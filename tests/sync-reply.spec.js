const { createDecipheriv } = require('node:crypto');
const { test, expect, roomId, deviceId, otherId, keyId, session, encrypt, authorize, message, profile, file } = require('./fixtures/sync-e2ee.cjs');

test.use({ serviceWorkers: 'block' });

const headers = {
    'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Sync-Key-Id',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS'
};
const bounds = latestId => ({ generation: '1', oldestId: latestId ? 1 : null, latestId, continuationId: latestId, hasNewer: false });
const confirmed = (body, id) => ({ id, deviceId, clientId: body.clientId, text: body.text, createdAt: Date.now() });
const openEnvelope = (encrypted, purpose) => {
    const envelope = JSON.parse(Buffer.from(encrypted.slice(6), 'base64url'));
    const bytes = Buffer.from(envelope.ciphertext, 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', Buffer.from(session.keyring.keys[envelope.keyId], 'base64url'), Buffer.from(envelope.iv, 'base64url'));
    decipher.setAAD(Buffer.from(`gavin-sync-v1:${roomId}:${purpose}`));
    decipher.setAuthTag(bytes.subarray(-16));
    return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(0, -16)), decipher.final()]));
};
const payload = body => openEnvelope(body.text, `message:${deviceId}:${body.clientId}`);
const quotedMessage = (id, text, reply) => {
    const item = message(id, text, otherId);
    item.text = encrypt(`message:${otherId}:${item.clientId}`, { text, reply });
    return item;
};
const openChat = async (page, history, handleRequest) => {
    await authorize(page);
    await page.route('**/portfolio/sync-config.json', route => route.fulfill({ json: { apiBase: 'https://sync.test' } }));
    await page.route('https://sync.test/**', async route => {
        if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
        if (await handleRequest?.(route)) return;
        return route.fulfill({ headers, json: { deviceId, devices: [profile(''), profile('', otherId)], grants: [], hasMore: false, keyId } });
    });
    let connection;
    await page.routeWebSocket('wss://sync.test/**', socket => {
        connection = socket;
        socket.onMessage(raw => {
            if (raw === 'ping') return socket.send('pong');
            if (JSON.parse(raw).type === 'auth') socket.send(JSON.stringify({
                type: 'ready', deviceId, messages: history, historyMode: 'replace', history: bounds(history.at(-1)?.id ?? null), readReceipts: [], pairing: null
            }));
        });
    });
    await page.goto('/portfolio/');
    await page.bringToFront();
    if (await page.locator('[data-window-action="minimize"]').isVisible()) await page.locator('[data-window-action="minimize"]').click();
    await page.locator('.desktop-shortcut[data-open-sync-space]').click();
    await expect(page.locator('[data-sync-status]')).toHaveAttribute('data-state', 'online');
    return frame => connection.send(JSON.stringify(frame));
};

test('encrypts the quoted snapshot and clears it immediately without clearing a new reply draft', async ({ page }) => {
    let sent;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    await openChat(page, [message(1, 'Original private message', otherId), message(2, 'Next original', otherId)], async route => {
        if (route.request().method() !== 'POST' || !route.request().url().endsWith('/messages')) return false;
        sent = route.request().postDataJSON();
        await gate;
        await route.fulfill({ headers, json: confirmed(sent, 3) });
        return true;
    });
    try {
        await page.locator('[data-sync-reply-message]').nth(0).click();
        await expect(page.locator('[data-sync-reply]')).toBeVisible();
        await expect(page.locator('[data-sync-reply-author]')).toHaveText('设备 2');
        await expect(page.locator('[data-sync-reply-text]')).toContainText('Original private message');
        await expect(page.locator('[data-sync-input]')).toBeFocused();
        await page.locator('[data-sync-input]').fill('Private answer');
        await page.locator('[data-sync-send]').click();
        await expect(page.locator('[data-sync-input]')).toHaveValue('');
        await expect(page.locator('[data-sync-reply]')).toBeHidden();
        const outgoing = page.locator('.sync-message[data-state="sending"]');
        await expect(outgoing.locator('.sync-message-quote-text')).toContainText('Original private message');
        await expect(outgoing.locator('[data-sync-reply-message]')).toBeHidden();
        await expect.poll(() => Boolean(sent)).toBe(true);
        expect(JSON.stringify(sent)).not.toContain('Original private message');
        expect(JSON.stringify(sent)).not.toContain('Private answer');
        expect(payload(sent)).toEqual({ text: 'Private answer', reply: { id: 1, deviceId: otherId, text: 'Original private message', attachmentName: '' } });
        await page.locator('[data-sync-reply-message]').nth(1).click();
        await page.locator('[data-sync-input]').fill('Next draft');
        release();
        await expect(page.locator('.sync-message[data-state="sent"]')).toHaveCount(3);
        await expect(page.locator('[data-sync-reply-text]')).toContainText('Next original');
        await expect(page.locator('[data-sync-input]')).toHaveValue('Next draft');
        await expect(page.locator('.sync-message').last().locator('.sync-message-quote-author')).toHaveText('设备 2');
    } finally { release(); }
});

test('restores an encrypted quote draft after reload, translates it and lets cancellation preserve the typed text', async ({ page }) => {
    await openChat(page, [message(1, 'Draft source', otherId)]);
    await page.locator('[data-sync-reply-message]').click();
    await page.locator('[data-sync-input]').fill('Draft to keep');
    await expect.poll(async () => {
        const raw = await page.evaluate(key => sessionStorage.getItem(key), `portfolio-sync-draft:${roomId}`);
        return raw ? openEnvelope(raw, `draft:${deviceId}`) : null;
    }).toMatchObject({ text: 'Draft to keep', reply: { id: 1, text: 'Draft source' } });
    const raw = await page.evaluate(key => sessionStorage.getItem(key), `portfolio-sync-draft:${roomId}`);
    expect(raw).not.toContain('Draft source');
    await page.reload();
    if (!await page.locator('[data-sync-window]').isVisible()) await page.locator('.desktop-shortcut[data-open-sync-space]').click();
    await expect(page.locator('[data-sync-status]')).toHaveAttribute('data-state', 'online');
    await expect(page.locator('[data-sync-reply-text]')).toContainText('Draft source');
    await expect(page.locator('[data-sync-input]')).toHaveValue('Draft to keep');
    await page.locator('[data-taskbar-lang]').click();
    await expect(page.locator('[data-sync-reply-author]')).toHaveText('Device 2');
    await expect(page.locator('[data-sync-reply-message]')).toHaveText('Reply');
    await expect(page.locator('[data-sync-reply-cancel]')).toHaveAttribute('aria-label', 'Cancel reply');
    await page.locator('[data-sync-reply-cancel]').click();
    await expect(page.locator('[data-sync-reply]')).toBeHidden();
    await expect(page.locator('[data-sync-input]')).toHaveValue('Draft to keep');
    await expect(page.locator('[data-sync-input]')).toBeFocused();
});

test('retains the original encrypted quote on failed-send retry while preserving a new quote draft', async ({ page }) => {
    const submissions = [];
    await openChat(page, [message(1, 'First source', otherId), message(2, 'Second source', otherId)], async route => {
        if (route.request().method() !== 'POST' || !route.request().url().endsWith('/messages')) return false;
        const body = route.request().postDataJSON();
        submissions.push(body);
        await route.fulfill({ status: submissions.length === 1 ? 503 : 200, headers, json: submissions.length === 1 ? { error: 'unavailable' } : confirmed(body, 3) });
        return true;
    });
    await page.locator('[data-sync-reply-message]').nth(0).click();
    await page.locator('[data-sync-input]').fill('Retry me');
    await page.locator('[data-sync-send]').click();
    await expect(page.locator('.sync-message[data-state="failed"]')).toHaveCount(1);
    await expect(page.locator('.sync-message[data-state="failed"] [data-sync-reply-message]')).toBeHidden();
    await page.locator('[data-sync-reply-message]').nth(1).click();
    await page.locator('[data-sync-input]').fill('Unsent second answer');
    await page.locator('[data-sync-retry-message]:visible').click();
    await expect(page.locator('.sync-message[data-state="sent"]')).toHaveCount(3);
    expect(submissions).toHaveLength(2);
    expect(submissions[1]).toEqual(submissions[0]);
    expect(payload(submissions[1]).reply.text).toBe('First source');
    await expect(page.locator('[data-sync-reply-text]')).toContainText('Second source');
    await expect(page.locator('[data-sync-input]')).toHaveValue('Unsent second answer');
});

test('quotes attachment names and keeps the quote encrypted when sending another attachment', async ({ page }) => {
    const original = file('private-report.bin', 'application/octet-stream', Buffer.from('report'));
    let uploaded;
    let receivedBytes = 0;
    await openChat(page, [message(1, '', otherId, original.metadata)], async route => {
        const request = route.request();
        const pathname = new URL(request.url()).pathname;
        if (pathname.endsWith('/uploads')) {
            uploaded = request.postDataJSON();
            await route.fulfill({ headers, json: { uploadId: 'reply-upload', receivedBytes: 0, chunkSize: 8 * 1024 * 1024 } });
        } else if (pathname.includes('/chunks/')) {
            receivedBytes += request.postDataBuffer().length;
            await route.fulfill({ headers, json: { receivedBytes } });
        } else if (pathname.endsWith('/complete')) await route.fulfill({ headers, json: confirmed(uploaded, 2) });
        else return false;
        return true;
    });
    await page.locator('[data-sync-reply-message]').click();
    await expect(page.locator('[data-sync-reply-text]')).toContainText('private-report.bin');
    await page.locator('[data-sync-file-input]').setInputFiles({ name: 'answer.txt', mimeType: 'text/plain', buffer: Buffer.from('file answer') });
    await page.locator('[data-sync-send]').click();
    await expect(page.locator('.sync-message[data-state="sent"]')).toHaveCount(2);
    expect(payload(uploaded)).toMatchObject({ text: '', reply: { id: 1, deviceId: otherId, text: '', attachmentName: 'private-report.bin' }, attachment: { name: 'answer.txt' } });
    expect(JSON.stringify(uploaded)).not.toContain('private-report.bin');
    await expect(page.locator('.sync-message').last().locator('.sync-message-quote-text')).toContainText('private-report.bin');
});

test('renders absent-source quotes as text, does not nest quotes and bounds long selections without breaking emoji', async ({ page }, testInfo) => {
    const source = '<img src=x onerror=alert(1)>';
    const long = '🙂'.repeat(350);
    await openChat(page, [quotedMessage(2, 'Current reply', { id: 1, deviceId: deviceId, text: source, attachmentName: '' }), message(3, long, otherId)]);
    const quoted = page.locator('.sync-message').first();
    await expect(quoted.locator('.sync-message-quote-text')).toHaveText(source);
    await expect(quoted.locator('.sync-message-quote img')).toHaveCount(0);
    await quoted.locator('[data-sync-reply-message]').click();
    await expect(page.locator('[data-sync-reply-text]')).toHaveText('Current reply');
    await page.locator('[data-sync-reply-message]').nth(1).click();
    await expect(page.locator('[data-sync-reply-text]')).toHaveText('🙂'.repeat(300));
    const strip = await page.locator('[data-sync-reply]').boundingBox();
    const cancel = await page.locator('[data-sync-reply-cancel]').boundingBox();
    expect(cancel.x).toBeGreaterThanOrEqual(strip.x);
    expect(cancel.x + cancel.width).toBeLessThanOrEqual(strip.x + strip.width + 1);
    expect(cancel.y + cancel.height).toBeLessThanOrEqual(strip.y + strip.height + 1);
    await page.screenshot({ path: testInfo.outputPath('reply.png') });
});

test('rejects malformed encrypted quote metadata and clears a selected quote when the room history is cleared', async ({ page }) => {
    const frame = await openChat(page, [message(1, 'Valid original', otherId), quotedMessage(2, 'Invalid reply', { id: -1, deviceId: otherId, text: 'forged', attachmentName: '' })]);
    const broken = page.locator('.sync-message').last();
    await expect(broken.locator('.sync-message-text')).toHaveText('此消息无法解密或已被篡改。');
    await expect(broken.locator('[data-sync-reply-message]')).toBeHidden();
    await expect(broken.locator('.sync-message-quote')).toHaveCount(0);
    await page.locator('[data-sync-reply-message]').first().click();
    await page.locator('[data-sync-input]').fill('Independent draft');
    frame({ type: 'cleared', history: { ...bounds(null), generation: '2' }, readReceipts: [] });
    await expect(page.locator('.sync-message')).toHaveCount(0);
    await expect(page.locator('[data-sync-reply]')).toBeHidden();
    await expect(page.locator('[data-sync-input]')).toHaveValue('Independent draft');
});
