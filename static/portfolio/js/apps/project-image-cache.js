export class ProjectImageCache {
    constructor({ maxBytes = 48 * 1024 * 1024, maxEntries = 6 } = {}) {
        this.maxBytes = maxBytes;
        this.maxEntries = maxEntries;
        this.entries = new Map();
        this.pending = new Map();
        this.bytes = 0;
        this.activeSource = null;
    }

    peek(source) {
        const entry = this.entries.get(source);
        if (entry) {
            this.entries.delete(source);
            this.entries.set(source, entry);
        }
        return entry;
    }

    setActive(source) {
        this.activeSource = source;
        this.peek(source);
        this.trim();
    }

    get(source, { priority = 'high', width = 0, height = 0 } = {}) {
        const cached = priority === 'low' ? this.entries.get(source) : this.peek(source);
        if (cached) return Promise.resolve(cached);
        if (this.pending.has(source)) return this.pending.get(source).promise;

        const reservedBytes = width * height * 4;
        const pendingBytes = [...this.pending.values()].reduce((sum, request) => sum + request.reservedBytes, 0);
        if (priority === 'low' && (this.bytes + pendingBytes + reservedBytes > this.maxBytes
            || this.entries.size + this.pending.size >= this.maxEntries)) {
            return Promise.reject(new DOMException('Image exceeds the preview cache budget', 'AbortError'));
        }
        const request = { controller: new AbortController(), image: null, url: null, reservedBytes };
        this.pending.set(source, request);
        request.promise = this.load(source, request, priority);
        return request.promise;
    }

    async load(source, request, priority) {
        const { signal } = request.controller;
        const timeout = setTimeout(() => request.controller.abort(new DOMException('Image loading timed out', 'TimeoutError')), 30000);
        try {
            const response = await fetch(source, { signal, priority });
            if (!response.ok) throw new Error(`Image request failed: ${response.status}`);
            const blob = await response.blob();
            signal.throwIfAborted();
            request.reservedBytes += blob.size;
            if (priority === 'low' && source !== this.activeSource && this.bytes + [...this.pending.values()].reduce((sum, pending) => sum + pending.reservedBytes, 0) > this.maxBytes) {
                throw new DOMException('Image exceeds the preview cache budget', 'AbortError');
            }
            request.url = URL.createObjectURL(blob);
            request.image = new Image();
            request.image.decoding = 'async';
            request.image.src = request.url;
            await Promise.race([
                request.image.decode(),
                new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
            ]);
            signal.throwIfAborted();

            const { naturalWidth: width, naturalHeight: height } = request.image;
            const entry = { url: request.url, image: request.image, width, height, bytes: width * height * 4 + blob.size };
            request.url = null;
            request.image = null;
            if (priority === 'low' && source !== this.activeSource
                && (this.bytes + entry.bytes > this.maxBytes || this.entries.size >= this.maxEntries)) {
                this.release(entry);
                throw new DOMException('Image exceeds the preview cache budget', 'AbortError');
            }
            this.entries.set(source, entry);
            this.bytes += entry.bytes;
            this.trim();
            if (!this.entries.has(source)) throw new DOMException('Image exceeds the preview cache budget', 'AbortError');
            return entry;
        } finally {
            clearTimeout(timeout);
            this.release(request);
            if (this.pending.get(source) === request) this.pending.delete(source);
        }
    }

    trim() {
        for (const [source, entry] of this.entries) {
            if (this.bytes <= this.maxBytes && this.entries.size <= this.maxEntries) break;
            if (source === this.activeSource) continue;
            this.entries.delete(source);
            this.bytes -= entry.bytes;
            this.release(entry);
        }
    }

    release(entry) {
        entry.image?.removeAttribute('src');
        entry.image = null;
        if (entry.url) URL.revokeObjectURL(entry.url);
        entry.url = null;
    }

    cancelPending(exceptSource) {
        for (const [source, request] of this.pending) {
            if (source === exceptSource) continue;
            this.pending.delete(source);
            request.controller.abort();
            this.release(request);
        }
    }

    clear() {
        this.cancelPending();
        for (const entry of this.entries.values()) this.release(entry);
        this.entries.clear();
        this.bytes = 0;
        this.activeSource = null;
    }
}
