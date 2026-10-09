const { test, expect } = require('@playwright/test');

test('prints the complete homepage without desktop windows or scroll clipping', async ({ page, browserName, isMobile }) => {
    test.skip(isMobile, 'print pagination runs once per browser engine');
    await page.goto('/portfolio/');
    await page.locator('[data-window-action="minimize"]').click();
    await page.locator('.desktop-shortcut[data-open-mail-window]').click();
    await expect(page.locator('[data-mail-window]')).toBeVisible();

    await page.emulateMedia({ media: 'print' });

    await expect(page.locator('[data-app-window]')).toBeVisible();
    await expect(page.locator('[data-mail-window]')).toBeHidden();
    await expect(page.locator('.desktop-taskbar')).toBeHidden();
    await expect(page.locator('.desktop-shortcuts')).toBeHidden();
    await expect(page.locator('[data-window-drag]')).toBeHidden();
    await expect(page.locator('[data-window-menubar]').first()).toBeHidden();
    await expect(page.locator('#contact')).toBeVisible();

    const layout = await page.evaluate(() => {
        const scroll = document.querySelector('[data-window-scroll]');
        const contact = document.querySelector('#contact').getBoundingClientRect();
        return {
            documentHeight: document.documentElement.scrollHeight,
            viewportHeight: window.innerHeight,
            scrollHeight: scroll.scrollHeight,
            scrollClientHeight: scroll.clientHeight,
            contactBottom: contact.bottom,
            scrollBottom: scroll.getBoundingClientRect().bottom,
            hiddenReveals: [...document.querySelectorAll('[data-app-window] .reveal')]
                .filter((element) => getComputedStyle(element).opacity !== '1').length
        };
    });
    expect(layout.documentHeight).toBeGreaterThan(layout.viewportHeight * 2);
    expect(layout.scrollHeight).toBeLessThanOrEqual(layout.scrollClientHeight + 1);
    expect(layout.contactBottom).toBeLessThanOrEqual(layout.scrollBottom + 1);
    expect(layout.hiddenReveals).toBe(0);

    if (browserName === 'chromium') {
        const pdf = await page.pdf({ format: 'A4' });
        const pages = pdf.toString('latin1').match(/\/Type \/Page\b/g);
        expect(pages.length).toBeGreaterThan(1);
    }
});
