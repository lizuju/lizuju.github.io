const { test, expect } = require('@playwright/test');

test.beforeEach(async ({ page, isMobile }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(isMobile ? '/portfolio/?view=mobile-homepage' : '/portfolio/');
    await page.evaluate(() => window.GomokuGame.open());
    await expect(page.locator('[data-gomoku-launcher]')).toBeHidden();
});

test('keeps Gomoku help focus inside the dialog and blocks game shortcuts', async ({ page }) => {
    await page.evaluate(() => window.GomokuGame.loadPosition([
        { row: 7, col: 7, player: 0 },
        { row: 7, col: 8, player: 1 }
    ]));
    const gameWindow = page.locator('[data-gomoku-window]');
    const helpMenu = page.locator('[data-gomoku-menu="help"]');
    await helpMenu.focus();
    await helpMenu.press('ArrowDown');
    await page.locator('[data-gomoku-help]').press('Enter');

    const dialog = page.locator('[data-gomoku-dialog]');
    const closeButtons = dialog.locator('[data-gomoku-dialog-close]');
    await expect(dialog).toBeVisible();
    await expect(closeButtons.first()).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(closeButtons.last()).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(closeButtons.first()).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(closeButtons.last()).toBeFocused();

    const stateBefore = await page.evaluate(() => window.render_game_to_text());
    const maximizedBefore = await gameWindow.evaluate((element) => element.classList.contains('is-maximized'));
    await page.keyboard.press('F2');
    await page.keyboard.press('Control+z');
    await page.keyboard.press('f');
    await page.locator('[data-gomoku-board]').focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');
    expect(await page.evaluate(() => window.render_game_to_text())).toBe(stateBefore);
    expect(await gameWindow.evaluate((element) => element.classList.contains('is-maximized'))).toBe(maximizedBefore);

    await page.keyboard.press('Tab');
    await expect(closeButtons.first()).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(helpMenu).toBeFocused();
});

test('restores the Gomoku menu focus after every about dialog close action', async ({ page }) => {
    const helpMenu = page.locator('[data-gomoku-menu="help"]');
    const dialog = page.locator('[data-gomoku-dialog]');

    for (const closeAction of ['titlebar', 'ok', 'escape']) {
        await helpMenu.click();
        await page.locator('[data-gomoku-about]').click();
        await expect(dialog).toBeVisible();
        await page.evaluate(() => window.dispatchEvent(new CustomEvent('portfolio-language-change', {
            detail: { language: 'en' }
        })));
        await expect(page.locator('[data-gomoku-dialog-title]')).toHaveText('About Gomoku');

        if (closeAction === 'escape') await page.keyboard.press('Escape');
        else {
            const closeButtons = dialog.locator('[data-gomoku-dialog-close]');
            await (closeAction === 'titlebar' ? closeButtons.first() : closeButtons.last()).click();
        }

        await expect(dialog).toBeHidden();
        await expect(helpMenu).toBeFocused();
    }
});
