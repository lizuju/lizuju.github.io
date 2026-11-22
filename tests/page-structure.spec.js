const { test, expect } = require('@playwright/test');

test.use({ serviceWorkers: 'block' });

test('the home page paints its boot screen before the scene scripts load, and React takes over in place', async ({ page, isMobile }) => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    // Hold the scene's script chunks so the page shows only what the HTML itself carries.
    await page.route(/\/(immersive|\d+)\.[0-9a-f]+\.js$/, async route => { await gate; await route.continue(); });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    const boot = page.locator('#boot-screen');
    if (isMobile) {
        await expect(boot).toBeHidden();
        release();
        return;
    }
    await expect(boot).toBeVisible();
    await expect(boot).toContainText('GAVIN BIOS / PORTFOLIO SYSTEM');
    await expect(boot).toContainText('Please wait');
    const staticLines = await boot.locator('p').evaluateAll(lines => lines.slice(0, 7).map(p => {
        const box = p.getBoundingClientRect();
        return [p.textContent.trim(), Math.round(box.left), Math.round(box.top)];
    }));
    release();
    await expect(page.locator('.loading-screen-header')).toBeVisible();
    await expect(boot).toHaveCount(0);
    // React's first frame puts the same lines in the same places.
    const reactLines = await page.locator('#ui-app p').evaluateAll(lines => lines.slice(0, 7).map(p => {
        const box = p.getBoundingClientRect();
        return [p.textContent.trim(), Math.round(box.left), Math.round(box.top)];
    }));
    expect(reactLines).toEqual(staticLines);
});

test('the portfolio has one top-level main landmark and shows the scene link landmark only with the link', async ({ page, isMobile }) => {
    await page.goto(isMobile ? '/portfolio/?view=mobile-homepage' : '/portfolio/');
    await expect(page.getByRole('main')).toHaveCount(1);
    await expect(page.getByRole('main')).toHaveAttribute('data-app-window', '');
    await expect(page.locator('main')).toHaveCount(0);
    const sceneNav = page.getByRole('navigation', { name: '沉浸式场景 / Immersive scene' });
    if (isMobile) await expect(sceneNav).toHaveCount(0);
    else await expect(sceneNav.getByRole('link', { name: '返回沉浸式场景 / Back to immersive scene' })).toBeVisible();
});

test('window buttons are at least 24 px square on touch screens and keep their classic size with a mouse', async ({ page, isMobile }) => {
    await page.goto(isMobile ? '/portfolio/?view=mobile-homepage' : '/portfolio/');
    const sizes = await page.locator('[data-app-window] > .window-titlebar .window-controls button').evaluateAll(buttons =>
        buttons.filter(button => button.getBoundingClientRect().width).map(button => {
            const box = button.getBoundingClientRect();
            return [Math.round(box.width), Math.round(box.height)];
        }));
    expect(sizes.length).toBeGreaterThan(0);
    for (const [width, height] of sizes) {
        if (isMobile) {
            expect(width).toBeGreaterThanOrEqual(24);
            expect(height).toBeGreaterThanOrEqual(24);
        } else {
            expect([width, height]).toEqual([22, 20]);
        }
    }
});

test('the not-found page has a main landmark and a level-one heading', async ({ page, isMobile }) => {
    test.skip(isMobile, 'the static error page only needs one browser pass');
    await page.goto('/404.html');
    await expect(page.getByRole('main', { name: /找不到文件/ })).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('C:\\GAVIN - 找不到文件 / File Not Found');
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
});
