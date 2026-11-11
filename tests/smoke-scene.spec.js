const { test, expect } = require('./fixtures/smoke.cjs');

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

test('syncs the desktop taskbar background music mute control with the immersive shell', async ({ page, isMobile }) => {
    test.skip(isMobile, 'the mobile shell does not load background audio');
    test.setTimeout(60000);
    await page.goto('/');
    await expect(page.locator('canvas').first()).toBeVisible({ timeout: 45000 });

    await page.evaluate(() => {
        window.__lastMuteState = null;
        document.addEventListener('muteToggle', (event) => {
            window.__lastMuteState = event.detail;
        });
    });

    const taskbarAudio = page.frameLocator('#computer-screen').locator('[data-audio-toggle]');
    await expect(taskbarAudio).toBeVisible({ timeout: 45000 });
    await expect(taskbarAudio).toHaveAttribute('aria-pressed', 'false');
    await taskbarAudio.evaluate((button) => button.click());

    await expect(taskbarAudio).toHaveAttribute('aria-pressed', 'true');
    await expect(taskbarAudio.locator('img')).toHaveAttribute('src', '../textures/UI/volume_off.svg');
    await expect.poll(() => page.evaluate(() => window.__lastMuteState)).toBe(true);

    await taskbarAudio.evaluate((button) => button.click());
    await expect(taskbarAudio).toHaveAttribute('aria-pressed', 'false');
    await expect(taskbarAudio.locator('img')).toHaveAttribute('src', '../textures/UI/volume_on.svg');
    await expect.poll(() => page.evaluate(() => window.__lastMuteState)).toBe(false);
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
    await expect.poll(() => page.evaluate(() => window.__gavinDrawCalls)).toBeGreaterThan(0);

    const countAtPause = await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, value: true });
        document.dispatchEvent(new Event('visibilitychange'));
        return window.__gavinDrawCalls;
    });
    await page.waitForTimeout(100);
    expect(await page.evaluate(() => window.__gavinDrawCalls)).toBe(countAtPause);

    await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, value: false });
        document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect.poll(() => page.evaluate(() => window.__gavinDrawCalls)).toBeGreaterThan(countAtPause);
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
        await expect(mobilePortfolio.locator('.desktop-shortcut')).toHaveCount(9);
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
        await expect(mobilePortfolio.locator('[data-app-window]')).toHaveClass(/is-minimized/);
        await expect(folderWindow).toBeVisible();
        await expect(folderWindow).toHaveClass(/is-active/);
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

    await computerFrame.locator('[data-window-action="minimize"]').evaluate(button => button.click());
    const originalTaskbar = await computerFrame.locator('.desktop-taskbar').evaluate(element =>
        element.getBoundingClientRect().toJSON()
    );
    for (const [shortcut, windowSelector, task, focusTarget, edge] of [
        ['[data-open-mail-window]', '[data-mail-window]', '[data-mail-task]', '[data-mail-send]', 'right'],
        ['[data-open-gomoku]', '[data-gomoku-window]', '[data-gomoku-task]', '[data-gomoku-mode="local"]', 'left']
    ]) {
        await computerFrame.locator(`.desktop-shortcut${shortcut}`).evaluate(button => button.click());
        await expect(computerFrame.locator(focusTarget)).toBeVisible();
        // Reproduce a window left partly beyond the screen after an edge drag.
        await computerFrame.locator(windowSelector).evaluate((element, edge) => {
            element.style.left = `${edge === 'right' ? window.innerWidth - 160 : 160 - element.offsetWidth}px`;
            element.style.top = `${window.innerHeight - 80}px`;
        }, edge);
        await computerFrame.locator(task).evaluate(button => {
            button.click();
            button.click();
        });
        await computerFrame.locator(focusTarget).evaluate(element => {
            element.focus();
            element.scrollIntoView({ block: 'center' });
        });

        expect(await page.locator('#css > div').evaluate(element =>
            [element.scrollLeft, element.scrollTop]
        )).toEqual([0, 0]);
        expect(await computerFrame.locator('[data-retro-desktop]').evaluate(element =>
            [window.scrollX, window.scrollY, element.scrollLeft, element.scrollTop]
        )).toEqual([0, 0, 0, 0]);
        expect(await computerFrame.locator('.desktop-taskbar').evaluate(element =>
            element.getBoundingClientRect().toJSON()
        )).toEqual(originalTaskbar);
    }
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
    await expect(errorPanel).not.toContainText('3D 场景加载失败');
    await expect(errorPanel.locator('a')).toHaveCount(0);
    await expect(page.locator('[data-resource-retry]')).toBeVisible();

    failResource = false;
    await page.locator('[data-resource-retry]').click();
    await expect(page.locator('canvas').first()).toBeVisible({ timeout: 45000 });
    await expect(page.locator('[data-resource-error]')).toHaveCount(0);
    await expect(page.locator('[data-start-scene]')).toBeVisible({ timeout: 10000 });
});
