const { test, expect } = require('@playwright/test');

test('keeps keyboard input inside shutdown until restarting from the button', async ({ page }) => {
    await page.clock.install();
    await page.goto('/portfolio/');
    const screen = page.locator('[data-shutdown-screen]');
    const restart = page.locator('[data-restart]');
    const background = page.locator('[data-retro-desktop] > :not([data-shutdown-screen])');
    const initialInert = await background.evaluateAll((elements) => elements.map((element) => element.inert));
    await page.evaluate(() => {
        window.shutdownKeyEvents = [];
        ['keydown', 'keyup'].forEach((type) => {
            document.addEventListener(type, (event) => window.shutdownKeyEvents.push(`${type}:${event.key}`));
        });
    });

    await page.locator('[data-start-toggle]').click();
    await page.locator('[data-shutdown]').click();
    await expect(screen).toBeFocused();
    await expect(restart).toBeHidden();
    expect(await background.evaluateAll((elements) => elements.every((element) => element.inert))).toBe(true);
    await page.keyboard.press('Tab');
    await expect(screen).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(screen).toBeFocused();
    await page.keyboard.press('f');
    expect(await page.evaluate(() => window.shutdownKeyEvents)).toEqual([]);

    const animationDuration = await page.evaluate(() => window.GavinDesktop.t().shutdownLines.length * 450);
    await page.clock.runFor(animationDuration);
    await expect(restart).toBeVisible();
    await expect(restart).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(restart).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(restart).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(screen).toBeHidden();
    await expect(page.locator('[data-lang-toggle]')).toBeFocused();
    expect(await background.evaluateAll((elements) => elements.map((element) => element.inert))).toEqual(initialInert);
    await page.locator('[data-taskbar-lang]').click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
});

test('restores background interaction and focus after automatic restart', async ({ page }) => {
    await page.clock.install();
    await page.goto('/portfolio/');
    await page.locator('[data-start-toggle]').click();
    await page.locator('[data-shutdown]').click();
    const animationDuration = await page.evaluate(() => window.GavinDesktop.t().shutdownLines.length * 450);
    await page.clock.runFor(animationDuration + 12000);
    await expect(page.locator('[data-shutdown-screen]')).toBeHidden();
    await expect(page.locator('[data-lang-toggle]')).toBeFocused();
    expect(await page.locator('[data-retro-desktop] > :not([data-shutdown-screen])')
        .evaluateAll((elements) => elements.every((element) => !element.inert))).toBe(true);
    await page.locator('[data-start-toggle]').click();
    await expect(page.locator('[data-start-menu]')).toBeVisible();
});
