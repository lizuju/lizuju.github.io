const { test, expect, roomId, deviceId, otherId, message, headers, bounds, confirmed, spaceDot, receipt, openChat } = require('./fixtures/sync-send.cjs');

test.use({ serviceWorkers: 'block' });

const { showSyncTools } = require('./fixtures/sync-tools.cjs');

test('encrypts offline text, restores it on reload and sends each queued message once in order after reconnecting', async ({ page }) => {
    const submissions = [];
    const chat = await openChat(page, async route => {
        if (route.request().method() !== 'POST' || !route.request().url().endsWith('/messages')) return false;
        const body = route.request().postDataJSON();
        submissions.push(body);
        await route.fulfill({ headers, json: confirmed(body, submissions.length) });
        return true;
    });
    chat.disconnect();
    await expect(page.locator('[data-sync-status]')).not.toHaveAttribute('data-state', 'online');
    await chat.send('Private offline first');
    await expect(page.locator('.sync-message[data-state="queued"]')).toHaveCount(1);
    await chat.send('Private offline second');
    await expect(page.locator('.sync-message[data-state="queued"]')).toHaveCount(2);
    await expect(page.locator('[data-sync-input]')).toHaveValue('');
    expect(submissions).toHaveLength(0);
    await expect.poll(() => page.evaluate(key => sessionStorage.getItem(key), `portfolio-sync-draft:${roomId}`)).toMatch(/^e2ee1\./);
    expect(await page.evaluate(() => JSON.stringify(sessionStorage))).not.toContain('Private offline');
    await page.reload();
    if (!await page.locator('[data-sync-window]').isVisible()) await page.locator('.desktop-shortcut[data-open-sync-space]').click();
    await expect(page.locator('.sync-message[data-state="queued"]')).toHaveCount(2);
    await page.locator('[data-sync-input]').fill('Unsent new draft');
    chat.reconnect();
    await expect(page.locator('.sync-message[data-state="sent"]')).toHaveCount(2);
    await expect(page.locator('.sync-message-text')).toHaveText(['Private offline first', 'Private offline second']);
    expect(submissions).toHaveLength(2);
    expect(new Set(submissions.map(item => item.clientId)).size).toBe(2);
    expect(JSON.stringify(submissions)).not.toContain('Private offline');
    await expect(page.locator('[data-sync-input]')).toHaveValue('Unsent new draft');
    await expect(spaceDot(page)).toBeHidden();
});

test('reuses the same client id when a lost response moves an online text into the automatic queue', async ({ page }) => {
    const submissions = [];
    const chat = await openChat(page, async route => {
        if (route.request().method() !== 'POST' || !route.request().url().endsWith('/messages')) return false;
        const body = route.request().postDataJSON();
        submissions.push(body);
        if (submissions.length === 1) await route.abort('failed');
        else await route.fulfill({ headers, json: confirmed(body, 1) });
        return true;
    });
    await page.clock.install();
    await chat.send('Retried automatically');
    await expect(page.locator('.sync-message[data-state="queued"]')).toHaveCount(1);
    expect(submissions).toHaveLength(1);
    await page.clock.fastForward(5100);
    await expect(page.locator('.sync-message[data-state="sent"]')).toHaveCount(1);
    expect(submissions).toHaveLength(2);
    expect(submissions[1].clientId).toBe(submissions[0].clientId);
    await expect(page.locator('[data-sync-input]')).toHaveValue('');
});

test('settles a retry whose delivered message was removed without restoring it or losing the new draft', async ({ page }) => {
    const submissions = [];
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const chat = await openChat(page, async route => {
        if (route.request().method() !== 'POST' || !route.request().url().endsWith('/messages')) return false;
        submissions.push(route.request().postDataJSON());
        if (submissions.length === 1) await route.abort('failed');
        else {
            await gate;
            await route.fulfill({ status: 410, headers, json: { error: 'message_removed' } });
        }
        return true;
    });
    try {
        await page.clock.install();
        await chat.send('Delivered before history cleanup');
        await expect(page.locator('.sync-message[data-state="queued"]')).toHaveCount(1);
        await page.clock.fastForward(5100);
        await expect.poll(() => submissions.length).toBe(2);
        expect(submissions[1].clientId).toBe(submissions[0].clientId);
        await page.locator('[data-sync-input]').fill('Keep this new draft');
        release();
        await expect(page.locator('.sync-message')).toHaveCount(0);
        await expect(page.locator('[data-sync-notice]')).toHaveText('消息已发送，历史记录已清理。');
        await expect(page.locator('[data-sync-input]')).toHaveValue('Keep this new draft');
        await expect(spaceDot(page)).toBeHidden();
        await page.reload();
        if (!await page.locator('[data-sync-window]').isVisible()) await page.locator('.desktop-shortcut[data-open-sync-space]').click();
        await expect(page.locator('[data-sync-status]')).toHaveAttribute('data-state', 'online');
        await expect(page.locator('[data-sync-input]')).toHaveValue('Keep this new draft');
        await expect(page.locator('.sync-message')).toHaveCount(0);
        expect(submissions).toHaveLength(2);
    } finally { release(); }
});

test('restores encrypted pending text after closing the original tab and deduplicates two recovering tabs', async ({ page, context }) => {
    const submissions = [];
    const handle = async route => {
        if (route.request().method() !== 'POST' || !route.request().url().endsWith('/messages')) return false;
        const body = route.request().postDataJSON(); submissions.push(body);
        await route.fulfill({ headers, json: confirmed(body, 1) }); return true;
    };
    const chat = await openChat(page, handle);
    chat.disconnect();
    await expect(page.locator('[data-sync-status]')).not.toHaveAttribute('data-state', 'online');
    await chat.send('Persist across closed tabs');
    await expect(page.locator('[data-sync-notice]')).toHaveText('等待联网后发送');
    const stored = await page.evaluate(async () => {
        const db = await new Promise(resolve => { const request = indexedDB.open('gavin-sync-outbox', 1); request.onsuccess = () => resolve(request.result); });
        const entries = await new Promise(resolve => { const request = db.transaction('messages').objectStore('messages').getAll(); request.onsuccess = () => resolve(request.result); });
        db.close(); return entries;
    });
    expect(stored).toHaveLength(1);
    expect(stored[0].encrypted).toMatch(/^e2ee1\./);
    expect(JSON.stringify(stored)).not.toContain('Persist across closed tabs');
    await page.close();
    const first = await context.newPage(), second = await context.newPage();
    await Promise.all([openChat(first, handle, false), openChat(second, handle, false)]);
    await expect.poll(() => submissions.length).toBe(1);
    await expect(first.locator('.sync-message[data-state="queued"]')).toHaveCount(0);
    await expect(second.locator('.sync-message[data-state="queued"]')).toHaveCount(0);
});

test('resumes a deferred retry after a slow space-name save finishes', async ({ page }) => {
    let release, profileStarted = false, posts = 0;
    const gate = new Promise(resolve => { release = resolve; });
    const chat = await openChat(page, async route => {
        if (route.request().method() === 'PATCH' && route.request().url().endsWith('/profile')) {
            profileStarted = true; await gate; await route.fulfill({ headers, json: { profile: null } }); return true;
        }
        if (route.request().method() !== 'POST' || !route.request().url().endsWith('/messages')) return false;
        posts++;
        if (posts === 1) await route.abort('failed');
        else if (posts === 2) await route.fulfill({ status: 503, headers: { ...headers, 'Retry-After': '5' }, json: { error: 'storage_cleaning' } });
        else await route.fulfill({ headers, json: confirmed(route.request().postDataJSON(), 1) });
        return true;
    });
    await page.clock.install();
    await chat.send('Retry after settings');
    await expect(page.locator('.sync-message[data-state="queued"]')).toHaveCount(1);
    await page.clock.fastForward(5100);
    await expect.poll(() => posts).toBe(2);
    try {
        await showSyncTools(page);
        await page.locator('[data-sync-space-rename]').click();
        await page.locator('[data-sync-space-name]').fill('新的名称');
        await page.locator('[data-sync-space-name-form]').getByRole('button', { name: '保存', exact: true }).click();
        await expect.poll(() => profileStarted).toBe(true);
        await page.clock.runFor(6000);
        expect(posts).toBe(2);
        release();
        await expect(page.locator('[data-sync-space-name-dialog]')).not.toBeVisible();
        await page.clock.runFor(1100);
        await expect(page.locator('.sync-message[data-state="sent"]')).toHaveCount(1);
        expect(posts).toBe(3);
    } finally { release(); }
});

test('clearing history removes durable pending text before reconnect or reload can resend it', async ({ page }) => {
    let posts = 0;
    const chat = await openChat(page, async route => {
        if (route.request().method() !== 'POST' || !route.request().url().endsWith('/messages')) return false;
        posts++;
        if (posts === 1) await route.abort('failed');
        else await route.fulfill({ status: 503, headers: { ...headers, 'Retry-After': '30' }, json: { error: 'storage_cleaning' } });
        return true;
    });
    await page.clock.install();
    await chat.send('Must not reappear');
    await expect(page.locator('.sync-message[data-state="queued"]')).toHaveCount(1);
    await page.clock.fastForward(5100);
    await expect.poll(() => posts).toBe(2);
    await expect(page.locator('.sync-message[data-state="queued"]')).toHaveCount(1);
    chat.clear();
    await expect(page.locator('.sync-message')).toHaveCount(0);
    await page.reload();
    if (!await page.locator('[data-sync-window]').isVisible()) await page.locator('.desktop-shortcut[data-open-sync-space]').click();
    await expect(page.locator('[data-sync-status]')).toHaveAttribute('data-state', 'online');
    await expect(page.locator('.sync-message')).toHaveCount(0);
    expect(posts).toBe(2);
});

test('waits for an explicit retry before sending an expired pending message', async ({ page }) => {
    const { session } = require('./fixtures/sync-e2ee.cjs');
    const { readFile } = require('node:fs/promises');
    const path = require('node:path');
    const submissions = [];
    await openChat(page, async route => {
        if (route.request().method() !== 'POST' || !route.request().url().endsWith('/messages')) return false;
        const body = route.request().postDataJSON();
        submissions.push(body);
        await route.fulfill({ headers, json: confirmed(body, 1) });
        return true;
    });
    await page.route('**/__queue-setup__/*.js', async route => route.fulfill({ contentType: 'text/javascript',
        body: await readFile(path.join(__dirname, '../static/portfolio/js/apps', new URL(route.request().url()).pathname.split('/').at(-1)), 'utf8') }));
    await page.evaluate(async session => {
        const { pendingMessages } = await import('/__queue-setup__/sync-outbox.js');
        await pendingMessages.save(session, {
            id: 'pending:expired-message', clientId: 'expired-message', deviceId: session.deviceId,
            text: 'An old pending message', createdAt: Date.now() - 8 * 86400000,
            autoSend: true, sendState: 'queued'
        }, true);
    }, session);
    await page.reload();
    if (!await page.locator('[data-sync-window]').isVisible()) await page.locator('.desktop-shortcut[data-open-sync-space]').click();
    await expect(page.locator('[data-sync-status]')).toHaveAttribute('data-state', 'online');
    await expect(page.locator('.sync-message[data-state="failed"]')).toHaveCount(1);
    expect(submissions).toHaveLength(0);
    await page.locator('[data-sync-retry-message]').click();
    await expect(page.locator('.sync-message[data-state="sent"]')).toHaveCount(1);
    expect(submissions).toHaveLength(1);
    expect(submissions[0].clientId).toBe('expired-message');
});
