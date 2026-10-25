const idle = new Map();
let idleBytes = 0;
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
        async acquire({ signal } = {}) {
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
                    state.animated = /^image\/(gif|png|apng|webp|avif)$/i.test(blob.type) || /\.(gif|png|apng|webp|avif)$/i.test(name);
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
                    state.bytes = blob.size;
                    state.ready = true;
                    return state.url;
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
                    if (state.ready && !state.evictOnRelease && !disposed) retain(state);
                    else clear(state);
                }
            };
            signal?.addEventListener('abort', release, { once: true });
            try {
                const url = await Promise.race([state.promise, released]);
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
