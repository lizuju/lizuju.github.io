import { encryptPayload, decryptPayload } from './sync-crypto.js';

let database;
const scope = session => `${session.roomId}:${session.deviceId}`;
const store = async (mode, operation) => {
    database ||= new Promise((resolve, reject) => {
        const request = indexedDB.open('gavin-sync-outbox', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('messages', { keyPath: ['scope', 'clientId'] }).createIndex('scope', 'scope');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    }).catch(error => { database = null; throw error; });
    const db = await database;
    return new Promise((resolve, reject) => {
        const transaction = db.transaction('messages', mode);
        const request = operation(transaction.objectStore('messages'));
        transaction.oncomplete = () => resolve(request?.result);
        transaction.onerror = transaction.onabort = () => reject(transaction.error);
    });
};
const change = (session, operation) => navigator.locks.request(`gavin-sync-outbox-store:${scope(session)}`, operation);

export const pendingMessages = {
    save(session, message, create = false) {
        return change(session, async () => {
            const encrypted = await encryptPayload(session.keyring, session.roomId, `outbox:${session.deviceId}:${message.clientId}`, message);
            await store('readwrite', messages => {
                const request = messages.get([scope(session), message.clientId]);
                request.onsuccess = () => {
                    if (create || request.result) messages.put({ scope: scope(session), clientId: message.clientId, encrypted });
                };
            });
        });
    },
    async load(session) {
        const entries = await store('readonly', messages => messages.index('scope').getAll(scope(session)));
        const loaded = await Promise.all(entries.map(entry => decryptPayload(session.keyring, session.roomId, `outbox:${session.deviceId}:${entry.clientId}`, entry.encrypted)));
        return loaded.sort((a, b) => a.createdAt - b.createdAt).map(message => ({ ...message,
            // An uncertain send older than server retention must not be silently replayed.
            autoSend: message.autoSend && Date.now() - message.createdAt < 7 * 86400000
        }));
    },
    async get(session, clientId) {
        const entry = await store('readonly', messages => messages.get([scope(session), clientId]));
        if (!entry) return null;
        const message = await decryptPayload(session.keyring, session.roomId, `outbox:${session.deviceId}:${clientId}`, entry.encrypted);
        return { ...message, autoSend: message.autoSend && Date.now() - message.createdAt < 7 * 86400000 };
    },
    remove(session, clientId) {
        return change(session, () => store('readwrite', messages => messages.delete([scope(session), clientId])));
    },
    clear(session) {
        return change(session, () => store('readwrite', messages => {
            const request = messages.index('scope').openKeyCursor(scope(session));
            request.onsuccess = () => {
                const cursor = request.result;
                if (cursor) { messages.delete(cursor.primaryKey); cursor.continue(); }
            };
        }));
    }
};
