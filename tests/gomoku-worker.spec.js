const { test, expect } = require('@playwright/test');

const state = page => page.evaluate(() => JSON.parse(window.render_game_to_text()));
const choose = page => page.locator('[data-gomoku-mode="computer"]').click();
const beginSearch = page => page.evaluate(() => {
    window.GomokuGame.playMove(7, 7);
    window.advanceTime(1000);
});
const controlledWorker = page => page.evaluate(() => {
    const NativeWorker = window.Worker;
    window.gomokuJobs = [];
    window.Worker = class {
        constructor(url, options) {
            if (!String(url).includes('gomoku-engine.js')) return new NativeWorker(url, options);
            window.gomokuJobs.push(this);
        }
        postMessage(data) { this.history = structuredClone(data.history); }
        terminate() { this.terminated = true; }
    };
});

test.beforeEach(async ({ page, isMobile }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(isMobile ? '/portfolio/?view=mobile-homepage' : '/portfolio/');
    await page.evaluate(() => window.GomokuGame.open());
    await expect(page.locator('[data-gomoku-launcher]')).toBeHidden();
    await choose(page);
});

test('computes real replies in a worker and supports Command undo with translated help', async ({ page }) => {
    const workerCreated = page.waitForEvent('worker', worker => worker.url().includes('gomoku-engine.js'));
    await page.evaluate(() => window.GomokuGame.playMove(7, 7));
    const worker = await workerCreated;
    await expect.poll(async () => (await state(page)).phase).toBe('playing');
    expect((await state(page)).moves.map(move => move.player)).toEqual(['human-black', 'computer-white']);
    expect(worker.url()).toContain('/portfolio/js/gomoku-engine.js?');
    expect(await page.evaluate(() => typeof window.GomokuEngine)).toBe('undefined');
    await page.keyboard.press('Meta+z');
    expect((await state(page)).moves).toEqual([]);
    await page.locator('[data-gomoku-menu="help"]').click();
    await page.locator('[data-gomoku-help]').click();
    await expect(page.locator('[data-gomoku-dialog-copy]')).toContainText('Ctrl/Cmd+Z：悔棋');
    await page.keyboard.press('Meta+z');
    await expect(page.locator('[data-gomoku-dialog]')).toBeVisible();
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('portfolio-language-change', { detail: { language: 'en' } })));
    await expect(page.locator('[data-gomoku-dialog-copy]')).toContainText('Ctrl/Cmd+Z: Undo');
});

test('cancels pending searches on undo, mode selection and close without accepting late results', async ({ page }) => {
    await controlledWorker(page);
    for (const action of ['undo', 'mode', 'close']) {
        await beginSearch(page);
        await expect.poll(async () => (await state(page)).phase).toBe('thinking');
        await expect(page.locator('[data-gomoku-undo]')).toBeEnabled();
        if (action === 'undo') await page.keyboard.press('Meta+z');
        if (action === 'mode') await page.locator('[data-gomoku-back]').click();
        if (action === 'close') await page.locator('[data-gomoku-drag] [data-gomoku-window-action="close"]').click();
        const before = await state(page);
        expect(await page.evaluate(() => window.gomokuJobs.at(-1).terminated)).toBe(true);
        await page.evaluate(() => window.gomokuJobs.at(-1).onmessage({ data: { move: [7, 8] } }));
        expect(await state(page)).toEqual(before);
        if (action === 'mode') await choose(page);
        if (action === 'close') {
            await page.evaluate(() => window.GomokuGame.open());
            await choose(page);
        }
    }
});

test('ignores a previous round reply while the new round is still searching', async ({ page }) => {
    await controlledWorker(page);
    await beginSearch(page);
    await page.keyboard.press('F2');
    await beginSearch(page);
    await page.evaluate(() => window.gomokuJobs[0].onmessage({ data: { move: [0, 0] } }));
    expect(await state(page)).toMatchObject({ phase: 'thinking', moves: [{ row: 7, col: 7, player: 'human-black' }] });
    await page.evaluate(() => window.gomokuJobs[1].onmessage({ data: { move: [7, 8] } }));
    expect(await state(page)).toMatchObject({ phase: 'playing', moves: [
        { row: 7, col: 7, player: 'human-black' }, { row: 7, col: 8, player: 'computer-white' }
    ] });
    expect(await page.evaluate(() => window.gomokuJobs.every(job => job.terminated))).toBe(true);
});

test('recovers from worker errors, invalid moves and a stalled search', async ({ page }) => {
    await controlledWorker(page);
    await page.clock.install();
    for (const failure of ['error', 'invalid', 'timeout']) {
        await beginSearch(page);
        if (failure === 'error') await page.evaluate(() => window.gomokuJobs.at(-1).onerror(new Event('error', { cancelable: true })));
        if (failure === 'invalid') await page.evaluate(() => window.gomokuJobs.at(-1).onmessage({ data: { move: [7, 7] } }));
        if (failure === 'timeout') await page.clock.runFor(15001);
        const game = await state(page);
        expect(game.phase).toBe('playing');
        expect(game.moves).toHaveLength(2);
        expect(game.moves[1].player).toBe('computer-white');
        expect([game.moves[1].row, game.moves[1].col]).not.toEqual([7, 7]);
        expect(await page.evaluate(() => window.gomokuJobs.at(-1).terminated)).toBe(true);
        await page.keyboard.press('Control+z');
        expect((await state(page)).moves).toEqual([]);
    }
});
