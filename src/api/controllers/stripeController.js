import Stripe from 'stripe';
import { PoolQueries } from '../utils/dbQueries.js';
import e from 'express';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Constants and Configuration
const MAX_RETRIES = 3;
const BASE_DELAY = 2000;

const WEBHOOK_PRIORITIES = {
  'checkout.session.completed': 1,
  'customer.subscription.created': 2,
  'invoice.paid': 3,
  'customer.subscription.updated': 4,
  'payout.paid': 5
};

// Webhook Queue Manager
class WebhookQueueManager {
  constructor() {
    this.completedWebhooks = new Set();
    this.pendingWebhooks = new Map();
    this.processingWebhooks = new Set();
  }

  async addToQueue(eventType, sessionId, handler) {
    const key = `${eventType}:${sessionId}`;
    if (!this.processingWebhooks.has(key)) {
      this.processingWebhooks.add(key);
      try {
        await handler();
        this.completedWebhooks.add(key);
      } finally {
        this.processingWebhooks.delete(key);
      }
    }
  }
}

const queueManager = new WebhookQueueManager();

// Utility Functions
const logWebhookProgress = (eventType, status, details = {}) => {
  console.log(`Webhook ${eventType} ${status}:`, {
    timestamp: new Date().toISOString(),
    ...details
  });
};

async function retryOperation(operation, operationName, maxRetries = MAX_RETRIES) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      logWebhookProgress(operationName, 'attempt', { attempt });
      return await operation();
    } catch (error) {
      const delay = Math.min(BASE_DELAY * Math.pow(2, attempt - 1), 10000);
      logWebhookProgress(operationName, 'failed', { 
        attempt,
        error: error.message,
        nextRetryIn: delay 
      });
      
      if (attempt === maxRetries) throw error;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

async function ensurePoolExists(poolId, poolData) {
  if (!poolId) {
    throw new Error('Pool ID is required');
  }

  try {
    const existingPool = await PoolQueries.executeQuery(
      'SELECT 1 FROM payment_system.pools WHERE pool_id = $1',
      [poolId]
    );

    if (existingPool.length === 0) {
      if (!poolData) {
        throw new Error(`Pool ${poolId} not found and no data provided`);
      }

      await PoolQueries.createOrUpdatePool({
        pool_id: poolId,
        owner_id: poolData.owner_id,
        username: poolData.username,
        email: poolData.email,
        currency: poolData.currency,
        metadata: poolData.metadata || {}
      });

      // Verify pool creation
      await new Promise(resolve => setTimeout(resolve, 1000));
      const verifyPool = await PoolQueries.executeQuery(
        'SELECT 1 FROM payment_system.pools WHERE pool_id = $1',
        [poolId]
      );

      if (verifyPool.length === 0) {
        throw new Error(`Failed to create pool ${poolId}`);
      }
    }

    return true;
  } catch (error) {
    logWebhookProgress('ensurePoolExists', 'failed', { poolId, error: error.message });
    throw error;
  }
}

async function verifySubscriptionExists(subscriptionId) {
  const subscription = await PoolQueries.executeQuery(
    'SELECT 1 FROM payment_system.stripe_subscriptions WHERE subscription_id = $1',
    [subscriptionId]
  );
  return subscription.length > 0;
}

async function getPaymentDetails(session) {
  try {
    const subscription = await stripe.subscriptions.retrieve(session.subscription, {
      expand: ['default_payment_method']
    });

    if (subscription.default_payment_method) {
      const { card } = subscription.default_payment_method;
      if (card) {
        return {
          payment_method_id: subscription.default_payment_method.id,
          card_last4: card.last4,
          card_brand: card.brand,
          card_exp_month: card.exp_month,
          card_exp_year: card.exp_year,
          card_country: card.country
        };
      }
    }
    return null;
  } catch (error) {
    console.error('Error fetching payment details:', error);
    return null;
  }
}
// Webhook Handlers
async function handleCheckoutCompleted(session) {
  const sessionId = session.id;
  logWebhookProgress('checkout.session.completed', 'started', { session_id: sessionId });

  await retryOperation(async () => {
    const { pool_id, owner_id, username, email } = session.metadata;

    // Get payment details
    const paymentDetails = await getPaymentDetails(session);

    // Create/update pool first
    await ensurePoolExists(pool_id, {
      owner_id,
      username,
      email,
      currency: session.currency,
      metadata: {
        session_id: session.id,
        customer_id: session.customer,
        initial_amount: session.amount_total
      }
    });

    if (session.subscription) {
      // Get subscription details
      const stripeSubscription = await stripe.subscriptions.retrieve(
        session.subscription,
        { expand: ['items.data.price'] }
      );

      // Update Stripe subscription with pool_id
      await stripe.subscriptions.update(session.subscription, {
        metadata: { pool_id, owner_id, username }
      });

      // Create subscription
      await PoolQueries.createOrUpdateSubscription({
        subscription_id: session.subscription,
        pool_id,
        customer_id: session.customer,
        amount: session.amount_total,
        currency: session.currency,
        interval: stripeSubscription.items.data[0].price.recurring.interval,
        status: stripeSubscription.status,
        ...(paymentDetails || {}),
        metadata: {
          session_id: session.id,
          customer_email: email,
          initial_setup: true
        }
      });

      // Add delay to ensure subscription is accessible
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    queueManager.completedWebhooks.add(`checkout.session.completed:${sessionId}`);
  }, 'handleCheckoutCompleted');

  logWebhookProgress('checkout.session.completed', 'completed', { session_id: sessionId });
}


async function handleInvoicePaid(invoice) {
  const sessionId = invoice.subscription;
  logWebhookProgress('invoice.paid', 'started', { invoice_id: invoice.id });

  await retryOperation(async () => {
    if (!queueManager.completedWebhooks.has(`checkout.session.completed:${sessionId}`)) {
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    const subscription = await stripe.subscriptions.retrieve(
      invoice.subscription,
      { expand: ['default_payment_method'] }
    );

    const pool_id = subscription.plan.metadata?.pool_id;
    if (!pool_id) {
      throw new Error(`No pool_id in subscription metadata for subscription ${subscription.id}`);
    }

    // Verify both pool and subscription exist
    await ensurePoolExists(pool_id, null);
    const subscriptionExists = await verifySubscriptionExists(subscription.id);
    if (!subscriptionExists) {
      throw new Error('Subscription not found in database');
    }

    await PoolQueries.processPayment({
      subscription_id: subscription.id,
      pool_id,
      event_type: 'invoice.paid',
      amount: invoice.amount_paid,
      currency: invoice.currency,
      status: 'succeeded',
      metadata: {
        invoice_id: invoice.id,
        customer_id: invoice.customer,
        payment_intent: invoice.payment_intent,
        subscription: subscription.id
      }
    });

    logWebhookProgress('invoice.paid', 'completed', {
      subscription_id: subscription.id,
      pool_id,
      amount: invoice.amount_paid / 100,
      status: 'succeeded'
    });
  }, 'handleInvoicePaid');
}

async function handleInvoiceFailed(invoice) {
  logWebhookProgress('invoice.failed', 'started', { invoice_id: invoice.id });

  await retryOperation(async () => {
    const subscription = await stripe.subscriptions.retrieve(invoice.subscription);
    const pool_id = subscription.plan.metadata?.pool_id;

    if (!pool_id) {
      throw new Error('No pool_id found for subscription');
    }

    await PoolQueries.recordFailedPayment({
      subscription_id: subscription.id,
      pool_id,
      amount: invoice.amount_due,
      metadata: {
        invoice_id: invoice.id,
        customer_id: invoice.customer,
        attempt_count: invoice.attempt_count,
        next_payment_attempt: invoice.next_payment_attempt,
        failure_reason: invoice.last_payment_error?.message,
        failure_code: invoice.last_payment_error?.code
      }
    });

    logWebhookProgress('invoice.failed', 'completed', {
      subscription_id: subscription.id,
      amount: invoice.amount_due,
      attempt_count: invoice.attempt_count
    });
  }, 'handleInvoiceFailed');
}

async function handleSubscriptionCreated(subscription) {
  const sessionId = subscription.id;
  logWebhookProgress('subscription.created', 'started', { subscription_id: sessionId });

  await retryOperation(async () => {
    const pool_id = subscription.plan.metadata?.pool_id;
    if (!pool_id) {
      throw new Error('No pool_id found in subscription metadata');
    }

    // Verify pool exists
    await ensurePoolExists(pool_id, null);

    const currentPeriodStart = new Date(subscription.current_period_start * 1000);
    const currentPeriodEnd = new Date(subscription.current_period_end * 1000);

    const subscriptionData = {
      subscription_id: subscription.id,
      pool_id,
      customer_id: subscription.customer,
      amount: subscription.plan.amount,
      currency: subscription.currency,
      interval: subscription.plan.interval,
      status: subscription.status,
      last_payment_date: currentPeriodStart,
      next_payment_date: currentPeriodEnd,
      metadata: {
        product_id: subscription.plan.product,
        price_id: subscription.plan.id,
        period_start: currentPeriodStart.toISOString(),
        period_end: currentPeriodEnd.toISOString(),
        billing_cycle_anchor: subscription.billing_cycle_anchor 
          ? new Date(subscription.billing_cycle_anchor * 1000).toISOString()
          : null,
        collection_method: subscription.collection_method,
        interval_count: subscription.plan.interval_count || 1
      }
    };

    await PoolQueries.createOrUpdateSubscription(subscriptionData);

    // Log initial payment event
    await PoolQueries.logPayment({
      pool_id,
      event_type: 'subscription.created',
      amount: subscription.plan.amount / 100,
      status: subscription.status,
      metadata: {
        subscription_id: subscription.id,
        customer_id: subscription.customer,
        original_amount: subscription.plan.amount,
        period_start: currentPeriodStart.toISOString(),
        period_end: currentPeriodEnd.toISOString()
      }
    });

    await new Promise(resolve => setTimeout(resolve, 1000));
    queueManager.completedWebhooks.add(`customer.subscription.created:${sessionId}`);

    logWebhookProgress('subscription.created', 'completed', {
      subscription_id: subscription.id,
      pool_id,
      amount: subscription.plan.amount / 100
    });
  }, 'handleSubscriptionCreated');
}

async function handleSubscriptionUpdated(subscription) {
  logWebhookProgress('subscription.updated', 'started', { subscription_id: subscription.id });

  await retryOperation(async () => {
    const pool_id = subscription.plan.metadata?.pool_id;
    let status = 'active';

    // Check if subscription is paused
    if (subscription.pause_collection && subscription.pause_collection.behavior === 'void') {
      status = 'paused';
    }

    await PoolQueries.createOrUpdateSubscription({
      subscription_id: subscription.id,
      pool_id,
      customer_id: subscription.customer,
      amount: subscription.plan.amount,
      currency: subscription.currency,
      interval: subscription.plan.interval,
      status: status,
      next_payment_date: new Date(subscription.current_period_end * 1000),
      metadata: {
        stripe_status: subscription.status,
        period_end: new Date(subscription.current_period_end * 1000).toISOString(),
        pause_collection: subscription.pause_collection ? 'void' : null,
        pause_resumes_at: subscription.pause_collection?.resumes_at ? 
          new Date(subscription.pause_collection.resumes_at * 1000).toISOString() : null
      }
    });

    logWebhookProgress('subscription.updated', 'completed', {
      subscription_id: subscription.id,
      status: status,
      pause_collection: subscription.pause_collection ? 'void' : null
    });
  }, 'handleSubscriptionUpdated');
}


async function handleSubscriptionCanceled(subscription) {
  logWebhookProgress('subscription.canceled', 'started', { subscription_id: subscription.id });

  await retryOperation(async () => {
    const pool_id = subscription.plan.metadata?.pool_id;
    if (!pool_id) {
      throw new Error('No pool_id found for subscription');
    }

    await PoolQueries.updateSubscriptionStatus({
      subscription_id: subscription.id,
      status: 'canceled',
      metadata: {
        canceled_at: new Date().toISOString(),
        cancel_reason: subscription.cancellation_details?.reason,
        period_end: subscription.current_period_end 
          ? new Date(subscription.current_period_end * 1000).toISOString()
          : null
      }
    });

    logWebhookProgress('subscription.canceled', 'completed', {
      subscription_id: subscription.id,
      pool_id,
      cancel_reason: subscription.cancellation_details?.reason
    });
  }, 'handleSubscriptionCanceled');
}

async function handlePayoutPaid(payout) {
  logWebhookProgress('payout.paid', 'started', { payout_id: payout.id });

  await retryOperation(async () => {
    const existingPayout = await PoolQueries.getPayoutById(payout.id);
    if (existingPayout) {
      logWebhookProgress('payout.paid', 'skipped', { 
        payout_id: payout.id,
        reason: 'already processed'
      });
      return;
    }

    const charges = await stripe.charges.list({
      arrival_payout: payout.id,
      limit: 100
    });

    const poolPayouts = {};
    for (const charge of charges.data) {
      if (charge.invoice) {
        const invoice = await stripe.invoices.retrieve(charge.invoice);
        if (invoice.subscription) {
          const subscription = await stripe.subscriptions.retrieve(invoice.subscription);
          const pool_id = subscription.plan.metadata?.pool_id;
          
          if (pool_id) {
            poolPayouts[pool_id] = poolPayouts[pool_id] || {
              amount: 0,
              payments: []
            };
            poolPayouts[pool_id].amount += charge.amount;
            poolPayouts[pool_id].payments.push({
              amount: charge.amount,
              subscription_id: invoice.subscription,
              charge_id: charge.id,
              invoice_id: invoice.id
            });
          }
        }
      }
    }

    for (const [pool_id, data] of Object.entries(poolPayouts)) {
      await PoolQueries.logPayoutWithTransaction({
        payout_id: payout.id,
        pool_id,
        amount: data.amount / 100,
        currency: payout.currency,
        bank_arrival_date: new Date(payout.arrival_date * 1000),
        bank_account: payout.destination,
        status: payout.status,
        metadata: {
          payments: data.payments,
          statement_descriptor: payout.statement_descriptor,
          method: payout.method,
          type: payout.type,
          processed_at: new Date().toISOString()
        }
      });

      logWebhookProgress('payout.paid', 'processed_pool', {
        payout_id: payout.id,
        pool_id,
        amount: data.amount / 100
      });
    }

    logWebhookProgress('payout.paid', 'completed', { 
      payout_id: payout.id,
      total_pools: Object.keys(poolPayouts).length
    });
  }, 'handlePayoutPaid');
}

async function handleCustomerUpdated(customer) {
  logWebhookProgress('customer.updated', 'started', { customer_id: customer.id });

  await retryOperation(async () => {
    // Retrieve full customer object with default payment method
    const customerWithPaymentMethod = await stripe.customers.retrieve(customer.id, {
      expand: ['invoice_settings.default_payment_method']
    });

    const defaultPaymentMethod = customerWithPaymentMethod.invoice_settings.default_payment_method;
    
    if (!defaultPaymentMethod || defaultPaymentMethod.type !== 'card') {
      console.log('No valid default payment method found for customer:', customer.id);
      return;
    }

    console.log('Processing customer update with payment method:', {
      customer_id: customer.id,
      payment_method_id: defaultPaymentMethod.id,
      card_last4: defaultPaymentMethod.card.last4
    });

    // Get all subscriptions for this customer
    const subscriptions = await stripe.subscriptions.list({
      customer: customer.id,
      expand: ['data.default_payment_method'],
      limit: 100
    });

    for (const subscription of subscriptions.data) {
      const pool_id = subscription.metadata?.pool_id;
      if (!pool_id) {
        console.log(`No pool_id found for subscription ${subscription.id}`);
        continue;
      }

      // Get previous payment method details
      const previousPaymentMethod = subscription.default_payment_method;

      // Update subscription's default payment method if different
      if (subscription.default_payment_method?.id !== defaultPaymentMethod.id) {
        await stripe.subscriptions.update(subscription.id, {
          default_payment_method: defaultPaymentMethod.id
        });
      }

      // Update in database
      await PoolQueries.updateSubscriptionPaymentMethod({
        subscription_id: subscription.id,
        payment_method_id: defaultPaymentMethod.id,
        card_last4: defaultPaymentMethod.card.last4,
        card_brand: defaultPaymentMethod.card.brand,
        card_exp_month: defaultPaymentMethod.card.exp_month,
        card_exp_year: defaultPaymentMethod.card.exp_year,
        card_country: defaultPaymentMethod.card.country,
        previous_payment_method: previousPaymentMethod ? {
          id: previousPaymentMethod.id,
          last4: previousPaymentMethod.card?.last4,
          brand: previousPaymentMethod.card?.brand
        } : null
      });

      logWebhookProgress('customer.updated', 'updated_subscription', {
        customer_id: customer.id,
        subscription_id: subscription.id,
        pool_id: pool_id,
        new_card_last4: defaultPaymentMethod.card.last4,
        payment_method_id: defaultPaymentMethod.id
      });
    }
  }, 'handleCustomerUpdated');

  logWebhookProgress('customer.updated', 'completed', { 
    customer_id: customer.id 
  });
}

export const stripeController = {
  // Handle checkout session creation
  async createCheckoutSession(req, res) {
    try {
      const { amount, currency, interval, pool_id, owner_id, username, email } = req.body;
      
      const hasSubscription = await PoolQueries.hasActiveSubscription(pool_id);
      await retryOperation(async () => {
        // Check for existing subscription
        if (hasSubscription) {
          return res.status(400).json({ 
            error: 'Active subscription already exists for this pool'
          });
        }

        // Create Stripe price
        const price = await stripe.prices.create({
          unit_amount: amount,
          currency,
          recurring: { interval },
          product: process.env.STRIPE_PRODUCT_ID,
          metadata: { pool_id }
        });

        // Create checkout session
        const session = await stripe.checkout.sessions.create({
          mode: 'subscription',
          payment_method_types: ['card'],
          line_items: [{ price: price.id, quantity: 1 }],
          success_url: `${process.env.FRONTEND_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${process.env.FRONTEND_URL}/cancel`,
          customer_email: email,
          metadata: { pool_id, owner_id, username, email, currency }
        });

        res.json({ url: session.url });
      }, 'createCheckoutSession');
    } catch (error) {
      console.error('Checkout Error:', error);
      res.status(500).json({ error: error.message });
    }
  },

  async createProductId(req, res) {
    try {
      const { name, description } = req.body;

      const product = await retryOperation(async () => {
        return await stripe.products.create({
          name: name || 'Subscription Product Test',
          description: description || 'Dynamic subscription product'
        });
      }, 'createProductId');

      console.log('Created Product ID:', product.id);
      res.json({ productId: product.id });
    } catch (error) {
      console.error('Error:', error);
      res.status(500).json({ error: error.message });
    }
  },

  async handleWebhook(req, res) {
    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        req.headers['stripe-signature'],
        process.env.STRIPE_WEBHOOK_SECRET
      );

      logWebhookProgress(event.type, 'received', { event_id: event.id });

      // Add priority-based delay
      const priority = WEBHOOK_PRIORITIES[event.type] || 10;
      await new Promise(resolve => setTimeout(resolve, priority * 500));

      switch (event.type) {
        case 'checkout.session.completed':
          await handleCheckoutCompleted(event.data.object);
          break;
        case 'invoice.paid':
          await handleInvoicePaid(event.data.object);
          break;
        case 'invoice.payment_failed':
          await handleInvoiceFailed(event.data.object);
          break;
        case 'customer.subscription.created':
          await handleSubscriptionCreated(event.data.object);
          break;
        case 'customer.subscription.updated':
          await handleSubscriptionUpdated(event.data.object);
          break;
        case 'customer.subscription.deleted':
          await handleSubscriptionCanceled(event.data.object);
          break;
        case 'payout.paid':
          await handlePayoutPaid(event.data.object);
          break;
        case 'customer.updated':
          await handleCustomerUpdated(event.data.object);
          break;
      }

      res.json({ received: true });
    } catch (error) {
      logWebhookProgress(event?.type || 'unknown', 'error', {
        error: error.message,
        stack: error.stack
      });
      res.status(200).json({ received: true });
    }
  },

  async setupPortalConfiguration(req, res) {
    try {
      const configuration = await retryOperation(async () => {
        return await stripe.billingPortal.configurations.create({
          business_profile: {
            headline: 'Vitaminer Cashback Pool',
          },
          features: {
            subscription_cancel: {
              enabled: true,
              mode: 'immediately',
              proration_behavior: 'none'
            },
            payment_method_update: { enabled: true },
            customer_update: {
              enabled: true,
              allowed_updates: ['email', 'address']
            }
          },
          default_return_url: process.env.FRONTEND_URL
        });
      }, 'setupPortalConfiguration');

      console.log('Created portal configuration:', configuration.id);
      res.json({ configuration_id: configuration.id });
    } catch (error) {
      console.error('Error creating portal configuration:', error);
      res.status(500).json({ error: error.message });
    }
  },

  async createUpdateSession(req, res) {
    try {
      const { poolId } = req.params;
      
      const result = await retryOperation(async () => {
        // First get subscription details
        const subscriptions = await PoolQueries.getSubscriptionsByPoolId(poolId);
        if (!subscriptions?.length) {
          throw new Error('No subscription found for this pool');
        }

        const customer_id = subscriptions[0].customer_id;
        const session = await stripe.billingPortal.sessions.create({
          customer: customer_id,
          return_url: `${process.env.FRONTEND_URL}/cancel`,
          configuration: process.env.STRIPE_PORTAL_CONFIG_ID
        });

        return session;
      }, 'createUpdateSession');

      res.json({ url: result.url });
    } catch (error) {
      console.error('Error creating portal session:', error);
      res.status(500).json({ error: error.message });
    }
  },

  async createTestPayout(req, res) {
    try {
      const { poolId } = req.params;
      
      // 1. Create a test customer
      const customer = await stripe.customers.create({
        email: 'test@example.com',
        source: 'tok_visa'
      });
  
      // 2. Create a product
      const product = await stripe.products.create({
        name: 'Test Pool Subscription'
      });
  
      // 3. Create a price/plan with pool metadata
      const price = await stripe.prices.create({
        unit_amount: 25000, // $250.00
        currency: 'usd',
        recurring: {
          interval: 'month'
        },
        product: product.id,
        metadata: {
          pool_id: poolId
        }
      });
  
      // 4. Create a subscription
      const subscription = await stripe.subscriptions.create({
        customer: customer.id,
        items: [{
          price: price.id,
        }],
        metadata: {
          pool_id: poolId
        }
      });
  
      // 5. Create an invoice
      const invoice = await stripe.invoices.create({
        customer: customer.id,
        subscription: subscription.id,
        metadata: {
          pool_id: poolId
        }
      });
  
      // 6. Pay the invoice
      await stripe.invoices.pay(invoice.id);
  
      // 7. Create payout
      const payout = await stripe.payouts.create({
        amount: 25000,
        currency: 'usd',
        metadata: {
          pool_id: poolId
        }
      });
  
      res.json({
        message: 'Production-like test created',
        data: {
          customer_id: customer.id,
          product_id: product.id,
          price_id: price.id,
          subscription_id: subscription.id,
          invoice_id: invoice.id,
          payout_id: payout.id,
          amount: 25000 / 100,
          pool_id: poolId
        }
      });
  
    } catch (error) {
      console.error('Error creating production test:', error);
      res.status(500).json({ 
        error: error.message,
        type: error.type,
        code: error.code 
      });
    }
  },
  
  async updateSubscriptionPrice(req, res) {
    try {
      const { poolId } = req.params;
      const { new_amount } = req.body;

      const result = await retryOperation(async () => {
        const subscriptions = await PoolQueries.getSubscriptionsByPoolId(poolId);
        if (!subscriptions?.length) {
          throw new Error('No subscription found for this pool');
        }
        if(subscriptions[0].status === 'canceled') {  
          throw new Error('Subscription is already canceled');
        }

        const subscription_id = subscriptions[0].subscription_id;
        const subscription = await stripe.subscriptions.retrieve(subscription_id);

        const newPrice = await stripe.prices.create({
          unit_amount: new_amount,
          currency: subscription.currency,
          recurring: {
            interval: subscription.items.data[0].price.recurring.interval,
            interval_count: subscription.items.data[0].price.recurring.interval_count
          },
          product: subscription.items.data[0].price.product,
          metadata: { pool_id: poolId }
        });

        const updatedSubscription = await stripe.subscriptions.update(subscription_id, {
          items: [{
            id: subscription.items.data[0].id,
            price: newPrice.id,
          }],
          proration_behavior: 'none'
        });

        await PoolQueries.updateSubscriptionPrice({
          subscription_id,
          amount: new_amount,
          metadata: {
            previous_amount: subscription.items.data[0].price.unit_amount,
            price_change_date: new Date().toISOString()
          }
        });

        return {
          old_amount: subscription.items.data[0].price.unit_amount / 100,
          new_amount: new_amount / 100,
          currency: subscription.currency,
          subscription: updatedSubscription
        };
      }, 'updateSubscriptionPrice');

      res.json({
        message: 'Subscription price updated successfully',
        ...result
      });
    } catch (error) {
      console.error('Error updating subscription price:', error);
      res.status(500).json({ error: error.message });
    }
  },

  async cancelSubscription(req, res) {
    try {
      const { poolId } = req.params;
      const { cancel_at_period_end = false } = req.body;

      const result = await retryOperation(async () => {
        const subscriptions = await PoolQueries.getSubscriptionsByPoolId(poolId);
        if (!subscriptions?.length) {
          throw new Error('No subscription found for this pool');
        }

        const subscription_id = subscriptions[0].subscription_id;
        let canceledSubscription;

        if (cancel_at_period_end) {
          canceledSubscription = await stripe.subscriptions.update(subscription_id, {
            cancel_at_period_end: true
          });
        } else {
          canceledSubscription = await stripe.subscriptions.cancel(subscription_id);
        }

        await PoolQueries.updateSubscriptionStatus({
          subscription_id,
          status: 'canceled',
          metadata: {
            canceled_at: new Date().toISOString(),
            cancel_at_period_end,
            cancel_effective_date: cancel_at_period_end ? 
              new Date(canceledSubscription.current_period_end * 1000).toISOString() :
              new Date().toISOString()
          }
        });

        logWebhookProgress('subscription.cancel', 'completed', {
          subscription_id,
          cancel_at_period_end,
          pool_id: poolId
        });

        return canceledSubscription;
      }, 'cancelSubscription');

      res.json({
        message: cancel_at_period_end ? 
          'Subscription will be canceled at the end of the billing period' : 
          'Subscription canceled immediately',
        subscription: result
      });
    } catch (error) {
      console.error('Error canceling subscription:', error);
      res.status(500).json({ error: error.message });
    }
  },
  async PauseSubscription(req, res) {
    try {
      const { poolId } = req.params;
   
      // Check if subscription can be paused
      const pauseCheck = await PoolQueries.canPauseSubscription(poolId);
      if (!pauseCheck.canPause) {
        return res.status(400).json({ 
          error: pauseCheck.reason 
        });
      }
   
      const result = await retryOperation(async () => {
        const subscriptions = await PoolQueries.getSubscriptionsByPoolId(poolId);
        if (!subscriptions?.length) {
          throw new Error('No subscription found for this pool');
        }
   
        const subscription_id = subscriptions[0].subscription_id;
        
        // Update Stripe subscription
        const pausedSubscription = await stripe.subscriptions.update(subscription_id, {
          pause_collection: { behavior: 'void' },
          proration_behavior: 'none' // Prevents proration

        });
   
        // Update local database
        await PoolQueries.updateSubscriptionPauseStatus(subscription_id, true);
   
        return pausedSubscription;
      }, 'pauseSubscription');
   
      res.json({
        subscription: result
      });
    } catch (error) {
      console.error('Error pausing subscription:', error);
      res.status(500).json({ error: error.message });
    }
   },
   
   async ResumeSubscription(req, res) {
    try {
      const { poolId } = req.params;
   
      // Check if subscription can be resumed
      const resumeCheck = await PoolQueries.canResumeSubscription(poolId);
      if (!resumeCheck.canResume) {
        return res.status(400).json({ 
          error: resumeCheck.reason || 'Cannot resume subscription' 
        });
      }
   
      const result = await retryOperation(async () => {
        const subscriptions = await PoolQueries.getSubscriptionsByPoolId(poolId);
        if (!subscriptions?.length) {
          throw new Error('No subscription found for this pool');
        }
        let resumedSubscription;
        const subscription_id = subscriptions[0].subscription_id;
        if (subscriptions.length > 0 && subscriptions[0].next_payment_date) {
          const nextPaymentDate = new Date(subscriptions[0].next_payment_date);
          const currentDate = new Date();
          console.log('Next Payment Date:', nextPaymentDate);
          console.log('Current Date:', currentDate);
          if (nextPaymentDate < currentDate) {
            resumedSubscription = await stripe.subscriptions.update(subscription_id, {
              pause_collection: null,
              proration_behavior: 'none',
              billing_cycle_anchor: 'now'
            });
            console.log('Resumed now');
          } else {
            resumedSubscription = await stripe.subscriptions.update(subscription_id, {
              pause_collection: null,
              proration_behavior: 'none',
              billing_cycle_anchor: 'unchanged'
            });
            console.log('Resumed with unchanged');
          }
        } else {
          throw new Error("No valid subscription data available.");
        }
     
        

        // Update Stripe subscription

        // Update local database
        await PoolQueries.updateSubscriptionPauseStatus(subscription_id, false);
   
        return resumedSubscription;
      }, 'resumeSubscription');
   
      res.json({
        subscription: result
      });
    } catch (error) {
      console.error('Error resuming subscription:', error);
      res.status(500).json({ error: error.message });
    }
   },

  async getSubscriptionsByPoolId(req, res) {
    try {
      const { poolId } = req.params;
      
      if (!poolId) {
        return res.status(400).json({ error: 'Pool ID is required' });
      }
      const pool_check = await PoolQueries.getPoolBalance(poolId);
      if (!pool_check) {
        res.json({
          pool_id: poolId,
          currency: null,
          current_balance: 0.00,
          subscriptions:[]
        })
      }
      else{

      const subscriptions = await retryOperation(async () => {
        const subs = await PoolQueries.getSubscriptionsByPoolId(poolId);
        if (!subs?.length) {
          return [];
        }

        return subs.map(sub => ({
          subscription_id: sub.subscription_id,
          status: sub.status,
          amount: sub.amount,
          currency: sub.currency,
          interval: sub.interval,
          last_payment_date: sub.last_payment_date,
          next_payment_date: sub.next_payment_date,
          card_details: sub.card_last4 ? {
            last4: sub.card_last4,
            brand: sub.card_brand,
            exp_month: sub.card_exp_month,
            exp_year: sub.card_exp_year
          } : null,
          metadata: sub.metadata
        }));
      }, 'getSubscriptionsByPoolId');
      const poolData = await PoolQueries.getPoolBalance(poolId);
      res.json({
        pool_id: poolData.pool_id,
        current_balance: poolData.current_balance,
        currency: poolData.currency,
        subscriptions: subscriptions,
      });
    }
    } catch (error) {
      console.error('Error in getSubscriptionsByPoolId:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  },
  async  getInvoiceTransactions(req, res) {
    try {
      const { poolId } = req.params;
      const transactions = await PoolQueries.getInvoiceTransactions(poolId);
      
      // Format the response
      const formattedTransactions = transactions.map(tx => ({
        id: tx.id,
        type: tx.event_type,
        status: tx.status,
        amount: tx.amount,
        date: tx.created_at,
        subscription_id: tx.subscription_id,
        interval: tx.interval,
        metadata: tx.metadata,
        currency: tx.metadata.currency
      }));
   
      res.json({
        pool_id: poolId,
        transactions: formattedTransactions
      });
      
    } catch (error) {
      console.error('Error getting invoice transactions:', error);
      res.status(500).json({ error: error.message });
    }
   },
  async getPoolBalance(req, res) {
    try {
      const { poolId } = req.params;
      
      if (!poolId) {
        return res.status(400).json({ error: 'Pool ID is required' });
      }
      const pool_check = await PoolQueries.getPoolBalance(poolId);
      if (!pool_check) {
        res.json({
          pool_id: poolId,
          currency: null,
          current_balance: 0.00,
        })
      }
      else{
      const pool = await retryOperation(async () => {
        const poolData = await PoolQueries.getPoolBalance(poolId);
        
        
        return poolData;
      }, 'getPoolBalance');

      res.json({
        pool_id: pool.pool_id,
        current_balance: pool.current_balance,
        currency: pool.currency,
        last_updated: pool.updated_at
      });
    }
    } catch (error) {
      console.error('Error in getPoolBalance:', error);
      if (error.message === 'Pool not found') {
        res.status(404).json({ error: 'Pool not found' });
      } else {
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  }
};

export const handlers = {
  handleCheckoutCompleted,
  handleInvoicePaid,
  handleInvoiceFailed,
  handleSubscriptionCreated,
  handleSubscriptionUpdated,
  handleSubscriptionCanceled,
  handlePayoutPaid,handleCustomerUpdated  
};

// Export utility functions for testing and reuse
export const utils = {
  retryOperation,
  ensurePoolExists,
  verifySubscriptionExists,
  getPaymentDetails,
  logWebhookProgress
};