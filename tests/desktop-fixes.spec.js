const { test, expect } = require('@playwright/test');

test.use({ serviceWorkers: 'block' });

test('keeps edge window menus inside the work area and scrolls short menus with the keyboard', async ({ page, isMobile }) => {
    test.skip(isMobile, 'the desktop menubar is hidden on small screens');
    await page.setViewportSize({ width: 1200, height: 793 });
    await page.goto('/portfolio/');
    await page.locator('[data-window-action="minimize"]').click();
    await page.locator('.desktop-shortcut[data-open-project-folder]').click();
    const app = page.locator('[data-project-folder-window]');
    const title = await app.locator('.window-titlebar').boundingBox();
    await page.mouse.move(title.x + 40, title.y + 10);
    await page.mouse.down();
    await page.mouse.move(1100, 710, { steps: 8 });
    await page.mouse.up();
    const trigger = app.locator('[data-window-menu="folder-file"]');
    const popup = app.locator('[data-window-menu-popup="folder-file"]');
    const assertContained = async () => {
        const menu = await popup.boundingBox();
        const taskbar = await page.locator('.desktop-taskbar').boundingBox();
        expect(menu.x).toBeGreaterThanOrEqual(0);
        expect(menu.y).toBeGreaterThanOrEqual(0);
        expect(menu.x + menu.width).toBeLessThanOrEqual(page.viewportSize().width);
        expect(menu.y + menu.height).toBeLessThanOrEqual(taskbar.y);
    };
    await trigger.click();
    await assertContained();
    expect((await popup.boundingBox()).y).toBeLessThan((await trigger.boundingBox()).y);
    await popup.locator('[role="menuitem"]').last().click();
    await expect(app).toBeHidden();
    await page.locator('.desktop-shortcut[data-open-project-folder]').click();
    await app.evaluate(element => { element.style.left = '-70px'; element.style.top = '0px'; });
    await trigger.focus();
    await page.keyboard.press('ArrowDown');
    await assertContained();
    await page.setViewportSize({ width: 980, height: 120 });
    await expect(popup).toBeHidden();
    await trigger.focus();
    await page.keyboard.press('ArrowUp');
    await assertContained();
    const last = popup.locator('[role="menuitem"]').last();
    await expect(last).toBeFocused();
    expect(await popup.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    const item = await last.boundingBox();
    const menu = await popup.boundingBox();
    expect(item.y + item.height).toBeLessThanOrEqual(menu.y + menu.height);
    await page.keyboard.press('Home');
    await expect(popup.locator('[role="menuitem"]').first()).toBeFocused();
    const first = await popup.locator('[role="menuitem"]').first().boundingBox();
    expect(first.y).toBeGreaterThanOrEqual(menu.y);
    expect(first.y + first.height).toBeLessThanOrEqual(menu.y + menu.height);
});

test('places mobile navigation targets below the sticky header after closing the menu', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'this regression concerns the mobile navigation layout');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/portfolio/?view=mobile-homepage');

    await page.locator('[data-menu-toggle]').click();
    await expect(page.locator('[data-mobile-menu]')).toHaveClass(/active/);
    await page.locator('.mobile-menu a[href="#projects"]').click();
    await expect(page.locator('[data-mobile-menu]')).toBeHidden();
    await expect(page.locator('[data-menu-toggle]')).toHaveAttribute('aria-expanded', 'false');

    await page.locator('[data-window-scroll]').evaluate((element) => new Promise((resolve) => {
        let previousTop = element.scrollTop;
        let stableFrames = 0;
        const checkScroll = () => {
            const nextTop = element.scrollTop;
            stableFrames = Math.abs(nextTop - previousTop) < 0.1 ? stableFrames + 1 : 0;
            previousTop = nextTop;
            if (stableFrames >= 6 && nextTop > 0) resolve();
            else window.requestAnimationFrame(checkScroll);
        };
        window.requestAnimationFrame(checkScroll);
    }));

    const layout = await page.evaluate(() => {
        const header = document.querySelector('.site-header').getBoundingClientRect();
        const section = document.querySelector('#projects').getBoundingClientRect();
        const title = document.querySelector('#projects-title').getBoundingClientRect();
        const scroll = document.querySelector('[data-window-scroll]').getBoundingClientRect();
        return {
            sectionClearsHeader: section.top >= header.bottom - 1,
            sectionNearHeader: section.top <= header.bottom + 2,
            titleClearsHeader: title.top >= header.bottom - 1,
            titleFits: title.bottom <= scroll.bottom + 1
        };
    });
    expect(layout).toEqual({
        sectionClearsHeader: true,
        sectionNearHeader: true,
        titleClearsHeader: true,
        titleFits: true
    });
    await expect(page).toHaveURL(/#projects$/);
});

test('ignores a second mail send from the menu while delivery is pending', async ({ page, isMobile }) => {
    test.skip(isMobile, 'the desktop menu and composer are exercised here');
    const endpoint = 'https://formsubmit.co/ajax/gavinxleele@gmail.com';
    let postRequests = 0;
    let releaseResponse;
    const responseGate = new Promise((resolve) => { releaseResponse = resolve; });
    await page.route(endpoint, async (route) => {
        if (route.request().method() === 'POST') postRequests += 1;
        await responseGate;
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ success: 'true' })
        });
    });

    await page.goto('/portfolio/');
    await page.locator('[data-window-action="minimize"]').click();
    await page.locator('.desktop-shortcut[data-open-mail-window]').click();
    const mailWindow = page.locator('[data-mail-window]');
    const mailForm = page.locator('[data-mail-form]');
    await mailForm.locator('input[name="name"]').fill('Regression visitor');
    await mailForm.locator('input[name="email"]').fill('regression@example.com');
    await mailForm.locator('textarea[name="message"]').fill('Intercepted regression request.');

    try {
        const firstRequest = page.waitForRequest((request) => request.url() === endpoint && request.method() === 'POST');
        await mailForm.locator('[data-mail-send]').click();
        await firstRequest;
        await expect(mailForm.locator('[data-mail-send]')).toBeDisabled();
        await expect(page.locator('[data-mail-status]')).toContainText('正在发送');

        await mailWindow.locator('[data-window-menu="mail-file"]').click();
        const duplicateRequest = page.waitForRequest(
            (request) => request.url() === endpoint && request.method() === 'POST',
            { timeout: 500 }
        ).then(() => true, () => false);
        await mailWindow.locator('[data-menu-action="mail-send"]').click();
        expect(await duplicateRequest).toBe(false);
        expect(postRequests).toBe(1);
        await expect(mailForm.locator('textarea[name="message"]')).toHaveValue('Intercepted regression request.');
    } finally {
        releaseResponse();
    }

    await expect(page.locator('[data-mail-status]')).toContainText('已发送');
    await expect(mailForm.locator('[data-mail-send]')).toBeEnabled();
    expect(postRequests).toBe(1);
});

test('keeps partially hidden windows reachable after desktop resize and maximized restore', async ({ page, isMobile }) => {
    test.skip(isMobile, 'this regression stays above the desktop breakpoint');
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/portfolio/');
    await page.locator('[data-window-action="minimize"]').click();
    await page.locator('.desktop-shortcut[data-open-project-folder]').click();

    const folderWindow = page.locator('[data-project-folder-window]');
    const titlebar = folderWindow.locator('[data-project-folder-drag]');
    const windowReachable = () => folderWindow.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const title = element.querySelector('.window-titlebar').getBoundingClientRect();
        const desktop = document.querySelector('[data-retro-desktop]').getBoundingClientRect();
        const taskbar = document.querySelector('.desktop-taskbar').getBoundingClientRect();
        return box.top >= desktop.top - 1 && title.bottom <= taskbar.top + 1
            && box.right >= desktop.left + 159 && box.left <= desktop.right - 159;
    });

    let dragBar = await titlebar.boundingBox();
    await page.mouse.move(dragBar.x + 150, dragBar.y + dragBar.height / 2);
    await page.mouse.down();
    await page.mouse.move(1270, 870, { steps: 8 });
    await page.mouse.up();
    const dragged = await folderWindow.boundingBox();
    expect(dragged.x + dragged.width).toBeGreaterThan(1280);
    expect(dragged.y + dragged.height).toBeGreaterThan(900);

    await page.setViewportSize({ width: 1000, height: 700 });
    await expect.poll(windowReachable).toBe(true);

    await page.setViewportSize({ width: 1280, height: 900 });
    dragBar = await titlebar.boundingBox();
    await page.mouse.move(dragBar.x + 150, dragBar.y + dragBar.height / 2);
    await page.mouse.down();
    await page.mouse.move(1270, 870, { steps: 8 });
    await page.mouse.up();
    await titlebar.dblclick({ position: { x: 40, y: 10 } });
    await expect(folderWindow).toHaveClass(/is-maximized/);

    await page.setViewportSize({ width: 1000, height: 700 });
    await expect.poll(windowReachable).toBe(true);
    await folderWindow.locator('[data-project-folder-action="maximize"]').click();
    await expect(folderWindow).not.toHaveClass(/is-maximized/);
    await expect.poll(windowReachable).toBe(true);

    await page.setViewportSize({ width: 1000, height: 300 });
    await expect.poll(windowReachable).toBe(true);
});

test('keeps the taskbar anchored when switching windows partly outside the desktop', async ({ page, isMobile }) => {
    test.skip(isMobile, 'desktop windows can be dragged outside the work area');
    await page.goto('/portfolio/');
    await page.locator('[data-window-action="minimize"]').click();
    const taskbar = page.locator('.desktop-taskbar');
    const original = await taskbar.boundingBox();
    for (const [shortcut, windowSelector] of [
        ['[data-open-mail-window]', '[data-mail-window]'],
        ['[data-open-gomoku]', '[data-gomoku-window]']
    ]) {
        await page.locator(`.desktop-shortcut${shortcut}`).click();
        if (windowSelector === '[data-gomoku-window]') await expect(page.locator('[data-gomoku-mode="local"]')).toBeVisible();
        const title = await page.locator(windowSelector).locator('.window-titlebar').first().boundingBox();
        await page.mouse.move(title.x + 60, title.y + 10);
        await page.mouse.down();
        await page.mouse.move(page.viewportSize().width - 2, original.y - 5, { steps: 8 });
        await page.mouse.up();
        const box = await page.locator(windowSelector).boundingBox();
        expect(box.y + box.height).toBeGreaterThan(page.viewportSize().height);
    }
    for (const selector of ['[data-mail-task]', '[data-gomoku-task]', '[data-gomoku-task]', '[data-gomoku-task]']) {
        await page.locator(selector).click();
        expect(await taskbar.boundingBox()).toEqual(original);
        expect(await page.locator('[data-retro-desktop]').evaluate(el => [el.scrollLeft, el.scrollTop])).toEqual([0, 0]);
    }
    await page.locator('[data-gomoku-mode="local"]').evaluate(el => el.scrollIntoView());
    expect(await taskbar.boundingBox()).toEqual(original);
    expect(await page.locator('[data-retro-desktop]').evaluate(el => [el.scrollLeft, el.scrollTop])).toEqual([0, 0]);
});

test('moves keyboard focus into opened windows and windows selected from the taskbar', async ({ page, isMobile }) => {
    test.skip(isMobile, 'this regression concerns desktop keyboard window navigation');
    await page.goto('/portfolio/');
    await page.locator('[data-window-action="minimize"]').click();

    const folderShortcut = page.locator('.desktop-shortcut[data-open-project-folder]');
    await folderShortcut.focus();
    await folderShortcut.press('Enter');
    const folderButton = page.locator('[data-open-robomaster-folder]');
    await expect(folderButton).toBeFocused();
    await folderButton.press('Enter');

    const photo = page.locator('[data-robomaster-image]').first();
    await photo.focus();
    await photo.press('Enter');
    const previewWindow = page.locator('[data-image-preview-window]');
    const previewClose = previewWindow.locator('[data-image-preview-action="close"]');
    await expect(previewClose).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(previewWindow).toHaveClass(/is-active/);

    const mailShortcut = page.locator('.desktop-shortcut[data-open-mail-window]');
    await mailShortcut.focus();
    await mailShortcut.press('Enter');
    const nameField = page.locator('[data-mail-form] input[name="name"]');
    await expect(nameField).toBeFocused();

    const folderTask = page.locator('[data-project-folder-task]');
    await folderTask.focus();
    await folderTask.press('Enter');
    await expect(photo).toBeFocused();
    await expect(page.locator('[data-project-folder-window]')).toHaveClass(/is-active/);

    const mailTask = page.locator('[data-mail-task]');
    await mailTask.focus();
    await mailTask.press('Enter');
    await expect(nameField).toBeFocused();

    const previewTask = page.locator('[data-image-preview-task]');
    await previewTask.focus();
    await previewTask.press('Enter');
    await expect(previewClose).toBeFocused();
    await expect(previewWindow).toHaveClass(/is-active/);
});

test('restores the original window geometry after reloading a maximized window', async ({ page, isMobile }) => {
    test.skip(isMobile, 'desktop windows preserve their movable geometry');
    await page.goto('/portfolio/');
    await page.locator('[data-window-action="minimize"]').click();
    await page.locator('.desktop-shortcut[data-open-project-folder]').click();
    const folderWindow = page.locator('[data-project-folder-window]');
    const handle = await page.locator('[data-project-folder-resize]').boundingBox();
    await page.mouse.move(handle.x + 4, handle.y + 4);
    await page.mouse.down();
    await page.mouse.move(handle.x - 100, handle.y - 60, { steps: 8 });
    await page.mouse.up();
    const geometry = await folderWindow.boundingBox();
    await folderWindow.locator('[data-project-folder-action="maximize"]').click();
    await expect(folderWindow).toHaveClass(/is-maximized/);

    for (let reload = 0; reload < 2; reload += 1) {
        await page.reload();
        await expect(folderWindow).toHaveClass(/is-maximized/);
    }
    await folderWindow.locator('[data-project-folder-action="maximize"]').click();
    await expect(folderWindow).not.toHaveClass(/is-maximized/);
    expect(await folderWindow.boundingBox()).toEqual(geometry);
});

for (const action of ['minimize', 'close']) {
    test(`preserves resized window geometry when reloading after ${action}`, async ({ page, isMobile }) => {
        test.skip(isMobile, 'desktop windows preserve their movable geometry');
        await page.goto('/portfolio/');
        await page.locator('[data-window-action="minimize"]').click();
        await page.locator('.desktop-shortcut[data-open-project-folder]').click();
        const folderWindow = page.locator('[data-project-folder-window]');
        const handle = await page.locator('[data-project-folder-resize]').boundingBox();
        await page.mouse.move(handle.x + 4, handle.y + 4);
        await page.mouse.down();
        await page.mouse.move(handle.x - 100, handle.y - 60, { steps: 8 });
        await page.mouse.up();
        const titlebar = await page.locator('[data-project-folder-drag]').boundingBox();
        await page.mouse.move(titlebar.x + 100, titlebar.y + 10);
        await page.mouse.down();
        await page.mouse.move(titlebar.x + 145, titlebar.y + 55, { steps: 8 });
        await page.mouse.up();
        const geometry = await folderWindow.boundingBox();

        await folderWindow.locator(`[data-project-folder-action="${action}"]`).click();
        await expect(folderWindow).toBeHidden();
        await page.reload();
        await expect(folderWindow).toBeHidden();
        const opener = action === 'minimize'
            ? '[data-project-folder-task]'
            : '.desktop-shortcut[data-open-project-folder]';
        await page.locator(opener).click();
        expect(await folderWindow.boundingBox()).toEqual(geometry);
    });
}
