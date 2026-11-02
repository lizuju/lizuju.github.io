const setupSyncIntegration = require('./fixtures/sync-integration.cjs');
const harness = setupSyncIntegration();
const { test, expect, siteOrigin, apiOrigin, wireBodies, text, png, awaitOnline, sendText, readSession, expandSpaces, selectSpace } = harness;
const { showSyncTools, hideSyncTools } = require('./fixtures/sync-tools.cjs');

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
        await showSyncTools(page);
        await page.locator('[data-sync-space-rename]').click();
        await page.locator('[data-sync-space-name]').fill(name);
        await expect(page.locator('[data-sync-space-name]')).toHaveValue(expected);
        await page.locator('[data-sync-space-name-form] button[type="submit"]').click();
        await expect(page.locator('[data-sync-space-name-dialog]')).toBeHidden();
        await expect.poll(() => page.evaluate(() => document.activeElement.matches('[data-sync-tools-toggle], [data-sync-space-rename]') && document.activeElement.getClientRects().length > 0)).toBe(true);
        await hideSyncTools(page);
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
        harness.interceptApi = async (request, forward) => {
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
        await showSyncTools(member);
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
