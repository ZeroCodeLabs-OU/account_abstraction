import fs from 'fs';
import {createHelia} from 'helia';
import {unixfs} from '@helia/unixfs';

async function createHeliaInstance() {
  return await createHelia({
    host: 'localhost',
    protocol: 'http',
    port: '5001'
  });
}

async function startInstanceNode(helia) {
  await helia.start((err) => {
    if (err) {
      throw err;
    }
  });
  console.log('IPFS node is running.');
}

async function uploadImagesToIPFS(helia, filesArray) {
  try {
    const unixFS = unixfs(helia);
    const dirCID = await unixFS.addDirectory();
    const uploadPromises = await filesArray.map(async (file) => {
      const fileBuffer = await fs.promises.readFile(file.path);
      const fileUint8Array = new Uint8Array(fileBuffer);
      const fileCID = await unixFS.addBytes(fileUint8Array);
      console.log(fileCID.toString());
      await unixFS.cp(fileCID, dirCID, file.originalname, {force: true});
    });
    await Promise.all(uploadPromises);
    return dirCID.toString();
  } catch (error) {
    console.error('An error is occurred while uploading files.', error);
    throw error;
  }
}

export {uploadImagesToIPFS, createHeliaInstance, startInstanceNode};
