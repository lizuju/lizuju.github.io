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
