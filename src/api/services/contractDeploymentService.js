import contractJson from '../utils/contracts/erc1155.json' assert {type: 'json'};

const { abi, bytecode } = contractJson;

const iface = new ethers.utils.Interface(abi);
const deployData = iface.encodeDeploy();
