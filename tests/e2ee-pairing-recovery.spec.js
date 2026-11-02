const setupSyncIntegration = require('./fixtures/sync-integration.cjs');
const harness = setupSyncIntegration();
const { test, expect, openApp, awaitOnline, sendText, readSession } = harness;
const { showSyncTools } = require('./fixtures/sync-tools.cjs');

test('recovers an accepted pairing after its final grant response is lost and acknowledges the persisted session', async ({ browser, isMobile }) => {
    test.skip(isMobile, 'real pairing recovery is exercised with isolated desktop contexts');
    test.setTimeout(60000);
    const contexts = await Promise.all(Array.from({ length: 2 }, () => browser.newContext({ viewport: { width: 1366, height: 900 } })));
    if (browser.browserType().name() === 'chromium') await Promise.all(contexts.map(context => context.grantPermissions(['local-network-access'])));
    const [owner, joining] = await Promise.all(contexts.map(context => context.newPage()));
    let lostResponses = 0;
    let settles = 0;
    let acknowledgements = 0;
    harness.interceptApi = async (request, forward) => {
        if (!new URL(request.url).pathname.startsWith('/v1/pair/')) return;
        if (request.method === 'DELETE') settles++;
        if (/\/ack$/.test(request.url) && request.method === 'POST') acknowledgements++;
        if (request.method === 'GET' && !lostResponses) {
            const response = await forward();
            const result = await response.clone().json();
            if (result.grant) {
                lostResponses++;
                const bytes = await response.arrayBuffer();
                // Deliver headers before truncation so the browser cannot transparently retry this GET.
                return new Response(bytes.slice(0, -1), {
                    status: response.status,
                    headers: { ...Object.fromEntries(response.headers), 'Content-Length': String(bytes.byteLength), Connection: 'close' }
                });
            }
            return response;
        }
    };
    try {
        await Promise.all([owner, joining].map(openApp));
        await owner.locator('[data-sync-create]').click();
        await awaitOnline(owner);
        await expect(owner.locator('[data-sync-pair-code]')).toHaveText(/^\d{4}$/, { timeout: 30000 });
        const previousKey = (await readSession(owner)).keyring.currentKeyId;
        await joining.locator('[data-sync-code]').fill(await owner.locator('[data-sync-pair-code]').textContent());
        await joining.locator('[data-sync-join]').click();
        await awaitOnline(joining);
        await expect.poll(() => acknowledgements).toBe(1);
        expect(lostResponses).toBe(1);
        expect(settles).toBe(1);
        const joined = await readSession(joining);
        expect(joined.keyring.currentKeyId).not.toBe(previousKey);
        await expect.poll(async () => (await readSession(owner)).keyring.currentKeyId).toBe(joined.keyring.currentKeyId);
        await sendText(joining, 'restored-after-lost-pairing-result');
        await expect(owner.locator('[data-sync-messages]')).toContainText('restored-after-lost-pairing-result');
    } finally { await Promise.all(contexts.map(context => context.close())); }
});

test('reloads during a delayed pairing grant and restores the same request and device', async ({ browser, isMobile }) => {
    test.skip(isMobile, 'reload recovery is exercised with isolated desktop contexts');
    test.setTimeout(60000);
    const contexts = await Promise.all(Array.from({ length: 2 }, () => browser.newContext({ viewport: { width: 1366, height: 900 } })));
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
            if (result.grant && !heldGrant) {
                heldGrant = true;
                await released;
            }
            return response;
        }
    };
    try {
        await Promise.all([owner, joining].map(openApp));
        await owner.locator('[data-sync-create]').click();
        await awaitOnline(owner);
        await expect(owner.locator('[data-sync-pair-code]')).toHaveText(/^\d{4}$/, { timeout: 30000 });
        await joining.locator('[data-sync-code]').fill(await owner.locator('[data-sync-pair-code]').textContent());
        await joining.locator('[data-sync-join]').click();
        await expect.poll(() => heldGrant).toBe(true);
        await expect.poll(() => joining.evaluate(() => sessionStorage.getItem('gavin-sync-pair-recovery'))).toBeTruthy();
        expect(await joining.evaluate(() => localStorage.getItem('portfolio-sync-space-e2ee1'))).toBeNull();
        expect(started).toHaveLength(1);
        expect(admissions).toHaveLength(1);
        await joining.reload();
        releaseGrant();
        if (await joining.locator('[data-window-action="minimize"]').isVisible()) await joining.locator('[data-window-action="minimize"]').click();
        await joining.locator('[data-open-sync-space]').first().click();
        await awaitOnline(joining);
        await expect.poll(() => acknowledged.length).toBe(1);
        expect(started).toHaveLength(1);
        expect(admissions).toHaveLength(1);
        expect([...new Set(grantPaths)]).toEqual([`/v1/pair/${started[0]}`]);
        expect(acknowledged).toEqual([`/v1/pair/${started[0]}/ack`]);
        expect(await joining.evaluate(() => JSON.parse(localStorage.getItem('portfolio-sync-space-e2ee1')).deviceId)).toBe(admissions[0]);
        await expect.poll(() => joining.evaluate(() => sessionStorage.getItem('gavin-sync-pair-recovery'))).toBeNull();
        await showSyncTools(owner);
        await owner.locator('[data-sync-devices]').click();
        await expect(owner.locator('[data-sync-devices-list] [data-device-id]')).toHaveCount(2);
        await expect(owner.locator(`[data-sync-devices-list] [data-device-id="${admissions[0]}"]`)).toBeVisible();
        await owner.locator('[data-sync-devices-dismiss]').click();
        await sendText(joining, 'joined-after-refresh-during-grant');
        await expect(owner.locator('[data-sync-messages]')).toContainText('joined-after-refresh-during-grant');
        await sendText(owner, 'owner-reply-after-refresh-during-grant');
        await expect(joining.locator('[data-sync-messages]')).toContainText('owner-reply-after-refresh-during-grant');
    } finally {
        releaseGrant();
        await Promise.all(contexts.map(context => context.close()));
    }
});

for (const acknowledgementLoss of ['before-server', 'after-server']) {
test(`reloads a saved pairing with an unreceived acknowledgement (${acknowledgementLoss}) without enrolling or revoking another device`, async ({ browser, isMobile }) => {
    test.skip(isMobile, 'persisted pairing acknowledgement is exercised with isolated desktop contexts');
    test.setTimeout(60000);
    const contexts = await Promise.all(Array.from({ length: 2 }, () => browser.newContext({ viewport: { width: 1366, height: 900 } })));
    if (browser.browserType().name() === 'chromium') await Promise.all(contexts.map(context => context.grantPermissions(['local-network-access'])));
    const [owner, joining] = await Promise.all(contexts.map(context => context.newPage()));
    const started = [], admissions = [], ackPaths = [], removedDevices = [];
    let heldAck = false;
    const recoveredAckStatuses = [];
    let releaseAck;
    const released = new Promise(resolve => { releaseAck = resolve; });
    harness.interceptApi = async (request, forward) => {
        const pathname = new URL(request.url).pathname;
        if (request.method === 'POST' && /\/pair-accept$/.test(pathname)) admissions.push((await request.clone().json()).deviceId);
        if (request.method === 'DELETE' && /\/device$/.test(pathname)) removedDevices.push(pathname);
        if (request.method === 'POST' && pathname === '/v1/pair') started.push((await request.clone().json()).requestId);
        if (request.method === 'POST' && /\/ack$/.test(pathname)) {
            ackPaths.push(pathname);
            if (!heldAck) {
                if (acknowledgementLoss === 'after-server') {
                    const response = await forward();
                    expect(response.status).toBe(200);
                }
                heldAck = true;
                await released;
                return false;
            }
            const response = await forward();
            recoveredAckStatuses.push(response.status);
            return response;
        }
    };
    try {
        await Promise.all([owner, joining].map(openApp));
        await owner.locator('[data-sync-create]').click();
        await awaitOnline(owner);
        await expect(owner.locator('[data-sync-pair-code]')).toHaveText(/^\d{4}$/, { timeout: 30000 });
        await joining.locator('[data-sync-code]').fill(await owner.locator('[data-sync-pair-code]').textContent());
        await joining.locator('[data-sync-join]').click();
        await expect.poll(() => heldAck).toBe(true);
        const saved = await joining.evaluate(() => {
            const session = JSON.parse(localStorage.getItem('portfolio-sync-space-e2ee1'));
            return { deviceId: session?.deviceId, vaultId: session?.vaultId };
        });
        expect(saved.deviceId).toBe(admissions[0]);
        expect(saved.vaultId).toBeTruthy();
        await joining.reload();
        releaseAck();
        if (await joining.locator('[data-window-action="minimize"]').isVisible()) await joining.locator('[data-window-action="minimize"]').click();
        await joining.locator('[data-open-sync-space]').first().click();
        await awaitOnline(joining);
        await expect.poll(() => recoveredAckStatuses).toEqual([acknowledgementLoss === 'after-server' ? 404 : 200]);
        expect(started).toHaveLength(1);
        expect(admissions).toHaveLength(1);
        expect(ackPaths).toEqual([`/v1/pair/${started[0]}/ack`, `/v1/pair/${started[0]}/ack`]);
        expect(removedDevices).toEqual([]);
        expect(await joining.evaluate(() => JSON.parse(localStorage.getItem('portfolio-sync-space-e2ee1')).deviceId)).toBe(saved.deviceId);
        await expect.poll(() => joining.evaluate(() => sessionStorage.getItem('gavin-sync-pair-recovery'))).toBeNull();
        await showSyncTools(owner);
        await owner.locator('[data-sync-devices]').click();
        await expect(owner.locator('[data-sync-devices-list] [data-device-id]')).toHaveCount(2);
        await expect(owner.locator(`[data-sync-devices-list] [data-device-id="${saved.deviceId}"]`)).toBeVisible();
        await owner.locator('[data-sync-devices-dismiss]').click();
        await sendText(joining, 'saved-device-survives-refresh-before-ack');
        await expect(owner.locator('[data-sync-messages]')).toContainText('saved-device-survives-refresh-before-ack');
        await sendText(owner, 'saved-device-receives-after-ack-recovery');
        await expect(joining.locator('[data-sync-messages]')).toContainText('saved-device-receives-after-ack-recovery');
    } finally {
        releaseAck();
        await Promise.all(contexts.map(context => context.close()));
    }
});
}
