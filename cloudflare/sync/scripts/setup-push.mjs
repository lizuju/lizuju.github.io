import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { getPushPublicKey } from '../src/web-push.js';

const subject = process.argv[2] || 'https://lizuju.github.io/chat/';
const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const privateKey = await crypto.subtle.exportKey('jwk', pair.privateKey);
const publicKey = Buffer.from(await crypto.subtle.exportKey('raw', pair.publicKey)).toString('base64url');
const secrets = { PUSH_VAPID_PUBLIC_KEY: publicKey, PUSH_VAPID_PRIVATE_KEY: privateKey.d, PUSH_VAPID_SUBJECT: subject };
if (!getPushPublicKey(secrets)) throw new Error('Use a valid mailto: or https: VAPID subject');
const directory = new URL('../../../output/', import.meta.url);
const file = new URL('web-push-secrets.json', directory);
await mkdir(directory, { recursive: true });
await writeFile(file, `${JSON.stringify(secrets, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
console.log(`Web Push keys saved to ${fileURLToPath(file)}. No cloud configuration was changed.`);
