const { test, expect } = require('./fixtures/smoke.cjs');

const path = require('path');
const { createBuildMetadata } = require('../bundler/build-metadata');
const buildMetadata = createBuildMetadata(path.resolve(__dirname, '..'));

test('renders the complete bilingual portfolio without school name or overflow', async ({ page, request }) => {
    await page.goto('/portfolio/');

    await expect(page).toHaveTitle(/李祖钜 Gavin/);
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
    await expect(page.locator('.retro-desktop')).toBeVisible();
    await expect(page.locator('[data-direct-return]')).toBeVisible();
    await expect(page.locator('[data-direct-return]')).toHaveAttribute('href', '../');
    await expect(page.locator('[data-direct-return]')).toHaveClass(/scene-link/);
    await expect(page.locator('[data-direct-return]')).toHaveText('返回沉浸式场景 / Back to immersive scene');
    await expect(page.locator('.desktop-taskbar [data-direct-return]')).toHaveCount(0);
    await expect(page.locator('[data-window-drag]')).toContainText('李祖钜 Gavin - 个人主页');
    await expect(page.locator('.desktop-taskbar')).toBeVisible();
    await expect(page.locator('[data-app-window]')).toBeVisible();
    await expect(page.locator('h1')).toContainText('智能系统');
    await expect(page.locator('.experience-row')).toHaveCount(2);
    await expect(page.locator('.detail-drawer')).toHaveCount(2);
    await expect(page.locator('.project-card')).toHaveCount(5);
    await expect(page.locator('.project-media img')).toHaveCount(5);
    await expect(page.locator('.project-media img').nth(0)).toHaveAttribute('src', 'assets/project-robomaster-autoaim.jpg');
    await expect(page.locator('.project-media img').nth(1)).toHaveAttribute('src', 'assets/project-robomaster-navigation.jpg');
    await expect(page.locator('.project-media img').nth(4)).toHaveAttribute('src', 'assets/project-inventory.jpg');
    await expect(page.locator('.publication-card')).toHaveCount(2);
    await expect(page.locator('.method-step')).toHaveCount(5);
    await expect(page.locator('.skill-card')).toHaveCount(5);
    await expect(page.locator('.award-columns > div')).toHaveCount(4);
    await expect(page.locator('.education-honors span')).toHaveCount(6);
    await expect(page.locator('.education-honors')).toContainText('两届国家奖学金');
    await expect(page.locator('.education-honors')).toContainText('优秀毕业生');
    await expect(page.locator('body')).toContainText('TAAC 2026 腾讯广告算法大赛');
    await expect(page.locator('body')).toContainText('ROS 2 机器人导航开发');
    await expect(page.locator('body')).toContainText('Stemm 家庭陪护机器人');
    await expect(page.locator('body')).toContainText('RoboMaster 机器人自瞄系统');
    await expect(page.locator('body')).toContainText('RoboMaster 机器人自主导航');
    await expect(page.locator('body')).toContainText('算法核心开发');
    await expect(page.locator('body')).not.toContainText('AI Agent 简历生成与优化平台');
    await expect(page.locator('body')).toContainText('AAAI 2027 · CCF-A · Submitted');
    await expect(page.locator('body')).toContainText('Submission 3748');
    await expect(page.locator('body')).toContainText('IEEE Sensors Journal · Submitted');
    await expect(page.locator('body')).toContainText('Sensors-109949-2026');
    await expect(page.locator('body')).not.toContainText(/广州南方|南方学院|Nanfang College/);
    await expect(page.locator('.brand')).toHaveAttribute('href', 'https://github.com/lizuju');
    await expect(page.locator('.brand img')).toHaveAttribute('src', 'assets/avatar.png');
    expect(await page.evaluate(() => ({
        languages: window.PORTFOLIO_DATA.SUPPORTED_LANGS,
        chineseProjects: window.PORTFOLIO_DATA.CONTENT['zh-CN'].projects.length,
        englishProjects: window.PORTFOLIO_DATA.CONTENT.en.projects.length,
    }))).toEqual({
        languages: ['zh-CN', 'en'],
        chineseProjects: 5,
        englishProjects: 5,
    });

    await expect.poll(async () => page.locator('.brand img').evaluate((image) => image.complete && image.naturalWidth > 0)).toBe(true);
    const imageSources = await page.locator('img').evaluateAll((images) => [...new Set(images
        .map((image) => image.getAttribute('src'))
        .filter(Boolean))]);
    for (const source of imageSources) {
        const response = await request.get(new URL(source, page.url()).href);
        expect(response.ok(), `image request failed: ${source}`).toBe(true);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test('supports language, navigation, and expandable details', async ({ page, isMobile }) => {
    if (!isMobile) await page.setViewportSize({ width: 983, height: 754 });
    await page.goto('/portfolio/');

    const appWindow = page.locator('[data-app-window]');
    const languageButton = page.locator('[data-lang-toggle]');
    const taskbarLanguageButton = page.locator('[data-taskbar-lang]');
    if (!isMobile) {
        await expect(appWindow).toHaveClass(/is-maximized/);
        await page.locator('[data-window-action="maximize"]').click();
        await expect(appWindow).not.toHaveClass(/is-maximized/);
    }
    await expect(languageButton).toBeVisible();
    await expect(taskbarLanguageButton).toBeVisible();
    await expect(taskbarLanguageButton).toHaveText('EN');
    expect(await page.locator('[data-window-scroll]').evaluate((viewport, button) => {
        const viewportRect = viewport.getBoundingClientRect();
        const buttonRect = button.getBoundingClientRect();
        return buttonRect.top >= viewportRect.top && buttonRect.bottom <= viewportRect.bottom;
    }, await languageButton.elementHandle())).toBe(true);

    await page.locator('[data-window-action="minimize"]').click();
    await expect(appWindow).toHaveClass(/is-minimized/);
    await expect(page.locator('[data-task-window]')).toBeVisible();
    await page.locator('[data-task-window]').click();
    await expect(appWindow).not.toHaveClass(/is-minimized/);

    if (!isMobile) {
        const windowBeforeDrag = await appWindow.boundingBox();
        const titlebar = await page.locator('[data-window-drag]').boundingBox();
        await page.mouse.move(titlebar.x + 240, titlebar.y + titlebar.height / 2);
        await page.mouse.down();
        await page.mouse.move(titlebar.x + 195, titlebar.y - 4, { steps: 4 });
        await page.mouse.up();
        const windowAfterDrag = await appWindow.boundingBox();
        expect(windowAfterDrag.x).toBeLessThan(windowBeforeDrag.x - 20);
        expect(windowAfterDrag.y).toBeLessThan(windowBeforeDrag.y - 10);

        const windowBeforeResize = await appWindow.boundingBox();
        const resizeHandle = await page.locator('[data-window-resize]').boundingBox();
        await page.mouse.move(resizeHandle.x + resizeHandle.width / 2, resizeHandle.y + resizeHandle.height / 2);
        await page.mouse.down();
        await page.mouse.move(resizeHandle.x - 80, resizeHandle.y - 55, { steps: 4 });
        await page.mouse.up();
        const windowAfterResize = await appWindow.boundingBox();
        expect(windowAfterResize.width).toBeLessThan(windowBeforeResize.width - 50);
        expect(windowAfterResize.height).toBeLessThan(windowBeforeResize.height - 30);

        await page.locator('[data-window-action="maximize"]').click();
        await expect(appWindow).toHaveClass(/is-maximized/);
        await page.locator('[data-window-action="maximize"]').click();
        await expect(appWindow).not.toHaveClass(/is-maximized/);
        const restoredWindow = await appWindow.boundingBox();
        expect(Math.abs(restoredWindow.x - windowAfterResize.x)).toBeLessThan(2);
        expect(Math.abs(restoredWindow.y - windowAfterResize.y)).toBeLessThan(2);
        expect(Math.abs(restoredWindow.width - windowAfterResize.width)).toBeLessThan(2);
        expect(Math.abs(restoredWindow.height - windowAfterResize.height)).toBeLessThan(2);
    }

    await page.locator('[data-start-toggle]').click();
    const startMenu = page.locator('[data-start-menu]');
    await expect(startMenu).toBeVisible();
    await expect(startMenu.locator('[data-shutdown]')).toBeVisible();
    await expect(startMenu.locator('a, [data-open-window], [data-open-gomoku]')).toHaveCount(0);
    await expect(startMenu.locator('[data-start-lang]')).toHaveCount(0);
    await expect(startMenu).toContainText('关闭计算机');
    const startMenuBox = await startMenu.boundingBox();
    expect(startMenuBox.height).toBeGreaterThanOrEqual(220);
    await page.keyboard.press('Escape');
    await expect(startMenu).toBeHidden();

    await taskbarLanguageButton.click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(taskbarLanguageButton).toHaveText('中');
    await expect(languageButton).toHaveText('中文');
    await expect(page.locator('h1')).toContainText('Intelligent Systems');
    await expect(page.locator('.project-card')).toHaveCount(5);
    await expect(page.locator('.publication-card')).toHaveCount(2);

    await languageButton.click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
    await expect(taskbarLanguageButton).toHaveText('EN');

    await page.locator('.primary-action').click();
    await expect(page).toHaveURL(/#experience$/);
    const experienceDrawers = page.locator('.detail-drawer');
    await experienceDrawers.nth(0).locator('summary').click();
    await expect(experienceDrawers.nth(0)).toHaveAttribute('open', '');
    await expect(experienceDrawers.nth(0).locator('.feature-list li')).toHaveCount(4);
    await experienceDrawers.nth(1).locator('summary').click();
    await expect(experienceDrawers.nth(1)).toHaveAttribute('open', '');
    await expect(experienceDrawers.nth(1).locator('.feature-list li')).toHaveCount(4);

    await page.locator('.project-details summary').first().click();
    await expect(page.locator('.project-details').first()).toHaveAttribute('open', '');

    await page.locator('.window-controls [data-window-action="close"]').click();
    await expect(appWindow).toHaveClass(/is-closed/);
    await expect(page.locator('[data-task-window]')).toBeHidden();
    await page.locator('[data-open-window]').first().evaluate((button) => button.click());
    await expect(appWindow).not.toHaveClass(/is-closed/);
    await expect(page.locator('[data-task-window]')).toBeVisible();

    if (!isMobile) {
        await page.locator('[data-start-toggle]').click();
        await expect(page.locator('[data-shutdown]')).toContainText('关闭计算机');
        await page.locator('[data-shutdown]').click();
        await expect(page.locator('[data-shutdown-screen]')).toBeVisible();
        await expect(page.locator('[data-shutdown-screen]')).toContainText('Gavin,');
        await expect(page.locator('[data-shutdown-screen]')).toContainText('系统已安全暂停');
        await expect(page.locator('[data-shutdown-log]')).toContainText('作品集内容保持在线', { timeout: 3000 });
        await expect(page.locator('[data-restart]')).toBeVisible();
        await page.locator('[data-restart]').click();
        await expect(page.locator('[data-shutdown-screen]')).toBeHidden();
    }

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

test('opens a retro email composer and sends without leaving the portfolio', async ({ page, isMobile }) => {
    test.skip(isMobile, 'desktop shortcuts are not shown in the mobile layout');
    await page.setViewportSize({ width: 983, height: 754 });
    await page.goto('/portfolio/');

    const mailWindow = page.locator('[data-mail-window]');
    const mailTask = page.locator('[data-mail-task]');
    const mailForm = page.locator('[data-mail-form]');
    const mailStatus = page.locator('[data-mail-status]');
    const endpoint = 'https://formsubmit.co/ajax/gavinxleele@gmail.com';

    await expect(mailWindow).toHaveClass(/is-closed/);
    await expect(mailTask).toBeHidden();
    await expect(page.locator('.desktop-shortcut[href^="mailto:"]')).toHaveCount(0);
    await expect(page.locator('.contact-links a[href^="mailto:"]')).toHaveAttribute('href', 'mailto:gavinxleele@gmail.com');
    await page.locator('[data-window-action="minimize"]').click();
    await expect(page.locator('[data-app-window]')).toHaveClass(/is-minimized/);
    await page.locator('.desktop-shortcut[data-open-mail-window]').click();
    await expect(mailWindow).toBeVisible();
    await expect(mailWindow).toContainText('收件人:');
    await expect(mailWindow).toContainText('gavinxleele@gmail.com');
    await expect(mailTask).toBeVisible();
    await expect(mailTask).toHaveClass(/is-active/);

    await page.route(endpoint, (route) => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: 'true' })
    }));
    await mailForm.locator('input[name="name"]').fill('Portfolio visitor');
    await mailForm.locator('input[name="email"]').fill('visitor@example.com');
    await mailForm.locator('input[name="company"]').fill('Gavin Labs');
    await mailForm.locator('textarea[name="message"]').fill('Hello from the retro desktop.');
    const sentRequest = page.waitForRequest((request) => request.url() === endpoint);
    await mailForm.locator('[data-mail-send]').click();
    expect((await sentRequest).postDataJSON()).toMatchObject({
        name: 'Portfolio visitor',
        email: 'visitor@example.com',
        company: 'Gavin Labs',
        message: 'Hello from the retro desktop.',
        _replyto: 'visitor@example.com'
    });
    await expect(mailStatus).toContainText('已发送');
    await expect(mailForm.locator('input[name="name"]')).toHaveValue('');
    await expect(page).toHaveURL(/\/portfolio\/$/);

    await page.locator('[data-task-window]').click();
    await expect(page.locator('[data-app-window]')).not.toHaveClass(/is-minimized/);
    await page.locator('[data-lang-toggle]').click();
    await expect(mailWindow).toContainText('New Message');
    await expect(mailForm.locator('input[name="name"]')).toHaveAttribute('placeholder', 'Your name');

    await page.locator('[data-window-action="minimize"]').click();
    await expect(page.locator('[data-app-window]')).toHaveClass(/is-minimized/);
    await page.locator('[data-mail-action="minimize"]').click();
    await expect(mailWindow).toHaveClass(/is-minimized/);
    await mailTask.click();
    await expect(mailWindow).not.toHaveClass(/is-minimized/);
    await page.locator('[data-mail-action="close"]').click();
    await expect(mailWindow).toHaveClass(/is-closed/);
    await expect(mailTask).toBeHidden();
    await page.locator('[data-task-window]').click();
    const contactEmail = page.locator('.contact-email-link');
    await contactEmail.scrollIntoViewIfNeeded();
    await contactEmail.click();
    await expect(mailWindow).toBeVisible();
});

test('runs consistent keyboard menus with window-specific commands', async ({ page, isMobile }) => {
    test.skip(isMobile, 'desktop application menus are hidden in the mobile layout');
    await page.setViewportSize({ width: 1100, height: 800 });
    await page.goto('/portfolio/');

    const fileMenu = page.locator('[data-window-menu="portfolio-file"]');
    const editMenu = page.locator('[data-window-menu="portfolio-edit"]');
    await fileMenu.click();
    await expect(page.locator('[data-window-menu-popup="portfolio-file"]')).toBeVisible();
    await page.keyboard.press('ArrowRight');
    await expect(editMenu).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('[data-window-menu-popup="portfolio-edit"]')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-window-menu-popup="portfolio-edit"]')).toBeHidden();
    await expect(editMenu).toBeFocused();

    await page.locator('[data-window-menu="portfolio-view"]').click();
    await page.locator('[data-menu-action="portfolio-projects"]').click();
    await expect(page).toHaveURL(/#projects$/);
    await expect.poll(() => page.locator('[data-window-scroll]').evaluate((element) => element.scrollTop)).toBeGreaterThan(0);

    await fileMenu.click();
    await page.locator('[data-menu-action="portfolio-project-files"]').click();
    const folderWindow = page.locator('[data-project-folder-window]');
    await expect(folderWindow).toBeVisible();

    await folderWindow.locator('[data-window-menu="folder-help"]').click();
    await folderWindow.locator('[data-menu-action="folder-info"]').click();
    await expect(folderWindow.locator('[data-project-folder-status]')).toContainText('13 张 RoboMaster');

    await folderWindow.locator('[data-window-menu="folder-edit"]').click();
    await folderWindow.locator('[data-menu-action="folder-select-all"]').click();
    await expect(folderWindow.locator('[data-open-robomaster-folder]')).toHaveClass(/is-selected/);
    await folderWindow.locator('[data-window-menu="folder-file"]').click();
    await folderWindow.locator('[data-menu-action="folder-open"]').click();
    await expect(folderWindow).toContainText('C:\\GAVIN\\PROJECTS\\RoboMaster 比赛记录');

    await folderWindow.locator('[data-window-menu="folder-edit"]').click();
    await folderWindow.locator('[data-menu-action="folder-select-all"]').click();
    await expect(folderWindow.locator('[data-robomaster-image].is-selected')).toHaveCount(13);
    await folderWindow.locator('[data-window-menu="folder-edit"]').click();
    await folderWindow.locator('[data-menu-action="folder-clear-selection"]').click();
    await expect(folderWindow.locator('[data-robomaster-image].is-selected')).toHaveCount(0);

    await folderWindow.locator('[data-window-menu="folder-file"]').click();
    await folderWindow.locator('[data-menu-action="folder-close"]').click();
    await expect(folderWindow).toHaveClass(/is-closed/);
    await fileMenu.click();
    await page.locator('[data-menu-action="portfolio-close"]').click();
    await expect(page.locator('[data-app-window]')).toHaveClass(/is-closed/);
    await expect(page.locator('[data-task-window]')).toBeHidden();

    await page.locator('.desktop-shortcut[data-open-mail-window]').click();
    const mailWindow = page.locator('[data-mail-window]');
    const messageField = mailWindow.locator('textarea[name="message"]');
    await messageField.fill('Draft message');
    await mailWindow.locator('[data-window-menu="mail-edit"]').click();
    await mailWindow.locator('[data-menu-action="mail-clear-field"]').click();
    await expect(messageField).toHaveValue('');
    await mailWindow.locator('[data-window-menu="mail-view"]').click();
    await mailWindow.locator('[data-menu-action="mail-focus-message"]').click();
    await expect(messageField).toBeFocused();
    await mailWindow.locator('[data-window-menu="mail-help"]').click();
    await mailWindow.locator('[data-menu-action="mail-help"]').click();
    await expect(mailWindow.locator('[data-mail-status]')).toContainText('消息会转发至 Gavin');
});

test('restores the most recently focused window after closing another window', async ({ page, isMobile }) => {
    test.skip(isMobile, 'desktop window stacking is not present on mobile');
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/portfolio/');

    const portfolioWindow = page.locator('[data-app-window]');
    const projectFolderWindow = page.locator('[data-project-folder-window]');
    const gameWindow = page.locator('[data-gomoku-window]');

    await page.locator('[data-window-action="maximize"]').click();
    await page.locator('.desktop-shortcut[data-open-project-folder]').click();
    await expect(projectFolderWindow).toBeVisible();

    await page.locator('[data-task-window]').click();
    await expect(portfolioWindow).toHaveClass(/is-active/);

    await page.locator('.desktop-shortcut[data-open-gomoku]').click();
    await expect(gameWindow).toHaveClass(/is-active/);
    await gameWindow.locator('[data-gomoku-drag] [data-gomoku-window-action="close"]').click();

    await expect(gameWindow).toHaveClass(/is-closed/);
    await expect(portfolioWindow).toHaveClass(/is-active/);
    await expect(projectFolderWindow).not.toHaveClass(/is-active/);
});

test('restores keyboard focus after closing or minimizing a desktop window', async ({ page, isMobile }) => {
    test.skip(isMobile, 'desktop window focus behavior is not present on mobile');
    await page.setViewportSize({ width: 983, height: 754 });
    await page.goto('/portfolio/');

    const portfolioWindow = page.locator('[data-app-window]');
    const projectFolderWindow = page.locator('[data-project-folder-window]');
    await page.locator('[data-window-action="maximize"]').click();
    await page.locator('.desktop-shortcut[data-open-project-folder]').click();
    await expect(projectFolderWindow).toBeVisible();

    await projectFolderWindow.locator('[data-project-folder-action="close"]').click();
    await expect.poll(() => page.evaluate(() => (
        document.activeElement === document.querySelector('[data-lang-toggle]')
    ))).toBe(true);

    await portfolioWindow.locator('[data-window-action="minimize"]').click();
    await expect.poll(() => page.evaluate(() => (
        document.activeElement === document.querySelector('[data-task-window]')
    ))).toBe(true);
});

test('restores desktop session state after a portfolio reload', async ({ page, isMobile }) => {
    test.skip(isMobile, 'desktop window geometry is not present on mobile');
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/portfolio/');

    const portfolioWindow = page.locator('[data-app-window]');
    const projectFolderWindow = page.locator('[data-project-folder-window]');
    const mailWindow = page.locator('[data-mail-window]');
    await portfolioWindow.locator('[data-window-action="maximize"]').click();

    await page.locator('.desktop-shortcut[data-open-project-folder]').click();
    await page.locator('[data-open-robomaster-folder]').click();
    await expect(projectFolderWindow).toContainText('C:\\GAVIN\\PROJECTS\\RoboMaster 比赛记录');
    await projectFolderWindow.evaluate((element) => {
        element.style.left = '168px';
        element.style.top = '96px';
    });

    await page.locator('.desktop-shortcut[data-open-mail-window]').click();
    await mailWindow.locator('input[name="name"]').fill('Session visitor');
    await mailWindow.locator('input[name="email"]').fill('session@example.com');
    await mailWindow.locator('textarea[name="message"]').fill('Keep this draft after reload.');

    await page.locator('.desktop-shortcut[data-open-gomoku]').click();
    await expect(page.locator('[data-gomoku-launcher]')).toBeHidden({ timeout: 3000 });
    await page.locator('[data-gomoku-mode="computer"]').click();
    await page.evaluate(() => window.GomokuGame.loadPosition([
        { row: 7, col: 7, player: 0 },
        { row: 7, col: 8, player: 1 }
    ], 0));

    await page.reload();

    await expect(projectFolderWindow).toContainText('C:\\GAVIN\\PROJECTS\\RoboMaster 比赛记录');
    await expect(projectFolderWindow).toBeVisible();
    expect(await projectFolderWindow.evaluate((element) => ({ left: element.style.left, top: element.style.top }))).toEqual({
        left: '168px',
        top: '96px'
    });
    await expect(mailWindow.locator('input[name="name"]')).toHaveValue('Session visitor');
    await expect(mailWindow.locator('input[name="email"]')).toHaveValue('session@example.com');
    await expect(mailWindow.locator('textarea[name="message"]')).toHaveValue('Keep this draft after reload.');
    expect(JSON.parse(await page.evaluate(() => window.render_game_to_text())).moves).toEqual([
        { row: 7, col: 7, player: 'human-black' },
        { row: 7, col: 8, player: 'computer-white' }
    ]);
});

test('keeps the retro desktop fixed when returning to the top', async ({ page }) => {
    await page.goto('/portfolio/');

    const windowScroll = page.locator('[data-window-scroll]');
    const desktop = page.locator('[data-retro-desktop]');
    const desktopBefore = await desktop.boundingBox();
    await windowScroll.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
    });
    await expect.poll(() => windowScroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);

    await page.locator('.site-footer a[href="#top"]').click();
    await expect(page).toHaveURL(/#top$/);
    await expect.poll(() => windowScroll.evaluate((element) => element.scrollTop)).toBe(0);

    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    expect(await desktop.boundingBox()).toEqual(desktopBefore);
});

test('exposes crawlable SEO metadata', async ({ page, request, isMobile }) => {
    test.skip(isMobile, 'metadata only needs one browser pass');
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    await expect(page).toHaveTitle('李祖钜 Gavin | AI Agent、机器人与计算机视觉作品集');
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
    await expect(page.locator('meta[name="description"]')).toHaveAttribute('content', /李祖钜 Gavin.*AI Agent/);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'index,follow,max-image-preview:large');
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', 'https://lizuju.github.io/');
    await expect(page.locator('meta[property="og:image"]')).toHaveAttribute('content', 'https://lizuju.github.io/portfolio/assets/portfolio-hero.jpg');
    await expect(page.locator('meta[property^="twitter:"]')).toHaveCount(0);
    await expect(page.locator('meta[name="twitter:card"]')).toHaveCount(1);
    await expect(page.locator('meta[name="theme-color"]')).toHaveCount(1);

    const schema = JSON.parse(await page.locator('script[type="application/ld+json"]').textContent());
    expect(schema['@type']).toBe('ProfilePage');
    expect(schema.mainEntity.name).toBe('李祖钜');
    expect(schema.mainEntity.sameAs).toContain('https://github.com/lizuju');

    const manifestHref = await page.locator('link[rel="manifest"]').getAttribute('href');
    const manifest = await (await request.get(`/${manifestHref}`)).json();
    expect(manifest.start_url).toBe('/');
    for (const icon of manifest.icons) {
        const iconResponse = await request.get(`/${icon.src}`);
        expect(iconResponse.ok()).toBe(true);
        expect(iconResponse.headers()['content-type']).toBe(icon.type);
    }
    const appleTouchIcon = await page.locator('link[rel="apple-touch-icon"]').getAttribute('href');
    expect((await request.get(`/${appleTouchIcon}`)).ok()).toBe(true);

    const robots = await request.get('/robots.txt');
    expect(robots.ok()).toBe(true);
    expect(await robots.text()).toContain('Sitemap: https://lizuju.github.io/sitemap.xml');

    const sitemap = await request.get('/sitemap.xml');
    expect(sitemap.ok()).toBe(true);
    const sitemapText = await sitemap.text();
    expect(sitemapText).toContain('<loc>https://lizuju.github.io/</loc>');
    expect(sitemapText).toContain(`<lastmod>${buildMetadata.lastModified}</lastmod>`);

    await page.goto('/portfolio/');
    await expect(page.locator('link[href^="css/main.css"]')).toHaveAttribute(
        'href',
        `css/main.css?v=${buildMetadata.assetVersion}`
    );
    for (const script of await page.locator('script[src]').all()) {
        await expect(script).toHaveAttribute('src', new RegExp(`\\?v=${buildMetadata.assetVersion}$`));
    }
    const portfolioSchema = JSON.parse(await page.locator('script[type="application/ld+json"]').textContent());
    expect(portfolioSchema).toEqual(schema);
    await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', '../site.webmanifest');
});

test('shows a retro file-not-found page for missing paths', async ({ page, isMobile }) => {
    test.skip(isMobile, 'the static error page only needs one browser pass');
    // python http.server does not serve 404.html, so load it the way GitHub Pages does.
    await page.route('**/missing/project-*', async (route) => {
        const notFound = await page.request.get('/404.html');
        await route.fulfill({ status: 404, contentType: 'text/html', body: await notFound.text() });
    });

    const response = await page.goto('/missing/project-%E4%B8%AD%E6%96%87');
    expect(response.status()).toBe(404);
    await expect(page).toHaveTitle(/找不到文件/);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex');
    await expect(page.locator('[data-missing-path]')).toHaveText('C:\\GAVIN\\missing\\project-中文');

    const notFoundHtml = await (await page.request.get('/404.html')).text();
    const previewPage = await page.context().newPage();
    await previewPage.goto(`data:text/html;charset=utf-8,${encodeURIComponent(notFoundHtml)}`);
    await expect(previewPage.locator('[data-missing-path]')).toHaveText('C:\\GAVIN\\404');
    await previewPage.close();

    const portfolioLink = page.getByRole('link', { name: /Portfolio/ });
    await expect(portfolioLink).toHaveAttribute('href', '/portfolio/');
    await portfolioLink.click();
    await expect(page).toHaveURL(/\/portfolio\/$/);
    await expect(page.locator('[data-app-window]')).toBeVisible();

    const expectedNotFound = 'console: Failed to load resource: the server responded with a status of 404 (Not Found)';
    expect(page.browserErrors.filter((error) => error === expectedNotFound)).toHaveLength(1);
    page.browserErrors.splice(page.browserErrors.indexOf(expectedNotFound), 1);
});
