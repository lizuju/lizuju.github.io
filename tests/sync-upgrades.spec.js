const { test, expect, allowSyncOrigin } = require('./sync-fixtures');
const { createServer } = require('node:http');
const { readFileSync } = require('node:fs');
const XLSX = require('xlsx');

const roomId = 'c5745baa-931f-4c83-9545-360fa055b57c';
const deviceId = '5fb30917-af43-4394-8034-0c326c774b78';
const otherId = 'ddda513e-dcf9-473b-ac0d-83503ac81318';
const token = 'a'.repeat(64);
const headers = {
    'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, DELETE, OPTIONS', 'Access-Control-Expose-Headers': 'Retry-After'
};
const makeMessage = (id) => ({ id, clientId: `message-${id}`, deviceId: otherId, text: `History message ${id}`, createdAt: Date.now() });
const bounds = (generation = '1', latestId = 120) => ({ generation, oldestId: 1, latestId, hasMore: true });
const authorize = async (page) => page.addInitScript(({ roomId, token }) => {
    localStorage.setItem('portfolio-sync-space', JSON.stringify({ roomId, token }));
}, { roomId, token });
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
        if (url.pathname.endsWith('/devices')) return route.fulfill({ headers, json: { deviceId, devices: [] } });
        if (url.pathname.endsWith('/messages')) {
            const before = Number(url.searchParams.get('before'));
            const messages = Array.from({ length: Math.min(50, before - 1) }, (_, index) => makeMessage(Math.max(1, before - 50) + index));
            return route.fulfill({ headers, json: { messages, history: bounds(), historyMode: 'prepend' } });
        }
        return route.fulfill({ headers, json: { ok: true } });
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
                historyMode: reconnect ? 'append' : 'replace', history: bounds('1', reconnect ? 121 : 120),
                messages: reconnect ? [makeMessage(121)] : Array.from({ length: 50 }, (_, index) => makeMessage(71 + index))
            }));
        });
    });
    await openSync(page);
    await expect(page.locator('.sync-message')).toHaveCount(50);
    await page.locator('[data-sync-feed]').evaluate(feed => { feed.scrollTop = 0; });
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
        if (path.endsWith('/devices')) return route.fulfill({ headers, json: { deviceId, devices: [] } });
        if (path.endsWith('/uploads')) {
            preparing++;
            if (preparing === 2) return route.fulfill({ status: 503, headers: { ...headers, 'Retry-After': '5' }, json: { error: 'storage_cleaning' } });
            return route.fulfill({ headers, json: { uploadId: 'test-upload', receivedBytes: 0, chunkSize: 1024 } });
        }
        if (request.method() === 'DELETE') { cancelled++; return route.fulfill({ headers, json: { ok: true } }); }
        if (path.includes('/chunks/')) {
            attempts.push(Date.now());
            return route.fulfill({ status: 429, headers: { ...headers, 'Retry-After': '4' }, json: { error: 'rate_limited' } });
        }
        return route.fulfill({ headers, json: { ok: true } });
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
    let issuedTickets = 0;
    const server = createServer((request, response) => {
        if (request.method === 'OPTIONS') { response.writeHead(204, headers); response.end(); return; }
        response.setHeader('Content-Type', 'application/json');
        if (request.url.endsWith('/devices')) {
            response.writeHead(200, headers); response.end(JSON.stringify({ deviceId, devices: [] })); return;
        }
        if (request.url.endsWith('/download')) {
            issuedTickets++;
            response.writeHead(200, headers); response.end(JSON.stringify({ ticket: String(issuedTickets).repeat(64), expiresAt: Date.now() + 86400000 })); return;
        }
        if (request.url.endsWith('1'.repeat(64))) { response.writeHead(404, headers); response.end(); return; }
        response.writeHead(200, { ...headers, 'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.length),
            'Content-Disposition': `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(filename)}` });
        response.end(request.method === 'HEAD' ? undefined : bytes);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        await authorize(page);
        await allowSyncOrigin(page, `http://127.0.0.1:${server.address().port}`);
        await page.route('**/portfolio/sync-config.json', route => route.fulfill({ json: { apiBase: `http://127.0.0.1:${server.address().port}` } }));
        await page.routeWebSocket(`ws://127.0.0.1:${server.address().port}/**`, socket => socket.onMessage(message => {
            if (message === 'ping') return socket.send('pong');
            socket.send(JSON.stringify({ type: 'ready', deviceId, pairing: null, messages: [{ id: 1, clientId: 'xlsx', deviceId, text: '', createdAt: Date.now(),
                attachment: { name: filename, size: bytes.length, type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' } }] }));
        }));
        await page.route('**/sync-test-immersive', route => route.fulfill({ contentType: 'text/html', body: '<iframe id="computer-screen" src="/portfolio/" style="width:1280px;height:720px;border:0"></iframe>' }));
        await page.goto('/sync-test-immersive');
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
    } finally { await new Promise(resolve => server.close(resolve)); }
});
