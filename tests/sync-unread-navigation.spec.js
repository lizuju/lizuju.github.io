const { test, expect, deviceId, otherId, keyId, encrypt, message, profile, authorize } = require('./fixtures/sync-e2ee.cjs');

test.use({ serviceWorkers: 'block' });
const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
const bounds = (latestId, oldestId = 1) => ({ generation: '1', oldestId, latestId, continuationId: latestId, hasNewer: false });
const mentionMessage = id => {
    const value = message(id, '@Local hello', otherId);
    value.text = encrypt(`message:${otherId}:${value.clientId}`, {
        text: `@Local hello ${id}`, mentions: [{ deviceId, start: 0, end: 6 }]
    });
    return value;
};
const openChat = async (page, { history, readId = 0, older = [], standalone = false } = {}) => {
    await page.clock.install();
    await authorize(page);
    await page.route('**/sync-config.json', route => route.fulfill({ json: { apiBase: 'https://sync.test' } }));
    const historyRequests = [];
    await page.route('https://sync.test/**', route => {
        const request = route.request();
        if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
        const url = new URL(request.url());
        if (url.pathname.endsWith('/messages')) {
            historyRequests.push(url.searchParams.get('before'));
            const available = older.filter(item => item.id < Number(url.searchParams.get('before'))).slice(-50);
            return route.fulfill({ headers, json: { messages: available, historyMode: 'prepend', history: bounds(history.at(-1).id) } });
        }
        return route.fulfill({ headers, json: { deviceId, devices: [profile('Local'), profile('Remote', otherId)], grants: [], hasMore: false, keyId } });
    });
    let connection;
    const reads = [];
    await page.routeWebSocket('wss://sync.test/**', socket => {
        connection = socket;
        socket.onMessage(raw => {
            if (raw === 'ping') return socket.send('pong');
            const data = JSON.parse(raw);
            if (data.type === 'auth') socket.send(JSON.stringify({ type: 'ready', deviceId, messages: history,
                historyMode: 'replace', history: bounds(history.at(-1)?.id ?? null), readReceipts: [{ deviceId, messageId: readId }], pairing: null }));
            if (data.type === 'read') reads.push(data.messageId);
        });
    });
    if (standalone) await page.route('**/chat/', async route => {
        const response = await route.fetch();
        const production = require('../static/portfolio/sync-config.json').apiBase;
        const html = (await response.text()).replaceAll(production, 'https://sync.test')
            .replaceAll(production.replace(/^http/, 'ws'), 'wss://sync.test');
        await route.fulfill({ response, body: html });
    });
    await page.goto(standalone ? '/chat/' : '/portfolio/');
    await page.bringToFront();
    if (!standalone) {
        if (await page.locator('[data-window-action="minimize"]').isVisible()) await page.locator('[data-window-action="minimize"]').click();
        if (!await page.locator('[data-sync-window]').isVisible()) await page.locator('.desktop-shortcut[data-open-sync-space]').click();
    }
    await expect(page.locator('[data-sync-status]')).toHaveAttribute('data-state', 'online');
    await expect(page.locator('.sync-message')).toHaveCount(history.length);
    return { reads, historyRequests, frame: data => connection.send(JSON.stringify(data)) };
};
const highlighted = page => page.locator('.sync-message.is-reply-target .sync-message-text');

test('pruning removes only deleted messages and preserves the loaded reading position', async ({ page }) => {
    const all = Array.from({ length: 100 }, (_, i) => message(i + 1, `Reading ${i + 1}`, otherId));
    const chat = await openChat(page, { history: all.slice(50), older: all.slice(0, 50), readId: 100, standalone: true });
    await page.locator('[data-sync-history-more]').click();
    await expect(page.locator('.sync-message')).toHaveCount(100);
    const message25 = page.locator('.sync-message-text').filter({ hasText: /^Reading 25$/ });
    await message25.evaluate(element => element.scrollIntoView({ block: 'start' }));
    const before = await message25.evaluate(element => {
        window.retainedReadingNode = element;
        return element.getBoundingClientRect().top;
    });
    chat.frame({ type: 'history', messages: [], historyMode: 'prune', history: {
        ...bounds(100, 2), generation: '2', removedIds: [1, 19, 44]
    } });
    await expect(page.locator('.sync-message')).toHaveCount(97);
    expect(await message25.evaluate(element => element === window.retainedReadingNode)).toBe(true);
    expect(Math.abs(await message25.evaluate(element => element.getBoundingClientRect().top) - before)).toBeLessThan(2);
    await expect(page.locator('.sync-message-text').filter({ hasText: /^Reading (1|19|44)$/ })).toHaveCount(0);
    await expect(page.locator('.sync-message-text').filter({ hasText: /^Reading 2$/ })).toHaveCount(1);
    chat.frame({ type: 'cleared', messages: [], historyMode: 'replace', history: bounds(null, null) });
    await expect(page.locator('.sync-message')).toHaveCount(0);
});

for (const action of ['wheel', 'keyboard', 'touch']) test(`marks the current backlog read after a foreground ${action} gesture, including unloaded history`, async ({ page, browserName, isMobile }) => {
    test.skip(action === 'touch' && browserName !== 'chromium', 'CDP provides native touch gestures in Chromium');
    test.skip(action === 'wheel' && browserName === 'webkit' && isMobile, 'iOS uses touch scrolling');
    const chat = await openChat(page, { history: Array.from({ length: 50 }, (_, i) => message(i + 51, `Backlog ${i + 51}`, otherId)),
        older: Array.from({ length: 50 }, (_, i) => message(i + 1, `Backlog ${i + 1}`, otherId)), readId: 20, standalone: true });
    const feed = page.locator('[data-sync-feed]');
    await expect(page.locator('[data-sync-first-unread]')).toBeVisible();
    await expect(page.locator('[data-sync-task]')).toBeVisible();
    await expect(page.locator('[data-sync-task] [data-sync-unread]')).toHaveCount(0);
    await feed.evaluate(element => { element.scrollTop -= 20; });
    await feed.dispatchEvent('wheel', { deltaY: -20 });
    await page.clock.runFor(800);
    expect(chat.reads).toEqual([]);
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await feed.focus();
    await page.keyboard.press('PageUp');
    await page.clock.runFor(800);
    expect(chat.reads).toEqual([]);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    if (action === 'wheel') {
        await feed.hover();
        await page.mouse.wheel(0, -20);
    } else if (action === 'keyboard') {
        await feed.focus();
        await page.keyboard.press('PageUp');
    } else {
        const box = await feed.boundingBox();
        const x = box.x + box.width / 2, y = box.y + box.height / 2;
        const session = await page.context().newCDPSession(page);
        await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
        await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - 40 }] });
        await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await session.detach();
    }
    await expect.poll(() => chat.reads.at(-1)).toBe(100);
    expect(chat.historyRequests).toEqual([]);
    await expect(page.locator('[data-sync-first-unread]')).toBeHidden();
    await expect(page.locator('[data-sync-unread-separator]')).toHaveCount(0);
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    chat.frame({ type: 'message', message: message(101, 'Later arrival', otherId), history: bounds(101) });
    await expect(page.locator('.sync-message')).toHaveCount(51);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.clock.runFor(800);
    expect(chat.reads.at(-1)).toBe(100);
});

test('does not restore unread mentions from delayed messages below the saved read watermark', async ({ page }) => {
    const chat = await openChat(page, { history: [message(100, 'Already read', otherId)], readId: 100, standalone: true });
    chat.frame({ type: 'message', message: mentionMessage(99), history: bounds(100) });
    await expect(page.locator('.sync-message')).toHaveCount(2);
    await expect(page.locator('[data-sync-unread-mention]')).toBeHidden();
    chat.frame({ type: 'message', message: mentionMessage(101), history: bounds(101) });
    await expect(page.locator('[data-sync-unread-mention]')).toHaveText('@我 · 1');
});

test('keeps a background backlog unread after automatic scrolling and reads only the messages actually viewed', async ({ page }) => {
    const chat = await openChat(page, { history: [message(1, 'Already read', otherId)], readId: 1, standalone: true });
    await page.evaluate(() => {
        Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => false });
        window.dispatchEvent(new Event('blur'));
    });
    for (let id = 2; id <= 26; id++) chat.frame({ type: 'message', message: message(id, `Backlog ${id}`, otherId), history: bounds(id) });
    await expect(page.locator('.sync-message')).toHaveCount(26);
    await page.evaluate(() => {
        Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true });
        window.dispatchEvent(new Event('focus'));
    });
    await page.mouse.move(2, 2);
    await page.clock.runFor(1600);
    expect(chat.reads).toEqual([]);
    await expect(page.locator('[data-sync-first-unread]')).toContainText('25');
    await expect(page.locator('[data-sync-first-unread]')).toBeVisible();
    await expect(page.locator('[data-sync-unread-separator]')).toHaveCount(1);

    const feed = page.locator('[data-sync-feed]');
    await feed.evaluate(element => { element.scrollTop = 0; });
    await page.mouse.move(4, 4);
    await page.clock.runFor(800);
    expect(chat.reads.at(-1)).toBeGreaterThan(1);
    expect(chat.reads.at(-1)).toBeLessThan(26);
    await expect(page.locator('[data-sync-unread-separator]')).toHaveCount(0);
    await expect(page.locator('[data-sync-first-unread]')).toBeVisible();
    for (let step = 0; step < 26 && chat.reads.at(-1) < 26; step++) {
        await feed.evaluate(element => { element.scrollTop += element.clientHeight / 2; });
        await page.mouse.move(5 + step, 5);
        await page.clock.runFor(800);
    }
    expect(chat.reads.at(-1)).toBe(26);
    await expect(page.locator('[data-sync-first-unread]')).toBeHidden();
});

test('only shows backlog prompts above ten unread messages and keeps them until the backlog is read', async ({ page }) => {
    const chat = await openChat(page, { history: [message(1, 'Already read', otherId)], readId: 1, standalone: true });
    for (let id = 2; id <= 12; id++) chat.frame({ type: 'message', message: message(id, `Foreground ${id}`, otherId), history: bounds(id) });
    await expect(page.locator('.sync-message')).toHaveCount(12);
    await expect(page.locator('[data-sync-first-unread]')).toBeHidden();
    await expect(page.locator('[data-sync-unread-separator]')).toHaveCount(0);
    chat.frame({ type: 'read', deviceId, messageId: 12 });
    await expect(page.locator('[data-sync-first-unread]')).toBeHidden();
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    for (let id = 13; id <= 22; id++) chat.frame({ type: 'message', message: message(id, `Background ${id}`, otherId), history: bounds(id) });
    await expect(page.locator('.sync-message')).toHaveCount(22);
    await expect(page.locator('[data-sync-first-unread]')).toBeHidden();
    await expect(page.locator('[data-sync-unread-separator]')).toHaveCount(0);
    chat.frame({ type: 'message', message: message(23, 'Eleventh unread message', otherId), history: bounds(23) });
    await expect(page.locator('.sync-message')).toHaveCount(23);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.clock.runFor(1000);
    await expect(page.locator('[data-sync-unread-separator]')).toHaveCount(1);
    await expect(page.locator('[data-sync-first-unread]')).toBeVisible();
    await expect(page.locator('[data-sync-first-unread]')).toContainText('11');
    expect(chat.reads).toEqual([]);
    chat.frame({ type: 'read', deviceId, messageId: 13 });
    await expect(page.locator('[data-sync-first-unread]')).toContainText('10');
    await expect(page.locator('[data-sync-first-unread]')).toBeVisible();
    await expect(page.locator('[data-sync-unread-separator]')).toHaveCount(0);
    chat.frame({ type: 'read', deviceId, messageId: 23 });
    await expect(page.locator('[data-sync-first-unread]')).toBeHidden();
    chat.frame({ type: 'message', message: message(24, 'A new small batch', otherId), history: bounds(24) });
    await expect(page.locator('.sync-message')).toHaveCount(24);
    await expect(page.locator('[data-sync-first-unread]')).toBeHidden();
});

for (const standalone of [false, true]) test(`does not show a backlog prompt for a foreground burst in ${standalone ? 'standalone' : 'desktop'} chat`, async ({ page }) => {
    const chat = await openChat(page, { history: [message(1, 'Already read', otherId)], readId: 1, standalone });
    await page.locator('[data-sync-input]').fill('Still chatting');
    for (let id = 2; id <= 30; id++) chat.frame({ type: 'message', message: message(id, `Foreground ${id}`, otherId), history: bounds(id) });
    await expect(page.locator('.sync-message')).toHaveCount(30);
    await expect(page.locator('[data-sync-first-unread]')).toBeHidden();
    await expect(page.locator('[data-sync-unread-separator]')).toHaveCount(0);
    await page.clock.runFor(1000);
    expect(chat.reads).toEqual([]);
    await expect(page.locator('[data-sync-input]')).toHaveValue('Still chatting');
    await expect(page.locator('[data-sync-first-unread]')).toBeHidden();
});

test('locates the first unread across history pages without reading newer messages', async ({ page }) => {
    const chat = await openChat(page, {
        history: Array.from({ length: 50 }, (_, i) => message(i + 51, `Message ${i + 51}`, otherId)),
        older: Array.from({ length: 50 }, (_, i) => message(i + 1, `Message ${i + 1}`, otherId)), readId: 20
    });
    await page.locator('[data-sync-first-unread]').click();
    await expect(highlighted(page)).toHaveText('Message 21');
    await expect(page.locator('[data-sync-first-unread]')).toBeHidden();
    expect(chat.historyRequests).toEqual(['51']);
    const divider = page.locator('[data-sync-unread-separator]');
    await expect(divider).toHaveText('从这里开始未读');
    expect(await divider.evaluate(element => element.nextElementSibling.querySelector('.sync-message-text').textContent)).toBe('Message 21');
    await page.clock.runFor(1000);
    expect(chat.reads).toEqual([]);
    const feed = await page.locator('[data-sync-feed]').boundingBox();
    const target = await page.locator('.sync-message').filter({ has: page.getByText('Message 21', { exact: true }) }).boundingBox();
    expect(target.y).toBeGreaterThanOrEqual(feed.y);
    expect(target.y).toBeLessThan(feed.y + feed.height);
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
    await page.locator('[data-taskbar-lang]').click();
    await expect(divider).toHaveText('Unread messages start here');
    await expect(page.locator('[data-sync-first-unread]')).toBeHidden();
    const navigation = await page.locator('[data-sync-unread-navigation]').boundingBox();
    expect(navigation).toBeNull();
    await page.clock.runFor(800);
    expect(chat.reads.at(-1)).toBeGreaterThanOrEqual(21);
    expect(chat.reads.at(-1)).toBeLessThan(100);
    await expect(divider).toHaveCount(0);
});

test('cycles unread mentions and never marks a bottom target read from the jump alone', async ({ page }) => {
    const history = Array.from({ length: 30 }, (_, i) => [4, 17, 30].includes(i + 1)
        ? mentionMessage(i + 1) : message(i + 1, `Message ${i + 1}`, otherId));
    const chat = await openChat(page, { history, readId: 3, standalone: true });
    const button = page.locator('[data-sync-unread-mention]');
    await expect(button).toHaveText('@我 · 3');
    for (const id of [4, 17, 30, 4]) {
        await button.click();
        await expect(highlighted(page)).toHaveText(`@Local hello ${id}`);
        await page.clock.runFor(800);
        expect(chat.reads).toEqual([]);
    }
    const area = await page.locator('.sync-message-area').boundingBox();
    const navigation = await page.locator('[data-sync-unread-navigation]').boundingBox();
    expect(navigation.x).toBeGreaterThanOrEqual(area.x);
    expect(navigation.x + navigation.width).toBeLessThanOrEqual(area.x + area.width);
    expect(navigation.y).toBeGreaterThanOrEqual(area.y);
    chat.frame({ type: 'read', deviceId, messageId: 17 });
    await expect(button).toHaveText('@我 · 1');
    await button.click();
    await expect(highlighted(page)).toHaveText('@Local hello 30');
});

test('keeps the divider stable on incoming messages and removes unread navigation after remote receipt', async ({ page }) => {
    const history = Array.from({ length: 30 }, (_, i) => message(i + 1, `Message ${i + 1}`, otherId));
    const chat = await openChat(page, { history, readId: 10 });
    await page.locator('[data-sync-first-unread]').click();
    const divider = page.locator('[data-sync-unread-separator]');
    const before = await page.locator('.sync-message.is-reply-target').boundingBox();
    chat.frame({ type: 'message', message: message(31, 'Latest 31', otherId), history: bounds(31) });
    await expect(page.locator('.sync-message-text').last()).toHaveText('Latest 31');
    expect(await divider.evaluate(element => element.nextElementSibling.querySelector('.sync-message-text').textContent)).toBe('Message 11');
    expect((await page.locator('.sync-message.is-reply-target').boundingBox()).y).toBe(before.y);
    chat.frame({ type: 'read', deviceId, messageId: 31 });
    await expect(divider).toHaveCount(0);
    await expect(page.locator('[data-sync-unread-navigation]')).toBeHidden();
    await expect(page.locator('[data-sync-first-unread]')).toBeHidden();
    expect(chat.reads).toEqual([]);
});

test('finds older unread mentions even when the latest page contains only own messages', async ({ page }) => {
    const chat = await openChat(page, { history: Array.from({ length: 50 }, (_, i) => message(i + 51)),
        older: Array.from({ length: 50 }, (_, i) => i === 11 ? mentionMessage(12) : message(i + 1)), readId: 10 });
    await expect(page.locator('[data-sync-unread-mention]')).toHaveText('查找 @我');
    await page.locator('[data-sync-unread-mention]').click();
    await expect(highlighted(page)).toHaveText('@Local hello 12');
    await expect(page.locator('[data-sync-unread-mention]')).toHaveText('@我 · 1');
    expect(chat.historyRequests).toEqual(['51']);
    await page.clock.runFor(800);
    expect(chat.reads).toEqual([]);
});

test('cancels a pending unread jump when the user searches', async ({ page }) => {
    const history = Array.from({ length: 50 }, (_, i) => message(i + 51, `Message ${i + 51}`, otherId));
    await openChat(page, { history, readId: 20 });
    let release;
    let requested = false;
    const gate = new Promise(resolve => { release = resolve; });
    await page.route('https://sync.test/**/messages?*', async route => {
        requested = true;
        await gate;
        await route.fulfill({ headers, json: {
            messages: Array.from({ length: 50 }, (_, i) => message(i + 1, `Message ${i + 1}`, otherId)),
            historyMode: 'prepend', history: bounds(100)
        } }).catch(() => {});
    });
    try {
        await page.locator('[data-sync-first-unread]').click();
        await expect.poll(() => requested).toBe(true);
        const toggle = page.locator('[data-sync-tools-toggle]');
        if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
        await page.locator('[data-sync-search]').fill('Message 75');
        release();
        await page.clock.runFor(1000);
        await expect(page.locator('.sync-message.is-reply-target')).toHaveCount(0);
        await expect(page.locator('[data-sync-search]')).toHaveValue('Message 75');
        await expect(page.locator('.sync-message:visible .sync-message-text')).toHaveText('Message 75');
    } finally { release(); }
});
