const { getSigner } = require("../services/biconomyService");
const { createSmartAccountClient, createPaymaster ,PaymasterMode} = require("@biconomy/account");
const ethers = require('ethers');
const db = require('../config/dbConfig');
const contractJson = require('../utils/contracts/erc1155.json');
const { abi, bytecode } = contractJson;
const {encodeInitializationParameters} = require('../utils/contractImplementation');




exports.deploySmartContract = async (req, res) => {
    const { encrypted_wallet, name, max_supply,tokenQuantity, max_token_per_mint , max_token_per_person} = req.body;

    if (!encrypted_wallet || !encrypted_wallet.encryptedData || !encrypted_wallet.iv) {
        return res.status(400).json({ error: 'Invalid encrypted wallet data' });
    }

    try {
        const paymaster = await createPaymaster({
            paymasterUrl: process.env.PAYMASTER_URL,
        });

        const signerInstance = getSigner(encrypted_wallet);
        if (!signerInstance || !ethers.isAddress(signerInstance.address)) {
            return res.status(400).json({ error: 'Invalid or undefined signer address' });
        }

        const biconomySmartAccount = await createSmartAccountClient({
            signer: signerInstance,
            biconomyPaymasterApiKey: process.env.PAYMASTER_KEY,
            bundlerUrl: process.env.BUNDLER_URL
        });

        const randomSalt = ethers.hexlify(ethers.randomBytes(32));
        const deployData = new ethers.Interface([
            "function deploy(bytes32 _salt, bytes _creationCode) external returns (address)",
            "function addressOf(bytes32 _salt) external view returns (address)"
        ]).encodeFunctionData("deploy", [randomSalt, bytecode]);

        const txDeploy = {
            to: "0x988C135a1049Ce61730724afD342fb7C56CD2776",
            data: deployData
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
            "function addressOf(bytes32 _salt) external view returns (address)"
        ]).encodeFunctionData("addressOf", [randomSalt]);

        const computedAddress = await ethers.getDefaultProvider().call({
            to: txDeploy.to,
            data: addressData
        });
        function unpadEthereumAddress(computedAddress) {
            return '0x' + computedAddress.slice(26);
        }

       
        const smartAccountAddress = await biconomySmartAccount.getAccountAddress();
        const initData = encodeInitializationParameters(name, max_supply,tokenQuantity,max_token_per_person, max_token_per_mint,smartAccountAddress)
        const deployedAddress = unpadEthereumAddress(computedAddress)
        const initTx = {
            to: deployedAddress,
            data: initData
        };

        const initResponse = await biconomySmartAccount.sendTransaction(initTx, {
            paymasterServiceData: { mode: PaymasterMode.SPONSORED }
        });

        const initReceipt = await initResponse.wait();
        if (initReceipt.success=="false") {
            throw new Error('Initialization transaction failed');
        }
        
        res.status(200).json({
            message: "Contract deployed and initialized successfully",
            transactionHash,
            DeployedContractAddress: deployedAddress,
            receipt: initReceipt
        });
    } catch (error) {
        console.error('Error deploying smart contract:', error);
        res.status(500).json({
            error: 'Internal server error',
            details: error.message
        });
    }
};
