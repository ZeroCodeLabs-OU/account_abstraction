import { getSigner,getSigner_network } from "../services/biconomyService.js";
import { createSmartAccountClient, createPaymaster, PaymasterMode } from "@biconomy/account";
import { ethers } from 'ethers';
import crypto from 'crypto';
import db from '../config/dbConfig.js';
import { fetchSmartAccountIDBySmartAccountAddress,fetchNetworkFromVoucherId, getUidUsingVoucherId,fetchSmartAccountByWalletAddress,fetchAccountIdByWalletAddress, fetchBaseURI, getContractAddressByVoucherId } from '../utils/db_helper.js';
import dotenv from 'dotenv';
dotenv.config();
export const generateQRData = async (req, res) => {
    const { voucherId, tokenId=0, amount=1 } = req.body;
    const { wallet_data,uid } = req.auth;

    // Validate the encrypted wallet data
    if (!wallet_data || !wallet_data.encryptedData || !wallet_data.iv) {
        return res.status(400).json({ error: 'Invalid encrypted wallet data' });
    }

    
    const network = await fetchNetworkFromVoucherId(voucherId);

    const { signer ,config } = getSigner_network(wallet_data,network);
    const wallet_Address = signer.address;
    const existingAccount = await db.query('SELECT * FROM account_abstraction.smart_account WHERE wallet_address = $1', [wallet_Address]);

    let smartAccountId;
    if (existingAccount.rows.length) {
      smartAccountId = existingAccount.rows[0].id;
    } else {
        const paymaster = await createPaymaster({
            paymasterUrl: config.PAYMASTER_URL,
            strictMode: true,
          });
      
          const biconomySmartAccount = await createSmartAccountClient({
            signer,
            paymaster,
            bundlerUrl: config.BUNDLER_URL,
          });
      const smartAccountAddress = await biconomySmartAccount.getAccountAddress();
      const result = await db.query(
        'INSERT INTO account_abstraction.smart_account (uid, wallet_address, smart_account_address, created_at) VALUES ($1, $2, $3, $4) RETURNING id',
        [uid, wallet_Address, smartAccountAddress, new Date()]
      );
      smartAccountId = result.rows[0].id;
    }
    

    // Decrypt the wallet address
    if (!signer || !ethers.isAddress(signer.address)) {
        console.error('Invalid or undefined signer address:', signer);
        return res.status(400).json({ error: 'Invalid or undefined signer address' });
    }
    const paymaster = await createPaymaster({
        paymasterUrl: config.PAYMASTER_URL,
        strictMode: true,
      });
  
    const biconomySmartAccount = await createSmartAccountClient({
        signer,
        paymaster,
        bundlerUrl: config.BUNDLER_URL,
      });

    const walletAddress= await biconomySmartAccount.getAccountAddress();
    try {
        const contractAddress = await getContractAddressByVoucherId(voucherId);
        if (!contractAddress.contract_address) {
            throw new Error('Voucher ID not found');
        }
        const contractABI = [
            "function balanceOf(address account, uint256 id) public view returns (uint256)"
        ];
        const provider = ethers.getDefaultProvider(config.INFURA_PROJECT_URL);
        const contract = new ethers.Contract(contractAddress.contract_address, contractABI,provider );
        
        // Call the balanceOf function directly
        const balance = await contract.balanceOf(walletAddress, tokenId);
        console.log("wallet",walletAddress)
        console.log(contractAddress.contract_address ,"contract")
        const balanceNumber = parseInt(balance.toString(), 10);
        const amountNumber = parseInt(amount, 10);
        console.log("Balance Number:", balanceNumber);
        console.log("Amount Number:", amountNumber);;

        if (balanceNumber < amountNumber) {  // Check if balance is less than the amount
            console.log('Insufficient balance:', balanceNumber, 'needed:', amountNumber);
            return res.status(400).json({ error: 'Insufficient balance' });
        }
        // Generate QR data and expiration time
        const qrData = JSON.stringify({ walletAddress, contractAddress, tokenId, amount, voucherId,network });
        const cipher = crypto.createCipher('aes-256-cbc', process.env.QR_SECRET);
        let encryptedData = cipher.update(qrData, 'utf8', 'hex');
        encryptedData += cipher.final('hex');
        const expiration = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes from now

        // Save encrypted data and expiration to the database
        const result = await db.query(
            `INSERT INTO account_abstraction.qr_data (voucher_id, encrypted_data, expiration, created_at)
             VALUES ($1, $2, $3, now()) RETURNING id`,
            [voucherId, encryptedData, expiration]
        );

        const qrDataId = result.rows[0].id;

        res.status(200).json({ encryptedData, qrDataId, expiration });
    } catch (error) {
        console.error('Error generating QR data:', error);
        res.status(500).json({ error: 'Internal server error', details: error.message });
    }
};


export const decryptAndRevoke = async (req, res) => {
    const { encryptedData, qrDataId } = req.body;
    const { wallet_data, uid } = req.auth;

    if (!encryptedData || !qrDataId) {
        return res.status(400).json({ error: 'Missing required parameters' });
    }

    try {
        // Decrypt the QR data
        const decipher = crypto.createDecipher('aes-256-cbc', process.env.QR_SECRET);
        let decryptedData = decipher.update(encryptedData, 'hex', 'utf8');
        decryptedData += decipher.final('utf8');

        console.log("Decrypted Data:", decryptedData);

        // Parse the decrypted data
        const parsedData = JSON.parse(decryptedData);
        const { walletAddress, contractAddress, tokenId, amount, voucherId, network } = parsedData;
        const uid_voucher_id = await getUidUsingVoucherId(voucherId);
        if (uid_voucher_id !== uid) {
            return res.status(400).json({ error: 'Invalid Voucher_Id: not the owner of the voucher' });
        }
        
        // Check if QR data is expired
        const result = await db.query(`SELECT expiration FROM account_abstraction.qr_data WHERE id = $1`, [qrDataId]);
        if (result.rows.length === 0) {
            return res.status(400).json({ error: 'QR data not found' });
        }

        const expirationDate = new Date(result.rows[0].expiration);
        if (expirationDate < new Date()) {
            return res.status(400).json({ error: 'QR data has expired' });
        }

        // Get signer instance
        const { signer, config } = getSigner_network(wallet_data, network);
        if (!signer || !ethers.isAddress(signer.address)) {
            console.error('Invalid or undefined signer address:', signer);
            return res.status(400).json({ error: 'Invalid or undefined signer address' });
        }

        // Create Biconomy Smart Account
        const paymaster = await createPaymaster({
            paymasterUrl: config.PAYMASTER_URL,
            strictMode: true,
        });

        const biconomySmartAccount = await createSmartAccountClient({
            signer,
            paymaster,
            bundlerUrl: config.BUNDLER_URL,
        });

        // Get contract address using voucher ID
        const contractAddr = await getContractAddressByVoucherId(voucherId);

        // Debugging logs
        console.log("Contract Address:", contractAddr.contract_address);
        console.log("Token ID:", tokenId);
        console.log("Wallet Address:", walletAddress);

        // Create a contract instance
        const contractABI = [
            "function balanceOf(address account, uint256 id) public view returns (uint256)"
        ];
        const provider = ethers.getDefaultProvider(config.INFURA_PROJECT_URL);
        const contract = new ethers.Contract(contractAddr.contract_address, contractABI, provider);

        // Call the balanceOf function directly
        const balance = await contract.balanceOf(walletAddress, tokenId);
        const balanceNumber = parseInt(balance.toString(), 10);
        const amountNumber = parseInt(amount, 10);
        console.log("Balance Number:", balanceNumber);
        console.log("Amount Number:", amountNumber);

        if (balanceNumber < amountNumber) {  // Check if balance is less than the amount
            console.log('Insufficient balance:', balanceNumber, 'needed:', amountNumber);
            return res.status(400).json({ error: 'Insufficient balance' });
        }

        // Revoke the NFT
        const revokeFunctionData = new ethers.Interface([
            "function revoke(address from, uint256 id, uint256 amount)"
        ]).encodeFunctionData("revoke", [walletAddress, tokenId, amount]);

        const tx = {
            to: contractAddr.contract_address,
            data: revokeFunctionData
        };

        // Retry transaction logic
        const retryTransaction = async (retryCount = 0) => {
            try {
                const txResponse = await biconomySmartAccount.sendTransaction(tx, {
                    paymasterServiceData: { mode: PaymasterMode.SPONSORED }
                });
                const txReceipt = await txResponse.wait();

                console.log("Transaction Receipt:", txReceipt);

                if (txReceipt.success === "false") {
                    throw new Error('Revoke transaction failed');
                }

                console.log('Revoke transaction successful:', txReceipt);

                // Update the mint database to mark as revoked
                await db.query(`UPDATE account_abstraction.nft_tx_mint SET revoked = true WHERE voucher_id = $1 AND token_id = $2 AND smart_account_address = $3`, [voucherId, tokenId, walletAddress]);

                res.status(200).json({ message: 'NFT revoked successfully', txReceipt });
            } catch (error) {
                if (retryCount < 3) {
                    const delay = 2000 + (retryCount * 1000); // Wait time: 2s, 3s, 4s
                    console.error(`Error revoking NFT (attempt ${retryCount + 1}), retrying in ${delay / 1000}s...`, error);

                    // Wait before retrying
                    await new Promise(resolve => setTimeout(resolve, delay));
                    await retryTransaction(retryCount + 1); // Retry again
                } else {
                    console.error('Max retries reached. Error revoking NFT:', error);
                    return res.status(500).json({ error: 'Internal server error during revocation', details: error.message });
                }
            }
        };

        // Start the first transaction attempt
        await retryTransaction();
    } catch (error) {
        console.error('Error decrypting and revoking NFT:', error);
        res.status(500).json({ error: 'Internal server error', details: error.message });
    }
};
