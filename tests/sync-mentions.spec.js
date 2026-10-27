const { createDecipheriv } = require('node:crypto');
const { test, expect, roomId, deviceId, otherId, keyId, session, encrypt, authorize, message, profile } = require('./fixtures/sync-e2ee.cjs');

test.use({ serviceWorkers: 'block' });
const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS' };
const decode = (body, purpose = `message:${deviceId}:${body.clientId}`) => {
    const envelope = JSON.parse(Buffer.from(body.text.slice(6), 'base64url'));
    const bytes = Buffer.from(envelope.ciphertext, 'base64url');
    const cipher = createDecipheriv('aes-256-gcm', Buffer.from(session.keyring.keys[envelope.keyId], 'base64url'), Buffer.from(envelope.iv, 'base64url'));
    cipher.setAAD(Buffer.from(`gavin-sync-v1:${roomId}:${purpose}`));
    cipher.setAuthTag(bytes.subarray(-16));
    return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(0, -16)), cipher.final()]));
};
const openChat = async (page, initial = [], handler) => {
    await authorize(page);
    await page.route('**/portfolio/sync-config.json', route => route.fulfill({ json: { apiBase: 'https://sync.test' } }));
    const sent = [];
    let names = ['', ''];
    await page.route('https://sync.test/**', async route => {
        const request = route.request();
        if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
        if (await handler?.(route)) return;
        if (request.method() === 'POST' && request.url().endsWith('/messages')) {
            const body = request.postDataJSON();
            sent.push(body);
            return route.fulfill({ headers, json: { id: initial.length + sent.length, deviceId, clientId: body.clientId, text: body.text, createdAt: Date.now() } });
        }
        return route.fulfill({ headers, json: { deviceId, devices: [profile(names[0]), profile(names[1], otherId)], grants: [], hasMore: false, keyId } });
    });
    let connection;
    await page.routeWebSocket('wss://sync.test/**', socket => {
        connection = socket;
        socket.onMessage(raw => {
            if (raw === 'ping') return socket.send('pong');
            if (JSON.parse(raw).type === 'auth') socket.send(JSON.stringify({ type: 'ready', deviceId, messages: initial, pairing: null, readReceipts: [],
                history: { generation: '1', oldestId: initial.length ? 1 : null, latestId: initial.at(-1)?.id ?? null, continuationId: initial.at(-1)?.id ?? null, hasNewer: false }, historyMode: 'replace' }));
        });
    });
    const open = async () => {
        await page.goto('/portfolio/');
        if (await page.locator('[data-window-action="minimize"]').isVisible()) await page.locator('[data-window-action="minimize"]').click();
        if (!await page.locator('[data-sync-window]').isVisible()) await page.locator('.desktop-shortcut[data-open-sync-space]').click();
        await expect(page.locator('[data-sync-status]')).toHaveAttribute('data-state', 'online');
        await expect.poll(() => page.locator('[data-sync-device-name]').count()).toBe(2);
    };
    await open();
    return { sent, open, rename: value => { names = value; connection.send(JSON.stringify({ type: 'devices' })); } };
};
const choose = async page => {
    await page.locator('[data-sync-input]').fill('@');
    await expect(page.locator('[data-sync-mention-menu]')).toBeVisible();
    const option = page.locator(`[data-sync-mention-device="${otherId}"]`);
    if (test.info().project.use.hasTouch) await option.tap();
    else await option.click();
};

test('selects a member with the keyboard before Enter sends and encrypts the identity with the message', async ({ page }) => {
    const chat = await openChat(page);
    const input = page.locator('[data-sync-input]');
    await input.fill('@设');
    await expect(page.locator('[data-sync-mention-device]')).toHaveCount(1);
    await input.press('ArrowDown');
    await input.press('Enter');
    await expect(input).toHaveValue('@设备 2 ');
    expect(chat.sent).toHaveLength(0);
    await input.press('End');
    await input.pressSequentially('hello https://example.com');
    await input.press('Enter');
    await expect.poll(() => chat.sent.length).toBe(1);
    expect(decode(chat.sent[0])).toMatchObject({ text: '@设备 2 hello https://example.com', mentions: [{ deviceId: otherId, start: 0, end: 5 }] });
    expect(JSON.stringify(chat.sent[0])).not.toContain(otherId);
    expect(JSON.stringify(chat.sent[0])).not.toContain('@设备');
    await expect(page.locator('.sync-message [data-sync-mention]')).toHaveText('@设备 2');
    await expect(page.locator('.sync-message-text a')).toHaveAttribute('href', 'https://example.com/');
    await expect(input).toHaveValue('');
});

test('preserves encrypted mention drafts across reload and language changes and drops edited mentions', async ({ page }) => {
    const chat = await openChat(page);
    await choose(page);
    await expect.poll(async () => {
        const text = await page.evaluate(key => sessionStorage.getItem(key), `portfolio-sync-draft:${roomId}`);
        return text && decode({ text }, `draft:${deviceId}`).mentions;
    }).toEqual([{ deviceId: otherId, start: 0, end: 5 }]);
    await chat.open();
    await page.locator('[data-taskbar-lang]').click();
    const input = page.locator('[data-sync-input]');
    await expect(input).toHaveValue('@设备 2 ');
    await input.focus();
    await input.evaluate(element => element.setSelectionRange(0, 0));
    await input.pressSequentially('prefix ');
    await page.locator('[data-sync-send]').click();
    await expect.poll(() => chat.sent.length).toBe(1);
    expect(decode(chat.sent[0]).mentions).toEqual([{ deviceId: otherId, start: 7, end: 12 }]);
    await choose(page);
    await input.fill('changed @Device 2 manually');
    await page.locator('[data-sync-send]').click();
    await expect.poll(() => chat.sent.length).toBe(2);
    expect(decode(chat.sent[1]).mentions).toBeUndefined();
});

test('renders incoming mentions safely and identifies mentions of this device across language changes', async ({ page }) => {
    const incoming = message(1, '', otherId);
    incoming.text = encrypt(`message:${otherId}:${incoming.clientId}`, { text: '@<script> hello', mentions: [{ deviceId, start: 0, end: 9 }] });
    const invalid = message(2, '', otherId);
    invalid.text = encrypt(`message:${otherId}:${invalid.clientId}`, { text: '@invalid', mentions: [{ deviceId, start: 0, end: 300 }] });
    await openChat(page, [incoming, invalid]);
    await expect(page.locator('.sync-mention.is-self')).toHaveText('@<script>');
    await expect(page.locator('.sync-mention.is-self')).toHaveAttribute('title', '提到了你');
    await expect(page.locator('.sync-message-text script')).toHaveCount(0);
    await expect(page.locator('.sync-message').last()).toContainText('无法解密');
    await page.locator('[data-taskbar-lang]').click();
    await expect(page.locator('.sync-mention.is-self')).toHaveAttribute('title', 'Mentioned you');
});

test('keeps a selected mention encrypted with an attachment caption', async ({ page }) => {
    let uploaded;
    let bytes = 0;
    await openChat(page, [], async route => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        if (path.endsWith('/uploads')) {
            uploaded = request.postDataJSON();
            await route.fulfill({ headers, json: { uploadId: 'mention-upload', receivedBytes: 0, chunkSize: 8 * 1024 * 1024 } });
        } else if (path.includes('/chunks/')) {
            bytes += request.postDataBuffer().length;
            await route.fulfill({ headers, json: { receivedBytes: bytes } });
        } else if (path.endsWith('/complete')) await route.fulfill({ headers, json: { id: 1, deviceId, clientId: uploaded.clientId, text: uploaded.text, createdAt: Date.now() } });
        else return false;
        return true;
    });
    await choose(page);
    await page.locator('[data-sync-file-input]').setInputFiles({ name: 'mention.txt', mimeType: 'text/plain', buffer: Buffer.from('private attachment') });
    await page.locator('[data-sync-send]').click();
    await expect(page.locator('.sync-message[data-state="sent"]')).toHaveCount(1);
    expect(decode(uploaded)).toMatchObject({ text: '@设备 2 ', mentions: [{ deviceId: otherId, start: 0, end: 5 }], attachment: { name: 'mention.txt' } });
    expect(JSON.stringify(uploaded)).not.toContain(otherId);
});

test('does not open mentions for email addresses and closes the picker with Escape without sending', async ({ page }) => {
    const chat = await openChat(page);
    const input = page.locator('[data-sync-input]');
    await input.fill('person@example.com');
    await expect(page.locator('[data-sync-mention-menu]')).toBeHidden();
    await input.fill('@');
    await expect(page.locator('[data-sync-mention-menu]')).toBeVisible();
    const bounds = await page.locator('[data-sync-mention-menu]').boundingBox();
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(page.viewportSize().width);
    await input.press('Escape');
    await expect(page.locator('[data-sync-mention-menu]')).toBeHidden();
    await input.evaluate(element => element.setSelectionRange(0, 0));
    await input.press('ArrowLeft');
    await expect(page.locator('[data-sync-mention-menu]')).toBeHidden();
    await input.fill('你好@');
    await expect(page.locator('[data-sync-mention-menu]')).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('mention-menu.png') });
    expect(chat.sent).toHaveLength(0);
});

test('keeps the selected identity after a rename and retries the original mention without clearing a new draft', async ({ page }) => {
    const submissions = [];
    const chat = await openChat(page, [], async route => {
        const request = route.request();
        if (request.method() !== 'POST' || !request.url().endsWith('/messages')) return false;
        const body = request.postDataJSON();
        submissions.push(body);
        await route.fulfill({ headers, status: submissions.length === 1 ? 503 : 200,
            json: submissions.length === 1 ? { error: 'unavailable' } : { id: 1, deviceId, clientId: body.clientId, text: body.text, createdAt: Date.now() } });
        return true;
    });
    await choose(page);
    chat.rename(['', 'Alice']);
    await expect(page.locator(`[data-device-id="${otherId}"] [data-sync-device-name]`)).toHaveValue('Alice');
    await page.locator('[data-sync-send]').click();
    await expect(page.locator('.sync-message[data-state="failed"]')).toHaveCount(1);
    await choose(page);
    await expect(page.locator('[data-sync-input]')).toHaveValue('@Alice ');
    await page.locator('[data-sync-retry-message]:visible').click();
    await expect(page.locator('.sync-message[data-state="sent"]')).toHaveCount(1);
    expect(submissions[1]).toEqual(submissions[0]);
    expect(decode(submissions[1])).toMatchObject({ text: '@设备 2 ', mentions: [{ deviceId: otherId, start: 0, end: 5 }] });
    await expect(page.locator('[data-sync-input]')).toHaveValue('@Alice ');
});
