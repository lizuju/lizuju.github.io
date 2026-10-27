const { test, expect, deviceId, otherId, keyId, authorize, message } = require('./fixtures/sync-e2ee.cjs');

test.use({ serviceWorkers: 'block' });

const headers = {
    'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Sync-Key-Id',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS'
};
const bounds = id => ({ generation: '1', oldestId: id ? 1 : null, latestId: id, continuationId: id, hasNewer: false });
const confirmed = (body, id) => ({ id, deviceId, clientId: body.clientId, text: body.text, createdAt: Date.now() });
const receipt = page => page.locator('.sync-message.is-own .sync-message-read');

const openChat = async (page, handleRequest) => {
    await authorize(page);
    await page.route('**/portfolio/sync-config.json', route => route.fulfill({ json: { apiBase: 'https://sync.test' } }));
    await page.route('https://sync.test/**', async route => {
        if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
        if (await handleRequest?.(route)) return;
        return route.fulfill({ headers, json: { deviceId, devices: [], grants: [], hasMore: false, keyId } });
    });
    let connection;
    await page.routeWebSocket('wss://sync.test/**', socket => {
        connection = socket;
        socket.onMessage(raw => {
            if (raw === 'ping') return socket.send('pong');
            if (JSON.parse(raw).type === 'auth') socket.send(JSON.stringify({
                type: 'ready', deviceId, messages: [], historyMode: 'replace', history: bounds(null), readReceipts: [], pairing: null
            }));
        });
    });
    await page.goto('/portfolio/');
    await page.bringToFront();
    if (await page.locator('[data-window-action="minimize"]').isVisible()) await page.locator('[data-window-action="minimize"]').click();
    await page.locator('.desktop-shortcut[data-open-sync-space]').click();
    await expect(page.locator('[data-sync-status]')).toHaveAttribute('data-state', 'online');
    return {
        send: async text => {
            await page.locator('[data-sync-input]').fill(text);
            await page.locator('[data-sync-send]').click();
        },
        echo: (item, generation = '1') => connection.send(JSON.stringify({ type: 'message', message: item, history: { ...bounds(item.id), generation } })),
        clear: () => connection.send(JSON.stringify({ type: 'cleared', history: { ...bounds(null), generation: '2' }, readReceipts: [] })),
        read: (sender, id) => connection.send(JSON.stringify({ type: 'read', deviceId: sender, messageId: id }))
    };
};

test('clears the composer immediately, keeps an identical new draft, and changes the sent check from grey to blue only for another reader', async ({ page }) => {
    let submitted;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const chat = await openChat(page, async route => {
        if (route.request().method() !== 'POST' || !route.request().url().endsWith('/messages')) return false;
        submitted = route.request().postDataJSON();
        await gate;
        await route.fulfill({ headers, json: confirmed(submitted, 1) });
        return true;
    });
    try {
        await chat.send('Identical text');
        await expect(page.locator('[data-sync-input]')).toHaveValue('');
        await expect(page.locator('.sync-message[data-state="sending"]')).toHaveCount(1);
        await expect(page.locator('.sync-message-text')).toHaveText('Identical text');
        await expect(receipt(page)).toBeHidden();
        await page.locator('[data-sync-input]').fill('Identical text');
        release();
        await expect(page.locator('.sync-message[data-state="sent"]')).toHaveCount(1);
        await expect(receipt(page)).toHaveAttribute('data-state', 'sent');
        await expect(receipt(page)).toHaveText('✓');
        const sentColor = await receipt(page).evaluate(element => getComputedStyle(element).color);
        await expect(page.locator('[data-sync-input]')).toHaveValue('Identical text');
        chat.echo(confirmed(submitted, 1));
        await expect(page.locator('.sync-message')).toHaveCount(1);
        chat.read(deviceId, 1);
        await expect(receipt(page)).toHaveAttribute('data-state', 'sent');
        chat.read(otherId, 1);
        await expect(receipt(page)).toHaveAttribute('data-state', 'read');
        expect(await receipt(page).evaluate(element => getComputedStyle(element).color)).not.toBe(sentColor);
        await expect(page.locator('[data-sync-input]')).toHaveValue('Identical text');
    } finally { release(); }
});

test('ignores a successful send response invalidated by clearing history and still accepts the next send', async ({ page }) => {
    let release;
    let firstRequest = false;
    const gate = new Promise(resolve => { release = resolve; });
    let requests = 0;
    const chat = await openChat(page, async route => {
        if (route.request().method() !== 'POST' || !route.request().url().endsWith('/messages')) return false;
        const body = route.request().postDataJSON();
        const id = ++requests;
        if (id === 1) {
            firstRequest = true;
            await gate;
        }
        await route.fulfill({ headers, json: confirmed(body, id === 1 ? 1 : 3) });
        return true;
    });
    try {
        await chat.send('Message before the clear');
        await expect.poll(() => firstRequest).toBe(true);
        await page.locator('[data-sync-input]').fill('Draft after the clear');
        chat.clear();
        await expect(page.locator('.sync-message')).toHaveCount(0);
        chat.echo(message(2, 'New peer message after the clear', otherId), '2');
        await expect(page.locator('.sync-message-text')).toHaveText('New peer message after the clear');
        release();
        await expect(page.locator('[data-sync-send]')).toBeEnabled();
        await expect(page.locator('.sync-message-text')).toHaveText('New peer message after the clear');
        await expect(page.locator('[data-sync-input]')).toHaveValue('Draft after the clear');
        await page.locator('[data-sync-send]').click();
        await expect(page.locator('.sync-message[data-state="sent"]')).toHaveCount(2);
        await expect(page.locator('.sync-message-text')).toHaveText(['New peer message after the clear', 'Draft after the clear']);
    } finally { release(); }
});

test('keeps a socket-confirmed message sent when the corresponding HTTP request subsequently fails', async ({ page }) => {
    let submitted;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const chat = await openChat(page, async route => {
        if (route.request().method() !== 'POST' || !route.request().url().endsWith('/messages')) return false;
        submitted = route.request().postDataJSON();
        await gate;
        await route.abort('failed');
        return true;
    });
    try {
        await chat.send('Socket wins the race');
        await expect.poll(() => !!submitted).toBe(true);
        await expect(page.locator('[data-sync-input]')).toHaveValue('');
        await page.locator('[data-sync-input]').fill('Next independent draft');
        chat.echo(confirmed(submitted, 1));
        await expect(page.locator('.sync-message[data-state="sent"]')).toHaveCount(1);
        release();
        await expect(page.locator('[data-sync-send]')).toBeEnabled();
        await expect(receipt(page)).toHaveAttribute('data-state', 'sent');
        await expect(page.locator('[data-sync-retry-message]')).toBeHidden();
        await expect(page.locator('[data-sync-input]')).toHaveValue('Next independent draft');
        await expect(page.locator('.sync-message')).toHaveCount(1);
    } finally { release(); }
});

test('restores a failed bubble after reload and retries its original client id without overwriting the new draft', async ({ page }) => {
    const submissions = [];
    let retryRelease;
    const retryGate = new Promise(resolve => { retryRelease = resolve; });
    const chat = await openChat(page, async route => {
        if (route.request().method() !== 'POST' || !route.request().url().endsWith('/messages')) return false;
        const body = route.request().postDataJSON();
        submissions.push(body);
        if (submissions.length === 1) await route.fulfill({ status: 503, headers, json: { error: 'unavailable' } });
        else {
            await retryGate;
            await route.fulfill({ headers, json: confirmed(body, 1) });
        }
        return true;
    });
    try {
        await chat.send('Original failed message');
        await expect(page.locator('.sync-message[data-state="failed"]')).toHaveCount(1);
        await expect(page.locator('[data-sync-input]')).toHaveValue('');
        await expect(receipt(page)).toBeHidden();
        await page.locator('[data-sync-input]').fill('Do not replace this draft');
        await page.reload();
        if (!await page.locator('[data-sync-window]').isVisible()) await page.locator('.desktop-shortcut[data-open-sync-space]').click();
        await expect(page.locator('[data-sync-status]')).toHaveAttribute('data-state', 'online');
        await expect(page.locator('.sync-message[data-state="failed"]')).toHaveCount(1);
        await expect(page.locator('[data-sync-input]')).toHaveValue('Do not replace this draft');
        await page.locator('[data-sync-retry-message]').click();
        await expect(page.locator('.sync-message[data-state="sending"]')).toHaveCount(1);
        await expect.poll(() => submissions.length).toBe(2);
        expect(submissions[1].clientId).toBe(submissions[0].clientId);
        expect(submissions[1].text).toBe(submissions[0].text);
        await expect(page.locator('[data-sync-input]')).toHaveValue('Do not replace this draft');
        retryRelease();
        await expect(page.locator('.sync-message[data-state="sent"]')).toHaveCount(1);
        await expect(page.locator('.sync-message-text')).toHaveText('Original failed message');
        await expect(page.locator('[data-sync-input]')).toHaveValue('Do not replace this draft');
    } finally { retryRelease(); }
});

test('treats two successful sends with identical text as two distinct messages', async ({ page }) => {
    const submissions = [];
    const chat = await openChat(page, async route => {
        if (route.request().method() !== 'POST' || !route.request().url().endsWith('/messages')) return false;
        const body = route.request().postDataJSON();
        submissions.push(body);
        await route.fulfill({ headers, json: confirmed(body, submissions.length) });
        return true;
    });
    await chat.send('Send this twice');
    await expect(page.locator('.sync-message[data-state="sent"]')).toHaveCount(1);
    await chat.send('Send this twice');
    await expect(page.locator('.sync-message[data-state="sent"]')).toHaveCount(2);
    expect(submissions[0].clientId).not.toBe(submissions[1].clientId);
    await expect(page.locator('[data-sync-input]')).toHaveValue('');
    await expect(page.locator('.sync-message-text')).toHaveText(['Send this twice', 'Send this twice']);
});

test('restores and retries a failed sticker without losing the draft, then marks it sent and read', async ({ page }) => {
    const submissions = [];
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const chat = await openChat(page, async route => {
        if (route.request().method() !== 'POST' || !route.request().url().endsWith('/messages')) return false;
        const body = route.request().postDataJSON();
        submissions.push(body);
        if (submissions.length === 1) await route.fulfill({ status: 503, headers, json: { error: 'unavailable' } });
        else {
            await gate;
            await route.fulfill({ headers, json: confirmed(body, 1) });
        }
        return true;
    });
    try {
        await page.locator('[data-sync-input]').fill('Keep my unfinished message');
        await page.locator('[data-sync-stickers]').click();
        await page.locator('[data-sync-sticker-choice="happy"]').click();
        await expect(page.locator('.sync-message[data-state="failed"] [data-sync-sticker="happy"]')).toBeVisible();
        await expect(receipt(page)).toBeHidden();
        await expect(page.locator('[data-sync-input]')).toHaveValue('Keep my unfinished message');
        await expect(page.locator('[data-sync-download-file]')).toHaveCount(0);
        await page.reload();
        if (!await page.locator('[data-sync-window]').isVisible()) await page.locator('.desktop-shortcut[data-open-sync-space]').click();
        await expect(page.locator('[data-sync-status]')).toHaveAttribute('data-state', 'online');
        await expect(page.locator('.sync-message[data-state="failed"] [data-sync-sticker="happy"]')).toBeVisible();
        await expect(page.locator('[data-sync-input]')).toHaveValue('Keep my unfinished message');
        await page.locator('[data-sync-retry-message]').click();
        await expect(page.locator('.sync-message[data-state="sending"] [data-sync-sticker="happy"]')).toBeVisible();
        await expect(receipt(page)).toBeHidden();
        await expect.poll(() => submissions.length).toBe(2);
        expect(submissions[1]).toEqual(submissions[0]);
        expect(submissions[0].text).toMatch(/^e2ee1\./);
        expect(JSON.stringify(submissions)).not.toContain('happy');
        release();
        await expect(page.locator('.sync-message[data-state="sent"] [data-sync-sticker="happy"]')).toBeVisible();
        await expect(receipt(page)).toHaveAttribute('data-state', 'sent');
        await expect(receipt(page)).toHaveText('✓');
        const sentColor = await receipt(page).evaluate(element => getComputedStyle(element).color);
        chat.read(deviceId, 1);
        await expect(receipt(page)).toHaveAttribute('data-state', 'sent');
        chat.read(otherId, 1);
        await expect(receipt(page)).toHaveAttribute('data-state', 'read');
        expect(await receipt(page).evaluate(element => getComputedStyle(element).color)).not.toBe(sentColor);
        await expect(page.locator('[data-sync-input]')).toHaveValue('Keep my unfinished message');
        await expect(page.locator('.sync-message')).toHaveCount(1);
        await expect(page.locator('[data-sync-download-file]')).toHaveCount(0);
    } finally { release(); }
});

test('shows an uploading attachment immediately and enables preview and download after confirmation', async ({ page }) => {
    let uploaded;
    let completeRelease;
    let completing = false;
    const completeGate = new Promise(resolve => { completeRelease = resolve; });
    let receivedBytes = 0;
    const chat = await openChat(page, async route => {
        const url = new URL(route.request().url());
        if (url.pathname.endsWith('/uploads')) {
            uploaded = route.request().postDataJSON();
            await route.fulfill({ headers, json: { uploadId: 'pending-file', receivedBytes: 0, chunkSize: 8 * 1024 * 1024 } });
        } else if (url.pathname.includes('/chunks/')) {
            receivedBytes += route.request().postDataBuffer().length;
            await route.fulfill({ headers, json: { receivedBytes } });
        } else if (url.pathname.endsWith('/complete')) {
            completing = true;
            await completeGate;
            await route.fulfill({ headers, json: confirmed(uploaded, 1) });
        } else return false;
        return true;
    });
    try {
        await page.locator('[data-sync-file-input]').setInputFiles({ name: 'pending-note.txt', mimeType: 'text/plain', buffer: Buffer.from('Encrypted pending attachment') });
        await chat.send('File caption');
        await expect(page.locator('[data-sync-input]')).toHaveValue('');
        const bubble = page.locator('.sync-message');
        await expect(bubble).toHaveAttribute('data-state', 'sending');
        await expect(bubble).toContainText('pending-note.txt');
        await expect(bubble.locator('[data-sync-preview-file]')).toBeDisabled();
        await expect(bubble.locator('[data-sync-download-file]')).toBeDisabled();
        await expect(receipt(page)).toBeHidden();
        await expect.poll(() => completing).toBe(true);
        await page.locator('[data-sync-input]').fill('File caption');
        completeRelease();
        await expect(bubble).toHaveAttribute('data-state', 'sent');
        await expect(bubble.locator('[data-sync-preview-file]')).toBeEnabled();
        await expect(bubble.locator('[data-sync-download-file]')).toBeEnabled();
        await expect(page.locator('[data-sync-input]')).toHaveValue('File caption');
        await expect(bubble).toHaveCount(1);
    } finally { completeRelease(); }
});

test('sends and retries a quoted text independently while an attachment is still committing', async ({ page }) => {
    let uploaded;
    let completing = false;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const texts = [];
    const chat = await openChat(page, async route => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        if (path.endsWith('/uploads')) {
            uploaded = request.postDataJSON();
            await route.fulfill({ headers, json: { uploadId: 'parallel-file', receivedBytes: 0, chunkSize: 8 * 1024 * 1024 } });
        } else if (path.includes('/chunks/')) {
            await route.fulfill({ headers, json: { receivedBytes: request.postDataBuffer().length } });
        } else if (path.endsWith('/complete')) {
            completing = true;
            await gate;
            await route.fulfill({ headers, json: confirmed(uploaded, 3) });
        } else if (path.endsWith('/messages') && request.method() === 'POST') {
            texts.push(request.postDataJSON());
            await route.fulfill(texts.length === 1
                ? { status: 503, headers, json: { error: 'unavailable' } }
                : { headers, json: confirmed(texts.at(-1), 2) });
        } else return false;
        return true;
    });
    try {
        chat.echo(message(1, 'Reply source', otherId));
        await expect(page.locator('.sync-message-text')).toHaveText('Reply source');
        await page.locator('[data-sync-file-input]').setInputFiles({ name: 'parallel.txt', mimeType: 'text/plain', buffer: Buffer.from('Attachment in flight') });
        await chat.send('File caption');
        await expect.poll(() => completing).toBe(true);
        await page.locator('[data-sync-reply-message]').first().click();
        await page.locator('[data-sync-input]').fill('Text during upload');
        await expect(page.locator('[data-sync-send]')).toBeEnabled();
        await page.locator('[data-sync-input]').press('Enter');
        await expect(page.locator('[data-sync-input]')).toHaveValue('');
        await expect(page.locator('[data-sync-reply]')).toBeHidden();
        const failed = page.locator('.sync-message[data-state="failed"]');
        await expect(failed.locator('.sync-message-text')).toHaveText('Text during upload');
        await expect(failed.locator('.sync-message-quote-text')).toHaveText('Reply source');
        await expect(failed.locator('.sync-attachment')).toHaveCount(0);
        await expect(page.locator('[data-sync-upload-status]')).toBeVisible();
        await page.locator('[data-sync-input]').fill('Next draft');
        await failed.locator('[data-sync-retry-message]').click();
        const sentText = page.locator('.sync-message[data-state="sent"]').filter({ hasText: 'Text during upload' });
        await expect(sentText).toHaveCount(1);
        await expect(sentText.locator('.sync-message-read')).toHaveAttribute('data-state', 'sent');
        expect(texts).toHaveLength(2);
        expect(texts[1]).toEqual(texts[0]);
        expect(JSON.stringify(texts)).not.toContain('Text during upload');
        await expect(page.locator('.sync-message[data-state="sending"] .sync-attachment-name')).toHaveText('parallel.txt');
        await expect(page.locator('[data-sync-upload-status]')).toBeVisible();
        await expect(page.locator('[data-sync-file-input]')).toBeDisabled();
        chat.read(otherId, 2);
        await expect(sentText.locator('.sync-message-read')).toHaveAttribute('data-state', 'read');
        release();
        await expect(page.locator('.sync-message[data-state="sending"]')).toHaveCount(0);
        await expect(page.locator('.sync-message[data-state="sent"]')).toHaveCount(3);
        await expect(page.locator('[data-sync-upload-status]')).toBeHidden();
        await expect(page.locator('[data-sync-input]')).toHaveValue('Next draft');
    } finally { release(); }
});

test('cancels an attachment without cancelling a parallel text send or replacing its draft', async ({ page }) => {
    let chunkStarted = false;
    let textBody;
    let releaseChunk;
    let releaseText;
    const chunkGate = new Promise(resolve => { releaseChunk = resolve; });
    const textGate = new Promise(resolve => { releaseText = resolve; });
    let deletions = 0;
    const chat = await openChat(page, async route => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        if (path.endsWith('/uploads')) {
            await route.fulfill({ headers, json: { uploadId: 'cancel-file', receivedBytes: 0, chunkSize: 8 * 1024 * 1024 } });
        } else if (path.includes('/chunks/')) {
            chunkStarted = true;
            await chunkGate;
            await route.fulfill({ headers, json: { receivedBytes: request.postDataBuffer().length } });
        } else if (request.method() === 'DELETE' && path.endsWith('/cancel-file')) {
            deletions++;
            await route.fulfill({ headers, json: { ok: true } });
        } else if (path.endsWith('/messages') && request.method() === 'POST') {
            textBody = request.postDataJSON();
            await textGate;
            await route.fulfill({ headers, json: confirmed(textBody, 1) });
        } else return false;
        return true;
    });
    try {
        await page.locator('[data-sync-file-input]').setInputFiles({ name: 'cancel.txt', mimeType: 'text/plain', buffer: Buffer.from('Cancel only this attachment') });
        await chat.send('File caption');
        await expect.poll(() => chunkStarted).toBe(true);
        await chat.send('Keep this text');
        await expect.poll(() => !!textBody).toBe(true);
        await page.locator('[data-sync-input]').fill('Independent draft');
        await page.locator('[data-sync-cancel-upload]').click();
        await expect.poll(() => deletions).toBe(1);
        await expect(page.locator('.sync-attachment')).toHaveCount(0);
        await expect(page.locator('.sync-message[data-state="sending"] .sync-message-text')).toHaveText('Keep this text');
        await expect(page.locator('[data-sync-send]')).toBeDisabled();
        releaseChunk();
        releaseText();
        await expect(page.locator('.sync-message[data-state="sent"] .sync-message-text')).toHaveText('Keep this text');
        await expect(page.locator('[data-sync-input]')).toHaveValue('Independent draft');
        await expect(page.locator('[data-sync-send]')).toBeEnabled();
        await expect(page.locator('[data-sync-upload-status]')).toBeHidden();
    } finally { releaseChunk(); releaseText(); }
});

test('ignores both in-flight responses after another tab removes the paired session', async ({ page }) => {
    let completing = false;
    let texting = false;
    let responses = 0;
    let uploaded;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const chat = await openChat(page, async route => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        if (path.endsWith('/uploads')) {
            uploaded = request.postDataJSON();
            await route.fulfill({ headers, json: { uploadId: 'old-session-file', receivedBytes: 0, chunkSize: 8 * 1024 * 1024 } });
        } else if (path.includes('/chunks/')) {
            await route.fulfill({ headers, json: { receivedBytes: request.postDataBuffer().length } });
        } else if (path.endsWith('/complete')) {
            completing = true;
            await gate;
            await route.fulfill({ headers, json: confirmed(uploaded, 2) });
            responses++;
        } else if (path.endsWith('/messages') && request.method() === 'POST') {
            texting = true;
            const body = request.postDataJSON();
            await gate;
            await route.fulfill({ headers, json: confirmed(body, 1) });
            responses++;
        } else return false;
        return true;
    });
    try {
        await page.locator('[data-sync-file-input]').setInputFiles({ name: 'old-session.txt', mimeType: 'text/plain', buffer: Buffer.from('Old session attachment') });
        await chat.send('Old attachment caption');
        await expect.poll(() => completing).toBe(true);
        await chat.send('Old text');
        await expect.poll(() => texting).toBe(true);
        await page.evaluate(() => {
            const key = 'portfolio-sync-space-e2ee1';
            localStorage.removeItem(key);
            window.dispatchEvent(new StorageEvent('storage', { key, newValue: null }));
        });
        await expect(page.locator('[data-sync-setup]')).toBeVisible();
        await expect(page.locator('.sync-message')).toHaveCount(0);
        release();
        await expect.poll(() => responses).toBe(2);
        await expect(page.locator('[data-sync-create]')).toBeEnabled();
        await expect(page.locator('[data-sync-input]')).toHaveValue('');
        await expect(page.locator('.sync-message')).toHaveCount(0);
        await expect(page.locator('[data-sync-upload-status]')).toBeHidden();
    } finally { release(); }
});
