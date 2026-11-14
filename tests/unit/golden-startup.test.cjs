const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = readFileSync(resolve(__dirname, '../../static/games/golden-hour/dist/game.js'), 'utf8');

function between(start, end) {
    const first = source.indexOf(start);
    assert.ok(first >= 0, start);
    const last = source.indexOf(end, first + start.length);
    assert.ok(last > first, end);
    return source.slice(first, last);
}

const flush = () => new Promise(setImmediate);

test('boot checkpoints reuse an unclamped task channel and recheck drag state after yielding', async () => {
    let deliver;
    let resume;
    let checked = false;
    let channels = 0;
    let closed = 0;
    const q1 = vm.runInNewContext(`(${between('q1=', ';function Rs0').slice(3)})`, {
        MessageChannel: class {
            constructor() {
                channels += 1;
                this.port1 = { close() { closed += 1; } };
                this.port2 = {
                    postMessage: () => { deliver = () => this.port1.onmessage(); },
                    close() { closed += 1; }
                };
            }
        },
        window: { __goldenHourWaitForBoot() { checked = true; return new Promise((resolve) => { resume = resolve; }); } }
    });
    let continued = false;
    const pending = q1().then(() => { continued = true; });
    assert.equal(checked, false, 'the host gets an event-loop turn before its state is checked');
    deliver();
    await flush();
    assert.equal(checked, true);
    assert.equal(continued, false);
    resume();
    await pending;
    assert.equal(continued, true);
    const second = q1();
    deliver();
    await flush();
    resume();
    await second;
    assert.equal(channels, 1);
    q1.close();
    assert.equal(closed, 2, 'both ports are released after boot');
});

test('cached builders keep synchronous return values while boot consumes the same steps cooperatively', async () => {
    const checkpoints = [];
    const { finishBuild, warmBootBuild } = vm.runInNewContext(
        `${between('function finishBuild(', 'function ao(...args)')};({finishBuild,warmBootBuild})`,
        { q1: () => new Promise((resolve) => checkpoints.push(resolve)) }
    );
    function* create(counter) {
        counter.push('geometry');
        yield;
        counter.push('texture');
        yield;
        return { ready: true, counter };
    }
    const sync = [];
    const value = finishBuild(create(sync));
    assert.equal(value.ready, true);
    assert.deepEqual(sync, ['geometry', 'texture']);
    const boot = [];
    const pending = warmBootBuild(create(boot));
    assert.deepEqual(boot, ['geometry']);
    checkpoints.shift()();
    await flush();
    assert.deepEqual(boot, ['geometry', 'texture']);
    checkpoints.shift()();
    assert.equal((await pending).ready, true);
});

test('procedural textures keep their generation order while letting input run between families', async () => {
    const calls = [];
    const releases = [];
    const scope = {
        performance: { now: () => calls.length },
        rj: 'oak', lj: 'walnut',
        yb: (seed) => { calls.push(`field:${seed}`); return seed; },
        ZY: () => { calls.push('voronoi'); return [1, 2]; },
        w9: (...args) => args,
        q1: () => new Promise((resolve) => releases.push(resolve))
    };
    const generators = ['oj', 'JY', 'tj', 'ej', 'sj', 'nj', 'ij', 'aj', 'eD', 'cj', 'hj', 'fj',
        'uj', 'dj', 'pj', 'mj', 'gj', 'xj', 'bj', 'yj', 'vj', 'Mj', 'wj', 'Ej', 'Tj', 'Sj', 'sw', 'Rj'];
    for (const name of generators) scope[name] = (...args) => {
        const key = `${name}:${args.join(',')}`;
        calls.push(key);
        return key;
    };
    const generate = vm.runInNewContext(`${between('async function iD(', 'function aD(')};iD`, scope);
    const pending = generate(8);
    assert.deepEqual(calls, ['field:11', 'field:23', 'field:37', 'field:53', 'field:71', 'voronoi']);
    let complete = false;
    pending.then(() => { complete = true; });
    while (!complete) {
        assert.ok(releases.length, 'each pending phase exposes a checkpoint');
        releases.shift()();
        await flush();
    }
    const textures = await pending;
    assert.deepEqual(calls.slice(6), [
        'oj:', 'JY:', 'tj:', 'ej:', 'sj:', 'nj:', 'ij:', 'aj:', 'eD:oak', 'eD:walnut',
        'cj:', 'hj:', 'fj:', 'uj:', 'dj:', 'pj:', 'mj:', 'gj:', 'xj:', 'bj:', 'yj:', 'vj:',
        'Mj:', 'wj:', 'Ej:', 'Tj:', 'Sj:', 'sw:0', 'sw:1', 'sw:2', 'sw:3', 'Rj:'
    ]);
    assert.equal(textures.marble, 'ij:');
    assert.equal(textures.oak, 'eD:oak');
    assert.equal(textures.walnut, 'eD:walnut');
    assert.deepEqual(Array.from(textures.art), ['sw:0', 'sw:1', 'sw:2', 'sw:3']);
});

test('runtime weapon builds remain synchronous and only boot can defer shader compilation', () => {
    const method = between('build(t,e={},precompile=', '_precompile(t){');
    const build = vm.runInNewContext(`({${method}}).build`, { Zi: () => 'default', e5: (id, config) => `${id}:${config}` });
    const compiled = [];
    const attached = [];
    const instance = {
        guns: {},
        ctx: { buildGun: (id) => ({ id, root: { visible: true, traverse(fn) { fn({ isMesh: true }); } } }) },
        clip: { add: (root) => attached.push(root) },
        _precompile: (gun) => compiled.push(gun.id)
    };
    assert.equal(build.call(instance, ['ar']), undefined);
    assert.equal(instance.guns['ar:default'].root.visible, false);
    assert.deepEqual(compiled, ['ar']);
    build.call(instance, ['ar']);
    assert.equal(attached.length, 1, 'cached guns are not rebuilt');
    build.call(instance, ['pistol'], {}, false);
    assert.equal(attached.length, 2);
    assert.deepEqual(compiled, ['ar'], 'boot still builds geometry synchronously but waits to compile it separately');
});

test('boot shader compilation finishes before the original render target is restored', async () => {
    const method = between('async _precompileAsync(t){', 'show(t,e=null){');
    const events = [];
    let finish;
    const compile = vm.runInNewContext(`({${method}})._precompileAsync`, {
        Vs: class {}, Yn: 1,
        q1: async () => { events.push('yield'); },
        console
    });
    const renderer = {
        getRenderTarget: () => 'previous',
        setRenderTarget: (target) => events.push(target),
        compileAsync: () => { events.push('compile'); return new Promise((resolve) => { finish = resolve; }); }
    };
    const pending = compile.call({ ctx: { gfx: { renderer } }, cam: {}, scene: {} }, { root: {} });
    assert.equal(events.at(-1), 'compile');
    assert.ok(!events.includes('previous'));
    finish();
    await pending;
    assert.deepEqual(events.slice(1), ['compile', 'yield', 'previous']);
});

test('weapon card startup yields between full-size bakes and preserves all cached images', async () => {
    const method = between('async build(t=["ar","smg","shotgun","pistol"]){', 'icons(t,e=null,s=!0){');
    const events = [];
    const build = vm.runInNewContext(`({${method}}).build`, {
        performance: { now: () => events.length }, Vb: (id) => id,
        q1: async () => { events.push('yield'); }
    });
    const studio = {
        items: new Map(), flat: new Map(), shaded: {}, cards: new Map(),
        buildGrenade() { return {}; },
        _wrap(key, id) { this.items.set(key, { key, id }); },
        ensure(id) { events.push(`build:${id}`); return { key: `${id}:default`, id }; },
        _bakeFlat(item) { events.push(`flat:${item.id}`); return `flat:${item.id}`; },
        _bakeShaded(item) { events.push(`card:${item.id}`); return `card:${item.id}`; }
    };
    await build.call(studio);
    for (const id of ['frag', 'ar', 'smg', 'shotgun', 'pistol']) {
        assert.equal(studio.flat.get(id), `flat:${id}`);
        assert.equal(studio.shaded[id], `card:${id}`);
        const flat = events.indexOf(`flat:${id}`);
        assert.equal(events[flat + 1], 'yield');
        assert.equal(events[flat + 2], `card:${id}`);
        assert.equal(events[flat + 3], 'yield');
    }
    assert.equal(studio.cards.size, 4);
});

test('final boot warms the shared grenade in the world renderer before detaching its template', async () => {
    const start = source.indexOf('{let f0=new Vs(4,4,{type:Yn});', source.indexOf('t.loading(.93,"FINAL CHECKS")'));
    const stop = source.indexOf('await audioReady;', start);
    assert.ok(start >= 0 && stop > start);
    const template = { parent: null, geometry: {}, material: {} };
    const scene = {
        add(object) { assert.equal(object, template); object.parent = this; },
        remove(object) { assert.equal(object, template); object.parent = null; },
    };
    const renderer = { shadowMap: {} };
    const camera = {};
    const viewmodelScene = {};
    const viewmodelCamera = {};
    const effects = Array.from({ length: 4 }, () => ({
        visible: false, isInstancedMesh: true, count: 0, instanceMatrix: { count: 10 },
        geometry: { drawRange: { start: 0, count: 10 } },
    }));
    const events = [];
    let finishCompile;
    const pending = vm.runInNewContext(`(async()=>${source.slice(start, stop)})()`, {
        Vs: class { dispose() { events.push('dispose'); } }, Yn: 1,
        i: scene, _: template, r: renderer, a: camera,
        n: { vmScene: viewmodelScene, vmCamera: viewmodelCamera },
        b: { bots: [], k9: { rigs: () => [] } },
        p: { chunkMesh: effects[0], caseMesh: effects[1] },
        u: { decals: { mesh: effects[2] } }, d: { shards: effects[3] },
        VC(activeRenderer, activeScene, activeCamera) {
            assert.equal(activeRenderer, renderer);
            assert.equal(template.parent, scene);
            if (activeScene === scene) {
                assert.equal(activeCamera, camera);
                events.push('compile world');
                return new Promise(resolve => { finishCompile = resolve; });
            }
            assert.equal(activeScene, viewmodelScene);
            assert.equal(activeCamera, viewmodelCamera);
            events.push('compile weapon');
        },
        Rs0(activeRenderer, activeScene, activeCamera) {
            assert.equal(activeRenderer, renderer);
            assert.equal(activeScene, scene);
            assert.equal(activeCamera, camera);
            assert.equal(template.parent, scene, 'the shared material textures participate in the real upload draw');
            events.push('upload');
        },
    });
    assert.deepEqual(events, ['compile world']);
    assert.equal(template.parent, scene);
    finishCompile();
    await pending;
    assert.deepEqual(events, ['compile world', 'compile weapon', 'upload', 'dispose']);
    assert.equal(template.parent, null, 'the boot template must not remain in the live world');
});
