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
let servedWorker = worker;
let metadata;
let encrypted;
let media;
let mediaEncrypted;
const mediaClear = Buffer.alloc(1024 * 1024 + 31, 37);
const mediaRanges = [];

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
    const c = await import(`data:text/javascript;base64,${readFileSync(require.resolve('../static/portfolio/js/apps/sync-crypto.js')).toString('base64')}`);
    media = c.createFileMetadata({ name: 'video.mp4', type: 'video/mp4', size: mediaClear.length });
    mediaEncrypted = Buffer.from(await c.encryptUploadChunk(media, 0, mediaClear));
    api = createServer((request, response) => {
        const headers = { 'Access-Control-Allow-Origin': origin, 'Access-Control-Expose-Headers': 'Content-Range, Content-Length' };
        const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range || '');
        if (!['/v1/spaces/room/downloads/ticket', '/v1/spaces/room/downloads/media'].includes(request.url) || !range) { response.writeHead(404, headers); response.end(); return; }
        const start = Number(range[1]);
        const end = Number(range[2]);
        const wire = request.url.endsWith('/media') ? mediaEncrypted : encrypted;
        if (request.url.endsWith('/media')) mediaRanges.push([start, end]);
        const body = wire.subarray(start, end + 1);
        response.writeHead(206, { ...headers, 'Content-Type': 'application/octet-stream', 'Content-Range': `bytes ${start}-${end}/${wire.length}`, 'Content-Length': body.length });
        response.end(body);
    });
    await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
    apiBase = `http://127.0.0.1:${api.address().port}`;
    site = createServer((request, response) => {
        if (request.url === '/sync-e2ee-worker.js') { response.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-store' }); response.end(servedWorker); }
        else if (/^\/(portfolio|chat)\/sync-e2ee-worker.js$/.test(request.url)) {
            response.writeHead(200, { 'Content-Type': 'application/javascript' });
            response.end("self.addEventListener('install', () => self.skipWaiting()); self.addEventListener('activate', event => event.waitUntil(self.clients.claim())); self.addEventListener('fetch', event => { if (new URL(event.request.url).pathname.endsWith('/__legacy-preview__')) event.respondWith(new Response('legacy preview')); });");
        }
        else if (/^\/(portfolio|chat)\/client.js$/.test(request.url)) { response.writeHead(200, { 'Content-Type': 'application/javascript' }); response.end(helper); }
        else if (request.url === '/portfolio/sync-config.json') { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ apiBase })); }
        else if (request.url === '/chat/index.html?legacy=1') { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('<!doctype html><title>Old preview page</title>'); }
        else if (/^\/(portfolio|chat)\/index.html$/.test(request.url)) { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('<script type="module">import {openEncryptedFile, prepareEncryptedFiles} from "./client.js"; window.openEncryptedFile = openEncryptedFile; window.prepareEncryptedFiles = prepareEncryptedFiles;</script>'); }
        else if (request.url === '/shell') { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('<iframe src="/portfolio/index.html"></iframe>'); }
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
    const frame = page.frames().find(frame => frame.url() === `${origin}/portfolio/index.html`);
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
    await other.goto(`${origin}/portfolio/index.html`);
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


test('previews new media with one small authenticated block and downloads every block in a browser', async ({ page }) => {
    mediaRanges.length = 0;
    await page.goto(`${origin}/portfolio/index.html`);
    await page.waitForFunction(() => typeof window.openEncryptedFile === 'function');
    const result = await page.evaluate(async ({ apiBase, metadata }) => {
        window.mediaCapability = await window.openEncryptedFile({ url: `${apiBase}/v1/spaces/room/downloads/media`, metadata });
        const response = await fetch(window.mediaCapability.url, { headers: { Range: 'bytes=0-1' } });
        return Array.from(new Uint8Array(await response.arrayBuffer()));
    }, { apiBase, metadata: media });
    expect(result).toEqual([37, 37]);
    expect(mediaRanges).toEqual([[0, 512 * 1024 - 1]]);
    mediaRanges.length = 0;
    const downloading = page.waitForEvent('download');
    await page.evaluate(async ({ apiBase, metadata }) => {
        window.mediaCapability.dispose();
        const capability = await window.openEncryptedFile({ url: `${apiBase}/v1/spaces/room/downloads/media`, metadata, download: true });
        const iframe = document.createElement('iframe');
        iframe.src = capability.url;
        document.body.append(iframe);
    }, { apiBase, metadata: media });
    const download = await downloading;
    expect((await readFile(await download.path())).equals(mediaClear)).toBe(true);
    expect(mediaRanges).toEqual([[0, mediaEncrypted.length - 1]]);
});


test('a stalled registration times out and recovers without duplicate registrations', async ({ page }) => {
    await page.goto(`${origin}/portfolio/index.html`);
    await page.waitForFunction(() => typeof window.prepareEncryptedFiles === 'function');
    await page.clock.install();
    await page.evaluate(() => {
        const register = navigator.serviceWorker.register.bind(navigator.serviceWorker);
        window.registrations = 0;
        navigator.serviceWorker.register = async (...args) => {
            window.registrations++;
            await new Promise(resolve => { window.releaseRegistration = resolve; });
            return register(...args);
        };
        window.preparing = window.prepareEncryptedFiles().catch(error => error.message);
    });
    await page.waitForFunction(() => !!window.releaseRegistration);
    await page.clock.runFor(15001);
    expect(await page.evaluate(() => window.preparing)).toBe('encrypted_file_unavailable');
    await page.evaluate(() => {
        window.recovered = window.prepareEncryptedFiles().then(worker => worker.scriptURL);
        window.releaseRegistration();
    });
    expect(await page.evaluate(() => window.recovered)).toBe(`${origin}/sync-e2ee-worker.js`);
    expect(await page.evaluate(() => window.registrations)).toBe(1);
});

test('waits for an updated worker before opening a new attachment format', async ({ page }) => {
    servedWorker = Buffer.from(`
        self.addEventListener('install', () => self.skipWaiting());
        self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
        self.addEventListener('message', event => event.ports[0]?.postMessage({ error: 'old_worker' }));
    `);
    try {
        await page.goto(`${origin}/portfolio/index.html`);
        await page.waitForFunction(() => typeof window.openEncryptedFile === 'function');
        await page.evaluate(async () => {
            await navigator.serviceWorker.register('/sync-e2ee-worker.js', { scope: '/', updateViaCache: 'none' });
            await navigator.serviceWorker.ready;
            if (!navigator.serviceWorker.controller) await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
        });
        servedWorker = Buffer.concat([worker, Buffer.from("\nself.addEventListener('install', event => event.waitUntil(new Promise(resolve => setTimeout(resolve, 300))));")]);
        const result = await page.evaluate(async ({ apiBase, metadata }) => {
            const capability = await window.openEncryptedFile({ url: `${apiBase}/v1/spaces/room/downloads/media`, metadata });
            const response = await fetch(capability.url, { headers: { Range: 'bytes=0-1' } });
            const bytes = Array.from(new Uint8Array(await response.arrayBuffer()));
            capability.dispose();
            return bytes;
        }, { apiBase, metadata: media });
        expect(result).toEqual([37, 37]);
    } finally { servedWorker = worker; }
});

test('migrates scoped workers on manual refresh without reloading unsaved page state', async ({ page, context }) => {
    const other = await context.newPage();
    const pages = [page, other];
    mediaRanges.length = 0;
    for (const [index, target] of pages.entries()) {
        const path = index ? 'chat' : 'portfolio';
        await target.goto(`${origin}/${path}/index.html`);
        await target.waitForFunction(() => typeof window.openEncryptedFile === 'function');
        await target.evaluate(async path => {
            await navigator.serviceWorker.register(`/${path}/sync-e2ee-worker.js`, { scope: `/${path}/` });
            await navigator.serviceWorker.ready;
            if (!navigator.serviceWorker.controller) await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
        }, path);
        expect(await target.evaluate(() => navigator.serviceWorker.controller.scriptURL)).toBe(`${origin}/${path}/sync-e2ee-worker.js`);
    }
    expect(await other.evaluate(async () => (await fetch('./__legacy-preview__')).text())).toBe('legacy preview');
    expect(await page.evaluate(async () => {
        window.unsaved = 'keep my draft';
        return window.prepareEncryptedFiles().catch(error => error.message);
    })).toBe('encrypted_file_reload_required');
    expect(await page.evaluate(() => window.unsaved)).toBe('keep my draft');
    expect(await other.evaluate(() => navigator.serviceWorker.controller.scriptURL)).toBe(`${origin}/chat/sync-e2ee-worker.js`);
    expect(await other.evaluate(async () => (await fetch('./__legacy-preview__')).text())).toBe('legacy preview');
    await page.reload();
    await other.reload();
    for (const target of pages) {
        await target.waitForFunction(() => navigator.serviceWorker.controller?.scriptURL === new URL('/sync-e2ee-worker.js', location.href).href
            && typeof window.openEncryptedFile === 'function');
        const bytes = await target.evaluate(async ({ apiBase, metadata }) => {
            window.mediaCapability = await window.openEncryptedFile({ url: `${apiBase}/v1/spaces/room/downloads/media`, metadata, cacheScope: 'room:device' });
            const response = await fetch(window.mediaCapability.url, { headers: { Range: 'bytes=0-1' } });
            return Array.from(new Uint8Array(await response.arrayBuffer()));
        }, { apiBase, metadata: media });
        expect(bytes).toEqual([37, 37]);
        expect(await target.evaluate(() => navigator.serviceWorker.controller.scriptURL)).toBe(`${origin}/sync-e2ee-worker.js`);
    }
    expect(mediaRanges).toEqual([[0, 512 * 1024 - 1]]);
    expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).map(item => item.scope))).toEqual([`${origin}/`]);
    await other.close();
});

test('an incompatible old page keeps its controller until the new page is manually refreshed', async ({ page, context }) => {
    const old = await context.newPage();
    await old.goto(`${origin}/chat/index.html?legacy=1`);
    await old.evaluate(async () => {
        await navigator.serviceWorker.register('/chat/sync-e2ee-worker.js', { scope: '/chat/' });
        await navigator.serviceWorker.ready;
        if (!navigator.serviceWorker.controller) await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
    });
    expect(await old.evaluate(async () => (await fetch('./__legacy-preview__')).text())).toBe('legacy preview');
    await page.goto(`${origin}/portfolio/index.html`);
    await page.waitForFunction(() => typeof window.prepareEncryptedFiles === 'function');
    expect(await page.evaluate(() => window.prepareEncryptedFiles().catch(error => error.message))).toBe('encrypted_file_reload_required');
    await page.reload();
    await page.waitForFunction(() => navigator.serviceWorker.controller?.scriptURL === new URL('/sync-e2ee-worker.js', location.href).href);
    expect(await old.evaluate(() => navigator.serviceWorker.controller.scriptURL)).toBe(`${origin}/chat/sync-e2ee-worker.js`);
    expect(await old.evaluate(async () => (await fetch('./__legacy-preview__')).text())).toBe('legacy preview');
    await old.close();
});
