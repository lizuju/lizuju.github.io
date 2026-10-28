const { test, expect } = require('@playwright/test');
const { showSyncTools } = require('./fixtures/sync-tools.cjs');
const { readFile } = require('node:fs/promises');
const { createServer } = require('node:http');
const path = require('node:path');
const { authorize, startSite, deviceId, keyId } = require('./fixtures/sync-e2ee.cjs');

test.use({ serviceWorkers: 'block' });

test.beforeEach(async ({ page }) => {
    const root = path.resolve(__dirname, '..');
    await page.route('**/__sync-pairing-test__/**', async route => {
        const file = new URL(route.request().url()).pathname.split('/__sync-pairing-test__/')[1];
        if (!file) return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Pairing tests</title>' });
        let source;
        if (file === 'crypto.js') source = (await readFile(path.join(root, 'static/portfolio/js/apps/sync-crypto.js'), 'utf8')).replace('@serenity-kit/opaque', './opaque.js');
        else if (file === 'pairing.js') source = (await readFile(path.join(root, 'static/portfolio/js/apps/sync-pairing.js'), 'utf8')).replace('./sync-crypto.js', './crypto.js');
        else if (file === 'opaque.js') source = await readFile(path.join(root, 'node_modules/@serenity-kit/opaque/esm/index.js'), 'utf8');
        else return route.abort();
        return route.fulfill({ contentType: 'text/javascript', body: source });
    });
    await page.goto('/__sync-pairing-test__/');
});

for (const responseOrder of ['empty-read-first', 'new-offer-first', 'empty-read-started-after-create', 'closed-while-generating']) {
    test(`keeps the latest pairing state with ${responseOrder}`, async ({ page }) => {
        const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Sync-Key-Id', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
        let connection;
        let emptyRead;
        let newOffer;
        let postedOffer;
        let deviceReads = 0;
        const api = createServer(async (request, response) => {
            const pathname = new URL(request.url, 'http://localhost').pathname;
            const send = value => { response.writeHead(200, { ...headers, 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
            if (request.method === 'OPTIONS') { response.writeHead(204, headers); response.end(); return; }
            if (pathname.endsWith('/devices')) deviceReads++;
            if (pathname.endsWith('/pair-code')) {
                if (request.method === 'GET') { emptyRead = send; return; }
                if (request.method === 'POST') {
                    const chunks = [];
                    for await (const chunk of request) chunks.push(chunk);
                    postedOffer = { ...JSON.parse(Buffer.concat(chunks)), ownerDeviceId: deviceId, enabled: true, locked: false, expiresAt: Date.now() + 600000, revision: 10 };
                    newOffer = send;
                    return;
                }
            }
            send({ deviceId, devices: [], grants: [], hasMore: false, keyId, requests: [] });
        });
        await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
        const apiBase = `http://127.0.0.1:${api.address().port}`;
        const site = await startSite(apiBase);
        if (page.context().browser().browserType().name() === 'chromium') await page.context().grantPermissions(['local-network-access']);
        await page.routeWebSocket(`${apiBase.replace('http:', 'ws:')}/**`, socket => {
            connection = socket;
            socket.onMessage(data => {
                if (data === 'ping') return socket.send('pong');
                if (JSON.parse(data).type === 'auth') socket.send(JSON.stringify({ type: 'ready', deviceId, messages: [], pairing: null }));
            });
        });
        try {
            await authorize(page, `${site.origin}/chat/`);
            await page.reload();
            await expect(page.locator('[data-sync-status]')).toHaveAttribute('data-state', 'online');
            await expect.poll(() => deviceReads).toBeGreaterThan(0);
            const initialDeviceReads = deviceReads;
            if (responseOrder === 'empty-read-started-after-create') {
                await showSyncTools(page);
                await page.locator('[data-sync-pair]').click();
                await expect.poll(() => Boolean(newOffer)).toBe(true);
                connection.send(JSON.stringify({ type: 'key-rotation' }));
                await expect.poll(() => Boolean(emptyRead)).toBe(true);
            } else {
                connection.send(JSON.stringify({ type: 'key-rotation' }));
                await expect.poll(() => Boolean(emptyRead)).toBe(true);
                await showSyncTools(page);
                await page.locator('[data-sync-pair]').click();
                await expect.poll(() => Boolean(newOffer)).toBe(true);
            }
            if (responseOrder === 'new-offer-first') {
                newOffer(postedOffer);
                await expect(page.locator('[data-sync-pair-code]')).toHaveText(/^\d{4}$/);
                emptyRead(null);
                await expect.poll(() => deviceReads).toBeGreaterThan(initialDeviceReads);
            } else {
                emptyRead(null);
                await expect.poll(() => deviceReads).toBeGreaterThan(initialDeviceReads);
                if (responseOrder === 'closed-while-generating') {
                    connection.send(JSON.stringify({ type: 'pairing', pairing: { enabled: false, locked: false, revision: 11 } }));
                    await expect(page.locator('[data-sync-pair-expiry]')).toHaveText('');
                }
                newOffer(postedOffer);
            }
            await expect(page.locator('[data-sync-pair]')).toBeEnabled();
            if (responseOrder === 'closed-while-generating') {
                await expect(page.locator('[data-sync-pair-code]')).toHaveText('');
                await expect(page.locator('[data-sync-pairing]')).toBeHidden();
                await expect(page.locator('[data-sync-pair]')).toHaveText('生成配对码');
            } else {
                await expect(page.locator('[data-sync-pair-code]')).toHaveText(/^\d{4}$/);
                await expect(page.locator('[data-sync-pairing]')).toBeVisible();
            }
        } finally {
            await page.close();
            await site.close();
            api.closeAllConnections();
            await new Promise(resolve => api.close(resolve));
        }
    });
}

test('bounds a stalled encryption module by the join deadline without submitting a request', async ({ page }) => {
    await page.route('**/__sync-pairing-test__/opaque.js', route => route.fulfill({
        contentType: 'text/javascript', body: 'export const ready = new Promise(() => {});'
    }));
    const result = await page.evaluate(async () => {
        const { EncryptedPairing } = await import('/__sync-pairing-test__/pairing.js');
        const timeout = AbortSignal.timeout.bind(AbortSignal);
        AbortSignal.timeout = delay => timeout(delay === 30000 ? 200 : delay);
        const requests = [];
        const pairing = new EncryptedPairing({ getSession: () => null, api: async path => {
            requests.push(path);
            return { offers: [{ offerId: crypto.randomUUID(), expiresAt: Date.now() + 600000 }] };
        } });
        const started = performance.now();
        try { await pairing.join('1234'); return { code: 'unexpected_success' }; }
        catch (error) {
            return { code: error.code, elapsed: performance.now() - started, requests,
                recovery: pairing.hasPendingJoin(), busy: Boolean(pairing.joinController) };
        } finally { AbortSignal.timeout = timeout; }
    });
    expect(result.code).toBe('pairing_timeout');
    expect(result.elapsed).toBeLessThan(2000);
    expect(result.requests).toEqual(['/v1/pair/offers']);
    expect(result.recovery).toBe(false);
    expect(result.busy).toBe(false);
});

test('reports encryption loading failure separately from invalid pairing codes', async ({ page }) => {
    await page.route('**/__sync-pairing-test__/opaque.js', route => route.abort());
    const result = await page.evaluate(async () => {
        const { EncryptedPairing } = await import('/__sync-pairing-test__/pairing.js');
        const requests = [];
        const pairing = new EncryptedPairing({ getSession: () => null, api: async path => {
            requests.push(path);
            return { offers: [{ offerId: crypto.randomUUID(), expiresAt: Date.now() + 600000 }] };
        } });
        try { await pairing.join('1234'); return { code: 'unexpected_success' }; }
        catch (error) { return { code: error.code, requests, busy: Boolean(pairing.joinController) }; }
    });
    expect(result).toEqual({ code: 'encryption_load_failed', requests: ['/v1/pair/offers'], busy: false });
});

test('keeps service timeouts distinct from a missing host response', async ({ page }) => {
    const code = await page.evaluate(async () => {
        const { EncryptedPairing } = await import('/__sync-pairing-test__/pairing.js');
        const pairing = new EncryptedPairing({ getSession: () => null, api: async () => {
            throw Object.assign(new Error('Request timed out'), { name: 'TimeoutError', code: 'network_error' });
        } });
        try { await pairing.join('1234'); }
        catch (error) { return error.code; }
    });
    expect(code).toBe('network_error');
});

test('cancels a join while encryption loads without waiting for that module', async ({ page }) => {
    await page.route('**/__sync-pairing-test__/opaque.js', route => route.fulfill({
        contentType: 'text/javascript', body: 'export const ready = new Promise(() => {});'
    }));
    const result = await page.evaluate(async () => {
        const { EncryptedPairing } = await import('/__sync-pairing-test__/pairing.js');
        const requests = [];
        const pairing = new EncryptedPairing({ getSession: () => null, api: async path => {
            requests.push(path);
            setTimeout(() => pairing.reset(), 100);
            return { offers: [{ offerId: crypto.randomUUID(), expiresAt: Date.now() + 600000 }] };
        } });
        try { await pairing.join('1234'); return { name: 'unexpected_success' }; }
        catch (error) { return { name: error.name, requests, recovery: pairing.hasPendingJoin() }; }
    });
    expect(result).toEqual({ name: 'AbortError', requests: ['/v1/pair/offers'], recovery: false });
});

test('resets host invitations after a key change without cancelling a separate join', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const c = await import('/__sync-pairing-test__/crypto.js');
        const { EncryptedPairing } = await import('/__sync-pairing-test__/pairing.js');
        const session = { roomId: crypto.randomUUID(), deviceId: crypto.randomUUID(), keyring: await c.createKeyring() };
        const pairing = new EncryptedPairing({ getSession: () => session });
        const wireOffer = async revision => {
            const offerId = crypto.randomUUID();
            const secret = { code: '1234', ownerDeviceId: session.deviceId, expiresAt: Date.now() + 600000 };
            return { offerId, revision, ownerDeviceId: session.deviceId, expiresAt: secret.expiresAt,
                secret: await c.encryptPayload(session.keyring, session.roomId, `offer:${offerId}`, secret) };
        };
        await pairing.readOffer(await wireOffer(1));
        const oldOffer = pairing.offer;
        const guest = new AbortController();
        pairing.joinController = guest;
        sessionStorage.setItem('gavin-sync-pair-recovery', 'joining-another-space');
        session.keyring = await c.createKeyring();
        await pairing.readOffer(await wireOffer(2));
        const afterRotation = { oldOfferAborted: oldOffer.controller.signal.aborted,
            guestAborted: guest.signal.aborted, cancelled: sessionStorage.getItem('gavin-sync-pair-cancelled'),
            currentCode: pairing.offer.code };
        pairing.resetHost();
        const afterHostReset = { guestAborted: guest.signal.aborted,
            cancelled: sessionStorage.getItem('gavin-sync-pair-cancelled'), offer: pairing.offer };
        pairing.reset();
        return { afterRotation, afterHostReset, afterReset: { guestAborted: guest.signal.aborted,
            cancelled: sessionStorage.getItem('gavin-sync-pair-cancelled') } };
    });
    expect(result).toEqual({
        afterRotation: { oldOfferAborted: true, guestAborted: false, cancelled: null, currentCode: '1234' },
        afterHostReset: { guestAborted: false, cancelled: null, offer: null },
        afterReset: { guestAborted: true, cancelled: 'joining-another-space' }
    });
});

test('refuses old-epoch offers and never reuses a cached offer after key rotation', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const c = await import('/__sync-pairing-test__/crypto.js');
        const { EncryptedPairing } = await import('/__sync-pairing-test__/pairing.js');
        const old = await c.createKeyring();
        const fresh = await c.createKeyring();
        const session = { roomId: crypto.randomUUID(), deviceId: crypto.randomUUID(), keyring: { ...fresh, keys: { ...old.keys, ...fresh.keys } } };
        const pairing = new EncryptedPairing({ getSession: () => session, api: () => { throw new Error('unexpected relay request'); } });
        const offerId = crypto.randomUUID();
        const secret = { code: '1234', ownerDeviceId: session.deviceId, expiresAt: Date.now() + 600000 };
        const wire = { offerId, ownerDeviceId: session.deviceId, expiresAt: secret.expiresAt,
            secret: await c.encryptPayload(old, session.roomId, `offer:${offerId}`, secret) };
        const rejected = async operation => { try { await operation(); return false; } catch { return true; } };
        const oldRejected = await rejected(() => pairing.readOffer(wire));
        wire.secret = await c.encryptPayload(session.keyring, session.roomId, `offer:${offerId}`, secret);
        const accepted = await pairing.readOffer(wire);
        const latest = await c.createKeyring();
        session.keyring = { ...latest, keys: { ...session.keyring.keys, ...latest.keys } };
        await pairing.handle({ type: 'pair-request', offerId, requestId: crypto.randomUUID(), startLoginRequest: 'not-negotiated' });
        const cachedRejected = await rejected(() => pairing.readOffer(wire));
        return { oldRejected, currentAccepted: accepted.code === secret.code, cachedRejected, cacheCleared: pairing.offer === null };
    });
    expect(result).toEqual({ oldRejected: true, currentAccepted: true, cachedRejected: true, cacheCleared: true });
});

test('accepts identical offer snapshots delivered concurrently by HTTP and websocket', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const c = await import('/__sync-pairing-test__/crypto.js');
        const { EncryptedPairing } = await import('/__sync-pairing-test__/pairing.js');
        const session = { roomId: crypto.randomUUID(), deviceId: crypto.randomUUID(), keyring: await c.createKeyring() };
        const pairing = new EncryptedPairing({ getSession: () => session });
        const offerId = crypto.randomUUID();
        const secret = { code: '1234', ownerDeviceId: session.deviceId, expiresAt: Date.now() + 600000 };
        const wire = { offerId, ownerDeviceId: session.deviceId, expiresAt: secret.expiresAt, enabled: true, locked: false, revision: 10,
            secret: await c.encryptPayload(session.keyring, session.roomId, `offer:${offerId}`, secret) };
        const fromWebsocket = pairing.readOffer(wire);
        const fromHttp = pairing.readOffer(JSON.parse(JSON.stringify(wire)));
        const opened = await Promise.all([fromWebsocket, fromHttp]);
        return { codes: opened.map(offer => offer?.code ?? null), cachedCode: pairing.offer?.code,
            sameOffer: opened.every(offer => offer?.offerId === offerId) };
    });
    expect(result).toEqual({ codes: ['1234', '1234'], cachedCode: '1234', sameOffer: true });
});

test('keeps pairing closed when old offer decryption or an automatic renewal finishes later', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const c = await import('/__sync-pairing-test__/crypto.js');
        const { EncryptedPairing } = await import('/__sync-pairing-test__/pairing.js');
        const session = { roomId: crypto.randomUUID(), deviceId: crypto.randomUUID(), keyring: await c.createKeyring() };
        let release;
        let announce;
        const requested = new Promise(resolve => { announce = resolve; });
        const pairing = new EncryptedPairing({ getSession: () => session, api: async (_path, options) => {
            const body = JSON.parse(options.body);
            announce();
            await new Promise(resolve => { release = resolve; });
            return { ...body, ownerDeviceId: session.deviceId, enabled: true, locked: true, expiresAt: null, revision: 13 };
        } });
        const offerId = crypto.randomUUID();
        const secret = { code: '1234', ownerDeviceId: session.deviceId, expiresAt: null };
        const fixedSecret = await c.encryptPayload(session.keyring, session.roomId, 'pairing-code', { code: secret.code });
        const wire = { offerId, ownerDeviceId: session.deviceId, expiresAt: null, locked: true, enabled: true, revision: 10,
            secret: await c.encryptPayload(session.keyring, session.roomId, `offer:${offerId}`, secret), fixedSecret };
        const pending = pairing.readOffer(wire);
        await pairing.readOffer({ enabled: false, locked: false, fixedSecret: null, revision: 11 });
        const decrypted = await pending;
        const afterDecryption = { offer: pairing.offer, enabled: pairing.policy.enabled, revision: pairing.policy.revision };
        await pairing.readOffer(wire);
        const afterLateSnapshot = { offer: pairing.offer, enabled: pairing.policy.enabled, revision: pairing.policy.revision };
        await pairing.readOffer({ enabled: true, locked: true, fixedSecret, revision: 12 });
        const renewal = pairing.createOffer({ reopen: false });
        await requested;
        await pairing.readOffer({ enabled: false, locked: false, fixedSecret: null, revision: 14 });
        release();
        await renewal;
        return { decrypted, afterDecryption, afterLateSnapshot,
            afterRenewal: { offer: pairing.offer, enabled: pairing.policy.enabled, revision: pairing.policy.revision } };
    });
    expect(result).toEqual({ decrypted: null,
        afterDecryption: { offer: null, enabled: false, revision: 11 },
        afterLateSnapshot: { offer: null, enabled: false, revision: 11 },
        afterRenewal: { offer: null, enabled: false, revision: 14 } });
});

test('an epoch change during PAKE admission cannot release new room keys using the old code', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const c = await import('/__sync-pairing-test__/crypto.js');
        const { EncryptedPairing } = await import('/__sync-pairing-test__/pairing.js');
        const identity = await c.createDeviceIdentity();
        const session = { roomId: crypto.randomUUID(), deviceId: crypto.randomUUID(), keyring: await c.createKeyring(), identity, trustedDevices: {}, revokedDevices: [] };
        session.trustedDevices[session.deviceId] = identity.publicKey;
        const fresh = await c.createKeyring();
        const latest = { ...fresh, keys: { ...session.keyring.keys, ...fresh.keys } };
        let challenge;
        let accepted = 0;
        const pairing = new EncryptedPairing({ getSession: () => session, onAccepted: () => {}, onExpired: () => {}, api: async (path, options) => {
            const body = JSON.parse(options.body);
            if (path.endsWith('/pair-code')) return { ...body, ownerDeviceId: session.deviceId, expiresAt: Date.now() + 600000 };
            if (path.endsWith('/pair-challenge')) { challenge = body; return { accepted: true }; }
            if (path.endsWith('/pair-accept')) { accepted++; return { accepted: true }; }
            throw new Error('unexpected relay request');
        } });
        await pairing.createOffer();
        const offerId = pairing.offer.offerId;
        const requestId = crypto.randomUUID();
        const client = await c.startPairingClient(pairing.offer.code, offerId);
        await pairing.handle({ type: 'pair-request', offerId, requestId, startLoginRequest: client.startLoginRequest });
        const matched = await c.finishPairingClient(client.clientState, offerId, requestId, challenge.loginResponse);
        const peer = await c.createDeviceIdentity();
        const clientData = await c.encryptPairing(matched.sessionKey, offerId, requestId, { nonce: 'new-client', publicKey: peer.publicKey });
        const deriveBits = crypto.subtle.deriveBits.bind(crypto.subtle);
        let changed = false;
        crypto.subtle.deriveBits = async (...args) => {
            const value = await deriveBits(...args);
            changed = true;
            session.keyring = latest;
            return value;
        };
        try { await pairing.handle({ type: 'pair-finish', offerId, requestId, finishLoginRequest: matched.finishLoginRequest, clientData }); }
        finally { crypto.subtle.deriveBits = deriveBits; }
        return { changed, accepted, trustedCount: Object.keys(session.trustedDevices).length };
    });
    expect(result).toEqual({ changed: true, accepted: 0, trustedCount: 1 });
});

test('finds the unique matching room among thirty real PAKE candidates without consuming thirty attempts', async ({ page, isMobile }) => {
    test.skip(isMobile, 'the thirty-candidate protocol is exercised once per browser engine');
    test.setTimeout(120000);
    const result = await page.evaluate(async () => {
        const c = await import('/__sync-pairing-test__/crypto.js');
        const { EncryptedPairing } = await import('/__sync-pairing-test__/pairing.js');
        const offers = Array.from({ length: 30 }, () => ({ offerId: crypto.randomUUID(), expiresAt: Date.now() + 600000 }));
        const secrets = new Map();
        for (const [index, offer] of offers.entries()) {
            secrets.set(offer.offerId, await c.createPairingSecret(index === 29 ? '1234' : String(2000 + index), offer.offerId));
        }
        const roomId = crypto.randomUUID();
        const deviceId = crypto.randomUUID();
        const keyring = await c.createKeyring();
        let pending;
        let grant;
        let selected;
        let frameCount;
        let payloadBytes;
        const hosts = new Map();
        const pairing = new EncryptedPairing({ getSession: () => null, api: async (path, options = {}) => {
            if (path === '/v1/pair/offers') return { offers };
            if (path === '/v1/pair') {
                pending = JSON.parse(options.body);
                frameCount = pending.requests.length;
                payloadBytes = new TextEncoder().encode(options.body).length;
                for (const frame of pending.requests) {
                    hosts.set(frame.offerId, await c.startPairingHost(secrets.get(frame.offerId), frame.offerId, pending.requestId, frame.startLoginRequest));
                }
                return { accepted: true };
            }
            if (options.method === 'DELETE') return {};
            if (options.method === 'POST') {
                const body = JSON.parse(options.body);
                selected = body.offerId;
                const sessionKey = await c.finishPairingHost(hosts.get(selected).serverState, body.finishLoginRequest);
                const client = await c.decryptPairing(sessionKey, selected, pending.requestId, body.clientData);
                grant = await c.encryptPairing(sessionKey, selected, pending.requestId, {
                    roomId, deviceId, keyring, token: 'a'.repeat(64), trustedDevices: { [deviceId]: client.publicKey }, revokedDevices: [], nonce: client.nonce
                });
                return { accepted: true };
            }
            return grant ? { grant } : { responses: [...hosts].map(([offerId, host]) => ({ offerId, loginResponse: host.loginResponse })) };
        } });
        let ticks = 0;
        const timer = setInterval(() => { ticks++; }, 0);
        const startedAt = performance.now();
        try {
            const joined = await pairing.join('1234');
            return {
                joined: joined.roomId === roomId && joined.trustedDevices[joined.deviceId] === joined.identity.publicKey,
                selectedLast: selected === offers[29].offerId, frameCount, payloadBytes, ticks,
                attempts: JSON.parse(localStorage.getItem('gavin-sync-pair-attempts:join')).ids.length,
                elapsed: performance.now() - startedAt
            };
        } finally { clearInterval(timer); }
    });
    expect(result.joined).toBe(true);
    expect(result.selectedLast).toBe(true);
    expect(result.frameCount).toBe(30);
    expect(result.payloadBytes).toBeLessThan(32768);
    expect(result.attempts).toBe(1);
    expect(result.ticks).toBeGreaterThan(30);
    console.log(`Thirty-candidate PAKE: ${Math.round(result.elapsed)}ms, ${result.payloadBytes} request bytes`);
});

test('refuses two matching pairing codes before granting access to either room', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const c = await import('/__sync-pairing-test__/crypto.js');
        const { EncryptedPairing } = await import('/__sync-pairing-test__/pairing.js');
        const offers = Array.from({ length: 2 }, () => ({ offerId: crypto.randomUUID(), expiresAt: Date.now() + 600000 }));
        const secrets = new Map();
        for (const offer of offers) secrets.set(offer.offerId, await c.createPairingSecret('1234', offer.offerId));
        let responses;
        let admitted = 0;
        let cancelled = 0;
        const pairing = new EncryptedPairing({ getSession: () => null, api: async (path, options = {}) => {
            if (path === '/v1/pair/offers') return { offers };
            if (path === '/v1/pair') {
                const body = JSON.parse(options.body);
                responses = [];
                for (const frame of body.requests) {
                    const host = await c.startPairingHost(secrets.get(frame.offerId), frame.offerId, body.requestId, frame.startLoginRequest);
                    responses.push({ offerId: frame.offerId, loginResponse: host.loginResponse });
                }
                return {};
            }
            if (options.method === 'DELETE') { cancelled++; return {}; }
            if (options.method === 'POST') { admitted++; return {}; }
            return { responses };
        } });
        let code;
        try { await pairing.join('1234'); } catch (error) { code = error.code; }
        return { code, admitted, cancelled };
    });
    expect(result).toEqual({ code: 'pairing_ambiguous', admitted: 0, cancelled: 1 });
});

test('allows the twentieth join with thirty candidates and limits the twenty-first submission', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const { EncryptedPairing } = await import('/__sync-pairing-test__/pairing.js');
        localStorage.setItem('gavin-sync-pair-attempts:join', JSON.stringify({
            ids: Array.from({ length: 19 }, () => crypto.randomUUID()), expiresAt: Date.now() + 60000
        }));
        const offers = Array.from({ length: 30 }, () => ({ offerId: crypto.randomUUID(), expiresAt: Date.now() + 600000 }));
        let submissions = 0;
        const pairing = new EncryptedPairing({ getSession: () => null, api: async (path, options = {}) => {
            if (path === '/v1/pair/offers') return { offers };
            if (options.method === 'DELETE') return { ok: true, cancelled: true };
            submissions++;
            throw Object.assign(new Error('unavailable'), { code: 'unavailable' });
        } });
        const errors = [];
        for (let index = 0; index < 2; index++) {
            try { await pairing.join('1234'); } catch (error) { errors.push(error.code); }
        }
        return { submissions, errors, attempts: JSON.parse(localStorage.getItem('gavin-sync-pair-attempts:join')).ids.length };
    });
    expect(result).toEqual({ submissions: 1, errors: ['unavailable', 'pairing_limited'], attempts: 20 });
});

test('isolates hosting attempts by trusted source while retaining a bounded aggregate budget', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const c = await import('/__sync-pairing-test__/crypto.js');
        const { EncryptedPairing } = await import('/__sync-pairing-test__/pairing.js');
        const session = { roomId: crypto.randomUUID(), deviceId: crypto.randomUUID(), keyring: await c.createKeyring() };
        let challenges = 0;
        let expired = 0;
        const pairing = new EncryptedPairing({ getSession: () => session, onExpired: () => { expired++; }, api: async (path, options) => {
            const body = JSON.parse(options.body);
            if (path.endsWith('/pair-code')) return { ...body, ownerDeviceId: session.deviceId, expiresAt: Date.now() + 600000 };
            challenges++;
            return { accepted: true };
        } });
        await pairing.createOffer();
        const send = async sourceId => {
            const client = await c.startPairingClient('9999', pairing.offer.offerId);
            return pairing.handle({ type: 'pair-request', offerId: pairing.offer.offerId, requestId: crypto.randomUUID(), sourceId, startLoginRequest: client.startLoginRequest });
        };
        for (let index = 0; index < 21; index++) await send('a'.repeat(64));
        const sameSource = challenges;
        for (let index = 1; index < 30; index++) await send(index.toString(16).padStart(64, '0'));
        const independentSources = challenges;
        const key = `gavin-sync-pair-attempts:host:${pairing.offer.offerId}`;
        const saved = JSON.parse(localStorage.getItem(key));
        saved.ids = Array.from({ length: 600 }, () => crypto.randomUUID());
        localStorage.setItem(key, JSON.stringify(saved));
        let code;
        try { await send('b'.repeat(64)); } catch (error) { code = error.code; }
        return { sameSource, independentSources, challenges, expired, code };
    });
    expect(result).toEqual({ sameSource: 20, independentSources: 49, challenges: 49, expired: 1, code: 'pairing_limited' });
});

test('an old room hitting its pairing budget cannot close invitations after a space switch', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const { EncryptedPairing } = await import('/__sync-pairing-test__/pairing.js');
        let session = { deviceId: 'old-device', keyring: { currentKeyId: 'old-key' } };
        let expired = 0;
        const pairing = new EncryptedPairing({ getSession: () => session, onExpired: () => { expired++; } });
        pairing.offer = { offerId: 'old-offer', ownerDeviceId: session.deviceId, keyId: 'old-key', locked: true, controller: new AbortController() };
        localStorage.setItem('gavin-sync-pair-attempts:host:old-offer', JSON.stringify({
            ids: Array.from({ length: 600 }, () => crypto.randomUUID()), expiresAt: Date.now() + 600000
        }));
        const lockName = 'gavin-sync-pair:host:old-offer';
        let release, acquired;
        const ready = new Promise(resolve => { acquired = resolve; });
        const held = navigator.locks.request(lockName, () => new Promise(resolve => { release = resolve; acquired(); }));
        await ready;
        const request = pairing.handle({ type: 'pair-request', offerId: 'old-offer', requestId: crypto.randomUUID(), sourceId: 'source' })
            .catch(error => error.code);
        while (!(await navigator.locks.query()).pending.some(lock => lock.name === lockName)) await new Promise(resolve => setTimeout(resolve, 0));
        pairing.reset();
        session = { deviceId: 'new-device', keyring: { currentKeyId: 'new-key' } };
        release();
        await held;
        return { code: await request, expired };
    });
    expect(result).toEqual({ code: 'pairing_limited', expired: 0 });
});

test('expires abandoned handshakes while a locked pairing code stays open for days', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const c = await import('/__sync-pairing-test__/crypto.js');
        const { EncryptedPairing } = await import('/__sync-pairing-test__/pairing.js');
        const session = { roomId: crypto.randomUUID(), deviceId: crypto.randomUUID(), keyring: await c.createKeyring() };
        const clock = Date.now;
        let now = clock();
        Date.now = () => now;
        let challenges = 0;
        let accepted = 0;
        const pairing = new EncryptedPairing({ getSession: () => session, onExpired: () => { throw new Error('locked offer expired'); }, api: async (path, options) => {
            const body = JSON.parse(options.body);
            if (path.endsWith('/pair-code')) return {
                ...body, enabled: true, revision: now, ownerDeviceId: session.deviceId,
                expiresAt: body.locked ? null : now + 600000
            };
            if (path.endsWith('/pair-accept')) accepted++;
            else challenges++;
            return { accepted: true };
        } });
        try {
            await pairing.createOffer();
            const initialCode = pairing.offer.code;
            const offerId = pairing.offer.offerId;
            await pairing.setLocked(true);
            const request = async () => {
                const client = await c.startPairingClient('9999', offerId);
                const requestId = crypto.randomUUID();
                await pairing.handle({ type: 'pair-request', offerId, requestId,
                    sourceId: 'a'.repeat(64), startLoginRequest: client.startLoginRequest });
                return requestId;
            };
            const first = await request();
            now += 5 * 60000;
            const second = await request();
            const secondHost = pairing.hosts.get(second);
            const beforeExpiry = pairing.hosts.size;
            now += 5 * 60000 + 1;
            const third = await request();
            const afterExpiry = {
                size: pairing.hosts.size, firstRemoved: !pairing.hosts.has(first),
                recentRetained: pairing.hosts.get(second) === secondHost, latestPresent: pairing.hosts.has(third)
            };
            await pairing.handle({ type: 'pair-finish', offerId, requestId: first,
                finishLoginRequest: 'expired', clientData: 'expired' });
            now += 3 * 24 * 60 * 60000;
            const latest = await request();
            return { beforeExpiry, afterExpiry, afterDays: pairing.hosts.size,
                latestPresent: pairing.hosts.has(latest), challenges, accepted,
                locked: pairing.offer.locked, expiresAt: pairing.offer.expiresAt,
                sameOffer: pairing.offer.offerId === offerId, sameCode: pairing.offer.code === initialCode };
        } finally { Date.now = clock; pairing.reset(); }
    });
    expect(result).toEqual({ beforeExpiry: 2,
        afterExpiry: { size: 2, firstRemoved: true, recentRetained: true, latestPresent: true },
        afterDays: 1, latestPresent: true, challenges: 4, accepted: 0,
        locked: true, expiresAt: null, sameOffer: true, sameCode: true });
});

test('counts each join once when five spaces are waiting for pairing', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const { EncryptedPairing } = await import('/__sync-pairing-test__/pairing.js');
        const offers = Array.from({ length: 5 }, () => ({ offerId: crypto.randomUUID() }));
        const sent = [];
        const pairing = new EncryptedPairing({ getSession: () => null, api: async (path, options) => {
            if (path === '/v1/pair/offers') return { offers };
            if (options.method === 'DELETE') return { ok: true, cancelled: true };
            sent.push(JSON.parse(options.body).requests.length);
            throw new Error('relay-unavailable');
        } });
        const outcomes = [];
        for (let index = 0; index < 2; index++) {
            try { await pairing.join('1234'); }
            catch (error) { outcomes.push(error.code || error.message); }
        }
        return { sent, outcomes, count: JSON.parse(localStorage.getItem('gavin-sync-pair-attempts:join')).ids.length };
    });
    expect(result).toEqual({ sent: [5, 5], outcomes: ['relay-unavailable', 'relay-unavailable'], count: 2 });
});

test('allows twenty joins, returns a cooldown on the twenty-first and resumes after expiry', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const { EncryptedPairing } = await import('/__sync-pairing-test__/pairing.js');
        const key = 'gavin-sync-pair-attempts:join';
        localStorage.setItem(key, JSON.stringify({ ids: Array.from({ length: 19 }, () => crypto.randomUUID()), expiresAt: Date.now() + 60000 }));
        const offers = Array.from({ length: 5 }, () => ({ offerId: crypto.randomUUID() }));
        let sent = 0;
        const pairing = new EncryptedPairing({ getSession: () => null, api: async (path, options = {}) => {
            if (path === '/v1/pair/offers') return { offers };
            if (options.method === 'DELETE') return { ok: true, cancelled: true };
            sent++;
            throw new Error('relay-unavailable');
        } });
        const attempt = async () => {
            try { await pairing.join('1234'); }
            catch (error) { return { code: error.code || error.message, retryAfter: error.retryAfter }; }
        };
        const allowed = await attempt();
        const count = JSON.parse(localStorage.getItem(key)).ids.length;
        const blocked = await attempt();
        const saved = JSON.parse(localStorage.getItem(key));
        saved.expiresAt = Date.now() - 1;
        localStorage.setItem(key, JSON.stringify(saved));
        const resumed = await attempt();
        return { allowed, count, blocked, resumed, sent, resumedCount: JSON.parse(localStorage.getItem(key)).ids.length };
    });
    expect(result.allowed.code).toBe('relay-unavailable');
    expect(result.count).toBe(20);
    expect(result.blocked.code).toBe('pairing_limited');
    expect(result.blocked.retryAfter).toBeGreaterThan(0);
    expect(result.blocked.retryAfter).toBeLessThanOrEqual(60);
    expect(result.resumed.code).toBe('relay-unavailable');
    expect(result.sent).toBe(2);
    expect(result.resumedCount).toBe(1);
});

test('corrects old per-candidate counts without clearing genuine attempts or extending the window', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const { EncryptedPairing } = await import('/__sync-pairing-test__/pairing.js');
        const key = 'gavin-sync-pair-attempts:join';
        const offers = Array.from({ length: 5 }, () => ({ offerId: crypto.randomUUID() }));
        const previousRequest = crypto.randomUUID();
        const expiresAt = Date.now() + 60000;
        localStorage.setItem(key, JSON.stringify({ ids: offers.map(offer => `${previousRequest}:${offer.offerId}`), expiresAt }));
        let sent = 0;
        const pairing = new EncryptedPairing({ getSession: () => null, api: async (path, options = {}) => {
            if (path === '/v1/pair/offers') return { offers };
            if (options.method === 'DELETE') return { ok: true, cancelled: true };
            sent++;
            throw new Error('relay-unavailable');
        } });
        try { await pairing.join('1234'); } catch {}
        const saved = JSON.parse(localStorage.getItem(key));
        const previous = Array.from({ length: 20 }, () => crypto.randomUUID());
        localStorage.setItem(key, JSON.stringify({ ids: previous, expiresAt }));
        let blocked;
        try { await pairing.join('1234'); }
        catch (error) { blocked = error.code; }
        return { count: saved.ids.length, keptPrevious: saved.ids.includes(previousRequest), sameExpiry: saved.expiresAt === expiresAt, sent, blocked };
    });
    expect(result).toEqual({ count: 2, keptPrevious: true, sameExpiry: true, sent: 1, blocked: 'pairing_limited' });
});

test('retries an unacknowledged challenge with the same PAKE state after network recovery', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const c = await import('/__sync-pairing-test__/crypto.js');
        const { EncryptedPairing } = await import('/__sync-pairing-test__/pairing.js');
        const session = { roomId: crypto.randomUUID(), deviceId: crypto.randomUUID(), keyring: await c.createKeyring() };
        const challenges = [];
        let event;
        const pairing = new EncryptedPairing({ getSession: () => session, api: async (path, options) => {
            if (path.endsWith('/pair-code')) return { ...JSON.parse(options.body), ownerDeviceId: session.deviceId, expiresAt: Date.now() + 600000 };
            if (path.endsWith('/pair-requests')) return { requests: [event] };
            challenges.push(JSON.parse(options.body).loginResponse);
            if (challenges.length <= 3) throw new TypeError('temporary network failure');
            return { accepted: true };
        } });
        await pairing.createOffer();
        const offerId = pairing.offer.offerId;
        const client = await c.startPairingClient(pairing.offer.code, offerId);
        event = { type: 'pair-request', offerId, requestId: crypto.randomUUID(), sourceId: 'a'.repeat(64), startLoginRequest: client.startLoginRequest };
        try { await pairing.handle(event); } catch {}
        const cached = pairing.hosts.get(event.requestId);
        await Promise.all([pairing.resume(), pairing.handle(event)]);
        await pairing.handle(event);
        const match = await c.finishPairingClient(client.clientState, offerId, event.requestId, challenges[3]);
        const key = await c.finishPairingHost(cached.serverState, match.finishLoginRequest);
        return { requests: challenges.length, unchanged: challenges.every(value => value === challenges[0]), matched: key === match.sessionKey,
            attempts: JSON.parse(localStorage.getItem(`gavin-sync-pair-attempts:host:${offerId}`)).ids.length };
    });
    expect(result).toEqual({ requests: 4, unchanged: true, matched: true, attempts: 1 });
});

test('does not admit a matching room while another candidate has not responded by the deadline', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const c = await import('/__sync-pairing-test__/crypto.js');
        const { EncryptedPairing } = await import('/__sync-pairing-test__/pairing.js');
        const offers = Array.from({ length: 2 }, () => ({ offerId: crypto.randomUUID(), expiresAt: Date.now() + 600000 }));
        const secret = await c.createPairingSecret('1234', offers[0].offerId);
        const now = Date.now;
        let elapsed = 0;
        let response;
        let admitted = 0;
        let cancelled = 0;
        Date.now = () => now() + elapsed;
        const pairing = new EncryptedPairing({ getSession: () => null, api: async (path, options = {}) => {
            if (path === '/v1/pair/offers') return { offers };
            if (path === '/v1/pair') {
                const body = JSON.parse(options.body);
                const host = await c.startPairingHost(secret, offers[0].offerId, body.requestId, body.requests[0].startLoginRequest);
                response = { offerId: offers[0].offerId, loginResponse: host.loginResponse };
                return {};
            }
            if (options.method === 'DELETE') { cancelled++; return {}; }
            if (options.method === 'POST') { admitted++; return {}; }
            elapsed = 13000;
            return { responses: [response] };
        } });
        let code;
        try { await pairing.join('1234'); } catch (error) { code = error.code; }
        finally { Date.now = now; }
        return { code, admitted, cancelled };
    });
    expect(result).toEqual({ code: 'pairing_timeout', admitted: 0, cancelled: 1 });
});


test('automatically recovers a transient challenge failure without websocket reconnect or manual resume', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const c = await import('/__sync-pairing-test__/crypto.js');
        const { EncryptedPairing } = await import('/__sync-pairing-test__/pairing.js');
        const session = { roomId: crypto.randomUUID(), deviceId: crypto.randomUUID(), keyring: await c.createKeyring() };
        const responses = [];
        const pairing = new EncryptedPairing({ getSession: () => session, api: async (path, options) => {
            if (path.endsWith('/pair-code')) return { ...JSON.parse(options.body), ownerDeviceId: session.deviceId, expiresAt: Date.now() + 600000 };
            responses.push(JSON.parse(options.body).loginResponse);
            if (responses.length === 1) throw new TypeError('temporary network failure');
            return { accepted: true };
        } });
        await pairing.createOffer();
        const offerId = pairing.offer.offerId;
        const client = await c.startPairingClient(pairing.offer.code, offerId);
        const event = { type: 'pair-request', offerId, requestId: crypto.randomUUID(), sourceId: 'a'.repeat(64), startLoginRequest: client.startLoginRequest };
        await pairing.handle(event);
        const host = pairing.hosts.get(event.requestId);
        const match = await c.finishPairingClient(client.clientState, offerId, event.requestId, responses[1]);
        return { requests: responses.length, unchanged: responses[0] === responses[1], acknowledged: host.challenged,
            matched: await c.finishPairingHost(host.serverState, match.finishLoginRequest) === match.sessionKey };
    });
    expect(result).toEqual({ requests: 2, unchanged: true, acknowledged: true, matched: true });
});

test('challenge retries honor Retry-After and stop on reset or a permanent rejection', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const c = await import('/__sync-pairing-test__/crypto.js');
        const { EncryptedPairing } = await import('/__sync-pairing-test__/pairing.js');
        const run = async scenario => {
            const session = { roomId: crypto.randomUUID(), deviceId: crypto.randomUUID(), keyring: await c.createKeyring() };
            const calls = [];
            let pairing;
            pairing = new EncryptedPairing({ getSession: () => session, api: async (path, options) => {
                if (path.endsWith('/pair-code')) return { ...JSON.parse(options.body), ownerDeviceId: session.deviceId, expiresAt: Date.now() + 600000 };
                calls.push(performance.now());
                if (scenario === 'reset') {
                    setTimeout(() => pairing.reset(), 30);
                    throw new TypeError('temporary network failure');
                }
                if (scenario === 'permanent') throw Object.assign(new Error('pairing_conflict'), { code: 'pairing_conflict', status: 409 });
                if (calls.length === 1) throw Object.assign(new Error('internal_error'), { code: 'internal_error', status: 503, retryAfter: 1 });
                return { accepted: true };
            } });
            await pairing.createOffer();
            const offerId = pairing.offer.offerId;
            const client = await c.startPairingClient(pairing.offer.code, offerId);
            let error;
            try { await pairing.handle({ type: 'pair-request', offerId, requestId: crypto.randomUUID(), sourceId: 'a'.repeat(64), startLoginRequest: client.startLoginRequest }); }
            catch (failure) { error = failure.code || failure.name; }
            return { calls: calls.length, delay: calls[1] - calls[0], error, cleared: pairing.offer === null };
        };
        return { waiting: await run('waiting'), reset: await run('reset'), permanent: await run('permanent') };
    });
    expect(result.waiting.calls).toBe(2);
    expect(result.waiting.delay).toBeGreaterThanOrEqual(950);
    expect(result.reset).toMatchObject({ calls: 1, cleared: true });
    expect(result.permanent).toMatchObject({ calls: 1, error: 'pairing_conflict' });
});
