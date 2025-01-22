import Stripe from 'stripe';
import { PoolQueries } from '../utils/db_Payment_Queries.js';
import { getSigner, getSigner_network } from '../services/biconomyService.js';
import { createSmartAccountClient, createPaymaster } from '@biconomy/account';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const MAX_RETRIES = 3;
const RETRY_DELAY = 2000;

// Helper function for retrying operations
async function retryOperation(operation, maxRetries = MAX_RETRIES) {
  let lastError;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === maxRetries) break;
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY * attempt));
    }
  }
  
  throw lastError;
}

async function handlePaymentIntentSucceeded(paymentIntent) {
  try {
    console.log('Processing payment intent:', paymentIntent);

    // Get invoice since that's where our metadata is
    const invoice = await stripe.invoices.retrieve(paymentIntent.invoice);
    if (!invoice?.metadata?.pool_id) {
      console.error('No pool_id found in invoice metadata');
      return;
    }

    // Check if transfer already exists
    const existingTransfer = await PoolQueries.getTransferByPaymentIntent(paymentIntent.id);
    if (existingTransfer) {
      console.log('Transfer already exists for payment intent:', paymentIntent.id);
      return;
    }

    // Get the charge and balance transaction
    const charge = await stripe.charges.retrieve(paymentIntent.latest_charge, {
      expand: ['balance_transaction']
    });

    if (!charge.balance_transaction) {
      console.error('No balance transaction found for charge:', charge.id);
      return;
    }

    // Create transfer record
    await PoolQueries.createTransfer({
      transaction_id: charge.balance_transaction.id,
      payment_intent_id: paymentIntent.id,
      invoice_id: paymentIntent.invoice,
      pool_id: invoice.metadata.pool_id,
      amount: paymentIntent.amount / 100,
      currency: paymentIntent.currency,
      payment_datetime: new Date(paymentIntent.created * 1000),
      status: 'active',
      metadata: {
        charge_id: charge.id,
        payment_method: paymentIntent.payment_method,
        balance_transaction: {
          amount: charge.balance_transaction.amount,
          fee: charge.balance_transaction.fee,
          net: charge.balance_transaction.net,
          available_on: charge.balance_transaction.available_on
        }
      }
    });

    console.log('Transfer record created:', {
      payment_intent_id: paymentIntent.id,
      transaction_id: charge.balance_transaction.id,
      amount: paymentIntent.amount / 100
    });

  } catch (error) {
    console.error('Error in handlePaymentIntentSucceeded:', error);
    throw error;
  }
}
// Webhook event handlers
async function handleSetupIntentSucceeded(setupIntent) {
  const { customer, payment_method, metadata } = setupIntent;
  
  try {
    // Set as default payment method
    await stripe.customers.update(customer, {
      invoice_settings: {
        default_payment_method: payment_method
      }
    });

    // Get payment method details
    const paymentMethod = await stripe.paymentMethods.retrieve(payment_method);

    // Log in our database
    if (metadata?.pool_id) {
      await PoolQueries.logPayment({
        pool_id: metadata.pool_id,
        event_type: 'payment_method.default_set',
        status: 'succeeded',
        metadata: {
          payment_method_id: payment_method,
          customer_id: customer,
          card_last4: paymentMethod.card?.last4,
          card_brand: paymentMethod.card?.brand
        }
      });
    }
  } catch (error) {
    console.error('Error in handleSetupIntentSucceeded:', error);
    throw error;
  }
}



async function handlePaymentIntentFailed(paymentIntent) {
  try {
    const { metadata, last_payment_error } = paymentIntent;
    
    if (!metadata?.pool_id) return;

    await PoolQueries.logPayment({
      pool_id: metadata.pool_id,
      event_type: 'payment_intent.failed',
      status: 'failed',
      metadata: {
        payment_intent_id: paymentIntent.id,
        error_message: last_payment_error?.message,
        error_code: last_payment_error?.code
      }
    });
  } catch (error) {
    console.error('Error in handlePaymentIntentFailed:', error);
    throw error;
  }
}
async function handlePayoutPaid(payout) {
  try {
    console.log('Processing payout:', payout.id);

    // Get all balance transactions for this payout
    const balanceTransactions = await stripe.balanceTransactions.list({
      payout: payout.id
    });

    // Update all transfers with payout information
    await PoolQueries.updateTransfersWithPayout({
      payout_id: payout.id,
      settlement_datetime: new Date(payout.arrival_date * 1000),
      transaction_ids: balanceTransactions.data.map(t => t.id)
    });

    console.log('Payout processed:', {
      payout_id: payout.id,
      transactions_processed: balanceTransactions.data.length
    });

  } catch (error) {
    console.error('Error processing payout:', error);
    throw error;
  }
}
async function createCustomer({ pool_id, email }) {
    try {
      if (!pool_id || !email) {
        throw new Error('pool_id and email are required');
      }
  
      // First check the pool table
      const existingCustomerId = await PoolQueries.getCustomerIdByPoolId(pool_id);
      if (existingCustomerId) {
        return {
          customerId: existingCustomerId,
          existing: true
        };
      }
  
      // Then check Stripe for existing customer with same email and pool_id
      const customers = await stripe.customers.list({
        email: email,
        limit: 100
      });
  
      const existingCustomer = customers.data.find(
        (customer) => customer.metadata.pool_id === pool_id
      );
  
      if (existingCustomer) {
        // Update pool table with the found customer ID
        await PoolQueries.updatePoolCustomerId(pool_id, existingCustomer.id);
        return {
          customerId: existingCustomer.id,
          existing: true
        };
      }
  
      // If no existing customer, create new one
      const customer = await stripe.customers.create({
        email,
        metadata: {
          pool_id,
          registrationDate: new Date().toISOString()
        }
      });
  
      // Update pool table with new customer ID
      await PoolQueries.updatePoolCustomerId(pool_id, customer.id);
  
      return {
        customerId: customer.id,
        existing: false
      };
    } catch (error) {
      console.error('Create customer error:', error);
      throw error;
    }
  }
  export const handleStripeWebhook = async (req, res) => {
    let event;
  
    try {
      // Get the webhook secret from environment variables
      const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
      
      // Verify the webhook signature
      event = stripe.webhooks.constructEvent(
        req.body,
        req.headers['stripe-signature'],
        webhookSecret
      );
  
      // Log webhook receipt
      console.log('Received webhook event:', event.type);
  
      // Handle different event types
      switch (event.type) {
        case 'setup_intent.succeeded':
          await retryOperation(() => handleSetupIntentSucceeded(event.data.object));
          break;
        case 'charge.succeeded':
          console.log('Charge succeeded:', event.data.object);
          const charge = event.data.object;
          if (charge.payment_intent) {
            const paymentIntent = await stripe.paymentIntents.retrieve(charge.payment_intent);
            await retryOperation(() => handlePaymentIntentSucceeded(paymentIntent));
            }
            break;
    
          case 'payout.paid':
            await retryOperation(() => handlePayoutPaid(event.data.object));
            break;
        // Add more event handlers as needed
  
        default:
          console.log(`Unhandled event type: ${event.type}`);
      }
  
      // Send success response
      res.json({ received: true });
    } catch (err) {
      console.error('Webhook error:', err.message);
      
      if (err.type === 'StripeSignatureVerificationError') {
        res.status(400).send(`Webhook signature verification failed.`);
        return;
      }
  
      // Log the error but send 200 response to acknowledge receipt
      res.status(200).json({
        received: true,
        error: err.message
      });
    }
  };
  async function getDefaultPaymentMethod(customerId) {
    try {
      if (!customerId) {
        return null;
      }
      
      const customer = await stripe.customers.retrieve(customerId);
      const defaultPaymentMethodId = customer.invoice_settings.default_payment_method;
  
      if (!defaultPaymentMethodId) {
        return null;
      }
  
      return await stripe.paymentMethods.retrieve(defaultPaymentMethodId);
    } catch (error) {
      console.error('Error fetching default payment method:', error);
      return null;
    }
  }
async function clearPendingInvoiceItems(customerId) {
    const existingItems = await stripe.invoiceItems.list({
      customer: customerId,
      pending: true
    });
  
    for (const item of existingItems.data) {
      await stripe.invoiceItems.del(item.id);
    }
  }

export const Payment_Controller = {
    async  createBillingPortalSession(req, res) {
        try {
          const { pool_id } = req.body;
          const poolInfo = await PoolQueries.getPoolInfo(pool_id);
          if (!poolInfo?.customer_id) {
            throw new Error('No customer found for this pool');
          }
          
          // Create a billing portal session
          const session = await stripe.billingPortal.sessions.create({
            customer: poolInfo?.customer_id,
            return_url: `${process.env.FRONTEND_URL}/success`
          });
      
          res.status(200).json({
            success: true,
            url: session.url,
          });
        } catch (error) {
          console.error('Error creating billing portal session:', error);
          res.status(500).json({
            success: false,
            error: error.message,
          });
        }
      },
  // Get payment method details
  async getPaymentMethodDetails(req, res) {
    try {
      const { pool_id } = req.params;
  
      if (!pool_id) {
        return res.status(400).json({
          success: false,
          error: 'Pool ID is required'
        });
      }
  
      const poolInfo = await PoolQueries.getPoolInfo(pool_id);
      if (!poolInfo?.customer_id) {
        return res.status(200).json({
          success: false,
          error: 'No customer found for this pool'
        });
      }
  
      const paymentMethod = await getDefaultPaymentMethod(poolInfo.customer_id);
      
      if (!paymentMethod || paymentMethod.type !== 'card') {
        return res.status(200).json({
          success: false,
          error: 'No card payment method found'
        });
      }
  
      res.status(200).json({
        success: true,              
        data: {
          type: paymentMethod.type,
          card: {
            brand: paymentMethod.card.brand,
            last4: paymentMethod.card.last4,
            exp_month: paymentMethod.card.exp_month,
            exp_year: paymentMethod.card.exp_year,
            country: paymentMethod.card.country
          }
        }
      });
    } catch (error) {
      console.error('Error fetching payment method details:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  },

  // Setup customer and add card
  async createSetupSession(req, res) {
    try {
        const { email, pool_id, network } = req.body;
        const { wallet_data } = req.auth;

        if (!wallet_data?.encryptedData || !wallet_data?.iv) {
            return res.status(400).json({ error: 'Invalid encrypted wallet data' });
        }

        if (!email || !pool_id) {
            return res.status(400).json({
                success: false,
                error: 'email and pool_id are required'
            });
        }

        // First check if pool exists and matches provided email
        const poolInfo = await PoolQueries.getPoolInfo(pool_id);
        if (poolInfo) {
            // If pool exists, verify email matches
            if (poolInfo.email !== email) {
                return res.status(200).json({
                    success: false,
                    error: 'Email does not match pool records',
                    data: {
                        pool_id,
                        provided_email: email,
                        stored_email: poolInfo.email
                    }
                });
            }

            // If pool has customer_id, check for existing payment method
            if (poolInfo.customer_id) {
                const paymentMethod = await getDefaultPaymentMethod(poolInfo.customer_id);
                if (paymentMethod) {
                    return res.status(200).json({
                        success: false,
                        error: 'Default payment method already exists',
                        data: {
                            card: {
                                brand: paymentMethod.card.brand,
                                last4: paymentMethod.card.last4,
                                exp_month: paymentMethod.card.exp_month,
                                exp_year: paymentMethod.card.exp_year
                            },
                            message: 'Please use update-card endpoint to modify payment method'
                        }
                    });
                }
            }
        }

        // Network validation
        if (!network || (network !== 'mainnet' && network !== 'testnet')) {
            return res.status(400).json({
                error: 'Invalid network parameter. Only "mainnet" and "testnet" are allowed.'
            });
        }

        let smartAccountAddress;
        // Only create new smart account if pool doesn't exist
        if (!poolInfo) {
            const { signer, config } = getSigner_network(wallet_data, network);
            const paymaster = await createPaymaster({
                paymasterUrl: config.PAYMASTER_URL,
                strictMode: true,
            });

            const biconomySmartAccount = await createSmartAccountClient({
                signer,
                paymaster,
                bundlerUrl: config.BUNDLER_URL,
            });

            smartAccountAddress = await biconomySmartAccount.getAccountAddress();

            // Create pool if it doesn't exist
            await PoolQueries.createOrUpdatePool({
                pool_id,
                email,
                smartAccountAddress,
                metadata: {
                    registration_source: 'setup_session',
                    registration_date: new Date().toISOString()
                }
            });
        }

        // Create/get customer
        const { customerId, existing } = await createCustomer({ pool_id, email });

        // Create setup session
        const session = await stripe.checkout.sessions.create({
            mode: 'setup',
            customer: customerId,
            payment_method_types: ['card'],
            success_url: `${process.env.FRONTEND_URL}/success`,
            cancel_url: `${process.env.FRONTEND_URL}/cancel`,
            metadata: {
                pool_id,
                smartAccountAddress: smartAccountAddress || poolInfo?.smart_account_address
            }
        });

        res.status(200).json({
            success: true,
            data: {
                sessionId: session.id,
                url: session.url,
                customerId: customerId,
                existing: existing
            }
        });
    } catch (error) {
        console.error('Create setup session error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
},
  async createAndChargeInvoice(req, res) {
    try {
      const { amount, pool_id, description, currency } = req.body;

      // Add amount validation
      if (!amount || amount <= 0) {
        return res.status(400).json({
          success: false,
          error: 'Invalid amount'
        });
      }

      const poolInfo = await PoolQueries.getPoolInfo(pool_id);
      if (!poolInfo?.customer_id) {
        return res.status(400).json({
          success: false,
          error: 'No customer found for this pool'
        });
      }
      const customerId=poolInfo.customer_id;
      console.log('Pool info:', poolInfo);
      const defaultPaymentMethodId = await getDefaultPaymentMethod(customerId);
      console.log('Default payment method:', defaultPaymentMethodId);
      await clearPendingInvoiceItems(poolInfo.customer_id);

      // Create invoice item with amount in cents
      const invoiceItem = await stripe.invoiceItems.create({
        customer: poolInfo.customer_id,
        amount: amount, // Convert to cents for Stripe
        currency: currency,
        description: description || 'Pool payment'
      });

      console.log('Invoice item created:', invoiceItem); // Debug log

      const invoice = await stripe.invoices.create({
        customer: customerId,
        auto_advance: true,
        collection_method: 'charge_automatically',
        default_payment_method: defaultPaymentMethodId.id,
        pending_invoice_items_behavior: 'include',
        metadata: {
          pool_id,
          description
        } 
      });

      console.log('Invoice created:', invoice); // Debug log

      const paidInvoice = await stripe.invoices.pay(invoice.id, {
        payment_method: defaultPaymentMethodId.id,
      });
      console.log('Paid invoice:', paidInvoice); // Debug log

      const mapStripeStatus = (stripeStatus) => {
        const statusMap = {
          'paid': 'succeeded',
          'unpaid': 'pending',
          'uncollectible': 'failed',
          'void': 'cancelled',
        };
        return statusMap[stripeStatus] || 'pending';
      };
      console.log('defaultPaymentMethodId:', defaultPaymentMethodId);
      // Store the original amount in our database
      await PoolQueries.createInvoice({
        invoice_id: paidInvoice.id,
        pool_id,
        amount: paidInvoice.amount_paid, 
        currency: currency,
        payment_method_id: defaultPaymentMethodId.id,
        status: mapStripeStatus(paidInvoice.status),
        payment_intent_id: paidInvoice.payment_intent,
        paid_at: new Date(),
        metadata: {
          description,
          payment_intent: paidInvoice.payment_intent,
          invoice_url: paidInvoice.hosted_invoice_url,
          stripe_amount: paidInvoice.amount_paid // Store Stripe amount for reference
        }
      });
      // const charge = await stripe.charges.retrieve(paidInvoice.payment_intent, {
      //   expand: ['balance_transaction']
      // });

      // await PoolQueries.createTransfer({
      //   transaction_id: charge.balance_transaction.id,
      //   payment_intent_id: paidInvoice.payment_intent,
      //   invoice_id: paidInvoice.id,
      //   pool_id: pool_id,
      //   amount: paidInvoice.amount_paid,
      //   currency: currency,
      //   payment_datetime: new Date(),
      //   status: 'active',
      //   metadata: {
      //     charge_id: charge.id,
      //     payment_method: defaultPaymentMethodId.id,
      //     balance_transaction: {
      //       amount: charge.balance_transaction.amount,
      //       fee: charge.balance_transaction.fee,
      //       net: charge.balance_transaction.net,
      //       available_on: charge.balance_transaction.available_on
      //     }
      //   }
      // });
      res.status(200).json({
        success: true,
        data: {
          invoiceId: paidInvoice.id,
          amount: paidInvoice.amount_paid,
          currency: paidInvoice.currency,
          status: paidInvoice.status,
          paidAt: new Date(paidInvoice.status_transitions.paid_at * 1000),
          invoiceUrl: paidInvoice.hosted_invoice_url
        }
      });
    } catch (error) {
      console.error('Create and charge invoice error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
}

};



