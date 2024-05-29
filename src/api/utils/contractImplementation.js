const ethers = require('ethers');

function encodeInitializationParameters(name, max_supply, tokenQuantity, max_token_per_person, max_token_per_mint, deployer_address) {
  const abiCoder = new ethers.AbiCoder();

  const tokenQuantities = Array.from({ length: max_supply }, () => tokenQuantity);

  // Deployment configuration as per contract structure
  const deploymentConfig = [
    name,  // Name of the NFT
    name.slice(0, 4),  // Symbol
    deployer_address,  // Owner address
    max_supply,  // Max supply
    tokenQuantities,  // Array of token quantities
    max_token_per_mint,  // Tokens per mint
    max_token_per_person,  // Tokens per person
    deployer_address,  // Treasury address
    deployer_address,  // Whitelist signer
    false,  // isSoulBound
    false,  // openedition
    deployer_address  // trustedForwarder
  ];

  const runtimeConfig = [
    "ipfs://test/",  // Base URI
    true,  // metadataUpdatable
    ethers.parseEther("0"),  // Public mint price
    true,  // Public mint price frozen
    ethers.parseEther("0"),  // Presale mint price
    true,  // Presale mint price frozen
    Math.floor(Date.now() / 1000),  // Public mint start time
    Math.floor(Date.now() / 1000) + 86400,  // Presale mint start time
    "ipfs://examplePreRevealUri/",  // Prereveal token URI
    ethers.ZeroHash,  // Presale merkle root
    0,  // Royalties basis points
    deployer_address  // Royalties address
  ];

  const reservedMint = [
    [0],  // tokenIds
    [0]   // amounts
  ];

  const encodedDeploymentConfig = abiCoder.encode([
    "tuple(string,string,address,uint256,uint256[],uint256,uint256,address,address,bool,bool,address)"
  ], [deploymentConfig]);

  const encodedRuntimeConfig = abiCoder.encode([
    "tuple(string,bool,uint256,bool,uint256,bool,uint256,uint256,string,bytes32,uint256,address)"
  ], [runtimeConfig]);

  const encodedReservedMint = abiCoder.encode([
    "tuple(uint256[],uint256[])"
  ], [reservedMint]);

  const functionSelector = ethers.id("initialize((string,string,address,uint256,uint256[],uint256,uint256,address,address,bool,bool,address),(string,bool,uint256,bool,uint256,bool,uint256,uint256,string,bytes32,uint256,address),(uint256[],uint256[]))").slice(0, 10);

  const txData = functionSelector + encodedDeploymentConfig.substring(2) + encodedRuntimeConfig.substring(2) + encodedReservedMint.substring(2);

  return txData;
}

module.exports = { encodeInitializationParameters };
