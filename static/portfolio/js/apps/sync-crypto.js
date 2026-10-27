export const FILE_CIPHER_CHUNK_SIZE = 8 * 1024 * 1024;
export function fileChunkLayout(metadata) {
    if (metadata.version !== undefined && metadata.version !== 1 && metadata.version !== 2) throw failure('invalid_file');
    const cipherSize = metadata.version === 2 ? 512 * 1024 : FILE_CIPHER_CHUNK_SIZE;
    const plainSize = cipherSize - 16;
    return { cipherSize, plainSize, uploadPlainSize: FILE_CIPHER_CHUNK_SIZE / cipherSize * plainSize };
}
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
let opaqueModule;
const loadOpaque = (signal) => {
    signal?.throwIfAborted();
    opaqueModule ||= import(/* webpackChunkName: "sync-pake" */ '@serenity-kit/opaque')
        .then(async (module) => { await module.ready; return module; })
        .catch(() => { opaqueModule = null; throw failure('encryption_load_failed'); });
    return new Promise((resolve, reject) => {
        const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
        const abort = () => { finish(); reject(signal.reason); };
        const timer = setTimeout(() => { finish(); reject(failure('encryption_load_failed')); }, 30000);
        signal?.addEventListener('abort', abort, { once: true });
        opaqueModule.then(value => { finish(); resolve(value); }, error => { finish(); reject(error); });
        if (signal?.aborted) abort();
    });
};
const failure = (code) => Object.assign(new Error(code), { code });
const randomBytes = (length) => crypto.getRandomValues(new Uint8Array(length));
const encode = (bytes) => {
    let text = '';
    for (let offset = 0; offset < bytes.byteLength; offset += 8192) text += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    return btoa(text).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
};
const decode = (text) => {
    if (typeof text !== 'string' || !/^[A-Za-z0-9_-]+$/.test(text)) throw failure('invalid_ciphertext');
    return Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), (value) => value.charCodeAt(0));
};
const aesKey = (raw, usages) => crypto.subtle.importKey('raw', decode(raw), 'AES-GCM', false, usages);
const readEnvelope = (prefix, text) => {
    if (typeof text !== 'string' || !text.startsWith(prefix)) throw failure('invalid_ciphertext');
    try {
        const value = JSON.parse(decoder.decode(decode(text.slice(prefix.length))));
        if (decode(value.iv).byteLength !== 12 || decode(value.ciphertext).byteLength < 16) throw failure('invalid_ciphertext');
        return value;
    } catch { throw failure('invalid_ciphertext'); }
};
const seal = async (key, aad, value) => {
    const iv = randomBytes(12);
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(aad) }, key, encoder.encode(JSON.stringify(value)));
    return { iv: encode(iv), ciphertext: encode(new Uint8Array(ciphertext)) };
};
const open = async (key, aad, value) => {
    try {
        const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(value.iv), additionalData: encoder.encode(aad) }, key, decode(value.ciphertext));
        return JSON.parse(decoder.decode(plaintext));
    } catch { throw failure('invalid_ciphertext'); }
};

export async function createKeyring() {
    const currentKeyId = crypto.randomUUID();
    return { version: 1, currentKeyId, keys: { [currentKeyId]: encode(randomBytes(32)) } };
}

export async function encryptPayload(keyring, roomId, purpose, value) {
    const keyId = keyring.currentKeyId;
    const encrypted = await seal(await aesKey(keyring.keys[keyId], ['encrypt']), `gavin-sync-v1:${roomId}:${purpose}`, value);
    return `e2ee1.${encode(encoder.encode(JSON.stringify({ keyId, ...encrypted })))}`;
}

export async function decryptPayload(keyring, roomId, purpose, envelope) {
    const value = readEnvelope('e2ee1.', envelope);
    if (!Object.hasOwn(keyring.keys, value.keyId)) throw failure('key_unavailable');
    return open(await aesKey(keyring.keys[value.keyId], ['decrypt']), `gavin-sync-v1:${roomId}:${purpose}`, value);
}

export function createFileMetadata(file) {
    return {
        version: 2,
        fileId: crypto.randomUUID(), key: encode(randomBytes(32)), noncePrefix: encode(randomBytes(8)),
        size: file.size, type: file.type || 'application/octet-stream', name: file.name
    };
}

const fileParameters = (metadata, index) => {
    if (!Number.isSafeInteger(index) || index < 0 || index > 0xffffffff) throw failure('invalid_chunk');
    const prefix = decode(metadata.noncePrefix);
    if (prefix.byteLength !== 8) throw failure('invalid_ciphertext');
    const iv = new Uint8Array(12);
    iv.set(prefix);
    new DataView(iv.buffer).setUint32(8, index);
    return { name: 'AES-GCM', iv, additionalData: encoder.encode(`gavin-sync-file-v${metadata.version || 1}:${metadata.fileId}:${index}`) };
};

export async function encryptFileChunk(metadata, index, plaintext) {
    const { plainSize } = fileChunkLayout(metadata);
    const expected = Math.min(plainSize, metadata.size - index * plainSize);
    if (expected <= 0 || plaintext.byteLength !== expected) throw failure('invalid_chunk');
    return crypto.subtle.encrypt(fileParameters(metadata, index), await aesKey(metadata.key, ['encrypt']), plaintext);
}

export async function decryptFileChunk(metadata, index, ciphertext) {
    const { plainSize } = fileChunkLayout(metadata);
    const expected = Math.min(plainSize, metadata.size - index * plainSize);
    if (expected <= 0 || ciphertext.byteLength !== expected + 16) throw failure('invalid_ciphertext');
    try {
        return await crypto.subtle.decrypt(fileParameters(metadata, index), await aesKey(metadata.key, ['decrypt']), ciphertext);
    } catch { throw failure('invalid_ciphertext'); }
}

export async function encryptUploadChunk(metadata, index, plaintext) {
    const { cipherSize, plainSize, uploadPlainSize } = fileChunkLayout(metadata);
    const expected = Math.min(uploadPlainSize, metadata.size - index * uploadPlainSize);
    if (expected <= 0 || plaintext.byteLength !== expected) throw failure('invalid_chunk');
    const clear = new Uint8Array(plaintext);
    const encrypted = new Uint8Array(clear.length + Math.ceil(clear.length / plainSize) * 16);
    const first = index * (FILE_CIPHER_CHUNK_SIZE / cipherSize);
    for (let offset = 0, part = 0; offset < clear.length; offset += plainSize, part++) {
        const chunk = await encryptFileChunk(metadata, first + part, clear.subarray(offset, offset + plainSize));
        encrypted.set(new Uint8Array(chunk), part * cipherSize);
    }
    return encrypted;
}

export async function keyedFingerprint(metadata, fingerprint) {
    const key = await crypto.subtle.importKey('raw', decode(metadata.key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const digest = await crypto.subtle.sign('HMAC', key, encoder.encode(`gavin-sync-file-fingerprint-v1:${metadata.fileId}:${fingerprint}`));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

const pairingIdentifiers = (offerId) => ({ client: `gavin-sync-pair-v1:client:${offerId}`, server: `gavin-sync-pair-v1:host:${offerId}` });

export async function createPairingSecret(code, offerId) {
    if (typeof code !== 'string' || !/^\d{4}$/.test(code)) throw failure('invalid_code');
    const opaque = await loadOpaque();
    const serverSetup = opaque.server.createSetup();
    const start = opaque.client.startRegistration({ password: code });
    const response = opaque.server.createRegistrationResponse({ serverSetup, userIdentifier: offerId, registrationRequest: start.registrationRequest });
    const { registrationRecord } = opaque.client.finishRegistration({ password: code, clientRegistrationState: start.clientRegistrationState, registrationResponse: response.registrationResponse, identifiers: pairingIdentifiers(offerId) });
    return { code, serverSetup, registrationRecord, expiresAt: Date.now() + 10 * 60 * 1000 };
}

export async function startPairingClient(code, offerId, signal) {
    if (typeof code !== 'string' || !/^\d{4}$/.test(code)) throw failure('invalid_code');
    const opaque = await loadOpaque(signal);
    signal?.throwIfAborted();
    const start = opaque.client.startLogin({ password: code });
    return { clientState: { state: start.clientLoginState, code, offerId }, startLoginRequest: start.startLoginRequest };
}

export async function startPairingHost(secret, offerId, requestId, startLoginRequest) {
    if (secret.expiresAt !== null && secret.expiresAt <= Date.now()) throw failure('invalid_code');
    const opaque = await loadOpaque();
    try {
        const result = opaque.server.startLogin({ serverSetup: secret.serverSetup, registrationRecord: secret.registrationRecord, userIdentifier: offerId, startLoginRequest, identifiers: pairingIdentifiers(offerId) });
        return { serverState: { state: result.serverLoginState, offerId, requestId }, loginResponse: result.loginResponse };
    } catch { throw failure('invalid_code'); }
}

export async function finishPairingClient(clientState, offerId, requestId, loginResponse, signal) {
    if (clientState.offerId !== offerId) throw failure('invalid_code');
    const opaque = await loadOpaque(signal);
    signal?.throwIfAborted();
    try {
        const result = opaque.client.finishLogin({ clientLoginState: clientState.state, password: clientState.code, loginResponse, identifiers: pairingIdentifiers(offerId) });
        if (!result) throw failure('invalid_code');
        return { finishLoginRequest: result.finishLoginRequest, sessionKey: result.sessionKey };
    } catch { throw failure('invalid_code'); }
}

export async function finishPairingHost(serverState, finishLoginRequest) {
    const opaque = await loadOpaque();
    try {
        const { sessionKey } = opaque.server.finishLogin({ serverLoginState: serverState.state, finishLoginRequest, identifiers: pairingIdentifiers(serverState.offerId) });
        return sessionKey;
    } catch { throw failure('invalid_code'); }
}

const pairingKey = async (sessionKey, offerId, requestId, usages) => {
    const secret = await crypto.subtle.importKey('raw', decode(sessionKey), 'HKDF', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: encoder.encode(`gavin-sync-pair-v1:${offerId}:${requestId}`), info: encoder.encode('room-key-envelope') }, secret, { name: 'AES-GCM', length: 256 }, false, usages);
};

export async function encryptPairing(sessionKey, offerId, requestId, value) {
    const encrypted = await seal(await pairingKey(sessionKey, offerId, requestId, ['encrypt']), `gavin-sync-pair-v1:${offerId}:${requestId}`, value);
    return `pair1.${encode(encoder.encode(JSON.stringify(encrypted)))}`;
}

export async function decryptPairing(sessionKey, offerId, requestId, envelope) {
    const value = readEnvelope('pair1.', envelope);
    return open(await pairingKey(sessionKey, offerId, requestId, ['decrypt']), `gavin-sync-pair-v1:${offerId}:${requestId}`, value);
}

let vaultDatabase;
const vaultStore = async (mode, operation) => {
    vaultDatabase ||= new Promise((resolve, reject) => {
        const request = indexedDB.open('gavin-sync-key-vault', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('sessions', { keyPath: 'id' });
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    }).catch((error) => { vaultDatabase = null; throw error; });
    const database = await vaultDatabase;
    return new Promise((resolve, reject) => {
        const transaction = database.transaction('sessions', mode);
        const request = operation(transaction.objectStore('sessions'));
        transaction.oncomplete = () => resolve(request.result);
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
    });
};

export async function saveLocalSession(session) {
    const vaultId = session.vaultId || crypto.randomUUID();
    if (!navigator.locks) throw failure('encryption_unavailable');
    return navigator.locks.request(`gavin-sync-vault:${vaultId}`, async () => {
        const previous = await vaultStore('readonly', (store) => store.get(vaultId));
        if (previous) {
            const saved = await open(previous.key, `gavin-sync-vault-v1:${vaultId}`, previous.encrypted);
            if (!Object.hasOwn(session.keyring.keys, saved.keyring.currentKeyId)) throw failure('key_changed');
        }
        const key = previous?.key || await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
        const encrypted = await seal(key, `gavin-sync-vault-v1:${vaultId}`, { ...session, vaultId });
        await vaultStore('readwrite', (store) => store.put({ id: vaultId, key, encrypted }));
        return { roomId: session.roomId, token: session.token, deviceId: session.deviceId, vaultId };
    });
}

export async function loadLocalSession(descriptor) {
    if (!descriptor?.vaultId) throw failure('key_unavailable');
    const entry = await vaultStore('readonly', (store) => store.get(descriptor.vaultId));
    if (!entry) throw failure('key_unavailable');
    const session = await open(entry.key, `gavin-sync-vault-v1:${descriptor.vaultId}`, entry.encrypted);
    if (session.roomId !== descriptor.roomId || session.token !== descriptor.token || session.deviceId !== descriptor.deviceId) throw failure('invalid_ciphertext');
    return session;
}

export async function deleteLocalSession(vaultId) {
    await vaultStore('readwrite', (store) => store.delete(vaultId));
}

export async function savePairingRecovery(id, value) {
    const previous = await vaultStore('readonly', store => store.get(id));
    const key = previous?.key || await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const encrypted = await seal(key, `gavin-sync-pair-recovery-v1:${id}`, value);
    await vaultStore('readwrite', store => store.put({ id, key, encrypted }));
}

export async function loadPairingRecovery(id) {
    const entry = await vaultStore('readonly', store => store.get(id));
    return entry ? open(entry.key, `gavin-sync-pair-recovery-v1:${id}`, entry.encrypted) : null;
}

export async function deletePairingRecovery(id) {
    await vaultStore('readwrite', store => store.delete(id));
}

export async function createDeviceIdentity() {
    const identity = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    return {
        privateKey: await crypto.subtle.exportKey('jwk', identity.privateKey),
        publicKey: encode(new Uint8Array(await crypto.subtle.exportKey('raw', identity.publicKey)))
    };
}

const rotationKey = async (identity, peerPublicKey, context, usages) => {
    const privateKey = await crypto.subtle.importKey('jwk', identity.privateKey, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    const publicKey = await crypto.subtle.importKey('raw', decode(peerPublicKey), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: publicKey }, privateKey, 256);
    const secret = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: encoder.encode(context), info: encoder.encode('gavin-sync-rotation-v1') }, secret, { name: 'AES-GCM', length: 256 }, false, usages);
};

export async function wrapKeyring(identity, peerPublicKey, context, keyring) {
    const encrypted = await seal(await rotationKey(identity, peerPublicKey, context, ['encrypt']), `gavin-sync-rotation-v1:${context}:${identity.publicKey}:${peerPublicKey}`, keyring);
    return `rotate1.${encode(encoder.encode(JSON.stringify(encrypted)))}`;
}

export async function unwrapKeyring(identity, senderPublicKey, context, envelope) {
    const value = readEnvelope('rotate1.', envelope);
    return open(await rotationKey(identity, senderPublicKey, context, ['decrypt']), `gavin-sync-rotation-v1:${context}:${senderPublicKey}:${identity.publicKey}`, value);
}

export async function createKeyRotation(session, recipients) {
    const previousKeyring = session.keyring;
    const previousKeyId = previousKeyring.currentKeyId;
    const trustedDevices = Object.fromEntries(recipients.map(device => [device.deviceId, device.publicKey]));
    if (trustedDevices[session.deviceId] !== session.identity.publicKey
        || Object.keys(trustedDevices).length !== recipients.length
        || recipients.some(device => session.revokedDevices.includes(device.deviceId)
            || (Object.hasOwn(session.trustedDevices, device.deviceId) && session.trustedDevices[device.deviceId] !== device.publicKey))) throw failure('invalid_ciphertext');
    const revokedDevices = [...new Set([...session.revokedDevices,
        ...Object.keys(session.trustedDevices).filter(id => !Object.hasOwn(trustedDevices, id))])];
    const added = await createKeyring();
    const keyring = { ...added, keys: { ...previousKeyring.keys, ...added.keys } };
    const next = { keyring, trustedDevices, revokedDevices };
    const rotationId = crypto.randomUUID();
    const grants = await Promise.all(recipients.map(async device => {
        const context = `${session.roomId}:${rotationId}:${device.deviceId}:${session.deviceId}:${previousKeyId}`;
        const inner = await wrapKeyring(session.identity, device.publicKey, context, next);
        const envelope = await encryptPayload(previousKeyring, session.roomId, `rotation:${rotationId}:${device.deviceId}`, {
            issuerDeviceId: session.deviceId, senderPublicKey: session.identity.publicKey, previousKeyId, inner
        });
        return { deviceId: device.deviceId, envelope };
    }));
    return { rotationId, previousKeyId, newKeyId: keyring.currentKeyId, grants, next };
}

export async function acceptKeyRotation(session, grant) {
    const wrapped = await decryptPayload(session.keyring, session.roomId, `rotation:${grant.rotationId}:${session.deviceId}`, grant.envelope);
    if (!Object.hasOwn(session.trustedDevices, wrapped.issuerDeviceId)
        || session.trustedDevices[wrapped.issuerDeviceId] !== wrapped.senderPublicKey
        || session.revokedDevices.includes(wrapped.issuerDeviceId)
        || wrapped.previousKeyId !== session.keyring.currentKeyId) throw failure('invalid_ciphertext');
    const context = `${session.roomId}:${grant.rotationId}:${session.deviceId}:${wrapped.issuerDeviceId}:${wrapped.previousKeyId}`;
    const next = await unwrapKeyring(session.identity, wrapped.senderPublicKey, context, wrapped.inner);
    if (!next || typeof next !== 'object') throw failure('invalid_ciphertext');
    const { keyring, trustedDevices, revokedDevices } = next;
    const record = (value) => value && typeof value === 'object' && !Array.isArray(value);
    if (!record(keyring) || keyring.version !== 1 || !record(keyring.keys)
        || !Object.hasOwn(keyring.keys, keyring.currentKeyId) || Object.hasOwn(session.keyring.keys, keyring.currentKeyId)
        || decode(keyring.keys[keyring.currentKeyId]).byteLength !== 32
        || Object.values(session.keyring.keys).includes(keyring.keys[keyring.currentKeyId])
        || Object.entries(session.keyring.keys).some(([key, value]) => keyring.keys[key] !== value)
        || !record(trustedDevices) || !Array.isArray(revokedDevices)
        || trustedDevices[session.deviceId] !== session.identity.publicKey
        || trustedDevices[wrapped.issuerDeviceId] !== wrapped.senderPublicKey
        || session.revokedDevices.some(id => !revokedDevices.includes(id))
        || Object.keys(trustedDevices).some(id => revokedDevices.includes(id)
            || (Object.hasOwn(session.trustedDevices, id) && trustedDevices[id] !== session.trustedDevices[id]))
        || Object.keys(session.trustedDevices).some(id => !Object.hasOwn(trustedDevices, id) && !revokedDevices.includes(id))) throw failure('invalid_ciphertext');
    return { keyring, trustedDevices, revokedDevices };
}
