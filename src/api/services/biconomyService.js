import { ethers } from 'ethers';
import { decrypt } from '../utils/cryptoUtils.js';
import dotenv from 'dotenv';
dotenv.config();

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

  return {signer};
}


function getSigner_network(encrypted_wallet, network) {
  // Decrypt retrieved data
  const encryptedDataString = String(encrypted_wallet.encryptedData);
  const ivString = String(encrypted_wallet.iv);
  const decrypted_wallet_string = decrypt(encryptedDataString, ivString);
  const decrypted_wallet = JSON.parse(decrypted_wallet_string);

  // Select the correct configuration based on the network
  const config = {
    mainnet: {
      INFURA_PROJECT_URL: process.env.INFURA_PROJECT_URL_MAINNET,
      PAYMASTER_URL: process.env.PAYMASTER_URL_MAINNET,
      BUNDLER_URL: process.env.BUNDLER_URL_MAINNET,
      PAYMASTER_KEY: process.env.PAYMASTER_KEY_MAINNET,
      CHAINID: process.env.CHAINID_MAINNET
    },
    testnet: {
      INFURA_PROJECT_URL: process.env.INFURA_PROJECT_URL_TESTNET,
      PAYMASTER_URL: process.env.PAYMASTER_URL_TESTNET,
      BUNDLER_URL: process.env.BUNDLER_URL_TESTNET,
      PAYMASTER_KEY: process.env.PAYMASTER_KEY_TESTNET,
      CHAINID: process.env.CHAINID_TESTNET
    }
  }[network];

  // Connect to JsonRpcProvider
  const infuraUrl = config.INFURA_PROJECT_URL;
  const provider = new ethers.JsonRpcProvider(infuraUrl);

  // Create new Wallet object from decrypted private key
  const signer = new ethers.Wallet(decrypted_wallet.privateKey, provider);

  return { signer, config };
}
export { getSigner ,getSigner_network};


