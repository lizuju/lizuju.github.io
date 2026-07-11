const { test, expect } = require('@playwright/test');

test.beforeEach(async ({ page }) => {
    const browserErrors = [];
    page.on('console', (message) => {
        if (message.type() === 'error') browserErrors.push(`console: ${message.text()}`);
    });
    page.on('pageerror', (error) => browserErrors.push(`pageerror: ${error.message}`));
    page.browserErrors = browserErrors;
    await page.addInitScript(() => localStorage.removeItem('portfolio-lang'));
});

test.afterEach(async ({ page }) => {
    expect(page.browserErrors).toEqual([]);
});

test('renders the complete bilingual portfolio without school name or overflow', async ({ page, request }) => {
    await page.goto('/portfolio/');

    await expect(page).toHaveTitle(/李祖钜 Gavin/);
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
    await expect(page.locator('.retro-desktop')).toBeVisible();
    await expect(page.locator('.window-titlebar')).toContainText('李祖钜 Gavin - 个人主页');
    await expect(page.locator('.desktop-taskbar')).toBeVisible();
    await expect(page.locator('.app-window')).toBeVisible();
    await expect(page.locator('h1')).toContainText('智能系统');
    await expect(page.locator('.project-card')).toHaveCount(5);
    await expect(page.locator('.project-media img')).toHaveCount(5);
    await expect(page.locator('.publication-card')).toHaveCount(2);
    await expect(page.locator('.method-step')).toHaveCount(5);
    await expect(page.locator('.skill-card')).toHaveCount(6);
    await expect(page.locator('.award-columns > div')).toHaveCount(4);
    await expect(page.locator('.education-honors span')).toHaveCount(6);
    await expect(page.locator('.education-honors')).toContainText('两届国家奖学金');
    await expect(page.locator('.education-honors')).toContainText('优秀毕业生');
    await expect(page.locator('body')).toContainText('TAAC 2026 腾讯广告算法大赛');
    await expect(page.locator('body')).toContainText('AAAI 2027 · CCF-A · Submitted');
    await expect(page.locator('body')).toContainText('Submission 3748');
    await expect(page.locator('body')).toContainText('IEEE Sensors Journal · Submitted');
    await expect(page.locator('body')).toContainText('Sensors-109949-2026');
    await expect(page.locator('body')).not.toContainText(/广州南方|南方学院|Nanfang College/);
    await expect(page.locator('.brand')).toHaveAttribute('href', 'https://github.com/lizuju');
    await expect(page.locator('.brand img')).toHaveAttribute('src', 'assets/avatar.png');

    await expect.poll(async () => page.locator('.brand img').evaluate((image) => image.complete && image.naturalWidth > 0)).toBe(true);
    const imageSources = await page.locator('img').evaluateAll((images) => [...new Set(images.map((image) => image.getAttribute('src')))]);
    for (const source of imageSources) {
        const response = await request.get(new URL(source, page.url()).href);
        expect(response.ok(), `image request failed: ${source}`).toBe(true);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test('supports language, navigation, and expandable details', async ({ page, isMobile }) => {
    await page.goto('/portfolio/');

    const appWindow = page.locator('[data-app-window]');
    await page.locator('[data-window-action="minimize"]').click();
    await expect(appWindow).toHaveClass(/is-minimized/);
    await page.locator('[data-task-window]').click();
    await expect(appWindow).not.toHaveClass(/is-minimized/);

    await page.locator('[data-window-action="maximize"]').click();
    await expect(appWindow).toHaveClass(/is-maximized/);
    await page.locator('[data-window-action="maximize"]').click();
    await expect(appWindow).not.toHaveClass(/is-maximized/);

    await page.locator('[data-start-toggle]').click();
    await expect(page.locator('[data-start-menu]')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-start-menu]')).toBeHidden();

    await page.locator('[data-lang-toggle]').click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('h1')).toContainText('Intelligent Systems');
    await expect(page.locator('.project-card')).toHaveCount(5);
    await expect(page.locator('.publication-card')).toHaveCount(2);

    await page.locator('[data-lang-toggle]').click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');

    await page.locator('.primary-action').click();
    await expect(page).toHaveURL(/#experience$/);
    await page.locator('.detail-drawer summary').click();
    await expect(page.locator('.detail-drawer')).toHaveAttribute('open', '');
    await expect(page.locator('.detail-drawer .feature-list li')).toHaveCount(5);

    await page.locator('.project-details summary').first().click();
    await expect(page.locator('.project-details').first()).toHaveAttribute('open', '');

    await page.locator('.window-controls [data-window-action="close"]').click();
    await expect(appWindow).toHaveClass(/is-closed/);
    await page.locator('[data-task-window]').click();
    await expect(appWindow).not.toHaveClass(/is-closed/);

    if (isMobile) {
        await page.locator('[data-menu-toggle]').click();
        await expect(page.locator('[data-menu-toggle]')).toHaveAttribute('aria-expanded', 'true');
        await expect(page.locator('[data-mobile-menu]')).toHaveClass(/active/);
        await page.locator('.mobile-menu a[href="#publications"]').click();
        await expect(page.locator('[data-menu-toggle]')).toHaveAttribute('aria-expanded', 'false');
        await expect(page).toHaveURL(/#publications$/);
    }

    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test('keeps the retro desktop fixed when returning to the top', async ({ page }) => {
    await page.goto('/portfolio/');

    const windowScroll = page.locator('[data-window-scroll]');
    const desktop = page.locator('[data-retro-desktop]');
    await windowScroll.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
    });
    await expect.poll(() => windowScroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);

    await page.locator('.site-footer a[href="#top"]').click();
    await expect(page).toHaveURL(/#top$/);
    await expect.poll(() => windowScroll.evaluate((element) => element.scrollTop)).toBe(0);

    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    expect(await desktop.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return rect.top === 0 && rect.bottom === window.innerHeight;
    })).toBe(true);
});

test('exposes crawlable SEO metadata', async ({ page, request, isMobile }) => {
    test.skip(isMobile, 'metadata only needs one browser pass');
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    await expect(page).toHaveTitle('李祖钜 Gavin | AI Agent、机器人与计算机视觉作品集');
    await expect(page.locator('meta[name="description"]')).toHaveAttribute('content', /李祖钜 Gavin.*AI Agent/);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'index,follow,max-image-preview:large');
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', 'https://lizuju.github.io/');
    await expect(page.locator('meta[property="og:image"]')).toHaveAttribute('content', 'https://lizuju.github.io/portfolio/assets/portfolio-hero.jpg');

    const schema = JSON.parse(await page.locator('script[type="application/ld+json"]').textContent());
    expect(schema['@type']).toBe('ProfilePage');
    expect(schema.mainEntity.name).toBe('李祖钜');
    expect(schema.mainEntity.sameAs).toContain('https://github.com/lizuju');

    const robots = await request.get('/robots.txt');
    expect(robots.ok()).toBe(true);
    expect(await robots.text()).toContain('Sitemap: https://lizuju.github.io/sitemap.xml');

    const sitemap = await request.get('/sitemap.xml');
    expect(sitemap.ok()).toBe(true);
    const sitemapText = await sitemap.text();
    expect(sitemapText).toContain('<loc>https://lizuju.github.io/</loc>');
    expect(sitemapText).toContain('<lastmod>2026-07-10</lastmod>');
});

test('serves the immersive desktop shell and lightweight mobile shell', async ({ page, isMobile }) => {
    test.setTimeout(60000);
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    if (isMobile) {
        await expect(page.locator('body')).toHaveClass(/mobile-mode/);
        await expect(page.locator('#mobile-portfolio')).toBeVisible();
        await expect(page.locator('canvas')).toHaveCount(0);
        await expect(page.frameLocator('#mobile-portfolio').locator('h1')).toContainText('智能系统');
        return;
    }

    await expect(page.locator('.direct-entry')).toBeVisible();
    await expect(page.locator('.direct-entry')).toHaveAttribute('href', 'portfolio/');
    await expect(page.locator('canvas').first()).toBeVisible({ timeout: 45000 });
    await expect(page.locator('#computer-screen')).toHaveAttribute('src', 'portfolio/', { timeout: 45000 });
    await expect(page.frameLocator('#computer-screen').locator('h1')).toContainText('智能系统', { timeout: 45000 });
    expect(await page.locator('canvas').first().evaluate((canvas) => canvas.width > 0 && canvas.height > 0)).toBe(true);

    await page.getByText('进入', { exact: true }).click();
    const viewport = page.viewportSize();
    await page.mouse.click(viewport.width / 2, viewport.height / 2);
    await page.waitForTimeout(2200);
    const screenBeforeFocus = await page.locator('#computer-screen').boundingBox();
    await page.mouse.move(
        screenBeforeFocus.x + screenBeforeFocus.width / 2,
        screenBeforeFocus.y + screenBeforeFocus.height / 2
    );
    await expect.poll(async () => (await page.locator('#computer-screen').boundingBox()).width, {
        timeout: 10000
    }).toBeGreaterThan(screenBeforeFocus.width * 1.5);

    const computerFrame = page.frameLocator('#computer-screen');
    const windowScroll = computerFrame.locator('[data-window-scroll]');
    await windowScroll.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
    });
    await computerFrame.locator('.site-footer a[href="#top"]').click();
    await expect.poll(() => windowScroll.evaluate((element) => element.scrollTop)).toBe(0);
    expect(await computerFrame.locator('[data-retro-desktop]').evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return window.scrollY === 0 && rect.top === 0 && rect.bottom === window.innerHeight;
    })).toBe(true);
});
