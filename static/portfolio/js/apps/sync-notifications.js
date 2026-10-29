import { prepareEncryptedFiles } from './sync-e2ee-files.js';

const preference = 'portfolio-sync-system-notifications';

export function createSystemNotifications({ button, translate, onError, onOpen }) {
    const supported = 'Notification' in window;
    const enabled = () => {
        try { return supported && Notification.permission === 'granted' && localStorage.getItem(preference) === 'on'; }
        catch { return false; }
    };
    const update = () => {
        button.disabled = !supported;
        button.textContent = translate(!supported ? 'syncNotificationsUnavailable' : enabled() ? 'syncNotificationsOn' : 'syncNotificationsOff');
        button.setAttribute('aria-pressed', String(enabled()));
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
    return {
        async show(message, session) {
            if (!enabled() || (!document.hidden && document.hasFocus())) return;
            const key = `portfolio-sync-system-notification:${session.roomId}:${session.deviceId}`;
            await navigator.locks.request(key, async () => {
                if (!enabled() || message.id <= Number(localStorage.getItem(key) || 0)) return;
                const worker = await prepareEncryptedFiles();
                const shown = await new Promise(resolve => {
                    const channel = new MessageChannel();
                    const timer = setTimeout(() => { channel.port1.close(); resolve(false); }, 5000);
                    channel.port1.onmessage = ({ data }) => { clearTimeout(timer); channel.port1.close(); resolve(data === true); };
                    worker.postMessage({ source: 'gavin-sync-notification', type: 'show', roomId: session.roomId,
                        title: translate('desktopSyncSpace'), body: translate('syncNotificationMessage') }, [channel.port2]);
                });
                if (shown) localStorage.setItem(key, String(message.id));
            });
        }
    };
}
