const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = readFileSync(process.env.GOLDEN_RUNTIME_SOURCE ||
    resolve(__dirname, '../../static/games/golden-hour/dist/game.js'), 'utf8');
const THREE = vm.runInThisContext(`${source.slice(0, source.indexOf('var iu='))}return Ct;})();`);
const start = source.indexOf('GhShadowCache=class');
const GhShadowCache = vm.runInNewContext(`(${source.slice(start + 14, source.indexOf(',GhDynRes=class{', start))})`);

// A stand-in for Three's shadow pass: it binds the light's map, clears it, then draws every
// visible shadow caster on the camera's layers, exactly the objects the real pass would draw.
function fixture() {
    const passes = [];
    const gl = {
        READ_FRAMEBUFFER: 1, DRAW_FRAMEBUFFER: 2, COLOR_BUFFER_BIT: 4, DEPTH_BUFFER_BIT: 8, NEAREST: 9,
        blits: [], blitFramebuffer(...args) { this.blits.push(args); },
    };
    const framebuffers = new Map();
    const renderer = {
        target: null,
        getRenderTarget() { return this.target; },
        getContext() { return gl; },
        clear() { passes.at(-1).cleared = true; },
        properties: { get(rt) { if (!framebuffers.has(rt)) framebuffers.set(rt, { __webglFramebuffer: { rt } }); return framebuffers.get(rt); } },
        state: { binds: [], bindFramebuffer(target, fb) { this.binds.push([target, fb]); } },
    };
    const makeMap = () => ({
        width: 2048, height: 2048, texture: {},
        clone() { const copy = makeMap(); copy.isCache = true; return copy; },
        dispose() { this.disposed = true; },
    });
    renderer.shadowMap = {
        enabled: true, autoUpdate: false, needsUpdate: false, type: THREE.PCFSoftShadowMap,
        render(lights, scene, camera) {
            if (this.enabled === false || this.autoUpdate === false && this.needsUpdate === false) return;
            const light = lights[0];
            if (light.shadow.map === null) light.shadow.map = makeMap();
            const pass = { map: light.shadow.map, drawn: [] };
            passes.push(pass);
            renderer.target = light.shadow.map;
            renderer.clear();
            scene.traverseVisible((o) => {
                if (o.isMesh && o.castShadow && o.layers.test(camera.layers)) pass.drawn.push(o.name);
            });
            renderer.target = null;
            this.needsUpdate = false;
        },
    };
    const cache = new GhShadowCache(renderer);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera();
    const light = new THREE.DirectionalLight();
    light.castShadow = true;
    scene.add(light, light.target);
    const material = new THREE.MeshStandardMaterial();
    const mesh = (name) => {
        const m = new THREE.Mesh(new THREE.BoxGeometry(), material.clone());
        m.name = name;
        m.castShadow = true;
        scene.add(m);
        return m;
    };
    const frame = () => {
        scene.updateMatrixWorld();
        const before = passes.length;
        renderer.shadowMap.needsUpdate = true;
        renderer.shadowMap.render([light], scene, camera);
        return passes.slice(before).map((p) => ({
            into: p.map.isCache ? 'cache' : 'map', drawn: p.drawn.sort().join(','), cleared: !!p.cleared,
        }));
    };
    return { cache, renderer, scene, light, gl, mesh, frame };
}

test('the first frame draws everything, then still casters are baked once and only movers redraw', () => {
    const { cache, gl, mesh, frame, scene } = fixture();
    const wall = mesh('wall');
    mesh('desk');
    const guard = mesh('guard');
    guard.isSkinnedMesh = true;

    // No shadow map exists yet: Three creates it during a normal full pass.
    assert.deepEqual(frame(), [{ into: 'map', drawn: 'desk,guard,wall', cleared: true }]);
    // The cache is baked with the still casters, then the map gets the cache plus the animated one.
    assert.deepEqual(frame(), [
        { into: 'cache', drawn: 'desk,wall', cleared: true },
        { into: 'map', drawn: 'guard', cleared: false },
    ]);
    assert.equal(gl.blits.length, 1);
    assert.deepEqual(gl.blits[0], [0, 0, 2048, 2048, 0, 0, 2048, 2048, 12, 9]);
    // Steady state: one pass, one copy, only the animated caster is drawn.
    for (let i = 0; i < 5; i++) assert.deepEqual(frame(), [{ into: 'map', drawn: 'guard', cleared: false }]);
    assert.equal(cache.stats.bakes, 1);
    // castShadow is only lowered for the duration of a pass.
    scene.traverse((o) => { if (o.isMesh) assert.equal(o.castShadow, true); });
    assert.equal(wall.castShadow, true);
});

test('a cached caster that moves, hides or changes material is rebaked out in the same frame', () => {
    const { cache, mesh, frame } = fixture();
    const wall = mesh('wall');
    const desk = mesh('desk');
    const lamp = mesh('lamp');
    const rug = mesh('rug');
    frame(); frame();
    assert.equal(cache.stats.bakes, 1);

    desk.position.x = 2;
    assert.deepEqual(frame(), [
        { into: 'cache', drawn: 'lamp,rug,wall', cleared: true },
        { into: 'map', drawn: 'desk', cleared: false },
    ]);
    wall.visible = false;
    assert.deepEqual(frame(), [
        { into: 'cache', drawn: 'lamp,rug', cleared: true },
        { into: 'map', drawn: 'desk', cleared: false },
    ]);
    lamp.material.visible = false;
    assert.equal(frame()[0].into, 'cache');
    rug.material = rug.material.clone();
    assert.deepEqual(frame(), [
        { into: 'cache', drawn: '', cleared: true },
        { into: 'map', drawn: 'desk,lamp,rug', cleared: false },
    ]);
    assert.equal(cache.stats.bakes, 5);
});

test('new casters draw live without a rebake, and settled movers rejoin the cache', () => {
    const { cache, mesh, frame } = fixture();
    mesh('wall');
    frame(); frame();
    const props = ['crate', 'chair', 'bin'].map(mesh);
    assert.deepEqual(frame(), [{ into: 'map', drawn: 'bin,chair,crate', cleared: false }]);
    assert.equal(cache.stats.bakes, 1);
    // After holding still for 60 frames (and 90 since the last bake) they are baked back in.
    let rebake;
    for (let i = 0; i < 100 && !rebake; i++) {
        const passes = frame();
        if (passes.length === 2) rebake = passes;
    }
    assert.deepEqual(rebake, [
        { into: 'cache', drawn: 'bin,chair,crate,wall', cleared: true },
        { into: 'map', drawn: '', cleared: false },
    ]);
    assert.equal(props.every((p) => p.castShadow), true);
});

test('the light moving, the map changing size, or the cache turning off all fall back safely', () => {
    const { cache, renderer, light, mesh, frame } = fixture();
    mesh('wall');
    frame(); frame();
    light.position.set(4, 9, 2);
    assert.equal(frame()[0].into, 'cache');

    light.shadow.map = null;
    assert.deepEqual(frame(), [{ into: 'map', drawn: 'wall', cleared: true }]);
    assert.equal(frame()[0].into, 'cache');

    cache.enabled = false;
    assert.deepEqual(frame(), [{ into: 'map', drawn: 'wall', cleared: true }]);
    cache.enabled = true;
    assert.equal(frame()[0].into, 'cache');

    renderer.shadowMap.type = THREE.VSMShadowMap;
    assert.deepEqual(frame(), [{ into: 'map', drawn: 'wall', cleared: true }]);
});
