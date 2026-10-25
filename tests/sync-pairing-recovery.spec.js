const { test, expect } = require('@playwright/test');
const { readFile } = require('node:fs/promises');
const path = require('node:path');

const testPath = '/__sync-recovery-test__/';
const recoveryKey = 'gavin-sync-pair-recovery';
let server;

test.beforeEach(async ({ page, context }) => {
    const root = path.resolve(__dirname, '..');
    await context.route(`**${testPath}**`, async route => {
        const file = new URL(route.request().url()).pathname.split(testPath)[1];
        if (!file) return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Pairing recovery tests</title>' });
        let source;
        if (file === 'crypto.js') source = (await readFile(path.join(root, 'static/portfolio/js/apps/sync-crypto.js'), 'utf8')).replace('@serenity-kit/opaque', './opaque.js');
        else if (file === 'pairing.js') source = (await readFile(path.join(root, 'static/portfolio/js/apps/sync-pairing.js'), 'utf8')).replace('./sync-crypto.js', './crypto.js');
        else if (file === 'opaque.js') source = await readFile(path.join(root, 'node_modules/@serenity-kit/opaque/esm/index.js'), 'utf8');
        else return route.abort();
        return route.fulfill({ contentType: 'text/javascript', body: source });
    });
    server = await context.newPage();
    await server.goto(testPath);
    await server.evaluate(async () => {
        const c = await import('/__sync-recovery-test__/crypto.js');
        const offerId = crypto.randomUUID();
        const secret = await c.createPairingSecret('1234', offerId);
        const keyring = await c.createKeyring();
        const roomId = crypto.randomUUID();
        const pending = new Map();
        const waiters = { challenge: [], proof: [] };
        window.stub = {
            holdChallenge: false, holdProof: false, failCleanup: false, failAck: false, ack404: false,
            posts: [], proofs: [], polls: 0, challengeWaits: 0, proofWaits: 0, settles: 0, removals: [], acks: 0,
            release(phase) {
                this[phase === 'challenge' ? 'holdChallenge' : 'holdProof'] = false;
                waiters[phase].splice(0).forEach(resolve => resolve());
            },
            async api({ path, method = 'GET', body, session }) {
                if (path === '/v1/pair/offers') return { offers: [{ offerId, expiresAt: Date.now() + 600000 }] };
                if (path === '/v1/pair' && method === 'POST') {
                    const request = JSON.parse(body);
                    this.posts.push(request.requestId);
                    if (!pending.has(request.requestId)) {
                        const host = await c.startPairingHost(secret, offerId, request.requestId, request.requests[0].startLoginRequest);
                        pending.set(request.requestId, { request, host });
                    } else if (JSON.stringify(pending.get(request.requestId).request) !== JSON.stringify(request)) {
                        throw new Error('Recovery changed its original PAKE request');
                    }
                    return { accepted: true };
                }
                if (path.endsWith('/device') && method === 'DELETE') {
                    this.removals.push({ deviceId: session.deviceId, validToken: [...pending.values()].some(entry => entry.session?.token === session.token) });
                    return { ok: true };
                }
                const match = /^\/v1\/pair\/([^/]+)(\/ack)?$/.exec(path);
                if (!match) throw new Error(`Unexpected request: ${path}`);
                const requestId = match[1];
                const entry = pending.get(requestId);
                if (match[2]) {
                    this.acks++;
                    if (this.failAck) throw Object.assign(new Error('offline'), { status: 503 });
                    if (this.ack404) throw Object.assign(new Error('expired'), { status: 404 });
                    pending.delete(requestId);
                    return { ok: true };
                }
                if (method === 'DELETE') {
                    this.settles++;
                    if (this.failCleanup) throw new TypeError('offline');
                    if (!entry) throw Object.assign(new Error('expired'), { status: 404 });
                    if (entry.grant) return { ok: true, cancelled: false, requestId, offerId, grant: entry.grant };
                    pending.delete(requestId);
                    return { ok: true, cancelled: true };
                }
                if (!entry) throw Object.assign(new Error('expired'), { status: 404 });
                if (method === 'POST') {
                    this.proofs.push(requestId);
                    const proof = JSON.parse(body);
                    const sessionKey = await c.finishPairingHost(entry.host.serverState, proof.finishLoginRequest);
                    const client = await c.decryptPairing(sessionKey, offerId, requestId, proof.clientData);
                    const deviceId = crypto.randomUUID();
                    entry.session = { roomId, deviceId, keyring, token: crypto.randomUUID(), trustedDevices: { [deviceId]: client.publicKey }, revokedDevices: [], nonce: client.nonce };
                    entry.grant = await c.encryptPairing(sessionKey, offerId, requestId, entry.session);
                    if (this.holdProof) { this.proofWaits++; await new Promise(resolve => waiters.proof.push(resolve)); }
                    return { accepted: true };
                }
                this.polls++;
                if (entry.grant) return { grant: entry.grant, offerId };
                if (this.holdChallenge) { this.challengeWaits++; await new Promise(resolve => waiters.challenge.push(resolve)); }
                return { responses: [{ offerId, loginResponse: entry.host.loginResponse }] };
            }
        };
    });
    await context.exposeBinding('__pairApi', async (_source, request) => server.evaluate(async request => {
        try { return { value: await window.stub.api(request) }; }
        catch (error) { return { error: { message: error.message, name: error.name, code: error.code, status: error.status } }; }
    }, request));
    await context.addInitScript(() => {
        window.bootRecoveryClient = async () => {
            const { EncryptedPairing } = await import('/__sync-recovery-test__/pairing.js');
            window.pairing = new EncryptedPairing({
                getSession: () => null,
                getSavedSession: () => JSON.parse(localStorage.getItem('__recovery_saved__') || 'null'),
                api: (path, options = {}, session) => new Promise((resolve, reject) => {
                    const signal = options.signal;
                    const abort = () => reject(signal.reason);
                    if (signal?.aborted) return abort();
                    signal?.addEventListener('abort', abort, { once: true });
                    window.__pairApi({ path, method: options.method, body: options.body, session }).then(result => {
                        if (result.error) reject(Object.assign(new Error(result.error.message), result.error));
                        else resolve(result.value);
                    }, reject).finally(() => signal?.removeEventListener('abort', abort));
                })
            });
        };
    });
    await page.goto(testPath);
    await page.evaluate(() => window.bootRecoveryClient());
});

const startJoin = page => page.evaluate(() => {
    window.joined = null;
    window.joinError = null;
    window.joinPromise = window.pairing.join('1234').then(session => { window.joined = session; }, error => { window.joinError = error.code || error.name; });
});

const reload = async page => {
    await page.reload();
    await page.evaluate(() => window.bootRecoveryClient());
};

const waitForStub = predicate => expect.poll(() => server.evaluate(predicate)).toBe(true);

const leaveCancelledJoin = async page => {
    await server.evaluate(() => { window.stub.holdProof = true; window.stub.failCleanup = true; });
    await startJoin(page);
    await waitForStub(() => window.stub.proofWaits === 1);
    await page.evaluate(() => window.pairing.reset());
    await expect.poll(() => page.evaluate(() => sessionStorage.getItem('gavin-sync-pair-cancelled'))).toBeTruthy();
    await reload(page);
    await server.evaluate(() => { window.stub.failCleanup = false; window.stub.release('proof'); });
};

test('wraps both PAKE recovery stages beside a nonextractable AES key', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const c = await import('/__sync-recovery-test__/crypto.js');
        const id = crypto.randomUUID();
        const offerId = crypto.randomUUID();
        const requestId = crypto.randomUUID();
        const identity = await c.createDeviceIdentity();
        const secret = await c.createPairingSecret('0042', offerId);
        const client = await c.startPairingClient('0042', offerId);
        const host = await c.startPairingHost(secret, offerId, requestId, client.startLoginRequest);
        const readRecord = async () => {
            const database = await new Promise(resolve => { const request = indexedDB.open('gavin-sync-key-vault'); request.onsuccess = () => resolve(request.result); });
            const record = await new Promise(resolve => { const request = database.transaction('sessions').objectStore('sessions').get(id); request.onsuccess = () => resolve(request.result); });
            database.close();
            let exportRefused = false;
            try { await crypto.subtle.exportKey('raw', record.key); } catch { exportRefused = true; }
            return { text: JSON.stringify(record), extractable: record.key.extractable, algorithm: record.key.algorithm.name, exportRefused, fields: Object.keys(record).sort() };
        };
        const state = { id, requestId, identity, states: { [offerId]: client.clientState }, expiresAt: Date.now() + 600000 };
        await c.savePairingRecovery(id, state);
        const before = await readRecord();
        const restoredBefore = await c.loadPairingRecovery(id);
        const match = await c.finishPairingClient(client.clientState, offerId, requestId, host.loginResponse);
        delete state.states;
        state.match = match;
        await c.savePairingRecovery(id, state);
        const after = await readRecord();
        const restoredAfter = await c.loadPairingRecovery(id);
        await c.deletePairingRecovery(id);
        return {
            before, after, privateKey: identity.privateKey.d, sessionKey: match.sessionKey,
            restoredCode: restoredBefore.states[offerId].code,
            restoredSessionKey: restoredAfter.match.sessionKey === match.sessionKey,
            deleted: await c.loadPairingRecovery(id) === null
        };
    });
    for (const stage of [result.before, result.after]) {
        expect(stage.fields).toEqual(['encrypted', 'id', 'key']);
        expect(stage.algorithm).toBe('AES-GCM');
        expect(stage.extractable).toBe(false);
        expect(stage.exportRefused).toBe(true);
        expect(stage.text).not.toContain('"0042"');
        expect(stage.text).not.toContain(result.privateKey);
        expect(stage.text).not.toContain(result.sessionKey);
    }
    expect(result.restoredCode).toBe('0042');
    expect(result.restoredSessionKey).toBe(true);
    expect(result.deleted).toBe(true);
});

test('reload before the PAKE challenge resumes the same original request', async ({ page }) => {
    await server.evaluate(() => { window.stub.holdChallenge = true; });
    await startJoin(page);
    await waitForStub(() => window.stub.challengeWaits === 1);
    const id = await page.evaluate(key => sessionStorage.getItem(key), recoveryKey);
    await reload(page);
    await server.evaluate(() => window.stub.release('challenge'));
    const result = await page.evaluate(async () => {
        const session = await window.pairing.recoverJoin();
        return { joined: Boolean(session?.identity?.privateKey), pending: window.pairing.hasPendingJoin() };
    });
    expect(result).toEqual({ joined: true, pending: true });
    expect(await page.evaluate(key => sessionStorage.getItem(key), recoveryKey)).toBe(id);
    const counters = await server.evaluate(() => ({ posts: window.stub.posts, proofs: window.stub.proofs.length }));
    expect(counters.posts).toHaveLength(2);
    expect(new Set(counters.posts).size).toBe(1);
    expect(counters.proofs).toBe(1);
});

test('reload after PAKE proof recovers the committed grant without another proof', async ({ page }) => {
    await server.evaluate(() => { window.stub.holdProof = true; });
    await startJoin(page);
    await waitForStub(() => window.stub.proofWaits === 1);
    await reload(page);
    await server.evaluate(() => window.stub.release('proof'));
    expect(await page.evaluate(async () => Boolean((await window.pairing.recoverJoin())?.keyring))).toBe(true);
    expect(await server.evaluate(() => ({ posts: window.stub.posts.length, proofs: window.stub.proofs.length, removed: window.stub.removals.length })))
        .toEqual({ posts: 1, proofs: 1, removed: 0 });
});

test('a cancelled join survives reload only to remove the unused device', async ({ page }) => {
    await leaveCancelledJoin(page);
    expect(await page.evaluate(() => window.pairing.recoverJoin())).toBeNull();
    expect(await page.evaluate(key => sessionStorage.getItem(key), recoveryKey)).toBeNull();
    expect(await page.evaluate(() => localStorage.getItem('__recovery_saved__'))).toBeNull();
    expect(await server.evaluate(() => ({ removals: window.stub.removals, acks: window.stub.acks })))
        .toEqual({ removals: [{ deviceId: expect.any(String), validToken: true }], acks: 1 });
});

test('a fresh join succeeds on its first click after cleaning an old cancellation', async ({ page }) => {
    await leaveCancelledJoin(page);
    expect(await page.evaluate(async () => Boolean((await window.pairing.join('1234'))?.keyring))).toBe(true);
    expect(await server.evaluate(() => ({ posts: window.stub.posts.length, proofs: window.stub.proofs.length, removed: window.stub.removals.length })))
        .toEqual({ posts: 2, proofs: 2, removed: 1 });
});

test('a persisted receipt treats ACK 404 as complete and never revokes the saved device', async ({ page }) => {
    await server.evaluate(() => { window.stub.failAck = true; });
    await page.evaluate(async () => {
        const c = await import('/__sync-recovery-test__/crypto.js');
        const session = await window.pairing.join('1234');
        const descriptor = await c.saveLocalSession(session);
        localStorage.setItem('__recovery_saved__', JSON.stringify(descriptor));
        await window.pairing.acknowledgeJoin(session);
    });
    expect(await page.evaluate(key => sessionStorage.getItem(key), recoveryKey)).toBeTruthy();
    await reload(page);
    await server.evaluate(() => { window.stub.failAck = false; window.stub.ack404 = true; });
    expect(await page.evaluate(() => window.pairing.recoverJoin())).toBeNull();
    expect(await page.evaluate(key => sessionStorage.getItem(key), recoveryKey)).toBeNull();
    expect(await server.evaluate(() => window.stub.removals)).toEqual([]);
    expect(await page.evaluate(async () => {
        const c = await import('/__sync-recovery-test__/crypto.js');
        return Boolean((await c.loadLocalSession(JSON.parse(localStorage.getItem('__recovery_saved__'))))?.keyring);
    })).toBe(true);
});

test('an expired recovery is cleared locally without joining or making network requests', async ({ page }) => {
    await server.evaluate(() => { window.stub.holdChallenge = true; });
    await startJoin(page);
    await waitForStub(() => window.stub.challengeWaits === 1);
    const id = await page.evaluate(async key => {
        const c = await import('/__sync-recovery-test__/crypto.js');
        const id = sessionStorage.getItem(key);
        const state = await c.loadPairingRecovery(id);
        state.expiresAt = Date.now() - 1;
        await c.savePairingRecovery(id, state);
        return id;
    }, recoveryKey);
    await reload(page);
    expect(await page.evaluate(() => window.pairing.recoverJoin())).toBeNull();
    expect(await page.evaluate(key => sessionStorage.getItem(key), recoveryKey)).toBeNull();
    expect(await page.evaluate(async id => (await import('/__sync-recovery-test__/crypto.js')).loadPairingRecovery(id), id)).toBeNull();
    expect(await server.evaluate(() => ({ posts: window.stub.posts.length, polls: window.stub.polls, settles: window.stub.settles, removed: window.stub.removals.length })))
        .toEqual({ posts: 1, polls: 1, settles: 0, removed: 0 });
});

test('two tabs sharing a recovery id allow only one active recovery', async ({ page, context }) => {
    await server.evaluate(() => { window.stub.holdChallenge = true; });
    await startJoin(page);
    await waitForStub(() => window.stub.challengeWaits === 1);
    const id = await page.evaluate(key => sessionStorage.getItem(key), recoveryKey);
    await reload(page);
    const other = await context.newPage();
    await other.goto(testPath);
    await other.evaluate(async ({ recoveryKey, id }) => { sessionStorage.setItem(recoveryKey, id); await window.bootRecoveryClient(); }, { recoveryKey, id });
    await page.evaluate(() => {
        window.recovered = null;
        window.recoveryPromise = window.pairing.recoverJoin().then(session => { window.recovered = session; });
    });
    await waitForStub(() => window.stub.challengeWaits === 2);
    expect(await other.evaluate(() => window.pairing.recoverJoin())).toBeNull();
    expect(await server.evaluate(() => window.stub.posts.length)).toBe(2);
    await server.evaluate(() => window.stub.release('challenge'));
    await page.evaluate(() => window.recoveryPromise);
    expect(await page.evaluate(() => Boolean(window.recovered?.keyring))).toBe(true);
    expect(await server.evaluate(() => window.stub.proofs.length)).toBe(1);
    await other.close();
});
