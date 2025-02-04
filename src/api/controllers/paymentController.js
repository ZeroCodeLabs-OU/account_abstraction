import Stripe from 'stripe';
import { PoolQueries } from '../utils/db_Payment_Queries.js';
import { getSigner, getSigner_network } from '../services/biconomyService.js';
import { createSmartAccountClient, createPaymaster,PaymasterMode } from '@biconomy/account';
import { ethers } from 'ethers';
import axios from 'axios';
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const MAX_RETRIES = 3;
const RETRY_DELAY = 2000;
// import {TokenDistributor} from '../utils/contracts/TokenDistributor.json';
import TokenDistributor from "../utils/contracts/TokenDistributor.json" assert { type: "json" };

const USDC_ABI = [
  "function transfer(address to, uint256 amount) external returns (bool)",
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function balanceOf(address account) external view returns (uint256)",
  "function decimals() external view returns (uint8)"
];

const IERC20_ABI = [
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
async function getUSDCExchangeRate(currency) {
  try {
      const response = await axios.get(
          `https://api.coingecko.com/api/v3/simple/price`, {
              params: {
                  ids: 'usd-coin',
                  vs_currencies: currency
              }
          }
      );

      if (!response.data['usd-coin'] || !response.data['usd-coin'][currency]) {
          throw new Error(`Unable to get USDC rate for ${currency}`);
      }

      // Return the inverse rate since we want currency -> USDC
      return 1 / response.data['usd-coin'][currency];
  } catch (error) {
      throw new Error(`Failed to fetch USDC exchange rate: ${error.message}`);
  }
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

async function calculateAndDistributeRewards(pool_id, invoice_id, wallet_data, network, usdc_token_address) {
  const DB_DECIMALS = 10;
  const USDC_ONCHAIN_DECIMALS = 16;
  const CONVERSION_FACTOR = BigInt(10 ** (USDC_ONCHAIN_DECIMALS - DB_DECIMALS)); 

  console.log('Starting reward distribution for:', {
      pool_id,
      invoice_id,
      network,
      usdc_address: usdc_token_address
  });

  try {
      // Get pending rewards from database
      const pendingRewards = await PoolQueries.getPendingRewards(pool_id, invoice_id);
      console.log(`Found ${pendingRewards.length} pending rewards`);

      if (!pendingRewards?.length) {
          return {
              success: false,
              error: 'No pending rewards found'
          };
      }

      // Update rewards to processing status
      await PoolQueries.updateRewardsToProcessing(pool_id, invoice_id);
      console.log('Updated rewards status to processing');

      // Initialize blockchain components
      const { signer, config } = getSigner_network(wallet_data, network);
      console.log('Blockchain configuration loaded');

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
      console.log('Smart Account Address:', smartAccountAddress);

      // Initialize USDC contract
      const provider = ethers.getDefaultProvider(config.INFURA_PROJECT_URL);
      const usdcContract = new ethers.Contract(usdc_token_address, USDC_ABI, provider);
      const balance = await usdcContract.balanceOf(smartAccountAddress);

      console.log('Initial balance:', ethers.formatUnits(balance, USDC_ONCHAIN_DECIMALS));

      // Aggregate rewards by recipient
      const aggregatedRewards = pendingRewards.reduce((acc, reward) => {
        if (!acc[reward.smart_account_address]) {
            acc[reward.smart_account_address] = BigInt(0);
        }
        
        console.log('Processing reward:', reward);
        
        const amountE8 = ethers.parseUnits(reward.calculated_reward_usdc, DB_DECIMALS); 
        const amountE18 = amountE8 * CONVERSION_FACTOR; // Convert to 18 decimals
        acc[reward.smart_account_address] += amountE18;
        return acc;
    }, {});

      // Prepare transactions
      const transactions = [];
      let totalAmount = BigInt(0);

      for (const [address, amount] of Object.entries(aggregatedRewards)) {
          console.log('Processing transfer:', {
              address,
              originalAmount: ethers.formatUnits(amount, USDC_ONCHAIN_DECIMALS),
              rawAmount: amount.toString(),
          });

          const transferData = usdcContract.interface.encodeFunctionData("transfer", [
              address,
              amount // Already in 18 decimals
          ]);

          transactions.push({
              to: usdc_token_address,
              data: transferData
          });

          totalAmount += amount;
      }

      console.log('Balance check:', {
          required: ethers.formatUnits(totalAmount, USDC_ONCHAIN_DECIMALS),
          available: ethers.formatUnits(balance, USDC_ONCHAIN_DECIMALS),
          requiredRaw: totalAmount.toString(),
          availableRaw: balance.toString()
      });

      if (balance < totalAmount) {
          throw new Error(`Insufficient balance. Required: ${ethers.formatUnits(totalAmount, USDC_ONCHAIN_DECIMALS)}, Available: ${ethers.formatUnits(balance, USDC_ONCHAIN_DECIMALS)}`);
      }

      // Execute batch transaction
      console.log('Sending batch transaction...');
      const txResponse = await biconomySmartAccount.sendTransaction(transactions, {
          paymasterServiceData: { mode: PaymasterMode.SPONSORED }
      });

      const { transactionHash } = await txResponse.waitForTxHash();
      console.log('Transaction hash:', transactionHash);

      const txReceipt = await txResponse.wait();
      
      if (!txReceipt.success) {
          throw new Error('Transaction failed to execute');
      }

      // Finalize the distribution
      await PoolQueries.finalizeRewardDistribution(
        transactionHash,
          pool_id,
          invoice_id
      );
      //talk with stan about what he would like in return 
      return {
          success: true,
          message: "Reward distribution completed successfully",
          data: {
              transactionHash,
              from: smartAccountAddress,
              totalAmount: ethers.formatUnits(totalAmount, 18),
              recipientCount: Object.keys(aggregatedRewards).length,
              transfers: Object.entries(aggregatedRewards).map(([address, amount]) => ({
                  address,
                  amount: ethers.formatUnits(amount, 18)
              }))
          }
      };

  } catch (error) {
      console.error('Distribution error:', error);

      try {
          await PoolQueries.revertProcessingStatus(pool_id, invoice_id);
          console.log('Successfully reverted processing status');
      } catch (revertError) {
          console.error('Failed to revert processing status:', revertError);
      }

      return {
          success: false,
          error: error.message
      };
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

    // Filter only charge transactions as these are what we store in transfers
    const chargeTransactions = balanceTransactions.data.filter(t => t.type === 'charge');
    
    console.log('Transaction details:', {
      total_transactions: balanceTransactions.data.length,
      charge_transactions: chargeTransactions.length,
      transaction_ids: chargeTransactions.map(t => t.id)
    });

    // First verify if transfers exist for these transactions
    const existingTransfers = await PoolQueries.getTransfersByTransactionIds(
      chargeTransactions.map(t => t.id)
    );

    console.log('Existing transfers:', {
      transfers_found: existingTransfers.length,
      transfer_ids: existingTransfers.map(t => t.id)
    });

    if (existingTransfers.length === 0) {
      console.warn('No existing transfers found for these transactions');
      return;
    }

    // Update all transfers with payout information
    const result = await PoolQueries.updateTransfersWithPayout({
      payout_id: payout.id,
      settlement_datetime: new Date(payout.arrival_date * 1000),
      transaction_ids: chargeTransactions.map(t => t.id)
    });

    console.log('Update result:', {
      payout_id: payout.id,
      updated_transfers: result.length,
      updated_records: result
    });

  } catch (error) {
    console.error('Error processing payout:', error.message);
    console.error('Error stack:', error.stack);
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
          res.status(200).json({
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

      // First create invoice item
      const invoiceItem = await stripe.invoiceItems.create({
          customer: poolInfo.customer_id,
          amount: amount,
          currency: currency,
          description: description || 'Pool payment'
      });
      console.log('Created invoice item:', {
          id: invoiceItem.id,
          amount: invoiceItem.amount,
          currency: invoiceItem.currency
      });
      // Verify invoice item was created with correct amount
      if (!invoiceItem || invoiceItem.amount <= 0) {
          return res.status(500).json({
              success: false,
              error: 'Failed to create invoice item with correct amount'
          });
      }

      // Create invoice with items
      const invoice = await stripe.invoices.create({
          customer: poolInfo.customer_id,
          auto_advance: false, 
          currency: currency.toLowerCase(),
          collection_method: 'charge_automatically',
          default_payment_method: defaultPaymentMethodId.id,
          pending_invoice_items_behavior: 'include',
          metadata: {
              pool_id,
              description
          }
      });

      console.log('Created invoice:', {
          id: invoice.id,
          amount_due: invoice.amount_due,
          currency: invoice.currency,
          items_count: invoice.lines.data.length
      });

      // Finalize invoice to ensure all amounts are calculated
      const finalizedInvoice = await stripe.invoices.finalizeInvoice(invoice.id);

      // Verify invoice amount before payment
      if (finalizedInvoice.amount_due <= 0) {
          return res.status(500).json({
              success: false,
              error: 'Invoice amount is zero'
          });
      }

      // Pay the invoice with error handling
      let paidInvoice;
      try {
          paidInvoice = await stripe.invoices.pay(finalizedInvoice.id, {
              payment_method: defaultPaymentMethodId.id,
          });
      } catch (paymentError) {
          return res.status(200).json({
            success: false,
            error: 'Payment failed',
            details: paymentError.message,
            invoice_id: invoice.id
          });
      }

      // Verify payment intent exists
      if (!paidInvoice.payment_intent) {
          return res.status(500).json({
              success: false,
              error: 'Payment successful but no payment intent created',
              invoice_id: paidInvoice.id
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

      // Continue with database insertion...
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
              payment_intent: paidInvoice.payment_intent,
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

      // Basic validations
      if (!pool_id || !invoice_id || !Array.isArray(rewards) || rewards.length === 0) {
          return res.status(400).json({
              success: false,
              error: 'pool_id, invoice_id, and rewards array are required'
          });
      }

      // Validate total percentage doesn't exceed 100%
      const totalPercentage = rewards.reduce((sum, r) => sum + r.reward_percentage, 0);
      if (Math.abs(totalPercentage - 100) > 0.01) { // Using 0.01 for floating point comparison
          return res.status(400).json({
              success: false,
              error: `Total reward percentage must equal exactly 100% current total percentage ${totalPercentage}`
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

      // Calculate base amount after 10% reduction
      const platformFeePercentage = 10;
      const baseAmount = invoice.amount;
      const platformFee = (baseAmount * platformFeePercentage) / 100;
      const distributionAmount = baseAmount - platformFee;

      // Create reward entries with adjusted calculations
      const createdRewards = await PoolQueries.createBulkRewards({
          pool_id,
          invoice_id,
          invoice_amount: baseAmount,
          distribution_amount: distributionAmount,
          rewards,
          metadata: {
              invoice_currency: invoice.currency,
              invoice_paid_at: invoice.paid_at,
              payment_intent_id: invoice.payment_intent_id,
              platform_fee_percentage: platformFeePercentage,
              platform_fee_amount: platformFee,
              distribution_amount: distributionAmount
          }
      });

      res.status(200).json({
          success: true,
          data: {
              invoice_id,
              base_amount: baseAmount,
              platform_fee: platformFee,
              distribution_amount: distributionAmount,
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
  const { pool_id, invoice_id, usdc_token_address, network } = req.body;
  const { wallet_data } = req.auth;

  try {
      // Get pending rewards
      const rewards = await PoolQueries.getPendingRewards_user(pool_id, invoice_id);
      if (!rewards?.length) {
          return res.status(200).json({
              success: false,
              error: 'No pending rewards found, please check treasury_withdraw status'
          });
      }

      const pendingRewards = await PoolQueries.getPendingRewards(pool_id, invoice_id);
      
      if (!pendingRewards || pendingRewards.length === 0) {
          return res.status(200).json({
              success: false,
              error: 'No pending rewards found'
          });
      }
      console.log("usdc_token_address",usdc_token_address)  
      const result = await calculateAndDistributeRewards(
          pool_id,
          invoice_id,
          wallet_data,
          network,
          usdc_token_address
      );

      return res.status(200).json(result);

  } catch (error) {
      console.error('Distribution error:', error);
      return res.status(200).json({
          success: false,
          error: error.message
      });
  }
},
async calculateRewardUSDCAmount(req, res) {
  try {
      const { pool_id, invoice_id } = req.params;
      const USDC_DECIMALS = 6;

      const rewards = await PoolQueries.getRewardsForInvoice(pool_id, invoice_id);
      if (!rewards?.length) {
          return res.status(200).json({
              success: false,
              error: 'No rewards found for this invoice'
          });
      }

      const currency = rewards[0].metadata.invoice_currency.toLowerCase();

      // Helper function to convert from smallest unit based on currency
      const convertToStandardUnit = (amount, curr) => {
          const zeroDecimalCurrencies = ["bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga", "pyg", "rwf", "ugx", "vnd", "vuv", "xaf", "xof", "xpf"];
          const threeDecimalCurrencies = ["bhd", "jod", "kwd", "omr", "tnd"];
          let currency_decimals;
          if (zeroDecimalCurrencies.includes(curr)) {
            currency_decimals=0
              return amount; // No conversion needed
          } else if (threeDecimalCurrencies.includes(curr)) {
            currency_decimals=3
              return amount / 1000; // Divide by 1000 for 3 decimal currencies
          } else {
            currency_decimals=2
              return amount / 100; // Default - divide 
              // by 100 for 2 decimal currencies
          }
      };

      if (currency === 'usdc') {
          const totalAmount = rewards.reduce((sum, r) => {
              const actualAmount = convertToStandardUnit(parseFloat(r.calculated_reward), currency);
              return sum + actualAmount;
          }, 0);
          
          const formattedTotal = Number(totalAmount.toFixed(USDC_DECIMALS));
          
          return res.status(200).json({
              success: true,
              data: {
                  total_reward_amount: formattedTotal,
                  currency: 'USDC',
                  exchange_rate: 1,
                  exchange_rate_date: new Date(),
                  usdc_amount: formattedTotal
              }
          });
      }

      const exchangeRate = await getUSDCExchangeRate(currency);
      const totalRewardAmount = rewards.reduce((sum, r) => {
          const actualAmount = convertToStandardUnit(parseFloat(r.calculated_reward), currency);
          return sum + actualAmount;
      }, 0);

      const usdcAmount = Number((totalRewardAmount * exchangeRate).toFixed(USDC_DECIMALS));

      const formattedRewards = rewards.map(r => {
          const actualRewardAmount = convertToStandardUnit(parseFloat(r.calculated_reward), currency);
          const rewardUsdcAmount = Number((actualRewardAmount * exchangeRate).toFixed(USDC_DECIMALS));
          return {
              smart_account_address: r.smart_account_address,
              reward_percentage: r.reward_percentage,
              reward_amount: actualRewardAmount,
              usdc_amount: rewardUsdcAmount,
              original_amount: r.calculated_reward 
          };
      });
      
      res.status(200).json({
          success: true,
          data: {
              total_reward_amount: totalRewardAmount,
              currency: currency.toUpperCase(),
              exchange_rate: exchangeRate,
              exchange_rate_date: new Date(),
              usdc_amount: usdcAmount,
              rewards: formattedRewards
          }
      });

  } catch (error) {
      console.error('Error calculating USDC amount:', error);
      res.status(500).json({
          success: false,
          error: error.message
      });
  }
},
async getInvoicesPendingTreasury(req, res) {
  try {
      const invoices = await PoolQueries.getInvoicesWithPayoutPendingTreasury();

      if (!invoices || invoices.length === 0) {
          return res.status(200).json({
              success: false,
              message: 'No invoices found pending treasury withdrawal'
          });
      }

      res.status(200).json({
          success: true,
          data: {
              invoices: invoices.map(invoice => ({
                  invoice_id: invoice.invoice_id,
                  pool_id: invoice.pool_id,
                  amount: invoice.amount,
                  currency: invoice.currency,
                  payout_id: invoice.payout_id,
                  payout_date: invoice.settlement_datetime,
                  transaction_id: invoice.transaction_id
              }))
          }
      });

  } catch (error) {
      console.error('Error fetching invoices pending treasury:', error);
      res.status(500).json({
          success: false,
          error: error.message
      });
  }
}
,


async processAndDistributeRewards(req, res) {
  try {
      const { pool_id, invoice_id, network, usdc_token_address, distributor_contract_address } = req.body;
      const { wallet_data } = req.auth;

      if (!wallet_data?.encryptedData || !wallet_data?.iv) {
          return res.status(200).json({ 
              success: false,
              error: 'Invalid wallet data' 
          });
      }

      // Format USDC amounts to 6 decimals
      const formatUSDC = (amount) => {
          return parseFloat(amount).toFixed(6).replace(/\.?0+$/, '');
      };
      const rewards_without_usdc = await PoolQueries.getPendingRewardsWithoutUSDC(pool_id, invoice_id);
        if (!rewards_without_usdc?.length) {
            return res.status(200).json({
                success: false,
                error: 'No pending rewards found getPendingRewardsWithoutUSDC '
            });
        }

        const exchangeRate = await getUSDCExchangeRate(rewards_without_usdc[0].currency.toLowerCase());
        
        // Update rewards with USDC calculations
        await PoolQueries.updateRewardsWithUSDC({
            pool_id,
            invoice_id,
            exchange_rate: exchangeRate,
            exchange_rate_date: new Date(),
            rewards: rewards_without_usdc.map(reward => ({
                id: reward.id,
                calculated_reward_usdc: parseFloat(reward.calculated_reward) * exchangeRate
            }))
        });
      // Step 1: Get and validate rewards
      const rewards = await PoolQueries.getPendingRewards_pool(pool_id, invoice_id);
      if (!rewards?.length) {
          return res.status(200).json({
              success: false,
              error: 'No pending rewards found getPendingRewards_pool'
          });
      }

      // Aggregate rewards by smart account address
      const aggregatedRewards = rewards.reduce((acc, reward) => {
          if (!acc[reward.pool_smart_account]) {
              acc[reward.pool_smart_account] = 0;
          }
          acc[reward.pool_smart_account] += parseFloat(reward.calculated_reward_usdc);
          return acc;
      }, {});

      const consolidatedRewards = Object.entries(aggregatedRewards).map(([address, total]) => ({
          address,
          amount: formatUSDC(total)
      }));

      console.log('Consolidated rewards:', consolidatedRewards);

      // Step 2: Setup smart account
      const { signer, config } = getSigner_network(wallet_data, network);
      const paymaster = await createPaymaster({
          paymasterUrl: config.PAYMASTER_URL,
          strictMode: true,
      });

      const biconomyAccount = await createSmartAccountClient({
          signer,
          paymaster,
          bundlerUrl: config.BUNDLER_URL,
      });

      // Step 3: Setup contract interface
      const distributorABI = [
          "function getContractBalance() view returns (uint256)",
          "function setBulkWithdrawalAllowances(address[] calldata recipients, uint256[] calldata amounts)",
          "function withdrawTokens(address withdrawalAddress)"
      ];

      const provider = ethers.getDefaultProvider(config.INFURA_PROJECT_URL);
      const distributorContract = new ethers.Contract(distributor_contract_address, distributorABI, provider);

      // Step 4: Calculate total and check contract balance
      const totalRequired = Object.values(aggregatedRewards).reduce((sum, amount) => {
        return sum + ethers.parseUnits(amount.toString(), 16); 
      }, BigInt(0));

      const contractBalance = await distributorContract.getContractBalance();

      console.log("Balance check:", {
        contractBalance: contractBalance.toString(), // Already in e18
        totalRequired: totalRequired.toString(), // In e18
      });
    
      if (contractBalance < totalRequired) {
        return res.status(200).json({
          success: false,
          error: "Insufficient USDC in distributor contract",
          details: {
            required: ethers.formatUnits(totalRequired, 18), // Show in readable format
            available: ethers.formatUnits(contractBalance, 18), // Show in readable format
          },
        });
      }

      // Step 5: Process distribution with retries
      const retryTransaction = async (retryCount = 0) => {
          try {
              // Set bulk allowances
              const setBulkAllowanceData = new ethers.Interface(distributorABI)
                  .encodeFunctionData("setBulkWithdrawalAllowances", [
                      consolidatedRewards.map(r => r.address),
                      consolidatedRewards.map(r => totalRequired)
                  ]);

              console.log('Setting allowances:', consolidatedRewards);

              const allowanceTx = {
                  to: distributor_contract_address,
                  data: setBulkAllowanceData
              };

              const allowanceResponse = await biconomyAccount.sendTransaction(allowanceTx, {
                  paymasterServiceData: { mode: PaymasterMode.SPONSORED }
              });

              console.log('Allowance transaction sent:', allowanceResponse);
              
              const allowanceReceipt = await allowanceResponse.wait();
              if (!allowanceReceipt.success) {
                  throw new Error('Setting allowances failed');
              }

              // Process withdrawals for consolidated amounts
              const withdrawResults = [];
              for (const reward of consolidatedRewards) {
                  console.log('Processing withdrawal for:', reward.address);
                  
                  const withdrawData = new ethers.Interface(distributorABI)
                      .encodeFunctionData("withdrawTokens", [reward.address]);

                  const withdrawTx = {
                      to: distributor_contract_address,
                      data: withdrawData
                  };

                  const withdrawResponse = await biconomyAccount.sendTransaction(withdrawTx, {
                      paymasterServiceData: { mode: PaymasterMode.SPONSORED }
                  });

                  const withdrawReceipt = await withdrawResponse.wait();
                  if (!withdrawReceipt.success) {
                      throw new Error(`Withdrawal failed for ${reward.address}`);
                  }

                  withdrawResults.push({
                      address: reward.address,
                      amount: reward.amount,
                      txHash: withdrawReceipt.transactionHash
                  });
              }

              // Update status in database
              await PoolQueries.updateDistributionStatus({
                  pool_id,
                  invoice_id,
                  transaction_hash: allowanceReceipt.transactionHash,
                  status: 'succeeded'
              });

              return res.status(200).json({
                success: true,
                data: {
                    transactionHash: allowanceReceipt.receipt.transactionHash,
                    withdrawals: withdrawResults.map(withdrawal => ({
                        address: withdrawal.address
                    })),
                    total_distributed: ethers.formatUnits(totalRequired, 18)
                }
            });

          } catch (error) {
              console.error(`Distribution error (attempt ${retryCount + 1}):`, error);

              if (retryCount < 3) {
                  const delay = 2000 + (retryCount * 1000);
                  console.log(`Retrying in ${delay}ms...`);
                  await new Promise(resolve => setTimeout(resolve, delay));
                  return await retryTransaction(retryCount + 1);
              }

              return res.status(200).json({
                  success: false,
                  error: 'Distribution failed after maximum retries',
                  details: error.message
              });
          }
      };

      await retryTransaction();

  } catch (error) {
      console.error('Distribution process error:', error);
      return res.status(200).json({
          success: false,
          error: error.message
      });
  }
}

}

