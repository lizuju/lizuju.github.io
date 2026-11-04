const { test, expect } = require('@playwright/test');

test.use({ serviceWorkers: 'block' });

test('releases a stalled mail send, keeps the current draft and only retries on request', async ({ page }) => {
    await page.clock.install();
    let release;
    const stalled = new Promise(resolve => { release = resolve; });
    const submissions = [];
    await page.route('https://formsubmit.co/ajax/**', async route => {
        if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' } });
        submissions.push(route.request().postDataJSON());
        if (submissions.length === 1) await stalled;
        await route.fulfill({ headers: { 'Access-Control-Allow-Origin': '*' }, json: { success: true } }).catch(() => {});
    });
    await page.goto('/portfolio/');
    await page.locator('[data-window-action="minimize"]').click();
    await page.locator('.desktop-shortcut[data-open-mail-window]').click();
    const form = page.locator('[data-mail-form]');
    await form.locator('[name="name"]').fill('Test visitor');
    await form.locator('[name="email"]').fill('visitor@example.com');
    await form.locator('[name="message"]').fill('First message');
    await form.locator('[data-mail-send]').click();
    await expect.poll(() => submissions.length).toBe(1);
    await form.locator('[name="message"]').fill('Keep this new draft');
    await page.locator('[data-mail-action="close"]').click();
    await page.clock.runFor(30001);
    await page.locator('.desktop-shortcut[data-open-mail-window]').click();
    await expect(form.locator('[data-mail-send]')).toBeEnabled();
    await expect(page.locator('[data-mail-status]')).toContainText('发送结果未确认');
    await expect(form.locator('[name="message"]')).toHaveValue('Keep this new draft');
    release();
    await page.clock.runFor(60000);
    expect(submissions).toHaveLength(1);
    await page.locator('[data-taskbar-lang]').click();
    await expect(page.locator('[data-mail-status]')).toContainText('unconfirmed');
    await form.locator('[data-mail-send]').click();
    await expect(page.locator('[data-mail-status]')).toContainText('sent');
    expect(submissions).toHaveLength(2);
    expect(submissions[1].message).toBe('Keep this new draft');
    await expect(form.locator('[name="message"]')).toHaveValue('');
});
