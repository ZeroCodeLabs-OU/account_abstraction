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

  async  setupPortalConfiguration() {
    try {
      const configuration = await stripe.billingPortal.configurations.create({
        business_profile: {
          headline: 'Zero-Code Labs',
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
  
      console.log('Created portal configuration:', configuration.id);
      return configuration.id;
    } catch (error) {
      console.error('Error creating portal configuration:', error);
      throw error;
    }
  }
,  
async  createUpdateSession(req, res) {
  try {
    const { poolId } = req.params;
    
    // First get subscription details from pool_id
    const subscriptions = await PoolQueries.getSubscriptionsByPoolId(poolId);
    
    if (!subscriptions || subscriptions.length === 0) {
      return res.status(404).json({ error: 'No subscription found for this pool' });
    }

    const customer_id = subscriptions[0].customer_id;

    const session = await stripe.billingPortal.sessions.create({
      customer: customer_id,
      return_url: `${process.env.FRONTEND_URL}/account`,
      configuration: process.env.STRIPE_PORTAL_CONFIG_ID
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error('Error creating portal session:', error);
    res.status(500).json({ error: error.message });
  }
}
,
async  createTestPayout(req, res) {
  try {
    const { poolId } = req.params;

    // 1. Get subscription data
    const subscriptions = await PoolQueries.getSubscriptionsByPoolId(poolId);
    if (!subscriptions.length) {
      return res.status(404).json({ error: 'No subscription found for this pool' });
    }

    const subscription = subscriptions[0];

    // Convert the amount to an integer (paise for INR)
    const amountInSmallestUnit = Math.round(subscription.amount);

    // 2. Create a Payment Intent
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountInSmallestUnit, // Ensure this is an integer
      currency: subscription.currency,
      customer: subscription.customer_id,
      payment_method: subscription.payment_method_id,
      off_session: true,
      confirm: true,
      metadata: {
        subscription_id: subscription.subscription_id,
        pool_id: poolId
      }
    });

    // 3. Create a test payout
    const payout = await stripe.payouts.create({
      amount: amountInSmallestUnit,
      currency: subscription.currency,
      metadata: {
        test_payment_intent_id: paymentIntent.id,
        pool_id: poolId,
        is_test: true
      }
    });

    res.json({
      message: 'Test payout created',
      data: {
        payment_intent_id: paymentIntent.id,
        payout_id: payout.id,
        amount: amountInSmallestUnit / 100,
        currency: subscription.currency
      }
    });

  } catch (error) {
    console.error('Error creating test payout:', error);
    res.status(500).json({ error: error.message });
  }
}

,
  async  updateSubscriptionPrice(req, res) {
    try {
      const { poolId } = req.params;
      const { new_amount } = req.body;
  
      // First get subscription details from pool_id
      const subscriptions = await PoolQueries.getSubscriptionsByPoolId(poolId);
      if (!subscriptions || subscriptions.length === 0) {
        return res.status(404).json({ error: 'No subscription found for this pool' });
      }
  
      const subscription_id = subscriptions[0].subscription_id; // Get the first active subscription
  
      // Get current subscription from Stripe
      const subscription = await stripe.subscriptions.retrieve(subscription_id);
  
      // Create new price
      const newPrice = await stripe.prices.create({
        unit_amount: new_amount,
        currency: subscription.currency,
        recurring: {
          interval: subscription.items.data[0].price.recurring.interval,
          interval_count: subscription.items.data[0].price.recurring.interval_count
        },
        product: subscription.items.data[0].price.product,
        metadata: { pool_id: poolId } // Keep pool_id in price metadata
      });
  
      // Update the subscription with new price
      const updatedSubscription = await stripe.subscriptions.update(subscription_id, {
        items: [{
          id: subscription.items.data[0].id,
          price: newPrice.id,
        }],
        proration_behavior: 'always_invoice' // or 'create_prorations' or 'none'
      });
  
      // Update our database
      await PoolQueries.updateSubscriptionPrice({
        subscription_id,
        amount: new_amount,
        metadata: {
          previous_amount: subscription.items.data[0].price.unit_amount,
          price_change_date: new Date().toISOString()
        }
      });
  
      res.json({
        message: 'Subscription price updated successfully',
        old_amount: subscription.items.data[0].price.unit_amount / 100,
        new_amount: new_amount / 100,
        currency: subscription.currency,
        subscription: updatedSubscription
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
    // Check if payout was already processed
    const existingPayout = await PoolQueries.getPayoutById(payout.id);
    if (existingPayout) {
      console.log(`Payout ${payout.id} already processed, skipping`);
      return;
    }

    // Get charges for this specific payout
    const charges = await stripe.charges.list({
      arrival_payout: payout.id,
      limit: 100
    });

    // Group by pool_id
    const poolPayouts = {};
    for (const charge of charges.data) {
      if (charge.invoice) {
        const invoice = await stripe.invoices.retrieve(charge.invoice);
        if (invoice.subscription) {
          const subscription = await stripe.subscriptions.retrieve(invoice.subscription);
          const pool_id = subscription.metadata.pool_id;
          
          if (pool_id) {
            if (!poolPayouts[pool_id]) {
              poolPayouts[pool_id] = {
                amount: 0,
                payments: []
              };
            }
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

    // Add each pool's payout in a transaction
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
    }

  } catch (error) {
    console.error('Error processing payout:', error);
    throw error;
  }
}



// Handle successful invoice payments
async function handleInvoicePaid(invoice) {
  try {
    // Get subscription with expanded details
    const subscription = await stripe.subscriptions.retrieve(
      invoice.subscription,
      { expand: ['default_payment_method'] }
    );

    // Get pool_id from either subscription metadata or plan metadata
    const pool_id = subscription.metadata.pool_id || 
                    subscription.plan.metadata.pool_id;

    if (!pool_id) {
      console.error('No pool_id in subscription or plan:', subscription.id);
      return;
    }

    // Process the payment
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

    console.log('Payment processed:', {
      subscription_id: subscription.id,
      pool_id,
      amount: invoice.amount_paid / 100,
      status: 'succeeded'
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