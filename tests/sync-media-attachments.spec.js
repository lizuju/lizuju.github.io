const { test, expect, deviceId, keyId, authorize, message, file, profile, startSite } = require('./fixtures/sync-e2ee.cjs');
const { createServer } = require('node:http');
const { readFile } = require('node:fs/promises');
const path = require('node:path');

const formats = [
    { name: 'camera.MOV', fixture: 'preview-video.mov', type: 'video/quicktime', kind: 'video' },
    { name: 'song.MP3', fixture: 'preview-audio.mp3', type: 'audio/mpeg', kind: 'audio' },
    { name: 'memo.M4A', fixture: 'preview-audio.m4a', type: 'audio/x-m4a', kind: 'audio' }
];
let site;
let server;
let attachments;
let originals;

const row = (page, name) => page.locator('.sync-message').filter({ has: page.locator('.sync-attachment-name', { hasText: name }) });

test.beforeEach(async ({ page, isMobile }) => {
    originals = await Promise.all(formats.map(format => readFile(path.join(__dirname, 'fixtures', format.fixture))));
    attachments = [
        ...formats.map((format, index) => file(format.name, 'application/octet-stream', originals[index])),
        ...formats.map((format, index) => file(`media-${index + 1}`, format.type, originals[index]))
    ];
    const headers = {
        'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Sync-Key-Id, Range',
        'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS', 'Access-Control-Expose-Headers': 'Content-Range, Content-Length'
    };
    server = createServer((request, response) => {
        const pathname = new URL(request.url, 'http://localhost').pathname;
        const json = value => { response.writeHead(200, { ...headers, 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
        if (request.method === 'OPTIONS') { response.writeHead(204, headers); response.end(); return; }
        if (pathname.endsWith('/key-grants')) return json({ grants: [], hasMore: false, keyId });
        if (pathname.endsWith('/devices')) return json({ deviceId, devices: [profile()] });
        if (pathname.endsWith('/download')) return json({ ticket: pathname.split('/').at(-2).padStart(64, '0'), expiresAt: Date.now() + 86400000 });
        const encrypted = attachments[Number(pathname.split('/').at(-1)) - 1]?.bytes;
        if (!encrypted) { response.writeHead(404, headers); response.end(); return; }
        const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range || '');
        const start = range ? Number(range[1]) : 0;
        const end = range ? Math.min(Number(range[2]), encrypted.length - 1) : encrypted.length - 1;
        const body = encrypted.subarray(start, end + 1);
        response.writeHead(range ? 206 : 200, { ...headers, 'Content-Type': 'application/octet-stream', 'Content-Length': String(body.length),
            ...(range ? { 'Content-Range': `bytes ${start}-${end}/${encrypted.length}` } : {}) });
        response.end(request.method === 'HEAD' ? undefined : body);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const apiBase = `http://127.0.0.1:${server.address().port}`;
    site = await startSite(apiBase);
    await authorize(page, `${site.origin}/portfolio/`);
    await page.routeWebSocket(`${apiBase.replace('http:', 'ws:')}/**`, socket => socket.onMessage(raw => {
        if (raw === 'ping') return socket.send('pong');
        if (JSON.parse(raw).type === 'auth') socket.send(JSON.stringify({
            type: 'ready', deviceId, pairing: null,
            messages: attachments.map((attachment, index) => message(index + 1, '', deviceId, attachment.metadata))
        }));
    }));
    await page.goto(`${site.origin}/portfolio/${isMobile ? 'chat/' : ''}`);
    if (!isMobile) {
        await page.locator('[data-window-action="minimize"]').click();
        await page.locator('.desktop-shortcut[data-open-sync-space]').click();
    }
    await expect(page.locator('[data-sync-status]')).toHaveAttribute('data-state', 'online');
});

test.afterEach(async () => {
    await site?.close();
    site = null;
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); server = null; }
});

for (const [index, format] of formats.entries()) {
    test(`previews encrypted ${format.name} by extension, seeks, pauses on minimize and downloads the original`, async ({ page, context }) => {
        const attachment = row(page, format.name);
        await attachment.locator('.sync-attachment-name').click();
        const viewer = page.locator('[data-sync-preview-window]');
        const media = viewer.locator(format.kind);
        await expect(media).toBeVisible();
        await expect(media).toHaveJSProperty('controls', true);
        await expect.poll(() => media.evaluate(element => element.duration)).toBeGreaterThan(0.8);
        expect(await media.evaluate(element => element.duration)).toBeLessThan(1.5);
        if (format.kind === 'video') {
            await expect(media).toHaveJSProperty('videoWidth', 64);
            await expect(media).toHaveJSProperty('videoHeight', 48);
        }
        expect(context.pages()).toHaveLength(1);
        await media.evaluate(async element => { element.muted = true; element.loop = true; await element.play(); });
        await expect(media).toHaveJSProperty('paused', false);
        await media.evaluate(element => { element.pause(); element.currentTime = 0.5; });
        await expect(media).toHaveJSProperty('seeking', false);
        await expect.poll(() => media.evaluate(element => element.currentTime)).toBeCloseTo(0.5, 1);
        await media.evaluate(element => element.play());
        await viewer.locator('[data-sync-preview-action="minimize"]').click();
        await expect(viewer).toBeHidden();
        await expect(media).toHaveJSProperty('paused', true);
        await attachment.locator('.sync-attachment-name').click();
        await expect(media).toBeVisible();
        const detachedMedia = await media.elementHandle();
        await media.evaluate(element => element.play());
        await viewer.locator('[data-sync-preview-action="close"]').click();
        await expect(viewer.locator('[data-sync-preview-body]')).toBeEmpty();
        expect(await detachedMedia.evaluate(element => element.paused && !element.hasAttribute('src'))).toBe(true);
        const downloaded = page.waitForEvent('download');
        await attachment.locator('[data-sync-download-file]').click();
        const download = await downloaded;
        expect(download.suggestedFilename()).toBe(format.name);
        expect(await readFile(await download.path())).toEqual(originals[index]);
        await expect(viewer).toBeHidden();
    });
}

test('recognizes QuickTime, MPEG audio and M4A MIME types without a file extension', async ({ page }) => {
    const viewer = page.locator('[data-sync-preview-window]');
    for (const [index, format] of formats.entries()) {
        await row(page, `media-${index + 1}`).locator('.sync-attachment-name').click();
        const media = viewer.locator(format.kind);
        await expect(media).toBeVisible();
        await expect.poll(() => media.evaluate(element => element.duration)).toBeGreaterThan(0.8);
        await viewer.locator('[data-sync-preview-action="close"]').click();
    }
});
