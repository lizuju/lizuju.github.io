const { test: base, expect } = require('@playwright/test');

const test = base.extend({
    serviceWorkers: 'block',
    page: async ({ page }, use) => {
        const browserErrors = [];
        page.on('console', message => {
            if (message.type() === 'error') browserErrors.push(`console: ${message.text()}`);
        });
        page.on('pageerror', error => browserErrors.push(`pageerror: ${error.message}`));
        page.browserErrors = browserErrors;
        await page.addInitScript(() => localStorage.removeItem('portfolio-lang'));
        await use(page);
        expect(browserErrors).toEqual([]);
    }
});

module.exports = { test, expect };
