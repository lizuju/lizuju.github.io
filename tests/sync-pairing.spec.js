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
