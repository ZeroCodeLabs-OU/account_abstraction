import validate from './api/middleware/validate.js';
import {
  createVoucher,
  getVoucherById,
  updateVoucher,
  deleteVoucher,
  getVouchersBySmartAccountId
} from './api/controllers/voucherController.js';
import { createSmartAccountSchema, getSmartAccountSchema } from './api/middleware/validateRequest.js';
import {deploySmartContract} from './api/controllers/contractController.js';
import { createVoucherSchema, updateVoucherSchema, DeleteVoucherSchema } from './api/middleware/voucherSchema.js';
import {getSmartAccount, createSmartAccount} from './api/controllers/walletController.js';

import multer from 'multer';
import { notFound, errorHandler } from './middlewares.js';

import {
  startInstanceNode,
  uploadImagesToIPFS,
  createHeliaInstance,
  uploadMetadataToIPFS,
} from './api/services/ipfsService.js';

import express from 'express';
import morgan from 'morgan';
import helmet from 'helmet';
import cors from 'cors';

import dotenv from 'dotenv';
dotenv.config();

const app = express();
const upload = multer({dest: 'uploads/'});

async function RunServer() {
  const helia = await createHeliaInstance();
  await startInstanceNode(helia).catch(error => {
    console.error('Error starting the IPFS node', error);
  });

  app.use(morgan('dev'));
  app.use(helmet());
  app.use(cors());
  app.use(express.json());

  app.get('/', (req, res) => {
    res.send('server test working');
  });

  app.post('/ipfs/images', upload.array('files', 1000), async (req, res) => {
    await uploadImagesToIPFS(helia, req.files).then((cid) => {
      res.json({status: req.status, cid: cid}).status(200);
    }).catch((error) => {
      res.json({status: req.status, response: error}).status(500);
    });
  });

  app.post('/ipfs/metadata', upload.array('files', 1000), async (req, res) => {
    await uploadMetadataToIPFS(helia, req.files).then((cid) => {
      res.json({status: req.status, cid: cid}).status(200);
    }).catch((error) => {
      res.json({status: req.status, response: error}).status(500);
    });
  });

  // smart_account
  app.post('/createSmartAccount', validate(createSmartAccountSchema), createSmartAccount);
  app.get('/getSmartAccount', validate(getSmartAccountSchema), getSmartAccount);

  // voucher
  app.post('/create_voucher', validate(createVoucherSchema), createVoucher);
  app.get('/get_voucher/:voucher_id', getVoucherById);
  app.put('/update_voucher/:voucher_id', validate(updateVoucherSchema), updateVoucher);
  app.delete('/delete_voucher/:voucher_id', deleteVoucher);
  app.get('/vouchers/smart_account/:smart_account_id', getVouchersBySmartAccountId);

  // contract
  app.post('/deploy_contract', deploySmartContract);

  app.use(notFound);
  app.use(errorHandler);

  const port = process.env.PORT || 5000;
  app.listen(port, () => {
    console.log(`Listening: http://localhost:${port}`);
  });
}

RunServer().then(() => {});
