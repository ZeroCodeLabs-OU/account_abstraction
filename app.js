import dotenv from 'dotenv';
dotenv.config();
import morgan from 'morgan';
import express from 'express';
import multer from 'multer';



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
  app.use((err, req, res, next) => {
    if (err.name === 'UnauthorizedError') {
      res.status(401).send('Unauthorized: No token provided or token was invalid');
    }
  });
  const PORT = process.env.PORT || 9000;
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });







//change the way we distribute from pool to user look into pool rewards table and get the amount to distribute 
//get the amount of usdc that needs to be distributed do the checks and then distribute it to the user
//update the pool rewards table with the amount distributed and update associated invoice and pool_id reward table 

//deploy the new contract on testnet look into the contract controller and deploy the contract on testnet
// deploy usdt for testing 
// create a endpoint where first we get exchange rate and multiple it with all the included pools and then set it in the table 
// and calculate it and store it in calcuated reward with that exchange rate  for that pool
// and then do check if the required usdc amount is greateer or equal to the total amount of usdc in contract then set the bulk setBulkWithdrawalAllowances and then check if usdc allowance is greater than or equal to do it and then do the distributino from contract to the pool smart address
// and then set the distribution status to true in db 
