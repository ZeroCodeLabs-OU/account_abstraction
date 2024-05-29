const Joi = require('joi');


const createSmartAccountSchema = Joi.object({
  encrypted_wallet: Joi.object({
    iv: Joi.string().required(), 
    encryptedData: Joi.string().required() 
  }).required()
});



const getSmartAccountSchema = Joi.object({
  wallet_address: Joi.string().required()
});

const mintNFTSchema = Joi.object({
    contractAddress: Joi.string().required(),
    tokenId: Joi.number().integer().required(),
    quantity: Joi.number().integer().required(),
    email: Joi.string().email().required(),
    privateKey: Joi.string().required() // Handle this securely!
  });
module.exports = { createSmartAccountSchema ,getSmartAccountSchema,mintNFTSchema};
