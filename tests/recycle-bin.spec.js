const { test, expect } = require('@playwright/test');

test('runs the recycle bin alongside other windows with taskbar controls', async ({ page }) => {
    await page.goto('/portfolio/');
    await page.locator('[data-window-action="minimize"]').click();
    const bin = page.locator('[data-recycle-window]');
    const task = page.locator('[data-recycle-task]');
    const folder = page.locator('[data-project-folder-window]');
    const folderTask = page.locator('[data-project-folder-task]');

    await page.locator('[data-open-recycle-bin]').click();
    await expect(bin).toBeVisible();
    await expect(task).toBeVisible();
    await expect(task).toHaveClass(/is-active/);
    await expect(page.locator('[data-recycle-empty]')).toBeFocused();
    await task.click();
    await expect(bin).toHaveClass(/is-minimized/);
    await expect(task).toBeVisible();

    await page.locator('.desktop-shortcut[data-open-project-folder]').click();
    await expect(folder).toBeVisible();
    await task.click();
    await expect(bin).toBeVisible();
    await expect(folder).toBeVisible();
    await expect(bin).toHaveClass(/is-active/);
    await expect(folder).not.toHaveClass(/is-active/);
    await folderTask.click();
    await expect(folder).toHaveClass(/is-active/);
    await expect(bin).toBeVisible();
    await task.click();
    await expect(bin).toHaveClass(/is-active/);
    expect(await bin.evaluate((element) => Number(getComputedStyle(element).zIndex)))
        .toBeGreaterThan(await folder.evaluate((element) => Number(getComputedStyle(element).zIndex)));

    await bin.locator('[data-recycle-action="close"]').first().click();
    await expect(bin).toHaveClass(/is-closed/);
    await expect(task).toBeHidden();
    await expect(folder).toHaveClass(/is-active/);
    await folderTask.click();
    await page.locator('[data-open-recycle-bin]').click();
    await page.locator('[data-recycle-empty]').click();
    await page.locator('[data-recycle-confirm]').click();
    await expect(page.locator('[data-recycle-files]')).toBeHidden();
    await expect(page.locator('[data-recycle-hint]')).toBeVisible();
    await expect(page.locator('[data-recycle-empty]')).toBeDisabled();
    await expect(bin.locator('.window-controls [data-recycle-action="close"]')).toBeFocused();
    await page.locator('[data-taskbar-lang]').click();
    await expect(task).toContainText('Recycle Bin');
    await expect(page.locator('[data-recycle-status]')).toContainText('0 objects');
    await bin.locator('.window-controls [data-recycle-action="close"]').click();
    await expect(task).toBeHidden();
    await page.locator('[data-open-recycle-bin]').click();
    await expect(page.locator('[data-recycle-hint]')).toBeVisible();
});

test('drags, resizes, maximizes and restores the recycle bin window', async ({ page, isMobile }) => {
    test.skip(isMobile, 'desktop geometry is replaced by the mobile window layout');
    await page.goto('/portfolio/');
    await page.locator('[data-window-action="minimize"]').click();
    await page.locator('[data-open-recycle-bin]').click();
    const bin = page.locator('[data-recycle-window]');
    const initial = await bin.boundingBox();
    const titlebar = await page.locator('[data-recycle-drag]').boundingBox();
    await page.mouse.move(titlebar.x + 160, titlebar.y + titlebar.height / 2);
    await page.mouse.down();
    await page.mouse.move(titlebar.x + 220, titlebar.y + titlebar.height / 2 + 40, { steps: 4 });
    await page.mouse.up();
    const dragged = await bin.boundingBox();
    expect(dragged.x).toBeCloseTo(initial.x + 60, 0);
    expect(dragged.y).toBeCloseTo(initial.y + 40, 0);

    const grip = await page.locator('[data-recycle-resize]').boundingBox();
    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
    await page.mouse.down();
    await page.mouse.move(grip.x + grip.width / 2 + 90, grip.y + grip.height / 2 + 60, { steps: 4 });
    await page.mouse.up();
    const resized = await bin.boundingBox();
    expect(resized.width).toBeCloseTo(dragged.width + 90, 0);
    expect(resized.height).toBeCloseTo(dragged.height + 60, 0);

    await bin.locator('[data-recycle-action="maximize"]').click();
    await expect(bin).toHaveClass(/is-maximized/);
    const desktop = await page.locator('[data-retro-desktop]').boundingBox();
    const taskbar = await page.locator('.desktop-taskbar').boundingBox();
    expect(await bin.boundingBox()).toEqual({ x: desktop.x, y: desktop.y, width: desktop.width, height: taskbar.y - desktop.y });
    await bin.locator('[data-recycle-action="maximize"]').click();
    await expect(bin).not.toHaveClass(/is-maximized/);
    expect(await bin.boundingBox()).toEqual(resized);
    await bin.locator('[data-recycle-action="close"]').first().click();
    await page.locator('[data-open-recycle-bin]').click();
    expect(await bin.boundingBox()).toEqual(resized);
});

test('keeps the immersive desktop aligned after closing the recycle bin', async ({ page, isMobile }) => {
    test.skip(isMobile, 'the mobile shell does not create the 3D monitor');
    test.setTimeout(60000);
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

    const frame = page.frameLocator('#computer-screen');
    await frame.locator('[data-window-action="minimize"]').click();
    const before = await frame.locator('[data-retro-desktop]').evaluate((desktop) => ({
        desktop: desktop.getBoundingClientRect().toJSON(),
        shortcut: document.querySelector('.desktop-shortcuts').getBoundingClientRect().toJSON(),
        taskbar: document.querySelector('.desktop-taskbar').getBoundingClientRect().toJSON()
    }));
    for (const action of ['titlebar', 'empty', 'minimize']) {
        await frame.locator('[data-open-recycle-bin]').click();
        if (action === 'empty') {
            await frame.locator('[data-recycle-empty]').click();
            await frame.locator('[data-recycle-confirm]').click();
        }
        if (action === 'minimize') {
            await frame.locator('[data-recycle-action="minimize"]').click();
            await frame.locator('[data-recycle-task]').click();
        }
        await frame.locator('.window-controls [data-recycle-action="close"]').click();
        await expect(frame.locator('[data-recycle-window]')).toBeHidden();
        await expect(frame.locator('[data-recycle-task]')).toBeHidden();
        expect(await frame.locator('[data-retro-desktop]').evaluate((desktop) => ({
            desktop: desktop.getBoundingClientRect().toJSON(),
            shortcut: document.querySelector('.desktop-shortcuts').getBoundingClientRect().toJSON(),
            taskbar: document.querySelector('.desktop-taskbar').getBoundingClientRect().toJSON()
        }))).toEqual(before);
        expect(await frame.locator('body').evaluate(() => window.scrollY)).toBe(0);
        expect(await screen.evaluate((iframe) => {
            for (let element = iframe; element; element = element.parentElement) {
                if (element.scrollTop || element.scrollLeft) return false;
            }
            return window.scrollY === 0 && window.scrollX === 0;
        })).toBe(true);
    }
});

test('uses the project folder grid with multiselection and cancellable deletion', async ({ page }) => {
    await page.goto('/portfolio/');
    await page.locator('[data-window-action="minimize"]').click();
    await page.locator('[data-open-recycle-bin]').click();
    const bin = page.locator('[data-recycle-window]');
    const items = bin.locator('[data-recycle-file]');
    const dialog = bin.locator('[data-recycle-dialog]');
    await expect(bin.locator('.address-field')).toHaveText('C:\\GAVIN\\RECYCLE');
    await expect(bin.locator('[data-recycle-view], [data-recycle-heading]')).toHaveCount(0);
    expect(await bin.locator('[data-recycle-files]').evaluate(element => getComputedStyle(element).display)).toBe('grid');
    await items.first().click();
    await items.last().click({ modifiers: ['Shift'] });
    await expect(bin.locator('[data-recycle-file][aria-pressed="true"]')).toHaveCount(3);
    await expect(bin.locator('[data-recycle-selection-status]')).toHaveText('已选择 3 项');
    await items.first().focus();
    await page.keyboard.press('Delete');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('[data-recycle-dialog-copy]')).toContainText('3');
    await expect(dialog.locator('[data-recycle-cancel]')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(items.last()).toBeFocused();
    await expect(items).toHaveCount(3);
    await items.first().click();
    await items.last().click({ modifiers: ['ControlOrMeta'] });
    await bin.locator('[data-recycle-restore]').click();
    await expect(bin.locator('[data-recycle-file]:visible')).toHaveCount(1);
    await expect(bin.locator('[data-recycle-status]')).toContainText('1 个对象');
    await bin.locator('[data-recycle-empty]').click();
    await dialog.locator('[data-recycle-confirm]').click();
    await expect(bin.locator('[data-recycle-hint]')).toBeVisible();
    await bin.locator('[data-recycle-reset]').click();
    await expect(bin.locator('[data-recycle-file]:visible')).toHaveCount(3);
});

test('opens file properties and preserves selection while changing language', async ({ page }) => {
    await page.goto('/portfolio/');
    await page.locator('[data-window-action="minimize"]').click();
    await page.locator('[data-open-recycle-bin]').click();
    const bin = page.locator('[data-recycle-window]');
    const file = bin.locator('[data-recycle-file="Idea"]');
    const dialog = bin.locator('[data-recycle-dialog]');
    await file.dblclick();
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('[data-recycle-dialog-title]')).toContainText('还没想好的点子.txt');
    await expect(dialog.locator('[data-recycle-property="location"]')).toHaveText('C:\\GAVIN\\IDEAS');
    await expect(dialog.locator('[data-recycle-dialog-copy]')).toContainText('先写下一行');
    await expect(dialog.locator('[data-recycle-confirm]')).toBeHidden();
    await dialog.locator('[data-recycle-cancel]').click();
    await expect(file).toBeFocused();
    await page.locator('[data-taskbar-lang]').click();
    await expect(file).toHaveAttribute('aria-pressed', 'true');
    await expect(bin.locator('.address-field')).toHaveText('C:\\GAVIN\\RECYCLE');
    await file.press('Enter');
    await expect(dialog.locator('[data-recycle-dialog-title]')).toContainText('Properties');
    await expect(dialog.locator('[data-recycle-property="type"]')).toHaveText('Text document');
    await dialog.locator('[data-recycle-dismiss]').click();
    await expect(file).toBeFocused();
});

test('uses the file context menu without losing a multi-selection', async ({ page, isMobile }) => {
    test.skip(isMobile, 'touch devices use the same commands from the menu bar');
    await page.goto('/portfolio/');
    await page.locator('[data-window-action="minimize"]').click();
    await page.locator('[data-open-recycle-bin]').click();
    const bin = page.locator('[data-recycle-window]');
    const items = bin.locator('[data-recycle-file]');
    const context = bin.locator('[data-recycle-context]');
    await items.first().click();
    await items.last().click({ modifiers: ['ControlOrMeta'] });
    await items.last().click({ button: 'right' });
    await expect(context).toBeVisible();
    await expect(bin.locator('[data-recycle-file][aria-pressed="true"]')).toHaveCount(2);
    await page.keyboard.press('Escape');
    await expect(context).toBeHidden();
    await expect(items.last()).toBeFocused();
    await items.last().press('Shift+F10');
    await expect(context).toBeVisible();
    await context.locator('[data-recycle-command="delete"]').click();
    const dialog = bin.locator('[data-recycle-dialog]');
    await expect(dialog.locator('[data-recycle-dialog-copy]')).toContainText('2');
    await dialog.locator('[data-recycle-confirm]').click();
    await expect(bin.locator('[data-recycle-file]:visible')).toHaveCount(1);
    await expect(bin.locator('.window-controls [data-recycle-action="close"]')).toBeFocused();
    await items.nth(1).focus();
    await page.keyboard.press('ControlOrMeta+a');
    await expect(items.nth(1)).toHaveAttribute('aria-pressed', 'true');
});
