const { test, expect } = require('@playwright/test');

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

test('keeps dragged windows in the work area after desktop resize and maximized restore', async ({ page, isMobile }) => {
    test.skip(isMobile, 'this regression stays above the desktop breakpoint');
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/portfolio/');
    await page.locator('[data-window-action="minimize"]').click();
    await page.locator('.desktop-shortcut[data-open-project-folder]').click();

    const folderWindow = page.locator('[data-project-folder-window]');
    const titlebar = folderWindow.locator('[data-project-folder-drag]');
    const windowFits = () => folderWindow.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const desktop = document.querySelector('[data-retro-desktop]').getBoundingClientRect();
        const taskbar = document.querySelector('.desktop-taskbar').getBoundingClientRect();
        return box.left >= desktop.left - 1 && box.top >= desktop.top - 1
            && box.right <= desktop.right + 1 && box.bottom <= taskbar.top + 1;
    });

    let dragBar = await titlebar.boundingBox();
    await page.mouse.move(dragBar.x + 150, dragBar.y + dragBar.height / 2);
    await page.mouse.down();
    await page.mouse.move(1270, 870, { steps: 8 });
    await page.mouse.up();
    const dragged = await folderWindow.boundingBox();
    expect(dragged.x + dragged.width).toBeGreaterThan(1000);
    expect(dragged.y + dragged.height).toBeGreaterThan(700);

    await page.setViewportSize({ width: 1000, height: 700 });
    await expect.poll(windowFits).toBe(true);

    await page.setViewportSize({ width: 1280, height: 900 });
    dragBar = await titlebar.boundingBox();
    await page.mouse.move(dragBar.x + 150, dragBar.y + dragBar.height / 2);
    await page.mouse.down();
    await page.mouse.move(1270, 870, { steps: 8 });
    await page.mouse.up();
    await folderWindow.locator('[data-project-folder-action="maximize"]').click();
    await expect(folderWindow).toHaveClass(/is-maximized/);

    await page.setViewportSize({ width: 1000, height: 700 });
    await expect.poll(windowFits).toBe(true);
    await folderWindow.locator('[data-project-folder-action="maximize"]').click();
    await expect(folderWindow).not.toHaveClass(/is-maximized/);
    await expect.poll(windowFits).toBe(true);

    await page.setViewportSize({ width: 1000, height: 300 });
    await expect.poll(windowFits).toBe(true);
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
