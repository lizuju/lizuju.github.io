const { test, expect, deviceId, otherId, keyId, authorize, message, profile, file, startSite } = require('./fixtures/sync-e2ee.cjs');
const { createServer } = require('node:http');
const { readFile } = require('node:fs/promises');
const XLSX = require('xlsx');

const desktopKey = 'gavin-portfolio-desktop-session';
const text = Buffer.from('独立联络站附件：只在设备端解密。');
const workbook = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['名称', '金额'], ['独立页面', 123]]), 'Summary');
const spreadsheet = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx', compression: true });
let site;
let api;
let apiBase;
let history;
let sockets;
let posted;

test.beforeEach(async ({ page }) => {
    const attachments = [file('notes.txt', 'text/plain', text), file('summary.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', spreadsheet)];
    history = attachments.map((attachment, index) => message(index + 1, '', otherId, attachment.metadata));
    sockets = [];
    posted = [];
    const headers = {
        'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Sync-Key-Id, Range',
        'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS', 'Access-Control-Expose-Headers': 'Content-Range, Content-Length'
    };
    api = createServer(async (request, response) => {
        const pathname = new URL(request.url, 'http://localhost').pathname;
        const json = value => { response.writeHead(200, { ...headers, 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
        if (request.method === 'OPTIONS') { response.writeHead(204, headers); response.end(); return; }
        if (pathname.endsWith('/key-grants')) return json({ grants: [], hasMore: false, keyId });
        if (pathname.endsWith('/devices')) return json({ deviceId, devices: [profile('Local'), profile('Paired', otherId)] });
        if (pathname.endsWith('/messages') && request.method === 'POST') {
            let raw = '';
            for await (const chunk of request) raw += chunk;
            const body = JSON.parse(raw);
            posted.push(body);
            const sent = { id: history.length + 1, clientId: body.clientId, text: body.text, deviceId, createdAt: Date.now() };
            history.push(sent);
            sockets.at(-1).send(JSON.stringify({ type: 'message', message: sent }));
            return json(sent);
        }
        if (/\/files\/\d+\/download$/.test(pathname)) return json({ ticket: pathname.split('/').at(-2).padStart(64, '0'), expiresAt: Date.now() + 86400000 });
        const download = /\/downloads\/(\d+)$/.exec(pathname);
        if (download) {
            const encrypted = attachments[Number(download[1]) - 1]?.bytes;
            if (encrypted) {
                const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range || '');
                const start = range ? Number(range[1]) : 0;
                const end = range ? Math.min(Number(range[2]), encrypted.length - 1) : encrypted.length - 1;
                const body = encrypted.subarray(start, end + 1);
                response.writeHead(range ? 206 : 200, { ...headers, 'Content-Type': 'application/octet-stream', 'Content-Length': body.length,
                    ...(range ? { 'Content-Range': `bytes ${start}-${end}/${encrypted.length}` } : {}) });
                response.end(request.method === 'HEAD' ? undefined : body);
                return;
            }
        }
        response.writeHead(404, headers);
        response.end();
    });
    await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
    apiBase = `http://127.0.0.1:${api.address().port}`;
    site = await startSite(apiBase);
    await page.routeWebSocket(`${apiBase.replace('http:', 'ws:')}/**`, socket => {
        sockets.push(socket);
        socket.onMessage(raw => {
            if (raw === 'ping') return socket.send('pong');
            if (JSON.parse(raw).type === 'auth') socket.send(JSON.stringify({
                type: 'ready', deviceId, pairing: null, messages: history, historyMode: 'replace', readReceipts: [],
                history: { generation: '1', oldestId: 1, latestId: history.at(-1)?.id, continuationId: history.at(-1)?.id, hasMore: false, hasNewer: false }
            }));
        });
    });
});

test.afterEach(async () => {
    await site?.close();
    if (api) { api.closeAllConnections(); await new Promise(resolve => api.close(resolve)); }
});

test('opens the standalone chat at every viewport with only its own assets and translated controls', async ({ page }) => {
    const errors = [];
    const missing = [];
    const scripts = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => { if (response.status() === 404) missing.push(response.url()); });
    page.on('request', request => { if (request.resourceType() === 'script') scripts.push(new URL(request.url()).pathname); });
    await page.goto(`${site.origin}/chat/`);
    const chat = page.locator('[data-sync-window]');
    await expect(chat).toBeVisible();
    await expect(page.locator('[data-sync-setup]')).toBeVisible();
    await expect(page.locator('body')).toHaveClass(/standalone-sync/);
    await expect(page.locator('body')).toHaveAttribute('data-asset-root', '../portfolio/');
    await expect(page.locator('.app-window')).toHaveCount(3);
    await expect(page.locator('[data-sync-gomoku-window]')).toHaveClass(/is-closed/);
    await expect(page.locator('[data-app-window], [data-project-window], [data-robot-pet]')).toHaveCount(0);
    await expect(page.locator('[data-start-menu]')).toBeHidden();
    await expect(chat.locator(':scope > .window-titlebar')).toBeHidden();
    await expect(page.locator('[data-sync-task]')).toBeDisabled();
    const geometry = await chat.boundingBox();
    expect(geometry.x).toBeGreaterThanOrEqual(0);
    expect(geometry.y).toBeGreaterThanOrEqual(0);
    expect((await chat.locator(':scope > .sync-content').boundingBox()).y - geometry.y).toBeLessThan(6);
    expect(geometry.width).toBeGreaterThanOrEqual(page.viewportSize().width - 12);
    expect(geometry.y + geometry.height).toBeLessThanOrEqual(page.viewportSize().height);
    await expect(page.locator('[data-sync-create]')).toHaveText('创建空间');
    await page.locator('[data-taskbar-lang]').click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('[data-sync-create]')).toHaveText('Create a space');
    await page.locator('[data-taskbar-lang]').click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
    expect(scripts).toContain('/portfolio/js/chat.js');
    expect(scripts.some(path => /\/portfolio\/js\/main\.js$|\/immersive\.|\/bundle\.|\/sync-documents\.|\/spreadsheet-preview\./.test(path))).toBe(false);
    expect(missing).toEqual([]);
    expect(errors).toEqual([]);
});

test('reuses a portfolio session, exchanges encrypted messages and previews and downloads attachments from the parent asset root', async ({ page }) => {
    await authorize(page, `${site.origin}/portfolio/`);
    const descriptor = await page.evaluate(() => localStorage.getItem('portfolio-sync-space-e2ee1'));
    const errors = [];
    const missing = [];
    const scripts = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => { if (response.status() === 404) missing.push(response.url()); });
    page.on('request', request => scripts.push(new URL(request.url()).pathname));
    await page.goto(`${site.origin}/chat/`);
    await expect(page.locator('[data-sync-status]')).toHaveAttribute('data-state', 'online');
    await expect(page.locator('.sync-message')).toHaveCount(2);
    expect(await page.evaluate(() => localStorage.getItem('portfolio-sync-space-e2ee1'))).toBe(descriptor);
    const desktop = await page.evaluate(key => sessionStorage.getItem(key), desktopKey);
    expect(JSON.parse(desktop).windows.portfolio).toBeTruthy();
    expect(scripts.some(path => /\/sync-documents\.|\/spreadsheet-preview\./.test(path))).toBe(false);
    await page.locator('[data-sync-input]').fill('Standalone outgoing 123');
    await page.locator('[data-sync-input]').press('Enter');
    await expect.poll(() => posted.length).toBe(1);
    expect(posted[0].text).toMatch(/^e2ee1\./);
    expect(JSON.stringify(posted[0])).not.toContain('Standalone outgoing 123');
    await expect(page.locator('.sync-message.is-own .sync-message-text')).toHaveText('Standalone outgoing 123');
    const incoming = message(4, 'Paired device reply', otherId);
    history.push(incoming);
    sockets.at(-1).send(JSON.stringify({ type: 'message', message: incoming }));
    await expect(page.locator('.sync-message-text').last()).toHaveText('Paired device reply');
    const attachment = name => page.locator('.sync-message').filter({ has: page.locator('.sync-attachment-name', { hasText: name }) });
    await attachment('notes.txt').locator('[data-sync-preview-file]').click();
    const preview = page.locator('[data-sync-preview-window]');
    await expect(preview.locator('.sync-document-text')).toHaveText(text.toString());
    expect(scripts.some(path => /\/sync-documents\./.test(path))).toBe(true);
    expect(scripts.some(path => /\/spreadsheet-preview\./.test(path))).toBe(false);
    await expect(page.locator('[data-sync-preview-task]')).toBeVisible();
    await preview.locator('[data-sync-preview-action="minimize"]').click();
    await page.locator('[data-sync-preview-task]').click();
    await expect(preview).toBeVisible();
    await preview.locator('[data-sync-preview-action="close"]').click();
    await attachment('summary.xlsx').locator('[data-sync-preview-file]').click();
    await expect(preview.locator('.sync-document-sheet')).toContainText('独立页面');
    expect(scripts.some(path => /\/spreadsheet-preview\./.test(path))).toBe(true);
    await preview.locator('[data-sync-preview-action="close"]').click();
    const downloading = page.waitForEvent('download');
    await attachment('notes.txt').locator('[data-sync-download-file]').click();
    const download = await downloading;
    expect(download.suggestedFilename()).toBe('notes.txt');
    expect(await readFile(await download.path())).toEqual(text);
    expect(await page.evaluate(() => navigator.serviceWorker.controller.scriptURL)).toBe(`${site.origin}/chat/sync-e2ee-worker.js`);
    const registrations = await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).map(entry => entry.scope));
    expect(registrations).toContain(`${site.origin}/chat/`);
    await page.reload();
    await expect(page.locator('[data-sync-status]')).toHaveAttribute('data-state', 'online');
    await expect(page.locator('.sync-message')).toHaveCount(4);
    expect(await page.evaluate(key => sessionStorage.getItem(key), desktopKey)).toBe(desktop);
    expect(missing).toEqual([]);
    expect(errors).toEqual([]);
});

test('keeps the existing portfolio and immersive iframe chat inside their current desktop', async ({ page }) => {
    for (const path of ['/portfolio/', '/shell']) {
        await page.goto(`${site.origin}${path}`);
        if (path === '/shell') await page.locator('#computer-screen').waitFor();
        const frame = path === '/shell' ? page.frameLocator('#computer-screen') : page;
        if (await frame.locator('[data-window-action="minimize"]').isVisible()) await frame.locator('[data-window-action="minimize"]').click();
        await frame.locator('.desktop-shortcut[data-open-sync-space]').click();
        await expect(frame.locator('[data-sync-window]')).toBeVisible();
        await expect(frame.locator('.sync-open-chat')).toHaveAttribute('href', '/chat/');
        await expect(frame.locator('.sync-open-chat')).toHaveAttribute('target', '_blank');
        expect(page.url()).toBe(`${site.origin}${path}`);
        expect(path === '/shell' ? await page.locator('#computer-screen').getAttribute('src') : new URL(page.url()).pathname).toBe('/portfolio/');
        await expect(frame.locator('body')).not.toHaveClass(/standalone-sync/);
        await expect(frame.locator('[data-sync-window] > .window-titlebar > .window-controls')).toBeVisible();
        await expect(frame.locator('[data-sync-window] > .window-titlebar')).toContainText('联络站');
    }
});
