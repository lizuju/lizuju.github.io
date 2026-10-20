const { test, expect } = require('@playwright/test');

test('restores desktop sections through browser Back and Forward', async ({ page, isMobile }) => {
    test.skip(isMobile, 'this regression concerns desktop history navigation');
    await page.goto('/portfolio/');

    const scroll = page.locator('[data-window-scroll]');
    const viewMenu = page.locator('[data-window-menu-popup="portfolio-view"]');
    const settledScrollTop = () => scroll.evaluate((element) => new Promise((resolve) => {
        let previousTop = element.scrollTop;
        let stableFrames = 0;
        const checkScroll = () => {
            const nextTop = element.scrollTop;
            stableFrames = Math.abs(nextTop - previousTop) < 0.1 ? stableFrames + 1 : 0;
            previousTop = nextTop;
            if (stableFrames >= 6 && nextTop > 0) resolve(nextTop);
            else window.requestAnimationFrame(checkScroll);
        };
        window.requestAnimationFrame(checkScroll);
    }));

    await page.locator('[data-window-menu="portfolio-view"]').click();
    await viewMenu.locator('[data-menu-action="portfolio-projects"]').click();
    await expect(page).toHaveURL(/#projects$/);
    const projectsTop = await settledScrollTop();

    await page.locator('[data-window-menu="portfolio-view"]').click();
    await viewMenu.locator('[data-menu-action="portfolio-contact"]').click();
    await expect(page).toHaveURL(/#contact$/);
    const contactTop = await settledScrollTop();
    expect(contactTop).toBeGreaterThan(projectsTop);

    await page.goBack();
    await expect(page).toHaveURL(/#projects$/);
    await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBeCloseTo(projectsTop, 0);

    await page.goForward();
    await expect(page).toHaveURL(/#contact$/);
    await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBeCloseTo(contactTop, 0);

    await page.goBack();
    await page.goBack();
    await expect(page).toHaveURL(/\/portfolio\/$/);
    await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBe(0);
});
