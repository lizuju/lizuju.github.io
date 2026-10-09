const { test, expect } = require('@playwright/test');

test('preserves the mail draft when the service rejects delivery with HTTP 200', async ({ page, isMobile }) => {
    test.skip(isMobile, 'this regression exercises the desktop mail composer');
    const endpoint = 'https://formsubmit.co/ajax/gavinxleele@gmail.com';
    await page.route(endpoint, (route) => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: 'false', message: 'Delivery was rejected.' })
    }));

    await page.goto('/portfolio/');
    await page.locator('[data-window-action="minimize"]').click();
    await page.locator('.desktop-shortcut[data-open-mail-window]').click();
    const mailForm = page.locator('[data-mail-form]');
    await mailForm.locator('input[name="name"]').fill('Rejected visitor');
    await mailForm.locator('input[name="email"]').fill('rejected@example.com');
    await mailForm.locator('input[name="company"]').fill('Regression company');
    await mailForm.locator('textarea[name="message"]').fill('Keep this draft if delivery fails.');
    await mailForm.locator('[data-mail-send]').click();

    await expect(page.locator('[data-mail-status]')).toContainText('发送失败');
    await expect(mailForm.locator('[data-mail-send]')).toBeEnabled();
    await expect(mailForm.locator('input[name="name"]')).toHaveValue('Rejected visitor');
    await expect(mailForm.locator('input[name="email"]')).toHaveValue('rejected@example.com');
    await expect(mailForm.locator('input[name="company"]')).toHaveValue('Regression company');
    await expect(mailForm.locator('textarea[name="message"]')).toHaveValue('Keep this draft if delivery fails.');
});

test('restores a pending mail draft as unconfirmed after a reload', async ({ page, isMobile }) => {
    test.skip(isMobile, 'this regression exercises the desktop mail composer');
    const endpoint = 'https://formsubmit.co/ajax/gavinxleele@gmail.com';
    let releaseResponse;
    const responseGate = new Promise((resolve) => { releaseResponse = resolve; });
    await page.route(endpoint, async (route) => {
        await responseGate;
        await route.abort('aborted');
    });

    await page.goto('/portfolio/');
    await page.locator('[data-window-action="minimize"]').click();
    await page.locator('.desktop-shortcut[data-open-mail-window]').click();
    const mailForm = page.locator('[data-mail-form]');
    await mailForm.locator('input[name="name"]').fill('Pending visitor');
    await mailForm.locator('input[name="email"]').fill('pending@example.com');
    await mailForm.locator('textarea[name="message"]').fill('Keep this draft across the reload.');

    try {
        const sentRequest = page.waitForRequest((request) => request.url() === endpoint && request.method() === 'POST');
        await mailForm.locator('[data-mail-send]').click();
        await sentRequest;
        await expect(page.locator('[data-mail-status]')).toContainText('正在发送');
        await expect(mailForm.locator('[data-mail-send]')).toBeDisabled();
        await page.reload();

        await expect(page.locator('[data-mail-window]')).toBeVisible();
        await expect(page.locator('[data-mail-status]')).toContainText('上次发送结果未确认');
        await expect(mailForm.locator('[data-mail-send]')).toBeEnabled();
        await expect(mailForm.locator('input[name="name"]')).toHaveValue('Pending visitor');
        await expect(mailForm.locator('input[name="email"]')).toHaveValue('pending@example.com');
        await expect(mailForm.locator('textarea[name="message"]')).toHaveValue('Keep this draft across the reload.');
    } finally {
        releaseResponse();
    }
});

test('keeps mobile section deep links and browser Back below the header', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'this regression concerns mobile section navigation');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/portfolio/?view=mobile-homepage#projects');

    await expect.poll(() => page.evaluate(() => {
        const header = document.querySelector('.site-header').getBoundingClientRect();
        const section = document.querySelector('#projects').getBoundingClientRect();
        const title = document.querySelector('#projects-title').getBoundingClientRect();
        return section.top >= header.bottom - 1 && section.top <= header.bottom + 2
            && title.top >= header.bottom - 1;
    })).toBe(true);

    await page.locator('[data-menu-toggle]').click();
    await page.locator('.mobile-menu a[href="#contact"]').click();
    await expect(page).toHaveURL(/#contact$/);
    await expect.poll(() => page.locator('#contact').evaluate((section) => (
        section.getBoundingClientRect().top < window.innerHeight
    ))).toBe(true);
    await page.goBack();
    await expect(page).toHaveURL(/#projects$/);

    await expect.poll(() => page.evaluate(() => {
        const header = document.querySelector('.site-header').getBoundingClientRect();
        const section = document.querySelector('#projects').getBoundingClientRect();
        const title = document.querySelector('#projects-title').getBoundingClientRect();
        return section.top >= header.bottom - 1 && section.top <= header.bottom + 2
            && title.top >= header.bottom - 1;
    })).toBe(true);
});

test('returns keyboard focus to the menu trigger after a command closes its menu', async ({ page, isMobile }) => {
    test.skip(isMobile, 'this regression concerns desktop application menus');
    await page.goto('/portfolio/');
    await page.locator('[data-window-action="minimize"]').click();
    await page.locator('.desktop-shortcut[data-open-project-folder]').click();

    const trigger = page.locator('[data-window-menu="folder-help"]');
    const popup = page.locator('[data-window-menu-popup="folder-help"]');
    const command = popup.locator('[data-menu-action="folder-info"]');
    await trigger.focus();
    await trigger.press('ArrowDown');
    await expect(command).toBeFocused();
    await command.press('Enter');

    await expect(popup).toBeHidden();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(trigger).toBeFocused();
});
