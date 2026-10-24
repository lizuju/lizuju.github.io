const { test, expect } = require('@playwright/test');
const { Miniflare } = require('../cloudflare/sync/node_modules/miniflare');
const { createServer } = require('node:http');
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
let pdf;
let mp4;
const sentText = 'private-message-只在设备端解密';
const renamed = '机密设备名';
const renamedText = 'message-from-renamed-private-device';
const laterText = 'after-revocation-新密钥专用';
const text = Buffer.from('This confidential attachment stays encrypted at rest. 私密附件。');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aC1kAAAAASUVORK5CYII=', 'base64');
const book = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['Private sheet', 'Value'], ['confidential-workbook-cell', 12345]]), 'Private');
const xlsx = XLSX.write(book, { type: 'buffer', bookType: 'xlsx', compression: true });

test.beforeAll(async () => {
    [pdf, mp4] = await Promise.all([
        readFile(path.join(root, 'static/portfolio/assets/li-zuju-resume.pdf')),
        readFile(path.join(root, 'static/textures/monitor/video/base-static.mp4'))
    ]);
    runtime = new Miniflare({
        host: '127.0.0.1', port: 8793,
        workers: [{ config: {
            name: 'sync-browser-e2ee', compatibilityDate: '2026-10-23',
            manifest: { mainModule: 'index.js', modules: {
                'index.js': { type: 'esm', contents: await readFile(path.join(root, 'cloudflare/sync/src/index.js'), 'utf8') },
                'daily-usage.js': { type: 'esm', contents: await readFile(path.join(root, 'cloudflare/sync/src/daily-usage.js'), 'utf8') }
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
    site = createServer(async (request, response) => {
        try {
            const url = new URL(request.url, siteOrigin);
            if (url.pathname === '/portfolio/sync-config.json') {
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
test.afterAll(async () => {
    if (site) { site.closeAllConnections(); await new Promise(resolve => site.close(resolve)); }
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
const readSession = page => page.evaluate(async () => {
    const descriptor = JSON.parse(localStorage.getItem('portfolio-sync-space-e2ee1'));
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
});

test('pairs real devices, encrypts text and attachments, restores keys and revokes future access', async ({ browser, isMobile }) => {
    test.skip(isMobile, 'full desktop app protocol is exercised with isolated desktop browser contexts');
    test.setTimeout(180000);
    wireBodies.length = 0;
    messageBodies.length = 0;
    const pairedCodes = new Set();
    const contexts = await Promise.all(Array.from({ length: 3 }, () => browser.newContext({ acceptDownloads: true, viewport: { width: 1366, height: 900 } })));
    if (browser.browserType().name() === 'chromium') await Promise.all(contexts.map(context => context.grantPermissions(['local-network-access'])));
    contexts.forEach(context => context.setDefaultTimeout(15000));
    const pages = await Promise.all(contexts.map(context => context.newPage()));
    const [first, second] = pages;
    let third = pages[2];
    const capture = page => page.on('request', request => {
        if (!request.url().startsWith(apiOrigin)) return;
        const body = request.postDataBuffer();
        if (body) wireBodies.push(Buffer.from(body));
        if (request.method() === 'POST' && /\/messages$/.test(request.url())) messageBodies.push(JSON.parse(body.toString()));
    });
    pages.forEach(capture);
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
        await pair(third);
        await sendText(first, sentText);
        for (const page of [second, third]) await expect(page.locator('[data-sync-messages]')).toContainText(sentText);
        const oldSession = await readSession(second);
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
            { name: 'private-workbook-表格.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: xlsx, preview: 'spreadsheet', marker: 'confidential-workbook-cell' },
            { name: 'private-paper-文档.pdf', mimeType: 'application/pdf', buffer: pdf, preview: 'pdf' },
            { name: 'private-video-视频.mp4', mimeType: 'video/mp4', buffer: mp4, preview: 'video' }
        ]) {
            await first.locator('[data-sync-file-input]').setInputFiles(file);
            await first.locator('[data-sync-send]').click();
            const message = second.locator('.sync-message').filter({ has: second.locator('.sync-attachment-name', { hasText: file.name }) });
            await expect(message).toBeVisible({ timeout: 30000 });
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
        capture(third);
        let interruptedKeyAcknowledgement = false;
        await third.route('**/key-grants', route => {
            if (route.request().method() === 'DELETE' && !interruptedKeyAcknowledgement) {
                interruptedKeyAcknowledgement = true;
                return route.abort('failed');
            }
            return route.continue();
        });
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
        for (const forbidden of [sentText, renamed, renamedText, laterText, afterRejoin, 'private-note-文档.txt', 'private-image-图片.png', 'private-workbook-表格.xlsx', 'private-paper-文档.pdf', 'private-video-视频.mp4', text.toString(), 'confidential-workbook-cell']) {
            expect(all.includes(Buffer.from(forbidden)), `backend must not receive ${forbidden}`).toBe(false);
        }
        expect(all.includes(png)).toBe(false);
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

for (const restore of ['live', 'reload']) {
test(`continues an encrypted upload after a new device pairs (${restore})`, async ({ browser, isMobile }, testInfo) => {
    test.skip(isMobile, 'upload rotation is exercised with isolated desktop browser contexts');
    test.setTimeout(180000);
    const contexts = await Promise.all(Array.from({ length: 2 }, () => browser.newContext({ acceptDownloads: true, viewport: { width: 1366, height: 900 } })));
    if (browser.browserType().name() === 'chromium') await Promise.all(contexts.map(context => context.grantPermissions(['local-network-access'])));
    contexts.forEach(context => context.setDefaultTimeout(15000));
    const [first, second] = await Promise.all(contexts.map(context => context.newPage()));
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
    await first.route(`${apiOrigin}/v1/spaces/*/files/uploads`, async route => {
        if (route.request().method() !== 'POST') return route.continue();
        const request = route.request();
        const result = await route.fetch();
        const body = await result.json();
        if (result.ok() && body.uploadId) uploads.push({
            clientId: request.postDataJSON().clientId,
            keyId: request.headers()['x-sync-key-id'],
            uploadId: body.uploadId,
            receivedBytes: body.receivedBytes
        });
        await route.fulfill({ response: result });
    });
    await first.route(`${apiOrigin}/v1/spaces/*/files/uploads/*/chunks/*`, async route => {
        const request = route.request();
        if (request.method() !== 'PUT') return route.continue();
        const index = Number(new URL(request.url()).pathname.split('/').at(-1));
        const chunk = { index, keyId: request.headers()['x-sync-key-id'] };
        chunks.push(chunk);
        if (index === 1 && !heldChunk) {
            heldChunk = true;
            await released;
            if (restore === 'reload') return route.abort('aborted');
            const response = await route.fetch();
            staleChunkStatus = response.status();
            await route.fulfill({ response });
            return;
        }
        return route.continue();
    });
    try {
        await Promise.all([openApp(first), openApp(second)]);
        await first.locator('[data-sync-create]').click();
        await awaitOnline(first);
        await expect(first.locator('[data-sync-pair-code]')).toHaveText(/^\d{4}$/, { timeout: 30000 });
        const code = await first.locator('[data-sync-pair-code]').textContent();
        const previousKeyId = (await readSession(first)).keyring.currentKeyId;
        await first.locator('[data-sync-file-input]').setInputFiles(uploadPath);
        await first.locator('[data-sync-send]').click();
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
        } else releaseChunk();

        const message = second.locator('.sync-message').filter({ has: second.locator('.sync-attachment-name', { hasText: file.name }) });
        await expect(message).toBeVisible({ timeout: 30000 });
        if (restore === 'live') expect(staleChunkStatus).toBe(409);
        expect(uploads.length).toBeGreaterThanOrEqual(2);
        expect(new Set(uploads.map(upload => upload.uploadId)).size).toBe(1);
        expect(new Set(uploads.map(upload => upload.clientId)).size).toBe(1);
        expect(uploads[0].keyId).toBe(previousKeyId);
        expect(uploads.at(-1).keyId).toBe(currentKeyId);
        expect(uploads.at(-1).receivedBytes).toBe(8 * 1024 * 1024);
        expect(chunks.filter(chunk => chunk.index === 0)).toHaveLength(1);
        expect(chunks.filter(chunk => chunk.index === 1)).toHaveLength(2);
        expect(chunks.at(-1).keyId).toBe(currentKeyId);

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
