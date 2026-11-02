const setupSyncIntegration = require('./fixtures/sync-integration.cjs');
const harness = setupSyncIntegration();
const { test, expect, openApp, awaitOnline, readSession } = harness;
const { readFile, writeFile } = require('node:fs/promises');

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
    if (restore === 'cross-tab') await uploader.addInitScript(() => {
        const Channel = window.BroadcastChannel;
        window.BroadcastChannel = class extends Channel {
            constructor(name) {
                super(name);
                this.addEventListener('message', event => {
                    if (event.data?.type === 'frame' && event.data.data?.type === 'key-rotation') event.stopImmediatePropagation();
                });
            }
        };
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
    harness.interceptApi = async (request, forward) => {
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
                expect(uploadSockets).toBe(0);
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
        if (restore === 'cross-tab') { expect(uploadSockets).toBe(0); expect(uploadAborted).toBe(false); }

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
