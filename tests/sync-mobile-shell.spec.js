const { test, expect } = require('./fixtures/sync-e2ee.cjs');
const { apiBase } = require('../static/portfolio/sync-config.json');

test.use({ serviceWorkers: 'block' });

test('collects storage from the mobile homepage and pauses while its parent is hidden', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'mobile homepage shell');
    await page.clock.install();
    await page.addInitScript(() => window.addEventListener('pageshow', () => { window.mobilePageShown = true; }));
    let releaseImages;
    const imagesReady = new Promise(resolve => { releaseImages = resolve; });
    await page.route('**/portfolio/assets/portfolio-hero*.webp', async route => {
        await imagesReady;
        await route.continue().catch(() => {});
    });
    await page.route('**/portfolio/?view=mobile-homepage', async route => {
        const response = await route.fetch();
        await route.fulfill({ response, body: (await response.text()).replaceAll(apiBase, 'https://sync.test') });
    });
    await page.route('**/portfolio/sync-config.json', route => route.fulfill({ json: { apiBase: 'https://sync.test' } }));
    let requests = 0;
    await page.route('https://sync.test/v1/status', route => {
        requests++;
        return route.fulfill({ headers: { 'Access-Control-Allow-Origin': '*' }, json: {
            ok: true, checkedAt: Date.now(), database: { registry: { ok: true } },
            storage: { bytes: 2000000, storedBytes: 2000000, highWaterBytes: 4800000000, roomCount: 1, reservedBytes: 0 },
            maintenance: { phase: null, scannedRooms: null, lastSuccessAt: Date.now(), nextAlarmAt: null }
        } });
    });
    await page.route('https://sync.test/v1/usage', route => route.fulfill({ headers: { 'Access-Control-Allow-Origin': '*' },
        json: { status: 'not_configured', available: false, day: '2026-11-04', checkedAt: null, resetsAt: Date.now() + 86400000 } }));
    await page.goto('/');
    await page.locator('[data-mobile-enter]').click();
    const frame = page.frameLocator('#mobile-portfolio');
    await frame.locator('[data-start-toggle]').click();
    await frame.locator('[data-open-control-panel]').click();
    await frame.locator('[data-open-sync-storage]').click();
    expect(await frame.locator('body').evaluate(() => !!window.mobilePageShown)).toBe(false);
    releaseImages();
    await expect.poll(() => frame.locator('body').evaluate(() => !!window.mobilePageShown)).toBe(true);
    await expect(frame.locator('[data-control-panel-window]')).toHaveClass(/is-active/);
    await expect(frame.locator('[data-sync-storage-metrics]')).toContainText('0.002 GB / 4.800 GB');
    expect(requests).toBe(1);
    await frame.locator('[data-sync-storage-refresh]').click();
    await expect.poll(() => requests).toBe(2);
    await expect(frame.locator('[data-sync-storage-refresh]')).toBeEnabled();
    await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, value: true });
        document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.clock.runFor(1);
    await page.clock.fastForward('15:01');
    expect(requests).toBe(2);
    await page.evaluate(() => {
        delete document.hidden;
        document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect.poll(() => requests).toBe(3);
    await expect(frame.locator('[data-sync-storage-refresh]')).toBeEnabled();
    await page.clock.fastForward('15:01');
    await expect.poll(() => requests).toBe(4);
});
