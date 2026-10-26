const root = new URL(document.body.dataset.assetRoot || '.', document.baseURI);
const workerUrl = new URL('sync-e2ee-worker.js', root);
const entries = new Map();
const DOWNLOAD_IDLE_MS = 60000;
let workerPromise;

navigator.serviceWorker?.addEventListener('message', (event) => {
    if (event.source?.scriptURL !== workerUrl.href || event.data?.source !== 'gavin-sync-e2ee') return;
    if (event.data.type === 'released') entries.get(event.data.token)?.release(event.data.status);
    else if (event.data.type === 'download-state') entries.get(event.data.token)?.update(event.data);
    else if (event.data.type === 'resolve' && event.ports[0]) event.ports[0].postMessage(entries.get(event.data.token)?.descriptor || null);
    else if (event.data.type === 'refresh' && event.ports[0]) {
        const entry = entries.get(event.data.token);
        Promise.resolve().then(() => entry?.refresh?.()).then(url => {
            if (!url || entries.get(event.data.token) !== entry) { event.ports[0].postMessage(null); return; }
            entry.descriptor.url = url;
            event.ports[0].postMessage(url);
        }).catch(() => event.ports[0].postMessage(null));
    }
});

export const prepareEncryptedFiles = () => {
    if (!workerPromise) {
        workerPromise = (async () => {
            if (!navigator.serviceWorker) throw new Error('encrypted_file_unavailable');
            await navigator.serviceWorker.register(workerUrl.href, { scope: root.pathname, updateViaCache: 'none' });
            if (navigator.serviceWorker.controller?.scriptURL !== workerUrl.href) {
                await new Promise((resolve, reject) => {
                    const check = () => {
                        if (navigator.serviceWorker.controller?.scriptURL !== workerUrl.href) return;
                        clearTimeout(timer);
                        navigator.serviceWorker.removeEventListener('controllerchange', check);
                        resolve();
                    };
                    const timer = setTimeout(() => {
                        navigator.serviceWorker.removeEventListener('controllerchange', check);
                        reject(new Error('encrypted_file_unavailable'));
                    }, 15000);
                    navigator.serviceWorker.addEventListener('controllerchange', check);
                    check();
                });
            }
            return navigator.serviceWorker.controller;
        })().catch((error) => { workerPromise = null; throw error; });
    }
    return workerPromise;
};

export async function openEncryptedFile({ url, metadata, download = false, refresh }) {
    await prepareEncryptedFiles();
    const worker = navigator.serviceWorker.controller;
    const token = Array.from(crypto.getRandomValues(new Uint8Array(24)), byte => byte.toString(16).padStart(2, '0')).join('');
    const mediaType = {
        mov: 'video/quicktime', mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg', ogg: 'video/ogg',
        mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', oga: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac'
    }[metadata.name.split('.').pop().toLowerCase()];
    const descriptor = { url, metadata: !download && metadata.type === 'application/octet-stream' && mediaType
        ? { ...metadata, type: mediaType } : metadata, download, expiresAt: download ? Date.now() + DOWNLOAD_IDLE_MS : null };
    let release;
    let report;
    let idleTimer;
    const result = new Promise(resolve => { report = status => resolve({ status }); });
    const closed = new Promise(resolve => {
        release = (status = 'disposed') => {
            clearTimeout(idleTimer);
            entries.delete(token);
            report(status);
            resolve();
        };
    });
    const dispose = () => {
        release();
        navigator.serviceWorker.controller?.postMessage({ source: 'gavin-sync-e2ee', type: 'close', token });
    };
    const update = ({ status, expiresAt }) => {
        clearTimeout(idleTimer);
        descriptor.expiresAt = expiresAt;
        if (expiresAt) idleTimer = setTimeout(dispose, Math.max(0, expiresAt - Date.now()));
        if (status) report(status);
    };
    entries.set(token, { descriptor, release, update, refresh });
    if (download) update({ expiresAt: descriptor.expiresAt });
    try {
        const localUrl = await new Promise((resolve, reject) => {
            const channel = new MessageChannel();
            const timer = setTimeout(() => { channel.port1.close(); reject(new Error('encrypted_file_unavailable')); }, 15000);
            channel.port1.onmessage = ({ data }) => {
                clearTimeout(timer);
                channel.port1.close();
                data?.url ? resolve(data.url) : reject(new Error('encrypted_file_unavailable'));
            };
            worker.postMessage({ source: 'gavin-sync-e2ee', type: 'open', token, descriptor }, [channel.port2]);
        });
        return {
            url: localUrl,
            closed,
            result,
            dispose
        };
    } catch (error) {
        release();
        worker.postMessage({ source: 'gavin-sync-e2ee', type: 'close', token });
        throw error;
    }
}
