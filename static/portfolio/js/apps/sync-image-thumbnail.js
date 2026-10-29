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

export async function createImageThumbnail(file, signal) {
    if (file.size > 20 * 1024 * 1024 || !(/\.(png|jpe?g|webp|gif|avif|heic|heif)$/i.test(file.name)
        || /^image\/(png|jpeg|webp|gif|avif|heic|heif)$/.test(file.type))) return null;
    let image;
    let url;
    try {
        signal.throwIfAborted();
        const details = await inspectImage(file);
        if (details.width * details.height > 40 * 1024 * 1024) return null;
        signal.throwIfAborted();
        try {
            image = await createImageBitmap(file, { resizeWidth: Math.min(details.width || 260, 260), resizeQuality: 'high' });
        } catch {
            signal.throwIfAborted();
            image = new Image();
            url = URL.createObjectURL(file);
            image.src = url;
            try { await image.decode(); }
            catch {
                if (!/\.(heic|heif)$/i.test(file.name) && !/^image\/hei[cf]$/.test(file.type)) return null;
                signal.throwIfAborted();
                const { heicTo } = await import(/* webpackChunkName: "preview-heic" */ 'heic-to/csp');
                const converted = await heicTo({ blob: file, type: 'image/jpeg', quality: 0.6 });
                signal.throwIfAborted();
                URL.revokeObjectURL(url);
                url = URL.createObjectURL(converted);
                image.src = url;
                await image.decode();
            }
        }
        signal.throwIfAborted();
        const width = image.naturalWidth || image.width;
        const height = image.naturalHeight || image.height;
        const canvas = document.createElement('canvas');
        try {
            for (const maximum of [260, 192, 128]) {
                const scale = Math.min(1, maximum / width, 200 / height);
                canvas.width = Math.max(1, Math.round(width * scale));
                canvas.height = Math.max(1, Math.round(height * scale));
                canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
                let blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', 0.55));
                if (blob && blob.type !== 'image/webp') blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.55));
                signal.throwIfAborted();
                if (!blob || blob.size > 4096) continue;
                const bytes = new Uint8Array(await blob.arrayBuffer());
                return { data: `data:${blob.type};base64,${btoa(String.fromCharCode(...bytes))}`,
                    width: canvas.width, height: canvas.height, animated: details.animated };
            }
        } finally { canvas.width = 0; canvas.height = 0; }
        return null;
    } catch (error) {
        if (signal.aborted) throw signal.reason;
        return null;
    } finally {
        image?.close?.();
        image?.removeAttribute?.('src');
        if (url) URL.revokeObjectURL(url);
    }
}
