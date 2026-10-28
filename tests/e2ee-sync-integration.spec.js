const { test, expect } = require('@playwright/test');
const { Miniflare } = require('../cloudflare/sync/node_modules/miniflare');
const { createServer, request: httpRequest } = require('node:http');
const { readFile, writeFile } = require('node:fs/promises');
const path = require('node:path');
const XLSX = require('xlsx');

const root = path.resolve(__dirname, '..');
const siteOrigin = 'http://127.0.0.1:3094';
const apiOrigin = 'http://127.0.0.1:8793';
const wireBodies = [];
const messageBodies = [];
let runtime;
let site;
let api;
let interceptApi;
const upgradedSockets = new Set();
let pdf;
let mp4;
const sentText = 'private-message-只在设备端解密';
const renamed = '机密设备名';
const renamedText = 'message-from-renamed-private-device';
const laterText = 'after-revocation-新密钥专用';
const text = Buffer.from('This confidential attachment stays encrypted at rest. 私密附件。');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aC1kAAAAASUVORK5CYII=', 'base64');
const gif = Buffer.from('R0lGODlhAQABAIAAAP8AAAAA/yH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACwAAAAAAQABAAACAkQBACH5BAAKAAAALAAAAAABAAEAAAICTAEAOw==', 'base64');
const book = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['Private sheet', 'Value'], ['confidential-workbook-cell', 12345]]), 'Private');
const xlsx = XLSX.write(book, { type: 'buffer', bookType: 'xlsx', compression: true });

test.beforeEach(async () => {
    wireBodies.length = 0;
    messageBodies.length = 0;
    interceptApi = null;
    [pdf, mp4] = await Promise.all([
        readFile(path.join(root, 'static/portfolio/assets/li-zuju-resume.pdf')),
        readFile(path.join(root, 'static/textures/monitor/video/base-static.mp4'))
    ]);
    runtime = new Miniflare({
        host: '127.0.0.1', port: 8794,
        workers: [{ config: {
            name: 'sync-browser-e2ee', compatibilityDate: '2026-10-23',
            manifest: { mainModule: 'index.js', modules: {
                'index.js': { type: 'esm', contents: await readFile(path.join(root, 'cloudflare/sync/src/index.js'), 'utf8') },
                'daily-usage.js': { type: 'esm', contents: await readFile(path.join(root, 'cloudflare/sync/src/daily-usage.js'), 'utf8') },
                'api-version.js': { type: 'esm', contents: await readFile(path.join(root, 'cloudflare/sync/src/api-version.js'), 'utf8') }
            } },
            env: {
                ALLOWED_ORIGINS: { type: 'text', value: siteOrigin },
                E2EE_PAIRING_REGISTRY: { type: 'durable-object', worker: 'sync-browser-e2ee', exportName: 'E2eePairingRegistry' },
                E2EE_SYNC_ROOMS: { type: 'durable-object', worker: 'sync-browser-e2ee', exportName: 'E2eeSyncRoom' },
                E2EE_FILE_SHARDS: { type: 'durable-object', worker: 'sync-browser-e2ee', exportName: 'E2eeFileShard' }
            },
            exports: Object.fromEntries(['E2eePairingRegistry', 'E2eeSyncRoom', 'E2eeFileShard'].map(name => [name, { type: 'durable-object', storage: 'sqlite' }]))
        } }]
    });
    await runtime.ready;
    api = createServer(async (incoming, outgoing) => {
        try {
            const chunks = [];
            for await (const chunk of incoming) chunks.push(chunk);
            const body = Buffer.concat(chunks);
            const controller = new AbortController();
            outgoing.on('close', () => { if (!outgoing.writableEnded) controller.abort(); });
            const request = new Request(new URL(incoming.url, apiOrigin), {
                method: incoming.method, headers: incoming.headers, signal: controller.signal,
                ...(!['GET', 'HEAD'].includes(incoming.method) ? { body } : {})
            });
            if (body.length) wireBodies.push(body);
            if (incoming.method === 'POST' && /\/messages$/.test(incoming.url)) messageBodies.push(JSON.parse(body.toString()));
            const forward = () => runtime.dispatchFetch(request.url, {
                method: request.method, headers: incoming.headers,
                ...(!['GET', 'HEAD'].includes(request.method) ? { body } : {})
            });
            const intercepted = await interceptApi?.(request, forward);
            if (intercepted === false) { outgoing.destroy(); return; }
            const response = intercepted || await forward();
            outgoing.writeHead(response.status, Object.fromEntries(response.headers));
            outgoing.end(Buffer.from(await response.arrayBuffer()));
        } catch { outgoing.destroy(); }
    });
    api.on('upgrade', (request, socket, head) => {
        const upstream = httpRequest(new URL(request.url, 'http://127.0.0.1:8794'), { headers: request.headers });
        upstream.on('upgrade', (response, peer, upstreamHead) => {
            for (const connection of [socket, peer]) {
                upgradedSockets.add(connection);
                connection.on('close', () => upgradedSockets.delete(connection));
                connection.on('error', () => { socket.destroy(); peer.destroy(); });
            }
            socket.write(`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n${Object.entries(response.headers).map(([key, value]) => `${key}: ${value}`).join('\r\n')}\r\n\r\n`);
            if (head.length) peer.write(head);
            if (upstreamHead.length) socket.write(upstreamHead);
            socket.pipe(peer).pipe(socket);
        });
        upstream.on('error', () => socket.destroy());
        upstream.end();
    });
    await new Promise(resolve => api.listen(8793, '127.0.0.1', resolve));
    site = createServer(async (request, response) => {
        try {
            const url = new URL(request.url, siteOrigin);
            if (['/portfolio/sync-config.json', '/chat/sync-config.json'].includes(url.pathname)) {
                response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
                response.end(JSON.stringify({ apiBase: apiOrigin }));
                return;
            }
            const file = path.resolve(root, 'docs', `.${decodeURIComponent(url.pathname)}`, url.pathname.endsWith('/') ? 'index.html' : '');
            if (!file.startsWith(path.join(root, 'docs') + path.sep)) { response.writeHead(404); response.end(); return; }
            let content = await readFile(file);
            if (path.extname(file) === '.html') {
                const { apiBase } = require('../static/portfolio/sync-config.json');
                content = Buffer.from(content.toString()
                    .replaceAll(apiBase, apiOrigin)
                    .replaceAll(apiBase.replace(/^http/, 'ws'), apiOrigin.replace(/^http/, 'ws')));
            }
            const types = { '.html': 'text/html', '.js': 'application/javascript', '.mjs': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp' };
            response.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
            response.end(content);
        } catch { response.writeHead(404); response.end(); }
    });
    await new Promise(resolve => site.listen(3094, '127.0.0.1', resolve));
});
test.afterEach(async () => {
    if (site) { site.closeAllConnections(); await new Promise(resolve => site.close(resolve)); }
    upgradedSockets.forEach(socket => socket.destroy());
    if (api) { api.closeAllConnections(); await new Promise(resolve => api.close(resolve)); }
    await runtime?.dispose();
});

const openApp = async page => {
    await page.goto(`${siteOrigin}/portfolio/`);
    if (await page.locator('[data-window-action="minimize"]').isVisible()) await page.locator('[data-window-action="minimize"]').click();
    await page.locator('[data-open-sync-space]').first().click();
};
const awaitOnline = page => expect(page.locator('[data-sync-status]')).toHaveAttribute('data-state', 'online', { timeout: 30000 });
const sendText = async (page, text) => {
    await page.locator('[data-sync-input]').fill(text);
    await page.locator('[data-sync-send]').click();
    await expect(page.locator('[data-sync-input]')).toHaveValue('');
};
const readSession = (page, roomId) => page.evaluate(async roomId => {
    const descriptor = roomId
        ? JSON.parse(localStorage.getItem('portfolio-sync-spaces-e2ee1')).find(space => space.roomId === roomId)
        : JSON.parse(localStorage.getItem('portfolio-sync-space-e2ee1'));
    const database = await new Promise((resolve, reject) => {
        const request = indexedDB.open('gavin-sync-key-vault', 1);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
    const saved = await new Promise((resolve, reject) => {
        const request = database.transaction('sessions').objectStore('sessions').get(descriptor.vaultId);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
    database.close();
    const bytes = text => Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), byte => byte.charCodeAt(0));
    const opened = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes(saved.encrypted.iv), additionalData: new TextEncoder().encode(`gavin-sync-vault-v1:${descriptor.vaultId}`) }, saved.key, bytes(saved.encrypted.ciphertext));
    return JSON.parse(new TextDecoder().decode(opened));
}, roomId);

const watchSpaceConnections = page => {
    const connections = [];
    page.on('websocket', socket => {
        const match = new URL(socket.url()).pathname.match(/^\/v1\/spaces\/([^/]+)\/socket$/);
        if (!match) return;
        const connection = { socket, roomId: match[1], auth: 0, ready: 0, frames: [], sent: [] };
        connections.push(connection);
        socket.on('framesent', ({ payload }) => {
            if (payload.toString() === 'ping') return;
            const frame = JSON.parse(payload.toString());
            if (frame.type === 'auth') connection.auth++;
            connection.sent.push(frame);
        });
        socket.on('framereceived', ({ payload }) => {
            if (payload.toString() === 'pong') return;
            const frame = JSON.parse(payload.toString());
            if (frame.type === 'ready') connection.ready++;
            connection.frames.push(frame);
        });
    });
    return connections;
};

const expandSpaces = async page => {
    const toggle = page.locator('[data-sync-spaces-toggle]');
    if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
    await expect(page.locator('[data-sync-spaces-panel]')).toBeVisible();
};

const selectSpace = async (page, roomId) => {
    await expandSpaces(page);
    await page.locator(`[data-sync-space-id="${roomId}"]`).click();
    await expect.poll(async () => (await readSession(page)).roomId).toBe(roomId);
    await awaitOnline(page);
};

test('switches saved spaces without mixing history, drafts, replies or selected files and restores the active space', async ({ page, isMobile, browserName }, testInfo) => {
    test.setTimeout(60000);
    const connections = watchSpaceConnections(page);
    const historyRequests = [];
    page.on('request', request => {
        if (request.method() === 'GET' && /\/messages$/.test(new URL(request.url()).pathname)) historyRequests.push(request.url());
    });
    if (browserName === 'chromium') await page.context().grantPermissions(['local-network-access']);
    await page.goto(`${siteOrigin}/chat/`);
    await page.locator('[data-sync-create]').click();
    await awaitOnline(page);
    const first = await readSession(page);
    await page.evaluate(() => localStorage.removeItem('portfolio-sync-spaces-e2ee1'));
    await page.reload();
    await awaitOnline(page);
    expect((await readSession(page)).vaultId).toBe(first.vaultId);
    await expandSpaces(page);
    await expect(page.locator('[data-sync-space-list] [data-sync-space-id]')).toHaveCount(1);
    await expect(page.locator(`[data-sync-space-id="${first.roomId}"]`)).toHaveCount(1);
    await page.locator('[data-sync-spaces-toggle]').click();
    const firstText = 'first-space-private-message';
    const firstDraft = 'first-space-unsent-draft';
    const secondText = 'second-space-private-message';
    const secondDraft = 'second-space-unsent-draft';
    const selected = { name: 'first-space-selected.txt', mimeType: 'text/plain', buffer: Buffer.from('first-space-only-file') };
    await sendText(page, firstText);
    const firstMessage = page.locator('.sync-message').filter({ hasText: firstText });
    await expect(firstMessage).toHaveCount(1);
    await firstMessage.locator('[data-sync-reply-message]').click();
    await page.locator('[data-sync-input]').fill(firstDraft);
    await page.locator('[data-sync-file-input]').setInputFiles(selected);

    await expandSpaces(page);
    await page.locator('[data-sync-add-space]').click();
    await expect(page.locator('[data-sync-setup]')).toBeVisible();
    await page.locator('[data-sync-back-space]').click();
    await expect(page.locator('[data-sync-input]')).toHaveValue(firstDraft);
    await expect(page.locator('[data-sync-reply-text]')).toHaveText(firstText);
    await expect(page.locator('[data-sync-file-name]')).toHaveText(selected.name);
    await expandSpaces(page);
    await page.locator('[data-sync-add-space]').click();
    await page.locator('[data-sync-create]').click();
    await expect.poll(async () => (await readSession(page)).roomId).not.toBe(first.roomId);
    await awaitOnline(page);
    const second = await readSession(page);
    expect(second.roomId).not.toBe(first.roomId);
    expect(second.vaultId).not.toBe(first.vaultId);
    await expect(page.locator('[data-sync-messages]')).not.toContainText(firstText);
    await expect(page.locator('[data-sync-input]')).toHaveValue('');
    await expect(page.locator('[data-sync-reply]')).toBeHidden();
    await expect(page.locator('[data-sync-selected-file]')).toBeHidden();
    await sendText(page, secondText);
    await expect(page.locator('[data-sync-messages]')).toContainText(secondText);
    await page.locator('[data-sync-input]').fill(secondDraft);
    const connected = connections.map(({ roomId, auth, ready }) => ({ roomId, auth, ready }));
    const firstConnection = connections.filter(connection => connection.roomId === first.roomId).at(-1);
    const secondConnection = connections.find(connection => connection.roomId === second.roomId);
    const historyReads = historyRequests.length;
    expect(firstConnection.socket.isClosed()).toBe(false);

    await selectSpace(page, first.roomId);
    expect((await readSession(page)).deviceId).toBe(first.deviceId);
    await expect(page.locator('[data-sync-messages]')).toContainText(firstText);
    await expect(page.locator('[data-sync-messages]')).not.toContainText(secondText);
    await expect(page.locator('[data-sync-input]')).toHaveValue(firstDraft);
    await expect(page.locator('[data-sync-reply-text]')).toHaveText(firstText);
    await expect(page.locator('[data-sync-file-name]')).toHaveText(selected.name);
    await page.locator('[data-sync-remove-file]').click();
    await page.locator('[data-sync-send]').click();
    await expect(page.locator('[data-sync-input]')).toHaveValue('');
    await expect(page.locator('.sync-message').filter({ hasText: firstDraft }).locator('.sync-message-quote-text')).toContainText(firstText);

    await selectSpace(page, second.roomId);
    await expect(page.locator('[data-sync-input]')).toHaveValue(secondDraft);
    await expect(page.locator('[data-sync-messages]')).toContainText(secondText);
    await expect(page.locator('[data-sync-messages]')).not.toContainText(firstDraft);
    expect(connections.map(({ roomId, auth, ready }) => ({ roomId, auth, ready }))).toEqual(connected);
    expect(historyRequests).toHaveLength(historyReads);
    expect(firstConnection.socket.isClosed()).toBe(false);
    expect(secondConnection.socket.isClosed()).toBe(false);
    await page.reload();
    await awaitOnline(page);
    expect((await readSession(page)).roomId).toBe(second.roomId);
    await expect(page.locator('[data-sync-input]')).toHaveValue(secondDraft);
    await expandSpaces(page);
    await expect(page.locator('[data-sync-space-list] [data-sync-space-id]')).toHaveCount(2);
    await expect(page.locator(`[data-sync-space-id="${second.roomId}"]`)).toHaveAttribute('aria-current', 'true');
    await page.screenshot({ path: testInfo.outputPath(`spaces-${isMobile ? 'mobile' : 'desktop'}.png`) });
    const windowBounds = await page.locator('[data-sync-window]').boundingBox();
    const sidebarBounds = await page.locator('[data-sync-spaces-panel]').boundingBox();
    expect(sidebarBounds.x + sidebarBounds.width).toBeLessThanOrEqual(windowBounds.x + windowBounds.width + 1);
    await page.locator('[data-sync-spaces-toggle]').click();
    await expect(page.locator('[data-sync-spaces-toggle]')).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('[data-sync-spaces-panel]')).toBeHidden();
    await page.screenshot({ path: testInfo.outputPath(`spaces-collapsed-${isMobile ? 'mobile' : 'desktop'}.png`) });
    const otherTab = await page.context().newPage();
    try {
        await otherTab.goto(`${siteOrigin}/chat/`);
        await awaitOnline(otherTab);
        expect((await readSession(otherTab)).roomId).toBe(second.roomId);
        await selectSpace(page, first.roomId);
        await expect(otherTab.locator('[data-sync-messages]')).toContainText(firstText);
        await expect(otherTab.locator('[data-sync-messages]')).not.toContainText(secondText);
        await selectSpace(page, second.roomId);
        await expect(otherTab.locator('[data-sync-messages]')).toContainText(secondText);
        await expect(page.locator('[data-sync-input]')).toHaveValue(secondDraft);
    } finally { await otherTab.close(); }
    const unchanged = await fetch(`${apiOrigin}/v1/spaces/${first.roomId}/devices`, { headers: { Origin: siteOrigin, Authorization: `Bearer ${first.token}` } });
    expect(unchanged.status).toBe(200);
    for (const secret of [firstDraft, secondDraft, firstText, secondText]) expect(Buffer.concat(wireBodies).includes(Buffer.from(secret))).toBe(false);
});

test('keeps background spaces paired and synchronized through key rotation, clearing and connection loss, then revokes only their own connection', async ({ browser, isMobile }) => {
    test.setTimeout(90000);
    const contexts = await Promise.all(Array.from({ length: 2 }, () => browser.newContext({
        viewport: isMobile ? { width: 320, height: 568 } : { width: 1366, height: 900 }, isMobile, hasTouch: isMobile
    })));
    if (browser.browserType().name() === 'chromium') await Promise.all(contexts.map(context => context.grantPermissions(['local-network-access'])));
    const [owner, peer] = await Promise.all(contexts.map(context => context.newPage()));
    const connections = watchSpaceConnections(owner);
    await owner.addInitScript(() => {
        window.testSpaceSockets = [];
        window.WebSocket = new Proxy(window.WebSocket, {
            construct(Target, args) {
                const socket = Reflect.construct(Target, args);
                window.testSpaceSockets.push(socket);
                return socket;
            }
        });
    });
    try {
        await Promise.all([owner, peer].map(page => page.goto(`${siteOrigin}/chat/`)));
        await owner.locator('[data-sync-create]').click();
        await awaitOnline(owner);
        await expect(owner.locator('[data-sync-pair-code]')).toHaveText(/^\d{4}$/);
        const code = await owner.locator('[data-sync-pair-code]').textContent();
        const first = await readSession(owner);
        await sendText(owner, 'first-space-before-background');
        await expect(owner.locator('.sync-message[data-state="sent"]')).toContainText('first-space-before-background');
        await expandSpaces(owner);
        await owner.locator('[data-sync-add-space]').click();
        await owner.locator('[data-sync-create]').click();
        await expect.poll(async () => (await readSession(owner)).roomId).not.toBe(first.roomId);
        await awaitOnline(owner);
        const second = await readSession(owner);
        await sendText(owner, 'second-space-remains-active');
        await expect(owner.locator('.sync-message[data-state="sent"]')).toContainText('second-space-remains-active');
        const firstConnection = connections.find(connection => connection.roomId === first.roomId);
        const secondConnection = connections.find(connection => connection.roomId === second.roomId);
        const connected = connections.map(({ roomId, auth, ready }) => ({ roomId, auth, ready }));
        expect(firstConnection.socket.isClosed()).toBe(false);

        await peer.locator('[data-sync-code]').fill(code);
        await peer.locator('[data-sync-join]').click();
        await awaitOnline(peer);
        const joined = await readSession(peer);
        expect(joined.roomId).toBe(first.roomId);
        expect(joined.keyring.currentKeyId).not.toBe(first.keyring.currentKeyId);
        await expect.poll(async () => (await readSession(owner, first.roomId)).keyring.currentKeyId).toBe(joined.keyring.currentKeyId);
        expect((await readSession(owner)).roomId).toBe(second.roomId);

        let messageCount = firstConnection.frames.filter(frame => frame.type === 'message').length;
        await sendText(peer, 'first-space-background-message');
        await expect.poll(() => firstConnection.frames.filter(frame => frame.type === 'message').length).toBeGreaterThan(messageCount);
        await expect(owner.locator('[data-sync-messages]')).not.toContainText('first-space-background-message');
        await expect(owner.locator('[data-sync-messages]')).toContainText('second-space-remains-active');
        const backgroundMessageId = firstConnection.frames.filter(frame => frame.type === 'message').at(-1).message.id;
        expect(firstConnection.sent.some(frame => frame.type === 'read' && frame.messageId >= backgroundMessageId)).toBe(false);
        await selectSpace(owner, first.roomId);
        await expect(owner.locator('[data-sync-messages]')).toContainText('first-space-background-message');
        await expect(owner.locator('[data-sync-messages]')).not.toContainText('second-space-remains-active');
        await selectSpace(owner, second.roomId);

        await peer.locator('[data-sync-clear]').click();
        await peer.locator('[data-sync-confirm-accept]').click();
        await expect.poll(() => firstConnection.frames.some(frame => frame.type === 'cleared')).toBe(true);
        messageCount = firstConnection.frames.filter(frame => frame.type === 'message').length;
        await sendText(peer, 'first-space-after-background-clear');
        await expect.poll(() => firstConnection.frames.filter(frame => frame.type === 'message').length).toBeGreaterThan(messageCount);
        await expect(owner.locator('[data-sync-messages]')).toContainText('second-space-remains-active');
        await expect(owner.locator('[data-sync-messages]')).not.toContainText('first-space-after-background-clear');
        await selectSpace(owner, first.roomId);
        await expect(owner.locator('.sync-message-text')).toHaveText('first-space-after-background-clear');
        expect(connections.map(({ roomId, auth, ready }) => ({ roomId, auth, ready }))).toEqual(connected);
        expect(firstConnection.socket.isClosed()).toBe(false);
        expect(secondConnection.socket.isClosed()).toBe(false);

        await selectSpace(owner, second.roomId);
        await owner.evaluate(roomId => {
            const socket = window.testSpaceSockets.find(socket => new URL(socket.url).pathname === `/v1/spaces/${roomId}/socket`
                && socket.readyState === WebSocket.OPEN);
            socket.close();
        }, first.roomId);
        await expect.poll(() => firstConnection.socket.isClosed()).toBe(true);
        await expect.poll(() => connections.filter(connection => connection.roomId === first.roomId).length).toBe(2);
        const recovered = connections.filter(connection => connection.roomId === first.roomId).at(-1);
        await expect.poll(() => recovered.ready).toBe(1);
        await awaitOnline(owner);
        expect((await readSession(owner)).roomId).toBe(second.roomId);
        expect(connections.filter(connection => connection.roomId === second.roomId)).toHaveLength(1);
        expect(secondConnection.socket.isClosed()).toBe(false);

        await sendText(peer, 'first-space-after-background-reconnect');
        await expect.poll(() => recovered.frames.some(frame => frame.type === 'message')).toBe(true);
        const unreadMessageId = recovered.frames.filter(frame => frame.type === 'message').at(-1).message.id;
        await owner.bringToFront();
        await owner.locator('[data-sync-input]').fill('second-space-unsent-during-background-reconnect');
        await expect(owner.locator('[data-sync-input]')).toHaveValue('second-space-unsent-during-background-reconnect');
        await expect(owner.locator('[data-sync-messages]')).not.toContainText('first-space-after-background-reconnect');
        expect(recovered.sent.some(frame => frame.type === 'read' && frame.messageId >= unreadMessageId)).toBe(false);
        await expect(recovered.socket.waitForEvent('framesent', {
            predicate: ({ payload }) => {
                if (payload.toString() === 'ping') return false;
                const frame = JSON.parse(payload.toString());
                return frame.type === 'read' && frame.messageId >= unreadMessageId;
            },
            timeout: 1000
        })).rejects.toThrow(/Timeout/);
        const reconnected = connections.map(({ roomId, auth, ready }) => ({ roomId, auth, ready }));
        await selectSpace(owner, first.roomId);
        await expect(owner.locator('.sync-message-text')).toHaveText(['first-space-after-background-clear', 'first-space-after-background-reconnect']);
        expect(connections.map(({ roomId, auth, ready }) => ({ roomId, auth, ready }))).toEqual(reconnected);
        expect(recovered.socket.isClosed()).toBe(false);
        await selectSpace(owner, second.roomId);
        await expect(owner.locator('[data-sync-input]')).toHaveValue('second-space-unsent-during-background-reconnect');
        await peer.locator('[data-sync-devices]').click();
        const ownerDevice = peer.locator(`[data-sync-devices-list] [data-device-id="${first.deviceId}"]`);
        await ownerDevice.locator('[data-sync-device-remove]').click();
        await peer.locator('[data-sync-confirm-accept]').click();
        await expect(ownerDevice).toHaveCount(0, { timeout: 30000 });
        await expect(owner.locator(`[data-sync-space-id="${first.roomId}"]`)).toHaveCount(0);
        await expect(owner.locator(`[data-sync-space-id="${second.roomId}"]`)).toHaveCount(1);
        expect((await readSession(owner)).roomId).toBe(second.roomId);
        await awaitOnline(owner);
        await expect.poll(() => recovered.socket.isClosed()).toBe(true);
        expect(secondConnection.socket.isClosed()).toBe(false);
        expect(connections.map(({ roomId, auth, ready }) => ({ roomId, auth, ready }))).toEqual(reconnected);
        await sendText(owner, 'second-space-after-background-revocation');
        await expect(owner.locator('.sync-message[data-state="sent"]')).toContainText(['second-space-remains-active', 'second-space-after-background-revocation']);
    } finally { await Promise.all(contexts.map(context => context.close())); }
});

test('marks a background space with a green dot when it receives a new message and clears it on switching there', async ({ browser, isMobile }) => {
    test.setTimeout(90000);
    const contexts = await Promise.all(Array.from({ length: 2 }, () => browser.newContext({
        viewport: isMobile ? { width: 320, height: 568 } : { width: 1366, height: 900 }, isMobile, hasTouch: isMobile
    })));
    if (browser.browserType().name() === 'chromium') await Promise.all(contexts.map(context => context.grantPermissions(['local-network-access'])));
    const [owner, peer] = await Promise.all(contexts.map(context => context.newPage()));
    const dot = roomId => owner.locator(`[data-sync-space-id="${roomId}"] [data-sync-space-unread]`);
    try {
        await Promise.all([owner, peer].map(page => page.goto(`${siteOrigin}/chat/`)));
        await owner.locator('[data-sync-create]').click();
        await awaitOnline(owner);
        await expect(owner.locator('[data-sync-pair-code]')).toHaveText(/^\d{4}$/);
        const code = await owner.locator('[data-sync-pair-code]').textContent();
        const first = await readSession(owner);
        await expandSpaces(owner);
        await owner.locator('[data-sync-add-space]').click();
        await owner.locator('[data-sync-create]').click();
        await expect.poll(async () => (await readSession(owner)).roomId).not.toBe(first.roomId);
        await awaitOnline(owner);
        const second = await readSession(owner);

        await peer.locator('[data-sync-code]').fill(code);
        await peer.locator('[data-sync-join]').click();
        await awaitOnline(peer);
        await expandSpaces(owner);
        await expect(dot(first.roomId)).toBeHidden();
        await expect(owner.locator('[data-sync-spaces-toggle]')).not.toHaveClass(/has-unread/);

        await sendText(peer, 'background-space-unread');
        await expect(dot(first.roomId)).toBeVisible();
        await expect(dot(second.roomId)).toBeHidden();
        await expect(owner.locator(`[data-sync-space-id="${first.roomId}"]`)).toHaveAttribute('title', /新消息|new messages/);
        await expect(owner.locator('[data-sync-spaces-toggle]')).toHaveClass(/has-unread/);

        await selectSpace(owner, first.roomId);
        await expect(owner.locator('[data-sync-messages]')).toContainText('background-space-unread');
        await expandSpaces(owner);
        await expect(dot(first.roomId)).toBeHidden();
        await expect(dot(second.roomId)).toBeHidden();
        await expect(owner.locator('[data-sync-spaces-toggle]')).not.toHaveClass(/has-unread/);
    } finally { await Promise.all(contexts.map(context => context.close())); }
});

test('restores every retained space connection after closing and reopening the app without losing the active draft', async ({ browser, isMobile }) => {
    test.setTimeout(60000);
    const contexts = await Promise.all(Array.from({ length: 2 }, () => browser.newContext({
        viewport: isMobile ? { width: 320, height: 568 } : { width: 1366, height: 900 }, isMobile, hasTouch: isMobile
    })));
    if (browser.browserType().name() === 'chromium') await Promise.all(contexts.map(context => context.grantPermissions(['local-network-access'])));
    const [owner, peer] = await Promise.all(contexts.map(context => context.newPage()));
    const connections = watchSpaceConnections(owner);
    const draft = 'second-space-draft-survives-app-close';
    try {
        await Promise.all([openApp(owner), peer.goto(`${siteOrigin}/chat/`)]);
        await owner.locator('[data-sync-create]').click();
        await awaitOnline(owner);
        await expect(owner.locator('[data-sync-pair-code]')).toHaveText(/^\d{4}$/);
        await peer.locator('[data-sync-code]').fill(await owner.locator('[data-sync-pair-code]').textContent());
        await peer.locator('[data-sync-join]').click();
        await awaitOnline(peer);
        const joined = await readSession(peer);
        await expect.poll(async () => (await readSession(owner)).keyring.currentKeyId).toBe(joined.keyring.currentKeyId);
        const first = await readSession(owner);
        await sendText(peer, 'first-space-before-app-close');
        await expect(owner.locator('[data-sync-messages]')).toContainText('first-space-before-app-close');
        await expandSpaces(owner);
        await owner.locator('[data-sync-add-space]').click();
        await owner.locator('[data-sync-create]').click();
        await expect.poll(async () => (await readSession(owner)).roomId).not.toBe(first.roomId);
        await awaitOnline(owner);
        const second = await readSession(owner);
        await sendText(owner, 'second-space-before-app-close');
        await expect(owner.locator('.sync-message[data-state="sent"]')).toContainText('second-space-before-app-close');
        await owner.locator('[data-sync-input]').fill(draft);
        expect(connections).toHaveLength(2);
        const originalConnections = [...connections];

        await owner.locator('[data-sync-action="close"]').click();
        await expect(owner.locator('[data-sync-window]')).toBeHidden();
        await expect.poll(() => originalConnections.every(connection => connection.socket.isClosed())).toBe(true);
        await sendText(peer, 'first-space-during-app-close');
        await expect(peer.locator('.sync-message[data-state="sent"] .sync-message-text')).toHaveText([
            'first-space-before-app-close', 'first-space-during-app-close'
        ]);

        await owner.locator('.desktop-shortcut[data-open-sync-space]').click();
        await awaitOnline(owner);
        await expect.poll(() => connections.filter(connection => connection.roomId === first.roomId).length).toBe(2);
        await expect.poll(() => connections.filter(connection => connection.roomId === second.roomId).length).toBe(2);
        const resumedFirst = connections.filter(connection => connection.roomId === first.roomId).at(-1);
        const resumedSecond = connections.filter(connection => connection.roomId === second.roomId).at(-1);
        await expect.poll(() => resumedFirst.ready).toBe(1);
        await expect.poll(() => resumedSecond.ready).toBe(1);
        expect(resumedFirst.auth).toBe(1);
        expect(resumedSecond.auth).toBe(1);
        expect((await readSession(owner)).roomId).toBe(second.roomId);
        await expect(owner.locator('[data-sync-input]')).toHaveValue(draft);
        await expect(owner.locator('.sync-message-text')).toHaveText('second-space-before-app-close');

        await sendText(peer, 'first-space-after-app-reopen');
        await expect.poll(() => resumedFirst.frames.some(frame => frame.type === 'message')).toBe(true);
        await expect(owner.locator('[data-sync-messages]')).not.toContainText('first-space-after-app-reopen');
        await selectSpace(owner, first.roomId);
        await expect(owner.locator('.sync-message-text')).toHaveText([
            'first-space-before-app-close', 'first-space-during-app-close', 'first-space-after-app-reopen'
        ]);
        await selectSpace(owner, second.roomId);
        await expect(owner.locator('[data-sync-input]')).toHaveValue(draft);
        await expect(owner.locator('.sync-message-text')).toHaveText('second-space-before-app-close');
        expect(connections).toHaveLength(4);
        expect(resumedFirst.socket.isClosed()).toBe(false);
        expect(resumedSecond.socket.isClosed()).toBe(false);
    } finally { await Promise.all(contexts.map(context => context.close())); }
});

test('keeps both spaces created concurrently by two empty tabs and follows their shared active selection', async ({ page, browserName }) => {
    test.setTimeout(60000);
    if (browserName === 'chromium') await page.context().grantPermissions(['local-network-access']);
    const other = await page.context().newPage();
    const created = [];
    let requests = 0;
    let releaseRequests;
    const ready = new Promise(resolve => { releaseRequests = resolve; });
    interceptApi = async (request, forward) => {
        if (request.method !== 'POST' || new URL(request.url).pathname !== '/v1/spaces') return;
        requests++;
        if (requests === 2) releaseRequests();
        await ready;
        const response = await forward();
        created.push(await response.clone().json());
        return response;
    };
    try {
        await Promise.all([page, other].map(tab => tab.goto(`${siteOrigin}/chat/`)));
        await Promise.all([page, other].map(tab => tab.locator('[data-sync-create]').click()));
        await expect.poll(() => created.length).toBe(2);
        const roomIds = created.map(session => session.roomId).sort();
        expect(new Set(roomIds).size).toBe(2);
        await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('portfolio-sync-spaces-e2ee1') || '[]').map(space => space.roomId).sort())).toEqual(roomIds);
        await Promise.all([page, other].map(awaitOnline));
        await Promise.all([page, other].map(tab => expect(tab.locator('[data-sync-add-space]')).toBeEnabled()));
        const activeId = (await readSession(page)).roomId;
        await Promise.all([page, other].map(tab => expect(tab.locator(`[data-sync-space-id="${activeId}"]`)).toHaveAttribute('aria-current', 'true')));
        await selectSpace(page, roomIds[0]);
        await expect(other.locator(`[data-sync-space-id="${roomIds[0]}"]`)).toHaveAttribute('aria-current', 'true');
        await sendText(page, 'concurrent-space-one-message');
        await expect(other.locator('[data-sync-messages]')).toContainText('concurrent-space-one-message');
        await selectSpace(other, roomIds[1]);
        await expect(page.locator(`[data-sync-space-id="${roomIds[1]}"]`)).toHaveAttribute('aria-current', 'true');
        await sendText(other, 'concurrent-space-two-message');
        await expect(page.locator('[data-sync-messages]')).toContainText('concurrent-space-two-message');
        await expect(page.locator('[data-sync-messages]')).not.toContainText('concurrent-space-one-message');
        await selectSpace(page, roomIds[0]);
        await expect(page.locator('[data-sync-messages]')).toContainText('concurrent-space-one-message');
        await expect(other.locator('[data-sync-messages]')).toContainText('concurrent-space-one-message');
        await expect(other.locator('[data-sync-messages]')).not.toContainText('concurrent-space-two-message');
        expect(requests).toBe(2);
        await expect(page.locator('[data-sync-space-list] [data-sync-space-id]')).toHaveCount(2);
        await expect(other.locator('[data-sync-space-list] [data-sync-space-id]')).toHaveCount(2);
    } finally {
        releaseRequests();
        await other.close();
    }
});

test('adds a paired space without duplicating a saved membership and leaves only the selected space', async ({ browser, isMobile }) => {
    test.setTimeout(90000);
    const contexts = await Promise.all(Array.from({ length: 2 }, () => browser.newContext({
        viewport: isMobile ? { width: 320, height: 568 } : { width: 1366, height: 900 }, isMobile, hasTouch: isMobile
    })));
    if (browser.browserType().name() === 'chromium') await Promise.all(contexts.map(context => context.grantPermissions(['local-network-access'])));
    const [owner, member] = await Promise.all(contexts.map(context => context.newPage()));
    const connections = watchSpaceConnections(member);
    const admittedDevices = [], removedDevices = [];
    interceptApi = async request => {
        const pathname = new URL(request.url).pathname;
        if (request.method === 'POST' && /\/pair-accept$/.test(pathname)) admittedDevices.push((await request.clone().json()).deviceId);
        if (request.method === 'DELETE' && /\/device$/.test(pathname)) removedDevices.push(pathname);
    };
    try {
        await Promise.all([owner, member].map(page => page.goto(`${siteOrigin}/chat/`)));
        await owner.locator('[data-sync-create]').click();
        await awaitOnline(owner);
        await expect(owner.locator('[data-sync-pair-code]')).toHaveText(/^\d{4}$/, { timeout: 30000 });
        const code = await owner.locator('[data-sync-pair-code]').textContent();
        const shared = await readSession(owner);
        await member.locator('[data-sync-create]').click();
        await awaitOnline(member);
        const original = await readSession(member);
        await sendText(member, 'member-original-space');
        await expandSpaces(member);
        await member.locator('[data-sync-add-space]').click();
        await member.locator('[data-sync-code]').fill(code);
        await member.locator('[data-sync-join]').click();
        await awaitOnline(member);
        await expect.poll(async () => (await readSession(member)).roomId).toBe(shared.roomId);
        const joined = await readSession(member);
        await sendText(owner, 'shared-space-message');
        await expect(member.locator('[data-sync-messages]')).toContainText('shared-space-message');
        await selectSpace(member, original.roomId);
        await expect(member.locator('[data-sync-messages]')).toContainText('member-original-space');
        await expect(member.locator('[data-sync-messages]')).not.toContainText('shared-space-message');
        await owner.locator('[data-sync-pair]').click();
        await expect(owner.locator('[data-sync-pair-code]')).toHaveText(/^\d{4}$/, { timeout: 30000 });
        await expandSpaces(member);
        await member.locator('[data-sync-add-space]').click();
        await member.locator('[data-sync-code]').fill(await owner.locator('[data-sync-pair-code]').textContent());
        await member.locator('[data-sync-join]').click();
        await expect.poll(async () => (await readSession(member)).roomId).toBe(shared.roomId);
        await awaitOnline(member);
        expect((await readSession(member)).deviceId).toBe(joined.deviceId);
        expect((await readSession(member)).vaultId).toBe(joined.vaultId);
        await expandSpaces(member);
        await expect(member.locator('[data-sync-space-list] [data-sync-space-id]')).toHaveCount(2);
        await expect(member.locator(`[data-sync-space-id="${shared.roomId}"]`)).toHaveCount(1);
        await member.locator('[data-sync-spaces-toggle]').click();
        expect(admittedDevices).toHaveLength(2);
        expect(admittedDevices[1]).not.toBe(joined.deviceId);
        await expect.poll(async () => {
            const response = await fetch(`${apiOrigin}/v1/spaces/${shared.roomId}/devices`, { headers: { Origin: siteOrigin, Authorization: `Bearer ${shared.token}` } });
            return (await response.json()).devices.map(device => device.deviceId).sort();
        }).toEqual([shared.deviceId, joined.deviceId].sort());
        expect(removedDevices).toEqual([`/v1/spaces/${shared.roomId}/device`]);
        await sendText(member, 'saved-membership-after-repeat-pairing');
        await expect(owner.locator('[data-sync-messages]')).toContainText('saved-membership-after-repeat-pairing');
        const originalConnection = connections.filter(connection => connection.roomId === original.roomId).at(-1);
        const sharedConnection = connections.filter(connection => connection.roomId === shared.roomId).at(-1);
        const connected = connections.map(({ roomId, auth, ready }) => ({ roomId, auth, ready }));
        expect(originalConnection.socket.isClosed()).toBe(false);
        await member.locator('[data-sync-leave]').click();
        await member.locator('[data-sync-confirm-accept]').click();
        await expandSpaces(member);
        await expect(member.locator(`[data-sync-space-id="${shared.roomId}"]`)).toHaveCount(0);
        await expect(member.locator(`[data-sync-space-id="${original.roomId}"]`)).toHaveCount(1);
        await selectSpace(member, original.roomId);
        expect((await readSession(member)).deviceId).toBe(original.deviceId);
        await expect(member.locator('[data-sync-messages]')).toContainText('member-original-space');
        await expect.poll(() => sharedConnection.socket.isClosed()).toBe(true);
        expect(originalConnection.socket.isClosed()).toBe(false);
        expect(connections.map(({ roomId, auth, ready }) => ({ roomId, auth, ready }))).toEqual(connected);
        const left = await fetch(`${apiOrigin}/v1/spaces/${joined.roomId}/messages`, { headers: { Origin: siteOrigin, Authorization: `Bearer ${joined.token}` } });
        expect(left.status).toBe(401);
    } finally { await Promise.all(contexts.map(context => context.close())); }
});

test('recovers an added space after reload during its accepted pairing without replacing the existing membership', async ({ browser, isMobile }) => {
    test.setTimeout(90000);
    const contexts = await Promise.all(Array.from({ length: 2 }, () => browser.newContext({
        viewport: isMobile ? { width: 320, height: 568 } : { width: 1366, height: 900 }, isMobile, hasTouch: isMobile
    })));
    if (browser.browserType().name() === 'chromium') await Promise.all(contexts.map(context => context.grantPermissions(['local-network-access'])));
    const [owner, joining] = await Promise.all(contexts.map(context => context.newPage()));
    const started = [], admissions = [], grantPaths = [], acknowledged = [];
    let heldGrant = false;
    let releaseGrant;
    const released = new Promise(resolve => { releaseGrant = resolve; });
    interceptApi = async (request, forward) => {
        const pathname = new URL(request.url).pathname;
        if (request.method === 'POST' && /\/pair-accept$/.test(pathname)) admissions.push((await request.clone().json()).deviceId);
        if (request.method === 'POST' && pathname === '/v1/pair') started.push((await request.clone().json()).requestId);
        if (request.method === 'POST' && /\/ack$/.test(pathname)) acknowledged.push(pathname);
        if (request.method === 'GET' && /^\/v1\/pair\/[0-9a-f-]{36}$/.test(pathname)) {
            grantPaths.push(pathname);
            const response = await forward(), result = await response.clone().json();
            if (result.grant && !heldGrant) { heldGrant = true; await released; }
            return response;
        }
    };
    try {
        await Promise.all([owner, joining].map(page => page.goto(`${siteOrigin}/chat/`)));
        await joining.locator('[data-sync-create]').click();
        await awaitOnline(joining);
        const original = await readSession(joining);
        await sendText(joining, 'original-space-before-pair-reload');
        await owner.locator('[data-sync-create]').click();
        await awaitOnline(owner);
        const shared = await readSession(owner);
        await expect(owner.locator('[data-sync-pair-code]')).toHaveText(/^\d{4}$/, { timeout: 30000 });
        await expandSpaces(joining);
        await joining.locator('[data-sync-add-space]').click();
        await joining.locator('[data-sync-code]').fill(await owner.locator('[data-sync-pair-code]').textContent());
        await joining.locator('[data-sync-join]').click();
        await expect.poll(() => heldGrant).toBe(true);
        await expect.poll(() => joining.evaluate(() => sessionStorage.getItem('gavin-sync-pair-recovery'))).toBeTruthy();
        expect((await readSession(joining)).roomId).toBe(original.roomId);
        expect(started).toHaveLength(1);
        expect(admissions).toHaveLength(1);
        await joining.reload();
        releaseGrant();
        await expect.poll(async () => (await readSession(joining)).roomId).toBe(shared.roomId);
        await awaitOnline(joining);
        const recovered = await readSession(joining);
        expect(recovered.deviceId).toBe(admissions[0]);
        await expect.poll(() => acknowledged.length).toBe(1);
        expect(started).toHaveLength(1);
        expect(admissions).toHaveLength(1);
        expect([...new Set(grantPaths)]).toEqual([`/v1/pair/${started[0]}`]);
        expect(acknowledged).toEqual([`/v1/pair/${started[0]}/ack`]);
        await expect.poll(() => joining.evaluate(() => sessionStorage.getItem('gavin-sync-pair-recovery'))).toBeNull();
        await expandSpaces(joining);
        await expect(joining.locator('[data-sync-space-list] [data-sync-space-id]')).toHaveCount(2);
        await joining.locator('[data-sync-spaces-toggle]').click();
        await sendText(joining, 'added-space-after-pair-reload');
        await expect(owner.locator('[data-sync-messages]')).toContainText('added-space-after-pair-reload');
        await selectSpace(joining, original.roomId);
        expect((await readSession(joining)).deviceId).toBe(original.deviceId);
        expect((await readSession(joining)).vaultId).toBe(original.vaultId);
        await expect(joining.locator('[data-sync-messages]')).toContainText('original-space-before-pair-reload');
        await expect(joining.locator('[data-sync-messages]')).not.toContainText('added-space-after-pair-reload');
        await selectSpace(joining, shared.roomId);
        expect((await readSession(joining)).deviceId).toBe(recovered.deviceId);
        await sendText(owner, 'shared-space-after-returning');
        await expect(joining.locator('[data-sync-messages]')).toContainText('shared-space-after-returning');
    } finally {
        releaseGrant();
        await Promise.all(contexts.map(context => context.close()));
    }
});

test('keeps an added space pairing alive when the current space rotates its encryption keys', async ({ browser, isMobile }) => {
    test.setTimeout(60000);
    const contexts = await Promise.all(Array.from({ length: 3 }, () => browser.newContext({
        viewport: isMobile ? { width: 320, height: 568 } : { width: 1366, height: 900 }, isMobile, hasTouch: isMobile
    })));
    if (browser.browserType().name() === 'chromium') await Promise.all(contexts.map(context => context.grantPermissions(['local-network-access'])));
    const [member, owner, newcomer] = await Promise.all(contexts.map(context => context.newPage()));
    let releaseGrant;
    const released = new Promise(resolve => { releaseGrant = resolve; });
    let heldGrant = false;
    const removed = [];
    interceptApi = async (request, forward) => {
        const pathname = new URL(request.url).pathname;
        if (request.method === 'DELETE' && pathname.endsWith('/device')) removed.push(pathname);
        if (request.method === 'GET' && /^\/v1\/pair\/[0-9a-f-]{36}$/.test(pathname)) {
            const response = await forward();
            const result = await response.clone().json();
            if (result.grant && !heldGrant) { heldGrant = true; await released; }
            return response;
        }
    };
    try {
        await Promise.all([member, owner, newcomer].map(page => page.goto(`${siteOrigin}/chat/`)));
        await owner.locator('[data-sync-create]').click();
        await awaitOnline(owner);
        await expect(owner.locator('[data-sync-pair-code]')).toHaveText(/^\d{4}$/);
        const added = await readSession(owner);
        const addedCode = await owner.locator('[data-sync-pair-code]').textContent();
        await member.locator('[data-sync-create]').click();
        await awaitOnline(member);
        await expect(member.locator('[data-sync-pair-code]')).toHaveText(/^\d{4}$/);
        const original = await readSession(member);
        const originalCode = await member.locator('[data-sync-pair-code]').textContent();
        await expandSpaces(member);
        await member.locator('[data-sync-add-space]').click();
        await member.locator('[data-sync-code]').fill(addedCode);
        await member.locator('[data-sync-join]').click();
        await expect.poll(() => heldGrant).toBe(true);
        await newcomer.locator('[data-sync-code]').fill(originalCode);
        await newcomer.locator('[data-sync-join]').click();
        await awaitOnline(newcomer);
        await expect.poll(async () => (await readSession(member)).keyring.currentKeyId).not.toBe(original.keyring.currentKeyId);
        await expect(member.locator('[data-sync-join]')).toBeDisabled();
        releaseGrant();
        await expect.poll(async () => (await readSession(member)).roomId).toBe(added.roomId);
        await awaitOnline(member);
        await expect(member.locator('[data-sync-setup]')).toBeHidden();
        await expect(member.locator('[data-sync-space-list] [data-sync-space-id]')).toHaveCount(2);
        expect(removed).toEqual([]);
        await sendText(owner, 'message-in-added-space-after-original-key-rotation');
        await expect(member.locator('[data-sync-messages]')).toContainText('message-in-added-space-after-original-key-rotation');
        await selectSpace(member, original.roomId);
        await sendText(newcomer, 'message-in-original-space-with-new-key');
        await expect(member.locator('[data-sync-messages]')).toContainText('message-in-original-space-with-new-key');
    } finally {
        releaseGrant();
        await Promise.all(contexts.map(context => context.close()));
    }
});

test('reuses the current membership when adding its own pairing code', async ({ page, browserName }) => {
    test.setTimeout(60000);
    if (browserName === 'chromium') await page.context().grantPermissions(['local-network-access']);
    await page.goto(`${siteOrigin}/chat/`);
    await page.locator('[data-sync-create]').click();
    await awaitOnline(page);
    await expect(page.locator('[data-sync-pair-code]')).toHaveText(/^\d{4}$/);
    const original = await readSession(page);
    const code = await page.locator('[data-sync-pair-code]').textContent();
    await expandSpaces(page);
    await page.locator('[data-sync-add-space]').click();
    await page.locator('[data-sync-code]').fill(code);
    await page.locator('[data-sync-join]').click();
    await expect(page.locator('[data-sync-setup]')).toBeHidden({ timeout: 30000 });
    await awaitOnline(page);
    expect((await readSession(page)).deviceId).toBe(original.deviceId);
    expect((await readSession(page)).vaultId).toBe(original.vaultId);
    await expect(page.locator('[data-sync-space-list] [data-sync-space-id]')).toHaveCount(1);
    await expect.poll(async () => {
        const response = await fetch(`${apiOrigin}/v1/spaces/${original.roomId}/devices`, {
            headers: { Origin: siteOrigin, Authorization: `Bearer ${original.token}` }
        });
        return (await response.json()).devices.map(device => device.deviceId);
    }).toEqual([original.deviceId]);
});

test('keeps the current draft and space when local storage cannot save it before switching', async ({ page, browserName }) => {
    test.setTimeout(60000);
    if (browserName === 'chromium') await page.context().grantPermissions(['local-network-access']);
    await page.goto(`${siteOrigin}/chat/`);
    await page.locator('[data-sync-create]').click();
    await awaitOnline(page);
    const first = await readSession(page);
    await page.locator('[data-sync-input]').fill('previously-saved-draft');
    await expect.poll(() => page.evaluate(id => sessionStorage.getItem(`portfolio-sync-draft:${id}`), first.roomId)).toBeTruthy();
    await expandSpaces(page);
    await page.locator('[data-sync-add-space]').click();
    await page.locator('[data-sync-create]').click();
    await expect.poll(async () => (await readSession(page)).roomId).not.toBe(first.roomId);
    await awaitOnline(page);
    const second = await readSession(page);
    await selectSpace(page, first.roomId);
    if (await page.locator('[data-sync-spaces-toggle]').getAttribute('aria-expanded') === 'true') await page.locator('[data-sync-spaces-toggle]').click();
    await page.evaluate(() => {
        const block = 'x'.repeat(1024);
        for (let index = 0; ; index++) {
            try { sessionStorage.setItem(`quota-test-${index}`, block); }
            catch { break; }
        }
    });
    const draft = 'new-unsaved-draft-'.repeat(500);
    try {
        await page.locator('[data-sync-input]').fill(draft);
        await expect(page.locator('[data-sync-notice]')).toHaveAttribute('data-i18n', 'syncStorageError');
        await expandSpaces(page);
        await page.locator(`[data-sync-space-id="${second.roomId}"]`).click();
        await expect(page.locator(`[data-sync-space-id="${first.roomId}"]`)).toHaveAttribute('aria-current', 'true');
        expect((await readSession(page)).roomId).toBe(first.roomId);
        await expect(page.locator('[data-sync-input]')).toHaveValue(draft);
        await expect(page.locator('[data-sync-notice]')).toHaveAttribute('data-i18n', 'syncStorageError');
    } finally {
        await page.evaluate(() => {
            Object.keys(sessionStorage).filter(key => key.startsWith('quota-test-')).forEach(key => sessionStorage.removeItem(key));
        });
    }
    await selectSpace(page, second.roomId);
    await selectSpace(page, first.roomId);
    await expect(page.locator('[data-sync-input]')).toHaveValue(draft);
});

test('synchronizes encrypted eight-character space names across devices, reconnects and saved spaces', async ({ browser, isMobile }, testInfo) => {
    test.setTimeout(90000);
    const contexts = await Promise.all(Array.from({ length: 3 }, () => browser.newContext({
        viewport: isMobile ? { width: 320, height: 568 } : { width: 1366, height: 900 }, isMobile, hasTouch: isMobile
    })));
    if (browser.browserType().name() === 'chromium') await Promise.all(contexts.map(context => context.grantPermissions(['local-network-access'])));
    const [owner, member, newcomer] = await Promise.all(contexts.map(context => context.newPage()));
    const errors = [];
    for (const page of [owner, member, newcomer]) page.on('pageerror', error => errors.push(error.message));
    await member.addInitScript(() => {
        const NativeWebSocket = window.WebSocket;
        window.__testSockets = new Set();
        window.WebSocket = class extends NativeWebSocket {
            constructor(...args) {
                super(...args);
                window.__testSockets.add(this);
                this.addEventListener('close', () => window.__testSockets.delete(this));
            }
        };
    });
    const firstName = '共享私密空间🎵🎸';
    const memberName = '团队协作空间甲乙';
    const offlineName = '离线更新空间甲乙';
    const secondName = '独立工作空间甲乙';
    const latestName = '后来成员可见房间';
    const rename = async (page, name, expected = name) => {
        await page.locator('[data-sync-space-rename]').click();
        await page.locator('[data-sync-space-name]').fill(name);
        await expect(page.locator('[data-sync-space-name]')).toHaveValue(expected);
        await page.locator('[data-sync-space-name-form] button[type="submit"]').click();
        await expect(page.locator('[data-sync-space-name-dialog]')).toBeHidden();
    };
    try {
        await Promise.all([owner, member, newcomer].map(page => page.goto(`${siteOrigin}/chat/`)));
        await owner.locator('[data-sync-create]').click();
        await awaitOnline(owner);
        await expect(owner.locator('[data-sync-pair-code]')).toHaveText(/^\d{4}$/);
        await owner.locator('[data-sync-pair-lock]').click();
        await expect(owner.locator('[data-sync-pair-lock]')).toHaveAttribute('aria-pressed', 'true');
        const code = await owner.locator('[data-sync-pair-code]').textContent();
        await member.locator('[data-sync-code]').fill(code);
        await member.locator('[data-sync-join]').click();
        await awaitOnline(member);
        const first = await readSession(owner);

        await rename(owner, `${firstName}超出`, firstName);
        for (const page of [owner, member]) {
            await expect(page.locator('[data-sync-space-title]')).toHaveText(firstName);
            await expect(page.locator(`[data-sync-space-id="${first.roomId}"]`)).toHaveText(firstName);
        }
        const profileResponse = await fetch(`${apiOrigin}/v1/spaces/${first.roomId}/profile`, {
            headers: { Origin: siteOrigin, Authorization: `Bearer ${first.token}` }
        });
        expect(profileResponse.status).toBe(200);
        const { profile } = await profileResponse.json();
        expect(profile.name).toMatch(/^e2ee1\./);
        expect(profile.revision).toBeGreaterThan(0);

        await owner.locator('[data-taskbar-lang]').click();
        await expect(owner.locator('html')).toHaveAttribute('lang', 'en');
        await expect(owner.locator('[data-sync-space-title]')).toHaveText(firstName);
        await rename(member, memberName);
        await expect(owner.locator('[data-sync-space-title]')).toHaveText(memberName);
        await member.reload();
        await awaitOnline(member);
        await expect(member.locator('[data-sync-space-title]')).toHaveText(memberName);

        await contexts[1].setOffline(true);
        await member.evaluate(() => { for (const socket of window.__testSockets) socket.close(); });
        await expect(member.locator('[data-sync-status]')).not.toHaveAttribute('data-state', 'online');
        await rename(owner, offlineName);
        await expect(owner.locator('[data-sync-space-title]')).toHaveText(offlineName);
        await expect(member.locator('[data-sync-space-title]')).toHaveText(memberName);
        await contexts[1].setOffline(false);
        await awaitOnline(member);
        await expect(member.locator('[data-sync-space-title]')).toHaveText(offlineName);

        await expandSpaces(owner);
        await owner.locator('[data-sync-add-space]').click();
        await owner.locator('[data-sync-create]').click();
        await expect.poll(async () => (await readSession(owner)).roomId).not.toBe(first.roomId);
        await awaitOnline(owner);
        const second = await readSession(owner);
        expect(second.roomId).not.toBe(first.roomId);
        await rename(owner, secondName);
        await rename(member, latestName);
        await expect(owner.locator('[data-sync-space-title]')).toHaveText(secondName);
        await selectSpace(owner, first.roomId);
        await expect(owner.locator('[data-sync-space-title]')).toHaveText(latestName);
        await expect(owner.locator(`[data-sync-space-id="${second.roomId}"]`)).toHaveText(secondName);

        await newcomer.locator('[data-sync-code]').fill(code);
        await newcomer.locator('[data-sync-join]').click();
        await awaitOnline(newcomer);
        await expect(newcomer.locator('[data-sync-space-title]')).toHaveText(latestName);
        await expect(newcomer.locator(`[data-sync-space-id="${first.roomId}"]`)).toHaveText(latestName);
        await rename(owner, '');
        await expect(owner.locator('[data-sync-space-title]')).toHaveText('Space 1');
        for (const page of [member, newcomer]) await expect(page.locator('[data-sync-space-title]')).toHaveText('空间 1');
        const clearedProfile = await fetch(`${apiOrigin}/v1/spaces/${first.roomId}/profile`, {
            headers: { Origin: siteOrigin, Authorization: `Bearer ${first.token}` }
        });
        const cleared = (await clearedProfile.json()).profile;
        expect(cleared.name).toMatch(/^e2ee1\./);
        expect(cleared.revision).toBeGreaterThan(profile.revision);
        await owner.reload();
        await awaitOnline(owner);
        await expect(owner.locator('[data-sync-space-title]')).toHaveText('Space 1');
        await selectSpace(owner, second.roomId);
        await expect(owner.locator('[data-sync-space-title]')).toHaveText(secondName);
        await owner.screenshot({ path: testInfo.outputPath('shared-space-name-isolation.png') });
        const secondProfileResponse = await fetch(`${apiOrigin}/v1/spaces/${second.roomId}/profile`, {
            headers: { Origin: siteOrigin, Authorization: `Bearer ${second.token}` }
        });
        const secondProfile = (await secondProfileResponse.json()).profile;
        const envelope = JSON.parse(Buffer.from(secondProfile.name.slice(6), 'base64url').toString());
        const damagedBytes = Buffer.from(envelope.ciphertext, 'base64url');
        damagedBytes[0] ^= 1;
        envelope.ciphertext = damagedBytes.toString('base64url');
        const damagedName = `e2ee1.${Buffer.from(JSON.stringify(envelope)).toString('base64url')}`;
        const damagedResponse = await fetch(`${apiOrigin}/v1/spaces/${second.roomId}/profile`, {
            method: 'PATCH',
            headers: { Origin: siteOrigin, Authorization: `Bearer ${second.token}`, 'Content-Type': 'application/json', 'X-Sync-Key-Id': second.keyring.currentKeyId },
            body: JSON.stringify({ name: damagedName })
        });
        expect(damagedResponse.status).toBe(200);
        await owner.reload();
        await awaitOnline(owner);
        await expect(owner.locator('[data-sync-space-title]')).toHaveText(secondName);
        const afterDamagedName = 'message-after-invalid-encrypted-space-name';
        await sendText(owner, afterDamagedName);
        await expect(owner.locator('.sync-message[data-state="sent"]').filter({ hasText: afterDamagedName })).toHaveCount(1);
        for (const name of [firstName, memberName, offlineName, secondName, latestName]) {
            expect(Buffer.concat(wireBodies).includes(Buffer.from(name))).toBe(false);
        }
        expect(errors).toEqual([]);
    } finally { await Promise.all(contexts.map(context => context.close())); }
});

test('keeps an uploading space active until its file finishes before allowing a switch', async ({ page, browserName }) => {
    test.setTimeout(60000);
    if (browserName === 'chromium') await page.context().grantPermissions(['local-network-access']);
    let releaseChunk;
    let held = false;
    let aborted = false;
    const released = new Promise(resolve => { releaseChunk = resolve; });
    try {
        await page.goto(`${siteOrigin}/chat/`);
        await page.locator('[data-sync-create]').click();
        await awaitOnline(page);
        const first = await readSession(page);
        await expandSpaces(page);
        await page.locator('[data-sync-add-space]').click();
        await page.locator('[data-sync-create]').click();
        await expect.poll(async () => (await readSession(page)).roomId).not.toBe(first.roomId);
        await awaitOnline(page);
        const second = await readSession(page);
        interceptApi = async (request, forward) => {
            if (request.method !== 'PUT' || !/\/files\/uploads\/[^/]+\/chunks\/0$/.test(new URL(request.url).pathname)) return;
            held = true;
            request.signal.addEventListener('abort', () => { aborted = true; }, { once: true });
            await released;
            return forward();
        };
        await page.locator('[data-sync-file-input]').setInputFiles({ name: 'stay-in-upload-space.txt', mimeType: 'text/plain', buffer: Buffer.from('upload must remain in the originating space') });
        await page.locator('[data-sync-send]').click();
        await expect.poll(() => held).toBe(true);
        await expandSpaces(page);
        const switchButton = page.locator(`[data-sync-space-id="${first.roomId}"]`);
        await expect(switchButton).toBeDisabled();
        await expect(page.locator('[data-sync-add-space]')).toBeDisabled();
        expect((await readSession(page)).roomId).toBe(second.roomId);
        expect(aborted).toBe(false);
        releaseChunk();
        await expect(page.locator('[data-sync-upload-status]')).toBeHidden({ timeout: 30000 });
        await expect(page.locator('.sync-message[data-state="sent"] .sync-attachment-name')).toHaveText('stay-in-upload-space.txt');
        await selectSpace(page, first.roomId);
        await expect(page.locator('[data-sync-messages]')).not.toContainText('stay-in-upload-space.txt');
    } finally { releaseChunk(); }
});

test('keeps a locked code across reload and key rotation, then closes it for every device and reopens with a fresh code', async ({ browser, isMobile }, testInfo) => {
    test.setTimeout(90000);
    const contexts = await Promise.all(Array.from({ length: 3 }, () => browser.newContext({
        viewport: isMobile ? { width: 320, height: 568 } : { width: 1366, height: 900 }, isMobile, hasTouch: isMobile
    })));
    if (browser.browserType().name() === 'chromium') await Promise.all(contexts.map(context => context.grantPermissions(['local-network-access'])));
    const [owner, member, newcomer] = await Promise.all(contexts.map(context => context.newPage()));
    try {
        await Promise.all([owner, member, newcomer].map(page => page.goto(`${siteOrigin}/chat/`)));
        await owner.locator('[data-sync-create]').click();
        await awaitOnline(owner);
        await expect(owner.locator('[data-sync-pair-code]')).toHaveText(/^\d{4}$/, { timeout: 30000 });
        const code = await owner.locator('[data-sync-pair-code]').textContent();
        await owner.locator('[data-sync-pair-lock]').click();
        await expect(owner.locator('[data-sync-pair-lock]')).toHaveAttribute('aria-pressed', 'true');
        await expect(owner.locator('[data-sync-pair-expiry]')).toHaveText('已锁定');
        await owner.screenshot({ path: testInfo.outputPath('locked-pairing.png') });
        await owner.reload();
        await awaitOnline(owner);
        await expect(owner.locator('[data-sync-pair-code]')).toHaveText(code);
        await expect(owner.locator('[data-sync-pair-lock]')).toHaveAttribute('aria-pressed', 'true');

        await member.locator('[data-sync-code]').fill(code);
        await member.locator('[data-sync-join]').click();
        await awaitOnline(member);
        const admitted = await readSession(member);
        await expect.poll(async () => (await readSession(owner)).keyring.currentKeyId).toBe(admitted.keyring.currentKeyId);
        for (const page of [owner, member]) {
            await expect(page.locator('[data-sync-pair-code]')).toHaveText(code);
            await expect(page.locator('[data-sync-pair-lock]')).toHaveAttribute('aria-pressed', 'true');
            await expect(page.locator('[data-sync-pair-expiry]')).toHaveText('已锁定');
        }

        await member.locator('[data-sync-pair-close]').click();
        for (const page of [owner, member]) {
            await expect(page.locator('[data-sync-pairing]')).toBeHidden();
            await expect(page.locator('[data-sync-pair-code]')).toHaveText('');
            await expect(page.locator('[data-sync-pair]')).toHaveText('生成配对码');
            await expect(page.locator('[data-sync-pair-lock]')).toHaveAttribute('aria-pressed', 'false');
        }
        await member.screenshot({ path: testInfo.outputPath('closed-pairing.png') });
        await member.reload();
        await awaitOnline(member);
        await expect(member.locator('[data-sync-pairing]')).toBeHidden();
        await expect(member.locator('[data-sync-pair]')).toHaveText('生成配对码');
        await expect(member.locator('[data-sync-pair-lock]')).toHaveAttribute('aria-pressed', 'false');
        await member.locator('[data-taskbar-lang]').click();
        await expect(member.locator('[data-sync-pair]')).toHaveText('Generate pairing code');
        await expect(member.locator('[data-sync-pairing]')).toBeHidden();
        await member.locator('[data-taskbar-lang]').click();
        await newcomer.locator('[data-sync-code]').fill(code);
        await newcomer.locator('[data-sync-join]').click();
        await expect(newcomer.locator('[data-sync-notice]')).toHaveAttribute('data-i18n', 'syncInvalidCode');
        await expect(newcomer.locator('[data-sync-setup]')).toBeVisible();
        const afterClose = 'existing-members-still-chat-when-invitations-closed';
        await sendText(member, afterClose);
        await expect(owner.locator('[data-sync-messages]')).toContainText(afterClose);

        await member.evaluate(previousCode => {
            const getRandomValues = crypto.getRandomValues.bind(crypto);
            crypto.getRandomValues = values => {
                if (values instanceof Uint16Array && values.length === 1) {
                    crypto.getRandomValues = getRandomValues;
                    values[0] = (Number(previousCode) + 1) % 10000;
                    return values;
                }
                return getRandomValues(values);
            };
        }, code);
        await member.locator('[data-sync-pair]').click();
        const newCode = String((Number(code) + 1) % 10000).padStart(4, '0');
        for (const page of [owner, member]) {
            await expect(page.locator('[data-sync-pairing]')).toBeVisible();
            await expect(page.locator('[data-sync-pair-code]')).toHaveText(newCode);
            await expect(page.locator('[data-sync-pair-lock]')).toHaveAttribute('aria-pressed', 'false');
            await expect(page.locator('[data-sync-pair-expiry]')).toHaveText(/剩余 (10:00|9:\d{2})/);
        }
        await newcomer.locator('[data-sync-join]').click();
        await expect(newcomer.locator('[data-sync-notice]')).toHaveAttribute('data-i18n', 'syncInvalidCode');
        await expect(newcomer.locator('[data-sync-setup]')).toBeVisible();
        await member.locator('[data-sync-pair-lock]').click();
        await expect(owner.locator('[data-sync-pair-lock]')).toHaveAttribute('aria-pressed', 'true');
        await newcomer.locator('[data-sync-code]').fill(newCode);
        await newcomer.locator('[data-sync-join]').click();
        await awaitOnline(newcomer);
        expect((await readSession(newcomer)).roomId).toBe(admitted.roomId);
        await expect(owner.locator('[data-sync-pair-code]')).toHaveText(newCode);
        await expect(newcomer.locator('[data-sync-pair-code]')).toHaveText(newCode);

        await newcomer.locator('[data-sync-pair-lock]').click();
        for (const page of [owner, member, newcomer]) {
            await expect(page.locator('[data-sync-pair-lock]')).toHaveAttribute('aria-pressed', 'false');
            await expect(page.locator('[data-sync-pair-expiry]')).toHaveText(/剩余 (10:00|9:\d{2})/);
            await expect(page.locator('[data-sync-pair-code]')).toHaveText(newCode);
        }
        for (const body of wireBodies) {
            let value;
            try { value = JSON.parse(body); } catch { continue; }
            const inspect = value => {
                if (typeof value === 'string') expect([code, newCode], 'pairing codes must stay encrypted on the wire').not.toContain(value);
                else if (Array.isArray(value)) value.forEach(inspect);
                else if (value && typeof value === 'object') {
                    expect(Object.hasOwn(value, 'code')).toBe(false);
                    Object.values(value).forEach(inspect);
                }
            };
            inspect(value);
        }
    } finally { await Promise.all(contexts.map(context => context.close())); }
});

test('sends lightweight encrypted stickers without uploads or download actions and preserves the text draft', async ({ browser, isMobile }, testInfo) => {
    test.setTimeout(60000);
    const contexts = await Promise.all(Array.from({ length: 2 }, () => browser.newContext({
        viewport: isMobile ? { width: 320, height: 568 } : { width: 1366, height: 900 }, isMobile, hasTouch: isMobile
    })));
    if (browser.browserType().name() === 'chromium') await Promise.all(contexts.map(context => context.grantPermissions(['local-network-access'])));
    const [sender, receiver] = await Promise.all(contexts.map(context => context.newPage()));
    const uploadRequests = [];
    interceptApi = request => { if (/\/files\/uploads/.test(request.url)) uploadRequests.push(request.url); };
    try {
        await Promise.all([sender, receiver].map(page => page.goto(`${siteOrigin}/chat/`)));
        await sender.locator('[data-sync-create]').click();
        await awaitOnline(sender);
        await expect(sender.locator('[data-sync-pair-code]')).toHaveText(/^\d{4}$/, { timeout: 30000 });
        await receiver.locator('[data-sync-code]').fill(await sender.locator('[data-sync-pair-code]').textContent());
        await receiver.locator('[data-sync-join]').click();
        await awaitOnline(receiver);
        await expect.poll(async () => (await readSession(sender)).keyring.currentKeyId).toBe((await readSession(receiver)).keyring.currentKeyId);
        for (const page of [sender, receiver]) await expect(page.locator('[data-sync-notice]')).not.toHaveAttribute('data-state', 'error');

        const draft = 'keep-this-unsent-text-草稿';
        await sender.locator('[data-sync-input]').fill(draft);
        expect(await sender.locator('[data-sync-voice-record]').evaluate(button => button.nextElementSibling.hasAttribute('data-sync-stickers'))).toBe(true);
        await sender.locator('[data-sync-stickers]').click();
        await expect(sender.locator('[data-sync-sticker-dialog]')).toBeVisible();
        await expect(sender.locator('[data-sync-sticker-choice]')).toHaveCount(17);
        const pickerImage = await sender.locator('[data-sync-sticker-choice="happy"] img').evaluate(image => ({ width: image.getBoundingClientRect().width, height: image.getBoundingClientRect().height }));
        expect(Math.abs(pickerImage.width - pickerImage.height)).toBeLessThan(1);
        await sender.screenshot({ path: testInfo.outputPath('sticker-picker.png') });
        await sender.locator('[data-sync-sticker-choice="happy"]').click();
        await expect(sender.locator('[data-sync-sticker-dialog]')).not.toBeVisible();
        await expect(sender.locator('[data-sync-input]')).toHaveValue(draft);
        for (const page of [sender, receiver]) {
            const sticker = page.locator('.sync-message-sticker[data-sync-sticker="happy"]');
            await expect(sticker).toBeVisible();
            await expect.poll(() => sticker.locator('img').evaluate(image => image.naturalWidth)).toBe(128);
            await expect(page.locator('[data-sync-download-file]')).toHaveCount(0);
            await expect(sticker.locator('..')).toHaveAttribute('data-state', 'sent');
        }
        expect(uploadRequests).toEqual([]);
        expect(messageBodies).toHaveLength(1);
        expect(Object.keys(messageBodies[0]).sort()).toEqual(['clientId', 'text']);
        expect(messageBodies[0].text).toMatch(/^e2ee1\./);
        expect(messageBodies[0].text).not.toContain('happy');
        const session = await readSession(sender);
        const opened = await sender.evaluate(async ({ session, message }) => {
            const bytes = text => Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), byte => byte.charCodeAt(0));
            const envelope = JSON.parse(new TextDecoder().decode(bytes(message.text.slice(6))));
            const key = await crypto.subtle.importKey('raw', bytes(session.keyring.keys[envelope.keyId]), 'AES-GCM', false, ['decrypt']);
            const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes(envelope.iv),
                additionalData: new TextEncoder().encode(`gavin-sync-v1:${session.roomId}:message:${session.deviceId}:${message.clientId}`) }, key, bytes(envelope.ciphertext));
            return JSON.parse(new TextDecoder().decode(plaintext));
        }, { session, message: messageBodies[0] });
        expect(opened.sticker).toBe('happy');
        expect(opened.text).toBe('');
        expect(opened.attachment).toBeUndefined();

        await receiver.locator('.sync-message-sticker').click();
        const preview = receiver.locator('[data-sync-preview-window]');
        await expect(preview).toBeVisible();
        await expect(preview.locator('img')).toBeVisible();
        expect(await preview.locator('img').evaluate(image => ({ width: image.getBoundingClientRect().width, rendering: getComputedStyle(image).imageRendering })))
            .toEqual({ width: 192, rendering: 'auto' });
        await expect(preview.locator('[data-sync-download-file], a[download]')).toHaveCount(0);
        await receiver.locator('[data-taskbar-lang]').click();
        await expect(preview.locator('[data-sync-preview-title]')).toContainText('Happy');
        await expect(preview.locator('img')).toHaveAttribute('alt', /Happy/);
        await preview.locator('[data-sync-preview-action="close"]').click();
        await receiver.locator('[data-sync-stickers]').click();
        await expect(receiver.locator('[data-sync-sticker-choice="happy"]')).toContainText('Happy');
        await receiver.locator('[data-sync-sticker-close]').click();
        await receiver.reload();
        await awaitOnline(receiver);
        await expect(receiver.locator('.sync-message-sticker[data-sync-sticker="happy"]')).toBeVisible();
        await receiver.screenshot({ path: testInfo.outputPath('sticker-message.png') });
        await receiver.locator('.sync-message').filter({ has: receiver.locator('[data-sync-sticker="happy"]') }).locator('[data-sync-reply-message]').click();
        await expect(receiver.locator('[data-sync-reply-text]')).toContainText('Happy');
        await sendText(receiver, 'reply-to-sticker');
        const reply = sender.locator('.sync-message').filter({ has: sender.locator('.sync-message-text', { hasText: 'reply-to-sticker' }) });
        await expect(reply.locator('.sync-message-quote-text')).toContainText('开心');
        await expect(sender.locator('[data-sync-input]')).toHaveValue(draft);
        await sender.locator('[data-sync-stickers]').click();
        await sender.locator('[data-sync-sticker-choice="doge"]').click();
        for (const page of [sender, receiver]) {
            const doge = page.locator('.sync-message-sticker[data-sync-sticker="doge"]');
            await expect(doge).toBeVisible();
            await expect.poll(() => doge.locator('img').evaluate(image => image.naturalWidth)).toBe(128);
        }
        await receiver.screenshot({ path: testInfo.outputPath('sticker-doge-message.png') });
        await expect(sender.locator('[data-sync-input]')).toHaveValue(draft);
        expect(uploadRequests).toEqual([]);
    } finally { await Promise.all(contexts.map(context => context.close())); }
});

test('pairs the standalone chat with the desktop, restores its session and transfers an encrypted file across entries', async ({ browser, isMobile }, testInfo) => {
    test.skip(isMobile, 'cross-entry pairing is exercised with isolated desktop contexts');
    test.setTimeout(90000);
    const contexts = await Promise.all(Array.from({ length: 2 }, () => browser.newContext({ acceptDownloads: true, viewport: { width: 1366, height: 900 } })));
    if (browser.browserType().name() === 'chromium') await Promise.all(contexts.map(context => context.grantPermissions(['local-network-access'])));
    const [desktop, chat] = await Promise.all(contexts.map(context => context.newPage()));
    const fromDesktop = 'cross-entry-desktop-private-message';
    const fromChat = 'cross-entry-chat-private-message';
    const file = { name: 'standalone-private-note.txt', mimeType: 'text/plain', buffer: text };
    const chatScripts = [];
    const chatWorkerUrls = [];
    await chat.addInitScript(() => {
        Object.defineProperty(window, 'MediaRecorder', { configurable: true, value: undefined });
        const createUrl = URL.createObjectURL.bind(URL);
        URL.createObjectURL = blob => {
            if (blob.type === 'audio/wav') window.recordedVoice = blob;
            return createUrl(blob);
        };
        Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
            async getUserMedia() {
                const context = new AudioContext();
                const oscillator = context.createOscillator();
                const destination = context.createMediaStreamDestination();
                oscillator.connect(destination);
                oscillator.start();
                await context.resume();
                window.voiceSource = context;
                return destination.stream;
            }
        } });
    });
    chat.on('response', response => { if (/\.js(?:\?|$)/.test(response.url()) && response.ok()) chatScripts.push(response.url()); });
    chat.on('worker', worker => chatWorkerUrls.push(worker.url()));
    try {
        await Promise.all([openApp(desktop), chat.goto(`${siteOrigin}/chat/`)]);
        await expect(chat.locator('[data-sync-window]')).toBeVisible();
        await desktop.locator('[data-sync-create]').click();
        await awaitOnline(desktop);
        await expect(desktop.locator('[data-sync-pair-code]')).toHaveText(/^\d{4}$/, { timeout: 30000 });
        const code = await desktop.locator('[data-sync-pair-code]').textContent();
        await chat.locator('[data-sync-code]').fill(code);
        await chat.locator('[data-sync-join]').click();
        await awaitOnline(chat);
        const joined = await readSession(chat);
        await expect.poll(async () => (await readSession(desktop)).keyring.currentKeyId).toBe(joined.keyring.currentKeyId);
        const owner = await readSession(desktop);
        expect(joined.roomId).toBe(owner.roomId);
        expect(joined.deviceId).not.toBe(owner.deviceId);
        expect(joined.trustedDevices[owner.deviceId]).toBe(owner.identity.publicKey);
        expect(owner.trustedDevices[joined.deviceId]).toBe(joined.identity.publicKey);
        expect(chatScripts.some(url => /^\/sync-pake\.[^/]+\.js$/.test(new URL(url).pathname))).toBe(true);

        await sendText(desktop, fromDesktop);
        await expect(chat.locator('[data-sync-messages]')).toContainText(fromDesktop);
        await chat.locator('.sync-message').filter({ has: chat.locator('.sync-message-text', { hasText: fromDesktop }) }).locator('[data-sync-reply-message]').click();
        await sendText(chat, fromChat);
        await expect(desktop.locator('[data-sync-messages]')).toContainText(fromChat);
        const answer = desktop.locator('.sync-message').filter({ has: desktop.locator('.sync-message-text', { hasText: fromChat }) });
        await expect(answer.locator('.sync-message-quote-text')).toHaveText(fromDesktop);
        await expect(answer.locator('.sync-message-quote-author')).toHaveText('设备 1');
        await chat.reload();
        await awaitOnline(chat);
        expect((await readSession(chat)).deviceId).toBe(joined.deviceId);
        await expect(chat.locator('[data-sync-messages]')).toContainText(fromDesktop);
        await expect(chat.locator('[data-sync-messages]')).toContainText(fromChat);
        await expect(chat.locator('.sync-message .sync-message-quote-text')).toHaveText(fromDesktop);

        const uploadPath = testInfo.outputPath(file.name);
        await writeFile(uploadPath, file.buffer);
        await chat.locator('.sync-message').filter({ has: chat.locator('.sync-message-text', { hasText: fromChat }) }).locator('[data-sync-reply-message]').click();
        await chat.locator('[data-sync-file-input]').setInputFiles(uploadPath);
        await chat.locator('[data-sync-send]').click();
        const attachment = desktop.locator('.sync-message').filter({ has: desktop.locator('.sync-attachment-name', { hasText: file.name }) });
        await expect(attachment).toBeVisible({ timeout: 30000 });
        await expect(attachment.locator('.sync-message-quote-text')).toHaveText(fromChat);
        expect(chatWorkerUrls.some(url => /^\/upload-fingerprint\.[^/]+\.js$/.test(new URL(url).pathname))).toBe(true);
        const downloading = desktop.waitForEvent('download');
        await attachment.locator('[data-sync-download-file]').click();
        const download = await downloading;
        expect(download.suggestedFilename()).toBe(file.name);
        expect(await readFile(await download.path())).toEqual(file.buffer);

        await expect(chat.locator('[data-sync-selected-file]')).toBeHidden();
        await chat.locator('.sync-message').filter({ has: chat.locator('.sync-attachment-name', { hasText: file.name }) }).locator('[data-sync-reply-message]').click();
        await chat.locator('[data-sync-voice-record]').click();
        await expect(chat.locator('[data-sync-voice-stop]')).toBeEnabled();
        await expect(chat.locator('[data-sync-voice-time]')).not.toHaveText('00:00 / 01:00');
        await chat.locator('[data-sync-voice-stop]').click();
        await expect(chat.locator('[data-sync-voice-preview]')).toBeVisible();
        const recorded = Buffer.from(await chat.evaluate(async () => [...new Uint8Array(await window.recordedVoice.arrayBuffer())]));
        expect(recorded.subarray(0, 4).toString()).toBe('RIFF');
        expect(recorded.readUInt32LE(24)).toBe(16000);
        expect(recorded.readUInt16LE(22)).toBe(1);
        expect(recorded.length).toBeLessThanOrEqual(44 + 16000 * 2 * 60);
        await chat.evaluate(() => window.voiceSource.close());
        await chat.locator('[data-sync-send]').click();
        const voice = desktop.locator('.sync-message').filter({ has: desktop.locator('[data-sync-voice-play]') });
        await expect(voice).toBeVisible({ timeout: 30000 });
        await expect(voice.locator('.sync-message-quote-text')).toContainText(file.name);
        const voiceDownloading = desktop.waitForEvent('download');
        await voice.locator('[data-sync-download-file]').click();
        const voiceDownload = await voiceDownloading;
        expect(await readFile(await voiceDownload.path())).toEqual(recorded);

        expect(messageBodies).toHaveLength(2);
        expect(messageBodies.every(body => body.text.startsWith('e2ee1.'))).toBe(true);
        const all = Buffer.concat(wireBodies);
        expect(all.includes(recorded.subarray(0, 44))).toBe(false);
        expect(all.includes(Buffer.from('durationMs'))).toBe(false);
        expect(all.includes(Buffer.from('audio/wav'))).toBe(false);
        for (const forbidden of [fromDesktop, fromChat, file.name, text.toString(), ...Object.values(owner.keyring.keys)]) {
            expect(all.includes(Buffer.from(forbidden)), `backend must not receive ${forbidden}`).toBe(false);
        }
        for (const body of wireBodies) {
            let value;
            try { value = JSON.parse(body); } catch { continue; }
            const inspect = value => {
                if (typeof value === 'string') expect(value).not.toBe(code);
                else if (Array.isArray(value)) value.forEach(inspect);
                else if (value && typeof value === 'object') {
                    expect(Object.hasOwn(value, 'code')).toBe(false);
                    Object.values(value).forEach(inspect);
                }
            };
            inspect(value);
        }
        const stored = await (await fetch(`${apiOrigin}/v1/spaces/${owner.roomId}/messages`, {
            headers: { Origin: siteOrigin, Authorization: `Bearer ${owner.token}` }
        })).json();
        expect(stored.messages).toHaveLength(4);
        expect(stored.messages.every(message => message.text.startsWith('e2ee1.'))).toBe(true);
    } finally { await Promise.all(contexts.map(context => context.close())); }
});

test('recovers an accepted pairing after its final grant response is lost and acknowledges the persisted session', async ({ browser, isMobile }) => {
    test.skip(isMobile, 'real pairing recovery is exercised with isolated desktop contexts');
    test.setTimeout(60000);
    const contexts = await Promise.all(Array.from({ length: 2 }, () => browser.newContext({ viewport: { width: 1366, height: 900 } })));
    if (browser.browserType().name() === 'chromium') await Promise.all(contexts.map(context => context.grantPermissions(['local-network-access'])));
    const [owner, joining] = await Promise.all(contexts.map(context => context.newPage()));
    let lostResponses = 0;
    let settles = 0;
    let acknowledgements = 0;
    interceptApi = async (request, forward) => {
        if (!new URL(request.url).pathname.startsWith('/v1/pair/')) return;
        if (request.method === 'DELETE') settles++;
        if (/\/ack$/.test(request.url) && request.method === 'POST') acknowledgements++;
        if (request.method === 'GET' && !lostResponses) {
            const response = await forward();
            const result = await response.clone().json();
            if (result.grant) {
                lostResponses++;
                const bytes = await response.arrayBuffer();
                // Deliver headers before truncation so the browser cannot transparently retry this GET.
                return new Response(bytes.slice(0, -1), {
                    status: response.status,
                    headers: { ...Object.fromEntries(response.headers), 'Content-Length': String(bytes.byteLength), Connection: 'close' }
                });
            }
            return response;
        }
    };
    try {
        await Promise.all([owner, joining].map(openApp));
        await owner.locator('[data-sync-create]').click();
        await awaitOnline(owner);
        await expect(owner.locator('[data-sync-pair-code]')).toHaveText(/^\d{4}$/, { timeout: 30000 });
        const previousKey = (await readSession(owner)).keyring.currentKeyId;
        await joining.locator('[data-sync-code]').fill(await owner.locator('[data-sync-pair-code]').textContent());
        await joining.locator('[data-sync-join]').click();
        await awaitOnline(joining);
        await expect.poll(() => acknowledgements).toBe(1);
        expect(lostResponses).toBe(1);
        expect(settles).toBe(1);
        const joined = await readSession(joining);
        expect(joined.keyring.currentKeyId).not.toBe(previousKey);
        await expect.poll(async () => (await readSession(owner)).keyring.currentKeyId).toBe(joined.keyring.currentKeyId);
        await sendText(joining, 'restored-after-lost-pairing-result');
        await expect(owner.locator('[data-sync-messages]')).toContainText('restored-after-lost-pairing-result');
    } finally { await Promise.all(contexts.map(context => context.close())); }
});

test('reloads during a delayed pairing grant and restores the same request and device', async ({ browser, isMobile }) => {
    test.skip(isMobile, 'reload recovery is exercised with isolated desktop contexts');
    test.setTimeout(60000);
    const contexts = await Promise.all(Array.from({ length: 2 }, () => browser.newContext({ viewport: { width: 1366, height: 900 } })));
    if (browser.browserType().name() === 'chromium') await Promise.all(contexts.map(context => context.grantPermissions(['local-network-access'])));
    const [owner, joining] = await Promise.all(contexts.map(context => context.newPage()));
    const started = [], admissions = [], grantPaths = [], acknowledged = [];
    let heldGrant = false;
    let releaseGrant;
    const released = new Promise(resolve => { releaseGrant = resolve; });
    interceptApi = async (request, forward) => {
        const pathname = new URL(request.url).pathname;
        if (request.method === 'POST' && /\/pair-accept$/.test(pathname)) admissions.push((await request.clone().json()).deviceId);
        if (request.method === 'POST' && pathname === '/v1/pair') started.push((await request.clone().json()).requestId);
        if (request.method === 'POST' && /\/ack$/.test(pathname)) acknowledged.push(pathname);
        if (request.method === 'GET' && /^\/v1\/pair\/[0-9a-f-]{36}$/.test(pathname)) {
            grantPaths.push(pathname);
            const response = await forward(), result = await response.clone().json();
            if (result.grant && !heldGrant) {
                heldGrant = true;
                await released;
            }
            return response;
        }
    };
    try {
        await Promise.all([owner, joining].map(openApp));
        await owner.locator('[data-sync-create]').click();
        await awaitOnline(owner);
        await expect(owner.locator('[data-sync-pair-code]')).toHaveText(/^\d{4}$/, { timeout: 30000 });
        await joining.locator('[data-sync-code]').fill(await owner.locator('[data-sync-pair-code]').textContent());
        await joining.locator('[data-sync-join]').click();
        await expect.poll(() => heldGrant).toBe(true);
        await expect.poll(() => joining.evaluate(() => sessionStorage.getItem('gavin-sync-pair-recovery'))).toBeTruthy();
        expect(await joining.evaluate(() => localStorage.getItem('portfolio-sync-space-e2ee1'))).toBeNull();
        expect(started).toHaveLength(1);
        expect(admissions).toHaveLength(1);
        await joining.reload();
        releaseGrant();
        if (await joining.locator('[data-window-action="minimize"]').isVisible()) await joining.locator('[data-window-action="minimize"]').click();
        await joining.locator('[data-open-sync-space]').first().click();
        await awaitOnline(joining);
        await expect.poll(() => acknowledged.length).toBe(1);
        expect(started).toHaveLength(1);
        expect(admissions).toHaveLength(1);
        expect([...new Set(grantPaths)]).toEqual([`/v1/pair/${started[0]}`]);
        expect(acknowledged).toEqual([`/v1/pair/${started[0]}/ack`]);
        expect(await joining.evaluate(() => JSON.parse(localStorage.getItem('portfolio-sync-space-e2ee1')).deviceId)).toBe(admissions[0]);
        await expect.poll(() => joining.evaluate(() => sessionStorage.getItem('gavin-sync-pair-recovery'))).toBeNull();
        await owner.locator('[data-sync-devices]').click();
        await expect(owner.locator('[data-sync-devices-list] [data-device-id]')).toHaveCount(2);
        await expect(owner.locator(`[data-sync-devices-list] [data-device-id="${admissions[0]}"]`)).toBeVisible();
        await owner.locator('[data-sync-devices-dismiss]').click();
        await sendText(joining, 'joined-after-refresh-during-grant');
        await expect(owner.locator('[data-sync-messages]')).toContainText('joined-after-refresh-during-grant');
        await sendText(owner, 'owner-reply-after-refresh-during-grant');
        await expect(joining.locator('[data-sync-messages]')).toContainText('owner-reply-after-refresh-during-grant');
    } finally {
        releaseGrant();
        await Promise.all(contexts.map(context => context.close()));
    }
});

for (const acknowledgementLoss of ['before-server', 'after-server']) {
test(`reloads a saved pairing with an unreceived acknowledgement (${acknowledgementLoss}) without enrolling or revoking another device`, async ({ browser, isMobile }) => {
    test.skip(isMobile, 'persisted pairing acknowledgement is exercised with isolated desktop contexts');
    test.setTimeout(60000);
    const contexts = await Promise.all(Array.from({ length: 2 }, () => browser.newContext({ viewport: { width: 1366, height: 900 } })));
    if (browser.browserType().name() === 'chromium') await Promise.all(contexts.map(context => context.grantPermissions(['local-network-access'])));
    const [owner, joining] = await Promise.all(contexts.map(context => context.newPage()));
    const started = [], admissions = [], ackPaths = [], removedDevices = [];
    let heldAck = false;
    const recoveredAckStatuses = [];
    let releaseAck;
    const released = new Promise(resolve => { releaseAck = resolve; });
    interceptApi = async (request, forward) => {
        const pathname = new URL(request.url).pathname;
        if (request.method === 'POST' && /\/pair-accept$/.test(pathname)) admissions.push((await request.clone().json()).deviceId);
        if (request.method === 'DELETE' && /\/device$/.test(pathname)) removedDevices.push(pathname);
        if (request.method === 'POST' && pathname === '/v1/pair') started.push((await request.clone().json()).requestId);
        if (request.method === 'POST' && /\/ack$/.test(pathname)) {
            ackPaths.push(pathname);
            if (!heldAck) {
                if (acknowledgementLoss === 'after-server') {
                    const response = await forward();
                    expect(response.status).toBe(200);
                }
                heldAck = true;
                await released;
                return false;
            }
            const response = await forward();
            recoveredAckStatuses.push(response.status);
            return response;
        }
    };
    try {
        await Promise.all([owner, joining].map(openApp));
        await owner.locator('[data-sync-create]').click();
        await awaitOnline(owner);
        await expect(owner.locator('[data-sync-pair-code]')).toHaveText(/^\d{4}$/, { timeout: 30000 });
        await joining.locator('[data-sync-code]').fill(await owner.locator('[data-sync-pair-code]').textContent());
        await joining.locator('[data-sync-join]').click();
        await expect.poll(() => heldAck).toBe(true);
        const saved = await joining.evaluate(() => {
            const session = JSON.parse(localStorage.getItem('portfolio-sync-space-e2ee1'));
            return { deviceId: session?.deviceId, vaultId: session?.vaultId };
        });
        expect(saved.deviceId).toBe(admissions[0]);
        expect(saved.vaultId).toBeTruthy();
        await joining.reload();
        releaseAck();
        if (await joining.locator('[data-window-action="minimize"]').isVisible()) await joining.locator('[data-window-action="minimize"]').click();
        await joining.locator('[data-open-sync-space]').first().click();
        await awaitOnline(joining);
        await expect.poll(() => recoveredAckStatuses).toEqual([acknowledgementLoss === 'after-server' ? 404 : 200]);
        expect(started).toHaveLength(1);
        expect(admissions).toHaveLength(1);
        expect(ackPaths).toEqual([`/v1/pair/${started[0]}/ack`, `/v1/pair/${started[0]}/ack`]);
        expect(removedDevices).toEqual([]);
        expect(await joining.evaluate(() => JSON.parse(localStorage.getItem('portfolio-sync-space-e2ee1')).deviceId)).toBe(saved.deviceId);
        await expect.poll(() => joining.evaluate(() => sessionStorage.getItem('gavin-sync-pair-recovery'))).toBeNull();
        await owner.locator('[data-sync-devices]').click();
        await expect(owner.locator('[data-sync-devices-list] [data-device-id]')).toHaveCount(2);
        await expect(owner.locator(`[data-sync-devices-list] [data-device-id="${saved.deviceId}"]`)).toBeVisible();
        await owner.locator('[data-sync-devices-dismiss]').click();
        await sendText(joining, 'saved-device-survives-refresh-before-ack');
        await expect(owner.locator('[data-sync-messages]')).toContainText('saved-device-survives-refresh-before-ack');
        await sendText(owner, 'saved-device-receives-after-ack-recovery');
        await expect(joining.locator('[data-sync-messages]')).toContainText('saved-device-receives-after-ack-recovery');
    } finally {
        releaseAck();
        await Promise.all(contexts.map(context => context.close()));
    }
});
}

test('pairs real devices, encrypts text and attachments, restores keys and revokes future access', async ({ browser, isMobile }) => {
    test.skip(isMobile, 'full desktop app protocol is exercised with isolated desktop browser contexts');
    test.setTimeout(180000);
    const pairedCodes = new Set();
    const contexts = await Promise.all(Array.from({ length: 3 }, () => browser.newContext({ acceptDownloads: true, viewport: { width: 1366, height: 900 } })));
    if (browser.browserType().name() === 'chromium') await Promise.all(contexts.map(context => context.grantPermissions(['local-network-access'])));
    contexts.forEach(context => context.setDefaultTimeout(15000));
    const pages = await Promise.all(contexts.map(context => context.newPage()));
    const [first, second] = pages;
    let third = pages[2];
    const challenges = [];
    let hostingSockets = 0;
    first.on('websocket', socket => {
        if (socket.url().startsWith(apiOrigin.replace(/^http/, 'ws'))) hostingSockets++;
    });
    interceptApi = async request => {
        if (request.method !== 'POST' || !/\/pair-challenge$/.test(request.url)) return;
        challenges.push(await request.clone().text());
        if (challenges.length === 1) return new Response('<html><body>Bad Gateway</body></html>', {
            status: 502, headers: { 'Access-Control-Allow-Origin': siteOrigin, 'Content-Type': 'text/html' }
        });
    };
    try {
        await Promise.all(pages.map(openApp));
        await first.locator('[data-sync-create]').click();
        await awaitOnline(first);
        await expect(first.locator('[data-sync-pair-code]')).toHaveText(/^\d{4}$/, { timeout: 30000 });
        const pair = async page => {
            if (!await first.locator('[data-sync-pairing]').isVisible()) {
                await first.locator('[data-sync-pair]').click();
                await expect(first.locator('[data-sync-pair-code]')).toHaveText(/^\d{4}$/, { timeout: 30000 });
            }
            const previousKeyId = (await readSession(first)).keyring.currentKeyId;
            const code = await first.locator('[data-sync-pair-code]').textContent();
            pairedCodes.add(code);
            await page.locator('[data-sync-code]').fill(code);
            await page.locator('[data-sync-join]').click();
            await awaitOnline(page);
            await expect.poll(async () => (await readSession(first)).keyring.currentKeyId).not.toBe(previousKeyId);
        };
        await pair(second);
        expect(challenges).toHaveLength(2);
        expect(challenges[1]).toBe(challenges[0]);
        expect(hostingSockets).toBe(1);
        interceptApi = null;
        await pair(third);
        await sendText(first, sentText);
        for (const page of [second, third]) await expect(page.locator('[data-sync-messages]')).toContainText(sentText);
        await second.bringToFront();
        await second.locator('[data-sync-input]').click();
        await expect(first.locator('.sync-message').filter({ hasText: sentText }).locator('.sync-message-read')).toHaveAttribute('data-state', 'read');
        const oldSession = await readSession(second);
        const thirdSession = await readSession(third);
        const initialKeyId = oldSession.keyring.currentKeyId;
        await third.close();
        await first.locator('[data-sync-devices]').click();
        const secondRow = first.locator(`[data-sync-devices-list] [data-device-id="${oldSession.deviceId}"]`);
        await secondRow.locator('input').fill(renamed);
        await secondRow.locator('[data-sync-device-save]').click();
        await expect(secondRow.locator('strong')).toHaveText(renamed);
        await first.locator('[data-sync-devices-dismiss]').click();
        await sendText(second, renamedText);
        await expect(first.locator('.sync-message').filter({ hasText: renamedText }).locator('.sync-message-meta')).toContainText(renamed);
        await second.reload();
        if (await second.locator('[data-window-action="minimize"]').isVisible()) await second.locator('[data-window-action="minimize"]').click();
        await second.locator('[data-open-sync-space]').first().click();
        await awaitOnline(second);
        await expect(second.locator('[data-sync-messages]')).toContainText(sentText);
        expect((await readSession(second)).keyring.currentKeyId).toBe(initialKeyId);

        for (const file of [
            { name: 'private-note-文档.txt', mimeType: 'text/plain', buffer: text, preview: 'text', marker: text.toString() },
            { name: 'private-image-图片.png', mimeType: 'image/png', buffer: png, preview: 'image' },
            { name: 'private-reaction-表情.gif', mimeType: 'image/gif', buffer: gif, preview: 'image', inline: true },
            { name: 'private-workbook-表格.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: xlsx, preview: 'spreadsheet', marker: 'confidential-workbook-cell' },
            { name: 'private-paper-文档.pdf', mimeType: 'application/pdf', buffer: pdf, preview: 'pdf' },
            { name: 'private-video-视频.mp4', mimeType: 'video/mp4', buffer: mp4, preview: 'video' }
        ]) {
            await first.locator('[data-sync-file-input]').setInputFiles(file);
            await first.locator('[data-sync-send]').click();
            const message = second.locator('.sync-message').filter({ has: second.locator('.sync-attachment-name', { hasText: file.name }) });
            await expect(message).toBeVisible({ timeout: 30000 });
            if (file.inline) for (const page of [first, second]) {
                const image = page.locator('.sync-message').filter({ has: page.locator('.sync-attachment-name', { hasText: file.name }) }).locator('.sync-message-image img');
                await expect(image).toBeVisible({ timeout: 30000 });
                await expect.poll(() => image.evaluate(image => [image.naturalWidth, image.naturalHeight])).toEqual([1, 1]);
            }
            await message.locator('[data-sync-preview-file]').click();
            const preview = second.locator('[data-sync-preview-window]');
            await expect(preview).toBeVisible();
            if (file.preview === 'image') await expect.poll(() => preview.locator('img').evaluate(image => image.naturalWidth)).toBe(1);
            else if (file.preview === 'pdf') {
                await expect(preview.locator('.sync-preview-page canvas').first()).toBeVisible({ timeout: 30000 });
                expect(await preview.locator('.sync-preview-page canvas').first().evaluate(canvas => canvas.width > 0 && canvas.height > 0)).toBe(true);
            } else if (file.preview === 'video') {
                const video = preview.locator('video');
                await expect.poll(() => video.evaluate(video => video.videoWidth > 0 && Number.isFinite(video.duration) && video.duration > 0)).toBe(true);
                await video.evaluate(video => { video.currentTime = video.duration / 2; });
                await expect.poll(() => video.evaluate(video => video.readyState)).toBeGreaterThanOrEqual(2);
                await video.evaluate(async video => { video.muted = true; await video.play(); });
                await expect.poll(() => video.evaluate(video => video.currentTime > video.duration / 2)).toBe(true);
                await video.evaluate(video => video.pause());
            }
            else await expect(preview.locator('[data-sync-preview-body]')).toContainText(file.marker, { timeout: 30000 });
            await preview.locator('[data-sync-preview-action="close"]').click();
            const downloading = second.waitForEvent('download');
            await message.locator('[data-sync-download-file]').click();
            const download = await downloading;
            expect(download.suggestedFilename()).toBe(file.name);
            expect(await readFile(await download.path())).toEqual(file.buffer);
        }

        await first.locator('[data-sync-devices]').click();
        await secondRow.locator('[data-sync-device-remove]').click();
        await first.locator('[data-sync-confirm-accept]').click();
        await expect(secondRow).toHaveCount(0, { timeout: 30000 });
        await first.locator('[data-sync-devices-dismiss]').click();
        await expect(second.locator('[data-sync-setup]')).toBeVisible({ timeout: 30000 });
        await expect.poll(async () => (await readSession(first)).keyring.currentKeyId).not.toBe(initialKeyId);
        await sendText(first, laterText);
        third = await contexts[2].newPage();
        let interruptedKeyAcknowledgement = false;
        interceptApi = request => {
            if (request.method === 'DELETE' && /\/key-grants$/.test(request.url)
                && request.headers.get('Authorization') === `Bearer ${thirdSession.token}` && !interruptedKeyAcknowledgement) {
                interruptedKeyAcknowledgement = true;
                return false;
            }
        };
        await openApp(third);
        await expect.poll(async () => (await readSession(third)).keyring.currentKeyId).toBe((await readSession(first)).keyring.currentKeyId);
        await expect.poll(() => interruptedKeyAcknowledgement).toBe(true);
        await third.reload();
        if (await third.locator('[data-window-action="minimize"]').isVisible()) await third.locator('[data-window-action="minimize"]').click();
        await third.locator('[data-open-sync-space]').first().click();
        await awaitOnline(third);
        await expect(third.locator('[data-sync-messages]')).toContainText(laterText, { timeout: 30000 });
        expect((await readSession(third)).keyring.currentKeyId).toBe((await readSession(first)).keyring.currentKeyId);
        const revokedResponse = await fetch(`${apiOrigin}/v1/spaces/${oldSession.roomId}/messages`, { headers: { Origin: siteOrigin, Authorization: `Bearer ${oldSession.token}` } });
        expect(revokedResponse.status).toBe(401);
        const latest = messageBodies.at(-1);
        const envelope = JSON.parse(Buffer.from(latest.text.slice('e2ee1.'.length), 'base64url').toString());
        expect(envelope.keyId).not.toBe(initialKeyId);
        expect(Object.hasOwn(oldSession.keyring.keys, envelope.keyId)).toBe(false);
        await pair(second);
        const rejoined = await readSession(second);
        expect(rejoined.deviceId).not.toBe(oldSession.deviceId);
        const afterRejoin = 'new-device-after-revoke-新成员';
        await sendText(second, afterRejoin);
        for (const page of [first, third]) await expect(page.locator('[data-sync-messages]')).toContainText(afterRejoin, { timeout: 30000 });
        expect(wireBodies.length).toBeGreaterThan(10);
        const all = Buffer.concat(wireBodies);
        for (const forbidden of [sentText, renamed, renamedText, laterText, afterRejoin, 'private-note-文档.txt', 'private-image-图片.png', 'private-reaction-表情.gif', 'private-workbook-表格.xlsx', 'private-paper-文档.pdf', 'private-video-视频.mp4', text.toString(), 'confidential-workbook-cell']) {
            expect(all.includes(Buffer.from(forbidden)), `backend must not receive ${forbidden}`).toBe(false);
        }
        expect(all.includes(png)).toBe(false);
        expect(all.includes(gif)).toBe(false);
        expect(all.includes(xlsx)).toBe(false);
        expect(all.includes(pdf)).toBe(false);
        expect(all.includes(mp4)).toBe(false);
        const roomKeys = new Set(Object.values(oldSession.keyring.keys));
        for (const page of [first, third]) {
            for (const key of Object.values((await readSession(page)).keyring.keys)) roomKeys.add(key);
        }
        for (const key of roomKeys) {
            expect(all.includes(Buffer.from(key)), 'backend must not receive a raw encoded room key').toBe(false);
            expect(all.includes(Buffer.from(key, 'base64url')), 'backend must not receive raw room key bytes').toBe(false);
        }
        for (const body of wireBodies) {
            let value;
            try { value = JSON.parse(body); } catch { continue; }
            const inspect = value => {
                if (typeof value === 'string') expect(pairedCodes.has(value), 'backend must not receive the pairing code').toBe(false);
                else if (Array.isArray(value)) value.forEach(inspect);
                else if (value && typeof value === 'object') {
                    expect(Object.hasOwn(value, 'code'), 'pairing requests must not contain a plaintext code field').toBe(false);
                    Object.values(value).forEach(inspect);
                }
            };
            inspect(value);
        }
        const stored = await (await fetch(`${apiOrigin}/v1/spaces/${oldSession.roomId}/messages`, {
            headers: { Origin: siteOrigin, Authorization: `Bearer ${(await readSession(first)).token}` }
        })).json();
        expect(stored.messages.every(message => message.text.startsWith('e2ee1.'))).toBe(true);
    } finally { await Promise.all(contexts.map(context => context.close())); }
});

for (const restore of ['live', 'reload', 'cross-tab']) {
test(`continues an encrypted upload after a new device pairs (${restore})`, async ({ browser, isMobile }, testInfo) => {
    test.skip(isMobile, 'upload rotation is exercised with isolated desktop browser contexts');
    test.setTimeout(180000);
    const contexts = await Promise.all(Array.from({ length: 2 }, () => browser.newContext({ acceptDownloads: true, viewport: { width: 1366, height: 900 } })));
    if (browser.browserType().name() === 'chromium') await Promise.all(contexts.map(context => context.grantPermissions(['local-network-access'])));
    contexts.forEach(context => context.setDefaultTimeout(15000));
    const [first, second] = await Promise.all(contexts.map(context => context.newPage()));
    const uploader = restore === 'cross-tab' ? await contexts[0].newPage() : first;
    let uploadAborted = false;
    let uploadSockets = 0;
    uploader.on('websocket', () => { uploadSockets++; });
    if (restore === 'cross-tab') await uploader.routeWebSocket(`${apiOrigin.replace(/^http/, 'ws')}/**`, socket => {
        const server = socket.connectToServer();
        server.onMessage(data => {
            if (data !== 'pong' && JSON.parse(data).type === 'key-rotation') return;
            socket.send(data);
        });
    });
    const file = { name: 'pairing-during-upload.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(9 * 1024 * 1024, 0x3c) };
    file.buffer.write('preserve-encrypted-chunks-across-pairing');
    file.buffer[file.buffer.length - 1] = 0xe7;
    const uploadPath = testInfo.outputPath(file.name);
    await writeFile(uploadPath, file.buffer);
    const uploads = [];
    const chunks = [];
    let heldChunk = false;
    let staleChunkStatus;
    let releaseChunk;
    const released = new Promise(resolve => { releaseChunk = resolve; });
    interceptApi = async (request, forward) => {
        const pathname = new URL(request.url).pathname;
        if (request.method === 'POST' && /\/files\/uploads$/.test(pathname)) {
            const result = await forward();
            const body = await result.clone().json();
            if (result.ok && body.uploadId) uploads.push({
                clientId: (await request.clone().json()).clientId,
                keyId: request.headers.get('X-Sync-Key-Id'),
                uploadId: body.uploadId,
                receivedBytes: body.receivedBytes
            });
            return result;
        }
        if (request.method !== 'PUT' || !/\/files\/uploads\/[^/]+\/chunks\/\d+$/.test(pathname)) return;
        request.signal.addEventListener('abort', () => { uploadAborted = true; }, { once: true });
        const index = Number(pathname.split('/').at(-1));
        const chunk = { index, keyId: request.headers.get('X-Sync-Key-Id') };
        chunks.push(chunk);
        if (index === 1 && !heldChunk) {
            heldChunk = true;
            await released;
            if (restore === 'reload') return false;
            const response = await forward();
            staleChunkStatus = response.status;
            return response;
        }
    };
    try {
        await Promise.all([openApp(first), openApp(second)]);
        await first.locator('[data-sync-create]').click();
        await awaitOnline(first);
        await expect(first.locator('[data-sync-pair-code]')).toHaveText(/^\d{4}$/, { timeout: 30000 });
        const code = await first.locator('[data-sync-pair-code]').textContent();
        const previousKeyId = (await readSession(first)).keyring.currentKeyId;
        if (restore === 'cross-tab') { await openApp(uploader); await awaitOnline(uploader); }
        await uploader.locator('[data-sync-file-input]').setInputFiles(uploadPath);
        await uploader.locator('[data-sync-send]').click();
        await expect.poll(() => heldChunk, { timeout: 30000 }).toBe(true);
        expect(uploads).toHaveLength(1);
        expect(uploads[0].receivedBytes).toBe(0);
        expect(chunks.filter(chunk => chunk.index === 0)).toHaveLength(1);
        expect(chunks.find(chunk => chunk.index === 1).keyId).toBe(previousKeyId);

        await second.locator('[data-sync-code]').fill(code);
        await second.locator('[data-sync-join]').click();
        await awaitOnline(second);
        await expect.poll(async () => (await readSession(first)).keyring.currentKeyId).not.toBe(previousKeyId);
        const currentKeyId = (await readSession(second)).keyring.currentKeyId;
        expect(currentKeyId).not.toBe(previousKeyId);
        if (restore === 'reload') {
            await first.reload();
            releaseChunk();
            if (await first.locator('[data-window-action="minimize"]').isVisible()) await first.locator('[data-window-action="minimize"]').click();
            if (!await first.locator('[data-sync-window]').isVisible()) await first.locator('[data-open-sync-space]').first().click();
            await awaitOnline(first);
            await expect(first.locator('[data-sync-selected-file]')).toBeVisible();
            await first.locator('[data-sync-file-input]').setInputFiles(uploadPath);
            await first.locator('[data-sync-send]').click();
        } else {
            if (restore === 'cross-tab') {
                await expect(uploader.locator('[data-sync-upload-status]')).toBeVisible();
                await expect(uploader.locator('[data-sync-file-name]')).toHaveText(file.name);
                expect(uploadSockets).toBe(1);
                expect(uploadAborted).toBe(false);
            }
            releaseChunk();
        }

        const message = second.locator('.sync-message').filter({ has: second.locator('.sync-attachment-name', { hasText: file.name }) });
        await expect(message).toBeVisible({ timeout: 30000 });
        if (restore !== 'reload') expect(staleChunkStatus).toBe(409);
        expect(uploads.length).toBeGreaterThanOrEqual(2);
        expect(new Set(uploads.map(upload => upload.uploadId)).size).toBe(1);
        expect(new Set(uploads.map(upload => upload.clientId)).size).toBe(1);
        expect(uploads[0].keyId).toBe(previousKeyId);
        expect(uploads.at(-1).keyId).toBe(currentKeyId);
        expect(uploads.at(-1).receivedBytes).toBe(8 * 1024 * 1024);
        expect(chunks.filter(chunk => chunk.index === 0)).toHaveLength(1);
        expect(chunks.filter(chunk => chunk.index === 1)).toHaveLength(2);
        expect(chunks.at(-1).keyId).toBe(currentKeyId);
        if (restore === 'cross-tab') { expect(uploadSockets).toBe(1); expect(uploadAborted).toBe(false); }

        const downloading = second.waitForEvent('download');
        await message.locator('[data-sync-download-file]').click();
        const download = await downloading;
        expect(download.suggestedFilename()).toBe(file.name);
        expect(await readFile(await download.path())).toEqual(file.buffer);
    } finally {
        releaseChunk();
        await Promise.all(contexts.map(context => context.close()));
    }
});
}
