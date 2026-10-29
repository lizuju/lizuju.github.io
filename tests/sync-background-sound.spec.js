const { test, expect, roomId, deviceId, otherId, keyId, session, authorize, allowSyncOrigin } = require('./fixtures/sync-e2ee.cjs');
const { showSyncTools, hideSyncTools } = require('./fixtures/sync-tools.cjs');
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

const servers = new WeakMap();
const openChat = async (page, seed = true) => {
    if (!servers.has(page.context())) servers.set(page.context(), { sockets: new Map(), reads: [], openings: 0 });
    const server = servers.get(page.context());
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
    const { sockets, reads } = server;
    await page.routeWebSocket('wss://sync.test/**', socket => {
        const room = new URL(socket.url()).pathname.split('/')[3];
        sockets.set(room, socket);
        server.openings++;
        socket.onMessage(raw => {
            if (raw === 'ping') return socket.send('pong');
            const frame = JSON.parse(raw);
            if (frame.type === 'auth' && !server.holdReady) socket.send(JSON.stringify({ type: 'ready', deviceId, messages: [message(room, 1)],
                pairing: null, readReceipts: [], history: bounds(1), historyMode: 'replace' }));
            if (frame.type === 'read') reads.push({ room, id: frame.messageId });
        });
    });
    const open = async () => {
        const previous = server.openings;
        await page.goto('/portfolio/');
        await page.bringToFront();
        if (await page.locator('[data-window-action="minimize"]').isVisible()) await page.locator('[data-window-action="minimize"]').click();
        if (!await page.locator('[data-sync-window]').isVisible()) await page.locator('.desktop-shortcut[data-open-sync-space]').click();
        await expect(page.locator('[data-sync-status]')).toHaveAttribute('data-state', 'online');
        await expect.poll(() => sockets.size).toBe(3);
        if (seed) await expect.poll(() => server.openings).toBe(previous + 3);
        await hideSyncTools(page);
        if (await page.locator('[data-sync-spaces-toggle]').getAttribute('aria-expanded') === 'true') {
            await page.locator('[data-sync-spaces-toggle]').click();
        }
        await page.locator('[data-sync-input]').click();
        await page.clock.runFor(1000);
    };
    await open();
    const flush = async room => {
        await page.evaluate(({ room, deviceId }) => navigator.locks.request(`portfolio-sync-notification:${room}:${deviceId}`, () => {}), { room, deviceId });
    };
    return { open, reads, sockets, flush, holdReady: value => { server.holdReady = value; }, openings: () => server.openings,
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
    await showSyncTools(page);
    await page.locator('[data-sync-sound]').click();
    chat.send(rooms[2], 3);
    await page.clock.runFor(1000);
    await chat.flush(rooms[2]);
    expect(await chat.starts()).toBe(2);
    await showSyncTools(page);
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
    expect(second.openings()).toBe(3);
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


test('shows only the most important space dot and restores unread green after a background reconnect', async ({ page }) => {
    const chat = await openChat(page);
    const button = page.locator(`[data-sync-space-id="${rooms[1]}"]`);
    const dot = button.locator('[data-sync-space-unread]');
    if (!await button.isVisible()) await page.locator('[data-sync-spaces-toggle]').click();
    chat.send(rooms[1], 2);
    await expect(dot).toHaveAttribute('data-state', 'green');
    await expect(dot).toHaveCount(1);
    chat.holdReady(true);
    chat.sockets.get(rooms[1]).close({ code: 1001, reason: 'test disconnect' });
    await expect(dot).toHaveAttribute('data-state', 'red');
    await expect(button).toHaveAttribute('title', '空间 2（连接已断开，正在重连）');
    await expect(page.locator('[data-sync-spaces-toggle]')).toHaveAttribute('data-state', 'red');
    await page.clock.runFor(2000);
    await expect.poll(chat.openings).toBe(4);
    await expect(dot).toHaveAttribute('data-state', 'red');
    chat.frame(rooms[1], { type: 'ready', deviceId, messages: [message(rooms[1], 1), message(rooms[1], 2)],
        pairing: null, readReceipts: [], history: bounds(2), historyMode: 'replace' });
    await expect(dot).toHaveAttribute('data-state', 'green');
    await expect(page.locator('[data-sync-spaces-toggle]')).toHaveAttribute('data-state', 'green');
    await expect(page.locator('[data-sync-space-title]')).toHaveText('空间 1');
});

test('keeps a failed-send red dot above unread green after switching spaces and refreshing', async ({ page }) => {
    const chat = await openChat(page);
    await page.route('https://sync.test/**/messages', route => route.fulfill({ status: 503, headers, json: { error: 'unavailable' } }));
    await page.locator('[data-sync-input]').fill('A failed outgoing message');
    await page.locator('[data-sync-send]').click();
    await expect(page.locator('.sync-message[data-state="failed"]')).toHaveCount(1);
    const failedRoom = page.locator(`[data-sync-space-id="${rooms[0]}"]`);
    if (!await failedRoom.isVisible()) await page.locator('[data-sync-spaces-toggle]').click();
    await expect(failedRoom.locator('[data-sync-space-unread]')).toHaveAttribute('data-state', 'red');
    await page.locator(`[data-sync-space-id="${rooms[1]}"]`).click();
    await expect(page.locator('[data-sync-space-title]')).toHaveText('空间 2');
    chat.send(rooms[0], 2);
    await expect(failedRoom.locator('[data-sync-space-unread]')).toHaveCount(1);
    await expect(failedRoom.locator('[data-sync-space-unread]')).toHaveAttribute('data-state', 'red');
    await expect(failedRoom).toHaveAttribute('title', '空间 1（消息发送失败）');
    await chat.open();
    await expect(page.locator('[data-sync-space-title]')).toHaveText('空间 2');
    await expect(failedRoom.locator('[data-sync-space-unread]')).toHaveAttribute('data-state', 'red');
});

test('flushes encrypted offline text after switching to another saved space', async ({ page }) => {
    const chat = await openChat(page);
    const sent = [];
    await page.route('https://sync.test/**/messages', async route => {
        if (route.request().method() !== 'POST') return route.fulfill({ status: 204, headers });
        const body = route.request().postDataJSON();
        sent.push(body);
        await route.fulfill({ headers, json: { id: 2, clientId: body.clientId, deviceId, text: body.text, createdAt: Date.now() } });
    });
    chat.holdReady(true);
    chat.sockets.get(rooms[0]).close({ code: 1001 });
    await expect(page.locator('[data-sync-status]')).not.toHaveAttribute('data-state', 'online');
    await page.locator('[data-sync-input]').fill('Background queued text');
    await page.locator('[data-sync-send]').click();
    await expect(page.locator('.sync-message[data-state="queued"]')).toHaveCount(1);
    await page.locator('[data-sync-spaces-toggle]').click();
    await page.locator(`[data-sync-space-id="${rooms[1]}"]`).click();
    await expect(page.locator('[data-sync-space-title]')).toHaveText('空间 2');
    await page.clock.runFor(2000);
    chat.frame(rooms[0], { type: 'ready', deviceId, messages: [message(rooms[0], 1)], historyMode: 'replace', history: bounds(1) });
    await expect.poll(() => sent.length).toBe(1);
    if (!await page.locator(`[data-sync-space-id="${rooms[0]}"]`).isVisible()) await page.locator('[data-sync-spaces-toggle]').click();
    await page.locator(`[data-sync-space-id="${rooms[0]}"]`).click();
    await expect(page.locator('.sync-message-text').last()).toHaveText('Background queued text');
    await expect(page.locator('.sync-message[data-state="queued"]')).toHaveCount(0);
    expect(JSON.stringify(sent)).not.toContain('Background queued text');
});

test('keeps the send lock and newer draft when returning to a space with an in-flight queued message', async ({ page }) => {
    const chat = await openChat(page);
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    let submitted;
    await page.route('https://sync.test/**/messages', async route => {
        if (route.request().method() !== 'POST') return route.fulfill({ status: 204, headers });
        submitted = route.request().postDataJSON();
        await pending;
        await route.fulfill({ headers, json: { id: 2, clientId: submitted.clientId, deviceId, text: submitted.text, createdAt: Date.now() } });
    });
    try {
        chat.holdReady(true);
        chat.sockets.get(rooms[0]).close({ code: 1001 });
        await expect(page.locator('[data-sync-status]')).not.toHaveAttribute('data-state', 'online');
        await page.locator('[data-sync-input]').fill('Waiting background message');
        await page.locator('[data-sync-send]').click();
        await expect(page.locator('.sync-message[data-state="queued"]')).toHaveCount(1);
        await page.locator('[data-sync-spaces-toggle]').click();
        await page.locator(`[data-sync-space-id="${rooms[1]}"]`).click();
        await expect(page.locator('[data-sync-space-title]')).toHaveText('空间 2');
        await page.clock.runFor(2000);
        chat.frame(rooms[0], { type: 'ready', deviceId, messages: [message(rooms[0], 1)], historyMode: 'replace', history: bounds(1) });
        await expect.poll(() => submitted).toBeTruthy();
        if (!await page.locator(`[data-sync-space-id="${rooms[0]}"]`).isVisible()) await page.locator('[data-sync-spaces-toggle]').click();
        await page.locator(`[data-sync-space-id="${rooms[0]}"]`).click();
        await expect(page.locator('.sync-message[data-state="sending"]')).toHaveCount(1);
        await page.locator('[data-sync-input]').fill('Newer unsent draft');
        await expect(page.locator('[data-sync-send]')).toBeDisabled();
        release();
        await expect(page.locator('.sync-message-text').last()).toHaveText('Waiting background message');
        await expect(page.locator('.sync-message[data-state="sending"]')).toHaveCount(0);
        await expect(page.locator('[data-sync-send]')).toBeEnabled();
        await expect(page.locator('[data-sync-input]')).toHaveValue('Newer unsent draft');
        chat.holdReady(false);
        await chat.open();
        await expect(page.locator('[data-sync-input]')).toHaveValue('Newer unsent draft');
        await expect(page.locator('.sync-message[data-state="queued"]')).toHaveCount(0);
    } finally { release(); }
});
