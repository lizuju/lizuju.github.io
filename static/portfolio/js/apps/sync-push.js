import { prepareEncryptedFiles } from './sync-e2ee-files.js';

const preference = 'portfolio-sync-system-notifications';
const supported = () => 'Notification' in window && 'PushManager' in window && 'serviceWorker' in navigator;
const decodeKey = value => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), character => character.charCodeAt(0));

export function createWebPush({ api, getSessions, getLanguage }) {
    const registered = new Map();
    let publicKey;
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
        if (!publicKey) ({ publicKey } = await api('/v1/push/key', {}, null));
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
        return subscription || worker.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
    };
    const save = async subscription => {
        const language = getLanguage() === 'en' ? 'en' : 'zh-CN';
        const sessions = getSessions();
        const active = new Set(sessions.map(session => `${session.roomId}:${session.deviceId}`));
        for (const key of registered.keys()) if (!active.has(key)) registered.delete(key);
        for (const session of sessions) {
            const key = `${session.roomId}:${session.deviceId}`;
            const fingerprint = `${subscription.endpoint}:${language}`;
            if (registered.get(key) === fingerprint) continue;
            try {
                await api(`/v1/spaces/${session.roomId}/push-subscription`, {
                    method: 'PUT', body: JSON.stringify({ subscription: subscription.toJSON(), language })
                }, session);
                registered.set(key, fingerprint);
            } catch (error) {
                if (![401, 404].includes(error.status)) throw error;
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
                throw error;
            }
            localStorage.setItem(preference, 'on');
        }),
        disable: () => serialize(async () => {
            if (!supported()) return;
            const worker = await navigator.serviceWorker.getRegistration('/');
            const subscription = await worker?.pushManager.getSubscription();
            if (subscription) await subscription.unsubscribe();
            registered.clear();
            localStorage.setItem(preference, 'off');
            await Promise.allSettled(getSessions().map(session => api(`/v1/spaces/${session.roomId}/push-subscription`, { method: 'DELETE' }, session)));
        }),
        sync: () => serialize(async () => {
            if (!supported() || Notification.permission !== 'granted' || localStorage.getItem(preference) !== 'on') return;
            await save(await subscribe());
        })
    };
}
