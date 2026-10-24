import {
    createPairingSecret, startPairingClient, startPairingHost, finishPairingClient, finishPairingHost,
    encryptPairing, decryptPairing, encryptPayload, decryptPayload, createDeviceIdentity, createKeyRotation
} from './sync-crypto.js';

const failure = (code) => Object.assign(new Error(code), { code });
const randomToken = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('');
const pause = (signal, delay = 500) => new Promise((resolve, reject) => {
    const timer = setTimeout(done, delay);
    function done() { signal.removeEventListener('abort', abort); resolve(); }
    function abort() { clearTimeout(timer); reject(signal.reason); }
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
});

async function useAttempts(id, requestId) {
    if (!navigator.locks) throw failure('encryption_unavailable');
    return navigator.locks.request(`gavin-sync-pair:${id}`, () => {
        const key = `gavin-sync-pair-attempts:${id}`;
        let saved = JSON.parse(localStorage.getItem(key) || 'null');
        if (!saved || saved.expiresAt <= Date.now()) saved = { ids: [], expiresAt: Date.now() + 10 * 60 * 1000 };
        // Older join counters stored a separate request:offer entry for every candidate.
        saved.ids = [...new Set(saved.ids.map(request => request.split(':')[0]))];
        if (saved.ids.includes(requestId)) return false;
        if (saved.ids.length >= 20) throw Object.assign(failure('pairing_limited'), {
            retryAfter: Math.max(1, Math.ceil((saved.expiresAt - Date.now()) / 1000))
        });
        saved.ids.push(requestId);
        localStorage.setItem(key, JSON.stringify(saved));
        return true;
    });
}

export class EncryptedPairing {
    constructor({ api, getSession, onExpired, onAccepted }) {
        this.api = api;
        this.getSession = getSession;
        this.onExpired = onExpired;
        this.onAccepted = onAccepted;
        this.hosts = new Map();
    }

    reset() {
        this.offer = null;
        this.hosts.clear();
        this.joinController?.abort();
    }

    async readOffer(pairing, session = this.getSession()) {
        if (!pairing || !session) { this.offer = null; return null; }
        const keyId = session.keyring.currentKeyId;
        if (this.offer && this.offer.keyId !== keyId) this.reset();
        if (this.offer?.offerId === pairing.offerId && this.offer.wireSecret === pairing.secret
            && this.offer.ownerDeviceId === pairing.ownerDeviceId && this.offer.expiresAt > Date.now()) return this.offer;
        const keyring = { keys: { [keyId]: session.keyring.keys[keyId] } };
        const secret = await decryptPayload(keyring, session.roomId, `offer:${pairing.offerId}`, pairing.secret);
        if (session.keyring.currentKeyId !== keyId) return null;
        if (!/^\d{4}$/.test(secret.code) || secret.ownerDeviceId !== pairing.ownerDeviceId || secret.expiresAt <= Date.now()) { this.offer = null; return null; }
        const offer = { ...pairing, keyId, wireSecret: pairing.secret, expiresAt: Math.min(pairing.expiresAt, secret.expiresAt), secret, code: secret.code };
        if (this.getSession() === session) this.offer = offer;
        return offer;
    }

    async createOffer() {
        const session = this.getSession();
        const keyring = session.keyring;
        const offerId = crypto.randomUUID();
        let random;
        do { random = crypto.getRandomValues(new Uint16Array(1))[0]; } while (random >= 60000);
        const secret = { ...await createPairingSecret(String(random % 10000).padStart(4, '0'), offerId), ownerDeviceId: session.deviceId };
        const encrypted = await encryptPayload(keyring, session.roomId, `offer:${offerId}`, secret);
        const result = await this.api(`/v1/spaces/${session.roomId}/pair-code`, {
            method: 'POST', headers: { 'X-Sync-Key-Id': keyring.currentKeyId }, body: JSON.stringify({ offerId, secret: encrypted })
        }, session);
        await this.readOffer(result, session);
        return result;
    }

    async handle(event) {
        const session = this.getSession();
        const offer = this.offer;
        if (!session || !offer || offer.keyId !== session.keyring.currentKeyId || offer.ownerDeviceId !== session.deviceId || event.offerId !== offer.offerId || offer.expiresAt <= Date.now()) return;
        const path = `/v1/spaces/${session.roomId}`;
        if (event.type === 'pair-request') {
            if (this.hosts.has(event.requestId)) return;
            try {
                if (!await useAttempts(`host:${offer.offerId}`, event.requestId)) return;
            } catch (error) {
                if (error.code === 'pairing_limited') this.onExpired();
                throw error;
            }
            const host = await startPairingHost(offer.secret, offer.offerId, event.requestId, event.startLoginRequest);
            if (this.getSession() !== session || this.offer !== offer || offer.keyId !== session.keyring.currentKeyId) return;
            this.hosts.set(event.requestId, { ...host, session, offerId: offer.offerId });
            const result = await this.api(`${path}/pair-challenge`, {
                method: 'POST', body: JSON.stringify({ offerId: offer.offerId, requestId: event.requestId, loginResponse: host.loginResponse })
            }, session);
            if (!result.accepted) this.hosts.delete(event.requestId);
        } else if (event.type === 'pair-finish') {
            const host = this.hosts.get(event.requestId);
            if (!host || host.session !== session) return;
            if (host.processing) return host.processing;
            host.processing = (async () => {
                if (!host.acceptance) {
                    const sessionKey = await finishPairingHost(host.serverState, event.finishLoginRequest);
                    const client = await decryptPairing(sessionKey, offer.offerId, event.requestId, event.clientData);
                    if (this.getSession() !== session || this.offer !== offer || offer.keyId !== session.keyring.currentKeyId) return;
                    if (typeof client.nonce !== 'string' || typeof client.publicKey !== 'string') throw failure('invalid_ciphertext');
                    const deviceId = crypto.randomUUID();
                    const token = randomToken();
                    const recipients = Object.entries(session.trustedDevices).map(([id, publicKey]) => ({ deviceId: id, publicKey }));
                    recipients.push({ deviceId, publicKey: client.publicKey });
                    const rotation = await createKeyRotation(session, recipients);
                    if (rotation.previousKeyId !== offer.keyId || session.keyring.currentKeyId !== offer.keyId) return;
                    const name = await encryptPayload(rotation.next.keyring, session.roomId, `device:${deviceId}`, { name: '', publicKey: client.publicKey });
                    const grant = await encryptPairing(sessionKey, offer.offerId, event.requestId, {
                        roomId: session.roomId, deviceId, token, ...rotation.next, nonce: client.nonce
                    });
                    host.acceptance = { offerId: offer.offerId, requestId: event.requestId, deviceId, token, name, grant,
                        rotationId: rotation.rotationId, newKeyId: rotation.newKeyId, grants: rotation.grants.filter(item => item.deviceId !== deviceId) };
                    host.previousKeyId = rotation.previousKeyId;
                }
                if (!host.acceptance || this.getSession() !== session || this.offer !== offer || offer.keyId !== session.keyring.currentKeyId || host.previousKeyId !== offer.keyId) return;
                await this.api(`${path}/pair-accept`, {
                    method: 'POST', headers: { 'X-Sync-Key-Id': host.previousKeyId }, body: JSON.stringify(host.acceptance)
                }, session);
                this.hosts.delete(event.requestId);
                await this.onAccepted(session);
            })().finally(() => { host.processing = null; });
            return host.processing;
        }
    }

    async resume() {
        const session = this.getSession();
        if (!session || this.offer?.ownerDeviceId !== session.deviceId) return;
        const result = await this.api(`/v1/spaces/${session.roomId}/pair-requests`, {}, session);
        for (const event of result.requests) {
            if (this.getSession() !== session) return;
            await this.handle(event);
        }
    }

    async join(code) {
        this.joinController?.abort();
        const controller = new AbortController();
        this.joinController = controller;
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]);
        const identity = await createDeviceIdentity();
        const { offers } = await this.api('/v1/pair/offers', { signal }, null);
        if (!Array.isArray(offers) || !offers.length || offers.length > 30 || new Set(offers.map(offer => offer.offerId)).size !== offers.length) throw failure('invalid_code');
        const requestId = crypto.randomUUID();
        const requestToken = randomToken();
        await useAttempts('join', requestId);
        const states = new Map();
        const requests = [];
        for (const offer of offers) {
            signal.throwIfAborted();
            const result = await startPairingClient(code, offer.offerId);
            states.set(offer.offerId, result.clientState);
            requests.push({ offerId: offer.offerId, startLoginRequest: result.startLoginRequest });
            await pause(signal, 0);
        }
        const path = `/v1/pair/${requestId}`;
        const headers = { Authorization: `Bearer ${requestToken}` };
        await this.api('/v1/pair', { method: 'POST', signal, body: JSON.stringify({ requestId, requestToken, requests }) }, null);
        const tried = new Set();
        const matches = new Map();
        const deadline = Date.now() + 12000;
        try {
            while (Date.now() < deadline && tried.size < offers.length) {
                signal.throwIfAborted();
                const result = await this.api(path, { signal, headers }, null);
                for (const response of result.responses) {
                    if (!states.has(response.offerId) || tried.has(response.offerId)) continue;
                    signal.throwIfAborted();
                    tried.add(response.offerId);
                    try { matches.set(response.offerId, await finishPairingClient(states.get(response.offerId), response.offerId, requestId, response.loginResponse)); }
                    catch (error) { if (error.code !== 'invalid_code') throw error; }
                    if (matches.size > 1) throw failure('pairing_ambiguous');
                    await pause(signal, 0);
                }
                if (tried.size < offers.length) await pause(signal);
            }
            if (matches.size !== 1) throw failure('invalid_code');
            const [offerId, match] = [...matches][0];
            const nonce = randomToken();
            const clientData = await encryptPairing(match.sessionKey, offerId, requestId, { nonce, publicKey: identity.publicKey });
            await this.api(path, {
                method: 'POST', signal, headers, body: JSON.stringify({ offerId, finishLoginRequest: match.finishLoginRequest, clientData })
            }, null);
            while (true) {
                signal.throwIfAborted();
                const result = await this.api(path, { signal, headers }, null);
                if (result.grant) {
                    const session = await decryptPairing(match.sessionKey, offerId, requestId, result.grant);
                    if (session.nonce !== nonce || !session.keyring?.keys?.[session.keyring.currentKeyId] || typeof session.token !== 'string'
                        || session.trustedDevices?.[session.deviceId] !== identity.publicKey || !Array.isArray(session.revokedDevices)) throw failure('invalid_ciphertext');
                    delete session.nonce;
                    return { ...session, identity };
                }
                await pause(signal);
            }
        } finally {
            this.api(path, { method: 'DELETE', headers }, null).catch(() => {});
            if (this.joinController === controller) this.joinController = null;
        }
    }
}
