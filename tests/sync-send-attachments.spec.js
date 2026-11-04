const { test, expect, roomId, deviceId, otherId, message, headers, bounds, confirmed, spaceDot, receipt, openChat } = require('./fixtures/sync-send.cjs');

test.use({ serviceWorkers: 'block' });

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
        await expect(spaceDot(page)).toHaveAttribute('data-state', 'yellow');
        await page.locator('[data-sync-reply-message]').first().click();
        await page.locator('[data-sync-input]').fill('Text during upload');
        await expect(page.locator('[data-sync-send]')).toBeEnabled();
        await page.locator('[data-sync-input]').press('Enter');
        await expect(page.locator('[data-sync-input]')).toHaveValue('');
        await expect(page.locator('[data-sync-reply]')).toBeHidden();
        const failed = page.locator('.sync-message[data-state="failed"]');
        await expect(failed.locator('.sync-message-text')).toHaveText('Text during upload');
        await expect(spaceDot(page)).toHaveCount(1);
        await expect(spaceDot(page)).toHaveAttribute('data-state', 'red');
        await expect(failed.locator('.sync-message-quote-text')).toHaveText('Reply source');
        await expect(failed.locator('.sync-attachment')).toHaveCount(0);
        await expect(page.locator('[data-sync-upload-status]')).toBeVisible();
        await page.locator('[data-sync-input]').fill('Next draft');
        await failed.locator('[data-sync-retry-message]').click();
        const sentText = page.locator('.sync-message[data-state="sent"]').filter({ hasText: 'Text during upload' });
        await expect(sentText).toHaveCount(1);
        await expect(spaceDot(page)).toHaveAttribute('data-state', 'yellow');
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
        await expect(spaceDot(page)).toBeHidden();
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


test('clears an already-delivered attachment retry without uploading it again', async ({ page }) => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let started = false;
    let chunks = 0;
    const chat = await openChat(page, async route => {
        if (route.request().url().includes('/chunks/')) chunks++;
        if (!route.request().url().endsWith('/files/uploads')) return false;
        started = true;
        await gate;
        await route.fulfill({ status: 410, headers, json: { error: 'message_removed' } });
        return true;
    });
    try {
        await page.locator('[data-sync-file-input]').setInputFiles({ name: 'already-sent.txt', mimeType: 'text/plain', buffer: Buffer.from('Original attachment') });
        await chat.send('Original caption');
        await expect.poll(() => started).toBe(true);
        await page.locator('[data-sync-input]').fill('New text draft');
        release();
        await expect(page.locator('[data-sync-notice]')).toHaveText('消息已发送，历史记录已清理。');
        await expect(page.locator('.sync-message')).toHaveCount(0);
        await expect(page.locator('[data-sync-selected-file]')).toBeHidden();
        await expect(page.locator('[data-sync-file-input]')).toBeEnabled();
        await expect(page.locator('[data-sync-input]')).toHaveValue('New text draft');
        await expect(page.locator('[data-sync-send]')).toBeEnabled();
        expect(chunks).toBe(0);
        await page.locator('[data-taskbar-lang]').click();
        await expect(page.locator('[data-sync-notice]')).toHaveText('Message was sent; its history has been removed.');
    } finally { release(); }
});
