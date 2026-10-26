const PREFIX = new URL('__sync-e2ee__/', self.registration.scope).pathname;
const CIPHER_CHUNK = 8 * 1024 * 1024;
const CLEAR_CHUNK = CIPHER_CHUNK - 16;
const DOWNLOAD_IDLE_MS = 60000;
const CHUNK_IDLE_MS = 30000;
const entries = new Map();
const pending = new Map();
const revoked = new Set();
let configPromise;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

const bytes = (value, length) => {
    const decoded = typeof value === 'string'
        ? Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0))
        : new Uint8Array(value);
    if (decoded.byteLength !== length) throw new Error('invalid_file');
    return decoded;
};
const getApi = () => {
    if (!configPromise) configPromise = fetch(new URL('sync-config.json', self.registration.scope), { cache: 'no-store' })
        .then(async response => {
            if (!response.ok) throw new Error('unavailable');
            const { apiBase } = await response.json();
            const api = new URL(apiBase);
            if (api.protocol !== 'https:' && !(api.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(api.hostname))) throw new Error('invalid_endpoint');
            return api;
        }).catch(error => { configPromise = null; throw error; });
    return configPromise;
};
const prepare = async (descriptor, owner, token) => {
    const api = await getApi();
    const url = new URL(descriptor.url);
    const basePath = api.pathname.replace(/\/$/, '');
    if (url.origin !== api.origin || url.username || url.password || url.hash
        || !url.pathname.startsWith(`${basePath}/v1/spaces/`) || !/\/downloads\/[^/]+$/.test(url.pathname)) throw new Error('invalid_endpoint');
    const metadata = descriptor.metadata;
    if (!Number.isSafeInteger(metadata.size) || metadata.size < 0 || metadata.size > 2 * 1024 ** 3
        || typeof metadata.fileId !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(metadata.fileId)
        || typeof metadata.name !== 'string' || metadata.name.length > 1024
        || typeof metadata.type !== 'string' || !/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/.test(metadata.type)) throw new Error('invalid_file');
    const key = await crypto.subtle.importKey('raw', bytes(metadata.key, 32), 'AES-GCM', false, ['decrypt']);
    const download = descriptor.download === true;
    if (download && descriptor.expiresAt && descriptor.expiresAt <= Date.now()) throw new Error('encrypted_file_unavailable');
    return { owner, token, url: url.href, metadata, download, key, noncePrefix: bytes(metadata.noncePrefix, 8), controllers: new Set(), pendingChunks: new Map(), cachedChunks: new Map(), streamCount: 0, expiresAt: download ? descriptor.expiresAt : null, expiryTimer: null };
};
const trustedClient = (client) => client?.type === 'window' && new URL(client.url).origin === self.location.origin
    && new URL(client.url).pathname.startsWith(new URL(self.registration.scope).pathname);

self.addEventListener('message', (event) => {
    if (event.data?.source !== 'gavin-sync-e2ee' || !trustedClient(event.source)) return;
    const { type, token, descriptor } = event.data;
    if (typeof token !== 'string' || !/^[a-f0-9]{48}$/.test(token)) return;
    if (type === 'close') {
        const entry = entries.get(token);
        if (entry && entry.owner !== event.source.id) return;
        revoked.add(`${event.source.id}:${token}`);
        entry?.controllers.forEach(controller => controller.abort());
        if (entry) { entry.cachedChunks.clear(); clearTimeout(entry.expiryTimer); }
        entries.delete(token);
    } else if (type === 'open') event.waitUntil((async () => {
        try {
            const entry = await prepare(descriptor, event.source.id, token);
            if (revoked.has(`${event.source.id}:${token}`)) throw new Error('encrypted_file_unavailable');
            entries.set(token, entry);
            if (entry.download) expireDownload(entry, entry.owner, token, entry.expiresAt);
            const url = new URL(`${PREFIX}${encodeURIComponent(entry.owner)}/${token}`, self.location.origin);
            event.ports[0]?.postMessage({ url: url.href });
        } catch { event.ports[0]?.postMessage({ error: 'encrypted_file_unavailable' }); }
    })());
});

const resolve = async (owner, token) => {
    const capability = `${owner}:${token}`;
    if (revoked.has(capability)) return null;
    const client = await self.clients.get(owner);
    if (!trustedClient(client)) return null;
    let entry = entries.get(token);
    if (entry) {
        if (entry.owner !== owner) return null;
        if (entry.expiresAt && entry.expiresAt <= Date.now()) { await releaseDownload(entry, owner, token); return null; }
        return entry;
    }
    if (!pending.has(capability)) pending.set(capability, (async () => {
        const descriptor = await new Promise(resolve => {
            const channel = new MessageChannel();
            const timer = setTimeout(() => { channel.port1.close(); resolve(null); }, 10000);
            channel.port1.onmessage = ({ data }) => { clearTimeout(timer); channel.port1.close(); resolve(data); };
            client.postMessage({ source: 'gavin-sync-e2ee', type: 'resolve', token }, [channel.port2]);
        });
        if (!descriptor || revoked.has(capability)) return null;
        const recovered = await prepare(descriptor, owner, token);
        if (revoked.has(capability)) return null;
        entries.set(token, recovered);
        return recovered;
    })().finally(() => pending.delete(capability)));
    return pending.get(capability);
};
const fetchChunk = async (entry, index, signal) => {
    const clearSize = Math.min(CLEAR_CHUNK, entry.metadata.size - index * CLEAR_CHUNK);
    const start = index * CIPHER_CHUNK;
    const end = start + clearSize + 15;
    const total = entry.metadata.size + Math.ceil(entry.metadata.size / CLEAR_CHUNK) * 16;
    const encrypted = new Uint8Array(clearSize + 16);
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
        signal.throwIfAborted();
        const request = new AbortController();
        const abort = () => request.abort(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        let timedOut = false;
        let idleTimer;
        const progress = () => {
            clearTimeout(idleTimer);
            idleTimer = setTimeout(() => { timedOut = true; request.abort(); }, CHUNK_IDLE_MS);
        };
        progress();
        try {
            const response = await fetch(entry.url, {
                headers: { Range: `bytes=${start}-${end}` }, credentials: 'omit', cache: 'no-store', redirect: 'error', signal: request.signal
            });
            progress();
            if (response.status !== 206 || !response.body) {
                await response.body?.cancel();
                clearTimeout(idleTimer);
                if ([401, 404].includes(response.status) && !refreshed) {
                    if (!entry.refreshPromise) entry.refreshPromise = (async () => {
                        const client = await self.clients.get(entry.owner);
                        if (!trustedClient(client)) throw new Error('encrypted_file_unavailable');
                        const url = await new Promise(resolve => {
                            const channel = new MessageChannel();
                            const timer = setTimeout(() => { channel.port1.close(); resolve(null); }, 15000);
                            channel.port1.onmessage = ({ data }) => { clearTimeout(timer); channel.port1.close(); resolve(data); };
                            client.postMessage({ source: 'gavin-sync-e2ee', type: 'refresh', token: entry.token }, [channel.port2]);
                        });
                        if (typeof url !== 'string' || entries.get(entry.token) !== entry) throw new Error('encrypted_file_unavailable');
                        const previous = new URL(entry.url);
                        const next = new URL(url);
                        if (next.origin !== previous.origin || next.username || next.password || next.search || next.hash
                            || next.pathname.slice(0, next.pathname.lastIndexOf('/') + 1) !== previous.pathname.slice(0, previous.pathname.lastIndexOf('/') + 1)
                            || !/^[0-9a-f]{64}$/.test(next.pathname.split('/').pop())) throw new Error('invalid_endpoint');
                        entry.url = next.href;
                    })();
                    await entry.refreshPromise;
                    signal.throwIfAborted();
                    refreshed = true;
                    attempt--;
                    continue;
                }
                const retryAfter = response.headers.get('Retry-After');
                const delay = retryAfter !== null && Number.isFinite(Number(retryAfter))
                    ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now();
                throw Object.assign(new Error('encrypted_file_unavailable'), {
                    retryable: response.status === 408 || response.status === 429 || response.status >= 500,
                    retryAfter: Number.isFinite(delay) ? Math.max(0, delay) : 0
                });
            }
            if (response.headers.get('Content-Range') !== `bytes ${start}-${end}/${total}`) {
                await response.body.cancel();
                throw new Error('invalid_file');
            }
            const reader = response.body.getReader();
            let offset = 0;
            try {
                while (true) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    if (offset + value.byteLength > encrypted.length) throw new Error('invalid_file');
                    encrypted.set(value, offset);
                    offset += value.byteLength;
                    if (value.byteLength) progress();
                }
                if (offset !== encrypted.length) throw Object.assign(new Error('encrypted_file_unavailable'), { retryable: true });
            } catch (error) { await reader.cancel().catch(() => {}); throw error; }
            break;
        } catch (error) {
            clearTimeout(idleTimer);
            signal.throwIfAborted();
            if (timedOut) error = Object.assign(new Error('encrypted_file_unavailable'), { retryable: true });
            if (attempt >= 2 || (!error.retryable && error.name !== 'TypeError')) throw error;
            await new Promise((resolve, reject) => {
                const abort = () => { clearTimeout(timer); reject(signal.reason); };
                const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, Math.max(500 * 2 ** attempt, error.retryAfter || 0));
                signal.addEventListener('abort', abort, { once: true });
                if (signal.aborted) abort();
            });
        } finally {
            clearTimeout(idleTimer);
            signal.removeEventListener('abort', abort);
        }
    }
    const nonce = new Uint8Array(12);
    nonce.set(entry.noncePrefix);
    new DataView(nonce.buffer).setUint32(8, index);
    const additionalData = new TextEncoder().encode(`gavin-sync-file-v1:${entry.metadata.fileId}:${index}`);
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce, additionalData }, entry.key, encrypted));
};
const readChunk = async (entry, index, signal) => {
    signal.throwIfAborted();
    if (entry.cachedChunks.has(index)) {
        const bytes = entry.cachedChunks.get(index);
        entry.cachedChunks.delete(index);
        entry.cachedChunks.set(index, bytes);
        return bytes;
    }
    let flight = entry.pendingChunks.get(index);
    if (!flight || flight.controller.signal.aborted) {
        const controller = new AbortController();
        flight = { controller, consumers: new Set() };
        entry.controllers.add(controller);
        flight.promise = fetchChunk(entry, index, controller.signal).then(bytes => {
            controller.signal.throwIfAborted();
            if (!entry.download) {
                entry.cachedChunks.set(index, bytes);
                if (entry.cachedChunks.size > 3) entry.cachedChunks.delete(entry.cachedChunks.keys().next().value);
            }
            return bytes;
        }).finally(() => {
            if (entry.pendingChunks.get(index) === flight) entry.pendingChunks.delete(index);
            entry.controllers.delete(controller);
        });
        entry.pendingChunks.set(index, flight);
    }
    flight.consumers.add(signal);
    const abort = () => {
        flight.consumers.delete(signal);
        if (!flight.consumers.size) flight.controller.abort();
    };
    signal.addEventListener('abort', abort, { once: true });
    try { return await flight.promise; }
    finally {
        signal.removeEventListener('abort', abort);
        flight.consumers.delete(signal);
    }
};
const releaseDownload = async (entry, owner, token, status = 'disposed') => {
    clearTimeout(entry.expiryTimer);
    revoked.add(`${owner}:${token}`);
    entry.cachedChunks.clear();
    entry.controllers.forEach(controller => controller.abort());
    entries.delete(token);
    const client = await self.clients.get(owner);
    client?.postMessage({ source: 'gavin-sync-e2ee', type: 'released', token, status });
};
const expireDownload = (entry, owner, token, expiresAt = Date.now() + DOWNLOAD_IDLE_MS) => {
    clearTimeout(entry.expiryTimer);
    entry.expiresAt = expiresAt;
    entry.expiryTimer = setTimeout(() => {
        if (entries.get(token) === entry && !entry.streamCount) releaseDownload(entry, owner, token);
    }, Math.max(0, expiresAt - Date.now()));
};
const downloadState = async (entry, owner, token, status) => {
    const client = await self.clients.get(owner);
    client?.postMessage({ source: 'gavin-sync-e2ee', type: 'download-state', token, status, expiresAt: entry.expiresAt });
};
const serve = async (event, owner, token) => {
    const entry = await resolve(owner, token);
    if (!entry || (event.clientId && event.clientId !== owner && event.request.mode !== 'navigate')) return new Response(null, { status: 404 });
    if (!['GET', 'HEAD'].includes(event.request.method)) return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
    const { size, type, name } = entry.metadata;
    const headers = new Headers({
        'Content-Type': type, 'Content-Length': String(size), 'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin',
        'Content-Security-Policy': "sandbox; default-src 'none'",
        'Content-Disposition': `${entry.download ? 'attachment' : 'inline'}; filename="download"; filename*=UTF-8''${encodeURIComponent(name)}`
    });
    let start = 0;
    let end = size;
    let status = 200;
    const range = event.request.method === 'GET' && event.request.headers.get('Range');
    if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (match && (match[1] || match[2])) {
            if (match[1]) {
                start = Number(match[1]);
                end = match[2] ? Math.min(size, Number(match[2]) + 1) : size;
            } else start = Math.max(0, size - Number(match[2]));
        }
        if (!match || (!match[1] && !match[2]) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= end || start >= size) {
            headers.set('Content-Range', `bytes */${size}`);
            headers.set('Content-Length', '0');
            return new Response(null, { status: 416, headers });
        }
        status = 206;
        headers.set('Content-Range', `bytes ${start}-${end - 1}/${size}`);
        headers.set('Content-Length', String(end - start));
    }
    if (event.request.method === 'HEAD' || size === 0) {
        if (event.request.method === 'GET' && entry.download && size === 0) await releaseDownload(entry, owner, token, 'delivered');
        return new Response(null, { status, headers });
    }
    const controller = new AbortController();
    entry.controllers.add(controller);
    if (entry.download) {
        clearTimeout(entry.expiryTimer);
        entry.expiresAt = null;
        entry.streamCount++;
        await downloadState(entry, owner, token);
    }
    let settled = false;
    const finish = async status => {
        if (settled) return;
        settled = true;
        event.request.signal.removeEventListener('abort', abortRequest);
        entry.controllers.delete(controller);
        if (!entry.download) return;
        entry.streamCount--;
        if (entries.get(token) !== entry) return;
        if (status === 'delivered' && !range) entry.delivered = true;
        if (!entry.streamCount) {
            if (entry.delivered) { await releaseDownload(entry, owner, token, 'delivered'); return; }
            expireDownload(entry, owner, token);
        }
        await downloadState(entry, owner, token, status === 'delivered' ? null : status);
    };
    const abortRequest = () => { controller.abort(event.request.signal.reason); return finish('cancelled'); };
    event.request.signal.addEventListener('abort', abortRequest, { once: true });
    if (event.request.signal.aborted) await abortRequest();
    let index = Math.floor(start / CLEAR_CHUNK);
    const last = Math.floor((end - 1) / CLEAR_CHUNK);
    const stream = new ReadableStream({
        async pull(output) {
            let chunk;
            try {
                chunk = await readChunk(entry, index, controller.signal);
                controller.signal.throwIfAborted();
            } catch {
                const cancelled = event.request.signal.aborted || controller.signal.aborted;
                controller.abort();
                await finish(cancelled ? 'cancelled' : 'failed');
                output.error(new Error('encrypted_file_unavailable'));
                return;
            }
            const complete = index === last;
            try {
                output.enqueue(chunk.subarray(Math.max(0, start - index * CLEAR_CHUNK), Math.min(chunk.length, end - index * CLEAR_CHUNK)));
                if (complete) output.close();
            } catch {
                controller.abort();
                await finish('cancelled');
                return;
            }
            index++;
            if (complete) await finish('delivered');
        },
        cancel() { controller.abort(); return finish('cancelled'); }
    }, { highWaterMark: 0 });
    return new Response(stream, { status, headers });
};
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    if (url.origin !== self.location.origin || !url.pathname.startsWith(PREFIX)) return;
    const parts = url.pathname.slice(PREFIX.length).split('/');
    event.respondWith((async () => {
        try {
            if (parts.length !== 2 || !/^[a-f0-9]{48}$/.test(parts[1])) return new Response(null, { status: 404 });
            return await serve(event, decodeURIComponent(parts[0]), parts[1]);
        } catch { return new Response(null, { status: 502, headers: { 'Cache-Control': 'no-store' } }); }
    })());
});
