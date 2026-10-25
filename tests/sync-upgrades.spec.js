const { test, expect } = require('./fixtures/sync-e2ee.cjs');
const { createServer } = require('node:http');
const { readFileSync } = require('node:fs');
const XLSX = require('xlsx');

const { roomId, deviceId, otherId, keyId, authorize, message, file, startSite } = require('./fixtures/sync-e2ee.cjs');
const headers = {
    'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Sync-Key-Id',
    'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, DELETE, OPTIONS', 'Access-Control-Expose-Headers': 'Retry-After'
};
const makeMessage = id => message(id, `History message ${id}`, otherId);
const bounds = (generation = '1', latestId = 120) => ({ generation, oldestId: 1, latestId, hasMore: true });
const openSync = async (page) => {
    await page.goto('/portfolio/');
    await page.locator('[data-window-action="minimize"]').click();
    await page.locator('.desktop-shortcut[data-open-sync-space]').click();
    await expect(page.locator('[data-sync-status]')).toHaveAttribute('data-state', 'online');
};

test('loads earlier messages without jumping, searches retained history, and reconnects incrementally', async ({ page, isMobile }) => {
    test.skip(isMobile, 'the sync application is a desktop window');
    await page.clock.install();
    await authorize(page);
    await page.route('**/portfolio/sync-config.json', route => route.fulfill({ json: { apiBase: 'https://sync.test' } }));
    await page.route('https://sync.test/**', async route => {
        const url = new URL(route.request().url());
        if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
        if (url.pathname.endsWith('/devices')) return route.fulfill({ headers, json: { deviceId, devices: [], grants: [], hasMore: false, keyId } });
        if (url.pathname.endsWith('/messages')) {
            const before = Number(url.searchParams.get('before'));
            const messages = Array.from({ length: Math.min(50, before - 1) }, (_, index) => makeMessage(Math.max(1, before - 50) + index));
            return route.fulfill({ headers, json: { messages, history: bounds(), historyMode: 'prepend' } });
        }
        return route.fulfill({ headers, json: { ok: true, grants: [], hasMore: false, keyId } });
    });
    const sockets = [];
    const socketUrls = [];
    await page.routeWebSocket('wss://sync.test/**', socket => {
        sockets.push(socket);
        socketUrls.push(new URL(socket.url()));
        socket.onMessage(message => {
            if (message === 'ping') return socket.send('pong');
            if (JSON.parse(message).type !== 'auth') return;
            const reconnect = socketUrls.at(-1).searchParams.has('after');
            socket.send(JSON.stringify({ type: 'ready', deviceId, pairing: null,
                readReceipts: [{ deviceId, messageId: 120 }],
                historyMode: reconnect ? 'append' : 'replace', history: bounds('1', reconnect ? 121 : 120),
                messages: reconnect ? [makeMessage(121)] : Array.from({ length: 50 }, (_, index) => makeMessage(71 + index))
            }));
        });
    });
    await openSync(page);
    await expect(page.locator('.sync-message')).toHaveCount(50);
    await page.locator('[data-sync-feed]').hover();
    await page.mouse.wheel(0, -10000);
    await expect.poll(() => page.locator('[data-sync-feed]').evaluate(feed => feed.scrollTop)).toBe(0);
    const anchor = page.getByText('History message 71', { exact: true });
    const before = await anchor.boundingBox();
    await page.locator('[data-sync-history-more]').click();
    await expect(page.locator('.sync-message')).toHaveCount(100);
    expect(Math.abs((await anchor.boundingBox()).y - before.y)).toBeLessThan(2);
    await page.locator('[data-sync-search]').fill('History message 90');
    await expect(page.locator('.sync-message:visible')).toHaveCount(1);
    await page.clock.runFor(200);
    await expect(page.locator('.sync-message')).toHaveCount(120);
    sockets.at(-1).close({ code: 1012, reason: 'Reconnect test' });
    await page.clock.runFor(1600);
    await expect(page.locator('.sync-message')).toHaveCount(121);
    expect(socketUrls.at(-1).searchParams.get('after')).toBe('120');
    expect(socketUrls.at(-1).searchParams.get('generation')).toBe('1');
    await expect(page.locator('.sync-message-text').first()).toHaveText('History message 1');
    await expect(page.locator('[data-sync-search]')).toHaveValue('History message 90');
    await expect(page.locator('[data-sync-unread]')).toHaveText('1');
    await page.locator('[data-sync-search]').fill('');
    expect(Math.abs((await anchor.boundingBox()).y - before.y)).toBeLessThan(2);
    await expect(page.locator('[data-sync-history-more]')).toBeHidden();
});

test('honors Retry-After during uploads and cancels the waiting retry', async ({ page, isMobile }) => {
    test.skip(isMobile, 'the sync application is a desktop window');
    await page.clock.install();
    await authorize(page);
    await page.route('**/portfolio/sync-config.json', route => route.fulfill({ json: { apiBase: 'https://sync.test' } }));
    const attempts = [];
    let cancelled = 0;
    let preparing = 0;
    await page.route('https://sync.test/**', route => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
        if (path.endsWith('/devices')) return route.fulfill({ headers, json: { deviceId, devices: [], grants: [], hasMore: false, keyId } });
        if (path.endsWith('/uploads')) {
            preparing++;
            if (preparing === 2) return route.fulfill({ status: 503, headers: { ...headers, 'Retry-After': '5' }, json: { error: 'storage_cleaning' } });
            return route.fulfill({ headers, json: { uploadId: 'test-upload', receivedBytes: 0, chunkSize: 8 * 1024 * 1024 } });
        }
        if (request.method() === 'DELETE') { cancelled++; return route.fulfill({ headers, json: { ok: true, grants: [], hasMore: false, keyId } }); }
        if (path.includes('/chunks/')) {
            attempts.push(Date.now());
            return route.fulfill({ status: 429, headers: { ...headers, 'Retry-After': '4' }, json: { error: 'rate_limited' } });
        }
        return route.fulfill({ headers, json: { ok: true, grants: [], hasMore: false, keyId } });
    });
    await page.routeWebSocket('wss://sync.test/**', socket => socket.onMessage(message => {
        if (message === 'ping') return socket.send('pong');
        socket.send(JSON.stringify({ type: 'ready', deviceId, messages: [], pairing: null, history: { generation: '1', oldestId: null, latestId: null, hasMore: false }, historyMode: 'replace' }));
    }));
    await openSync(page);
    await page.locator('[data-sync-file-input]').setInputFiles({ name: 'test.txt', mimeType: 'text/plain', buffer: Buffer.from('test') });
    await page.locator('[data-sync-send]').click();
    await expect(page.locator('[data-sync-upload-status]')).toContainText('4');
    expect(attempts).toHaveLength(1);
    await page.clock.runFor(3000);
    expect(attempts).toHaveLength(1);
    await page.clock.runFor(1100);
    await expect.poll(() => attempts.length).toBe(2);
    await page.locator('[data-sync-cancel-upload]').click();
    await expect(page.locator('[data-sync-selected-file]')).toBeHidden();
    await page.clock.runFor(10000);
    expect(attempts).toHaveLength(2);
    expect(cancelled).toBe(1);
    await page.locator('[data-sync-file-input]').setInputFiles({ name: 'prepare.txt', mimeType: 'text/plain', buffer: Buffer.from('test') });
    await page.locator('[data-sync-send]').click();
    await expect(page.locator('[data-sync-upload-status]')).toContainText('5');
    await expect(page.locator('[data-sync-cancel-upload]')).toBeEnabled();
    await page.locator('[data-sync-cancel-upload]').click();
    await expect(page.locator('[data-sync-selected-file]')).toBeHidden();
    await page.clock.runFor(6000);
    expect(preparing).toBe(2);
    expect(cancelled).toBe(1);
});

test('downloads real XLSX bytes from a cross-origin server inside the immersive iframe', async ({ page, isMobile }) => {
    test.skip(isMobile, 'the sync application is a desktop window');
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['项目', '进度'], ['机器人', 123]]), '项目');
    const bytes = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    const filename = '咖啡冰淇淋机器人项目跟进表格.xlsx';
    const encrypted = file(filename, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', bytes);
    const attachmentMessage = message(1, '', deviceId, encrypted.metadata, 'xlsx');
    let issuedTickets = 0;
    const server = createServer((request, response) => {
        if (request.method === 'OPTIONS') { response.writeHead(204, headers); response.end(); return; }
        response.setHeader('Content-Type', 'application/json');
        if (request.url.endsWith('/key-grants')) {
            response.writeHead(200, headers); response.end(JSON.stringify({ grants: [], hasMore: false, keyId })); return;
        }
        if (request.url.endsWith('/devices')) {
            response.writeHead(200, headers); response.end(JSON.stringify({ deviceId, devices: [] })); return;
        }
        if (request.url.endsWith('/download')) {
            issuedTickets++;
            response.writeHead(200, headers); response.end(JSON.stringify({ ticket: String(issuedTickets).repeat(64), expiresAt: Date.now() + 86400000 })); return;
        }
        if (request.url.endsWith('1'.repeat(64))) { response.writeHead(404, headers); response.end(); return; }
        const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range || '');
        const start = range ? Number(range[1]) : 0;
        const end = range ? Number(range[2]) : encrypted.bytes.length - 1;
        const body = encrypted.bytes.subarray(start, end + 1);
        response.writeHead(range ? 206 : 200, { ...headers, 'Access-Control-Expose-Headers': 'Content-Range', 'Content-Type': 'application/octet-stream', 'Content-Length': String(body.length),
            ...(range ? { 'Content-Range': `bytes ${start}-${end}/${encrypted.bytes.length}` } : {}) });
        response.end(request.method === 'HEAD' ? undefined : body);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const site = await startSite(`http://127.0.0.1:${server.address().port}`);
    try {
        await authorize(page, `${site.origin}/portfolio/`);
        await page.routeWebSocket(`ws://127.0.0.1:${server.address().port}/**`, socket => socket.onMessage(message => {
            if (message === 'ping') return socket.send('pong');
            socket.send(JSON.stringify({ type: 'ready', deviceId, pairing: null, messages: [attachmentMessage] }));
        }));
        await page.goto(`${site.origin}/shell`);
        const desktop = page.frameLocator('#computer-screen');
        await desktop.locator('[data-window-action="minimize"]').click();
        await desktop.locator('.desktop-shortcut[data-open-sync-space]').click();
        await expect(desktop.locator('[data-sync-status]')).toHaveAttribute('data-state', 'online');
        const received = page.waitForEvent('download');
        await desktop.locator('[data-sync-download-file]').click();
        const download = await received;
        expect(await download.failure()).toBeNull();
        expect(download.suggestedFilename()).toBe(filename);
        expect(readFileSync(await download.path())).toEqual(bytes);
        expect(issuedTickets).toBe(2);
        await expect(desktop.locator('[data-sync-notice]')).not.toHaveAttribute('data-i18n', 'syncDownloadFailed');
        await desktop.locator('[data-sync-preview-file]').click();
        await expect(desktop.locator('.sync-document-sheet')).toContainText('机器人');
        await expect(desktop.locator('.sync-document-sheet')).toContainText('123');
        expect(issuedTickets).toBe(2);
    } finally { await site.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
