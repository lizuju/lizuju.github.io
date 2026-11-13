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
    const calls = { pose: 0, ray: 0, indoor: 0, camera: 0, audio: 0 };
    const hudStates = [];
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
        updateMatrixWorld: () => calls.camera++, updateProjectionMatrix: noop, getWorldDirection: noop
    };
    const graphics = {
        vmPass: {}, vmScene: {}, sunUv: vector(), uniforms: {},
        render(dt, paused) {
            const drawn = render(dt, paused);
            if (drawn) this.pausedFrame = paused;
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
        g: { update: [], indoor: () => { calls.indoor++; return 0; } }, u: { update: noop },
        r: { domElement: { height: 600 } }, C: { update: () => calls.pose++ },
        f: { raycast: () => { calls.ray++; return null; } }, Ii: vector(), i3: vector(), a3: vector(),
        x: { update: noop },
        t: { update: (dt, state) => { hud.push(dt); hudStates.push(state); } },
        fo: { setListener: noop, setEnvironment: noop, setLowHealth: noop, update: () => calls.audio++ },
        Ee: (from, to, rate, dt) => from + (to - from) * (1 - Math.exp(-rate * dt)),
        Ht: (from, to, factor) => from + (to - from) * factor,
        ns: value => Math.max(0, Math.min(1, value)), jn: Math.PI / 180
    };
    const frame = vm.runInNewContext(`${frameSource};M0`, scope);
    return {
        scene, browser, steps, renders, hud, completed, calls, graphics, hudStates,
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

test('cached pause skips spatial work while audio and HUD timers keep their original cadence', () => {
    const game = runtime({ state: 'paused' });
    for (let frame = 0; frame < 90; frame++) game.step(1 / 30);
    assert.deepEqual(game.calls, { pose: 1, ray: 1, indoor: 1, camera: 1, audio: 90 });
    assert.equal(game.hudStates.filter(state => state.paused).length, 89);
    assert.equal(game.scene.time, 0);
    assert.equal(game.completed.length, 90);
    assert.equal(game.graphics.uniforms.uDamage.value, 0);

    game.graphics.pausedFrame = false;
    game.step(1 / 30);
    assert.equal(game.calls.pose, 2, 'A settings, resize or context invalidation refreshes the pose');
    assert.equal(game.calls.ray, 2);
    assert.equal(game.hudStates.at(-1).paused, false);
    game.step(1 / 30);
    assert.equal(game.calls.pose, 2);

    game.scene.state = 'playing';
    for (let frame = 0; frame < 3; frame++) game.step(1 / 60);
    assert.equal(game.calls.pose, 5);
    assert.equal(game.calls.ray, 5);
    assert.equal(game.steps.length, 3);
    assert.equal(game.hudStates.at(-1).paused, false);
    assert.ok(Math.abs(game.scene.time - .05) < 1e-10);
});

test('paused free camera still updates spatial work and cached pause preserves timed shader decay', () => {
    const game = runtime({ state: 'paused' });
    game.graphics.uniforms.uDamage.value = .8;
    game.step(1 / 30);
    for (let frame = 0; frame < 29; frame++) game.step(1 / 30);
    assert.ok(Math.abs(game.graphics.uniforms.uDamage.value - .8 * Math.exp(-2.6)) < 1e-10);
    assert.equal(game.calls.pose, 1);
    game.scene.freeCam = { x: 1, y: 2, z: 3, yaw: 0, pitch: 0 };
    game.step(1 / 30);
    game.step(1 / 30);
    assert.equal(game.calls.pose, 3);
    assert.equal(game.hudStates.at(-1).paused, false);
});

function element() {
    return {
        style: {}, classList: { add() {}, remove() {}, toggle() {} },
        animate: () => ({ cancel() {}, play() {} }),
    };
}

test('cached HUD advances ammo, health and transient timers while skipping scene projections', () => {
    const hudStart = source.indexOf('update(t,e){', source.indexOf('perfReset(){'));
    const hudEnd = source.indexOf('_drop(t,e){', hudStart);
    const Hud = vm.runInNewContext(`class Hud {${source.slice(hudStart, hudEnd)}};Hud`, {
        performance: { now: () => 0 }, Math, innerHeight: 600, innerWidth: 800,
        jn: Math.PI / 180, Oa: { hudScale: 1 }, P2: false, ta: '',
        L2: (node, value) => { node.textContent = value; },
        c6: (node, value) => { node.className = value; }, Ar() {}, vs: () => '',
    });
    const removed = [];
    const banners = [];
    const toasts = [];
    const ticks = { map: 0, k9: 0 };
    const hud = new Hud();
    const forbid = () => { throw new Error('Frozen HUD queried the scene'); };
    const nodes = new Proxy({}, { get: (target, key) => target[key] ||= element() });
    nodes.frags = [element(), element()];
    nodes.stances = { stand: element() };
    const slot = { ammo: 30, reserve: 60 };
    Object.assign(hud, {
        slow: 1, e: nodes, c: { wkey: 'ar', wid: 'ar', mag: 30, frag: 2,
            sA: 0, sB: 0, lead: -1, clock: 100, ended: false, board: false, alive: true },
        a: {}, leadT: .1, bT: .1, bq: [{ hold: 1, text: 'TEST' }],
        gap: 4, gapV: 0, magRoll: { a: 0, b: 30, t: 0 },
        lastHp: .8, hpShow: .5, ghost: 1, ghostHold: .1,
        dmg: Array.from({ length: 6 }, () => ({ t: .1, beta: 0, q: 0, n: element() })),
        ev: { on: true, shown: 10, total: 10, t: .1 },
        lines: [{ t: .1 }], meds: [{ t: .1 }], feed: [{ t: .1 }],
        toasts: ['toast'], toastT: .1, stat: { streak: 0 }, tags: [],
        perf: { n: 0, sum: 0, max: 0, over: 0 },
        map: { update: (...args) => { assert.equal(args[6], true); ticks.map++; } },
        k9hud: { update: (dt, state) => { assert.equal(state.paused, true); ticks.k9++; } },
        _drop: (item, kind) => removed.push(kind),
        _banner: item => banners.push(item.text), _toast: item => toasts.push(item),
    });
    const state = { paused: true, player: { alive: true, yaw: 0, streak: 0,
        health: 80, stance: 'stand', mode: 'normal' },
        ars: { def: { id: 'ar', mag: 30 }, slot, slots: [slot, slot], cur: 0,
            ads: 0, spread: 0, grenades: 2, state: 'ready' },
        match: { scores: [0, 0], state: 'live', time: 100, actors: [] },
        camera: { fov: 60, position: {} }, world: { clear: forbid } };
    for (let frame = 0; frame < 30; frame++) hud.update(1 / 30, state);
    assert.deepEqual(removed, ['line', 'medal', 'feed']);
    assert.deepEqual(banners, ['TEST']);
    assert.deepEqual(toasts, ['toast']);
    assert.equal(hud.magRoll, null);
    assert.equal(nodes.mag.textContent, 30);
    assert.equal(hud.hpShow, .8);
    assert.equal(hud.ghost, .8);
    assert.equal(hud.ev.on, false);
    assert.ok(hud.leadT <= 0);
    assert.ok(hud.dmg.every(damage => damage.t <= 0));
    assert.deepEqual(ticks, { map: 30, k9: 30 });
    assert.equal(hud.perf.n, 30);
    hud.map.update = () => {};
    hud.k9hud.update = () => {};
    hud.update(1 / 30, { ...state, paused: false });
    assert.equal(hud.magRoll, null, 'Resume does not restart an expired ammo animation');
    assert.equal(hud.ghost, .8);
});

function minimap() {
    const begin = source.indexOf('O7=class') + 3;
    const end = source.indexOf(';var xs0=', begin);
    const Map = vm.runInNewContext(`(${source.slice(begin, end)})`, {
        Math, HU: ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'], IU: []
    });
    const map = Object.create(Map.prototype);
    Object.assign(map, {
        ready: true, mode: 'rotate', _lay: false, c: {}, upper: false,
        half: 100, mpm: 4, minx: 0, minz: 0, rr: 0, tdeg: 0, tick: 0,
        rot: element(), me: element(), cone: element(), north: element(), map: element(),
        tape: element(), hdg: element(), zone: element(), cv: [element(), element()],
        layer: {}, blips: [],
    });
    return map;
}

test('cached minimap expires old pings but preserves frozen game-time shots without raycasts', () => {
    const map = minimap();
    const player = { isPlayer: true, team: 0, yaw: 0, pos: { x: 0, y: 0, z: 0 },
        viewDir: { x: 0, y: 0, z: 1 } };
    const actors = [player, { team: 0, alive: false, pos: { x: 0, y: 0, z: 4 } },
        { team: 1, alive: true, lastShot: 0, pos: { x: 0, y: 0, z: 10 } },
        { team: 1, alive: true, lastShot: 10, pos: { x: 0, y: 0, z: 12 } }];
    for (let i = 1; i < actors.length; i++) map.blips[i] = {
        el: element(), dead: true, deadT: .1, t: .1, vis: false, op: 25,
        anim: { cancel() {}, play() {} }, ring: { cancel() {}, play() {} },
    };
    let rays = 0;
    const world = { raycast: () => { rays++; return true; } };
    const eye = { x: 0, y: 1.4, z: 0 };
    for (let frame = 0; frame < 30; frame++) map.update(1 / 30, player, actors, world, 10, eye, true);
    assert.equal(rays, 0);
    assert.equal(map.blips[1].el.style.display, 'none');
    assert.equal(map.blips[2].op, 0);
    assert.ok(Math.abs(map.blips[3].t - (2.6 - 1 / 30)) < 1e-10,
        'A lastShot still recent in frozen game time keeps its original refresh behavior');
    for (let frame = 0; frame < 4; frame++) map.update(1 / 30, player, actors, world, 10.2, eye, false);
    assert.equal(rays, 2, 'Resume re-enables the round-robin visibility queries');
    assert.ok(map.blips[3].t < 2.5);
});

test('cached K9 HUD advances hurt and charge timers without projecting actors', () => {
    const begin = source.indexOf('update(t,e){let s=e.match.k9');
    const end = source.indexOf('};var', begin);
    const Hud = vm.runInNewContext(`class Hud {${source.slice(begin, end)}};Hud`, {
        Math, nd: value => Math.max(0, Math.min(1, value)), GU: 100,
        Ql: { set() { throw new Error('Frozen K9 HUD projected an actor'); } },
    });
    const map = minimap();
    map.kb = [0, 1].map(() => ({ el: element(), op: 0, t: .1,
        ring: { cancel() {}, play() {} } }));
    map._k9put = () => { throw new Error('Frozen K9 map positioned an actor'); };
    const hud = new Hud();
    const nodes = new Proxy({}, { get: (target, key) => target[key] ||= element() });
    Object.assign(hud, { on: true, st: 'active', arc: 0, hpShown: .9, hurtT: .1,
        kills: 0, e: nodes, c: { hurt: true, foeOp: 0, prox: false }, a: {}, hud: { map } });
    const state = { paused: true, player: { team: 0 }, camera: {},
        match: { k9: { view: { state: 'active', time: .5, hp: .9, kills: 0 },
            units: [{ alive: true, team: 0 }, { alive: true, team: 1 }] } } };
    for (let frame = 0; frame < 30; frame++) hud.update(1 / 30, state);
    assert.equal(hud.c.hurt, false);
    assert.ok(hud.hurtT <= 0);
    assert.ok(Math.abs(hud.arc - .5) < .003);
    assert.equal(map.kb[1].op, 0, 'An unseen enemy K9 marker expires during pause');
    hud.c.foeOp = 1;
    hud.update(1 / 30, state);
    assert.equal(map.kb[1].t, 1.5, 'A visible enemy K9 keeps its existing marker timer');
});

test('upstairs gameplay still updates K9 minimap positions through the HUD', () => {
    const begin = source.indexOf('update(t,e){let s=e.match.k9');
    const end = source.indexOf('};var', begin);
    const vector = {
        x: 0, y: 0, z: 0,
        set(x, y, z) { Object.assign(this, { x, y, z }); return this; },
        distanceTo() { return 10; },
        project() { this.x = .3; this.y = .3; this.z = .5; return this; },
    };
    const Hud = vm.runInNewContext(`class Hud {${source.slice(begin, end)}};Hud`, {
        Math, nd: value => Math.max(0, Math.min(1, value)), GU: 100, Ql: vector,
        innerWidth: 800, innerHeight: 600,
    });
    const map = minimap();
    map.upper = true;
    map.kb = [0, 1].map(() => ({ el: element(), op: 0, t: 0,
        ring: { cancel() {}, play() {} } }));
    const own = { alive: true, team: 0, pos: { x: 2, y: 4, z: 3 }, yaw: 0 };
    const hud = new Hud();
    const nodes = new Proxy({}, { get: (target, key) => target[key] ||= element() });
    Object.assign(hud, { on: true, st: 'active', arc: .5, hpShown: .9, hurtT: 0,
        kills: 0, e: nodes, c: { foeOp: 0 }, a: {}, hud: { map } });
    const state = { paused: false, player: { team: 0, pos: { y: 4 } }, ars: { ads: 0 },
        camera: { position: { x: 0, y: 5.4, z: 0 } },
        match: { k9: { view: { state: 'active', time: .5, hp: .9, kills: 0 }, units: [own] } } };
    hud.update(1 / 60, state);
    assert.equal(map.kb[0].qx, 32);
    assert.equal(map.kb[0].qz, 48);
    assert.equal(map.kb[0].off, false);
    own.pos.x = 5;
    hud.update(1 / 60, state);
    assert.equal(map.kb[0].qx, 80, 'Being above 2.6 m must not freeze normal minimap positions');
});
