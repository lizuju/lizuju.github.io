const { test, expect, roomId, deviceId, otherId, keyId, session, authorize } = require('./fixtures/sync-e2ee.cjs');
const { showSyncTools, hideSyncTools } = require('./fixtures/sync-tools.cjs');
const { createCipheriv, randomBytes } = require('node:crypto');
const { readFile } = require('node:fs/promises');
const path = require('node:path');

test.use({ serviceWorkers: 'block' });
const rooms = [roomId, '11111111-1111-4111-8111-111111111111'];
const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
const message = (room, id) => {
    const clientId = `reading-${id}`;
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', Buffer.from(session.keyring.keys[keyId], 'base64url'), iv);
    cipher.setAAD(Buffer.from(`gavin-sync-v1:${room}:message:${otherId}:${clientId}`));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify({ text: `Room ${rooms.indexOf(room) + 1} message ${id}: reading position survives switching spaces.` })), cipher.final(), cipher.getAuthTag()]);
    return { id, clientId, deviceId: otherId, createdAt: Date.now(), text: `e2ee1.${Buffer.from(JSON.stringify({ keyId, iv: iv.toString('base64url'), ciphertext: ciphertext.toString('base64url') })).toString('base64url')}` };
};
const open = async page => {
    await authorize(page);
    await page.route('**/__reading-setup__/*', async route => route.fulfill({ contentType: 'text/javascript',
        body: await readFile(path.join(__dirname, '../static/portfolio/js/apps', new URL(route.request().url()).pathname.split('/').at(-1)), 'utf8') }));
    await page.evaluate(async ({ rooms, session }) => {
        const { SavedSpaces } = await import('/__reading-setup__/sync-spaces.js');
        const spaces = new SavedSpaces();
        await spaces.importActive();
        await spaces.save({ ...session, roomId: rooms[1] }, { activate: true });
        await spaces.select(rooms[0]);
    }, { rooms, session });
    await page.route('**/portfolio/sync-config.json', route => route.fulfill({ json: { apiBase: 'https://sync.test' } }));
    await page.route('https://sync.test/**', route => route.fulfill({ status: route.request().method() === 'OPTIONS' ? 204 : 200,
        headers, json: { deviceId, devices: [], grants: [], hasMore: false, keyId } }));
    const sockets = new Map();
    await page.routeWebSocket('wss://sync.test/**', socket => {
        const room = new URL(socket.url()).pathname.split('/')[3];
        sockets.set(room, socket);
        socket.onMessage(raw => {
            if (raw === 'ping') return socket.send('pong');
            if (JSON.parse(raw).type === 'auth') socket.send(JSON.stringify({ type: 'ready', deviceId, pairing: null, readReceipts: [],
                messages: Array.from({ length: 50 }, (_, index) => message(room, index + 1)), historyMode: 'replace',
                history: { generation: '1', oldestId: 1, latestId: 50, continuationId: 50, hasNewer: false } }));
        });
    });
    await page.goto('/portfolio/');
    if (await page.locator('[data-window-action="minimize"]').isVisible()) await page.locator('[data-window-action="minimize"]').click();
    if (!await page.locator('[data-sync-window]').isVisible()) await page.locator('.desktop-shortcut[data-open-sync-space]').click();
    await expect(page.locator('.sync-message')).toHaveCount(50);
    await expect.poll(() => sockets.size).toBe(2);
    return {
        async select(room) {
            if (!await page.locator(`[data-sync-space-id="${room}"]`).isVisible()) await page.locator('[data-sync-spaces-toggle]').click();
            await page.locator(`[data-sync-space-id="${room}"]`).click();
            await expect(page.locator('[data-sync-space-title]')).toHaveText(`空间 ${rooms.indexOf(room) + 1}`);
            await expect(page.locator('[data-sync-status]')).toHaveAttribute('data-state', 'online');
        },
        add: (room, id) => sockets.get(room).send(JSON.stringify({ type: 'message', message: message(room, id),
            history: { generation: '1', oldestId: 1, latestId: id, continuationId: id, hasNewer: false } })),
        clear: room => sockets.get(room).send(JSON.stringify({ type: 'cleared', history: { generation: '2', oldestId: null, latestId: null, continuationId: null, hasNewer: false } }))
    };
};
const position = page => page.evaluate(() => {
    const top = document.querySelector('[data-sync-feed]').getBoundingClientRect().top;
    const node = [...document.querySelectorAll('.sync-message')].find(node => !node.hidden && node.getBoundingClientRect().bottom > top);
    return { text: node.querySelector('.sync-message-text').textContent, offset: node.getBoundingClientRect().top - top };
});
const expectPosition = async (page, saved) => {
    await expect.poll(async () => (await position(page)).text).toBe(saved.text);
    expect(Math.abs((await position(page)).offset - saved.offset)).toBeLessThanOrEqual(2);
};

test('keeps each space reading anchor, search query and pre-search position when messages arrive in the background', async ({ page }) => {
    const chat = await open(page);
    await page.locator('[data-sync-input]').fill('Unsent draft in the first space');
    await page.locator('[data-sync-feed]').evaluate(feed => { feed.scrollTop = feed.scrollHeight * 0.4; });
    const saved = await position(page);
    await chat.select(rooms[1]);
    chat.add(rooms[0], 51);
    await chat.select(rooms[0]);
    await expectPosition(page, saved);
    await expect(page.locator('[data-sync-input]')).toHaveValue('Unsent draft in the first space');
    await showSyncTools(page);
    await page.locator('[data-sync-search]').fill('message 1');
    await hideSyncTools(page);
    await expect(page.locator('.sync-message:visible')).toHaveCount(11);
    await page.locator('[data-sync-feed]').evaluate(feed => { feed.scrollTop = feed.scrollHeight * 0.3; });
    const searched = await position(page);
    await chat.select(rooms[1]);
    await expect(page.locator('[data-sync-search]')).toHaveValue('');
    await chat.select(rooms[0]);
    await expect(page.locator('[data-sync-search]')).toHaveValue('message 1');
    await expectPosition(page, searched);
    await page.locator('[data-sync-search-clear]').click();
    await expectPosition(page, saved);
});

test('does not restore the old reading view after the background space history is cleared', async ({ page }) => {
    const chat = await open(page);
    await showSyncTools(page);
    await page.locator('[data-sync-search]').fill('message 1');
    await hideSyncTools(page);
    await chat.select(rooms[1]);
    chat.clear(rooms[0]);
    await chat.select(rooms[0]);
    await expect(page.locator('.sync-message')).toHaveCount(0);
    await expect(page.locator('[data-sync-search]')).toHaveValue('');
    await expect(page.locator('[data-sync-feed]')).toHaveJSProperty('scrollTop', 0);
});

test('snapshot while restoring a space does not replace history with the empty transition view', async ({ page }) => {
    const chat = await open(page);
    await page.locator('[data-sync-input]').fill('First room draft');
    await page.locator('[data-sync-feed]').evaluate(feed => { feed.scrollTop = feed.scrollHeight * 0.4; });
    const saved = await position(page);
    await chat.select(rooms[1]);
    await page.evaluate(session => {
        const decrypt = crypto.subtle.decrypt.bind(crypto.subtle);
        crypto.subtle.decrypt = async (...args) => {
            const aad = new TextDecoder().decode(args[0].additionalData);
            if (aad === `gavin-sync-v1:${session.roomId}:draft:${session.deviceId}` && !window.__draftHeld) {
                window.__draftHeld = true;
                await new Promise(resolve => window.__releaseDraft = resolve);
            }
            return decrypt(...args);
        };
    }, session);
    const selection = chat.select(rooms[0]);
    await expect.poll(() => page.evaluate(() => window.__draftHeld)).toBe(true);
    await page.evaluate(async session => {
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${session.roomId}:${session.token}`));
        const key = `gavin-sync-connection:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`;
        window.__snapshotPeer = new BroadcastChannel(key);
        window.__snapshotFrames = [];
        window.__snapshotPeer.onmessage = event => window.__snapshotFrames.push(event.data);
        window.__snapshotPeer.postMessage({ type: 'hello', sender: 'reading-test-peer' });
    }, session);
    await expect.poll(() => page.evaluate(() => window.__snapshotFrames.some(frame => frame.type === 'welcome'))).toBe(true);
    const snapshotSize = await page.evaluate(() => window.__snapshotFrames.find(frame => frame.type === 'welcome').data.messages.length);
    await page.evaluate(() => { window.__releaseDraft(); window.__snapshotPeer.close(); });
    await selection;
    expect(snapshotSize).toBe(50);
    await expect(page.locator('.sync-message')).toHaveCount(50);
    await expectPosition(page, saved);
});
