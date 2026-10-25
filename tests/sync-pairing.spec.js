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

test('allows the twentieth join with thirty candidates and limits the twenty-first submission', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const { EncryptedPairing } = await import('/__sync-pairing-test__/pairing.js');
        localStorage.setItem('gavin-sync-pair-attempts:join', JSON.stringify({
            ids: Array.from({ length: 19 }, () => crypto.randomUUID()), expiresAt: Date.now() + 60000
        }));
        const offers = Array.from({ length: 30 }, () => ({ offerId: crypto.randomUUID(), expiresAt: Date.now() + 600000 }));
        let submissions = 0;
        const pairing = new EncryptedPairing({ getSession: () => null, api: async (path) => {
            if (path === '/v1/pair/offers') return { offers };
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

test('counts each join once when five spaces are waiting for pairing', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const { EncryptedPairing } = await import('/__sync-pairing-test__/pairing.js');
        const offers = Array.from({ length: 5 }, () => ({ offerId: crypto.randomUUID() }));
        const sent = [];
        const pairing = new EncryptedPairing({ getSession: () => null, api: async (path, options) => {
            if (path === '/v1/pair/offers') return { offers };
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
        const pairing = new EncryptedPairing({ getSession: () => null, api: async path => {
            if (path === '/v1/pair/offers') return { offers };
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
        const pairing = new EncryptedPairing({ getSession: () => null, api: async path => {
            if (path === '/v1/pair/offers') return { offers };
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
