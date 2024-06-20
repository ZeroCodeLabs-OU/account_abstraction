import admin from 'firebase-admin';
import dotenv from 'dotenv';

dotenv.config();

const {
    FIREBASE_PROJECT_ID,
    FIREBASE_PRIVATE_KEY,
    FIREBASE_CLIENT_EMAIL,
    FIREBASE_STORAGE_BUCKET_URL
} = process.env;

const serviceAccount = {
    projectId: FIREBASE_PROJECT_ID,
    privateKey: FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),  
    clientEmail: FIREBASE_CLIENT_EMAIL
};

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    storageBucket: FIREBASE_STORAGE_BUCKET_URL
});

const bucket = admin.storage().bucket();

export { bucket };
