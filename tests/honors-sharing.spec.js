const { test, expect } = require('@playwright/test');

test.use({ serviceWorkers: 'block' });

for (const stage of ['headers', 'body']) test(`a stalled honors ${stage} request times out and can be retried after reopening`, async ({ page }) => {
    await page.clock.install();
    await page.addInitScript(stage => {
        const original = window.fetch.bind(window);
        window.honorsRequests = 0;
        window.fetch = (url, options) => {
            if (!String(url).endsWith('/certificates.json') || ++window.honorsRequests > 1) return original(url, options);
            const { signal } = options;
            if (stage === 'headers') return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
            return Promise.resolve(new Response(new ReadableStream({ start(controller) {
                controller.enqueue(new TextEncoder().encode('['));
                signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
            } })));
        };
    }, stage);
    await page.goto('/portfolio/');
    if (await page.locator('[data-window-action="minimize"]').isVisible()) await page.locator('[data-window-action="minimize"]').click();
    const open = async () => {
        await page.locator('.desktop-shortcut[data-open-project-folder]').click();
        await page.locator('[data-folder="honors"]').click();
    };
    await open();
    await expect.poll(() => page.evaluate(() => window.honorsRequests)).toBe(1);
    await page.locator('[data-project-folder-action="close"]').click();
    await open();
    expect(await page.evaluate(() => window.honorsRequests)).toBe(1);
    await page.clock.fastForward(15001);
    const retry = page.locator('[data-honors-retry]');
    await expect(retry).toBeVisible();
    await retry.click();
    await expect(page.locator('[data-honor-image]')).toHaveCount(35);
    await expect(retry).toBeHidden();
    expect(await page.evaluate(() => window.honorsRequests)).toBe(2);
});

test('categories combine with search, translate and survive reload', async ({ page }) => {
    await page.goto('/honors/');
    const category = page.locator('[data-honors-category]');
    const search = page.locator('[data-project-folder-search]');
    const visible = page.locator('[data-honor-image]:visible');
    await expect(visible).toHaveCount(35);
    await category.selectOption('modeling');
    await expect(visible).toHaveCount(5);
    await search.fill('APMCM');
    await expect(visible).toHaveCount(1);
    await page.locator('[data-taskbar-lang]').click();
    await expect(category).toHaveAttribute('aria-label', 'Certificate category');
    await expect(category.locator('option:checked')).toHaveText('Mathematical modeling');
    await expect(visible).toHaveCount(1);
    await page.reload();
    await expect(category).toHaveValue('modeling');
    await expect(search).toHaveValue('APMCM');
    await expect(visible).toHaveCount(1);
    await category.selectOption('robotics');
    await expect(page.locator('[data-project-folder-empty]')).toBeVisible();
    await search.fill('');
    await expect(visible).toHaveCount(6);
    await category.selectOption('');
    await expect(visible).toHaveCount(35);
});

test('copying a certificate opens that image regardless of saved filters and language', async ({ page }) => {
    await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: async text => { window.copiedCertificate = text; } }
    }));
    await page.goto('/honors/');
    await expect(page.locator('[data-honor-image]')).toHaveCount(35);
    await page.locator('[data-honors-category]').selectOption('modeling');
    await page.locator('[data-honor-image="certificate-16"]').click();
    await page.locator('[data-image-share]').click();
    await expect(page.locator('[data-image-share]')).toHaveText('链接已复制');
    const shared = await page.evaluate(() => window.copiedCertificate);
    expect(new URL(shared).pathname).toBe('/honors/');
    expect(new URL(shared).searchParams.get('certificate')).toBe('certificate-16');
    await page.locator('[data-image-preview-action="close"]').click();
    await page.locator('[data-honors-category]').selectOption('robotics');
    await page.locator('[data-project-folder-search]').fill('2023');
    await page.goto(shared);
    await expect(page.locator('[data-image-preview-window]')).toBeVisible();
    await expect(page.locator('[data-image-preview-caption]')).toContainText('APMCM');
    await expect(page.locator('[data-honors-category]')).toHaveValue('');
    await expect(page.locator('[data-project-folder-search]')).toHaveValue('');
    await expect.poll(() => page.locator('[data-image-preview-image]').evaluate(image => image.naturalWidth)).toBeGreaterThan(0);
    await page.locator('[data-image-next]').click();
    await expect(page).toHaveURL(/certificate=certificate-15/);
    await page.reload();
    await expect(page.locator('[data-image-preview-caption]')).toContainText('华数杯');
    await page.locator('[data-image-preview-action="close"]').click();
    await expect(page).toHaveURL(/\/honors\/$/);
});

test('a denied clipboard exposes the selectable share URL and an unknown link keeps the gallery usable', async ({ page }) => {
    await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: async () => { throw new DOMException('Denied', 'NotAllowedError'); } }
    }));
    await page.goto('/honors/?certificate=certificate-24');
    await expect(page.locator('[data-image-preview-window]')).toBeVisible();
    await page.locator('[data-image-share]').click();
    const url = page.locator('[data-image-share-url]');
    await expect(url).toBeVisible();
    await expect(url).toHaveValue(/\/honors\/\?certificate=certificate-24$/);
    await expect(url).toBeFocused();
    expect(await url.evaluate(input => input.selectionEnd - input.selectionStart)).toBe((await url.inputValue()).length);
    await page.goto('/honors/?certificate=unknown');
    await expect(page.locator('[data-honor-image]:visible')).toHaveCount(35);
    await expect(page.locator('[data-image-preview-window]')).toBeHidden();
    await expect(page.locator('[data-project-folder-status]')).toHaveText('未找到该奖状，请从列表中选择。');
    await page.locator('[data-honor-image]').first().click();
    await expect(page.locator('[data-image-preview-window]')).toBeVisible();
});

test('arrow navigation keeps the selected certificate inside the scroll viewport', async ({ page }) => {
    await page.goto('/honors/');
    await expect(page.locator('[data-honor-image]')).toHaveCount(35);
    await page.locator('[data-honor-image]').first().focus();
    for (let i = 0; i < 20; i++) await page.keyboard.press('ArrowDown');
    const result = await page.evaluate(() => {
        const scroll = document.querySelector('.project-folder-scroll');
        const bounds = scroll.getBoundingClientRect();
        const selected = document.activeElement.getBoundingClientRect();
        return { scrollTop: scroll.scrollTop, top: selected.top, bottom: selected.bottom, viewportTop: bounds.top, viewportBottom: bounds.bottom };
    });
    expect(result.scrollTop).toBeGreaterThan(0);
    expect(result.top).toBeGreaterThanOrEqual(result.viewportTop);
    expect(result.bottom).toBeLessThanOrEqual(result.viewportBottom);
});

test('desktop honors reuse categories and share the standalone link', async ({ page }) => {
    await page.goto('/portfolio/');
    if (await page.locator('[data-window-action="minimize"]').isVisible()) await page.locator('[data-window-action="minimize"]').click();
    await page.locator('.desktop-shortcut[data-open-project-folder]').click();
    await expect(page.locator('[data-honors-category]')).toBeHidden();
    await page.locator('[data-folder="honors"]').click();
    await page.locator('[data-honors-category]').selectOption('academic');
    await expect(page.locator('[data-honor-image]:visible')).toHaveCount(5);
    await page.locator('[data-honor-image="certificate-22"]').click();
    await expect(page.locator('[data-image-share]')).toBeVisible();
    await expect(page.locator('[data-image-share-url]')).toHaveValue(/\/honors\/\?certificate=certificate-22$/);
    await expect(page).toHaveURL(/\/portfolio\/$/);
});
