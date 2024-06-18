import fs from 'fs';
import path from 'path';
import {createHelia} from 'helia';
import { unixfs } from '@helia/unixfs';
import { strings } from '@helia/strings';

async function createHeliaInstance() {
  return await createHelia();
}

async function startInstanceNode(helia) {
  await helia.start((err) => {
    if (err) {
      throw err;
    }
  });
  console.log('Backend IPFS node is running.');
}

/**
 * Add a file to an ipfs node.
 * @param helia Instance of createHelia.
 * @param filePath File path to add.
 * @returns {Promise<void>}
 */
async function addFile(helia, filePath) {
  const unixFS = unixfs(helia);
  const file = {
    path: filePath,
    content: fs.readFileSync(filePath)
  };

  try {
    const filesAdded = await unixFS.addFile(file);
    console.log('Added file:', filesAdded.path, filesAdded.cid);
    return filesAdded;
  } catch (error) {
    console.error(error);
  }
}

async function addFolder(helia, folderPath) {
  const unixFS = unixfs(helia);
  const files = fs.readdirSync(folderPath).map(fileName => {
    return {
      path: path.join(folderPath, fileName),
      content: fs.readFileSync(path.join(folderPath, fileName))
    };
  });

  try {
    const result = await unixFS.addAll(files);
    console.log(result);
  } catch (error) {
    console.error(error);
  }
}

async function addString(helia, content) {
  const s = strings(helia)
  const cid = await s.add(content)
  return cid.toString();
}

/**
 * Get a file as string from an ipfs node.
 * @param helia Instance of createHelia.
 * @param cid The cid of a file.
 * @returns {Promise<string>}
 */
async function getContentFromCid(helia, cid) {
  const file = await helia.cat(cid);
  return file.toString();
}

export {addFile, getContentFromCid, addString, addFolder, createHeliaInstance, startInstanceNode};
