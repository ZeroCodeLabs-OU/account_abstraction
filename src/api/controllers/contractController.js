import { ethers } from 'ethers';
import { createSmartAccountClient, createPaymaster, PaymasterMode } from '@biconomy/account';
import { getSigner,getSigner_network } from '../services/biconomyService.js';
import db from '../config/dbConfig.js';
import contractJson from '../utils/contracts/erc1155.json' assert { type: 'json' };
import dotenv from 'dotenv';
dotenv.config();
import {
  fetchBaseURI,
  fetchAccountIdByWalletAddress,
  fetchSmartAccountIDBySmartAccountAddress,
  createSmartAccountContract,
  recordMintTransaction,
  recordRevokeTransaction,fetchNetworkFromVoucherId,
  getContractAddressByVoucherId,getUidUsingVoucherId,fetchMintTransactionCount
} from '../utils/db_helper.js';
import multer from 'multer';
import { parse } from 'csv-parse';
import { Readable } from 'stream';
const { abi, bytecode } = contractJson;
import { encodeInitializationData } from '../utils/contractImplementation.js';

export const deploySmartContract = async (req, res) => {
  const { voucherId, name, max_supply, tokenQuantity, max_token_per_mint, max_token_per_person } = req.body;
  const { wallet_data } = req.auth;

  if (!wallet_data || !wallet_data.encryptedData || !wallet_data.iv) {
    return res.status(400).json({ error: 'Invalid encrypted wallet data' });
  }

  const network =await  fetchNetworkFromVoucherId(voucherId);

  try {
    console.log('Creating Paymaster...');
    
    const { signer,config } = getSigner_network(wallet_data, network);

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
      chain: network,
      type: "ERC1155",
      baseUri: base_URI,
      tokenSymbol: name.slice(0, 4),
      royaltyShare: 0,
      maxSupply: max_supply, 
      tokenQuantity : tokenQuantity ,
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
  const { voucherId, id = 0, amount = 1, tokenIndex = 1 } = req.body;
  const { wallet_data, uid } = req.auth;
  const data = "0x00";

  console.log('Received request body:', req.body);

  if (!wallet_data || !wallet_data.encryptedData || !wallet_data.iv) {
    return res.status(400).json({ error: 'Invalid encrypted wallet data' });
  }

  const network = await fetchNetworkFromVoucherId(voucherId);
  const { signer, config } = getSigner_network(wallet_data, network);
  const walletAddress = signer.address;
  const existingAccount = await db.query('SELECT * FROM account_abstraction.smart_account WHERE wallet_address = $1', [walletAddress]);

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
      [uid, walletAddress, smartAccountAddress, new Date()]
    );
    smartAccountId = result.rows[0].id;
  }

  const retryTransaction = async (retryCount = 0) => {
    try {
      const { signer, config } = getSigner_network(wallet_data, network);
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

      const walletAddress = await biconomySmartAccount.getAccountAddress();
      const contractAddress = await getContractAddressByVoucherId(voucherId);
      const tokenPerPerson = contractAddress.max_per_person;
      const contractABI = [
        "function balanceOf(address account, uint256 id) public view returns (uint256)"
      ];
      const provider = ethers.getDefaultProvider(config.INFURA_PROJECT_URL);
      const contract = new ethers.Contract(contractAddress.contract_address, contractABI, provider);

      // Call the balanceOf function directly
      const balance = await contract.balanceOf(walletAddress, id);
      const balanceNumber = parseInt(balance.toString(), 10);

      if (balanceNumber + amount > tokenPerPerson) {
        return res.status(400).json({ error: 'Token Per Person value surpassed' });
      }

      const _contractABI = [
        "function availableToken(uint256 id) public view returns (uint256)"
      ];
      const _contract = new ethers.Contract(contractAddress.contract_address, _contractABI, provider);

      // Check available tokens
      const available = await _contract.availableToken(id);
      const availableToken = parseInt(available.toString(), 10);
      if (availableToken === 0) {
        return res.status(400).json({ error: 'Max supply of token ID surpassed' });
      }

      const totalMinted = await fetchMintTransactionCount(voucherId, id);
      const tokenQuantity = contractAddress.tokenquantity[id];
      console.log("Token Quantity:", tokenQuantity);
      console.log("Total Minted:", totalMinted);
      if (totalMinted >= tokenQuantity) {
        return res.status(400).json({ error: 'Token quantity surpassed' });
      }

      const mintFunctionData = new ethers.Interface([
        "function mint(uint256 amount, uint256 id, bytes memory data)"
      ]).encodeFunctionData("mint", [amount, id, data]);

      const tx = {
        to: contractAddress.contract_address,
        data: mintFunctionData
      };

      const txResponse = await biconomySmartAccount.sendTransaction(tx, {
        paymasterServiceData: { mode: PaymasterMode.SPONSORED }
      });
      const txReceipt = await txResponse.wait();

      // Check transaction success
      if (txReceipt.success === "false") {
        throw new Error('Mint transaction failed');
      }

      console.log('Mint transaction successful:', txReceipt);

      const smartAccountAddress = await biconomySmartAccount.getAccountAddress();
      await recordMintTransaction(voucherId, id, smartAccountAddress);
      console.log('Mint transaction recorded in database.');

      const uid = await getUidUsingVoucherId(voucherId);

      res.status(200).json({
        message: "Tokens minted successfully",
        "txReceipt": txReceipt,
        "voucherId": voucherId,
        "uid": uid
      });
    } catch (error) {
      if (retryCount < 3) {
        const delay = 2000 + (retryCount * 1000); // Wait time: 2s, 3s, 4s
        console.error(`Error minting tokens (attempt ${retryCount + 1}), retrying in ${delay / 1000}s...`, error);

        // Wait before retrying
        setTimeout(() => retryTransaction(retryCount + 1), delay);
      } else {
        console.error('Max retries reached. Error minting tokens:', error);
        return res.status(500).json({
          error: 'Internal server error',
          details: error.message
        });
      }
    }
  };

  // Start the first transaction attempt
  retryTransaction();
};



export const revokeTokens = async (req, res) => {
  const { voucherId, id, amount,network } = req.body;
  const { wallet_data } = req.auth;

  console.log('Received request body:', req.body);

  if (!wallet_data || !wallet_data.encryptedData || !wallet_data.iv) {
    return res.status(400).json({ error: 'Invalid encrypted wallet data' });
  }
  if (!network || (network !== 'mainnet' && network !== 'testnet')) {
    return res.status(400).json({ error: 'Invalid network parameter. Only "mainnet" and "testnet" are allowed.' });
  }
  try {
    const { signer,config } = getSigner_network(wallet_data,network);
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
    const contractAddress = await getContractAddressByVoucherId(voucherId);

    const burnFunctionData = new ethers.Interface([
      "function burn(uint256 id, uint256 amount)"
    ]).encodeFunctionData("burn", [id, amount]);

    const tx = {
      to: contractAddress.contract_address,
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
      "txReceipt":txReceipt,
      "voucherId":voucherId,
      "uid":uid
    });
  } catch (error) {
    console.error('Error revoking tokens:', error);
    res.status(500).json({
      error: 'Internal server error',
      details: error.message
    });
  }
};


export const getERC20Balance = async (req, res) => {
  const { tokenAddress, network } = req.body;
  const { wallet_data } = req.auth;

  if (!wallet_data || !wallet_data.encryptedData || !wallet_data.iv) {
    return res.status(400).json({ error: 'Invalid encrypted wallet data' });
  }

  if (!tokenAddress || !ethers.isAddress(tokenAddress)) {
    return res.status(400).json({ error: 'Invalid ERC20 token address' });
  }

  if (!network || (network !== 'mainnet' && network !== 'testnet')) {
    return res.status(400).json({ error: 'Invalid network parameter. Only "mainnet" and "testnet" are allowed.' });
  }

  try {
    const { signer, config } = getSigner_network(wallet_data, network);
    
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

    // Get the smart account address
    const smartAccountAddress = await biconomySmartAccount.getAccountAddress();

    // ERC20 token contract interface
    const erc20ABI = [
      "function balanceOf(address account) view returns (uint256)",
      "function decimals() view returns (uint8)",
      "function symbol() view returns (string)"
    ];

    // Create provider and contract instances
    const provider = ethers.getDefaultProvider(config.INFURA_PROJECT_URL);
    const tokenContract = new ethers.Contract(tokenAddress, erc20ABI, provider);

    // Fetch token details and balance
    const [balance, decimals, symbol] = await Promise.all([
      tokenContract.balanceOf(smartAccountAddress),
      tokenContract.decimals(),
      tokenContract.symbol()
    ]);

    // Convert balance to human readable format and ensure it's a string
    const formattedBalance = ethers.formatUnits(balance, decimals);
    
    res.status(200).json({
      success: true,
      data: {
        smartAccountAddress,
        tokenAddress,
        symbol,
        balance: formattedBalance,
        rawBalance: balance.toString(), // Convert BigInt to string
        decimals: Number(decimals) // Convert to regular number
      }
    });

  } catch (error) {
    console.error('Error fetching ERC20 balance:', error);
    res.status(500).json({
      error: 'Internal server error',
      details: error.message
    });
  }
};


const USDC_ABI = [
  "function transfer(address to, uint256 amount) external returns (bool)",
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function balanceOf(address account) external view returns (uint256)",
  "function decimals() external view returns (uint8)"
];

export const withdrawUSDC = async (req, res) => {
  const { receiverAddress, amount, network, tokenAddress } = req.body;
  const { wallet_data } = req.auth;

  if (!wallet_data || !wallet_data.encryptedData || !wallet_data.iv) {
      return res.status(400).json({ error: 'Invalid encrypted wallet data' });
  }

  if (!ethers.isAddress(receiverAddress)) {
      return res.status(400).json({ error: 'Invalid receiver address' });
  }

  if (!amount || isNaN(amount)) {
      return res.status(400).json({ error: 'Invalid amount' });
  }

  if (!network || (network !== 'mainnet' && network !== 'testnet')) {
      return res.status(400).json({ error: 'Invalid network parameter' });
  }

  if (!ethers.isAddress(tokenAddress)) {
      return res.status(400).json({ error: 'Invalid USDC token address' });
  }

  try {
      const { signer, config } = getSigner_network(wallet_data, network);

      const paymaster = await createPaymaster({
          paymasterUrl: config.PAYMASTER_URL,
          strictMode: true,
      });

      const biconomySmartAccount = await createSmartAccountClient({
          signer,
          paymaster,
          bundlerUrl: config.BUNDLER_URL,
      });

      // Get smart account address
      const smartAccountAddress = await biconomySmartAccount.getAccountAddress();

      // Create contract instance
      const provider = ethers.getDefaultProvider(config.INFURA_PROJECT_URL);
      const usdcContract = new ethers.Contract(tokenAddress, USDC_ABI, provider);

      // Get decimals and check balance
      const decimals = await usdcContract.decimals();
      const balance = await usdcContract.balanceOf(smartAccountAddress);
      const amountInWei = ethers.parseUnits(amount.toString(), decimals);

      if (balance < amountInWei) {
          return res.status(400).json({ error: 'Insufficient USDC balance' });
      }

      // Prepare transfer transaction
      const transferData = usdcContract.interface.encodeFunctionData("transfer", [
          receiverAddress,
          amountInWei
      ]);

      const tx = {
          to: tokenAddress,
          data: transferData
      };

      // Send transaction
      const txResponse = await biconomySmartAccount.sendTransaction(tx, {
          paymasterServiceData: { mode: PaymasterMode.SPONSORED }
      });

      const txReceipt = await txResponse.wait();
      if (!txReceipt.success && txReceipt.success != "true") {
        throw new Error('Withdrawal transaction failed');
      }

      res.status(200).json({
          success: true,
          message: "USDC withdrawn successfully",
          data: {
              transactionHash: txReceipt.transactionHash,
              from: smartAccountAddress,
              to: receiverAddress,
              amount: amount.toString(),
              receipt: txReceipt
          }
      });

  } catch (error) {
      console.error('Error withdrawing USDC:', error);
      res.status(500).json({
          error: 'Internal server error',
          details: error.message
      });
  }
};

export const depositToPool = async (req, res) => {
  const { contractAddress, amount, network, tokenAddress } = req.body;
  const { wallet_data } = req.auth;

  if (!wallet_data || !wallet_data.encryptedData || !wallet_data.iv) {
      return res.status(400).json({ error: 'Invalid encrypted wallet data' });
  }

  if (!ethers.isAddress(contractAddress)) {
      return res.status(400).json({ error: 'Invalid contract address' });
  }

  if (!amount || isNaN(amount)) {
      return res.status(400).json({ error: 'Invalid amount' });
  }

  if (!network || (network !== 'mainnet' && network !== 'testnet')) {
      return res.status(400).json({ error: 'Invalid network parameter' });
  }

  if (!ethers.isAddress(tokenAddress)) {
      return res.status(400).json({ error: 'Invalid USDC token address' });
  }

  try {
      const { signer, config } = getSigner_network(wallet_data, network);

      const paymaster = await createPaymaster({
          paymasterUrl: config.PAYMASTER_URL,
          strictMode: true,
      });

      const biconomySmartAccount = await createSmartAccountClient({
          signer,
          paymaster,
          bundlerUrl: config.BUNDLER_URL,
      });

      // Get smart account address
      const smartAccountAddress = await biconomySmartAccount.getAccountAddress();

      // Create contract instance
      const provider = ethers.getDefaultProvider(config.INFURA_PROJECT_URL);
      const usdcContract = new ethers.Contract(tokenAddress, USDC_ABI, provider);

      // Get decimals and check balance
      const decimals = await usdcContract.decimals();
      const balance = await usdcContract.balanceOf(smartAccountAddress);
      const amountInWei = ethers.parseUnits(amount.toString(), decimals);

      if (balance < amountInWei) {
          return res.status(400).json({ error: 'Insufficient USDC balance' });
      }

      // Prepare transfer transaction
      const transferData = usdcContract.interface.encodeFunctionData("transfer", [
          contractAddress,
          amountInWei
      ]);

      const tx = {
          to: tokenAddress,
          data: transferData
      };

      // Send transaction
      const txResponse = await biconomySmartAccount.sendTransaction(tx, {
          paymasterServiceData: { mode: PaymasterMode.SPONSORED }
      });

      const txReceipt = await txResponse.wait();

      if (txReceipt.success=="false") {
          throw new Error('Transfer transaction failed');
      }

      res.status(200).json({
          success: txReceipt.success,
          message: "USDC sent to contract successfully",
          data: {
              transactionHash: txReceipt.transactionHash,
              from: smartAccountAddress,
              to: contractAddress,
              amount: amount.toString(),
              receipt: txReceipt
          }
      });

  } catch (error) {
      console.error('Error sending USDC to contract:', error);
      res.status(500).json({
          error: 'Internal server error',
          details: error.message
      });
  }
};


export const batchSendUSDC = async (req, res) => {
  const { transfers, network, tokenAddress } = req.body;
  const { wallet_data } = req.auth;

  // Validate input
  if (!wallet_data || !wallet_data.encryptedData || !wallet_data.iv) {
      return res.status(400).json({ error: 'Invalid encrypted wallet data' });
  }

  if (!Array.isArray(transfers) || transfers.length === 0) {
      return res.status(400).json({ error: 'Transfers must be a non-empty array' });
  }
  console.log(transfers.length,"transfers length")

  if (transfers.length > 100) {
      return res.status(400).json({ error: 'Maximum 100 transfers allowed in a batch' });
  }

  if (!network || (network !== 'mainnet' && network !== 'testnet')) {
      return res.status(400).json({ error: 'Invalid network parameter' });
  }

  if (!ethers.isAddress(tokenAddress)) {
      return res.status(400).json({ error: 'Invalid USDC token address' });
  }

  // Validate each transfer
  for (const transfer of transfers) {
      if (!ethers.isAddress(transfer.to)) {
          return res.status(400).json({ error: `Invalid recipient address: ${transfer.to}` });
      }
      if (!transfer.amount || isNaN(transfer.amount)) {
          return res.status(400).json({ error: `Invalid amount for recipient ${transfer.to}` });
      }
  }

  try {
      const { signer, config } = getSigner_network(wallet_data, network);

      const paymaster = await createPaymaster({
          paymasterUrl: config.PAYMASTER_URL,
          strictMode: true,
      });

      const biconomySmartAccount = await createSmartAccountClient({
          signer,
          paymaster,
          bundlerUrl: config.BUNDLER_URL,
      });

      // Get smart account address
      const smartAccountAddress = await biconomySmartAccount.getAccountAddress();

      // Create contract instance
      const provider = ethers.getDefaultProvider(config.INFURA_PROJECT_URL);
      const usdcContract = new ethers.Contract(tokenAddress, USDC_ABI, provider);

      // Get decimals and check total balance
      const decimals = await usdcContract.decimals();
      const balance = await usdcContract.balanceOf(smartAccountAddress);

      // Calculate total amount needed and prepare transactions
      let totalAmount = ethers.parseUnits('0', decimals);
      const transactions = [];

      for (const transfer of transfers) {
          const amountInWei = ethers.parseUnits(transfer.amount.toString(), decimals);
          totalAmount = totalAmount + amountInWei;

          const transferData = usdcContract.interface.encodeFunctionData("transfer", [
              transfer.to,
              amountInWei
          ]);

          transactions.push({
              to: tokenAddress,
              data: transferData
          });
      }

      // Check if enough balance
      if (balance < totalAmount) {
          return res.status(400).json({ error: 'Insufficient USDC balance for batch transfer' });
      }

      // Send batch transaction
      const txResponse = await biconomySmartAccount.sendTransaction(transactions, {
          paymasterServiceData: { mode: PaymasterMode.SPONSORED }
      });

      const { transactionHash } = await txResponse.waitForTxHash();
      console.log("Transaction Hash", transactionHash);

      const txReceipt = await txResponse.wait();

      if (!txReceipt.success) {
          throw new Error('Batch transfer failed');
      }

      res.status(200).json({
          success: true,
          message: "Batch USDC transfer completed successfully",
          data: {
              transactionHash,
              from: smartAccountAddress,
              totalAmount: ethers.formatUnits(totalAmount, decimals),
              transferCount: transfers.length,
              receipt: txReceipt
          }
      });

  } catch (error) {
      console.error('Error in batch USDC transfer:', error);
      res.status(500).json({
          error: 'Internal server error',
          details: error.message
      });
  }
};