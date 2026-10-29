const { test, expect, deviceId, keyId, authorize, message, file, profile, startSite } = require('./fixtures/sync-e2ee.cjs');
const { createServer } = require('node:http');
const { createCipheriv } = require('node:crypto');
const { readFile } = require('node:fs/promises');
const path = require('node:path');

const clearChunk = 8 * 1024 * 1024 - 16;
const originalDownload = Buffer.alloc(clearChunk + 65536, 23);
const downloadFile = file('background-transfer.bin', 'application/octet-stream', originalDownload);
downloadFile.bytes = Buffer.concat([0, 1].map(index => {
    const nonce = Buffer.concat([Buffer.from(downloadFile.metadata.noncePrefix, 'base64url'), Buffer.alloc(4)]);
    nonce.writeUInt32BE(index, 8);
    const cipher = createCipheriv('aes-256-gcm', Buffer.from(downloadFile.metadata.key, 'base64url'), nonce);
    cipher.setAAD(Buffer.from(`gavin-sync-file-v1:${downloadFile.metadata.fileId}:${index}`));
    return Buffer.concat([cipher.update(originalDownload.subarray(index * clearChunk, (index + 1) * clearChunk)), cipher.final(), cipher.getAuthTag()]);
}));
let site;
let server;
let holdTicket;
let holdDownload;
let pendingTickets;
let pendingDownloads;
let ticketRequests;
let headRequests;
let downloadRanges;
let retryDownload;

const row = (page, name) => page.locator('.sync-message').filter({ has: page.locator('.sync-attachment-name', { hasText: name }) });
const background = page => page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    window.dispatchEvent(new Event('blur'));
    document.dispatchEvent(new Event('visibilitychange'));
});
const foreground = page => page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('focus'));
});

test.beforeEach(async ({ page, isMobile }) => {
    holdTicket = false;
    holdDownload = false;
    pendingTickets = [];
    pendingDownloads = [];
    ticketRequests = 0;
    headRequests = 0;
    downloadRanges = [];
    retryDownload = false;
    const attachments = [
        file('delayed-video.mp4', 'video/mp4', await readFile(path.join(__dirname, '../static/textures/monitor/video/base-static.mp4'))),
        downloadFile
    ];
    const headers = {
        'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Sync-Key-Id, Range',
        'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS', 'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Retry-After'
    };
    server = createServer((request, response) => {
        const pathname = new URL(request.url, 'http://localhost').pathname;
        const json = value => { response.writeHead(200, { ...headers, 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
        if (request.method === 'OPTIONS') { response.writeHead(204, headers); response.end(); return; }
        if (pathname.endsWith('/key-grants')) return json({ grants: [], hasMore: false, keyId });
        if (pathname.endsWith('/devices')) return json({ deviceId, devices: [profile()] });
        if (pathname.endsWith('/download')) {
            ticketRequests++;
            const send = () => json({ ticket: pathname.split('/').at(-2).padStart(64, '0'), expiresAt: Date.now() + 86400000 });
            if (holdTicket) pendingTickets.push(send);
            else send();
            return;
        }
        const id = Number(pathname.split('/').at(-1));
        const encrypted = attachments[id - 1]?.bytes;
        if (!encrypted) { response.writeHead(404, headers); response.end(); return; }
        if (request.method === 'HEAD') headRequests++;
        const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range || '');
        const start = range ? Number(range[1]) : 0;
        const end = range ? Math.min(Number(range[2]), encrypted.length - 1) : encrypted.length - 1;
        const body = encrypted.subarray(start, end + 1);
        if (request.method === 'GET') downloadRanges.push({ id, start, end });
        if (retryDownload && id === 2 && start > 0) {
            retryDownload = false;
            response.writeHead(503, { ...headers, 'Retry-After': '2' }); response.end(); return;
        }
        const send = () => {
            response.writeHead(range ? 206 : 200, { ...headers, 'Content-Type': 'application/octet-stream', 'Content-Length': String(body.length),
                ...(range ? { 'Content-Range': `bytes ${start}-${end}/${encrypted.length}` } : {}) });
            response.end(request.method === 'HEAD' ? undefined : body);
        };
        if (holdDownload && id === 2 && start > 0 && request.method === 'GET') pendingDownloads.push(send);
        else send();
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
    await page.goto(`${site.origin}/${isMobile ? 'chat/' : 'portfolio/'}`);
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

test('finishes a delayed preview after switching windows without reopening or stealing focus', async ({ page }) => {
    holdTicket = true;
    await row(page, 'delayed-video.mp4').locator('.sync-attachment-name').click();
    const viewer = page.locator('[data-sync-preview-window]');
    await expect(viewer).toBeVisible();
    await expect.poll(() => pendingTickets.length).toBe(1);
    await viewer.locator('[data-sync-preview-action="minimize"]').click();
    const input = page.locator('[data-sync-input]');
    await input.fill('Keep writing while the preview loads');
    pendingTickets.splice(0).forEach(send => send());
    const media = viewer.locator('video');
    await expect.poll(() => media.evaluate(video => video.videoWidth)).toBeGreaterThan(0);
    await expect(viewer).toBeHidden();
    await expect(input).toBeFocused();
    await expect(input).toHaveValue('Keep writing while the preview loads');
    await page.locator('[data-sync-preview-task]').click();
    await expect(media).toBeVisible();
    expect(ticketRequests).toBe(1);
    expect(headRequests).toBe(0);
});

test('keeps a delayed preview loading while the page is hidden', async ({ page }) => {
    holdTicket = true;
    await row(page, 'delayed-video.mp4').locator('.sync-attachment-name').click();
    const viewer = page.locator('[data-sync-preview-window]');
    await expect(viewer).toBeVisible();
    await expect.poll(() => pendingTickets.length).toBe(1);
    await background(page);
    pendingTickets.splice(0).forEach(send => send());
    const media = viewer.locator('video');
    await expect.poll(() => media.evaluate(video => video.videoWidth)).toBeGreaterThan(0);
    await expect(media).toHaveJSProperty('paused', true);
    await foreground(page);
    await expect(media).toBeVisible();
    expect(ticketRequests).toBe(1);
    expect(headRequests).toBe(0);
});

test('keeps a slow native download alive after iframe load, ten minutes and backgrounding', async ({ page }) => {
    await page.clock.install();
    holdDownload = true;
    const downloading = page.waitForEvent('download');
    await row(page, 'background-transfer.bin').locator('[data-sync-download-file]').click();
    const download = await downloading;
    await expect.poll(() => pendingDownloads.length).toBe(1);
    const frame = page.locator('iframe[src*="__sync-e2ee__"]');
    await expect(frame).toHaveCount(1);
    await background(page);
    await frame.evaluate(element => element.dispatchEvent(new Event('load')));
    await expect(frame).toHaveCount(1);
    await page.clock.fastForward(10 * 60 * 1000 + 1000);
    await expect(frame).toHaveCount(1);
    holdDownload = false;
    pendingDownloads.splice(0).forEach(send => send());
    expect(await readFile(await download.path())).toEqual(originalDownload);
    await expect(frame).toHaveCount(0);
    await foreground(page);
    await expect(page.locator('[data-sync-notice]')).not.toHaveAttribute('data-state', 'error');
    expect(ticketRequests).toBe(1);
});

test('deduplicates active downloads, exposes cancellation and allows a fresh retry', async ({ page }) => {
    holdDownload = true;
    const attachment = row(page, 'background-transfer.bin');
    const button = attachment.locator('[data-sync-download-file]');
    const cancel = attachment.locator('[data-sync-cancel-download]');
    let downloads = 0;
    page.on('download', () => downloads++);
    const firstEvent = page.waitForEvent('download');
    await button.click();
    const first = await firstEvent;
    await expect.poll(() => pendingDownloads.length).toBe(1);
    await expect(button).toBeDisabled();
    await expect(attachment.locator('[data-sync-download-progress]')).toContainText(/99%.*\//);
    await expect(button).toContainText(/正在下载|Downloading/);
    await expect(cancel).toBeVisible();
    await button.dispatchEvent('click');
    await expect(page.locator('iframe[src*="__sync-e2ee__"]')).toHaveCount(1);
    await cancel.click();
    await expect(button).toBeEnabled();
    await expect(cancel).toBeHidden();
    await expect(attachment.locator('[data-sync-download-progress]')).toBeHidden();
    await expect(page.locator('iframe[src*="__sync-e2ee__"]')).toHaveCount(0);
    expect(await first.failure()).toBeTruthy();
    expect(downloads).toBe(1);
    holdDownload = false;
    pendingDownloads.splice(0).forEach(send => send());
    const retryEvent = page.waitForEvent('download');
    await button.click();
    const retry = await retryEvent;
    expect(await readFile(await retry.path())).toEqual(originalDownload);
    await expect(button).toBeEnabled();
    expect(downloads).toBe(2);
});

test('cancels download preparation before a delayed ticket arrives', async ({ page }) => {
    holdTicket = true;
    const attachment = row(page, 'background-transfer.bin');
    let downloads = 0;
    page.on('download', () => downloads++);
    await attachment.locator('[data-sync-download-file]').click();
    await expect.poll(() => pendingTickets.length).toBe(1);
    await attachment.locator('[data-sync-cancel-download]').click();
    await expect(attachment.locator('[data-sync-download-file]')).toBeEnabled();
    holdTicket = false;
    pendingTickets.splice(0).forEach(send => send());
    // A new attempt may share the pending ticket, but only it may start a transfer.
    const retryEvent = page.waitForEvent('download');
    await attachment.locator('[data-sync-download-file]').click();
    const retry = await retryEvent;
    expect(await readFile(await retry.path())).toEqual(originalDownload);
    expect(downloads).toBe(1);
});

test('a video preview and its native download share cached chunks', async ({ page }) => {
    const attachment = row(page, 'delayed-video.mp4');
    await attachment.locator('.sync-attachment-name').click();
    const viewer = page.locator('[data-sync-preview-window]');
    await expect.poll(() => viewer.locator('video').evaluate(video => video.videoWidth)).toBeGreaterThan(0);
    const before = downloadRanges.filter(range => range.id === 1).length;
    expect(before).toBeGreaterThan(0);
    await viewer.locator('[data-sync-preview-action="minimize"]').click();
    const event = page.waitForEvent('download');
    await attachment.locator('[data-sync-download-file]').click();
    const download = await event;
    expect(await readFile(await download.path())).toEqual(await readFile(path.join(__dirname, '../static/textures/monitor/video/base-static.mp4')));
    expect(downloadRanges.filter(range => range.id === 1)).toHaveLength(before);
    await page.locator('[data-sync-preview-task]').click();
    await expect.poll(() => viewer.locator('video').evaluate(video => video.videoWidth)).toBeGreaterThan(0);
});

test('download progress shows retry waiting and resumes in the background', async ({ page }) => {
    retryDownload = true;
    holdDownload = true;
    const attachment = row(page, 'background-transfer.bin');
    const event = page.waitForEvent('download');
    await attachment.locator('[data-sync-download-file]').click();
    const download = await event;
    await expect(attachment.locator('[data-sync-download-progress]')).toContainText(/等待|Retrying/);
    await expect(attachment.locator('[data-sync-download-file]')).toBeDisabled();
    await background(page);
    await expect.poll(() => pendingDownloads.length).toBe(1);
    holdDownload = false;
    pendingDownloads.splice(0).forEach(send => send());
    expect(await readFile(await download.path())).toEqual(originalDownload);
    await foreground(page);
    await expect(attachment.locator('[data-sync-download-progress]')).toBeHidden();
    await expect(attachment.locator('[data-sync-download-file]')).toBeEnabled();
});
