const { test, expect, allowSyncOrigin } = require('./fixtures/sync-e2ee.cjs');
const { createServer } = require('node:http');

const { roomId, deviceId, token, keyId, authorize, message, profile, file, startSite } = require('./fixtures/sync-e2ee.cjs');

test.describe('mocked pairing requests', () => {
test.use({ serviceWorkers: 'block' });

test('shows the remaining pairing cooldown and enables joining when it expires', async ({ page, isMobile }) => {
    test.skip(isMobile, 'the sync application is a desktop window');
    await page.clock.install();
    await page.route('**/portfolio/sync-config.json', route => route.fulfill({ json: { apiBase: 'https://sync.test' } }));
    await page.route('https://sync.test/**', route => route.fulfill({
        headers: { 'Access-Control-Allow-Origin': '*' },
        json: { offers: Array.from({ length: 5 }, () => ({ offerId: require('node:crypto').randomUUID() })) }
    }));
    await page.goto('/portfolio/');
    await page.locator('[data-window-action="minimize"]').click();
    await page.locator('.desktop-shortcut[data-open-sync-space]').click();
    await page.evaluate(() => localStorage.setItem('gavin-sync-pair-attempts:join', JSON.stringify({
        ids: Array.from({ length: 20 }, () => crypto.randomUUID()), expiresAt: Date.now() + 60000
    })));
    await page.locator('[data-sync-code]').fill('1234');
    const join = page.locator('[data-sync-join]');
    await join.click();
    await expect(page.locator('[data-sync-notice]')).toHaveAttribute('data-i18n', 'syncPairLimited');
    await expect(join).toBeDisabled();
    await expect(join).toContainText('秒后重试');
    await page.clock.runFor(60100);
    await expect(join).toBeEnabled();
    await expect(join).toHaveText('加入空间');
});
});

test('caches image previews, renews expired download tickets and authenticates reconnects outside the URL', async ({ page, isMobile, browserName }) => {
    test.skip(isMobile, 'the sync application is a desktop window');
    await page.clock.install();
    const encrypted = file('pixel.png', 'image/png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64'));
    const attachmentMessage = message(1, '', deviceId, encrypted.metadata, roomId);
    let tickets = 0;
    const server = createServer((request, response) => {
        const path = new URL(request.url, 'http://localhost').pathname;
        const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Sync-Key-Id', 'Access-Control-Allow-Methods': 'GET, HEAD, POST, DELETE, OPTIONS' };
        const json = value => { response.writeHead(200, { ...headers, 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
        if (request.method === 'OPTIONS') { response.writeHead(204, headers); response.end(); return; }
        if (path.endsWith('/key-grants')) return json({ grants: [], hasMore: false, keyId });
        if (path.endsWith('/devices')) return json({ deviceId, devices: [profile()] });
        if (path.endsWith('/download')) return json({ ticket: String(++tickets).padStart(64, '0'), expiresAt: Date.now() + 24 * 60 * 60 * 1000 });
        const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range || '');
        const start = range ? Number(range[1]) : 0;
        const end = range ? Number(range[2]) : encrypted.bytes.length - 1;
        const body = encrypted.bytes.subarray(start, end + 1);
        response.writeHead(range ? 206 : 200, { ...headers, 'Content-Type': 'application/octet-stream', 'Content-Length': String(body.length), 'Access-Control-Expose-Headers': 'Content-Range', ...(range ? { 'Content-Range': `bytes ${start}-${end}/${encrypted.bytes.length}` } : {}) });
        response.end(request.method === 'HEAD' ? undefined : body);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const apiBase = `http://127.0.0.1:${server.address().port}`;
    const site = await startSite(apiBase);
    try {
    await authorize(page, `${site.origin}/portfolio/`);
    await page.routeWebSocket(`${apiBase.replace('http:', 'ws:')}/**`, socket => socket.onMessage(message => {
        if (message === 'ping') return socket.send('pong');
        if (JSON.parse(message).type === 'auth') socket.send(JSON.stringify({
            type: 'ready', deviceId, pairing: null,
            messages: [attachmentMessage]
        }));
    }));
    await page.goto(`${site.origin}/portfolio/`);
    await page.evaluate(() => {
        const NativeWebSocket = window.WebSocket;
        window.WebSocket = class extends NativeWebSocket {
            constructor(url, protocols) {
                super(url, protocols);
                window.syncSocketRequest = { url: String(url), protocols };
            }
        };
    });
    await page.locator('[data-window-action="minimize"]').click();
    await page.locator('.desktop-shortcut[data-open-sync-space]').click();
    await expect(page.locator('[data-sync-status]')).toHaveAttribute('data-state', 'online');
    const socketRequest = await page.evaluate(() => window.syncSocketRequest);
    expect(socketRequest.protocols).toEqual(['sync', `auth.${token}`]);
    expect(socketRequest.url).not.toContain(token);
    for (let attempt = 0; attempt < 2; attempt++) {
        await page.locator('[data-sync-preview-file]').click();
        await expect(page.locator('[data-sync-preview-body] img')).toBeVisible();
        await page.locator('[data-sync-preview-action="close"]').click();
    }
    const downloaded = page.waitForEvent('download');
    await page.locator('[data-sync-download-file]').click();
    await downloaded;
    expect(tickets).toBe(1);
    await page.clock.setSystemTime(Date.now() + 24 * 60 * 60 * 1000);
    await page.locator('[data-sync-preview-file]').click();
    await expect(page.locator('[data-sync-preview-body] img')).toBeVisible();
    expect(tickets).toBe(1);
    await page.locator('[data-sync-preview-action="close"]').click();
    const renewedDownload = page.waitForEvent('download');
    await page.locator('[data-sync-download-file]').click();
    await renewedDownload;
    expect(tickets).toBe(2);
    } finally { await site.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('a reclaimed room returns to pairing instead of repeatedly reconnecting with expired credentials', async ({ page, isMobile }) => {
    test.skip(isMobile, 'the sync application is a desktop window');
    const server = createServer((request, response) => {
        response.writeHead(request.method === 'OPTIONS' ? 204 : 404, {
            'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Sync-Key-Id'
        });
        response.end(request.method === 'OPTIONS' ? '' : JSON.stringify({ error: 'not_found' }));
    });
    server.on('upgrade', (request, socket) => socket.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        await authorize(page);
        await allowSyncOrigin(page, `http://127.0.0.1:${server.address().port}`);
        await page.route('**/portfolio/sync-config.json', route => route.fulfill({ json: { apiBase: `http://127.0.0.1:${server.address().port}` } }));
        await page.goto('/portfolio/');
        await page.locator('[data-window-action="minimize"]').click();
        await page.locator('.desktop-shortcut[data-open-sync-space]').click();
        await expect(page.locator('[data-sync-setup]')).toBeVisible();
        await expect(page.locator('[data-sync-notice]')).toHaveAttribute('data-i18n', 'syncRejoin');
        expect(await page.evaluate(() => localStorage.getItem('portfolio-sync-space-e2ee1'))).toBeNull();
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
});
