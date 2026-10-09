const { test, expect } = require('@playwright/test');

const satelliteRecords = [{
    OBJECT_NAME: 'ISS (ZARYA)',
    OBJECT_ID: '1998-067A',
    NORAD_CAT_ID: 25544,
    EPOCH: new Date().toISOString(),
    MEAN_MOTION: 15.49,
    ECCENTRICITY: 0.0005,
    INCLINATION: 51.64,
    RA_OF_ASC_NODE: 100,
    ARG_OF_PERICENTER: 20,
    MEAN_ANOMALY: 340
}];

test('keeps a loaded satellite window ready after minimizing and reopening', async ({ page, isMobile }) => {
    test.skip(isMobile, 'satellite windows are only available in the desktop layout');
    let requests = 0;
    await page.route('https://celestrak.org/**', (route) => {
        requests += 1;
        return route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify(satelliteRecords)
        });
    });
    await page.goto('/portfolio/');
    const satelliteWindow = page.locator('[data-satellite-window]');
    const status = page.locator('[data-satellite-status]');
    const loading = page.locator('[data-satellite-loading]');
    await page.locator('[data-window-action="minimize"]').click();
    await page.locator('.desktop-shortcut[data-open-satellite]').click();
    await expect(status).toHaveText('实时推算运行中');
    await expect(loading).toBeHidden();

    await satelliteWindow.locator('[data-satellite-action="minimize"]').click();
    await page.locator('[data-satellite-task]').click();
    await expect(status).toHaveText('实时推算运行中');
    await expect(loading).toBeHidden();

    await page.locator('[data-taskbar-lang]').click();
    await expect(status).toHaveText('Live propagation running');
    await satelliteWindow.locator('[data-satellite-action="close"]').click();
    await page.locator('.desktop-shortcut[data-open-satellite]').click();
    await expect(status).toHaveText('Live propagation running');
    await expect(loading).toBeHidden();
    expect(requests).toBe(1);
});

test('preserves loading and failure translations and retries on satellite reopen', async ({ page, isMobile }) => {
    test.skip(isMobile, 'satellite windows are only available in the desktop layout');
    let firstRoute;
    let requests = 0;
    await page.route('https://celestrak.org/**', (route) => {
        requests += 1;
        if (requests === 1) {
            firstRoute = route;
            return;
        }
        return route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify(satelliteRecords)
        });
    });
    await page.goto('/portfolio/');
    const satelliteWindow = page.locator('[data-satellite-window]');
    const status = page.locator('[data-satellite-status]');
    const loading = page.locator('[data-satellite-loading]');
    await page.locator('[data-window-action="minimize"]').click();
    await page.locator('.desktop-shortcut[data-open-satellite]').click();
    await expect.poll(() => Boolean(firstRoute)).toBe(true);
    await satelliteWindow.locator('[data-satellite-action="minimize"]').click();
    await page.locator('[data-satellite-task]').click();
    await expect(loading).toBeVisible();
    await page.locator('[data-taskbar-lang]').click();
    await expect(status).toHaveAttribute('data-i18n', 'satelliteLoading');
    await expect(status).toHaveText(await page.evaluate(() => window.PORTFOLIO_DATA.CONTENT.en.satelliteLoading));
    expect(requests).toBe(1);

    await firstRoute.fulfill({ status: 503, body: 'Unavailable' });
    await expect(status).toHaveText('Unable to load orbital data. Please try again later.');
    await page.locator('[data-taskbar-lang]').click();
    await expect(status).toHaveText('无法载入轨道数据，请稍后重试。');
    await expect(loading.locator('strong')).toHaveText('无法载入轨道数据，请稍后重试。');

    await satelliteWindow.locator('[data-satellite-action="close"]').click();
    await page.locator('.desktop-shortcut[data-open-satellite]').click();
    await expect(status).toHaveText('实时推算运行中');
    await expect(loading).toBeHidden();
    expect(requests).toBe(2);
});
