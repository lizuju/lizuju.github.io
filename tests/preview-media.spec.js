const { test, expect } = require('./fixtures/sync-e2ee.cjs');
const { showSyncTools } = require('./fixtures/sync-tools.cjs');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { createServer } = require('node:http');
const { deviceId, keyId, authorize, message, file, profile, startSite } = require('./fixtures/sync-e2ee.cjs');

const heic = readFileSync(join(__dirname, 'fixtures/heic-gradient.heic'));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aC1kAAAAASUVORK5CYII=', 'base64');
const mp4 = readFileSync(join(__dirname, '../static/textures/monitor/video/static-texture-layer.mp4'));
let server;
let site;
let failDownloads;
let downloadAttempts;
let beforeServe;

test.beforeEach(async ({ page, isMobile }) => {
    test.skip(isMobile, 'attachment previews and device names are desktop windows');
    await page.addInitScript(() => {
        window.previewImageUrls = [];
        window.revokedPreviewImageUrls = [];
        const create = URL.createObjectURL.bind(URL);
        const revoke = URL.revokeObjectURL.bind(URL);
        URL.createObjectURL = (blob) => {
            const url = create(blob);
            if (blob.type.startsWith('image/')) window.previewImageUrls.push({ url, type: blob.type });
            return url;
        };
        URL.revokeObjectURL = (url) => {
            window.revokedPreviewImageUrls.push(url);
            return revoke(url);
        };
    });
    failDownloads = 0;
    downloadAttempts = 0;
    beforeServe = () => {};
    const attachments = [
        file('camera.HEIC', 'application/octet-stream', heic),
        file('pixel.png', 'application/octet-stream', png),
        file('capture.MP4', 'application/octet-stream', mp4),
        file('payload.bin', 'application/octet-stream', png),
        file('notes.txt', 'text/plain', Buffer.from('Preview retry text'))
    ];
    const devices = [profile('Mac')];
    const headers = {
        'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Sync-Key-Id, Range',
        'Access-Control-Allow-Methods': 'GET, HEAD, POST, PATCH, OPTIONS', 'Access-Control-Expose-Headers': 'Content-Range'
    };
    server = createServer(async (request, response) => {
        if (request.method === 'OPTIONS') { response.writeHead(204, headers); response.end(); return; }
        const path = new URL(request.url, 'http://localhost').pathname;
        if (request.method === 'PATCH') {
            const chunks = [];
            for await (const chunk of request) chunks.push(chunk);
            devices[0].name = JSON.parse(Buffer.concat(chunks).toString()).name;
            response.writeHead(200, { ...headers, 'Content-Type': 'application/json' }); response.end(JSON.stringify({ ok: true })); return;
        }
        if (path.endsWith('/key-grants')) {
            response.writeHead(200, { ...headers, 'Content-Type': 'application/json' }); response.end(JSON.stringify({ grants: [], hasMore: false, keyId })); return;
        }
        if (path.endsWith('/devices')) {
            response.writeHead(200, { ...headers, 'Content-Type': 'application/json' }); response.end(JSON.stringify({ deviceId, devices })); return;
        }
        if (path.endsWith('/download')) {
            response.writeHead(200, { ...headers, 'Content-Type': 'application/json' });
            response.end(JSON.stringify({ ticket: path.split('/').at(-2).padStart(64, '0'), expiresAt: Date.now() + 86400000 })); return;
        }
        if (request.method === 'GET' && path.includes('/downloads/')) {
            downloadAttempts++;
            if (failDownloads-- > 0) { response.writeHead(503, headers); response.end('Temporarily unavailable'); return; }
        }
        const encrypted = attachments[Number(path.split('/').at(-1)) - 1].bytes;
        const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range || '');
        const start = range ? Number(range[1]) : 0;
        const end = range ? Number(range[2]) : encrypted.length - 1;
        const body = encrypted.subarray(start, end + 1);
        response.writeHead(range ? 206 : 200, { ...headers, 'Content-Type': 'application/octet-stream', 'Content-Length': String(body.length),
            ...(range ? { 'Content-Range': `bytes ${start}-${end}/${encrypted.length}` } : {}) });
        response.end(request.method === 'HEAD' ? undefined : body);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    site = await startSite(`http://127.0.0.1:${server.address().port}`, pathname => beforeServe(pathname));
    await authorize(page, `${site.origin}/portfolio/`);
    await page.routeWebSocket(`ws://127.0.0.1:${server.address().port}/**`, socket => socket.onMessage(data => {
        if (data === 'ping') return socket.send('pong');
        if (JSON.parse(data).type === 'auth') socket.send(JSON.stringify({
            type: 'ready', deviceId, pairing: null,
            messages: attachments.map((attachment, index) => message(index + 1, '', deviceId, attachment.metadata))
        }));
    }));
    await page.goto(`${site.origin}/portfolio/`);
    await page.locator('[data-window-action="minimize"]').click();
    await page.locator('.desktop-shortcut[data-open-sync-space]').click();
    await expect(page.locator('[data-sync-status]')).toHaveAttribute('data-state', 'online');
    await expect(page.locator('[data-sync-preview-file]')).toHaveCount(4);
});

test.afterEach(async () => {
    if (site) { await site.close(); site = null; }
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); server = null; }
});

test('previews real HEIC locally, loads its decoder only when needed, and releases image URLs', async ({ page, context }) => {
    expect(await page.evaluate(() => performance.getEntriesByType('resource').filter(entry => /\/preview-heic\.[^/]+\.js$/.test(new URL(entry.name).pathname)).length)).toBe(0);
    const decoderRequests = [];
    page.on('request', request => {
        if (/\/preview-heic\.[^/]+\.js$/.test(new URL(request.url()).pathname)) decoderRequests.push(request.url());
    });
    const nativeSupported = await page.evaluate(async base64 => {
        const blob = new Blob([Uint8Array.from(atob(base64), c => c.charCodeAt(0))], { type: 'image/heic' });
        const image = new Image();
        const url = URL.createObjectURL(blob);
        image.src = url;
        try { await image.decode(); return true; }
        catch { return false; }
        finally { URL.revokeObjectURL(url); }
    }, heic.toString('base64'));
    expect(decoderRequests).toHaveLength(0);
    await page.locator('[data-sync-preview-file]').first().click();
    const preview = page.locator('[data-sync-preview-window]');
    const image = preview.locator('img');
    await expect(image).toHaveJSProperty('naturalWidth', 64);
    await expect(image).toHaveJSProperty('naturalHeight', 48);
    await expect(image).toHaveAttribute('src', /^blob:/);
    expect(decoderRequests).toHaveLength(nativeSupported ? 0 : 1);
    expect(context.pages()).toHaveLength(1);
    const originalWidth = await image.evaluate(element => element.getBoundingClientRect().width);
    await preview.locator('[data-preview-zoom-in]').click();
    await expect(preview.locator('[data-preview-zoom-value]')).toHaveText('125%');
    await expect.poll(() => image.evaluate(element => element.getBoundingClientRect().width)).toBeCloseTo(originalWidth * 1.25, 0);
    await preview.locator('[data-preview-zoom-fit]').click();
    await expect(preview.locator('[data-preview-zoom-value]')).toHaveText('100%');
    await preview.locator('[data-sync-preview-action="close"]').click();
    await expect(preview.locator('[data-sync-preview-body]')).toBeEmpty();
    await expect(page.locator('.sync-message-image img[alt="camera.HEIC"]')).toHaveJSProperty('naturalWidth', 64);
    await page.locator('[data-sync-action="close"]').click();
    expect(await page.evaluate(() => window.previewImageUrls.every(({ url }) => window.revokedPreviewImageUrls.includes(url)))).toBe(true);
});

test('closing during the HEIC decoder load cannot replace the next image or retain its blob URL', async ({ page }) => {
    await page.evaluate(() => {
        const decode = HTMLImageElement.prototype.decode;
        HTMLImageElement.prototype.decode = function () {
            if (!this.alt && !window.forcedHeicFailure) {
                window.forcedHeicFailure = true;
                return Promise.reject(new DOMException('HEIC native decoding unavailable', 'EncodingError'));
            }
            return decode.call(this);
        };
    });
    let releaseDecoder;
    let decoderRequested;
    const gate = new Promise(resolve => { releaseDecoder = resolve; });
    const requested = new Promise(resolve => { decoderRequested = resolve; });
    beforeServe = async pathname => {
        if (!/\/preview-heic\.[^/]+\.js$/.test(pathname)) return;
        decoderRequested();
        await gate;
    };
    try {
        await page.locator('[data-sync-preview-file]').first().click();
        await requested;
        await page.locator('[data-sync-preview-action="close"]').click();
        await page.locator('[data-sync-preview-file]').nth(1).click();
        const image = page.locator('[data-sync-preview-body] img');
        await expect(image).toHaveAttribute('alt', 'pixel.png');
        await expect(image).toHaveJSProperty('naturalWidth', 1);
        const decoderLoaded = page.waitForResponse(/\/preview-heic\.[^/]+\.js$/);
        releaseDecoder();
        await decoderLoaded;
        await expect(image).toHaveAttribute('alt', 'pixel.png');
        await page.locator('[data-sync-preview-action="close"]').click();
        await page.locator('[data-sync-action="close"]').click();
        await expect.poll(() => page.evaluate(() => window.previewImageUrls.every(({ url }) => window.revokedPreviewImageUrls.includes(url)))).toBe(true);
    } finally { releaseDecoder(); }
});

test('limits device names to eight Unicode characters and keeps the saved name across language changes', async ({ page }) => {
    await showSyncTools(page);
    await page.locator('[data-sync-devices]').click();
    const row = page.locator(`[data-device-id="${deviceId}"]`);
    const name = row.locator('[data-sync-device-name]');
    await expect(name).toHaveAttribute('placeholder', '输入设备名称');
    await name.fill('苹果🤖Mac设备额外');
    await expect(name).toHaveValue('苹果🤖Mac设备');
    const saved = page.waitForRequest(request => request.url().endsWith(`/devices/${deviceId}`) && request.method() === 'PATCH');
    await row.locator('[data-sync-device-save]').click();
    const payload = (await saved).postDataJSON();
    expect(payload.name).toMatch(/^e2ee1\./);
    expect(payload.name).not.toContain('苹果🤖Mac设备');
    await expect(row.locator('strong')).toHaveText('苹果🤖Mac设备');
    await page.locator('[data-sync-devices-dismiss]').click();
    await expect(page.locator('.sync-message-meta').first()).toContainText('苹果🤖Mac设备');
    await page.locator('[data-taskbar-lang]').click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('.sync-message-meta').first()).toContainText('苹果🤖Mac设备');
    await showSyncTools(page);
    await page.locator('[data-sync-devices]').click();
    await expect(name).toHaveAttribute('placeholder', 'Device name');
    await expect(name).toHaveValue('苹果🤖Mac设备');
    await expect(row.locator('strong')).toHaveText('苹果🤖Mac设备');
});

test('opening the same failed attachment retries without closing its preview window', async ({ page }) => {
    await page.locator('.sync-message').filter({ hasText: 'pixel.png' }).scrollIntoViewIfNeeded();
    await expect(page.locator('.sync-message-image img[alt="pixel.png"]')).toHaveJSProperty('naturalWidth', 1);
    const attempts = downloadAttempts;
    failDownloads = 3;
    const attachment = page.locator('.sync-message').filter({ hasText: 'notes.txt' }).locator('[data-sync-preview-file]');
    await attachment.click();
    await expect(page.locator('[data-sync-preview-status]')).toHaveText('文件无法预览，你仍可下载原文件。');
    expect(downloadAttempts).toBe(attempts + 3);
    await page.locator('[data-sync-preview-action="minimize"]').click();
    await attachment.click();
    await expect(page.locator('[data-sync-preview-body]')).toHaveText('Preview retry text');
    expect(downloadAttempts).toBe(attempts + 4);
});

test('previews a PNG with a generic MIME type and keeps unsupported extensions download-only', async ({ page }) => {
    const imageMessage = page.locator('.sync-message').filter({ hasText: 'pixel.png' });
    await imageMessage.locator('[data-sync-preview-file]').click();
    const preview = page.locator('[data-sync-preview-window]');
    await expect(preview.locator('img')).toHaveJSProperty('naturalWidth', 1);
    await expect(preview.locator('img')).toHaveJSProperty('naturalHeight', 1);
    await preview.locator('[data-sync-preview-action="close"]').click();
    const unsupported = page.locator('.sync-message').filter({ hasText: 'payload.bin' });
    await expect(unsupported.locator('[data-sync-preview-file]')).toHaveCount(0);
    await expect(unsupported.locator('[data-sync-download-file]')).toBeVisible();
});

test('recognizes a generic-MIME MP4 by its extension and decodes its real video metadata', async ({ page }) => {
    const videoMessage = page.locator('.sync-message').filter({ hasText: 'capture.MP4' });
    await videoMessage.locator('[data-sync-preview-file]').click();
    const preview = page.locator('[data-sync-preview-window]');
    const video = preview.locator('video');
    await expect(video).toHaveJSProperty('controls', true);
    await expect(video).toHaveJSProperty('videoWidth', 480);
    await expect(video).toHaveJSProperty('videoHeight', 360);
    await preview.locator('[data-sync-preview-action="close"]').click();
    await expect(preview.locator('[data-sync-preview-body]')).toBeEmpty();
});
