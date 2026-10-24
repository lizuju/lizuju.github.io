const { test, expect } = require('@playwright/test');

test('keeps the scene return link clear of window controls at short and narrow sizes', async ({ page }) => {
    for (const viewport of [{ width: 980, height: 320 }, { width: 1366, height: 768 }, { width: 320, height: 568 }]) {
        await page.setViewportSize(viewport);
        await page.goto('/portfolio/');
        const link = page.locator('[data-direct-return]');
        const window = page.locator('[data-app-window]');
        await expect(link).toBeVisible();
        for (let state = 0; state < 2; state++) {
            const bounds = await link.boundingBox();
            const controls = await window.locator('.window-controls').boundingBox();
            expect(bounds.y).toBeGreaterThanOrEqual(controls.y + controls.height);
            expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
            expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height);
            await window.locator('[data-window-action="maximize"]').click();
        }
        await window.locator('[data-window-action="close"]').click();
        await expect(link).toBeVisible();
        await page.locator('.desktop-shortcut[data-open-window]').click();
        await expect(window).toBeVisible();
    }
});

test('opens public sync storage automatically, refreshes without credentials and aborts on close', async ({ page }) => {
    const seen = [];
    let bytes = 1200000000;
    let hold = false;
    let aborted;
    const cancelled = new Promise(resolve => { aborted = resolve; });
    let release;
    let started;
    const waiting = new Promise(resolve => { started = resolve; });
    page.on('requestfailed', request => { if (request.url() === 'https://sync.test/v1/status') aborted(); });
    await page.route('**/portfolio/sync-config.json', route => route.fulfill({ json: { apiBase: 'https://sync.test' } }));
    await page.route('https://sync.test/v1/status', async route => {
        const headers = { 'Access-Control-Allow-Origin': '*' };
        seen.push({ url: route.request().url(), auth: route.request().headers().authorization });
        if (hold) {
            started();
            await new Promise(resolve => { release = resolve; });
        }
        await route.fulfill({ headers, json: {
            ok: true, checkedAt: Date.now(), database: { registry: { ok: true } },
            storage: { bytes, highWaterBytes: 4700000000, roomCount: 3, reservedBytes: 800000000 },
            maintenance: { phase: null, scannedRooms: null, lastSuccessAt: Date.now() - 1000, nextAlarmAt: null }
        } });
    });
    await page.goto('/portfolio/');
    await page.locator('[data-start-toggle]').click();
    await page.locator('[data-open-control-panel]').click();
    const panel = page.locator('[data-control-panel-window]');
    await expect(panel).toBeVisible();
    await page.locator('[data-open-sync-storage]').click();
    const app = page.locator('[data-sync-storage-window]');
    const notice = app.locator('[data-sync-storage-notice]');
    await expect(app).toBeVisible();
    await expect(panel).toBeVisible();
    await expect(app.locator('input')).toHaveCount(0);
    await expect(app.locator('[data-sync-storage-metrics]')).toContainText('1.200 GB / 4.700 GB');
    bytes = 1500000000;
    await app.locator('[data-sync-storage-refresh]').click();
    await expect(app.locator('[data-sync-storage-metrics]')).toContainText('1.500 GB / 4.700 GB');
    expect(seen).toHaveLength(2);
    expect(seen.every(request => !request.auth && !request.url.includes('token'))).toBe(true);
    await app.locator('[data-sync-storage-action="maximize"]').click();
    await expect(app).toHaveClass(/is-maximized/);
    await page.locator('[data-taskbar-lang]').click();
    await expect(app.locator('[data-sync-storage-metrics]')).toContainText('Project storage');
    await expect(app.locator('[data-sync-storage-action="close"]')).toHaveAttribute('aria-label', 'Close sync storage');
    await app.locator('[data-sync-storage-action="minimize"]').click();
    await expect(app).toHaveClass(/is-minimized/);
    await page.locator('[data-sync-storage-task]').click();
    await expect(app).not.toHaveClass(/is-minimized/);
    expect(seen).toHaveLength(2);
    hold = true;
    await app.locator('[data-sync-storage-refresh]').click();
    await waiting;
    await app.locator('[data-sync-storage-action="close"]').click();
    await cancelled;
    await expect(app.locator('[data-sync-storage-metrics]')).toBeHidden();
    await expect(notice).toHaveText('Open this window to check sync storage.');
    release();
    hold = false;
    await page.locator('[data-open-sync-storage]').click();
    await expect(app.locator('[data-sync-storage-metrics]')).toContainText('1.500 GB / 4.700 GB');
    expect(seen).toHaveLength(4);
});

test('opens the bilingual control panel as a movable desktop window with an independent storage window', async ({ page, isMobile }) => {
    test.skip(isMobile, 'desktop window controls are tested with a mouse');
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.goto('/portfolio/');
    await page.locator('[data-start-toggle]').click();
    await expect(page.locator('.start-menu-rail')).toHaveText('GAVIN OS');
    await expect(page.locator('[data-start-menu] [data-open-sync-storage]')).toHaveCount(0);
    await page.locator('[data-open-control-panel]').click();
    const panel = page.locator('[data-control-panel-window]');
    const storage = page.locator('[data-sync-storage-window]');
    const item = panel.locator('[data-open-sync-storage]');
    await expect(panel).toBeVisible();
    await expect(item).toBeFocused();
    await expect(page.locator('[data-control-panel-task]')).toBeVisible();
    const original = await panel.boundingBox();
    const title = await panel.locator('[data-control-panel-drag]').boundingBox();
    await page.mouse.move(title.x + 100, title.y + 10);
    await page.mouse.down();
    await page.mouse.move(title.x + 140, title.y + 40);
    await page.mouse.up();
    const moved = await panel.boundingBox();
    expect(moved.x).toBeGreaterThan(original.x + 30);
    expect(moved.y).toBeGreaterThan(original.y + 20);
    const grip = await panel.locator('[data-control-panel-resize]').boundingBox();
    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
    await page.mouse.down();
    await page.mouse.move(grip.x + grip.width / 2 + 40, grip.y + grip.height / 2 + 30);
    await page.mouse.up();
    expect((await panel.boundingBox()).width).toBeGreaterThan(moved.width + 30);
    await panel.locator('[data-control-panel-action="maximize"]').click();
    await expect(panel).toHaveClass(/is-maximized/);
    await panel.locator('[data-control-panel-action="maximize"]').click();
    await panel.locator('[data-control-panel-action="minimize"]').click();
    await expect(panel).toHaveClass(/is-minimized/);
    await page.locator('[data-control-panel-task]').click();
    await expect(panel).toBeVisible();
    await item.click();
    await expect(storage).toBeVisible();
    await expect(panel).toBeVisible();
    await expect(page.locator('[data-sync-storage-task]')).toBeVisible();
    await page.screenshot({ path: '/tmp/portfolio-control-panel.png' });
    await storage.locator('[data-sync-storage-action="close"]').click();
    await expect(panel).toBeVisible();
    await expect(panel).toHaveClass(/is-active/);
    await page.locator('[data-taskbar-lang]').click();
    await expect(panel.locator('#control-panel-title')).toHaveText('Control Panel');
    await expect(item).toContainText('Sync storage');
    await expect(panel.locator('[data-control-panel-action="close"]')).toHaveAttribute('aria-label', 'Close Control Panel');
    await panel.locator('[data-control-panel-action="close"]').click();
    await expect(panel).toBeHidden();
    await expect(page.locator('[data-control-panel-task]')).toBeHidden();
});
