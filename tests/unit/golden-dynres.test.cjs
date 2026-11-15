const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = readFileSync(process.env.GOLDEN_RUNTIME_SOURCE ||
    resolve(__dirname, '../../static/games/golden-hour/dist/game.js'), 'utf8');
const start = source.indexOf('GhDynRes=class');
const window = { __goldenHourFpsCap: 60 };
const GhDynRes = vm.runInNewContext(`(${source.slice(start + 9, source.indexOf(',BM=class{', start))})`, { window });

// A stand-in for the graphics: frames take `cost(k)` ms of GPU time at render scale k (pipelined,
// so the frame rate follows it smoothly, as measured in Chrome), and never come faster than the
// cap the page's frame pacing enforces.
function rig({ cost, cap = 60 }) {
    window.__goldenHourFpsCap = cap;
    const gfx = { dynK: 1, resizes: 0, resize() { this.resizes++; } };
    const dyn = new GhDynRes(gfx);
    let now = 1000;
    const trace = [];
    const run = (seconds, { paused = false } = {}) => {
        const end = now + seconds * 1000;
        while (now < end) {
            now += Math.max(1000 / cap, cost(dyn.k));
            if (dyn.enabled) dyn.tick(paused, now);
            trace.push(dyn.k);
        }
    };
    return { gfx, dyn, run, trace, stall: (ms) => { now += ms; } };
}

test('steps the scale down while the GPU is the bottleneck, never below 60%', () => {
    // 30 ms per frame at full scale, proportional to pixels: needs about 0.75 to hold 60.
    const { gfx, dyn, run } = rig({ cost: (k) => 30 * k * k });
    run(5);
    assert.equal(dyn.k, 1, 'off by default');
    dyn.setEnabled(true);
    run(8);
    assert.ok(dyn.k <= 0.8 && dyn.k >= 0.6, `scale ${dyn.k}`);
    assert.equal(gfx.dynK, dyn.k);
    assert.ok(gfx.resizes > 0);
    // A heavier scene drives it to the floor and no further.
    const heavy = rig({ cost: (k) => 80 * k * k });
    heavy.dyn.setEnabled(true);
    heavy.run(30);
    assert.equal(heavy.dyn.k, 0.6);
    assert.ok(heavy.trace.every((k) => k >= 0.6));
});

test('a frame rate held down by something else leaves the scale where it was', () => {
    // A browser capped at 30 fps (energy saver) while the game's cap is 60: lowering the scale
    // never helps, so each try is undone and the next one waits longer.
    const { dyn, run, trace } = rig({ cost: () => 33.4 });
    dyn.setEnabled(true);
    run(60);
    const tries = trace.filter((k, i) => i && k < trace[i - 1]).length;
    assert.ok(tries >= 1 && tries <= 4, `${tries} tries in a minute`);
    assert.equal(dyn.k, 1);
    assert.ok(trace.filter((k) => k < 1).length < trace.length * 0.05, 'below full scale only briefly');
});

test('climbs back to full scale once there is room, and backs off a step that costs frames', () => {
    let heavy = true;
    const { dyn, run } = rig({ cost: (k) => (heavy ? 30 : 12) * k * k });
    dyn.setEnabled(true);
    run(10);
    assert.ok(dyn.k < 1);
    heavy = false;
    run(30);
    assert.equal(dyn.k, 1, 'back to full scale');
    // 95% holds 60 FPS but full scale drops below 54: each climb to 1.0 is undone, and retried
    // after 3, 6, 12... seconds instead of every few seconds.
    const edge = rig({ cost: (k) => 18.8 * k * k });
    edge.dyn.setEnabled(true);
    edge.run(60);
    const climbs = edge.trace.filter((k, i) => i && k === 1 && edge.trace[i - 1] < 1).length;
    assert.ok(climbs >= 1 && climbs <= 5, `${climbs} climbs to full scale in a minute`);
    assert.ok(edge.dyn.k >= 0.9);
});

test('uses the 30 FPS cap, ignores paused frames and stalls, and resets when switched off', () => {
    const thirty = rig({ cost: (k) => 25 * k * k, cap: 30 });
    thirty.dyn.setEnabled(true);
    thirty.run(20);
    assert.equal(thirty.dyn.k, 1, '25 ms frames already meet a 30 FPS cap');

    const { gfx, dyn, run, stall } = rig({ cost: (k) => 30 * k * k });
    dyn.setEnabled(true);
    run(5, { paused: true });
    assert.equal(dyn.k, 1, 'paused frames are not judged');
    stall(2000);
    run(0.4);
    assert.equal(dyn.k, 1, 'a stall starts a fresh window');
    run(8);
    assert.ok(dyn.k < 1);
    const before = gfx.resizes;
    dyn.setEnabled(false);
    assert.equal(dyn.k, 1);
    assert.equal(gfx.dynK, 1);
    assert.equal(gfx.resizes, before + 1);
});
