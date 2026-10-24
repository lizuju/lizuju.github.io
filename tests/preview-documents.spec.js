const { test, expect } = require('./sync-fixtures');
const XLSX = require('xlsx');

const roomId = '0f91b47d-d2a7-426e-aa14-48cd174ad752';
const deviceId = '49def00d-752e-4dd9-ae46-952ce53ec1f3';
const token = 'c'.repeat(64);
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
    await page.addInitScript(({ roomId, token }) => {
        localStorage.setItem('portfolio-sync-space', JSON.stringify({ roomId, token }));
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
    }, { roomId, token });
    await page.route('**/portfolio/sync-config.json', route => route.fulfill({ json: { apiBase: 'https://sync.test' } }));
    await page.route('https://sync.test/**', route => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        const headers = {
            'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
        };
        if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
        if (path.endsWith('/devices')) return route.fulfill({ headers, json: { deviceId, devices: [{ deviceId, name: 'Mac', createdAt: Date.now() }] } });
        if (path.endsWith('/download')) return route.fulfill({ headers, json: { ticket: path.split('/').at(-2).padStart(64, '0'), expiresAt: Date.now() + 86400000 } });
        return route.fulfill({ headers, contentType: 'application/octet-stream', body: path.endsWith('1') ? xlsx : csv });
    });
    await page.routeWebSocket('wss://sync.test/**', socket => socket.onMessage(message => {
        if (message === 'ping') return socket.send('pong');
        if (JSON.parse(message).type === 'auth') socket.send(JSON.stringify({
            type: 'ready', deviceId, pairing: null,
            messages: [
                { id: 1, name: 'sample.xlsx', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', body: xlsx },
                { id: 2, name: 'sample.csv', type: 'text/csv', body: csv }
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
