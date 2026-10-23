const { test, expect } = require('@playwright/test');

test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.removeItem('portfolio-lang'));
});

test('summons one robot from empty desktop space without intercepting app interactions or focus', async ({ page, isMobile }) => {
    test.skip(isMobile, 'desktop double-click interactions are checked with a mouse');
    await page.goto('/portfolio/');
    const pet = page.locator('[data-desktop-pet]');
    const desktop = page.locator('[data-retro-desktop]');
    await expect(pet).toBeHidden();

    await page.locator('[data-window-drag]').dblclick({ position: { x: 140, y: 10 } });
    await expect(pet).toBeHidden();
    await page.locator('[data-window-action="minimize"]').click();
    await page.locator('.desktop-shortcut[data-open-project-folder]').dblclick();
    await expect(page.locator('[data-project-folder-window]')).toBeVisible();
    await expect(pet).toBeHidden();
    await page.locator('[data-project-folder-action="close"]').click();

    const box = await desktop.boundingBox();
    const position = { x: box.x + box.width * 0.6, y: box.y + box.height * 0.4 };
    expect(await desktop.evaluate((element, position) => document.elementFromPoint(position.x, position.y) === element,
        position)).toBe(true);
    await page.mouse.dblclick(position.x, position.y);
    await expect(pet).toBeVisible();
    await expect(page.locator('[data-pet-speech]')).toBeVisible();
    expect(await pet.evaluate((element) => element.contains(document.activeElement))).toBe(false);
    await expect(page.locator('[data-app-window]')).toHaveClass(/is-minimized/);

    await page.mouse.dblclick(position.x, position.y);
    await expect(pet).toHaveCount(1);
    await expect(pet).toBeVisible();
    expect(await pet.evaluate((element) => element.contains(document.activeElement))).toBe(false);
    await expect(page.locator('[data-pet-toggle]')).toHaveAttribute('aria-expanded', 'true');
});

test('automatically follows a stationary lower-quarter pointer when the direct portfolio stays maximized', async ({ page, isMobile }) => {
    test.skip(isMobile, 'automatic desktop following is disabled on touch devices');
    await page.clock.install({ time: new Date('2026-10-23T00:00:00Z') });
    await page.clock.pauseAt(new Date('2026-10-23T00:00:01Z'));
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.goto('/portfolio/');
    const appWindow = page.locator('[data-app-window]');
    const pet = page.locator('[data-desktop-pet]');
    const speech = page.locator('[data-pet-speech]');
    await expect(appWindow).toHaveClass(/is-maximized/);
    await expect(pet).toBeHidden();
    const desktop = await page.locator('[data-retro-desktop]').boundingBox();
    const boundaryY = desktop.y + desktop.height * 0.75;
    await page.mouse.move(desktop.x + desktop.width * 0.25, boundaryY + 2);
    await page.clock.runFor(9999);
    await expect(pet).toBeHidden();
    await page.clock.runFor(1);
    await expect(pet).toBeVisible();
    await expect(pet).toHaveClass(/is-walking/);
    await expect(speech).toBeVisible();
    const appeared = await pet.boundingBox();
    await page.clock.runFor(1000);
    const followed = await pet.boundingBox();
    expect(appeared.x - followed.x).toBeGreaterThan(25);
    expect(appeared.x - followed.x).toBeLessThan(35);
    await expect(speech).toBeVisible();

    await page.mouse.move(desktop.x + desktop.width * 0.25, boundaryY - 2);
    await expect(pet).not.toHaveClass(/is-walking/);
    const stopped = await pet.boundingBox();
    await page.mouse.move(desktop.x + desktop.width * 0.85, boundaryY - 2);
    await page.clock.runFor(1000);
    expect((await pet.boundingBox()).x).toBe(stopped.x);
    await expect(pet).not.toHaveClass(/is-walking/);
    await expect(appWindow).toHaveClass(/is-maximized/);
});

test('supports keyboard wake-up, bilingual greetings and returning focus when dismissed', async ({ page, isMobile }) => {
    test.skip(isMobile, 'the desktop start menu is checked with a keyboard');
    await page.goto('/portfolio/');
    await page.locator('[data-window-action="minimize"]').click();
    const start = page.locator('[data-start-toggle]');
    const toggle = page.locator('[data-pet-toggle]');
    const robot = page.locator('[data-pet-greet]');
    const speech = page.locator('[data-pet-speech]');
    const pet = page.locator('[data-desktop-pet]');
    await start.focus();
    await page.keyboard.press('Enter');
    await expect(toggle).toContainText('唤醒机器人');
    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(robot).toBeFocused();
    await expect(page.locator('[data-start-menu]')).toBeHidden();
    await expect(speech).toHaveText('哔哔！我是 G-BOT，今天由我来巡逻桌面。');

    await page.keyboard.press('Enter');
    await expect(speech).toHaveText('收到一个点击，补充一点能量！');
    await page.locator('[data-taskbar-lang]').click();
    await expect(robot).toHaveAttribute('aria-label', 'Say hello to the robot');
    await expect(page.locator('[data-pet-dismiss]')).toHaveAttribute('aria-label', 'Dismiss robot');
    await expect(speech).toHaveText('One click received. A little energy restored!');
    await robot.click();
    await expect(speech).toHaveText('Looking for inspiration. If I find any, I will pretend it was my idea.');
    await robot.click();
    await expect(speech).toHaveText('Beep! I am G-BOT, your desktop patrol for today.');
    await robot.focus();
    await page.keyboard.press('Escape');
    await expect(pet).toBeHidden();
    await expect(start).toBeFocused();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');

    await page.keyboard.press('Enter');
    await expect(toggle).toContainText('Wake up robot');
    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(robot).toBeFocused();
    await page.locator('[data-pet-dismiss]').click();
    await expect(pet).toBeHidden();
    await expect(speech).toBeHidden();
    await expect(start).toBeFocused();
});

test('follows the mouse immediately through greetings, stationary targets and keyboard wake-up', async ({ page, isMobile }) => {
    test.skip(isMobile, 'mouse following is only available in the desktop layout');
    await page.clock.install();
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.goto('/portfolio/');
    await page.locator('[data-window-action="minimize"]').click();
    const desktop = await page.locator('[data-retro-desktop]').boundingBox();
    const pet = page.locator('[data-desktop-pet]');
    const speech = page.locator('[data-pet-speech]');
    const pointerY = desktop.y + desktop.height * 0.8;
    await page.mouse.dblclick(desktop.x + desktop.width * 0.4, pointerY);
    const initial = await pet.boundingBox();
    const pointerX = desktop.x + desktop.width * 0.65;
    const targetX = pointerX - initial.width / 2;
    await expect(speech).toBeVisible();

    await page.mouse.move(pointerX, pointerY);
    await page.clock.runFor(200);
    const started = await pet.boundingBox();
    expect(started.x).toBeGreaterThan(initial.x + 4);
    expect(started.x).toBeLessThan(initial.x + 8);
    expect(started.x).toBeLessThan(targetX - 100);
    expect(started.y).toBe(initial.y);
    await expect(speech).toBeVisible();
    await expect(pet).toHaveClass(/is-walking/);

    await page.clock.runFor(2000);
    const continued = await pet.boundingBox();
    expect(continued.x).toBeGreaterThan(started.x + 50);
    expect(continued.x).toBeLessThan(started.x + 70);
    await page.clock.runFor(12000);
    const arrived = await pet.boundingBox();
    expect(Math.abs(arrived.x - targetX)).toBeLessThanOrEqual(4);
    expect(arrived.y).toBe(initial.y);
    await expect(pet).not.toHaveClass(/is-walking/);

    const reversePointerX = desktop.x + desktop.width * 0.35;
    await page.mouse.move(reversePointerX, pointerY);
    await page.clock.runFor(200);
    const reversed = await pet.boundingBox();
    expect(reversed.x).toBeLessThan(arrived.x - 4);
    expect(reversed.x).toBeGreaterThan(arrived.x - 8);
    await expect(pet).toHaveClass(/is-facing-left/);
    await page.clock.runFor(17000);
    expect(Math.abs((await pet.boundingBox()).x - (reversePointerX - initial.width / 2))).toBeLessThanOrEqual(4);
    await expect(pet).not.toHaveClass(/is-walking/);

    await page.locator('[data-pet-greet]').focus();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Enter');
    await page.locator('[data-pet-toggle]').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-pet-greet]')).toBeFocused();
    await expect(speech).toBeVisible();
    const keyboardSpawn = await pet.boundingBox();
    await page.mouse.move(desktop.x + desktop.width * 0.45, pointerY);
    await page.clock.runFor(200);
    const keyboardStarted = await pet.boundingBox();
    expect(keyboardStarted.x).toBeLessThan(keyboardSpawn.x - 4);
    expect(keyboardStarted.x).toBeGreaterThan(keyboardSpawn.x - 8);
    await expect(page.locator('[data-pet-greet]')).toBeFocused();
    await expect(speech).toBeVisible();
});

test('patrols while idle and rejects mouse movement while reduced motion, hidden or shut down', async ({ page, isMobile }) => {
    test.skip(isMobile, 'desktop patrol is checked without touch emulation');
    await page.clock.install();
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.addInitScript(() => { Math.random = () => 0.9; });
    await page.goto('/portfolio/');
    await page.locator('[data-window-action="minimize"]').click();
    const desktop = await page.locator('[data-retro-desktop]').boundingBox();
    await page.mouse.dblclick(desktop.x + desktop.width * 0.35, desktop.y + desktop.height * 0.4);
    const pet = page.locator('[data-desktop-pet]');
    const initial = await pet.boundingBox();
    await page.clock.runFor(6100);
    await expect(pet).toHaveClass(/is-walking/);
    expect((await pet.boundingBox()).x).toBeGreaterThan(initial.x);

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(pet).toHaveClass(/is-paused/);
    await expect(pet).not.toHaveClass(/is-walking/);
    const reducedPosition = await pet.evaluate((element) => element.style.transform);
    await page.mouse.move(desktop.x + desktop.width * 0.9, desktop.y + desktop.height * 0.8);
    await page.clock.runFor(12000);
    expect(await pet.evaluate((element) => element.style.transform)).toBe(reducedPosition);
    await expect(pet).not.toHaveClass(/is-walking/);

    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, value: true });
        document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect(pet).toHaveClass(/is-paused/);
    const hiddenPosition = await pet.evaluate((element) => element.style.transform);
    await page.mouse.move(desktop.x + desktop.width * 0.15, desktop.y + desktop.height * 0.8);
    await page.clock.runFor(12000);
    expect(await pet.evaluate((element) => element.style.transform)).toBe(hiddenPosition);
    await expect(pet).not.toHaveClass(/is-walking/);
    await page.evaluate(() => {
        delete document.hidden;
        document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect(pet).not.toHaveClass(/is-paused/);
    await page.mouse.move(desktop.x + desktop.width * 0.9, desktop.y + desktop.height * 0.8);
    await page.clock.runFor(200);
    await expect(pet).toHaveClass(/is-walking/);
    expect(await pet.evaluate((element) => element.style.transform)).not.toBe(hiddenPosition);

    await page.locator('[data-start-toggle]').click();
    await page.locator('[data-shutdown]').click();
    await expect(pet).toHaveAttribute('inert', '');
    await expect(pet).toHaveClass(/is-paused/);
    await expect(pet).not.toHaveClass(/is-walking/);
    const shutdownPosition = await pet.evaluate((element) => element.style.transform);
    await page.mouse.move(desktop.x + desktop.width * 0.15, desktop.y + desktop.height * 0.8);
    await page.clock.runFor(6100);
    expect(await pet.evaluate((element) => element.style.transform)).toBe(shutdownPosition);
    await expect(pet).not.toHaveClass(/is-walking/);
    await page.locator('[data-restart]').click();
    await expect(pet).not.toHaveAttribute('inert');
    await expect(pet).not.toHaveClass(/is-paused/);
});

for (const viewport of [
    { width: 1366, height: 768 },
    { width: 1024, height: 600 },
    { width: 1920, height: 1080 },
    { width: 901, height: 600 }
]) {
    test(`follows only in the bottom quarter and takes short idle walks at ${viewport.width}x${viewport.height}`, async ({ page, isMobile }) => {
        test.skip(isMobile, 'desktop regions are checked without touch emulation');
        await page.clock.install({ time: new Date('2026-10-23T00:00:00Z') });
        await page.clock.pauseAt(new Date('2026-10-23T00:00:01Z'));
        await page.emulateMedia({ reducedMotion: 'no-preference' });
        await page.addInitScript(() => { Math.random = () => 0.999; });
        await page.setViewportSize(viewport);
        await page.goto('/portfolio/');
        await page.locator('[data-window-action="minimize"]').click();
        const desktop = await page.locator('[data-retro-desktop]').boundingBox();
        const pet = page.locator('[data-desktop-pet]');
        const boundaryY = desktop.y + desktop.height * 0.75;
        await page.mouse.dblclick(desktop.x + desktop.width * 0.25, desktop.y + desktop.height * 0.4);
        const initial = await pet.boundingBox();

        await page.mouse.move(desktop.x + desktop.width * 0.85, boundaryY + 2);
        await expect(pet).toHaveClass(/is-walking/);
        await page.clock.runFor(2000);
        const followed = await pet.boundingBox();
        expect(followed.x - initial.x).toBeGreaterThan(50);
        expect(followed.x - initial.x).toBeLessThan(70);

        await page.mouse.move(desktop.x + desktop.width * 0.85, boundaryY - 2);
        await expect(pet).not.toHaveClass(/is-walking/);
        const stopped = await pet.boundingBox();
        await page.mouse.move(desktop.x + desktop.width * 0.15, boundaryY - 2);
        await page.clock.runFor(3900);
        expect((await pet.boundingBox()).x).toBe(stopped.x);
        await expect(pet).not.toHaveClass(/is-walking/);

        await page.clock.runFor(200);
        await expect(pet).toHaveClass(/is-walking/);
        const patrolStarted = await pet.boundingBox();
        expect(patrolStarted.x).toBeGreaterThan(stopped.x);
        expect(patrolStarted.x).toBeLessThan(stopped.x + 3);
        await page.clock.runFor(2000);
        const patrolContinued = await pet.boundingBox();
        expect(patrolContinued.x - patrolStarted.x).toBeGreaterThan(25);
        expect(patrolContinued.x - patrolStarted.x).toBeLessThan(35);
        await page.clock.runFor(2100);
        const patrolStopped = await pet.boundingBox();
        expect(patrolStopped.x - stopped.x).toBeGreaterThan(55);
        expect(patrolStopped.x - stopped.x).toBeLessThanOrEqual(60);
        await expect(pet).not.toHaveClass(/is-walking/);
        await page.clock.runFor(1500);
        expect((await pet.boundingBox()).x).toBe(patrolStopped.x);
        await expect(pet).not.toHaveClass(/is-walking/);
        await page.clock.runFor(400);
        await expect(pet).toHaveClass(/is-walking/);

        await page.mouse.move(desktop.x + desktop.width * 0.15, boundaryY + 2);
        const beforeResize = await pet.boundingBox();
        await page.setViewportSize({ width: viewport.width, height: viewport.height + 200 });
        await expect(pet).not.toHaveClass(/is-walking/);
        const resized = await pet.boundingBox();
        expect(Math.abs(resized.x - beforeResize.x)).toBeLessThanOrEqual(1);
        await page.clock.runFor(200);
        expect((await pet.boundingBox()).x).toBe(resized.x);
        await page.setViewportSize(viewport);
        await expect(pet).toHaveClass(/is-walking/);
        const resumed = await pet.boundingBox();
        await page.clock.runFor(200);
        const moved = await pet.boundingBox();
        expect(resumed.x - moved.x).toBeGreaterThan(4);
        expect(resumed.x - moved.x).toBeLessThan(8);
    });
}

test('stays inside desktop bounds and remains disabled for small screens and touch devices', async ({ page, isMobile }) => {
    if (!isMobile) {
        await page.goto('/portfolio/');
        await page.locator('[data-window-action="minimize"]').click();
        const desktop = page.locator('[data-retro-desktop]');
        const box = await desktop.boundingBox();
        await page.mouse.dblclick(box.x + box.width - 10, box.y + box.height * 0.4);
        const pet = page.locator('[data-desktop-pet]');
        await expect(pet).toBeVisible();
        const initial = await pet.boundingBox();
        expect(initial.x).toBeGreaterThanOrEqual(box.x + 8);
        expect(initial.x + initial.width).toBeLessThanOrEqual(box.x + box.width - 7);

        await page.setViewportSize({ width: 1000, height: 768 });
        await expect.poll(() => pet.evaluate((element) => element.getBoundingClientRect().right))
            .toBeLessThanOrEqual(993);
        const resized = await pet.boundingBox();
        const taskbar = await page.locator('.desktop-taskbar').boundingBox();
        expect(resized.x).toBeGreaterThanOrEqual(8);
        expect(resized.y + resized.height).toBeLessThanOrEqual(taskbar.y - 7);
        const speech = await page.locator('[data-pet-speech]').boundingBox();
        expect(speech.x).toBeGreaterThanOrEqual(8);
        expect(speech.x + speech.width).toBeLessThanOrEqual(993);

        await page.setViewportSize({ width: 320, height: 568 });
        await expect(pet).toHaveAttribute('hidden', '');
        await expect(pet).toBeHidden();
        await expect(page.locator('[data-pet-toggle]')).toBeHidden();
        await desktop.dispatchEvent('dblclick', { button: 0, clientX: 160, clientY: 250 });
        await expect(pet).toHaveAttribute('hidden', '');
        await page.setViewportSize({ width: 1366, height: 768 });
        await expect(page.locator('[data-pet-toggle]')).not.toHaveCSS('display', 'none');
        await expect(pet).toHaveAttribute('hidden', '');
        await expect(pet).toBeHidden();
    } else {
        await page.goto('/portfolio/');
        const pet = page.locator('[data-desktop-pet]');
        await expect(pet).toHaveAttribute('hidden', '');
        await expect(pet).toBeHidden();
        await expect(page.locator('[data-pet-toggle]')).toBeHidden();
        await page.locator('[data-retro-desktop]').dispatchEvent('dblclick', { button: 0, clientX: 160, clientY: 250 });
        await expect(pet).toHaveAttribute('hidden', '');

        await page.setViewportSize({ width: 1024, height: 568 });
        expect(await page.evaluate(() => window.matchMedia('(pointer: coarse)').matches)).toBe(true);
        await expect(page.locator('[data-pet-toggle]')).toBeHidden();
        await page.locator('[data-retro-desktop]').dispatchEvent('dblclick', { button: 0, clientX: 500, clientY: 250 });
        await expect(pet).toHaveAttribute('hidden', '');
        await expect(pet).toBeHidden();
    }

    await page.goto('/portfolio/?view=mobile-homepage');
    const pet = page.locator('[data-desktop-pet]');
    await expect(pet).toBeHidden();
    await expect(page.locator('[data-pet-toggle]')).toBeHidden();
    await page.locator('[data-retro-desktop]').dispatchEvent('dblclick', { button: 0, clientX: 160, clientY: 250 });
    await expect(pet).toHaveAttribute('hidden', '');
    await expect(pet).toBeHidden();
});
