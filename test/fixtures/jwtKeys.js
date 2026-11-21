import { generateKeyPairSync } from 'node:crypto';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

export const jwtPublicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
export const jwtPrivateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
