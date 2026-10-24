const root = new URL('.', document.baseURI);
const workerUrl = new URL('sync-e2ee-worker.js', root);
const entries = new Map();
let workerPromise;

navigator.serviceWorker?.addEventListener('message', (event) => {
    if (event.source?.scriptURL !== workerUrl.href || event.data?.source !== 'gavin-sync-e2ee') return;
    if (event.data.type === 'released') entries.get(event.data.token)?.release();
    else if (event.data.type === 'resolve' && event.ports[0]) event.ports[0].postMessage(entries.get(event.data.token)?.descriptor || null);
});

const getWorker = () => {
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

export async function openEncryptedFile({ url, metadata, download = false }) {
    await getWorker();
    const worker = navigator.serviceWorker.controller;
    const token = Array.from(crypto.getRandomValues(new Uint8Array(24)), byte => byte.toString(16).padStart(2, '0')).join('');
    const descriptor = { url, metadata, download };
    let release;
    const closed = new Promise(resolve => { release = () => { entries.delete(token); resolve(); }; });
    entries.set(token, { descriptor, release });
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
            dispose() {
                release();
                navigator.serviceWorker.controller?.postMessage({ source: 'gavin-sync-e2ee', type: 'close', token });
            }
        };
    } catch (error) {
        release();
        worker.postMessage({ source: 'gavin-sync-e2ee', type: 'close', token });
        throw error;
    }
}
