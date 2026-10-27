const { test, expect, roomId, deviceId, otherId, keyId, session, authorize, allowSyncOrigin } = require('./fixtures/sync-e2ee.cjs');
const { createCipheriv, randomBytes } = require('node:crypto');
const { readFile } = require('node:fs/promises');
const path = require('node:path');

test.use({ serviceWorkers: 'block' });
const rooms = [roomId, '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Sync-Key-Id',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
const bounds = latestId => ({ generation: '1', oldestId: 1, latestId, continuationId: latestId, hasNewer: false });
const message = (room, id, sender = otherId) => {
    const clientId = `background-${id}`;
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', Buffer.from(session.keyring.keys[keyId], 'base64url'), iv);
    cipher.setAAD(Buffer.from(`gavin-sync-v1:${room}:message:${sender}:${clientId}`));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify({ text: `Room ${rooms.indexOf(room) + 1} message ${id}` })), cipher.final(), cipher.getAuthTag()]);
    return { id, clientId, deviceId: sender, createdAt: Date.now(), text: `e2ee1.${Buffer.from(JSON.stringify({
        keyId, iv: iv.toString('base64url'), ciphertext: ciphertext.toString('base64url')
    })).toString('base64url')}` };
};

const openChat = async (page, seed = true) => {
    await allowSyncOrigin(page, 'https://sync.test');
    await page.addInitScript(() => {
        window.notificationStarts = 0;
        class NotificationAudio extends EventTarget {
            constructor(src) { super(); this.src = src; this.currentTime = 0; this.muted = false; }
            async play() { if (!this.muted) window.notificationStarts++; }
            pause() {}
        }
        window.Audio = NotificationAudio;
    });
    await page.clock.install({ time: new Date('2026-10-27T00:00:00Z') });
    await page.clock.pauseAt(new Date('2026-10-27T00:00:01Z'));
    if (seed) {
        await authorize(page);
        await page.route('**/__background-setup__/*', async route => route.fulfill({ contentType: 'text/javascript',
            body: await readFile(path.join(__dirname, '../static/portfolio/js/apps', new URL(route.request().url()).pathname.split('/').at(-1)), 'utf8') }));
        await page.evaluate(async ({ rooms, session }) => {
            const { SavedSpaces } = await import('/__background-setup__/sync-spaces.js');
            const spaces = new SavedSpaces();
            await spaces.importActive();
            for (const roomId of rooms.slice(1)) await spaces.save({ ...session, roomId }, { activate: true });
            await spaces.select(rooms[0]);
        }, { rooms, session });
    }
    await page.route('**/portfolio/sync-config.json', route => route.fulfill({ json: { apiBase: 'https://sync.test' } }));
    await page.route('https://sync.test/**', route => route.request().method() === 'OPTIONS'
        ? route.fulfill({ status: 204, headers })
        : route.fulfill({ headers, json: { deviceId, devices: [], grants: [], hasMore: false, keyId } }));
    const sockets = new Map();
    const reads = [];
    await page.routeWebSocket('wss://sync.test/**', socket => {
        const room = new URL(socket.url()).pathname.split('/')[3];
        sockets.set(room, socket);
        socket.onMessage(raw => {
            if (raw === 'ping') return socket.send('pong');
            const frame = JSON.parse(raw);
            if (frame.type === 'auth') socket.send(JSON.stringify({ type: 'ready', deviceId, messages: [message(room, 1)],
                pairing: null, readReceipts: [], history: bounds(1), historyMode: 'replace' }));
            if (frame.type === 'read') reads.push({ room, id: frame.messageId });
        });
    });
    const open = async () => {
        sockets.clear();
        await page.goto('/portfolio/');
        await page.bringToFront();
        if (await page.locator('[data-window-action="minimize"]').isVisible()) await page.locator('[data-window-action="minimize"]').click();
        if (!await page.locator('[data-sync-window]').isVisible()) await page.locator('.desktop-shortcut[data-open-sync-space]').click();
        await expect(page.locator('[data-sync-status]')).toHaveAttribute('data-state', 'online');
        await expect.poll(() => sockets.size).toBe(3);
        await page.locator('[data-sync-input]').click();
        await page.clock.runFor(1000);
    };
    await open();
    const flush = async room => {
        await page.evaluate(({ room, deviceId }) => navigator.locks.request(`portfolio-sync-notification:${room}:${deviceId}`, () => {}), { room, deviceId });
    };
    return { open, reads, sockets, flush,
        starts: () => page.evaluate(() => window.notificationStarts),
        frame: (room, data) => sockets.get(room).send(JSON.stringify(data)),
        send: (room, id, sender = otherId) => sockets.get(room).send(JSON.stringify({ type: 'message', message: message(room, id, sender), history: bounds(id) }))
    };
};

test('connects all saved spaces after reload and sounds for unread live messages without changing the active room', async ({ page }) => {
    const chat = await openChat(page);
    expect(await chat.starts()).toBe(0);
    chat.send(rooms[1], 2);
    await expect.poll(chat.starts).toBe(1);
    chat.send(rooms[2], 2);
    await expect.poll(chat.starts).toBe(2);
    await expect(page.locator('[data-sync-space-title]')).toHaveText('空间 1');
    await expect(page.locator('.sync-message-text')).toHaveText('Room 1 message 1');
    expect(chat.reads.some(item => item.room !== roomId)).toBe(false);
    chat.send(rooms[1], 2);
    chat.send(rooms[1], 3, deviceId);
    chat.frame(rooms[1], { type: 'history', messages: [message(rooms[1], 4)], historyMode: 'append', history: bounds(4) });
    await chat.flush(rooms[1]);
    await page.clock.runFor(1000);
    expect(await chat.starts()).toBe(2);
    await page.locator('[data-sync-sound]').click();
    chat.send(rooms[2], 3);
    await page.clock.runFor(1000);
    await chat.flush(rooms[2]);
    expect(await chat.starts()).toBe(2);
    await page.locator('[data-sync-sound]').click();
    await chat.open();
    expect(await chat.starts()).toBe(0);
    chat.send(rooms[2], 5);
    await expect.poll(chat.starts).toBe(1);
    await expect(page.locator('[data-sync-space-title]')).toHaveText('空间 1');
    expect(chat.reads.some(item => item.room !== roomId)).toBe(false);
});

test('deduplicates background notifications across tabs and keeps them active while switching spaces', async ({ page, context }) => {
    const first = await openChat(page);
    const otherPage = await context.newPage();
    const second = await openChat(otherPage, false);
    const starts = async () => (await first.starts()) + (await second.starts());
    first.send(rooms[2], 2);
    second.send(rooms[2], 2);
    await expect.poll(starts).toBe(1);
    await page.bringToFront();
    if (!await page.locator(`[data-sync-space-id="${rooms[1]}"]`).isVisible()) await page.locator('[data-sync-spaces-toggle]').click();
    await page.locator(`[data-sync-space-id="${rooms[1]}"]`).click();
    await expect(page.locator('[data-sync-space-title]')).toHaveText('空间 2');
    await expect(otherPage.locator('[data-sync-space-title]')).toHaveText('空间 2');
    await page.clock.runFor(1000);
    await otherPage.clock.runFor(1000);
    first.send(rooms[2], 3);
    second.send(rooms[2], 3);
    await expect.poll(starts).toBe(2);
    expect(first.reads.some(item => item.room === rooms[2])).toBe(false);
    expect(second.reads.some(item => item.room === rooms[2])).toBe(false);
    await otherPage.close();
});
