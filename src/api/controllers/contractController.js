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
const DISTRIBUTION_CONTRACT_ABI = [
  "constructor(address _usdtAddress)",
  "function setBulkWithdrawalAllowances(address[] recipients, uint256[] amounts) external",
  "function withdrawTokens(address withdrawalAddress) external",
  "function getWithdrawalAmount(address userAddress) external view returns (uint256)",
  "function getContractBalance() external view returns (uint256)",
  "function emergencyWithdraw(uint256 amount) external"
];

export const deployDistributionContract = async (req, res) => {
  const { tokenAddress, network = 'testnet' } = req.body;
  const { wallet_data } = req.auth;

  if (!wallet_data || !wallet_data.encryptedData || !wallet_data.iv) {
      return res.status(400).json({ error: 'Invalid encrypted wallet data' });
  }

  if (!tokenAddress || !ethers.isAddress(tokenAddress)) {
      return res.status(400).json({ error: 'Invalid token address' });
  }

  try {
      console.log('Starting deployment process...', { tokenAddress, network });
      
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

      const smartAccountAddress = await biconomySmartAccount.getAccountAddress();
      console.log('Smart Account Address:', smartAccountAddress);

      // Encode constructor parameters
      const abiCoder = new ethers.AbiCoder();
      const constructorArgs = abiCoder.encode(
          ['address', 'address'],
          [tokenAddress, smartAccountAddress]  // Pass token address and smart account as admin
      );

      // Get deployment data
      const randomSalt = ethers.hexlify(ethers.randomBytes(32));
      
      // Add your bytecode here
      const DISTRIBUTION_BYTECODE = "0x608060405234801561000f575f80fd5b50604051611d63380380611d638339818101604052810190610031919061022c565b60015f819055505f60015f6101000a81548160ff0219169083151502179055505f73ffffffffffffffffffffffffffffffffffffffff168273ffffffffffffffffffffffffffffffffffffffff1614806100b657505f73ffffffffffffffffffffffffffffffffffffffff168173ffffffffffffffffffffffffffffffffffffffff16145b156100ed576040517fe6c4247b00000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b816001806101000a81548173ffffffffffffffffffffffffffffffffffffffff021916908373ffffffffffffffffffffffffffffffffffffffff1602179055508060025f6101000a81548173ffffffffffffffffffffffffffffffffffffffff021916908373ffffffffffffffffffffffffffffffffffffffff1602179055508073ffffffffffffffffffffffffffffffffffffffff165f73ffffffffffffffffffffffffffffffffffffffff167f7e644d79422f17c01e4894b5f4f588d331ebfa28653d42ae832dc59e38c9798f60405160405180910390a3505061026a565b5f80fd5b5f73ffffffffffffffffffffffffffffffffffffffff82169050919050565b5f6101fb826101d2565b9050919050565b61020b816101f1565b8114610215575f80fd5b50565b5f8151905061022681610202565b92915050565b5f8060408385031215610242576102416101ce565b5b5f61024f85828601610218565b925050602061026085828601610218565b9150509250929050565b611aec806102775f395ff3fe6080604052600436106100aa575f3560e01c8063677b325d11610063578063677b325d146101ab5780636f9fb98a146101e7578063704b6c02146102115780638456cb5914610239578063d00bcabd1461024f578063f851a44014610277576100b1565b80631f9119b0146100b55780632f48ab7d146100dd5780633f4ba83a1461010757806349df728c1461011d57806356582bf9146101455780635c975abb14610181576100b1565b366100b157005b5f80fd5b3480156100c0575f80fd5b506100db60048036038101906100d69190611407565b6102a1565b005b3480156100e8575f80fd5b506100f1610728565b6040516100fe91906114b2565b60405180910390f35b348015610112575f80fd5b5061011b61074c565b005b348015610128575f80fd5b50610143600480360381019061013e91906114cb565b6107dc565b005b348015610150575f80fd5b5061016b600480360381019061016691906114cb565b610b17565b6040516101789190611505565b60405180910390f35b34801561018c575f80fd5b50610195610b5d565b6040516101a29190611538565b60405180910390f35b3480156101b6575f80fd5b506101d160048036038101906101cc91906114cb565b610b72565b6040516101de9190611505565b60405180910390f35b3480156101f2575f80fd5b506101fb610b87565b6040516102089190611505565b60405180910390f35b34801561021c575f80fd5b50610237600480360381019061023291906114cb565b610c25565b005b348015610244575f80fd5b5061024d610dd3565b005b34801561025a575f80fd5b5061027560048036038101906102709190611607565b610e63565b005b348015610282575f80fd5b5061028b61119b565b6040516102989190611694565b60405180910390f35b60025f9054906101000a900473ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff163373ffffffffffffffffffffffffffffffffffffffff1614610327576040517f82b4290000000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b61032f6111c0565b5f73ffffffffffffffffffffffffffffffffffffffff168273ffffffffffffffffffffffffffffffffffffffff1603610394576040517fe6c4247b00000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b5f81036103cd576040517f2c5211c600000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b5f73ffffffffffffffffffffffffffffffffffffffff168373ffffffffffffffffffffffffffffffffffffffff160361053b575f4790508181101561043e576040517ff4d678b800000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b5f8373ffffffffffffffffffffffffffffffffffffffff1683604051610463906116da565b5f6040518083038185875af1925050503d805f811461049d576040519150601f19603f3d011682016040523d82523d5f602084013e6104a2565b606091505b50509050806104e6576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016104dd90611748565b60405180910390fd5b8373ffffffffffffffffffffffffffffffffffffffff167fcb34bab4d8a21ce2df6988d496d854246c2a96147dac484b1e1a30be9213befd8460405161052c9190611505565b60405180910390a2505061071b565b5f8390505f8173ffffffffffffffffffffffffffffffffffffffff166370a08231306040518263ffffffff1660e01b81526004016105799190611694565b602060405180830381865afa158015610594573d5f803e3d5ffd5b505050506040513d601f19601f820116820180604052508101906105b8919061177a565b9050828110156105f4576040517ff4d678b800000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b5f8273ffffffffffffffffffffffffffffffffffffffff1663a9059cbb86866040518363ffffffff1660e01b81526004016106309291906117a5565b6020604051808303815f875af115801561064c573d5f803e3d5ffd5b505050506040513d601f19601f8201168201806040525081019061067091906117f6565b9050806106b2576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016106a99061186b565b60405180910390fd5b8473ffffffffffffffffffffffffffffffffffffffff168673ffffffffffffffffffffffffffffffffffffffff167fe921ae6c24420c995517b54a581810c5d0fd0e99f02ac02d0ebfd7ce3a6f994a8660405161070f9190611505565b60405180910390a35050505b61072361120d565b505050565b60018054906101000a900473ffffffffffffffffffffffffffffffffffffffff1681565b60025f9054906101000a900473ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff163373ffffffffffffffffffffffffffffffffffffffff16146107d2576040517f82b4290000000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b6107da611216565b565b6107e46111c0565b6107ec611277565b5f73ffffffffffffffffffffffffffffffffffffffff168173ffffffffffffffffffffffffffffffffffffffff1603610851576040517fe6c4247b00000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b5f60035f3373ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff1681526020019081526020015f205490505f81036108cb576040517f2c5211c600000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b8060018054906101000a900473ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff166370a08231306040518263ffffffff1660e01b81526004016109259190611694565b602060405180830381865afa158015610940573d5f803e3d5ffd5b505050506040513d601f19601f82011682018060405250810190610964919061177a565b101561099c576040517ff4d678b800000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b5f60035f3373ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff1681526020019081526020015f20819055505f60018054906101000a900473ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff1663a9059cbb84846040518363ffffffff1660e01b8152600401610a3a9291906117a5565b6020604051808303815f875af1158015610a56573d5f803e3d5ffd5b505050506040513d601f19601f82011682018060405250810190610a7a91906117f6565b905080610abc576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401610ab3906118d3565b60405180910390fd5b8273ffffffffffffffffffffffffffffffffffffffff167f6352c5382c4a4578e712449ca65e83cdb392d045dfcf1cad9615189db2da244b83604051610b029190611505565b60405180910390a25050610b1461120d565b50565b5f60035f8373ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff1681526020019081526020015f20549050919050565b5f60015f9054906101000a900460ff16905090565b6003602052805f5260405f205f915090505481565b5f60018054906101000a900473ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff166370a08231306040518263ffffffff1660e01b8152600401610be19190611694565b602060405180830381865afa158015610bfc573d5f803e3d5ffd5b505050506040513d601f19601f82011682018060405250810190610c20919061177a565b905090565b60025f9054906101000a900473ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff163373ffffffffffffffffffffffffffffffffffffffff1614610cab576040517f82b4290000000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b5f73ffffffffffffffffffffffffffffffffffffffff168173ffffffffffffffffffffffffffffffffffffffff1603610d10576040517fe6c4247b00000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b5f60025f9054906101000a900473ffffffffffffffffffffffffffffffffffffffff1690508160025f6101000a81548173ffffffffffffffffffffffffffffffffffffffff021916908373ffffffffffffffffffffffffffffffffffffffff1602179055508173ffffffffffffffffffffffffffffffffffffffff168173ffffffffffffffffffffffffffffffffffffffff167f7e644d79422f17c01e4894b5f4f588d331ebfa28653d42ae832dc59e38c9798f60405160405180910390a35050565b60025f9054906101000a900473ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff163373ffffffffffffffffffffffffffffffffffffffff1614610e59576040517f82b4290000000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b610e616112c1565b565b60025f9054906101000a900473ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff163373ffffffffffffffffffffffffffffffffffffffff1614610ee9576040517f82b4290000000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b610ef1611277565b818190508484905014610f30576040517fa24a13a600000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b5f5b84849050811015611194575f73ffffffffffffffffffffffffffffffffffffffff16858583818110610f6757610f666118f1565b5b9050602002016020810190610f7c91906114cb565b73ffffffffffffffffffffffffffffffffffffffff1603610fc9576040517fe6c4247b00000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b5f838383818110610fdd57610fdc6118f1565b5b905060200201350361101b576040517f2c5211c600000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b82828281811061102e5761102d6118f1565b5b9050602002013560035f87878581811061104b5761104a6118f1565b5b905060200201602081019061106091906114cb565b73ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff1681526020019081526020015f205f8282546110a7919061194b565b925050819055508484828181106110c1576110c06118f1565b5b90506020020160208101906110d691906114cb565b73ffffffffffffffffffffffffffffffffffffffff167fb02ea4e7ecdb64443ed633cefb587013399da0fb12440aabd83cb2a41c510ae860035f888886818110611123576111226118f1565b5b905060200201602081019061113891906114cb565b73ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff1681526020019081526020015f205460405161117f9190611505565b60405180910390a28080600101915050610f32565b5050505050565b60025f9054906101000a900473ffffffffffffffffffffffffffffffffffffffff1681565b60025f5403611204576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016111fb906119c8565b60405180910390fd5b60025f81905550565b60015f81905550565b61121e611322565b5f60015f6101000a81548160ff0219169083151502179055507f5db9ee0a495bf2e6ff9c91a7834c1ba4fdd244a5e8aa4e537bd38aeae4b073aa61126061136b565b60405161126d9190611694565b60405180910390a1565b61127f610b5d565b156112bf576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016112b690611a30565b60405180910390fd5b565b6112c9611277565b6001805f6101000a81548160ff0219169083151502179055507f62e78cea01bee320cd4e420270b5ea74000d11b0c9f74754ebdbfc544b05a25861130b61136b565b6040516113189190611694565b60405180910390a1565b61132a610b5d565b611369576040517f08c379a000000000000000000000000000000000000000000000000000000000815260040161136090611a98565b60405180910390fd5b565b5f33905090565b5f80fd5b5f80fd5b5f73ffffffffffffffffffffffffffffffffffffffff82169050919050565b5f6113a38261137a565b9050919050565b6113b381611399565b81146113bd575f80fd5b50565b5f813590506113ce816113aa565b92915050565b5f819050919050565b6113e6816113d4565b81146113f0575f80fd5b50565b5f81359050611401816113dd565b92915050565b5f805f6060848603121561141e5761141d611372565b5b5f61142b868287016113c0565b935050602061143c868287016113c0565b925050604061144d868287016113f3565b9150509250925092565b5f819050919050565b5f61147a6114756114708461137a565b611457565b61137a565b9050919050565b5f61148b82611460565b9050919050565b5f61149c82611481565b9050919050565b6114ac81611492565b82525050565b5f6020820190506114c55f8301846114a3565b92915050565b5f602082840312156114e0576114df611372565b5b5f6114ed848285016113c0565b91505092915050565b6114ff816113d4565b82525050565b5f6020820190506115185f8301846114f6565b92915050565b5f8115159050919050565b6115328161151e565b82525050565b5f60208201905061154b5f830184611529565b92915050565b5f80fd5b5f80fd5b5f80fd5b5f8083601f84011261157257611571611551565b5b8235905067ffffffffffffffff81111561158f5761158e611555565b5b6020830191508360208202830111156115ab576115aa611559565b5b9250929050565b5f8083601f8401126115c7576115c6611551565b5b8235905067ffffffffffffffff8111156115e4576115e3611555565b5b602083019150836020820283011115611600576115ff611559565b5b9250929050565b5f805f806040858703121561161f5761161e611372565b5b5f85013567ffffffffffffffff81111561163c5761163b611376565b5b6116488782880161155d565b9450945050602085013567ffffffffffffffff81111561166b5761166a611376565b5b611677878288016115b2565b925092505092959194509250565b61168e81611399565b82525050565b5f6020820190506116a75f830184611685565b92915050565b5f81905092915050565b50565b5f6116c55f836116ad565b91506116d0826116b7565b5f82019050919050565b5f6116e4826116ba565b9150819050919050565b5f82825260208201905092915050565b7f4e617469766520746f6b656e207769746864726177616c206661696c656400005f82015250565b5f611732601e836116ee565b915061173d826116fe565b602082019050919050565b5f6020820190508181035f83015261175f81611726565b9050919050565b5f81519050611774816113dd565b92915050565b5f6020828403121561178f5761178e611372565b5b5f61179c84828501611766565b91505092915050565b5f6040820190506117b85f830185611685565b6117c560208301846114f6565b9392505050565b6117d58161151e565b81146117df575f80fd5b50565b5f815190506117f0816117cc565b92915050565b5f6020828403121561180b5761180a611372565b5b5f611818848285016117e2565b91505092915050565b7f546f6b656e207769746864726177616c206661696c65640000000000000000005f82015250565b5f6118556017836116ee565b915061186082611821565b602082019050919050565b5f6020820190508181035f83015261188281611849565b9050919050565b7f5472616e73666572206661696c656400000000000000000000000000000000005f82015250565b5f6118bd600f836116ee565b91506118c882611889565b602082019050919050565b5f6020820190508181035f8301526118ea816118b1565b9050919050565b7f4e487b71000000000000000000000000000000000000000000000000000000005f52603260045260245ffd5b7f4e487b71000000000000000000000000000000000000000000000000000000005f52601160045260245ffd5b5f611955826113d4565b9150611960836113d4565b92508282019050808211156119785761197761191e565b5b92915050565b7f5265656e7472616e637947756172643a207265656e7472616e742063616c6c005f82015250565b5f6119b2601f836116ee565b91506119bd8261197e565b602082019050919050565b5f6020820190508181035f8301526119df816119a6565b9050919050565b7f5061757361626c653a20706175736564000000000000000000000000000000005f82015250565b5f611a1a6010836116ee565b9150611a25826119e6565b602082019050919050565b5f6020820190508181035f830152611a4781611a0e565b9050919050565b7f5061757361626c653a206e6f74207061757365640000000000000000000000005f82015250565b5f611a826014836116ee565b9150611a8d82611a4e565b602082019050919050565b5f6020820190508181035f830152611aaf81611a76565b905091905056fea2646970667358221220d3dd6f6d6706d8b29b7ac609a2857199bff1798ccf8abb7b8150785398affcf864736f6c634300081a0033"; // Add your contract bytecode here

      const deploymentBytecode = DISTRIBUTION_BYTECODE + constructorArgs.slice(2);

      const deployData = new ethers.Interface([
          "function deploy(bytes32 _salt, bytes _creationCode) external returns (address)",
          "function addressOf(bytes32 _salt) external view returns (address)"
      ]).encodeFunctionData("deploy", [randomSalt, deploymentBytecode]);

      const txDeploy = {
          to: process.env.CONTRACT_DEPLOYER_ADDRESS,
          data: deployData,
      };

      console.log('Sending deployment transaction...');
      const deployResponse = await biconomySmartAccount.sendTransaction(txDeploy, {
          paymasterServiceData: { mode: PaymasterMode.SPONSORED }
      });

      console.log('Waiting for deployment receipt...');
      const receiptDeploy = await deployResponse.wait();

      if (!receiptDeploy.success) {
          throw new Error('Deployment transaction failed');
      }

      // Get deployed address
      const addressData = new ethers.Interface([
          'function addressOf(bytes32 _salt) external view returns (address)',
      ]).encodeFunctionData('addressOf', [randomSalt]);

      const computedAddress = await ethers.getDefaultProvider(config.INFURA_PROJECT_URL).call({
          to: process.env.CONTRACT_DEPLOYER_ADDRESS,
          data: addressData
      });

      const deployedAddress = '0x' + computedAddress.slice(26);

      console.log('Deployment successful', {
          contractAddress: deployedAddress,
          smartAccountAddress,
          tokenAddress
      });

      res.status(200).json({
          message: "Distribution contract deployed successfully",
          contractAddress: deployedAddress,
          tokenAddress: tokenAddress,
          adminAddress: smartAccountAddress,
          transactionHash: receiptDeploy.receipt.transactionHash
      });

  } catch (error) {
      console.error('Deployment error details:', error);
      res.status(500).json({
          error: 'Internal server error',
          details: error.message,
          stack: error.stack
      });
  }
};


export const setBulkAllowancesFromCSV = async (req, res) => {
  console.log('Starting setBulkAllowancesFromCSV');
  console.log('Request file:', req.file);
  console.log('Request body:', req.body);

  try {
      // Validate request
      if (!req.file) {
          console.log('No file found in request');
          return res.status(400).json({ error: 'No file uploaded' });
      }

      const { contractAddress, network = 'testnet' } = req.body;
      const { wallet_data } = req.auth;

      if (!contractAddress || !ethers.isAddress(contractAddress)) {
          console.log('Invalid contract address:', contractAddress);
          return res.status(400).json({ error: 'Invalid contract address' });
      }

      if (!wallet_data || !wallet_data.encryptedData || !wallet_data.iv) {
          console.log('Invalid wallet data');
          return res.status(400).json({ error: 'Invalid encrypted wallet data' });
      }

      // Parse CSV
      const addresses = [];
      const amounts = [];
      
      console.log('Starting CSV parsing...');
      await new Promise((resolve, reject) => {
          console.log('CSV Buffer size:', req.file.buffer.length, 'bytes');
          
          Readable.from(req.file.buffer)
              .pipe(parse({ columns: true, trim: true }))
              .on('data', (data) => {
                  console.log('Processing row:', data);
                  
                  if (!data.address || !data.amount) {
                      console.log('Error: Missing required columns');
                      reject(new Error('CSV must have address and amount columns'));
                      return;
                  }
                  
                  if (!ethers.isAddress(data.address)) {
                      console.log('Invalid address:', data.address);
                      reject(new Error(`Invalid address format: ${data.address}`));
                      return;
                  }

                  try {
                      const amount = ethers.parseUnits(data.amount.toString(), 18);
                      addresses.push(data.address);
                      amounts.push(amount);
                      console.log('Row processed:', {
                          address: data.address,
                          amount: data.amount,
                          parsedAmount: amount.toString()
                      });
                  } catch (error) {
                      console.log('Error parsing amount:', data.amount);
                      reject(new Error(`Invalid amount format: ${data.amount}`));
                      return;
                  }
              })
              .on('end', () => {
                  console.log('CSV parsing completed', {
                      addressCount: addresses.length
                  });
                  resolve(true);
              })
              .on('error', (error) => {
                  console.log('CSV parsing error:', error);
                  reject(error);
              });
      });

      if (addresses.length === 0) {
          return res.status(400).json({ error: 'No valid records found in CSV' });
      }

      // Setup Biconomy
      console.log('Setting up Biconomy...', { network });
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

      // Create contract interface and transaction data
      const distributorInterface = new ethers.Interface([
          "function setBulkWithdrawalAllowances(address[] recipients, uint256[] amounts) external"
      ]);

      const txData = distributorInterface.encodeFunctionData(
          "setBulkWithdrawalAllowances",
          [addresses, amounts]
      );

      console.log('Transaction data created', {
          contractAddress,
          addressesCount: addresses.length,
          dataSize: txData.length
      });

      const tx = {
          to: contractAddress,
          data: txData
      };

      // Send transaction
      console.log('Sending transaction...');
      const response = await biconomySmartAccount.sendTransaction(tx, {
          paymasterServiceData: { mode: PaymasterMode.SPONSORED }
      });

      console.log('Transaction sent, waiting for receipt...', {
          userOpHash: response.userOpHash
      });

      const receipt = await response.wait();
      console.log('Receipt received:', receipt);

      // Check if transaction was successful
      if (receipt.success === 'false') {
          console.error('Transaction failed', {
              receipt
          });
          return res.status(400).json({
              error: 'Transaction failed',
              details: {
                  userOpHash: receipt.userOpHash,
                  transactionHash: receipt.receipt.transactionHash,
                  reason: receipt.reason || 'Unknown reason'
              }
          });
      }

      res.status(200).json({
          message: "Bulk allowances set successfully",
          transactionHash: receipt.receipt.transactionHash,
          userOpHash: receipt.userOpHash,
          addressesProcessed: addresses.length,
          addresses,
          amounts: amounts.map(a => a.toString())
      });

  } catch (error) {
      console.error('Error in setBulkAllowancesFromCSV:', error);
      res.status(500).json({
          error: 'Transaction processing failed',
          details: error.message
      });
  }
};


// Get withdrawal amount endpoint
export const getWithdrawalAmount = async (req, res) => {
  try {
      const { contractAddress, userAddress, network = 'testnet' } = req.body;
      const { wallet_data } = req.auth;

      if (!contractAddress || !ethers.isAddress(contractAddress)) {
          return res.status(400).json({ error: 'Invalid contract address' });
      }

      if (!userAddress || !ethers.isAddress(userAddress)) {
          return res.status(400).json({ error: 'Invalid user address' });
      }

      const { signer, config } = getSigner_network(wallet_data, network);

      // Create contract interface
      const distributorInterface = new ethers.Interface([
          "function getWithdrawalAmount(address account) external view returns (uint256)"
      ]);

      // Create contract instance
      const contract = new ethers.Contract(contractAddress, distributorInterface, signer);

      // Get withdrawal amount
      const amount = await contract.getWithdrawalAmount(userAddress);

      res.status(200).json({
          address: userAddress,
          amount: amount.toString(),
          contractAddress
      });

  } catch (error) {
      console.error('Error getting withdrawal amount:', error);
      res.status(500).json({
          error: 'Failed to get withdrawal amount',
          details: error.message
      });
  }
};

// Withdraw tokens endpoint
export const withdrawTokens = async (req, res) => {
  try {
      const { contractAddress, withdrawalAddress, network = 'testnet' } = req.body;
      const { wallet_data } = req.auth;

      if (!contractAddress || !ethers.isAddress(contractAddress)) {
          return res.status(400).json({ error: 'Invalid contract address' });
      }

      if (!withdrawalAddress || !ethers.isAddress(withdrawalAddress)) {
          return res.status(400).json({ error: 'Invalid withdrawal address' });
      }

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

      // Create transaction data
      const distributorInterface = new ethers.Interface([
          "function withdrawTokens(address withdrawalAddress) external"
      ]);

      const txData = distributorInterface.encodeFunctionData(
          "withdrawTokens",
          [withdrawalAddress]
      );

      const tx = {
          to: contractAddress,
          data: txData
      };

      console.log('Sending withdrawal transaction...');
      const response = await biconomySmartAccount.sendTransaction(tx, {
          paymasterServiceData: { mode: PaymasterMode.SPONSORED }
      });

      console.log('Waiting for receipt...');
      const receipt = await response.wait();

      if (receipt.success === 'false') {
          return res.status(400).json({
              error: 'Withdrawal failed',
              details: {
                  userOpHash: receipt.userOpHash,
                  transactionHash: receipt.receipt.transactionHash,
                  reason: receipt.reason || 'Unknown reason'
              }
          });
      }

      res.status(200).json({
          message: "Withdrawal successful",
          transactionHash: receipt.receipt.transactionHash,
          userOpHash: receipt.userOpHash,
          withdrawalAddress,
          contractAddress
      });

  } catch (error) {
      console.error('Error withdrawing tokens:', error);
      res.status(500).json({
          error: 'Failed to withdraw tokens',
          details: error.message
      });
  }
};