import dotenv from 'dotenv';
dotenv.config();
import morgan from 'morgan';
import express from 'express';
import multer from 'multer';

import stripe from './src/api/config/stripe.js';

import {authenticateToken} from "./src/api/middleware/authenticateToken.js";
import {
  createVoucher, 
  getVoucherById, 
  updateVoucher, 
  deleteVoucher, 
  getVouchersBySmartAccountId, 
  getVouchersBySmartAccountId_Status, 
  getVouchersByLocationAndRadius, 
  updateVoucherStatus, 
  getCollectedVouchers ,updateVoucherAndMetadata
} from './src/api/controllers/voucherController.js';
import { getSmartAccount, createSmartAccount ,createAndDeploySmartAccount} from './src/api/controllers/walletController.js';
import {
  deploySmartContract,
  mintTokens,
  revokeTokens
} from './src/api/controllers/contractController.js';
import { generateQRData, decryptAndRevoke } from './src/api/controllers/qrController.js';
import {getERC20Balance,depositToPool,withdrawUSDC,batchSendUSDC,getPoolTreasuryInfo,addPoolAllocation,resetPoolAllocation,executePoolTransfers,batchAddPoolAllocations} from './src/api/controllers/CashBackContractController.js';



import {stripeController  } from './src/api/controllers/stripeController.js';

import {Payment_Controller,handleStripeWebhook   } from './src/api/controllers/paymentController.js';

const app = express();
const upload = multer({ storage: multer.memoryStorage() });
const storage = multer.memoryStorage();

app.post('/webhook', express.raw({type: 'application/json'}), handleStripeWebhook );

app.use(express.json());

app.get('/', (req, res) => {
  res.send('Server test working');
});

app.use(morgan('dev'));

// Smart account
app.post('/createSmartAccount',authenticateToken, createSmartAccount);
app.get('/getSmartAccount',authenticateToken,getSmartAccount);
app.post('/api/jwt', authenticateToken, (req, res) => {
  res.json(req.auth);
});

  // voucher
  app.post('/create_voucher',authenticateToken, createVoucher);
  app.get('/get_voucher/:voucher_id',authenticateToken, getVoucherById);
  app.put('/update_voucher/:voucher_id',authenticateToken ,updateVoucher);
  app.delete('/delete_voucher/:voucher_id',authenticateToken, deleteVoucher);
  app.get('/vouchers_by_wallet_address',authenticateToken ,getVouchersBySmartAccountId);
  app.post('/vouchers/vouchers_by_status/:voucher_id',authenticateToken, updateVoucherStatus);
  app.get('/vouchers/vouchers_by_status',authenticateToken, getVouchersBySmartAccountId_Status);
  app.get('/vouchers/by-location',authenticateToken, getVouchersByLocationAndRadius);
  app.get('/vouchers/collected',authenticateToken, getCollectedVouchers);

  // contract interaction,
  app.post('/deploy_contract',authenticateToken, deploySmartContract);
  app.post('/mint',authenticateToken, mintTokens);
  app.post('/revoke',authenticateToken, revokeTokens);

  // QR
  app.post('/generate-qr-data',authenticateToken, generateQRData);
  app.post('/decrypt-and-revoke',authenticateToken, decryptAndRevoke);

  //Combined endpoint
  app.post('/complete-process',authenticateToken, upload.fields([{ name: 'images', maxCount: 100 }, { name: 'metadata', maxCount: 100 }]), createAndDeploySmartAccount);

  // update voucher 
  app.put('/update-voucher', authenticateToken, upload.fields([{ name: 'images', maxCount: 100 }, { name: 'metadata', maxCount: 100 }]), updateVoucherAndMetadata);


  // get erc20 balance
  app.post('/get-erc20-balance', authenticateToken, getERC20Balance);
  // withdraw usdc
  app.post('/withdraw-usdc', authenticateToken, withdrawUSDC);
  // deposit to pool
  app.post('/deposit-to-pool', authenticateToken, depositToPool);
  //batch transfer
  app.post('/batch-transfer',authenticateToken, batchSendUSDC);

  // Operator functions
  app.post('/pool/add-allocation',authenticateToken, addPoolAllocation);
  app.post('/pool/batch-add-allocations',authenticateToken, batchAddPoolAllocations);
  app.post('/pool/reset-allocation',authenticateToken, resetPoolAllocation);
  app.post('/pool/execute-transfers',authenticateToken, executePoolTransfers);


  app.get('/pool/treasury-info',authenticateToken, getPoolTreasuryInfo);

  
  
  
  //stripe
  // app.post('/pools/create-checkout',authenticateToken, stripeController.createCheckoutSession);
  // app.get('/pools/:poolId/subscriptions',authenticateToken, stripeController.getSubscriptionsByPoolId);
  // app.get('/pools/:poolId/balance',authenticateToken, stripeController.getPoolBalance);
  // app.get('/pools/:poolId/invoices',authenticateToken, stripeController.getInvoiceTransactions);

  // app.post('/pools/:poolId/cancel',authenticateToken, stripeController.cancelSubscription);
  // app.post('/pools/:poolId/pause',authenticateToken, stripeController.PauseSubscription);
  // app.post('/pools/:poolId/resume',authenticateToken, stripeController.ResumeSubscription);

  // app.post('/pools/:poolId/update-session',authenticateToken, stripeController.createUpdateSession);
  // app.post('/pools/:poolId/update-price', authenticateToken,stripeController.updateSubscriptionPrice);
  // app.post('/pools/:poolId/test-payment-method', authenticateToken,stripeController.testingforpaymentype);

  // // config endpoint used for .env setup for stripe
  // app.post('/setup/config-portal', authenticateToken,stripeController.setupPortalConfiguration);
  // app.post('/setup/create-product', authenticateToken,stripeController.createProductId);

  // app.post('/admin/transfers/withdraw/:payout_id', authenticateToken, stripeController.markTransfersWithdrawn);
  // app.get('/admin/:poolId/transfers', authenticateToken, stripeController.getTransfersByPool);
  // app.get('/admin/transfers/payout/:payoutId', authenticateToken, stripeController.getTransfersByPayout);

  // app.post("/test/subscription",stripeController.createAndChargeInvoice);
  // app.post("/test/subscription-card",stripeController.createSetupSession);
  // app.post("/test/subscription-card/update",stripeController.createBillingPortalSession);

  app.post("/pools/add-card",authenticateToken, Payment_Controller.createSetupSession);
  app.get("/pools/:pool_id/card-details",authenticateToken, Payment_Controller.getPaymentMethodDetails);
  app.post("/pools/update-card",authenticateToken, Payment_Controller.createBillingPortalSession);
  app.post("/pools/invoice",authenticateToken, Payment_Controller.createAndChargeInvoice);
  app.put('/pools/update-email',authenticateToken, Payment_Controller.updatePoolEmail);
  app.get('/pools/:pool_id/invoices',authenticateToken, Payment_Controller.getPaidInvoices);
  app.post('/pools/rewards/initialize',authenticateToken, Payment_Controller.initializePoolRewards);
  app.post('/pools/rewards/distribute',authenticateToken, Payment_Controller.distributePoolRewards);
  app.post('/get-smart-account',authenticateToken, Payment_Controller.createSmartAccount);


  app.get('/pools/:pool_id/invoices/:invoice_id/rewards/usdc',authenticateToken, Payment_Controller.calculateRewardUSDCAmount);
  app.get('/invoices/pending-treasury',authenticateToken, Payment_Controller.getInvoicesPendingTreasury);
  app.post("/pools/rewards/pool-distribution",authenticateToken, Payment_Controller.processAndDistributeRewards);
  
  // app.post('/trigger-payout', async (req, res) => {
  //   try {
  //     const { transaction_id, method, currency } = req.body;
  
  //     if (!transaction_id || !method || !currency) {
  //       return res.status(400).json({
  //         success: false,
  //         message: 'Transaction ID, method, and currency are required'
  //       });
  //     }
  
  //     // 1️⃣ Fetch balance transaction details from Stripe
  //     const balanceTransaction = await stripe.balanceTransactions.retrieve(transaction_id);
      
  //     if (!balanceTransaction) {
  //       return res.status(404).json({
  //         success: false,
  //         message: 'Balance transaction not found'
  //       });
  //     }
  
  //     // 2️⃣ Ensure the transaction is available for payout
  //     if (!['available'].includes(balanceTransaction.status)) {
  //       return res.status(400).json({
  //         success: false,
  //         message: 'Balance transaction is not available for payout yet'
  //       });
  //     }
  
  //     // 3️⃣ Initiate a Payout for the Transaction Amount
  //     const payout = await stripe.payouts.create({
  //       amount: balanceTransaction.net, // Use net amount after fees
  //       currency: currency, // Ensure currency matches the transaction
  //       method: method, // "standard" or "instant"
  //     });
  
  //     return res.status(200).json({
  //       success: true,
  //       message: 'Payout initiated successfully',
  //       payout_id: payout.id,
  //       payout_status: payout.status
  //     });
  
  //   } catch (error) {
  //     console.error('Error triggering payout:', error);
  //     return res.status(500).json({
  //       success: false,
  //       error: error.message
  //     });
  //   }
  // });
  
  app.get('/payout-details/:payoutId', async (req, res) => {
    try {
      const { payoutId } = req.params;
  
      if (!payoutId) {
        return res.status(400).json({
          success: false,
          message: 'Payout ID is required'
        });
      }
  
      // 1. First fetch the payout details
      const payout = await stripe.payouts.retrieve(payoutId);
      
      // 2. Then fetch all balance transactions associated with this payout
      const balanceTransactions = await stripe.balanceTransactions.list({
        payout: payoutId,
        limit: 100 // Adjust based on your needs
      });
      const chargeTransactions = balanceTransactions.data.filter(t => t.type === 'charge');
      console.log('Transaction details:', {
        total_transactions: balanceTransactions.data.length,
        charge_transactions: chargeTransactions.length,
        transaction_ids: chargeTransactions.map(t => t.id)
      });
      // 3. Process and format the transactions data
      const transactionsData = balanceTransactions.data.map(transaction => ({
        id: transaction.id,
        amount: transaction.amount,
        net: transaction.net,
        fee: transaction.fee,
        currency: transaction.currency,
        type: transaction.type,
        status: transaction.status,
        available_on: new Date(transaction.available_on * 1000).toISOString(),
        created: new Date(transaction.created * 1000).toISOString()
      }));
  
      // 4. Calculate some summary statistics
      const summary = {
        total_amount: transactionsData.reduce((sum, t) => sum + t.amount, 0),
        total_fees: transactionsData.reduce((sum, t) => sum + t.fee, 0),
        total_net: transactionsData.reduce((sum, t) => sum + t.net, 0),
        transaction_count: transactionsData.length
      };
  
      // Log detailed information to console
      console.log('Payout Details:', {
        payout_id: payout.id,
        payout_amount: payout.amount,
        payout_status: payout.status,
        payout_currency: payout.currency,
        arrival_date: new Date(payout.arrival_date * 1000).toISOString(),
        summary,
        transactions: transactionsData
      });
  
      // Return response to client
      return res.status(200).json({
        success: true,
        payout: {
          id: payout.id,
          amount: payout.amount,
          currency: payout.currency,
          status: payout.status,
          arrival_date: new Date(payout.arrival_date * 1000).toISOString()
        },
        summary,
        transactions: transactionsData,
        charge_transactions: chargeTransactions
      });
  
    } catch (error) {
      console.error('Error fetching payout details:', error);
      return res.status(500).json({
        success: false,
        error: error.message
      });
    } 
  });


  app.get('/transaction-invoice/:transactionId', async (req, res) => {
    try {
      const { transactionId } = req.params;
  
      if (!transactionId) {
        return res.status(400).json({
          success: false,
          message: 'Transaction ID is required'
        });
      }
  
      // 1. Retrieve the balance transaction
      const balanceTransaction = await stripe.balanceTransactions.retrieve(transactionId);
      
      if (!balanceTransaction?.source) {
        return res.status(404).json({
          success: false,
          message: `No source found for transaction: ${transactionId}`
        });
      }
  
      // 2. Check if this is a charge-type transaction
      if (balanceTransaction.type !== 'charge') {
        return res.status(400).json({
          success: false,
          message: `Transaction ${transactionId} is not a charge (type: ${balanceTransaction.type})`
        });
      }
  
      // 3. Get the charge details
      const charge = await stripe.charges.retrieve(balanceTransaction.source);
  
      if (!charge?.payment_intent) {
        return res.status(404).json({
          success: false,
          message: `No payment intent found for charge: ${charge.id}`
        });
      }
  
      // 4. Get the payment intent
      const paymentIntent = await stripe.paymentIntents.retrieve(charge.payment_intent);
  
      if (!paymentIntent?.invoice) {
        return res.status(404).json({
          success: false,
          message: `No invoice found for payment intent: ${paymentIntent.id}`
        });
      }
  
      // 5. Get the invoice
      const invoice = await stripe.invoices.retrieve(paymentIntent.invoice);
  
      // 6. Format the response
      const invoiceData = {
        invoice_details: {
          id: invoice.id,
          number: invoice.number,
          status: invoice.status,
          amount_paid: invoice.amount_paid,
          amount_due: invoice.amount_due,
          currency: invoice.currency,
          customer_id: invoice.customer,
          customer_email: invoice.customer_email,
          metadata: invoice.metadata,
          created: new Date(invoice.created * 1000).toISOString(),
          payment_intent_id: paymentIntent.id
        },
        transaction_details: {
          id: balanceTransaction.id,
          amount: balanceTransaction.amount,
          net: balanceTransaction.net,
          fee: balanceTransaction.fee,
          currency: balanceTransaction.currency,
          type: balanceTransaction.type,
          status: balanceTransaction.status,
          available_on: new Date(balanceTransaction.available_on * 1000).toISOString(),
          created: new Date(balanceTransaction.created * 1000).toISOString()
        },
        charge_details: {
          id: charge.id,
          amount: charge.amount,
          status: charge.status,
          payment_method: charge.payment_method,
          payment_method_details: charge.payment_method_details
        }
      };
  
      // Log detailed information to console
      console.log('Invoice Details:', {
        transaction_id: transactionId,
        invoice_id: invoice.id,
        payment_intent_id: paymentIntent.id,
        charge_id: charge.id,
        amount: invoice.amount_paid,
        status: invoice.status
      });
  
      // Return response to client
      return res.status(200).json({
        success: true,
        data: invoiceData
      });
  
    } catch (error) {
      console.error('Error fetching invoice details:', error);
      return res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });
  app.use((err, req, res, next) => {
    if (err.name === 'UnauthorizedError') {
      res.status(401).send('Unauthorized: No token provided or token was invalid');
    }
  });
  const PORT = process.env.PORT || 9000;
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });







