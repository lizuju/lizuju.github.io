const { test, expect, deviceId, otherId, keyId, message, authorize } = require('./fixtures/sync-e2ee.cjs');

test.use({ serviceWorkers: 'block' });

const headers = {
    'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Sync-Key-Id',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
};
const ready = (messages = []) => ({
    type: 'ready', deviceId, pairing: null, readReceipts: [], messages, historyMode: 'replace',
    history: { generation: '1', oldestId: messages[0]?.id ?? null, latestId: messages.at(-1)?.id ?? null,
        continuationId: messages.at(-1)?.id ?? null, hasNewer: false }
});

const openChat = async (page, onAuth, handleRequest, beforeOpen) => {
    await page.clock.install({ time: new Date('2026-10-25T00:00:00Z') });
    await page.clock.pauseAt(new Date('2026-10-25T00:00:01Z'));
    await page.addInitScript(() => { Math.random = () => 0; });
    await authorize(page);
    await page.route('**/portfolio/sync-config.json', route => route.fulfill({ json: { apiBase: 'https://sync.test' } }));
    await page.route('https://sync.test/**', async route => {
        if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
        if (await handleRequest?.(route)) return;
        return route.fulfill({ headers, json: { deviceId, devices: [], grants: [], hasMore: false, keyId } });
    });
    const sockets = [];
    let closes = 0;
    await page.routeWebSocket('wss://sync.test/**', socket => {
        sockets.push(socket);
        socket.onClose(() => { closes++; });
        socket.onMessage(raw => {
            if (raw === 'ping') return socket.send('pong');
            if (JSON.parse(raw).type === 'auth') onAuth(socket, sockets.length);
        });
    });
    await page.goto('/portfolio/');
    await beforeOpen?.();
    if (await page.locator('[data-window-action="minimize"]').isVisible()) await page.locator('[data-window-action="minimize"]').click();
    if (!await page.locator('[data-sync-window]').isVisible()) await page.locator('.desktop-shortcut[data-open-sync-space]').click();
    return { sockets, closes: () => closes };
};

test('times out a missing ready frame and reconnects using the existing backoff', async ({ page }) => {
    const chat = await openChat(page, (socket, index) => { if (index > 1) socket.send(JSON.stringify(ready())); });
    const status = page.locator('[data-sync-status]');
    await expect.poll(() => chat.sockets.length).toBe(1);
    await page.clock.runFor(29999);
    await expect(status).toHaveAttribute('data-state', 'connecting');
    await page.clock.runFor(1);
    await expect(status).toHaveAttribute('data-state', 'offline');
    await page.clock.runFor(999);
    expect(chat.sockets).toHaveLength(1);
    await page.clock.runFor(1);
    await expect.poll(() => chat.sockets.length).toBe(2);
    await expect(status).toHaveAttribute('data-state', 'online');
    await expect.poll(chat.closes).toBe(1);
});

test('also recovers when the first WebSocket never opens', async ({ page }) => {
    const chat = await openChat(page, socket => socket.send(JSON.stringify(ready())), null, () => page.evaluate(() => {
        const NativeWebSocket = WebSocket;
        window.__pendingSocketCount = 0;
        window.__pendingSocketCloses = 0;
        window.WebSocket = class extends EventTarget {
            static OPEN = NativeWebSocket.OPEN;
            constructor(...args) {
                super();
                if (window.__pendingSocketCount++) return new NativeWebSocket(...args);
                this.readyState = NativeWebSocket.CONNECTING;
            }
            close() {
                this.readyState = NativeWebSocket.CLOSED;
                window.__pendingSocketCloses++;
                this.dispatchEvent(new CloseEvent('close', { code: 1000 }));
            }
        };
    }));
    await expect.poll(() => page.evaluate(() => window.__pendingSocketCount)).toBe(1);
    await page.clock.runFor(30000);
    expect(await page.evaluate(() => window.__pendingSocketCloses)).toBe(1);
    await page.clock.runFor(1000);
    await expect.poll(() => chat.sockets.length).toBe(1);
    await expect(page.locator('[data-sync-status]')).toHaveAttribute('data-state', 'online');
});

test('keeps a slow valid initialization online after its original timeout is cleared', async ({ page }) => {
    let keyRequest = false;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const chat = await openChat(page, () => {}, async route => {
        if (!route.request().url().endsWith('/key-grants')) return false;
        keyRequest = true;
        await gate;
        await route.fulfill({ headers, json: { grants: [], hasMore: false, keyId } });
        return true;
    });
    try {
        await expect.poll(() => chat.sockets.length).toBe(1);
        await page.clock.runFor(10000);
        chat.sockets[0].send(JSON.stringify(ready([message(1, 'Slow initialization', otherId)])));
        await expect.poll(() => keyRequest).toBe(true);
        await page.clock.runFor(10000);
        await expect(page.locator('[data-sync-status]')).toHaveAttribute('data-state', 'connecting');
        release();
        await expect(page.locator('[data-sync-status]')).toHaveAttribute('data-state', 'online');
        await expect(page.locator('.sync-message-text')).toHaveText('Slow initialization');
        await page.clock.runFor(10001);
        expect(chat.sockets).toHaveLength(1);
        expect(chat.closes()).toBe(0);
        await expect(page.locator('[data-sync-status]')).toHaveAttribute('data-state', 'online');
    } finally { release(); }
});

test('covers history decryption in the timeout and ignores the expired initialization result', async ({ page }) => {
    await page.addInitScript(() => {
        const decrypt = crypto.subtle.decrypt.bind(crypto.subtle);
        let stalled = false;
        crypto.subtle.decrypt = async (...args) => {
            const result = await decrypt(...args);
            if (!stalled && new TextDecoder().decode(args[0].additionalData).includes(':message:')) {
                stalled = true;
                await new Promise(resolve => { window.__releaseInitializationDecrypt = resolve; });
            }
            return result;
        };
    });
    const chat = await openChat(page, (socket, index) => socket.send(JSON.stringify(ready([
        message(index, index === 1 ? 'Expired initialization' : 'Current connection', otherId)
    ]))));
    await expect.poll(() => page.evaluate(() => typeof window.__releaseInitializationDecrypt === 'function')).toBe(true);
    await page.clock.runFor(31000);
    await expect.poll(() => chat.sockets.length).toBe(2);
    await expect(page.locator('[data-sync-status]')).toHaveAttribute('data-state', 'online');
    await expect(page.locator('.sync-message-text')).toHaveText('Current connection');
    await page.evaluate(() => window.__releaseInitializationDecrypt());
    await page.clock.runFor(1);
    await expect(page.locator('.sync-message-text')).toHaveText('Current connection');
    expect(chat.sockets).toHaveLength(2);
});

test('cancels the initialization timer when the session changes and when the window closes', async ({ page }) => {
    const chat = await openChat(page, (socket, index) => { if (index > 1) socket.send(JSON.stringify(ready())); });
    await expect.poll(() => chat.sockets.length).toBe(1);
    await page.evaluate(() => {
        const key = 'portfolio-sync-space-e2ee1';
        window.__savedConnectionSession = localStorage.getItem(key);
        localStorage.removeItem(key);
        window.dispatchEvent(new StorageEvent('storage', { key, newValue: null }));
    });
    await expect(page.locator('[data-sync-setup]')).toBeVisible();
    await expect.poll(chat.closes).toBe(1);
    await page.clock.runFor(5000);
    await page.evaluate(() => {
        const key = 'portfolio-sync-space-e2ee1';
        localStorage.setItem(key, window.__savedConnectionSession);
        window.dispatchEvent(new StorageEvent('storage', { key, newValue: window.__savedConnectionSession }));
    });
    await expect.poll(() => chat.sockets.length).toBe(2);
    await expect(page.locator('[data-sync-status]')).toHaveAttribute('data-state', 'online');
    await page.clock.runFor(25001);
    expect(chat.sockets).toHaveLength(2);
    await expect(page.locator('[data-sync-status]')).toHaveAttribute('data-state', 'online');
    await page.locator('[data-sync-action="close"]').click();
    await page.clock.runFor(31000);
    expect(chat.sockets).toHaveLength(2);
    await expect.poll(chat.closes).toBe(2);
});
