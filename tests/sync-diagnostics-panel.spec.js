const { test, expect, authorize, deviceId, otherId, keyId, profile } = require('./fixtures/sync-e2ee.cjs');

test.use({ serviceWorkers: 'block' });

const openDiagnostics = async page => {
    await page.locator('[data-start-toggle]').click();
    await page.locator('[data-open-control-panel]').click();
    await page.locator('[data-open-sync-diagnostics]').click();
    return page.locator('[data-sync-diagnostics-view]');
};

test('opens local diagnostics without cloud probes, switches language and exports only safe fields', async ({ page }) => {
    const probes = [];
    await page.route('**/v1/status', route => { probes.push(route.request().url()); return route.abort(); });
    await page.addInitScript(() => {
        sessionStorage.setItem('portfolio-sync-notification-diagnostics', JSON.stringify([
            { at: Date.now(), status: 'shown', visibility: 'hidden', totalMs: 120, queueMs: 20, workerMs: 30,
                roomId: 'private-room', token: 'private-token', body: 'private-message', url: 'https://secret.test' },
            { at: Date.now(), status: 'private-status', totalMs: 1 }
        ]));
    });
    await page.goto('/portfolio/');
    const view = await openDiagnostics(page);
    await expect(view).toBeVisible();
    await expect(view.locator('[data-sync-diagnostics-metrics]')).toContainText('本页尚未连接联络站');
    await expect(page.locator('[data-sync-storage-view]')).toBeHidden();
    await expect(view.locator('[data-sync-diagnostics-timings]')).toContainText('120 ms');
    await expect(view.locator('[data-sync-diagnostics-events]')).toContainText('已提交系统通知');
    await page.locator('[data-taskbar-lang]').click();
    await expect(page.locator('[data-control-panel-location]')).toHaveText('Control Panel › Connection diagnostics');
    await expect(view.locator('[data-sync-diagnostics-metrics]')).toContainText('Reconnects on this page');
    const downloaded = page.waitForEvent('download');
    await view.locator('[data-sync-diagnostics-export]').click();
    const download = await downloaded;
    await expect(view.locator('[data-sync-diagnostics-notice]')).toHaveText('Download requested. Check your browser downloads.');
    expect(download.suggestedFilename()).toBe('gavin-connection-diagnostics.json');
    const stream = await download.createReadStream();
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString();
    expect(text).not.toMatch(/private-|secret\.test/);
    const report = JSON.parse(text);
    expect(report.notifications).toHaveLength(1);
    expect(report.notifications[0].totalMs).toBe(120);
    expect(report.connection.connections.online).toBe(0);
    expect(probes).toHaveLength(0);
    await page.locator('[data-control-panel-back]').click();
    await expect(page.locator('[data-control-panel-root]')).toBeVisible();
    await expect(page.locator('[data-open-sync-diagnostics]')).toBeFocused();
});

test('asks notification permission only when testing and reports denial without enabling reminders', async ({ page }) => {
    await page.addInitScript(() => {
        window.permissionRequests = 0;
        window.Notification = { permission: 'default', requestPermission: async () => {
            window.permissionRequests++;
            return window.Notification.permission = 'denied';
        } };
    });
    await page.goto('/portfolio/');
    const view = await openDiagnostics(page);
    expect(await page.evaluate(() => window.permissionRequests)).toBe(0);
    await view.locator('[data-sync-diagnostics-test]').click();
    await expect(view.locator('[data-sync-diagnostics-notice]')).toHaveText('通知权限未允许');
    expect(await page.evaluate(() => window.permissionRequests)).toBe(1);
    expect(await page.evaluate(() => localStorage.getItem('portfolio-sync-system-notifications'))).toBeNull();
    await page.locator('[data-taskbar-lang]').click();
    await expect(view.locator('[data-sync-diagnostics-notice]')).toHaveText('Notification permission not granted');
});

test('downloads diagnostics through a native link inside the immersive iframe', async ({ page }) => {
    await page.route('**/__diagnostics-shell__/', route => route.fulfill({ contentType: 'text/html',
        body: '<iframe id="computer-screen" src="/portfolio/" style="width:900px;height:680px;border:0"></iframe>' }));
    await page.goto('/__diagnostics-shell__/');
    const frame = page.frameLocator('#computer-screen');
    const view = await openDiagnostics(frame);
    for (let attempt = 0; attempt < 2; attempt++) {
        const downloaded = page.waitForEvent('download');
        await view.locator('[data-sync-diagnostics-export]').click();
        const download = await downloaded;
        expect(download.suggestedFilename()).toBe('gavin-connection-diagnostics.json');
        expect(await download.failure()).toBeNull();
        await expect(view.locator('[data-sync-diagnostics-notice]')).toHaveText('已发起下载，请查看浏览器下载列表。');
    }
});

test('shows live connection and reconnect state without fetching diagnostics from the backend', async ({ page }) => {
    await authorize(page);
    await page.route('**/portfolio/sync-config.json', route => route.fulfill({ json: { apiBase: 'https://sync.test' } }));
    const requests = [];
    await page.route('https://sync.test/**', route => {
        requests.push(route.request().url());
        return route.fulfill({ headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' },
            json: { deviceId, devices: [profile('Local'), profile('Other', otherId)], grants: [], hasMore: false, keyId } });
    });
    let connection;
    await page.routeWebSocket('wss://sync.test/**', socket => {
        connection = socket;
        socket.onMessage(raw => {
            if (raw === 'ping') return socket.send('pong');
            if (JSON.parse(raw).type === 'auth') socket.send(JSON.stringify({ type: 'ready', deviceId, messages: [], pairing: null }));
        });
    });
    await page.goto('/portfolio/');
    const view = await openDiagnostics(page);
    await expect(view.locator('[data-sync-diagnostics-metrics]')).toContainText('本页尚未连接联络站');
    await view.locator('[data-sync-diagnostics-open]').click();
    await expect(page.locator('[data-sync-status]')).toHaveAttribute('data-state', 'online');
    await page.locator('[data-control-panel-task]').click();
    const metrics = view.locator('[data-sync-diagnostics-metrics]');
    await expect(metrics).toContainText('在线 1 · 连接中 0 · 离线 0');
    await connection.close({ code: 1012, reason: 'Restart' });
    await expect(metrics).toContainText('离线 1');
    await expect(metrics).toContainText('在线 1 · 连接中 0 · 离线 0');
    await expect(metrics.locator('dt', { hasText: '本页重连次数' }).locator('+ dd')).toHaveText('1');
    expect(requests.some(url => url.endsWith('/v1/status'))).toBe(false);
});

test('keeps diagnostics readable and scrollable at short and phone window sizes', async ({ page }) => {
    for (const viewport of [{ width: 980, height: 320 }, { width: 320, height: 568 }]) {
        await page.setViewportSize(viewport);
        await page.goto('/portfolio/');
        const view = await openDiagnostics(page);
        const list = view.locator('[data-sync-diagnostics-events]');
        await list.scrollIntoViewIfNeeded();
        const bounds = await list.boundingBox();
        expect(bounds.y).toBeGreaterThanOrEqual(0);
        expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height);
        expect(await view.locator('.sync-storage-body').evaluate(element => element.scrollWidth > element.clientWidth)).toBe(false);
        await page.locator('[data-control-panel-back]').click();
        await expect(view).toBeHidden();
        await page.locator('[data-control-panel-action="close"]').click();
    }
});
