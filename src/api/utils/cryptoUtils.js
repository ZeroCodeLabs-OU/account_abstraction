import crypto from 'crypto';
import { ethers } from 'ethers';
import dotenv from 'dotenv';
dotenv.config();
const key = process.env.ENCRYPTION_KEY;

// Decryption function
function decrypt(encryptedData, inputIV) {
  const algorithm = 'aes-256-cbc';
  const decipher = crypto.createDecipheriv(algorithm, Buffer.from(key), Buffer.from(inputIV, 'hex'));
  let decrypted = decipher.update(encryptedData, 'hex', 'utf-8');
  decrypted += decipher.final('utf-8');
  return decrypted;
}

// Function to get the function selector from a function signature
function getFunctionSelector(signature) {
  return ethers.keccak256(ethers.toUtf8Bytes(signature)).substring(0, 10);
}

export { decrypt, getFunctionSelector };
