const { test, expect } = require('@playwright/test');

const viewports = [
    { name: 'mobile portrait', width: 320, height: 568 },
    { name: 'mobile landscape', width: 844, height: 390 },
    { name: 'desktop', width: 1366, height: 768 },
];

test('keeps critical portfolio regions within every target viewport', async ({ page, isMobile }) => {
    test.skip(isMobile, 'the viewport matrix runs once per browser engine');

    const browserErrors = [];
    page.on('console', (message) => {
        if (message.type() === 'error') browserErrors.push(`console: ${message.text()}`);
    });
    page.on('pageerror', (error) => browserErrors.push(`pageerror: ${error.message}`));

    for (const viewport of viewports) {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await page.goto('/portfolio/', { waitUntil: 'domcontentloaded' });
        await expect(page.locator('[data-retro-desktop]')).toBeVisible();
        await expect(page.locator('[data-app-window]')).toBeVisible();

        const layout = await page.evaluate(() => {
            const rect = (selector) => document.querySelector(selector)?.getBoundingClientRect();
            const overlaps = (first, second) => Boolean(first && second
                && first.left < second.right
                && first.right > second.left
                && first.top < second.bottom
                && first.bottom > second.top);
            const insideViewport = (box) => Boolean(box
                && box.left >= -1
                && box.top >= -1
                && box.right <= window.innerWidth + 1
                && box.bottom <= window.innerHeight + 1);

            const desktop = rect('[data-retro-desktop]');
            const appWindow = rect('[data-app-window]');
            const taskbar = rect('.desktop-taskbar');
            const title = rect('[data-window-drag] .window-title');
            const windowControls = rect('[data-window-drag] .window-controls');
            const brand = rect('.brand');
            const headerActions = rect('.header-actions');
            const windowScroll = document.querySelector('[data-window-scroll]');
            const systemSteps = [...document.querySelectorAll('.system-map > div')];

            return {
                documentFits: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
                windowContentFits: windowScroll.scrollWidth <= windowScroll.clientWidth,
                desktopFits: insideViewport(desktop),
                appFits: insideViewport(appWindow),
                appClearsTaskbar: appWindow.bottom <= taskbar.top + 1,
                titleClearsControls: !overlaps(title, windowControls),
                brandClearsActions: !overlaps(brand, headerActions),
                systemStepsFit: systemSteps.every((step) => (
                    step.scrollWidth <= step.clientWidth + 1
                    && step.scrollHeight <= step.clientHeight + 1
                )),
            };
        });

        expect(layout, `${viewport.name} (${viewport.width}x${viewport.height})`).toEqual({
            documentFits: true,
            windowContentFits: true,
            desktopFits: true,
            appFits: true,
            appClearsTaskbar: true,
            titleClearsControls: true,
            brandClearsActions: true,
            systemStepsFit: true,
        });
    }

    expect(browserErrors).toEqual([]);
});

test('keeps homepage text readable when resizing its window on a wide desktop', async ({ page, isMobile }) => {
    test.skip(isMobile, 'desktop window resizing uses a mouse');
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.goto('/portfolio/');
    const appWindow = page.locator('[data-app-window]');
    await appWindow.locator('[data-window-action="maximize"]').click();

    for (const width of [520, 640, 900, 1040, 1200, 520]) {
        const before = await appWindow.boundingBox();
        const grip = await page.locator('[data-window-resize]').boundingBox();
        await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
        await page.mouse.down();
        await page.mouse.move(grip.x + grip.width / 2 + width - before.width,
            grip.y + grip.height / 2 + (width === 520 ? 360 : 600) - before.height, { steps: 4 });
        await page.mouse.up();
        expect(Math.abs((await appWindow.boundingBox()).width - width)).toBeLessThan(2);

        for (const language of ['zh-CN', 'en']) {
            if (await page.locator('html').getAttribute('lang') !== language) {
                await page.locator('[data-taskbar-lang]').click();
            }
            await page.locator('[data-window-scroll]').evaluate(element => { element.scrollTop = 0; });
            const layout = await page.evaluate(() => {
                const scroll = document.querySelector('[data-window-scroll]');
                const content = scroll.getBoundingClientRect();
                const blocks = [...scroll.querySelectorAll('.section, .hero-copy, .hero-visual, .project-card, .method-step, .skill-card, .contact-item')];
                const titleLines = [...scroll.querySelectorAll('.hero h1 span')];
                return {
                    fits: scroll.scrollWidth <= scroll.clientWidth + 1,
                    blocksFit: blocks.every(element => {
                        const box = element.getBoundingClientRect();
                        return box.left >= content.left && box.right <= content.right
                            && element.scrollWidth <= element.clientWidth + 1;
                    }),
                    titleReadable: titleLines.every(element => element.getBoundingClientRect().height
                        < Number.parseFloat(getComputedStyle(element).fontSize) * 2.2)
                };
            });
            expect(layout, `${width}px, ${language}`).toEqual({ fits: true, blocksFit: true, titleReadable: true });
        }
    }

    await page.locator('[data-menu-toggle]').click();
    await page.locator('[data-mobile-menu] a[href="#projects"]').click();
    await expect.poll(() => page.evaluate(() => {
        const header = document.querySelector('.site-header').getBoundingClientRect();
        const section = document.querySelector('#projects').getBoundingClientRect();
        return Math.abs(section.top - header.bottom) <= 2;
    })).toBe(true);
    await appWindow.locator('[data-window-action="maximize"]').click();
    await expect(page.locator('.desktop-nav')).toBeVisible();
});
