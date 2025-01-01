import Stripe from 'stripe';
import { PoolQueries } from '../utils/dbQueries.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export const stripeController = {
  // Handle checkout session creation
  async createCheckoutSession(req, res) {
    try {
      const { amount, currency, interval, pool_id, owner_id, username, email } = req.body;

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
    } catch (error) {
      console.error('Checkout Error:', error);
      res.status(500).json({ error: error.message });
    }
  },

  // Handle Stripe webhooks
  async handleWebhook(req, res) {
    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        req.headers['stripe-signature'],
        process.env.STRIPE_WEBHOOK_SECRET
      );

      console.log('Processing webhook:', {
        type: event.type,
        id: event.id
      });

      switch (event.type) {
        case 'checkout.session.completed':
          await handleCheckoutCompleted(event.data.object);
          break;

        case 'invoice.paid':
        case 'invoice.payment_succeeded':
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
              
      }

      res.json({ received: true });
    } catch (error) {
      console.error('Webhook Error:', {
        type: event?.type,
        error: error.message,
        stack: error.stack
      });
      res.status(200).json({ received: true });
    }
  },
  async cancelSubscription(req, res) {
    try {
      const { poolId } = req.params;
      const { cancel_at_period_end = false } = req.body;
      const sub = await PoolQueries.getSubscriptionsByPoolId(poolId);
      const subscription_id = sub[0]?.subscription_id;
      console.log('Canceling subscription:', {
        subscription_id,
        cancel_at_period_end
      });

      let canceledSubscription;
  
      if (cancel_at_period_end) {
        // Cancel at period end
        canceledSubscription = await stripe.subscriptions.update(subscription_id, {
          cancel_at_period_end: true
        });
      } else {
        // Immediate cancellation
        canceledSubscription = await stripe.subscriptions.cancel(subscription_id);
      }
  
      // Update our database
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
  
      res.json({
        message: cancel_at_period_end ? 
          'Subscription will be canceled at the end of the billing period' : 
          'Subscription canceled immediately',
        subscription: canceledSubscription
      });
  
    } catch (error) {
      console.error('Error canceling subscription:', error);
      res.status(500).json({ error: error.message });
    }
  }
  ,
  async getSubscriptionsByPoolId(req, res) {
    try {
      const { poolId } = req.params;
      
      if (!poolId) {
        return res.status(400).json({ error: 'Pool ID is required' });
      }

      const subscriptions = await PoolQueries.getSubscriptionsByPoolId(poolId);
      
      const formattedSubscriptions = subscriptions.map(sub => ({
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

      res.json({
        pool_id: poolId,
        current_balance: subscriptions[0]?.current_balance || 0,
        currency: subscriptions[0]?.pool_currency,
        subscriptions: formattedSubscriptions
      });
    } catch (error) {
      console.error('Error in getSubscriptionsByPoolId:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  },

  async getPoolBalance(req, res) {
    try {
      const { poolId } = req.params;
      
      if (!poolId) {
        return res.status(400).json({ error: 'Pool ID is required' });
      }

      const pool = await PoolQueries.getPoolBalance(poolId);
      
      if (!pool) {
        return res.status(404).json({ error: 'Pool not found' });
      }

      res.json({
        pool_id: pool.pool_id,
        current_balance: pool.current_balance,
        currency: pool.currency,
        last_updated: pool.updated_at      });
    } catch (error) {
      console.error('Error in getPoolBalance:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

};

// Handle successful checkout completion
async function handleCheckoutCompleted(session) {
  try {
    console.log('Processing checkout session:', session);
    const { pool_id, owner_id, username, email } = session.metadata;

    // Get payment details
    const paymentDetails = await getPaymentDetails(session);

    // Only create/update pool, don't handle balance here
    await PoolQueries.createOrUpdatePool({
      pool_id,
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

      // Create subscription but don't handle payment yet
      await PoolQueries.createOrUpdateSubscription({
        subscription_id: session.subscription,
        pool_id,
        customer_id: session.customer,
        amount: session.amount_total,
        currency: session.currency,
        interval: stripeSubscription.items.data[0].price.recurring.interval,
        status: stripeSubscription.status,
        ...(paymentDetails || {}), // Add card details if available
        metadata: {
          session_id: session.id,
          customer_email: email,
          initial_setup: true
        }
      });
    }
  } catch (error) {
    console.error('Error in handleCheckoutCompleted:', error);
    throw error;
  }
}

async function handlePayoutPaid(payout) {
  try {
    // Get charges in this payout
    const charges = await stripe.charges.list({
      payout: payout.id,
      expand: ['data.balance_transaction', 'data.invoice.subscription']
    });

    // Group charges by pool_id
    const poolPayouts = {};
    for (const charge of charges.data) {
      if (charge.invoice?.subscription) {
        const subscription = await stripe.subscriptions.retrieve(charge.invoice.subscription);
        const pool_id = subscription.metadata.pool_id;
        
        if (pool_id) {
          if (!poolPayouts[pool_id]) {
            poolPayouts[pool_id] = {
              amount: 0,
              charges: []
            };
          }
          poolPayouts[pool_id].amount += charge.amount;
          poolPayouts[pool_id].charges.push({
            amount: charge.amount,
            subscription_id: charge.invoice.subscription,
            charge_id: charge.id
          });
        }
      }
    }

    // Log payout for each pool
    for (const [pool_id, data] of Object.entries(poolPayouts)) {
      await PoolQueries.logPayout({
        payout_id: payout.id,
        pool_id,
        amount: data.amount / 100, // Convert from cents
        currency: payout.currency,
        bank_arrival_date: new Date(payout.arrival_date * 1000),
        bank_account: payout.destination,
        status: payout.status,
        metadata: {
          charges: data.charges,
          statement_descriptor: payout.statement_descriptor,
          method: payout.method
        }
      });
    }

  } catch (error) {
    console.error('Error processing payout:', error);
    throw error;
  }
}


// Handle successful invoice payments
async function handleInvoicePaid(invoice) {
  try {
    const subscription = await stripe.subscriptions.retrieve(invoice.subscription);
    const pool_id = subscription.metadata.pool_id;
    
    if (!pool_id) {
      console.error('No pool_id in subscription:', subscription.id);
      return;
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
        payment_intent: invoice.payment_intent
      }
    });

  } catch (error) {
    console.error('Error processing invoice payment:', error);
    throw error;
  }
}
// Handle invoice payment failures
async function handleInvoiceFailed(invoice) {
  try {
    const subscription = await stripe.subscriptions.retrieve(invoice.subscription);
    const pool_id = subscription.metadata.pool_id;

    if (!pool_id) {
      console.error('No pool_id found for subscription:', subscription.id);
      return;
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

    console.log('Recorded failed payment:', {
      subscription_id: subscription.id,
      amount: invoice.amount_due,
      attempt_count: invoice.attempt_count
    });
  } catch (error) {
    console.error('Error processing invoice failure:', error);
    throw error;
  }
}

async function handleSubscriptionUpdated(subscription) {
  try {
    const pool_id = subscription.metadata.pool_id || 
                    subscription.plan.metadata.pool_id;

    if (!pool_id) {
      console.error('No pool_id found for subscription:', subscription.id);
      return;
    }

    // Map Stripe status to our allowed statuses
    const statusMapping = {
      'incomplete': 'active',
      'incomplete_expired': 'canceled',
      'trialing': 'active',
      'active': 'active',
      'past_due': 'past_due',
      'canceled': 'canceled',
      'unpaid': 'past_due'
    };

    const mappedStatus = statusMapping[subscription.status] || 'active';
    const endDate = new Date(subscription.current_period_end * 1000);

    await PoolQueries.createOrUpdateSubscription({
      subscription_id: subscription.id,
      pool_id,
      customer_id: subscription.customer,
      amount: subscription.plan.amount,
      currency: subscription.currency,
      interval: subscription.plan.interval,
      status: mappedStatus,
      next_payment_date: endDate,
      metadata: {
        stripe_status: subscription.status,
        cancel_at: subscription.cancel_at,
        canceled_at: subscription.canceled_at,
        period_end: endDate.toISOString(),
        cancel_reason: subscription.cancellation_details?.reason
      }
    });

    console.log('Updated subscription:', {
      subscription_id: subscription.id,
      status: mappedStatus,
      stripe_status: subscription.status
    });
  } catch (error) {
    console.error('Error processing subscription update:', error);
    throw error;
  }
}



async function handleSubscriptionCreated(subscription) {
  try {
    console.log('Processing subscription creation:', subscription);
    
    // Get pool_id from metadata
    const pool_id = subscription.metadata.pool_id || 
                    subscription.plan.metadata.pool_id;

    if (!pool_id) {
      console.error('No pool_id found in subscription metadata:', subscription.id);
      return;
    }

    // Get dates from Stripe timestamps
    const currentPeriodStart = new Date(subscription.current_period_start * 1000);
    const currentPeriodEnd = new Date(subscription.current_period_end * 1000);

    const subscriptionData = {
      subscription_id: subscription.id,
      pool_id: pool_id,
      customer_id: subscription.customer,
      amount: subscription.plan.amount,
      currency: subscription.currency,
      interval: subscription.plan.interval,
      status: subscription.status, // Use Stripe status directly
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

    // Create the subscription in our database
    const result = await PoolQueries.createOrUpdateSubscription(subscriptionData);

    // Log initial payment event
    await PoolQueries.logPayment({
      pool_id: pool_id,
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

    console.log('Successfully created subscription:', {
      subscription_id: subscription.id,
      amount: subscription.plan.amount / 100,
      status: subscription.status,
      last_payment_date: currentPeriodStart,
      next_payment_date: currentPeriodEnd,
      pool_id: pool_id
    });

    return result;
  } catch (error) {
    console.error('Error processing subscription creation:', error);
    throw error;
  }
}

async function handleSubscriptionCanceled(subscription) {
  try {
    const pool_id = subscription.metadata.pool_id || 
                    subscription.plan.metadata.pool_id;

    if (!pool_id) {
      console.error('No pool_id found for subscription:', subscription.id);
      return;
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

    console.log('Subscription canceled:', {
      subscription_id: subscription.id,
      pool_id,
      cancel_reason: subscription.cancellation_details?.reason
    });
  } catch (error) {
    console.error('Error handling subscription cancellation:', error);
    throw error;
  }
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




export const handlers = {
  handleCheckoutCompleted,
  handleInvoicePaid,
  handleInvoiceFailed,
  handleSubscriptionCreated,
  handleSubscriptionUpdated
};