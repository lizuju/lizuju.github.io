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
    await expect(page.locator('.project-card')).toHaveCount(4);
    await expect(page.locator('.project-media img')).toHaveCount(4);
    await expect(page.locator('.project-media img').nth(0)).toHaveAttribute('src', 'assets/project-resume-agent.jpg');
    await expect(page.locator('.project-media img').nth(2)).toHaveAttribute('src', 'assets/project-taac-recommender.jpg');
    await expect(page.locator('.method-step')).toHaveCount(5);
    await expect(page.locator('.skill-card')).toHaveCount(5);
    await expect(page.locator('.brand')).toHaveAttribute('href', 'https://github.com/lizuju');
    await expect(page.locator('.brand')).toHaveAttribute('target', '_blank');
    await expect(page.locator('.award-columns > div')).toHaveCount(4);
    await expect(page.locator('body')).not.toContainText(/广州南方|南方学院|Nanfang College/);
    await expect(page.locator('body')).toContainText('Agent 产品与推荐算法项目迭代');
    await expect(page.locator('body')).toContainText('AI Agent 简历生成与优化平台');
    await expect(page.locator('body')).toContainText('TAAC 2026 腾讯广告算法大赛');
    await expect(page.locator('body')).toContainText('2025 第十六届蓝桥杯人工智能大学组全国选拔赛二等奖');
    await expect(page.locator('.stack-strip li')).toHaveCount(0);
    await expect(page.locator('.stack-strip span')).toHaveCount(14);
    await expect(page.locator('.education-honors span')).toHaveCount(5);
    await expect(page.locator('.education-honors span').first()).toContainText('两届国家奖学金');
    await expect(page.locator('.education-honors')).toContainText('大学生年度人物');

    const noHorizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    expect(noHorizontalOverflow).toBe(true);

    const mobileSystemMapIsSeparated = await page.evaluate(() => {
        if (window.innerWidth > 640) return true;
        const item = document.querySelector('.system-map div:nth-child(2)');
        const number = item?.querySelector('span');
        const title = item?.querySelector('strong');
        if (!number || !title) return false;
        return number.getBoundingClientRect().right < title.getBoundingClientRect().left
            && getComputedStyle(title).position === 'static';
    });
    expect(mobileSystemMapIsSeparated).toBe(true);
});

test('exposes crawlable SEO metadata', async ({ page, request }) => {
    await page.goto('/?qa=seo-smoke#top');

    await expect(page).toHaveTitle('李祖钜 Gavin | AI Agent、机器人与计算机视觉作品集');
    await expect(page.locator('meta[name="description"]')).toHaveAttribute('content', /Gavin Lizuju/);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'index,follow,max-image-preview:large');
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', 'https://lizuju.github.io/');
    await expect(page.locator('meta[property="og:image"]')).toHaveAttribute('content', 'https://lizuju.github.io/assets/portfolio-hero.jpg');

    const schema = await page.locator('script[type="application/ld+json"]').textContent();
    const parsedSchema = JSON.parse(schema);
    expect(parsedSchema['@type']).toBe('ProfilePage');
    expect(parsedSchema.mainEntity.name).toBe('李祖钜');
    expect(parsedSchema.mainEntity.sameAs).toContain('https://github.com/lizuju');

    const robots = await request.get('/robots.txt');
    expect(robots.ok()).toBe(true);
    expect(await robots.text()).toContain('Sitemap: https://lizuju.github.io/sitemap.xml');

    const sitemap = await request.get('/sitemap.xml');
    expect(sitemap.ok()).toBe(true);
    const sitemapText = await sitemap.text();
    expect(sitemapText).toContain('<loc>https://lizuju.github.io/</loc>');
    expect(sitemapText).toContain('<lastmod>2026-06-22</lastmod>');
});

test('supports language toggle and mobile menu', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'mobile interaction coverage');

    await page.goto('/?qa=smoke-mobile#top');

    await page.locator('[data-lang-toggle]').click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('h1')).toContainText('Intelligent Systems');
    await expect(page.locator('.method-step')).toHaveCount(5);
    await expect(page.locator('.project-media img')).toHaveCount(4);
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
    await expect(page).toHaveURL(/#experience$/);

    await page.locator('.secondary-action').click();
    await expect(page).toHaveURL(/#contact$/);

    await page.locator('.site-footer a[href="#top"]').click();
    await expect(page).toHaveURL(/#top$/);
    await page.waitForFunction(() => window.scrollY < 10);

    await page.locator('.detail-drawer summary').click();
    await expect(page.locator('.detail-drawer')).toHaveAttribute('open', '');
    await expect(page.locator('.detail-drawer .feature-list li')).toHaveCount(5);

    await page.locator('.project-details summary').first().click();
    await expect(page.locator('.project-details').first()).toHaveAttribute('open', '');
});
