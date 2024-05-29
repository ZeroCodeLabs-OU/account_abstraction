const express = require('express');
const app = express();
const validate = require('./src/api/middleware/validate'); 
require('dotenv').config();
const voucherController = require('./src/api/controllers/voucherController');
const walletController = require('./src/api/controllers/walletController');
const contractController = require('./src/api/controllers/contractController');

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
app.post('/create_voucher', validate(createVoucherSchema),voucherController.createVoucher);
app.get('/get_voucher/:voucher_id',voucherController.getVoucherById);
app.put('/update_voucher/:voucher_id', validate(updateVoucherSchema),voucherController.updateVoucher);
app.delete('/delete_voucher/:voucher_id', voucherController.deleteVoucher);
app.get('/vouchers/smart_account/:smart_account_id', voucherController.getVouchersBySmartAccountId);

//contract
app.post('/deploy_contract', contractController.deploySmartContract);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
