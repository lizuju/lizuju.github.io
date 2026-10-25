const { test, expect, deviceId, otherId, keyId, profile, message, authorize } = require('./fixtures/sync-e2ee.cjs');

const headers = {
    'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Sync-Key-Id',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
};
const bounds = latestId => ({ generation: '1', oldestId: 1, latestId, continuationId: latestId, hasNewer: false });
const atBottom = page => page.locator('[data-sync-feed]').evaluate(feed => feed.scrollHeight - feed.clientHeight - feed.scrollTop);

const openChat = async (page, history, receipts = [], background = false, realClock = false) => {
    if (!realClock) await page.clock.install();
    await authorize(page);
    await page.route('**/portfolio/sync-config.json', route => route.fulfill({ json: { apiBase: 'https://sync.test' } }));
    await page.route('https://sync.test/**', route => {
        if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
        return route.fulfill({ headers, json: {
            deviceId, devices: [profile('Local'), profile('Paired', otherId)], grants: [], hasMore: false, keyId
        } });
    });
    let connection;
    const reads = [];
    await page.routeWebSocket('wss://sync.test/**', socket => {
        connection = socket;
        socket.onMessage(raw => {
            if (raw === 'ping') return socket.send('pong');
            const data = JSON.parse(raw);
            if (data.type === 'auth') socket.send(JSON.stringify({
                type: 'ready', deviceId, messages: history, pairing: null, readReceipts: receipts,
                history: bounds(history.at(-1)?.id ?? null), historyMode: 'replace'
            }));
            else if (data.type === 'read') {
                reads.push(data.messageId);
                socket.send(JSON.stringify({ ...data, deviceId }));
            }
        });
    });
    await page.goto('/portfolio/');
    await page.bringToFront();
    if (background) await page.evaluate(() => {
        Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => false });
        window.dispatchEvent(new Event('blur'));
    });
    if (await page.locator('[data-window-action="minimize"]').isVisible()) await page.locator('[data-window-action="minimize"]').click();
    await page.locator('.desktop-shortcut[data-open-sync-space]').click();
    await expect(page.locator('[data-sync-status]')).toHaveAttribute('data-state', 'online');
    await expect(page.locator('.sync-message')).toHaveCount(history.length);
    return {
        reads,
        incoming: async id => {
            connection.send(JSON.stringify({ type: 'message', message: message(id, `Incoming ${id}`, otherId), history: bounds(id) }));
            await expect(page.locator('.sync-message-text').last()).toHaveText(`Incoming ${id}`);
        },
        receipt: (sender, id) => connection.send(JSON.stringify({ type: 'read', deviceId: sender, messageId: id })),
        snapshot: receipts => connection.send(JSON.stringify({ type: 'history', messages: history,
            history: bounds(history.at(-1)?.id ?? null), historyMode: 'replace', readReceipts: receipts }))
    };
};

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

test('follows a new message while unfocused but leaves it unread until the user returns and interacts', async ({ page }) => {
    const chat = await openChat(page, Array.from({ length: 40 }, (_, i) => message(i + 1, `History ${i + 1}`, otherId)));
    await page.locator('[data-sync-input]').click();
    await page.clock.runFor(800);
    await expect.poll(() => chat.reads.at(-1)).toBe(40);
    const baseline = chat.reads.length;
    await page.evaluate(() => {
        Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => false });
        window.dispatchEvent(new Event('blur'));
    });
    await chat.incoming(41);
    await expect.poll(() => atBottom(page)).toBeLessThan(3);
    await page.clock.runFor(1200);
    await expect(page.locator('[data-sync-unread]')).toHaveText('1');
    expect(chat.reads).toHaveLength(baseline);
    await page.evaluate(() => {
        Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true });
        Object.defineProperty(document, 'hidden', { configurable: true, value: true });
        window.dispatchEvent(new Event('focus'));
    });
    await page.clock.runFor(1000);
    expect(chat.reads).toHaveLength(baseline);
    await expect(page.locator('[data-sync-unread]')).toHaveText('1');
    await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, value: false });
        document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.locator('[data-sync-input]').click();
    await page.clock.runFor(800);
    await expect.poll(() => chat.reads.at(-1)).toBe(41);
    await expect(page.locator('[data-sync-unread]')).toBeHidden();
});

test('does not mark new messages read behind another desktop window or while minimized', async ({ page }) => {
    const chat = await openChat(page, Array.from({ length: 30 }, (_, i) => message(i + 1, `History ${i + 1}`, otherId)));
    await page.locator('[data-sync-input]').click();
    await page.clock.runFor(800);
    await expect.poll(() => chat.reads.at(-1)).toBe(30);
    const baseline = chat.reads.length;
    await page.locator('[data-start-toggle]').click();
    await page.locator('[data-open-control-panel]').click();
    await chat.incoming(31);
    await page.clock.runFor(1000);
    expect(chat.reads).toHaveLength(baseline);
    await expect(page.locator('[data-sync-unread]')).toHaveText('1');
    await page.locator('[data-sync-task]').click();
    await page.locator('[data-sync-input]').click();
    await page.clock.runFor(800);
    await expect.poll(() => chat.reads.at(-1)).toBe(31);
    await page.locator('[data-sync-action="minimize"]').click();
    await chat.incoming(32);
    await page.clock.runFor(1000);
    expect(chat.reads.at(-1)).toBe(31);
    await expect(page.locator('[data-sync-unread]')).toHaveText('1');
    await page.locator('[data-sync-task]').click();
    await page.locator('[data-sync-input]').click();
    await page.clock.runFor(800);
    await expect.poll(() => chat.reads.at(-1)).toBe(32);
});

test('synchronizes a partial own-device read watermark without reading newer messages in another tab', async ({ page }) => {
    const chat = await openChat(page, []);
    await page.locator('[data-sync-action="minimize"]').click();
    await chat.incoming(1);
    await chat.incoming(2);
    await chat.incoming(3);
    await expect(page.locator('[data-sync-unread]')).toHaveText('3');
    chat.receipt(deviceId, 2);
    await expect(page.locator('[data-sync-unread]')).toHaveText('1');
    chat.receipt(deviceId, 1);
    await expect(page.locator('[data-sync-unread]')).toHaveText('1');
    chat.receipt(deviceId, 3);
    await expect(page.locator('[data-sync-unread]')).toBeHidden();
    await expect(page.locator('[data-sync-latest]')).toBeHidden();
    expect(chat.reads).toHaveLength(0);
});

test('floats unread navigation without moving the feed or reading position when it appears or clears', async ({ page, browserName, isMobile }) => {
    const chat = await openChat(page, Array.from({ length: 40 }, (_, i) => message(i + 1, `History ${i + 1}`, otherId)),
        [{ deviceId, messageId: 40 }]);
    const feed = page.locator('[data-sync-feed]');
    const latest = page.locator('[data-sync-latest]');
    await page.clock.runFor(100);
    if (browserName === 'webkit' && isMobile) await feed.evaluate(element => { element.scrollTop = 0; });
    else {
        await feed.hover();
        await page.mouse.wheel(0, -100000);
    }
    await page.clock.runFor(200);
    await expect.poll(() => feed.evaluate(element => element.scrollTop)).toBeLessThan(3);
    const before = await feed.boundingBox();
    const compose = await page.locator('[data-sync-send-form]').boundingBox();
    const anchor = await page.locator('.sync-message').first().boundingBox();
    await chat.incoming(41);
    await page.clock.runFor(100);
    await expect(latest).toBeVisible();
    expect(await feed.boundingBox()).toEqual(before);
    expect(await page.locator('[data-sync-send-form]').boundingBox()).toEqual(compose);
    expect((await page.locator('.sync-message').first().boundingBox()).y).toBe(anchor.y);
    const floating = await latest.boundingBox();
    expect(floating.x).toBeGreaterThanOrEqual(before.x);
    expect(floating.y).toBeGreaterThanOrEqual(before.y);
    expect(floating.x + floating.width).toBeLessThanOrEqual(before.x + before.width);
    expect(floating.y + floating.height).toBeLessThanOrEqual(before.y + before.height);
    await chat.incoming(42);
    await expect(latest).toContainText('2');
    chat.receipt(deviceId, 42);
    await expect(latest).toBeHidden();
    await page.clock.runFor(100);
    expect(await feed.boundingBox()).toEqual(before);
    expect(await page.locator('[data-sync-send-form]').boundingBox()).toEqual(compose);
    expect((await page.locator('.sync-message').first().boundingBox()).y).toBe(anchor.y);
    await chat.incoming(43);
    await latest.click();
    await page.clock.runFor(800);
    await expect(latest).toBeHidden();
    await expect.poll(() => atBottom(page)).toBeLessThan(3);
    expect(await feed.boundingBox()).toEqual(before);
    expect(await page.locator('[data-sync-send-form]').boundingBox()).toEqual(compose);
});

test('cancels pending read confirmation while an ancestor is inert and requires the full dwell again', async ({ page }) => {
    const chat = await openChat(page, []);
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
    await expect(page.locator('[data-sync-unread]')).toHaveText('1');
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
    await expect(page.locator('[data-sync-unread]')).toHaveText('1');
    await page.locator('[data-sync-input]').click();
    await page.clock.runFor(800);
    await expect.poll(() => chat.reads.at(-1)).toBe(2);
    await expect(page.locator('[data-sync-unread]')).toBeHidden();
});

test('restores unread messages from the server watermark when the chat first connects without browser focus', async ({ page }) => {
    const chat = await openChat(page, [message(1, 'Read before reload', otherId), message(2, 'Unread before reload', otherId)],
        [{ deviceId, messageId: 1 }], true);
    await page.clock.runFor(1000);
    await expect(page.locator('[data-sync-unread]')).toHaveText('1');
    expect(chat.reads).toHaveLength(0);
    await page.evaluate(() => {
        Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true });
        window.dispatchEvent(new Event('focus'));
    });
    await page.locator('[data-sync-input]').click();
    await page.clock.runFor(800);
    await expect.poll(() => chat.reads.at(-1)).toBe(2);
    await expect(page.locator('[data-sync-unread]')).toBeHidden();
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
    await expect(page.locator('[data-sync-unread]')).toHaveText('1');
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

test('preserves earlier reading, then follows the latest message through delayed layout and viewport changes', async ({ page, isMobile, browserName }) => {
    const chat = await openChat(page, Array.from({ length: 60 }, (_, i) => message(i + 1, `History ${i + 1}`, otherId)), [], false, true);
    const feed = page.locator('[data-sync-feed]');
    await expect.poll(() => atBottom(page)).toBeLessThan(3);
    if (isMobile && browserName === 'webkit') await feed.evaluate(element => new Promise(resolve => {
        element.addEventListener('scroll', () => requestAnimationFrame(() => requestAnimationFrame(resolve)), { once: true });
        element.scrollTop = 0;
    }));
    else {
        await feed.hover();
        await page.mouse.wheel(0, -100000);
    }
    await expect.poll(() => feed.evaluate(element => element.scrollTop)).toBeLessThan(3);
    await chat.incoming(61);
    expect(await feed.evaluate(element => element.scrollTop)).toBeLessThan(3);
    await expect(page.locator('[data-sync-latest]')).toBeVisible();
    await page.locator('[data-sync-latest]').click();
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
