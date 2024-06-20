import { create } from 'ipfs-http-client';

const auth = 'Basic ' + Buffer.from('641feefe9682428ab1e3c5bcabee9ad8'+ ':' + '48045231002c4b158ae4d2d908c1730d' ).toString('base64');
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
        const fileUrl = `https://jmakwana101.infura-ipfs.io/ipfs/${added.cid}`;
        return fileUrl;  
    } catch (error) {
        console.error('Failed to upload and pin to IPFS:', error);
        throw error;
    }
}
