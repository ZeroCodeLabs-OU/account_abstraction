
const db = require('../config/dbConfig');

exports.createVoucher = async (req, res) => {
    const { smart_account_id, description, name, status, latitude, longitude } = req.body;
    try {
        const result = await db.query(
            'INSERT INTO account_abstraction.voucher (smart_account_id, name, description, status, location, created_at) VALUES ($1, $2, $3, $4, ST_SetSRID(ST_MakePoint($5, $6), 4326), now()) RETURNING *',
            [smart_account_id, name, description, status, latitude, longitude]
        );
        res.status(201).json(result.rows[0]);
    } catch (error) {
        console.error('Error creating voucher:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};

exports.getVoucherById = async (req, res) => {
    const { voucher_id } = req.params;
    try {
        console.log(voucher_id)
        const result = await db.query(
            'SELECT * FROM account_abstraction.voucher WHERE id = $1',
            [voucher_id]
        );
        if (result.rows.length) {
            res.status(200).json(result.rows[0]);
        } else {
            res.status(404).send('Voucher not found.');
        }
    } catch (error) {
        console.error('Error retrieving voucher:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};


exports.updateVoucher = async (req, res) => {
    const { voucher_id } = req.params;
    const { description, name, status, latitude, longitude } = req.body;
    try {
        const result = await db.query(
            'UPDATE account_abstraction.voucher SET name = $1, description = $2, status = $3, location = ST_SetSRID(ST_MakePoint($4, $5), 4326) WHERE id = $6 RETURNING *',
            [name, description, status, latitude, longitude, voucher_id]
        );
        if (result.rows.length) {
            res.status(200).json(result.rows[0]);
        } else {
            res.status(404).send('Voucher not found.');
        }
    } catch (error) {
        console.error('Error updating voucher:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};


exports.deleteVoucher = async (req, res) => {
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

exports.getVouchersBySmartAccountId = async (req, res) => {
    const { smart_account_id } = req.params; 
    try {
        const result = await db.query(
            'SELECT * FROM account_abstraction.voucher WHERE smart_account_id = $1',
            [smart_account_id]
        );
        if (result.rows.length > 0) {
            res.status(200).json(result.rows);
        } else {
            res.status(404).send('No vouchers found for this smart account.');
        }
    } catch (error) {
        console.error('Error retrieving vouchers:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};
