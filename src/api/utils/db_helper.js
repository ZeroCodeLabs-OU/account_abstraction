import db from '../config/dbConfig.js';

async function fetchBaseURI(voucherId) {
  const query = 'SELECT base_uri FROM account_abstraction.nft_cid WHERE voucher_id = $1';
  try {
    const result = await db.query(query, [voucherId]);
    if (result.rows.length > 0) {
      return result.rows[0].base_uri;
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

async function getContractAddressByVoucherId(voucherId) {
  const query = 'SELECT contract_address FROM account_abstraction.smart_account_smart_contract WHERE voucher_id = $1';
  try {
    const result = await db.query(query, [voucherId]);
    if (result.rows.length > 0) {
      return result.rows[0].contract_address;
    } else {
      throw new Error("No contract address found for the given voucher ID");
    }
  } catch (err) {
    console.error("Database error while fetching contract address:", err);
    throw err;
  }
}

async function fetchSmartAccountIDBySmartAccountAddress(walletAddress) {
  const query = 'SELECT id FROM account_abstraction.smart_account WHERE smart_account_address = $1';
  try {
    const result = await db.query(query, [walletAddress]);
    if (result.rows.length > 0) {
      return result.rows[0].id; 
    } else {
      throw new Error("No smart account found for the given smart account address");
    }
  } catch (err) {
    console.error("Database error while fetching smart account id:", err);
    throw err;
  }
}

async function fetchSmartAccountByWalletAddress(walletAddress) {
  const query = 'SELECT smart_account_address FROM account_abstraction.smart_account WHERE wallet_address = $1';
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

async function recordMintTransaction(voucherId, tokenId, smartAccountAddress) {
  const query = `
    INSERT INTO account_abstraction.nft_tx_mint (voucher_id, token_id, smart_account_address, created_at, updated_at)
    VALUES ($1, $2, $3, now(), now())
    RETURNING id;
  `;
  const values = [voucherId, tokenId, smartAccountAddress];
  
  try {
    const result = await db.query(query, values);
    return result.rows[0].id;
  } catch (err) {
    console.error("Database error while recording mint transaction:", err);
    throw err;
  }
}

async function recordRevokeTransaction(voucherId, tokenId, smartAccountAddress) {
  const query = `
    INSERT INTO account_abstraction.nft_tx_revoke (voucher_id, token_id, smart_account_address, created_at, updated_at)
    VALUES ($1, $2, $3, now(), now())
    RETURNING id;
  `;
  const values = [voucherId, tokenId, smartAccountAddress];
  
  try {
    const result = await db.query(query, values);
    return result.rows[0].id;
  } catch (err) {
    console.error("Database error while recording revoke transaction:", err);
    throw err;
  }
}

async function insertNFTMetadata(voucherId, tokenId, imageUrl, metadata) {
  const query = `
      INSERT INTO account_abstraction.nft_metadata (voucher_id, token_id, image_url, metadata)
      VALUES ($1, $2, $3, $4)
      RETURNING id;
  `;
  const values = [voucherId, tokenId, imageUrl, metadata];
  try {
      const result = await db.query(query, values);
      return result.rows[0].id;
  } catch (err) {
      console.error("Database error while inserting NFT metadata:", err);
      throw err;
  }
}

// Function to insert the base URI into the nft_cid table
async function insertBaseURI(voucherId, baseUri) {
  const query = `
      INSERT INTO account_abstraction.nft_cid (voucher_id, base_uri)
      VALUES ($1, $2)
      RETURNING id;
  `;
  const values = [voucherId, baseUri];
  try {
      const result = await db.query(query, values);
      return result.rows[0].id;
  } catch (err) {
      console.error("Database error while inserting base URI:", err);
      throw err;
  }
}

async function getUidUsingVoucherId(voucherId) {
  const query = `
      SELECT sa.uid
      FROM account_abstraction.voucher v
      JOIN account_abstraction.smart_account sa ON v.smart_account_id = sa.id
      WHERE v.id = $1;
  `;
  try {
      const result = await db.query(query, [voucherId]);
      if (result.rows.length > 0) {
          return result.rows[0].uid;
      } else {
          throw new Error("No UID found for the given voucher ID");
      }
  } catch (err) {
      console.error("Database error while fetching UID:", err);
      throw err;
  }
}

async function fetchUIDByWalletAddress(walletAddress) {
  const query = 'SELECT id FROM account_abstraction.uid WHERE wallet_address = $1';
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

export {
  fetchBaseURI,
  fetchAccountIdByWalletAddress,
  fetchSmartAccountIDBySmartAccountAddress,
  createSmartAccountContract,
  recordMintTransaction,
  recordRevokeTransaction,
  getContractAddressByVoucherId,
  fetchSmartAccountByWalletAddress,insertNFTMetadata,insertBaseURI,getUidUsingVoucherId,fetchUIDByWalletAddress
};
