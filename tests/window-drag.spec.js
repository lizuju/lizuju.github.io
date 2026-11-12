const { test, expect } = require('@playwright/test');

test.use({ serviceWorkers: 'block' });

for (const app of ['project-folder', 'gomoku']) {
    for (const interruption of ['capture loss', 'pointer cancel', 'blur', 'released button']) {
        test(`${app} keeps its dragged position after ${interruption} and can be dragged again`, async ({ page, isMobile }) => {
            test.skip(isMobile, 'desktop mouse capture and focus regression');
            await page.goto('/portfolio/');
            await page.locator('[data-window-action="minimize"]').click();
            await page.locator(`.desktop-shortcut[data-open-${app}]`).click();
            const window = page.locator(`[data-${app}-window]`);
            if (app === 'gomoku') await expect(page.locator('[data-gomoku-mode="local"]')).toBeVisible();
            const titlebar = window.locator('.window-titlebar').first();
            await titlebar.evaluate(element => element.addEventListener('pointerdown', event => {
                element.dataset.pointerId = String(event.pointerId);
            }));
            const title = await titlebar.boundingBox();
            const start = { x: title.x + 80, y: title.y + 10 };
            const target = { x: start.x + 80, y: start.y + 60 };
            const initial = await window.boundingBox();
            await page.mouse.move(start.x, start.y);
            await page.mouse.down();
            await page.mouse.move(target.x, target.y, { steps: 5 });
            await expect.poll(async () => {
                const box = await window.boundingBox();
                return [Math.round(box.x - initial.x), Math.round(box.y - initial.y)];
            }).toEqual([80, 60]);
            const moved = await window.boundingBox();
            expect(moved.x).toBeCloseTo(initial.x + 80, 0);
            expect(moved.y).toBeCloseTo(initial.y + 60, 0);

            if (interruption === 'capture loss') {
                await titlebar.evaluate(element => element.releasePointerCapture(Number(element.dataset.pointerId)));
            } else if (interruption === 'pointer cancel') {
                await titlebar.evaluate(element => document.dispatchEvent(new PointerEvent('pointercancel', {
                    pointerId: Number(element.dataset.pointerId), pointerType: 'mouse', bubbles: true
                })));
            } else if (interruption === 'blur') {
                await page.evaluate(() => window.dispatchEvent(new Event('blur')));
            } else {
                await titlebar.evaluate((element, start) => document.dispatchEvent(new PointerEvent('pointermove', {
                    pointerId: Number(element.dataset.pointerId), pointerType: 'mouse', buttons: 0,
                    clientX: start.x, clientY: start.y, bubbles: true
                })), start);
            }
            await page.mouse.move(start.x, start.y);
            expect(await window.boundingBox()).toEqual(moved);
            await expect(window).not.toHaveClass(/is-dragging/);
            await page.mouse.up();

            const next = await titlebar.boundingBox();
            await page.mouse.move(next.x + 80, next.y + 10);
            await page.mouse.down();
            await page.mouse.move(next.x + 110, next.y + 30, { steps: 4 });
            await page.mouse.up();
            const final = await window.boundingBox();
            expect(final.x).toBeCloseTo(moved.x + 30, 0);
            expect(final.y).toBeCloseTo(moved.y + 20, 0);
            await page.mouse.move(start.x, start.y);
            expect(await window.boundingBox()).toEqual(final);
        });
    }
}

for (const action of ['drag', 'resize']) {
    test(`${action} batches rapid moves and applies the release position before the next frame`, async ({ page, isMobile }) => {
        test.skip(isMobile, 'desktop pointer geometry regression');
        await page.goto('/portfolio/');
        await page.locator('[data-window-action="minimize"]').click();
        await page.locator('.desktop-shortcut[data-open-project-folder]').click();
        const app = page.locator('[data-project-folder-window]');
        const handle = page.locator(`[data-project-folder-${action}]`);
        await handle.evaluate(element => element.addEventListener('pointerdown', event => {
            element.dataset.pointerId = String(event.pointerId);
            element.dataset.pointerX = String(event.clientX);
            element.dataset.pointerY = String(event.clientY);
        }));
        const box = await handle.boundingBox();
        const start = action === 'drag'
            ? { x: box.x + 80, y: box.y + 10 }
            : { x: box.x + box.width / 2, y: box.y + box.height / 2 };
        await page.mouse.move(start.x, start.y);
        await page.mouse.down();
        const positions = await handle.evaluate(element => {
            const app = element.closest('.app-window');
            const start = { x: Number(element.dataset.pointerX), y: Number(element.dataset.pointerY) };
            const geometry = () => {
                const box = app.getBoundingClientRect();
                return { x: box.x, y: box.y, width: box.width, height: box.height };
            };
            const before = geometry();
            const dispatch = (type, dx, dy) => document.dispatchEvent(new PointerEvent(type, {
                pointerId: Number(element.dataset.pointerId), pointerType: 'mouse',
                buttons: type === 'pointerup' ? 0 : 1,
                clientX: start.x + dx, clientY: start.y + dy, bubbles: true
            }));
            dispatch('pointermove', 10, 5);
            dispatch('pointermove', 30, 20);
            const pending = geometry();
            dispatch('pointerup', 60, 40);
            return { before, pending, released: geometry() };
        });
        expect(positions.pending).toEqual(positions.before);
        const changes = action === 'drag' ? { x: 60, y: 40 } : { width: 60, height: 40 };
        for (const [key, value] of Object.entries(positions.before)) {
            expect(positions.released[key]).toBeCloseTo(value + (changes[key] || 0), 0);
        }
        await expect(app).not.toHaveClass(/is-dragging|is-resizing/);
        await page.mouse.up();
        await page.evaluate(() => new Promise(requestAnimationFrame));
        const final = await app.boundingBox();
        expect(final).toEqual(positions.released);
    });
}
