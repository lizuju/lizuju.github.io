const { test, expect } = require('@playwright/test');

const state = page => page.evaluate(() => JSON.parse(window.render_game_to_text()));
const choose = (page, mode) => page.locator(`[data-gomoku-mode="${mode}"]`).click();
const clickPoint = async (page, row, col) => {
    const canvas = page.locator('[data-gomoku-board]');
    const point = await canvas.evaluate((element, { row, col }) => {
        const size = element.getBoundingClientRect().width;
        const margin = Math.max(16, size / 16);
        const step = (size - 2 * margin) / 14;
        return { x: margin + col * step, y: margin + row * step };
    }, { row, col });
    await canvas.click({ position: point });
};

test.beforeEach(async ({ page, isMobile }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(isMobile ? '/portfolio/?view=mobile-homepage' : '/portfolio/');
    await page.evaluate(() => window.GomokuGame.open());
    await expect(page.locator('[data-gomoku-launcher]')).toBeHidden();
    await expect(page.locator('[data-gomoku-mode-home]')).toBeVisible();
});

test('fills the game content with mode selection and preserves it through minimize and reload', async ({ page }, testInfo) => {
    const modeHome = page.locator('[data-gomoku-mode-home]');
    await expect(page.locator('[data-gomoku-board]')).toBeHidden();
    await expect(page.locator('[data-gomoku-menubar]')).toBeHidden();
    await expect(page.locator('.gomoku-statusbar')).toBeHidden();
    await expect(page.locator('[data-gomoku-dialog]')).toBeHidden();
    const windowBox = await page.locator('[data-gomoku-window]').boundingBox();
    const titleBox = await page.locator('[data-gomoku-drag]').boundingBox();
    const homeBox = await modeHome.boundingBox();
    expect(homeBox.width).toBeGreaterThanOrEqual(windowBox.width - 4);
    expect(homeBox.y).toBeCloseTo(titleBox.y + titleBox.height, 0);
    expect(homeBox.y + homeBox.height).toBeCloseTo(windowBox.y + windowBox.height - 2, 0);
    await expect(page.locator('[data-gomoku-mode="local"]')).toBeFocused();
    await page.keyboard.press('F2');
    expect(await page.evaluate(() => window.GomokuGame.playMove(7, 7))).toBe(false);
    expect((await state(page)).phase).toBe('choosing');
    await page.keyboard.press('Tab');
    await expect(page.locator('[data-gomoku-mode="computer"]')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.locator('[data-gomoku-mode="local"]')).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(page.locator('[data-gomoku-mode="computer"]')).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(page.locator('[data-gomoku-mode="local"]')).toBeFocused();
    await page.screenshot({ path: testInfo.outputPath('mode-choice.png') });

    await page.locator('[data-gomoku-drag] [data-gomoku-window-action="minimize"]').click();
    await page.locator('[data-gomoku-task]').click();
    await expect(page.locator('[data-gomoku-mode="local"]')).toBeVisible();
    await page.reload();
    await expect(page.locator('[data-gomoku-mode="local"]')).toBeVisible();
    if (!await page.locator('[data-gomoku-window]').evaluate(element => element.classList.contains('is-active'))) {
        await page.locator('[data-gomoku-task]').click();
    }
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('portfolio-language-change', { detail: { language: 'en' } })));
    await expect(modeHome.locator('h2')).toHaveText('Choose Game Mode');
    await expect(page.locator('[data-gomoku-mode="local"]')).toHaveText('Two Players');
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-gomoku-window]')).toHaveClass(/is-closed/);
    await page.evaluate(() => window.GomokuGame.open());
    await expect(page.locator('[data-gomoku-mode="computer"]')).toBeVisible();
    await page.setViewportSize({ width: 980, height: 320 });
    await page.locator('[data-gomoku-window-action="maximize"]').click();
    await expect(page.locator('[data-gomoku-window]')).toHaveClass(/is-maximized/);
    const shortHome = await modeHome.boundingBox();
    for (const button of await modeHome.locator('[data-gomoku-mode]').all()) {
        const box = await button.boundingBox();
        expect(box.y).toBeGreaterThanOrEqual(shortHome.y);
        expect(box.y + box.height).toBeLessThanOrEqual(shortHome.y + shortHome.height);
    }
    await page.screenshot({ path: testInfo.outputPath('mode-choice-short.png') });
    await choose(page, 'computer');
    expect((await state(page)).mode).toBe('computer');
    await expect(modeHome).toBeHidden();
    await expect(page.locator('[data-gomoku-board]')).toBeVisible();
});

test('returns to mode selection during a computer turn and starts a fresh game in either mode', async ({ page }, testInfo) => {
    await choose(page, 'computer');
    await expect(page.locator('[data-gomoku-back]')).toBeVisible();
    await page.evaluate(() => {
        window.GomokuGame.playMove(7, 7);
        document.querySelector('[data-gomoku-back]').click();
    });
    await page.waitForTimeout(350);
    await page.evaluate(() => window.advanceTime(1000));
    expect(await state(page)).toMatchObject({ phase: 'choosing', currentPlayer: null, moves: [], score: { human: 0, computer: 0 } });
    await expect(page.locator('[data-gomoku-mode-home]')).toBeVisible();
    await expect(page.locator('[data-gomoku-board]')).toBeHidden();
    await expect(page.locator('[data-gomoku-mode="local"]')).toBeFocused();
    await choose(page, 'local');
    expect(await state(page)).toMatchObject({ mode: 'local', phase: 'playing', currentPlayer: 'player-black', moves: [] });
    await clickPoint(page, 7, 7);
    await page.locator('[data-gomoku-menu="help"]').click();
    await page.locator('[data-gomoku-help]').click();
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-gomoku-menu="help"]')).toBeFocused();
    await page.locator('[data-gomoku-back]').click();
    await choose(page, 'computer');
    expect(await state(page)).toMatchObject({ mode: 'computer', phase: 'playing', currentPlayer: 'human-black', moves: [] });
    await page.screenshot({ path: testInfo.outputPath('game-return-control.png') });
});

test('alternates local mouse and keyboard moves, restores the white turn and undoes one stone', async ({ page }, testInfo) => {
    await choose(page, 'local');
    await expect(page.locator('[data-gomoku-status]')).toHaveText('轮到黑方落子（黑棋）');
    await clickPoint(page, 7, 7);
    await page.evaluate(() => window.advanceTime(1000));
    expect((await state(page)).moves).toEqual([{ row: 7, col: 7, player: 'player-black' }]);
    await expect(page.locator('[data-gomoku-status]')).toHaveText('轮到白方落子（白棋）');
    await page.reload();
    expect(await state(page)).toMatchObject({ mode: 'local', phase: 'playing', currentPlayer: 'player-white' });
    await expect(page.locator('[data-gomoku-dialog]')).toBeHidden();
    await page.locator('[data-gomoku-board]').focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');
    expect((await state(page)).moves.at(-1)).toEqual({ row: 7, col: 8, player: 'player-white' });
    await page.screenshot({ path: testInfo.outputPath('local-game.png') });
    await page.keyboard.press('Control+z');
    expect(await state(page)).toMatchObject({ currentPlayer: 'player-white', moves: [{ row: 7, col: 7, player: 'player-black' }] });
    await clickPoint(page, 7, 8);
    await clickPoint(page, 7, 8);
    expect((await state(page)).moves).toHaveLength(2);
    await page.keyboard.press('F2');
    expect(await state(page)).toMatchObject({ mode: 'local', phase: 'playing', currentPlayer: 'player-black', moves: [] });
    await expect(page.locator('[data-gomoku-dialog]')).toBeHidden();
    await page.locator('[data-gomoku-menu="help"]').click();
    await page.locator('[data-gomoku-help]').click();
    await expect(page.locator('[data-gomoku-dialog-copy]')).toContainText('两位玩家在本设备轮流落子');
});

test('keeps computer replies and two-stone undo after choosing the computer mode', async ({ page }) => {
    await choose(page, 'computer');
    await clickPoint(page, 7, 7);
    await page.evaluate(() => window.advanceTime(1000));
    expect((await state(page)).moves.map(move => move.player)).toEqual(['human-black', 'computer-white']);
    await expect(page.locator('[data-gomoku-status]')).toHaveText('轮到你落子（黑棋）');
    await page.keyboard.press('Control+z');
    expect(await state(page)).toMatchObject({ mode: 'computer', phase: 'playing', currentPlayer: 'human-black', moves: [] });
});

for (const winningPlayer of ['black', 'white']) {
    test(`scores a local ${winningPlayer} win and reverses the result when undoing`, async ({ page }) => {
        await choose(page, 'local');
        for (let index = 0; index < 5; index++) {
            await clickPoint(page, winningPlayer === 'black' ? 7 : 0, winningPlayer === 'black' ? index : index * 2);
            if (index < 4 || winningPlayer === 'white') await clickPoint(page, winningPlayer === 'white' ? 7 : 0, winningPlayer === 'white' ? index : index * 2);
        }
        expect(await state(page)).toMatchObject({ winner: `player-${winningPlayer}`, currentPlayer: null });
        await expect(page.locator('[data-gomoku-status]')).toContainText(winningPlayer === 'black' ? '黑方获胜' : '白方获胜');
        await expect(page.locator('[data-gomoku-score]')).toHaveText(winningPlayer === 'black' ? '1:0' : '0:1');
        const count = (await state(page)).moves.length;
        await clickPoint(page, 10, 10);
        expect((await state(page)).moves).toHaveLength(count);
        await page.keyboard.press('Control+z');
        expect(await state(page)).toMatchObject({ phase: 'playing', winner: null, currentPlayer: `player-${winningPlayer}` });
        await expect(page.locator('[data-gomoku-score]')).toHaveText('0:0');
        expect((await state(page)).moves).toHaveLength(count - 1);
    });
}
