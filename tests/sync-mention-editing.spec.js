const { test, expect } = require('@playwright/test');
const { readFile } = require('node:fs/promises');
const path = require('node:path');

const first = '11111111-1111-4111-8111-111111111111';
const second = '22222222-2222-4222-8222-222222222222';
test.beforeEach(async ({ page }) => {
    await page.setContent('<textarea maxlength="10000"></textarea><div id="menu" hidden></div>');
    const source = await readFile(path.join(__dirname, '../static/portfolio/js/apps/sync-mentions.js'));
    await page.evaluate(async ({ url, first, second }) => {
        const { createMentions } = await import(url);
        window.composer = createMentions({
            input: document.querySelector('textarea'), menu: document.querySelector('#menu'), translate: () => 'Choose a member',
            members: () => [{ deviceId: first, name: 'Alice', detail: 'Device 2' }, { deviceId: second, name: 'Alice', detail: 'Device 3' }]
        });
    }, { url: `data:text/javascript;base64,${source.toString('base64')}`, first, second });
});
const mention = async (page, device) => {
    await page.locator('textarea').pressSequentially('@');
    await page.locator(`[data-sync-mention-device="${device}"]`).click();
};

test('deleting the first of two identical names keeps the second device identity', async ({ page }) => {
    const input = page.locator('textarea');
    await input.focus();
    await mention(page, first);
    await mention(page, second);
    await input.evaluate(element => element.setSelectionRange(0, 7));
    await input.press('Backspace');
    await expect(input).toHaveValue('@Alice ');
    expect(await page.evaluate(() => composer.snapshot())).toEqual([{ deviceId: second, start: 0, end: 6 }]);
});

test('inserting identical untagged text before a mention does not move its identity to that text', async ({ page }) => {
    const input = page.locator('textarea');
    await input.focus();
    await mention(page, second);
    await input.evaluate(element => element.setSelectionRange(0, 0));
    await input.pressSequentially('@Alice ');
    await input.press('Escape');
    expect(await page.evaluate(() => composer.snapshot())).toEqual([{ deviceId: second, start: 7, end: 13 }]);
    await input.evaluate(element => element.setSelectionRange(0, 7));
    await input.press('Delete');
    expect(await page.evaluate(() => composer.snapshot())).toEqual([{ deviceId: second, start: 0, end: 6 }]);
});

test('replacing a selected mention with the same plain text removes the old identity', async ({ page }) => {
    const input = page.locator('textarea');
    await input.focus();
    await mention(page, first);
    await mention(page, second);
    await input.evaluate(element => {
        element.setSelectionRange(0, 6);
        element.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, inputType: 'insertFromPaste', data: '@Alice' }));
        element.setRangeText('@Alice', 0, 6, 'end');
        element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste', data: '@Alice' }));
    });
    await expect(input).toHaveValue('@Alice @Alice ');
    expect(await page.evaluate(() => composer.snapshot())).toEqual([{ deviceId: second, start: 7, end: 13 }]);
});
