const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = readFileSync(resolve(__dirname, '../../static/games/golden-hour/dist/game.js'), 'utf8');
const start = source.indexOf('function createGoldenAudioDSP()');
const end = source.indexOf('var fo=eZ()', start);
assert.ok(start >= 0 && end > start);
const audioSource = source.slice(start, end).replace('return zt}',
    'zt.testBank=Dw;zt.testKeys=B$;zt.testMusic=dt=>{l0(o.ctx.currentTime);$0(o.ctx.currentTime,dt)};return zt}');

class Param {
    constructor() { this.value = 0; this.events = []; }
    setValueAtTime(...args) { this.events.push(['set', ...args]); }
    linearRampToValueAtTime(...args) { this.events.push(['linear', ...args]); }
    exponentialRampToValueAtTime(...args) { this.events.push(['exponential', ...args]); }
    setTargetAtTime(...args) { this.events.push(['target', ...args]); }
    cancelScheduledValues(...args) { this.events.push(['cancel', ...args]); }
}

function audio(muted = false) {
    let seed = 12345;
    let randomDraws = 0;
    const math = Object.create(Math);
    math.random = () => {
        randomDraws++;
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed / 4294967296;
    };
    const api = vm.runInNewContext(`${audioSource};eZ()`, { Math: math, console });
    const engine = api._engine;
    const nodes = [];
    const node = type => {
        const result = { id: nodes.length, type, starts: [], stops: [], links: [] };
        for (const key of ['gain', 'frequency', 'Q', 'detune', 'playbackRate', 'delayTime', 'positionX', 'positionY', 'positionZ', 'pan']) {
            result[key] = new Param();
        }
        result.connect = target => { assert.ok(target); result.links.push(target.id ?? 'param'); };
        result.disconnect = () => {};
        result.start = (...args) => result.starts.push(args);
        result.stop = (...args) => result.stops.push(args);
        nodes.push(result);
        return result;
    };
    engine.ctx = { currentTime: 10, sampleRate: 48000, __goldenHourOutput: { muted, hidden: false } };
    for (const type of ['Gain', 'BiquadFilter', 'Oscillator', 'BufferSource', 'ChannelMerger', 'Delay', 'Panner', 'WaveShaper', 'StereoPanner']) {
        engine.ctx[`create${type}`] = () => node(type);
    }
    engine.bus = Object.fromEntries(['sfx', 'foley', 'gun', 'k9', 'ui', 'exp', 'amb'].map(name => [name, { id: name }]));
    engine.revIn = { id: 'reverb' };
    engine.tin = { id: 'tinnitus' };
    engine.masterLP = { frequency: new Param() };
    for (const key of ['duckA', 'duckW', 'duckG', 'musicDuck']) engine[key] = { gain: new Param() };
    engine.buf.white = { duration: 3 };
    engine.buf.brown = { duration: 4 };
    const bank = api.testBank(engine.ctx.sampleRate);
    for (const key of api.testKeys()) bank.d[key] = {};
    engine.abuf = new Proxy({}, { get: () => ({ duration: .5 }) });
    return { api, engine, nodes, draws: () => randomDraws, mute: value => { engine.ctx.__goldenHourOutput.muted = value; } };
}

const position = x => ({ x, y: 0, z: 0 });
const events = [
    ['walk', api => api.footstep('concrete', position(2), { run: false })],
    ['run', api => api.footstep('water', position(2), { run: true })],
    ['near gunfire', api => api.gunshot('ar', position(2), {})],
    ['middle gunfire', api => api.gunshot('ar', position(20), {})],
    ['far gunfire', api => api.gunshot('ar', position(60), {})],
    ['own gunfire', api => api.gunshot('ar', null, {})],
    ['suppressed gunfire', api => api.gunshot('smg', position(2), { suppressed: true })],
    ['explosion', api => api.explosion(position(2))],
    ['metal impact', api => api.impact('metal', position(2))],
    ['wood impact', api => api.impact('wood', position(2))],
    ['casing', api => api.casing(position(2), 'metal', 'shell')],
    ['glass crack', api => api.glassCrack(position(2))],
    ['glass shatter', api => api.glassShatter(position(2), .8)],
    ['reload', api => api.reload('ar', 'magin')],
    ['grenade', api => api.grenadeBounce(position(2))],
    ['headshot', api => api.hitmarker('head')],
    ['hurt', api => api.hurt(.5)],
    ['tinnitus', api => api.tinnitus(.8)],
    ['deploy chord', api => api.ui('deploy')],
    ['victory chord', api => api.ui('victory')],
    ['defeat chord', api => api.ui('defeat')],
    ['unlock chord', api => api.ui('unlock')],
];

for (const [name, play] of events) {
    test(`system mute skips ${name} nodes while preserving procedural randomness`, () => {
        const heard = audio();
        const muted = audio(true);
        for (let count = 0; count < 3; count++) {
            play(heard.api);
            play(muted.api);
        }
        assert.equal(heard.engine.errors.length, 0, JSON.stringify(heard.engine.errors));
        assert.equal(muted.engine.errors.length, 0, JSON.stringify(muted.engine.errors));
        assert.ok(heard.nodes.length > 0);
        assert.equal(muted.nodes.length, 0);
        assert.equal(muted.engine.active, 0);
        assert.equal(muted.draws(), heard.draws());
    });
}

test('unmuting starts only new events at the current audio time and preserves their original graph', () => {
    const heard = audio();
    const muted = audio(true);
    for (let count = 0; count < 30; count++) {
        heard.api.footstep('concrete', position(2), { run: false });
        muted.api.footstep('concrete', position(2), { run: false });
    }
    const oldCount = heard.nodes.length;
    heard.engine.ctx.currentTime = muted.engine.ctx.currentTime = 70;
    // Remove expired test voices, as the live update loop does during normal playback.
    heard.engine.voices.length = 0;
    heard.engine.active = 0;
    heard.engine.cats = {};
    muted.mute(false);
    heard.api.footstep('concrete', position(2), { run: false });
    muted.api.footstep('concrete', position(2), { run: false });
    const fresh = heard.nodes.slice(oldCount);
    const graph = (nodes, offset) => JSON.parse(JSON.stringify(nodes, (key, value) => {
        if (key === 'id') return value - offset;
        if (key === 'links') return value.map(link => typeof link === 'number' ? link - offset : link);
        return value;
    }));
    assert.deepEqual(graph(muted.nodes, 0), graph(fresh, oldCount));
    assert.ok(muted.nodes.some(node => node.starts.length));
    assert.ok(muted.nodes.flatMap(node => node.starts).every(([time]) => time >= 70));
    assert.equal(muted.draws(), heard.draws());
});

test('slides and moving loops retain the current segment across mute changes without replay or reconstruction', () => {
    const run = audio(true);
    run.api.slideStart('wood');
    const slide = run.engine.slide;
    assert.ok(slide.srcs.length);
    run.api.k9Loop('moving', position(2), .8);
    const loop = run.engine.k9.loops.get('moving');
    assert.ok(loop.srcs.length);
    const before = run.nodes.length;
    const starts = run.nodes.reduce((sum, node) => sum + node.starts.length, 0);
    run.engine.ctx.currentTime += .25;
    run.mute(false);
    run.api.k9Loop('moving', position(3), .7);
    assert.equal(run.engine.slide, slide);
    assert.equal(run.engine.k9.loops.get('moving'), loop);
    assert.equal(run.nodes.length, before);
    assert.equal(run.nodes.reduce((sum, node) => sum + node.starts.length, 0), starts);
    run.api.slideStop();
    run.api.k9Loop('moving', null, 0);
    assert.equal(run.engine.slide, null);
    assert.ok(slide.dying);
    assert.ok(loop.stop > run.engine.ctx.currentTime);
    assert.equal(run.engine.errors.length, 0);
});


test('sustained music keeps its beat and randomized phrase across mute without catch-up scheduling', () => {
    const heard = audio();
    const muted = audio(true);
    for (const run of [heard, muted]) {
        Object.assign(run.engine.menu, {
            on: true, next: 10.05, nextSwell: 1000,
            gain: { id: 'menu-gain' }, filt: { id: 'menu-filter' },
            lead: { id: 'menu-lead' }, send: { id: 'menu-send' }
        });
        Object.assign(run.engine.lounge, {
            active: true, next: 10.1, occT: 1000,
            in: { id: 'lounge' }, pos: position(2)
        });
    }
    for (let step = 0; step < 60; step++) {
        for (const run of [heard, muted]) {
            run.engine.ctx.currentTime = 10 + step / 10;
            run.api.testMusic(.1);
        }
    }
    assert.equal(muted.draws(), heard.draws());
    assert.deepEqual(JSON.parse(JSON.stringify(muted.engine.lounge.phrase)),
        JSON.parse(JSON.stringify(heard.engine.lounge.phrase)));
    assert.equal(muted.engine.menu.bar, heard.engine.menu.bar);
    assert.equal(muted.engine.lounge.beat, heard.engine.lounge.beat);
    const before = muted.nodes.length;
    muted.mute(false);
    muted.api.testMusic(0);
    assert.equal(muted.nodes.length, before, 'unmute does not enqueue any expired musical events');
    assert.equal(muted.nodes.length, heard.nodes.length);
    assert.equal(muted.engine.errors.length, 0);
});
