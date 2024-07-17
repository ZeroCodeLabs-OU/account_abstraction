import { create } from 'ipfs-http-client';
import dotenv from 'dotenv';
dotenv.config();
const infuraPublic=process.env.INFURA_PROJECT_ID
const infuraPrivate=process.env.INFURA_PROJECT_SECRET
const auth = 'Basic ' + Buffer.from(infuraPublic+ ':' + infuraPrivate ).toString('base64');
const client = create({
    host: 'ipfs.infura.io',
    port: 5001,
    protocol: 'https',
    headers: {
        authorization: auth,
    }
});

export async function uploadToIPFSAndPin(buffer, filename) {
    try {
        const added = await client.add({ content: buffer }, { pin: true, wrapWithDirectory: false });
        const fileUrl = `https://zero-code-io.infura-ipfs.io/ipfs/${added.cid}`;
        return fileUrl;  
    } catch (error) {
        console.error('Failed to upload and pin to IPFS:', error);
        throw error;
    }
}
