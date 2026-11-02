const { test, expect, authorize, deviceId, otherId, keyId, profile, message } = require('./fixtures/sync-e2ee.cjs');
const { apiBase } = require('../static/portfolio/sync-config.json');

test.use({ serviceWorkers: 'block' });
const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
const bounds = id => ({ generation: '1', oldestId: 1, latestId: id, continuationId: id, hasNewer: false });
const openChat = async (page, standalone = false, paginated = false) => {
    await authorize(page);
    await page.route('**/chat/', async route => {
        const response = await route.fetch();
        await route.fulfill({ response, body: (await response.text()).replaceAll(apiBase, 'https://sync.test')
            .replaceAll(apiBase.replace(/^http/, 'ws'), 'wss://sync.test') });
    });
    const fullHistory = Array.from({ length: 90 }, (_, index) => message(index + 1,
        `History ${index + 1}: a longer line to reflow when the phone rotates. `.repeat(2), otherId));
    const initial = paginated ? fullHistory.slice(40) : fullHistory.slice(0, 20);
    const reads = [];
    await page.route('**/sync-config.json', route => route.fulfill({ json: { apiBase: 'https://sync.test' } }));
    await page.route('https://sync.test/**', route => {
        if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
        const url = new URL(route.request().url());
        if (url.pathname.endsWith('/messages')) return route.fulfill({ headers, json: {
            messages: fullHistory.filter(item => item.id < Number(url.searchParams.get('before'))).slice(-50),
            historyMode: 'prepend', history: bounds(90)
        } });
        return route.fulfill({ headers, json: { deviceId, devices: [profile('Local'), profile('Remote', otherId)], grants: [], hasMore: false, keyId } });
    });
    await page.routeWebSocket('wss://sync.test/**', socket => socket.onMessage(raw => {
        if (raw === 'ping') return socket.send('pong');
        const data = JSON.parse(raw);
        if (data.type === 'auth') socket.send(JSON.stringify({ type: 'ready', deviceId, messages: initial, pairing: null,
            readReceipts: [{ deviceId, messageId: paginated ? 20 : 0 }], historyMode: 'replace', history: bounds(initial.at(-1).id) }));
        if (data.type === 'read') reads.push(data.messageId);
    }));
    await page.goto(standalone ? '/chat/' : '/portfolio/');
    await page.bringToFront();
    if (!standalone) {
        if (await page.locator('[data-window-action="minimize"]').isVisible()) await page.locator('[data-window-action="minimize"]').click();
        await page.locator('.desktop-shortcut[data-open-sync-space]').click();
    }
    await expect(page.locator('[data-sync-status]')).toHaveAttribute('data-state', 'online');
    await expect(page.locator('.sync-message')).toHaveCount(initial.length);
    return { reads };
};

for (const standalone of [false, true]) test(`keeps the ${standalone ? 'standalone' : 'desktop'} mobile composer inside the keyboard viewport`, async ({ page, isMobile }) => {
    test.skip(!isMobile, 'touch viewport adaptation');
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
        const viewport = new EventTarget();
        Object.assign(viewport, { height: innerHeight, offsetTop: 0, scale: 1 });
        Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
    });
    await openChat(page, standalone);
    const app = page.locator('[data-sync-window]');
    await expect(app).toHaveClass(/is-mobile-layout/);
    const input = page.locator('[data-sync-input]');
    const unchanged = !standalone && await page.locator('[data-app-window]').evaluate(element => ({ width: element.offsetWidth, height: element.offsetHeight }));
    await input.fill('A line\n'.repeat(10));
    await expect(input).toHaveCSS('font-size', '16px');
    await page.evaluate(() => {
        Object.assign(visualViewport, { height: 320, offsetTop: 25 });
        visualViewport.dispatchEvent(new Event('resize'));
    });
    await expect.poll(() => app.evaluate(element => element.getBoundingClientRect().bottom)).toBeLessThanOrEqual(345);
    const send = await page.locator('[data-sync-send]').boundingBox();
    expect(send.y).toBeGreaterThanOrEqual(25);
    expect(send.y + send.height).toBeLessThanOrEqual(345);
    const long = await input.boundingBox();
    expect(long.height).toBeLessThanOrEqual(112);
    await input.fill('Short');
    await expect.poll(() => input.evaluate(element => element.offsetHeight)).toBeLessThan(long.height);
    const height = await app.evaluate(element => element.style.getPropertyValue('--sync-viewport-height'));
    await page.evaluate(() => {
        Object.assign(visualViewport, { height: 160, scale: 2 });
        visualViewport.dispatchEvent(new Event('resize'));
    });
    expect(await app.evaluate(element => element.style.getPropertyValue('--sync-viewport-height'))).toBe(height);
    if (!standalone) expect(await page.locator('[data-app-window]').evaluate(element => ({ width: element.offsetWidth, height: element.offsetHeight }))).toEqual(unchanged);
    expect(errors).toEqual([]);
});

test('keeps the older unread reading anchor through phone rotation without marking it read', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'touch viewport adaptation');
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.clock.install();
    const chat = await openChat(page, true, true);
    await page.locator('[data-sync-first-unread]').click();
    const target = page.locator('.sync-message.is-reply-target');
    await expect(target).toContainText('History 21:');
    await page.clock.runFor(200);
    const anchor = await page.locator('[data-sync-messages]').evaluate(list => {
        const top = document.querySelector('[data-sync-feed]').getBoundingClientRect().top;
        const item = [...list.querySelectorAll('.sync-message')].find(node => node.getBoundingClientRect().bottom > top);
        item.dataset.rotationAnchor = '';
        return { offset: item.getBoundingClientRect().top - top };
    });
    await page.setViewportSize({ width: 568, height: 320 });
    await page.clock.runFor(800);
    const offset = await page.locator('[data-rotation-anchor]').evaluate(element => element.getBoundingClientRect().top
        - document.querySelector('[data-sync-feed]').getBoundingClientRect().top);
    expect(Math.abs(offset - anchor.offset)).toBeLessThanOrEqual(2);
    expect(chat.reads).toEqual([]);
    await expect(page.locator('[data-sync-unread-separator]')).toBeVisible();
    expect(errors).toEqual([]);
});

test('does not force phone composer geometry on a desktop pointer', async ({ page, isMobile }) => {
    test.skip(isMobile, 'mouse viewport stays desktop-controlled');
    await page.setViewportSize({ width: 320, height: 568 });
    await openChat(page);
    await expect(page.locator('[data-sync-window]')).not.toHaveClass(/is-mobile-layout/);
    await expect(page.locator('[data-sync-input]')).toHaveCSS('resize', 'vertical');
});
