const express = require('express');
const app = express();
const validate = require('./src/api/middleware/validate'); 
require('dotenv').config();
const voucherController = require('./src/api/controllers/voucherController');
const walletController = require('./src/api/controllers/walletController');
const contractController = require('./src/api/controllers/contractController');
const { generateQRData, decryptAndRevoke } = require('./src/api/controllers/qrController');

const { createSmartAccountSchema, getSmartAccountSchema } = require('./src/api/middleware/validateRequest');
const { createVoucherSchema, updateVoucherSchema,DeleteVoucherSchema } = require('./src/api/middleware/voucherSchema');
app.use(express.json());

app.get('/', (req, res) => {
  res.send('server test working');
});
//smart_account
app.post('/createSmartAccount', validate(createSmartAccountSchema), walletController.createSmartAccount);
app.get('/getSmartAccount', validate(getSmartAccountSchema), walletController.getSmartAccount);

//voucher
app.post('/create_voucher',voucherController.createVoucher);
app.get('/get_voucher/:voucher_id',voucherController.getVoucherById);
app.put('/update_voucher/:voucher_id',voucherController.updateVoucher);
app.delete('/delete_voucher/:voucher_id', voucherController.deleteVoucher);
app.get('/vouchers_by_wallet_address/:wallet_address', voucherController.getVouchersBySmartAccountId);
app.post('/vouchers/vouchers_by_status/:voucher_id',voucherController.updateVoucherStatus);

app.get('/vouchers/vouchers_by_status',voucherController.getVouchersBySmartAccountId_Status);
app.get('/vouchers/by-location', voucherController.getVouchersByLocationAndRadius);
app.get('/vouchers/collected', voucherController.getCollectedVouchers);

//contract interaction
app.post('/deploy_contract', contractController.deploySmartContract);
app.post('/mint', contractController.mintTokens);
app.post('/revoke', contractController.revokeTokens);

//QR
app.post('/generate-qr-data', generateQRData);
app.post('/decrypt-and-revoke', decryptAndRevoke);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
