const { test, expect } = require('@playwright/test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const heic = readFileSync(join(__dirname, 'fixtures/heic-gradient.heic'));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aC1kAAAAASUVORK5CYII=', 'base64');
const roomId = 'c5745baa-931f-4c83-9545-360fa055b57c';
const deviceId = '5fb30917-af43-4394-8034-0c326c774b78';
const token = 'a'.repeat(64);

test.beforeEach(async ({ page, isMobile }) => {
    test.skip(isMobile, 'attachment previews and device names are desktop windows');
    await page.addInitScript(({ roomId, token }) => {
        localStorage.setItem('portfolio-sync-space', JSON.stringify({ roomId, token }));
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
    }, { roomId, token });
    await page.route('**/portfolio/sync-config.json', route => route.fulfill({ json: { apiBase: 'https://sync.test' } }));
    const devices = [{ deviceId, name: 'Mac', createdAt: Date.now() }];
    await page.route('https://sync.test/**', route => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        const headers = {
            'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type',
            'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS'
        };
        if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
        if (request.method() === 'PATCH') {
            devices[0].name = request.postDataJSON().name.trim();
            return route.fulfill({ headers, json: { ok: true } });
        }
        if (path.endsWith('/devices')) return route.fulfill({ headers, json: { deviceId, devices } });
        if (path.endsWith('/download')) return route.fulfill({
            headers,
            json: { ticket: path.split('/').at(-2).padStart(64, '0'), expiresAt: Date.now() + 86400000 }
        });
        return route.fulfill({
            headers: { ...headers, 'Content-Disposition': 'attachment' },
            contentType: 'application/octet-stream', body: path.endsWith('1') ? heic : png
        });
    });
    await page.routeWebSocket('wss://sync.test/**', socket => socket.onMessage(message => {
        if (message === 'ping') return socket.send('pong');
        if (JSON.parse(message).type === 'auth') socket.send(JSON.stringify({
            type: 'ready', deviceId, pairing: null,
            messages: [
                { id: 1, name: 'camera.HEIC', type: 'application/octet-stream', body: heic },
                { id: 2, name: 'pixel.png', type: 'image/png', body: png }
            ].map(file => ({
                id: file.id, clientId: `${roomId}-${file.id}`, deviceId, text: '', createdAt: Date.now(),
                attachment: { name: file.name, type: file.type, size: file.body.length }
            }))
        }));
    }));
    await page.goto('/portfolio/');
    await page.locator('[data-window-action="minimize"]').click();
    await page.locator('.desktop-shortcut[data-open-sync-space]').click();
    await expect(page.locator('[data-sync-status]')).toHaveAttribute('data-state', 'online');
    await expect(page.locator('[data-sync-preview-file]')).toHaveCount(2);
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
    expect(await page.evaluate(() => window.previewImageUrls.every(({ url }) => window.revokedPreviewImageUrls.includes(url)))).toBe(true);
});

test('closing during the HEIC decoder load cannot replace the next image or retain its blob URL', async ({ page }) => {
    await page.evaluate(() => {
        const decode = HTMLImageElement.prototype.decode;
        HTMLImageElement.prototype.decode = function () {
            if (window.previewImageUrls.some(entry => entry.url === this.src && entry.type === 'image/heic')) {
                return Promise.reject(new DOMException('HEIC native decoding unavailable', 'EncodingError'));
            }
            return decode.call(this);
        };
    });
    let releaseDecoder;
    let decoderRequested;
    const gate = new Promise(resolve => { releaseDecoder = resolve; });
    const requested = new Promise(resolve => { decoderRequested = resolve; });
    await page.route('**/preview-heic.*.js', async route => {
        decoderRequested();
        await gate;
        await route.continue();
    });
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
        expect(await page.evaluate(() => window.previewImageUrls.every(({ url }) => window.revokedPreviewImageUrls.includes(url)))).toBe(true);
    } finally { releaseDecoder(); }
});

test('limits device names to eight Unicode characters and keeps the saved name across language changes', async ({ page }) => {
    await page.locator('[data-sync-devices]').click();
    const row = page.locator(`[data-device-id="${deviceId}"]`);
    const name = row.locator('[data-sync-device-name]');
    await expect(name).toHaveAttribute('placeholder', '输入设备名称');
    await name.fill('苹果🤖Mac设备额外');
    await expect(name).toHaveValue('苹果🤖Mac设备');
    const saved = page.waitForRequest(request => request.url().endsWith(`/devices/${deviceId}`) && request.method() === 'PATCH');
    await row.locator('[data-sync-device-save]').click();
    expect((await saved).postDataJSON()).toEqual({ name: '苹果🤖Mac设备' });
    await expect(row.locator('strong')).toHaveText('苹果🤖Mac设备');
    await page.locator('[data-sync-devices-dismiss]').click();
    await expect(page.locator('.sync-message-meta').first()).toContainText('苹果🤖Mac设备');
    await page.locator('[data-taskbar-lang]').click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('.sync-message-meta').first()).toContainText('苹果🤖Mac设备');
    await page.locator('[data-sync-devices]').click();
    await expect(name).toHaveAttribute('placeholder', 'Device name');
    await expect(name).toHaveValue('苹果🤖Mac设备');
    await expect(row.locator('strong')).toHaveText('苹果🤖Mac设备');
});
