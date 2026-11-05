const { test, expect } = require('./fixtures/smoke.cjs');

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
    {
        OBJECT_NAME: 'ONEWEB-0123',
        OBJECT_ID: '2020-020A',
        NORAD_CAT_ID: 46001,
        MEAN_MOTION: 13.4,
        ECCENTRICITY: 0.0002,
        INCLINATION: 87.9,
        RA_OF_ASC_NODE: 20,
        ARG_OF_PERICENTER: 80,
        MEAN_ANOMALY: 110,
    },
    {
        OBJECT_NAME: 'BEIDOU-3 M25',
        OBJECT_ID: '2021-040A',
        NORAD_CAT_ID: 48001,
        MEAN_MOTION: 1.0027,
        ECCENTRICITY: 0.001,
        INCLINATION: 55,
        RA_OF_ASC_NODE: 70,
        ARG_OF_PERICENTER: 15,
        MEAN_ANOMALY: 60,
    },
    {
        OBJECT_NAME: 'COSMOS 2544 (GLONASS)',
        OBJECT_ID: '2019-075A',
        NORAD_CAT_ID: 44500,
        MEAN_MOTION: 2.13,
        ECCENTRICITY: 0.001,
        INCLINATION: 64.8,
        RA_OF_ASC_NODE: 110,
        ARG_OF_PERICENTER: 25,
        MEAN_ANOMALY: 90,
    },
    {
        OBJECT_NAME: 'GALILEO 27',
        OBJECT_ID: '2021-060A',
        NORAD_CAT_ID: 49001,
        MEAN_MOTION: 1.7,
        ECCENTRICITY: 0.0004,
        INCLINATION: 56,
        RA_OF_ASC_NODE: 150,
        ARG_OF_PERICENTER: 30,
        MEAN_ANOMALY: 130,
    },
    {
        OBJECT_NAME: 'IRIDIUM 180',
        OBJECT_ID: '2019-030A',
        NORAD_CAT_ID: 44001,
        MEAN_MOTION: 14.34,
        ECCENTRICITY: 0.0002,
        INCLINATION: 86.4,
        RA_OF_ASC_NODE: 190,
        ARG_OF_PERICENTER: 45,
        MEAN_ANOMALY: 170,
    },
    {
        OBJECT_NAME: 'NOAA 21',
        OBJECT_ID: '2022-150A',
        NORAD_CAT_ID: 54001,
        MEAN_MOTION: 14.2,
        ECCENTRICITY: 0.0003,
        INCLINATION: 98.7,
        RA_OF_ASC_NODE: 210,
        ARG_OF_PERICENTER: 55,
        MEAN_ANOMALY: 200,
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
    await expect(folderWindow).toContainText('RoboMaster 比赛记录');
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

    await expect(folderWindow).toContainText('C:\\GAVIN\\PROJECTS\\RoboMaster 比赛记录');
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
    const previousLabel = await imageButtons.nth(7).locator('[data-photo-label]').textContent();
    const previousPreviewPath = await imageButtons.nth(7).getAttribute('data-image-src');
    await page.keyboard.press('ArrowUp');
    await expect(previewWindow).toContainText(previousLabel);
    await expect(previewWindow.locator('[data-image-preview-image]')).toHaveAttribute('src', previousPreviewPath);
    await expect(previewWindow.locator('[data-image-counter]')).toHaveText('8 / 13');
    await expect(folderWindow.locator('[data-robomaster-image].is-selected')).toContainText(previousLabel);

    await page.keyboard.press('ArrowDown');
    await expect(previewWindow).toContainText('09 3号.jpg');
    await expect(previewWindow.locator('[data-image-counter]')).toHaveText('9 / 13');
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
    await expect(page.locator('[data-satellite-count]')).toHaveText('10', { timeout: 30000 });
    await expect(page.locator('[data-satellite-group-count="starlink"]')).toHaveText('1');
    await expect(page.locator('[data-satellite-group-count="oneweb"]')).toHaveText('1');
    await expect(page.locator('[data-satellite-group-count="stations"]')).toHaveText('1');
    await expect(page.locator('[data-satellite-group-count="gps"]')).toHaveText('1');
    await expect(page.locator('[data-satellite-group-count="beidou"]')).toHaveText('1');
    await expect(page.locator('[data-satellite-group-count="glonass"]')).toHaveText('1');
    await expect(page.locator('[data-satellite-group-count="galileo"]')).toHaveText('1');
    await expect(page.locator('[data-satellite-group-count="iridium"]')).toHaveText('1');
    await expect(page.locator('[data-satellite-group-count="weather"]')).toHaveText('1');
    await expect(page.locator('[data-satellite-group-count="other"]')).toHaveText('1');

    await page.locator('[data-satellite-search]').fill('25544');
    await page.locator('[data-satellite-search-button]').click();
    await expect(page.locator('[data-satellite-name]')).toHaveText('ISS (ZARYA)');
    await expect(page.locator('[data-satellite-norad]')).toHaveText('25544');
    await expect(page.locator('[data-satellite-altitude]')).not.toHaveText('-');
    await expect(page.locator('[data-satellite-speed]')).toContainText('km/s');
    await expect(page.locator('[data-satellite-position]')).toContainText('/');
    await expect(page.locator('[data-satellite-period]')).toHaveText(/min$/);
    await expect(page.locator('[data-satellite-inclination]')).toHaveText('51.64°');
    await expect(page.locator('[data-satellite-age]')).toHaveText(/天$/);
    await expect(page.locator('[data-satellite-group]')).toHaveText('空间站');
    await expect(page.locator('[data-satellite-group-tag]')).toHaveAttribute('data-category', 'stations');

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

test('runs the retro Gomoku desktop application', async ({ page, isMobile }) => {
    await page.clock.install({ time: new Date('2026-11-02T00:00:00Z') });
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
    await page.locator('[data-gomoku-mode="computer"]').click();
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

    // Keep the AI timer from racing the separate keyboard and state-inspection calls.
    await page.clock.pauseAt(new Date('2026-11-02T00:01:00Z'));
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
    await page.clock.runFor(1000);
    await page.keyboard.press('Control+z');
    keyboardState = JSON.parse(await page.evaluate(() => window.render_game_to_text()));
    expect(keyboardState.moves).toHaveLength(0);

    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Space');
    keyboardState = JSON.parse(await page.evaluate(() => window.render_game_to_text()));
    expect(keyboardState.phase).toBe('thinking');
    expect(keyboardState.moves[0]).toEqual({ row: 8, col: 7, player: 'human-black' });
    await page.clock.runFor(1000);
    await page.keyboard.press('Control+z');
    keyboardState = JSON.parse(await page.evaluate(() => window.render_game_to_text()));
    expect(keyboardState.moves).toHaveLength(0);
    await page.clock.resume();

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

    await page.locator('[data-taskbar-lang]').click();
    await expect(page.locator('[data-gomoku-drag]')).toContainText('Gomoku - GavinOS Games');
    await page.locator('[data-taskbar-lang]').click();
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
        await page.mouse.move(titlebar.x + 205, titlebar.y - 20, { steps: 4 });
        await page.mouse.up();
        const windowAfterDrag = await gameWindow.boundingBox();
        expect(windowAfterDrag.x).toBeLessThan(windowBeforeDrag.x - 20);
        expect(windowAfterDrag.y).toBeLessThanOrEqual(windowBeforeDrag.y - 8);

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
