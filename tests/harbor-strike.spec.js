const { test, expect } = require('@playwright/test');

// Matches only the game's own address, not the redirect left at /portfolio/games/harbor-strike/.
const GAME_PAGE = (url) => new URL(url).pathname === '/games/harbor-strike/';
// Stand-in for the game page: records the state messages the desktop sends over the sandbox bridge.
const GAME_STUB = '<!doctype html><meta charset="utf-8"><title>港区突击 Harbor Strike</title><canvas id="view" tabindex="0"></canvas>'
    + '<script>window.lastState = null; addEventListener("message", (event) => {'
    + ' if (event.source === parent && event.data?.type === "harbor-strike-state") window.lastState = event.data; });'
    + ' parent.postMessage({ source: "harbor-strike", type: "ready" }, "*");</script>';
const gameState = (page, key) => page.frames().find((frame) => GAME_PAGE(frame.url()))
    ?.evaluate((name) => window.lastState?.[name], key);

test('ships Harbor Strike without the original author branding', async ({ request }) => {
    const response = await request.get('/games/harbor-strike/');
    expect(response.ok()).toBe(true);
    const html = await response.text();
    expect(html).toContain('<title>港区突击 Harbor Strike</title>');
    for (const removed of ['几猫', '猫', '3A大作', '各位老师', 'Fable5.2', '项目介绍', 'data-act="about"', 'data-tab="about"']) {
        expect(html).not.toContain(removed);
    }
    // "高" is the highest quality; the master gain obeys the desktop mute flag; frames are paced.
    expect(html).toContain('dM=["low","medium","high"]');
    expect(html).not.toContain('极高');
    expect(html).not.toContain('name:"ultra"');
    expect(html.split('w.gain.value=window.__harborStrikeMuted?0:me').length - 1).toBe(2);
    expect(html).toContain('if(document.hidden)return;if(window.__harborStrikeHold){');
    // Inside the window the page is sandboxed: state arrives by message and settings save through the desktop.
    expect(html).toContain("state.type !== 'harbor-strike-state'");
    expect(html).toContain('(window.__harborStrikeStore||localStorage).getItem(fM)');
    // While drawing is held the audio mixer still runs, so a paused round fades its sound.
    expect(html).toContain('u("audio",Math.min(d,.05))');
    expect(html).toContain('if(h-l<(q?30:13))return;');
    // Window resizes settle before the render targets are rebuilt.
    expect(html).toContain('N._rt=setTimeout(');
    // Image quality is untouched: native retina output and the original pixel budgets.
    expect(html).toContain('X=Math.min(window.devicePixelRatio||1,2)');
    expect(html).toContain('$={low:1e6,medium:15e5,high:23e5}');
});

test('mutes Harbor Strike with the system audio toggle', async ({ page, isMobile }) => {
    test.skip(isMobile, 'phones get the use-a-computer notice instead');
    // Embeds the desktop the way the 3D scene does, so the taskbar mute toggle is active.
    await page.route('**/harbor-strike-harness', (route) => route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: '<!doctype html><iframe id="desk" src="/portfolio/" style="width:1366px;height:768px;border:0"></iframe>'
    }));
    await page.route(GAME_PAGE, (route) => route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: GAME_STUB
    }));
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.goto('/harbor-strike-harness');
    const desktop = page.frameLocator('#desk');
    const setSystemMute = (muted) => page.evaluate((value) => {
        document.getElementById('desk').contentWindow.postMessage(
            { source: 'gavin-shell', type: 'audio-mute-state', muted: value }, location.origin);
    }, muted);
    const gameMuted = () => gameState(page, 'muted');

    await desktop.locator('[data-window-action="minimize"]').click();
    await setSystemMute(true);
    await expect(desktop.locator('[data-audio-toggle]')).toHaveAttribute('aria-pressed', 'true');
    await desktop.locator('.desktop-shortcut[data-open-harbor-strike]').click();
    await expect(desktop.locator('[data-harbor-status]')).toHaveText('点击画面锁定鼠标 · Esc 释放鼠标');
    await expect.poll(gameMuted).toBe(true);

    await setSystemMute(false);
    await expect.poll(gameMuted).toBe(false);
    await setSystemMute(true);
    await expect.poll(gameMuted).toBe(true);
});

test('holds Harbor Strike drawing when it is not in front and tells the 3D scene while it runs', async ({ page, isMobile }) => {
    test.skip(isMobile, 'phones get the use-a-computer notice instead');
    await page.route('**/harbor-strike-harness', (route) => route.fulfill({
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
    await page.goto('/harbor-strike-harness');
    const desktop = page.frameLocator('#desk');
    const heavyApp = () => page.evaluate(() => window.heavyApp);
    const held = () => gameState(page, 'hold');
    const setMonitorView = (active) => page.evaluate((value) => {
        document.getElementById('desk').contentWindow.postMessage(
            { source: 'gavin-shell', type: 'portfolio-view-state', active: value }, location.origin);
    }, active);

    await desktop.locator('[data-window-action="minimize"]').click();
    await desktop.locator('.desktop-shortcut[data-open-harbor-strike]').click();
    await expect(desktop.locator('[data-harbor-status]')).toHaveText('点击画面锁定鼠标 · Esc 释放鼠标');
    await expect.poll(heavyApp).toEqual([true]);
    await expect.poll(held).toBe(false);

    await desktop.locator('.desktop-shortcut[data-open-project-folder]').click();
    await expect.poll(held).toBe(true);
    await desktop.locator('[data-harbor-task]').click();
    await expect.poll(held).toBe(false);

    await setMonitorView(false);
    await expect.poll(held).toBe(true);
    await setMonitorView(true);
    await expect.poll(held).toBe(false);

    await desktop.locator('[data-harbor-action="minimize"]').click();
    await expect.poll(heavyApp).toEqual([true, false]);
    await desktop.locator('[data-harbor-task]').click();
    await expect.poll(heavyApp).toEqual([true, false, true]);
    await desktop.locator('.window-controls [data-harbor-action="close"]').click();
    await expect.poll(heavyApp).toEqual([true, false, true, false]);
});

test('slows the 3D room while Harbor Strike runs on the settled monitor', async ({ page, isMobile }) => {
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
        const start = await page.evaluate(() => window.roomFrames);
        await page.waitForTimeout(2000);
        return ((await page.evaluate(() => window.roomFrames)) - start) / 2;
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
    await desktop.locator('.desktop-shortcut[data-open-harbor-strike]').click();
    await expect(desktop.locator('[data-harbor-window]')).toBeVisible();
    const gameFps = await roomFps();
    expect(gameFps).toBeLessThanOrEqual(11);

    await desktop.locator('.window-controls [data-harbor-action="close"]').click();
    await expect(desktop.locator('[data-harbor-window]')).toBeHidden();
    // Software-rendered browsers may not draw the room much faster than the throttle anyway.
    if (settledFps >= 20) expect(await roomFps()).toBeGreaterThan(15);
});

test('runs Harbor Strike as a lazy desktop window and unloads it on close', async ({ page, isMobile }) => {
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
    const gameWindow = page.locator('[data-harbor-window]');
    const task = page.locator('[data-harbor-task]');
    const frame = gameWindow.locator('iframe.harbor-frame');
    const status = page.locator('[data-harbor-status]');
    await expect(gameWindow).toHaveClass(/is-closed/);
    expect(gameRequests).toHaveLength(0);

    await page.locator('[data-window-action="minimize"]').click();
    await page.locator('.desktop-shortcut[data-open-harbor-strike]').click();
    await expect(gameWindow).toBeVisible();
    await expect(task).toBeVisible();
    await expect(task).toHaveClass(/is-active/);
    await expect(page.locator('[data-harbor-phone]')).toBeHidden();
    await expect(frame).toHaveAttribute('src', '../games/harbor-strike/');
    await expect(status).toHaveText('点击画面锁定鼠标 · Esc 释放鼠标');
    await expect(page.locator('[data-harbor-loading]')).toBeHidden();
    await expect(page.frameLocator('iframe.harbor-frame').locator('#view')).toBeAttached();
    await expect(frame).toBeFocused();

    await gameWindow.locator('[data-harbor-action="minimize"]').click();
    await expect(gameWindow).toHaveClass(/is-minimized/);
    await expect.poll(() => gameState(page, 'hidden')).toBe(true);
    await task.click();
    await expect(gameWindow).toBeVisible();
    await expect.poll(() => gameState(page, 'hidden')).toBe(false);
    expect(gameRequests).toHaveLength(1);

    await page.locator('[data-taskbar-lang]').click();
    await expect(task).toContainText('Harbor Strike');
    await expect(status).toHaveText('Click the view to lock the mouse · Esc to release');
    await expect(gameWindow.locator('[data-harbor-open-link]')).toHaveAttribute('title', 'Open in new tab');
    await page.locator('[data-taskbar-lang]').click();

    await gameWindow.locator('.window-controls [data-harbor-action="close"]').click();
    await expect(gameWindow).toHaveClass(/is-closed/);
    await expect(task).toBeHidden();
    await expect(frame).toHaveCount(0);

    // The pop-out button plays the game at its own address and closes the in-window copy.
    await page.locator('.desktop-shortcut[data-open-harbor-strike]').click();
    await expect(frame).toHaveCount(1);
    const openLink = gameWindow.locator('[data-harbor-open-link]');
    await expect(openLink).toBeVisible();
    await expect(openLink).toHaveAttribute('target', '_blank');
    const popupPromise = page.waitForEvent('popup');
    await openLink.click();
    const popup = await popupPromise;
    await expect(popup).toHaveURL(/^http:\/\/[^/]+\/games\/harbor-strike\/$/);
    await expect(gameWindow).toHaveClass(/is-closed/);
    await expect(frame).toHaveCount(0);
    await popup.close();
});

test('asks phone visitors to open Harbor Strike on a computer', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'computers load the game');
    const gameRequests = [];
    page.on('request', (request) => {
        if (request.url().includes('/games/harbor-strike/')) gameRequests.push(request.url());
    });
    await page.goto('/portfolio/');
    const gameWindow = page.locator('[data-harbor-window]');
    await page.locator('[data-window-action="minimize"]').click();
    await page.locator('.desktop-shortcut[data-open-harbor-strike]').click();
    await expect(gameWindow).toBeVisible();
    await expect(page.locator('[data-harbor-phone]')).toBeVisible();
    await expect(page.locator('[data-harbor-phone]')).toContainText('请使用电脑打开');
    await expect(gameWindow.locator('iframe')).toHaveCount(0);
    await expect(gameWindow.locator('[data-menu-action="harbor-open-tab"]')).toBeHidden();
    expect(gameRequests).toHaveLength(0);

    await page.goto('/games/harbor-strike/');
    await expect(page.locator('.harbor-phone-notice')).toBeVisible();
    await expect(page.locator('.harbor-phone-notice')).toContainText('请使用电脑打开');
    await expect(page.locator('#app')).toBeHidden();
    expect(await page.locator('#ui').evaluate((element) => element.childElementCount)).toBe(0);
});

test('redirects the old Harbor Strike address to /games/harbor-strike/', async ({ page }) => {
    await page.route(GAME_PAGE, (route) => route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: GAME_STUB
    }));
    await page.goto('/portfolio/games/harbor-strike/');
    await expect.poll(() => new URL(page.url()).pathname).toBe('/games/harbor-strike/');
    await expect(page).toHaveTitle('港区突击 Harbor Strike');
});

test('mutes Harbor Strike from the taskbar on the directly opened desktop', async ({ page, isMobile }) => {
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
    await page.locator('.desktop-shortcut[data-open-harbor-strike]').click();
    await expect(page.locator('[data-harbor-status]')).toHaveText('点击画面锁定鼠标 · Esc 释放鼠标');
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
    await page.locator('.desktop-shortcut[data-open-harbor-strike]').click();
    const frame = page.locator('iframe.harbor-frame');
    await expect(frame).toHaveAttribute('sandbox', 'allow-scripts allow-pointer-lock');
    await expect(page.locator('[data-harbor-status]')).toHaveText('点击画面锁定鼠标 · Esc 释放鼠标');
    const gameFrame = page.frames().find((candidate) => GAME_PAGE(candidate.url()));
    expect(await gameFrame.evaluate(() => window.origin)).toBe('null');
    await expect.poll(() => gameFrame.evaluate(() => window.lastState && {
        hidden: window.lastState.hidden, hold: window.lastState.hold, muted: window.lastState.muted
    })).toEqual({ hidden: false, hold: false, muted: false });
    // The game page saves its settings through the desktop, which keeps them for the next launch.
    await gameFrame.evaluate(() => parent.postMessage({ source: 'harbor-strike', type: 'settings', value: '{"quality":"medium"}' }, '*'));
    await expect.poll(() => page.evaluate(() => localStorage.getItem('saltline.settings.v1'))).toBe('{"quality":"medium"}');
    await page.locator('.window-controls [data-harbor-action="close"]').click();
    await page.locator('.desktop-shortcut[data-open-harbor-strike]').click();
    await expect.poll(() => gameState(page, 'settings')).toBe('{"quality":"medium"}');
});
