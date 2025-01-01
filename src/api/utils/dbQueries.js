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
          CURRENT_TIMESTAMP + (CASE 
            WHEN $6 = 'week' THEN INTERVAL '7 days'
            ELSE INTERVAL '1 month'
          END),
          $8, 0, $9, $10, $11, $12, $13, $14)
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
          CURRENT_TIMESTAMP + (CASE 
            WHEN $6 = 'week' THEN INTERVAL '7 days'
            ELSE INTERVAL '1 month'
          END),
          $8, 0)
        RETURNING *;
      `, [
        data.subscription_id,
        data.pool_id,
        data.customer_id,
        data.amount,
        data.currency,
        data.interval,
        data.status,
        data.metadata || {}
      ], client);

      // Create payment schedule
      await this.executeQuery(`
        INSERT INTO payment_system.payment_schedule 
        (subscription_id, scheduled_date, amount, status)
        SELECT 
          $1,
          generate_series(
            CURRENT_TIMESTAMP,
            CURRENT_TIMESTAMP + INTERVAL '1 year',
            CASE 
              WHEN $2 = 'week' THEN INTERVAL '7 days'
              ELSE INTERVAL '1 month'
            END
          ),
          $3,
          'scheduled'
      `, [data.subscription_id, data.interval, data.amount / 100], client);

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
  
      const subscriptionData = await this.executeQuery(`
        SELECT s.*, p.current_balance, p.currency, 
               EXISTS (
                 SELECT 1 
                 FROM payment_system.payment_logs 
                 WHERE pool_id = p.pool_id 
                 AND event_type = 'payment.initial'
               ) as has_initial_payment
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
  
        // Only update balance if it's not the first payment
        // For first payment, we'll set it directly instead of adding
        const oldBalance = parseFloat(sub.current_balance);
        const newBalance = sub.has_initial_payment ? 
          oldBalance + paymentAmount : // For subsequent payments
          paymentAmount;              // For first payment
  
        // Update with verification
        const balanceResult = await this.executeQuery(`
          UPDATE payment_system.pools 
          SET 
            current_balance = $2,
            updated_at = CURRENT_TIMESTAMP
          WHERE pool_id = $1 
          AND current_balance = $3
          RETURNING current_balance
        `, [sub.pool_id, newBalance.toFixed(8), oldBalance.toFixed(8)], client);
  
        if (!balanceResult.length) {
          throw new Error('Balance update failed - concurrent modification');
        }
  
        console.log('Balance updated:', {
          pool_id: sub.pool_id,
          old_balance: oldBalance,
          payment_amount: paymentAmount,
          new_balance: newBalance,
          is_initial_payment: !sub.has_initial_payment
        });
      }
  
      // Log payment with proper type
      await this.logPayment({
        pool_id: sub.pool_id,
        event_type: sub.has_initial_payment ? data.event_type : 'payment.initial',
        amount: paymentAmount,
        status: data.status,
        metadata: {
          ...data.metadata,
          is_initial_payment: !sub.has_initial_payment
        }
      }, client);
  
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
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
  static async updatePoolBalance(poolId, amount, type, client = null) {
    const shouldReleaseClient = !client;
    client = client || await pool.connect();
    
    try {
      await client.query('BEGIN');

      // Get current balance with lock
      const currentBalance = await this.executeQuery(`
        SELECT current_balance 
        FROM payment_system.pools 
        WHERE pool_id = $1 
        FOR UPDATE
      `, [poolId], client);

      if (!currentBalance.length) {
        throw new Error('Pool not found');
      }

      const oldBalance = parseFloat(currentBalance[0].current_balance);
      const newBalance = type === 'credit' 
        ? oldBalance + parseFloat(amount)
        : oldBalance - parseFloat(amount);

      // Update balance
      await this.executeQuery(`
        UPDATE payment_system.pools 
        SET 
          current_balance = $2,
          updated_at = CURRENT_TIMESTAMP
        WHERE pool_id = $1
        AND current_balance = $3
      `, [poolId, newBalance.toFixed(8), oldBalance.toFixed(8)], client);

      await client.query('COMMIT');
      return newBalance;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      if (shouldReleaseClient) {
        client.release();
      }
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
}
