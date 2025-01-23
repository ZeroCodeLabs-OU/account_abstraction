import pool from '../config/dbConfig.js';

export class PoolQueries {
  static async executeQuery(queryText, values, client = pool) {
    try {
      const result = await client.query(queryText, values);
      return result.rows;
    } catch (error) {
      console.error('Database Error:', {
        query: queryText,
        error: error.message
      });
      throw error;
    }
  }

  static async createOrUpdatePool(data) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const query = `
        INSERT INTO payment_system.pools 
        (pool_id, email, customer_id, smart_account_address, metadata)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (pool_id) 
        DO UPDATE SET
          email = EXCLUDED.email,
          customer_id = EXCLUDED.customer_id,
          smart_account_address = EXCLUDED.smart_account_address,
          metadata = COALESCE(payment_system.pools.metadata, '{}')::jsonb || EXCLUDED.metadata::jsonb,
          updated_at = CURRENT_TIMESTAMP
        RETURNING *;
      `;

      const values = [
        data.pool_id,
        data.email,
        data.customer_id,
        data.smartAccountAddress,
        data.metadata || {}
      ];

      const result = await this.executeQuery(query, values, client);
      await client.query('COMMIT');
      return result[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  static async createInvoice(data) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const query = `
        INSERT INTO payment_system.invoices
        (invoice_id, pool_id, payment_intent_id, amount, payment_method_id, 
         currency, status, paid_at, metadata)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING *;
      `;

      const values = [
        data.invoice_id,
        data.pool_id,
        data.payment_intent_id,
        data.amount,
        data.payment_method_id,
        data.currency,
        data.status,
        data.paid_at,
        data.metadata
      ];

      const result = await this.executeQuery(query, values, client);
      await client.query('COMMIT');
      return result[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  static async createOrUpdatePayout(data) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const query = `
        INSERT INTO payment_system.payouts 
        (payout_id, amount, currency, bank_arrival_date, status, metadata)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (payout_id) 
        DO UPDATE SET
          status = EXCLUDED.status,
          bank_arrival_date = EXCLUDED.bank_arrival_date,
          metadata = COALESCE(payment_system.payouts.metadata, '{}'::jsonb) || EXCLUDED.metadata,
          updated_at = CURRENT_TIMESTAMP
        RETURNING *;
      `;

      const result = await client.query(query, [
        data.payout_id,
        data.amount,
        data.currency,
        data.bank_arrival_date,
        data.status,
        data.metadata
      ]);

      await client.query('COMMIT');
      return result.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  static async updateBalanceTransactionPayout(data) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Update or insert balance transaction
      await client.query(`
        INSERT INTO payment_system.balance_transactions
        (transaction_id, pool_id, payment_intent_id, payout_id, 
         amount, fee, net, type, available_on, status, metadata)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        ON CONFLICT (transaction_id)
        DO UPDATE SET
          payout_id = EXCLUDED.payout_id,
          status = EXCLUDED.status,
          available_on = EXCLUDED.available_on,
          metadata = COALESCE(payment_system.balance_transactions.metadata, '{}'::jsonb) || EXCLUDED.metadata,
          updated_at = CURRENT_TIMESTAMP;
      `, [
        data.transaction_id,
        data.pool_id,
        data.payment_intent_id,
        data.payout_id,
        data.amount,
        data.fee,
        data.net,
        data.type,
        data.available_on,
        'succeeded',
        data.metadata
      ]);

      // Update related invoice if it exists
      await client.query(`
        UPDATE payment_system.invoices
        SET 
          payout_id = $1,
          metadata = metadata || jsonb_build_object(
            'payout_details', jsonb_build_object(
              'payout_id', $1,
              'transaction_id', $2,
              'amount', $3,
              'fee', $4,
              'net', $5,
              'available_on', $6
            )
          )
        WHERE payment_intent_id = $7;
      `, [
        data.payout_id,
        data.transaction_id,
        data.amount,
        data.fee,
        data.net,
        data.available_on,
        data.payment_intent_id
      ]);

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
   static async logPayoutEvent(data) {
    const query = `
      INSERT INTO payment_system.payment_logs
      (pool_id, event_type, amount, status, metadata)
      SELECT DISTINCT 
        bt.pool_id,
        $2,
        $3,
        'succeeded',
        $4
      FROM payment_system.balance_transactions bt
      WHERE bt.payout_id = $1
      LIMIT 1;
    `;

    try {
      await pool.query(query, [
        data.payout_id,
        data.event_type,
        data.amount,
        data.metadata
      ]);
    } catch (error) {
      console.error('Error logging payout event:', error);
      throw error;
    }
  }


  static async getPoolInfo(poolId) {
    const query = `
      SELECT 
        pool_id,
        email,
        customer_id,
        smart_account_address,
        usdc_balance,
        metadata,
        status,
        created_at,
        updated_at
      FROM payment_system.pools
      WHERE pool_id = $1;
    `;

    try {
      const result = await this.executeQuery(query, [poolId]);
      return result[0];
    } catch (error) {
      console.error('Error fetching pool info:', error);
      throw error;
    }
  }

  static async updatePoolCustomerId(poolId, customerId) {
    const query = `
      UPDATE payment_system.pools
      SET customer_id = $2,
          updated_at = CURRENT_TIMESTAMP
      WHERE pool_id = $1
      RETURNING *;
    `;

    try {
      const result = await this.executeQuery(query, [poolId, customerId]);
      return result[0];
    } catch (error) {
      console.error('Error updating pool customer ID:', error);
      throw error;
    }
  }
  static async getPendingRewardsForDistribution(poolId, invoiceId) {
    const query = `
        SELECT pr.*
        FROM payment_system.pool_rewards pr
        JOIN payment_system.transfers t ON pr.invoice_id = t.invoice_id
        WHERE pr.pool_id = $1
        AND pr.invoice_id = $2
        AND pr.status = 'pending'
        AND t.treasury_withdrawn = true
        AND t.user_distributed = false;
    `;

    const result = await pool.query(query, [poolId, invoiceId]);
    return result.rows;
}
static async finalizeRewardDistribution({ pool_id, invoice_id, transaction_hash }) {
  const client = await pool.connect();
  try {
      await client.query('BEGIN');

      // Update rewards
      await client.query(`
          UPDATE payment_system.pool_rewards
          SET 
              status = 'succeeded',
              blockchain_tx_id = $1,
              distributed_at = CURRENT_TIMESTAMP
          WHERE pool_id = $2 
          AND invoice_id = $3
          AND status = 'processing';
      `, [transaction_hash, pool_id, invoice_id]);

      // Update transfer
      await client.query(`
          UPDATE payment_system.transfers
          SET 
              user_distributed = true,
              user_distributed_at = CURRENT_TIMESTAMP
          WHERE pool_id = $1 
          AND invoice_id = $2;
      `, [pool_id, invoice_id]);

      

      await client.query('COMMIT');
  } catch (error) {
      await client.query('ROLLBACK');
      throw error;
  } finally {
      client.release();
  }
}



static async updateRewardsWithUsdcAmounts(rewards) {
  const client = await pool.connect();
  try {
      await client.query('BEGIN');

      for (const reward of rewards) {
          await client.query(`
              UPDATE payment_system.pool_rewards
              SET 
                  usdc_base_amount = $1,
                  calculated_reward_usdc = $2,
                  status = 'processing',
                  updated_at = CURRENT_TIMESTAMP
              WHERE id = $3
          `, [reward.usdc_base_amount, reward.calculated_reward_usdc, reward.id]);
      }

      await client.query('COMMIT');
  } catch (error) {
      await client.query('ROLLBACK');
      throw error;
  } finally {
      client.release();
  }
}


  static async getCustomerIdByPoolId(poolId) {
    const query = `
      SELECT customer_id
      FROM payment_system.pools
      WHERE pool_id = $1;
    `;

    try {
      const result = await this.executeQuery(query, [poolId]);
      return result[0]?.customer_id;
    } catch (error) {
      console.error('Error fetching customer ID:', error);
      throw error;
    }
  }

  static async updateTransfersWithPayout(data) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
  
      const query = `
        UPDATE payment_system.transfers
        SET 
          payout_id = $1,
          settlement_datetime = $2,
          updated_at = CURRENT_TIMESTAMP
        WHERE transaction_id = ANY($3)
        RETURNING *;
      `;
  
      const result = await client.query(query, [
        data.payout_id,
        data.settlement_datetime,
        data.transaction_ids
      ]);
  
      await client.query('COMMIT');
      return result.rows;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  static async createTransfer(data) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
  
      const query = `
        INSERT INTO payment_system.transfers
        (transaction_id, payment_intent_id, invoice_id, pool_id, 
         amount, currency, payment_datetime, status, metadata)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING *;
      `;
  
      const result = await client.query(query, [
        data.transaction_id,
        data.payment_intent_id,
        data.invoice_id,
        data.pool_id,
        data.amount,
        data.currency,
        data.payment_datetime,
        data.status,
        data.metadata
      ]);
  
      await client.query('COMMIT');
      return result.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  static async getTransferByPaymentIntent(paymentIntentId) {
    const query = `
      SELECT * FROM payment_system.transfers 
      WHERE payment_intent_id = $1 
      LIMIT 1;
    `;
  
    try {
      const result = await pool.query(query, [paymentIntentId]);
      return result.rows[0];
    } catch (error) {
      console.error('Error getting transfer:', error);
      throw error;
    }
  }
  static async updatePoolEmail(data) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const query = `
            UPDATE payment_system.pools
            SET 
                email = $2,
                metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb,
                updated_at = CURRENT_TIMESTAMP
            WHERE pool_id = $1
            RETURNING *;
        `;

        const result = await client.query(query, [
            data.pool_id,
            data.email,
            data.metadata || {}
        ]);

        

        await client.query('COMMIT');
        return result.rows[0];
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

static async getInvoiceDetails(invoiceId) {
  const query = `
      SELECT * FROM payment_system.invoices 
      WHERE invoice_id = $1 
      AND status = 'succeeded';
  `;
  
  try {
      const result = await pool.query(query, [invoiceId]);
      return result.rows[0];
  } catch (error) {
      console.error('Error fetching invoice:', error);
      throw error;
  }
}

static async getRewardByInvoiceId(invoiceId) {
  const query = `
      SELECT * FROM payment_system.pool_rewards 
      WHERE invoice_id = $1;
  `;
  
  try {
      const result = await pool.query(query, [invoiceId]);
      return result.rows[0];
  } catch (error) {
      console.error('Error fetching reward:', error);
      throw error;
  }
}
static async createBulkRewards({ pool_id, invoice_id, invoice_amount, rewards, metadata }) {
  const client = await pool.connect();
  try {
      await client.query('BEGIN');

      const createdRewards = [];
      for (const reward of rewards) {
          const calculatedReward = (parseFloat(invoice_amount) * reward.reward_percentage) / 100;
          
          const query = `
              INSERT INTO payment_system.pool_rewards
              (pool_id, invoice_id, smart_account_address, reward_percentage, 
               base_amount, calculated_reward, metadata)
              VALUES ($1, $2, $3, $4, $5, $6, $7)
              RETURNING *;
          `;

          const result = await client.query(query, [
              pool_id,
              invoice_id,
              reward.smart_account_address,
              reward.reward_percentage,
              invoice_amount,
              calculatedReward,
              metadata
          ]);

          createdRewards.push(result.rows[0]);
      }

      await client.query('COMMIT');
      return createdRewards;
  } catch (error) {
      await client.query('ROLLBACK');
      throw error;
  } finally {
      client.release();
  }
}

static async getPaidInvoices({ pool_id, limit, offset }) {
  const client = await pool.connect();
  try {
      // Get paginated invoices
      const invoicesQuery = `
          SELECT *
          FROM payment_system.invoices 
          WHERE pool_id = $1 
          AND status = 'succeeded'
          ORDER BY paid_at DESC
          LIMIT $2 OFFSET $3;
      `;

      // Get total count
      const countQuery = `
          SELECT COUNT(*) 
          FROM payment_system.invoices 
          WHERE pool_id = $1 
          AND status = 'succeeded';
      `;

      const [invoicesResult, countResult] = await Promise.all([
          client.query(invoicesQuery, [pool_id, limit, offset]),
          client.query(countQuery, [pool_id])
      ]);

      return {
          invoices: invoicesResult.rows,
          total: parseInt(countResult.rows[0].count)
      };

  } catch (error) {
      console.error('Error in getPaidInvoices:', error);
      throw error;
  } finally {
      client.release();
  }
}
}