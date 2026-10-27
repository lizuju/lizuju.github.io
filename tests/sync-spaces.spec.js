const { test, expect } = require('@playwright/test');
const { readFile } = require('node:fs/promises');
const path = require('node:path');

test.beforeEach(async ({ page, context }) => {
    const root = path.resolve(__dirname, '..');
    await context.route('**/__sync-spaces-test__/**', async route => {
        const file = new URL(route.request().url()).pathname.split('/__sync-spaces-test__/')[1];
        if (!file) return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Saved spaces tests</title>' });
        if (!['sync-spaces.js', 'sync-crypto.js'].includes(file)) return route.abort();
        return route.fulfill({ contentType: 'text/javascript', body: await readFile(path.join(root, 'static/portfolio/js/apps', file), 'utf8') });
    });
    await page.goto('/__sync-spaces-test__/');
});

test('imports the existing encrypted session without changing its identity and keeps room numbering', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const c = await import('/__sync-spaces-test__/sync-crypto.js');
        const { SavedSpaces, CREDENTIAL_KEY } = await import('/__sync-spaces-test__/sync-spaces.js');
        const session = { roomId: 'legacy-room', deviceId: 'legacy-device', token: 'legacy-token', keyring: await c.createKeyring() };
        const original = await c.saveLocalSession(session);
        localStorage.setItem(CREDENTIAL_KEY, JSON.stringify(original));
        const spaces = new SavedSpaces();
        const first = await spaces.importActive();
        const repeated = await spaces.importActive();
        const loaded = await c.loadLocalSession(spaces.active());
        const next = { roomId: 'other-room', deviceId: 'other-device', token: 'other-token', keyring: await c.createKeyring() };
        await spaces.save(next, { activate: true });
        await spaces.select(session.roomId);
        return { first, repeated, original, key: loaded.keyring.currentKeyId, expectedKey: session.keyring.currentKeyId,
            numbers: spaces.list().map(item => item.number), active: spaces.active().roomId };
    });
    expect(result.first).toEqual([{ ...result.original, number: 1 }]);
    expect(result.repeated).toEqual(result.first);
    expect(result.key).toBe(result.expectedKey);
    expect(result.numbers).toEqual([1, 2]);
    expect(result.active).toBe('legacy-room');
});

test('concurrent tabs save different spaces without losing either encrypted vault', async ({ page, context }) => {
    const other = await context.newPage();
    await other.goto('/__sync-spaces-test__/');
    const sessions = await Promise.all([page, other].map((tab, index) => tab.evaluate(async index => {
        const c = await import('/__sync-spaces-test__/sync-crypto.js');
        const { SavedSpaces } = await import('/__sync-spaces-test__/sync-spaces.js');
        const session = { roomId: `room-${index}`, deviceId: `device-${index}`, token: `token-${index}`, keyring: await c.createKeyring() };
        const saved = await new SavedSpaces().save(session, { activate: true });
        return { saved, rawKey: session.keyring.keys[session.keyring.currentKeyId], revision: session.revision, vaultId: session.vaultId };
    }, index)));
    const result = await page.evaluate(async () => {
        const c = await import('/__sync-spaces-test__/sync-crypto.js');
        const { SavedSpaces, CATALOG_KEY } = await import('/__sync-spaces-test__/sync-spaces.js');
        const spaces = new SavedSpaces();
        return { list: spaces.list(), raw: localStorage.getItem(CATALOG_KEY),
            restored: await Promise.all(spaces.list().map(async saved => (await c.loadLocalSession(saved)).roomId)) };
    });
    expect(result.list.map(item => item.roomId).sort()).toEqual(['room-0', 'room-1']);
    expect(result.list.map(item => item.number).sort()).toEqual([1, 2]);
    expect(result.restored.sort()).toEqual(['room-0', 'room-1']);
    for (const session of sessions) {
        expect(session.saved.revision).toBe(session.revision);
        expect(session.saved.vaultId).toBe(session.vaultId);
        expect(result.raw).not.toContain(session.rawKey);
        expect(result.raw).not.toContain('keyring');
    }
    await other.close();
});

test('an inactive key update never switches rooms and a removed identity cannot be revived', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const c = await import('/__sync-spaces-test__/sync-crypto.js');
        const { SavedSpaces } = await import('/__sync-spaces-test__/sync-spaces.js');
        const spaces = new SavedSpaces();
        const first = { roomId: 'first', deviceId: 'one', token: 'token-one', keyring: await c.createKeyring() };
        const second = { roomId: 'second', deviceId: 'two', token: 'token-two', keyring: await c.createKeyring() };
        const firstDescriptor = await spaces.save(first, { activate: true });
        await spaces.save(second, { activate: true });
        const previous = spaces.find(first).revision;
        await spaces.save(first);
        const updated = { room: spaces.active().roomId, revision: spaces.find(first).revision, previous };
        await spaces.remove(first);
        const lateSave = await spaces.save(first);
        let removedVault;
        try { await c.loadLocalSession(firstDescriptor); removedVault = false; } catch (error) { removedVault = error.code === 'key_unavailable'; }
        const replacement = { roomId: second.roomId, deviceId: 'replacement', token: 'replacement-token', keyring: await c.createKeyring() };
        await spaces.save(replacement, { activate: true });
        const staleRemove = await spaces.remove(second);
        return { updated, lateSave, removedVault, staleRemove, list: spaces.list(), active: spaces.active(),
            replacementReadable: (await c.loadLocalSession(spaces.active())).token === replacement.token };
    });
    expect(result.updated.room).toBe('second');
    expect(result.updated.revision).not.toBe(result.updated.previous);
    expect(result.lateSave).toBeNull();
    expect(result.removedVault).toBe(true);
    expect(result.staleRemove).toBe(false);
    expect(result.list).toHaveLength(1);
    expect(result.list[0]).toMatchObject({ roomId: 'second', deviceId: 'replacement', number: 2 });
    expect(result.active.token).toBe('replacement-token');
    expect(result.replacementReadable).toBe(true);
});

test('removal waits for an in-flight save and leaves no orphaned vault', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const c = await import('/__sync-spaces-test__/sync-crypto.js');
        const { SavedSpaces } = await import('/__sync-spaces-test__/sync-spaces.js');
        const spaces = new SavedSpaces();
        const session = { roomId: 'racing-room', deviceId: 'device', token: 'token', keyring: await c.createKeyring() };
        const descriptor = await spaces.save(session, { activate: true });
        const lockName = `gavin-sync-vault:${session.vaultId}`;
        let release;
        let acquired;
        const held = new Promise(resolve => { acquired = resolve; });
        const blocker = navigator.locks.request(lockName, () => new Promise(resolve => { release = resolve; acquired(); }));
        await held;
        const saving = spaces.save(session);
        while (!(await navigator.locks.query()).pending.some(lock => lock.name === lockName)) await new Promise(resolve => setTimeout(resolve, 0));
        const removing = spaces.remove(session);
        release();
        await Promise.all([blocker, saving, removing]);
        let removedVault;
        try { await c.loadLocalSession(descriptor); removedVault = false; } catch (error) { removedVault = error.code === 'key_unavailable'; }
        return { removedVault, list: spaces.list(), active: spaces.active() };
    });
    expect(result).toEqual({ removedVault: true, list: [], active: null });
});

test('removing the active space selects another space and deletes only the removed vault', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const c = await import('/__sync-spaces-test__/sync-crypto.js');
        const { SavedSpaces } = await import('/__sync-spaces-test__/sync-spaces.js');
        const spaces = new SavedSpaces();
        const first = { roomId: 'first', deviceId: 'one', token: 'token-one', keyring: await c.createKeyring() };
        const second = { roomId: 'second', deviceId: 'two', token: 'token-two', keyring: await c.createKeyring() };
        const firstDescriptor = await spaces.save(first, { activate: true });
        await spaces.save(second, { activate: true });
        await spaces.select(first.roomId);
        await spaces.remove(first);
        let removedVault;
        try { await c.loadLocalSession(firstDescriptor); removedVault = false; } catch (error) { removedVault = error.code === 'key_unavailable'; }
        const preserved = await c.loadLocalSession(spaces.active());
        const activeAfterRemove = spaces.active().roomId;
        await spaces.remove(second);
        return { removedVault, preserved: preserved.roomId, activeAfterRemove, empty: spaces.list(), active: spaces.active() };
    });
    expect(result).toEqual({ removedVault: true, preserved: 'second', activeAfterRemove: 'second', empty: [], active: null });
});

test('shared names keep their revision across key updates and reject delayed or revoked updates', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const c = await import('/__sync-spaces-test__/sync-crypto.js');
        const { SavedSpaces } = await import('/__sync-spaces-test__/sync-spaces.js');
        const spaces = new SavedSpaces();
        const session = { roomId: 'named-room', deviceId: 'named-device', token: 'named-token', keyring: await c.createKeyring() };
        await spaces.save(session, { activate: true });
        const before = spaces.active();
        await spaces.updateName(session, '工作😀', 1);
        const after = spaces.active();
        await spaces.importActive();
        await spaces.save(session);
        const named = spaces.list()[0];
        await spaces.updateName(session, '旧名称', 0);
        const afterStale = spaces.list()[0];
        await spaces.updateName(session, '', 2);
        await spaces.updateName(session, '延迟名称', 1);
        await spaces.importActive();
        const cleared = spaces.list()[0];
        await spaces.remove(session);
        await spaces.updateName(session, '已离开空间', 3);
        return { before, after, named, afterStale, cleared, removed: spaces.list() };
    });
    expect(result.before).toEqual(result.after);
    expect(result.named.name).toBe('工作😀');
    expect(result.named.token).toBe(result.before.token);
    expect(result.named.nameRevision).toBe(1);
    expect(result.afterStale.name).toBe('工作😀');
    expect(result.cleared.name).toBeUndefined();
    expect(result.cleared.nameRevision).toBe(2);
    expect(result.removed).toEqual([]);
});
