const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = readFileSync(process.env.GOLDEN_RUNTIME_SOURCE ||
    resolve(__dirname, '../../static/games/golden-hour/dist/game.js'), 'utf8');

function runtime() {
    const allocations = { targets: 0, materials: 0 };
    const { Graphics, qualities } = vm.runInNewContext(`${source.slice(0, source.indexOf(';var Ii='))};
HY=()=>null;
Vs=class extends Vs {constructor(...args){super(...args);allocations.targets++}};
We=class extends We {constructor(...args){super(...args);allocations.materials++}};
_m=class extends _m {constructor(...args){super(...args);allocations.materials++}};
li=class extends li {constructor(...args){super(...args);allocations.materials++}};
Hm=class {
    constructor(){this.shadowMap={};this.info={reset(){}};this.ratio=1}
    setPixelRatio(value){this.ratio=value}getPixelRatio(){return this.ratio}
    setSize(width,height){this.width=width;this.height=height}
    getDrawingBufferSize(size){return size.set(Math.floor(this.width*this.ratio),Math.floor(this.height*this.ratio))}
};
return {Graphics:BM,qualities:c9};})();`, {
        AbortController, console, allocations, window: { devicePixelRatio: 1 }, innerWidth: 952, innerHeight: 538,
        addEventListener() {},
    });
    return { Graphics, qualities, allocations };
}

function effects() {
    return { sizes: [], qualities: [], releaseCount: 0,
        resize(width, height) { this.sizes.push([width, height]); },
        onQuality(quality) { this.qualities.push(quality); },
        releaseTargets() { this.releaseCount++; },
    };
}

for (const quality of ['low', 'medium', 'high']) {
    test(`initial ${quality} quality builds once and effects attach without replacing existing resources`, () => {
        const { Graphics, qualities, allocations } = runtime();
        const originalBuild = Graphics.prototype._build;
        let builds = 0;
        Graphics.prototype._build = function (...args) { builds++; return originalBuild.apply(this, args); };
        const gfx = new Graphics({ addEventListener() {} }, quality);
        const fx = effects();
        const before = { ...allocations };
        const { composer, bloom, final, uniforms, vmPass, meter } = gfx;
        const dimensions = Array.from(gfx.size.toArray());
        const notification = [];
        gfx.onQuality = value => notification.push(value);
        gfx.uniforms.uExposure.value = .75;
        gfx.pausedFrame = true;
        gfx.setFx(fx);
        assert.equal(builds, 1);
        assert.equal(gfx.quality, quality);
        assert.equal(gfx.q, qualities[quality]);
        assert.equal(gfx.composer, composer);
        assert.equal(gfx.bloom, bloom);
        assert.equal(gfx.final, final);
        assert.equal(gfx.uniforms, uniforms);
        assert.equal(gfx.vmPass, vmPass);
        assert.equal(gfx.meter, meter);
        assert.equal(gfx.uniforms.uExposure.value, .75);
        assert.equal(gfx.pausedFrame, false);
        assert.equal(allocations.targets - before.targets, 1, 'Only the effects distortion target is added');
        assert.equal(allocations.materials - before.materials, 1, 'Only the effects composite material is added');
        assert.equal(composer.passes[composer.passes.indexOf(vmPass) - 1], gfx.fxPass);
        assert.equal(gfx._passes[gfx._passes.indexOf(vmPass) - 1], gfx.fxPass);
        assert.deepEqual(fx.sizes, [dimensions]);
        assert.deepEqual(fx.qualities, [qualities[quality]]);
        assert.deepEqual(notification, [qualities[quality]]);
        assert.equal(composer.renderTarget1.samples, qualities[quality].samples);
        assert.equal(composer.renderTarget1.resolveDepthBuffer, false);
        gfx._dispose();
    });
}

test('runtime quality rebuild keeps the effects pass before the weapon and releases the old pipeline once', () => {
    const { Graphics, qualities } = runtime();
    const gfx = new Graphics({ addEventListener() {} }, 'medium');
    const fx = effects();
    gfx.setFx(fx);
    const qualityEvents = [];
    gfx.onQuality = quality => qualityEvents.push(quality);
    gfx.uniforms.uExposure.value = .83;
    for (const quality of ['high', 'low', 'medium']) {
        const old = { composer: gfx.composer, fx: gfx.fxPass, bloom: gfx.bloom };
        let fxDisposals = 0, highPassDisposals = 0;
        old.fx.mat.addEventListener('dispose', () => fxDisposals++);
        old.bloom.materialHighPassFilter.addEventListener('dispose', () => highPassDisposals++);
        gfx.setQuality(quality);
        assert.notEqual(gfx.composer, old.composer);
        assert.notEqual(gfx.fxPass, old.fx);
        assert.equal(fxDisposals, 1);
        assert.equal(highPassDisposals, 1);
        assert.equal(gfx.composer.passes.filter(pass => pass === gfx.fxPass).length, 1);
        assert.equal(gfx.composer.passes[gfx.composer.passes.indexOf(gfx.vmPass) - 1], gfx.fxPass);
        assert.equal(gfx.uniforms.uExposure.value, .83);
        assert.equal(gfx.composer.renderTarget1.samples, qualities[quality].samples);
        assert.equal(fx.qualities.at(-1), qualities[quality]);
        assert.equal(qualityEvents.at(-1), qualities[quality]);
        gfx.resize();
        assert.deepEqual(fx.sizes.at(-1), Array.from(gfx.size.toArray()));
    }
    gfx._dispose();
});

test('default construction remains high quality and boot passes validated saved quality directly', () => {
    const { Graphics } = runtime();
    const gfx = new Graphics({ addEventListener() {} });
    assert.equal(gfx.quality, 'high');
    const start = source.indexOf('let n=new BM(');
    const end = source.indexOf('let{scene:i,camera:a,renderer:r}=n', start);
    assert.ok(start >= 0 && end > start);
    const calls = [];
    vm.runInNewContext(source.slice(start, end), {
        BM: class { constructor(canvas, quality) { calls.push(['construct', canvas, quality]); } setMotionBlur(value) { calls.push(['motionBlur', value]); } },
        o: 'canvas', _s: { quality: 'medium', motionBlur: 'high' },
    });
    assert.deepEqual(calls, [['construct', 'canvas', 'medium'], ['motionBlur', 'high']]);
    gfx._dispose();
});
