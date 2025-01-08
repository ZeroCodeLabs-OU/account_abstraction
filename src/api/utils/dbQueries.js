import pool from '../config/dbConfig.js';

export class PoolQueries {
  // Basic query executor with error handling
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

  // Create/update pool and handle metadata
  static async createOrUpdatePool(data) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
  
      if (!data.pool_id) throw new Error('pool_id is required');
  
      const query = `
        INSERT INTO payment_system.pools 
        (pool_id, owner_id, username, email, currency, current_balance, metadata)
        VALUES ($1, $2, $3, $4, $5, 0, $6)
        ON CONFLICT (pool_id) 
        DO UPDATE SET
          username = EXCLUDED.username,
          email = EXCLUDED.email,
          currency = EXCLUDED.currency,
          metadata = COALESCE(payment_system.pools.metadata, '{}')::jsonb || $6::jsonb,
          updated_at = CURRENT_TIMESTAMP
        RETURNING *;
      `;
  
      const values = [
        data.pool_id,
        data.owner_id,
        data.username,
        data.email,
        data.currency,
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
  static async createOrUpdateSubscription(data) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const query = `
            INSERT INTO payment_system.stripe_subscriptions 
            (subscription_id, pool_id, customer_id, amount, currency, interval, 
             status, next_payment_date, metadata, failure_count,
             payment_method_id, card_last4, card_brand, card_exp_month, card_exp_year, card_country)
            VALUES ($1, $2, $3, $4, $5, $6, $7, 
              $8, 
              $9, 0, $10, $11, $12, $13, $14, $15)
            ON CONFLICT (subscription_id) 
            DO UPDATE SET
              status = EXCLUDED.status,
              next_payment_date = EXCLUDED.next_payment_date,
              metadata = COALESCE(payment_system.stripe_subscriptions.metadata, '{}'::jsonb) || EXCLUDED.metadata,
              payment_method_id = COALESCE(EXCLUDED.payment_method_id, payment_system.stripe_subscriptions.payment_method_id),
              card_last4 = COALESCE(EXCLUDED.card_last4, payment_system.stripe_subscriptions.card_last4),
              card_brand = COALESCE(EXCLUDED.card_brand, payment_system.stripe_subscriptions.card_brand),
              card_exp_month = COALESCE(EXCLUDED.card_exp_month, payment_system.stripe_subscriptions.card_exp_month),
              card_exp_year = COALESCE(EXCLUDED.card_exp_year, payment_system.stripe_subscriptions.card_exp_year),
              card_country = COALESCE(EXCLUDED.card_country, payment_system.stripe_subscriptions.card_country),
              updated_at = CURRENT_TIMESTAMP
            RETURNING *;
        `;

        const values = [
            data.subscription_id,
            data.pool_id,
            data.customer_id,
            data.amount,
            data.currency,
            data.interval,
            data.status,
            data.next_payment_date, 
            data.metadata || {},
            data.payment_method_id || null,
            data.card_last4 || null,
            data.card_brand || null,
            data.card_exp_month || null,
            data.card_exp_year || null,
            data.card_country || null
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

static async createSubscription(data) {
  const client = await pool.connect();
  try {
      await client.query('BEGIN');

      // Create subscription
      const subscription = await this.executeQuery(`
          INSERT INTO payment_system.stripe_subscriptions 
          (subscription_id, pool_id, customer_id, amount, currency, interval, 
           status, next_payment_date, metadata, failure_count)
          VALUES ($1, $2, $3, $4, $5, $6, $7, 
            $8, -- Use provided next_payment_date
            $9, 0)
          RETURNING *;
      `, [
          data.subscription_id,
          data.pool_id,
          data.customer_id,
          data.amount,
          data.currency,
          data.interval,
          data.status,
          data.next_payment_date, // Use next_payment_date from the input
          data.metadata || {}
      ], client);

      // Create payment schedule
      await this.executeQuery(`
          INSERT INTO payment_system.payment_schedule 
          (subscription_id, scheduled_date, amount, status)
          SELECT 
            $1,
            generate_series(
              $2, -- Start from provided next_payment_date
              $2 + INTERVAL '1 year',
              CASE 
                WHEN $3 = 'week' THEN INTERVAL '7 days'
                ELSE INTERVAL '1 month'
              END
            ),
            $4,
            'scheduled'
      `, [data.subscription_id, data.next_payment_date, data.interval, data.amount / 100], client);

      await client.query('COMMIT');
      return subscription[0];
  } catch (error) {
      await client.query('ROLLBACK');
      throw error;
  } finally {
      client.release();
  }
}
  // Process payments and update balances
  static async processPayment(data) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Check if payment already processed
      const paymentExists = await this.executeQuery(`
        SELECT 1 
        FROM payment_system.payment_logs 
        WHERE metadata->>'payment_intent' = $1
      `, [data.metadata.payment_intent], client);

      if (paymentExists.length > 0) {
        console.log('Payment already processed:', data.metadata.payment_intent);
        await client.query('COMMIT');
        return;
      }

      // Get subscription with pool data
      const subscriptionData = await this.executeQuery(`
        SELECT s.*, p.current_balance, p.currency
        FROM payment_system.stripe_subscriptions s
        JOIN payment_system.pools p ON s.pool_id = p.pool_id
        WHERE s.subscription_id = $1
        FOR UPDATE
      `, [data.subscription_id], client);

      if (!subscriptionData[0]) {
        throw new Error('Subscription not found');
      }

      const sub = subscriptionData[0];
      const paymentAmount = parseFloat(data.amount) / 100;

      if (data.status === 'succeeded') {
        // Update subscription dates
        await this.executeQuery(`
          UPDATE payment_system.stripe_subscriptions
          SET 
            status = 'active',
            last_payment_date = CURRENT_TIMESTAMP,
            next_payment_date = CURRENT_TIMESTAMP + (CASE 
              WHEN interval = 'week' THEN INTERVAL '7 days'
              ELSE INTERVAL '1 month'
            END),
            failure_count = 0,
            updated_at = CURRENT_TIMESTAMP
          WHERE subscription_id = $1
        `, [data.subscription_id], client);

        // Always add payment amount to current balance
        const oldBalance = parseFloat(sub.current_balance) || 0;
        const newBalance = oldBalance + paymentAmount;

        // Update balance
        await this.executeQuery(`
          UPDATE payment_system.pools 
          SET 
            current_balance = $2,
            updated_at = CURRENT_TIMESTAMP
          WHERE pool_id = $1 
        `, [sub.pool_id, newBalance.toFixed(8)], client);

        console.log('Balance updated:', {
          pool_id: sub.pool_id,
          old_balance: oldBalance,
          payment_amount: paymentAmount,
          new_balance: newBalance
        });
      }

      // Log the payment with currency in metadata
      await this.logPayment({
        pool_id: sub.pool_id,
        subscription_id: sub.subscription_id,
        event_type: data.event_type,
        amount: paymentAmount,
        status: data.status,
        metadata: {
          ...data.metadata,
          payment_intent: data.metadata.payment_intent,
          payment_amount: paymentAmount,
          currency: sub.currency 
        }
      }, client);

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Payment processing error:', error);
      throw error;
    } finally {
      client.release();
    }
}

  // Payment schedule tracking
  static async trackPaymentSchedule(subscriptionId, client) {
    try {
      const sub = await this.executeQuery(`
        SELECT interval, amount, currency
        FROM payment_system.stripe_subscriptions
        WHERE subscription_id = $1
      `, [subscriptionId], client);
  
      if (!sub.length) throw new Error('Subscription not found');
  
      // First delete existing future schedules
      await this.executeQuery(`
        DELETE FROM payment_system.payment_schedule
        WHERE subscription_id = $1
        AND scheduled_date > CURRENT_TIMESTAMP
      `, [subscriptionId], client);
  
      // Then insert new schedules
      const query = `
        WITH RECURSIVE dates AS (
          SELECT 
            CURRENT_TIMESTAMP::timestamp as payment_date,
            1 as payment_number
          UNION ALL
          SELECT 
            CASE 
              WHEN $2 = 'week' THEN payment_date + INTERVAL '7 days'
              ELSE payment_date + INTERVAL '1 month'
            END,
            payment_number + 1
          FROM dates
          WHERE payment_number < 12
        )
        INSERT INTO payment_system.payment_schedule 
        (subscription_id, scheduled_date, amount, status)
        SELECT 
          $1 as subscription_id,
          payment_date,
          $3 as amount,
          'scheduled' as status
        FROM dates;
      `;
  
      return await this.executeQuery(query, [
        subscriptionId, 
        sub[0].interval,
        sub[0].amount
      ], client);
  
    } catch (error) {
      console.error('Error tracking payment schedule:', error);
      throw error;
    }
  }

  // Log payment events
  static async logPayment(data, existingClient = null) {
    const client = existingClient || await pool.connect();
    try {
      if (!existingClient) await client.query('BEGIN');

      await this.executeQuery(`
        INSERT INTO payment_system.payment_logs
        (pool_id, event_type, amount, status, metadata)
        VALUES ($1, $2, $3, $4, $5)
      `, [
        data.pool_id,
        data.event_type,
        data.amount,
        data.status,
        data.metadata
      ], client);

      if (!existingClient) await client.query('COMMIT');
    } catch (error) {
      if (!existingClient) await client.query('ROLLBACK');
      throw error;
    } finally {
      if (!existingClient) client.release();
    }
  }

  // Handle failed payments
  static async recordFailedPayment(data) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Update subscription status
      await this.executeQuery(`
        UPDATE payment_system.stripe_subscriptions
        SET 
          status = 'past_due',
          failure_count = failure_count + 1,
          updated_at = CURRENT_TIMESTAMP
        WHERE subscription_id = $1
      `, [data.subscription_id], client);

      // Log failure
      await this.logPayment({
        pool_id: data.pool_id,
        event_type: 'payment.failed',
        amount: parseFloat(data.amount) / 100,
        status: 'failed',
        metadata: data.metadata
      }, client);

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  static async getInvoiceTransactions(poolId) {
    const query = `
      WITH distinct_currencies AS (
        SELECT DISTINCT 
          jsonb_extract_path_text(pl.metadata, 'currency') as currency
        FROM payment_system.payment_logs pl
        WHERE pl.pool_id = $1
        AND pl.event_type IN ('invoice.paid', 'payment.failed')
        AND pl.metadata->>'currency' IS NOT NULL
      )
      SELECT 
        pl.*,
        s.subscription_id,
        s.interval,
        s.amount as subscription_amount,
        ARRAY(SELECT currency FROM distinct_currencies) as available_currencies
      FROM payment_system.payment_logs pl
      JOIN payment_system.stripe_subscriptions s ON s.pool_id = pl.pool_id
      WHERE pl.pool_id = $1
      AND pl.event_type IN ('invoice.paid', 'payment.failed')
      ORDER BY pl.created_at DESC;
    `;
   
    try {
      return await this.executeQuery(query, [poolId]);
    } catch (error) {
      console.error('Error fetching invoice transactions:', error);
      throw error;
    }
}

static async canPauseSubscription(poolId) {
  const query = `
    SELECT 
      status,
      metadata->>'pause_collection' as pause_collection
    FROM payment_system.stripe_subscriptions 
    WHERE pool_id = $1
    AND status = 'active'
    AND (metadata->>'pause_collection' IS NULL OR metadata->>'pause_collection' != 'void')
    LIMIT 1;
  `;

  try {
    const result = await this.executeQuery(query, [poolId]);
    return {
      canPause: result.length > 0,
      reason: result.length === 0 ? 'Subscription cannot be paused (either inactive or already paused)' : null
    };
  } catch (error) {
    throw error;
  }
}
static async canResumeSubscription(poolId) {
  const query = `
    SELECT status
    FROM payment_system.stripe_subscriptions 
    WHERE pool_id = $1
    AND status = 'paused'
    AND metadata->>'pause_collection' = 'void'
    LIMIT 1;
  `;

  try {
    const result = await this.executeQuery(query, [poolId]);
    return {
      canResume: result.length > 0,
      reason: result.length === 0 ? 'Subscription is not paused' : null
    };
  } catch (error) {
    throw error;
  }
}
   
   static async updateSubscriptionPauseStatus(subscription_id, isPaused) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
  
      const query = `
        UPDATE payment_system.stripe_subscriptions
        SET 
          status = $2,
          metadata = jsonb_set(
            COALESCE(metadata, '{}'::jsonb),
            '{pause_collection}',
            $3::jsonb
          ),
          updated_at = CURRENT_TIMESTAMP
        WHERE subscription_id = $1
        RETURNING *;
      `;
  
      const result = await this.executeQuery(query, [
        subscription_id,
        isPaused ? 'paused' : 'active',
        JSON.stringify(isPaused ? 'void' : null)
      ], client);
  
      // Log the status change
      if (result[0]) {
        await this.logPayment({
          pool_id: result[0].pool_id,
          event_type: isPaused ? 'subscription.paused' : 'subscription.resumed',
          amount: result[0].amount,
          status: isPaused ? 'paused' : 'active',
          metadata: {
            subscription_id,
            pause_collection: isPaused ? 'void' : null,
            status_changed_at: new Date().toISOString()
          }
        }, client);
      }
  
      await client.query('COMMIT');
      return result[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
   
  static async getSubscriptionsByPoolId(poolId) {
    const query = `
      SELECT 
        s.*,
        p.current_balance,
        p.currency as pool_currency
      FROM payment_system.stripe_subscriptions s
      JOIN payment_system.pools p ON s.pool_id = p.pool_id
      WHERE s.pool_id = $1
      ORDER BY s.created_at DESC;
    `;
  
    try {
      return await this.executeQuery(query, [poolId]);
    } catch (error) {
      console.error('Error fetching subscriptions:', error);
      throw error;
    }
  }
  
  static async getPoolBalance(poolId) {
    const query = `
      SELECT 
        pool_id,
        current_balance,
        currency,
        created_at,
        updated_at
      FROM payment_system.pools
      WHERE pool_id = $1;
    `;
  
    try {
      const result = await this.executeQuery(query, [poolId]);
      return result[0];
    } catch (error) {
      console.error('Error fetching pool balance:', error);
      throw error;
    }
  }


  static async updateSubscriptionStatus(data) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
  
      // Update subscription status
      const subscription = await this.executeQuery(`
        UPDATE payment_system.stripe_subscriptions
        SET 
          status = $2,
          metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb,
          updated_at = CURRENT_TIMESTAMP
        WHERE subscription_id = $1
        RETURNING *;
      `, [
        data.subscription_id,
        data.status,
        data.metadata
      ], client);
  
      if (!subscription.length) {
        throw new Error('Subscription not found');
      }
  
      // Log the cancellation
      await this.logPayment({
        pool_id: subscription[0].pool_id,
        event_type: 'subscription.canceled',
        status: data.status,
        metadata: {
          ...data.metadata,
          subscription_id: data.subscription_id
        }
      }, client);
  
      await client.query('COMMIT');
      return subscription[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  static async logPayout(data) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
  
      const result = await this.executeQuery(`
        INSERT INTO payment_system.payouts
        (payout_id, pool_id, amount, currency, bank_arrival_date, bank_account, status, metadata)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING *;
      `, [
        data.payout_id,
        data.pool_id,
        data.amount,
        data.currency,
        data.bank_arrival_date,
        data.bank_account,
        data.status,
        data.metadata
      ], client);
  
      await client.query('COMMIT');
      return result[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  
  // Get payout history for a pool
  static async getPoolPayouts(poolId) {
    return await this.executeQuery(`
      SELECT * FROM payment_system.payouts
      WHERE pool_id = $1
      ORDER BY bank_arrival_date DESC;
    `, [poolId]);
  }
  static async updateSubscriptionPrice(data) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
  
      const result = await this.executeQuery(`
        UPDATE payment_system.stripe_subscriptions
        SET 
          amount = $2,
          metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb,
          updated_at = CURRENT_TIMESTAMP
        WHERE subscription_id = $1
        RETURNING *;
      `, [
        data.subscription_id,
        data.amount,
        data.metadata
      ], client);
  
      // Log the price change
      await this.logPayment({
        pool_id: result[0].pool_id,
        event_type: 'subscription.price_updated',
        amount: data.amount,
        metadata: {
          subscription_id: data.subscription_id,
          ...data.metadata
        }
      }, client);
  
      await client.query('COMMIT');
      return result[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  static async getPayoutById(payoutId) {
    return await this.executeQuery(`
      SELECT * FROM payment_system.payouts 
      WHERE payout_id = $1
    `, [payoutId]);
  }


  static async logPayoutWithTransaction(data) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
  
      // Double-check payout doesn't exist (race condition protection)
      const existing = await this.executeQuery(`
        SELECT 1 FROM payment_system.payouts 
        WHERE payout_id = $1 AND pool_id = $2
      `, [data.payout_id, data.pool_id], client);
  
      if (existing.length > 0) {
        await client.query('ROLLBACK');
        console.log(`Payout ${data.payout_id} for pool ${data.pool_id} already exists`);
        return;
      }
  
      // Insert payout record
      await this.executeQuery(`
        INSERT INTO payment_system.payouts
        (payout_id, pool_id, amount, currency, bank_arrival_date, bank_account, status, metadata)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `, [
        data.payout_id,
        data.pool_id,
        data.amount,
        data.currency,
        data.bank_arrival_date,
        data.bank_account,
        data.status,
        data.metadata
      ], client);
  
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  static async hasActiveSubscription(poolId) {
    try {
      const result = await this.executeQuery(`
        SELECT EXISTS (
          SELECT 1 
          FROM payment_system.stripe_subscriptions 
          WHERE pool_id = $1 
          AND (status = 'active' OR status = 'incomplete')
        ) as has_subscription;
      `, [poolId]);
  
      return result[0].has_subscription;
    } catch (error) {
      console.error('Error checking active subscription:', error);
      throw error;
    }
  }
  
}
