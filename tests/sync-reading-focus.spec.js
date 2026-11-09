const { test, expect, deviceId, otherId, message, atBottom, openChat } = require('./fixtures/sync-reading.cjs');

test.use({ serviceWorkers: 'block' });

test('follows a new message while unfocused but leaves it unread until the user returns and interacts', async ({ page }) => {
    const chat = await openChat(page, Array.from({ length: 40 }, (_, i) => message(i + 1, `History ${i + 1}`, otherId)),
        [{ deviceId, messageId: 40 }]);
    const baseline = chat.reads.length;
    await page.evaluate(() => {
        Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => false });
        window.dispatchEvent(new Event('blur'));
    });
    await chat.incoming(41);
    await expect.poll(() => atBottom(page)).toBeLessThan(3);
    await page.clock.runFor(1200);
    expect(chat.reads).toHaveLength(baseline);
    await page.evaluate(() => {
        Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true });
        Object.defineProperty(document, 'hidden', { configurable: true, value: true });
        window.dispatchEvent(new Event('focus'));
    });
    await page.clock.runFor(1000);
    expect(chat.reads).toHaveLength(baseline);
    await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, value: false });
        document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.locator('[data-sync-input]').click();
    await page.clock.runFor(800);
    await expect.poll(() => chat.reads.at(-1)).toBe(41);
});

test('does not mark new messages read behind another desktop window or while minimized', async ({ page }) => {
    const chat = await openChat(page, Array.from({ length: 30 }, (_, i) => message(i + 1, `History ${i + 1}`, otherId)),
        [{ deviceId, messageId: 30 }]);
    const baseline = chat.reads.length;
    await page.locator('[data-start-toggle]').click();
    await page.locator('[data-open-control-panel]').click();
    await chat.incoming(31);
    await page.clock.runFor(1000);
    expect(chat.reads).toHaveLength(baseline);
    await page.locator('[data-sync-task]').click();
    await page.locator('[data-sync-input]').click();
    await page.clock.runFor(800);
    await expect.poll(() => chat.reads.at(-1)).toBe(31);
    await page.locator('[data-sync-action="minimize"]').click();
    await chat.incoming(32);
    await page.clock.runFor(1000);
    expect(chat.reads.at(-1)).toBe(31);
    await page.locator('[data-sync-task]').click();
    await page.locator('[data-sync-input]').click();
    await page.clock.runFor(800);
    await expect.poll(() => chat.reads.at(-1)).toBe(32);
});

test('cancels pending read confirmation while an ancestor is inert and requires the full dwell again', async ({ page }) => {
    await page.clock.install({ time: new Date('2026-10-30T00:00:00Z') });
    await page.clock.pauseAt(new Date('2026-10-30T00:00:01Z'));
    const chat = await openChat(page, [], [], false, true);
    await chat.incoming(1);
    await page.mouse.move(2, 2);
    await page.clock.runFor(300);
    await page.locator('[data-retro-desktop]').evaluate(element => { element.inert = true; });
    await page.clock.runFor(1000);
    expect(chat.reads).toHaveLength(0);
    await page.locator('[data-retro-desktop]').evaluate(element => { element.inert = false; });
    await page.clock.runFor(300);
    expect(chat.reads).toHaveLength(0);
    await page.clock.runFor(400);
    await expect.poll(() => chat.reads.at(-1)).toBe(1);
});

test('does not read new messages when the shutdown screen fully covers the chat', async ({ page }) => {
    const chat = await openChat(page, []);
    await page.locator('[data-start-toggle]').click();
    await page.locator('[data-shutdown]').click();
    await expect(page.locator('[data-shutdown-screen]')).toBeVisible();
    await chat.incoming(1);
    await page.mouse.move(2, 2);
    await page.clock.runFor(1000);
    expect(chat.reads).toHaveLength(0);
    await page.clock.runFor(2500);
    await page.locator('[data-restart]').click();
    await page.locator('[data-sync-task]').click();
    await page.mouse.move(5, 5);
    await page.clock.runFor(800);
    await expect.poll(() => chat.reads.at(-1)).toBe(1);
});

test('keeps an idle frontmost chat unread until mouse, keyboard, or touch activity resumes', async ({ page }) => {
    const chat = await openChat(page, [message(1, 'Initial message', otherId)]);
    await page.locator('[data-sync-input]').click();
    await page.clock.runFor(800);
    await expect.poll(() => chat.reads.at(-1)).toBe(1);
    await page.clock.fastForward(61000);
    await chat.incoming(2);
    await page.clock.runFor(1200);
    expect(chat.reads.at(-1)).toBe(1);
    await page.locator('[data-sync-input]').click();
    await page.clock.runFor(800);
    await expect.poll(() => chat.reads.at(-1)).toBe(2);
});

test('accepts mouse movement and website wheel or touch activity after an incoming message', async ({ page, browserName, isMobile }) => {
    const chat = await openChat(page, [message(1, 'Initial message', otherId)]);
    await page.locator('[data-sync-input]').click();
    await page.clock.runFor(800);
    await expect.poll(() => chat.reads.at(-1)).toBe(1);
    await chat.incoming(2);
    await page.clock.runFor(1200);
    await expect.poll(() => atBottom(page)).toBeLessThan(3);
    expect(chat.reads.at(-1)).toBe(1);
    await page.mouse.move(2, 2);
    await page.clock.runFor(800);
    await expect.poll(() => chat.reads.at(-1)).toBe(2);
    await chat.incoming(3);
    await page.clock.runFor(1200);
    expect(chat.reads.at(-1)).toBe(2);
    if (browserName === 'webkit' && isMobile) await page.touchscreen.tap(2, 2);
    else await page.mouse.wheel(0, 10);
    await page.clock.runFor(800);
    await expect.poll(() => chat.reads.at(-1)).toBe(3);
});

for (const sidebar of ['tools', 'spaces']) {
    test(`does not mark covered messages read under the narrow ${sidebar} sidebar`, async ({ page }) => {
        const chat = await openChat(page, []);
        await page.locator('[data-sync-window]').evaluate(app => { app.style.width = '320px'; });
        const toggle = page.locator(`[data-sync-${sidebar}-toggle]`);
        if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
        await chat.incoming(1);
        await page.mouse.move(100, 200);
        await page.clock.runFor(1200);
        expect(chat.reads).toEqual([]);
        await toggle.click();
        await page.locator('[data-sync-input]').click();
        await page.clock.runFor(1000);
        await expect.poll(() => chat.reads.at(-1)).toBe(1);
    });
}
