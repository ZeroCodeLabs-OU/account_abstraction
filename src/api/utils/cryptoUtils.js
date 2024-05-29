const crypto = require('crypto');

const key = process.env.ENCRYPTION_KEY; 
const ethers =require("ethers")
// Decryption function
function decrypt(encryptedData, inputIV) {
  const algorithm = 'aes-256-cbc';
  const decipher = crypto.createDecipheriv(algorithm, Buffer.from(key), Buffer.from(inputIV, 'hex'));
  let decrypted = decipher.update(encryptedData, 'hex', 'utf-8');
  decrypted += decipher.final('utf-8');
  return decrypted;
}

function getFunctionSelector(signature) {
  return ethers.keccak256(ethers.toUtf8Bytes(signature)).substring(0, 10);
}
module.exports = { decrypt ,getFunctionSelector};
