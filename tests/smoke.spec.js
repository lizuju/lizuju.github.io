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
    await expect(page.locator('[data-window-drag]')).toContainText('李祖钜 Gavin - 个人主页');
    await expect(page.locator('.desktop-taskbar')).toBeVisible();
    await expect(page.locator('[data-app-window]')).toBeVisible();
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
    if (!isMobile) await page.setViewportSize({ width: 983, height: 754 });
    await page.goto('/portfolio/');

    const appWindow = page.locator('[data-app-window]');
    const languageButton = page.locator('[data-lang-toggle]');
    await expect(languageButton).toBeVisible();
    expect(await page.locator('[data-window-scroll]').evaluate((viewport, button) => {
        const viewportRect = viewport.getBoundingClientRect();
        const buttonRect = button.getBoundingClientRect();
        return buttonRect.top >= viewportRect.top && buttonRect.bottom <= viewportRect.bottom;
    }, await languageButton.elementHandle())).toBe(true);

    await page.locator('[data-window-action="minimize"]').click();
    await expect(appWindow).toHaveClass(/is-minimized/);
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
    await expect(startMenu.locator('button')).toHaveCount(2);
    await expect(startMenu.locator('a, [data-open-window], [data-open-gomoku]')).toHaveCount(0);
    await expect(startMenu).toContainText('切换语言');
    await expect(startMenu).toContainText('关闭计算机');
    const startMenuBox = await startMenu.boundingBox();
    const languageItemBox = await startMenu.locator('[data-start-lang]').boundingBox();
    const shutdownItemBox = await startMenu.locator('[data-shutdown]').boundingBox();
    expect(startMenuBox.height).toBeGreaterThanOrEqual(220);
    expect(shutdownItemBox.y - languageItemBox.y).toBeGreaterThan(100);
    await page.keyboard.press('Escape');
    await expect(startMenu).toBeHidden();

    await languageButton.click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('h1')).toContainText('Intelligent Systems');
    await expect(page.locator('.project-card')).toHaveCount(5);
    await expect(page.locator('.publication-card')).toHaveCount(2);

    await languageButton.click();
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

    if (!isMobile) {
        await page.locator('[data-start-toggle]').click();
        await expect(page.locator('[data-shutdown]')).toContainText('关闭计算机');
        await page.locator('[data-shutdown]').click();
        await expect(page.locator('[data-shutdown-screen]')).toBeVisible();
        await expect(page.locator('[data-shutdown-log]')).toContainText('作品集必须保持在线', { timeout: 3000 });
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

test('runs the retro Gomoku desktop application', async ({ page, isMobile }) => {
    if (!isMobile) await page.setViewportSize({ width: 983, height: 754 });
    await page.goto('/portfolio/');

    const portfolioWindow = page.locator('[data-app-window]');
    const gameWindow = page.locator('[data-gomoku-window]');
    const portfolioTask = page.locator('[data-task-window]');
    const gameTask = page.locator('[data-gomoku-task]');
    const launcher = page.locator('[data-gomoku-launcher]');

    if (isMobile) {
        await page.evaluate(() => window.GomokuGame.open());
    } else {
        await page.locator('.desktop-shortcut[data-open-gomoku]').click();
    }

    await expect(gameWindow).toBeVisible();
    await expect(portfolioWindow).toBeVisible();
    await expect(portfolioWindow).not.toHaveClass(/is-minimized/);
    await expect(gameTask).toBeVisible();
    await expect(gameTask).toHaveClass(/is-active/);
    await expect(launcher).toBeVisible();
    await expect(page.locator('[data-gomoku-launch-log]')).toContainText('C:\\GAVIN\\GAMES> gomoku.exe');
    await expect(launcher).toBeHidden({ timeout: 3000 });
    await expect(page.locator('[data-gomoku-status]')).toContainText('轮到你落子');

    const canvas = page.locator('[data-gomoku-board]');
    if (isMobile) {
        await expect(page.locator('.gomoku-statusbar')).toBeVisible();
        await expect(page.locator('.gomoku-legend')).toBeHidden();
    }

    if (!isMobile) {
        const boardBeforeResize = await canvas.boundingBox();
        const resizeHandleBefore = await page.locator('[data-gomoku-resize]').boundingBox();
        await page.mouse.move(
            resizeHandleBefore.x + resizeHandleBefore.width / 2,
            resizeHandleBefore.y + resizeHandleBefore.height / 2
        );
        await page.mouse.down();
        await page.mouse.move(resizeHandleBefore.x - 100, resizeHandleBefore.y - 100, { steps: 5 });
        await page.mouse.up();
        await expect.poll(async () => (await canvas.boundingBox()).width).toBeLessThan(boardBeforeResize.width - 50);

        const boardAfterShrink = await canvas.boundingBox();
        const resizeHandleAfterShrink = await page.locator('[data-gomoku-resize]').boundingBox();
        await page.mouse.move(
            resizeHandleAfterShrink.x + resizeHandleAfterShrink.width / 2,
            resizeHandleAfterShrink.y + resizeHandleAfterShrink.height / 2
        );
        await page.mouse.down();
        await page.mouse.move(resizeHandleAfterShrink.x + 120, resizeHandleAfterShrink.y + 110, { steps: 5 });
        await page.mouse.up();
        await expect.poll(async () => (await canvas.boundingBox()).width).toBeGreaterThan(boardAfterShrink.width + 50);

        const resizedBoard = await canvas.boundingBox();
        expect(Math.abs(resizedBoard.width - resizedBoard.height)).toBeLessThan(1);
        const gameWindowBox = await gameWindow.boundingBox();
        const gameStatusBox = await page.locator('.gomoku-statusbar').boundingBox();
        const portfolioStatusBox = await page.locator('.window-statusbar').boundingBox();
        const legendBox = await page.locator('.gomoku-legend').boundingBox();
        const computerLabelBox = await page.locator(
            '.gomoku-legend [data-gomoku-i18n="computer"]'
        ).boundingBox();
        const resizeHandleBox = await page.locator('[data-gomoku-resize]').boundingBox();
        expect(Math.abs(gameStatusBox.height - portfolioStatusBox.height)).toBeLessThan(1);
        expect(Math.abs(gameStatusBox.x - gameWindowBox.x - 2)).toBeLessThan(1);
        expect(Math.abs(
            gameStatusBox.y + gameStatusBox.height - gameWindowBox.y - gameWindowBox.height + 2
        )).toBeLessThan(1);
        expect(Math.abs(
            legendBox.y + legendBox.height / 2 - resizeHandleBox.y - resizeHandleBox.height / 2
        )).toBeLessThan(1);
        expect(Math.abs(resizeHandleBox.y - gameStatusBox.y - 3)).toBeLessThan(1);
        expect(Math.abs(
            gameStatusBox.y + gameStatusBox.height - resizeHandleBox.y - resizeHandleBox.height - 2
        )).toBeLessThan(1);
        expect(computerLabelBox.x + computerLabelBox.width).toBeLessThan(resizeHandleBox.x - 2);
    }

    await portfolioTask.click();
    await expect(portfolioWindow).toHaveClass(/is-active/);
    await expect(gameWindow).not.toHaveClass(/is-active/);
    await expect(gameWindow).toBeVisible();
    expect(await page.evaluate(() => (
        Number(window.getComputedStyle(document.querySelector('[data-app-window]')).zIndex)
        > Number(window.getComputedStyle(document.querySelector('[data-gomoku-window]')).zIndex)
    ))).toBe(true);

    await gameTask.click();
    await expect(gameWindow).toHaveClass(/is-active/);
    await expect(gameWindow).toBeVisible();
    await expect(portfolioWindow).toBeVisible();
    expect(await page.evaluate(() => (
        Number(window.getComputedStyle(document.querySelector('[data-gomoku-window]')).zIndex)
        > Number(window.getComputedStyle(document.querySelector('[data-app-window]')).zIndex)
    ))).toBe(true);

    const thinkingState = await page.evaluate(() => {
        window.GomokuGame.playMove(7, 7);
        const element = document.querySelector('[data-gomoku-board]');
        return {
            phase: JSON.parse(window.render_game_to_text()).phase,
            locked: element.classList.contains('is-locked'),
            thinking: element.classList.contains('is-thinking'),
            cursor: window.getComputedStyle(element).cursor
        };
    });
    expect(thinkingState).toEqual({ phase: 'thinking', locked: true, thinking: true, cursor: 'wait' });
    await page.evaluate(() => window.advanceTime(1000));

    let gameState = JSON.parse(await page.evaluate(() => window.render_game_to_text()));
    expect(gameState.phase).toBe('playing');
    expect(gameState.currentPlayer).toBe('human-black');
    expect(gameState.moves).toHaveLength(2);
    expect(gameState.moves.map((move) => move.player)).toEqual(['human-black', 'computer-white']);
    await expect(canvas).not.toHaveClass(/is-locked|is-thinking/);
    expect(await canvas.evaluate((element) => window.getComputedStyle(element).cursor)).toBe('crosshair');

    await portfolioTask.click();
    await page.keyboard.press('Control+z');
    gameState = JSON.parse(await page.evaluate(() => window.render_game_to_text()));
    expect(gameState.moves).toHaveLength(2);
    await gameTask.click();

    await page.locator('[data-gomoku-menu="game"]').click();
    await page.locator('[data-gomoku-undo]').click();
    gameState = JSON.parse(await page.evaluate(() => window.render_game_to_text()));
    expect(gameState.moves).toHaveLength(0);

    await page.locator('[data-gomoku-menu="help"]').click();
    await page.locator('[data-gomoku-help]').click();
    await expect(page.locator('[data-gomoku-dialog]')).toBeVisible();
    await expect(page.locator('[data-gomoku-dialog-copy]')).toContainText('率先连成五子');
    await page.locator('.gomoku-dialog-actions [data-gomoku-dialog-close]').click();
    await expect(page.locator('[data-gomoku-dialog]')).toBeHidden();

    await page.locator('[data-start-toggle]').click();
    await page.locator('[data-start-lang]').click();
    await expect(page.locator('[data-gomoku-drag]')).toContainText('Gomoku - GavinOS Games');
    await page.locator('[data-start-toggle]').click();
    await page.locator('[data-start-lang]').click();
    await expect(page.locator('[data-gomoku-drag]')).toContainText('五子棋 - GavinOS 游戏');

    await page.evaluate(() => window.GomokuGame.loadPosition([
        { row: 7, col: 3, player: 0 },
        { row: 3, col: 3, player: 1 },
        { row: 7, col: 4, player: 0 },
        { row: 3, col: 5, player: 1 },
        { row: 7, col: 5, player: 0 },
        { row: 3, col: 7, player: 1 },
        { row: 7, col: 6, player: 0 }
    ], 0));
    const winningBoardBox = await canvas.boundingBox();
    await page.mouse.click(
        winningBoardBox.x + winningBoardBox.width / 2,
        winningBoardBox.y + winningBoardBox.height / 2
    );
    gameState = JSON.parse(await page.evaluate(() => window.render_game_to_text()));
    expect(gameState.phase).toBe('player-won');
    expect(gameState.winner).toBe('human-black');
    expect(gameState.winningLine).toHaveLength(5);
    await expect(page.locator('[data-gomoku-status]')).toContainText('你赢了');
    await expect(canvas).toHaveClass(/is-locked/);
    await expect(canvas).not.toHaveClass(/is-thinking/);
    expect(await canvas.evaluate((element) => window.getComputedStyle(element).cursor)).toBe('default');

    await page.locator('.gomoku-face').click();
    gameState = JSON.parse(await page.evaluate(() => window.render_game_to_text()));
    expect(gameState.moves).toHaveLength(0);
    await expect(canvas).not.toHaveClass(/is-locked|is-thinking/);
    expect(await canvas.evaluate((element) => window.getComputedStyle(element).cursor)).toBe('crosshair');

    if (!isMobile) {
        const windowBeforeDrag = await gameWindow.boundingBox();
        const titlebar = await page.locator('[data-gomoku-drag]').boundingBox();
        await page.mouse.move(titlebar.x + 250, titlebar.y + titlebar.height / 2);
        await page.mouse.down();
        await page.mouse.move(titlebar.x + 205, titlebar.y + 35, { steps: 4 });
        await page.mouse.up();
        const windowAfterDrag = await gameWindow.boundingBox();
        expect(windowAfterDrag.x).toBeLessThan(windowBeforeDrag.x - 20);
        expect(windowAfterDrag.y).toBeGreaterThanOrEqual(windowBeforeDrag.y + 8);

        await page.locator('[data-gomoku-window-action="maximize"]').click();
        await expect(gameWindow).toHaveClass(/is-maximized/);
        await page.locator('[data-gomoku-window-action="maximize"]').click();
        await expect(gameWindow).not.toHaveClass(/is-maximized/);
    }

    await page.locator('[data-gomoku-window-action="minimize"]').click();
    await expect(gameWindow).toHaveClass(/is-minimized/);
    await expect(portfolioWindow).not.toHaveClass(/is-minimized/);
    await gameTask.click();
    await expect(gameWindow).not.toHaveClass(/is-minimized/);

    await page.locator('[data-gomoku-drag] [data-gomoku-window-action="close"]').click();
    await expect(gameWindow).toHaveClass(/is-closed/);
    await expect(gameTask).toBeHidden();
    await expect(portfolioWindow).toBeVisible();
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

    await expect(page).toHaveTitle('Gavin Lizuju | AI Agent, Robotics & Computer Vision Portfolio');
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
    await expect(page.locator('.direct-entry')).toHaveText('Direct View');
    await expect(page.locator('canvas').first()).toBeVisible({ timeout: 45000 });
    await expect(page.locator('#computer-screen')).toHaveAttribute('src', 'portfolio/', { timeout: 45000 });
    await expect(page.frameLocator('#computer-screen').locator('h1')).toContainText('智能系统', { timeout: 45000 });
    expect(await page.locator('canvas').first().evaluate((canvas) => canvas.width > 0 && canvas.height > 0)).toBe(true);

    await page.getByText('Enter', { exact: true }).click();
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
