const { test, expect } = require('@playwright/test');
const { Miniflare } = require('../../cloudflare/sync/node_modules/miniflare');
const { createServer, request: httpRequest } = require('node:http');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const XLSX = require('xlsx');

module.exports = function setupSyncIntegration() {
    const root = path.resolve(__dirname, '../..');
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
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');
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
                    const { apiBase } = require('../../static/portfolio/sync-config.json');
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


    return { test, expect, siteOrigin, apiOrigin, wireBodies, messageBodies, sentText, renamed, renamedText, laterText,
        text, png, gif, xlsx, openApp, awaitOnline, sendText, readSession, watchSpaceConnections, expandSpaces, selectSpace,
        get pdf() { return pdf; }, get mp4() { return mp4; },
        set interceptApi(value) { interceptApi = value; }
    };
};
