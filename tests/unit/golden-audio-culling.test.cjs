const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = readFileSync(process.env.GOLDEN_AUDIO_SOURCE ||
    resolve(__dirname, '../../static/games/golden-hour/dist/game.js'), 'utf8');
const start = source.indexOf('function createGoldenAudioDSP()');
const end = source.indexOf('var fo=eZ()', start);
assert.ok(start >= 0 && end > start);
const audioSource = source.slice(start, end).replace('return zt}', 'zt.TestVoice=T;return zt}');

class Param {
    constructor() { this.value = 0; this.events = []; }
    setValueAtTime(...args) { this.events.push(['set', ...args]); }
    linearRampToValueAtTime(...args) { this.events.push(['linear', ...args]); }
    exponentialRampToValueAtTime(...args) { this.events.push(['exponential', ...args]); }
    setTargetAtTime(...args) { this.events.push(['target', ...args]); }
    cancelScheduledValues(...args) { this.events.push(['cancel', ...args]); }
}

function audio(seed = 12345) {
    let randomDraws = 0;
    const math = Object.create(Math);
    math.random = () => {
        randomDraws += 1;
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed / 4294967296;
    };
    const api = vm.runInNewContext(`${audioSource};eZ()`, { Math: math, console });
    const engine = api._engine;
    const nodes = [];
    const node = type => {
        const result = { id: nodes.length, type, links: [], starts: [], stops: [] };
        for (const key of ['gain', 'frequency', 'Q', 'detune', 'playbackRate', 'delayTime', 'positionX', 'positionY', 'positionZ']) {
            result[key] = new Param();
        }
        result.connect = (destination, ...ports) => {
            assert.ok(destination, 'audio connections require a real destination');
            result.links.push([destination.id ?? 'param', ...ports]);
        };
        result.disconnect = () => {};
        result.start = (...args) => result.starts.push(args);
        result.stop = (...args) => result.stops.push(args);
        nodes.push(result);
        return result;
    };
    engine.ctx = { currentTime: 10, sampleRate: 48000 };
    for (const type of ['Gain', 'BiquadFilter', 'Oscillator', 'BufferSource', 'ChannelMerger', 'Delay', 'Panner', 'WaveShaper']) {
        engine.ctx[`create${type}`] = () => node(type);
    }
    const bus = { id: 'sfx' };
    engine.bus = { sfx: bus, foley: bus, gun: bus, k9: bus };
    engine.revIn = { id: 'reverb' };
    engine.buf.white = { duration: 3 };
    engine.buf.brown = { duration: 4 };
    return { api, engine, nodes, draws: () => randomDraws };
}

const position = x => ({ x, y: 0, z: 0 });

test('static voices preserve audible distance boundaries and cull only the zero-gain region', () => {
    for (const distance of [0, 13.9, 14, 19.999]) {
        const { api, engine, nodes } = audio();
        const voice = new api.TestVoice(position(distance), { maxDist: 20 });
        assert.ok(voice.level > 0, `voice at ${distance} remains audible`);
        assert.ok(nodes.length > 0);
        assert.equal(engine.active, 1);
    }
    for (const distance of [20, 25, 200]) {
        const { api, engine, nodes } = audio();
        const voice = new api.TestVoice(position(distance), { maxDist: 20 });
        assert.equal(voice.level, 0);
        assert.equal(nodes.length, 0);
        assert.equal(engine.active, 0);
        assert.equal(engine.voices.length, 0);
    }
});

test('culled events do not steal voices at either the category or global limit', () => {
    const { api, engine, nodes } = audio();
    for (let index = 0; index < 56; index += 1) {
        new api.TestVoice(position(1), { cat: index < 8 ? 'step' : `other-${index}` });
    }
    const before = nodes.length;
    api.footstep('concrete', position(25), { run: false });
    assert.equal(nodes.length, before);
    assert.equal(engine.active, 56);
    assert.equal(engine.cats.step, 8);
    assert.equal(engine.stats.stolen, 0);
    assert.equal(engine.voices.some(voice => voice.dying), false);
    assert.equal(engine.errors.length, 0);
});

test('distant footsteps consume the same random draws as audible footsteps', () => {
    for (const surface of ['concrete', 'carpet', 'wood', 'metal', 'water', 'gravel']) {
        for (const run of [false, true]) {
            const near = audio();
            const far = audio();
            for (let count = 0; count < 10; count += 1) {
                near.api.footstep(surface, position(2), { run });
                far.api.footstep(surface, position(25), { run });
            }
            assert.ok(near.nodes.length > 0);
            assert.equal(far.nodes.length, 0);
            assert.equal(far.draws(), near.draws(), `${surface}, run=${run}`);
            assert.equal(near.engine.errors.length + far.engine.errors.length, 0);
        }
    }
});

test('every static voice source stays silent without changing procedural randomness', () => {
    function recipe(voice) {
        const destination = voice.filter('lowpass', 1200);
        voice.shaper(2);
        voice.play({ duration: .3 });
        voice.glide({ f: [[0, 300], [.1, 200]], dest: destination });
        voice.noise({ type: 'lowpass', f: 1000 });
        voice.noise({ g: 0 });
        voice.tone({ f: 500 });
        voice.fm({ f: 600 });
        voice.partials(100, [1, 2, 3], .2, .1);
    }
    const near = audio();
    const far = audio();
    recipe(new near.api.TestVoice(position(1), { maxDist: 20 }));
    recipe(new far.api.TestVoice(position(25), { maxDist: 20 }));
    assert.ok(near.nodes.length > 0);
    assert.equal(far.nodes.length, 0);
    assert.equal(far.draws(), near.draws());
});

test('dynamic voices and moving loops retain nodes when starting outside the audible range', () => {
    const { api, engine, nodes } = audio();
    const voice = new api.TestVoice(position(25), { maxDist: 20, dyn: true });
    assert.equal(voice.level, 0);
    assert.equal(engine.active, 1);
    assert.ok(nodes.some(value => value.panningModel === 'equalpower'));
    api.k9Loop('moving', position(40), .8);
    const loop = engine.k9.loops.get('moving');
    assert.ok(loop);
    const before = nodes.length;
    api.k9Loop('moving', position(2), .8);
    assert.equal(engine.k9.loops.get('moving'), loop);
    assert.equal(nodes.length, before);
    assert.ok(loop.out.gain.events.some(([kind, gain]) => kind === 'target' && gain > 0));
    assert.equal(engine.errors.length, 0);
});

test('nearby footstep audio graph and envelopes match the original sound', () => {
    const { api, nodes } = audio();
    api.footstep('concrete', position(2), { run: false });
    const digest = createHash('sha256').update(JSON.stringify(nodes)).digest('hex');
    assert.equal(digest, '6ed2ab2acb749a09e76202e24c9254302ce91bc10e3fac6a1638eb8d819d1b10');
});
