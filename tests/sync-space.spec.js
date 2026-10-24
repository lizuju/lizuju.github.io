const { test, expect } = require('@playwright/test');
const { createServer } = require('node:http');

const roomId = 'c5745baa-931f-4c83-9545-360fa055b57c';
const deviceId = '5fb30917-af43-4394-8034-0c326c774b78';
const token = 'a'.repeat(64);

test('reuses one ticket for preview and download, renews it near expiry and authenticates reconnects outside the URL', async ({ page, isMobile, browserName }) => {
    test.skip(isMobile, 'the sync application is a desktop window');
    await page.clock.install();
    await page.addInitScript(({ roomId, token }) => {
        localStorage.setItem('portfolio-sync-space', JSON.stringify({ roomId, token }));
    }, { roomId, token });
    await page.route('**/portfolio/sync-config.json', route => route.fulfill({ json: { apiBase: 'https://sync.test' } }));
    let tickets = 0;
    await page.route('https://sync.test/**', route => {
        const path = new URL(route.request().url()).pathname;
        const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
        if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
        if (path.endsWith('/devices')) return route.fulfill({ headers, json: { deviceId, devices: [{ deviceId, name: 'Mac', createdAt: Date.now() }] } });
        if (path.endsWith('/download')) {
            tickets++;
            return route.fulfill({ headers, json: { ticket: String(tickets).padStart(64, '0'), expiresAt: Date.now() + 24 * 60 * 60 * 1000 } });
        }
        const preview = new URL(route.request().url()).searchParams.has('preview');
        return route.fulfill({
            headers: { ...headers, 'Content-Disposition': `${preview ? 'inline' : 'attachment'}; filename="pixel.png"` },
            contentType: 'image/png',
            body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aC1kAAAAASUVORK5CYII=', 'base64')
        });
    });
    await page.routeWebSocket('wss://sync.test/**', socket => socket.onMessage(message => {
        if (message === 'ping') return socket.send('pong');
        if (JSON.parse(message).type === 'auth') socket.send(JSON.stringify({
            type: 'ready', deviceId, pairing: null,
            messages: [{ id: 1, clientId: roomId, deviceId, text: '', createdAt: Date.now(), attachment: { name: 'pixel.png', type: 'image/png', size: 68 } }]
        }));
    }));
    await page.goto('/portfolio/');
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
    const downloaded = browserName === 'webkit'
        ? page.waitForRequest(request => request.method() === 'GET' && request.url().includes('/downloads/') && !new URL(request.url()).searchParams.has('preview'))
        : page.waitForEvent('download');
    await page.locator('[data-sync-download-file]').click();
    await downloaded;
    expect(tickets).toBe(1);
    await page.clock.setSystemTime(Date.now() + 24 * 60 * 60 * 1000);
    await page.locator('[data-sync-preview-file]').click();
    await expect(page.locator('[data-sync-preview-body] img')).toBeVisible();
    expect(tickets).toBe(2);
});

test('a reclaimed room returns to pairing instead of repeatedly reconnecting with expired credentials', async ({ page, isMobile }) => {
    test.skip(isMobile, 'the sync application is a desktop window');
    const server = createServer((request, response) => {
        response.writeHead(request.method === 'OPTIONS' ? 204 : 404, {
            'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type'
        });
        response.end(request.method === 'OPTIONS' ? '' : JSON.stringify({ error: 'not_found' }));
    });
    server.on('upgrade', (request, socket) => socket.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        await page.addInitScript(({ roomId, token }) => localStorage.setItem('portfolio-sync-space', JSON.stringify({ roomId, token })), { roomId, token });
        await page.route('**/portfolio/sync-config.json', route => route.fulfill({ json: { apiBase: `http://127.0.0.1:${server.address().port}` } }));
        await page.goto('/portfolio/');
        await page.locator('[data-window-action="minimize"]').click();
        await page.locator('.desktop-shortcut[data-open-sync-space]').click();
        await expect(page.locator('[data-sync-setup]')).toBeVisible();
        await expect(page.locator('[data-sync-notice]')).toHaveAttribute('data-i18n', 'syncRejoin');
        expect(await page.evaluate(() => localStorage.getItem('portfolio-sync-space'))).toBeNull();
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
});
