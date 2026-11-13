const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = readFileSync(process.env.GOLDEN_RUNTIME_SOURCE ||
    resolve(__dirname, '../../static/games/golden-hour/dist/game.js'), 'utf8');
const THREE = vm.runInThisContext(`${source.slice(0, source.indexOf('var iu='))}return Ct;})();`);
const start = source.indexOf('XM=class') + 3;
const stop = source.indexOf(';var VL=', start);
const Volume = vm.runInNewContext(`(${source.slice(start, stop)})`, {
    Vs: THREE.WebGLRenderTarget, Yn: THREE.HalfFloatType, ls: THREE.LinearFilter,
    Lt: THREE.Matrix4, jf: THREE.Frustum, a0: THREE.Vector3, Dt: THREE.Color,
    me: THREE.Vector4, It: THREE.Vector2, We: THREE.ShaderMaterial, Xn: THREE.NoBlending,
    ic: class { constructor(material) { this.material = material; } render(renderer) { renderer.draws++; } },
    b9: '', YY: '', XY: '',
});

function fixture() {
    const volume = new Volume(null);
    volume.setSteps(20);
    volume.setSize(952, 538);
    const camera = new THREE.PerspectiveCamera(65, 952 / 538, .06, 2500);
    const renderer = { draws: 0, targets: [], setRenderTarget(value) { this.targets.push(value); } };
    const sun = { shadow: { map: { texture: {} }, matrix: new THREE.Matrix4() } };
    const depth = {};
    const render = () => {
        renderer.draws = 0;
        renderer.targets.length = 0;
        camera.updateProjectionMatrix();
        camera.updateMatrixWorld(true);
        return volume.render(renderer, depth, camera, sun, 7);
    };
    const look = (x, y, z, tx, ty, tz) => {
        camera.position.set(x, y, z);
        camera.lookAt(tx, ty, tz);
    };
    return { volume, camera, renderer, sun, depth, render, look };
}

function rayReachesHaze(camera, volume, x, y) {
    const direction = new THREE.Vector3(x, y, 1).unproject(camera).sub(camera.position).normalize();
    const min = volume.uniforms.uBoxMin.value;
    const max = volume.uniforms.uBoxMax.value;
    let enter = 0, leave = 46;
    for (const axis of ['x', 'y', 'z']) {
        const inverse = 1 / (direction[axis] + 1e-6);
        const a = (min[axis] - camera.position[axis]) * inverse;
        const b = (max[axis] - camera.position[axis]) * inverse;
        enter = Math.max(enter, Math.min(a, b));
        leave = Math.min(leave, Math.max(a, b));
    }
    return leave > enter;
}

test('skips all three volumetric draws only when the haze lies outside the view', () => {
    const f = fixture();
    f.look(0, 1.6, 22, 0, 1.6, 30);
    assert.equal(f.render(), null);
    assert.equal(f.renderer.draws, 0);
    assert.deepEqual(f.renderer.targets, []);
    f.look(0, 1.6, 22, 0, 1.6, 0);
    assert.equal(f.render(), f.volume.rtA.texture);
    assert.equal(f.renderer.draws, 3);
    assert.deepEqual(f.renderer.targets, [f.volume.rtA, f.volume.rtB, f.volume.rtA]);
    assert.equal(f.volume.uniforms.tDepth.value, f.depth);
    assert.equal(f.volume.uniforms.uTime.value, 7);
    f.look(0, 1.6, 22, 0, 1.6, 30);
    assert.equal(f.render(), null, 'An old visible result must not survive turning away');
});

test('keeps haze around the camera and between the camera and its near plane', () => {
    const f = fixture();
    for (const target of [[0, 1.6, -10], [0, 1.6, 10], [0, 20, 0]]) {
        f.look(0, 1.6, 0, ...target);
        assert.equal(f.render(), f.volume.rtA.texture);
    }
    f.volume.uniforms.uBoxMin.value.set(-.01, -.01, -.04);
    f.volume.uniforms.uBoxMax.value.set(.01, .01, -.01);
    f.look(0, 0, 0, 0, 0, -1);
    assert.equal(f.render(), f.volume.rtA.texture);
    assert.equal(rayReachesHaze(f.camera, f.volume, 0, 0), true);
    const ordinaryFrustum = new THREE.Frustum().setFromProjectionMatrix(
        new THREE.Matrix4().multiplyMatrices(f.camera.projectionMatrix, f.camera.matrixWorldInverse));
    assert.equal(ordinaryFrustum.intersectsBox(new THREE.Box3(
        f.volume.uniforms.uBoxMin.value, f.volume.uniforms.uBoxMax.value)), false);
});

test('retains screen-edge contributions including the shader ray epsilon', () => {
    const f = fixture();
    f.camera.fov = 90;
    f.camera.aspect = 1;
    f.look(0, 0, 0, 0, 0, -1);
    f.volume.uniforms.uBoxMin.value.set(4.9, -.1, -5.1);
    f.volume.uniforms.uBoxMax.value.set(5.1, .1, -4.9);
    assert.equal(f.render(), f.volume.rtA.texture);
    assert.equal(rayReachesHaze(f.camera, f.volume, .999, 0), true);
    f.volume.uniforms.uBoxMin.value.set(5.000004, -.1, -5.000001);
    f.volume.uniforms.uBoxMax.value.set(5.00002, .1, -4.999999);
    assert.equal(f.render(), f.volume.rtA.texture);
    assert.equal(rayReachesHaze(f.camera, f.volume, 1, 0), true);
});

test('camera movement, rotation, aspect and FOV changes never omit sampled visible haze', () => {
    const f = fixture();
    let visibleViews = 0, culledViews = 0;
    const poses = [[0, 1.6, 22], [29, 1.6, 0], [-29, 9, -21], [0, 1.6, 0]];
    for (const position of poses) for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
        for (const fov of [30, 90, 120]) for (const aspect of [.6, 2]) {
            f.camera.position.set(...position);
            f.camera.rotation.set(.2, yaw, 0);
            f.camera.fov = fov;
            f.camera.aspect = aspect;
            const result = f.render();
            let anyRay = false;
            for (const x of [-1, -.5, 0, .5, 1]) for (const y of [-1, -.5, 0, .5, 1]) {
                anyRay ||= rayReachesHaze(f.camera, f.volume, x, y);
            }
            if (anyRay) {
                visibleViews++;
                assert.equal(result, f.volume.rtA.texture, JSON.stringify({ position, yaw, fov, aspect }));
            }
            if (result === null) culledViews++;
        }
    }
    assert.ok(visibleViews > 50);
    assert.ok(culledViews > 0);
});
