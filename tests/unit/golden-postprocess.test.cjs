const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = readFileSync(process.env.GOLDEN_RUNTIME_SOURCE ||
    resolve(__dirname, '../../static/games/golden-hour/dist/game.js'), 'utf8');
const { THREE, Graphics, Bloom, GTAO, qualities } = vm.runInNewContext(
    `${source.slice(0, source.indexOf(';var Ii='))};HY=()=>null;return {THREE:Ct,Graphics:BM,Bloom:mg,GTAO:gg,qualities:c9};})();`,
    { AbortController, console, window: { devicePixelRatio: 1 }, innerWidth: 952, innerHeight: 538 },
);

function graphics(quality, { composite = false, failAt = '' } = {}) {
    const gfx = Object.create(Graphics.prototype);
    const draws = [];
    let target = null;
    let depthTexture;
    let depthMode;
    let particleDraws = 0;
    const renderer = {
        autoClear: true, autoClearColor: true, autoClearDepth: true, autoClearStencil: true,
        ratio: 1, width: 952, height: 538, color: new THREE.Color(), alpha: 1,
        getPixelRatio() { return this.ratio; },
        setPixelRatio(value) { this.ratio = value; },
        setSize(width, height) { this.width = width; this.height = height; },
        getDrawingBufferSize(size) { return size.set(Math.floor(this.width * this.ratio), Math.floor(this.height * this.ratio)); },
        getRenderTarget() { return target; },
        setRenderTarget(value) { target = value; },
        getClearColor(color) { return color.copy(this.color); },
        setClearColor(color, alpha = this.alpha) { this.color.set(color); this.alpha = alpha; },
        getClearAlpha() { return this.alpha; },
        setClearAlpha(alpha) { this.alpha = alpha; },
        clear(color = true, depth = true) { if (target && depth) target.depthContent = 'clear'; },
        clearDepth() { this.clear(false, true); },
        render(scene, camera) {
            const world = scene === gfx.scene && camera === gfx.camera && camera.layers.mask === 3;
            const particles = scene === gfx.scene && camera === gfx.camera && camera.layers.mask === 4;
            if (world) {
                if (failAt === 'world') throw new Error('world failed');
                target.depthContent = 'world';
            }
            if (particles) {
                if (failAt === 'particles') throw new Error('particles failed');
                particleDraws++;
                assert.equal(depthTexture.content, 'world', 'soft particles retain resolved world depth');
                if (!depthMode[1]) assert.equal(target.depthContent, 'world', 'world MSAA depth survives composite');
            }
            draws.push({ target, resolveDepth: target?.resolveDepthBuffer, samples: target?.samples, world, particles });
            if (target?.samples > 0) {
                if (target.resolveDepthBuffer) {
                    if (target.depthTexture) target.depthTexture.content = target.depthContent;
                } else {
                    // Three can invalidate both the multisample attachment and resolved texture.
                    target.depthContent = 'invalid';
                    if (target.depthTexture) target.depthTexture.content = 'invalid';
                }
            }
        },
    };
    const fx = {
        p: { drawn: 1 }, distort: { drawn: 0 },
        releaseTargets() {}, resize() {}, onQuality() {},
        prePass(camera, depth) {
            depthTexture = depth;
            assert.equal(depth.content, 'world', 'effects receive the current resolved world depth');
        },
        renderVolumetric() { return composite ? {} : null; },
        setDepthMode(...mode) { depthMode = mode; },
    };
    Object.assign(gfx, {
        renderer, q: qualities[quality], _passes: [], composer: null, size: new THREE.Vector2(), fx,
        scene: new THREE.Scene(), vmScene: new THREE.Scene(),
        camera: new THREE.PerspectiveCamera(), vmCamera: new THREE.PerspectiveCamera(),
        exposure: { auto: 1 }, _blurK: 0, _reproj: new THREE.Matrix4(),
    });
    gfx.camera.layers.enable(1);
    gfx._build();
    gfx.fxPass._warm = true;
    return { gfx, draws, particleDraws: () => particleDraws };
}

for (const quality of ['medium', 'high']) {
    for (const composite of [false, true]) {
        test(`${quality}: geometry retains MSAA and soft-particle depth while the postprocess tail uses resolved color (${composite ? 'volumetric' : 'ordinary'})`, () => {
            const { gfx, draws, particleDraws } = graphics(quality, { composite });
            const targets = [gfx.composer.renderTarget1, gfx.composer.renderTarget2];
            for (let frame = 0; frame < 2; frame++) gfx.composer.render(1 / 60);
            assert.equal(particleDraws(), 2);
            assert.ok(draws.some(draw => draw.world && draw.resolveDepth));
            const postprocess = draws.filter(draw => targets.includes(draw.target) && !draw.world && !draw.particles);
            assert.ok(postprocess.some(draw => draw.resolveDepth === false));
            for (const target of targets) {
                assert.equal(target.samples, qualities[quality].samples);
                assert.equal(target.depthBuffer, true);
                assert.equal(target.resolveDepthBuffer, false);
            }
            for (const draw of draws.filter(draw => targets.includes(draw.target))) {
                assert.equal(draw.samples, qualities[quality].samples);
            }
            assert.ok(draws.some(draw => gfx._postTargets.includes(draw.target)));
            for (const target of gfx._postTargets) {
                assert.equal(target.samples, 0);
                assert.equal(target.depthBuffer, false);
                assert.equal(target.texture.type, targets[0].texture.type);
                assert.equal(target.texture.minFilter, targets[0].texture.minFilter);
                assert.deepEqual([target.width, target.height], [targets[0].width, targets[0].height]);
            }
            gfx._dispose();
        });
    }
}

test('temporary world and particle depth resolution restores after failed rendering', () => {
    for (const failAt of ['world', 'particles']) {
        const { gfx } = graphics('high', { failAt });
        assert.throws(() => gfx.composer.render(1 / 60), new RegExp(`${failAt} failed`));
        assert.equal(gfx.composer.renderTarget1.resolveDepthBuffer, false);
        assert.equal(gfx.composer.renderTarget2.resolveDepthBuffer, false);
        gfx._dispose();
    }
});

test('postprocess swapping follows active blur passes without feeding post targets back into geometry', () => {
    const { gfx } = graphics('high', { composite: true });
    const composer = gfx.composer;
    const geometry = [composer.renderTarget1, composer.renderTarget2];
    const post = gfx._postTargets;
    const seen = [];
    for (const pass of composer.passes) {
        const render = pass.render;
        pass.render = function (renderer, write, read, delta, mask) {
            const result = render.call(this, renderer, write, read, delta, mask);
            seen.push({ pass, write, read, swaps: this.needsSwap });
            return result;
        };
    }
    for (const [blur, delta, rays] of [[1, 1 / 60, true], [0, 1 / 60, false], [1, 0, true], [1, 1 / 30, false]]) {
        gfx.vmBlur = blur;
        gfx.shutter = .38;
        gfx.rays.enabled = rays;
        seen.length = 0;
        const priorTarget = {};
        gfx.renderer.setRenderTarget(priorTarget);
        composer.render(delta);
        assert.equal(gfx.renderer.getRenderTarget(), priorTarget);
        assert.ok(geometry.includes(composer.readBuffer));
        assert.ok(geometry.includes(composer.writeBuffer));
        const boundary = seen.findIndex(entry => entry.pass === gfx.vmPass);
        for (const entry of seen.slice(0, boundary + 1)) {
            assert.ok(geometry.includes(entry.read));
            assert.ok(geometry.includes(entry.write));
        }
        let expectedRead = composer.readBuffer;
        let expectedWrite = post[0];
        for (const entry of seen.slice(boundary + 1)) {
            assert.equal(entry.read, expectedRead);
            assert.equal(entry.write, expectedWrite);
            assert.notEqual(entry.read, entry.write);
            if (entry.swaps) {
                expectedRead = expectedWrite;
                expectedWrite = expectedWrite === post[0] ? post[1] : post[0];
            }
        }
        assert.equal(gfx.vmBlurPass.needsSwap, blur > 0 && delta > 1e-5);
    }
    const old = {};
    gfx.renderer.setRenderTarget(old);
    gfx.bloom.render = () => { throw new Error('postprocess failed'); };
    assert.throws(() => composer.render(1 / 60), /postprocess failed/);
    assert.equal(gfx.renderer.getRenderTarget(), old);
    assert.ok(geometry.includes(composer.readBuffer));
    gfx._dispose();
});

test('postprocess targets resize and release across quality changes without allocating them for low quality', () => {
    const { gfx } = graphics('medium');
    let targets = gfx._postTargets;
    for (const quality of ['high', 'ultra', 'low', 'medium']) {
        const old = targets || [];
        let disposed = 0;
        for (const target of old) target.addEventListener('dispose', () => disposed++);
        gfx.q = qualities[quality];
        gfx._build();
        assert.equal(disposed, old.length);
        targets = gfx._postTargets;
        if (quality === 'low') {
            assert.equal(targets, null);
            continue;
        }
        assert.equal(targets.length, 2);
        assert.notEqual(targets, old);
        const sameTargets = targets;
        gfx._measure = () => new THREE.Vector2(1200, 700);
        gfx.resize();
        assert.equal(gfx._postTargets, sameTargets);
        for (const target of targets) assert.deepEqual([target.width, target.height], [1200, 700]);
    }
    let disposed = 0;
    for (const target of targets) target.addEventListener('dispose', () => disposed++);
    gfx._dispose();
    assert.equal(disposed, 2);
    assert.equal(gfx._postTargets, null);
});

test('Bloom and AO intermediates omit depth while retaining resolution, precision and normal depth', () => {
    const bloom = new Bloom(new THREE.Vector2(1366, 768), .3, .5, 1.35);
    const targets = [bloom.renderTargetBright, ...bloom.renderTargetsHorizontal, ...bloom.renderTargetsVertical];
    assert.equal(targets.length, 11);
    for (const target of targets) {
        assert.equal(target.depthBuffer, false);
        assert.equal(target.texture.type, THREE.HalfFloatType);
    }
    assert.deepEqual(Array.from(bloom.renderTargetsHorizontal, target => [target.width, target.height]),
        [[683, 384], [342, 192], [171, 96], [86, 48], [43, 24]]);
    bloom.setSize(952, 538);
    assert.deepEqual([bloom.renderTargetBright.width, bloom.renderTargetBright.height], [476, 269]);
    const ao = new GTAO(new THREE.Scene(), new THREE.PerspectiveCamera(), 952, 538);
    for (const target of [ao.gtaoRenderTarget, ao.pdRenderTarget]) {
        assert.equal(target.depthBuffer, false);
        assert.equal(target.texture.type, THREE.HalfFloatType);
        assert.deepEqual([target.width, target.height], [952, 538]);
    }
    assert.equal(ao.normalRenderTarget.depthBuffer, true);
    assert.ok(ao.normalRenderTarget.depthTexture);
    bloom.dispose();
    ao.dispose();
    ao.gtaoMaterial.dispose();
    ao.blendMaterial.dispose();
});

test('quality rebuild disposes the old Bloom high-pass material and all intermediate targets', () => {
    const { gfx } = graphics('medium');
    for (const quality of ['high', 'medium', 'high']) {
        const old = gfx.bloom;
        const resources = [old.materialHighPassFilter, old.renderTargetBright,
            ...old.renderTargetsHorizontal, ...old.renderTargetsVertical,
            ...old.separableBlurMaterials, old.compositeMaterial, old.blendMaterial];
        const disposals = new Map(resources.map(resource => [resource, 0]));
        for (const resource of resources) resource.addEventListener('dispose', () => disposals.set(resource, disposals.get(resource) + 1));
        gfx.q = qualities[quality];
        gfx._build();
        assert.notEqual(gfx.bloom, old);
        for (const count of disposals.values()) assert.equal(count, 1);
        assert.equal(gfx.composer.renderTarget1.samples, qualities[quality].samples);
    }
    gfx._dispose();
});
