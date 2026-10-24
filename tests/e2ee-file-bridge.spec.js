const { test, expect } = require('@playwright/test');
const { webcrypto } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { readFile } = require('node:fs/promises');
const { createServer } = require('node:http');

const helper = readFileSync(require.resolve('../static/portfolio/js/apps/sync-e2ee-files.js'));
const worker = readFileSync(require.resolve('../static/portfolio/sync-e2ee-worker.js'));
const clear = Buffer.from('Private notes: 端到端加密附件，只在本机解密。');
let site;
let api;
let origin;
let apiBase;
let metadata;
let encrypted;

test.beforeAll(async () => {
    const key = webcrypto.getRandomValues(new Uint8Array(32));
    const noncePrefix = webcrypto.getRandomValues(new Uint8Array(8));
    metadata = {
        key: Buffer.from(key).toString('base64url'), noncePrefix: Buffer.from(noncePrefix).toString('base64url'),
        fileId: '6da382f8-4c1d-4821-b08a-9effa8d5b58b', name: '机密笔记.txt', type: 'text/plain', size: clear.length
    };
    const nonce = new Uint8Array(12);
    nonce.set(noncePrefix);
    const cryptoKey = await webcrypto.subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt']);
    encrypted = Buffer.from(await webcrypto.subtle.encrypt({
        name: 'AES-GCM', iv: nonce,
        additionalData: new TextEncoder().encode(`gavin-sync-file-v1:${metadata.fileId}:0`)
    }, cryptoKey, clear));
    api = createServer((request, response) => {
        const headers = { 'Access-Control-Allow-Origin': origin, 'Access-Control-Expose-Headers': 'Content-Range, Content-Length' };
        const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range || '');
        if (request.url !== '/v1/spaces/room/downloads/ticket' || !range) { response.writeHead(404, headers); response.end(); return; }
        const start = Number(range[1]);
        const end = Number(range[2]);
        const body = encrypted.subarray(start, end + 1);
        response.writeHead(206, { ...headers, 'Content-Type': 'application/octet-stream', 'Content-Range': `bytes ${start}-${end}/${encrypted.length}`, 'Content-Length': body.length });
        response.end(body);
    });
    await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
    apiBase = `http://127.0.0.1:${api.address().port}`;
    site = createServer((request, response) => {
        if (request.url === '/portfolio/sync-e2ee-worker.js') { response.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-store' }); response.end(worker); }
        else if (request.url === '/portfolio/client.js') { response.writeHead(200, { 'Content-Type': 'application/javascript' }); response.end(helper); }
        else if (request.url === '/portfolio/sync-config.json') { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ apiBase })); }
        else if (request.url === '/portfolio/client.html') { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('<script type="module">import {openEncryptedFile} from "./client.js"; window.openEncryptedFile = openEncryptedFile;</script>'); }
        else if (request.url === '/shell') { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('<iframe src="/portfolio/client.html"></iframe>'); }
        else { response.writeHead(404); response.end(); }
    });
    await new Promise(resolve => site.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${site.address().port}`;
});
test.afterAll(async () => {
    for (const server of [site, api]) if (server) {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    }
});

test('streams decrypted ranges and native downloads inside the immersive iframe', async ({ page, context }) => {
    await page.goto(`${origin}/shell`);
    const frame = page.frames().find(frame => frame.url() === `${origin}/portfolio/client.html`);
    await frame.waitForFunction(() => typeof window.openEncryptedFile === 'function');
    const url = await frame.evaluate(async ({ apiBase, metadata }) => {
        window.capability = await window.openEncryptedFile({ url: `${apiBase}/v1/spaces/room/downloads/ticket`, metadata });
        return window.capability.url;
    }, { apiBase, metadata });
    const result = await frame.evaluate(async url => {
        const head = await fetch(url, { method: 'HEAD' });
        const response = await fetch(url, { headers: { Range: 'bytes=3-15' } });
        return { length: head.headers.get('Content-Length'), status: response.status, bytes: Array.from(new Uint8Array(await response.arrayBuffer())) };
    }, url);
    expect(result.length).toBe(String(clear.length));
    expect(result.status).toBe(206);
    expect(Buffer.from(result.bytes)).toEqual(clear.subarray(3, 16));
    const other = await context.newPage();
    await other.goto(`${origin}/portfolio/client.html`);
    expect(await other.evaluate(async url => (await fetch(url)).status, url)).toBe(404);
    await other.close();
    const downloading = page.waitForEvent('download');
    await frame.evaluate(async ({ apiBase, metadata }) => {
        const capability = await window.openEncryptedFile({ url: `${apiBase}/v1/spaces/room/downloads/ticket`, metadata, download: true });
        window.downloadCapability = capability;
        const iframe = document.createElement('iframe');
        iframe.src = capability.url;
        document.body.append(iframe);
    }, { apiBase, metadata });
    const download = await downloading;
    expect(download.suggestedFilename()).toBe(metadata.name);
    expect(await readFile(await download.path())).toEqual(clear);
    expect(await frame.evaluate(async () => (await fetch(window.downloadCapability.url)).status)).toBe(404);
    expect(await frame.evaluate(async () => {
        window.capability.dispose();
        return (await fetch(window.capability.url)).status;
    })).toBe(404);
});
