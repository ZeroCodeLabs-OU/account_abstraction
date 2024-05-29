const contractJson = require('../utils/contracts/erc1155.json');
const { abi, bytecode } = contractJson;

const iface = new ethers.utils.Interface(abi);
const deployData = iface.encodeDeploy();
