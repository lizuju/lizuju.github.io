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
