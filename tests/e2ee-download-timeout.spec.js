const { test, expect } = require('@playwright/test');
const { readFileSync } = require('node:fs');
const { createContext, runInContext } = require('node:vm');
const { createCipheriv, webcrypto } = require('node:crypto');

const source = readFileSync(require.resolve('../static/portfolio/sync-e2ee-worker.js'), 'utf8');
const clear = Buffer.from('encrypted slow transfer');
const key = Buffer.alloc(32, 7);
const nonce = Buffer.alloc(12, 0);
const cipher = createCipheriv('aes-256-gcm', key, nonce);
cipher.setAAD(Buffer.from('gavin-sync-file-v1:test-file:0'));
const encrypted = Buffer.concat([cipher.update(clear), cipher.final(), cipher.getAuthTag()]);

async function scenario(respond) {
    let now = 0;
    let nextTimer = 0;
    const timers = new Map();
    const requests = [];
    const scope = createContext({
        URL, Uint8Array, DataView, TextEncoder, AbortController, Response, crypto: webcrypto,
        setTimeout: (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, time: now + delay }); return id; },
        clearTimeout: id => timers.delete(id),
        self: { registration: { scope: 'https://local.test/portfolio/' }, addEventListener() {} },
        fetch: (_url, { signal }) => {
            requests.push(now);
            return respond({ signal, attempt: requests.length });
        }
    });
    runInContext(`${source}\nglobalThis.read = fetchChunk;`, scope);
    const entry = {
        url: 'https://local.test/download', metadata: { size: clear.length, fileId: 'test-file' },
        noncePrefix: new Uint8Array(8), key: await webcrypto.subtle.importKey('raw', key, 'AES-GCM', false, ['decrypt'])
    };
    const controller = new AbortController();
    let settled = false;
    const result = scope.read(entry, 0, controller.signal).then(bytes => {
        settled = true;
        return { bytes: Buffer.from(bytes) };
    }, error => { settled = true; return { error: error.name }; });
    const flush = () => new Promise(setImmediate);
    const advance = async duration => {
        const end = now + duration;
        await flush();
        while (true) {
            const next = [...timers].filter(([, timer]) => timer.time <= end).sort((a, b) => a[1].time - b[1].time)[0];
            if (!next) break;
            now = next[1].time;
            timers.delete(next[0]);
            next[1].callback();
            await flush();
        }
        now = end;
        await flush();
    };
    await flush();
    return { requests, timers, result, controller, advance, settled: () => settled };
}

const response = body => new Response(body, { status: 206, headers: { 'Content-Range': `bytes 0-${encrypted.length - 1}/${encrypted.length}` } });
const stalledBody = signal => new ReadableStream({
    start(controller) {
        controller.enqueue(encrypted.subarray(0, 1));
        signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
    }
});

for (const stage of ['headers', 'body']) test(`retries a ${stage} stall after thirty seconds without losing encrypted bytes`, async () => {
    const transfer = await scenario(({ signal, attempt }) => {
        if (attempt > 1) return response(encrypted);
        return stage === 'body' ? response(stalledBody(signal))
            : new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    });
    await transfer.advance(29999);
    expect(transfer.requests).toEqual([0]);
    expect(transfer.settled()).toBe(false);
    await transfer.advance(501);
    expect(await transfer.result).toEqual({ bytes: clear });
    expect(transfer.requests).toEqual([0, 30500]);
    expect(transfer.timers.size).toBe(0);
});

test('keeps a slow progressing chunk alive beyond the total idle deadline', async () => {
    let output;
    const transfer = await scenario(() => response(new ReadableStream({ start(controller) { output = controller; } })));
    for (let start = 0; start < encrypted.length; start += 10) {
        await transfer.advance(20000);
        output.enqueue(encrypted.subarray(start, start + 10));
        await transfer.advance(0);
    }
    output.close();
    expect(await transfer.result).toEqual({ bytes: clear });
    expect(transfer.requests).toEqual([0]);
    expect(transfer.timers.size).toBe(0);
});

test('user cancellation stops a stalled request without waiting or retrying', async () => {
    const transfer = await scenario(({ signal }) => response(stalledBody(signal)));
    transfer.controller.abort();
    expect(await transfer.result).toEqual({ error: 'AbortError' });
    await transfer.advance(120000);
    expect(transfer.requests).toEqual([0]);
    expect(transfer.timers.size).toBe(0);
});
