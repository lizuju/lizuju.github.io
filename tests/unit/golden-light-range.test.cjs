const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = readFileSync(process.env.GOLDEN_RUNTIME_SOURCE ||
    resolve(__dirname, '../../static/games/golden-hour/dist/game.js'), 'utf8');
const THREE = vm.runInThisContext(`${source.slice(0, source.indexOf('var iu='))}return Ct;})();`);
// Three's own loop unroller (#pragma unroll_loop_start), as the renderer applies it.
const unrollStart = source.indexOf('var GX=/#pragma unroll_loop_start');
const unrollEnd = source.indexOf('function', source.indexOf('function WX(', unrollStart) + 1);
const unroll = vm.runInNewContext(`${source.slice(unrollStart, unrollEnd)};hL`);

test('each unrolled point light is guarded by its own range and colour, with a switch back to all lights', () => {
    const chunk = THREE.ShaderChunk.lights_fragment_begin;
    const start = chunk.indexOf('#if ( NUM_POINT_LIGHTS > 0 ) && defined( RE_Direct )');
    const end = chunk.indexOf('#endif\n', chunk.indexOf('#pragma unroll_loop_end', start));
    const glsl = unroll(chunk.slice(start, end).replace(/NUM_POINT_LIGHTS/g, '3').replace(/UNROLLED_LOOP_INDEX < NUM_POINT_LIGHT_SHADOWS/g, 'UNROLLED_LOOP_INDEX < 0'));
    assert.ok(!glsl.includes('#pragma unroll_loop_start'), 'the loop unrolled');
    for (let i = 0; i < 3; i++) {
        const guard = `if ( ( pointLight.distance <= 0.0 || length( pointLight.position - geometryPosition ) < pointLight.distance ) && pointLight.color != vec3( 0.0 ) ) {`;
        const copy = glsl.split(`pointLight = pointLights[ ${i} ];`)[1].split('pointLight = pointLights[')[0];
        assert.ok(copy.includes('#ifdef GH_EVERY_POINT_LIGHT\n\t\tif ( true ) {\n\t\t#else'), `light ${i}: full-loop switch`);
        assert.ok(copy.includes(guard), `light ${i}: range guard`);
        const inside = copy.slice(copy.indexOf(guard));
        assert.ok(inside.indexOf('getPointLightInfo( pointLight, geometryPosition, directLight );') > 0);
        assert.ok(inside.indexOf('RE_Direct( directLight') > inside.indexOf('getPointLightInfo'));
    }
    // Braces still pair up once the preprocessor picks one of the two `if` lines.
    for (const pick of ['true', 'guard']) {
        const resolved = glsl.replace(/#ifdef GH_EVERY_POINT_LIGHT\n\t\tif \( true \) \{\n\t\t#else\n(\t\tif [^\n]+\n)\t\t#endif\n/g,
            (m, guard) => (pick === 'true' ? '\t\tif ( true ) {\n' : guard));
        assert.ok(!resolved.includes('#ifdef GH_EVERY_POINT_LIGHT') && !resolved.includes('#else'));
        let depth = 0;
        for (const c of resolved) { if (c === '{') depth++; if (c === '}') depth--; assert.ok(depth >= 0); }
        assert.equal(depth, 0, `${pick}: balanced braces`);
    }
});

test('three attenuates a point light to exactly zero at and past its cutoff, so skipping it adds nothing', () => {
    // getDistanceAttenuation in single precision: 1/max(d^decay, .01) * pow2(saturate(1 - pow4(d / cutoff))).
    const f = Math.fround;
    const attenuation = (d, cutoff, decay) => {
        let falloff = f(1 / Math.max(f(Math.pow(d, decay)), 0.01));
        const x = f(d / cutoff), x2 = f(x * x), x4 = f(x2 * x2);
        const s = Math.min(1, Math.max(0, f(1 - x4)));
        return f(falloff * f(s * s));
    };
    let seed = 5;
    const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < 20000; i++) {
        const cutoff = f(5 + rand() * 20);
        const d = f(cutoff * (1 + rand() * 2));
        assert.equal(attenuation(d, cutoff, 2), 0, `d ${d} cutoff ${cutoff}`);
        // Just inside the cutoff the light still counts (it is never skipped there).
        assert.ok(attenuation(f(cutoff * 0.999), cutoff, 2) > 0);
    }
    assert.equal(attenuation(f(12), f(12), 2), 0);
    // The emulation above is the formula this bundle's three.js uses, on the same distance.
    const pars = THREE.ShaderChunk.lights_pars_begin;
    assert.ok(pars.includes('distanceFalloff *= pow2( saturate( 1.0 - pow4( lightDistance / cutoffDistance ) ) );'));
    assert.ok(pars.includes('vec3 lVector = pointLight.position - geometryPosition;') && pars.includes('float lightDistance = length( lVector );'));
    assert.ok(THREE.ShaderChunk.common.includes('float pow4( const in float x ) { float x2 = x*x; return x2*x2; }'));
});
