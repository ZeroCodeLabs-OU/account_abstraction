import db from '../config/dbConfig.js';
import { fetchBaseURI, fetchAccountIdByWalletAddress,updateBaseURI,getContractAddressByVoucherId,update_Voucher, insertOrUpdateNFTMetadata,fetchSmartAccountIDBySmartAccountAddress, createSmartAccountContract, fetchSmartAccountByWalletAddress ,fetchUIDByWalletAddress,getUidUsingVoucherId} from '../utils/db_helper.js';
import { getSigner } from "../services/biconomyService.js";
import { ethers } from 'ethers';
import {update_processFiles} from "../services/firestorage.js"
import { createSmartAccountClient, createPaymaster, PaymasterMode } from '@biconomy/account';
import dotenv from 'dotenv';
dotenv.config();
export const createVoucher = async (req, res) => {
    const {  wallet_data } = req.auth;
    const { description, name, status, latitude, longitude } = req.body;

    try {
        if (!wallet_data || !wallet_data.encryptedData || !wallet_data.iv) {
            return res.status(400).json({ error: 'Invalid encrypted wallet data' });
        }

        const signerInstance = getSigner(wallet_data);
        if (!signerInstance || !ethers.isAddress(signerInstance.address)) {
            console.error('Invalid or undefined signer address:', signerInstance);
            return res.status(400).json({ error: 'Invalid or undefined signer address' });
        }

        const wallet_address = signerInstance.address;
        const SmartAccountId = await fetchAccountIdByWalletAddress(wallet_address);
        if (!SmartAccountId) {
            return res.status(404).json({ error: 'Smart account not found' });
        }
        const uid = await fetchUIDByWalletAddress(wallet_address)
        const result = await db.query(
            'INSERT INTO account_abstraction.voucher (smart_account_id, name, description, status, location, latitude, longitude, created_at) VALUES ($1, $2, $3, $4, account_abstraction.ST_SetSRID(account_abstraction.ST_MakePoint($6, $5), 4326), $5, $6, now()) RETURNING *',
            [SmartAccountId, name, description, status, latitude, longitude]
        );
        res.status(201).json({ ...result.rows[0], uid });
    } catch (error) {
        console.error('Error creating voucher:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};

export const getVoucherById = async (req, res) => {
    const { voucher_id } = req.params;

    try {
        const result = await db.query(
            `SELECT v.*, 
                    json_agg(nm.*) AS nft_metadata 
             FROM account_abstraction.voucher v 
             LEFT JOIN account_abstraction.nft_metadata nm ON v.id = nm.voucher_id 
             WHERE v.id = $1 
             GROUP BY v.id`,
            [voucher_id]
        );

        if (result.rows.length) {
            const uid = await getUidUsingVoucherId(voucher_id);
            res.status(200).json({ ...result.rows[0], uid });
        } else {
            res.status(404).send('Voucher not found.');
        }
    } catch (error) {
        console.error('Error retrieving voucher:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};

export const updateVoucher = async (req, res) => {
    const { voucher_id } = req.params;
    const { description, name, status, latitude, longitude } = req.body;

    try {
        const result = await db.query(
            'UPDATE account_abstraction.voucher SET name = $1, description = $2, status = $3, location = account_abstraction.ST_SetSRID(account_abstraction.ST_MakePoint($4, $5), 4326), latitude = $4, longitude = $5 WHERE id = $6 RETURNING *',
            [name, description, status, latitude, longitude, voucher_id]
        );

        if (result.rows.length) {
            const uid = await getUidUsingVoucherId(voucher_id);
            res.status(200).json({ ...result.rows[0], uid });
        } else {
            res.status(404).send('Voucher not found.');
        }
    } catch (error) {
        console.error('Error updating voucher:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};


export const deleteVoucher = async (req, res) => {
    const { voucher_id } = req.params;

    try {
        const result = await db.query(
            'DELETE FROM account_abstraction.voucher WHERE id = $1',
            [voucher_id]
        );

        if (result.rowCount > 0) {
            res.status(204).send();
        } else {
            res.status(404).send('Voucher not found.');
        }
    } catch (error) {
        console.error('Error deleting voucher:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};


export const getVouchersBySmartAccountId = async (req, res) => {
    const { wallet_data } = req.auth;

    try {
        if (!wallet_data || !wallet_data.encryptedData || !wallet_data.iv) {
            return res.status(400).json({ error: 'Invalid encrypted wallet data' });
        }

        const signerInstance = getSigner(wallet_data);
        if (!signerInstance || !ethers.isAddress(signerInstance.address)) {
            console.error('Invalid or undefined signer address:', signerInstance);
            return res.status(400).json({ error: 'Invalid or undefined signer address' });
        }

        const wallet_address = signerInstance.address;
        const SmartAccountId = await fetchAccountIdByWalletAddress(wallet_address);
        if (!SmartAccountId) {
            return res.status(404).json({ error: 'Smart account not found' });
        }

        const result = await db.query(
            `SELECT v.*, 
                    json_agg(nm.*) AS nft_metadata 
             FROM account_abstraction.voucher v 
             LEFT JOIN account_abstraction.nft_metadata nm ON v.id = nm.voucher_id 
             WHERE v.smart_account_id = $1 
             GROUP BY v.id`,
            [SmartAccountId]
        );

        if (result.rows.length > 0) {
            const vouchersWithUid = await Promise.all(result.rows.map(async (voucher) => {
                const uid = await getUidUsingVoucherId(voucher.id);
                return { ...voucher, uid };
            }));
            res.status(200).json(vouchersWithUid);
        } else {
            res.status(404).send('No vouchers found for this smart account.');
        }
    } catch (error) {
        console.error('Error retrieving vouchers:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};


export const getVouchersBySmartAccountId_Status = async (req, res) => {
    const { wallet_data } = req.auth;
    const { status } = req.body;

    try {
        if (!wallet_data || !wallet_data.encryptedData || !wallet_data.iv) {
            return res.status(400).json({ error: 'Invalid encrypted wallet data' });
        }

        const signerInstance = getSigner(wallet_data);
        if (!signerInstance || !ethers.isAddress(signerInstance.address)) {
            console.error('Invalid or undefined signer address:', signerInstance);
            return res.status(400).json({ error: 'Invalid or undefined signer address' });
        }

        const wallet_address = signerInstance.address;
        const SmartAccountId = await fetchAccountIdByWalletAddress(wallet_address);
        if (!SmartAccountId) {
            return res.status(404).json({ error: 'Smart account not found' });
        }

        const result = await db.query(
            `SELECT v.*, 
                    json_agg(nm.*) AS nft_metadata 
             FROM account_abstraction.voucher v 
             LEFT JOIN account_abstraction.nft_metadata nm ON v.id = nm.voucher_id 
             WHERE v.smart_account_id = $1 AND v.status = $2 
             GROUP BY v.id`,
            [SmartAccountId, status]
        );

        if (result.rows.length > 0) {
            const vouchersWithUid = await Promise.all(result.rows.map(async (voucher) => {
                const uid = await getUidUsingVoucherId(voucher.id);
                return { ...voucher, uid };
            }));
            res.status(200).json(vouchersWithUid);
        } else {
            res.status(404).send('No vouchers found for this smart account.');
        }
    } catch (error) {
        console.error('Error retrieving vouchers:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};

export const getVouchersByLocationAndRadius = async (req, res) => {
    const { latitude, longitude, status, radius } = req.body;

    if (!latitude || !longitude || !status || !radius) {
        return res.status(400).json({ error: 'Latitude, longitude, status, and radius are required' });
    }

    try {
        const result = await db.query(
            `SELECT v.*, 
                    json_agg(nm.*) AS nft_metadata,
                    account_abstraction.ST_Distance(v.location, account_abstraction.ST_SetSRID(account_abstraction.ST_MakePoint($2, $1), 4326)) AS distance
             FROM account_abstraction.voucher v 
             LEFT JOIN account_abstraction.nft_metadata nm ON v.id = nm.voucher_id 
             WHERE v.status = $3 
             AND account_abstraction.ST_DWithin(
                 v.location,
                 account_abstraction.ST_SetSRID(account_abstraction.ST_MakePoint($2, $1), 4326),
                 $4
             )
             GROUP BY v.id
             ORDER BY distance ASC`,
            [latitude, longitude, status, radius]
        );

        if (result.rows.length > 0) {
            const vouchersWithUid = await Promise.all(result.rows.map(async (voucher) => {
                const uid = await getUidUsingVoucherId(voucher.id);
                return { ...voucher, uid };
            }));
            res.status(200).json(vouchersWithUid);
        } else {
            res.status(404).send('No vouchers found within the specified radius.');
        }
    } catch (error) {
        console.error('Error retrieving vouchers:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};

export const updateVoucherStatus = async (req, res) => {
    const { status, voucher_id } = req.body;

    const validStatuses = ['pending', 'available', 'unavailable', 'banned'];
    if (!validStatuses.includes(status)) {
        return res.status(400).json({ error: 'Invalid status value' });
    }

    try {
        const result = await db.query(
            'UPDATE account_abstraction.voucher SET status = $1 WHERE id = $2 RETURNING *',
            [status, voucher_id]
        );

        if (result.rows.length) {
            const uid = await getUidUsingVoucherId(voucher_id);
            res.status(200).json({ ...result.rows[0], uid });
        } else {
            res.status(404).send('Voucher not found.');
        }
    } catch (error) {
        console.error('Error updating voucher status:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};

export const getCollectedVouchers = async (req, res) => {
    const { wallet_data } = req.auth;

    if (!wallet_data || !wallet_data.encryptedData || !wallet_data.iv) {
        return res.status(400).json({ error: 'Invalid encrypted wallet data' });
    }

    const signerInstance = getSigner(wallet_data);
    if (!signerInstance || !ethers.isAddress(signerInstance.address)) {
        console.error('Invalid or undefined signer address:', signerInstance);
        return res.status(400).json({ error: 'Invalid or undefined signer address' });
    }

    const wallet_address = signerInstance.address;

    try {
        const smartAccountAddress = await fetchSmartAccountByWalletAddress(wallet_address);
        if (!smartAccountAddress) {
            return res.status(404).json({ error: 'Smart account not found for the given wallet address' });
        }

        const result = await db.query(
            `SELECT m.*, v.*, json_agg(nm.*) AS nft_metadata
             FROM account_abstraction.nft_tx_mint m
             JOIN account_abstraction.voucher v ON m.voucher_id = v.id
             LEFT JOIN account_abstraction.nft_metadata nm ON v.id = nm.voucher_id
             WHERE m.smart_account_address = $1
             GROUP BY m.id, v.id`,
            [smartAccountAddress]
        );

        if (result.rows.length > 0) {
            const vouchersWithUid = await Promise.all(result.rows.map(async (voucher) => {
                const uid = await getUidUsingVoucherId(voucher.id);
                return { ...voucher, uid };
            }));
            res.status(200).json(vouchersWithUid);
        } else {
            res.status(404).send('No collected vouchers found for this wallet address.');
        }
    } catch (error) {
        console.error('Error retrieving collected vouchers:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};


export const updateVoucherAndMetadata = async (req, res) => {
    const { voucher_id, name, description, status, latitude, longitude } = req.body;
    const { wallet_data } = req.auth;
    const images = req.files['images'] || [];
    const metadataFiles = req.files['metadata'] || [];

    if (!wallet_data || !wallet_data.encryptedData || !wallet_data.iv) {
        return res.status(400).json({ error: 'Invalid encrypted wallet data' });
    }

    try {
        const signerInstance = getSigner(wallet_data);
        if (!signerInstance || !ethers.isAddress(signerInstance.address)) {
            console.error('Invalid or undefined signer address:', signerInstance);
            return res.status(400).json({ error: 'Invalid or undefined signer address' });
        }

        // Update voucher
        const updatedVoucher = await update_Voucher(voucher_id, { name, description, status, latitude, longitude });

        // Update metadata if provided
        if (images.length > 0 && metadataFiles.length > 0) {
            const { baseURI, firebaseImageUrls } = await update_processFiles(images, metadataFiles, voucher_id);
            await updateBaseURI(voucher_id, baseURI);

            // const contractAddress = await getContractAddressByVoucherId(voucher_id);
            // const updateMetadataFunctionData = new ethers.Interface([
            //     "function metadata_update(string memory _baseURI) public onlyRole(ADMIN_ROLE)"
            // ]).encodeFunctionData("metadata_update", [baseURI]);


            // const tx = {
            //     to: contractAddress,
            //     data: updateMetadataFunctionData
            // };

            // const biconomySmartAccount = await createSmartAccountClient({
            //     signer: signerInstance,
            //     biconomyPaymasterApiKey: process.env.PAYMASTER_KEY,
            //     bundlerUrl: process.env.BUNDLER_URL
            // });

            // const txResponse = await biconomySmartAccount.sendTransaction(tx, {
            //     paymasterServiceData: { mode: PaymasterMode.SPONSORED }
            // });
            // const txReceipt = await txResponse.wait();

            // if (!txReceipt.success) {
            //     throw new Error('Metadata update transaction failed');
            // }

            res.status(200).json({
                message: "Voucher and metadata updated successfully",
                updatedVoucher,
                baseURI,
                firebaseImageUrls
            });
        } else {
            res.status(200).json({
                message: "Voucher updated successfully",
                updatedVoucher
            });
        }
    } catch (error) {
        console.error('Error updating voucher and metadata:', error);
        res.status(500).json({ error: 'Internal server error', details: error.message });
    }
};