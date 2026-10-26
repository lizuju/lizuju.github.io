const { test, expect, deviceId, keyId, authorize, message, file, profile, startSite } = require('./fixtures/sync-e2ee.cjs');
const { createServer } = require('node:http');
const { readFile } = require('node:fs/promises');
const path = require('node:path');

const gif = Buffer.from('R0lGODlhAQABAIAAAP8AAAAA/yH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACwAAAAAAQABAAACAkQBACH5BAAKAAAALAAAAAABAAEAAAICTAEAOw==', 'base64');
let site;
let server;
let gets;
let maxConcurrent;
let failGif;

test.beforeEach(async ({ page }) => {
    gets = new Map();
    maxConcurrent = 0;
    failGif = 3;
    let concurrent = 0;
    const attachments = [
        ...Array.from({ length: 20 }, (_, index) => file(`reaction-${index + 1}.gif`, 'image/gif', Buffer.concat([gif, Buffer.alloc(1024 * 1024 - gif.length)]))),
        file('clip.mp4', 'video/mp4', await readFile(path.join(__dirname, '../static/textures/monitor/video/base-static.mp4')))
    ];
    const headers = {
        'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Sync-Key-Id, Range',
        'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS', 'Access-Control-Expose-Headers': 'Content-Range, Content-Length'
    };
    server = createServer((request, response) => {
        if (request.method === 'OPTIONS') { response.writeHead(204, headers); response.end(); return; }
        const json = value => { response.writeHead(200, { ...headers, 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
        if (request.url.endsWith('/key-grants')) return json({ grants: [], hasMore: false, keyId });
        if (request.url.endsWith('/devices')) return json({ deviceId, devices: [profile()] });
        if (request.url.endsWith('/download')) return json({ ticket: request.url.split('/').at(-2).padStart(64, '0'), expiresAt: Date.now() + 86400000 });
        const id = Number(request.url.split('/').at(-1));
        const encrypted = attachments[id - 1]?.bytes;
        if (!encrypted) { response.writeHead(404, headers); response.end(); return; }
        const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range || '');
        const start = range ? Number(range[1]) : 0;
        const end = range ? Number(range[2]) : encrypted.length - 1;
        const body = encrypted.subarray(start, end + 1);
        const send = () => {
            if (id === 20 && failGif > 0 && request.method === 'GET') { failGif--; response.writeHead(503, headers); response.end(); return; }
            response.writeHead(range ? 206 : 200, { ...headers, 'Content-Type': 'application/octet-stream', 'Content-Length': String(body.length),
                ...(range ? { 'Content-Range': `bytes ${start}-${end}/${encrypted.length}` } : {}) });
            response.end(request.method === 'HEAD' ? undefined : body);
        };
        if (request.method !== 'GET') return send();
        gets.set(id, (gets.get(id) || 0) + 1);
        if (id === 21) return send();
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        const timer = setTimeout(send, 100);
        response.once('close', () => { concurrent--; clearTimeout(timer); });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const apiBase = `http://127.0.0.1:${server.address().port}`;
    site = await startSite(apiBase);
    await page.addInitScript(() => {
        window.gifImageUrls = [];
        window.gifRevokedImageUrls = [];
        const create = URL.createObjectURL.bind(URL);
        const revoke = URL.revokeObjectURL.bind(URL);
        URL.createObjectURL = blob => {
            const url = create(blob);
            if (blob.type.startsWith('image/')) window.gifImageUrls.push(url);
            return url;
        };
        URL.revokeObjectURL = url => { window.gifRevokedImageUrls.push(url); revoke(url); };
    });
    await authorize(page, `${site.origin}/portfolio/`);
    await page.routeWebSocket(`${apiBase.replace('http:', 'ws:')}/**`, socket => socket.onMessage(raw => {
        if (raw === 'ping') return socket.send('pong');
        if (JSON.parse(raw).type === 'auth') socket.send(JSON.stringify({
            type: 'ready', deviceId, pairing: null, messages: attachments.map((attachment, index) => message(index + 1, '', deviceId, attachment.metadata))
        }));
    }));
    await page.goto(`${site.origin}/portfolio/`);
    if (await page.locator('[data-window-action="minimize"]').isVisible()) await page.locator('[data-window-action="minimize"]').click();
    await page.locator('.desktop-shortcut[data-open-sync-space]').click();
    await expect(page.locator('[data-sync-status]')).toHaveAttribute('data-state', 'online');
});

test.afterEach(async () => {
    await site?.close();
    site = null;
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); server = null; }
});

test('loads nearby encrypted GIFs with bounded concurrency, retries a failed GIF and releases them on close', async ({ page }) => {
    const failed = page.locator('.sync-message-image[data-state="failed"]');
    await expect(failed).toBeVisible();
    expect(gets.get(20)).toBe(3);
    expect([...gets.keys()].filter(id => id <= 20).length).toBeLessThan(10);
    expect(maxConcurrent).toBeLessThanOrEqual(3);
    expect(await page.locator('.sync-message-image img[src]').count()).toBeLessThan(10);
    await failed.click();
    const lastGif = page.locator('.sync-message').filter({ has: page.locator('.sync-attachment-name', { hasText: 'reaction-20.gif' }) });
    await expect(lastGif.locator('.sync-message-image img')).toHaveJSProperty('naturalWidth', 1);
    expect(gets.get(20)).toBe(4);
    await page.locator('[data-sync-feed]').evaluate(feed => feed.scrollBy({ top: -200, behavior: 'instant' }));
    await expect.poll(() => page.locator('[data-sync-feed]').evaluate(feed => feed.scrollHeight - feed.scrollTop - feed.clientHeight)).toBeGreaterThan(100);
    const position = await page.locator('[data-sync-feed]').evaluate(feed => {
        const top = feed.getBoundingClientRect().top;
        const rows = [...feed.querySelectorAll('.sync-message')];
        const row = rows.find(row => row.getBoundingClientRect().bottom > top);
        return { index: rows.indexOf(row), offset: row.getBoundingClientRect().top - top };
    });
    await page.locator('[data-sync-action="close"]').click();
    await expect(page.locator('.sync-message-image img[src]')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => window.gifImageUrls.every(url => window.gifRevokedImageUrls.includes(url)))).toBe(true);
    await page.locator('.desktop-shortcut[data-open-sync-space]').click();
    await expect.poll(() => page.locator('.sync-message-image img[src]').count()).toBeGreaterThan(0);
    await expect.poll(() => page.locator('[data-sync-feed]').evaluate((feed, index) =>
        feed.querySelectorAll('.sync-message')[index].getBoundingClientRect().top - feed.getBoundingClientRect().top,
    position.index)).toBe(position.offset);
    expect([...gets.keys()].filter(id => id <= 20).length).toBeLessThan(15);
});

test('pauses the attachment video under the shutdown overlay without stopping unrelated media', async ({ page }) => {
    await page.locator('.sync-message').filter({ has: page.locator('.sync-attachment-name', { hasText: 'clip.mp4' }) }).locator('[data-sync-preview-file]').click();
    const video = page.locator('[data-sync-preview-body] video');
    await expect.poll(() => video.evaluate(video => video.readyState)).toBeGreaterThanOrEqual(1);
    await video.evaluate(async video => {
        video.muted = true;
        await video.play();
        const unrelated = document.createElement('video');
        unrelated.id = 'unrelated-media';
        unrelated.muted = true;
        unrelated.src = video.currentSrc;
        document.body.append(unrelated);
        await unrelated.play();
    });
    await expect(video).toHaveJSProperty('paused', false);
    await page.locator('[data-start-toggle]').click();
    await page.locator('[data-shutdown]').click();
    await expect(page.locator('[data-shutdown-screen]')).toBeVisible();
    await expect(video).toHaveJSProperty('paused', true);
    await expect(page.locator('#unrelated-media')).toHaveJSProperty('paused', false);
});
