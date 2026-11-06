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
        postMessage(data) { this.history = structuredClone(data.history); this.difficulty = data.difficulty; }
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

test('changes difficulty without discarding the board and cancels the previous search', async ({ page }, testInfo) => {
    const selector = page.getByRole('combobox', { name: '难度' });
    await expect(selector).toHaveValue('normal');
    await controlledWorker(page);
    await beginSearch(page);
    await selector.selectOption('challenge');
    await page.evaluate(() => { window.advanceTime(1000); });
    expect(await page.evaluate(() => window.gomokuJobs.map(job => ({ difficulty: job.difficulty, terminated: !!job.terminated })))).toEqual([
        { difficulty: 'normal', terminated: true }, { difficulty: 'challenge', terminated: false }
    ]);
    await page.evaluate(() => window.gomokuJobs[0].onmessage({ data: { move: [0, 0] } }));
    expect(await state(page)).toMatchObject({ difficulty: 'challenge', phase: 'thinking', moves: [{ row: 7, col: 7, player: 'human-black' }] });
    await page.evaluate(() => window.gomokuJobs[1].onmessage({ data: { move: [7, 8] } }));
    expect((await state(page)).moves).toHaveLength(2);
    await page.reload();
    await expect(selector).toHaveValue('challenge');
    expect((await state(page)).moves).toHaveLength(2);
    await page.evaluate(() => window.GomokuGame.open());
    await page.locator('[data-gomoku-back]').click();
    await page.locator('[data-gomoku-mode="local"]').click();
    await expect(selector).toBeHidden();
    await page.locator('[data-gomoku-back]').click();
    await choose(page);
    await expect(selector).toHaveValue('challenge');
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('portfolio-language-change', { detail: { language: 'en' } })));
    const translated = page.getByRole('combobox', { name: 'Difficulty' });
    await expect(translated).toHaveValue('challenge');
    await expect(translated.locator('option')).toHaveText(['Easy', 'Normal', 'Challenge']);
    const bar = page.locator('[data-gomoku-menubar]');
    const bounds = await bar.boundingBox();
    const selectBounds = await translated.boundingBox();
    const backBounds = await page.locator('[data-gomoku-back]').boundingBox();
    expect(selectBounds.x + selectBounds.width).toBeLessThanOrEqual(backBounds.x);
    expect(backBounds.x + backBounds.width).toBeLessThanOrEqual(bounds.x + bounds.width);
    await page.screenshot({ path: testInfo.outputPath('difficulty-controls.png') });
    await page.setViewportSize({ width: 320, height: 568 });
    const grip = await page.locator('[data-gomoku-resize]').boundingBox();
    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
    await page.mouse.down();
    await page.mouse.move(grip.x + grip.width / 2 - 100, grip.y + grip.height / 2);
    await page.mouse.up();
    const narrowBar = await bar.boundingBox();
    for (const control of [translated, page.locator('[data-gomoku-back]')]) {
        const box = await control.boundingBox();
        expect(box.x).toBeGreaterThanOrEqual(narrowBar.x);
        expect(box.x + box.width).toBeLessThanOrEqual(narrowBar.x + narrowBar.width);
        expect(box.y + box.height).toBeLessThanOrEqual(narrowBar.y + narrowBar.height);
    }
    const frame = await page.locator('[data-gomoku-board-frame]').boundingBox();
    const canvas = await page.locator('[data-gomoku-board]').boundingBox();
    expect(canvas.x).toBeGreaterThanOrEqual(frame.x);
    expect(canvas.y).toBeGreaterThanOrEqual(frame.y);
    expect(canvas.x + canvas.width).toBeLessThanOrEqual(frame.x + frame.width);
    expect(canvas.y + canvas.height).toBeLessThanOrEqual(frame.y + frame.height);
    await page.screenshot({ path: testInfo.outputPath('difficulty-controls-resized.png') });
});

test('keeps the worker tactical candidate when deeper search reaches its time limit', async ({ page }) => {
    await controlledWorker(page);
    await page.clock.install();
    await page.locator('[data-gomoku-difficulty]').selectOption('challenge');
    await beginSearch(page);
    await page.evaluate(() => window.gomokuJobs.at(-1).onmessage({ data: { candidate: [7, 8] } }));
    expect((await state(page)).phase).toBe('thinking');
    await page.clock.runFor(15001);
    expect((await state(page)).moves.at(-1)).toMatchObject({ row: 7, col: 8, player: 'computer-white' });
    expect(await page.evaluate(() => window.gomokuJobs.at(-1).terminated)).toBe(true);
});

test('all three real difficulty workers take wins and block immediate losses', async ({ page }) => {
    const replies = await page.evaluate(async () => {
        const positions = {
            win: [[0, 0, 0], [7, 3, 1], [0, 2, 0], [7, 4, 1], [0, 4, 0], [7, 5, 1], [1, 1, 0], [7, 6, 1], [3, 4, 0]],
            block: [[7, 3, 0], [7, 2, 1], [7, 4, 0], [0, 2, 1], [7, 5, 0], [0, 4, 1], [7, 6, 0]]
        };
        const results = [];
        for (const [position, moves] of Object.entries(positions)) {
            for (const difficulty of ['simple', 'normal', 'challenge']) {
                const move = await new Promise((resolve, reject) => {
                    const worker = new Worker('/portfolio/js/gomoku-engine.js');
                    worker.onerror = error => { worker.terminate(); reject(new Error(error.message)); };
                    worker.onmessage = ({ data }) => {
                        if (data.candidate) return;
                        worker.terminate();
                        if (data.error) reject(new Error('worker failed'));
                        else resolve(data.move);
                    };
                    worker.postMessage({ difficulty, history: moves.map(([row, col, player]) => ({ row, col, player })) });
                });
                results.push({ position, difficulty, move });
            }
        }
        return results;
    });
    for (const { position, move } of replies) {
        if (position === 'win') expect([[7, 2], [7, 7]]).toContainEqual(move);
        else expect(move).toEqual([7, 7]);
    }
});
