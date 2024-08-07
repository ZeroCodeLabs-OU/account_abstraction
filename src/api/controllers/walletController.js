import { createSmartAccountClient, createPaymaster ,PaymasterMode} from '@biconomy/account';
import {ethers} from 'ethers';
import db from '../config/dbConfig.js';
import { getSigner ,getSigner_} from '../services/biconomyService.js';
import contractJson from '../utils/contracts/erc1155.json' assert { type: 'json' };
const { abi, bytecode } = contractJson;
import { processFiles } from '../services/firestorage.js';
import { encodeInitializationData } from '../utils/contractImplementation.js';

import {
  fetchBaseURI,
  fetchAccountIdByWalletAddress,
  fetchSmartAccountIDBySmartAccountAddress,
  createSmartAccountContract,
  recordMintTransaction,
  recordRevokeTransaction,
  getContractAddressByVoucherId
} from '../utils/db_helper.js';




export const createSmartAccount = async (req, res) => {
  try {
    const { uid, encrypted_wallet } = req.auth;

    if (!encrypted_wallet || !encrypted_wallet.encryptedData || !encrypted_wallet.iv) {
      return res.status(400).json({ error: 'Invalid encrypted wallet data' });
    }

    // Setup Paymaster and other dependent services
    const paymaster = await createPaymaster({
      paymasterUrl: process.env.PAYMASTER_URL,
      strictMode: true,
    });

    const signerInstance = getSigner(encrypted_wallet);
    const biconomySmartAccount = await createSmartAccountClient({
      signer: signerInstance,
      paymaster,
      bundlerUrl: process.env.BUNDLER_URL,
    });

    const smartAccountAddress = await biconomySmartAccount.getAccountAddress();

    // Store in database and return the inserted data
    const result = await db.query(
      'INSERT INTO account_abstraction.smart_account (uid, wallet_address, smart_account_address, created_at) VALUES ($1, $2, $3, $4) RETURNING *',
      [uid, signerInstance.address, smartAccountAddress, new Date()],
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error creating smart account:', error);

    // Handling unique constraint violation specifically
    if (error.code === '23505' && error.detail.includes('wallet_address')) {
      const walletAddressMatch = error.detail.match(/\=\(([^)]+)\)/);
      const walletAddress = walletAddressMatch ? walletAddressMatch[1] : 'Unavailable';

      return res.status(409).json({
        error: 'A smart account with this wallet address already exists.',
        wallet_address: walletAddress,
      });
    }

    res.status(500).json({ error: 'Internal server error' });
  }
};

export const getSmartAccount = async (req, res) => {
  try {
    const { encrypted_wallet } = req.auth;
    const signerInstance = getSigner(encrypted_wallet);
    

    const result = await db.query('SELECT * FROM account_abstraction.smart_account WHERE wallet_address = $1', [signerInstance.address]);
    if (result.rows.length) {
      res.status(200).json(result.rows[0]);
    } else {
      res.status(404).send('Smart account not found.');
    }
  } catch (error) {
    console.error('Error retrieving smart account:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const createAndDeploySmartAccount = async (req, res) => {
  const client = await db.connect();
  try {
    const { uid, encrypted_wallet } = req.auth;

    const parseJsonField = (field) => (typeof field === 'string' ? JSON.parse(field) : field);

    const { 
      encryptedData, iv, 
      description, 
      name, 
      status, 
      latitude, 
      longitude, 
      tokenQuantity, max_supply,
      max_token_per_mint, 
      max_token_per_person 
    } = req.body;

    const images = req.files['images'] || [];
    const metadataFiles = req.files['metadata'] || [];

    if (!encryptedData || !iv) {
      res.status(400).json({ error: 'Invalid encrypted wallet data' });
      return;
    }

    const signerInstance = getSigner(encrypted_wallet);
    const walletAddress = signerInstance.address;
    const existingAccount = await client.query('SELECT * FROM account_abstraction.smart_account WHERE wallet_address = $1', [walletAddress]);

    let smartAccountId;
    if (existingAccount.rows.length) {
      smartAccountId = existingAccount.rows[0].id;
    } else {
      const paymaster = await createPaymaster({ paymasterUrl: process.env.PAYMASTER_URL, strictMode: true });
      const biconomySmartAccount = await createSmartAccountClient({ signer: signerInstance, paymaster, bundlerUrl: process.env.BUNDLER_URL });
      const smartAccountAddress = await biconomySmartAccount.getAccountAddress();
      const result = await client.query(
        'INSERT INTO account_abstraction.smart_account (uid, wallet_address, smart_account_address, created_at) VALUES ($1, $2, $3, $4) RETURNING id',
        [uid, walletAddress, smartAccountAddress, new Date()]
      );
      smartAccountId = result.rows[0].id;
    }

    const voucherResult = await client.query(
      'INSERT INTO account_abstraction.voucher (smart_account_id, name, description, status, location, latitude, longitude, created_at) VALUES ($1, $2, $3, $4, ST_SetSRID(ST_MakePoint($6, $5), 4326), $5, $6, now()) RETURNING id',
      [smartAccountId, name, description, status, latitude, longitude]
    );
    const voucherId = voucherResult.rows[0].id;

    await processFiles(images, metadataFiles, voucherId);

    const paymaster = await createPaymaster({ paymasterUrl: process.env.PAYMASTER_URL });
    const biconomySmartAccount = await createSmartAccountClient({
      signer: signerInstance,
      paymaster,
      bundlerUrl: process.env.BUNDLER_URL,
    });

    const randomSalt = ethers.utils.hexlify(ethers.utils.randomBytes(32));
    const deployData = new ethers.utils.Interface([
      "function deploy(bytes32 _salt, bytes _creationCode) external returns (address)",
      "function addressOf(bytes32 _salt) external view returns (address)"
    ]).encodeFunctionData("deploy", [randomSalt, bytecode]);

    const txDeploy = {
      to: process.env.CONTRACT_DEPLOYER_ADDRESS,
      data: deployData,
    };

    const deployResponse = await biconomySmartAccount.sendTransaction(txDeploy, {
      paymasterServiceData: { mode: 'SPONSORED' }
    });
    const receiptDeploy = await deployResponse.wait();

    if (!receiptDeploy.success) {
      res.status(500).json({ error: 'Deployment transaction failed' });
      return;
    }

    const addressData = new ethers.utils.Interface([
      'function addressOf(bytes32 _salt) external view returns (address)',
    ]).encodeFunctionData('addressOf', [randomSalt]);

    const computedAddress = await ethers.getDefaultProvider().call({
      to: txDeploy.to,
      data: addressData
    });

    const deployedAddress = '0x' + computedAddress.slice(26);

    const base_URI = await fetchBaseURI(voucherId);
    
    const publicMintStart = Math.floor(Date.now() / 1000);
    const presaleMintStart = Math.floor(Date.now() / 1000) + 86400;

    const initData = encodeInitializationData(
      name,
      max_supply,
      parseJsonField(tokenQuantity),
      parseJsonField(max_token_per_mint),
      parseJsonField(max_token_per_person),
      base_URI,
      publicMintStart,
      presaleMintStart,
      signerInstance.address
    );

    const initTx = {
      to: deployedAddress,
      data: initData
    };

    const initResponse = await biconomySmartAccount.sendTransaction(initTx, {
      paymasterServiceData: { mode: 'SPONSORED' }
    });
    const initReceipt = await initResponse.wait();

    if (!initReceipt.success) {
      res.status(500).json({ error: 'Initialization transaction failed' });
      return;
    }

    const contractResponse = await createSmartAccountContract({
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
      maxPerPerson: parseJsonField(max_token_per_person),
      maxPerTransaction: parseJsonField(max_token_per_mint),
      presaleMintStartDate: new Date(presaleMintStart * 1000),
      publicMintStartDate: new Date(publicMintStart * 1000),
      prerevealBaseUri: "",
      sbtActivated: false,
      isGasless: false,
      isArchived: false,
      externalContract: false
    });

    res.status(200).json({
      message: "Smart account and contract deployed successfully",
      contractResponse
    });
  } catch (error) {
    console.error('Error in execution:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  } finally {
    client.release();
  }
};

// add uid return to all endpoints
//update contract changes
//update voucher and ipfs endpoint 
