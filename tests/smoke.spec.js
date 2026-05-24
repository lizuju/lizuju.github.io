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
    await expect(page.locator('h1')).toContainText('智能系统');
    await expect(page.locator('.project-card')).toHaveCount(3);
    await expect(page.locator('.project-media img')).toHaveCount(3);
    await expect(page.locator('.method-step')).toHaveCount(5);
    await expect(page.locator('.skill-card')).toHaveCount(7);
    await expect(page.locator('.brand')).toHaveAttribute('href', 'https://github.com/lizuju');
    await expect(page.locator('.brand')).toHaveAttribute('target', '_blank');
    await expect(page.locator('.award-columns > div')).toHaveCount(4);
    await expect(page.locator('body')).not.toContainText(/广州南方|南方学院|Nanfang College/);
    await expect(page.locator('body')).toContainText('语音机器人云端与设备协同');
    await expect(page.locator('body')).toContainText('2025 第十六届蓝桥杯人工智能大学组全国选拔赛二等奖');
    await expect(page.locator('.stack-strip li')).toHaveCount(0);
    await expect(page.locator('.stack-strip span')).toHaveCount(16);
    await expect(page.locator('.education-honors span')).toHaveCount(4);
    await expect(page.locator('.education-honors span').first()).toContainText('两届国家奖学金');
    await expect(page.locator('.education-honors')).toContainText('大学生年度人物');

    const noHorizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    expect(noHorizontalOverflow).toBe(true);
});

test('supports language toggle and mobile menu', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'mobile interaction coverage');

    await page.goto('/?qa=smoke-mobile#top');

    await page.locator('[data-lang-toggle]').click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('h1')).toContainText('Intelligent Systems');
    await expect(page.locator('.method-step')).toHaveCount(5);
    await expect(page.locator('.project-media img')).toHaveCount(3);
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

test('supports primary links and expandable details', async ({ page }) => {
    await page.goto('/?qa=smoke-interactions#top');

    await page.locator('.primary-action').click();
    await expect(page).toHaveURL(/#projects$/);

    await page.locator('.secondary-action').click();
    await expect(page).toHaveURL(/#contact$/);

    await page.locator('.site-footer a[href="#top"]').click();
    await expect(page).toHaveURL(/#top$/);
    await page.waitForFunction(() => window.scrollY < 10);

    await page.locator('.detail-drawer summary').click();
    await expect(page.locator('.detail-drawer')).toHaveAttribute('open', '');
    await expect(page.locator('.detail-drawer .feature-list li')).toHaveCount(7);

    await page.locator('.project-details summary').first().click();
    await expect(page.locator('.project-details').first()).toHaveAttribute('open', '');
});
