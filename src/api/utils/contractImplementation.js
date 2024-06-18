import {ethers} from 'ethers';

function encodeInitializationData(name, max_supply, token_Quantity, max_token_per_mint, max_token_per_person, base_URI, public_mint_start, presale_mint_start, smartAccountAddress) {
  // Define the ABI for the `initialize` function
  const contractABI = [
    'function initialize(tuple(string name, string symbol, address owner, uint256 maxSupply, uint256[] tokenQuantity, uint256 tokensPerMint, uint256 tokenPerPerson, address treasuryAddress, address whitelistSigner, bool isSoulBound, bool openEdition, address trustedForwarder) deploymentConfig, tuple(string baseURI, bool metadataUpdatable, uint256 publicMintPrice, bool publicMintPriceFrozen, uint256 presaleMintPrice, bool presaleMintPriceFrozen, uint256 publicMintStart, uint256 presaleMintStart, string prerevealTokenURI, bytes32 presaleMerkleRoot, uint256 royaltiesBps, address royaltiesAddress) runtimeConfig, tuple(uint256[] tokenIds, uint256[] amounts) reservedMint) public',
  ];

  // Create an ethers Interface object
  const myInterface = new ethers.Interface(contractABI);

  // Define the data for each configuration structure
  const deploymentConfig = {
    name,
    symbol: name.slice(0, 4),
    owner: smartAccountAddress,
    maxSupply: max_supply,
    tokenQuantity: token_Quantity,
    tokensPerMint: max_token_per_mint,
    tokenPerPerson: max_token_per_person,
    treasuryAddress: smartAccountAddress,
    whitelistSigner: process.env.WHITELISTSIGNER,
    isSoulBound: false,
    openEdition: false,
    trustedForwarder: process.env.trustedForwarder,
  };

  const runtimeConfig = {
    baseURI: base_URI,
    metadataUpdatable: true,
    publicMintPrice: 0,
    publicMintPriceFrozen: true,
    presaleMintPrice: 0,
    presaleMintPriceFrozen: true,
    publicMintStart: public_mint_start,
    presaleMintStart: presale_mint_start,
    prerevealTokenURI: '',
    presaleMerkleRoot: ethers.ZeroHash,
    royaltiesBps: 0,
    royaltiesAddress: smartAccountAddress,
  };

  const reservedMint = {
    tokenIds: [],
    amounts: [],
  };

  // Encode the data using the interface
  const initData = myInterface.encodeFunctionData('initialize', [deploymentConfig, runtimeConfig, reservedMint]);

  return initData;
}

export { encodeInitializationData };
