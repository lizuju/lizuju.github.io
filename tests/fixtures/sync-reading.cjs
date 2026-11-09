const { test, expect, roomId, session, deviceId, otherId, keyId, profile, message, authorize } = require('./sync-e2ee.cjs');

const headers = {
    'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Sync-Key-Id',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
};
const bounds = latestId => ({ generation: '1', oldestId: 1, latestId, continuationId: latestId, hasNewer: false });
const atBottom = page => page.locator('[data-sync-feed]').evaluate(feed => feed.scrollHeight - feed.clientHeight - feed.scrollTop);

const openChat = async (page, history, receipts = [], background = false, realClock = false, prepare = async () => {}) => {
    if (!realClock) await page.clock.install();
    await authorize(page);
    await prepare();
    await page.route('**/portfolio/sync-config.json', route => route.fulfill({ json: { apiBase: 'https://sync.test' } }));
    await page.route('https://sync.test/**', route => {
        if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
        return route.fulfill({ headers, json: {
            deviceId, devices: route.request().url().includes(roomId) ? [profile('Local'), profile('Paired', otherId)] : [], grants: [], hasMore: false, keyId
        } });
    });
    const connections = new Map();
    const reads = [];
    await page.routeWebSocket('wss://sync.test/**', socket => {
        const room = new URL(socket.url()).pathname.split('/')[3];
        connections.set(room, socket);
        const initial = room === roomId ? history : [];
        socket.onMessage(raw => {
            if (raw === 'ping') return socket.send('pong');
            const data = JSON.parse(raw);
            if (data.type === 'auth') socket.send(JSON.stringify({
                type: 'ready', deviceId, messages: initial, pairing: null, readReceipts: receipts,
                history: bounds(initial.at(-1)?.id ?? null), historyMode: 'replace'
            }));
            else if (data.type === 'read') {
                reads.push(data.messageId);
                socket.send(JSON.stringify({ ...data, deviceId }));
            }
        });
    });
    await page.goto('/portfolio/');
    await page.bringToFront();
    if (background) await page.evaluate(() => {
        Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => false });
        window.dispatchEvent(new Event('blur'));
    });
    if (await page.locator('[data-window-action="minimize"]').isVisible()) await page.locator('[data-window-action="minimize"]').click();
    await page.locator('.desktop-shortcut[data-open-sync-space]').click();
    await expect(page.locator('[data-sync-status]')).toHaveAttribute('data-state', 'online');
    await expect(page.locator('.sync-message')).toHaveCount(history.length);
    return {
        reads,
        publish: (message, metadata) => connections.get(roomId).send(JSON.stringify({ type: 'message', message, history: metadata })),
        incoming: async (id, metadata = bounds(id)) => {
            connections.get(roomId).send(JSON.stringify({ type: 'message', message: message(id, `Incoming ${id}`, otherId), history: metadata }));
            await expect(page.locator('.sync-message-text').last()).toHaveText(`Incoming ${id}`);
        },
        receipt: (sender, id) => connections.get(roomId).send(JSON.stringify({ type: 'read', deviceId: sender, messageId: id })),
        snapshot: receipts => connections.get(roomId).send(JSON.stringify({ type: 'history', messages: history,
            history: bounds(history.at(-1)?.id ?? null), historyMode: 'replace', readReceipts: receipts }))
    };
};

module.exports = { test, expect, roomId, session, deviceId, otherId, keyId, profile, message, headers, bounds, atBottom, openChat };
