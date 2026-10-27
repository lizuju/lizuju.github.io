const { test, expect, roomId, deviceId, otherId, keyId, session, authorize, allowSyncOrigin } = require('./fixtures/sync-e2ee.cjs');
const { createCipheriv, randomBytes } = require('node:crypto');
const { readFile } = require('node:fs/promises');
const path = require('node:path');

test.use({ serviceWorkers: 'block' });
const rooms = [roomId, '11111111-1111-4111-8111-111111111111'];
const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
const bounds = latestId => ({ generation: '1', oldestId: 1, latestId, continuationId: latestId, hasNewer: false });
const encrypt = (room, purpose, value) => {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', Buffer.from(session.keyring.keys[keyId], 'base64url'), iv);
    cipher.setAAD(Buffer.from(`gavin-sync-v1:${room}:${purpose}`));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final(), cipher.getAuthTag()]);
    return `e2ee1.${Buffer.from(JSON.stringify({ keyId, iv: iv.toString('base64url'), ciphertext: ciphertext.toString('base64url') })).toString('base64url')}`;
};
const message = (room, id) => ({ id, clientId: `recovery-${id}`, deviceId: otherId, createdAt: Date.now(),
    text: encrypt(room, `message:${otherId}:recovery-${id}`, { text: `Room ${rooms.indexOf(room) + 1} message ${id}` }) });
const messages = (room, first, last) => Array.from({ length: last - first + 1 }, (_, index) => message(room, first + index));
const openChat = async page => {
    await allowSyncOrigin(page, 'https://sync.test');
    await page.clock.install({ time: new Date('2026-10-27T00:00:00Z') });
    await page.clock.pauseAt(new Date('2026-10-27T00:00:01Z'));
    await authorize(page);
    await page.route('**/__recovery-setup__/*', async route => route.fulfill({ contentType: 'text/javascript',
        body: await readFile(path.join(__dirname, '../static/portfolio/js/apps', new URL(route.request().url()).pathname.split('/').at(-1)), 'utf8') }));
    await page.evaluate(async ({ rooms, session }) => {
        const { SavedSpaces } = await import('/__recovery-setup__/sync-spaces.js');
        const spaces = new SavedSpaces();
        await spaces.importActive();
        await spaces.save({ ...session, roomId: rooms[1] }, { activate: true });
        await spaces.select(rooms[0]);
    }, { rooms, session });
    await page.route('**/portfolio/sync-config.json', route => route.fulfill({ json: { apiBase: 'https://sync.test' } }));
    const deviceRequests = [];
    let otherName = 'Alice';
    await page.route('https://sync.test/**', route => {
        const request = route.request();
        if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
        const url = new URL(request.url());
        const room = url.pathname.split('/')[3];
        if (url.pathname.endsWith('/devices')) {
            deviceRequests.push(room);
            return route.fulfill({ headers, json: { deviceId, devices: [deviceId, otherId].map(id => ({ deviceId: id, createdAt: Date.now(),
                name: encrypt(room, `device:${id}`, { name: id === deviceId ? 'My Mac' : otherName, publicKey: session.trustedDevices[id] }) })) } });
        }
        return route.fulfill({ headers, json: { deviceId, devices: [], grants: [], hasMore: false, keyId } });
    });
    const sockets = new Map();
    const ready = new Map(rooms.map(room => [room, { messages: [message(room, 1)], history: bounds(1), historyMode: 'replace' }]));
    const connections = [];
    await page.routeWebSocket('wss://sync.test/**', socket => {
        const room = new URL(socket.url()).pathname.split('/')[3];
        sockets.set(room, socket);
        connections.push({ room, url: socket.url() });
        socket.onMessage(raw => {
            if (raw === 'ping') return socket.send('pong');
            if (JSON.parse(raw).type === 'auth') socket.send(JSON.stringify({ type: 'ready', deviceId, pairing: null, readReceipts: [], ...ready.get(room) }));
        });
    });
    await page.goto('/portfolio/');
    if (await page.locator('[data-window-action="minimize"]').isVisible()) await page.locator('[data-window-action="minimize"]').click();
    if (!await page.locator('[data-sync-window]').isVisible()) await page.locator('.desktop-shortcut[data-open-sync-space]').click();
    await expect(page.locator('[data-sync-status]')).toHaveAttribute('data-state', 'online');
    await expect.poll(() => sockets.size).toBe(2);
    await expect(page.locator('.sync-message-meta span:first-child')).toContainText('Alice');
    await page.clock.runFor(1000);
    return {
        deviceRequests, connections, ready, rename: name => { otherName = name; },
        async switchRoom(room) {
            if (!await page.locator(`[data-sync-space-id="${room}"]`).isVisible()) await page.locator('[data-sync-spaces-toggle]').click();
            await page.locator(`[data-sync-space-id="${room}"]`).click();
            await expect(page.locator('[data-sync-space-title]')).toHaveText(`空间 ${rooms.indexOf(room) + 1}`);
            await expect(page.locator('[data-sync-status]')).toHaveAttribute('data-state', 'online');
        },
        async reconnect(room, snapshot) {
            ready.set(room, snapshot);
            const previous = sockets.get(room);
            previous.close({ code: 1000 });
            await page.clock.runFor(2000);
            await expect.poll(() => sockets.get(room) !== previous).toBe(true);
            await page.clock.runFor(1000);
        },
        async live(room, id, metadata = {}) {
            sockets.get(room).send(JSON.stringify({ type: 'message', message: message(room, id), history: { generation: '1', oldestId: 1, latestId: id, ...metadata } }));
            await page.clock.runFor(1000);
        }
    };
};
const backlog = room => ({ messages: messages(room, 2, 51), historyMode: 'append', history: { ...bounds(80), continuationId: 51, hasNewer: true } });

test('fills the background reconnect gap even after a newer live message arrives', async ({ page }) => {
    const chat = await openChat(page);
    const room = rooms[1];
    const cursors = [];
    await page.route('https://sync.test/**/messages?*', route => {
        cursors.push(new URL(route.request().url()).searchParams.get('after'));
        return route.fulfill({ headers, json: { messages: messages(room, 52, 81), historyMode: 'append', history: bounds(81) } });
    });
    await chat.reconnect(room, backlog(room));
    await chat.live(room, 81);
    await chat.switchRoom(room);
    await expect(page.locator('.sync-message-text')).toHaveText(messages(room, 1, 81).map((_, index) => `Room 2 message ${index + 1}`));
    expect(cursors).toEqual(['51']);
    await chat.switchRoom(rooms[0]);
    await chat.switchRoom(room);
    expect(cursors).toEqual(['51']);
});

test('keeps a pending catch-up gap when live messages arrive and the user switches away', async ({ page }) => {
    const chat = await openChat(page);
    const room = rooms[1];
    const cursors = [];
    let release;
    const held = new Promise(resolve => { release = resolve; });
    await page.route('https://sync.test/**/messages?*', async route => {
        cursors.push(new URL(route.request().url()).searchParams.get('after'));
        if (cursors.length === 1) await held;
        await route.fulfill({ headers, json: { messages: messages(room, 52, 82), historyMode: 'append', history: bounds(82) } }).catch(() => {});
    });
    try {
        await chat.reconnect(room, backlog(room));
        await chat.live(room, 81);
        await chat.switchRoom(room);
        await expect.poll(() => cursors.length).toBe(1);
        await chat.live(room, 82);
        await expect(page.locator('.sync-message-text').last()).toHaveText('Room 2 message 82');
        await chat.switchRoom(rooms[0]);
        await chat.switchRoom(room);
        await expect(page.locator('.sync-message-text')).toHaveCount(82);
        await expect(page.locator('.sync-message-text').nth(51)).toHaveText('Room 2 message 52');
        expect(cursors).toEqual(['51', '51']);
    } finally { release(); }
});

test('replaces a background gap with the latest snapshot when retention changes its generation', async ({ page }) => {
    const chat = await openChat(page);
    const room = rooms[1];
    const queries = [];
    const snapshot = { messages: messages(room, 452, 501), historyMode: 'replace', history: { ...bounds(501), generation: '2', oldestId: 2, hasMore: true } };
    await page.route('https://sync.test/**/messages?*', route => {
        const query = new URL(route.request().url()).searchParams;
        queries.push({ after: query.get('after'), generation: query.get('generation') });
        return route.fulfill({ headers, json: snapshot });
    });
    await chat.reconnect(room, { ...backlog(room), history: { ...backlog(room).history, latestId: 500 } });
    await chat.live(room, 501, { generation: '2', oldestId: 2 });
    await chat.switchRoom(room);
    await expect(page.locator('.sync-message-text')).toHaveCount(50);
    await expect(page.locator('.sync-message-text').first()).toHaveText('Room 2 message 452');
    await expect(page.locator('.sync-message-text').last()).toHaveText('Room 2 message 501');
    expect(queries).toEqual([{ after: '51', generation: '1' }]);
});

test('reconnects an active catch-up using its continuous cursor after retention changes', async ({ page }) => {
    const chat = await openChat(page);
    const room = rooms[1];
    let release;
    const held = new Promise(resolve => { release = resolve; });
    let pending = false;
    await page.route('https://sync.test/**/messages?*', async route => {
        pending = true;
        await held;
        await route.fulfill({ headers, json: { messages: messages(room, 52, 80), historyMode: 'append', history: bounds(80) } }).catch(() => {});
    });
    try {
        await chat.reconnect(room, { ...backlog(room), history: { ...backlog(room).history, latestId: 500 } });
        await chat.switchRoom(room);
        await expect.poll(() => pending).toBe(true);
        chat.ready.set(room, { messages: messages(room, 452, 501), historyMode: 'replace', history: { ...bounds(501), generation: '2', oldestId: 2, hasMore: true } });
        await chat.live(room, 501, { generation: '2', oldestId: 2 });
        await page.clock.runFor(2000);
        await expect.poll(() => chat.connections.length).toBe(4);
        const reconnect = new URL(chat.connections.at(-1).url);
        expect(reconnect.searchParams.get('after')).toBe('51');
        expect(reconnect.searchParams.get('generation')).toBe('1');
        await expect(page.locator('.sync-message-text')).toHaveCount(50);
        await expect(page.locator('.sync-message-text').first()).toHaveText('Room 2 message 452');
        await expect(page.locator('.sync-message-text').last()).toHaveText('Room 2 message 501');
    } finally { release(); }
});

test('loads members on first background-room entry, reuses the cache, and refreshes after reconnect', async ({ page }) => {
    const chat = await openChat(page);
    const room = rooms[1];
    expect(chat.deviceRequests).toEqual([rooms[0]]);
    await chat.switchRoom(room);
    await expect(page.locator('.sync-message-meta span:first-child')).toContainText('Alice');
    await page.locator('[data-sync-input]').fill('@');
    await expect(page.locator('[data-sync-mention-device]')).toHaveText('Alice设备 2');
    expect(chat.deviceRequests).toEqual(rooms);
    await chat.switchRoom(rooms[0]);
    await chat.switchRoom(room);
    expect(chat.deviceRequests).toEqual(rooms);
    await chat.switchRoom(rooms[0]);
    chat.rename('Bob');
    await chat.reconnect(room, { messages: [message(room, 1)], history: bounds(1), historyMode: 'replace' });
    await chat.switchRoom(room);
    await expect(page.locator('.sync-message-meta span:first-child')).toContainText('Bob');
    await page.locator('[data-sync-input]').fill('@');
    await expect(page.locator('[data-sync-mention-device]')).toHaveText('Bob设备 2');
    expect(chat.deviceRequests).toEqual([rooms[0], room, room]);
});
