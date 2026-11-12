const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { Worker: NodeWorker } = require('node:worker_threads');

const source = readFileSync(resolve(__dirname, '../../static/games/golden-hour/dist/game.js'), 'utf8');
function between(start, end) {
    const first = source.indexOf(start);
    assert.ok(first >= 0, start);
    const last = source.indexOf(end, first + start.length);
    assert.ok(last > first, end);
    return source.slice(first, last);
}
const audioSource = between('function createGoldenAudioDSP()', 'var Xd=');

function digest(sampleRate, cache, keys) {
    const hash = createHash('sha256');
    for (const key of ['ir:in', 'ir:out', ...keys]) {
        hash.update(key);
        for (const [mode, channels] of Object.entries(cache.d[key])) {
            hash.update(mode);
            for (const channel of channels) hash.update(Buffer.from(channel.buffer));
        }
    }
    hash.update(Buffer.from(cache.noise.white.buffer));
    hash.update(Buffer.from(cache.noise.brown.buffer));
    return hash.digest('hex');
}

test('worker PCM matches every original sound byte at both hardware sample rates', async () => {
    let created = 0;
    let terminated = 0;
    let revoked = 0;
    const scripts = new Map();
    const context = vm.createContext({
        Blob: class { constructor(parts) { this.code = parts.join(''); } },
        URL: {
            createObjectURL(blob) { const id = `blob:${scripts.size}`; scripts.set(id, blob.code); return id; },
            revokeObjectURL(id) { scripts.delete(id); revoked += 1; }
        },
        Worker: class {
            constructor(id) {
                created += 1;
                this.worker = new NodeWorker(`
                    const { parentPort } = require('node:worker_threads');
                    globalThis.self = {
                        postMessage(data, transfer) { parentPort.postMessage(data, transfer); },
                        close() { parentPort.close(); }
                    };
                    ${scripts.get(id)}
                    parentPort.on('message', data => self.onmessage({ data }));
                `, { eval: true });
                this.worker.on('message', data => this.onmessage({ data }));
                this.worker.on('error', error => this.onerror({ message: error.message, preventDefault() {} }));
            }
            postMessage(data) { this.worker.postMessage(data); }
            terminate() { terminated += 1; this.worker.terminate(); }
        },
        q1() { throw new Error('working worker must not run DSP on the main thread'); }
    });
    vm.runInContext(audioSource, context);
    context.Nb = () => { throw new Error('main-thread synthesis'); };
    const expected = {
        44100: '797c254d38bb3bc89b345a84c2f916fa8a58ccc85994e716bdd53d59326918d5',
        48000: '2fa70a54659187fb87debb9cf6a22b0eeffbcd867cbefdb4fe2ec3a32e33b1b5'
    };
    for (const sampleRate of [44100, 48000]) {
        const pending = context.prepareGoldenAudioPCM(sampleRate);
        assert.equal(context.prepareGoldenAudioPCM(sampleRate), pending, 'duplicate callers share one worker');
        await pending;
        assert.equal(digest(sampleRate, context.Dw(sampleRate), context.B$()), expected[sampleRate]);
        assert.equal(context.prepareGoldenAudioPCM(sampleRate), pending, 'ready samples are reused');
    }
    assert.equal(created, 2, 'distinct sample rates have independent caches');
    assert.equal(terminated, 2);
    assert.equal(revoked, 2);
    assert.equal(scripts.size, 0);
});

test('a blocked worker yields between original sounds and cleans up before becoming ready', async () => {
    const events = [];
    const cache = { d: {} };
    const context = vm.createContext({
        Blob: class {},
        URL: { createObjectURL: () => 'blob:test', revokeObjectURL: () => events.push('revoke') },
        Worker: class {
            postMessage() { queueMicrotask(() => this.onerror({ message: 'blocked', preventDefault() {} })); }
            terminate() { events.push('terminate'); }
        },
        setTimeout(resolve) { events.push('yield'); queueMicrotask(resolve); },
        window: { __goldenHourWaitForBoot: async () => {} }
    });
    vm.runInContext(audioSource, context);
    context.Dw = () => cache;
    context.B$ = () => ['gun:ar:near:0', 'exp:0'];
    context.tI = (rate, duration, type) => { events.push(type); return new Float32Array(1); };
    context.Nb = (rate, key) => { events.push(key); cache.d[key] = {}; };
    const pending = context.prepareGoldenAudioPCM(48000);
    assert.equal(context.prepareGoldenAudioPCM(48000), pending);
    await pending;
    assert.deepEqual(events, ['yield', 'white', 'brown', 'yield', 'ir:in', 'yield', 'ir:out',
        'yield', 'gun:ar:near:0', 'yield', 'exp:0', 'terminate', 'revoke']);
    assert.equal(Object.keys(cache.d).length, 4);
});

test('boot prepares a suspended audio context without resuming or changing the sample rate', async () => {
    const events = [];
    let finish;
    const engine = {};
    const scope = {
        o: engine,
        AudioContext: class {
            constructor(options) { events.push(options); this.sampleRate = 44100; this.state = 'running'; }
            suspend() { events.push('suspend'); return Promise.resolve(); }
            resume() { throw new Error('preparation must not resume audio'); }
        },
        prepareGoldenAudioPCM(rate) { events.push(rate); return new Promise(resolve => { finish = resolve; }); },
        e(name, error) { throw error; }
    };
    const prepare = vm.runInNewContext(`${between('function prepareAudio()', 'function z0(')};prepareAudio`, scope);
    const first = prepare();
    assert.equal(prepare(), first);
    assert.equal(engine.ctx, undefined, 'playback remains uninitialized until a user gesture');
    assert.equal(engine.preparedContext.sampleRate, 44100);
    finish();
    await first;
    assert.equal(events[0].latencyHint, 'interactive');
    assert.deepEqual(events.slice(1), ['suspend', 44100]);
    const boot = source.slice(source.indexOf('async function As0()'));
    assert.ok(boot.indexOf('let audioReady=fo.prepare()') < boot.indexOf('new BM(o)'));
    assert.ok(boot.indexOf('await audioReady') < boot.indexOf('window.GH.ready=!0'));
});


test('already suspended audio does not block standalone page readiness', async () => {
    const engine = {};
    let preparedRate;
    const prepare = vm.runInNewContext(`${between('function prepareAudio()', 'function z0(')};prepareAudio`, {
        o: engine,
        AudioContext: class {
            constructor() { this.sampleRate = 48000; this.state = 'suspended'; }
            suspend() { return new Promise(() => {}); }
            resume() { throw new Error('preparation must not resume audio'); }
        },
        prepareGoldenAudioPCM(rate) { preparedRate = rate; return Promise.resolve(); },
        e(name, error) { throw error; }
    });
    await prepare();
    assert.equal(preparedRate, 48000);
    assert.equal(engine.preparedContext.state, 'suspended');
    assert.equal(engine.ctx, undefined);
});
