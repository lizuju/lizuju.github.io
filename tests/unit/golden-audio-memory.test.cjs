const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');

const source = readFileSync(resolve(__dirname, '../../static/games/golden-hour/dist/game.js'), 'utf8');
function between(start, end) {
    const first = source.indexOf(start);
    const last = source.indexOf(end, first + start.length);
    assert.ok(first >= 0 && last > first, start);
    return source.slice(first, last);
}
const dspSource = between('function createGoldenAudioDSP()', 'var Xd=');
const copySource = between('function m(J)', 'function x(J,Q)');
const noiseSource = between('function E(J)', 'o.master=i(o.vol.master)');

function runtime(sampleRate) {
    let copies = 0;
    let failChannel = -1;
    const context = {
        sampleRate,
        createBuffer(numberOfChannels, length, rate) {
            copies += 1;
            const channels = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
            return {
                numberOfChannels, length, sampleRate: rate,
                getChannelData(index) {
                    if (index === failChannel) throw new Error('copy interrupted');
                    return channels[index];
                }
            };
        }
    };
    const scope = new Function('context', 'performance', `
        let Blob, URL, Worker;
        ${dspSource}
        let o = { ctx: context, abuf: {}, buf: {}, stats: { bakeMs: 0 } };
        ${copySource}
        ${noiseSource}}
        return {
            Dw, B$, tI, p, E, prepareGoldenAudioPCM,
            get o() { return o; }, set o(value) { o = value; },
            get Nb() { return Nb; }, set Nb(value) { Nb = value; },
            set Blob(value) { Blob = value; }, set URL(value) { URL = value; },
            set Worker(value) { Worker = value; }
        };
    `)(context);
    return { scope, context, copies: () => copies, failAt: index => { failChannel = index; } };
}

const digestChannels = channels => {
    const hash = createHash('sha256');
    for (const channel of channels) hash.update(Buffer.from(channel.buffer, channel.byteOffset, channel.byteLength));
    return hash.digest('hex');
};
const bufferChannels = buffer => Array.from({ length: buffer.numberOfChannels }, (_, index) => buffer.getChannelData(index));

test('all original PCM modes transfer byte-for-byte at 44.1 and 48 kHz, releasing each copied mode', () => {
    const expected = {
        44100: '797c254d38bb3bc89b345a84c2f916fa8a58ccc85994e716bdd53d59326918d5',
        48000: '2fa70a54659187fb87debb9cf6a22b0eeffbcd867cbefdb4fe2ec3a32e33b1b5'
    };
    for (const sampleRate of [44100, 48000]) {
        const { scope } = runtime(sampleRate);
        const cache = scope.Dw(sampleRate);
        const allSounds = createHash('sha256');
        for (const key of ['ir:in', 'ir:out', ...scope.B$()]) {
            const sound = scope.Nb(sampleRate, key);
            const modes = Object.keys(sound);
            allSounds.update(key);
            for (const mode of modes) {
                const pcm = sound[mode];
                const original = digestChannels(pcm);
                const buffer = scope.p(key, mode === 'st');
                assert.equal(buffer.sampleRate, sampleRate);
                assert.equal(buffer.numberOfChannels, pcm.length);
                assert.equal(digestChannels(bufferChannels(buffer)), original, `${sampleRate}: ${key}/${mode}`);
                allSounds.update(mode);
                for (const channel of bufferChannels(buffer)) allSounds.update(Buffer.from(channel.buffer));
                assert.equal(sound[mode], undefined, 'copied PCM no longer stays in the shared cache');
                assert.equal(sound.buffers[mode], buffer);
                assert.equal(scope.Nb(sampleRate, key), sound, 'already prepared keys must not synthesize again');
            }
        }
        assert.equal(Object.keys(cache.d).length, 92);
        for (const sound of Object.values(cache.d)) assert.deepEqual(Object.keys(sound), ['buffers']);
        scope.E({});
        for (const kind of ['white', 'brown']) allSounds.update(Buffer.from(scope.o.buf[kind].getChannelData(0).buffer));
        assert.equal(allSounds.digest('hex'), expected[sampleRate], 'the complete converted library matches the original PCM fingerprint');
        assert.equal(scope.o.stats.bakeMs, 0);
    }
});

test('mono and stereo retain their original selection in either conversion order and across contexts', () => {
    for (const order of [[true, false], [false, true]]) {
        const { scope, copies, context } = runtime(48000);
        const sound = scope.Nb(48000, 'gun:ar:near:0');
        const originals = { mono: digestChannels(sound.mono), st: digestChannels(sound.st) };
        const firstMode = order[0] ? 'st' : 'mono';
        const otherMode = order[0] ? 'mono' : 'st';
        const first = scope.p('gun:ar:near:0', order[0]);
        assert.equal(sound[firstMode], undefined);
        assert.ok(sound[otherMode]);
        const second = scope.p('gun:ar:near:0', order[1]);
        assert.equal(digestChannels(bufferChannels(first)), originals[firstMode]);
        assert.equal(digestChannels(bufferChannels(second)), originals[otherMode]);
        assert.notEqual(first, second);
        scope.o = { ctx: { ...context }, abuf: {}, buf: {}, stats: { bakeMs: 0 } };
        scope.Nb = () => sound;
        assert.equal(scope.p('gun:ar:near:0', order[0]), first);
        assert.equal(scope.p('gun:ar:near:0', order[1]), second);
        assert.equal(copies(), 2);
    }
});

test('mono-only and stereo-only requests share their unchanged fallback AudioBuffer', () => {
    const { scope, copies } = runtime(48000);
    for (const key of ['exp:0', 'glass:crack:0']) {
        const original = scope.Nb(48000, key);
        const mode = original.st ? 'st' : 'mono';
        const digest = digestChannels(original[mode]);
        const before = copies();
        const stereo = scope.p(key, true);
        const mono = scope.p(key, false);
        assert.equal(stereo, mono);
        assert.equal(digestChannels(bufferChannels(mono)), digest);
        assert.equal(copies(), before + 1);
    }
});

test('failed copy retains all original channels and is retryable', () => {
    const { scope, failAt } = runtime(48000);
    const sound = scope.Nb(48000, 'gun:ar:near:0');
    const original = sound.st;
    failAt(1);
    assert.throws(() => scope.p('gun:ar:near:0', true), /copy interrupted/);
    assert.equal(sound.st, original);
    assert.equal(sound.buffers.st, undefined);
    assert.equal(scope.o.abuf['gun:ar:near:0|s'], undefined);
    failAt(-1);
    const buffer = scope.p('gun:ar:near:0', true);
    assert.equal(digestChannels(bufferChannels(buffer)), digestChannels(original));
    assert.equal(sound.st, undefined);
});

test('noise buffers release PCM after success and are reused on another initialization', () => {
    const { scope, copies, context, failAt } = runtime(48000);
    const cache = scope.Dw(48000);
    const noise = cache.noise = { white: scope.tI(48000, 3, 'white'), brown: scope.tI(48000, 4, 'brown') };
    const original = { white: noise.white, brown: noise.brown };
    failAt(0);
    assert.throws(() => scope.E({}), /copy interrupted/);
    assert.equal(noise.white, original.white);
    assert.equal(noise.brown, original.brown);
    failAt(-1);
    scope.E({});
    for (const kind of ['white', 'brown']) {
        assert.equal(noise[kind], undefined);
        assert.equal(digestChannels(bufferChannels(scope.o.buf[kind])), digestChannels([original[kind]]));
    }
    const buffers = scope.o.buf;
    const before = copies();
    scope.o = { ctx: { ...context }, abuf: {}, buf: {}, stats: { bakeMs: 0 } };
    scope.E({});
    assert.equal(scope.o.buf.white, buffers.white);
    assert.equal(scope.o.buf.brown, buffers.brown);
    assert.equal(copies(), before);
});

test('late worker completion does not overwrite converted samples or duplicate noise PCM', async () => {
    const { scope } = runtime(48000);
    let worker;
    scope.Blob = class {};
    scope.URL = { createObjectURL: () => 'blob:audio', revokeObjectURL() {} };
    scope.Worker = class {
        constructor() { worker = this; }
        postMessage() {}
        terminate() {}
    };
    const pending = scope.prepareGoldenAudioPCM(48000);
    const converted = scope.p('exp:0', false);
    scope.E({});
    const noise = scope.Dw(48000).noise;
    worker.onmessage({ data: {
        d: { 'exp:0': { mono: [new Float32Array(8)] }, 'exp:1': { mono: [new Float32Array(16)] } },
        noise: { white: new Float32Array(8), brown: new Float32Array(8) }
    } });
    await pending;
    const cache = scope.Dw(48000);
    assert.equal(cache.d['exp:0'].buffers.mono, converted);
    assert.equal(cache.d['exp:0'].mono, undefined);
    assert.ok(cache.d['exp:1'].mono);
    assert.equal(cache.noise, noise);
    assert.equal(noise.white, undefined);
    assert.equal(scope.prepareGoldenAudioPCM(48000), pending);
});
