const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const THREE = require('three');

const source = fs.readFileSync('static/games/golden-hour/dist/game.js', 'utf8');
const start = source.indexOf('QM=class');
const expression = source.slice(start + 3, source.indexOf('var ', start)).trim().replace(/;$/, '');
const Reflection = vm.runInNewContext(`(${expression})`, {
    Eo: THREE.PerspectiveCamera,
    Lt: THREE.Matrix4,
    jf: THREE.Frustum,
    Po: THREE.Box3
});

function fixture() {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
    const material = new THREE.MeshStandardMaterial();
    const floor = new THREE.Mesh(new THREE.BoxGeometry(20, 0.2, 20), material);
    floor.position.y = -0.1;
    scene.add(floor);
    const reflection = new Reflection(scene, camera);
    reflection.add(material);
    const look = (x, y, z, targetX, targetY, targetZ) => {
        camera.position.set(x, y, z);
        camera.lookAt(targetX, targetY, targetZ);
        camera.updateMatrixWorld(true);
    };
    return { floor, reflection, look };
}

test('renders floor reflections whenever any receiver reaches the camera frustum', () => {
    const { reflection, look } = fixture();
    look(0, 2, 5, 0, 0, 0);
    assert.equal(reflection.floorVisible(), true);
    // Its centre is outside the view, but the near edge still contributes visible pixels.
    look(12, 2, 5, 12, 0, 0);
    assert.equal(reflection.floorVisible(), true);
});

test('skips the reflection pass for views above or completely away from the floor', () => {
    const { reflection, look } = fixture();
    look(0, 2, 0, 0, 20, 0);
    assert.equal(reflection.floorVisible(), false);
    reflection.rt = {};
    reflection.render({ render: () => assert.fail('An invisible floor must not render its scene') });
    look(100, 2, 5, 100, 0, 0);
    assert.equal(reflection.floorVisible(), false);
});

test('tracks receiver transforms and ignores material surfaces outside the reflection plane', () => {
    const { floor, reflection, look } = fixture();
    look(0, 2, 5, 0, 0, 0);
    assert.equal(reflection.floorVisible(), true);
    floor.position.x = 100;
    assert.equal(reflection.floorVisible(), false);
    floor.position.x = 0;
    floor.position.y = 1;
    assert.equal(reflection.floorVisible(), false);
    floor.position.y = -0.1;
    assert.equal(reflection.floorVisible(), true);
});
