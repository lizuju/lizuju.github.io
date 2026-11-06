const { test, expect } = require('@playwright/test');

test.beforeEach(async ({ isMobile }) => {
    test.skip(isMobile, 'the immersive startup layer is desktop only');
    test.setTimeout(60000);
});

test('keeps loading and ready focus above the scene, then restores scene navigation', async ({ page }) => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    await page.route('**/models/World/environment.glb', async route => {
        await gate;
        await route.continue();
    });
    try {
        await page.goto('/', { waitUntil: 'domcontentloaded' });
        const dialog = page.getByRole('dialog', { name: '启动沉浸式场景 / Start immersive scene' });
        await expect(dialog).toBeFocused();
        await expect(page.locator('#css')).toHaveAttribute('inert', '');
        for (const key of ['Tab', 'Shift+Tab']) {
            await page.keyboard.press(key);
            await expect(dialog).toBeFocused();
        }
        release();
        const enter = page.locator('[data-start-scene]');
        await expect(enter).toBeFocused({ timeout: 30000 });
        await expect(page.locator('#computer-screen')).toBeAttached();
        for (const key of ['Tab', 'Shift+Tab']) {
            await page.keyboard.press(key);
            await expect(enter).toBeFocused();
        }
        await page.keyboard.press('Enter');
        await expect(page.locator('#css')).not.toHaveAttribute('inert', '');
        await expect(page.locator('.direct-entry')).toBeFocused();
        await expect(page.getByRole('dialog')).toHaveCount(0);
    } finally { release(); }
});

test('focuses retry on startup failure and restores the normal Enter flow after retrying', async ({ page }) => {
    let fail = true;
    await page.route('**/models/World/environment.glb', route => fail
        ? route.fulfill({ contentType: 'model/gltf-binary', body: 'invalid glb' }) : route.continue());
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    const retry = page.locator('[data-resource-retry]');
    await expect(retry).toBeFocused({ timeout: 20000 });
    for (const key of ['Tab', 'Shift+Tab']) {
        await page.keyboard.press(key);
        await expect(retry).toBeFocused();
    }
    fail = false;
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-start-scene]')).toBeFocused({ timeout: 30000 });
    await page.keyboard.press('Enter');
    await expect(page.locator('#css')).not.toHaveAttribute('inert', '');
});

test('approaches the monitor for keyboard focus and returns when focus leaves the desktop', async ({ page, browserName }) => {
    await page.goto('/');
    await expect(page.locator('[data-start-scene]')).toBeFocused({ timeout: 30000 });
    await page.keyboard.press('Enter');
    await expect(page.locator('.direct-entry')).toBeFocused();
    await page.keyboard.press(browserName === 'webkit' ? 'Alt+Tab' : 'Tab');
    const home = page.frameLocator('#computer-screen').locator('.desktop-shortcut[data-open-window]');
    await expect(home).toBeFocused();
    const monitor = page.locator('#computer-screen');
    await expect.poll(async () => (await monitor.boundingBox()).width, { timeout: 10000 }).toBeGreaterThan(500);
    const enteredWidth = (await monitor.boundingBox()).width;
    await page.keyboard.press(browserName === 'webkit' ? 'Alt+Shift+Tab' : 'Shift+Tab');
    await expect(page.locator('.direct-entry')).toBeFocused();
    await expect.poll(async () => (await monitor.boundingBox()).width, { timeout: 10000 }).toBeLessThan(enteredWidth * 0.8);
});

test('honors reduced motion at startup and when the preference changes during the scene', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    await expect(page.locator('[data-start-scene]')).toBeFocused({ timeout: 30000 });
    await page.keyboard.press('Enter');
    const monitor = page.locator('#computer-screen');
    await expect(monitor).toHaveCSS('animation-name', 'none');
    await expect.poll(() => page.locator('#video-1, #video-2').evaluateAll(videos => videos.every(video => video.paused))).toBe(true);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const transform = await monitor.evaluate(element => element.parentElement.parentElement.style.transform);
    await page.waitForTimeout(250);
    expect(await monitor.evaluate(element => element.parentElement.parentElement.style.transform)).toBe(transform);

    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await expect(monitor).toHaveCSS('animation-name', 'jittery');
    await expect.poll(() => page.locator('#video-1, #video-2').evaluateAll(videos => videos.every(video => !video.paused))).toBe(true);
    await expect.poll(() => monitor.evaluate(element => element.parentElement.parentElement.style.transform)).not.toBe(transform);

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(monitor).toHaveCSS('animation-name', 'none');
    await expect.poll(() => page.locator('#video-1, #video-2').evaluateAll(videos => videos.every(video => video.paused))).toBe(true);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const stopped = await monitor.evaluate(element => element.parentElement.parentElement.style.transform);
    await page.waitForTimeout(250);
    expect(await monitor.evaluate(element => element.parentElement.parentElement.style.transform)).toBe(stopped);
});
