const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = readFileSync(process.env.GOLDEN_RUNTIME_SOURCE ||
    resolve(__dirname, '../../static/games/golden-hour/dist/game.js'), 'utf8');
const THREE = vm.runInThisContext(`${source.slice(0, source.indexOf('var iu='))}return Ct;})();`);

function loadClass(name, end, globals) {
    const start = source.indexOf(`${name}=class`);
    const stop = source.indexOf(end, start);
    assert.ok(start >= 0 && stop > start);
    return vm.runInNewContext(`(${source.slice(start + name.length + 1, stop)})`, globals);
}

const Graphics = loadClass('BM', ';var Ii=', {
    Hm: class { constructor() { this.shadowMap = {}; this.info = { reset() {} }; } },
    Q1: THREE.NoToneMapping, gx: THREE.PCFSoftShadowMap,
    zr: THREE.Scene, Eo: THREE.PerspectiveCamera, c9: { high: { mblur: 8 } },
    It: THREE.Vector2, a0: THREE.Vector3, Ft: THREE.Quaternion, Lt: THREE.Matrix4,
    OM: new THREE.Quaternion(), kL: new THREE.Matrix4(), CL: new THREE.Matrix4(),
    innerWidth: 800, innerHeight: 600,
    addEventListener() {},
});
const buildGraphics = Graphics.prototype._build;
Graphics.prototype._build = () => {};

function graphics() {
    const canvas = new EventTarget();
    const gfx = new Graphics(canvas);
    gfx.canvas = canvas;
    gfx.uniforms = { uTime: { value: 0 }, uAuto: { value: 1 } };
    gfx.bloom = {};
    gfx.rays = { enabled: true, uniforms: {
        uSun: { value: new THREE.Vector2() }, uK: { value: 0 }, uAspect: { value: 0 },
    } };
    gfx.composer = { render() {} };
    return gfx;
}

test('each logical frame updates both hierarchies once and keeps cameras, hooks and shadows live', () => {
    const gfx = graphics();
    const actors = [new THREE.Object3D(), new THREE.Object3D()];
    const scenes = [gfx.scene, gfx.vmScene];
    const updates = [0, 0];
    scenes.forEach((scene, index) => {
        const group = new THREE.Group();
        group.position.y = 2;
        group.add(actors[index]);
        scene.add(group);
        const update = scene.updateMatrixWorld.bind(scene);
        scene.updateMatrixWorld = (...args) => { updates[index]++; update(...args); };
    });
    let hooks = 0;
    let shadows = 0;
    const seen = [];
    for (const actor of actors) actor.onBeforeRender = () => hooks++;
    const render = (scene, camera) => {
        if (scene.matrixWorldAutoUpdate) scene.updateMatrixWorld();
        if (!camera.parent && camera.matrixWorldAutoUpdate) camera.updateMatrixWorld();
        if (gfx.renderer.shadowMap.needsUpdate) {
            shadows++;
            gfx.renderer.shadowMap.needsUpdate = false;
        }
        const actor = actors[scenes.indexOf(scene)];
        actor.onBeforeRender();
        seen.push([actor.matrixWorld.elements[12], actor.matrixWorld.elements[13]]);
    };
    const reflection = new THREE.PerspectiveCamera();
    gfx.preRender = () => render(gfx.scene, reflection);
    gfx.composer.render = () => {
        render(gfx.scene, gfx.camera);
        render(gfx.scene, gfx.camera);
        render(gfx.vmScene, gfx.vmCamera);
        render(gfx.vmScene, gfx.vmCamera);
    };
    for (let frame = 1; frame <= 2; frame++) {
        actors[0].position.x = frame * 3;
        actors[1].position.x = frame * 5;
        gfx.camera.position.z = frame * 7;
        reflection.position.x = frame * 11;
        gfx.render(1 / 60);
        assert.deepEqual(updates, [frame, frame]);
        assert.equal(gfx.camera.matrixWorld.elements[14], frame * 7);
        assert.equal(reflection.matrixWorld.elements[12], frame * 11);
        assert.deepEqual(seen.slice(-5), [
            [frame * 3, 2], [frame * 3, 2], [frame * 3, 2], [frame * 5, 2], [frame * 5, 2],
        ]);
        for (const scene of scenes) assert.equal(scene.matrixWorldAutoUpdate, true);
    }
    assert.equal(hooks, 10);
    assert.equal(shadows, 2);
});

test('logical-frame hierarchy flags restore after reflection or composer failure', () => {
    for (const failure of ['preRender', 'composer']) {
        for (const worldAuto of [false, true]) {
            const gfx = graphics();
            gfx.scene.matrixWorldAutoUpdate = worldAuto;
            gfx.vmScene.matrixWorldAutoUpdate = !worldAuto;
            const fail = () => { throw new Error('render failed'); };
            if (failure === 'preRender') gfx.preRender = fail;
            else gfx.composer.render = fail;
            assert.throws(() => gfx.render(1 / 60), /render failed/);
            assert.equal(gfx.scene.matrixWorldAutoUpdate, worldAuto);
            assert.equal(gfx.vmScene.matrixWorldAutoUpdate, !worldAuto);
        }
    }
});

test('paused frames reuse the presented scene and gameplay resumes drawing every frame', () => {
    const gfx = graphics();
    let sceneUpdates = 0;
    let viewUpdates = 0;
    let reflections = 0;
    let composites = 0;
    gfx.scene.updateMatrixWorld = () => sceneUpdates++;
    gfx.vmScene.updateMatrixWorld = () => viewUpdates++;
    gfx.preRender = () => reflections++;
    gfx.composer.render = () => composites++;
    gfx.render(1 / 60, true);
    const pausedTime = gfx.time;
    for (let frame = 0; frame < 60; frame++) gfx.render(1 / 60, true);
    assert.deepEqual([sceneUpdates, viewUpdates, reflections, composites], [1, 1, 1, 1]);
    assert.equal(gfx.time, pausedTime);
    gfx.render(1 / 60, false);
    gfx.render(1 / 60, false);
    assert.deepEqual([sceneUpdates, viewUpdates, reflections, composites], [3, 3, 3, 3]);
    assert.ok(gfx.time > pausedTime);
    gfx.render(1 / 60, true);
    gfx.render(1 / 60, true);
    assert.equal(composites, 4);
});

test('a failed pause render retries instead of caching an unpresented frame', () => {
    for (const failure of ['preRender', 'composer']) {
        const gfx = graphics();
        let attempts = 0;
        const failOnce = () => {
            if (++attempts === 1) throw new Error('render failed');
        };
        if (failure === 'preRender') gfx.preRender = failOnce;
        else gfx.composer.render = failOnce;
        assert.throws(() => gfx.render(1 / 60, true), /render failed/);
        gfx.render(1 / 60, true);
        gfx.render(1 / 60, true);
        assert.equal(attempts, 2);
    }
});

test('resize invalidates the paused frame and redraws at the new dimensions once', () => {
    const gfx = graphics();
    let draws = 0;
    const sizes = [];
    gfx.composer.render = () => draws++;
    gfx.composer.setSize = (width, height) => sizes.push([width, height]);
    gfx.uniforms.uRes = { value: new THREE.Vector2() };
    gfx._measure = () => new THREE.Vector2(1000, 750);
    gfx.render(1 / 60, true);
    gfx.resize();
    gfx.render(1 / 60, true);
    gfx.render(1 / 60, true);
    assert.equal(draws, 2);
    assert.deepEqual(sizes, [[1000, 750]]);
    assert.deepEqual(gfx.uniforms.uRes.value.toArray(), [1000, 750]);
    assert.equal(gfx.camera.aspect, 800 / 600);
});

test('rebuilding render targets invalidates the old paused frame before disposal', () => {
    const gfx = graphics();
    gfx.render(1 / 60, true);
    gfx._dispose = () => {
        assert.equal(gfx.pausedFrame, false);
        throw new Error('rebuild boundary');
    };
    assert.throws(() => buildGraphics.call(gfx), /rebuild boundary/);
});

test('settings changes redraw the paused view once with the new field of view', () => {
    const start = source.indexOf('function H(f0){n.pausedFrame=');
    const stop = source.indexOf('fo.setOcclusionTester', start);
    assert.ok(start >= 0 && stop > start);
    const gfx = graphics();
    let draws = 0;
    let viewFovUpdates = 0;
    gfx.composer.render = () => draws++;
    const applySetting = vm.runInNewContext(`(${source.slice(start, stop)})`, {
        n: gfx, a: gfx.camera, _s: { fov: 97 }, Je: { state: 'paused' },
        S: { adsK: .4 }, E: { setFov() { viewFovUpdates++; } }, kg: fov => fov,
    });
    gfx.render(1 / 60, true);
    applySetting('fov');
    gfx.render(1 / 60, true);
    gfx.render(1 / 60, true);
    assert.equal(draws, 2);
    assert.equal(gfx.camera.fov, 97);
    assert.equal(viewFovUpdates, 1);
});

test('restoring a WebGL context redraws a paused canvas whose cached content was lost', () => {
    const gfx = graphics();
    let draws = 0;
    gfx.composer.render = () => draws++;
    gfx.render(1 / 60, true);
    gfx.canvas.dispatchEvent(new Event('webglcontextrestored'));
    gfx.render(1 / 60, true);
    gfx.render(1 / 60, true);
    assert.equal(draws, 2);
});

test('rays skip only the shader identity branch and resume with unchanged parameters', () => {
    const gfx = graphics();
    gfx.render(1 / 60);
    assert.equal(gfx.rays.enabled, true);
    for (const rayK of [0, .001, .003, .3, 0]) {
        gfx.rayK = rayK;
        gfx.sunUv.set(.2, .8);
        gfx.camera.aspect = 1.7;
        gfx.render(1 / 60);
        assert.equal(gfx.rays.enabled, rayK * .7 > .002);
        assert.equal(gfx.rays.uniforms.uK.value, rayK * .7);
        assert.deepEqual(gfx.rays.uniforms.uSun.value.toArray(), [.2, .8]);
        assert.equal(gfx.rays.uniforms.uAspect.value, 1.7);
    }
});

const Effects = loadClass('$M', ';var ZM=', {
    Dt: THREE.Color,
    GL: () => ({ shaftMesh: new THREE.Mesh(), shaftMat: { uniforms: { uK: { value: .055 } } },
        motePts: new THREE.Points(), moteMat: {} }),
});

test('zero-intensity shafts hide while dust remains and low-quality shafts restore', () => {
    const fx = Object.create(Effects.prototype);
    fx.scene = new THREE.Scene();
    fx.shared = {};
    fx.releaseTargets = () => {};
    fx.atlas = { ready: true };
    fx.vol = { setSteps(value) { this.steps = value; } };
    fx.distort = { clear() {} };
    fx.buildShafts([], new THREE.Vector3());
    const dust = fx.scene.children[1];
    for (const quality of [
        { soft: true, vol: 20, distort: true, fxK: 1 },
        { soft: false, vol: 0, distort: false, fxK: .55 },
        { soft: true, vol: 12, distort: true, fxK: .8 },
    ]) {
        fx.onQuality(quality);
        assert.equal(fx.shaftMesh.visible, !quality.soft);
        assert.equal(fx.shaftMat.uniforms.uK.value, quality.soft ? 0 : .055);
        assert.equal(dust.visible, true);
        assert.equal(fx.vol.steps, quality.soft ? quality.vol : 0);
        assert.equal(fx.k, quality.fxK);
    }
});

const FxPass = loadClass('f9', ',u9=', {
    Dr: class {}, NM: new THREE.Color(),
});

test('an empty particle pass skips rendering but retains output target and depth setup', () => {
    for (const gtao of [false, true]) {
        for (const drawn of [0, 3]) {
            const world = { depthTexture: {}, texture: {} };
            const input = gtao ? { texture: {} } : world;
            const output = { texture: {} };
            const camera = new THREE.PerspectiveCamera();
            camera.layers.enable(1);
            const mask = camera.layers.mask;
            const clears = [];
            const draws = [];
            const depth = [];
            const renderer = {
                autoClear: true, target: input, color: new THREE.Color(0x123456), alpha: .4,
                getClearAlpha() { return this.alpha; },
                getClearColor(value) { return value.copy(this.color); },
                setClearColor(value, alpha) { this.color.set(value); this.alpha = alpha; },
                setRenderTarget(value) { this.target = value; },
                clear(...args) { clears.push(args); },
                render(scene, cam) { draws.push({ scene, mask: cam.layers.mask, target: this.target }); },
            };
            const fx = { p: { drawn }, distort: { drawn: 0 }, prePass() {},
                setDepthMode(...args) { depth.push(args); } };
            const pass = Object.create(FxPass.prototype);
            Object.assign(pass, { gfx: { fx, camera, scene: {}, q: { soft: true, vol: 0, distort: false },
                _worldRT: world, _blurK: 0, gtao, _reproj: new THREE.Matrix4() },
            _warm: true, _particlesWarm: true, w: 800, h: 600, distRT: { texture: {} },
            uniforms: Object.fromEntries(['tDiffuse', 'tVol', 'uVolK', 'tDist', 'uDistK', 'uBlur']
                .map(key => [key, { value: null }])), quad: { render() {} } });
            pass.uniforms.uReproj = { value: new THREE.Matrix4() };
            pass.render(renderer, output, input);
            assert.equal(draws.length, drawn ? 1 : 0);
            if (drawn) assert.equal(draws[0].mask, 1 << 2);
            assert.equal(renderer.target, gtao ? output : input);
            assert.deepEqual(depth, [[1, gtao ? 1 : 0]]);
            assert.deepEqual(clears, gtao ? [[false, true, false]] : []);
            assert.equal(camera.layers.mask, mask);
            assert.equal(renderer.autoClear, true);
            assert.equal(renderer.color.getHex(), 0x123456);
            assert.equal(renderer.alpha, .4);
            if (!drawn) {
                pass._particlesWarm = false;
                pass.render(renderer, output, input);
                assert.equal(draws.length, 1);
                pass.render(renderer, output, input);
                assert.equal(draws.length, 1);
            }
        }
    }
});

const GTAO = loadClass('gg', ';gg.OUTPUT=', { Dr: class {}, Xn: THREE.NoBlending });
GTAO.OUTPUT = { Off: -1, Default: 0, Diffuse: 1, Depth: 2, Normal: 3, AO: 4, Denoise: 5 };

function gtao() {
    const pass = Object.create(GTAO.prototype);
    const uniforms = () => ({
        tDiffuse: { value: null }, tSource: { value: null }, intensity: { value: 0 },
        cameraNear: {}, cameraFar: {}, cameraProjectionMatrix: { value: new THREE.Matrix4() },
        cameraProjectionMatrixInverse: { value: new THREE.Matrix4() }, cameraWorldMatrix: { value: new THREE.Matrix4() },
    });
    Object.assign(pass, { _renderGBuffer: false, camera: new THREE.PerspectiveCamera(),
        gtaoMaterial: { uniforms: uniforms() }, pdMaterial: { uniforms: uniforms() },
        copyMaterial: { uniforms: uniforms() }, blendMaterial: { uniforms: uniforms() },
        gtaoRenderTarget: { texture: {} }, pdRenderTarget: { texture: {} },
        blendIntensity: .92, renderToScreen: false, output: GTAO.OUTPUT.Default,
    });
    return pass;
}

test('GTAO default composites once into the original output without sampling its destination', () => {
    for (const screen of [false, true]) {
        const pass = gtao();
        pass.renderToScreen = screen;
        const input = { texture: {} };
        const output = { texture: {} };
        const renders = [];
        pass._renderPass = (renderer, material, target) => renders.push({ material, target });
        pass.render({}, output, input);
        assert.equal(renders.length, 3);
        assert.equal(renders[0].material, pass.gtaoMaterial);
        assert.equal(renders[1].material, pass.pdMaterial);
        assert.equal(renders[2].material, pass.blendMaterial);
        assert.equal(renders[2].target, screen ? null : output);
        assert.equal(pass.blendMaterial.uniforms.tSource.value, input.texture);
        assert.equal(pass.blendMaterial.uniforms.tDiffuse.value, pass.pdRenderTarget.texture);
        assert.equal(pass.blendMaterial.uniforms.intensity.value, .92);
    }
});

test('GTAO diffuse debug output still copies the source without applying AO', () => {
    const pass = gtao();
    pass.output = GTAO.OUTPUT.Diffuse;
    const input = { texture: {} };
    const output = { texture: {} };
    const renders = [];
    pass._renderPass = (renderer, material, target) => renders.push({ material, target });
    pass.render({}, output, input);
    assert.equal(renders.length, 3);
    assert.equal(renders[2].material, pass.copyMaterial);
    assert.equal(renders[2].target, output);
    assert.equal(pass.copyMaterial.uniforms.tDiffuse.value, input.texture);
    assert.equal(pass.copyMaterial.blending, THREE.NoBlending);
});
