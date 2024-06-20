import express from 'express';
import multer from 'multer';
import dotenv from 'dotenv';
dotenv.config();

import { processFiles } from './src/api/services/firestorage.js';

import {
  createVoucher, 
  getVoucherById, 
  updateVoucher, 
  deleteVoucher, 
  getVouchersBySmartAccountId, 
  getVouchersBySmartAccountId_Status, 
  getVouchersByLocationAndRadius, 
  updateVoucherStatus, 
  getCollectedVouchers 
} from './src/api/controllers/voucherController.js';
import { getSmartAccount, createSmartAccount } from './src/api/controllers/walletController.js';
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

// Smart account
app.post('/createSmartAccount', createSmartAccount);
  app.get('/getSmartAccount', getSmartAccount);

  // voucher
  app.post('/create_voucher', createVoucher);
  app.get('/get_voucher/:voucher_id', getVoucherById);
  app.put('/update_voucher/:voucher_id', updateVoucher);
  app.delete('/delete_voucher/:voucher_id', deleteVoucher);
  app.get('/vouchers_by_wallet_address/:wallet_address', getVouchersBySmartAccountId);
  app.post('/vouchers/vouchers_by_status/:voucher_id', updateVoucherStatus);
  app.get('/vouchers/vouchers_by_status', getVouchersBySmartAccountId_Status);
  app.get('/vouchers/by-location', getVouchersByLocationAndRadius);
  app.get('/vouchers/collected', getCollectedVouchers);

  // contract interaction
  app.post('/deploy_contract', deploySmartContract);
  app.post('/mint', mintTokens);
  app.post('/revoke', revokeTokens);

  // QR
  app.post('/generate-qr-data', generateQRData);
  app.post('/decrypt-and-revoke', decryptAndRevoke);

  app.post('/uploadNFT', upload.fields([{ name: 'images', maxCount: 100 }, { name: 'metadata', maxCount: 100 }]), async (req, res) => {
    try {
        const images = req.files['images'] || [];
        const metadataFiles = req.files['metadata'] || [];
        const voucherId = req.body.voucherId;  

        if (!voucherId) {
            return res.status(400).send("Voucher ID is required.");
        }

        const { baseURI, firebaseImageUrls } = await processFiles(images, metadataFiles, voucherId);

        res.status(200).json({ baseURI, firebaseImageUrls });
    } catch (error) {
        console.error('Error processing files:', error);
        res.status(500).send('Error processing NFT data.');
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
