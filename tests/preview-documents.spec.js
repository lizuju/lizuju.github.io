const { test, expect } = require('@playwright/test');
const XLSX = require('xlsx');
const { createServer } = require('node:http');
const { deviceId, keyId, authorize, message, profile, file, startSite } = require('./fixtures/sync-e2ee.cjs');

let site;
let server;
const workbook = XLSX.utils.book_new();
const formatted = XLSX.utils.aoa_to_sheet([['Amount', 'Cached formula', 'Text'], [12.5, 7, '<img src=x onerror=alert(1)>']]);
formatted.A2.z = '0.00';
formatted.B2.f = '3+4';
XLSX.utils.book_append_sheet(workbook, formatted, 'Summary');
XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(
    Array.from({ length: 1005 }, (_, row) => Array.from({ length: 52 }, (_, column) => `row${row + 1}-col${column + 1}`))
), 'Large sheet');
XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([]), 'Empty');
const xlsx = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx', compression: true });
const csv = Buffer.from('名称,金额\n示例,12.50\n', 'utf8');

test.beforeEach(async ({ page, isMobile }) => {
    test.skip(isMobile, 'document previews are desktop windows');
    await page.addInitScript(() => {
        window.spreadsheetWorkers = 0;
        window.closedSpreadsheetWorkers = 0;
        window.workerWaitTicks = 0;
        const NativeWorker = window.Worker;
        window.Worker = class extends NativeWorker {
            constructor(url, options) {
                super(url, options);
                if (options?.name !== 'spreadsheet-preview') return;
                window.spreadsheetWorkers++;
                let timer;
                const post = this.postMessage.bind(this);
                this.postMessage = (message, transfer) => {
                    if (message.type === 'load') timer = setInterval(() => { window.workerWaitTicks++; }, 5);
                    post(message, transfer);
                };
                this.addEventListener('message', (event) => {
                    if (event.data.id === 1) clearInterval(timer);
                });
                const terminate = this.terminate.bind(this);
                this.terminate = () => {
                    clearInterval(timer);
                    window.closedSpreadsheetWorkers++;
                    terminate();
                };
            }
        };
    });
    const files = [
        { id: 1, ...file('sample.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xlsx) },
        { id: 2, ...file('sample.csv', 'text/csv', csv) }
    ];
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Sync-Key-Id, Range',
        'Access-Control-Allow-Methods': 'GET, HEAD, POST, DELETE, OPTIONS',
        'Access-Control-Expose-Headers': 'Content-Range, Content-Length'
    };
    server = createServer((request, response) => {
        if (request.method === 'OPTIONS') { response.writeHead(204, headers); response.end(); return; }
        const json = value => { response.writeHead(200, { ...headers, 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
        if (request.url.endsWith('/key-grants')) return json({ grants: [], hasMore: false, keyId });
        if (request.url.endsWith('/devices')) return json({ deviceId, devices: [profile()] });
        if (request.url.endsWith('/download')) return json({ ticket: request.url.split('/').at(-2).padStart(64, '0'), expiresAt: Date.now() + 86400000 });
        const encrypted = files[request.url.endsWith('1') ? 0 : 1].bytes;
        const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range || '');
        const start = range ? Number(range[1]) : 0;
        const end = range ? Number(range[2]) : encrypted.length - 1;
        const body = encrypted.subarray(start, end + 1);
        response.writeHead(range ? 206 : 200, { ...headers, 'Content-Type': 'application/octet-stream', 'Content-Length': String(body.length),
            ...(range ? { 'Content-Range': `bytes ${start}-${end}/${encrypted.length}` } : {}) });
        response.end(request.method === 'HEAD' ? undefined : body);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const apiOrigin = `http://127.0.0.1:${server.address().port}`;
    site = await startSite(apiOrigin);
    await authorize(page, `${site.origin}/portfolio/`);
    await page.routeWebSocket(`${apiOrigin.replace('http:', 'ws:')}/**`, socket => socket.onMessage(received => {
        if (received === 'ping') return socket.send('pong');
        if (JSON.parse(received).type === 'auth') socket.send(JSON.stringify({
            type: 'ready', deviceId, pairing: null,
            messages: files.map(file => message(file.id, '', deviceId, file.metadata))
        }));
    }));
    await page.goto(`${site.origin}/portfolio/`);
    await page.locator('[data-window-action="minimize"]').click();
    await page.locator('.desktop-shortcut[data-open-sync-space]').click();
    await expect(page.locator('[data-sync-status]')).toHaveAttribute('data-state', 'online');
});

test.afterEach(async () => {
    await site?.close();
    site = null;
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); server = null; }
});

test('parses real XLSX in a local worker, preserves formatted cached values, and renders only visible rows', async ({ page }) => {
    await page.locator('[data-sync-preview-file]').first().click();
    const preview = page.locator('[data-sync-preview-window]');
    const sheet = preview.locator('.sync-document-sheet');
    await expect(sheet).toContainText('12.50');
    await expect(sheet.locator('tbody tr[aria-rowindex="3"] td').nth(1)).toHaveText('7');
    await expect(sheet).toContainText('<img src=x onerror=alert(1)>');
    await expect(sheet.locator('img')).toHaveCount(0);
    expect(await page.evaluate(() => window.spreadsheetWorkers)).toBe(1);
    expect(await page.evaluate(() => window.workerWaitTicks)).toBeGreaterThan(0);
    await preview.getByRole('button', { name: 'Large sheet', exact: true }).click();
    await expect(preview.locator('.sync-document-limit')).toBeVisible();
    await expect(sheet.locator('table')).toHaveAttribute('aria-rowcount', '1001');
    await expect(sheet.locator('thead th')).toHaveCount(51);
    await expect(sheet).toContainText('row1-col1');
    expect(await sheet.locator('td').count()).toBeLessThan(2000);
    await sheet.evaluate(element => { element.scrollTop = element.scrollHeight; });
    await expect(sheet).toContainText('row1000-col1');
    await expect(sheet).not.toContainText('row1001-col1');
    expect(await sheet.locator('td').count()).toBeLessThan(2000);
    await preview.locator('[data-sync-preview-action="close"]').click();
    expect(await page.evaluate(() => window.closedSpreadsheetWorkers)).toBe(1);
    await expect(preview.locator('[data-sync-preview-body]')).toBeEmpty();
});

test('changing languages preserves the active worksheet and scroll position while translating preview labels', async ({ page }) => {
    await page.locator('[data-sync-preview-file]').first().click();
    const preview = page.locator('[data-sync-preview-window]');
    const sheet = preview.locator('.sync-document-sheet');
    await preview.getByRole('button', { name: 'Large sheet', exact: true }).click();
    await expect(sheet).toContainText('row1-col1');
    await sheet.evaluate(element => { element.scrollTop = 7000; element.scrollLeft = 400; });
    const scroll = await sheet.evaluate(element => ({ top: element.scrollTop, left: element.scrollLeft }));
    await page.locator('[data-taskbar-lang]').click();
    await expect(preview.locator('.sync-document-tabs')).toHaveAttribute('aria-label', 'Worksheets');
    await expect(sheet).toHaveAttribute('aria-label', 'Sheet Large sheet');
    await expect(preview.getByRole('button', { name: 'Large sheet', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(preview.locator('.sync-document-limit')).toHaveText('Preview is limited to 1000 rows and 50 columns');
    expect(await sheet.evaluate(element => ({ top: element.scrollTop, left: element.scrollLeft }))).toEqual(scroll);
    await preview.getByRole('button', { name: 'Empty', exact: true }).click();
    await expect(sheet).toHaveText('This worksheet is empty');
    await page.locator('[data-taskbar-lang]').click();
    await expect(sheet).toHaveText('此工作表没有数据');
    await expect(preview.getByRole('button', { name: 'Empty', exact: true })).toHaveAttribute('aria-pressed', 'true');
});

test('previews UTF-8 CSV through the same worker and closes it when another attachment opens', async ({ page }) => {
    await page.locator('[data-sync-preview-file]').nth(1).click();
    const preview = page.locator('[data-sync-preview-window]');
    await expect(preview.locator('.sync-document-sheet')).toContainText('名称');
    await expect(preview.locator('.sync-document-sheet')).toContainText('示例');
    await preview.locator('[data-sync-preview-action="minimize"]').click();
    await page.locator('[data-sync-preview-file]').first().click();
    await expect(preview.locator('.sync-document-sheet')).toContainText('Amount');
    expect(await page.evaluate(() => window.closedSpreadsheetWorkers)).toBe(1);
    expect(await page.evaluate(() => window.spreadsheetWorkers)).toBe(2);
});
