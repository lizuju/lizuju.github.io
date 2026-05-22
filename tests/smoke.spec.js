const { test, expect } = require('@playwright/test');

test.beforeEach(async ({ page }) => {
    const browserErrors = [];
    page.on('console', (message) => {
        if (['error', 'warning'].includes(message.type())) {
            browserErrors.push(`${message.type()}: ${message.text()}`);
        }
    });
    page.on('pageerror', (error) => browserErrors.push(`pageerror: ${error.message}`));
    page.browserErrors = browserErrors;
});

test.afterEach(async ({ page }) => {
    expect(page.browserErrors).toEqual([]);
});

test('renders portfolio content without school name or overflow', async ({ page }) => {
    await page.goto('/?qa=smoke-desktop#top');

    await expect(page).toHaveTitle(/李祖钜 Gavin|Gavin Lizuju/);
    await expect(page.locator('h1')).toContainText('AI Agent');
    await expect(page.locator('.project-card')).toHaveCount(3);
    await expect(page.locator('.skill-card')).toHaveCount(7);
    await expect(page.locator('.award-columns > div')).toHaveCount(4);
    await expect(page.locator('body')).not.toContainText(/广州南方|南方学院|Nanfang College/);
    await expect(page.locator('body')).toContainText('声纹注册与识别链路开发');
    await expect(page.locator('body')).toContainText('2025 第十六届蓝桥杯人工智能大学组全国选拔赛二等奖');

    const noHorizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    expect(noHorizontalOverflow).toBe(true);
});

test('supports language toggle and mobile menu', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'mobile interaction coverage');

    await page.goto('/?qa=smoke-mobile#top');

    await page.locator('[data-lang-toggle]').click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('h1')).toContainText('Vision Systems');
    await expect(page.locator('body')).not.toContainText(/广州南方|南方学院|Nanfang College/);

    await page.locator('[data-lang-toggle]').click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');

    await page.locator('[data-menu-toggle]').click();
    await expect(page.locator('[data-menu-toggle]')).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('[data-mobile-menu]')).toHaveClass(/active/);

    await page.locator('.mobile-menu a[href="#projects"]').click();
    await expect(page.locator('[data-menu-toggle]')).toHaveAttribute('aria-expanded', 'false');
    await expect(page).toHaveURL(/#projects$/);

    const noHorizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    expect(noHorizontalOverflow).toBe(true);
});
