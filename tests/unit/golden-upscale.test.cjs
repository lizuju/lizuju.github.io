const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = readFileSync(process.env.GOLDEN_RUNTIME_SOURCE ||
    resolve(__dirname, '../../static/games/golden-hour/dist/game.js'), 'utf8');

// The graphics class from the bundle, on a renderer stand-in that sizes its canvas the way
// three.js does (drawing buffer = CSS size x pixel ratio).
function graphics({ dpr = 2, width = 1280, height = 800, quality = 'medium' } = {}) {
    const window = { devicePixelRatio: dpr };
    const { Graphics } = vm.runInNewContext(`${source.slice(0, source.indexOf(';var Ii='))};
HY=()=>null;
Hm=class {
    constructor(){this.shadowMap={};this.info={reset(){}};this.ratio=1}
    setPixelRatio(value){this.ratio=value}getPixelRatio(){return this.ratio}
    setSize(width,height){this.width=width;this.height=height}
    getDrawingBufferSize(size){return size.set(Math.floor(this.width*this.ratio),Math.floor(this.height*this.ratio))}
};
return {Graphics:BM};})();`, {
        AbortController, console, window, innerWidth: width, innerHeight: height, addEventListener() {},
    });
    const gfx = new Graphics({ addEventListener() {} }, quality);
    const canvas = () => { const v = { x: 0, y: 0, set(x, y) { this.x = x; this.y = y; return this; } }; return gfx.renderer.getDrawingBufferSize(v); };
    return { gfx, canvas, window };
}

test('with upscaling the scene keeps its render size while the canvas takes the screen size', () => {
    const { gfx, canvas } = graphics();
    assert.equal(gfx.upscale, false);
    assert.equal(gfx._up, false);
    assert.deepEqual([gfx.size.x, gfx.size.y], [1088, 680]);
    assert.deepEqual([canvas().x, canvas().y], [1088, 680]);
    let resizes = 0;
    const resize = gfx.resize.bind(gfx);
    gfx.resize = () => { resizes++; resize(); };
    gfx.setUpscale(true);
    assert.equal(resizes, 1);
    assert.equal(gfx._up, true);
    assert.deepEqual([gfx.size.x, gfx.size.y], [1088, 680], 'MEDIUM still renders at 85%');
    assert.deepEqual([canvas().x, canvas().y], [2560, 1600], 'the canvas is the Retina screen');
    gfx.setUpscale(true);
    assert.equal(resizes, 1, 'no resize without a change');
    gfx.setUpscale(false);
    assert.equal(gfx._up, false);
    assert.deepEqual([canvas().x, canvas().y], [1088, 680]);
    gfx._dispose();
});

test('upscaling stays out of the way where the preset already renders at the screen size', () => {
    const { gfx, canvas } = graphics({ dpr: 1, quality: 'high' });
    gfx.setUpscale(true);
    assert.equal(gfx._up, false, 'HIGH on a 100% screen is native already');
    assert.deepEqual([canvas().x, canvas().y], [1280, 800]);
    gfx._dispose();
    // A 4K screen at 250% caps the canvas at 2x.
    const wide = graphics({ dpr: 2.5 });
    wide.gfx.setUpscale(true);
    assert.deepEqual([wide.canvas().x, wide.canvas().y], [2560, 1600]);
    wide.gfx._dispose();
});

test('the final pass draws into the upscaler input without its own sharpening, then the upscaler draws the screen', () => {
    const { gfx } = graphics();
    const calls = [];
    gfx.final.render = function (renderer, write, read) {
        calls.push({ write, read, toScreen: this.renderToScreen, sharpen: gfx.uniforms.uSharpen.value });
    };
    gfx._wrapFinal();
    gfx.upscaler.render = (renderer, src, dst) => calls.push({ upscale: true, src, dst });
    const read = { width: 1088, height: 680 }, write = {};
    gfx.final.renderToScreen = true;
    const sharpen = gfx.uniforms.uSharpen.value;
    assert.ok(sharpen > 0);

    gfx.final.render('renderer', write, read, 0.016);
    assert.deepEqual(calls.splice(0), [{ write, read, toScreen: true, sharpen }], 'off: unchanged');

    gfx.setUpscale(true);
    let input = null;
    gfx.upscaler.input = (w, h) => (input = { w, h, texture: {} });
    gfx.final.render('renderer', write, read, 0.016);
    assert.deepEqual(input, { w: 1088, h: 680, texture: {} });
    assert.deepEqual(calls.splice(0), [
        { write: input, read, toScreen: false, sharpen: 0 },
        { upscale: true, src: input, dst: null },
    ]);
    assert.equal(gfx.final.renderToScreen, true);
    assert.equal(gfx.uniforms.uSharpen.value, sharpen);
    gfx._dispose();
});
