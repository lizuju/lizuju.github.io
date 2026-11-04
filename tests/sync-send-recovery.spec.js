const { test, expect, deviceId, keyId, authorize, allowSyncOrigin } = require('./fixtures/sync-e2ee.cjs');

test.use({ serviceWorkers: 'block' });
const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
const open = async page => {
    await allowSyncOrigin(page, 'https://sync.test');
    await page.goto('/portfolio/');
    if (await page.locator('[data-window-action="minimize"]').isVisible()) await page.locator('[data-window-action="minimize"]').click();
    if (!await page.locator('[data-sync-window]').isVisible()) await page.locator('.desktop-shortcut[data-open-sync-space]').click();
    await expect(page.locator('[data-sync-status]')).toHaveAttribute('data-state', 'online');
};
const readOutbox = page => page.evaluate(async () => {
    const db = await new Promise(resolve => { const request = indexedDB.open('gavin-sync-outbox', 1); request.onsuccess = () => resolve(request.result); });
    const entries = await new Promise(resolve => { const request = db.transaction('messages').objectStore('messages').getAll(); request.onsuccess = () => resolve(request.result); });
    db.close();
    return entries;
});

for (const delivered of [false, true]) test(`recovers an online send after closing its tab when the first request was ${delivered ? 'delivered without acknowledgment' : 'not delivered'}`, async ({ page, context }) => {
    let release;
    const stalled = new Promise(resolve => { release = resolve; });
    const submissions = [];
    const saved = new Map();
    await context.route('**/portfolio/sync-config.json', route => route.fulfill({ json: { apiBase: 'https://sync.test' } }));
    await context.route('https://sync.test/**', async route => {
        if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
        if (route.request().method() === 'POST' && route.request().url().endsWith('/messages')) {
            const body = route.request().postDataJSON();
            submissions.push(body);
            if (submissions.length === 1) {
                if (delivered) saved.set(body.clientId, { ...body, id: 1, deviceId, createdAt: Date.now() });
                await stalled;
                await route.abort().catch(() => {});
                return;
            }
            if (!saved.has(body.clientId)) saved.set(body.clientId, { ...body, id: saved.size + 1, deviceId, createdAt: Date.now() });
            return route.fulfill({ headers, json: saved.get(body.clientId) });
        }
        return route.fulfill({ headers, json: { deviceId, devices: [], grants: [], hasMore: false, keyId } });
    });
    await context.routeWebSocket('wss://sync.test/**', socket => socket.onMessage(raw => {
        if (raw === 'ping') return socket.send('pong');
        // An empty snapshot also checks recovery when the original acknowledgment/history is unavailable.
        if (JSON.parse(raw).type === 'auth') socket.send(JSON.stringify({ type: 'ready', deviceId, messages: [], pairing: null,
            historyMode: 'replace', history: { generation: '1', oldestId: null, latestId: null, continuationId: null, hasNewer: false }, readReceipts: [] }));
    }));
    try {
        await authorize(page);
        await open(page);
        await page.locator('[data-sync-input]').fill('Keep this online message after closing');
        await page.locator('[data-sync-send]').click();
        await expect.poll(() => submissions.length).toBe(1);
        const entries = await readOutbox(page);
        expect(entries).toHaveLength(1);
        expect(entries[0].encrypted).toMatch(/^e2ee1\./);
        expect(JSON.stringify(entries)).not.toContain('Keep this online message');
        await page.close();
        release();
        const first = await context.newPage();
        const second = await context.newPage();
        await Promise.all([open(first), open(second)]);
        await expect.poll(() => submissions.length).toBe(2);
        await expect.poll(() => readOutbox(first)).toHaveLength(0);
        expect(new Set(submissions.map(body => body.clientId)).size).toBe(1);
        expect(saved.size).toBe(1);
        await expect(first.locator('.sync-message[data-state="queued"], .sync-message[data-state="sending"]')).toHaveCount(0);
        await expect(second.locator('.sync-message[data-state="queued"], .sync-message[data-state="sending"]')).toHaveCount(0);
    } finally { release(); }
});
