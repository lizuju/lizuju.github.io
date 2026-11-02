const setupSyncIntegration = require('./fixtures/sync-integration.cjs');
const harness = setupSyncIntegration();
const { test, expect, siteOrigin, apiOrigin, wireBodies, messageBodies, sentText, renamed, renamedText, laterText, text, png, gif, xlsx, openApp, awaitOnline, sendText, readSession } = harness;
const { showSyncTools } = require('./fixtures/sync-tools.cjs');
const { readFile } = require('node:fs/promises');

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
    harness.interceptApi = async request => {
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
                await showSyncTools(first);
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
        harness.interceptApi = null;
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
        await showSyncTools(first);
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
            { name: 'private-paper-文档.pdf', mimeType: 'application/pdf', buffer: harness.pdf, preview: 'pdf' },
            { name: 'private-video-视频.mp4', mimeType: 'video/mp4', buffer: harness.mp4, preview: 'video' }
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

        await showSyncTools(first);
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
        harness.interceptApi = request => {
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
        expect(all.includes(harness.pdf)).toBe(false);
        expect(all.includes(harness.mp4)).toBe(false);
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
