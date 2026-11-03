const { test, expect } = require('@playwright/test');
const { readFile } = require('node:fs/promises');

test('concurrent tabs preserve the newest pending read across late confirmations and isolate devices and rooms', async ({ page, context }) => {
    await context.route('**/__read-receipts__/**', async route => route.fulfill({
        contentType: route.request().url().endsWith('.js') ? 'text/javascript' : 'text/html',
        body: route.request().url().endsWith('.js') ? await readFile('static/portfolio/js/apps/sync-read-receipts.js', 'utf8') : '<!doctype html>'
    }));
    const other = await context.newPage();
    for (const tab of [page, other]) {
        await tab.goto('/__read-receipts__/');
        await tab.evaluate(async () => {
            window.receipts = (await import('./sync-read-receipts.js')).pendingReads;
            window.session = { roomId: 'room', deviceId: 'device' };
        });
    }
    await Promise.all([
        page.evaluate(() => receipts.save(session, 30)),
        other.evaluate(async () => { await receipts.save(session, 13); await receipts.confirm(session, 13); })
    ]);
    expect(await other.evaluate(() => receipts.load(session))).toBe(30);
    await page.close();
    await other.reload();
    const result = await other.evaluate(async () => {
        const receipts = (await import('./sync-read-receipts.js')).pendingReads;
        const session = { roomId: 'room', deviceId: 'device' };
        const restored = await receipts.load(session);
        await receipts.confirm(session, 30);
        await receipts.save(session, 20);
        await receipts.save({ ...session, roomId: 'other-room' }, 45);
        await receipts.save({ ...session, deviceId: 'other-device' }, 50);
        const confirmed = await receipts.load(session);
        await receipts.clear({ ...session, roomId: 'other-room' });
        return { restored, confirmed, removed: await receipts.load({ ...session, roomId: 'other-room' }),
            otherDevice: await receipts.load({ ...session, deviceId: 'other-device' }) };
    });
    expect(result).toEqual({ restored: 30, confirmed: 0, removed: 0, otherDevice: 50 });
});
