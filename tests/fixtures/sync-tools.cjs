const { expect } = require('@playwright/test');

// The sound switch, search, pairing, device and rename controls live in the collapsible tools sidebar,
// which starts collapsed in narrow windows.
async function showSyncTools(scope) {
    const toggle = scope.locator('[data-sync-tools-toggle]');
    if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
    await expect(scope.locator('[data-sync-tools-panel]')).toBeVisible();
}

// In narrow windows the expanded sidebar overlays the conversation, so tests close it before using the feed.
async function hideSyncTools(scope) {
    const toggle = scope.locator('[data-sync-tools-toggle]');
    if (await toggle.getAttribute('aria-expanded') === 'true') await toggle.click();
    await expect(scope.locator('[data-sync-tools-panel]')).toBeHidden();
}

module.exports = { showSyncTools, hideSyncTools };
