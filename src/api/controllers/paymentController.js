import Stripe from 'stripe';
import { PoolQueries } from '../utils/db_Payment_Queries.js';
import { getSigner, getSigner_network } from '../services/biconomyService.js';
import { createSmartAccountClient, createPaymaster } from '@biconomy/account';
import { ethers } from 'ethers';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const MAX_RETRIES = 3;
const RETRY_DELAY = 2000;
const USDC_ABI = [
  "function transfer(address to, uint256 amount) external returns (bool)",
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function balanceOf(address account) external view returns (uint256)",
  "function decimals() external view returns (uint8)"
];
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
async function calculateAndDistributeRewards(poolId, invoiceId, walletData, network, usdcTokenAddress) {
  // Biconomy setup
  const { signer, config } = getSigner_network(walletData, network);
  const paymaster = await createPaymaster({
      paymasterUrl: config.PAYMASTER_URL,
      strictMode: true,
  });

  const biconomyAccount = await createSmartAccountClient({
      signer,
      paymaster,
      bundlerUrl: config.BUNDLER_URL,
  });

  // Get USDC info
  const smartAccountAddress = await biconomyAccount.getAccountAddress();
  const provider = ethers.getDefaultProvider(config.INFURA_PROJECT_URL);
  const usdcContract = new ethers.Contract(usdcTokenAddress, USDC_ABI, provider);
  
  const decimals = await usdcContract.decimals();
  const balance = await usdcContract.balanceOf(smartAccountAddress);
  const usdcBalance = ethers.formatUnits(balance, decimals);

  // Get rewards
  const pendingRewards = await PoolQueries.getPendingRewardsForDistribution(poolId, invoiceId);
  if (!pendingRewards.length) {
      throw new Error('No pending rewards found');
  }

  // Calculate USDC amounts
  const totalPercentage = pendingRewards.reduce((sum, r) => sum + parseFloat(r.reward_percentage), 0);
  if (Math.abs(totalPercentage - 100) > 0.01) {
      throw new Error('Reward percentages must total 100%');
  }

  const rewardsWithUsdc = pendingRewards.map(reward => ({
      ...reward,
      calculated_reward_usdc: (parseFloat(usdcBalance) * reward.reward_percentage) / 100
  }));

  // Update USDC amounts
  await PoolQueries.updateRewardsWithUsdcAmounts(rewardsWithUsdc);

  // Execute transfers
  const transfers = rewardsWithUsdc.map(reward => ({
      to: reward.smart_account_address,
      amount: reward.calculated_reward_usdc.toString()
  }));

  const batchResult = await batchSendUSDC({
      transfers, 
      network,
      tokenAddress: usdcTokenAddress,
      wallet_data: walletData
  });

  // Update statuses
  await PoolQueries.finalizeRewardDistribution({
      pool_id: poolId,
      invoice_id: invoiceId,
      transaction_hash: batchResult.transactionHash
  });

  return {
      transaction_hash: batchResult.transactionHash,
      smart_account: smartAccountAddress,
      rewards_distributed: transfers.length,
      total_usdc: batchResult.totalAmount
  };
}

async function batchSendUSDC({ transfers, network, tokenAddress, wallet_data }) {
  if (!wallet_data?.encryptedData || !wallet_data?.iv) {
      throw new Error('Invalid encrypted wallet data');
  }

  if (!Array.isArray(transfers) || transfers.length === 0) {
      throw new Error('Transfers must be a non-empty array');
  }

  if (transfers.length > 100) {
      throw new Error('Maximum 100 transfers allowed in a batch');
  }

  // Validate each transfer
  for (const transfer of transfers) {
      if (!ethers.isAddress(transfer.to)) {
          throw new Error(`Invalid recipient address: ${transfer.to}`);
      }
      if (!transfer.amount || isNaN(transfer.amount)) {
          throw new Error(`Invalid amount for recipient ${transfer.to}`);
      }
  }

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

  const smartAccountAddress = await biconomySmartAccount.getAccountAddress();
  const provider = ethers.getDefaultProvider(config.INFURA_PROJECT_URL);
  const usdcContract = new ethers.Contract(tokenAddress, USDC_ABI, provider);

  const decimals = await usdcContract.decimals();
  const balance = await usdcContract.balanceOf(smartAccountAddress);

  let totalAmount = ethers.parseUnits('0', decimals);
  const transactions = [];

  for (const transfer of transfers) {
      const amountInWei = ethers.parseUnits(transfer.amount.toString(), decimals);
      totalAmount = totalAmount + amountInWei;

      transactions.push({
          to: tokenAddress,
          data: usdcContract.interface.encodeFunctionData("transfer", [
              transfer.to,
              amountInWei
          ])
      });
  }

  if (balance < totalAmount) {
      throw new Error('Insufficient USDC balance for batch transfer');
  }

  const txResponse = await biconomySmartAccount.sendTransaction(transactions, {
      paymasterServiceData: { mode: PaymasterMode.SPONSORED }
  });

  const { transactionHash } = await txResponse.waitForTxHash();
  const txReceipt = await txResponse.wait();

  if (txReceipt.success=='false') {
      throw new Error('Batch transfer failed');
  }

  return {
      transactionHash,
      from: smartAccountAddress,
      totalAmount: ethers.formatUnits(totalAmount, decimals),
      transferCount: transfers.length,
      receipt: txReceipt
  };
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

      const defaultPaymentMethodId = await getDefaultPaymentMethod(poolInfo.customer_id);
      await clearPendingInvoiceItems(poolInfo.customer_id);

      const invoiceItem = await stripe.invoiceItems.create({
          customer: poolInfo.customer_id,
          amount: amount,
          currency: currency,
          description: description || 'Pool payment'
      });

      const invoice = await stripe.invoices.create({
          customer: poolInfo.customer_id,
          auto_advance: true,
          collection_method: 'charge_automatically',
          default_payment_method: defaultPaymentMethodId.id,
          pending_invoice_items_behavior: 'include',
          metadata: {
              pool_id,
              description
          }
      });

      let paidInvoice;
      try {
          paidInvoice = await stripe.invoices.pay(invoice.id, {
              payment_method: defaultPaymentMethodId.id,
          });
      } catch (payError) {
          return res.status(200).json({
              success: false,
              error: 'Payment failed',
              details: payError.message,
              invoice_id: invoice.id
          });
      }
      const mapStripeStatus = (stripeStatus) => {
        const statusMap = {
          'paid': 'succeeded',
          'unpaid': 'pending',
          'uncollectible': 'failed',
          'void': 'cancelled',
        };
        return statusMap[stripeStatus] || 'pending';
      };
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
              stripe_amount: paidInvoice.amount_paid
          }
      });

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
},
async updatePoolEmail(req, res) {
  try {
      const { pool_id, new_email } = req.body;

      // Validate inputs
      if (!pool_id || !new_email) {
          return res.status(400).json({
              success: false,
              error: 'pool_id and new_email are required'
          });
      }

      // Validate email format
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(new_email)) {
          return res.status(400).json({
              success: false,
              error: 'Invalid email format'
          });
      }

      // Check if pool exists
      const poolInfo = await PoolQueries.getPoolInfo(pool_id);
      if (!poolInfo) {
          return res.status(200).json({
              success: false,
              error: 'Pool not found'
          });
      }

      // If pool has a customer, update email in Stripe too
      if (poolInfo.customer_id) {
          await stripe.customers.update(poolInfo.customer_id, {
              email: new_email
          });
      }

      // Update pool email
      const updatedPool = await PoolQueries.updatePoolEmail({
          pool_id,
          email: new_email,
          metadata: {
              previous_email: poolInfo.email,
              updated_at: new Date().toISOString()
          }
      });

      res.status(200).json({
          success: true,
          data: {
              pool_id: updatedPool.pool_id,
              email: updatedPool.email,
              previous_email: poolInfo.email,
              updated_at: updatedPool.updated_at
          }
      });

  } catch (error) {
      console.error('Error updating pool email:', error);
      res.status(500).json({
          success: false,
          error: error.message
      });
  }
}
,
async getPaidInvoices(req, res) {
  try {
      const { pool_id } = req.params;
      const { limit = 10, page = 1 } = req.query;

      if (!pool_id) {
          return res.status(400).json({
              success: false,
              error: 'pool_id is required'
          });
      }

      // Get paginated paid invoices
      const { invoices, total } = await PoolQueries.getPaidInvoices({
          pool_id,
          limit: parseInt(limit),
          offset: (parseInt(page) - 1) * parseInt(limit)
      });

      res.status(200).json({
          success: true,
          data: {
              invoices: invoices.map(invoice => ({
                  invoice_id: invoice.invoice_id,
                  amount: invoice.amount,
                  currency: invoice.currency,
                  paid_at: invoice.paid_at,
                  payment_intent_id: invoice.payment_intent_id,
                  status: invoice.status,
                  description: invoice.metadata?.description || null,
                  invoice_url: invoice.metadata?.invoice_url || null
              })),
              pagination: {
                  total,
                  page: parseInt(page),
                  limit: parseInt(limit),
                  total_pages: Math.ceil(total / parseInt(limit))
              }
          }
      });

  } catch (error) {
      console.error('Error fetching paid invoices:', error);
      res.status(500).json({
          success: false,
          error: error.message
      });
  }
}
,
async initializePoolRewards(req, res) {
  try {
      const { pool_id, invoice_id, rewards } = req.body;
      /* 
      rewards format: [
          { smart_account_address: "0x123...", reward_percentage: 2.5 },
          { smart_account_address: "0x456...", reward_percentage: 3.0 },
          ...
      ]
      */

      // Validate inputs
      if (!pool_id || !invoice_id || !Array.isArray(rewards) || rewards.length === 0) {
          return res.status(400).json({
              success: false,
              error: 'pool_id, invoice_id, and rewards array are required'
          });
      }

      // Validate total percentage doesn't exceed 100%
      const totalPercentage = rewards.reduce((sum, r) => sum + r.reward_percentage, 0);
      if (totalPercentage > 100) {
          return res.status(400).json({
              success: false,
              error: 'Total reward percentage cannot exceed 100%'
          });
      }

      // Check if invoice exists and is valid
      const invoice = await PoolQueries.getInvoiceDetails(invoice_id);
      if (!invoice) {
          return res.status(200).json({
              success: false,
              error: 'Invoice not found'
          });
      }

      // Verify invoice belongs to pool
      if (invoice.pool_id !== pool_id) {
          return res.status(200).json({
              success: false,
              error: 'Invoice does not belong to this pool'
          });
      }

      // Create reward entries
      const createdRewards = await PoolQueries.createBulkRewards({
          pool_id,
          invoice_id,
          invoice_amount: invoice.amount,
          rewards,
          metadata: {
              invoice_currency: invoice.currency,
              invoice_paid_at: invoice.paid_at,
              payment_intent_id: invoice.payment_intent_id
          }
      });

      res.status(200).json({
          success: true,
          data: {
              invoice_id,
              total_percentage: totalPercentage,
              rewards: createdRewards.map(reward => ({
                  reward_id: reward.id,
                  smart_account_address: reward.smart_account_address,
                  reward_percentage: reward.reward_percentage,
                  calculated_reward: reward.calculated_reward,
                  status: reward.status
              }))
          }
      });

  } catch (error) {
      console.error('Error initializing rewards:', error);
      res.status(500).json({
          success: false,
          error: error.message
      });
  }
}
,
async createSmartAccount  (req, res)  {
  try {
    const { wallet_data} = req.auth;
    const { network } = req.body;
    if (!wallet_data || !wallet_data.encryptedData || !wallet_data.iv) {
      return res.status(400).json({ error: 'Invalid encrypted wallet data' });
    }
    if (!network || (network !== 'mainnet' && network !== 'testnet')) {
      return res.status(400).json({ error: 'Invalid network parameter. Only "mainnet" and "testnet" are allowed.' });
    }

    // Get signer and configuration
    const { signer, config } = getSigner_network(wallet_data, network);
    // Setup Paymaster and other dependent services
    const paymaster = await createPaymaster({
      paymasterUrl: config.PAYMASTER_URL,
      strictMode: true,
    });

    const biconomySmartAccount = await createSmartAccountClient({
      signer,
      paymaster,
      bundlerUrl: config.BUNDLER_URL,
    });

    const smartAccountAddress = await biconomySmartAccount.getAccountAddress();
    
   
    res.status(200).json({
      walletAddress: signer.address,
      smartAccountAddress:smartAccountAddress
    });
  } catch (error) {
    console.error('Error creating smart account:', error);

    // Handling unique constraint violation specifically
    if (error.code === '23505' && error.detail.includes('wallet_address')) {
      const walletAddressMatch = error.detail.match(/\=\(([^)]+)\)/);
      const walletAddress = walletAddressMatch ? walletAddressMatch[1] : 'Unavailable';

      return res.status(409).json({
        error: 'A smart account with this wallet address already exists.',
        wallet_address: walletAddress,
      });
    }

    res.status(500).json({ error: 'Internal server error' });
  }
},
async  distributePoolRewards(req, res) {
  try {
      const { pool_id, invoice_id, usdc_token_address, network } = req.body;
      const { wallet_data } = req.auth;

      if (!wallet_data?.encryptedData || !wallet_data?.iv) {
          return res.status(400).json({ error: 'Invalid wallet data' });
      }

      if (!ethers.isAddress(usdc_token_address)) {
          return res.status(400).json({ error: 'Invalid USDC address' });
      }
      const distributionStatus = await PoolQueries.getDistributionStatus(pool_id, invoice_id);
       if (distributionStatus.isDistributed) {
           return res.status(200).json({
               success: false,
               error: 'Rewards already distributed',
               data: {
                   distribution_time: distributionStatus.distributed_at,
                   transaction_hash: distributionStatus.blockchain_tx_id,
                   smart_account_address: distributionStatus.smart_account_address,
                   rewards: distributionStatus.rewards.map(r => ({
                       smart_account: r.smart_account_address,
                       percentage: r.reward_percentage,
                       amount: r.calculated_reward_usdc
                   }))
               }
           });
       }

      const result = await calculateAndDistributeRewards(pool_id, invoice_id, wallet_data, network, usdc_token_address);

      res.status(200).json({
          success: true,
          data: result
      });

  } catch (error) {
      console.error('Reward distribution error:', error);
      res.status(500).json({ success: false, error: error.message });
  }
}
};


