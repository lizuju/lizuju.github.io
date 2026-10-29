const { test, expect } = require('@playwright/test');
const { readFile } = require('node:fs/promises');
const path = require('node:path');

test.use({ serviceWorkers: 'block' });

test('shares ordered frames and reads, isolates rooms, reconnects and transfers the socket when its owner closes', async ({ page, context }) => {
    await context.route('**/__shared-connection__/**', async route => {
        const filename = new URL(route.request().url()).pathname.split('/').at(-1);
        if (!filename) return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Shared connection</title>' });
        return route.fulfill({ contentType: 'text/javascript', body: await readFile(path.join(__dirname, '../static/portfolio/js/apps', filename)) });
    });
    const sockets = [];
    const reads = [];
    let number = 0;
    await context.routeWebSocket('ws://127.0.0.1:3090/__socket__/**', socket => {
        const entry = { socket, room: new URL(socket.url()).pathname.split('/').at(-1), number: ++number };
        sockets.push(entry);
        socket.onMessage(raw => {
            if (raw === 'ping') return socket.send('pong');
            const frame = JSON.parse(raw);
            if (frame.type === 'auth') socket.send(JSON.stringify({ type: 'ready', messages: [entry.number] }));
            else reads.push({ room: entry.room, ...frame });
        });
    });
    const mount = async (page, room = 'room') => {
        await page.goto('/__shared-connection__/');
        await page.evaluate(async room => {
            const { SharedSyncConnection } = await import('./sync-shared-connection.js');
            window.received = [];
            window.requestCount = 0;
            window.connection = new SharedSyncConnection({
                session: { roomId: room, token: 'same-device' },
                getUrl: () => `ws://${location.host}/__socket__/${room}`,
                receive: async (data, current) => {
                    if (window.stallNext) {
                        window.stallNext = false;
                        await new Promise(resolve => { window.releaseStalled = resolve; });
                    }
                    if (!current()) return;
                    if (data.type === 'ready') window.received = data.messages;
                    else window.received.push(data.id);
                },
                snapshot: () => ({ type: 'ready', messages: window.received }),
                request: async key => {
                    window.requestCount++;
                    if (window.holdRequest) await new Promise(resolve => { window.releaseRequest = resolve; });
                    return { key, count: window.requestCount };
                },
                onState: state => { window.connectionState = state; },
                onClose: () => {},
                onError: error => { window.error = error.message; }
            });
            window.connection.connect();
        }, room);
        await expect.poll(() => page.evaluate(() => window.connectionState)).toBe('online');
    };
    await mount(page);
    const follower = await context.newPage();
    await mount(follower);
    expect(sockets).toHaveLength(1);
    await expect.poll(() => follower.evaluate(() => window.received)).toEqual([1]);
    await page.evaluate(() => { window.holdRequest = true; window.result = window.connection.request('devices'); });
    await page.waitForFunction(() => !!window.releaseRequest);
    await follower.evaluate(() => { window.result = window.connection.request('devices'); });
    sockets[0].socket.send(JSON.stringify({ type: 'message', id: 10 }));
    sockets[0].socket.send(JSON.stringify({ type: 'message', id: 11 }));
    await expect.poll(() => follower.evaluate(() => window.received)).toEqual([1, 10, 11]);
    await page.evaluate(() => { window.holdRequest = false; window.releaseRequest(); });
    expect(await follower.evaluate(() => window.result)).toEqual({ key: 'devices', count: 1 });
    expect(await page.evaluate(() => window.result)).toEqual({ key: 'devices', count: 1 });
    expect(await follower.evaluate(() => window.connection.request('devices'))).toEqual({ key: 'devices', count: 1 });
    await follower.evaluate(() => window.connection.invalidateResults());
    expect(await follower.evaluate(() => window.connection.request('devices'))).toEqual({ key: 'devices', count: 2 });
    await follower.evaluate(() => window.connection.socket.send(JSON.stringify({ type: 'read', messageId: 11 })));
    await expect.poll(() => reads).toEqual([{ room: 'room', type: 'read', messageId: 11 }]);
    const otherRoom = await context.newPage();
    await mount(otherRoom, 'other-room');
    expect(sockets).toHaveLength(2);
    await follower.evaluate(() => { window.stallNext = true; });
    sockets[0].socket.send(JSON.stringify({ type: 'message', id: 12 }));
    await follower.waitForFunction(() => typeof window.releaseStalled === 'function');
    expect(await otherRoom.evaluate(() => window.received)).toEqual([2]);
    await follower.evaluate(() => window.connection.socket.close());
    await expect.poll(() => sockets.length).toBe(3);
    await expect.poll(() => follower.evaluate(() => window.received)).toEqual([3]);
    await follower.evaluate(() => window.releaseStalled());
    expect(await follower.evaluate(() => window.received)).toEqual([3]);
    await page.evaluate(() => { window.holdRequest = true; window.releaseRequest = null; });
    await follower.evaluate(() => { window.pendingRequest = window.connection.request('pair-code').catch(error => error.code); });
    await page.waitForFunction(() => !!window.releaseRequest);
    await page.close();
    await expect.poll(() => sockets.length).toBe(4);
    await expect.poll(() => follower.evaluate(() => window.connectionState)).toBe('online');
    expect(await follower.evaluate(() => window.pendingRequest)).toBe('network_error');
    expect(await follower.evaluate(() => window.connection.request('pair-code'))).toEqual({ key: 'pair-code', count: 1 });
    sockets[3].socket.send(JSON.stringify({ type: 'message', id: 20 }));
    await expect.poll(() => follower.evaluate(() => window.received)).toEqual([4, 20]);
    expect(await follower.evaluate(() => window.error)).toBeUndefined();
    expect(await otherRoom.evaluate(() => window.received)).toEqual([2]);
});

test('a slow shared device refresh does not delay encrypted messages in either tab', async ({ page, context }) => {
    const { authorize, deviceId, otherId, keyId, message, profile } = require('./fixtures/sync-e2ee.cjs');
    await authorize(page);
    const production = require('../static/portfolio/sync-config.json').apiBase;
    await context.route('**/chat/', async route => {
        const response = await route.fetch();
        await route.fulfill({ response, body: (await response.text()).replaceAll(production, 'https://sync.test').replaceAll(production.replace('https:', 'wss:'), 'wss://sync.test') });
    });
    const sockets = [];
    let deviceRequests = 0;
    let keyRequests = 0;
    let release;
    let hold = false;
    const gate = new Promise(resolve => { release = resolve; });
    const headers = { 'Access-Control-Allow-Origin': '*' };
    await context.route('**/portfolio/sync-config.json', route => route.fulfill({ json: { apiBase: 'https://sync.test' } }));
    await context.route('https://sync.test/**', async route => {
        if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { ...headers,
            'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Sync-Key-Id', 'Access-Control-Allow-Methods': 'GET, DELETE' } });
        if (route.request().url().endsWith('/devices')) {
            deviceRequests++;
            if (hold) await gate;
            return route.fulfill({ headers, json: { deviceId, devices: [profile(), profile('Peer', otherId)] } });
        }
        keyRequests++;
        return route.fulfill({ headers, json: { grants: [], hasMore: false, keyId } });
    });
    await context.routeWebSocket('wss://sync.test/**', socket => {
        sockets.push(socket);
        socket.onMessage(raw => {
            if (raw === 'ping') return socket.send('pong');
            if (JSON.parse(raw).type === 'auth') socket.send(JSON.stringify({ type: 'ready', deviceId,
                currentKeyId: keyId, messages: [message(1, 'before refresh', otherId)], pairing: null }));
        });
    });
    const open = async page => {
        await page.goto('/chat/');
        await expect(page.locator('[data-sync-status]')).toHaveAttribute('data-state', 'online');
        await expect(page.locator('[data-sync-messages]')).toContainText('before refresh');
    };
    try {
        await open(page);
        await expect.poll(() => deviceRequests).toBe(1);
        const follower = await context.newPage();
        await open(follower);
        expect(sockets).toHaveLength(1);
        expect(keyRequests).toBe(1);
        hold = true;
        const before = deviceRequests;
        sockets[0].send(JSON.stringify({ type: 'devices' }));
        await expect.poll(() => deviceRequests).toBe(before + 1);
        sockets[0].send(JSON.stringify({ type: 'message', message: message(2, 'received during held request', otherId) }));
        for (const tab of [page, follower]) await expect(tab.locator('[data-sync-messages]')).toContainText('received during held request', { timeout: 2000 });
        expect(deviceRequests).toBe(before + 1);
        release();
        await expect(follower.locator('.sync-message-meta').last()).toContainText('Peer');
    } finally { release(); }
});
