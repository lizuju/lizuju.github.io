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

test('loads public storage inside the control panel and aborts on back or close', async ({ page }) => {
    const seen = [];
    let bytes = 1200000000;
    let hold = false;
    let release;
    let notifyStarted;
    let notifyCancelled;
    page.on('requestfailed', request => { if (request.url() === 'https://sync.test/v1/status') notifyCancelled?.(); });
    await page.route('**/portfolio/sync-config.json', route => route.fulfill({ json: { apiBase: 'https://sync.test' } }));
    await page.route('https://sync.test/v1/status', async route => {
        const headers = { 'Access-Control-Allow-Origin': '*' };
        seen.push({ url: route.request().url(), auth: route.request().headers().authorization });
        if (hold) {
            notifyStarted();
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
    const root = panel.locator('[data-control-panel-root]');
    const item = panel.locator('[data-open-sync-storage]');
    const storage = panel.locator('[data-sync-storage-view]');
    const metrics = storage.locator('[data-sync-storage-metrics]');
    const back = panel.locator('[data-control-panel-back]');
    await item.click();
    await expect(root).toBeHidden();
    await expect(storage).toBeVisible();
    await expect(back).toBeVisible();
    await expect(panel.locator('[data-control-panel-location]')).toContainText('联络站存储');
    await expect(page.locator('[data-sync-storage-window], [data-sync-storage-task], [data-sync-storage-action]')).toHaveCount(0);
    await expect(storage.locator('input')).toHaveCount(0);
    await expect(metrics).toContainText('1.200 GB / 4.700 GB');
    bytes = 1500000000;
    await storage.locator('[data-sync-storage-refresh]').click();
    await expect(metrics).toContainText('1.500 GB / 4.700 GB');
    expect(seen).toHaveLength(2);
    expect(seen.every(request => !request.auth && !request.url.includes('token'))).toBe(true);
    await page.locator('[data-taskbar-lang]').click();
    await expect(storage).toBeVisible();
    await expect(metrics).toContainText('Project storage');
    await expect(panel.locator('[data-control-panel-location]')).toContainText('Sync storage');
    await panel.locator('[data-control-panel-action="minimize"]').click();
    await expect(panel).toHaveClass(/is-minimized/);
    await page.locator('[data-control-panel-task]').click();
    await expect(storage).toBeVisible();
    await expect(metrics).toContainText('1.500 GB / 4.700 GB');
    expect(seen).toHaveLength(2);
    for (const action of ['back', 'close']) {
        hold = true;
        const waiting = new Promise(resolve => { notifyStarted = resolve; });
        const cancelled = new Promise(resolve => { notifyCancelled = resolve; });
        await storage.locator('[data-sync-storage-refresh]').click();
        await waiting;
        if (action === 'back') await back.click();
        else await panel.locator('[data-control-panel-action="close"]').click();
        await cancelled;
        if (action === 'close') {
            await page.locator('[data-start-toggle]').click();
            await page.locator('[data-open-control-panel]').click();
        }
        await expect(root).toBeVisible();
        await expect(storage).toBeHidden();
        await expect(metrics).toBeEmpty();
        await expect(back).toBeHidden();
        await expect(item).toBeFocused();
        release();
        hold = false;
        await item.click();
        await expect(metrics).toContainText('1.500 GB / 4.700 GB');
    }
    expect(seen).toHaveLength(6);
});

test('keeps nested storage navigation inside the movable bilingual control panel', async ({ page, isMobile }) => {
    test.skip(isMobile, 'desktop window controls are tested with a mouse');
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.goto('/portfolio/');
    await page.locator('[data-start-toggle]').click();
    await expect(page.locator('.start-menu-rail')).toHaveText('GAVIN OS');
    await expect(page.locator('[data-start-menu] [data-open-sync-storage]')).toHaveCount(0);
    await page.locator('[data-open-control-panel]').click();
    const panel = page.locator('[data-control-panel-window]');
    const storage = panel.locator('[data-sync-storage-view]');
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
    await expect(page.locator('[data-sync-storage-task]')).toHaveCount(0);
    await expect(panel.locator('[data-control-panel-root]')).toBeHidden();
    await page.screenshot({ path: '/tmp/portfolio-control-panel.png' });
    await panel.locator('[data-control-panel-back]').click();
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

test('keeps the storage page scrollable in short and narrow windows', async ({ page }) => {
    await page.route('**/portfolio/sync-config.json', route => route.fulfill({ json: { apiBase: 'https://sync.test' } }));
    await page.route('https://sync.test/v1/status', route => route.fulfill({ headers: { 'Access-Control-Allow-Origin': '*' }, json: {
        ok: true, checkedAt: Date.now(), database: { registry: { ok: true } },
        storage: { bytes: 1200000000, highWaterBytes: 4700000000, roomCount: 3, reservedBytes: 0 },
        maintenance: { phase: null, scannedRooms: null, lastSuccessAt: Date.now(), nextAlarmAt: null }
    } }));
    for (const viewport of [{ width: 980, height: 320 }, { width: 320, height: 568 }]) {
        await page.setViewportSize(viewport);
        await page.goto('/portfolio/');
        await page.locator('[data-start-toggle]').click();
        await page.locator('[data-open-control-panel]').click();
        const panel = page.locator('[data-control-panel-window]');
        await panel.locator('[data-open-sync-storage]').click();
        const storage = panel.locator('[data-sync-storage-view]');
        await expect(storage.locator('[data-sync-storage-metrics]')).toContainText('4.700 GB');
        await storage.locator('[data-sync-storage-metrics] dd').last().scrollIntoViewIfNeeded();
        const position = await storage.locator('[data-sync-storage-metrics] dd').last().boundingBox();
        expect(position.y).toBeGreaterThanOrEqual(0);
        expect(position.y + position.height).toBeLessThanOrEqual(viewport.height);
        expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
        await panel.locator('[data-control-panel-back]').click();
        await expect(panel.locator('[data-control-panel-root]')).toBeVisible();
        await expect(storage).toBeHidden();
    }
});

test('keeps failed checks visible across language changes and distinguishes sampled health from daily quotas', async ({ page }) => {
    let fail = false;
    let quotaStatus = 'ready';
    const collectedAt = Date.UTC(2026, 9, 24, 2);
    const dailyMetrics = {
        workersRequests: { used: 81000, limit: 100000, level: 'warning' },
        durableRequests: { used: 96000, limit: 100000, level: 'critical' },
        rowsRead: { used: 100, limit: 5000000, level: 'normal' },
        rowsWritten: { used: 100100, limit: 100000, level: 'exceeded' },
        duration: { used: 1.25, limit: 13000, level: 'normal' }
    };
    await page.route('**/portfolio/sync-config.json', route => route.fulfill({ json: { apiBase: 'https://sync.test' } }));
    await page.route('https://sync.test/v1/status', route => route.fulfill({ status: fail ? 503 : 200, headers: { 'Access-Control-Allow-Origin': '*' }, json: fail ? { error: 'unavailable' } : {
        ok: false, checkedAt: collectedAt,
        database: { registry: { ok: true }, sampledRoom: { ok: true }, sampledShard: { ok: false } },
        storage: { bytes: 1200000000, highWaterBytes: 4700000000, roomCount: 3, reservedBytes: 0 },
        maintenance: { status: 'overdue', phase: null, scannedRooms: null, lastSuccessAt: collectedAt - 48 * 3600000, lastFailureAt: null, nextAlarmAt: null },
        dailyUsage: { status: quotaStatus, available: quotaStatus !== 'not_configured', day: '2026-10-24', checkedAt: quotaStatus === 'not_configured' ? null : collectedAt,
            resetsAt: Date.UTC(2026, 9, 25), metrics: quotaStatus === 'not_configured' ? null : dailyMetrics, estimated: true }
    } }));
    await page.goto('/portfolio/');
    await page.locator('[data-start-toggle]').click();
    await page.locator('[data-open-control-panel]').click();
    await page.locator('[data-open-sync-storage]').click();
    const metrics = page.locator('[data-sync-storage-metrics]');
    const quota = page.locator('[data-sync-daily-metrics]');
    const notice = page.locator('[data-sync-storage-notice]');
    await expect(metrics).toContainText('维护逾期');
    await expect(metrics.locator('dt', { hasText: '附件抽样' }).locator('+ dd')).toHaveText('异常');
    await expect(quota).toContainText('81,000 / 100,000 (81%)');
    await expect(quota.locator('[data-level="exceeded"]')).toContainText('100.1%');
    fail = true;
    await page.locator('[data-sync-storage-refresh]').click();
    await expect(notice).toHaveText('暂时无法检查服务，请重试。');
    await page.locator('[data-taskbar-lang]').click();
    await expect(notice).toHaveText('Unable to check the service. Please retry.');
    await expect(notice).toHaveAttribute('data-state', 'error');
    await expect(page.locator('[data-sync-daily-checked]')).toContainText('2026-10-24 (UTC)');
    fail = false;
    quotaStatus = 'stale';
    await page.locator('[data-sync-storage-refresh]').click();
    await expect(page.locator('[data-sync-daily-notice]')).toContainText('last successful snapshot');
    await expect(quota).toBeVisible();
    quotaStatus = 'not_configured';
    await page.locator('[data-sync-storage-refresh]').click();
    await expect(page.locator('[data-sync-daily-notice]')).toContainText('not connected');
    await expect(quota).toBeHidden();
    await expect(quota).toBeEmpty();
    await expect(notice).toContainText('Checked:');
});

test('refreshes storage every fifteen minutes only while its detail page is visible', async ({ page }) => {
    let requests = 0;
    await page.clock.install();
    await page.route('**/portfolio/sync-config.json', route => route.fulfill({ json: { apiBase: 'https://sync.test' } }));
    await page.route('https://sync.test/v1/status', route => {
        requests++;
        return route.fulfill({ headers: { 'Access-Control-Allow-Origin': '*' }, json: {
            ok: true, checkedAt: Date.now(), database: { registry: { ok: true } },
            storage: { bytes: 1200000000, highWaterBytes: 4700000000, roomCount: 3, reservedBytes: 0 },
            maintenance: { phase: null, scannedRooms: null, lastSuccessAt: Date.now(), nextAlarmAt: null }
        } });
    });
    await page.goto('/portfolio/');
    await page.clock.fastForward('15:00');
    expect(requests).toBe(0);
    await page.locator('[data-start-toggle]').click();
    await page.locator('[data-open-control-panel]').click();
    await page.clock.fastForward('15:00');
    expect(requests).toBe(0);
    const panel = page.locator('[data-control-panel-window]');
    const item = panel.locator('[data-open-sync-storage]');
    const notice = panel.locator('[data-sync-storage-notice]');
    await item.click();
    await expect(notice).toContainText('检查时间');
    expect(requests).toBe(1);
    await page.clock.fastForward('14:59');
    expect(requests).toBe(1);
    await page.clock.fastForward('00:01');
    await expect.poll(() => requests).toBe(2);
    await expect(notice).toContainText('检查时间');
    await panel.locator('[data-control-panel-action="minimize"]').click();
    await page.clock.fastForward('15:00');
    expect(requests).toBe(2);
    await page.locator('[data-control-panel-task]').click();
    await expect.poll(() => requests).toBe(3);
    await expect(notice).toContainText('检查时间');
    await panel.locator('[data-control-panel-back]').click();
    await page.clock.fastForward('30:00');
    expect(requests).toBe(3);
    await item.click();
    await expect.poll(() => requests).toBe(4);
    await expect(notice).toContainText('检查时间');
    await panel.locator('[data-control-panel-action="close"]').click();
    await page.clock.fastForward('15:00');
    expect(requests).toBe(4);
    await page.locator('[data-start-toggle]').click();
    await page.locator('[data-open-control-panel]').click();
    await item.click();
    await expect.poll(() => requests).toBe(5);
    await expect(notice).toContainText('检查时间');
    await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, value: true });
        document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.clock.fastForward('15:00');
    expect(requests).toBe(5);
    await page.evaluate(() => {
        delete document.hidden;
        document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect.poll(() => requests).toBe(6);
});

test('pauses storage collection when leaving the immersive monitor', async ({ page }) => {
    let requests = 0;
    await page.clock.install();
    await page.route('**/quota-test-shell', route => route.fulfill({ contentType: 'text/html', body: '<iframe id="computer-screen" src="/portfolio/" style="position:fixed;inset:0;width:100%;height:100%;border:0"></iframe>' }));
    await page.route('**/portfolio/sync-config.json', route => route.fulfill({ json: { apiBase: 'https://sync.test' } }));
    await page.route('https://sync.test/v1/status', route => {
        requests++;
        return route.fulfill({ headers: { 'Access-Control-Allow-Origin': '*' }, json: {
            ok: true, checkedAt: Date.now(), database: { registry: { ok: true } },
            storage: { bytes: 0, highWaterBytes: 4700000000, roomCount: 0, reservedBytes: 0 },
            maintenance: { phase: null, scannedRooms: null, lastSuccessAt: null, nextAlarmAt: null }
        } });
    });
    await page.goto('/quota-test-shell');
    const frame = page.frameLocator('#computer-screen');
    await frame.locator('[data-start-toggle]').click();
    await frame.locator('[data-open-control-panel]').click();
    await frame.locator('[data-open-sync-storage]').click();
    await page.clock.fastForward('15:00');
    expect(requests).toBe(0);
    const setMonitorActive = (active) => page.evaluate((active) => {
        document.querySelector('iframe').contentWindow.postMessage({ source: 'gavin-shell', type: 'portfolio-view-state', active }, location.origin);
    }, active);
    await setMonitorActive(true);
    await expect.poll(() => requests).toBe(1);
    await expect(frame.locator('[data-sync-storage-notice]')).toContainText('检查时间');
    await setMonitorActive(false);
    await page.clock.fastForward('30:00');
    expect(requests).toBe(1);
    await setMonitorActive(true);
    await expect.poll(() => requests).toBe(2);
    await expect(frame.locator('[data-sync-storage-notice]')).toContainText('检查时间');
    await page.clock.fastForward('15:00');
    await expect.poll(() => requests).toBe(3);
});
