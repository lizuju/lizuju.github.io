const { test, expect, roomId, deviceId, otherId, message, headers, bounds, confirmed, spaceDot, receipt, openChat } = require('./fixtures/sync-send.cjs');

test.use({ serviceWorkers: 'block' });

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
        await expect(spaceDot(page)).toHaveAttribute('data-state', 'yellow');
        await expect(page.locator('[data-sync-spaces-toggle]')).toHaveAttribute('data-state', 'yellow');
        await page.locator('[data-sync-input]').fill('Identical text');
        release();
        await expect(page.locator('.sync-message[data-state="sent"]')).toHaveCount(1);
        await expect(receipt(page)).toHaveAttribute('data-state', 'sent');
        await expect(spaceDot(page)).toBeHidden();
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
        await expect(spaceDot(page)).toHaveAttribute('data-state', 'red');
        await expect(page.locator('[data-sync-input]')).toHaveValue('');
        await expect(receipt(page)).toBeHidden();
        await page.locator('[data-sync-input]').fill('Do not replace this draft');
        await page.reload();
        if (!await page.locator('[data-sync-window]').isVisible()) await page.locator('.desktop-shortcut[data-open-sync-space]').click();
        await expect(page.locator('[data-sync-status]')).toHaveAttribute('data-state', 'online');
        await expect(page.locator('.sync-message[data-state="failed"]')).toHaveCount(1);
        await expect(page.locator('[data-sync-input]')).toHaveValue('Do not replace this draft');
        await expect(spaceDot(page)).toHaveAttribute('data-state', 'red');
        await page.locator('[data-sync-retry-message]').click();
        await expect(spaceDot(page)).toHaveAttribute('data-state', 'yellow');
        await expect(page.locator('.sync-message[data-state="sending"]')).toHaveCount(1);
        await expect.poll(() => submissions.length).toBe(2);
        expect(submissions[1].clientId).toBe(submissions[0].clientId);
        expect(submissions[1].text).toBe(submissions[0].text);
        await expect(page.locator('[data-sync-input]')).toHaveValue('Do not replace this draft');
        retryRelease();
        await expect(page.locator('.sync-message[data-state="sent"]')).toHaveCount(1);
        await expect(page.locator('.sync-message-text')).toHaveText('Original failed message');
        await expect(spaceDot(page)).toBeHidden();
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

test('Enter sends while Control, Command and Shift Enter insert newlines and preserve selected text edits', async ({ page }) => {
    let requests = 0;
    await openChat(page, async route => {
        if (route.request().method() !== 'POST' || !route.request().url().endsWith('/messages')) return false;
        requests++;
        await route.fulfill({ headers, json: confirmed(route.request().postDataJSON(), requests) });
        return true;
    });
    const input = page.locator('[data-sync-input]');
    for (const modifier of ['Control', 'Meta', 'Shift']) {
        await input.fill('firstsecond');
        await input.evaluate(element => element.setSelectionRange(5, 5));
        await input.press(`${modifier}+Enter`);
        await expect(input).toHaveValue('first\nsecond');
        expect(requests).toBe(0);
    }
    await input.fill('before SELECT after');
    await input.evaluate(element => element.setSelectionRange(7, 13));
    await input.press('Control+Enter');
    await expect(input).toHaveValue('before \n after');
    await input.press('Enter');
    await expect(input).toHaveValue('');
    await expect(page.locator('.sync-message[data-state="sent"] .sync-message-text')).toHaveText('before \n after');
    expect(requests).toBe(1);
});
