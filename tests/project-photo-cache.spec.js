const { test, expect } = require('@playwright/test');

test.use({ serviceWorkers: 'block' });

test('photo switching shows the selected thumbnail, cancels obsolete work and reuses recent full images', async ({ page }) => {
    await page.goto('/honors/');
    const photos = page.locator('[data-honor-image]');
    await expect(photos).toHaveCount(35);
    const sources = await photos.evaluateAll(items => items.map(item => item.dataset.imageSrc));
    const waiting = new Map();
    const requests = new Map();
    const cancelled = new Set();
    page.on('requestfailed', request => cancelled.add(request.url()));
    await page.route('**/honors/*.webp', route => {
        const source = route.request().url();
        if (!sources.includes(source)) return route.continue();
        requests.set(source, (requests.get(source) || 0) + 1);
        waiting.set(source, route);
    });
    const select = async index => {
        if (await page.locator('[data-image-preview-window]').isVisible()) {
            await page.locator('[data-image-preview-action="close"]').click();
        }
        await photos.nth(index).click();
    };
    const expectThumbnail = async index => {
        await expect.poll(() => page.evaluate(index => {
            const thumbnail = document.querySelectorAll('[data-honor-image]')[index].querySelector('img');
            const image = document.querySelector('[data-image-preview-image]');
            return image.currentSrc === thumbnail.currentSrc && image.naturalWidth > 0
                && getComputedStyle(image).visibility === 'visible';
        }, index)).toBe(true);
        await expect(page.locator('[data-image-loading]')).toBeVisible();
        await expect.poll(() => waiting.has(sources[index])).toBe(true);
    };
    const expectLoaded = async () => {
        await expect(page.locator('[data-image-loading]')).toBeHidden();
        await expect(page.locator('[data-image-error]')).toBeHidden();
        await expect.poll(() => page.locator('[data-image-preview-image]').evaluate(image => image.currentSrc)).toMatch(/^blob:/);
    };

    await select(0);
    await expectThumbnail(0);
    await waiting.get(sources[0]).continue();
    await expectLoaded();
    const firstBlob = await page.locator('[data-image-preview-image]').evaluate(image => image.currentSrc);
    await expect.poll(() => waiting.has(sources[1])).toBe(true);

    await select(10);
    await expectThumbnail(10);
    await select(20);
    await expectThumbnail(20);
    await waiting.get(sources[20]).continue();
    await expectLoaded();
    await expect.poll(() => cancelled.has(sources[1]) && cancelled.has(sources[10])).toBe(true);
    await waiting.get(sources[1]).continue().catch(() => {});
    await waiting.get(sources[10]).continue().catch(() => {});

    await select(0);
    await expectLoaded();
    await expect.poll(() => page.locator('[data-image-preview-image]').evaluate(image => image.currentSrc)).toBe(firstBlob);
    expect(requests.get(sources[0])).toBe(1);
    await expect(page.locator('[data-image-counter]')).toHaveText('1 / 35');
    await page.unrouteAll({ behavior: 'ignoreErrors' });
});
