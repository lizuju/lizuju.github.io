const { test, expect, roomId, session, deviceId, otherId, message, headers, bounds, atBottom, openChat } = require('./fixtures/sync-reading.cjs');

test.use({ serviceWorkers: 'block' });

test('preserves earlier reading, then follows the latest message through delayed layout and viewport changes', async ({ page, isMobile, browserName }) => {
    const chat = await openChat(page, Array.from({ length: 60 }, (_, i) => message(i + 1, `History ${i + 1}`, otherId)), [], false, true);
    const feed = page.locator('[data-sync-feed]');
    await expect.poll(() => atBottom(page)).toBeLessThan(3);
    if (isMobile && browserName === 'webkit') {
        await feed.dispatchEvent('touchmove');
        await feed.evaluate(element => new Promise(resolve => {
            element.addEventListener('scroll', () => requestAnimationFrame(() => requestAnimationFrame(resolve)), { once: true });
            element.scrollTop = 0;
        }));
    }
    else {
        await feed.hover();
        await page.mouse.wheel(0, -100000);
    }
    await expect.poll(() => feed.evaluate(element => element.scrollTop)).toBeLessThan(3);
    await chat.incoming(61);
    expect(await feed.evaluate(element => element.scrollTop)).toBeLessThan(3);
    // Scrolling is a user acknowledgement even when the backlog is not yet read.
    await expect(page.locator('[data-sync-first-unread]')).toBeHidden();
    await feed.evaluate(element => new Promise(resolve => {
        element.addEventListener('scroll', () => requestAnimationFrame(() => requestAnimationFrame(resolve)), { once: true });
        element.scrollTop = element.scrollHeight;
    }));
    await expect.poll(() => atBottom(page)).toBeLessThan(3);
    await chat.incoming(62);
    await expect.poll(() => atBottom(page)).toBeLessThan(3);
    await page.locator('.sync-message').last().evaluate(item => { item.style.paddingBottom = '240px'; });
    await expect.poll(() => atBottom(page)).toBeLessThan(3);
    await page.setViewportSize({ width: 390, height: 700 });
    await expect.poll(() => atBottom(page)).toBeLessThan(3);
    await chat.incoming(63);
    await expect.poll(() => atBottom(page)).toBeLessThan(3);
});


test('keeps loaded history and the reading anchor when a live message advances the retention boundary', async ({ page }) => {
    const chat = await openChat(page, Array.from({ length: 500 }, (_, index) => message(index + 1, `History ${index + 1}`, otherId)),
        [{ deviceId, messageId: 500 }], false, true);
    const feed = page.locator('[data-sync-feed]');
    const anchor = page.locator('.sync-message').filter({ has: page.getByText('History 250', { exact: true }) });
    await expect.poll(() => atBottom(page)).toBeLessThan(3);
    await anchor.evaluate(element => new Promise(resolve => {
        const feed = document.querySelector('[data-sync-feed]');
        feed.addEventListener('scroll', () => requestAnimationFrame(() => requestAnimationFrame(resolve)), { once: true });
        feed.scrollTop += element.getBoundingClientRect().top - feed.getBoundingClientRect().top - 20;
    }));
    await expect.poll(() => anchor.evaluate(element =>
        Math.abs(element.getBoundingClientRect().top - document.querySelector('[data-sync-feed]').getBoundingClientRect().top - 20)
    )).toBeLessThan(2);
    const before = await anchor.boundingBox();
    await chat.incoming(501, { ...bounds(501), generation: '2', oldestId: 2 });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(page.locator('.sync-message')).toHaveCount(500);
    await expect(page.locator('.sync-message-text').first()).toHaveText('History 2');
    expect(Math.abs((await anchor.boundingBox()).y - before.y)).toBeLessThan(2);
    expect(await feed.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeGreaterThan(500);
    await page.waitForTimeout(800);
    expect(chat.reads).toHaveLength(0);
});

test('preserves an older protected message when the server trims later messages', async ({ page }) => {
    const chat = await openChat(page, Array.from({ length: 500 }, (_, index) => message(index + 1, `History ${index + 1}`, otherId)),
        [{ deviceId, messageId: 500 }], false, true);
    await chat.incoming(501, { ...bounds(501), generation: '2', removedIds: [2] });
    await expect(page.locator('.sync-message')).toHaveCount(500);
    await expect(page.locator('.sync-message-text').first()).toHaveText('History 1');
    await expect(page.locator('.sync-message-text').nth(1)).toHaveText('History 3');
    await expect(page.locator('.sync-message-text').filter({ hasText: /^History 2$/ })).toHaveCount(0);
});


test('keeps protected history while multiple HTTP acknowledgments precede pruning frames', async ({ page }) => {
    const chat = await openChat(page, Array.from({ length: 500 }, (_, index) => message(index + 1, `History ${index + 1}`, otherId)),
        [{ deviceId, messageId: 500 }], false, true);
    const sent = [];
    await page.route('https://sync.test/**/messages', route => {
        if (route.request().method() !== 'POST') return route.fallback();
        const acknowledged = { ...route.request().postDataJSON(), id: 501 + sent.length, deviceId, createdAt: Date.now() };
        sent.push(acknowledged);
        return route.fulfill({ headers, json: acknowledged });
    });
    for (const text of ['First acknowledgment', 'Second acknowledgment']) {
        await page.locator('[data-sync-input]').fill(text);
        await page.locator('[data-sync-send]').click();
        await expect(page.locator('.sync-message').filter({ has: page.getByText(text, { exact: true }) })).toHaveAttribute('data-state', 'sent');
    }
    await expect(page.locator('.sync-message-text').first()).toHaveText('History 1');
    await expect(page.locator('.sync-message')).toHaveCount(502);
    chat.publish(sent[0], { ...bounds(501), generation: '2', removedIds: [2] });
    await expect(page.locator('.sync-message')).toHaveCount(501);
    await expect(page.locator('.sync-message-text').first()).toHaveText('History 1');
    chat.publish(sent[1], { ...bounds(502), generation: '3', removedIds: [3] });
    await expect(page.locator('.sync-message')).toHaveCount(500);
    await expect(page.locator('.sync-message-text').first()).toHaveText('History 1');
    await expect(page.locator('.sync-message-text').nth(1)).toHaveText('History 4');
});

test('keeps protected history when an HTTP acknowledgment arrives after switching spaces', async ({ page }) => {
    const otherRoom = '11111111-1111-4111-8111-111111111111';
    const chat = await openChat(page, Array.from({ length: 500 }, (_, index) => message(index + 1, `History ${index + 1}`, otherId)),
        [{ deviceId, messageId: 500 }], false, false, async () => {
            await page.route('**/__history-setup__/*', async route => route.fulfill({ contentType: 'text/javascript',
                body: await require('node:fs/promises').readFile(require('node:path').join(__dirname, '../static/portfolio/js/apps',
                    new URL(route.request().url()).pathname.split('/').at(-1)), 'utf8') }));
            await page.evaluate(async ({ session, otherRoom }) => {
                const { SavedSpaces } = await import('/__history-setup__/sync-spaces.js');
                const spaces = new SavedSpaces();
                await spaces.importActive();
                await spaces.save({ ...session, roomId: otherRoom }, { activate: true });
                await spaces.select(session.roomId);
            }, { session, otherRoom });
        });
    let acknowledgment;
    let attempts = 0;
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    await page.route('https://sync.test/**/messages', async route => {
        if (route.request().method() !== 'POST') return route.fallback();
        if (++attempts === 1) return route.fulfill({ status: 503, headers: { ...headers, 'Retry-After': '5' }, json: { error: 'storage_cleaning' } });
        acknowledgment = { ...route.request().postDataJSON(), id: 501, deviceId, createdAt: Date.now() };
        await pending;
        return route.fulfill({ headers, json: acknowledgment });
    });
    const select = async id => {
        const room = page.locator(`[data-sync-space-id="${id}"]`);
        if (!await room.isVisible()) await page.locator('[data-sync-spaces-toggle]').click();
        await room.click();
        await expect(page.locator('[data-sync-space-title]')).toHaveText(id === roomId ? '空间 1' : '空间 2');
        await expect(page.locator('[data-sync-status]')).toHaveAttribute('data-state', 'online');
    };
    await page.locator('[data-sync-input]').fill('Acknowledged in the background');
    await page.locator('[data-sync-send]').click();
    await expect(page.locator('.sync-message[data-state="queued"]')).toHaveCount(1);
    await select(otherRoom);
    await page.clock.runFor(5100);
    await expect.poll(() => !!acknowledgment).toBe(true);
    release();
    await expect.poll(() => page.evaluate(async () => {
        const database = await new Promise(resolve => { const request = indexedDB.open('gavin-sync-outbox', 1); request.onsuccess = () => resolve(request.result); });
        const entries = await new Promise(resolve => { const request = database.transaction('messages').objectStore('messages').getAll(); request.onsuccess = () => resolve(request.result); });
        database.close();
        return entries.length;
    })).toBe(0);
    await select(roomId);
    await expect(page.locator('.sync-message')).toHaveCount(501);
    await expect(page.locator('.sync-message-text').first()).toHaveText('History 1');
    chat.publish(acknowledgment, { ...bounds(501), generation: '2', removedIds: [2] });
    await expect(page.locator('.sync-message')).toHaveCount(500);
    await expect(page.locator('.sync-message-text').first()).toHaveText('History 1');
    await expect(page.locator('.sync-message-text').nth(1)).toHaveText('History 3');
});
