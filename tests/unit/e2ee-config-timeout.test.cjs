const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createContext, runInContext } = require('node:vm');

const source = readFileSync(require.resolve('../../static/portfolio/sync-e2ee-worker.js'), 'utf8');

for (const stage of ['headers', 'body']) test(`a stalled config ${stage} request expires and the next file can retry`, async () => {
    const timers = new Map();
    let requests = 0;
    let signal;
    const scope = createContext({
        URL, AbortController,
        self: { registration: { scope: 'https://local.test/' }, addEventListener() {} },
        setTimeout: (callback, delay) => { timers.set(callback, delay); return callback; },
        clearTimeout: callback => timers.delete(callback),
        fetch: async (_url, options) => {
            requests++;
            signal = options.signal;
            if (requests > 1) return Response.json({ apiBase: 'https://sync.test' });
            if (stage === 'headers') return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
            return new Response(new ReadableStream({ start(controller) {
                controller.enqueue(new TextEncoder().encode('{"apiBase":'));
                signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
            } }));
        }
    });
    runInContext(`${source}\nglobalThis.getApi = getApi;`, scope);
    const first = scope.getApi();
    assert.equal(scope.getApi(), first);
    const failed = assert.rejects(first, { name: 'AbortError' });
    await new Promise(setImmediate);
    assert.equal(requests, 1);
    assert.deepEqual([...timers.values()], [10000]);
    for (const timeout of timers.keys()) timeout();
    await failed;
    assert.equal(signal.aborted, true);
    assert.equal(timers.size, 0);
    const retry = scope.getApi();
    assert.equal(scope.getApi(), retry);
    assert.equal((await retry).href, 'https://sync.test/');
    assert.equal((await scope.getApi()).href, 'https://sync.test/');
    assert.equal(requests, 2);
    assert.equal(timers.size, 0);
});
