const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const THREE = require('three');

const source = readFileSync(resolve(__dirname, '../../static/games/golden-hour/dist/game.js'), 'utf8');
const start = source.indexOf('var Gd=4,');
const end = source.indexOf(';var ww=', start);
const { World } = vm.runInNewContext(`${source.slice(start, end)}; ({World: Mw})`, {
    a0: THREE.Vector3, Us: THREE.Matrix3, ne: THREE.BufferGeometry,
    Yt: THREE.BufferAttribute, ae: THREE.Mesh, li: THREE.MeshBasicMaterial,
    Float32Array
});

function linearRaycast(world, origin, direction, maxDistance, ignoreWater = false) {
    const d = direction.map((value) => Math.abs(value) < 1e-9 ? 1e-9 : value);
    const inv = d.map((value) => 1 / value);
    let distance = maxDistance;
    let result = null;
    for (const col of world.cols) {
        if (col.off || col.noRay || col.pane || (ignoreWater && col.water)) continue;
        let near = -Infinity;
        let far = Infinity;
        let axis = 0;
        for (let j = 0; j < 3; j++) {
            const label = ['x', 'y', 'z'][j];
            const a = (col[`${label}0`] - origin[j]) * inv[j];
            const b = (col[`${label}1`] - origin[j]) * inv[j];
            const entry = Math.min(a, b);
            if (entry > near) { near = entry; axis = j; }
            far = Math.min(far, Math.max(a, b));
        }
        if (near > far || near < 0 || near >= distance) continue;
        distance = near;
        result = {
            t: near, col,
            nx: axis === 0 ? (d[0] > 0 ? -1 : 1) : 0,
            ny: axis === 1 ? (d[1] > 0 ? -1 : 1) : 0,
            nz: axis === 2 ? (d[2] > 0 ? -1 : 1) : 0
        };
    }
    return result;
}

function assertRay(world, origin, direction, distance, ignoreWater = false) {
    const expected = linearRaycast(world, origin, direction, distance, ignoreWater);
    assert.equal(world.raycast(...origin, ...direction, distance, null, ignoreWater),
        expected !== null, JSON.stringify({ origin, direction, distance, boolean: true }));
    const actual = {};
    const hit = world.raycast(...origin, ...direction, distance, actual, ignoreWater);
    assert.equal(hit, expected !== null, JSON.stringify({ origin, direction, distance }));
    if (expected) assert.deepEqual(actual, expected);
}

function random(seed) {
    return () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed / 0x100000000;
    };
}

function assertGround(world, x, z, ceiling, tolerance = .05) {
    let height = -Infinity;
    let collider = null;
    for (const col of world.cols) {
        if (col.off || col.noMove || col.pane) continue;
        if (x < col.x0 || x > col.x1 || z < col.z0 || z > col.z1) continue;
        if (col.y1 <= ceiling + tolerance && col.y1 > height) {
            height = col.y1;
            collider = col;
        }
    }
    assert.equal(world.groundAt(x, z, ceiling, tolerance), height);
    assert.equal(world.groundCol, collider);
}

test('point ground queries preserve heights and collider identity across grid and shape boundaries', () => {
    const world = new World();
    const next = random(42110);
    for (let i = 0; i < 400; i++) {
        const x = next() * 80 - 40;
        const z = next() * 80 - 40;
        const y = next() * 12 - 2;
        world.addCollider(x, y, z, x + next() * 8, y + next() * 4, z + next() * 8,
            'concrete', { off: i % 41 === 0, noMove: i % 37 === 0, pane: i % 31 === 0 });
    }
    for (let i = 0; i < 3000; i++) {
        assertGround(world, next() * 100 - 50, next() * 100 - 50, next() * 16 - 3,
            i % 3 ? .05 : next());
    }
    for (const col of world.cols) {
        for (const x of [col.x0, col.x1]) for (const z of [col.z0, col.z1]) {
            for (const ceiling of [col.y1 - .05, col.y1, col.y1 + .05]) {
                assertGround(world, x, z, ceiling);
            }
        }
    }
    for (let x = -44; x <= 44; x += 4) for (let z = -44; z <= 44; z += 4) {
        assertGround(world, x, z, 12);
    }
});

test('point ground queries keep insertion ties and observe live collider flags', () => {
    const world = new World();
    const first = world.addCollider(-4, -1, -4, 4, 0, 4);
    const second = world.addCollider(-4, -1, -4, 4, 0, 4);
    assertGround(world, 0, 0, 0);
    assert.equal(world.groundCol, first);
    for (const key of ['off', 'noMove', 'pane']) {
        first[key] = true;
        assertGround(world, 0, 0, 0);
        assert.equal(world.groundCol, second);
        second[key] = true;
        assertGround(world, 0, 0, 0);
        assert.equal(world.groundCol, null);
        first[key] = second[key] = false;
    }
    first.noRay = first.water = true;
    assertGround(world, 0, 0, 0);
    assert.equal(world.groundCol, first);
    const higher = world.addCollider(-4, 0, -4, 4, 2, 4);
    assertGround(world, 4, -4, 2);
    assert.equal(world.groundCol, higher);
    assertGround(world, 4, -4, 1);
    assert.equal(world.groundCol, first);
});

test('point ground queries do not copy candidates or mutate multi-cell query stamps', () => {
    const world = new World();
    world.addCollider(-8, -1, -8, 8, 0, 8);
    world.addCollider(0, 0, 0, 4, 2, 4);
    const candidates = [...world.query(-8, -8, 8, 8)];
    const stamp = world._stamp;
    const stamps = world.cols.map(col => col.stamp);
    world.query = () => { throw new Error('Point query copied candidates'); };
    for (const [x, z, ceiling] of [[0, 0, 2], [-4, 4, 0], [100, 100, 0]]) {
        assertGround(world, x, z, ceiling);
    }
    assert.equal(world._stamp, stamp);
    assert.deepEqual([...world._q], candidates);
    assert.deepEqual(world.cols.map(col => col.stamp), stamps);
});

test('grid rays preserve the original hit, distance and normal across varied shots', () => {
    const world = new World();
    const next = random(42019);
    for (let i = 0; i < 863; i++) {
        const x = next() * 120 - 60;
        const y = next() * 12 - 2;
        const z = next() * 100 - 50;
        world.addCollider(x, y, z, x + next() * 12, y + next() * 5, z + next() * 12,
            'concrete', { off: i % 41 === 0, noRay: i % 37 === 0, pane: i % 31 === 0,
                water: i % 19 === 0 });
    }
    for (let i = 0; i < 15000; i++) {
        const origin = [next() * 180 - 90, next() * 30 - 10, next() * 160 - 80];
        const direction = [next() * 2 - 1, next() * 2 - 1, next() * 2 - 1];
        if (i % 4 === 0) direction[i % 3] = 0;
        const length = Math.hypot(...direction);
        assertRay(world, origin, direction.map((value) => value / length), next() * 300, i % 2 === 0);
    }
});

test('grid edges, corner contacts and equal-distance hits keep linear ordering', () => {
    const world = new World();
    for (let x = -12; x <= 12; x += 4) {
        for (let z = -12; z <= 12; z += 4) {
            world.addCollider(x, 0, z, x + 1, 2, z + 1);
            world.addCollider(x, 0, z, x + 1, 2, z + 1, 'metal');
        }
    }
    for (let x = -16; x <= 16; x += 4) {
        for (let z = -16; z <= 16; z += 4) {
            for (const dx of [-1, 0, 1]) for (const dz of [-1, 0, 1]) {
                for (const dy of [-1, 0, 1]) assertRay(world, [x, 1, z], [dx, dy, dz], 50);
            }
        }
    }
    assertRay(world, [0, 1, -5], [0, 0, 1], 5);
    assertRay(world, [0, 1, -5], [0, 0, 1], 0);
});

test('nearby ray checks only local candidates and observes collider state changes', () => {
    const world = new World();
    for (let i = 0; i < 900; i++) world.addCollider(20 + i % 30 * 2, 0, 20 + Math.floor(i / 30) * 2,
        21 + i % 30 * 2, 2, 21 + Math.floor(i / 30) * 2);
    const target = world.addCollider(0, 0, 2, 1, 2, 3);
    assertRay(world, [.5, 1, 0], [0, 0, 1], 4);
    assert.ok(world._rayQ.length < world.cols.length / 10);
    target.off = true;
    assertRay(world, [.5, 1, 0], [0, 0, 1], 4);
    target.off = false;
    target.noRay = true;
    assertRay(world, [.5, 1, 0], [0, 0, 1], 4);
});

test('boolean rays preserve inside, surface, tangent and exclusive-distance contacts', () => {
    const world = new World();
    world.addCollider(0, 0, 0, 4, 4, 4);
    const cases = [
        [[2, 2, 2], [1, 0, 0], 10, false],
        [[0, 2, 2], [-1, 0, 0], 10, false],
        [[0, 2, 2], [1, 0, 0], 10, true],
        [[-1, 2, 2], [1, 0, 0], 1, false],
        [[-1, 2, 2], [1, 0, 0], 1.00001, true],
        [[-1, 3, 2], [1, 1, 0], 10, true],
        [[-1, 3.001, 2], [1, 1, 0], 10, false],
        [[5, 5, 2], [-1, -1, 0], 10, true],
        [[2, -1, 2], [0, 1, 0], 10, true],
        [[2, -1, 2], [0, 1, 0], 0, false]
    ];
    for (const [origin, direction, distance, expected] of cases) {
        assert.equal(world.raycast(...origin, ...direction, distance, null), expected);
        assertRay(world, origin, direction, distance);
    }
});

test('boolean rays keep glass, water and collider flags live between queries', () => {
    const world = new World();
    const col = world.addCollider(0, 0, 2, 1, 2, 3);
    const ray = () => world.raycast(.5, 1, 0, 0, 0, 1, 20, null);
    assert.equal(ray(), true);
    for (const key of ['off', 'noRay', 'pane']) {
        col[key] = true;
        assert.equal(ray(), false, key);
        assertRay(world, [.5, 1, 0], [0, 0, 1], 20);
        col[key] = false;
        assert.equal(ray(), true, key);
    }
    col.water = true;
    assert.equal(ray(), true);
    assert.equal(world.raycast(.5, 1, 0, 0, 0, 1, 20, null, true), false);
    assertRay(world, [.5, 1, 0], [0, 0, 1], 20, true);
    world.addCollider(0, 0, 10, 1, 2, 11);
    assert.equal(world.raycast(.5, 1, 0, 0, 0, 1, 20, null, true), true);
    assertRay(world, [.5, 1, 0], [0, 0, 1], 20, true);
});

test('boolean occlusion stops after its first blocker while detailed rays retain the nearest hit', () => {
    const world = new World();
    const far = world.addCollider(0, 0, 3, 1, 2, 3.5);
    const near = world.addCollider(0, 0, 2, 1, 2, 2.5);
    world.addCollider(0, 0, 2, 1, 2, 2.5, 'metal');
    for (let z = 8; z < 300; z += 4) world.addCollider(0, 0, z, 1, 2, z + 1);
    let candidates = 0;
    let cells = 0;
    for (const col of world.cols) Object.defineProperty(col, 'noRay', {
        get() { candidates++; return false; }
    });
    const get = world.grid.get.bind(world.grid);
    world.grid.get = (key) => { cells++; return get(key); };
    assert.equal(world.raycast(.5, 1, 0, 0, 0, 1, 300, null), true);
    const booleanWork = { candidates, cells };
    candidates = cells = 0;
    const hit = {};
    assert.equal(world.raycast(.5, 1, 0, 0, 0, 1, 300, hit), true);
    assert.equal(hit.col, near);
    assert.notEqual(hit.col, far);
    assert.equal(hit.t, 2);
    assert.deepEqual([hit.nx, hit.ny, hit.nz], [0, 0, -1]);
    assert.ok(booleanWork.candidates < candidates / 10);
    assert.ok(booleanWork.cells < cells / 10);
    assertRay(world, [.5, 1, 0], [0, 0, 1], 300);
});

function expandedAttribute(geometry, name) {
    const attribute = geometry.getAttribute(name);
    const input = new Uint32Array(attribute.array.buffer, attribute.array.byteOffset, attribute.array.length);
    const indices = geometry.index?.array;
    const count = indices ? indices.length : attribute.count;
    const output = new Uint32Array(count * attribute.itemSize);
    for (let i = 0; i < count; i++) {
        const vertex = indices ? indices[i] : i;
        for (let j = 0; j < attribute.itemSize; j++) {
            output[i * attribute.itemSize + j] = input[vertex * attribute.itemSize + j];
        }
    }
    return output;
}

function expectedAttributes(batch) {
    return {
        position: new Uint32Array(new Float32Array(batch.pos).buffer),
        normal: new Uint32Array(new Float32Array(batch.nrm).buffer),
        uv: new Uint32Array(new Float32Array(batch.uv).buffer)
    };
}

function assertAttributes(geometry, expected) {
    for (const name of ['position', 'normal', 'uv']) {
        assert.deepEqual(expandedAttribute(geometry, name), expected[name]);
    }
}

test('indexed batches preserve exact triangle order, attributes, materials and shadow flags', () => {
    const world = new World();
    const material = new THREE.MeshBasicMaterial();
    const glass = new THREE.MeshBasicMaterial({ transparent: true });
    for (const x of [-40, 0, 40]) {
        for (let i = 0; i < 1500; i++) {
            const z = -2 + (i % 30) / 30;
            const y = Math.floor(i / 30) / 50;
            world.box(x, y, z, x + .1, y + .01, z + .01, material);
        }
    }
    world.box(-40, -1, -40, 40, 0, 40, material, { shadow: false });
    for (const x of [-40, 0, 40]) world.box(x, 0, 5, x + 2, 3, 6, glass);
    const input = new Map();
    for (const batch of world.batches.values()) {
        input.set(`${batch.material.uuid}:${batch.shadow}:${batch.receive}`, expectedAttributes(batch));
    }
    const scene = new THREE.Scene();
    world.finalize(scene);
    assert.equal(world.meshes.length, input.size);
    for (const mesh of world.meshes) {
        const key = `${mesh.material.uuid}:${mesh.castShadow}:${mesh.receiveShadow}`;
        assertAttributes(mesh.geometry, input.get(key));
        assert.ok(mesh.geometry.index);
        assert.ok(mesh.geometry.attributes.position.count < mesh.geometry.index.count);
        assert.equal(mesh.matrixAutoUpdate, false);
        assert.ok(mesh.geometry.boundingBox && mesh.geometry.boundingSphere);
    }
    scene.traverse((mesh) => mesh.geometry?.dispose());
    material.dispose();
    glass.dispose();
});

test('exact indexing keeps UV and normal seams, signed zero and hash collisions separate', () => {
    const world = new World();
    const material = new THREE.MeshBasicMaterial();
    const batch = world._batch(material);
    // The first two vertices have the same full 32-bit FNV hash, even before table masking.
    const vertices = [
        [1, 0, 0, 0, 1, 0, 0, 0],
        [2, 0, 0, 0, 1, 0, 0, 2 ** -22],
        [1, 0, 0, 1, 0, 0, 0, 0],
        [1, 0, 0, 0, 1, 0, 1, 0],
        [1, -0, 0, 0, 1, 0, 0, 0],
        [1, 0, 0, -0, 1, 0, 0, 0],
        [1, 0, 0, 0, 1, 0, -0, 0],
        [1 + 1e-9, 0, 0, 0, 1, 0, 0, 0]
    ];
    for (let i = 0; i < 3; i++) for (const vertex of vertices) {
        batch.pos.push(...vertex.slice(0, 3));
        batch.nrm.push(...vertex.slice(3, 6));
        batch.uv.push(...vertex.slice(6, 8));
    }
    const expected = expectedAttributes(batch);
    world.finalize(new THREE.Scene());
    const geometry = world.meshes[0].geometry;
    assertAttributes(geometry, expected);
    assert.equal(geometry.attributes.position.count, 7);
    assert.deepEqual(Array.from(geometry.index.array.slice(0, 8)), [0, 1, 2, 3, 4, 5, 6, 0]);
    geometry.dispose();
    material.dispose();
});

test('index width respects the WebGL primitive-restart boundary', () => {
    for (const unique of [65535, 65536]) {
        const world = new World();
        const material = new THREE.MeshBasicMaterial();
        const batch = world._batch(material);
        for (let i = 0; i < unique; i++) for (let j = 0; j < 3; j++) {
            batch.pos.push(i, 0, 0);
            batch.nrm.push(0, 1, 0);
            batch.uv.push(0, 0);
        }
        const expected = expectedAttributes(batch);
        world.finalize(new THREE.Scene());
        const geometry = world.meshes[0].geometry;
        assertAttributes(geometry, expected);
        assert.equal(geometry.index.array.BYTES_PER_ELEMENT, unique <= 65535 ? 2 : 4);
        assert.equal(geometry.attributes.position.count, unique);
        geometry.dispose();
        material.dispose();
    }
});

test('batches with no useful sharing keep their original unindexed attributes', () => {
    const world = new World();
    const material = new THREE.MeshBasicMaterial();
    const batch = world._batch(material);
    for (let i = 0; i < 300; i++) {
        batch.pos.push(i === 299 ? 0 : i, 0, 0);
        batch.nrm.push(0, 1, 0);
        batch.uv.push(0, 0);
    }
    const expected = expectedAttributes(batch);
    world.finalize(new THREE.Scene());
    const geometry = world.meshes[0].geometry;
    assertAttributes(geometry, expected);
    assert.equal(geometry.index, null);
    geometry.dispose();
    material.dispose();
});
