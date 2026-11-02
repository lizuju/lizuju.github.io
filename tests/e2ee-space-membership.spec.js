const setupSyncIntegration = require('./fixtures/sync-integration.cjs');
const harness = setupSyncIntegration();
const { test, expect, siteOrigin, apiOrigin, awaitOnline, sendText, readSession, watchSpaceConnections, expandSpaces, selectSpace } = harness;
const { showSyncTools } = require('./fixtures/sync-tools.cjs');

test('adds a paired space without duplicating a saved membership and leaves only the selected space', async ({ browser, isMobile }) => {
    test.setTimeout(90000);
    const contexts = await Promise.all(Array.from({ length: 2 }, () => browser.newContext({
        viewport: isMobile ? { width: 320, height: 568 } : { width: 1366, height: 900 }, isMobile, hasTouch: isMobile
    })));
    if (browser.browserType().name() === 'chromium') await Promise.all(contexts.map(context => context.grantPermissions(['local-network-access'])));
    const [owner, member] = await Promise.all(contexts.map(context => context.newPage()));
    const connections = watchSpaceConnections(member);
    const admittedDevices = [], removedDevices = [];
    harness.interceptApi = async request => {
        const pathname = new URL(request.url).pathname;
        if (request.method === 'POST' && /\/pair-accept$/.test(pathname)) admittedDevices.push((await request.clone().json()).deviceId);
        if (request.method === 'DELETE' && /\/device$/.test(pathname)) removedDevices.push(pathname);
    };
    try {
        await Promise.all([owner, member].map(page => page.goto(`${siteOrigin}/chat/`)));
        await owner.locator('[data-sync-create]').click();
        await awaitOnline(owner);
        await expect(owner.locator('[data-sync-pair-code]')).toHaveText(/^\d{4}$/, { timeout: 30000 });
        const code = await owner.locator('[data-sync-pair-code]').textContent();
        const shared = await readSession(owner);
        await member.locator('[data-sync-create]').click();
        await awaitOnline(member);
        const original = await readSession(member);
        await sendText(member, 'member-original-space');
        await expandSpaces(member);
        await member.locator('[data-sync-add-space]').click();
        await member.locator('[data-sync-code]').fill(code);
        await member.locator('[data-sync-join]').click();
        await awaitOnline(member);
        await expect.poll(async () => (await readSession(member)).roomId).toBe(shared.roomId);
        const joined = await readSession(member);
        await sendText(owner, 'shared-space-message');
        await expect(member.locator('[data-sync-messages]')).toContainText('shared-space-message');
        await selectSpace(member, original.roomId);
        await expect(member.locator('[data-sync-messages]')).toContainText('member-original-space');
        await expect(member.locator('[data-sync-messages]')).not.toContainText('shared-space-message');
        await showSyncTools(owner);
        await owner.locator('[data-sync-pair]').click();
        await expect(owner.locator('[data-sync-pair-code]')).toHaveText(/^\d{4}$/, { timeout: 30000 });
        await expandSpaces(member);
        await member.locator('[data-sync-add-space]').click();
        await member.locator('[data-sync-code]').fill(await owner.locator('[data-sync-pair-code]').textContent());
        await member.locator('[data-sync-join]').click();
        await expect.poll(async () => (await readSession(member)).roomId).toBe(shared.roomId);
        await awaitOnline(member);
        expect((await readSession(member)).deviceId).toBe(joined.deviceId);
        expect((await readSession(member)).vaultId).toBe(joined.vaultId);
        await expandSpaces(member);
        await expect(member.locator('[data-sync-space-list] [data-sync-space-id]')).toHaveCount(2);
        await expect(member.locator(`[data-sync-space-id="${shared.roomId}"]`)).toHaveCount(1);
        await member.locator('[data-sync-spaces-toggle]').click();
        expect(admittedDevices).toHaveLength(2);
        expect(admittedDevices[1]).not.toBe(joined.deviceId);
        await expect.poll(async () => {
            const response = await fetch(`${apiOrigin}/v1/spaces/${shared.roomId}/devices`, { headers: { Origin: siteOrigin, Authorization: `Bearer ${shared.token}` } });
            return (await response.json()).devices.map(device => device.deviceId).sort();
        }).toEqual([shared.deviceId, joined.deviceId].sort());
        expect(removedDevices).toEqual([`/v1/spaces/${shared.roomId}/device`]);
        await sendText(member, 'saved-membership-after-repeat-pairing');
        await expect(owner.locator('[data-sync-messages]')).toContainText('saved-membership-after-repeat-pairing');
        const originalConnection = connections.filter(connection => connection.roomId === original.roomId).at(-1);
        const sharedConnection = connections.filter(connection => connection.roomId === shared.roomId).at(-1);
        const connected = connections.map(({ roomId, auth, ready }) => ({ roomId, auth, ready }));
        expect(originalConnection.socket.isClosed()).toBe(false);
        await showSyncTools(member);
        await member.locator('[data-sync-leave]').click();
        await member.locator('[data-sync-confirm-accept]').click();
        await expandSpaces(member);
        await expect(member.locator(`[data-sync-space-id="${shared.roomId}"]`)).toHaveCount(0);
        await expect(member.locator(`[data-sync-space-id="${original.roomId}"]`)).toHaveCount(1);
        await selectSpace(member, original.roomId);
        expect((await readSession(member)).deviceId).toBe(original.deviceId);
        await expect(member.locator('[data-sync-messages]')).toContainText('member-original-space');
        await expect.poll(() => sharedConnection.socket.isClosed()).toBe(true);
        expect(originalConnection.socket.isClosed()).toBe(false);
        expect(connections.map(({ roomId, auth, ready }) => ({ roomId, auth, ready }))).toEqual(connected);
        const left = await fetch(`${apiOrigin}/v1/spaces/${joined.roomId}/messages`, { headers: { Origin: siteOrigin, Authorization: `Bearer ${joined.token}` } });
        expect(left.status).toBe(401);
    } finally { await Promise.all(contexts.map(context => context.close())); }
});

test('recovers an added space after reload during its accepted pairing without replacing the existing membership', async ({ browser, isMobile }) => {
    test.setTimeout(90000);
    const contexts = await Promise.all(Array.from({ length: 2 }, () => browser.newContext({
        viewport: isMobile ? { width: 320, height: 568 } : { width: 1366, height: 900 }, isMobile, hasTouch: isMobile
    })));
    if (browser.browserType().name() === 'chromium') await Promise.all(contexts.map(context => context.grantPermissions(['local-network-access'])));
    const [owner, joining] = await Promise.all(contexts.map(context => context.newPage()));
    const started = [], admissions = [], grantPaths = [], acknowledged = [];
    let heldGrant = false;
    let releaseGrant;
    const released = new Promise(resolve => { releaseGrant = resolve; });
    harness.interceptApi = async (request, forward) => {
        const pathname = new URL(request.url).pathname;
        if (request.method === 'POST' && /\/pair-accept$/.test(pathname)) admissions.push((await request.clone().json()).deviceId);
        if (request.method === 'POST' && pathname === '/v1/pair') started.push((await request.clone().json()).requestId);
        if (request.method === 'POST' && /\/ack$/.test(pathname)) acknowledged.push(pathname);
        if (request.method === 'GET' && /^\/v1\/pair\/[0-9a-f-]{36}$/.test(pathname)) {
            grantPaths.push(pathname);
            const response = await forward(), result = await response.clone().json();
            if (result.grant && !heldGrant) { heldGrant = true; await released; }
            return response;
        }
    };
    try {
        await Promise.all([owner, joining].map(page => page.goto(`${siteOrigin}/chat/`)));
        await joining.locator('[data-sync-create]').click();
        await awaitOnline(joining);
        const original = await readSession(joining);
        await sendText(joining, 'original-space-before-pair-reload');
        await owner.locator('[data-sync-create]').click();
        await awaitOnline(owner);
        const shared = await readSession(owner);
        await expect(owner.locator('[data-sync-pair-code]')).toHaveText(/^\d{4}$/, { timeout: 30000 });
        await expandSpaces(joining);
        await joining.locator('[data-sync-add-space]').click();
        await joining.locator('[data-sync-code]').fill(await owner.locator('[data-sync-pair-code]').textContent());
        await joining.locator('[data-sync-join]').click();
        await expect.poll(() => heldGrant).toBe(true);
        await expect.poll(() => joining.evaluate(() => sessionStorage.getItem('gavin-sync-pair-recovery'))).toBeTruthy();
        expect((await readSession(joining)).roomId).toBe(original.roomId);
        expect(started).toHaveLength(1);
        expect(admissions).toHaveLength(1);
        await joining.reload();
        releaseGrant();
        await expect.poll(async () => (await readSession(joining)).roomId).toBe(shared.roomId);
        await awaitOnline(joining);
        const recovered = await readSession(joining);
        expect(recovered.deviceId).toBe(admissions[0]);
        await expect.poll(() => acknowledged.length).toBe(1);
        expect(started).toHaveLength(1);
        expect(admissions).toHaveLength(1);
        expect([...new Set(grantPaths)]).toEqual([`/v1/pair/${started[0]}`]);
        expect(acknowledged).toEqual([`/v1/pair/${started[0]}/ack`]);
        await expect.poll(() => joining.evaluate(() => sessionStorage.getItem('gavin-sync-pair-recovery'))).toBeNull();
        await expandSpaces(joining);
        await expect(joining.locator('[data-sync-space-list] [data-sync-space-id]')).toHaveCount(2);
        await joining.locator('[data-sync-spaces-toggle]').click();
        await sendText(joining, 'added-space-after-pair-reload');
        await expect(owner.locator('[data-sync-messages]')).toContainText('added-space-after-pair-reload');
        await selectSpace(joining, original.roomId);
        expect((await readSession(joining)).deviceId).toBe(original.deviceId);
        expect((await readSession(joining)).vaultId).toBe(original.vaultId);
        await expect(joining.locator('[data-sync-messages]')).toContainText('original-space-before-pair-reload');
        await expect(joining.locator('[data-sync-messages]')).not.toContainText('added-space-after-pair-reload');
        await selectSpace(joining, shared.roomId);
        expect((await readSession(joining)).deviceId).toBe(recovered.deviceId);
        await sendText(owner, 'shared-space-after-returning');
        await expect(joining.locator('[data-sync-messages]')).toContainText('shared-space-after-returning');
    } finally {
        releaseGrant();
        await Promise.all(contexts.map(context => context.close()));
    }
});

test('keeps an added space pairing alive when the current space rotates its encryption keys', async ({ browser, isMobile }) => {
    test.setTimeout(60000);
    const contexts = await Promise.all(Array.from({ length: 3 }, () => browser.newContext({
        viewport: isMobile ? { width: 320, height: 568 } : { width: 1366, height: 900 }, isMobile, hasTouch: isMobile
    })));
    if (browser.browserType().name() === 'chromium') await Promise.all(contexts.map(context => context.grantPermissions(['local-network-access'])));
    const [member, owner, newcomer] = await Promise.all(contexts.map(context => context.newPage()));
    let releaseGrant;
    const released = new Promise(resolve => { releaseGrant = resolve; });
    let heldGrant = false;
    const removed = [];
    harness.interceptApi = async (request, forward) => {
        const pathname = new URL(request.url).pathname;
        if (request.method === 'DELETE' && pathname.endsWith('/device')) removed.push(pathname);
        if (request.method === 'GET' && /^\/v1\/pair\/[0-9a-f-]{36}$/.test(pathname)) {
            const response = await forward();
            const result = await response.clone().json();
            if (result.grant && !heldGrant) { heldGrant = true; await released; }
            return response;
        }
    };
    try {
        await Promise.all([member, owner, newcomer].map(page => page.goto(`${siteOrigin}/chat/`)));
        await owner.locator('[data-sync-create]').click();
        await awaitOnline(owner);
        await expect(owner.locator('[data-sync-pair-code]')).toHaveText(/^\d{4}$/);
        const added = await readSession(owner);
        const addedCode = await owner.locator('[data-sync-pair-code]').textContent();
        await member.locator('[data-sync-create]').click();
        await awaitOnline(member);
        await expect(member.locator('[data-sync-pair-code]')).toHaveText(/^\d{4}$/);
        const original = await readSession(member);
        const originalCode = await member.locator('[data-sync-pair-code]').textContent();
        await expandSpaces(member);
        await member.locator('[data-sync-add-space]').click();
        await member.locator('[data-sync-code]').fill(addedCode);
        await member.locator('[data-sync-join]').click();
        await expect.poll(() => heldGrant).toBe(true);
        await newcomer.locator('[data-sync-code]').fill(originalCode);
        await newcomer.locator('[data-sync-join]').click();
        await awaitOnline(newcomer);
        await expect.poll(async () => (await readSession(member)).keyring.currentKeyId).not.toBe(original.keyring.currentKeyId);
        await expect(member.locator('[data-sync-join]')).toBeDisabled();
        releaseGrant();
        await expect.poll(async () => (await readSession(member)).roomId).toBe(added.roomId);
        await awaitOnline(member);
        await expect(member.locator('[data-sync-setup]')).toBeHidden();
        await expect(member.locator('[data-sync-space-list] [data-sync-space-id]')).toHaveCount(2);
        expect(removed).toEqual([]);
        await sendText(owner, 'message-in-added-space-after-original-key-rotation');
        await expect(member.locator('[data-sync-messages]')).toContainText('message-in-added-space-after-original-key-rotation');
        await selectSpace(member, original.roomId);
        await sendText(newcomer, 'message-in-original-space-with-new-key');
        await expect(member.locator('[data-sync-messages]')).toContainText('message-in-original-space-with-new-key');
    } finally {
        releaseGrant();
        await Promise.all(contexts.map(context => context.close()));
    }
});

test('reuses the current membership when adding its own pairing code', async ({ page, browserName }) => {
    test.setTimeout(60000);
    if (browserName === 'chromium') await page.context().grantPermissions(['local-network-access']);
    await page.goto(`${siteOrigin}/chat/`);
    await page.locator('[data-sync-create]').click();
    await awaitOnline(page);
    await expect(page.locator('[data-sync-pair-code]')).toHaveText(/^\d{4}$/);
    const original = await readSession(page);
    const code = await page.locator('[data-sync-pair-code]').textContent();
    await expandSpaces(page);
    await page.locator('[data-sync-add-space]').click();
    await page.locator('[data-sync-code]').fill(code);
    await page.locator('[data-sync-join]').click();
    await expect(page.locator('[data-sync-setup]')).toBeHidden({ timeout: 30000 });
    await awaitOnline(page);
    expect((await readSession(page)).deviceId).toBe(original.deviceId);
    expect((await readSession(page)).vaultId).toBe(original.vaultId);
    await expect(page.locator('[data-sync-space-list] [data-sync-space-id]')).toHaveCount(1);
    await expect.poll(async () => {
        const response = await fetch(`${apiOrigin}/v1/spaces/${original.roomId}/devices`, {
            headers: { Origin: siteOrigin, Authorization: `Bearer ${original.token}` }
        });
        return (await response.json()).devices.map(device => device.deviceId);
    }).toEqual([original.deviceId]);
});

test('keeps the current draft and space when local storage cannot save it before switching', async ({ page, browserName }) => {
    test.setTimeout(60000);
    if (browserName === 'chromium') await page.context().grantPermissions(['local-network-access']);
    await page.goto(`${siteOrigin}/chat/`);
    await page.locator('[data-sync-create]').click();
    await awaitOnline(page);
    const first = await readSession(page);
    await page.locator('[data-sync-input]').fill('previously-saved-draft');
    await expect.poll(() => page.evaluate(id => sessionStorage.getItem(`portfolio-sync-draft:${id}`), first.roomId)).toBeTruthy();
    await expandSpaces(page);
    await page.locator('[data-sync-add-space]').click();
    await page.locator('[data-sync-create]').click();
    await expect.poll(async () => (await readSession(page)).roomId).not.toBe(first.roomId);
    await awaitOnline(page);
    const second = await readSession(page);
    await selectSpace(page, first.roomId);
    if (await page.locator('[data-sync-spaces-toggle]').getAttribute('aria-expanded') === 'true') await page.locator('[data-sync-spaces-toggle]').click();
    await page.evaluate(() => {
        const block = 'x'.repeat(1024);
        for (let index = 0; ; index++) {
            try { sessionStorage.setItem(`quota-test-${index}`, block); }
            catch { break; }
        }
    });
    const draft = 'new-unsaved-draft-'.repeat(500);
    try {
        await page.locator('[data-sync-input]').fill(draft);
        await expect(page.locator('[data-sync-notice]')).toHaveAttribute('data-i18n', 'syncStorageError');
        await expandSpaces(page);
        await page.locator(`[data-sync-space-id="${second.roomId}"]`).click();
        await expect(page.locator(`[data-sync-space-id="${first.roomId}"]`)).toHaveAttribute('aria-current', 'true');
        expect((await readSession(page)).roomId).toBe(first.roomId);
        await expect(page.locator('[data-sync-input]')).toHaveValue(draft);
        await expect(page.locator('[data-sync-notice]')).toHaveAttribute('data-i18n', 'syncStorageError');
    } finally {
        await page.evaluate(() => {
            Object.keys(sessionStorage).filter(key => key.startsWith('quota-test-')).forEach(key => sessionStorage.removeItem(key));
        });
    }
    await selectSpace(page, second.roomId);
    await selectSpace(page, first.roomId);
    await expect(page.locator('[data-sync-input]')).toHaveValue(draft);
});
