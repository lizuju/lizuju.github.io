const { test, expect } = require('@playwright/test');
const { readFile } = require('node:fs/promises');
const path = require('node:path');

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

test('allows five join submissions with thirty candidates and limits the sixth submission', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const { EncryptedPairing } = await import('/__sync-pairing-test__/pairing.js');
        const offers = Array.from({ length: 30 }, () => ({ offerId: crypto.randomUUID(), expiresAt: Date.now() + 600000 }));
        let submissions = 0;
        const pairing = new EncryptedPairing({ getSession: () => null, api: async (path) => {
            if (path === '/v1/pair/offers') return { offers };
            submissions++;
            throw Object.assign(new Error('unavailable'), { code: 'unavailable' });
        } });
        const errors = [];
        for (let index = 0; index < 6; index++) {
            try { await pairing.join('1234'); } catch (error) { errors.push(error.code); }
        }
        return { submissions, errors, attempts: JSON.parse(localStorage.getItem('gavin-sync-pair-attempts:join')).ids.length };
    });
    expect(result).toEqual({ submissions: 5, errors: [...Array(5).fill('unavailable'), 'pairing_limited'], attempts: 5 });
});

test('retains the five-attempt limit for each hosting offer', async ({ page }) => {
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
        let code;
        for (let index = 0; index < 6; index++) {
            const client = await c.startPairingClient('9999', pairing.offer.offerId);
            try { await pairing.handle({ type: 'pair-request', offerId: pairing.offer.offerId, requestId: crypto.randomUUID(), startLoginRequest: client.startLoginRequest }); }
            catch (error) { code = error.code; }
        }
        return { challenges, expired, code };
    });
    expect(result).toEqual({ challenges: 5, expired: 1, code: 'pairing_limited' });
});
