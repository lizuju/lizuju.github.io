const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = readFileSync(process.env.GOLDEN_RUNTIME_SOURCE ||
    resolve(__dirname, '../../static/games/golden-hour/dist/game.js'), 'utf8');
// The game bundles a newer Three.js than the immersive desktop host uses.
const THREE = vm.runInThisContext(`${source.slice(0, source.indexOf('var iu='))}return Ct;})();`);

function loadClass(name, end, globals) {
    const start = source.indexOf(`${name}=class`);
    assert.ok(start >= 0);
    const stop = source.indexOf(end, start);
    assert.ok(stop > start);
    return vm.runInNewContext(`(${source.slice(start + name.length + 1, stop)})`, globals);
}

const matrix = () => new THREE.Matrix4();
const vector = () => new THREE.Vector3();
const Physics = loadClass('_w', ',p$=', {
    ia: THREE.InstancedMesh, qs: THREE.BoxGeometry, ps: THREE.CylinderGeometry,
    $e: THREE.MeshStandardMaterial, ID: 320, HD: 90, DD: 9.81,
    Sw: matrix().makeScale(0, 0, 0), K9: matrix(), Sg: new THREE.Quaternion(),
    Vc: vector(), X9: vector(), Wd: vector(), xr: vector(), pu: vector(),
    Tw: new THREE.Color(), at: (min, max) => (min + max) / 2,
});

function physics() {
    return new Physics(new THREE.Scene(), { overlap: () => null }, { audio: { casing() {} } });
}

function spawn(physics, kind) {
    if (kind === 'cases') physics.casing(new THREE.Vector3(1, 2, 3), vector(), 0);
    else physics.debris(1, 2, 3, 0, 0, 0, .1, 0xffffff);
}

function simulate(physics, kind, delta = 1 / 60) {
    physics._simSingles(physics[kind], physics[kind === 'cases' ? 'caseMesh' : 'chunkMesh'], delta, kind === 'cases');
}

test('effect pools start empty and ring overwrites do not inflate the live count', () => {
    for (const kind of ['chunks', 'cases']) {
        const p = physics();
        const pool = p[kind];
        const mesh = p[kind === 'cases' ? 'caseMesh' : 'chunkMesh'];
        assert.equal(mesh.count, 0);
        assert.equal(mesh.visible, false);
        for (let i = 0; i < pool.N + 19; i++) spawn(p, kind);
        assert.equal(pool.live, pool.N);
        assert.equal(mesh.count, pool.N);
        assert.equal(mesh.visible, true);
        pool.life.fill(.001);
        simulate(p, kind);
        assert.equal(pool.live, 0);
        assert.equal(mesh.count, 0);
        assert.equal(mesh.visible, false);
    }
});

test('draw ranges preserve holes and a new spawn at a high ring index', () => {
    const p = physics();
    for (let i = 0; i < 4; i++) spawn(p, 'chunks');
    p.chunks.life[1] = .001;
    simulate(p, 'chunks');
    assert.equal(p.chunks.live, 3);
    assert.equal(p.chunkMesh.count, 4);
    p.chunks.life[3] = .001;
    simulate(p, 'chunks');
    assert.equal(p.chunkMesh.count, 3);
    p.chunks.i = 17;
    spawn(p, 'chunks');
    simulate(p, 'chunks');
    assert.equal(p.chunkMesh.count, 18);
    const result = matrix();
    p.chunkMesh.getMatrixAt(17, result);
    assert.equal(result.elements[12], 1);
    assert.equal(result.elements[14], 3);
});

test('resting debris skips uploads until its final shrink or expiration', () => {
    const p = physics();
    spawn(p, 'chunks');
    simulate(p, 'chunks');
    p.chunks.st[0] = 2;
    p.chunks.life[0] = 3;
    p.chunkMesh.instanceMatrix.clearUpdateRanges();
    let version = p.chunkMesh.instanceMatrix.version;
    simulate(p, 'chunks');
    assert.equal(p.chunkMesh.instanceMatrix.version, version);
    assert.equal(p.chunkMesh.instanceMatrix.updateRanges.length, 0);
    p.chunks.life[0] = .5;
    simulate(p, 'chunks');
    assert.equal(p.chunkMesh.instanceMatrix.version, version + 1);
    assert.deepEqual(p.chunkMesh.instanceMatrix.updateRanges, [{ start: 0, count: 16 }]);
});

test('pending matrix writes survive multiple updates and reset before a render', () => {
    const p = physics();
    spawn(p, 'chunks');
    simulate(p, 'chunks');
    p.chunks.st[0] = 2;
    p.chunks.i = 5;
    spawn(p, 'chunks');
    simulate(p, 'chunks');
    assert.deepEqual(p.chunkMesh.instanceMatrix.updateRanges,
        [{ start: 0, count: 16 }, { start: 80, count: 16 }]);
    const gpu = new Float32Array(p.chunkMesh.instanceMatrix.array);
    p.chunkMesh.instanceMatrix.clearUpdateRanges();
    p.reset();
    assert.equal(p.chunks.live, 0);
    assert.equal(p.chunkMesh.visible, false);
    assert.equal(p.chunkMesh.count, 0);
    spawn(p, 'chunks');
    simulate(p, 'chunks');
    assert.equal(p.chunkMesh.count, 7);
    assert.ok(p.chunkMesh.instanceMatrix.updateRanges.some(range =>
        range.start === 0 && range.count === p.chunkMesh.instanceMatrix.array.length));
    const old = matrix();
    p.chunkMesh.getMatrixAt(5, old);
    assert.equal(old.elements[0], 0);
    assert.equal(old.elements[5], 0);
    assert.equal(old.elements[10], 0);
    for (const { start, count } of p.chunkMesh.instanceMatrix.updateRanges) {
        gpu.set(p.chunkMesh.instanceMatrix.array.subarray(start, start + count), start);
    }
    assert.deepEqual(gpu, p.chunkMesh.instanceMatrix.array);
});

const Glass = loadClass('Ew', ',LD=', {
    ww: 3200, d$: () => new THREE.MeshBasicMaterial(),
    ne: THREE.BufferGeometry, Yt: THREE.BufferAttribute, Uc: THREE.DynamicDrawUsage,
    ae: THREE.Mesh, Ge: THREE.PlaneGeometry, ia: THREE.InstancedMesh,
    Fi: vector(), at: (min, max) => (min + max) / 2,
});

function glass() {
    const g = new Glass(new THREE.Scene(), { groundAt: () => -Infinity }, { audio: { glassDebris() {} } });
    g.build();
    return g;
}

function shard(glass, slot) {
    glass.cursor = slot;
    glass._spawnShard({ axis: 2, pos: 3 }, 0, 2, 1, 2, 0, 3, 0, 0, 0, 1);
}

test('glass draw range retains high surviving shards and becomes empty after expiry', () => {
    const g = glass();
    assert.equal(g.shards.visible, false);
    assert.equal(g.shards.geometry.drawRange.count, 0);
    shard(g, 1);
    shard(g, 7);
    assert.equal(g.active, 2);
    assert.equal(g.shards.geometry.drawRange.count, 24);
    g.sstate[1] = g.sstate[7] = 2;
    g.slife[1] = 14;
    g._simulate(.1);
    assert.equal(g.active, 1);
    assert.equal(g.shards.geometry.drawRange.count, 24);
    g.slife[7] = 14;
    g._simulate(.1);
    assert.equal(g.active, 0);
    assert.equal(g.shards.geometry.drawRange.count, 0);
    assert.equal(g.shards.visible, false);
    shard(g, 3199);
    assert.equal(g.shards.geometry.drawRange.count, 9600);
    g.reset();
    assert.equal(g.shards.geometry.drawRange.count, 0);
    assert.equal(g.shards.visible, false);
    shard(g, 0);
    g._simulate(.01);
    assert.equal(g.shards.geometry.drawRange.count, 3);
    assert.equal(g.shards.visible, true);
});

const Decals = loadClass('KM', ';var XY=', {
    qY: () => ({ map: null, normalMap: null }), $e: THREE.MeshStandardMaterial,
    It: THREE.Vector2, Ge: THREE.PlaneGeometry, ol: THREE.InstancedBufferAttribute,
    ia: THREE.InstancedMesh, Lt: THREE.Matrix4, Uc: THREE.DynamicDrawUsage,
    qM: new THREE.Color(), W2: { test: { cells: [[0, 0, 1]], size: [.1, .2] } },
    Nm: vector(), y9: vector(), BL: vector(), KY: new THREE.Vector3(0, 1, 0),
    HL: new THREE.Vector3(0, 0, 1), UL: matrix(), WM: new THREE.Quaternion(),
    IL: new THREE.Quaternion(), FL: vector(), OL: vector(), NL: matrix(), gb: 8,
});

test('decals skip unused instances and hide only after the longest remaining lifetime', () => {
    const d = new Decals(4, 1);
    const add = life => d.add('test', vector(), new THREE.Vector3(0, 1, 0), .1, null, 0, life);
    assert.equal(d.mesh.count, 0);
    assert.equal(d.mesh.visible, false);
    add(20);
    add(10);
    assert.equal(d.mesh.count, 2);
    d.update(11);
    assert.equal(d.mesh.visible, true);
    d.update(10);
    assert.equal(d.mesh.visible, false);
    add(10);
    assert.equal(d.mesh.visible, true);
    assert.equal(d.mesh.count, 3);
    add(10);
    add(10);
    assert.equal(d.mesh.count, 4);
    d.clear();
    assert.equal(d.mesh.visible, false);
    assert.equal(d.mesh.count, 0);
    add(10);
    assert.equal(d.mesh.count, 1);
});

const Graphics = loadClass('BM', ';var Ii=', {
    Hm: class { constructor() { this.shadowMap = {}; this.info = {}; } },
    Q1: THREE.NoToneMapping, gx: THREE.PCFSoftShadowMap,
    zr: THREE.Scene, Eo: THREE.PerspectiveCamera, c9: { high: {} },
    It: THREE.Vector2, a0: THREE.Vector3, Ft: THREE.Quaternion, Lt: THREE.Matrix4,
    addEventListener() {},
});
Graphics.prototype._build = () => {};

test('frozen identity scene roots still update changed actors across render passes', () => {
    const gfx = new Graphics(new EventTarget());
    for (const scene of [gfx.scene, gfx.vmScene]) {
        assert.equal(scene.matrixAutoUpdate, false);
        assert.equal(scene.matrixWorldAutoUpdate, true);
        const group = new THREE.Group();
        const actor = new THREE.Object3D();
        group.add(actor);
        scene.add(group);
        group.position.x = 3;
        actor.position.z = 4;
        scene.updateMatrixWorld();
        assert.deepEqual(actor.getWorldPosition(vector()).toArray(), [3, 0, 4]);
        group.position.x = 8;
        actor.position.z = 9;
        scene.updateMatrixWorld();
        assert.deepEqual(actor.getWorldPosition(vector()).toArray(), [8, 0, 9]);
        scene.updateMatrixWorld();
        assert.deepEqual(actor.getWorldPosition(vector()).toArray(), [8, 0, 9]);
    }
});

test('startup warms hidden effect pools and restores their draw state even if upload fails', () => {
    const start = source.indexOf('let effects=[p.chunkMesh,p.caseMesh,u.decals.mesh,d.shards]');
    assert.ok(start >= 0);
    const stop = source.indexOf('}await audioReady;', start);
    assert.ok(stop > start);
    for (const failure of [false, true]) {
        const p = physics();
        const d = glass();
        const u = { decals: new Decals(4, 1) };
        p.caseMesh.count = 2;
        p.caseMesh.visible = true;
        d.shards.geometry.setDrawRange(3, 6);
        const effects = [p.chunkMesh, p.caseMesh, u.decals.mesh, d.shards];
        const previous = effects.map(mesh => ({
            visible: mesh.visible,
            count: mesh.count,
            range: { ...mesh.geometry.drawRange },
        }));
        const actors = [{ visible: true }, { visible: true }];
        const renderer = { shadowMap: { needsUpdate: false } };
        let draws = 0;
        let disposals = 0;
        const run = () => vm.runInNewContext(source.slice(start, stop), {
            p, d, u, r: renderer, i: {}, a: {}, _0: actors,
            f0: { dispose() { disposals++; } },
            Rs0() {
                draws++;
                assert.equal(renderer.shadowMap.needsUpdate, true);
                for (const mesh of effects) {
                    assert.equal(mesh.visible, true);
                    if (mesh.isInstancedMesh) assert.equal(mesh.count, mesh.instanceMatrix.count);
                    else assert.deepEqual(mesh.geometry.drawRange,
                        { start: 0, count: mesh.geometry.attributes.position.count });
                }
                if (failure) throw new Error('upload failed');
            },
        });
        if (failure) assert.throws(run, /upload failed/);
        else run();
        assert.equal(draws, 1);
        assert.equal(disposals, 1);
        for (const actor of actors) assert.equal(actor.visible, false);
        effects.forEach((mesh, index) => {
            assert.equal(mesh.visible, previous[index].visible);
            assert.equal(mesh.count, previous[index].count);
            assert.deepEqual(mesh.geometry.drawRange, previous[index].range);
        });
    }
});
