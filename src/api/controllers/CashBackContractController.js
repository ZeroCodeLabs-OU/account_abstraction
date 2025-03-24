import { ethers } from 'ethers';
import { createSmartAccountClient, createPaymaster, PaymasterMode } from '@biconomy/account';
import { getSigner_network } from '../services/biconomyService.js';
import dotenv from 'dotenv';
dotenv.config();

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
  
  export const pool_getERC20Balance = async (req, res) => {
    const { smartcontract,tokenAddress, network } = req.body;
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
        tokenContract.balanceOf(smartcontract),
        tokenContract.decimals(),
        tokenContract.symbol()
      ]);
      console.log(decimals)
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
  }
  
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



  const POOL_TREASURY_ABI = [
    "function addAllocation(address pool, uint256 amount) external returns (uint256)",
    "function batchAddAllocations(address[] pools, uint256[] amounts) external",
    "function resetAllocation(address pool) external",
    "function executeTransfers(address[] pools) external",
    "function getAllocatedPools() external view returns (address[])",
    "function getAllocatedPoolCount() external view returns (uint256)",
    "function getTotalAllocated() external view returns (uint256)",
    "function poolAllocations(address) external view returns (uint256)"

];

export const addPoolAllocation = async (req, res) => {
    const { poolAddress, amount, network, treasuryAddress } = req.body;
    const { wallet_data } = req.auth;

    if (!wallet_data || !wallet_data.encryptedData || !wallet_data.iv) {
        return res.status(400).json({ error: 'Invalid encrypted wallet data' });
    }

    if (!ethers.isAddress(poolAddress)) {
        return res.status(400).json({ error: 'Invalid pool address' });
    }

    if (!amount || isNaN(amount) || amount <= 0) {
        return res.status(400).json({ error: 'Invalid amount' });
    }

    if (!ethers.isAddress(treasuryAddress)) {
        return res.status(400).json({ error: 'Invalid treasury address' });
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

        const treasuryContract = new ethers.Contract(treasuryAddress, POOL_TREASURY_ABI);
        
        const addAllocationData = treasuryContract.interface.encodeFunctionData(
            "addAllocation",
            [poolAddress, amount]
        );

        const tx = {
            to: treasuryAddress,
            data: addAllocationData
        };

        const txResponse = await biconomySmartAccount.sendTransaction(tx, {
            paymasterServiceData: { mode: PaymasterMode.SPONSORED }
        });

        const { transactionHash } = await txResponse.waitForTxHash();
        const txReceipt = await txResponse.wait();

        if (!txReceipt.success) {
            throw new Error('Add allocation transaction failed');
        }

        res.status(200).json({
            success: true,
            message: "Pool allocation added successfully",
            data: {
                transactionHash,
                pool: poolAddress,
                amount: amount.toString(),
                receipt: txReceipt
            }
        });

    } catch (error) {
        console.error('Error adding pool allocation:', error);
        res.status(500).json({
            error: 'Internal server error',
            details: error.message
        });
    }
};


export const batchAddPoolAllocations = async (req, res) => {
    const { allocations, network, treasuryAddress } = req.body;
    const { wallet_data } = req.auth;

    if (!wallet_data || !wallet_data.encryptedData || !wallet_data.iv) {
        return res.status(400).json({ error: 'Invalid encrypted wallet data' });
    }

    if (!Array.isArray(allocations) || allocations.length === 0) {
        return res.status(400).json({ error: 'Allocations must be a non-empty array' });
    }

    const pools = [];
    const amounts = [];

    // Validate and separate pools and amounts
    for (const allocation of allocations) {
        if (!ethers.isAddress(allocation.pool)) {
            return res.status(400).json({ error: `Invalid pool address: ${allocation.pool}` });
        }
        if (!allocation.amount || allocation.amount <= 0) {
            return res.status(400).json({ error: `Invalid amount for pool ${allocation.pool}` });
        }
        pools.push(allocation.pool);
        amounts.push(allocation.amount);
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

        const treasuryContract = new ethers.Contract(treasuryAddress, POOL_TREASURY_ABI);
        
        const batchAddData = treasuryContract.interface.encodeFunctionData(
            "batchAddAllocations",
            [pools, amounts]
        );

        const tx = {
            to: treasuryAddress,
            data: batchAddData
        };

        const txResponse = await biconomySmartAccount.sendTransaction(tx, {
            paymasterServiceData: { mode: PaymasterMode.SPONSORED }
        });

        const { transactionHash } = await txResponse.waitForTxHash();
        const txReceipt = await txResponse.wait();

        if (!txReceipt.success) {
            throw new Error('Batch allocation transaction failed');
        }

        res.status(200).json({
            success: true,
            message: "Batch pool allocations added successfully",
            data: {
                transactionHash,
                allocations: allocations.map(a => ({
                    pool: a.pool,
                    amount: a.amount.toString()
                })),
                receipt: txReceipt
            }
        });

    } catch (error) {
        console.error('Error adding batch pool allocations:', error);
        res.status(500).json({
            error: 'Internal server error',
            details: error.message
        });
    }
};


export const resetPoolAllocation = async (req, res) => {
    const { poolAddress, network, treasuryAddress } = req.body;
    const { wallet_data } = req.auth;

    if (!wallet_data || !wallet_data.encryptedData || !wallet_data.iv) {
        return res.status(400).json({ error: 'Invalid encrypted wallet data' });
    }

    if (!ethers.isAddress(poolAddress)) {
        return res.status(400).json({ error: 'Invalid pool address' });
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

        const treasuryContract = new ethers.Contract(treasuryAddress, POOL_TREASURY_ABI);
        
        const resetData = treasuryContract.interface.encodeFunctionData(
            "resetAllocation",
            [poolAddress]
        );

        const tx = {
            to: treasuryAddress,
            data: resetData
        };

        const txResponse = await biconomySmartAccount.sendTransaction(tx, {
            paymasterServiceData: { mode: PaymasterMode.SPONSORED }
        });

        const { transactionHash } = await txResponse.waitForTxHash();
        const txReceipt = await txResponse.wait();

        if (!txReceipt.success) {
            throw new Error('Reset allocation transaction failed');
        }

        res.status(200).json({
            success: true,
            message: "Pool allocation reset successfully",
            data: {
                transactionHash,
                pool: poolAddress,
                receipt: txReceipt
            }
        });

    } catch (error) {
        console.error('Error resetting pool allocation:', error);
        res.status(500).json({
            error: 'Internal server error',
            details: error.message
        });
    }
};

export const executePoolTransfers = async (req, res) => {
    const { pools, network, treasuryAddress } = req.body;
    const { wallet_data } = req.auth;

    if (!wallet_data || !wallet_data.encryptedData || !wallet_data.iv) {
        return res.status(400).json({ error: 'Invalid encrypted wallet data' });
    }

    if (!Array.isArray(pools) || pools.length === 0) {
        return res.status(400).json({ error: 'Pools must be a non-empty array' });
    }

    // Validate pool addresses
    for (const pool of pools) {
        if (!ethers.isAddress(pool)) {
            return res.status(400).json({ error: `Invalid pool address: ${pool}` });
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

        const treasuryContract = new ethers.Contract(treasuryAddress, POOL_TREASURY_ABI);
        
        const executeData = treasuryContract.interface.encodeFunctionData(
            "executeTransfers",
            [pools]
        );

        const tx = {
            to: treasuryAddress,
            data: executeData
        };

        const txResponse = await biconomySmartAccount.sendTransaction(tx, {
            paymasterServiceData: { mode: PaymasterMode.SPONSORED }
        });

        const { transactionHash } = await txResponse.waitForTxHash();
        const txReceipt = await txResponse.wait();

        if (!txReceipt.success) {
            throw new Error('Execute transfers transaction failed');
        }

        res.status(200).json({
            success: true,
            message: "Pool transfers executed successfully",
            data: {
                transactionHash,
                pools,
                receipt: txReceipt
            }
        });

    } catch (error) {
        console.error('Error executing pool transfers:', error);
        res.status(500).json({
            error: 'Internal server error',
            details: error.message
        });
    }
};


export const getPoolTreasuryInfo = async (req, res) => {
    const { network, treasuryAddress } = req.body;

    if (!ethers.isAddress(treasuryAddress)) {
        return res.status(400).json({ error: 'Invalid treasury address' });
    }   

    try {
        const config = {
            mainnet: {
              INFURA_PROJECT_URL: process.env.INFURA_PROJECT_URL_MAINNET,
              PAYMASTER_URL: process.env.PAYMASTER_URL_MAINNET,
              BUNDLER_URL: process.env.BUNDLER_URL_MAINNET,
              PAYMASTER_KEY: process.env.PAYMASTER_KEY_MAINNET,
              CHAINID: process.env.CHAINID_MAINNET
            },
            testnet: {
              INFURA_PROJECT_URL: process.env.INFURA_PROJECT_URL_TESTNET,
              PAYMASTER_URL: process.env.PAYMASTER_URL_TESTNET,
              BUNDLER_URL: process.env.BUNDLER_URL_TESTNET,
              PAYMASTER_KEY: process.env.PAYMASTER_KEY_TESTNET,
              CHAINID: process.env.CHAINID_TESTNET
            }
          }[network];
        
        // Create provider based on network
        const provider = ethers.getDefaultProvider(config.INFURA_PROJECT_URL);
        const treasuryContract = new ethers.Contract(treasuryAddress, POOL_TREASURY_ABI, provider);

        // Fetch all data in parallel
        const [allocatedPools, poolCount, totalAllocated] = await Promise.all([
            treasuryContract.getAllocatedPools(),
            treasuryContract.getAllocatedPoolCount(),
            treasuryContract.getTotalAllocated()
        ]);

        // Fetch individual pool allocations
        const poolAllocationsPromises = allocatedPools.map(async (pool) => {
            const allocation = await treasuryContract.poolAllocations(pool);
            return {
                pool,
                allocation: allocation.toString()
            };
        });

        const poolAllocations = await Promise.all(poolAllocationsPromises);

        res.status(200).json({
            success: true,
            data: {
                allocatedPools,
                poolCount: poolCount.toString(),
                totalAllocated: totalAllocated.toString(),
                poolAllocations
            }
        });

    } catch (error) {
        console.error('Error fetching pool treasury info:', error);
        res.status(500).json({
            error: 'Internal server error',
            details: error.message
        });
    }
};