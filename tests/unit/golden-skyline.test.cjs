const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const THREE = require('three');

const source = readFileSync(resolve(__dirname, '../../static/games/golden-hour/dist/game.js'), 'utf8');
const randomStart = source.indexOf('function Re(');
const randomSource = source.slice(randomStart, source.indexOf('var at=', randomStart));
const start = source.indexOf('h=new ia(r,c,a)', source.indexOf('function PL('));
const end = source.indexOf('r.setAttribute("aInfo"', start);

test('skyline submits only populated buildings and preserves every visible instance', () => {
    let writes = 0;
    class Instances extends THREE.InstancedMesh {
        setMatrixAt(index, matrix) {
            writes++;
            return super.setMatrixAt(index, matrix);
        }
    }
    const { mesh, info, filled } = vm.runInNewContext(`${randomSource}; (() => {
        let n=Re(4711),i=250,a=i*3,r=new qs(1,1,1),c={},l=new Float32Array(a*4);
        let ${source.slice(start, end)};
        return { mesh:h, info:l, filled:p };
    })()`, {
        qs: THREE.BoxGeometry, ia: Instances, Lt: THREE.Matrix4, Ft: THREE.Quaternion,
        a0: THREE.Vector3, je: { DEFAULT_UP: new THREE.Vector3(0, 1, 0) },
        Pd: -180, Float32Array
    });
    const hash = values => createHash('sha256').update(Buffer.from(
        values.buffer, values.byteOffset, values.byteLength)).digest('hex');
    assert.equal(filled, 576);
    assert.equal(mesh.count, filled);
    assert.equal(writes, filled);
    assert.equal(hash(mesh.instanceMatrix.array.subarray(0, filled * 16)),
        'dfa359405e78e27f397ced738ef7ff9a286786527af51057a047e992e2345f68');
    assert.equal(hash(info.subarray(0, filled * 4)),
        'f980c474e80b410c8cea83baf45a6ffd658162d4a1911206c65fcbf520a0ff68');
    mesh.geometry.dispose();
});
