const { readFile } = require('node:fs/promises');
const { showSyncTools } = require('./fixtures/sync-tools.cjs');
const path = require('node:path');
const { test, expect, deviceId, otherId, keyId, session, profile, message, authorize } = require('./fixtures/sync-e2ee.cjs');

test.use({ serviceWorkers: 'block' });

const headers = {
    'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Sync-Key-Id',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS'
};
const bounds = latestId => ({ generation: '1', oldestId: 1, latestId, continuationId: latestId, hasNewer: false });

const openChat = async (page, history = [], handleRequest) => {
    await authorize(page);
    await page.route('**/portfolio/sync-config.json', route => route.fulfill({ json: { apiBase: 'https://sync.test' } }));
    const devices = [profile(''), profile('', otherId)];
    await page.route('https://sync.test/**', async route => {
        const request = route.request();
        if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
        if (await handleRequest?.(route)) return;
        if (request.method() === 'PATCH') devices.find(device => request.url().endsWith(`/${device.deviceId}`)).name = request.postDataJSON().name;
        return route.fulfill({ headers, json: { deviceId, devices, grants: [], requests: [], hasMore: false, keyId } });
    });
    let connection;
    await page.routeWebSocket('wss://sync.test/**', socket => {
        connection = socket;
        socket.onMessage(raw => {
            if (raw === 'ping') return socket.send('pong');
            if (JSON.parse(raw).type === 'auth') socket.send(JSON.stringify({
                type: 'ready', deviceId, messages: history, historyMode: 'replace', history: bounds(history.at(-1)?.id ?? null),
                readReceipts: [], pairing: null
            }));
        });
    });
    await page.goto('/portfolio/');
    await page.bringToFront();
    if (await page.locator('[data-window-action="minimize"]').isVisible()) await page.locator('[data-window-action="minimize"]').click();
    await page.locator('.desktop-shortcut[data-open-sync-space]').click();
    await expect(page.locator('[data-sync-status]')).toHaveAttribute('data-state', 'online');
    return data => connection.send(JSON.stringify(data));
};

const preparePair = async page => {
    await page.route('**/__sync-delivery/crypto.js', async route => route.fulfill({ contentType: 'application/javascript',
        body: (await readFile(path.resolve('static/portfolio/js/apps/sync-crypto.js'), 'utf8')).replace('@serenity-kit/opaque', './opaque.js') }));
    await page.route('**/__sync-delivery/opaque.js', async route => route.fulfill({ contentType: 'application/javascript',
        body: await readFile(path.resolve('node_modules/@serenity-kit/opaque/esm/index.js'), 'utf8') }));
    return page.evaluate(async session => {
        const crypto = await import('/__sync-delivery/crypto.js');
        const offerId = window.crypto.randomUUID();
        const secret = { ...await crypto.createPairingSecret('1234', offerId), ownerDeviceId: session.deviceId };
        const offer = { offerId, ownerDeviceId: session.deviceId, expiresAt: secret.expiresAt,
            secret: await crypto.encryptPayload(session.keyring, session.roomId, `offer:${offerId}`, secret) };
        const client = await crypto.startPairingClient('1234', offerId);
        window.deliveryPairClient = client;
        return { offer, request: { type: 'pair-request', offerId, requestId: window.crypto.randomUUID(),
            sourceId: 'a'.repeat(64), startLoginRequest: client.startLoginRequest } };
    }, session);
};

test('delivers messages while a pairing challenge is pending and ignores errors from a cancelled offer', async ({ page }) => {
    let challengeStarted = false;
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    const frame = await openChat(page, [], async route => {
        if (!route.request().url().endsWith('/pair-challenge')) return false;
        challengeStarted = true;
        await pending;
        await route.fulfill({ status: 403, headers, json: { error: 'invalid_ciphertext' } });
        return true;
    });
    try {
        const pairing = await preparePair(page);
        frame({ type: 'pairing', pairing: pairing.offer });
        await expect(page.locator('[data-sync-pair-code]')).toHaveText('1234');
        frame(pairing.request);
        await expect.poll(() => challengeStarted).toBe(true);
        frame({ type: 'message', message: message(1, 'Chat continues during pairing', otherId), history: bounds(1) });
        await expect(page.locator('.sync-message-text')).toHaveText('Chat continues during pairing');
        frame({ type: 'pairing', pairing: null });
        await expect(page.locator('[data-sync-pairing]')).toBeHidden();
        release();
        frame({ type: 'message', message: message(2, 'Chat continues after cancellation', otherId), history: bounds(2) });
        await expect(page.locator('.sync-message-text').last()).toHaveText('Chat continues after cancellation');
        await expect(page.locator('[data-sync-notice]')).not.toHaveText('此消息无法解密或已被篡改。');
        await expect(page.locator('[data-sync-status]')).toHaveAttribute('data-state', 'online');
    } finally { release(); }
});

test('updates failed decryption bubbles and their search text when the language changes', async ({ page }) => {
    const corrupted = { ...message(1, '', otherId), text: 'e2ee1.invalid' };
    await openChat(page, [corrupted]);
    const bubble = page.locator('.sync-message-text');
    await expect(bubble).toHaveText('此消息无法解密或已被篡改。');
    await expect(page.locator('[data-sync-copy-message]')).toBeHidden();
    await page.locator('[data-taskbar-lang]').click();
    await expect(bubble).toHaveText('This message could not be decrypted or was altered.');
    await showSyncTools(page);
    await page.locator('[data-sync-search]').fill('decrypted');
    await expect(bubble).toBeVisible();
    await page.locator('[data-taskbar-lang]').click();
    await expect(bubble).toBeHidden();
    await showSyncTools(page);
    await page.locator('[data-sync-search]').fill('无法解密');
    await expect(bubble).toBeVisible();
});

test('uses the same numbered or custom device names in the device list, message labels and search', async ({ page }) => {
    await openChat(page, [message(1, 'Local text'), message(2, 'Remote text', otherId)]);
    const labels = page.locator('.sync-message-meta > span:first-child');
    await expect(labels.nth(0)).toContainText('设备 1 ·');
    await expect(labels.nth(1)).toContainText('设备 2 ·');
    await showSyncTools(page);
    await page.locator('[data-sync-devices]').click();
    await expect(page.locator('.sync-device-heading strong')).toHaveText(['设备 1', '设备 2']);
    const name = page.locator('[data-sync-device-name]').nth(1);
    await name.fill('🚀一二三四五六七八');
    await expect(name).toHaveValue('🚀一二三四五六七');
    await page.locator('[data-sync-device-save]').nth(1).click();
    await expect(page.locator('.sync-device-heading strong').nth(1)).toHaveText('🚀一二三四五六七');
    await page.locator('[data-sync-devices-close]').click();
    await expect(labels.nth(1)).toContainText('🚀一二三四五六七 ·');
    await page.locator('[data-taskbar-lang]').click();
    await expect(labels.nth(0)).toContainText('Device 1 ·');
    await expect(labels.nth(1)).toContainText('🚀一二三四五六七 ·');
    await showSyncTools(page);
    await page.locator('[data-sync-search]').fill('Device 1');
    await expect(page.locator('.sync-message:visible .sync-message-text')).toHaveText('Local text');
    await showSyncTools(page);
    await page.locator('[data-sync-search]').fill('🚀一二三四五六七');
    await expect(page.locator('.sync-message:visible .sync-message-text')).toHaveText('Remote text');
});

test('does not block chat on pairing acceptance and still decrypts new-epoch messages after their key rotation', async ({ page }) => {
    let challenge;
    let acceptance;
    let grants = [];
    let keyRequested = false;
    let releaseAcceptance;
    let releaseKeys;
    const acceptancePending = new Promise(resolve => { releaseAcceptance = resolve; });
    const keysPending = new Promise(resolve => { releaseKeys = resolve; });
    const frame = await openChat(page, [], async route => {
        const request = route.request();
        if (request.url().endsWith('/pair-challenge')) {
            challenge = request.postDataJSON();
            await route.fulfill({ headers, json: { accepted: true } });
            return true;
        }
        if (request.url().endsWith('/pair-accept')) {
            acceptance = request.postDataJSON();
            await acceptancePending;
            await route.fulfill({ headers, json: { ok: true } });
            return true;
        }
        if (grants.length && request.url().endsWith('/key-grants')) {
            if (request.method() === 'DELETE') grants = [];
            else { keyRequested = true; await keysPending; }
            await route.fulfill({ headers, json: { grants, hasMore: false, keyId: acceptance.newKeyId } });
            return true;
        }
        return false;
    });
    try {
        const pairing = await preparePair(page);
        frame({ type: 'pairing', pairing: pairing.offer });
        await expect(page.locator('[data-sync-pair-code]')).toHaveText('1234');
        frame(pairing.request);
        await expect.poll(() => Boolean(challenge)).toBe(true);
        const finish = await page.evaluate(async ({ offerId, requestId, loginResponse }) => {
            const crypto = await import('/__sync-delivery/crypto.js');
            const matched = await crypto.finishPairingClient(window.deliveryPairClient.clientState, offerId, requestId, loginResponse);
            const identity = await crypto.createDeviceIdentity();
            return { type: 'pair-finish', offerId, requestId, finishLoginRequest: matched.finishLoginRequest,
                clientData: await crypto.encryptPairing(matched.sessionKey, offerId, requestId, { nonce: 'new-client', publicKey: identity.publicKey }) };
        }, challenge);
        frame(finish);
        await expect.poll(() => Boolean(acceptance)).toBe(true);
        frame({ type: 'message', message: message(1, 'Chat continues during acceptance', otherId), history: bounds(1) });
        await expect(page.locator('.sync-message-text')).toHaveText('Chat continues during acceptance');
        grants = [{ id: 1, rotationId: acceptance.rotationId, envelope: acceptance.grants.find(grant => grant.deviceId === deviceId).envelope }];
        const next = await page.evaluate(async ({ session, grant, sender }) => {
            const crypto = await import('/__sync-delivery/crypto.js');
            const next = await crypto.acceptKeyRotation(session, grant);
            const clientId = 'message-new-epoch';
            return { id: 2, clientId, deviceId: sender, createdAt: Date.now(), text: await crypto.encryptPayload(next.keyring,
                session.roomId, `message:${sender}:${clientId}`, { text: 'New epoch remains ordered', attachment: null }) };
        }, { session, grant: grants[0], sender: otherId });
        frame({ type: 'key-rotation' });
        frame({ type: 'message', message: next, history: bounds(2) });
        await expect.poll(() => keyRequested).toBe(true);
        await expect(page.locator('.sync-message-text')).toHaveCount(1);
        releaseKeys();
        await expect(page.locator('.sync-message-text').last()).toHaveText('New epoch remains ordered');
        await expect(page.locator('[data-sync-notice]')).not.toHaveText('此消息无法解密或已被篡改。');
        releaseAcceptance();
    } finally { releaseAcceptance(); releaseKeys(); }
});
