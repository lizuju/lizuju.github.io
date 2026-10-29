import { inspectImage } from './sync-image-resource.js';

export async function validThumbnail(value) {
    if (!value || !Number.isInteger(value.width) || value.width < 1 || value.width > 260
        || !Number.isInteger(value.height) || value.height < 1 || value.height > 200
        || typeof value.animated !== 'boolean' || typeof value.data !== 'string' || value.data.length > 6000
        || !/^data:image\/(webp|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(value.data)) return false;
    try {
        const bytes = Uint8Array.from(atob(value.data.split(',')[1]), character => character.charCodeAt(0));
        if (bytes.length > 4096) return false;
        const details = await inspectImage(new Blob([bytes]));
        return details.width === value.width && details.height === value.height && !details.animated;
    } catch { return false; }
}

// Thumbnail generation is optional: terminate decoding after two seconds and upload the original.
export async function createImageThumbnail(file, signal) {
    signal.throwIfAborted();
    if (file.size > 20 * 1024 * 1024 || !(/\.(png|jpe?g|webp|gif|avif|heic|heif)$/i.test(file.name)
        || /^image\/(png|jpeg|webp|gif|avif|heic|heif)$/.test(file.type))) return null;
    let worker;
    let timer;
    let abort;
    try {
        return await new Promise((resolve, reject) => {
            abort = () => reject(signal.reason);
            signal.addEventListener('abort', abort, { once: true });
            timer = setTimeout(() => resolve(null), 2000);
            worker = new Worker(new URL('./sync-thumbnail-worker.js', import.meta.url), { type: 'module', name: 'image-thumbnail' });
            worker.onmessage = event => resolve(event.data);
            worker.onerror = event => { event.preventDefault(); resolve(null); };
            worker.postMessage(file);
        });
    } catch (error) {
        if (signal.aborted) throw signal.reason;
        return null;
    } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        worker?.terminate();
    }
}
