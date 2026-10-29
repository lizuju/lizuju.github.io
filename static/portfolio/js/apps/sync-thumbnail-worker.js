import { inspectImage } from './sync-image-resource.js';

self.onmessage = async ({ data: file }) => {
    let image;
    let canvas;
    try {
        const details = await inspectImage(file);
        if (details.width * details.height > 40 * 1024 * 1024) { self.postMessage(null); return; }
        const options = { resizeWidth: Math.min(details.width || 260, 260), resizeQuality: 'high' };
        try { image = await createImageBitmap(file, options); }
        catch {
            if (!/\.(heic|heif)$/i.test(file.name) && !/^image\/hei[cf]$/.test(file.type)) throw new Error('unsupported_image');
            const { heicTo } = await import(/* webpackChunkName: "preview-heic" */ 'heic-to/csp');
            image = await heicTo({ blob: file, type: 'bitmap', options });
        }
        canvas = new OffscreenCanvas(1, 1);
        for (const maximum of [260, 192, 128]) {
            const scale = Math.min(1, maximum / image.width, 200 / image.height);
            canvas.width = Math.max(1, Math.round(image.width * scale));
            canvas.height = Math.max(1, Math.round(image.height * scale));
            canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
            let blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.55 });
            if (blob.type !== 'image/webp') blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.55 });
            if (blob.size > 4096) continue;
            const bytes = new Uint8Array(await blob.arrayBuffer());
            self.postMessage({ data: `data:${blob.type};base64,${btoa(String.fromCharCode(...bytes))}`,
                width: canvas.width, height: canvas.height, animated: details.animated });
            return;
        }
        self.postMessage(null);
    } catch { self.postMessage(null); }
    finally {
        image?.close();
        if (canvas) { canvas.width = 0; canvas.height = 0; }
    }
};
