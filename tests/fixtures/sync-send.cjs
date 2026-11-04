const { test, expect, roomId, deviceId, otherId, keyId, authorize, message, allowSyncOrigin } = require('./sync-e2ee.cjs');

const headers = {
    'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Sync-Key-Id',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS'
};
const bounds = id => ({ generation: '1', oldestId: id ? 1 : null, latestId: id, continuationId: id, hasNewer: false });
const confirmed = (body, id) => ({ id, deviceId, clientId: body.clientId, text: body.text, createdAt: Date.now() });
const spaceDot = page => page.locator('[data-sync-space-id][aria-current="true"] [data-sync-space-unread]');
const receipt = page => page.locator('.sync-message.is-own .sync-message-read');

const openChat = async (page, handleRequest, seed = true) => {
    if (seed) await authorize(page);
    else await allowSyncOrigin(page, 'https://sync.test');
    await page.route('**/portfolio/sync-config.json', route => route.fulfill({ json: { apiBase: 'https://sync.test' } }));
    await page.route('https://sync.test/**', async route => {
        if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
        if (await handleRequest?.(route)) return;
        return route.fulfill({ headers, json: { deviceId, devices: [], grants: [], hasMore: false, keyId } });
    });
    let connection;
    let holdReady = false;
    await page.routeWebSocket('wss://sync.test/**', socket => {
        connection = socket;
        socket.onMessage(raw => {
            if (raw === 'ping') return socket.send('pong');
            if (JSON.parse(raw).type === 'auth' && !holdReady) socket.send(JSON.stringify({
                type: 'ready', deviceId, messages: [], historyMode: 'replace', history: bounds(null), readReceipts: [], pairing: null
            }));
        });
    });
    await page.goto('/portfolio/');
    await page.bringToFront();
    if (await page.locator('[data-window-action="minimize"]').isVisible()) await page.locator('[data-window-action="minimize"]').click();
    await page.locator('.desktop-shortcut[data-open-sync-space]').click();
    await expect(page.locator('[data-sync-status]')).toHaveAttribute('data-state', 'online');
    return {
        disconnect: () => { holdReady = true; connection.close({ code: 1001 }); },
        reconnect: () => { holdReady = false; connection.send(JSON.stringify({ type: 'ready', deviceId, messages: [], historyMode: 'replace', history: bounds(null), readReceipts: [], pairing: null })); },
        send: async text => {
            await page.locator('[data-sync-input]').fill(text);
            await page.locator('[data-sync-send]').click();
        },
        echo: (item, generation = '1') => connection.send(JSON.stringify({ type: 'message', message: item, history: { ...bounds(item.id), generation } })),
        clear: () => connection.send(JSON.stringify({ type: 'cleared', history: { ...bounds(null), generation: '2' }, readReceipts: [] })),
        read: (sender, id) => connection.send(JSON.stringify({ type: 'read', deviceId: sender, messageId: id }))
    };
};


module.exports = { test, expect, roomId, deviceId, otherId, message, headers, bounds, confirmed, spaceDot, receipt, openChat };
