const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = readFileSync(process.env.GOLDEN_RUNTIME_SOURCE ||
    resolve(__dirname, '../../static/games/golden-hour/dist/game.js'), 'utf8');
const start = source.indexOf('class{constructor(t,e,s){this.scene=t,this.world=e,this.hooks=s,this.bodies=[]');
const end = source.indexOf('},p$=new Float32Array(16)', start);
assert.ok(start > 0 && end > start);
const vec = { set() { return this; }, normalize() { return this; }, clone() { return this; } };
const Physics = vm.runInNewContext(`(${source.slice(start, end + 1)})`, {
    DD: 9.81, X2: {}, xr: vec, Rg: vec, ns: (v) => Math.min(1, Math.max(0, v)),
});

function random(seed) {
    return () => {
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// A room of static boxes (floor, walls, furniture; some switched off or immovable) that the
// physics queries in a fixed order, as the hotel's collision grid does.
function world(rand) {
    const boxes = [{ x0: -12, x1: 12, y0: -1, y1: 0, z0: -12, z1: 12 }];
    for (let i = 0; i < 160; i++) {
        const x = rand() * 20 - 10, y = rand() * 2.5, z = rand() * 20 - 10;
        const sx = 0.1 + rand() * (rand() < 0.2 ? 6 : 1.2), sy = 0.1 + rand() * 2, sz = 0.1 + rand() * (rand() < 0.2 ? 6 : 1.2);
        boxes.push({ x0: x, x1: x + sx, y0: y, y1: y + sy, z0: z, z1: z + sz, off: rand() < 0.05, noMove: rand() < 0.05 });
    }
    return { boxes, query(x0, z0, x1, z1, out) { out.length = 0; for (const b of boxes) out.push(b); return out; } };
}

function body(rand, type) {
    const points = type === 'box' ? 8 : 15;
    const cx = rand() * 16 - 8, cy = 0.5 + rand() * 3, cz = rand() * 16 - 8;
    const x = new Float32Array(points * 3), o = new Float32Array(points * 3), r = new Float32Array(points);
    const vx = (rand() - 0.5) * 0.4, vy = rand() * 0.2, vz = (rand() - 0.5) * 0.4;
    for (let i = 0; i < points; i++) {
        const px = type === 'box' ? cx + ((i & 1) - 0.5) * 0.5 : cx + (rand() - 0.5) * 1.2;
        const py = type === 'box' ? cy + (((i >> 1) & 1) - 0.5) * 0.5 : cy + (rand() - 0.5) * 1.6;
        const pz = type === 'box' ? cz + (((i >> 2) & 1) - 0.5) * 0.5 : cz + (rand() - 0.5) * 1.2;
        x.set([px, py, pz], i * 3);
        o.set([px - vx, py - vy, pz - vz], i * 3);
        r[i] = 0.04 + rand() * 0.12;
    }
    const ci = [], cl = [];
    for (let a = 0; a < points; a++) for (let b = a + 1; b < points; b++) {
        if (type !== 'box' && b !== a + 1 && rand() > 0.15) continue;
        ci.push(a, b);
        cl.push(Math.hypot(x[a * 3] - x[b * 3], x[a * 3 + 1] - x[b * 3 + 1], x[a * 3 + 2] - x[b * 3 + 2]));
    }
    return {
        type, n: points, x, o, r, ci, cl, cmin: null, iters: type === 'box' ? 4 : 8, damp: 0.995, fric: 0.6,
        gScale: 1, rest: 0.3, cool: 0, still: 0, mat: 'wood', breakable: false, cx, cy, cz,
    };
}

function simulate(prefilter, seed) {
    const rand = random(seed);
    const physics = Object.create(Physics.prototype);
    physics.world = world(rand);
    physics._cands = [];
    physics.time = 0;
    physics.hooks = {
        audio: { propHit() {}, grenadeBounce() {}, bodyFall() {} },
        fx: {},
        glass: { hit() {}, bodyHit() { return false; } },
    };
    let narrowed = 0;
    const near = physics._near;
    physics._near = prefilter ? function (...args) { const q = near.apply(this, args); if (q) narrowed++; return q; } : () => null;
    const bodies = [];
    for (let i = 0; i < 24; i++) bodies.push(body(rand, i % 3 ? 'box' : 'rag'));
    const frames = [];
    for (let step = 0; step < 240; step++) {
        for (const b of bodies) if (!b.sleeping && !b.dead) physics._step(b, 1 / 90, 1);
        frames.push(bodies.map((b) => [Array.from(b.x), Array.from(b.o), b.sleeping, b.still, b.dead]));
    }
    return { frames, narrowed };
}

test('the collision prefilter leaves every simulated point bit-identical', () => {
    for (const seed of [1, 7, 42]) {
        const full = simulate(false, seed);
        const fast = simulate(true, seed);
        assert.ok(fast.narrowed > 1000, `prefilter engaged only ${fast.narrowed} times`);
        assert.equal(full.narrowed, 0);
        for (let f = 0; f < full.frames.length; f++) {
            assert.deepEqual(fast.frames[f], full.frames[f], `seed ${seed}, step ${f}`);
        }
    }
});

test('the prefilter keeps every box within reach and steps aside for tiny or broken bodies', () => {
    const physics = Object.create(Physics.prototype);
    const boxes = [
        { x0: 0, x1: 1, y0: 0, y1: 1, z0: 0, z1: 1 },
        { x0: 5, x1: 6, y0: 0, y1: 1, z0: 0, z1: 1 },
        { x0: 1.2, x1: 2, y0: 0, y1: 1, z0: 0, z1: 1 },
        { x0: 1.3, x1: 2, y0: 0, y1: 1, z0: 0, z1: 1 },
        ...Array.from({ length: 8 }, (_, i) => ({ x0: 20 + i, x1: 21 + i, y0: 0, y1: 1, z0: 0, z1: 1 })),
    ];
    const n = new Float32Array([0.5, 1.2, 0.5, 0.9, 1.2, 0.5]);
    const r = new Float32Array([0.1, 0.05]);
    const q = physics._near(boxes, n, 2, r);
    // Boxes 0 and 2 are within the largest radius + 0.25 m (0.35 m) of the points; box 3 sits
    // 0.4 m away and the rest are farther.
    assert.deepEqual(Array.from(q.i.slice(0, q.n)), [0, 2]);
    assert.ok(Math.abs(q.x1 - (0.9 + 0.249)) < 1e-6 && Math.abs(q.x0 - (0.5 - 0.249)) < 1e-6);
    assert.equal(physics._near(boxes, n, 1, r), null);
    assert.equal(physics._near(boxes.slice(0, 5), n, 2, r), null);
    assert.equal(physics._near(boxes, new Float32Array([NaN, 0, 0, 1, 1, 1]), 2, r), null);
});

test('every box the prefilter leaves out is beyond reach from anywhere in its safe box', () => {
    const rand = random(99);
    const physics = Object.create(Physics.prototype);
    let checked = 0;
    for (let round = 0; round < 400; round++) {
        const points = 2 + Math.floor(rand() * 14);
        const n = new Float32Array(points * 3), r = new Float32Array(points);
        const cx = rand() * 6 - 3, cy = rand() * 2, cz = rand() * 6 - 3;
        for (let i = 0; i < points; i++) {
            n.set([cx + (rand() - 0.5) * 1.5, cy + (rand() - 0.5) * 1.5, cz + (rand() - 0.5) * 1.5], i * 3);
            r[i] = 0.02 + rand() * 0.2;
        }
        const boxes = Array.from({ length: 40 }, () => {
            const x = rand() * 10 - 5, y = rand() * 4 - 1, z = rand() * 10 - 5;
            return { x0: x, x1: x + rand() * 1.5, y0: y, y1: y + rand() * 1.5, z0: z, z1: z + rand() * 1.5 };
        });
        const q = physics._near(boxes, n, points, r);
        if (!q) continue;
        const kept = new Set(q.i.slice(0, q.n));
        const R = Math.max(...r);
        boxes.forEach((z, index) => {
            if (kept.has(index)) return;
            // Nearest gap between the safe box and the left-out box, on any axis.
            const gap = Math.max(z.x0 - q.x1, q.x0 - z.x1, z.y0 - q.y1, q.y0 - z.y1, z.z0 - q.z1, q.z0 - z.z1);
            assert.ok(gap >= R, `box ${index} is ${gap} m from the safe box, radius ${R}`);
            checked++;
        });
    }
    assert.ok(checked > 1000);
});

test('a point pushed out of its safe box falls back to the full box list from where it was', () => {
    // Point 0 starts buried in a 2 m crate and is pushed out of its top, into a shelf that the
    // prefilter left out because it was more than 1 m from both points at the start.
    const crate = { x0: -1, x1: 1, y0: -1, y1: 1, z0: -1, z1: 1 };
    const shelf = { x0: -0.5, x1: 0.5, y0: 1.05, y1: 1.5, z0: -0.5, z1: 0.5 };
    const far = Array.from({ length: 8 }, (_, i) => ({ x0: 30 + i, x1: 31 + i, y0: 0, y1: 1, z0: 0, z1: 1 }));
    const boxes = [crate, ...far, shelf];
    const run = (prefilter) => {
        const physics = Object.create(Physics.prototype);
        physics.world = { query(x0, z0, x1, z1, out) { out.length = 0; out.push(...boxes); return out; } };
        physics._cands = [];
        physics.time = 0;
        physics.hooks = { audio: { propHit() {}, grenadeBounce() {}, bodyFall() {} }, fx: {}, glass: {} };
        if (!prefilter) physics._near = () => null;
        const x = new Float32Array([0, 0, 0, 0.2, 0, 0]);
        const t = {
            type: 'box', n: 2, x, o: x.slice(), r: new Float32Array([0.1, 0.1]), ci: [], cl: [], cmin: null,
            iters: 1, damp: 1, fric: 0.5, gScale: 0, rest: 0, cool: 0, still: 0, mat: 'wood', breakable: false,
        };
        const q = prefilter && physics._near(boxes, x, 2, t.r);
        physics._step(t, 1 / 90, 1);
        return { x: Array.from(t.x), o: Array.from(t.o), kept: q && Array.from(q.i.slice(0, q.n)) };
    };
    const full = run(false), fast = run(true);
    assert.deepEqual(fast.kept, [0]);
    assert.notEqual(full.x[1], 1.1, 'the shelf pushed the point back down in the full scan');
    assert.deepEqual(fast.x, full.x);
    assert.deepEqual(fast.o, full.o);
});
