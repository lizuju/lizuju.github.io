import {
    createPairingSecret, startPairingClient, startPairingHost, finishPairingClient, finishPairingHost,
    encryptPairing, decryptPairing, encryptPayload, decryptPayload, createDeviceIdentity, createKeyRotation,
    savePairingRecovery, loadPairingRecovery, deletePairingRecovery
} from './sync-crypto.js';

const failure = (code) => Object.assign(new Error(code), { code });
const randomToken = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('');
const RECOVERY_KEY = 'gavin-sync-pair-recovery';
const CANCEL_KEY = 'gavin-sync-pair-cancelled';
const pause = (signal, delay = 500) => new Promise((resolve, reject) => {
    const timer = setTimeout(done, delay);
    function done() { signal.removeEventListener('abort', abort); resolve(); }
    function abort() { clearTimeout(timer); reject(signal.reason); }
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
});

async function retryCleanup(api, path, options, session, signal) {
    for (let attempt = 0; ; attempt++) {
        signal.throwIfAborted();
        try { return await api(path, { ...options, signal }, session); }
        catch (error) {
            if (signal.aborted || attempt === 2 || !(error instanceof TypeError || error.name === 'TimeoutError'
                || error.status === 429 || error.status >= 500 && error.status <= 599)) throw error;
            await pause(signal, Math.max(250 * 2 ** attempt, (error.retryAfter || 0) * 1000));
        }
    }
}

async function useAttempts(id, requestId, limit = 20) {
    if (!navigator.locks) throw failure('encryption_unavailable');
    return navigator.locks.request(`gavin-sync-pair:${id}`, () => {
        const key = `gavin-sync-pair-attempts:${id}`;
        let saved = JSON.parse(localStorage.getItem(key) || 'null');
        if (!saved || saved.expiresAt <= Date.now()) saved = { ids: [], expiresAt: Date.now() + 10 * 60 * 1000 };
        // Older join counters stored a separate request:offer entry for every candidate.
        saved.ids = [...new Set(saved.ids.map(request => request.split(':')[0]))];
        if (saved.ids.includes(requestId)) return false;
        if (saved.ids.length >= limit) throw Object.assign(failure('pairing_limited'), {
            retryAfter: Math.max(1, Math.ceil((saved.expiresAt - Date.now()) / 1000))
        });
        saved.ids.push(requestId);
        localStorage.setItem(key, JSON.stringify(saved));
        return true;
    });
}

export class EncryptedPairing {
    constructor({ api, getSession, getSavedSession = () => null, onExpired, onAccepted }) {
        this.api = api;
        this.getSession = getSession;
        this.getSavedSession = getSavedSession;
        this.onExpired = onExpired;
        this.onAccepted = onAccepted;
        this.hosts = new Map();
    }

    reset() {
        this.offer?.controller.abort();
        this.offer = null;
        this.hosts.clear();
        if (this.joinController && sessionStorage.getItem(RECOVERY_KEY)) sessionStorage.setItem(CANCEL_KEY, sessionStorage.getItem(RECOVERY_KEY));
        this.joinController?.abort();
    }

    async readOffer(pairing, session = this.getSession()) {
        if (!pairing || !session) { this.offer?.controller.abort(); this.offer = null; this.hosts.clear(); return null; }
        const keyId = session.keyring.currentKeyId;
        if (this.offer && this.offer.keyId !== keyId) this.reset();
        if (this.offer?.offerId === pairing.offerId && this.offer.wireSecret === pairing.secret
            && this.offer.ownerDeviceId === pairing.ownerDeviceId && this.offer.expiresAt > Date.now()) return this.offer;
        const keyring = { keys: { [keyId]: session.keyring.keys[keyId] } };
        const secret = await decryptPayload(keyring, session.roomId, `offer:${pairing.offerId}`, pairing.secret);
        if (session.keyring.currentKeyId !== keyId) return null;
        if (!/^\d{4}$/.test(secret.code) || secret.ownerDeviceId !== pairing.ownerDeviceId || secret.expiresAt <= Date.now()) { this.offer?.controller.abort(); this.offer = null; this.hosts.clear(); return null; }
        const offer = { ...pairing, controller: new AbortController(), keyId, wireSecret: pairing.secret, expiresAt: Math.min(pairing.expiresAt, secret.expiresAt), secret, code: secret.code };
        if (this.getSession() === session) {
            this.offer?.controller.abort();
            this.hosts.clear();
            this.offer = offer;
        }
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
            let host = this.hosts.get(event.requestId);
            if (!host) {
                try {
                    if (!await useAttempts(`host:${offer.offerId}:${event.sourceId}`, event.requestId)) return;
                } catch (error) {
                    if (error.code === 'pairing_limited') return;
                    throw error;
                }
                try {
                    if (!await useAttempts(`host:${offer.offerId}`, event.requestId, 600)) return;
                } catch (error) {
                    if (error.code === 'pairing_limited') this.onExpired();
                    throw error;
                }
                host = { ...await startPairingHost(offer.secret, offer.offerId, event.requestId, event.startLoginRequest), session, offerId: offer.offerId };
                if (this.getSession() !== session || this.offer !== offer || offer.keyId !== session.keyring.currentKeyId) return;
                this.hosts.set(event.requestId, host);
            }
            if (host.challenged) return;
            if (host.sending) return host.sending;
            host.sending = (async () => {
                const active = () => this.getSession() === session && this.offer === offer && offer.keyId === session.keyring.currentKeyId
                    && offer.expiresAt > Date.now() && this.hosts.get(event.requestId) === host;
                const signal = AbortSignal.any([offer.controller.signal, AbortSignal.timeout(Math.max(1, offer.expiresAt - Date.now()))]);
                for (let attempt = 0; attempt < 3 && active(); attempt++) {
                    try {
                        const result = await this.api(`${path}/pair-challenge`, {
                            method: 'POST', signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
                            body: JSON.stringify({ offerId: offer.offerId, requestId: event.requestId, loginResponse: host.loginResponse })
                        }, session);
                        if (result.accepted) host.challenged = true;
                        else this.hosts.delete(event.requestId);
                        return;
                    } catch (error) {
                        if (!active()) return;
                        if (attempt === 2 || !(error instanceof TypeError || error.name === 'TimeoutError'
                            || error.status === 429 || error.status >= 500 && error.status <= 599)) throw error;
                        try { await pause(signal, Math.max(500 * 2 ** attempt, (error.retryAfter || 0) * 1000)); }
                        catch (aborted) { if (active()) throw aborted; }
                    }
                }
            })().finally(() => { host.sending = null; });
            return host.sending;
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

    async storeRecovery(state) {
        await savePairingRecovery(state.id, state);
    }

    async clearRecovery(state) {
        await deletePairingRecovery(state.id);
        if (sessionStorage.getItem(RECOVERY_KEY) === state.id) sessionStorage.removeItem(RECOVERY_KEY);
        if (sessionStorage.getItem(CANCEL_KEY) === state.id) sessionStorage.removeItem(CANCEL_KEY);
    }

    hasPendingJoin() {
        return Boolean(sessionStorage.getItem(RECOVERY_KEY));
    }

    isSaved(session) {
        const saved = this.getSavedSession();
        return Boolean(session && saved?.roomId === session.roomId && saved?.deviceId === session.deviceId && saved?.token === session.token);
    }

    async acknowledgeJoin(session) {
        const receipt = this.joinResult;
        if (receipt?.session !== session) return;
        this.joinResult = null;
        receipt.state.session = session;
        receipt.state.persisted = true;
        try {
            await this.storeRecovery(receipt.state);
            try { await retryCleanup(this.api, `${receipt.path}/ack`, { method: 'POST', headers: receipt.headers }, null, AbortSignal.timeout(15000)); }
            catch (error) { if (error.status !== 404) throw error; }
            await this.clearRecovery(receipt.state);
        } catch { /* Keep the wrapped receipt for the next page load or reconnect. */ }
    }

    async abandonJoin(session) {
        const receipt = this.joinResult;
        if (receipt?.session !== session) return;
        if (this.isSaved(session)) return this.acknowledgeJoin(session);
        this.joinResult = null;
        sessionStorage.setItem(CANCEL_KEY, receipt.state.id);
        try {
            await this.removeJoinedDevice(session, receipt.path, receipt.headers, AbortSignal.timeout(15000));
            await this.clearRecovery(receipt.state);
        }
        catch { /* Retry the saved cancellation after connectivity returns. */ }
    }

    async removeJoinedDevice(session, path, headers, signal) {
        try { await retryCleanup(this.api, `/v1/spaces/${session.roomId}/device`, { method: 'DELETE' }, session, signal); }
        catch (error) { if (error.status !== 401 && error.status !== 404) throw error; }
        try { await retryCleanup(this.api, `${path}/ack`, { method: 'POST', headers }, null, signal); }
        catch (error) { if (error.status !== 404) throw error; }
    }

    async openJoinGrant(state, grant) {
        const session = await decryptPairing(state.match.sessionKey, state.offerId, state.requestId, grant);
        if (session.nonce !== state.nonce || !session.keyring?.keys?.[session.keyring.currentKeyId] || typeof session.token !== 'string'
            || session.trustedDevices?.[session.deviceId] !== state.identity.publicKey || !Array.isArray(session.revokedDevices)) throw failure('invalid_ciphertext');
        delete session.nonce;
        return { ...session, identity: state.identity, vaultId: crypto.randomUUID() };
    }

    async settleJoin(state, signal, cancelled) {
        const path = `/v1/pair/${state.requestId}`;
        const headers = { Authorization: `Bearer ${state.requestToken}` };
        let result;
        try { result = await retryCleanup(this.api, path, { method: 'DELETE', headers }, null, signal); }
        catch (error) {
            if (error.status !== 404) throw error;
            if (cancelled && state.session && !this.isSaved(state.session)) {
                try { await retryCleanup(this.api, `/v1/spaces/${state.session.roomId}/device`, { method: 'DELETE' }, state.session, signal); }
                catch (removal) { if (removal.status !== 401 && removal.status !== 404) throw removal; }
            }
            await this.clearRecovery(state);
            return null;
        }
        if (!result.grant) {
            await this.clearRecovery(state);
            return null;
        }
        const session = state.session || await this.openJoinGrant(state, result.grant);
        cancelled ||= sessionStorage.getItem(CANCEL_KEY) === state.id;
        if (cancelled && !this.isSaved(session)) {
            await this.removeJoinedDevice(session, path, headers, signal);
            await this.clearRecovery(state);
            return null;
        }
        state.session = session;
        await this.storeRecovery(state);
        this.joinResult = { session, state, path, headers };
        return session;
    }

    async recoverJoin({ cancel = false } = {}) {
        const id = sessionStorage.getItem(RECOVERY_KEY);
        if (!id || this.joinController) return null;
        return navigator.locks.request(`gavin-sync-pair-recovery:${id}`, { ifAvailable: true }, async lock => {
            if (!lock) return null;
            const state = await loadPairingRecovery(id);
            if (!state) { sessionStorage.removeItem(RECOVERY_KEY); return null; }
            if (state.expiresAt <= Date.now()) { await this.clearRecovery(state); return null; }
            if (state.persisted || this.isSaved(state.session)) {
                this.joinResult = { session: state.session, state, path: `/v1/pair/${state.requestId}`, headers: { Authorization: `Bearer ${state.requestToken}` } };
                await this.acknowledgeJoin(state.session);
                return null;
            }
            if (cancel || this.getSavedSession()) sessionStorage.setItem(CANCEL_KEY, id);
            if (sessionStorage.getItem(CANCEL_KEY) === id) {
                await this.settleJoin(state, AbortSignal.timeout(15000), true);
                return null;
            }
            return this.continueJoin(state);
        });
    }

    async join(code) {
        this.joinController?.abort();
        await this.recoverJoin({ cancel: true });
        if (sessionStorage.getItem(RECOVERY_KEY)) throw failure('pairing_timeout');
        const controller = new AbortController();
        this.joinController = controller;
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]);
        try {
            const identity = await createDeviceIdentity();
            const { offers } = await this.api('/v1/pair/offers', { signal }, null);
            if (!Array.isArray(offers) || !offers.length || offers.length > 30 || new Set(offers.map(offer => offer.offerId)).size !== offers.length) throw failure('invalid_code');
            const state = { id: crypto.randomUUID(), requestId: crypto.randomUUID(), requestToken: randomToken(), identity,
                offers, states: {}, requests: [], expiresAt: Date.now() + 20 * 60 * 1000 };
            await useAttempts('join', state.requestId);
            for (const offer of offers) {
                signal.throwIfAborted();
                const result = await startPairingClient(code, offer.offerId, signal);
                state.states[offer.offerId] = result.clientState;
                state.requests.push({ offerId: offer.offerId, startLoginRequest: result.startLoginRequest });
                await pause(signal, 0);
            }
            sessionStorage.setItem(RECOVERY_KEY, state.id);
            await this.storeRecovery(state);
            return await navigator.locks.request(`gavin-sync-pair-recovery:${state.id}`, { signal }, () => this.continueJoin(state, controller, signal));
        } catch (error) {
            if (error.name === 'TimeoutError' && error.code !== 'network_error') throw failure('pairing_timeout');
            throw error;
        } finally {
            if (this.joinController === controller) this.joinController = null;
        }
    }

    async continueJoin(state, controller = new AbortController(), signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30000)])) {
        this.joinController = controller;
        const path = `/v1/pair/${state.requestId}`;
        const headers = { Authorization: `Bearer ${state.requestToken}` };
        const cancelled = () => controller.signal.aborted || sessionStorage.getItem(CANCEL_KEY) === state.id;
        try {
            if (cancelled()) throw new DOMException('Cancelled', 'AbortError');
            if (!state.match) {
                await this.api('/v1/pair', { method: 'POST', signal, body: JSON.stringify({ requestId: state.requestId, requestToken: state.requestToken, requests: state.requests }) }, null);
                const tried = new Set();
                const matches = new Map();
                const deadline = Date.now() + 12000;
                while (Date.now() < deadline && tried.size < state.offers.length) {
                    signal.throwIfAborted();
                    const result = await this.api(path, { signal, headers }, null);
                    for (const response of result.responses) {
                        if (!state.states[response.offerId] || tried.has(response.offerId)) continue;
                        signal.throwIfAborted();
                        tried.add(response.offerId);
                        try { matches.set(response.offerId, await finishPairingClient(state.states[response.offerId], response.offerId, state.requestId, response.loginResponse, signal)); }
                        catch (error) { if (error.code !== 'invalid_code') throw error; }
                        if (matches.size > 1) throw failure('pairing_ambiguous');
                        await pause(signal, 0);
                    }
                    if (tried.size < state.offers.length) await pause(signal);
                }
                if (tried.size !== state.offers.length) throw failure('pairing_timeout');
                if (matches.size !== 1) throw failure('invalid_code');
                [state.offerId, state.match] = [...matches][0];
                state.nonce = randomToken();
                state.clientData = await encryptPairing(state.match.sessionKey, state.offerId, state.requestId, { nonce: state.nonce, publicKey: state.identity.publicKey });
                delete state.states;
                await this.storeRecovery(state);
                await this.api(path, { method: 'POST', signal, headers, body: JSON.stringify({ offerId: state.offerId, finishLoginRequest: state.match.finishLoginRequest, clientData: state.clientData }) }, null);
            } else if (!state.session) {
                const result = await this.api(path, { signal, headers }, null);
                if (result.grant) state.session = await this.openJoinGrant(state, result.grant);
                else await this.api(path, { method: 'POST', signal, headers, body: JSON.stringify({ offerId: state.offerId, finishLoginRequest: state.match.finishLoginRequest, clientData: state.clientData }) }, null);
            }
            while (!state.session) {
                signal.throwIfAborted();
                const result = await this.api(path, { signal, headers }, null);
                if (result.grant) state.session = await this.openJoinGrant(state, result.grant);
                else await pause(signal);
            }
            await this.storeRecovery(state);
            if (cancelled()) throw new DOMException('Cancelled', 'AbortError');
            this.joinResult = { session: state.session, state, path, headers };
            return state.session;
        } catch (error) {
            try {
                const session = await this.settleJoin(state, AbortSignal.timeout(15000), cancelled());
                if (session) {
                    if (!cancelled()) return session;
                    await this.abandonJoin(session);
                }
            } catch { /* The encrypted request remains recoverable while offline. */ }
            if (cancelled()) throw new DOMException('Cancelled', 'AbortError');
            if (error.name === 'TimeoutError' && error.code !== 'network_error') throw failure('pairing_timeout');
            throw error;
        } finally {
            if (this.joinController === controller) this.joinController = null;
        }
    }
}
