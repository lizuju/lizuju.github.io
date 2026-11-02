import { prepareEncryptedFiles } from './sync-e2ee-files.js';

const preference = 'portfolio-sync-system-notifications';
const diagnosticsKey = 'portfolio-sync-notification-diagnostics';

const statuses = new Set(['shown', 'foreground', 'duplicate', 'disabled', 'timeout', 'lock_timeout', 'error', 'denied', 'unsupported']);
const cleanDiagnostic = value => {
    if (!value || !Number.isFinite(value.at) || value.at < 0 || !statuses.has(value.status)) return null;
    const result = { at: value.at, status: value.status, visibility: value.visibility === 'hidden' ? 'hidden' : 'visible' };
    if (value.test === true) result.test = true;
    for (const key of ['receiveToRequestMs', 'queueMs', 'prepareMs', 'workerMs', 'totalMs', 'attempt']) {
        if (Number.isFinite(value[key]) && value[key] >= 0) result[key] = value[key];
    }
    return result;
};
let diagnostics = [];
try {
    const stored = JSON.parse(sessionStorage.getItem(diagnosticsKey) || '[]');
    if (Array.isArray(stored)) diagnostics = stored.map(cleanDiagnostic).filter(Boolean).slice(-50);
} catch { /* Diagnostics are optional. */ }
const record = value => {
    const entry = cleanDiagnostic({ at: Date.now(), visibility: document.hidden ? 'hidden' : 'visible', ...value });
    if (!entry) return;
    diagnostics.push(entry);
    diagnostics = diagnostics.slice(-50);
    try { sessionStorage.setItem(diagnosticsKey, JSON.stringify(diagnostics)); } catch { /* Keep diagnostics in memory. */ }
    window.dispatchEvent(new Event('sync-diagnostics-change'));
};

export const readNotificationDiagnostics = () => diagnostics.map(cleanDiagnostic).filter(Boolean);
export function getNotificationState() {
    const supported = 'Notification' in window;
    const permission = supported && ['default', 'granted', 'denied'].includes(Notification.permission) ? Notification.permission : 'unsupported';
    let enabled = false;
    try { enabled = permission === 'granted' && localStorage.getItem(preference) === 'on'; } catch { /* Preference storage is optional. */ }
    const state = navigator.serviceWorker?.controller?.state;
    const workerState = ['installing', 'installed', 'activating', 'activated', 'redundant'].includes(state) ? state : 'none';
    return { supported, permission, enabled, workerState };
}

const sendNotification = async payload => {
    for (let attempt = 0; attempt < 2; attempt++) {
        const preparingAt = Date.now();
        const worker = await prepareEncryptedFiles();
        const prepareMs = Date.now() - preparingAt;
        const response = await new Promise((resolve, reject) => {
            const channel = new MessageChannel();
            const timer = setTimeout(() => { channel.port1.close(); resolve({ status: 'timeout' }); }, 5000);
            channel.port1.onmessage = ({ data }) => { clearTimeout(timer); channel.port1.close(); resolve(data); };
            try { worker.postMessage({ source: 'gavin-sync-notification', ...payload }, [channel.port2]); }
            catch (error) {
                clearTimeout(timer); channel.port1.close();
                if (worker !== navigator.serviceWorker.controller) resolve({ status: 'timeout' });
                else reject(error);
            }
        });
        if (response.status === 'timeout' && attempt === 0 && worker !== navigator.serviceWorker.controller) continue;
        return { status: statuses.has(response.status) ? response.status : 'error', prepareMs,
            workerMs: Number.isFinite(response.workerMs) && response.workerMs >= 0 ? response.workerMs : null, attempt: attempt + 1 };
    }
};

export async function testSystemNotification({ title, body }) {
    const startedAt = Date.now();
    let result;
    try {
        if (!('Notification' in window)) result = { status: 'unsupported' };
        else {
            const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
            result = permission === 'granted' ? await sendNotification({ type: 'test', title, body }) : { status: 'denied' };
        }
    } catch { result = { status: 'error' }; }
    result = { ...result, totalMs: Date.now() - startedAt, test: true };
    record(result);
    return result;
}

export function createSystemNotifications({ button, translate, onError, onOpen }) {
    const supported = 'Notification' in window;
    const pending = new Map();
    const enabled = () => {
        try { return supported && Notification.permission === 'granted' && localStorage.getItem(preference) === 'on'; }
        catch { return false; }
    };
    const update = () => {
        button.disabled = !supported;
        button.textContent = translate(!supported ? 'syncNotificationsUnavailable' : enabled() ? 'syncNotificationsOn' : 'syncNotificationsOff');
        button.setAttribute('aria-pressed', String(enabled()));
        window.dispatchEvent(new Event('sync-diagnostics-change'));
    };
    button.addEventListener('click', async () => {
        if (!supported) return;
        if (enabled()) localStorage.setItem(preference, 'off');
        else {
            try {
                const permission = await Notification.requestPermission();
                if (permission !== 'granted') { onError('syncNotificationsDenied'); update(); return; }
                await prepareEncryptedFiles();
                localStorage.setItem(preference, 'on');
            } catch { onError('syncNotificationsUnavailable'); }
        }
        update();
    });
    navigator.serviceWorker?.addEventListener('message', event => {
        const expected = new URL('sync-e2ee-worker.js', document.baseURI).href;
        if (event.source?.scriptURL === expected && event.data?.source === 'gavin-sync-notification') onOpen(event.data.roomId);
    });
    window.addEventListener('storage', event => { if (event.key === preference || event.key === null) update(); });
    window.addEventListener('portfolio-language-change', update);
    update();
    const deliver = async (entry, key) => {
        const queuedAt = Date.now();
        const controller = new AbortController();
        const deadline = setTimeout(() => controller.abort(), 5000);
        try {
            await navigator.locks.request(key, { signal: controller.signal }, async () => {
                clearTimeout(deadline);
                const { message, session, receivedAt } = entry.latest;
                const startedAt = Date.now();
                const timings = { receiveToRequestMs: Math.max(0, queuedAt - receivedAt), queueMs: startedAt - queuedAt };
                const finish = (status, extra = {}) => record({ status, ...timings, totalMs: Date.now() - receivedAt, ...extra });
                if (!enabled()) { finish('disabled'); return; }
                if (!document.hidden && document.hasFocus()) { finish('foreground'); return; }
                if (message.id <= Number(localStorage.getItem(key) || 0)) { finish('duplicate'); return; }
                const response = await sendNotification({ type: 'show', roomId: session.roomId,
                    title: translate('desktopSyncSpace'), body: translate('syncNotificationMessage') });
                if (response.status === 'shown') localStorage.setItem(key, String(message.id));
                finish(response.status, response);
            });
        } catch (error) { record({ status: controller.signal.aborted ? 'lock_timeout' : 'error', totalMs: Date.now() - entry.latest.receivedAt }); }
        finally { clearTimeout(deadline); }
    };
    return {
        diagnostics: readNotificationDiagnostics,
        show(message, session, receivedAt = Date.now()) {
            if (!enabled()) return Promise.resolve();
            if (!document.hidden && document.hasFocus()) {
                record({ status: 'foreground', totalMs: Date.now() - receivedAt });
                return Promise.resolve();
            }
            const key = `portfolio-sync-system-notification:${session.roomId}:${session.deviceId}`;
            const existing = pending.get(key);
            if (existing) {
                if (message.id > existing.latest.message.id) existing.latest = { message, session, receivedAt };
                return existing.task;
            }
            const entry = { latest: { message, session, receivedAt } };
            pending.set(key, entry);
            entry.task = (async () => {
                let latest;
                do {
                    latest = entry.latest;
                    await deliver(entry, key);
                } while (entry.latest !== latest);
            })().finally(() => pending.delete(key));
            return entry.task;
        }
    };
}
