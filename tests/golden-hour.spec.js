const { test, expect } = require('@playwright/test');

// Matches only the game's own address, not the redirects left at the Harbor Strike addresses.
const GAME_PAGE = (url) => new URL(url).pathname === '/games/golden-hour/';
// Stand-in for the game page: records the state messages the desktop sends over the sandbox bridge.
const GAME_STUB = '<!doctype html><meta charset="utf-8"><title>GOLDEN HOUR — Solstice Hotel</title><canvas tabindex="0"></canvas>'
    + '<script>window.lastState = null; addEventListener("message", (event) => {'
    + ' if (event.source === parent && event.data?.type === "game-state") window.lastState = event.data; });'
    + ' parent.postMessage({ source: "golden-hour", type: "ready" }, "*");'
    + ' parent.postMessage({ source: "golden-hour", type: "game-ready" }, "*");</script>';
const gameState = (page, key) => page.frames().find((frame) => GAME_PAGE(frame.url()))
    ?.evaluate((name) => window.lastState?.[name], key);

test('shows loading until the current game finishes initializing', async ({ page, isMobile }) => {
    test.skip(isMobile, 'phones do not load the game');
    await page.route(GAME_PAGE, (route) => route.fulfill({
        contentType: 'text/html',
        body: GAME_STUB.replace(' parent.postMessage({ source: "golden-hour", type: "game-ready" }, "*");', '')
    }));
    await page.goto('/portfolio/');
    await page.locator('[data-window-action="minimize"]').click();
    await page.locator('.desktop-shortcut[data-open-golden-hour]').click();
    const status = page.locator('[data-golden-status]');
    await expect.poll(() => gameState(page, 'hidden')).toBe(false);
    await expect(status).toHaveText('正在载入至日酒店...');
    await page.evaluate(() => window.postMessage({ source: 'golden-hour', type: 'game-ready' }, '*'));
    await expect(status).toHaveText('正在载入至日酒店...');
    const frame = page.frames().find((candidate) => GAME_PAGE(candidate.url()));
    await frame.evaluate(() => parent.postMessage({ source: 'golden-hour', type: 'game-ready' }, '*'));
    await expect(status).toHaveText('点击画面锁定鼠标 · Esc 释放鼠标');
});

test('ships Golden Hour without the copy label or ULTRA preset, and redirects Harbor Strike', async ({ request }) => {
    const page = await request.get('/games/golden-hour/');
    expect(page.ok()).toBe(true);
    const html = await page.text();
    expect(html).toContain('<title>GOLDEN HOUR — Solstice Hotel</title>');
    expect(html).not.toContain('(Copy)');
    // Desktop bridge: sandbox state by message, settings saved through the desktop, a speaker
    // gain for mute, paced frames, and a loader that waits for the saved settings.
    expect(html).toContain("state.type !== 'game-state'");
    expect(html).toContain("type: 'storage'");
    expect(html).toContain('AudioNode.prototype.connect = function');
    expect(html).toContain('window.__goldenHourShouldRender =');
    expect(html).toContain('window.__goldenHourClockEpoch');
    expect(html).toContain("window.__goldenHourReady.then(");
    expect(html).toContain('请使用电脑打开');

    const game = await request.get('/games/golden-hour/dist/game.js');
    expect(game.ok()).toBe(true);
    const code = await game.text();
    expect(code).toContain('opts:[["low","LOW"],["medium","MEDIUM"],["high","HIGH"]]');
    expect(code).not.toContain('["ultra","ULTRA"]');
    expect(code).toContain('["low","medium","high"].includes(_s.quality)||(_s.quality=Ib.quality);');
    // Medium is the default preset; three.js skips its synchronous shader checks.
    expect(code).toContain('quality:"medium",motionBlur:"high"');
    expect(code).toContain('this.debug={checkShaderErrors:!1,onShaderError:null}');

    for (const old of ['/games/harbor-strike/', '/portfolio/games/harbor-strike/']) {
        expect(await (await request.get(old)).text()).toContain('golden-hour/');
    }
});

test('mutes Golden Hour with the system audio toggle', async ({ page, isMobile }) => {
    test.skip(isMobile, 'phones get the use-a-computer notice instead');
    // Embeds the desktop the way the 3D scene does, so the taskbar mute toggle is active.
    await page.route('**/game-harness', (route) => route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: '<!doctype html><iframe id="desk" src="/portfolio/" style="width:1366px;height:768px;border:0"></iframe>'
    }));
    await page.route(GAME_PAGE, (route) => route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: GAME_STUB
    }));
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.goto('/game-harness');
    const desktop = page.frameLocator('#desk');
    const setSystemMute = (muted) => page.evaluate((value) => {
        document.getElementById('desk').contentWindow.postMessage(
            { source: 'gavin-shell', type: 'audio-mute-state', muted: value }, location.origin);
    }, muted);
    const gameMuted = () => gameState(page, 'muted');

    await desktop.locator('[data-window-action="minimize"]').click();
    await setSystemMute(true);
    await expect(desktop.locator('[data-audio-toggle]')).toHaveAttribute('aria-pressed', 'true');
    await desktop.locator('.desktop-shortcut[data-open-golden-hour]').click();
    await expect(desktop.locator('[data-golden-status]')).toHaveText('点击画面锁定鼠标 · Esc 释放鼠标');
    await expect.poll(gameMuted).toBe(true);

    await setSystemMute(false);
    await expect.poll(gameMuted).toBe(false);
    await setSystemMute(true);
    await expect.poll(gameMuted).toBe(true);
});

test('holds Golden Hour drawing when it is not in front and tells the 3D scene while it runs', async ({ page, isMobile }) => {
    test.skip(isMobile, 'phones get the use-a-computer notice instead');
    await page.route('**/game-harness', (route) => route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: `<!doctype html><iframe id="desk" src="/portfolio/" style="width:1366px;height:768px;border:0"></iframe>
            <script>window.heavyApp = []; addEventListener('message', (event) => {
                if (event.data?.type === 'heavy-app-state') window.heavyApp.push(event.data.active);
            });</script>`
    }));
    await page.route(GAME_PAGE, (route) => route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: GAME_STUB
    }));
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.goto('/game-harness');
    const desktop = page.frameLocator('#desk');
    const heavyApp = () => page.evaluate(() => window.heavyApp);
    const held = () => gameState(page, 'hold');
    const setMonitorView = (active) => page.evaluate((value) => {
        document.getElementById('desk').contentWindow.postMessage(
            { source: 'gavin-shell', type: 'portfolio-view-state', active: value }, location.origin);
    }, active);

    await desktop.locator('[data-window-action="minimize"]').click();
    await desktop.locator('.desktop-shortcut[data-open-golden-hour]').click();
    await expect(desktop.locator('[data-golden-status]')).toHaveText('点击画面锁定鼠标 · Esc 释放鼠标');
    await expect.poll(heavyApp).toEqual([true]);
    await expect.poll(held).toBe(false);

    await desktop.locator('.desktop-shortcut[data-open-project-folder]').click();
    await expect.poll(held).toBe(true);
    await desktop.locator('[data-golden-task]').click();
    await expect.poll(held).toBe(false);

    await setMonitorView(false);
    await expect.poll(held).toBe(true);
    await setMonitorView(true);
    await expect.poll(held).toBe(false);

    await desktop.locator('[data-golden-action="minimize"]').click();
    await expect.poll(heavyApp).toEqual([true, false]);
    await desktop.locator('[data-golden-task]').click();
    await expect.poll(heavyApp).toEqual([true, false, true]);
    await desktop.locator('.window-controls [data-golden-action="close"]').click();
    await expect.poll(heavyApp).toEqual([true, false, true, false]);
});

test('slows the 3D room while Golden Hour runs on the settled monitor', async ({ page, isMobile }) => {
    test.skip(isMobile, 'the mobile shell does not create the 3D monitor');
    test.setTimeout(90000);
    await page.route(GAME_PAGE, (route) => route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: GAME_STUB
    }));
    // Counts animation frames in which the room's own WebGL contexts drew anything.
    await page.addInitScript(() => {
        window.roomFrames = 0;
        let drewThisFrame = false;
        for (const proto of [WebGLRenderingContext.prototype, WebGL2RenderingContext.prototype]) {
            for (const name of ['drawElements', 'drawArrays']) {
                const original = proto[name];
                proto[name] = function (...args) {
                    drewThisFrame = true;
                    return original.apply(this, args);
                };
            }
        }
        const count = () => {
            if (drewThisFrame) window.roomFrames += 1;
            drewThisFrame = false;
            requestAnimationFrame(count);
        };
        requestAnimationFrame(count);
    });
    const roomFps = async () => {
        const sample = () => page.evaluate(() => ({ frames: window.roomFrames, time: performance.now() }));
        const start = await sample();
        await page.waitForTimeout(2000);
        const end = await sample();
        return (end.frames - start.frames) * 1000 / (end.time - start.time);
    };

    await page.goto('/');
    const screen = page.locator('#computer-screen');
    await expect(screen).toHaveAttribute('src', 'portfolio/', { timeout: 45000 });
    await page.locator('[data-start-scene]').click();
    await expect(page.locator('[data-help-prompt]')).toContainText('Click anywhere', { timeout: 15000 });
    const viewport = page.viewportSize();
    await page.mouse.click(viewport.width / 2, viewport.height / 2);
    await page.waitForTimeout(2200);
    const screenBefore = await screen.boundingBox();
    await page.mouse.move(screenBefore.x + screenBefore.width / 2, screenBefore.y + screenBefore.height / 2);
    await expect.poll(async () => (await screen.boundingBox()).width, { timeout: 10000 })
        .toBeGreaterThan(screenBefore.width * 1.5);
    await page.waitForTimeout(2500);
    const settledFps = await roomFps();

    const desktop = page.frameLocator('#computer-screen');
    await desktop.locator('[data-window-action="minimize"]').click();
    await desktop.locator('.desktop-shortcut[data-open-golden-hour]').click();
    await expect(desktop.locator('[data-golden-window]')).toBeVisible();
    await expect(desktop.locator('[data-golden-status]')).toHaveText('点击画面锁定鼠标 · Esc 释放鼠标');
    const gameFps = await roomFps();
    expect(gameFps).toBeLessThanOrEqual(11);

    await desktop.locator('.window-controls [data-golden-action="close"]').click();
    await expect(desktop.locator('[data-golden-window]')).toBeHidden();
    // Software-rendered browsers may not draw the room much faster than the throttle anyway.
    if (settledFps >= 20) expect(await roomFps()).toBeGreaterThan(15);
});

test('runs Golden Hour as a lazy desktop window and unloads it on close', async ({ page, isMobile }) => {
    test.skip(isMobile, 'phones get the use-a-computer notice instead');
    // The real game needs a GPU; software WebGL in CI takes far longer to start than the window logic under test.
    const gameRequests = [];
    await page.context().route(GAME_PAGE, (route) => {
        gameRequests.push(route.request().url());
        return route.fulfill({
            contentType: 'text/html; charset=utf-8',
            body: GAME_STUB
        });
    });
    await page.goto('/portfolio/');
    const gameWindow = page.locator('[data-golden-window]');
    const task = page.locator('[data-golden-task]');
    const frame = gameWindow.locator('iframe.golden-frame');
    const status = page.locator('[data-golden-status]');
    await expect(gameWindow).toHaveClass(/is-closed/);
    expect(gameRequests).toHaveLength(0);

    await page.locator('[data-window-action="minimize"]').click();
    await page.locator('.desktop-shortcut[data-open-golden-hour]').click();
    await expect(gameWindow).toBeVisible();
    await expect(task).toBeVisible();
    await expect(task).toHaveClass(/is-active/);
    await expect(page.locator('[data-golden-phone]')).toBeHidden();
    await expect(frame).toHaveAttribute('src', '../games/golden-hour/');
    await expect(status).toHaveText('点击画面锁定鼠标 · Esc 释放鼠标');
    await expect(page.locator('[data-golden-loading]')).toBeHidden();
    await expect(page.frameLocator('iframe.golden-frame').locator('canvas')).toBeAttached();
    await expect(frame).toBeFocused();

    await gameWindow.locator('[data-golden-action="minimize"]').click();
    await expect(gameWindow).toHaveClass(/is-minimized/);
    await expect.poll(() => gameState(page, 'hidden')).toBe(true);
    await task.click();
    await expect(gameWindow).toBeVisible();
    await expect.poll(() => gameState(page, 'hidden')).toBe(false);
    expect(gameRequests).toHaveLength(1);

    await page.locator('[data-taskbar-lang]').click();
    await expect(task).toContainText('Golden Hour');
    await expect(status).toHaveText('Click the view to lock the mouse · Esc to release');
    await expect(gameWindow.locator('[data-golden-open-link]')).toHaveAttribute('title', 'Open in new tab');
    await page.locator('[data-taskbar-lang]').click();

    await gameWindow.locator('.window-controls [data-golden-action="close"]').click();
    await expect(gameWindow).toHaveClass(/is-closed/);
    await expect(task).toBeHidden();
    await expect(frame).toHaveCount(0);

    // The pop-out button plays the game at its own address and closes the in-window copy.
    await page.locator('.desktop-shortcut[data-open-golden-hour]').click();
    await expect(frame).toHaveCount(1);
    const openLink = gameWindow.locator('[data-golden-open-link]');
    await expect(openLink).toBeVisible();
    await expect(openLink).toHaveAttribute('target', '_blank');
    const popupPromise = page.waitForEvent('popup');
    await openLink.click();
    const popup = await popupPromise;
    await expect(popup).toHaveURL(/^http:\/\/[^/]+\/games\/golden-hour\/$/);
    await expect(gameWindow).toHaveClass(/is-closed/);
    await expect(frame).toHaveCount(0);
    await popup.close();
});

test('asks phone visitors to open Golden Hour on a computer', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'computers load the game');
    const gameRequests = [];
    page.on('request', (request) => {
        const path = new URL(request.url()).pathname;
        if (path === '/games/golden-hour/' || path.startsWith('/games/golden-hour/dist/')) gameRequests.push(request.url());
    });
    await page.goto('/portfolio/');
    const gameWindow = page.locator('[data-golden-window]');
    await page.locator('[data-window-action="minimize"]').click();
    await page.locator('.desktop-shortcut[data-open-golden-hour]').click();
    await expect(gameWindow).toBeVisible();
    await expect(page.locator('[data-golden-phone]')).toBeVisible();
    await expect(page.locator('[data-golden-phone]')).toContainText('请使用电脑打开');
    await expect(gameWindow.locator('iframe')).toHaveCount(0);
    await expect(gameWindow.locator('[data-menu-action="golden-open-tab"]')).toBeHidden();
    expect(gameRequests).toHaveLength(0);

    const scriptRequests = [];
    page.on('request', (request) => {
        if (request.url().includes('/games/golden-hour/dist/')) scriptRequests.push(request.url());
    });
    await page.goto('/games/golden-hour/');
    await expect(page.locator('.gh-phone-notice')).toBeVisible();
    await expect(page.locator('.gh-phone-notice')).toContainText('请使用电脑打开');
    await expect(page.locator('body > :not(.gh-phone-notice):not(script):not(style):not(title)').first()).toBeHidden();
    expect(scriptRequests).toHaveLength(0);
});

test('redirects the old Harbor Strike addresses to Golden Hour', async ({ page }) => {
    await page.route(GAME_PAGE, (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: GAME_STUB }));
    for (const old of ['/games/harbor-strike/', '/portfolio/games/harbor-strike/']) {
        await page.goto(old);
        await expect.poll(() => new URL(page.url()).pathname).toBe('/games/golden-hour/');
        await expect(page).toHaveTitle('GOLDEN HOUR — Solstice Hotel');
    }
});

test('mutes Golden Hour from the taskbar on the directly opened desktop', async ({ page, isMobile }) => {
    test.skip(isMobile, 'phones get the use-a-computer notice instead');
    await page.route(GAME_PAGE, (route) => route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: GAME_STUB
    }));
    await page.goto('/portfolio/');
    const audioToggle = page.locator('[data-audio-toggle]');
    const gameMuted = () => gameState(page, 'muted');
    await expect(audioToggle).toBeVisible();
    await expect(audioToggle).toHaveAttribute('aria-pressed', 'false');
    await expect(audioToggle).toHaveAttribute('title', '静音');

    // Muted before the game opens: it starts muted.
    await audioToggle.click();
    await expect(audioToggle).toHaveAttribute('aria-pressed', 'true');
    await expect(audioToggle).toHaveAttribute('title', '取消静音');
    await expect(page.locator('[data-audio-toggle-icon]')).toHaveAttribute('src', '../textures/UI/volume_off.svg');
    await page.locator('[data-window-action="minimize"]').click();
    await page.locator('.desktop-shortcut[data-open-golden-hour]').click();
    await expect(page.locator('[data-golden-status]')).toHaveText('点击画面锁定鼠标 · Esc 释放鼠标');
    await expect.poll(gameMuted).toBe(true);

    await audioToggle.click();
    await expect.poll(gameMuted).toBe(false);
    await page.locator('[data-taskbar-lang]').click();
    await expect(audioToggle).toHaveAttribute('title', 'Mute sound');
    await audioToggle.click();
    await expect.poll(gameMuted).toBe(true);
    await expect(audioToggle).toHaveAttribute('title', 'Unmute sound');
});

test('runs the game in a sandboxed frame that still loads and reports ready', async ({ page, isMobile }) => {
    test.skip(isMobile, 'phones get the use-a-computer notice instead');
    // In Chrome the opaque-origin frame gets its own process, so a heavy startup (here three
    // seconds of busy work) no longer stalls the desktop. Playwright's bundled Chromium does not
    // isolate frames, so this checks the frame setup and the message handshake.
    await page.route(GAME_PAGE, (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: GAME_STUB }));
    await page.goto('/portfolio/');
    await page.locator('[data-window-action="minimize"]').click();
    await page.locator('.desktop-shortcut[data-open-golden-hour]').click();
    const frame = page.locator('iframe.golden-frame');
    await expect(frame).toHaveAttribute('sandbox', 'allow-scripts allow-pointer-lock');
    await expect(page.locator('[data-golden-status]')).toHaveText('点击画面锁定鼠标 · Esc 释放鼠标');
    const gameFrame = page.frames().find((candidate) => GAME_PAGE(candidate.url()));
    expect(await gameFrame.evaluate(() => window.origin)).toBe('null');
    await expect.poll(() => gameFrame.evaluate(() => window.lastState && {
        hidden: window.lastState.hidden, hold: window.lastState.hold, muted: window.lastState.muted
    })).toEqual({ hidden: false, hold: false, muted: false });
    // The game page saves its settings through the desktop, which keeps them for the next launch.
    await gameFrame.evaluate(() => parent.postMessage({ source: 'golden-hour', type: 'storage',
        value: { 'golden-hour-settings-v1': '{"quality":"medium"}', 'unrelated-key': 'ignored' } }, '*'));
    await expect.poll(() => page.evaluate(() => localStorage.getItem('golden-hour-settings-v1'))).toBe('{"quality":"medium"}');
    expect(await page.evaluate(() => localStorage.getItem('unrelated-key'))).toBeNull();
    await page.locator('.window-controls [data-golden-action="close"]').click();
    await page.locator('.desktop-shortcut[data-open-golden-hour]').click();
    await expect.poll(() => gameState(page, 'storage')).toEqual({ 'golden-hour-settings-v1': '{"quality":"medium"}' });
});

test('dismisses the desktop robot when Golden Hour opens without restoring it on close', async ({ page, isMobile }) => {
    test.skip(isMobile, 'the robot only walks on the desktop layout');
    await page.clock.install();
    await page.route(GAME_PAGE, (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: GAME_STUB }));
    await page.goto('/portfolio/');
    await page.locator('[data-window-action="minimize"]').click();
    const pet = page.locator('[data-desktop-pet]');
    await page.locator('[data-start-toggle]').click();
    await page.locator('[data-pet-toggle]').click();
    await expect(pet).toBeVisible();

    await page.locator('.desktop-shortcut[data-open-golden-hour]').click();
    await expect(page.locator('iframe.golden-frame')).toHaveCount(1);
    await expect(pet).toBeHidden();
    // Minimizing keeps the game open, so the robot stays away.
    await page.locator('[data-golden-action="minimize"]').click();
    await expect(pet).toBeHidden();

    await page.locator('[data-golden-task]').click();
    await page.locator('.window-controls [data-golden-action="close"]').click();
    await expect(pet).toBeHidden();
    await expect(page.locator('[data-pet-toggle]')).toHaveAttribute('aria-expanded', 'false');
    await page.locator('.desktop-shortcut[data-open-window]').click();
    await page.clock.runFor(11000);
    await expect(pet).toBeHidden();

    await page.locator('[data-start-toggle]').click();
    await page.locator('[data-pet-toggle]').click();
    await expect(pet).toBeVisible();
});

test('keeps the robot from appearing on its own while Golden Hour is open', async ({ page, isMobile }) => {
    test.skip(isMobile, 'the robot only walks on the desktop layout');
    await page.clock.install();
    await page.route(GAME_PAGE, (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: GAME_STUB }));
    await page.goto('/portfolio/');
    // The robot introduces itself ten seconds after the homepage shows; the homepage stays open here.
    await page.locator('.desktop-shortcut[data-open-golden-hour]').evaluate((button) => button.click());
    await expect(page.locator('iframe.golden-frame')).toHaveCount(1);
    await page.locator('[data-app-window]').evaluate((element) => element.dispatchEvent(new Event('pointerdown', { bubbles: true })));
    await page.clock.runFor(15000);
    await expect(page.locator('[data-desktop-pet]')).toBeHidden();

    // The homepage is in front now, so close the game window from its button directly.
    await page.locator('.window-controls [data-golden-action="close"]').evaluate((button) => button.click());
    await page.clock.runFor(11000);
    await expect(page.locator('[data-desktop-pet]')).toBeVisible();
});
