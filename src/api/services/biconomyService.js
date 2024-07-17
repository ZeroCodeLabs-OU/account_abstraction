import { ethers } from 'ethers';
import { decrypt } from '../utils/cryptoUtils.js';
import dotenv from 'dotenv';
dotenv.config();
const infuraUrl = process.env.INFURA_PROJECT_URL;

function getSigner(encrypted_wallet) {
  // Decrypt retrieved data
  const encryptedDataString = String(encrypted_wallet.encryptedData);
  const ivString = String(encrypted_wallet.iv);
  const decrypted_wallet_string = decrypt(encryptedDataString, ivString);
  const decrypted_wallet = JSON.parse(decrypted_wallet_string);

  // Connect to JsonRpcProvider
  const infuraUrl = process.env.INFURA_PROJECT_URL || 'https://polygon-amoy.infura.io/v3/2IqgllOdDttzJ2c3mcp753wu0kW';
  const provider = new ethers.JsonRpcProvider(infuraUrl);

  // Create new Wallet object from decrypted private key
  const signer = new ethers.Wallet(decrypted_wallet.privateKey, provider);

  return signer;
}

export { getSigner };
