const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = readFileSync(process.env.GOLDEN_RUNTIME_SOURCE ||
    resolve(__dirname, '../../static/games/golden-hour/dist/game.js'), 'utf8');
const THREE = vm.runInThisContext(`${source.slice(0, source.indexOf('var iu='))}return Ct;})();`);
const start = source.indexOf('function VK(');
const end = source.indexOf('var gL=', start);
const makeObjects = vm.runInNewContext(`(${source.slice(start, end)})`);
const gfxStart = source.indexOf('BM=class');
const Graphics = vm.runInNewContext(`(${source.slice(gfxStart + 3, source.indexOf(';var Ii=', gfxStart))})`, {
    Hm: class { constructor() { this.info = { render: { frame: 0 }, reset() {} }; this.shadowMap = {}; } },
    Q1: THREE.NoToneMapping, gx: THREE.PCFSoftShadowMap, zr: THREE.Scene, Eo: THREE.PerspectiveCamera,
    c9: { high: {} }, It: THREE.Vector2, a0: THREE.Vector3, Ft: THREE.Quaternion, Lt: THREE.Matrix4,
    addEventListener() {},
});
Graphics.prototype._build = () => {};

function fixture() {
    const gfx = new Graphics({ addEventListener() {} });
    gfx.uniforms = { uTime: { value: 0 }, uAuto: { value: 1 } };
    gfx.bloom = {};
    gfx._motion = () => {};
    const geometry = new THREE.BufferGeometry();
    const bone = new THREE.Bone();
    const child = new THREE.Bone();
    child.position.y = 2;
    bone.add(child);
    gfx.scene.add(bone);
    const skeleton = new THREE.Skeleton([bone, child]);
    skeleton.computeBoneTexture();
    const meshes = [new THREE.SkinnedMesh(geometry), new THREE.SkinnedMesh(geometry)];
    for (const mesh of meshes) mesh.bind(skeleton);
    let boneUpdates = 0;
    const originalUpdate = skeleton.update.bind(skeleton);
    skeleton.update = () => { boneUpdates++; originalUpdate(); };
    let geometryUpdates = 0;
    const objects = makeObjects({}, { get: (mesh, geometry) => geometry, update() { geometryUpdates++; } }, {}, gfx.renderer.info);
    const outputs = [];
    const pass = () => {
        objects.update(meshes[0]);
        objects.update(meshes[1]);
        outputs.push(Array.from(skeleton.boneMatrices));
        gfx.renderer.info.render.frame++;
    };
    gfx.preRender = pass;
    gfx.composer = { render() { pass(); pass(); pass(); } };
    return { gfx, skeleton, bone, child, objects, meshes, outputs, pass,
        boneUpdates: () => boneUpdates, geometryUpdates: () => geometryUpdates };
}

test('reflection, world, AO and weapon passes reuse identical bone matrices and a single texture version', () => {
    const f = fixture();
    for (let frame = 1; frame <= 3; frame++) {
        f.bone.position.x = frame * 2;
        f.child.position.y = frame + 2;
        const textureVersion = f.skeleton.boneTexture.version;
        f.gfx.render(1 / 60);
        assert.equal(f.boneUpdates(), frame);
        assert.equal(f.geometryUpdates(), frame * 4, 'Geometry uploads keep the original per-render cadence');
        assert.equal(f.skeleton.boneTexture.version, textureVersion + 1);
        const frameOutputs = f.outputs.slice(-4);
        for (const output of frameOutputs) assert.deepEqual(output, frameOutputs[0]);
        assert.equal(frameOutputs[0][12], frame * 2);
        assert.equal(frameOutputs[0][16 + 13], frame + 2);
        assert.equal(f.gfx.renderer.info.skeletonFrame, undefined);
    }
});

test('ordinary renderer calls between logical frames update normally and cannot collide with logical keys', () => {
    const f = fixture();
    f.gfx.render(1 / 60);
    f.bone.position.z = 7;
    f.gfx.scene.updateMatrixWorld();
    f.pass();
    f.bone.position.z = 9;
    f.gfx.scene.updateMatrixWorld();
    f.pass();
    assert.equal(f.boneUpdates(), 3);
    assert.equal(f.skeleton.boneMatrices[14], 9);
    f.bone.position.z = 12;
    f.gfx.render(1 / 60);
    assert.equal(f.boneUpdates(), 4);
    assert.equal(f.skeleton.boneMatrices[14], 12);
});

test('renderer-local caches update shared skeletons independently and reset on disposal', () => {
    const f = fixture();
    const secondInfo = { render: { frame: 0 }, skeletonFrame: -1 };
    const second = makeObjects({}, { get: (mesh, geometry) => geometry, update() {} }, {}, secondInfo);
    f.gfx.render(1 / 60);
    second.update(f.meshes[0]);
    second.update(f.meshes[1]);
    assert.equal(f.boneUpdates(), 2);
    second.dispose();
    second.update(f.meshes[0]);
    assert.equal(f.boneUpdates(), 3);
});

test('nested logical frames restore their caller marker and failures release the cache scope', () => {
    const f = fixture();
    let nested = false;
    f.gfx.preRender = () => {
        const outer = f.gfx.renderer.info.skeletonFrame;
        f.pass();
        if (!nested) {
            nested = true;
            f.gfx.render(1 / 60);
            assert.equal(f.gfx.renderer.info.skeletonFrame, outer);
        }
    };
    f.gfx.render(1 / 60);
    assert.equal(f.gfx.renderer.info.skeletonFrame, undefined);
    f.gfx.preRender = () => { f.pass(); throw new Error('reflection failed'); };
    assert.throws(() => f.gfx.render(1 / 60), /reflection failed/);
    assert.equal(f.gfx.renderer.info.skeletonFrame, undefined);
    const updates = f.boneUpdates();
    f.pass();
    assert.equal(f.boneUpdates(), updates + 1);
});

test('cached paused frames do not consume a logical skeleton frame or update bones', () => {
    const f = fixture();
    f.gfx.render(1 / 60, true);
    const frame = f.gfx._skeletonFrame;
    f.gfx.render(1 / 60, true);
    assert.equal(f.gfx._skeletonFrame, frame);
    assert.equal(f.boneUpdates(), 1);
    f.gfx.render(1 / 60, false);
    assert.equal(f.boneUpdates(), 2);
});
