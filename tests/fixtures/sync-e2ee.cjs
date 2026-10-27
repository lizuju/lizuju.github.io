const { createCipheriv, generateKeyPairSync, randomBytes } = require('node:crypto');
const { test: base, expect } = require('@playwright/test');
const { apiBase: productionApiBase } = require('../../static/portfolio/sync-config.json');

async function allowSyncOrigin(page, origin) {
    if (page.context().browser().browserType().name() === 'chromium') {
        await page.context().grantPermissions(['local-network-access']);
    }
    await page.route('**/portfolio/', async route => {
        const response = await route.fetch();
        const html = (await response.text())
            .replaceAll(productionApiBase, origin)
            .replaceAll(productionApiBase.replace(/^http/, 'ws'), origin.replace(/^http/, 'ws'));
        await route.fulfill({ response, body: html });
    });
}

const test = base.extend({
    page: async ({ page }, use) => {
        await allowSyncOrigin(page, 'https://sync.test');
        await use(page);
    },
});

const roomId = 'c5745baa-931f-4c83-9545-360fa055b57c';
const deviceId = '5fb30917-af43-4394-8034-0c326c774b78';
const otherId = 'ddda513e-dcf9-473b-ac0d-83503ac81318';
const token = 'a'.repeat(64);
const keyId = 'd1ec4662-cc5e-45a4-b357-1ab64fec8449';
const key = randomBytes(32);
const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const publicJwk = pair.publicKey.export({ format: 'jwk' });
const publicKey = Buffer.concat([Buffer.from([4]), Buffer.from(publicJwk.x, 'base64url'), Buffer.from(publicJwk.y, 'base64url')]).toString('base64url');
const session = {
    roomId, deviceId, token, keyring: { version: 1, currentKeyId: keyId, keys: { [keyId]: key.toString('base64url') } },
    identity: { privateKey: pair.privateKey.export({ format: 'jwk' }), publicKey },
    trustedDevices: { [deviceId]: publicKey, [otherId]: publicKey }, revokedDevices: []
};
const seal = (key, aad, value) => {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(aad));
    return { iv: iv.toString('base64url'), ciphertext: Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final(), cipher.getAuthTag()]).toString('base64url') };
};
const encrypt = (purpose, value) => `e2ee1.${Buffer.from(JSON.stringify({ keyId, ...seal(key, `gavin-sync-v1:${roomId}:${purpose}`, value) })).toString('base64url')}`;
const message = (id, text = `Message ${id}`, sender = deviceId, attachment = null, clientId = `message-${id}`) => ({
    id, clientId, deviceId: sender, text: encrypt(`message:${sender}:${clientId}`, { text, attachment }), createdAt: Date.now()
});
const profile = (name = 'Mac', id = deviceId) => ({ deviceId: id, name: encrypt(`device:${id}`, { name, publicKey }), createdAt: Date.now() });
const file = (name, type, bytes) => {
    const metadata = { fileId: '2999e297-4ea2-412f-bb30-2c27b3613321', key: randomBytes(32).toString('base64url'), noncePrefix: randomBytes(8).toString('base64url'), name, type, size: bytes.length };
    const nonce = Buffer.concat([Buffer.from(metadata.noncePrefix, 'base64url'), Buffer.alloc(4)]);
    const cipher = createCipheriv('aes-256-gcm', Buffer.from(metadata.key, 'base64url'), nonce);
    cipher.setAAD(Buffer.from(`gavin-sync-file-v1:${metadata.fileId}:0`));
    return { metadata, bytes: Buffer.concat([cipher.update(bytes), cipher.final(), cipher.getAuthTag()]) };
};
const authorize = async (page, url = '/portfolio/') => {
    await page.goto(url);
    await page.evaluate(async session => {
        const vaultId = crypto.randomUUID();
        const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(`gavin-sync-vault-v1:${vaultId}`) }, key, new TextEncoder().encode(JSON.stringify({ ...session, vaultId })));
        const encode = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
        const database = await new Promise((resolve, reject) => {
            const request = indexedDB.open('gavin-sync-key-vault', 1);
            request.onupgradeneeded = () => request.result.createObjectStore('sessions', { keyPath: 'id' });
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        await new Promise((resolve, reject) => {
            const transaction = database.transaction('sessions', 'readwrite');
            transaction.objectStore('sessions').put({ id: vaultId, key, encrypted: { iv: encode(iv), ciphertext: encode(ciphertext) } });
            transaction.oncomplete = resolve;
            transaction.onerror = () => reject(transaction.error);
        });
        database.close();
        localStorage.setItem('portfolio-sync-space-e2ee1', JSON.stringify({ roomId: session.roomId, token: session.token, deviceId: session.deviceId, vaultId }));
    }, session);
};
const startSite = async (apiBase, beforeServe = () => {}) => {
    const { createServer } = require('node:http');
    const { readFile } = require('node:fs/promises');
    const path = require('node:path');
    const docs = path.resolve(__dirname, '../../docs');
    const server = createServer(async (request, response) => {
        try {
            const pathname = new URL(request.url, 'http://localhost').pathname;
            await beforeServe(pathname);
            if (['/portfolio/sync-config.json', '/chat/sync-config.json'].includes(pathname)) {
                response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ apiBase })); return;
            }
            if (pathname === '/shell') {
                response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('<iframe id="computer-screen" src="/portfolio/" style="width:1280px;height:720px;border:0"></iframe>'); return;
            }
            const file = path.resolve(docs, `.${decodeURIComponent(pathname)}`, pathname.endsWith('/') ? 'index.html' : '');
            if (!file.startsWith(docs + path.sep)) throw new Error('not_found');
            let content = await readFile(file);
            if (file.endsWith('.html')) content = Buffer.from(content.toString()
                .replaceAll(productionApiBase, apiBase)
                .replaceAll(productionApiBase.replace(/^http/, 'ws'), apiBase.replace(/^http/, 'ws')));
            const types = { '.html': 'text/html', '.js': 'application/javascript', '.mjs': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.webp': 'image/webp', '.png': 'image/png', '.svg': 'image/svg+xml' };
            response.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); response.end(content);
        } catch { response.writeHead(404); response.end(); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return { origin: `http://127.0.0.1:${server.address().port}`, close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
};
module.exports = { test, expect, allowSyncOrigin, roomId, deviceId, otherId, token, keyId, session, encrypt, message, profile, file, authorize, startSite };
