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
  revokeTokens,
} from './src/api/controllers/contractController.js';
import { generateQRData, decryptAndRevoke } from './src/api/controllers/qrController.js';
const app = express();
const upload = multer({ storage: multer.memoryStorage() });
app.use(express.json());

app.get('/', (req, res) => {
  res.send('Server test working');
});
app.use(morgan('dev'));

// Smart account
app.post('/createSmartAccount',authenticateToken, createSmartAccount);
app.get('/getSmartAccount',getSmartAccount);
app.post('/api/jwt', authenticateToken, (req, res) => {
  res.json(req.auth);
});

  // voucher
  app.post('/create_voucher',authenticateToken, createVoucher);
  app.get('/get_voucher/:voucher_id',authenticateToken, getVoucherById);
  app.put('/update_voucher/:voucher_id',authenticateToken ,updateVoucher);
  app.delete('/delete_voucher/:voucher_id',authenticateToken, deleteVoucher);
  app.get('/vouchers_by_wallet_address/:wallet_address',authenticateToken ,getVouchersBySmartAccountId);
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
  

// Error handling for unauthorized access
app.use((err, req, res, next) => {
  if (err.name === 'UnauthorizedError') {
    res.status(401).send('Unauthorized: No token provided or token was invalid');
  }
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
