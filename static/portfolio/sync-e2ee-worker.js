const PREFIX = new URL('__sync-e2ee__/', self.registration.scope).pathname;
const CIPHER_CHUNK = 8 * 1024 * 1024;
const CLEAR_CHUNK = CIPHER_CHUNK - 16;
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
const prepare = async (descriptor, owner) => {
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
    return { owner, url: url.href, metadata, download: descriptor.download === true, key, noncePrefix: bytes(metadata.noncePrefix, 8), controllers: new Set(), pendingChunks: new Map(), cachedChunk: null };
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
        if (entry) entry.cachedChunk = null;
        entries.delete(token);
    } else if (type === 'open') event.waitUntil((async () => {
        try {
            const entry = await prepare(descriptor, event.source.id);
            if (revoked.has(`${event.source.id}:${token}`)) throw new Error('encrypted_file_unavailable');
            entries.set(token, entry);
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
    if (entry) return entry.owner === owner ? entry : null;
    if (!pending.has(capability)) pending.set(capability, (async () => {
        const descriptor = await new Promise(resolve => {
            const channel = new MessageChannel();
            const timer = setTimeout(() => { channel.port1.close(); resolve(null); }, 10000);
            channel.port1.onmessage = ({ data }) => { clearTimeout(timer); channel.port1.close(); resolve(data); };
            client.postMessage({ source: 'gavin-sync-e2ee', type: 'resolve', token }, [channel.port2]);
        });
        if (!descriptor || revoked.has(capability)) return null;
        const recovered = await prepare(descriptor, owner);
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
    const response = await fetch(entry.url, {
        headers: { Range: `bytes=${start}-${end}` }, credentials: 'omit', cache: 'no-store', redirect: 'error', signal
    });
    if (response.status !== 206 || !response.body) throw new Error('encrypted_file_unavailable');
    const total = entry.metadata.size + Math.ceil(entry.metadata.size / CLEAR_CHUNK) * 16;
    if (response.headers.get('Content-Range') !== `bytes ${start}-${end}/${total}`) throw new Error('invalid_file');
    const encrypted = new Uint8Array(clearSize + 16);
    const reader = response.body.getReader();
    let offset = 0;
    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            if (offset + value.byteLength > encrypted.length) throw new Error('invalid_file');
            encrypted.set(value, offset);
            offset += value.byteLength;
        }
        if (offset !== encrypted.length) throw new Error('invalid_file');
    } catch (error) { await reader.cancel().catch(() => {}); throw error; }
    const nonce = new Uint8Array(12);
    nonce.set(entry.noncePrefix);
    new DataView(nonce.buffer).setUint32(8, index);
    const additionalData = new TextEncoder().encode(`gavin-sync-file-v1:${entry.metadata.fileId}:${index}`);
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce, additionalData }, entry.key, encrypted));
};
const readChunk = async (entry, index, signal) => {
    signal.throwIfAborted();
    if (entry.cachedChunk?.index === index) return entry.cachedChunk.bytes;
    let flight = entry.pendingChunks.get(index);
    if (!flight || flight.controller.signal.aborted) {
        const controller = new AbortController();
        flight = { controller, consumers: new Set() };
        entry.controllers.add(controller);
        flight.promise = fetchChunk(entry, index, controller.signal).then(bytes => {
            controller.signal.throwIfAborted();
            entry.cachedChunk = { index, bytes };
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
const releaseDownload = async (entry, owner, token) => {
    revoked.add(`${owner}:${token}`);
    entry.cachedChunk = null;
    entry.controllers.forEach(controller => controller.abort());
    entries.delete(token);
    const client = await self.clients.get(owner);
    client?.postMessage({ source: 'gavin-sync-e2ee', type: 'released', token });
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
        if (event.request.method === 'GET' && entry.download && size === 0) await releaseDownload(entry, owner, token);
        return new Response(null, { status, headers });
    }
    const controller = new AbortController();
    entry.controllers.add(controller);
    let index = Math.floor(start / CLEAR_CHUNK);
    const last = Math.floor((end - 1) / CLEAR_CHUNK);
    const stream = new ReadableStream({
        async pull(output) {
            try {
                const chunk = await readChunk(entry, index, controller.signal);
                controller.signal.throwIfAborted();
                output.enqueue(chunk.subarray(Math.max(0, start - index * CLEAR_CHUNK), Math.min(chunk.length, end - index * CLEAR_CHUNK)));
                if (index++ === last) {
                    output.close();
                    entry.controllers.delete(controller);
                    if (entry.download && !range) {
                        await releaseDownload(entry, owner, token);
                    }
                }
            } catch {
                controller.abort();
                entry.controllers.delete(controller);
                output.error(new Error('encrypted_file_unavailable'));
            }
        },
        cancel() { controller.abort(); entry.controllers.delete(controller); }
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
