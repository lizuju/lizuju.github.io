const { test, expect } = require('@playwright/test');

test.use({ serviceWorkers: 'block' });

for (const region of [
    // Safari's system week preferences can start a Chinese calendar on Sunday.
    { locale: 'zh-CN', timezoneId: 'Asia/Shanghai', date: '2026-11-11', clock: /08:30/, firstWeekday: /一|日/ },
    { locale: 'en-US', timezoneId: 'America/Los_Angeles', date: '2026-11-10', clock: /16:30/, firstWeekday: /^Sun/i },
    { locale: 'en-GB', timezoneId: 'Europe/London', date: '2026-11-11', clock: /00:30/, firstWeekday: /^Mon/i }
]) {
    test(`uses the local date, 24-hour clock and week start for ${region.locale} in ${region.timezoneId}`, async ({ browser, baseURL, isMobile }, testInfo) => {
        const context = await browser.newContext({
            baseURL,
            locale: region.locale,
            timezoneId: region.timezoneId,
            viewport: testInfo.project.use.viewport,
            isMobile,
            hasTouch: isMobile,
            serviceWorkers: 'block'
        });
        try {
            const page = await context.newPage();
            await page.clock.install({ time: new Date('2026-11-11T00:30:00Z') });
            await page.goto('/portfolio/');
            const formattedClock = await page.evaluate(() => new Intl.DateTimeFormat(navigator.languages, {
                hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
            }).format(new Date()));
            expect(formattedClock).toMatch(region.clock);
            await expect(page.locator('[data-retro-clock]')).toHaveText(formattedClock);
            await page.locator('[data-calendar-toggle]').click();
            const calendar = page.locator('[data-taskbar-calendar]');
            await expect(calendar).toBeVisible();
            await expect(calendar.locator('[data-calendar-time]')).toHaveText(formattedClock);
            await expect(calendar.locator('time[aria-current="date"]')).toHaveAttribute('datetime', region.date);
            await expect(calendar.locator('[data-calendar-weekdays] > *')).toHaveCount(7);
            await expect(calendar.locator('[data-calendar-weekdays] > *').first()).toHaveText(region.firstWeekday);
            await expect(calendar.locator('[data-calendar-days] time[datetime="2026-11-30"]')).toBeVisible();
            await expect(calendar.locator('[data-calendar-days] time[datetime="2026-11-31"]')).toHaveCount(0);
        } finally {
            await context.close();
        }
    });
}

test('opens a contained calendar, browses across a year boundary and closes with the keyboard or outside click', async ({ page }) => {
    await page.clock.install({ time: new Date('2026-12-15T12:00:00Z') });
    await page.goto('/portfolio/');
    const toggle = page.locator('[data-calendar-toggle]');
    const calendar = page.locator('[data-taskbar-calendar]');
    await expect(calendar).toBeHidden();
    await toggle.focus();
    await toggle.press('Enter');
    await expect(calendar).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const bounds = await calendar.boundingBox();
    const taskbar = await page.locator('.desktop-taskbar').boundingBox();
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(page.viewportSize().width);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(taskbar.y + 1);

    await page.locator('[data-calendar-next]').click();
    await expect(calendar.locator('time[datetime="2027-01-01"]')).toBeVisible();
    await expect(calendar.locator('time[aria-current="date"]')).toHaveCount(0);
    await page.locator('[data-calendar-prev]').click();
    await expect(calendar.locator('time[datetime="2026-12-31"]')).toBeVisible();
    await page.locator('[data-calendar-prev]').click();
    await expect(calendar.locator('time[datetime="2026-11-30"]')).toBeVisible();
    await page.locator('[data-calendar-today]').click();
    await expect(calendar.locator('time[datetime="2026-12-31"]')).toBeVisible();
    await expect(calendar.locator('time[aria-current="date"]')).toHaveCount(1);

    const previousTime = await calendar.locator('[data-calendar-time]').textContent();
    await page.clock.fastForward(60000);
    const nextTime = await page.evaluate(() => new Intl.DateTimeFormat(navigator.languages, {
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).format(new Date()));
    expect(nextTime).not.toBe(previousTime);
    await expect(calendar).toBeVisible();
    await expect(calendar.locator('[data-calendar-time]')).toHaveText(nextTime);
    await expect(page.locator('[data-retro-clock]')).toHaveText(nextTime);

    await page.keyboard.press('Escape');
    await expect(calendar).toBeHidden();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle).toBeFocused();
    await toggle.click();
    await expect(calendar).toBeVisible();
    await page.locator('[data-start-toggle]').click();
    await expect(calendar).toBeHidden();
    await toggle.click();
    await expect(page.locator('[data-start-menu]')).toBeHidden();
    await expect(calendar).toBeVisible();
    await toggle.click();
    await expect(calendar).toBeHidden();
});

test('refreshes the clock and open calendar after returning across midnight', async ({ page }) => {
    await page.clock.install({ time: new Date(2026, 11, 31, 23, 59, 0) });
    await page.goto('/portfolio/');
    await page.locator('[data-calendar-toggle]').click();
    const calendar = page.locator('[data-taskbar-calendar]');
    await expect(calendar.locator('time[aria-current="date"]')).toHaveAttribute('datetime', '2026-12-31');
    await expect(calendar.locator('[data-calendar-time]')).toHaveText('23:59');
    await page.clock.setSystemTime(new Date(2027, 0, 1, 0, 1, 0));
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(calendar.locator('time[aria-current="date"]')).toHaveAttribute('datetime', '2027-01-01');
    await expect(page.locator('[data-calendar-date]')).toHaveAttribute('datetime', '2027-01-01');
    const formattedClock = await page.evaluate(() => new Intl.DateTimeFormat(navigator.languages, {
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).format(new Date()));
    await expect(page.locator('[data-retro-clock]')).toHaveText(formattedClock);
    await expect(calendar.locator('[data-calendar-time]')).toHaveText(formattedClock);
});

test('updates the time zone name when daylight saving time changes without changing the date', async ({ browser, baseURL }) => {
    const context = await browser.newContext({ baseURL, locale: 'en-US', timezoneId: 'America/New_York', serviceWorkers: 'block' });
    try {
        const page = await context.newPage();
        await page.clock.install({ time: new Date('2026-11-01T05:30:00Z') });
        await page.goto('/portfolio/');
        await page.locator('[data-calendar-toggle]').click();
        const zone = page.locator('[data-calendar-zone]');
        await expect(page.locator('[data-calendar-time]')).toHaveText('01:30');
        const summer = await zone.textContent();
        await page.clock.setSystemTime(new Date('2026-11-01T06:30:00Z'));
        await page.evaluate(() => window.dispatchEvent(new Event('focus')));
        const winter = await page.evaluate(() => new Intl.DateTimeFormat(navigator.languages, {
            timeZoneName: 'long'
        }).formatToParts(new Date()).find(part => part.type === 'timeZoneName').value);
        expect(winter).not.toBe(summer);
        await expect(zone).toHaveText(winter);
        await expect(page.locator('[data-calendar-time]')).toHaveText('01:30');
        await expect(page.locator('[data-calendar-days] time[aria-current="date"]')).toHaveAttribute('datetime', '2026-11-01');
    } finally {
        await context.close();
    }
});

test('follows a changed device time zone without reloading the page', async ({ browser, browserName, baseURL }) => {
    test.skip(browserName !== 'chromium', 'Live time zone emulation uses the Chromium protocol');
    const context = await browser.newContext({ baseURL, locale: 'en-US', serviceWorkers: 'block' });
    try {
        const page = await context.newPage();
        const protocol = await context.newCDPSession(page);
        await protocol.send('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Shanghai' });
        await page.clock.install({ time: new Date('2026-11-11T00:30:00Z') });
        await page.goto('/portfolio/');
        await page.locator('[data-calendar-toggle]').click();
        const today = page.locator('[data-calendar-days] time[aria-current="date"]');
        await expect(today).toHaveAttribute('datetime', '2026-11-11');
        await expect(page.locator('[data-calendar-time]')).toHaveText('08:30');
        await protocol.send('Emulation.setTimezoneOverride', { timezoneId: 'America/Los_Angeles' });
        await page.evaluate(() => window.dispatchEvent(new Event('focus')));
        await expect(today).toHaveAttribute('datetime', '2026-11-10');
        await expect(page.locator('[data-retro-clock]')).toHaveText('16:30');
        await expect(page.locator('[data-calendar-time]')).toHaveText('16:30');
    } finally {
        await context.close();
    }
});
