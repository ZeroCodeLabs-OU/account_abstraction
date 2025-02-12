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

  static async getDistributionStatus(pool_id, invoice_id) {
    const query = `
        SELECT 
            i.invoice_id,
            i.pool_id,
            i.amount,
            i.currency,
            i.status as invoice_status,
            p.smart_account_address as pool_smart_account,
            COALESCE(
                bool_or(pr.status = 'succeeded'),
                false
            ) as is_distributed,
            MAX(pr.distributed_at) as distributed_at,
            MAX(pr.blockchain_tx_id) as blockchain_tx_id,
            COALESCE(
                json_agg(
                    json_build_object(
                        'smart_account_address', pr.smart_account_address,
                        'reward_percentage', pr.reward_percentage,
                        'calculated_reward_usdc', pr.calculated_reward_usdc
                    )
                ) FILTER (WHERE pr.smart_account_address IS NOT NULL),
                '[]'
            ) as rewards
        FROM payment_system.invoices i
        JOIN payment_system.pools p ON p.pool_id = i.pool_id
        LEFT JOIN payment_system.pool_rewards pr ON pr.invoice_id = i.invoice_id
        WHERE i.pool_id = $1 
        AND i.invoice_id = $2
        GROUP BY 
            i.invoice_id,
            i.pool_id,
            i.amount,
            i.currency,
            i.status,
            p.smart_account_address;
    `;

    try {
        const result = await pool.query(query, [pool_id, invoice_id]);
        
        // If no record found
        if (result.rows.length === 0) {
            return {
                isDistributed: false,
                distributed_at: null,
                blockchain_tx_id: null,
                rewards: [],
                pool_smart_account: null
            };
        }

        const row = result.rows[0];
        return {
            isDistributed: row.is_distributed,
            distributed_at: row.distributed_at,
            blockchain_tx_id: row.blockchain_tx_id,
            rewards: row.rewards || [],
            pool_smart_account: row.pool_smart_account,
            invoice: {
                invoice_id: row.invoice_id,
                pool_id: row.pool_id,
                amount: row.amount,
                currency: row.currency,
                status: row.invoice_status
            }
        };
    } catch (error) {
        console.error('Error getting distribution status:', error);
        throw error;
    }
}

  static async getInvoicesWithPayoutPendingTreasury() {
    const query = `
        SELECT 
            i.*,
            t.payout_id,
            t.transaction_id,
            t.settlement_datetime,
            t.treasury_withdrawn,
            t.treasury_withdrawn_at
        FROM payment_system.invoices i
        JOIN payment_system.transfers t ON i.invoice_id = t.invoice_id
        WHERE t.payout_id IS NOT NULL 
        AND t.settlement_datetime IS NOT NULL
        AND t.treasury_withdrawn = false
        ORDER BY t.settlement_datetime DESC;
    `;

    try {
        const result = await pool.query(query);
        return result.rows;
    } catch (error) {
        console.error('Error fetching invoices pending treasury:', error);
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

static async updateRewardsWithUSDC({ pool_id, invoice_id, exchange_rate, exchange_rate_date, rewards }) {
  const client = await pool.connect();
  try {
      await client.query('BEGIN');

      for (const reward of rewards) {
          await client.query(`
              UPDATE payment_system.pool_rewards
              SET 
                  calculated_reward_usdc = $1,
                  usdc_exchange_rate = $2,
                  usdc_exchange_rate_date = $3,
                  updated_at = CURRENT_TIMESTAMP
              WHERE id = $4
              AND pool_id = $5
              AND invoice_id = $6
          `, [
              reward.calculated_reward_usdc,
              exchange_rate,
              exchange_rate_date,
              reward.id,
              pool_id,
              invoice_id
          ]);
      }

      await client.query('COMMIT');
  } catch (error) {
      await client.query('ROLLBACK');
      throw error;
  } finally {
      client.release();
  }
}

static async getPendingRewardsWithoutUSDC(poolId, invoiceId) {
  const query = `
      SELECT 
          pr.*,
          i.currency,
          t.treasury_withdrawn,
          t.user_distributed,
          p.smart_account_address as pool_smart_account
      FROM payment_system.pool_rewards pr
      JOIN payment_system.invoices i ON i.invoice_id = pr.invoice_id
      JOIN payment_system.transfers t ON t.invoice_id = pr.invoice_id
      JOIN payment_system.pools p ON p.pool_id = pr.pool_id
      WHERE pr.pool_id = $1 
      AND pr.invoice_id = $2
      AND pr.status = 'pending'
      AND t.treasury_withdrawn = false
      AND t.user_distributed = false
      AND p.smart_account_address IS NOT NULL
      ORDER BY pr.created_at ASC;
  `;

  try {
      const result = await pool.query(query, [poolId, invoiceId]);
      return result.rows;
  } catch (error) {
      throw error;
  }
}




static async updateDistributionStatus({ pool_id, invoice_id, transaction_hash, status }) {
  const client = await pool.connect();
  try {
      await client.query('BEGIN');

      // Update rewards status
     

      // Update transfer status
      const updateTransferQuery = `
          UPDATE payment_system.transfers
          SET 
              treasury_withdrawn = true,
              treasury_withdrawn_at = CURRENT_TIMESTAMP,
              updated_at = CURRENT_TIMESTAMP
          WHERE pool_id = $1 
          AND invoice_id = $2
          RETURNING *;
      `;

      await client.query(updateTransferQuery, [pool_id, invoice_id]);

      

      await client.query('COMMIT');
      return updateTransferQuery;
      

  } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error updating distribution status:', error);
      throw error;
  } finally {
      client.release();
  }
}
static async updateRewardsToProcessing(pool_id, invoice_id) {
  const query = `
      UPDATE payment_system.pool_rewards
      SET 
          status = 'processing',
          updated_at = CURRENT_TIMESTAMP
      WHERE pool_id = $1 
      AND invoice_id = $2
      AND status = 'pending';
  `;
  await pool.query(query, [pool_id, invoice_id]);
}

static async revertProcessingStatus(pool_id, invoice_id) {
  const query = `
      UPDATE payment_system.pool_rewards
      SET 
          status = 'pending',
          updated_at = CURRENT_TIMESTAMP
      WHERE pool_id = $1 
      AND invoice_id = $2
      AND status = 'processing';
  `;
  await pool.query(query, [pool_id, invoice_id]);
}
static async getPendingRewards_pool(poolId, invoiceId) {
  const query = `
      SELECT 
          pr.*,
          i.currency,
          t.treasury_withdrawn,
          t.user_distributed,
          p.smart_account_address as pool_smart_account
      FROM payment_system.pool_rewards pr
      JOIN payment_system.invoices i ON i.invoice_id = pr.invoice_id
      JOIN payment_system.transfers t ON t.invoice_id = pr.invoice_id
      JOIN payment_system.pools p ON p.pool_id = pr.pool_id
      WHERE pr.pool_id = $1 
      AND pr.invoice_id = $2
      AND pr.status IN ('pending', 'processing')
      AND t.treasury_withdrawn = false
      AND t.user_distributed = false
      AND pr.calculated_reward_usdc IS NOT NULL
      AND p.smart_account_address IS NOT NULL
      ORDER BY pr.created_at ASC;
  `;


  try {
      const result = await pool.query(query, [poolId, invoiceId]);
      return result.rows;
  } catch (error) {
      throw error;
  }
}
static async getPoolSmartAccount(poolId) {
  const query = `
      SELECT smart_account_address
      FROM payment_system.pools
      WHERE pool_id = $1;
  `;
  const values = [poolId];
  const result = await pool.query(query, values);
  return result.rows[0];
}
static async getPendingRewards_user(poolId, invoiceId) {
  const query = `
      SELECT 
          pr.*,
          i.currency,
          t.treasury_withdrawn,
          t.user_distributed,
          p.smart_account_address as pool_smart_account
      FROM payment_system.pool_rewards pr
      JOIN payment_system.invoices i ON i.invoice_id = pr.invoice_id
      JOIN payment_system.transfers t ON t.invoice_id = pr.invoice_id
      JOIN payment_system.pools p ON p.pool_id = pr.pool_id
      WHERE pr.pool_id = $1 
      AND pr.invoice_id = $2
      AND pr.status IN ('pending', 'processing')
      AND t.treasury_withdrawn = true
      AND t.user_distributed = false
      AND pr.calculated_reward_usdc IS NOT NULL
      AND p.smart_account_address IS NOT NULL
      ORDER BY pr.created_at ASC;
  `;


  try {
      const result = await pool.query(query, [poolId, invoiceId]);
      return result.rows;
  } catch (error) {
      throw error;
  }
}


static async getPendingRewards(pool_id, invoice_id) {
  const query = `
      SELECT *
      FROM payment_system.pool_rewards
      WHERE pool_id = $1 
      AND invoice_id = $2
      AND status IN ('pending', 'processing')
  `;
  const result = await pool.query(query, [pool_id, invoice_id]);
  // console.log('Pending rewards:', result);
  return result.rows;
}
static async finalizeRewardDistribution( transaction_hash,pool_id, invoice_id ) {
  const client = await pool.connect();
  console.log('Starting reward distribution finalization:', {
      pool_id,
      invoice_id,
      transaction_hash
  });

  try {
      await client.query('BEGIN');

      // Update rewards with detailed status
      const rewardResult = await client.query(`
        UPDATE payment_system.pool_rewards
        SET 
            status = 'succeeded',
            blockchain_tx_id = $1::text,
            distributed_at = CURRENT_TIMESTAMP
        WHERE pool_id = $2::text 
        AND invoice_id = $3::text
        AND status = 'processing';
    `, [transaction_hash, pool_id, invoice_id]);

      console.log(`Updated ${rewardResult.rowCount} rewards to succeeded status`);

      // Update transfer status with timestamps
      const transferResult = await client.query(`
          UPDATE payment_system.transfers
          SET 
              treasury_withdrawn = true,
              treasury_withdrawn_at = CURRENT_TIMESTAMP,
              user_distributed = true,
              user_distributed_at = CURRENT_TIMESTAMP,
              updated_at = CURRENT_TIMESTAMP
          WHERE pool_id = $1 
          AND invoice_id = $2
          RETURNING transaction_id, amount;
      `, [pool_id, invoice_id]);

      console.log(`Updated transfer status for ${transferResult.rowCount} records`);

      

      await client.query('COMMIT');

      return {
          success: true,
          updated_rewards: rewardResult.rows,
          transfer_details: transferResult.rows[0],
          timestamp: new Date()
      };

  } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error in finalizeRewardDistribution:', {
          error: error.message,
          pool_id,
          invoice_id
      });
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

static async getTransfersByTransactionIds(transactionIds) {
    const client = await pool.connect();
    try {
      const query = `
        SELECT id, transaction_id, amount, status, payout_id
        FROM payment_system.transfers
        WHERE transaction_id = ANY($1);
      `;
      
      const result = await client.query(query, [transactionIds]);
      return result.rows;
    } catch (error) {
      console.error('Error getting transfers:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  static async updateTransfersWithPayout(data) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      console.log('Updating transfers with data:', {
        payout_id: data.payout_id,
        settlement_datetime: data.settlement_datetime,
        transaction_count: data.transaction_ids.length,
        transaction_ids: data.transaction_ids
      });

      const query = `
        UPDATE payment_system.transfers
        SET 
          payout_id = $1,
          settlement_datetime = $2,
          updated_at = CURRENT_TIMESTAMP
        WHERE transaction_id = ANY($3)
        RETURNING id, transaction_id, amount, status, payout_id, settlement_datetime;
      `;

      const result = await client.query(query, [
        data.payout_id,
        data.settlement_datetime,
        data.transaction_ids
      ]);

      console.log('Update query result:', {
        rows_affected: result.rowCount,
        updated_records: result.rows
      });

      await client.query('COMMIT');
      return result.rows;
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error updating transfers:', error);
      console.error('Error details:', {
        message: error.message,
        detail: error.detail,
        hint: error.hint,
        where: error.where
      });
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
static async createBulkRewards({ pool_id, invoice_id, invoice_amount, distribution_amount, rewards, metadata }) {
  const client = await pool.connect();
  try {
      await client.query('BEGIN');

      const createdRewards = [];
      for (const reward of rewards) {
          // Calculate reward based on distribution_amount (90% of original)
          const calculatedReward = (distribution_amount * reward.reward_percentage) / 100;
          
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
              invoice_amount, // Store original amount
              calculatedReward,
              {
                  ...metadata,
                  reward_calculation: {
                      original_amount: invoice_amount,
                      distribution_amount: distribution_amount,
                      percentage: reward.reward_percentage,
                      calculated_reward: calculatedReward
                  }
              }
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

static async getRewardsForInvoice(poolId, invoiceId) {
  const query = `
      SELECT 
          pr.*,
          i.currency as invoice_currency
      FROM payment_system.pool_rewards pr
      JOIN payment_system.invoices i ON pr.invoice_id = i.invoice_id
      WHERE pr.pool_id = $1 
      AND pr.invoice_id = $2;
  `;

  try {
      const result = await pool.query(query, [poolId, invoiceId]);
      return result.rows;
  } catch (error) {
      throw error;
  }
}
static async getPendingBatchRewards() {
  const query = `
      SELECT DISTINCT ON (i.invoice_id)
          i.invoice_id,
          i.pool_id,
          t.transaction_id,
          t.payout_id,
          t.settlement_datetime,
          pr.metadata
      FROM payment_system.invoices i
      JOIN payment_system.transfers t ON t.invoice_id = i.invoice_id
      JOIN payment_system.pool_rewards pr ON pr.invoice_id = i.invoice_id
      WHERE t.payout_id IS NOT NULL 
      AND t.treasury_withdrawn = false
      AND pr.calculated_reward IS NOT NULL
      ORDER BY i.invoice_id, i.created_at DESC;
  `;
  return (await pool.query(query)).rows;
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