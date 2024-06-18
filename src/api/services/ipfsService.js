import fs from 'fs';
import {createHelia} from 'helia';
import {unixfs} from '@helia/unixfs';

/**
 * Create an instance for using helia.
 * @returns {Promise<*>}
 */
async function createHeliaInstance() {
  return await createHelia({
    host: 'localhost',
    protocol: 'http',
    port: '5001'
  });
}

/**
 * Start an IPFS/Helia Node.
 * @param helia
 * @returns {Promise<void>}
 */
async function startInstanceNode(helia) {
  await helia.start((err) => {
    if (err) {
      throw err;
    }
  });
  console.log('IPFS node is running.');
}

/**
 * Upload Medias|Files to IPFS.
 * @param helia createHelia instance.
 * @param filesArray Files to upload.
 * @returns {Promise<string>} Directory CID.
 */
async function uploadImagesToIPFS(helia, filesArray) {
  try {
    const unixFS = unixfs(helia);
    let dirCID = await unixFS.addDirectory();
    const uploadPromises = await filesArray.map(async (file) => {
      const fileBuffer = await fs.promises.readFile(file.path);
      const fileUint8Array = new Uint8Array(fileBuffer);
      const fileCID = await unixFS.addBytes(fileUint8Array);
      dirCID = await unixFS.cp(fileCID, dirCID, file.originalname);
    });
    await Promise.all(uploadPromises);
    return dirCID.toString();
  } catch (error) {
    console.error('An error is occurred while adding files to ipfs.', error);
    throw error;
  }
}

/**
 * Upload Metadata to IPFS.
 * @param helia createHelia instance.
 * @param filesArray Files to upload.
 * @returns {Promise<string>} Directory CID.
 */
async function uploadMetadataToIPFS(helia, filesArray) {
  try {
    const unixFS = unixfs(helia);
    let dirCID = await unixFS.addDirectory();
    const uploadPromises = await filesArray.map(async (file, index) => {
      const fileBuffer = await fs.promises.readFile(file.path);
      const fileUint8Array = new Uint8Array(fileBuffer);
      const fileCID = await unixFS.addBytes(fileUint8Array);
      dirCID = await unixFS.cp(fileCID, dirCID, `${index}`);
    });
    await Promise.all(uploadPromises);
    return dirCID.toString();
  } catch (error) {
    console.error('An error is occurred while uploading metadata to ipfs.', error);
    throw error;
  }
}

export {createHeliaInstance, startInstanceNode, uploadImagesToIPFS, uploadMetadataToIPFS};
