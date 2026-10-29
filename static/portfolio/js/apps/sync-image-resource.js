const idle = new Map();
let idleBytes = 0;
const AUTOMATIC_PIXEL_LIMIT = 8 * 1024 * 1024;

export const inspectImage = async blob => {
    const bytes = new Uint8Array(await blob.slice(0, 1024 * 1024).arrayBuffer());
    const view = new DataView(bytes.buffer);
    const text = (start, length) => String.fromCharCode(...bytes.subarray(start, start + length));
    const result = { width: 0, height: 0, animated: false };
    if (bytes.length >= 24 && text(0, 8) === '\x89PNG\r\n\x1a\n') {
        result.width = view.getUint32(16);
        result.height = view.getUint32(20);
        // APNG declares animation before the first image-data chunk.
        result.animated = true;
        for (let offset = 8; offset + 8 <= bytes.length; offset += view.getUint32(offset) + 12) {
            const type = text(offset + 4, 4);
            if (type === 'acTL') break;
            if (type === 'IDAT' || type === 'IEND') { result.animated = false; break; }
        }
    } else if (bytes.length >= 10 && ['GIF87a', 'GIF89a'].includes(text(0, 6))) {
        result.width = view.getUint16(6, true);
        result.height = view.getUint16(8, true);
        result.animated = true;
    } else if (bytes.length >= 30 && text(0, 4) === 'RIFF' && text(8, 4) === 'WEBP') {
        const type = text(12, 4);
        if (type === 'VP8X') {
            result.animated = !!(bytes[20] & 2);
            result.width = 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16);
            result.height = 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16);
        } else if (type === 'VP8 ') {
            result.width = view.getUint16(26, true) & 0x3fff;
            result.height = view.getUint16(28, true) & 0x3fff;
        } else if (type === 'VP8L') {
            const dimensions = view.getUint32(21, true);
            result.width = (dimensions & 0x3fff) + 1;
            result.height = ((dimensions >>> 14) & 0x3fff) + 1;
        }
    } else if (bytes[0] === 0xff && bytes[1] === 0xd8) {
        for (let offset = 2; offset + 4 <= bytes.length;) {
            if (bytes[offset] !== 0xff) break;
            const marker = bytes[offset + 1];
            if (marker === 0xff) { offset++; continue; }
            if (marker === 0xda || marker === 0xd9) break;
            const length = view.getUint16(offset + 2);
            if (length < 2 || offset + 2 + length > bytes.length) break;
            if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 7) {
                result.height = view.getUint16(offset + 5);
                result.width = view.getUint16(offset + 7);
                break;
            }
            offset += 2 + length;
        }
    } else if (bytes.length >= 16 && text(4, 4) === 'ftyp') {
        const boxes = (start, end, depth = 0) => {
            for (let offset = start; offset + 8 <= end;) {
                let length = view.getUint32(offset);
                const type = text(offset + 4, 4);
                let payload = offset + 8;
                if (length === 1) {
                    if (offset + 16 > end) break;
                    length = view.getUint32(offset + 8) * 2 ** 32 + view.getUint32(offset + 12);
                    payload += 8;
                } else if (length === 0) length = end - offset;
                if (length < payload - offset || !Number.isSafeInteger(length)) break;
                const limit = Math.min(end, offset + length);
                if (type === 'ftyp') {
                    for (let brand = payload; brand + 4 <= limit; brand += 4) {
                        if (brand !== payload + 4 && text(brand, 4) === 'avis') result.animated = true;
                    }
                } else if (type === 'ispe' && payload + 12 <= limit) {
                    const width = view.getUint32(payload + 4);
                    const height = view.getUint32(payload + 8);
                    if (width * height > result.width * result.height) Object.assign(result, { width, height });
                } else if (depth < 3 && ['meta', 'iprp', 'ipco'].includes(type)) {
                    boxes(payload + (type === 'meta' ? 4 : 0), limit, depth + 1);
                }
                offset += length;
            }
        };
        boxes(0, bytes.length);
    }
    return result;
};

const removeIdle = state => {
    if (!idle.delete(state)) return;
    idleBytes -= state.bytes;
};

export function createImageResource({ kind = 'image', name = '', load }) {
    let current;
    let disposed = false;
    const abortError = () => new DOMException('Image request cancelled', 'AbortError');
    const clear = (state, error = abortError()) => {
        removeIdle(state);
        state.evictOnRelease = true;
        state.controller.abort();
        state.blob = null;
        if (state.url) { URL.revokeObjectURL(state.url); state.url = null; }
        state.users.forEach(user => user.reject(error));
        if (current === state) current = null;
    };
    const retain = state => {
        idle.set(state, true);
        idleBytes += state.bytes;
        while (idle.size > 12 || idleBytes > 32 * 1024 * 1024) {
            idle.keys().next().value.evict();
        }
    };
    return {
        async acquire({ signal, automatic = false } = {}) {
            if (disposed || signal?.aborted) throw abortError();
            if (!current) {
                const state = { controller: new AbortController(), users: new Set(), url: null, bytes: 0 };
                state.evict = () => clear(state);
                current = state;
                state.promise = Promise.resolve().then(async () => {
                    const capability = await load(state.controller.signal);
                    let blob;
                    try {
                        state.controller.signal.throwIfAborted();
                        const response = await fetch(capability.url, { signal: state.controller.signal });
                        if (!response.ok) throw new Error('image_preview_failed');
                        blob = await response.blob();
                    } finally { capability.dispose?.(); }
                    state.controller.signal.throwIfAborted();
                    const details = await inspectImage(blob);
                    state.controller.signal.throwIfAborted();
                    state.pixels = details.width * details.height;
                    state.animated = details.animated || /^image\/gif$/i.test(blob.type) || /\.gif$/i.test(name);
                    state.blob = blob;
                    state.bytes = blob.size;
                }).catch(error => { clear(state, error); throw error; });
            }
            const state = current;
            removeIdle(state);
            const user = {};
            state.users.add(user);
            let rejectAborted;
            const released = new Promise((_resolve, reject) => { rejectAborted = reject; });
            user.reject = rejectAborted;
            const release = () => {
                signal?.removeEventListener('abort', release);
                if (!state.users.delete(user)) return;
                rejectAborted(abortError());
                if (!state.users.size) {
                    if ((state.ready || state.blob) && !state.evictOnRelease && !disposed) retain(state);
                    else clear(state);
                }
            };
            signal?.addEventListener('abort', release, { once: true });
            try {
                await Promise.race([state.promise, released]);
                if (automatic && (!state.pixels || state.pixels > AUTOMATIC_PIXEL_LIMIT)) {
                    throw Object.assign(new Error('image_preview_deferred'), { code: 'image_preview_deferred' });
                }
                state.urlPromise ||= state.promise.then(async () => {
                    state.controller.signal.throwIfAborted();
                    let blob = state.blob;
                    state.blob = null;
                    if (kind === 'heic') blob = blob.slice(0, blob.size, 'image/heic');
                    state.url = URL.createObjectURL(blob);
                    if (kind === 'heic') {
                        const image = new Image();
                        image.src = state.url;
                        try { await image.decode(); }
                        catch {
                            state.controller.signal.throwIfAborted();
                            const { heicTo } = await import(/* webpackChunkName: "preview-heic" */ 'heic-to/csp');
                            state.controller.signal.throwIfAborted();
                            const converted = await heicTo({ blob, type: 'image/jpeg', quality: 0.9 });
                            state.controller.signal.throwIfAborted();
                            URL.revokeObjectURL(state.url);
                            state.url = URL.createObjectURL(converted);
                            blob = converted;
                        } finally { image.removeAttribute('src'); }
                    }
                    state.controller.signal.throwIfAborted();
                    state.bytes = Math.max(blob.size, state.pixels * 4);
                    state.ready = true;
                    return state.url;
                }).catch(error => { clear(state, error); throw error; });
                const url = await Promise.race([state.urlPromise, released]);
                return { url, animated: state.animated, release };
            } catch (error) { release(); throw error; }
        },
        clear() {
            if (!current) return;
            if (current.users.size) current.evictOnRelease = true;
            else clear(current);
        },
        dispose() {
            disposed = true;
            if (current) clear(current);
        }
    };
}
