const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = readFileSync(resolve(__dirname, '../../static/games/golden-hour/dist/game.js'), 'utf8');
const start = source.indexOf('let G=new Jf', source.indexOf('async function As0()'));
const end = source.indexOf('window.GH.debug=', start);
assert.ok(start >= 0 && end > start);
const frameSource = source.slice(start, end);

class Vector {
    constructor() { this.x = this.y = this.z = 0; }
    set() { return this; }
    copy() { return this; }
    addScaledVector() { return this; }
    project() { return this; }
    applyQuaternion() { return this; }
    dot() { return 0; }
}

function runtime({ gate = () => true, render = () => true, state = 'playing' } = {}) {
    let delta = 0;
    let timestamp = 0;
    const steps = [];
    const renders = [];
    const hud = [];
    const completed = [];
    const noop = () => {};
    const vector = () => new Vector();
    const scene = { state, time: 0, timeScale: 1, fps: 0, freeCam: null };
    const browser = { __goldenHourClockEpoch: 0, __goldenHourShouldRender: gate };
    const player = {
        hit: [{ a: vector(), b: vector() }, { a: vector(), b: vector() }],
        update: dt => steps.push(dt), getHit: noop,
        alive: true, health: 100, mode: 'stand', shake: 0, adsK: 0
    };
    const camera = {
        position: vector(), rotation: vector(), up: vector(), quaternion: {},
        updateMatrixWorld: noop, updateProjectionMatrix: noop, getWorldDirection: noop
    };
    const graphics = {
        vmPass: {}, vmScene: {}, sunUv: vector(), uniforms: {},
        render(dt, paused) {
            const drawn = render(dt, paused);
            renders.push({ dt, paused, drawn });
            return drawn;
        }
    };
    for (const name of ['uFade', 'uExposure', 'uDamage', 'uLowHealth', 'uCA', 'uAds']) {
        graphics.uniforms[name] = { value: 0 };
    }
    const scope = {
        window: browser, performance: { now: () => timestamp },
        Jf: class { getDelta() { return delta; } }, Je: scene,
        S: player, n: graphics, a: camera,
        l: { keys: new Set(), endFrame: () => completed.push(timestamp) },
        A: { update: noop }, m: { frame: noop },
        b: { state: 'playing', bots: [{ update: noop }], update: noop },
        p: { update: noop }, d: { update: noop }, E: { update: noop },
        g: { update: [], indoor: () => 0 }, u: { update: noop },
        r: { domElement: { height: 600 } }, C: { update: noop },
        f: { raycast: () => null }, Ii: vector(), i3: vector(), a3: vector(),
        x: { update: noop },
        t: { update: dt => hud.push(dt) },
        fo: { setListener: noop, setEnvironment: noop, setLowHealth: noop, update: noop },
        Ee: (from, to, rate, dt) => from + (to - from) * (1 - Math.exp(-rate * dt)),
        Ht: (from, to, factor) => from + (to - from) * factor,
        ns: value => Math.max(0, Math.min(1, value)), jn: Math.PI / 180
    };
    const frame = vm.runInNewContext(`${frameSource};M0`, scope);
    return {
        scene, browser, steps, renders, hud, completed,
        step(seconds) {
            delta = seconds;
            timestamp += seconds * 1000;
            frame(timestamp);
        }
    };
}

test('5 Hz drawing retains 60 Hz simulation and reports real drawn FPS', () => {
    const game = runtime({ gate: timestamp => Math.round(timestamp / (1000 / 60)) % 12 === 0 });
    const fps = [];
    for (let frame = 0; frame < 180; frame += 1) {
        game.step(1 / 60);
        if (frame >= 60) fps.push(game.scene.fps);
    }
    assert.equal(game.steps.length, 180);
    assert.equal(game.hud.length, 180);
    assert.equal(game.completed.length, 180);
    assert.ok(Math.abs(game.scene.time - 3) < 1e-10);
    assert.equal(game.renders.length, 15);
    assert.ok(Math.abs(game.renders.reduce((sum, value) => sum + value.dt, 0) - 3) < 1e-10);
    assert.ok(game.renders.every(value => Math.abs(value.dt - .2) < 1e-10));
    const meanFps = fps.reduce((sum, value) => sum + value, 0) / fps.length;
    assert.ok(meanFps > 4.5 && meanFps < 5.5, `measured FPS ${meanFps}`);
});

test('visibility resume discards the hidden gap and pending draw time', () => {
    let draw = false;
    const game = runtime({ gate: () => draw });
    for (let frame = 0; frame < 10; frame += 1) game.step(1 / 60);
    const before = game.scene.time;
    game.scene.fps = 42;
    game.browser.__goldenHourClockEpoch += 1;
    draw = true;
    game.step(120);
    assert.equal(game.scene.time, before);
    assert.equal(game.steps.at(-1), 0);
    assert.equal(game.renders.at(-1).dt, 0);
    assert.equal(game.scene.fps, 0);
    for (let frame = 0; frame < 90; frame += 1) game.step(1 / 60);
    assert.ok(Math.abs(game.scene.time - before - 1.5) < 1e-10);
    assert.ok(game.scene.fps >= 59 && game.scene.fps <= 61);
});

test('slow real frames keep the simulation clamp without inflating reported FPS', () => {
    const game = runtime();
    for (let frame = 0; frame < 30; frame += 1) game.step(.1);
    assert.equal(game.steps.length, 30);
    assert.ok(game.steps.every(dt => dt === .05555555555555555));
    assert.ok(Math.abs(game.scene.time - 30 / 18) < 1e-10);
    assert.ok(Math.abs(game.scene.fps - 10) < 1e-10);
});

test('paused-frame cache hits do not count as newly drawn frames', () => {
    let first = true;
    const game = runtime({ state: 'paused', render: () => {
        const drawn = first;
        first = false;
        return drawn;
    } });
    for (let frame = 0; frame < 120; frame += 1) game.step(1 / 60);
    assert.equal(game.renders.length, 120);
    assert.equal(game.renders.filter(value => value.drawn).length, 1);
    assert.ok(game.renders.every(value => value.paused));
    assert.equal(game.scene.time, 0);
    assert.equal(game.scene.fps, 0);
});
