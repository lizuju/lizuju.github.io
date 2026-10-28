const { test, expect, deviceId, keyId, authorize } = require('./fixtures/sync-e2ee.cjs');

test.use({ serviceWorkers: 'block' });

const preference = 'portfolio-sync-tools-collapsed';
const headers = {
    'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Sync-Key-Id',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
};

const openChat = async page => {
    await authorize(page);
    await page.route('**/portfolio/sync-config.json', route => route.fulfill({ json: { apiBase: 'https://sync.test' } }));
    await page.route('https://sync.test/**', route => route.request().method() === 'OPTIONS'
        ? route.fulfill({ status: 204, headers })
        : route.fulfill({ headers, json: { deviceId, devices: [], grants: [], hasMore: false, keyId } }));
    await page.routeWebSocket('wss://sync.test/**', socket => socket.onMessage(raw => {
        if (raw === 'ping') return socket.send('pong');
        if (JSON.parse(raw).type === 'auth') socket.send(JSON.stringify({
            type: 'ready', deviceId, messages: [], pairing: null, readReceipts: [],
            history: { generation: '1', oldestId: null, latestId: null, continuationId: null, hasNewer: false }, historyMode: 'replace'
        }));
    }));
    const open = async () => {
        await page.goto('/portfolio/');
        if (await page.locator('[data-window-action="minimize"]').isVisible()) await page.locator('[data-window-action="minimize"]').click();
        if (!await page.locator('[data-sync-window]').isVisible()) await page.locator('.desktop-shortcut[data-open-sync-space]').click();
        await expect(page.locator('[data-sync-status]')).toHaveAttribute('data-state', 'online');
    };
    await open();
    return open;
};

test('keeps the tools overlay closed in narrow windows and remembers only the wide layout', async ({ page, isMobile }) => {
    const open = await openChat(page);
    const toggle = page.locator('[data-sync-tools-toggle]');
    const panel = page.locator('[data-sync-tools-panel]');
    const saved = () => page.evaluate(key => localStorage.getItem(key), preference);
    const overlay = () => page.locator('[data-sync-tools]').evaluate(element => getComputedStyle(element).position === 'absolute');

    expect(await overlay()).toBe(true);
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(panel).toBeHidden();
    await toggle.click();
    await expect(panel).toBeVisible();
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
    await toggle.click();
    await expect(panel).toBeHidden();
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
