const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = readFileSync(process.env.GOLDEN_RUNTIME_SOURCE ||
    resolve(__dirname, '../../static/games/golden-hour/dist/game.js'), 'utf8');
const { THREE, Bloom } = vm.runInNewContext(
    `${source.slice(0, source.indexOf(';var Ii='))};return {THREE:Ct,Bloom:mg};})();`,
    { AbortController, console, window: { devicePixelRatio: 1 }, innerWidth: 952, innerHeight: 538 },
);
const radii = [3, 5, 7, 9, 11];

function linearSample(values, position) {
    const left = Math.floor(position);
    const fraction = position - left;
    const clamped = index => values[Math.max(0, Math.min(values.length - 1, index))];
    return clamped(left) * (1 - fraction) + clamped(left + 1) * fraction;
}

function referenceBlur(values, radius, position) {
    let sum = 0;
    let weightSum = 0;
    for (let offset = 1 - radius; offset < radius; offset++) {
        const weight = Math.exp(-(offset ** 2) / (2 * radius ** 2));
        sum += linearSample(values, position + offset) * weight;
        weightSum += weight;
    }
    return sum / weightSum;
}

function pairedBlur(values, coefficients, position) {
    let sum = linearSample(values, position) * coefficients[0];
    let weightSum = coefficients[0];
    for (let index = 1; index < coefficients.length; index += 2) {
        const weight = coefficients[index] + coefficients[index + 1];
        const offset = index + coefficients[index + 1] / weight;
        sum += (linearSample(values, position + offset) + linearSample(values, position - offset)) * weight;
        weightSum += 2 * weight;
    }
    return sum / weightSum;
}

for (const radius of radii) {
    test(`paired Bloom radius ${radius} retains the original convolution through clamp-to-edge boundaries`, () => {
        const bloom = new Bloom(new THREE.Vector2(952, 538), .3, .5, 1.35);
        const material = bloom.separableBlurMaterials[radii.indexOf(radius)];
        const coefficients = material.uniforms.gaussianCoefficients.value;
        assert.equal(material.defines.KERNEL_RADIUS, radius);
        assert.equal(coefficients.length, radius);
        for (let index = 0; index < radius; index++) {
            assert.equal(coefficients[index], .39894 * Math.exp(-.5 * index * index / (radius * radius)) / radius);
        }
        for (const length of [1, 2, 7, 31]) {
            const signals = [
                Array(length).fill(.75),
                Array.from({ length }, (_, index) => index === 0 ? 1 : 0),
                Array.from({ length }, (_, index) => index === Math.floor(length / 2) ? 1 : 0),
                Array.from({ length }, (_, index) => ((index * 1103515245 + 12345) >>> 0) / 2 ** 32),
            ];
            for (const values of signals) {
                for (let position = 0; position < length; position++) {
                    const error = Math.abs(referenceBlur(values, radius, position) - pairedBlur(values, coefficients, position));
                    assert.ok(error < 1e-12, `radius=${radius}, length=${length}, position=${position}, error=${error}`);
                }
            }
        }
        bloom.dispose();
    });
}

test('Bloom fuses only the same-grid passes and preserves mip dimensions and half-float filtering after resize', () => {
    const bloom = new Bloom(new THREE.Vector2(1366, 768), .3, .5, 1.35);
    const materials = Array.from(bloom.separableBlurMaterials);
    const coefficients = materials.map(material => Array.from(material.uniforms.gaussianCoefficients.value));
    let target;
    const draws = [];
    const renderer = {
        autoClear: true,
        getClearColor(color) { return color.set(0); },
        getClearAlpha() { return 1; },
        setClearColor() {},
        setRenderTarget(value) { target = value; },
        clear() {},
    };
    bloom._fsQuad.render = () => {
        const material = bloom._fsQuad.material;
        const level = materials.indexOf(material);
        if (level < 0) return;
        const input = material.uniforms.colorTexture.value;
        const vertical = material.uniforms.direction.value.y === 1;
        draws.push({ level, vertical, input, target, paired: material.defines.PAIR_HORIZONTAL === 1 || vertical });
    };
    for (const [width, height] of [[1366, 768], [953, 539], [640, 360]]) {
        bloom.setSize(width, height);
        draws.length = 0;
        const input = new THREE.WebGLRenderTarget(width, height);
        bloom.render(renderer, null, input, 0, false);
        assert.equal(draws.length, 10);
        assert.equal(draws.filter(draw => draw.paired).length, 6);
        let mipWidth = Math.round(width / 2);
        let mipHeight = Math.round(height / 2);
        for (let level = 0; level < 5; level++) {
            const material = materials[level];
            const horizontal = draws[level * 2];
            const vertical = draws[level * 2 + 1];
            const previous = level === 0 ? bloom.renderTargetBright : bloom.renderTargetsVertical[level - 1];
            assert.equal(horizontal.input, previous.texture);
            assert.equal(horizontal.target, bloom.renderTargetsHorizontal[level]);
            assert.equal(vertical.input, horizontal.target.texture);
            assert.equal(vertical.target, bloom.renderTargetsVertical[level]);
            assert.equal(horizontal.paired, level === 0, 'downsample passes retain the original sampling phase');
            assert.equal(vertical.paired, true);
            assert.deepEqual([horizontal.target.width, horizontal.target.height], [mipWidth, mipHeight]);
            assert.deepEqual([vertical.target.width, vertical.target.height], [mipWidth, mipHeight]);
            for (const output of [horizontal.target, vertical.target]) {
                assert.equal(output.texture.type, THREE.HalfFloatType);
                assert.equal(output.texture.minFilter, THREE.LinearFilter);
                assert.equal(output.texture.magFilter, THREE.LinearFilter);
                assert.equal(output.texture.wrapS, THREE.ClampToEdgeWrapping);
                assert.equal(output.texture.wrapT, THREE.ClampToEdgeWrapping);
            }
            assert.equal(material.uniforms.invSize.value.x, 1 / mipWidth);
            assert.equal(material.uniforms.invSize.value.y, 1 / mipHeight);
            assert.deepEqual(Array.from(material.uniforms.gaussianCoefficients.value), coefficients[level]);
            assert.match(material.fragmentShader, /if \(PAIR_HORIZONTAL == 1 \|\| direction\.y > 0\.5\)/);
            assert.match(material.fragmentShader, /for \(int i = 1; i < KERNEL_RADIUS; i \+= 2\)/);
            assert.match(material.fragmentShader, /else \{\s*for\( int i = 1; i < KERNEL_RADIUS; i \+\+ \)/);
            mipWidth = Math.round(mipWidth / 2);
            mipHeight = Math.round(mipHeight / 2);
        }
        input.dispose();
    }
    bloom.dispose();
});

test('fractional downsampling cannot substitute a paired lookup for separated taps', () => {
    const bloom = new Bloom(new THREE.Vector2(952, 538), .3, .5, 1.35);
    const values = [0, 1, 0, 1, 0, 1, 0];
    const material = bloom.separableBlurMaterials[1];
    const difference = Math.abs(referenceBlur(values, 5, 2.5) - pairedBlur(values, material.uniforms.gaussianCoefficients.value, 2.5));
    assert.ok(difference > .001, 'the original downsampling path is necessary to preserve the image');
    assert.equal(material.defines.PAIR_HORIZONTAL, 0);
    bloom.dispose();
});
