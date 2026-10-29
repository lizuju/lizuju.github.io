const { test, expect } = require('@playwright/test');
const { readFile } = require('node:fs/promises');
const path = require('node:path');

test.beforeEach(async ({ page, context }) => {
    const root = path.resolve(__dirname, '..');
    await context.route('**/__sync-crypto-test__/**', async (route) => {
        const file = new URL(route.request().url()).pathname.split('/__sync-crypto-test__/')[1];
        if (!file) return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Crypto tests</title>' });
        let source;
        if (file === 'module.js') source = (await readFile(path.join(root, 'static/portfolio/js/apps/sync-crypto.js'), 'utf8')).replace('@serenity-kit/opaque', './opaque.js');
        else if (['sync-image-thumbnail.js', 'sync-image-resource.js', 'sync-thumbnail-worker.js'].includes(file)) source = await readFile(path.join(root, 'static/portfolio/js/apps', file), 'utf8');
        else if (file === 'pairing.js') source = (await readFile(path.join(root, 'static/portfolio/js/apps/sync-pairing.js'), 'utf8')).replace('./sync-crypto.js', './module.js');
        else if (file === 'opaque.js') source = await readFile(path.join(root, 'node_modules/@serenity-kit/opaque/esm/index.js'), 'utf8');
        else if (file === 'fingerprint-worker.js') source = (await readFile(path.join(root, 'static/portfolio/js/apps/sync-upload-fingerprint-worker.js'), 'utf8')).replace('@noble/hashes/sha2.js', './noble/sha2.js');
        else if (/^noble\/[A-Za-z0-9_.-]+\.js$/.test(file)) source = await readFile(path.join(root, 'node_modules/@noble/hashes', file.slice(6)), 'utf8');
        else return route.abort();
        return route.fulfill({ contentType: 'text/javascript', body: source });
    });
    await page.goto('/__sync-crypto-test__/');
});

test('authenticates messages and file chunks with room, sender and sequence context', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const c = await import('/__sync-crypto-test__/module.js');
        const keyring = await c.createKeyring();
        const payload = { text: 'private message', attachment: { name: '私人文件.xlsx' } };
        const purpose = 'message:device:client';
        const first = await c.encryptPayload(keyring, 'room', purpose, payload);
        const second = await c.encryptPayload(keyring, 'room', purpose, payload);
        const rejected = async (operation) => { try { await operation(); return false; } catch { return true; } };
        const metadata = c.createFileMetadata({ name: 'private.mp4', type: 'video/mp4', size: 512 * 1024 - 16 + 31 });
        const firstBytes = new Uint8Array(c.fileChunkLayout(metadata).plainSize).fill(7);
        const lastBytes = new Uint8Array(31).fill(11);
        const firstChunk = await c.encryptFileChunk(metadata, 0, firstBytes);
        const lastChunk = await c.encryptFileChunk(metadata, 1, lastBytes);
        const tamperedChunk = new Uint8Array(firstChunk.slice(0));
        tamperedChunk[3] ^= 1;
        const envelope = JSON.parse(atob(first.slice(6).replaceAll('-', '+').replaceAll('_', '/')));
        envelope.ciphertext = `${envelope.ciphertext[0] === 'A' ? 'B' : 'A'}${envelope.ciphertext.slice(1)}`;
        const tampered = `e2ee1.${btoa(JSON.stringify(envelope)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')}`;
        return {
            payload: await c.decryptPayload(keyring, 'room', purpose, first),
            freshNonce: first !== second,
            hidesContent: !first.includes(payload.text) && !first.includes(payload.attachment.name),
            rejectsPlaintext: await rejected(() => c.decryptPayload(keyring, 'room', purpose, JSON.stringify(payload))),
            rejectsRoom: await rejected(() => c.decryptPayload(keyring, 'other-room', purpose, first)),
            rejectsSender: await rejected(() => c.decryptPayload(keyring, 'room', 'message:other-device:client', first)),
            rejectsTampering: await rejected(() => c.decryptPayload(keyring, 'room', purpose, tampered)),
            rejectsWrongKey: await rejected(async () => c.decryptPayload(await c.createKeyring(), 'room', purpose, first)),
            chunkSizes: [firstChunk.byteLength, lastChunk.byteLength],
            firstContent: new Uint8Array(await c.decryptFileChunk(metadata, 0, firstChunk)).every((value) => value === 7),
            lastContent: Array.from(new Uint8Array(await c.decryptFileChunk(metadata, 1, lastChunk))),
            rejectsChunkTampering: await rejected(() => c.decryptFileChunk(metadata, 0, tamperedChunk)),
            rejectsChunkSwap: await rejected(() => c.decryptFileChunk(metadata, 1, firstChunk)),
            keyedIdentity: await c.keyedFingerprint(metadata, 'same-full-content-hash') !== await c.keyedFingerprint(c.createFileMetadata({ name: 'same', size: 1 }), 'same-full-content-hash')
        };
    });
    expect(result.payload).toEqual({ text: 'private message', attachment: { name: '私人文件.xlsx' } });
    for (const name of ['freshNonce', 'hidesContent', 'rejectsPlaintext', 'rejectsRoom', 'rejectsSender', 'rejectsTampering', 'rejectsWrongKey', 'firstContent', 'rejectsChunkTampering', 'rejectsChunkSwap', 'keyedIdentity']) expect(result[name], name).toBe(true);
    expect(result.chunkSizes).toEqual([512 * 1024, 47]);
    expect(result.lastContent).toEqual(Array(31).fill(11));
});

test('pairs with a four digit PAKE secret and refuses incorrect codes and replayed envelopes', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const c = await import('/__sync-crypto-test__/module.js');
        const secret = await c.createPairingSecret('0012', 'offer');
        const client = await c.startPairingClient('0012', 'offer');
        const host = await c.startPairingHost(secret, 'offer', 'request', client.startLoginRequest);
        const accepted = await c.finishPairingClient(client.clientState, 'offer', 'request', host.loginResponse);
        const sessionKey = await c.finishPairingHost(host.serverState, accepted.finishLoginRequest);
        const keyring = await c.createKeyring();
        const envelope = await c.encryptPairing(sessionKey, 'offer', 'request', { keyring });
        const wrongClient = await c.startPairingClient('0013', 'offer');
        const wrongHost = await c.startPairingHost(secret, 'offer', 'wrong-request', wrongClient.startLoginRequest);
        let wrongCode = false;
        let replay = false;
        try { await c.finishPairingClient(wrongClient.clientState, 'offer', 'wrong-request', wrongHost.loginResponse); } catch (error) { wrongCode = error.code === 'invalid_code'; }
        try { await c.decryptPairing(sessionKey, 'offer', 'other-request', envelope); } catch { replay = true; }
        return { sameKey: sessionKey === accepted.sessionKey, keyringMatches: JSON.stringify((await c.decryptPairing(accepted.sessionKey, 'offer', 'request', envelope)).keyring) === JSON.stringify(keyring), wrongCode, replay, hidesKey: !envelope.includes(keyring.keys[keyring.currentKeyId]) };
    });
    expect(result).toEqual({ sameKey: true, keyringMatches: true, wrongCode: true, replay: true, hidesKey: true });
});

test('persists only a wrapped session beside a nonextractable IndexedDB key', async ({ page }) => {
    const saved = await page.evaluate(async () => {
        const c = await import('/__sync-crypto-test__/module.js');
        const keyring = await c.createKeyring();
        const descriptor = await c.saveLocalSession({ roomId: 'room', deviceId: 'device', token: 'token', keyring });
        const database = await new Promise((resolve) => { const request = indexedDB.open('gavin-sync-key-vault'); request.onsuccess = () => resolve(request.result); });
        const record = await new Promise((resolve) => { const request = database.transaction('sessions').objectStore('sessions').get(descriptor.vaultId); request.onsuccess = () => resolve(request.result); });
        database.close();
        return { descriptor, key: keyring.keys[keyring.currentKeyId], persisted: JSON.stringify(record), extractable: record.key.extractable };
    });
    expect(saved.extractable).toBe(false);
    expect(saved.persisted).not.toContain(saved.key);
    expect(saved.descriptor).not.toHaveProperty('keyring');
    await page.reload();
    const loaded = await page.evaluate(async ({ descriptor, key }) => {
        const c = await import('/__sync-crypto-test__/module.js');
        const session = await c.loadLocalSession(descriptor);
        let substituted = false;
        try { await c.loadLocalSession({ ...descriptor, roomId: 'other-room' }); } catch { substituted = true; }
        await c.deleteLocalSession(descriptor.vaultId);
        let deleted = false;
        try { await c.loadLocalSession(descriptor); } catch (error) { deleted = error.code === 'key_unavailable'; }
        return { restored: session.keyring.keys[session.keyring.currentKeyId] === key, substituted, deleted };
    }, saved);
    expect(loaded).toEqual({ restored: true, substituted: true, deleted: true });
});

test('stale tabs cannot overwrite a newer persisted encryption epoch', async ({ page, context }) => {
    const saved = await page.evaluate(async () => {
        const c = await import('/__sync-crypto-test__/module.js');
        const keyring = await c.createKeyring();
        const session = { roomId: 'room', deviceId: 'device', token: 'token', keyring };
        const descriptor = await c.saveLocalSession(session);
        return { descriptor, session: { ...session, vaultId: descriptor.vaultId } };
    });
    const other = await context.newPage();
    await other.goto('/__sync-crypto-test__/');
    const advanced = await page.evaluate(async ({ descriptor, session }) => {
        const c = await import('/__sync-crypto-test__/module.js');
        const added = await c.createKeyring();
        const next = { ...session, keyring: { ...added, keys: { ...session.keyring.keys, ...added.keys } } };
        await c.saveLocalSession(next);
        return { descriptor, keyId: added.currentKeyId };
    }, saved);
    const result = await other.evaluate(async ({ session, advanced }) => {
        const c = await import('/__sync-crypto-test__/module.js');
        let refused = false;
        try { await c.saveLocalSession(session); } catch (error) { refused = error.code === 'key_changed'; }
        const loaded = await c.loadLocalSession(advanced.descriptor);
        await c.deleteLocalSession(advanced.descriptor.vaultId);
        return { refused, latest: loaded.keyring.currentKeyId === advanced.keyId };
    }, { session: saved.session, advanced });
    expect(result).toEqual({ refused: true, latest: true });
    await other.close();
});

test('wraps rotated room keys for the intended device and authenticated sender only', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const c = await import('/__sync-crypto-test__/module.js');
        const [alice, bob, removed] = await Promise.all([c.createDeviceIdentity(), c.createDeviceIdentity(), c.createDeviceIdentity()]);
        const keyring = await c.createKeyring();
        const context = 'room:rotation:bob';
        const envelope = await c.wrapKeyring(alice, bob.publicKey, context, keyring);
        const rejected = async (operation) => { try { await operation(); return false; } catch { return true; } };
        return {
            correctRecipient: JSON.stringify(await c.unwrapKeyring(bob, alice.publicKey, context, envelope)) === JSON.stringify(keyring),
            removedDevice: await rejected(() => c.unwrapKeyring(removed, alice.publicKey, context, envelope)),
            senderSubstitution: await rejected(() => c.unwrapKeyring(bob, removed.publicKey, context, envelope)),
            replay: await rejected(() => c.unwrapKeyring(bob, alice.publicKey, 'room:other-rotation:bob', envelope)),
            reflection: await rejected(() => c.unwrapKeyring(alice, bob.publicKey, context, envelope)),
            hidesKey: !envelope.includes(keyring.keys[keyring.currentKeyId])
        };
    });
    expect(result).toEqual({ correctRecipient: true, removedDevice: true, senderSubstitution: true, replay: true, reflection: true, hidesKey: true });
});

test('admits new members only through a pinned issuer and preserves revocations across epochs', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const c = await import('/__sync-crypto-test__/module.js');
        const [alice, bob, newcomer, removed] = await Promise.all(Array.from({ length: 4 }, () => c.createDeviceIdentity()));
        const keyring = await c.createKeyring();
        const trustedDevices = { alice: alice.publicKey, bob: bob.publicKey };
        const source = { roomId: 'room', deviceId: 'alice', identity: alice, keyring, trustedDevices, revokedDevices: ['removed'] };
        const recipient = { ...source, deviceId: 'bob', identity: bob };
        const recipients = Object.entries({ ...trustedDevices, newcomer: newcomer.publicKey }).map(([deviceId, publicKey]) => ({ deviceId, publicKey }));
        const rotation = await c.createKeyRotation(source, recipients);
        const grant = { rotationId: rotation.rotationId, ...rotation.grants.find(item => item.deviceId === 'bob') };
        const next = await c.acceptKeyRotation(recipient, grant);
        const concurrent = { ...source };
        const newerKeyring = await c.createKeyring();
        const preparing = c.createKeyRotation(concurrent, recipients);
        concurrent.keyring = newerKeyring;
        const captured = await preparing;
        const capturedNext = await c.acceptKeyRotation(recipient, { rotationId: captured.rotationId, ...captured.grants.find(item => item.deviceId === 'bob') });
        const rejected = async (operation) => { try { await operation(); return false; } catch { return true; } };
        const forged = async (payload, issuer = { deviceId: 'alice', identity: alice }, previousKeyId = keyring.currentKeyId) => {
            const rotationId = crypto.randomUUID();
            const context = `room:${rotationId}:bob:${issuer.deviceId}:${previousKeyId}`;
            const inner = await c.wrapKeyring(issuer.identity, bob.publicKey, context, payload);
            const envelope = await c.encryptPayload(keyring, 'room', `rotation:${rotationId}:bob`, {
                issuerDeviceId: issuer.deviceId, senderPublicKey: issuer.identity.publicKey, previousKeyId, inner
            });
            return c.acceptKeyRotation(recipient, { rotationId, envelope });
        };
        const oldEpochReuse = { ...next.keyring, keys: { ...next.keyring.keys, [next.keyring.currentKeyId]: keyring.keys[keyring.currentKeyId] } };
        return {
            admission: next.trustedDevices.newcomer === newcomer.publicKey,
            epochSnapshot: captured.previousKeyId === keyring.currentKeyId && capturedNext.keyring.keys[keyring.currentKeyId] === keyring.keys[keyring.currentKeyId]
                && !Object.hasOwn(capturedNext.keyring.keys, newerKeyring.currentKeyId),
            preservedKey: next.keyring.keys[keyring.currentKeyId] === keyring.keys[keyring.currentKeyId],
            unknownIssuer: await rejected(() => forged(next, { deviceId: 'untrusted', identity: removed })),
            changedPin: await rejected(() => forged({ ...next, trustedDevices: { ...next.trustedDevices, alice: removed.publicKey } })),
            recipientRemoved: await rejected(() => forged({ ...next, trustedDevices: { alice: alice.publicKey }, revokedDevices: ['removed', 'bob'] })),
            revokedReentry: await rejected(() => forged({ ...next, trustedDevices: { ...next.trustedDevices, removed: removed.publicKey } })),
            lostRevocation: await rejected(() => forged({ ...next, revokedDevices: [] })),
            discardedHistory: await rejected(() => forged({ ...next, keyring: { ...next.keyring, keys: { [next.keyring.currentKeyId]: next.keyring.keys[next.keyring.currentKeyId] } } })),
            reusedSecret: await rejected(() => forged({ ...next, keyring: oldEpochReuse })),
            replay: await rejected(() => c.acceptKeyRotation({ ...recipient, ...next }, grant)),
            missingIssuer: await rejected(() => c.createKeyRotation(source, recipients.filter(device => device.deviceId !== 'alice'))),
            replacedRecipient: await rejected(() => c.createKeyRotation(source, recipients.map(device => device.deviceId === 'bob' ? { ...device, publicKey: removed.publicKey } : device))),
            reinvitedRevoked: await rejected(() => c.createKeyRotation(source, [...recipients, { deviceId: 'removed', publicKey: removed.publicKey }]))
        };
    });
    for (const [name, accepted] of Object.entries(result)) expect(accepted, name).toBe(true);
});

test('atomically pairs a new device with a new epoch and retries the same encrypted acceptance', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const c = await import('/__sync-crypto-test__/module.js');
        const { EncryptedPairing } = await import('/__sync-crypto-test__/pairing.js');
        const identity = await c.createDeviceIdentity();
        const keyring = await c.createKeyring();
        const session = { roomId: crypto.randomUUID(), deviceId: crypto.randomUUID(), identity, keyring, trustedDevices: {}, revokedDevices: [] };
        session.trustedDevices[session.deviceId] = identity.publicKey;
        const oldKeyId = keyring.currentKeyId;
        const acceptedBodies = [];
        const acceptanceEpochs = [];
        let challenge;
        let offerEpoch;
        let callbackCount = 0;
        const pairing = new EncryptedPairing({ getSession: () => session, onExpired: () => {}, onAccepted: async () => {
            callbackCount++;
            const body = acceptedBodies.at(-1);
            Object.assign(session, await c.acceptKeyRotation(session, { rotationId: body.rotationId, ...body.grants.find(grant => grant.deviceId === session.deviceId) }));
        }, api: async (path, options) => {
            const body = JSON.parse(options.body);
            if (path.endsWith('/pair-code')) { offerEpoch = options.headers['X-Sync-Key-Id']; return { ...body, ownerDeviceId: session.deviceId, expiresAt: Date.now() + 600000 }; }
            if (path.endsWith('/pair-challenge')) { challenge = body; return { accepted: true }; }
            if (path.endsWith('/pair-accept')) {
                acceptedBodies.push(body);
                acceptanceEpochs.push(options.headers['X-Sync-Key-Id']);
                if (acceptedBodies.length === 1) throw new Error('temporary network failure');
                return { accepted: true };
            }
            throw new Error('unexpected request');
        } });
        await pairing.createOffer();
        const offerId = pairing.offer.offerId;
        const requestId = crypto.randomUUID();
        const client = await c.startPairingClient(pairing.offer.code, offerId);
        await pairing.handle({ type: 'pair-request', offerId, requestId, startLoginRequest: client.startLoginRequest });
        const matched = await c.finishPairingClient(client.clientState, offerId, requestId, challenge.loginResponse);
        const clientIdentity = await c.createDeviceIdentity();
        const clientData = await c.encryptPairing(matched.sessionKey, offerId, requestId, { nonce: 'client-nonce', publicKey: clientIdentity.publicKey });
        const finish = { type: 'pair-finish', offerId, requestId, finishLoginRequest: matched.finishLoginRequest, clientData };
        try { await pairing.handle(finish); } catch {}
        const unchangedAfterFailure = Object.keys(session.trustedDevices).length === 1 && session.keyring.currentKeyId === oldKeyId;
        await pairing.handle(finish);
        const body = acceptedBodies.at(-1);
        const joined = await c.decryptPairing(matched.sessionKey, offerId, requestId, body.grant);
        const profile = await c.decryptPayload(joined.keyring, session.roomId, `device:${body.deviceId}`, body.name);
        return {
            unchangedAfterFailure,
            capturedRequestEpochs: offerEpoch === oldKeyId && acceptanceEpochs.every(keyId => keyId === oldKeyId),
            idempotentRetry: JSON.stringify(acceptedBodies[0]) === JSON.stringify(acceptedBodies[1]),
            callbackCount,
            rotated: session.keyring.currentKeyId !== oldKeyId && joined.keyring.currentKeyId === session.keyring.currentKeyId && body.newKeyId === session.keyring.currentKeyId,
            sameRoster: JSON.stringify(session.trustedDevices) === JSON.stringify(joined.trustedDevices),
            authenticatedNewIdentity: profile.publicKey === clientIdentity.publicKey && session.trustedDevices[body.deviceId] === clientIdentity.publicKey,
            existingGrantsOnly: body.grants.length === 1 && body.grants[0].deviceId === session.deviceId,
            hidesKeys: !JSON.stringify(body).includes(joined.keyring.keys[joined.keyring.currentKeyId])
        };
    });
    expect(result.callbackCount).toBe(1);
    for (const [name, accepted] of Object.entries(result).filter(([name]) => name !== 'callbackCount')) expect(accepted, name).toBe(true);
});

test('hashes complete file content including bytes outside the former fingerprint samples', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const first = new Uint8Array(1024 * 1024);
        const second = first.slice();
        second[130000] = 1;
        const fingerprint = (bytes) => new Promise((resolve, reject) => {
            const worker = new Worker('/__sync-crypto-test__/fingerprint-worker.js', { type: 'module' });
            worker.onmessage = ({ data }) => { if (data.progress !== undefined) return; worker.terminate(); data.error ? reject(new Error(data.error)) : resolve(data.fingerprint); };
            worker.onerror = (event) => { worker.terminate(); reject(new Error(event.message)); };
            worker.postMessage(new File([bytes], 'same-name.bin'));
        });
        const actual = await Promise.all([fingerprint(first), fingerprint(second)]);
        const expected = await Promise.all([first, second].map(async (bytes) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (byte) => byte.toString(16).padStart(2, '0')).join('')));
        return { actual, expected };
    });
    expect(result.actual).toEqual(result.expected);
    expect(result.actual[0]).not.toBe(result.actual[1]);
});

for (const scenario of ['lost-response', 'timeout', 'cancel-before-commit', 'cancel-after-commit', 'cancel-cleanup-fails', 'abandon-unpersisted', 'keep-persisted']) {
    test(`settles a real PAKE join safely after ${scenario}`, async ({ page }) => {
        const result = await page.evaluate(async scenario => {
            const c = await import('/__sync-crypto-test__/module.js');
            const { EncryptedPairing } = await import('/__sync-crypto-test__/pairing.js');
            const offerId = crypto.randomUUID();
            const secret = await c.createPairingSecret('1234', offerId);
            const keyring = await c.createKeyring();
            const roomId = crypto.randomUUID();
            const deviceId = crypto.randomUUID();
            let pending;
            let host;
            let grant;
            let committed = false;
            let settles = 0;
            let removed = 0;
            let acknowledgements = 0;
            let removedWithNewToken = false;
            const nativeTimeout = AbortSignal.timeout;
            if (scenario === 'timeout') AbortSignal.timeout = delay => nativeTimeout.call(AbortSignal, delay === 30000 ? 1200 : delay);
            const pairing = new EncryptedPairing({ getSession: () => null, api: async (path, options = {}, session) => {
                if (path === '/v1/pair/offers') return { offers: [{ offerId, expiresAt: Date.now() + 600000 }] };
                if (path === '/v1/pair') {
                    pending = JSON.parse(options.body);
                    host = await c.startPairingHost(secret, offerId, pending.requestId, pending.requests[0].startLoginRequest);
                    return {};
                }
                if (path.endsWith('/ack')) { acknowledgements++; return { ok: true }; }
                if (path.endsWith('/device')) {
                    removed++;
                    removedWithNewToken = session?.token === 'a'.repeat(64) && session?.deviceId === deviceId;
                    if (scenario === 'cancel-cleanup-fails' || removed === 1) throw Object.assign(new Error('unavailable'), { status: 502 });
                    return { ok: true };
                }
                if (options.method === 'DELETE') {
                    settles++;
                    if (settles === 1 && scenario === 'lost-response') throw Object.assign(new Error('unavailable'), { status: 502 });
                    return committed ? { ok: true, cancelled: false, offerId, grant } : { ok: true, cancelled: true };
                }
                if (options.method === 'POST') {
                    const body = JSON.parse(options.body);
                    const key = await c.finishPairingHost(host.serverState, body.finishLoginRequest);
                    const client = await c.decryptPairing(key, offerId, pending.requestId, body.clientData);
                    grant = await c.encryptPairing(key, offerId, pending.requestId, {
                        roomId, deviceId, keyring, token: 'a'.repeat(64), trustedDevices: { [deviceId]: client.publicKey }, revokedDevices: [], nonce: client.nonce
                    });
                    committed = scenario !== 'cancel-before-commit';
                    if (scenario.startsWith('cancel-')) {
                        pairing.reset();
                        throw new DOMException('Cancelled', 'AbortError');
                    }
                    return {};
                }
                if (!grant) return { responses: [{ offerId, loginResponse: host.loginResponse }] };
                if (scenario === 'timeout') return new Promise((resolve, reject) => {
                    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
                });
                if (scenario === 'abandon-unpersisted' || scenario === 'keep-persisted') return { grant };
                throw new TypeError('Final grant response lost');
            } });
            let joined;
            let error;
            try { joined = await pairing.join('1234'); }
            catch (failure) { error = failure.name; }
            finally { AbortSignal.timeout = nativeTimeout; }
            const acksBeforePersistence = acknowledgements;
            if (scenario === 'abandon-unpersisted') await pairing.abandonJoin(joined);
            else if (joined) {
                await pairing.acknowledgeJoin(joined);
                if (scenario === 'keep-persisted') await pairing.abandonJoin(joined);
            }
            return { joined: joined?.roomId === roomId, error, settles, removed, removedWithNewToken, acknowledgements, acksBeforePersistence };
        }, scenario);
        if (scenario === 'lost-response' || scenario === 'timeout' || scenario === 'keep-persisted') {
            expect(result.joined).toBe(true);
            expect(result.removed).toBe(0);
            expect(result.acksBeforePersistence).toBe(0);
            expect(result.acknowledgements).toBe(1);
        } else if (scenario === 'abandon-unpersisted') {
            expect(result.joined).toBe(true);
            expect(result.removed).toBe(2);
            expect(result.removedWithNewToken).toBe(true);
            expect(result.acksBeforePersistence).toBe(0);
            expect(result.acknowledgements).toBe(1);
        } else {
            expect(result.joined).toBe(false);
            expect(result.error).toBe('AbortError');
            if (scenario === 'cancel-before-commit') {
                expect(result.removed).toBe(0);
                expect(result.acknowledgements).toBe(0);
            } else {
                expect(result.removedWithNewToken).toBe(true);
                expect(result.removed).toBe(scenario === 'cancel-cleanup-fails' ? 3 : 2);
                expect(result.acknowledgements).toBe(scenario === 'cancel-cleanup-fails' ? 0 : 1);
            }
        }
        expect(result.settles).toBe(scenario === 'lost-response' ? 2 : ['keep-persisted', 'abandon-unpersisted'].includes(scenario) ? 0 : 1);
    });
}


test('encrypts independent media blocks into resumable transport chunks and preserves old-format uploads', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const c = await import('/__sync-crypto-test__/module.js');
        const outcomes = [];
        for (const version of [1, 2]) {
            const metadata = c.createFileMetadata({ name: 'resume.mp4', type: 'video/mp4', size: 1 });
            if (version === 1) delete metadata.version;
            const { cipherSize, plainSize, uploadPlainSize } = c.fileChunkLayout(metadata);
            const remaining = version === 2 ? plainSize + 31 : 31;
            metadata.size = uploadPlainSize + remaining;
            const first = await c.encryptUploadChunk(metadata, 0, new Uint8Array(uploadPlainSize).fill(7));
            const final = await c.encryptUploadChunk(metadata, 1, new Uint8Array(remaining).fill(11));
            const resumed = await c.encryptUploadChunk(metadata, 1, new Uint8Array(remaining).fill(11));
            const firstBlock = await c.decryptFileChunk(metadata, 0, first.slice(0, cipherSize));
            const tailIndex = c.FILE_CIPHER_CHUNK_SIZE / cipherSize;
            const tailBlock = await c.decryptFileChunk(metadata, tailIndex, final.slice(0, cipherSize));
            const lastBlock = version === 2 ? await c.decryptFileChunk(metadata, tailIndex + 1, final.slice(cipherSize)) : tailBlock;
            outcomes.push({ version, firstSize: first.byteLength, finalSize: final.byteLength,
                first: new Uint8Array(firstBlock).every(value => value === 7),
                tail: new Uint8Array(tailBlock).every(value => value === 11),
                last: Array.from(new Uint8Array(lastBlock)),
                resumed: final.every((value, index) => value === resumed[index]) });
        }
        return outcomes;
    });
    for (const item of result) {
        expect(item.firstSize).toBe(8 * 1024 * 1024);
        expect(item.finalSize).toBe((item.version === 2 ? 512 * 1024 : 0) + 47);
        expect(item.first && item.tail && item.resumed).toBe(true);
        expect(item.last).toEqual(Array(31).fill(11));
    }
});


test('generates bounded thumbnails inside authenticated encrypted payloads and respects cancellation', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const { createImageThumbnail, validThumbnail } = await import('/__sync-crypto-test__/sync-image-thumbnail.js');
        const c = await import('/__sync-crypto-test__/module.js');
        const canvas = document.createElement('canvas');
        canvas.width = 2400; canvas.height = 1600;
        const context = canvas.getContext('2d');
        context.fillStyle = 'red'; context.fillRect(0, 0, 2400, 1600);
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        const file = new File([blob], 'photo.png', { type: 'image/png' });
        const signal = new AbortController().signal;
        const thumbnail = await createImageThumbnail(file, signal);
        const keyring = await c.createKeyring();
        const encrypted = await c.encryptPayload(keyring, 'room', 'message:device:client', { attachment: { thumbnail } });
        const decrypted = await c.decryptPayload(keyring, 'room', 'message:device:client', encrypted);
        const cancelled = new AbortController(); cancelled.abort();
        let aborted = false;
        try { await createImageThumbnail(file, cancelled.signal); } catch (error) { aborted = error.name === 'AbortError'; }
        const gif = Uint8Array.from(atob('R0lGODlhAQABAIAAAP8AAAAA/yH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACwAAAAAAQABAAACAkQBACH5BAAKAAAALAAAAAABAAEAAAICTAEAOw=='), byte => byte.charCodeAt(0));
        const animation = await createImageThumbnail(new File([gif], 'reaction.gif', { type: 'image/gif' }), signal);
        return { valid: await validThumbnail(thumbnail), width: thumbnail.width, height: thumbnail.height,
            bytes: atob(thumbnail.data.split(',')[1]).length, matches: decrypted.attachment.thumbnail.data === thumbnail.data,
            hidden: !encrypted.includes(thumbnail.data), aborted, animated: animation.animated,
            rejectsSVG: await validThumbnail({ ...thumbnail, data: 'data:image/svg+xml;base64,PHN2Zz4=' }),
            rejectsForgedSize: await validThumbnail({ ...thumbnail, width: 1, height: 1 }) };
    });
    expect(result.valid).toBe(true);
    expect(result.width).toBeLessThanOrEqual(260);
    expect(result.height).toBeLessThanOrEqual(200);
    expect(result.bytes).toBeLessThanOrEqual(4096);
    expect(result).toMatchObject({ matches: true, hidden: true, aborted: true, animated: true, rejectsSVG: false, rejectsForgedSize: false });
});

test('skips slow thumbnails after the budget and terminates decoding on cancellation', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const { createImageThumbnail } = await import('/__sync-crypto-test__/sync-image-thumbnail.js');
        const workers = [];
        window.Worker = class {
            constructor() { workers.push(this); }
            postMessage() {}
            terminate() { this.terminated = true; }
        };
        const file = new File(['image'], 'slow.heic', { type: 'image/heic' });
        const start = performance.now();
        const value = await createImageThumbnail(file, new AbortController().signal);
        const elapsed = performance.now() - start;
        const cancelled = new AbortController();
        const pending = createImageThumbnail(file, cancelled.signal);
        cancelled.abort();
        let aborted = false;
        try { await pending; } catch (error) { aborted = error.name === 'AbortError'; }
        return { value, elapsed, aborted, stopped: workers.every(worker => worker.terminated) };
    });
    expect(result).toMatchObject({ value: null, aborted: true, stopped: true });
    expect(result.elapsed).toBeGreaterThanOrEqual(1900);
    expect(result.elapsed).toBeLessThan(3500);
});

test('bounds the intermediate bitmap for long screenshots before drawing the thumbnail', async ({ page, context }) => {
    await context.route('**/__sync-crypto-test__/sync-thumbnail-worker.js', async route => {
        const source = await readFile(path.join(__dirname, '../static/portfolio/js/apps/sync-thumbnail-worker.js'), 'utf8');
        const probe = `const originalBitmap = globalThis.createImageBitmap;
            const originalPost = self.postMessage.bind(self);
            let decoded;
            globalThis.createImageBitmap = async (...args) => { const bitmap = await originalBitmap(...args); decoded = { width: bitmap.width, height: bitmap.height }; return bitmap; };
            self.postMessage = thumbnail => originalPost({ thumbnail, decoded });\n`;
        await route.fulfill({ contentType: 'text/javascript', body: probe + source });
    });
    const result = await page.evaluate(async () => {
        const canvas = new OffscreenCanvas(600, 12000);
        canvas.getContext('2d').fillRect(0, 0, canvas.width, canvas.height);
        const blob = await canvas.convertToBlob({ type: 'image/png' });
        canvas.width = 0; canvas.height = 0;
        const worker = new Worker('/__sync-crypto-test__/sync-thumbnail-worker.js', { type: 'module' });
        return new Promise((resolve, reject) => {
            worker.onmessage = ({ data }) => { worker.terminate(); resolve(data); };
            worker.onerror = event => { worker.terminate(); reject(new Error(event.message)); };
            worker.postMessage(new File([blob], 'long.png', { type: 'image/png' }));
        });
    });
    expect(result.decoded).toEqual({ width: 10, height: 200 });
    expect(result.thumbnail).toMatchObject({ width: 10, height: 200 });
});
