const { test, expect } = require('@playwright/test');

test.use({ serviceWorkers: 'block' });

for (const app of ['project-folder', 'gomoku']) {
    for (const interruption of ['capture loss', 'blur', 'released button']) {
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
            const moved = await window.boundingBox();
            expect(moved.x).toBeCloseTo(initial.x + 80, 0);
            expect(moved.y).toBeCloseTo(initial.y + 60, 0);

            if (interruption === 'capture loss') {
                await titlebar.evaluate(element => element.releasePointerCapture(Number(element.dataset.pointerId)));
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
