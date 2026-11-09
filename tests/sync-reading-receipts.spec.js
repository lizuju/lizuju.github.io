const { test, expect, deviceId, otherId, message, atBottom, openChat } = require('./fixtures/sync-reading.cjs');

test.use({ serviceWorkers: 'block' });

test('shows a read check only after a different trusted paired device reads a sent message', async ({ page }) => {
    const chat = await openChat(page, [message(1), message(2)], [{ deviceId, messageId: 2 }]);
    const checks = page.locator('.sync-message.is-own .sync-message-read[data-state="read"]:visible');
    await expect(checks).toHaveCount(0);
    chat.receipt('untrusted-device', 2);
    await page.clock.runFor(700);
    await expect(checks).toHaveCount(0);
    chat.receipt(otherId, 1);
    await expect(checks).toHaveCount(1);
    await expect(checks).toHaveText('✓');
    chat.receipt(otherId, 2);
    await expect(checks).toHaveCount(2);
    chat.receipt(otherId, 1);
    await expect(checks).toHaveCount(2);
    chat.snapshot([{ deviceId: otherId, messageId: 1 }]);
    await expect(checks).toHaveCount(2);
    await page.locator('[data-taskbar-lang]').click();
    await expect(checks.first()).toHaveAttribute('title', 'Read');
});

test('synchronizes a partial own-device read watermark without reading newer messages in another tab', async ({ page }) => {
    const chat = await openChat(page, []);
    await page.locator('[data-sync-action="minimize"]').click();
    for (let id = 1; id <= 13; id++) await chat.incoming(id);
    await expect(page.locator('[data-sync-first-unread]')).toHaveText('有 13 条新消息 · 首条未读');
    chat.receipt(deviceId, 12);
    await expect(page.locator('[data-sync-first-unread]')).toHaveText('有 1 条新消息 · 首条未读');
    chat.receipt(deviceId, 1);
    await expect(page.locator('[data-sync-first-unread]')).toHaveText('有 1 条新消息 · 首条未读');
    chat.receipt(deviceId, 13);
    await expect(page.locator('[data-sync-first-unread]')).toBeHidden();
    expect(chat.reads).toHaveLength(0);
});

test('floats unread navigation without moving the feed or reading position when it appears or clears', async ({ page, browserName, isMobile }) => {
    const chat = await openChat(page, Array.from({ length: 40 }, (_, i) => message(i + 1, `History ${i + 1}`, otherId)),
        [{ deviceId, messageId: 40 }], false, true);
    const feed = page.locator('[data-sync-feed]');
    const latest = page.locator('[data-sync-first-unread]');
    await expect.poll(() => atBottom(page)).toBeLessThan(3);
    if (browserName === 'webkit' && isMobile) await feed.evaluate(element => { element.scrollTop = 0; });
    else {
        await feed.hover();
        await page.mouse.wheel(0, -100000);
    }
    await expect.poll(() => feed.evaluate(element => element.scrollTop)).toBeLessThan(3);
    const before = await feed.boundingBox();
    const compose = await page.locator('[data-sync-send-form]').boundingBox();
    const anchor = await page.locator('.sync-message').first().boundingBox();
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    for (let id = 41; id <= 51; id++) await chat.incoming(id);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(latest).toBeVisible();
    expect(await feed.boundingBox()).toEqual(before);
    expect(await page.locator('[data-sync-send-form]').boundingBox()).toEqual(compose);
    expect((await page.locator('.sync-message').first().boundingBox()).y).toBe(anchor.y);
    const floating = await latest.boundingBox();
    expect(floating.x).toBeGreaterThanOrEqual(before.x);
    expect(floating.y).toBeGreaterThanOrEqual(before.y);
    expect(floating.x + floating.width).toBeLessThanOrEqual(before.x + before.width);
    expect(floating.y + floating.height).toBeLessThanOrEqual(before.y + before.height);
    await chat.incoming(52);
    await expect(latest).toContainText('12');
    chat.receipt(deviceId, 52);
    await expect(latest).toBeHidden();
    expect(await feed.boundingBox()).toEqual(before);
    expect(await page.locator('[data-sync-send-form]').boundingBox()).toEqual(compose);
    expect((await page.locator('.sync-message').first().boundingBox()).y).toBe(anchor.y);
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    for (let id = 53; id <= 63; id++) await chat.incoming(id);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await latest.click();
    await expect(latest).toBeHidden();
    await expect(page.locator('.sync-message.is-reply-target .sync-message-text')).toHaveText('Incoming 53');
    chat.receipt(deviceId, 63);
    await expect(latest).toBeHidden();
    expect(await feed.boundingBox()).toEqual(before);
    expect(await page.locator('[data-sync-send-form]').boundingBox()).toEqual(compose);
});

test('restores unread messages from the server watermark when the chat first connects without browser focus', async ({ page }) => {
    const chat = await openChat(page, [message(1, 'Read before reload', otherId), message(2, 'Unread before reload', otherId)],
        [{ deviceId, messageId: 1 }], true);
    await page.clock.runFor(1000);
    expect(chat.reads).toHaveLength(0);
    await page.evaluate(() => {
        Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true });
        window.dispatchEvent(new Event('focus'));
    });
    await page.locator('[data-sync-input]').click();
    await page.clock.runFor(800);
    await expect.poll(() => chat.reads.at(-1)).toBe(2);
});
