const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const source = readFileSync('static/portfolio/js/apps/project-image-cache.js', 'utf8');
const modulePromise = import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

test('honor prefetch rejects oversized dimensions before network or decoding and reserves pending memory', async t => {
    const { ProjectImageCache } = await modulePromise;
    let requests = 0;
    let release;
    t.mock.method(globalThis, 'fetch', async () => {
        requests++;
        await new Promise(resolve => { release = resolve; });
        return new Response(new Uint8Array(10));
    });
    const cache = new ProjectImageCache({ maxBytes: 24 * 1024 * 1024 });
    cache.bytes = 5 * 1024 * 1024;
    await assert.rejects(cache.get('large-honor.webp', { priority: 'low', width: 1961, height: 2694 }), { name: 'AbortError' });
    assert.equal(requests, 0);
    const pending = cache.get('first.webp', { priority: 'low', width: 2000, height: 2000 });
    await assert.rejects(cache.get('second.webp', { priority: 'low', width: 2000, height: 2000 }), { name: 'AbortError' });
    assert.equal(requests, 1);
    cache.cancelPending();
    release();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(cache.pending.size, 0);
});

test('encoded image bytes are included before allocating the decoded bitmap', async t => {
    const { ProjectImageCache } = await modulePromise;
    t.mock.method(globalThis, 'fetch', async () => new Response(new Uint8Array(1000)));
    const cache = new ProjectImageCache({ maxBytes: 4500 });
    await assert.rejects(cache.get('image.webp', { priority: 'low', width: 32, height: 32 }), { name: 'AbortError' });
    assert.equal(cache.pending.size, 0);
});

for (const stage of ['body', 'decode']) test(`an image timeout releases ${stage} work and permits a fresh request`, async t => {
    const { ProjectImageCache } = await modulePromise;
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let resolveDecode;
    let requests = 0;
    const revoked = [];
    const images = [];
    const originalImage = globalThis.Image;
    globalThis.Image = class {
        naturalWidth = 32;
        naturalHeight = 32;
        constructor() { images.push(this); }
        decode() { return requests === 1 ? new Promise(resolve => { resolveDecode = resolve; }) : Promise.resolve(); }
        removeAttribute() { this.src = ''; }
    };
    t.after(() => { if (originalImage) globalThis.Image = originalImage; else delete globalThis.Image; });
    t.mock.method(URL, 'createObjectURL', () => `blob:image-${requests}`);
    t.mock.method(URL, 'revokeObjectURL', value => revoked.push(value));
    t.mock.method(globalThis, 'fetch', async (_source, { signal }) => {
        requests++;
        if (requests > 1 || stage === 'decode') return new Response(new Uint8Array(10));
        return new Response(new ReadableStream({ start(controller) {
            controller.enqueue(new Uint8Array(1));
            signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
        } }));
    });
    const cache = new ProjectImageCache();
    const rejected = assert.rejects(cache.get('photo.webp'), { name: 'TimeoutError' });
    await new Promise(resolve => setImmediate(resolve));
    t.mock.timers.tick(30000);
    await rejected;
    assert.equal(cache.pending.size, 0);
    assert.equal(cache.bytes, 0);
    if (stage === 'decode') {
        assert.deepEqual(revoked, ['blob:image-1']);
        assert.equal(images[0].src, '');
    }
    const fresh = await cache.get('photo.webp');
    resolveDecode?.();
    assert.equal(fresh.url, 'blob:image-2');
    assert.equal(cache.peek('photo.webp'), fresh);
    cache.clear();
});
