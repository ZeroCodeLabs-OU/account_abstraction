import { bucket } from '../config/firebaseAdmin.js';
import { create } from 'ipfs-http-client';
import {uploadToIPFSAndPin} from "./ipfsService.js";
import {insertNFTMetadata,insertBaseURI} from "../utils/db_helper.js";

const auth = 'Basic ' + Buffer.from('641feefe9682428ab1e3c5bcabee9ad8'+ ':' + '48045231002c4b158ae4d2d908c1730d' ).toString('base64');
const client = create({
    host: 'ipfs.infura.io',
    port: 5001,
    protocol: 'https',
    headers: {
        authorization: auth,
    }
});

async function uploadToFirebase(image, firebaseFile) {
    return new Promise((resolve, reject) => {
        const blobStream = firebaseFile.createWriteStream({
            metadata: {
                contentType: image.mimetype
            }
        });

        blobStream.on('error', reject);

        blobStream.on('finish', async () => {
            try {
                await firebaseFile.makePublic();
                const publicUrl = `https://storage.googleapis.com/${bucket.name}/${firebaseFile.name}`;
                resolve(publicUrl);
            } catch (error) {
                console.error('Error making file public:', error);
                reject(error);
            }
        });
    
        blobStream.end(image.buffer);
    });}
async function processFiles(images, metadataFiles, voucherId) {
        let metadataUploads = [];
        let firebaseImageUrls = [];
        let tokenId = 0;
        for (const image of images) {
                const baseName = image.originalname.split('.').slice(0, -1).join('.'); 
                const metadataFile = metadataFiles.find(md => md.originalname.split('.').slice(0, -1).join('.') === baseName);
        
                if (!metadataFile) {
                    console.error(`No matching metadata file found for image ${image.originalname}`);
                    continue;
                }
        
                // Upload Image to IPFS
                const ipfsImageUrl = await uploadToIPFSAndPin(image.buffer, `${image.originalname}`);
        
                // Upload Image to Firebase Storage
                const firebaseStoragePath = `${image.originalname}`;
                const firebaseFile = bucket.file(firebaseStoragePath);
                const publicUrl = await uploadToFirebase(image, firebaseFile);
                firebaseImageUrls.push(publicUrl);  
        
                // Prepare and Update Metadata
                const metadataContent = JSON.parse(metadataFile.buffer.toString());
                metadataContent.media = ipfsImageUrl;  // Add IPFS image link to metadata
        
                const updatedMetadataBuffer = Buffer.from(JSON.stringify(metadataContent));
                const metadataPath = `${tokenId}.json`; // Rename metadata file based on tokenId
                const ipfsMetadataUrl = await uploadToIPFSAndPin(updatedMetadataBuffer, metadataPath);
                const metadataId = await insertNFTMetadata(voucherId, tokenId, publicUrl, metadataContent);

                metadataUploads.push({
                    path: metadataPath,
                    content: updatedMetadataBuffer
                });
        
                tokenId++; 
            }
        
            // Upload all metadata to a single directory for Base URI
            const directoryResponse = await client.addAll(metadataUploads, { wrapWithDirectory: true });
            let baseURI = '';
            for await (const response of directoryResponse) {
                if (response.path === '') {
                    baseURI = `https://jmakwana101.infura-ipfs.io/ipfs/${response.cid}`;
                    break;
                }
            }
            await insertBaseURI(voucherId, baseURI);

            return { baseURI, firebaseImageUrls };
        }
export {processFiles};