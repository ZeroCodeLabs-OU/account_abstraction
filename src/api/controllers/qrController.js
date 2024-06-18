const { getSigner } = require("../services/biconomyService");
const { createSmartAccountClient, createPaymaster ,PaymasterMode} = require("@biconomy/account");
const ethers = require('ethers');
const crypto = require('crypto');
const db = require('../config/dbConfig');
const { fetchSmartAccountIDBySmartAccountAddress, fetchAccountIdByWalletAddress, fetchBaseURI ,getContractAddressByVoucherId} = require('../utils/db_helper');
const { Wallet } = require("ethers");

exports.generateQRData = async (req, res) => {
    const { encrypted_wallet, voucherId, tokenId, amount } = req.body;

    // Validate the encrypted wallet data
    if (!encrypted_wallet || !encrypted_wallet.encryptedData || !encrypted_wallet.iv) {
        console.error('Invalid encrypted wallet data:', encrypted_wallet);
        return res.status(400).json({ error: 'Invalid encrypted wallet data' });
    }

    // Decrypt the wallet address
    const signerInstance = getSigner(encrypted_wallet);
    if (!signerInstance || !ethers.isAddress(signerInstance.address)) {
        console.error('Invalid or undefined signer address:', signerInstance);
        return res.status(400).json({ error: 'Invalid or undefined signer address' });
    }

    const walletAddress = signerInstance.address;
    try {
        const contractAddress = await getContractAddressByVoucherId(voucherId);
        if (!contractAddress) {
            throw new Error('Voucher ID not found');
        }

        // Generate QR data and expiration time
        const qrData = JSON.stringify({ walletAddress, contractAddress, tokenId, amount, voucherId });
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


exports.decryptAndRevoke = async (req, res) => {
    const { encrypted_wallet, encryptedData, qrDataId } = req.body;

    if (!encryptedData || !qrDataId) {
        return res.status(400).json({ error: 'Missing required parameters' });
    }

    try {
        // Decrypt the QR data
        const decipher = crypto.createDecipher('aes-256-cbc', process.env.QR_SECRET);
        let decryptedData = decipher.update(encryptedData, 'hex', 'utf8');
        decryptedData += decipher.final('utf8');
        
        console.log("dec", decryptedData);

        // Parse the decrypted data
        const parsedData = JSON.parse(decryptedData);
        const { walletAddress, contractAddress, tokenId, amount, voucherId } = parsedData;

        // Check if QR data is expired
        const result = await db.query(`SELECT expiration FROM account_abstraction.qr_data WHERE id = $1`, [qrDataId]);
        if (result.rows.length === 0 || new Date(result.rows[0].expiration) < new Date()) {
            return res.status(400).json({ error: 'QR data has expired' });
        }

        // Get signer instance
        const signerInstance = getSigner(encrypted_wallet);
        if (!signerInstance || !ethers.isAddress(signerInstance.address)) {
            console.error('Invalid or undefined signer address:', signerInstance);
            return res.status(400).json({ error: 'Invalid or undefined signer address' });
        }

        // Create Biconomy Smart Account
        const biconomySmartAccount = await createSmartAccountClient({
            signer: signerInstance,
            biconomyPaymasterApiKey: process.env.PAYMASTER_KEY,
            bundlerUrl: process.env.BUNDLER_URL
        });

        // Get contract address using voucher ID
        const contractAddr = await getContractAddressByVoucherId(voucherId);

        // Get balance of the user using a low-level call
        const balanceOfData = new ethers.Interface([
            "function balanceOf(address account, uint256 id) public view returns (uint256)"
        ]).encodeFunctionData("balanceOf", [walletAddress, tokenId]);

        const balance = await ethers.getDefaultProvider().call({
            to: contractAddr,
            data: balanceOfData
        });

        // const balance = ethers.BigNumber.from(balanceHex).toNumber();

        if (balance < amount) {
            return res.status(400).json({ error: 'Insufficient balance' });
        }

        // Revoke the NFT
        const revokeFunctionData = new ethers.Interface([
            "function revoke(address from, uint256 id, uint256 amount)"
        ]).encodeFunctionData("revoke", [walletAddress, tokenId, amount]);

        const tx = {
            to: contractAddr,
            data: revokeFunctionData
        };

        const txResponse = await biconomySmartAccount.sendTransaction(tx, {
            paymasterServiceData: { mode: PaymasterMode.SPONSORED }
        });
        const txReceipt = await txResponse.wait();

        if (!txReceipt.success) {
            throw new Error('Revoke transaction failed');
        }

        console.log('Revoke transaction successful:', txReceipt);

        // Update the mint database to mark as revoked
        await db.query(`UPDATE account_abstraction.nft_tx_mint SET revoked = true WHERE voucher_id = $1 AND token_id = $2`, [voucherId, tokenId]);

        res.status(200).json({ message: 'NFT revoked successfully', txReceipt });
    } catch (error) {
        console.error('Error decrypting and revoking NFT:', error);
        res.status(500).json({ error: 'Internal server error', details: error.message });
    }
};
