const db = require('../config/dbConfig');


async function fetchBaseURI(voucherId) {
    const query = 'SELECT files_cid FROM account_abstraction.nft_cid WHERE voucher_id = $1';
    try {
        const result = await db.query(query, [voucherId]);
        if (result.rows.length > 0) {
            return `https://ipfs.io/ipfs/${result.rows[0].metadata_cid}`;
        } else {
            throw new Error("No CID found for the given voucher ID");
        }
    } catch (err) {
        console.error("Database error:", err);
        throw err;
    }
}

async function fetchAccountIdByWalletAddress(walletAddress) {
    const query = 'SELECT id FROM account_abstraction.smart_account WHERE wallet_address = $1';
    try {
        const result = await db.query(query, [walletAddress]);
        if (result.rows.length > 0) {
            return result.rows[0].id;
        } else {
            throw new Error("No account found for the given wallet address");
        }
    } catch (err) {
        console.error("Database error while fetching account id:", err);
        throw err;
    }
}

async function fetchSmartAccountIDBySmartAccountAddress(walletAddress) {
    const query = 'SELECT id FROM account_abstraction.smart_account WHERE smart_account_address = $1';
    try {
        const result = await db.query(query, [walletAddress]);
        if (result.rows.length > 0) {
            return result.rows[0].smart_account_address;
        } else {
            throw new Error("No smart account found for the given smart account address");
        }
    } catch (err) {
        console.error("Database error while fetching smart account id:", err);
        throw err;
    }
}
async function createSmartAccountContract({
    smartAccountId,
    voucherId,
    name,
    description,
    contractAddress,
    chain,
    type,
    baseUri,
    tokenSymbol,
    royaltyShare,
    maxSupply,
    teamReserved,
    maxPerPerson,
    maxPerTransaction,
    presaleMintStartDate,
    publicMintStartDate,
    prerevealBaseUri,
    sbtActivated,
    isGasless,
    isArchived,
    externalContract
}) {
    const query = `
        INSERT INTO account_abstraction.smart_account_smart_contract
        (
            smart_account_id, voucher_id, name, description, contract_address, chain, type, base_uri,
            token_symbol, royalty_share, max_supply, team_reserved, max_per_person, max_per_transaction,
            presale_mint_start_date, public_mint_start_date, prereveal_base_uri, sbt_activated,
            is_gasless, is_archived, external_contract
        )
        VALUES
        (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21
        )
        RETURNING id;
    `;

    const values = [
        smartAccountId,
        voucherId,
        name,
        description,
        contractAddress,
        chain,
        type,
        baseUri,
        tokenSymbol,
        royaltyShare,
        maxSupply,
        teamReserved,
        maxPerPerson,
        maxPerTransaction,
        presaleMintStartDate,
        publicMintStartDate,
        prerevealBaseUri,
        sbtActivated || false, // Default to false if not provided
        isGasless || false, // Default to false if not provided
        isArchived || false, // Default to false if not provided
        externalContract || false // Default to false if not provided
    ];

    try {
        const result = await db.query(query, values);
        return result.rows[0].id;  
    } catch (err) {
        console.error("Database error while creating smart account smart contract:", err);
        throw err;
    }
}


module.exports = {
    fetchBaseURI,
    fetchAccountIdByWalletAddress,
    fetchSmartAccountIDBySmartAccountAddress,
    createSmartAccountContract
};
