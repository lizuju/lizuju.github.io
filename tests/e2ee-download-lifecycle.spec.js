const { test, expect } = require('@playwright/test');
const { createCipheriv, randomBytes } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { readFile } = require('node:fs/promises');
const { createServer } = require('node:http');

const helper = readFileSync(require.resolve('../static/portfolio/js/apps/sync-e2ee-files.js'), 'utf8');
const worker = readFileSync(require.resolve('../static/portfolio/sync-e2ee-worker.js'), 'utf8');
const clearChunk = 8 * 1024 * 1024 - 16;
const clear = Buffer.alloc(clearChunk + 32768, 7);
const metadata = {
    key: randomBytes(32).toString('base64url'), noncePrefix: randomBytes(8).toString('base64url'),
    fileId: '6da382f8-4c1d-4821-b08a-9effa8d5b58b', name: 'private-download.bin', type: 'application/octet-stream', size: clear.length
};
const encrypted = Buffer.concat([0, 1].map(index => {
    const nonce = Buffer.concat([Buffer.from(metadata.noncePrefix, 'base64url'), Buffer.alloc(4)]);
    nonce.writeUInt32BE(index, 8);
    const cipher = createCipheriv('aes-256-gcm', Buffer.from(metadata.key, 'base64url'), nonce);
    cipher.setAAD(Buffer.from(`gavin-sync-file-v1:${metadata.fileId}:${index}`));
    return Buffer.concat([cipher.update(clear.subarray(index * clearChunk, (index + 1) * clearChunk)), cipher.final(), cipher.getAuthTag()]);
}));
let site;
let api;
let origin;
let apiBase;
let requests;
let failSecond;
let holdFirst;
let holdSecond;
let heldResponses = [];
let shortExpiry;
let workerRevision = 0;
let faults;
let requestLog;

test.beforeAll(async () => {
    api = createServer((request, response) => {
        const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Retry-After' };
        const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range || '');
        if (!range) { response.writeHead(404, headers); response.end(); return; }
        const start = Number(range[1]);
        const end = Number(range[2]);
        requests++;
        requestLog.push({ range: request.headers.range, time: Date.now() });
        if (holdFirst && start === 0) { heldResponses.push(response); return; }
        if (failSecond && start > 0) { response.writeHead(503, headers); response.end(); return; }
        if (holdSecond && start > 0) { heldResponses.push(response); return; }
        const fault = faults.shift();
        if (fault?.status) {
            response.writeHead(fault.status, { ...headers, ...(fault.retryAfter ? { 'Retry-After': fault.retryAfter } : {}) });
            response.end(); return;
        }
        let body = encrypted.subarray(start, end + 1);
        if (fault?.tamper) { body = Buffer.from(body); body[body.length - 1] ^= 1; }
        response.writeHead(206, { ...headers, 'Content-Type': 'application/octet-stream',
            'Content-Range': `bytes ${start + (fault?.badRange ? 1 : 0)}-${end}/${encrypted.length}`,
            ...(!fault?.truncate ? { 'Content-Length': body.length } : {}) });
        if (fault?.truncate) body = body.subarray(0, Math.floor(body.length / 2));
        response.end(body);
    });
    await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
    apiBase = `http://127.0.0.1:${api.address().port}`;
    site = createServer((request, response) => {
        const source = text => shortExpiry ? text.replace('DOWNLOAD_IDLE_MS = 60000;', 'DOWNLOAD_IDLE_MS = 300;') : text;
        if (request.url === '/portfolio/sync-e2ee-worker.js') {
            response.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-store' });
            response.end(`${source(worker)}\n// ${workerRevision}`);
        } else if (request.url === '/portfolio/client.js') {
            response.writeHead(200, { 'Content-Type': 'application/javascript' }); response.end(source(helper));
        } else if (request.url === '/portfolio/sync-config.json') {
            response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ apiBase }));
        } else if (request.url === '/portfolio/client.html') {
            response.writeHead(200, { 'Content-Type': 'text/html' });
            response.end('<script type="module">import {openEncryptedFile} from "./client.js"; window.openEncryptedFile = openEncryptedFile;</script>');
        } else { response.writeHead(404); response.end(); }
    });
    await new Promise(resolve => site.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${site.address().port}`;
});

test.beforeEach(() => { requests = 0; failSecond = false; holdFirst = false; holdSecond = false; shortExpiry = false; faults = []; requestLog = []; });
test.afterEach(() => { heldResponses.forEach(response => response.destroy()); heldResponses = []; });
test.afterAll(async () => {
    for (const server of [site, api]) {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    }
});

const open = async (page, download = true) => {
    await page.goto(`${origin}/portfolio/client.html`);
    await page.waitForFunction(() => typeof window.openEncryptedFile === 'function');
    return page.evaluate(async ({ apiBase, metadata, download }) => {
        window.capability = await window.openEncryptedFile({ url: `${apiBase}/v1/spaces/room/downloads/ticket`, metadata, download });
        window.result = null;
        window.capabilityClosed = false;
        window.capability.result.then(result => { window.result = result; });
        window.capability.closed.then(() => { window.capabilityClosed = true; });
        return window.capability.url;
    }, { apiBase, metadata, download });
};

test('normal native download reports stream delivery and releases its capability', async ({ page }) => {
    await open(page);
    const downloading = page.waitForEvent('download');
    await page.evaluate(() => {
        const iframe = document.createElement('iframe');
        iframe.src = window.capability.url;
        document.body.append(iframe);
    });
    const download = await downloading;
    expect(await readFile(await download.path())).toEqual(clear);
    await expect.poll(() => page.evaluate(() => ({ result: window.result, closed: window.capabilityClosed })))
        .toEqual({ result: { status: 'delivered' }, closed: true });
    expect(await page.evaluate(async () => (await fetch(window.capability.url)).status)).toBe(404);
    expect(requests).toBe(2);
});

test('a second encrypted chunk failure retains authenticated cache and permits range resume', async ({ page }) => {
    failSecond = true;
    await open(page);
    const downloading = page.waitForEvent('download');
    await page.evaluate(() => {
        const iframe = document.createElement('iframe');
        iframe.src = window.capability.url;
        document.body.append(iframe);
    });
    const download = await downloading;
    expect(await download.failure()).toBeTruthy();
    await expect.poll(() => page.evaluate(() => window.result)).toEqual({ status: 'failed' });
    expect(await page.evaluate(() => window.capabilityClosed)).toBe(false);
    expect(requests).toBe(4);
    const first = await page.evaluate(async () => {
        const response = await fetch(window.capability.url, { headers: { Range: 'bytes=0-0' } });
        return { status: response.status, bytes: [...new Uint8Array(await response.arrayBuffer())] };
    });
    expect(first).toEqual({ status: 206, bytes: [7] });
    expect(requests).toBe(4);
    failSecond = false;
    const resumed = await page.evaluate(async start => {
        const response = await fetch(window.capability.url, { headers: { Range: `bytes=${start}-` } });
        return { status: response.status, bytes: [...new Uint8Array(await response.arrayBuffer())] };
    }, clearChunk);
    expect(resumed.status).toBe(206);
    expect(Buffer.from(resumed.bytes)).toEqual(clear.subarray(clearChunk));
    expect(requests).toBe(5);
    expect(await page.evaluate(() => window.result)).toEqual({ status: 'failed' });
    await page.evaluate(() => window.capability.dispose());
});

test('cancelling a streamed download reuses authenticated chunks within the bounded resume window', async ({ page }) => {
    holdSecond = true;
    await open(page);
    await page.evaluate(async () => {
        const response = await fetch(window.capability.url);
        const reader = response.body.getReader();
        await reader.read();
        await reader.cancel();
    });
    await expect.poll(() => page.evaluate(() => window.result)).toEqual({ status: 'cancelled' });
    expect(await page.evaluate(() => window.capabilityClosed)).toBe(false);
    const before = requests;
    expect(await page.evaluate(async () => {
        const response = await fetch(window.capability.url, { headers: { Range: 'bytes=0-0' } });
        return [...new Uint8Array(await response.arrayBuffer())];
    })).toEqual([7]);
    expect(requests).toBe(before);
    await page.evaluate(() => window.capability.dispose());
    expect(await page.evaluate(async () => (await fetch(window.capability.url)).status)).toBe(404);
});

test('cancelling a native download reports cancellation before the final chunk arrives', async ({ page }) => {
    holdSecond = true;
    await open(page);
    const downloading = page.waitForEvent('download');
    await page.evaluate(() => {
        const iframe = document.createElement('iframe');
        iframe.src = window.capability.url;
        document.body.append(iframe);
    });
    const download = await downloading;
    await download.cancel();
    await expect.poll(() => page.evaluate(() => window.result)).toEqual({ status: 'cancelled' });
    expect(await page.evaluate(() => window.capabilityClosed)).toBe(false);
    await page.evaluate(() => window.capability.dispose());
});

test('aborting a download request while its first upstream chunk is pending reports cancellation', async ({ page }) => {
    holdFirst = true;
    await open(page);
    await page.evaluate(() => {
        window.downloadController = new AbortController();
        window.pendingRead = fetch(window.capability.url, { signal: window.downloadController.signal })
            .then(response => response.arrayBuffer()).catch(error => error.name);
    });
    await expect.poll(() => requests).toBe(1);
    await page.evaluate(() => window.downloadController.abort());
    await expect.poll(() => page.evaluate(() => window.result)).toEqual({ status: 'cancelled' });
    expect(await page.evaluate(() => window.pendingRead)).toBe('AbortError');
    expect(await page.evaluate(() => window.capabilityClosed)).toBe(false);
    await page.evaluate(() => window.capability.dispose());
});

test('an interrupted download expires and cannot recover from its owner after a worker restart', async ({ page }) => {
    shortExpiry = true;
    failSecond = true;
    const url = await open(page);
    await page.evaluate(async () => {
        try { await (await fetch(window.capability.url)).arrayBuffer(); } catch {}
    });
    await expect.poll(() => page.evaluate(() => window.result)).toEqual({ status: 'failed' });
    await expect.poll(() => page.evaluate(() => window.capabilityClosed)).toBe(true);
    expect(await page.evaluate(async url => (await fetch(url)).status, url)).toBe(404);
    workerRevision++;
    await page.evaluate(async () => {
        const changed = new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
        await (await navigator.serviceWorker.getRegistration()).update();
        await changed;
    });
    expect(await page.evaluate(async url => (await fetch(url)).status, url)).toBe(404);
});

test('media preview ranges retain cache and remain usable after a cancelled read', async ({ page }) => {
    holdSecond = true;
    await open(page, false);
    const ranges = await page.evaluate(async () => {
        const result = [];
        for (const range of ['bytes=0-0', 'bytes=31-33']) {
            const response = await fetch(window.capability.url, { headers: { Range: range } });
            result.push({ status: response.status, bytes: [...new Uint8Array(await response.arrayBuffer())] });
        }
        return result;
    });
    expect(ranges).toEqual([{ status: 206, bytes: [7] }, { status: 206, bytes: [7, 7, 7] }]);
    expect(requests).toBe(1);
    await page.evaluate(async () => {
        const reader = (await fetch(window.capability.url)).body.getReader();
        await reader.read();
        await reader.cancel();
    });
    const afterCancel = requests;
    expect(await page.evaluate(() => ({ result: window.result, closed: window.capabilityClosed }))).toEqual({ result: null, closed: false });
    expect(await page.evaluate(async () => {
        const response = await fetch(window.capability.url, { headers: { Range: 'bytes=17-17' } });
        return [...new Uint8Array(await response.arrayBuffer())];
    })).toEqual([7]);
    expect(requests).toBe(afterCancel);
    await page.evaluate(() => window.capability.dispose());
    expect(await page.evaluate(() => window.result)).toEqual({ status: 'disposed' });
});

test('preview metadata can read the file head, tail and head again without downloading the head twice', async ({ page }) => {
    await open(page, false);
    const ranges = await page.evaluate(async tail => {
        const result = [];
        for (const range of ['bytes=0-31', `bytes=${tail}-`, 'bytes=16-47']) {
            const response = await fetch(window.capability.url, { headers: { Range: range } });
            result.push([...new Uint8Array(await response.arrayBuffer())]);
        }
        return result;
    }, clear.length - 32);
    expect(ranges).toEqual(Array.from({ length: 3 }, () => Array(32).fill(7)));
    expect(requestLog.map(request => request.range)).toEqual([
        `bytes=0-${clearChunk + 15}`, `bytes=${clearChunk + 16}-${encrypted.length - 1}`
    ]);
    await page.evaluate(() => window.capability.dispose());
});

test('native downloads wait for Retry-After and recover from transient upstream errors', async ({ page }) => {
    faults = [{ status: 429, retryAfter: '1' }, { status: 503 }];
    await open(page);
    const downloading = page.waitForEvent('download');
    await page.evaluate(() => {
        const iframe = document.createElement('iframe');
        iframe.src = window.capability.url;
        document.body.append(iframe);
    });
    const download = await downloading;
    expect(await readFile(await download.path())).toEqual(clear);
    expect(requests).toBe(4);
    expect(requestLog[1].time - requestLog[0].time).toBeGreaterThanOrEqual(950);
    expect(requestLog[2].time - requestLog[1].time).toBeGreaterThanOrEqual(950);
    await expect.poll(() => page.evaluate(() => window.result)).toEqual({ status: 'delivered' });
});

test('a truncated second chunk retries before releasing any unauthenticated bytes', async ({ page }) => {
    faults = [null, { truncate: true }];
    await open(page);
    const result = await page.evaluate(async () => {
        const response = await fetch(window.capability.url);
        const bytes = new Uint8Array(await response.arrayBuffer());
        return { length: bytes.length, correct: bytes.every(value => value === 7) };
    });
    expect(result).toEqual({ length: clear.length, correct: true });
    expect(requests).toBe(3);
    expect(requestLog[1].range).toBe(requestLog[2].range);
    await expect.poll(() => page.evaluate(() => window.result)).toEqual({ status: 'delivered' });
});

test('closing a capability cancels Retry-After without a later upstream request', async ({ page }) => {
    faults = [{ status: 429, retryAfter: '2' }];
    await open(page, false);
    await page.evaluate(() => {
        window.pendingRead = fetch(window.capability.url).then(response => response.arrayBuffer()).then(() => 'unexpected success', () => 'cancelled');
    });
    await expect.poll(() => requests).toBe(1);
    await page.evaluate(() => window.capability.dispose());
    expect(await page.evaluate(() => window.pendingRead)).toBe('cancelled');
    await page.waitForTimeout(2100);
    expect(requests).toBe(1);
});

for (const [name, fault] of [['revoked authorization', { status: 403 }], ['incorrect range', { badRange: true }], ['invalid authentication tag', { tamper: true }]]) {
    test(`rejects ${name} without retrying or releasing plaintext`, async ({ page }) => {
        faults = [fault];
        await open(page, false);
        expect(await page.evaluate(async () => {
            const response = await fetch(window.capability.url);
            try { await response.body.getReader().read(); return 'plaintext'; }
            catch { return 'rejected'; }
        })).toBe('rejected');
        expect(requests).toBe(1);
        await page.evaluate(() => window.capability.dispose());
    });
}

test('rejects ticket renewal into a different space before making another upstream request', async ({ page }) => {
    faults = [{ status: 404 }];
    await page.goto(`${origin}/portfolio/client.html`);
    await page.waitForFunction(() => typeof window.openEncryptedFile === 'function');
    const result = await page.evaluate(async ({ apiBase, metadata }) => {
        let renewals = 0;
        const capability = await window.openEncryptedFile({
            url: `${apiBase}/v1/spaces/room/downloads/${'a'.repeat(64)}`, metadata,
            refresh: async () => { renewals++; return `${apiBase}/v1/spaces/another-room/downloads/${'b'.repeat(64)}`; }
        });
        try {
            const response = await fetch(capability.url);
            await response.arrayBuffer();
            return { rejected: false, renewals };
        } catch { return { rejected: true, renewals }; }
        finally { capability.dispose(); }
    }, { apiBase, metadata });
    expect(result).toEqual({ rejected: true, renewals: 1 });
    expect(requests).toBe(1);
});
