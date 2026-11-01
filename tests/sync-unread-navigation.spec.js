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

test('locates the first unread across history pages without reading newer messages', async ({ page }) => {
    const chat = await openChat(page, {
        history: Array.from({ length: 50 }, (_, i) => message(i + 51, `Message ${i + 51}`, otherId)),
        older: Array.from({ length: 50 }, (_, i) => message(i + 1, `Message ${i + 1}`, otherId)), readId: 20
    });
    await page.locator('[data-sync-first-unread]').click();
    await expect(highlighted(page)).toHaveText('Message 21');
    expect(chat.historyRequests).toEqual(['51']);
    const divider = page.locator('[data-sync-unread-separator]');
    await expect(divider).toHaveText('从这里开始未读');
    expect(await divider.evaluate(element => element.nextElementSibling.querySelector('.sync-message-text').textContent)).toBe('Message 21');
    await page.clock.runFor(1000);
    expect(chat.reads).toEqual([]);
    await expect(page.locator('[data-sync-unread]')).toHaveText('80');
    const feed = await page.locator('[data-sync-feed]').boundingBox();
    const target = await page.locator('.sync-message.is-reply-target').boundingBox();
    expect(target.y).toBeGreaterThanOrEqual(feed.y);
    expect(target.y).toBeLessThan(feed.y + feed.height);
    await page.locator('[data-taskbar-lang]').click();
    await expect(divider).toHaveText('Unread messages start here');
    await expect(page.locator('[data-sync-first-unread]')).toHaveText('First unread');
    const navigation = await page.locator('[data-sync-unread-navigation]').boundingBox();
    const latest = await page.locator('[data-sync-latest]').boundingBox();
    const area = await page.locator('.sync-message-area').boundingBox();
    expect(navigation.y + navigation.height).toBeLessThanOrEqual(latest.y);
    expect(navigation.x).toBeGreaterThanOrEqual(area.x);
    expect(navigation.x + navigation.width).toBeLessThanOrEqual(area.x + area.width);
    expect(latest.x).toBeGreaterThanOrEqual(area.x);
    expect(latest.x + latest.width).toBeLessThanOrEqual(area.x + area.width);
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
    await expect(page.locator('[data-sync-latest]')).toBeHidden();
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

for (const action of ['latest', 'search']) test(`cancels a pending unread jump when the user chooses ${action}`, async ({ page }) => {
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
        if (action === 'latest') await page.locator('[data-sync-latest]').click();
        else {
            const toggle = page.locator('[data-sync-tools-toggle]');
            if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
            await page.locator('[data-sync-search]').fill('Message 75');
        }
        release();
        await page.clock.runFor(1000);
        await expect(page.locator('.sync-message.is-reply-target')).toHaveCount(0);
        if (action === 'latest') await expect.poll(() => page.locator('[data-sync-feed]').evaluate(feed => feed.scrollHeight - feed.clientHeight - feed.scrollTop)).toBeLessThan(3);
        else {
            await expect(page.locator('[data-sync-search]')).toHaveValue('Message 75');
            await expect(page.locator('.sync-message:visible .sync-message-text')).toHaveText('Message 75');
        }
    } finally { release(); }
});
