import Stripe from 'stripe';
import { PoolQueries } from '../utils/db_Payment_Queries.js';
import { getSigner, getSigner_network , get_address} from '../services/biconomyService.js';
import { createSmartAccountClient, createPaymaster,PaymasterMode } from '@biconomy/account';
import { ethers } from 'ethers';
import axios from 'axios';
const stripe = new Stripe(process.env.STRIPE_SECRET_TEST_KEY);
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
  const maxRetries = 3;
  const baseDelay = 1000;
  
  // Define API sources
  const apis = [
      {
          name: 'CoinGecko',
          fetch: async () => {
              const response = await axios.get(
                  `https://api.coingecko.com/api/v3/simple/price`,
                  {
                      params: {
                          ids: 'usd-coin',
                          vs_currencies: currency.toLowerCase()
                      },
                      timeout: 5000
                  }
              );
              if (!response.data['usd-coin'] || !response.data['usd-coin'][currency.toLowerCase()]) {
                  throw new Error('Invalid response format');
              }
              return 1 / response.data['usd-coin'][currency.toLowerCase()];
          }
      },
      {
          name: 'CryptoCompare',
          fetch: async () => {
              const response = await axios.get(
                  `https://min-api.cryptocompare.com/data/price`,
                  {
                      params: {
                          fsym: 'USDC',
                          tsyms: currency.toUpperCase()
                      },
                      timeout: 5000
                  }
              );
              if (!response.data || !response.data[currency.toUpperCase()]) {
                  throw new Error('Invalid response format');
              }
              return 1 / response.data[currency.toUpperCase()];
          }
      }
  ];

  // Try each API with retries
  for (const api of apis) {
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
          try {
              const rate = await api.fetch();
              console.log(`Exchange rate fetched from ${api.name}: ${rate} : ${currency}`);
              return rate;
              
          } catch (error) {
              const isRateLimit = error.response?.status === 429;
              const isLastAttempt = attempt === maxRetries;
              const isLastAPI = api === apis[apis.length - 1];

              // Only throw if this is the last attempt of the last API
              if (isLastAttempt && isLastAPI) {
                  throw new Error(`All APIs failed to fetch USDC exchange rate: ${error.message}`);
              }

              // Calculate delay for retry
              const delay = isRateLimit 
                  ? baseDelay * Math.pow(2, attempt)
                  : baseDelay;

              console.warn(`${api.name} attempt ${attempt} failed: ${error.message}`);
              console.warn(`Waiting ${delay}ms before retry...`);
              
              await new Promise(resolve => setTimeout(resolve, delay));
          }
      }
      console.warn(`All attempts failed for ${api.name}, trying next API source...`);
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
  // USDC has 6 decimals on-chain, not 16 or 18
  const DB_DECIMALS = 10;
  const USDC_DECIMALS = 6;
  const CONVERSION_FACTOR = BigInt(10 ** (USDC_DECIMALS - DB_DECIMALS < 0 ? 0 : USDC_DECIMALS - DB_DECIMALS)); 

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
      console.log('Original Smart Account Address:', smartAccountAddress);

      // Normalize to proper EIP-55 checksum format
      const normalizedSmartAccountAddress = ethers.getAddress(smartAccountAddress.toLowerCase());
      console.log('Normalized Smart Account Address:', normalizedSmartAccountAddress);

      const pool_smart_account = await PoolQueries.getPoolSmartAccount(pool_id);
      console.log('Pool Smart Account Address:', pool_smart_account.smart_account_address);

      // Compare using lowercase to be safe
      if (pool_smart_account.smart_account_address.toLowerCase() !== normalizedSmartAccountAddress.toLowerCase()) {
        return {
          success: false,
          error: `Smart Account Address does not match. pool_smart_account: ${pool_smart_account.smart_account_address.toLowerCase()}, provided_smart_account: ${normalizedSmartAccountAddress.toLowerCase()}`
        };
      }
      
      // Initialize USDC contract
      const provider = ethers.getDefaultProvider(config.INFURA_PROJECT_URL);
      const usdcContract = new ethers.Contract(usdc_token_address, USDC_ABI, provider);
      const balance = await usdcContract.balanceOf(normalizedSmartAccountAddress);

      console.log('Initial balance:', ethers.formatUnits(balance, USDC_DECIMALS));

      // Normalize addresses and aggregate rewards by recipient
      const aggregatedRewards = pendingRewards.reduce((acc, reward) => {
        // Normalize address before using as a key
        const normalizedAddress = ethers.getAddress(reward.smart_account_address.toLowerCase());
        
        if (!acc[normalizedAddress]) {
            acc[normalizedAddress] = BigInt(0);
        }
        
        console.log('Processing reward:', {
            ...reward,
            normalized_address: normalizedAddress
        });
        
        // Handle floating point precision issues by rounding to 6 decimals maximum
        const rewardAmount = parseFloat(reward.calculated_reward_usdc).toFixed(6);
        // Convert directly to USDC units (6 decimals)
        const amountInUsdcUnits = ethers.parseUnits(rewardAmount, USDC_DECIMALS);
        
        acc[normalizedAddress] += amountInUsdcUnits;
        return acc;
      }, {});

      // Prepare transactions with normalized addresses
      const transactions = [];
      let totalAmount = BigInt(0);

      for (const [address, amount] of Object.entries(aggregatedRewards)) {
          // Normalize address again to be safe
          const normalizedAddress = ethers.getAddress(address.toLowerCase());
          
          console.log('Processing transfer:', {
              address: normalizedAddress,
              formattedAmount: ethers.formatUnits(amount, USDC_DECIMALS),
              rawAmount: amount.toString(),
          });

          const transferData = usdcContract.interface.encodeFunctionData("transfer", [
              normalizedAddress, // Use normalized address
              amount // Already in USDC units (6 decimals)
          ]);

          transactions.push({
              to: usdc_token_address,
              data: transferData
          });

          totalAmount += amount;
      }
      
      console.log('Balance check:', {
          required: ethers.formatUnits(totalAmount, USDC_DECIMALS),
          available: ethers.formatUnits(balance, USDC_DECIMALS),
          requiredRaw: totalAmount.toString(),
          availableRaw: balance.toString(),
          smartAccountAddress: normalizedSmartAccountAddress
      });

      if (balance < totalAmount) {
          throw new Error(`Insufficient balance. Required: ${ethers.formatUnits(totalAmount, USDC_DECIMALS)}, Available: ${ethers.formatUnits(balance, USDC_DECIMALS)}`);
      }

      // Execute batch transaction
      console.log('Sending batch transaction...');
      const txResponse = await biconomySmartAccount.sendTransaction(transactions, {
          paymasterServiceData: { mode: PaymasterMode.SPONSORED }
      });

      const { transactionHash } = await txResponse.waitForTxHash();
      console.log('Transaction hash:', transactionHash);

      const txReceipt = await txResponse.wait();
      
      if (txReceipt.success=='false') {
          throw new Error('Transaction failed to execute');
      }

      // Finalize the distribution
      await PoolQueries.finalizeRewardDistribution(
        transactionHash,
        pool_id,
        invoice_id
      );
      
      return {
          success: true,
          message: "Reward distribution completed successfully",
          data: {
              transactionHash,
              from: normalizedSmartAccountAddress,
              totalAmount: ethers.formatUnits(totalAmount, USDC_DECIMALS),
              recipientCount: Object.keys(aggregatedRewards).length,
              transfers: Object.entries(aggregatedRewards).map(([address, amount]) => ({
                  address: ethers.getAddress(address.toLowerCase()), // Normalize here too
                  amount: ethers.formatUnits(amount, USDC_DECIMALS)
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

    // Get ALL balance transactions for this payout using pagination
    let allTransactions = [];
    let hasMore = true;
    let startingAfter = null;
    
    while (hasMore) {
      const params = {
        payout: payout.id,
        limit: 100
      };
      
      if (startingAfter) {
        params.starting_after = startingAfter;
      }

      const balanceTransactions = await stripe.balanceTransactions.list(params);
      
      allTransactions = [...allTransactions, ...balanceTransactions.data];
      hasMore = balanceTransactions.has_more;
      
      if (hasMore && balanceTransactions.data.length > 0) {
        startingAfter = balanceTransactions.data[balanceTransactions.data.length - 1].id;
      }
    }

    // Log raw transaction data for debugging
    console.log('Raw transaction count:', allTransactions.length);
    console.log('Transaction types:', allTransactions.reduce((acc, t) => {
      acc[t.type] = (acc[t.type] || 0) + 1;
      return acc;
    }, {}));

    // Filter charge transactions
    const chargeTransactions = allTransactions.filter(t => t.type === 'charge');
    
    console.log('Transaction details:', {
      total_transactions: allTransactions.length,
      charge_transactions: chargeTransactions.length,
      transaction_ids: chargeTransactions.map(t => t.id),
      charges: chargeTransactions.map(t => ({
        id: t.id,
        amount: t.amount,
        status: t.status,
        source: t.source
      }))
    });

    if (chargeTransactions.length === 0) {
      console.warn('No charge transactions found for payout:', payout.id);
      return;
    }

    // Verify existing transfers
    const existingTransfers = await PoolQueries.getTransfersByTransactionIds(
      chargeTransactions.map(t => t.id)
    );

    console.log('Found existing transfers:', {
      transfers_found: existingTransfers.length,
      transfer_ids: existingTransfers.map(t => t.id),
      transfer_details: existingTransfers.map(t => ({
        id: t.id,
        transaction_id: t.transaction_id,
        amount: t.amount,
        status: t.status
      }))
    });

    if (existingTransfers.length === 0) {
      console.warn('No existing transfers found for transactions. Transaction IDs:', 
        chargeTransactions.map(t => t.id)
      );
      return;
    }

    // Update transfers with payout information
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

    // Verify all expected transfers were updated
    if (result.length !== existingTransfers.length) {
      console.warn('Not all transfers were updated:', {
        expected: existingTransfers.length,
        actual: result.length,
        missing: existingTransfers.filter(et => 
          !result.find(r => r.transaction_id === et.transaction_id)
        ).map(t => t.transaction_id)
      });
    }

  } catch (error) {
    console.error('Error processing payout:', error);
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
      const webhookSecret = process.env.STRIPE_WEBHOOK_TEST_SECRET;
      
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
          const { pool_id, network } = req.body;
          if (!network || ( network !== 'testnet')) {
            return res.status(400).json({ error: 'Invalid network parameter. Only "testnet" are allowed.' });
          }
          const poolInfo = await PoolQueries.getPoolInfo(pool_id,network);
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
      const network = 'testnet';
      if (!pool_id) {
        return res.status(400).json({
          success: false,
          error: 'Pool ID is required'
        });
      }

    if (!network || (network !== 'testnet')) {
        return res.status(400).json({ error: 'Invalid network parameter. Only "testnet" are allowed.' });
      }
  
      const poolInfo = await PoolQueries.getPoolInfo(pool_id,network);
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
        if (!network || ( network !== 'testnet')) {
          return res.status(400).json({ error: 'Invalid network parameter. Only "testnet" are allowed.' });
        }

        // First check if pool exists and matches provided email
        const poolInfo = await PoolQueries.getPoolInfo(pool_id,network);
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
                network,
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
      const { amount,network, pool_id, description, currency } = req.body;

      if (!amount || amount <= 0) {
          return res.status(400).json({
              success: false,
              error: 'Invalid amount'
          });
      }
      if (!network || (network !== 'testnet')) {
        return res.status(400).json({ error: 'Invalid network parameter. Only "testnet" are allowed.' });
      }

      const poolInfo = await PoolQueries.getPoolInfo(pool_id,network);
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
      const { pool_id, new_email, network } = req.body;

      // Validate inputs
      if (!pool_id || !new_email) {
          return res.status(400).json({
              success: false,
              error: 'pool_id and new_email are required'
          });
      }
    if (!network || (network !== 'testnet')) {
        return res.status(400).json({ error: 'Invalid network parameter. Only "testnet" are allowed.' });
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
      const poolInfo = await PoolQueries.getPoolInfo(pool_id,network);
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
async getCalculatedRewards(req, res) {
  try {
        const network = 'testnet';
        if (!network || (network !== 'testnet')) {
        return res.status(400).json({ error: 'Invalid network parameter. Only "testnet" are allowed.' });
      }
      
  
      const rewards = await PoolQueries.getPendingBatchRewards(network);
      if (!rewards?.length) return res.status(200).json({ success: false, error: 'No rewards found' });

      const USDC_DECIMALS = 6;

      // Extract unique currencies from rewards
      const uniqueCurrencies = [...new Set(
          rewards.map(r => r.metadata.invoice_currency.toLowerCase())
      )];

      // Fetch all exchange rates at once and store in a map
      const exchangeRates = new Map();
      await Promise.all(
          uniqueCurrencies.map(async currency => {
              if (currency === 'usdc') {
                  exchangeRates.set(currency, 1);
                  return;
              }
              try {
                  const rate = await getUSDCExchangeRate(currency);
                  exchangeRates.set(currency, rate);
              } catch (error) {
                  console.error(`Failed to get exchange rate for ${currency}:`, error);
                  throw error; // Re-throw to handle in the main catch block
              }
          })
      );

      const convertToStandardUnit = (amount, curr) => {
          const zeroDecimalCurrencies = ["bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga", "pyg", "rwf", "ugx", "vnd", "vuv", "xaf", "xof", "xpf"];
          const threeDecimalCurrencies = ["bhd", "jod", "kwd", "omr", "tnd"];
          if (zeroDecimalCurrencies.includes(curr)) return amount;
          if (threeDecimalCurrencies.includes(curr)) return amount / 1000;
          return amount / 100;
      };

      const formattedRewards = rewards.map(r => {
          const metadata = r.metadata;
          const currency = metadata.invoice_currency.toLowerCase();
          const exchangeRate = exchangeRates.get(currency);
          
          const distributionAmount = convertToStandardUnit(metadata.reward_calculation.distribution_amount, currency);
          const usdcAmount = Number((distributionAmount * exchangeRate).toFixed(USDC_DECIMALS));
          
          return {
              invoice_id: r.invoice_id,
              pool_id: r.pool_id,
              payout_id: r.payout_id,
              transaction_id: r.transaction_id,
              total_calculated_usdc: usdcAmount,
              settlement_datetime: r.settlement_datetime,
              reward_details: {
                  currency: currency.toUpperCase(),
                  invoice_amount: convertToStandardUnit(metadata.reward_calculation.original_amount, currency),
                  original_amount: convertToStandardUnit(metadata.reward_calculation.original_amount, currency),
                  distribution_amount: distributionAmount,
                  platform_fee_amount: convertToStandardUnit(metadata.platform_fee_amount, currency),
                  platform_fee_percentage: metadata.platform_fee_percentage,
                  exchange_rate: exchangeRate,
                  exchange_rate_date: new Date()
              }
          };
      });

      res.json({ success: true, data: formattedRewards });

  } catch (error) {
      console.error('Error calculating batch rewards:', error);
      res.status(500).json({ success: false, error: error.message });
  }
}
,
async getPaidInvoices(req, res) {
  try {
      const { pool_id } = req.params;
      const { limit = 10, page = 1 } = req.query;
      const network = 'testnet';
      if (!pool_id) {
          return res.status(400).json({
              success: false,
              error: 'pool_id is required'
          });
      }
    if (!network || (network !== 'testnet')) {
        return res.status(400).json({ error: 'Invalid network parameter. Only  "testnet" are allowed.' });
      }

      const poolInfo = await PoolQueries.getPoolInfo(pool_id,network);
      if (!poolInfo) {
          return res.status(200).json({
              success: false,
              error: 'Pool not found'
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
      const { pool_id,network, invoice_id, rewards } = req.body;

      // Basic validations
      if (!pool_id || !invoice_id || !Array.isArray(rewards) || rewards.length === 0) {
          return res.status(400).json({
              success: false,
              error: 'pool_id, invoice_id, and rewards array are required'
          });
      } 

    if (!network || (network !== 'testnet')) {
        return res.status(400).json({ error: 'Invalid network parameter. Only "testnet" are allowed.' });
      }
      
      const poolInfo = await PoolQueries.getPoolInfo(pool_id,network);
      if (!poolInfo?.customer_id) {
        return res.status(200).json({
          success: false,
          error: 'No customer found for this pool'
        });
      }
      const reward_detail = await PoolQueries.getRewardsForInvoice(pool_id, invoice_id);
      if (reward_detail?.length) {
          return res.status(200).json({
              success: false,
              error: 'Pool rewards already initialized for this invoice'
          });
      }
      
      // Simple Ethereum address validation
      const ethereumAddressRegex = /^0x[a-fA-F0-9]{40}$/;
      
      for (const reward of rewards) {
          if (!reward.smart_account_address) {
              return res.status(400).json({
                  success: false,
                  error: 'Each reward must have a smart_account_address'
              });
          }
          
          // Check basic Ethereum address format
          if (!ethereumAddressRegex.test(reward.smart_account_address)) {
              return res.status(400).json({
                  success: false,
                  error: `Invalid smart account address format: ${reward.smart_account_address}`
              });
          }
      }
      
      const invoice = await PoolQueries.getInvoiceDetails(invoice_id);
      if (!invoice) {
          return res.status(200).json({
              success: false,
              error: 'Invoice not found'
          });
      }
      const total_reward_amount = rewards.reduce((sum, r) => sum + r.reward_amount, 0);
      if (total_reward_amount>invoice.amount) { 
          return res.status(400).json({
              success: false,
              error: `Total reward :${total_reward_amount} amount must be  less than  invoice amount ${invoice.amount} `
          });
      }


      // Verify invoice belongs to pool
      if (invoice.pool_id !== pool_id) {
          return res.status(200).json({
              success: false,
              error: 'Invoice does not belong to this pool'
          });
      }

      

      // Create reward entries with adjusted calculations
      const createdRewards = await PoolQueries.createBulkRewards({
          pool_id,
          invoice_id,
          invoice_amount: invoice.amount,
          distribution_amount: total_reward_amount,
          rewards,
          metadata: {
              invoice_currency: invoice.currency,
              invoice_paid_at: invoice.paid_at,
              payment_intent_id: invoice.payment_intent_id,
              distribution_amount: total_reward_amount
          }
      });

      res.status(200).json({
          success: true,
          data: {
              invoice_id,
              distribution_amount: total_reward_amount,
              rewards: createdRewards.map(reward => ({
                  reward_id: reward.id,
                  smart_account_address: reward.smart_account_address,
                  calculated_reward: reward.reward_amount,
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
    if (!network || ( network !== 'testnet')) {
      return res.status(400).json({ error: 'Invalid network parameter. Only "testnet" are allowed.' });
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
  const { pool_id, invoice_id, network } = req.body;
  const { wallet_data } = req.auth;
  
  try {
    if (!network || (network !== 'testnet')) {
      return res.status(400).json({ error: 'Invalid network parameter. Only "testnet"  are allowed.' });
    }
    
    const poolInfo = await PoolQueries.getPoolInfo(pool_id,network);
    if (!poolInfo?.customer_id) {
      return res.status(200).json({
        success: false,
        error: 'No customer found for this pool'
      });
    }

    const address= await get_address(network)
    const usdc_token_address =address.Token
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

      const network = 'testnet';
    if (!network || (network !== 'testnet')) {
        return res.status(400).json({ error: 'Invalid network parameter. Only "testnet" are allowed.' });
      }
      
      const poolInfo = await PoolQueries.getPoolInfo(pool_id,network);
      if (!poolInfo?.customer_id) {
        return res.status(200).json({
          success: false,
          error: 'No customer found for this pool'
        });
      }
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
      const network = 'testnet';
      if (!network || (network !== 'testnet')) {
        return res.status(400).json({ error: 'Invalid network parameter. Only  and "testnet" are allowed.' });
      }
      
   
      const invoices = await PoolQueries.getInvoicesWithPayoutPendingTreasury(network);

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
      const { pool_id, invoice_id, network } = req.body;
      const { wallet_data } = req.auth;

      if (!wallet_data?.encryptedData || !wallet_data?.iv) {
          return res.status(200).json({ 
              success: false,
              error: 'Invalid wallet data' 
          });
      }
      if (!network || (network !== 'testnet')) {
        return res.status(400).json({ error: 'Invalid network parameter. Only  "testnet" are allowed.' });
      }
      const address= await get_address(network)
      console.log("address",address);
      const usdc_token_address =address.Token
      const distributor_contract_address =address.Distributor
      const poolInfo = await PoolQueries.getPoolInfo(pool_id,network);
      if (!poolInfo?.customer_id) {
        return res.status(200).json({
          success: false,
          error: 'No customer found for this pool'
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
        const convertToStandardUnit = (amount, curr) => {
          const zeroDecimalCurrencies = ["bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga", "pyg", "rwf", "ugx", "vnd", "vuv", "xaf", "xof", "xpf"];
          const threeDecimalCurrencies = ["bhd", "jod", "kwd", "omr", "tnd"];
          if (zeroDecimalCurrencies.includes(curr)) return amount;
          if (threeDecimalCurrencies.includes(curr)) return amount / 1000;
          return amount / 100;
      };
        // Update rewards with USDC calculations
        await PoolQueries.updateRewardsWithUSDC({
            pool_id,
            invoice_id,
            exchange_rate: exchangeRate,
            exchange_rate_date: new Date(),
            rewards: rewards_without_usdc.map(reward => ({
                id: reward.id,
                calculated_reward_usdc: parseFloat(convertToStandardUnit(reward.calculated_reward,rewards_without_usdc[0].currency.toLowerCase())) * exchangeRate
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
      const getChecksumAddress = (address) => {
        return ethers.getAddress(address.toLowerCase());
      };

      console.log('Aggregated rewards:', aggregatedRewards);
      const consolidatedRewards = Object.entries(aggregatedRewards).map(([address, total]) => ({
        address: getChecksumAddress(address),
        amount: formatUSDC(total)
      }));


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
      // Changed from 16 to 6 decimals for USDC
      const totalRequired = Object.values(aggregatedRewards).reduce((sum, amount) => {
        // Round to 6 decimal places to avoid precision errors
        const roundedAmount = parseFloat(amount).toFixed(6);
        return sum + ethers.parseUnits(roundedAmount, 6);
      }, BigInt(0));

      const contractBalance = await distributorContract.getContractBalance();

      console.log("Balance check:", {
        contractBalance: contractBalance.toString(), // Already in USDC format (6 decimals)
        totalRequired: totalRequired.toString(), // Now correctly in USDC format (6 decimals)
      });
    
      if (contractBalance < totalRequired) {
        return res.status(200).json({
          success: false,
          error: "Insufficient USDC in distributor contract",
          details: {
            required: ethers.formatUnits(totalRequired, 6), // Changed from 18 to 6 decimals
            available: ethers.formatUnits(contractBalance, 6), // Changed from 18 to 6 decimals
          },
        });
      }

      // Step 5: Process distribution with retries
      const retryTransaction = async (retryCount = 0) => {
          try {
              // Set bulk allowances
              // Fixed: individual reward amounts instead of total for each recipient
              const setBulkAllowanceData = new ethers.Interface(distributorABI)
                  .encodeFunctionData("setBulkWithdrawalAllowances", [
                      consolidatedRewards.map(r => r.address),
                      consolidatedRewards.map(r => ethers.parseUnits(r.amount, 6)) // Parse each amount properly
                  ]);


              const allowanceTx = {
                  to: distributor_contract_address,
                  data: setBulkAllowanceData
              };

              const allowanceResponse = await biconomyAccount.sendTransaction(allowanceTx, {
                  paymasterServiceData: { mode: PaymasterMode.SPONSORED }
              });

              console.log('Allowance transaction sent:', allowanceResponse);
              
              const allowanceReceipt = await allowanceResponse.wait();
              console.log('Allowance receipt:', allowanceReceipt);
              if (allowanceReceipt.success=="false") {
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
                  console.log('Withdrawal receipt:', withdrawReceipt);
                  if (withdrawReceipt.success=="false") {
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
                    total_distributed: ethers.formatUnits(totalRequired, 6) // Changed from 18 to 6 decimals
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

