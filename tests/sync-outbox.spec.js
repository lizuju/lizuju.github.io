const { test, expect } = require('@playwright/test');
const { readFile } = require('node:fs/promises');
const path = require('node:path');

test('keeps encrypted queues isolated, handles rotation and prevents a late update resurrecting removed text', async ({ page }) => {
    await page.route('**/__outbox__/', route => route.fulfill({ contentType: 'text/html', body: '<main>Outbox test</main>' }));
    await page.route('**/__outbox__/*.js', async route => route.fulfill({ contentType: 'text/javascript',
        body: await readFile(path.join(__dirname, '../static/portfolio/js/apps', new URL(route.request().url()).pathname.split('/').at(-1)), 'utf8') }));
    await page.goto('/__outbox__/');
    const result = await page.evaluate(async () => {
        const { pendingMessages } = await import('./sync-outbox.js');
        const { createKeyring } = await import('./sync-crypto.js');
        const session = { roomId: 'room-one', deviceId: 'device-one', keyring: await createKeyring() };
        const other = { ...session, roomId: 'room-two' };
        const message = { clientId: 'message-one', text: 'private text', createdAt: Date.now(), autoSend: true };
        await Promise.all([pendingMessages.save(session, message, true), pendingMessages.save(other, message, true)]);
        const next = await createKeyring();
        session.keyring = { ...next, keys: { ...session.keyring.keys, ...next.keys } };
        const restored = await pendingMessages.load(session);
        await pendingMessages.save(session, { ...message, nextAttemptAt: Date.now() + 5000 });
        const updated = await pendingMessages.get(session, message.clientId);
        await pendingMessages.remove(session, message.clientId);
        await pendingMessages.save(session, message);
        const removed = await pendingMessages.load(session);
        const otherCount = (await pendingMessages.load(other)).length;
        await pendingMessages.clear(other);
        await pendingMessages.save(other, message);
        const cleared = await pendingMessages.load(other);
        await pendingMessages.save(session, { ...message, createdAt: Date.now() - 8 * 86400000 }, true);
        return { text: restored[0].text, updated: updated.nextAttemptAt > Date.now(), removed, otherCount, cleared,
            expiredAutoSend: (await pendingMessages.load(session))[0].autoSend,
            expiredRetry: (await pendingMessages.get(session, message.clientId)).autoSend };
    });
    expect(result).toEqual({ text: 'private text', updated: true, removed: [], otherCount: 1, cleared: [], expiredAutoSend: false, expiredRetry: false });
});
