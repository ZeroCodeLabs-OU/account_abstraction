import { ethers } from 'ethers';
import { createSmartAccountClient, createPaymaster, PaymasterMode } from '@biconomy/account';
import { getSigner } from '../services/biconomyService.js';
import db from '../config/dbConfig.js';
import contractJson from '../utils/contracts/erc1155.json' assert { type: 'json' };

import {
  fetchBaseURI,
  fetchAccountIdByWalletAddress,
  fetchSmartAccountIDBySmartAccountAddress,
  createSmartAccountContract,
  recordMintTransaction,
  recordRevokeTransaction,
  getContractAddressByVoucherId,getUidUsingVoucherId
} from '../utils/db_helper.js';

const { abi, bytecode } = contractJson;
import { encodeInitializationData } from '../utils/contractImplementation.js';

export const deploySmartContract = async (req, res) => {
  const { voucherId, name, max_supply, tokenQuantity, max_token_per_mint, max_token_per_person } = req.body;
  const { encrypted_wallet } = req.auth;

  if (!encrypted_wallet || !encrypted_wallet.encryptedData || !encrypted_wallet.iv) {
    console.error('Invalid encrypted wallet data:', encrypted_wallet);
    return res.status(400).json({ error: 'Invalid encrypted wallet data' });
  }

  try {
    console.log('Creating Paymaster...');
    const paymaster = await createPaymaster({
      paymasterUrl: process.env.PAYMASTER_URL,
    });

    const signerInstance = getSigner(encrypted_wallet);

    if (!signerInstance || !ethers.isAddress(signerInstance.address)) {
      console.error('Invalid or undefined signer address:', signerInstance);
      return res.status(400).json({ error: 'Invalid or undefined signer address' });
    }

    const biconomySmartAccount = await createSmartAccountClient({
      signer: signerInstance,
      biconomyPaymasterApiKey: process.env.PAYMASTER_KEY,
      bundlerUrl: process.env.BUNDLER_URL,
    });

    const randomSalt = ethers.hexlify(ethers.randomBytes(32));

    const deployData = new ethers.Interface([
      "function deploy(bytes32 _salt, bytes _creationCode) external returns (address)",
      "function addressOf(bytes32 _salt) external view returns (address)"
    ]).encodeFunctionData("deploy", [randomSalt, bytecode]);

    const txDeploy = {
      to: process.env.CONTRACT_DEPLOYER_ADDRESS,
      data: deployData,
    };

    const deployResponse = await biconomySmartAccount.sendTransaction(txDeploy, {
      paymasterServiceData: { mode: PaymasterMode.SPONSORED }
    });
    const { transactionHash } = await deployResponse.waitForTxHash();

    const receiptDeploy = await deployResponse.wait();

    if (!receiptDeploy.success) {
      throw new Error('Deployment transaction failed');
    }

    const addressData = new ethers.Interface([
      'function addressOf(bytes32 _salt) external view returns (address)',
    ]).encodeFunctionData('addressOf', [randomSalt]);

    console.log('Computing deployed contract address...');
    const computedAddress = await ethers.getDefaultProvider().call({
      to: txDeploy.to,
      data: addressData
    });

    function unpadEthereumAddress(computedAddress) {
      return '0x' + computedAddress.slice(26);
    }

    const deployedAddress = unpadEthereumAddress(computedAddress);

    const smartAccountAddress = await biconomySmartAccount.getAccountAddress();

    const smartAccountId = await fetchSmartAccountIDBySmartAccountAddress(smartAccountAddress);

    const base_URI = await fetchBaseURI(voucherId);

    const public_mint_start = Math.floor(Date.now() / 1000);
    const presale_mint_start = Math.floor(Date.now() / 1000) + 86400;
    const initData = encodeInitializationData(name, max_supply, tokenQuantity, max_token_per_mint, max_token_per_person, base_URI, public_mint_start, presale_mint_start, smartAccountAddress);

    const initTx = {
      to: deployedAddress,
      data: initData
    };
    console.log('Initialization transaction data:', initTx);

    console.log('Sending initialization transaction...');
    const initResponse = await biconomySmartAccount.sendTransaction(initTx, {
      paymasterServiceData: { mode: PaymasterMode.SPONSORED }
    });
    const initReceipt = await initResponse.wait();

    if (initReceipt.success == "false") {
      throw new Error('Initialization transaction failed');
    }

    console.log('Creating smart account contract record in the database...');
    const ContractResponse = await createSmartAccountContract({
      smartAccountId,
      voucherId,
      name,
      description: "",
      contractAddress: deployedAddress,
      chain: "MATIC_AMOY",
      type: "ERC1155",
      baseUri: base_URI,
      tokenSymbol: name.slice(0, 4),
      royaltyShare: 0,
      maxSupply: max_supply,
      teamReserved: 0,
      maxPerPerson: max_token_per_person,
      maxPerTransaction: max_token_per_mint,
      presaleMintStartDate: new Date(),
      publicMintStartDate: new Date(),
      prerevealBaseUri: "",
      sbtActivated: false,
      isGasless: false,
      isArchived: false,
      externalContract: false
    });

    const uid = await getUidUsingVoucherId(voucherId);

    res.status(200).json({
      message: "Contract deployed and initialized successfully",
      ContractResponse,
      uid
    });
  } catch (error) {
    console.error('Error deploying smart contract:', error);
    res.status(500).json({
      error: 'Internal server error',
      details: error.message
    });
  }
};

export const mintTokens = async (req, res) => {
  const { voucherId, id, amount = 1, tokenIndex = 1 } = req.body;
  const { encrypted_wallet } = req.auth;
  const data = "0x00";

  console.log('Received request body:', req.body);

  if (!encrypted_wallet || !encrypted_wallet.encryptedData || !encrypted_wallet.iv) {
    console.error('Invalid encrypted wallet data:', encrypted_wallet);
    return res.status(400).json({ error: 'Invalid encrypted wallet data' });
  }

  try {
    const signerInstance = getSigner(encrypted_wallet);
    if (!signerInstance || !ethers.isAddress(signerInstance.address)) {
      console.error('Invalid or undefined signer address:', signerInstance);
      return res.status(400).json({ error: 'Invalid or undefined signer address' });
    }

    const biconomySmartAccount = await createSmartAccountClient({
      signer: signerInstance,
      biconomyPaymasterApiKey: process.env.PAYMASTER_KEY,
      bundlerUrl: process.env.BUNDLER_URL
    });

    const contractAddress = await getContractAddressByVoucherId(voucherId);

    const mintFunctionData = new ethers.Interface([
      "function mint(uint256 amount, uint256 id, bytes memory data)"
    ]).encodeFunctionData("mint", [amount, id, data]);

    const tx = {
      to: contractAddress,
      data: mintFunctionData
    };

    const txResponse = await biconomySmartAccount.sendTransaction(tx, {
      paymasterServiceData: { mode: PaymasterMode.SPONSORED }
    });
    const txReceipt = await txResponse.wait();
    
    if (!txReceipt.success) {
      throw new Error('Mint transaction failed');
    }

    console.log('Mint transaction successful:', txReceipt);

    const smartAccountAddress = await biconomySmartAccount.getAccountAddress();
    await recordMintTransaction(voucherId, id, smartAccountAddress);
    console.log('Mint transaction recorded in database.');

    const uid = await getUidUsingVoucherId(voucherId);

    res.status(200).json({
      message: "Tokens minted successfully",
      txReceipt,
      uid
    });
  } catch (error) {
    console.error('Error minting tokens:', error);
    res.status(500).json({
      error: 'Internal server error',
      details: error.message
    });
  }
};

export const revokeTokens = async (req, res) => {
  const { voucherId, id, amount } = req.body;
  const { encrypted_wallet } = req.auth;

  console.log('Received request body:', req.body);

  if (!encrypted_wallet || !encrypted_wallet.encryptedData || !encrypted_wallet.iv) {
    console.error('Invalid encrypted wallet data:', encrypted_wallet);
    return res.status(400).json({ error: 'Invalid encrypted wallet data' });
  }

  try {
    const signerInstance = getSigner(encrypted_wallet);
    if (!signerInstance || !ethers.isAddress(signerInstance.address)) {
      console.error('Invalid or undefined signer address:', signerInstance);
      return res.status(400).json({ error: 'Invalid or undefined signer address' });
    }

    const biconomySmartAccount = await createSmartAccountClient({
      signer: signerInstance,
      biconomyPaymasterApiKey: process.env.PAYMASTER_KEY,
      bundlerUrl: process.env.BUNDLER_URL
    });

    const contractAddress = await getContractAddressByVoucherId(voucherId);

    const burnFunctionData = new ethers.Interface([
      "function burn(uint256 id, uint256 amount)"
    ]).encodeFunctionData("burn", [id, amount]);

    const tx = {
      to: contractAddress,
      data: burnFunctionData
    };

    const txResponse = await biconomySmartAccount.sendTransaction(tx, {
      paymasterServiceData: { mode: PaymasterMode.SPONSORED }
    });
    const txReceipt = await txResponse.wait();

    if (!txReceipt.success) {
      throw new Error('Revoke transaction failed');
    }

    console.log('Revoke transaction successful:', txReceipt);

    const smartAccountAddress = await biconomySmartAccount.getAccountAddress();
    await recordRevokeTransaction(voucherId, id, smartAccountAddress);
    console.log('Revoke transaction recorded in database.');

    const uid = await getUidUsingVoucherId(voucherId);

    res.status(200).json({
      message: "Tokens revoked successfully",
      txReceipt,
      uid
    });
  } catch (error) {
    console.error('Error revoking tokens:', error);
    res.status(500).json({
      error: 'Internal server error',
      details: error.message
    });
  }
};