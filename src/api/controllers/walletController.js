import { createSmartAccountClient, createPaymaster } from '@biconomy/account';
import {ethers} from 'ethers';
import db from '../config/dbConfig.js';
import { getSigner } from '../services/biconomyService.js';

export const createSmartAccount = async (req, res) => {
  try {
    const { encrypted_wallet } = req.body;
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
      'INSERT INTO account_abstraction.smart_account (wallet_address, smart_account_address, created_at) VALUES ($1, $2, $3) RETURNING *',
      [signerInstance.address, smartAccountAddress, new Date()],
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
    const { wallet_address } = req.body;

    const result = await db.query('SELECT * FROM account_abstraction.smart_account WHERE wallet_address = $1', [wallet_address]);
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
