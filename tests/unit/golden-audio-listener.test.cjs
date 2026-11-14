const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = readFileSync(resolve(__dirname, '../../static/games/golden-hour/dist/game.js'), 'utf8');
const start = source.indexOf('function createGoldenAudioDSP()');
const end = source.indexOf('var fo=eZ()', start);
assert.ok(start >= 0 && end > start);
const audioSource = source.slice(start, end);
const vector = (x, y, z) => ({ x, y, z });
const origin = vector(0, 0, 0);
const forward = vector(0, 0, -1);
const up = vector(0, 1, 0);
const fields = ['positionX', 'positionY', 'positionZ', 'forwardX', 'forwardY', 'forwardZ', 'upX', 'upY', 'upZ'];

function listener(legacy = false) {
    const writes = [];
    const target = {};
    if (legacy) {
        target.setPosition = (...values) => writes.push(['position', ...values]);
        target.setOrientation = (...values) => writes.push(['orientation', ...values]);
    } else {
        for (const field of fields) {
            let value = 0;
            target[field] = {
                get value() { return value; },
                set value(next) { value = Math.fround(next); writes.push([field, next]); }
            };
        }
    }
    return { target, writes };
}

function audio(target) {
    const api = vm.runInNewContext(`${audioSource};eZ()`, { console });
    if (target) api._engine.ctx = { listener: target, state: 'running' };
    return api;
}

test('stationary listener submits initial values once, including zero axes and non-float32 positions', () => {
    const { target, writes } = listener();
    const api = audio(target);
    const position = vector(1 / 3, 0, -.1);
    for (let tick = 0; tick < 300; tick++) api.setListener(position, forward, up);
    assert.deepEqual(writes, fields.map((field, i) => [field, [position.x, 0, position.z, 0, 0, -1, 0, 1, 0][i]]));
    assert.equal(api._engine.errors.length, 0);
});

test('moving and rotating the listener immediately submits only changed axes without changing spatial state', () => {
    const { target, writes } = listener();
    const api = audio(target);
    api.setListener(origin, forward, up);
    writes.length = 0;
    api.setListener(vector(4, 0, 0), forward, up);
    assert.deepEqual(writes, [['positionX', 4]]);
    assert.equal(api._engine.lx, 4);
    assert.equal(api._engine.lvec.x, 4);
    writes.length = 0;
    api.setListener(vector(4, 0, 0), vector(2, 0, 0), vector(0, 0, 1));
    assert.deepEqual(writes, [['forwardX', 2], ['forwardZ', 0], ['upY', 0], ['upZ', 1]]);
    assert.equal(api._engine.fx, 1);
    assert.equal(api._engine.fy, 0);
    assert.equal(api._engine.fz, 0);
    assert.equal(api._engine.ry, -1);
});

test('a new AudioContext listener receives all current values while suspend and resume retain submissions', () => {
    const first = listener();
    const api = audio();
    const position = vector(2, 3, 4);
    api.setListener(position, forward, up);
    api._engine.ctx = { listener: first.target, state: 'running' };
    api.setListener(position, forward, up);
    assert.equal(first.writes.length, 9);
    api._engine.ctx.state = 'suspended';
    api.setListener(position, forward, up);
    api._engine.ctx.state = 'running';
    api.setListener(position, forward, up);
    assert.equal(first.writes.length, 9);
    const next = listener();
    api._engine.ctx = { listener: next.target, state: 'running' };
    api.setListener(position, forward, up);
    assert.deepEqual(next.writes, first.writes);
    assert.equal(api._engine.errors.length, 0);
});

test('legacy listeners preserve position and orientation calls and update each changed group', () => {
    const { target, writes } = listener(true);
    const api = audio(target);
    api.setListener(origin, forward, up);
    api.setListener(origin, forward, up);
    assert.deepEqual(writes, [['position', 0, 0, 0], ['orientation', 0, 0, -1, 0, 1, 0]]);
    writes.length = 0;
    api.setListener(vector(1, 2, 3), forward, up);
    assert.deepEqual(writes, [['position', 1, 2, 3]]);
    writes.length = 0;
    api.setListener(vector(1, 2, 3), vector(-1, 0, 0), up);
    assert.deepEqual(writes, [['orientation', -1, 0, 0, 0, 1, 0]]);
    assert.equal(api._engine.errors.length, 0);
});

test('invalid positions are ignored and invalid orientation retains the existing default directions', () => {
    const { target, writes } = listener();
    const api = audio(target);
    api.setListener(origin, vector(1, 0, 0), vector(0, 0, 1));
    writes.length = 0;
    api.setListener(vector(NaN, 0, 0), forward, up);
    assert.deepEqual(writes, []);
    api.setListener(origin, vector(NaN, 0, 0), vector(0, Infinity, 0));
    assert.deepEqual(writes, [['forwardX', 0], ['forwardZ', -1], ['upY', 1], ['upZ', 0]]);
    assert.equal(api._engine.errors.length, 0);
});

test('separate audio engines do not share listener submission state', () => {
    const a = listener(), b = listener();
    const first = audio(a.target), second = audio(b.target);
    first.setListener(origin, forward, up);
    second.setListener(origin, forward, up);
    assert.deepEqual(a.writes, b.writes);
    assert.equal(a.writes.length, 9);
});
