const { test, expect } = require('@playwright/test');
const path = require('path');
const { createBuildMetadata } = require('../bundler/build-metadata');

const buildMetadata = createBuildMetadata(path.resolve(__dirname, '..'));

const satelliteRecords = [
    {
        OBJECT_NAME: 'ISS (ZARYA)',
        OBJECT_ID: '1998-067A',
        NORAD_CAT_ID: 25544,
        MEAN_MOTION: 15.49,
        ECCENTRICITY: 0.0005,
        INCLINATION: 51.64,
        RA_OF_ASC_NODE: 100,
        ARG_OF_PERICENTER: 20,
        MEAN_ANOMALY: 340,
    },
    {
        OBJECT_NAME: 'STARLINK-1234',
        OBJECT_ID: '2020-001A',
        NORAD_CAT_ID: 45000,
        MEAN_MOTION: 15.06,
        ECCENTRICITY: 0.0002,
        INCLINATION: 53,
        RA_OF_ASC_NODE: 180,
        ARG_OF_PERICENTER: 60,
        MEAN_ANOMALY: 120,
    },
    {
        OBJECT_NAME: 'GPS BIIR-2',
        OBJECT_ID: '1997-035A',
        NORAD_CAT_ID: 24876,
        MEAN_MOTION: 2.0056,
        ECCENTRICITY: 0.006,
        INCLINATION: 55.4,
        RA_OF_ASC_NODE: 230,
        ARG_OF_PERICENTER: 95,
        MEAN_ANOMALY: 250,
    },
    {
        OBJECT_NAME: 'HST',
        OBJECT_ID: '1990-037B',
        NORAD_CAT_ID: 20580,
        MEAN_MOTION: 15.09,
        ECCENTRICITY: 0.0003,
        INCLINATION: 28.47,
        RA_OF_ASC_NODE: 45,
        ARG_OF_PERICENTER: 130,
        MEAN_ANOMALY: 210,
    },
].map((record) => ({
    ...record,
    EPOCH: '2026-07-20T00:00:00.000000',
    MEAN_MOTION_DOT: 0.00001,
    MEAN_MOTION_DDOT: 0,
    BSTAR: 0.0001,
    EPHEMERIS_TYPE: 0,
    CLASSIFICATION_TYPE: 'U',
    ELEMENT_SET_NO: 999,
    REV_AT_EPOCH: 50000,
}));

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
    await expect(page.locator('[data-direct-return]')).toBeVisible();
    await expect(page.locator('[data-direct-return]')).toHaveAttribute('href', '../');
    await expect(page.locator('[data-direct-return]')).toHaveClass(/scene-link/);
    await expect(page.locator('[data-direct-return]')).toHaveText('返回沉浸式场景 / Back to immersive scene');
    await expect(page.locator('.desktop-taskbar [data-direct-return]')).toHaveCount(0);
    expect((await page.locator('[data-direct-return]').boundingBox()).y).toBeLessThan(100);
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

test('returns from the direct portfolio to the immersive shell', async ({ page, isMobile }) => {
    await page.goto('/portfolio/');
    await page.locator('[data-direct-return]').click();
    await expect(page).toHaveURL(/\/$/);
    if (isMobile) {
        await expect(page.locator('#mobile-entry')).toBeVisible();
        await page.locator('[data-mobile-enter]').click();
        await expect(page.locator('#mobile-portfolio')).toBeVisible();
    } else {
        await expect(page.locator('.direct-entry')).toBeHidden();
    }
    await page.goto('/portfolio/');
});

test('opens the direct desktop portfolio maximized and allows restoring it', async ({ page, isMobile }) => {
    test.skip(isMobile, 'desktop maximize behavior is disabled on the mobile layout');
    test.setTimeout(90000);
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.direct-entry')).toBeHidden();
    await page.locator('[data-start-scene]').click();
    await expect(page.locator('.direct-entry')).toBeVisible();
    await page.locator('.direct-entry').click();
    await expect(page).toHaveURL(/\/portfolio\/$/);

    const appWindow = page.locator('[data-app-window]');
    const maximizeButton = page.locator('[data-window-action="maximize"]');
    await expect(appWindow).toHaveClass(/is-maximized/, { timeout: 45000 });
    await expect(maximizeButton).toHaveAttribute('aria-pressed', 'true', { timeout: 45000 });

    await maximizeButton.click();
    await expect(appWindow).not.toHaveClass(/is-maximized/);
    await expect(maximizeButton).toHaveAttribute('aria-pressed', 'false');
    const restoredWindow = await appWindow.boundingBox();
    expect(restoredWindow.x).toBeGreaterThan(0);
    expect(restoredWindow.y).toBeGreaterThan(0);
    expect(restoredWindow.width).toBeLessThan(page.viewportSize().width);
});

test('supports language, navigation, and expandable details', async ({ page, isMobile }) => {
    if (!isMobile) await page.setViewportSize({ width: 983, height: 754 });
    await page.goto('/portfolio/');

    const appWindow = page.locator('[data-app-window]');
    const languageButton = page.locator('[data-lang-toggle]');
    if (!isMobile) {
        await expect(appWindow).toHaveClass(/is-maximized/);
        await page.locator('[data-window-action="maximize"]').click();
        await expect(appWindow).not.toHaveClass(/is-maximized/);
    }
    await expect(languageButton).toBeVisible();
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

test('opens Project Files as a desktop folder window without navigating the portfolio', async ({ page, isMobile }) => {
    test.skip(isMobile, 'desktop folder interactions are not shown in the mobile layout');
    await page.setViewportSize({ width: 983, height: 754 });
    await page.goto('/portfolio/');

    const folderWindow = page.locator('[data-project-folder-window]');
    const folderTask = page.locator('[data-project-folder-task]');
    const portfolioWindow = page.locator('[data-app-window]');

    await expect(folderWindow).toHaveClass(/is-closed/);
    await expect(folderTask).toBeHidden();
    await page.locator('[data-window-action="minimize"]').click();
    await expect(portfolioWindow).toHaveClass(/is-minimized/);
    await page.locator('[data-open-project-folder]').click();

    await expect(page).toHaveURL(/\/portfolio\/$/);
    await expect(folderWindow).toBeVisible();
    await expect(folderWindow).toContainText('C:\\GAVIN\\PROJECTS');
    await expect(folderWindow).toContainText(/ROBOMASTER_\s*RECORDS/);
    await expect(folderWindow).not.toContainText('AI Agent');
    await expect(folderTask).toBeVisible();
    await expect(folderTask).toHaveClass(/is-active/);
    await expect(portfolioWindow).toHaveClass(/is-minimized/);

    const beforeDrag = await folderWindow.boundingBox();
    const titlebar = await page.locator('[data-project-folder-drag]').boundingBox();
    await page.mouse.move(titlebar.x + 180, titlebar.y + titlebar.height / 2);
    await page.mouse.down();
    await page.mouse.move(titlebar.x + 140, titlebar.y + titlebar.height / 2 + 24, { steps: 4 });
    await page.mouse.up();
    const afterDrag = await folderWindow.boundingBox();
    expect(afterDrag.x).toBeLessThan(beforeDrag.x - 25);
    expect(afterDrag.y).toBeGreaterThan(beforeDrag.y + 15);

    const beforeResize = await folderWindow.boundingBox();
    const resizeHandle = await page.locator('[data-project-folder-resize]').boundingBox();
    await page.mouse.move(resizeHandle.x + resizeHandle.width / 2, resizeHandle.y + resizeHandle.height / 2);
    await page.mouse.down();
    await page.mouse.move(resizeHandle.x - 60, resizeHandle.y - 45, { steps: 4 });
    await page.mouse.up();
    const afterResize = await folderWindow.boundingBox();
    expect(afterResize.width).toBeLessThan(beforeResize.width - 40);
    expect(afterResize.height).toBeLessThan(beforeResize.height - 30);

    const maximizeButton = page.locator('[data-project-folder-action="maximize"]');
    await maximizeButton.click();
    await expect(folderWindow).toHaveClass(/is-maximized/);
    await maximizeButton.click();
    await expect(folderWindow).not.toHaveClass(/is-maximized/);

    await page.locator('[data-project-folder-action="minimize"]').click();
    await expect(folderWindow).toHaveClass(/is-minimized/);
    await folderTask.click();
    await expect(folderWindow).not.toHaveClass(/is-minimized/);

    await page.locator('[data-project-folder-action="close"]').click();
    await expect(folderWindow).toHaveClass(/is-closed/);
    await expect(folderTask).toBeHidden();
});

test('opens RoboMaster match records in a movable image preview window', async ({ page, isMobile }) => {
    test.skip(isMobile, 'desktop image windows are not shown in the mobile layout');
    await page.setViewportSize({ width: 1280, height: 900 });

    const thumbnailRequests = new Set();
    const previewImageRequests = new Set();
    const originalImageRequests = new Set();
    page.on('request', (request) => {
        const pathname = new URL(request.url()).pathname;
        if (!pathname.includes('/portfolio/assets/robomaster-match-records/')) return;

        if (pathname.includes('/thumbs/')) {
            thumbnailRequests.add(pathname);
        } else if (pathname.includes('/previews/')) {
            previewImageRequests.add(pathname);
        } else if (pathname.endsWith('.jpg')) {
            originalImageRequests.add(pathname);
        }
    });

    await page.goto('/portfolio/');

    const folderWindow = page.locator('[data-project-folder-window]');
    const previewWindow = page.locator('[data-image-preview-window]');
    const previewTask = page.locator('[data-image-preview-task]');

    await page.locator('[data-window-action="minimize"]').click();
    await page.locator('[data-open-project-folder]').click();
    await page.locator('[data-open-robomaster-folder]').click();

    await expect(folderWindow).toContainText('C:\\GAVIN\\PROJECTS\\ROBOMASTER_RECORDS');
    await expect(folderWindow.locator('[data-robomaster-image]')).toHaveCount(13);
    await expect(folderWindow).toContainText('13 视觉.jpg');
    await expect(folderWindow.locator('[data-robomaster-thumbnail]').first()).toHaveAttribute(
        'src',
        'assets/robomaster-match-records/thumbs/01-match-multi-robot.jpg'
    );
    await expect.poll(() => thumbnailRequests.size).toBe(13);
    expect(previewImageRequests).toEqual(new Set());
    expect(originalImageRequests).toEqual(new Set());

    const selectedPreviewPath = '/portfolio/assets/robomaster-match-records/previews/09-no3-infantry-front.webp';
    const selectedImageRequest = page.waitForRequest(
        (request) => new URL(request.url()).pathname === selectedPreviewPath
    );
    await folderWindow.locator('[data-robomaster-image]').nth(8).click();
    await selectedImageRequest;
    await expect(previewWindow).toBeVisible();
    await expect(previewWindow).toContainText('09 3号.jpg');
    await expect(previewWindow.locator('[data-image-preview-image]')).toHaveAttribute(
        'src',
        'assets/robomaster-match-records/previews/09-no3-infantry-front.jpg'
    );
    await expect(previewWindow.locator('[data-image-preview-source]')).toHaveAttribute(
        'srcset',
        'assets/robomaster-match-records/previews/09-no3-infantry-front.webp'
    );
    const previewImage = previewWindow.locator('[data-image-preview-image]');
    const previewResource = await previewImage.evaluate((image) => ({
        currentSrc: image.currentSrc,
        width: image.naturalWidth,
        height: image.naturalHeight
    }));
    expect(new URL(previewResource.currentSrc).pathname).toBe(selectedPreviewPath);
    expect(Math.max(previewResource.width, previewResource.height)).toBeLessThanOrEqual(1600);
    expect(previewImageRequests).toEqual(new Set([selectedPreviewPath]));
    expect(originalImageRequests).toEqual(new Set());
    const originalImageResponse = await page.request.get(
        '/portfolio/assets/robomaster-match-records/09-no3-infantry-front.jpg'
    );
    expect(originalImageResponse.status()).toBe(404);
    await expect(previewTask).toBeVisible();
    await expect(previewTask).toHaveClass(/is-active/);
    await expect(folderWindow.locator('[data-robomaster-image].is-selected')).toContainText('09 3号.jpg');

    const nextPreviewPath = '/portfolio/assets/robomaster-match-records/previews/10-operator-console.webp';
    const nextImageRequest = page.waitForRequest(
        (request) => new URL(request.url()).pathname === nextPreviewPath
    );
    await page.keyboard.press('ArrowRight');
    await nextImageRequest;
    await expect(previewWindow).toContainText('10 调试.jpg');
    await expect(folderWindow.locator('[data-robomaster-image].is-selected')).toContainText('10 调试.jpg');

    await page.keyboard.press('ArrowLeft');
    await expect(previewWindow).toContainText('09 3号.jpg');
    await expect(folderWindow.locator('[data-robomaster-image].is-selected')).toContainText('09 3号.jpg');

    const imageButtons = folderWindow.locator('[data-robomaster-image]');
    const aboveIndex = await imageButtons.evaluateAll((buttons) => {
        const firstRowTop = buttons[0].offsetTop;
        const columnCount = buttons.findIndex((button, index) => index > 0 && button.offsetTop !== firstRowTop);
        return 8 - (columnCount === -1 ? buttons.length : columnCount);
    });
    const aboveLabel = await imageButtons.nth(aboveIndex).locator('[data-photo-label]').textContent();
    const abovePreviewPath = await imageButtons.nth(aboveIndex).getAttribute('data-image-src');
    await page.keyboard.press('ArrowUp');
    await expect(previewWindow).toContainText(aboveLabel);
    await expect(previewWindow.locator('[data-image-preview-image]')).toHaveAttribute('src', abovePreviewPath);
    await expect(folderWindow.locator('[data-robomaster-image].is-selected')).toContainText(aboveLabel);

    await page.keyboard.press('ArrowDown');
    await expect(previewWindow).toContainText('09 3号.jpg');
    await expect(folderWindow.locator('[data-robomaster-image].is-selected')).toContainText('09 3号.jpg');

    const beforeDrag = await previewWindow.boundingBox();
    const titlebar = await previewWindow.locator('[data-image-preview-drag]').boundingBox();
    await page.mouse.move(titlebar.x + 160, titlebar.y + titlebar.height / 2);
    await page.mouse.down();
    await page.mouse.move(titlebar.x + 118, titlebar.y + titlebar.height / 2 + 26, { steps: 4 });
    await page.mouse.up();
    const afterDrag = await previewWindow.boundingBox();
    expect(afterDrag.x).toBeLessThan(beforeDrag.x - 25);
    expect(afterDrag.y).toBeGreaterThan(beforeDrag.y + 15);

    const beforeResize = await previewWindow.boundingBox();
    const resizeHandle = await previewWindow.locator('[data-image-preview-resize]').boundingBox();
    await page.mouse.move(resizeHandle.x + resizeHandle.width / 2, resizeHandle.y + resizeHandle.height / 2);
    await page.mouse.down();
    await page.mouse.move(resizeHandle.x - 70, resizeHandle.y - 55, { steps: 4 });
    await page.mouse.up();
    const afterResize = await previewWindow.boundingBox();
    expect(afterResize.width).toBeLessThan(beforeResize.width - 45);
    expect(afterResize.height).toBeLessThan(beforeResize.height - 35);

    const maximizeButton = previewWindow.locator('[data-image-preview-action="maximize"]');
    await maximizeButton.click();
    await expect(previewWindow).toHaveClass(/is-maximized/);
    await maximizeButton.click();
    await expect(previewWindow).not.toHaveClass(/is-maximized/);

    await previewWindow.locator('[data-image-preview-action="minimize"]').click();
    await expect(previewWindow).toHaveClass(/is-minimized/);
    await previewTask.click();
    await expect(previewWindow).not.toHaveClass(/is-minimized/);

    await previewWindow.locator('[data-image-preview-action="close"]').click();
    await expect(previewWindow).toHaveClass(/is-closed/);
    await expect(previewTask).toBeHidden();
    await expect(folderWindow).toHaveClass(/is-active/);

    await page.keyboard.press('ArrowRight');
    await expect(folderWindow.locator('[data-robomaster-image].is-selected')).toContainText('10 调试.jpg');
    await expect(previewWindow).toHaveClass(/is-closed/);

    await page.keyboard.press('Enter');
    await expect(previewWindow).toContainText('10 调试.jpg');
    await expect(folderWindow.locator('[data-robomaster-image].is-selected')).toContainText('10 调试.jpg');
    await previewWindow.locator('[data-image-preview-action="close"]').click();
    await expect(previewWindow).toHaveClass(/is-closed/);

    await page.locator('[data-project-folder-back]').click();
    await expect(folderWindow).toContainText('C:\\GAVIN\\PROJECTS');
    await expect(folderWindow.locator('[data-open-robomaster-folder]')).toBeVisible();
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
    await expect(page.locator('.contact-links a[href^="mailto:"]')).toHaveCount(0);
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

test('runs the live satellite tracker as a lazy GavinOS window', async ({ page, isMobile }) => {
    test.setTimeout(90000);
    const satelliteBundleRequests = [];
    page.on('request', (request) => {
        if (request.url().includes('/portfolio/js/satellite-tracker.js')) {
            satelliteBundleRequests.push(request.url());
        }
    });
    await page.route(/celestrak\.org\/NORAD\/elements\/gp\.php\?GROUP=active&FORMAT=json$/, (route) => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(satelliteRecords),
    }));
    await page.goto(isMobile ? '/portfolio/?view=mobile-homepage' : '/portfolio/');

    const satelliteWindow = page.locator('[data-satellite-window]');
    const satelliteTask = page.locator('[data-satellite-task]');
    const desktop = page.locator('[data-retro-desktop]');
    await expect(satelliteWindow).toHaveClass(/is-closed/);
    expect(satelliteBundleRequests).toHaveLength(0);

    await page.locator('[data-window-action="minimize"]').click();
    await page.locator('.desktop-shortcut[data-open-satellite]').click();
    await expect(satelliteWindow).toBeVisible();
    await expect(satelliteWindow).not.toHaveClass(/is-closed|is-minimized/);
    await expect(satelliteTask).toBeVisible();
    await expect(satelliteTask).toHaveClass(/is-active/);
    await expect.poll(() => satelliteBundleRequests.length).toBeGreaterThan(0);
    await expect(page.locator('[data-satellite-count]')).toHaveText('4', { timeout: 30000 });
    await expect(page.locator('[data-satellite-group-count="starlink"]')).toHaveText('1');
    await expect(page.locator('[data-satellite-group-count="navigation"]')).toHaveText('1');
    await expect(page.locator('[data-satellite-group-count="crewed"]')).toHaveText('1');
    await expect(page.locator('[data-satellite-group-count="other"]')).toHaveText('1');

    await page.locator('[data-satellite-search]').fill('25544');
    await page.locator('[data-satellite-search-button]').click();
    await expect(page.locator('[data-satellite-name]')).toHaveText('ISS (ZARYA)');
    await expect(page.locator('[data-satellite-norad]')).toHaveText('25544');
    await expect(page.locator('[data-satellite-altitude]')).not.toHaveText('-');

    const canvas = page.locator('[data-satellite-canvas]');
    await expect(canvas).toHaveAttribute('data-rendered', 'true');
    const pixelSums = await canvas.evaluate((element) => {
        window.SatelliteTracker.renderNow();
        const context = element.getContext('webgl2') || element.getContext('webgl');
        const points = [
            [0.5, 0.5],
            [0.2, 0.2],
            [0.8, 0.2],
            [0.2, 0.8],
            [0.8, 0.8],
        ];
        return points.map(([x, y]) => {
            const pixel = new Uint8Array(4);
            context.readPixels(
                Math.floor(element.width * x),
                Math.floor(element.height * y),
                1,
                1,
                context.RGBA,
                context.UNSIGNED_BYTE,
                pixel
            );
            return pixel[0] + pixel[1] + pixel[2];
        });
    });
    expect(Math.max(...pixelSums) - Math.min(...pixelSums)).toBeGreaterThan(20);

    const desktopBox = await desktop.boundingBox();
    const windowBox = await satelliteWindow.boundingBox();
    expect(windowBox.x).toBeGreaterThanOrEqual(desktopBox.x);
    expect(windowBox.y).toBeGreaterThanOrEqual(desktopBox.y);
    expect(windowBox.x + windowBox.width).toBeLessThanOrEqual(desktopBox.x + desktopBox.width + 1);
    expect(windowBox.y + windowBox.height).toBeLessThanOrEqual(desktopBox.y + desktopBox.height + 1);

    await satelliteWindow.locator('[data-satellite-action="maximize"]').click();
    await expect(satelliteWindow).toHaveClass(/is-maximized/);
    await satelliteWindow.locator('[data-satellite-action="maximize"]').click();
    await expect(satelliteWindow).not.toHaveClass(/is-maximized/);
    await satelliteWindow.locator('[data-satellite-action="minimize"]').click();
    await expect(satelliteWindow).toHaveClass(/is-minimized/);
    await satelliteTask.click();
    await expect(satelliteWindow).not.toHaveClass(/is-minimized/);
    await satelliteWindow.locator('[data-satellite-action="close"]').click();
    await expect(satelliteWindow).toHaveClass(/is-closed/);
    await expect(satelliteTask).toBeHidden();
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
    await expect(folderWindow).toContainText('C:\\GAVIN\\PROJECTS\\ROBOMASTER_RECORDS');

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
    await expect(projectFolderWindow).toContainText('C:\\GAVIN\\PROJECTS\\ROBOMASTER_RECORDS');
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
    await page.evaluate(() => window.GomokuGame.loadPosition([
        { row: 7, col: 7, player: 0 },
        { row: 7, col: 8, player: 1 }
    ], 0));

    await page.reload();

    await expect(projectFolderWindow).toContainText('C:\\GAVIN\\PROJECTS\\ROBOMASTER_RECORDS');
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

test('keeps a single iframe input bridge after portfolio iframe reloads', async ({ page, isMobile }) => {
    test.skip(isMobile, 'the mobile shell does not create the portfolio iframe');
    test.setTimeout(60000);
    await page.goto('/');
    await expect(page.locator('canvas').first()).toBeVisible({ timeout: 45000 });

    const screen = page.locator('#computer-screen');
    await expect(screen).toHaveAttribute('src', 'portfolio/');
    await screen.evaluate(async (iframe) => {
        iframe.dataset.bridgeEventCount = '0';
        iframe.addEventListener('mousemove', () => {
            iframe.dataset.bridgeEventCount = String(
                Number(iframe.dataset.bridgeEventCount || '0') + 1
            );
        });

        for (let version = 1; version <= 2; version += 1) {
            await new Promise((resolve) => {
                iframe.addEventListener('load', resolve, { once: true });
                const nextUrl = new URL(iframe.src);
                nextUrl.searchParams.set('bridge-test', String(version));
                iframe.src = nextUrl.href;
            });
        }
    });

    await page.frameLocator('#computer-screen').locator('body').evaluate(() => {
        window.parent.postMessage(
            {
                source: 'gavin-portfolio',
                type: 'mousemove',
                clientX: 20,
                clientY: 20,
            },
            window.location.origin
        );
    });

    await expect.poll(async () => screen.getAttribute('data-bridge-event-count')).toBe('1');
});

test('starts the visual scene before deferred audio finishes loading', async ({ page, isMobile }) => {
    test.skip(isMobile, 'the mobile shell does not load immersive resources');
    test.setTimeout(60000);
    let requestedDeferredAudio = false;
    let releaseDeferredAudio;
    const deferredAudio = new Promise((resolve) => {
        releaseDeferredAudio = resolve;
    });

    await page.route('**/audio/atmosphere/office.mp3', async (route) => {
        requestedDeferredAudio = true;
        await deferredAudio;
        await route.continue();
    });

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('canvas').first()).toBeVisible({ timeout: 45000 });
    await expect(page.locator('[data-start-scene]')).toBeVisible({ timeout: 10000 });
    expect(requestedDeferredAudio).toBe(false);
    await page.locator('[data-start-scene]').click();
    await expect.poll(() => requestedDeferredAudio).toBe(true);
    await expect(page.locator('[data-resource-error]')).toHaveCount(0);
    releaseDeferredAudio();
    await page.waitForTimeout(100);
});

test('pauses and resumes the render loop when document visibility changes', async ({ page, isMobile }) => {
    test.skip(isMobile, 'the mobile shell does not create the render loop');
    test.setTimeout(60000);
    await page.addInitScript(() => {
        const originalRequestAnimationFrame = window.requestAnimationFrame.bind(window);
        window.__gavinRafRequests = 0;
        window.requestAnimationFrame = (callback) => {
            window.__gavinRafRequests += 1;
            return originalRequestAnimationFrame(callback);
        };
    });

    await page.goto('/');
    await expect(page.locator('canvas').first()).toBeVisible({ timeout: 45000 });
    await page.waitForTimeout(150);

    const countBeforePause = await page.evaluate(() => window.__gavinRafRequests);
    await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, value: true });
        document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForTimeout(100);
    const countWhileHidden = await page.evaluate(() => window.__gavinRafRequests);

    await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, value: false });
        document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect.poll(() => page.evaluate(() => window.__gavinRafRequests)).toBeGreaterThan(countWhileHidden);
    expect(countWhileHidden - countBeforePause).toBeLessThanOrEqual(2);
});

test('pauses the immersive render loop when direct view opens and resumes after returning', async ({ page, isMobile }) => {
    test.skip(isMobile, 'the mobile shell does not create the render loop');
    test.setTimeout(60000);
    await page.addInitScript(() => {
        window.__gavinDrawCalls = 0;
        [window.WebGLRenderingContext, window.WebGL2RenderingContext].forEach((Context) => {
            if (!Context) return;
            ['drawArrays', 'drawElements'].forEach((method) => {
                if (!Object.prototype.hasOwnProperty.call(Context.prototype, method)) return;
                const original = Context.prototype[method];
                Context.prototype[method] = function (...args) {
                    window.__gavinDrawCalls += 1;
                    return original.apply(this, args);
                };
            });
        });
    });

    await page.goto('/');
    await expect(page.locator('canvas').first()).toBeVisible({ timeout: 45000 });
    await page.locator('[data-start-scene]').click();
    const directEntry = page.locator('.direct-entry');
    await expect(directEntry).toBeVisible();
    await page.waitForTimeout(150);

    await directEntry.evaluate((link) => {
        link.addEventListener('click', (event) => event.preventDefault(), { once: true });
        link.click();
    });
    await page.waitForTimeout(50);
    const countAfterPause = await page.evaluate(() => window.__gavinDrawCalls);
    await page.waitForTimeout(100);
    const countWhileDirect = await page.evaluate(() => window.__gavinDrawCalls);

    await page.evaluate(() => {
        window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    });
    await expect.poll(() => page.evaluate(() => window.__gavinDrawCalls)).toBeGreaterThan(countWhileDirect);
    expect(countWhileDirect).toBe(countAfterPause);
});

test('runs the retro Gomoku desktop application', async ({ page, isMobile }) => {
    if (!isMobile) await page.setViewportSize({ width: 983, height: 754 });
    await page.goto(isMobile ? '/portfolio/?view=mobile-homepage' : '/portfolio/');

    const portfolioWindow = page.locator('[data-app-window]');
    const gameWindow = page.locator('[data-gomoku-window]');
    const portfolioTask = page.locator('[data-task-window]');
    const gameTask = page.locator('[data-gomoku-task]');
    const launcher = page.locator('[data-gomoku-launcher]');

    if (isMobile) {
        await page.evaluate(() => window.GomokuGame.open());
    } else {
        await expect(portfolioWindow).toHaveClass(/is-maximized/);
        await page.locator('[data-window-action="maximize"]').click();
        await expect(portfolioWindow).not.toHaveClass(/is-maximized/);
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
        const scorePanelBox = await page.locator('.gomoku-score-panel').boundingBox();
        for (const counter of await page.locator('.gomoku-counter').all()) {
            const counterBox = await counter.boundingBox();
            expect(counterBox.y).toBeGreaterThanOrEqual(scorePanelBox.y);
            expect(counterBox.y + counterBox.height).toBeLessThanOrEqual(
                scorePanelBox.y + scorePanelBox.height
            );
        }

        await expect(gameWindow).not.toHaveClass(/is-maximized/);

        const initialBox = await gameWindow.boundingBox();
        expect(initialBox.width).toBeGreaterThan(page.viewportSize().width - 16);

        const boardBeforeResize = await canvas.boundingBox();
        const resizeHandleBox = await page.locator('[data-gomoku-resize]').boundingBox();
        await page.mouse.move(
            resizeHandleBox.x + resizeHandleBox.width / 2,
            resizeHandleBox.y + resizeHandleBox.height / 2
        );
        await page.mouse.down();
        await page.mouse.move(
            resizeHandleBox.x + resizeHandleBox.width / 2 - 24,
            resizeHandleBox.y + resizeHandleBox.height / 2 - 32,
            { steps: 4 }
        );
        await page.mouse.up();
        await expect.poll(async () => (await canvas.boundingBox()).width).toBeLessThan(boardBeforeResize.width);

        const restoredBox = await gameWindow.boundingBox();
        expect(restoredBox.width).toBeLessThan(page.viewportSize().width);
        const titlebarBox = await page.locator('[data-gomoku-drag]').boundingBox();
        await page.mouse.move(titlebarBox.x + titlebarBox.width / 2, titlebarBox.y + titlebarBox.height / 2);
        await page.mouse.down();
        await page.mouse.move(
            titlebarBox.x + titlebarBox.width / 2 + 20,
            titlebarBox.y + titlebarBox.height / 2 + 24,
            { steps: 4 }
        );
        await page.mouse.up();
        const draggedBox = await gameWindow.boundingBox();
        expect(draggedBox.x).toBeGreaterThan(restoredBox.x);
        expect(draggedBox.y).toBeGreaterThan(restoredBox.y);

        await page.locator('[data-gomoku-window-action="maximize"]').click();
        await expect(gameWindow).toHaveClass(/is-maximized/);
        await page.locator('[data-gomoku-window-action="maximize"]').click();
        await expect(gameWindow).not.toHaveClass(/is-maximized/);
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
        const portfolioStatusBox = await page.locator('[data-app-window] .window-statusbar').boundingBox();
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

    await canvas.focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowDown');
    let keyboardState = JSON.parse(await page.evaluate(() => window.render_game_to_text()));
    expect(keyboardState.keyboardCursor).toEqual({ row: 8, col: 8 });
    await expect(canvas).toHaveAttribute('aria-label', /第 9 行，第 9 列，空位/);
    await page.keyboard.press('Enter');
    keyboardState = JSON.parse(await page.evaluate(() => window.render_game_to_text()));
    expect(keyboardState.phase).toBe('thinking');
    expect(keyboardState.moves[0]).toEqual({ row: 8, col: 8, player: 'human-black' });
    await page.evaluate(() => window.advanceTime(1000));
    await page.keyboard.press('Control+z');
    keyboardState = JSON.parse(await page.evaluate(() => window.render_game_to_text()));
    expect(keyboardState.moves).toHaveLength(0);

    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Space');
    keyboardState = JSON.parse(await page.evaluate(() => window.render_game_to_text()));
    expect(keyboardState.phase).toBe('thinking');
    expect(keyboardState.moves[0]).toEqual({ row: 8, col: 7, player: 'human-black' });
    await page.evaluate(() => window.advanceTime(1000));
    await page.keyboard.press('Control+z');
    keyboardState = JSON.parse(await page.evaluate(() => window.render_game_to_text()));
    expect(keyboardState.moves).toHaveLength(0);

    for (let index = 0; index < 16; index += 1) {
        await page.keyboard.press('ArrowUp');
        await page.keyboard.press('ArrowLeft');
    }
    keyboardState = JSON.parse(await page.evaluate(() => window.render_game_to_text()));
    expect(keyboardState.keyboardCursor).toEqual({ row: 0, col: 0 });
    for (let index = 0; index < 16; index += 1) {
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('ArrowRight');
    }
    keyboardState = JSON.parse(await page.evaluate(() => window.render_game_to_text()));
    expect(keyboardState.keyboardCursor).toEqual({ row: 14, col: 14 });
    await page.keyboard.press('F2');
    keyboardState = JSON.parse(await page.evaluate(() => window.render_game_to_text()));
    expect(keyboardState.keyboardCursor).toEqual({ row: 7, col: 7 });

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
    expect(thinkingState).toEqual({ phase: 'thinking', locked: true, thinking: true, cursor: 'default' });
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
    const scoreOutput = page.locator('[data-gomoku-score]');
    const movesOutput = page.locator('[data-gomoku-moves]');
    await expect(scoreOutput).toHaveText('0:0');

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
    expect(gameState.score).toEqual({ human: 1, computer: 0 });
    await expect(page.locator('[data-gomoku-status]')).toContainText('你赢了');
    await expect(movesOutput).toHaveText('008');
    await expect(scoreOutput).toHaveText('1:0');
    await expect(canvas).toHaveClass(/is-locked/);
    await expect(canvas).not.toHaveClass(/is-thinking/);
    expect(await canvas.evaluate((element) => window.getComputedStyle(element).cursor)).toBe('default');

    await page.locator('[data-gomoku-menu="game"]').click();
    await page.locator('[data-gomoku-undo]').click();
    gameState = JSON.parse(await page.evaluate(() => window.render_game_to_text()));
    expect(gameState.score).toEqual({ human: 0, computer: 0 });
    await expect(scoreOutput).toHaveText('0:0');
    await page.mouse.click(
        winningBoardBox.x + winningBoardBox.width / 2,
        winningBoardBox.y + winningBoardBox.height / 2
    );
    gameState = JSON.parse(await page.evaluate(() => window.render_game_to_text()));
    expect(gameState.score).toEqual({ human: 1, computer: 0 });
    await expect(scoreOutput).toHaveText('1:0');

    await page.locator('.gomoku-face').click();
    gameState = JSON.parse(await page.evaluate(() => window.render_game_to_text()));
    expect(gameState.phase).toBe('playing');
    expect(gameState.moves).toHaveLength(0);
    expect(gameState.score).toEqual({ human: 1, computer: 0 });
    await expect(movesOutput).toHaveText('000');
    await expect(scoreOutput).toHaveText('1:0');
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
    gameState = JSON.parse(await page.evaluate(() => window.render_game_to_text()));
    expect(gameState.score).toEqual({ human: 0, computer: 0 });
    await expect(scoreOutput).toHaveText('0:0');
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
    expect(sitemapText).toContain(`<lastmod>${buildMetadata.lastModified}</lastmod>`);

    await page.goto('/portfolio/');
    await expect(page.locator('link[href^="css/custom.css"]')).toHaveAttribute(
        'href',
        `css/custom.css?v=${buildMetadata.assetVersion}`
    );
    for (const script of await page.locator('script[src]').all()) {
        await expect(script).toHaveAttribute('src', new RegExp(`\\?v=${buildMetadata.assetVersion}$`));
    }
});

test('restarts the appropriate shell when crossing the responsive breakpoint', async ({ page, isMobile }) => {
    test.setTimeout(90000);

    if (isMobile) {
        await page.setViewportSize({ width: 844, height: 390 });
        await page.goto('/', { waitUntil: 'domcontentloaded' });
        await expect(page.locator('body')).toHaveClass(/mobile-mode/);
        await expect(page.locator('#mobile-entry')).toBeVisible();
        await expect(page.locator('#mobile-site')).toBeHidden();
        await expect(page.locator('canvas')).toHaveCount(0);
        return;
    }

    await page.setViewportSize({ width: 983, height: 754 });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('body')).not.toHaveClass(/mobile-mode/);
    await expect(page.locator('#computer-screen')).toHaveAttribute('src', 'portfolio/', { timeout: 45000 });

    const desktopPortfolio = page.frameLocator('#computer-screen');
    await desktopPortfolio.locator('[data-window-action="minimize"]').evaluate((button) => button.click());
    await desktopPortfolio.locator('.desktop-shortcut[data-open-mail-window]').evaluate((button) => button.click());
    await desktopPortfolio.locator('[data-mail-form] input[name="name"]').evaluate((field) => {
        field.value = 'Breakpoint visitor';
        field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await desktopPortfolio.locator('[data-mail-form] input[name="email"]').evaluate((field) => {
        field.value = 'breakpoint@example.com';
        field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await desktopPortfolio.locator('[data-mail-form] textarea[name="message"]').evaluate((field) => {
        field.value = 'Keep this across a shell reload.';
        field.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const mobileReload = page.waitForEvent('framenavigated', (frame) => frame === page.mainFrame());
    await page.setViewportSize({ width: 820, height: 754 });
    await mobileReload;
    await expect(page.locator('body')).toHaveClass(/mobile-mode/);
    await expect(page.locator('#mobile-entry')).toBeVisible();
    await expect(page.locator('#mobile-site')).toBeHidden();
    await expect(page.locator('canvas')).toHaveCount(0);
    await page.locator('[data-mobile-enter]').click();
    await expect(page.locator('#mobile-portfolio')).toHaveAttribute('src', 'portfolio/?view=mobile-homepage');
    const mobilePortfolio = page.frameLocator('#mobile-portfolio');
    await expect(mobilePortfolio.locator('body')).toHaveClass(/mobile-homepage/);
    await expect(mobilePortfolio.locator('[data-app-window]')).not.toHaveClass(/is-minimized|is-closed/);
    await expect(mobilePortfolio.locator('[data-app-window]')).toHaveClass(/is-active/);
    await expect(mobilePortfolio.locator('[data-direct-return]')).toBeHidden();
    await expect(mobilePortfolio.locator('[data-mail-form] input[name="name"]')).toHaveValue('Breakpoint visitor');
    await expect(mobilePortfolio.locator('[data-mail-form] input[name="email"]')).toHaveValue('breakpoint@example.com');
    await expect(mobilePortfolio.locator('[data-mail-form] textarea[name="message"]')).toHaveValue('Keep this across a shell reload.');

    const desktopReload = page.waitForEvent('framenavigated', (frame) => frame === page.mainFrame());
    await page.setViewportSize({ width: 983, height: 754 });
    await desktopReload;
    await expect(page.locator('body')).not.toHaveClass(/mobile-mode/);
    await expect(page.locator('#computer-screen')).toHaveAttribute('src', 'portfolio/', { timeout: 45000 });
});

test('serves the immersive desktop shell and lightweight mobile shell', async ({ page, isMobile }) => {
    test.setTimeout(90000);
    const immersiveChunkRequests = [];
    const videoRequests = [];
    page.on('request', (request) => {
        const path = new URL(request.url()).pathname;
        if (/\/[a-z0-9-]+\.[a-f0-9]+\.js$/.test(path) && !path.includes('/bundle.')) {
            immersiveChunkRequests.push(request.url());
        }
        if (request.url().includes('/textures/monitor/video/')) {
            videoRequests.push(request.url());
        }
    });
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    if (isMobile) {
        await expect(page.locator('body')).toHaveClass(/mobile-mode/);
        await expect(page.locator('#mobile-entry')).toBeVisible();
        await expect(page.locator('#mobile-entry')).toContainText('WARNING: This experience is best viewed on a desktop or laptop computer.');
        await expect(page.locator('#mobile-portfolio')).not.toHaveAttribute('src');
        await page.locator('[data-mobile-enter]').click();
        await expect(page.locator('#mobile-portfolio')).toBeVisible();
        await expect(page.locator('#mobile-portfolio')).toHaveAttribute('src', 'portfolio/?view=mobile-homepage');
        await expect(page.locator('canvas')).toHaveCount(0);
        const mobilePortfolio = page.frameLocator('#mobile-portfolio');
        await expect(mobilePortfolio.locator('body')).toHaveClass(/mobile-homepage/);
        await expect(mobilePortfolio.locator('[data-app-window]')).toBeVisible();
        await expect(mobilePortfolio.locator('[data-app-window]')).not.toHaveClass(/is-minimized|is-closed/);
        await expect(mobilePortfolio.locator('[data-app-window] > .window-menubar')).toBeVisible();
        await expect(mobilePortfolio.locator('[data-app-window] > .window-menubar [data-window-menu]')).toHaveCount(5);
        await expect(mobilePortfolio.locator('h1')).toContainText('智能系统');
        await expect(mobilePortfolio.locator('[data-direct-return]')).toBeHidden();

        await mobilePortfolio.locator('[data-window-action="minimize"]').click();
        await expect(mobilePortfolio.locator('[data-app-window]')).toHaveClass(/is-minimized/);
        await expect(mobilePortfolio.locator('.desktop-shortcuts')).toBeVisible();
        await expect(mobilePortfolio.locator('.desktop-shortcut')).toHaveCount(6);
        for (const icon of await mobilePortfolio.locator('.desktop-shortcut .shortcut-icon').all()) {
            await expect(icon).toBeVisible();
        }

        await mobilePortfolio.locator('[data-open-project-folder]').click();
        const folderWindow = mobilePortfolio.locator('[data-project-folder-window]');
        const desktop = mobilePortfolio.locator('[data-retro-desktop]');
        await expect(folderWindow).toBeVisible();
        const desktopBox = await desktop.boundingBox();
        const initialFolderBox = await folderWindow.boundingBox();
        expect(initialFolderBox.x).toBeGreaterThanOrEqual(desktopBox.x);
        expect(initialFolderBox.x + initialFolderBox.width).toBeLessThanOrEqual(desktopBox.x + desktopBox.width);

        const resizeBox = await mobilePortfolio.locator('[data-project-folder-resize]').boundingBox();
        await page.mouse.move(resizeBox.x + resizeBox.width / 2, resizeBox.y + resizeBox.height / 2);
        await page.mouse.down();
        await page.mouse.move(resizeBox.x - 70, resizeBox.y - 90);
        await page.mouse.up();
        const resizedFolderBox = await folderWindow.boundingBox();
        expect(resizedFolderBox.width).toBeLessThan(initialFolderBox.width);
        expect(resizedFolderBox.height).toBeLessThan(initialFolderBox.height);

        const folderTitlebar = mobilePortfolio.locator('[data-project-folder-drag]');
        const titlebarBox = await folderTitlebar.boundingBox();
        await page.mouse.move(titlebarBox.x + 80, titlebarBox.y + titlebarBox.height / 2);
        await page.mouse.down();
        await page.mouse.move(titlebarBox.x + 110, titlebarBox.y + 30);
        await page.mouse.up();
        const movedFolderBox = await folderWindow.boundingBox();
        expect(movedFolderBox.x).toBeGreaterThan(resizedFolderBox.x);
        expect(movedFolderBox.y).toBeGreaterThan(resizedFolderBox.y);

        await mobilePortfolio.locator('body').evaluate(() => window.dispatchEvent(new Event('pageshow')));
        await expect(mobilePortfolio.locator('[data-app-window]')).toBeVisible();
        await expect(mobilePortfolio.locator('[data-app-window]')).not.toHaveClass(/is-minimized|is-closed|is-maximized/);
        expect(immersiveChunkRequests).toHaveLength(0);
        expect(videoRequests).toHaveLength(0);
        return;
    }

    await expect(page.locator('.direct-entry')).toBeHidden();
    await expect(page.locator('.direct-entry')).toHaveAttribute('href', 'portfolio/');
    await expect(page.locator('.direct-entry')).toHaveClass(/scene-link/);
    await expect(page.locator('.direct-entry')).toHaveText('直接访问主页 / Visit homepage');
    await expect(page.locator('canvas').first()).toBeVisible({ timeout: 45000 });
    await expect(page.locator('#computer-screen')).toHaveAttribute('src', 'portfolio/', { timeout: 45000 });
    await expect(page.frameLocator('#computer-screen').locator('h1')).toContainText('智能系统', { timeout: 45000 });
    await expect(page.frameLocator('#computer-screen').locator('[data-app-window]')).not.toHaveClass(/is-maximized/);
    await expect(page.frameLocator('#computer-screen').locator('[data-direct-return]')).toBeHidden();
    expect(await page.locator('canvas').first().evaluate((canvas) => canvas.width > 0 && canvas.height > 0)).toBe(true);
    expect(immersiveChunkRequests.length).toBeGreaterThanOrEqual(2);
    const loadedVideoPaths = [...new Set(videoRequests.map((requestUrl) => new URL(requestUrl).pathname))].sort();
    expect(loadedVideoPaths).toEqual([
        '/textures/monitor/video/base-static.mp4',
        '/textures/monitor/video/static-texture-layer.mp4'
    ]);

    const layerOrder = await page.evaluate(() =>
        ['css', 'webgl', 'overlay', 'ui-interactive', 'ui'].map((id) =>
            Number.parseInt(getComputedStyle(document.getElementById(id)).zIndex, 10)
        )
    );
    expect(layerOrder).toEqual([0, 1, 2, 3, 4]);

    await page.locator('[data-start-scene]').click();
    await expect(page.locator('.direct-entry')).toBeVisible();
    const helpPrompt = page.locator('[data-help-prompt]');
    await expect(helpPrompt).toBeVisible({ timeout: 3000 });
    await expect(helpPrompt).toContainText('Click anywhere', { timeout: 15000 });
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

test('keeps the scene sharp without densifying film grain on high-DPI screens', async ({ browser, isMobile }) => {
    test.skip(isMobile, 'the mobile shell does not create WebGL renderers');
    test.setTimeout(60000);

    const context = await browser.newContext({
        baseURL: 'http://127.0.0.1:3090',
        viewport: { width: 1280, height: 720 },
        deviceScaleFactor: 2,
    });
    const page = await context.newPage();
    const browserErrors = [];
    page.on('console', (message) => {
        if (message.type() === 'error') browserErrors.push(`console: ${message.text()}`);
    });
    page.on('pageerror', (error) => browserErrors.push(`pageerror: ${error.message}`));

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#webgl canvas')).toBeVisible({ timeout: 45000 });
    await expect(page.locator('#overlay canvas')).toBeVisible({ timeout: 45000 });

    const readPixelRatios = () => page.evaluate(() => {
        const ratio = (selector) => {
            const canvas = document.querySelector(selector);
            return canvas.width / canvas.getBoundingClientRect().width;
        };
        return {
            webgl: ratio('#webgl canvas'),
            overlay: ratio('#overlay canvas'),
            overlayOpacity: Number.parseFloat(
                getComputedStyle(document.querySelector('#overlay canvas')).opacity
            ),
        };
    });

    await expect.poll(async () => readPixelRatios()).toEqual({ webgl: 2, overlay: 1, overlayOpacity: 0.02 });
    await page.setViewportSize({ width: 1366, height: 768 });
    await expect.poll(async () => readPixelRatios()).toEqual({ webgl: 2, overlay: 1, overlayOpacity: 0.02 });
    expect(browserErrors).toEqual([]);
    await context.close();
});

test('recovers from an immersive resource loading failure', async ({ page, isMobile }) => {
    test.skip(isMobile, 'the mobile shell does not load immersive resources');
    test.setTimeout(60000);

    let failResource = true;
    await page.route('**/models/World/environment.glb', async (route) => {
        if (failResource) {
            await route.fulfill({
                status: 200,
                contentType: 'model/gltf-binary',
                body: 'invalid glb',
            });
            return;
        }
        await route.continue();
    });

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    const errorPanel = page.locator('[data-resource-error]');
    await expect(errorPanel).toBeVisible({ timeout: 15000 });
    await expect(errorPanel).toContainText('3D 资源加载失败');
    await expect(page.locator('[data-resource-direct]')).toHaveAttribute('href', 'portfolio/');
    await expect(page.locator('[data-resource-retry]')).toBeVisible();

    failResource = false;
    await page.locator('[data-resource-retry]').click();
    await expect(page.locator('canvas').first()).toBeVisible({ timeout: 45000 });
    await expect(page.locator('[data-resource-error]')).toHaveCount(0);
    await expect(page.locator('[data-start-scene]')).toBeVisible({ timeout: 10000 });
});
