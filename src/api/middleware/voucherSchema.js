import Joi from 'joi';

export const createVoucherSchema = Joi.object({
  smart_account_id: Joi.number().integer().required(),
  name: Joi.string().max(255),
  description: Joi.string().max(255),
});

export const DeleteVoucherSchema = Joi.object({
  voucher_id: Joi.number().integer().required(),
});

export const updateVoucherSchema = Joi.object({
  name: Joi.string().max(255),

  description: Joi.string().max(255),
});
