const { test: base, expect } = require('@playwright/test');
const { apiBase } = require('../static/portfolio/sync-config.json');

async function allowSyncOrigin(page, origin) {
    if (origin.startsWith('http://127.0.0.1:') && page.context().browser().browserType().name() === 'chromium') {
        await page.context().grantPermissions(['local-network-access']);
    }
    await page.route('**/portfolio/', async route => {
        const response = await route.fetch();
        const html = (await response.text())
            .replaceAll(apiBase, origin)
            .replaceAll(apiBase.replace(/^http/, 'ws'), origin.replace(/^http/, 'ws'));
        await route.fulfill({ response, body: html });
    });
}

const test = base.extend({
    page: async ({ page }, use) => {
        // Keep CSP enforced, substituting only the API origin used by the isolated mock.
        await allowSyncOrigin(page, 'https://sync.test');
        await use(page);
    },
});

module.exports = { test, expect, allowSyncOrigin };
