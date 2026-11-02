const setupSyncIntegration = require('./fixtures/sync-integration.cjs');
const harness = setupSyncIntegration();
const { test, expect, siteOrigin, apiOrigin, wireBodies, messageBodies, text, png, openApp, awaitOnline, sendText, readSession, watchSpaceConnections } = harness;
const { showSyncTools } = require('./fixtures/sync-tools.cjs');
const { readFile, writeFile } = require('node:fs/promises');
const path = require('node:path');

test('sends lightweight encrypted stickers without uploads or download actions and preserves the text draft', async ({ browser, isMobile }, testInfo) => {
    test.setTimeout(60000);
    const contexts = await Promise.all(Array.from({ length: 2 }, () => browser.newContext({
        viewport: isMobile ? { width: 320, height: 568 } : { width: 1366, height: 900 }, isMobile, hasTouch: isMobile
    })));
    if (browser.browserType().name() === 'chromium') await Promise.all(contexts.map(context => context.grantPermissions(['local-network-access'])));
    const [sender, receiver] = await Promise.all(contexts.map(context => context.newPage()));
    const uploadRequests = [];
    harness.interceptApi = request => { if (/\/files\/uploads/.test(request.url)) uploadRequests.push(request.url); };
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
        await expect(sender.locator('[data-sync-sticker-choice]')).toHaveCount(18);
        await expect(sender.locator('[data-sync-sticker-choice="like"] + [data-sync-sticker-choice="dislike"]')).toContainText('倒拇指');
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
        await expect(receiver.locator('[data-sync-sticker-choice="dislike"]')).toContainText('Thumbs down');
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
        await sender.locator('[data-sync-stickers]').click();
        await sender.locator('[data-sync-sticker-choice="dislike"]').click();
        for (const page of [sender, receiver]) {
            const thumbsDown = page.locator('.sync-message-sticker[data-sync-sticker="dislike"]');
            await expect(thumbsDown).toBeVisible();
            await expect.poll(() => thumbsDown.locator('img').evaluate(image => image.naturalWidth)).toBe(128);
        }
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


test('shares desktop and standalone tabs, hands over ownership and decrypts thumbnails after pairing rotates keys', async ({ browser, isMobile }) => {
    test.setTimeout(120000);
    const contexts = await Promise.all(Array.from({ length: 2 }, () => browser.newContext({
        viewport: isMobile ? { width: 320, height: 568 } : { width: 1366, height: 900 }
    })));
    if (browser.browserType().name() === 'chromium') await Promise.all(contexts.map(context => context.grantPermissions(['local-network-access'])));
    contexts.forEach(context => context.setDefaultTimeout(15000));
    const first = await contexts[0].newPage();
    const second = await contexts[0].newPage();
    const peer = await contexts[1].newPage();
    const firstConnections = watchSpaceConnections(first);
    const secondConnections = watchSpaceConnections(second);
    const challenges = [];
    const downloads = [];
    harness.interceptApi = request => {
        if (request.method === 'POST' && /\/pair-challenge$/.test(request.url)) challenges.push(request.url);
        if (/\/files\/\d+(\/download|\?|$)/.test(request.url)) downloads.push(request.url);
    };
    try {
        await openApp(first);
        await first.locator('[data-sync-create]').click();
        await awaitOnline(first);
        await sendText(first, 'before another tab');
        await expect(first.locator('[data-sync-messages]')).toContainText('before another tab');
        await second.goto(`${siteOrigin}/chat/`);
        await awaitOnline(second);
        await expect(second.locator('[data-sync-messages]')).toContainText('before another tab');
        expect(firstConnections.length + secondConnections.length).toBe(1);
        await sendText(second, 'sent from follower');
        await expect(first.locator('[data-sync-messages]')).toContainText('sent from follower');
        await expect(first.locator('[data-sync-pair-code]')).toHaveText(/^\d{4}$/);
        const code = await first.locator('[data-sync-pair-code]').textContent();
        await peer.goto(`${siteOrigin}/chat/`);
        await peer.locator('[data-sync-code]').fill(code);
        await peer.locator('[data-sync-join]').click();
        await awaitOnline(peer);
        expect(challenges).toHaveLength(1);
        await sendText(peer, 'after key rotation');
        for (const page of [first, second]) await expect(page.locator('[data-sync-messages]')).toContainText('after key rotation');
        await sendText(second, 'follower uses new key');
        await expect(peer.locator('[data-sync-messages]')).toContainText('follower uses new key');
        for (const file of [
            { name: 'encrypted-thumbnail.png', mimeType: 'image/png', buffer: png, width: 1 },
            { name: 'encrypted-thumbnail.heic', mimeType: 'image/heic', buffer: await readFile(path.join(__dirname, 'fixtures/heic-gradient.heic')), width: 64 }
        ]) {
            const downloadsBefore = downloads.length;
            await expect(second.locator('[data-sync-attach]')).toBeEnabled();
            await second.locator('[data-sync-file-input]').setInputFiles(file);
            await second.locator('[data-sync-send]').click();
            for (const page of [first, second, peer]) {
                const image = page.locator('.sync-message').filter({ hasText: file.name }).locator('.sync-message-image img');
                await expect(image).toHaveAttribute('src', /^data:image\/(webp|jpeg);base64,/);
                await expect.poll(() => image.evaluate(image => image.naturalWidth)).toBe(file.width);
            }
            expect(downloads.length).toBe(downloadsBefore);
            expect(Buffer.concat(wireBodies).includes(Buffer.from('data:image/'))).toBe(false);
            await peer.locator('.sync-message').filter({ hasText: file.name }).locator('.sync-message-image').click();
            await expect.poll(() => peer.locator('[data-sync-preview-window] img').evaluate(image => image.naturalWidth)).toBe(file.width);
            expect(downloads.length).toBeGreaterThan(downloadsBefore);
            await peer.locator('[data-sync-preview-action="close"]').click();
        }
        await first.close();
        await expect.poll(() => secondConnections.length).toBe(1);
        await awaitOnline(second);
        await sendText(peer, 'after leader closed');
        await expect(second.locator('[data-sync-messages]')).toContainText('after leader closed');
        await second.reload();
        await awaitOnline(second);
        await expect(second.locator('[data-sync-messages]')).toContainText('after leader closed');
        const member = await readSession(peer);
        await showSyncTools(second);
        await second.locator('[data-sync-devices]').click();
        await second.locator(`[data-device-id="${member.deviceId}"] [data-sync-device-remove]`).click();
        await second.locator('[data-sync-confirm-accept]').click();
        await expect(peer.locator('[data-sync-setup]')).toBeVisible();
    } finally { await Promise.all(contexts.map(context => context.close())); }
});
