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
