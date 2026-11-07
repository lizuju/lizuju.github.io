import { prepareEncryptedFiles } from './sync-e2ee-files.js';

const cacheKey = 'gavin-sync-push-registration-v1';
const cacheUrl = new URL('/__sync-push-registration__', location.origin).href;
const cacheLifetime = 60 * 60 * 1000;
const readCache = async () => {
    try { return await (await (await caches.open(cacheKey)).match(cacheUrl))?.json() || {}; } catch { return {}; }
};
const saveCache = async value => {
    try { await (await caches.open(cacheKey)).put(cacheUrl, new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })); } catch {}
};
const digest = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2, '0')).join('');
const preference = 'portfolio-sync-system-notifications';
const supported = () => 'Notification' in window && 'PushManager' in window && 'serviceWorker' in navigator;
const decodeKey = value => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), character => character.charCodeAt(0));

export function createWebPush({ api, getSessions, getLanguage }) {
    const registered = new Map();
    let task = Promise.resolve();
    const serialize = operation => {
        task = task.catch(() => {}).then(() => navigator.locks.request('gavin-sync-web-push', operation));
        return task;
    };
    const registration = async () => {
        await prepareEncryptedFiles();
        return navigator.serviceWorker.getRegistration('/');
    };
    const subscribe = async () => {
        const worker = await registration();
        const cache = await readCache();
        let publicKey = cache.keyExpiresAt > Date.now() ? cache.publicKey : null;
        if (!publicKey) {
            ({ publicKey } = await api('/v1/push/key', {}, null));
            await saveCache({ ...cache, publicKey, keyExpiresAt: Date.now() + cacheLifetime });
        }
        if (!publicKey) throw new Error('push_unavailable');
        const applicationServerKey = decodeKey(publicKey);
        let subscription = await worker.pushManager.getSubscription();
        if (subscription && subscription.options.applicationServerKey
            && (subscription.options.applicationServerKey.byteLength !== applicationServerKey.length
                || !new Uint8Array(subscription.options.applicationServerKey).every((byte, index) => byte === applicationServerKey[index]))) {
            await subscription.unsubscribe();
            subscription = null;
            registered.clear();
        }
        if (!subscription) registered.clear();
        return subscription || worker.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
    };
    const save = async subscription => {
        const language = getLanguage() === 'en' ? 'en' : 'zh-CN';
        const sessions = getSessions();
        const cache = await readCache();
        const successes = Object.fromEntries(Object.entries(cache.registrations || {}).filter(([, entry]) => entry.expiresAt > Date.now()));
        const active = new Set(sessions.map(session => `${session.roomId}:${session.deviceId}`));
        for (const key of registered.keys()) if (!active.has(key)) registered.delete(key);
        for (const session of sessions) {
            const key = `${session.roomId}:${session.deviceId}`;
            const identity = await digest(JSON.stringify([session.roomId, session.deviceId, session.token]));
            const fingerprint = await digest(JSON.stringify([subscription.toJSON(), language]));
            if (successes[identity]?.fingerprint === fingerprint) { registered.set(key, successes[identity].expiresAt); continue; }
            try {
                await api(`/v1/spaces/${session.roomId}/push-subscription`, {
                    method: 'PUT', body: JSON.stringify({ subscription: subscription.toJSON(), language })
                }, session);
                successes[identity] = { fingerprint, expiresAt: Date.now() + cacheLifetime };
                registered.set(key, successes[identity].expiresAt);
                cache.registrations = Object.fromEntries(Object.entries(successes).slice(-100));
                await saveCache(cache);
            } catch (error) {
                if (![401, 404].includes(error.status)) throw error;
                registered.delete(key);
            }
        }
    };
    return {
        supported,
        usesPush: session => registered.has(`${session.roomId}:${session.deviceId}`),
        enable: () => serialize(async () => {
            if (!supported()) return;
            const subscription = await subscribe();
            try { await save(subscription); }
            catch (error) {
                await subscription.unsubscribe();
                registered.clear();
                await saveCache({ disabled: true });
                throw error;
            }
            await saveCache({ ...await readCache(), disabled: false });
            localStorage.setItem(preference, 'on');
        }),
        disable: () => serialize(async () => {
            if (!supported()) return;
            const worker = await navigator.serviceWorker.getRegistration('/');
            const subscription = await worker?.pushManager.getSubscription();
            if (subscription) await subscription.unsubscribe();
            registered.clear();
            await saveCache({ disabled: true });
            localStorage.setItem(preference, 'off');
            await Promise.allSettled(getSessions().map(session => api(`/v1/spaces/${session.roomId}/push-subscription`, { method: 'DELETE' }, session)));
        }),
        sync: () => serialize(async () => {
            if (!supported() || Notification.permission !== 'granted' || localStorage.getItem(preference) !== 'on' || (await readCache()).disabled) return;
            await save(await subscribe());
        })
    };
}
