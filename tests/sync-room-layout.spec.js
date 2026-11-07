const { test, expect, deviceId, otherId, keyId, message, authorize } = require('./fixtures/sync-e2ee.cjs');
const { apiBase: productionApiBase } = require('../static/portfolio/sync-config.json');

test.use({ serviceWorkers: 'block' });

const preference = 'portfolio-sync-tools-collapsed';
const headers = {
    'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Sync-Key-Id',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
};

const openChat = async (page, initial = [], path = '/portfolio/') => {
    if (path === '/chat/') await page.route('**/chat/', async route => {
        const response = await route.fetch();
        const body = (await response.text()).replaceAll(productionApiBase, 'https://sync.test')
            .replaceAll(productionApiBase.replace(/^http/, 'ws'), 'wss://sync.test');
        await route.fulfill({ response, body });
    });
    await authorize(page);
    await page.route('**/portfolio/sync-config.json', route => route.fulfill({ json: { apiBase: 'https://sync.test' } }));
    await page.route('https://sync.test/**', route => route.request().method() === 'OPTIONS'
        ? route.fulfill({ status: 204, headers })
        : route.fulfill({ headers, json: { deviceId, devices: [], grants: [], hasMore: false, keyId } }));
    await page.routeWebSocket('wss://sync.test/**', socket => socket.onMessage(raw => {
        if (raw === 'ping') return socket.send('pong');
        if (JSON.parse(raw).type === 'auth') socket.send(JSON.stringify({
            type: 'ready', deviceId, messages: initial, pairing: null, readReceipts: [],
            history: { generation: '1', oldestId: initial[0]?.id ?? null, latestId: initial.at(-1)?.id ?? null, continuationId: initial.at(-1)?.id ?? null, hasNewer: false },
            historyMode: 'replace'
        }));
    }));
    const open = async () => {
        await page.goto(path);
        if (path === '/portfolio/') {
            if (await page.locator('[data-window-action="minimize"]').isVisible()) await page.locator('[data-window-action="minimize"]').click();
            if (!await page.locator('[data-sync-window]').isVisible()) await page.locator('.desktop-shortcut[data-open-sync-space]').click();
        }
        await expect(page.locator('[data-sync-status]')).toHaveAttribute('data-state', 'online');
    };
    await open();
    return open;
};

test('closing the space name dialog restores a visible keyboard target', async ({ page }) => {
    await openChat(page);
    for (const close of ['escape', 'space-name-close', 'space-name-cancel']) {
        await page.locator('[data-sync-tools-toggle]').click();
        await page.locator('[data-sync-space-rename]').click();
        await expect(page.locator('[data-sync-space-name]')).toBeFocused();
        if (close === 'escape') await page.keyboard.press('Escape');
        else await page.locator(`[data-sync-${close}]`).click();
        await expect(page.locator('[data-sync-tools-toggle]')).toBeFocused();
    }
});

test('keeps the tools overlay closed in narrow windows and remembers only the wide layout', async ({ page, isMobile }) => {
    const open = await openChat(page);
    const toggle = page.locator('[data-sync-tools-toggle]');
    const panel = page.locator('[data-sync-tools-panel]');
    const saved = () => page.evaluate(key => localStorage.getItem(key), preference);
    const overlay = () => page.locator('[data-sync-tools]').evaluate(element => getComputedStyle(element).position === 'absolute');
    // The toggle sits at the sidebar's right edge, so collapsing or expanding never moves it under the pointer.
    const expectToggleAt = async place => {
        const box = await toggle.boundingBox();
        expect(Math.abs(box.x - place.x)).toBeLessThanOrEqual(1);
        expect(Math.abs(box.y - place.y)).toBeLessThanOrEqual(1);
    };

    expect(await overlay()).toBe(true);
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(panel).toBeHidden();
    const closedToggle = await toggle.boundingBox();
    await toggle.click();
    await expect(panel).toBeVisible();
    await expectToggleAt(closedToggle);
    expect((await page.locator('[data-sync-sound]').boundingBox()).x).toBeLessThan(closedToggle.x);
    await toggle.click();
    await expect(panel).toBeHidden();
    expect(await saved()).toBeNull();

    if (isMobile) {
        // A wide layout saved on another screen must not reopen the overlay over the conversation.
        await page.evaluate(key => localStorage.setItem(key, 'false'), preference);
        await open();
        await expect(toggle).toHaveAttribute('aria-expanded', 'false');
        await expect(panel).toBeHidden();
        await toggle.click();
        await expect(panel).toBeVisible();
        expect(await saved()).toBe('false');
        return;
    }

    const maximize = page.locator('[data-sync-action="maximize"]');
    await maximize.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(panel).toBeVisible();
    expect(await overlay()).toBe(false);
    const expandedToggle = await toggle.boundingBox();
    expect((await page.locator('[data-sync-sound]').boundingBox()).x).toBeLessThan(expandedToggle.x);
    await toggle.click();
    await expect(panel).toBeHidden();
    await expectToggleAt(expandedToggle);
    expect(await saved()).toBe('true');
    await toggle.click();
    await expect(panel).toBeVisible();
    expect(await saved()).toBe('false');

    await maximize.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(panel).toBeHidden();
    await expect(page.locator('[data-sync-input]')).toBeVisible();
    await page.locator('[data-sync-input]').click();
    expect(await saved()).toBe('false');

    await maximize.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(panel).toBeVisible();
});

for (const path of ['/portfolio/', '/chat/']) test(`opens concise bilingual Home Screen guidance in a narrow modal from ${path}`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await page.addInitScript(() => {
        delete window.Notification;
        Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' });
        Object.defineProperty(navigator, 'standalone', { configurable: true, value: false });
    });
    await openChat(page, [], path);
    const toggle = page.locator('[data-sync-tools-toggle]');
    const notifications = page.locator('[data-sync-notifications]');
    const dialog = page.locator('[data-sync-install-dialog]');
    await expect(page.locator('[data-sync-install-guide]')).toHaveCount(0);
    await expect(dialog).toBeHidden();
    for (const close of ['escape', 'install-close', 'install-dismiss']) {
        await toggle.click();
        await expect(notifications).toHaveText('系统通知：需添加到主屏幕');
        await notifications.click();
        await expect(dialog).toBeVisible();
        expect(await dialog.evaluate(element => element.matches(':modal'))).toBe(true);
        await expect(dialog.locator('li')).toHaveCount(3);
        await expect(dialog).toContainText('分享');
        await expect(dialog).toContainText('添加到主屏幕');
        await expect(dialog).toContainText('开启通知');
        const link = dialog.locator('[data-sync-install-open]');
        if (path === '/portfolio/') {
            await expect(link).toBeVisible();
            await expect(link).toHaveAttribute('href', '/chat/');
        } else await expect(link).toBeHidden();
        const bounds = await dialog.boundingBox();
        expect(bounds.x).toBeGreaterThanOrEqual(0);
        expect(bounds.y).toBeGreaterThanOrEqual(0);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(321);
        expect(bounds.y + bounds.height).toBeLessThanOrEqual(569);
        const dimensions = await dialog.evaluate(element => ({ width: element.clientWidth, scroll: element.scrollWidth }));
        expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width + 1);
        if (close === 'escape') await page.keyboard.press('Escape');
        else await dialog.locator(`[data-sync-${close}]`).click();
        await expect(dialog).toBeHidden();
        await expect(toggle).toBeFocused();
    }
    await page.locator('[data-taskbar-lang]').click();
    await toggle.click();
    await notifications.click();
    await expect(dialog).toContainText('Share');
    await expect(dialog).toContainText('Add to Home Screen');
    await expect(dialog).toContainText('notifications');
});

// Records an element's top after each of the next frames is painted, starting from a change made in the first frame.
const paintedTops = (page, selector, change) => page.evaluate(({ selector, change }) => new Promise(resolve => {
    const element = document.querySelector(selector);
    const tops = [];
    const sample = () => requestAnimationFrame(() => setTimeout(() => {
        tops.push(Math.round(element.getBoundingClientRect().top));
        if (tops.length < 6) sample(); else resolve(tops);
    }));
    new Function(change)();
    sample();
}), { selector, change });
// Painted positions may differ by a rounding pixel; anything more is a visible jump.
const expectStill = (tops, top) => {
    for (const value of tops) expect(Math.abs(value - top), `painted tops ${tops.join(', ')}`).toBeLessThanOrEqual(1);
};

test('floats the pairing card over the conversation without moving the messages when it opens, closes or appears', async ({ page }) => {
    await openChat(page, Array.from({ length: 30 }, (_, index) => message(index + 1, `Layout message ${index + 1}`, otherId)));
    const feed = page.locator('[data-sync-feed]');
    const dock = page.locator('[data-sync-pairing-dock]');
    const pairing = page.locator('[data-sync-pairing]');
    await expect(page.locator('.sync-message').last()).toContainText('Layout message 30');
    await expect.poll(() => feed.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(2);
    await page.locator('.sync-message').last().evaluate(element => { element.id = 'layout-latest'; });
    await expect(page.locator('#layout-latest')).toHaveCount(1);
    const latestTop = Math.round((await page.locator('#layout-latest').boundingBox()).y);

    // An offer arrives collapsed, then the user opens and closes it while reading the newest messages.
    const appear = "const pairing = document.querySelector('[data-sync-pairing]'); pairing.open = false; pairing.hidden = false;";
    expectStill(await paintedTops(page, '#layout-latest', appear), latestTop);
    await expect(pairing).toBeVisible();
    const toggle = "document.querySelector('.sync-pairing-toggle').click();";
    expectStill(await paintedTops(page, '#layout-latest', toggle), latestTop);
    await expect(pairing).toHaveAttribute('open', '');
    expectStill(await paintedTops(page, '#layout-latest', toggle), latestTop);
    await expect(pairing).not.toHaveAttribute('open', '');

    // Older messages being read stay in place too.
    await feed.evaluate(element => { element.scrollTop = Math.round(element.scrollHeight / 3); });
    await page.waitForFunction(() => {
        const feed = document.querySelector('[data-sync-feed]');
        return feed.scrollHeight - feed.scrollTop - feed.clientHeight > 100;
    });
    const reading = await page.locator('.sync-message').evaluateAll(items => {
        const feed = document.querySelector('[data-sync-feed]').getBoundingClientRect();
        const item = items.find(element => element.getBoundingClientRect().top > feed.top + 160);
        item.id = 'layout-reading';
        return Math.round(item.getBoundingClientRect().top);
    });
    expectStill(await paintedTops(page, '#layout-reading', toggle), reading);
    expectStill(await paintedTops(page, '#layout-reading', toggle), reading);

    const colors = await page.evaluate(() => ['[data-sync-pairing-dock]', '[data-sync-feed]', '[data-sync-pairing]']
        .map(selector => getComputedStyle(document.querySelector(selector))).map(style => [style.backgroundColor, style.boxShadow]));
    expect(colors[0][0]).toBe(colors[1][0]);
    expect(colors[2][1]).not.toBe('none');
    await expect(dock).toBeVisible();
});


test('keeps search visible after tools collapse and clears it without reopening tools', async ({ page }) => {
    await openChat(page, [message(1, 'Find this'), message(2, 'Keep the other')]);
    const toggle = page.locator('[data-sync-tools-toggle]');
    if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
    await page.locator('[data-sync-search]').fill('Find');
    await toggle.click();
    await expect(page.locator('[data-sync-search-state]')).toBeVisible();
    await expect(page.locator('[data-sync-search-label]')).toHaveText('搜索：Find');
    await expect(page.locator('.sync-message:visible')).toHaveCount(1);
    await page.locator('[data-taskbar-lang]').click();
    await expect(page.locator('[data-sync-search-label]')).toHaveText('Search: Find');
    await page.locator('[data-sync-search-clear]').click();
    await expect(page.locator('[data-sync-search-state]')).toBeHidden();
    await expect(page.locator('.sync-message:visible')).toHaveCount(2);
    await expect(page.locator('[data-sync-input]')).toBeFocused();
});

test('restores focus to visible tools toggle when device management closes over a narrow chat', async ({ page }) => {
    await openChat(page);
    await page.locator('[data-sync-window]').evaluate(app => { app.style.width = '320px'; });
    const toggle = page.locator('[data-sync-tools-toggle]');
    if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
    await page.locator('[data-sync-devices]').click();
    await expect(page.locator('[data-sync-devices-dialog]')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(toggle).toBeFocused();
});
