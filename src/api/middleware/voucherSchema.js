const Joi = require('joi');

const createVoucherSchema = Joi.object({
    smart_account_id: Joi.number().integer().required(),
    name:Joi.string().max(255),
    description: Joi.string().max(255)
});



const DeleteVoucherSchema = Joi.object({
    voucher_id: Joi.number().integer().required()
});

const updateVoucherSchema = Joi.object({
    name:Joi.string().max(255),

    description: Joi.string().max(255)
});

module.exports = { createVoucherSchema, DeleteVoucherSchema,updateVoucherSchema };