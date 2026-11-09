const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const THREE = require('three');

const source = readFileSync('src/SatelliteTracker/index.js', 'utf8')
    .replace(/^import .*;$/gm, '')
    .replaceAll('import.meta.url', "'https://portfolio.test/portfolio/js/satellite-tracker.js'");

test('a late removed satellite script cannot replace the active tracker or register duplicate listeners', () => {
    let listeners = 0;
    const window = { addEventListener() { listeners++; } };
    const run = isConnected => vm.runInNewContext(source, {
        THREE, window, document: { currentScript: { isConnected }, querySelector: () => ({}) }
    });
    run(false);
    assert.equal(window.SatelliteTracker, undefined);
    assert.equal(listeners, 0);
    run(true);
    const active = window.SatelliteTracker;
    assert.equal(typeof active.open, 'function');
    assert.equal(listeners, 1);
    run(false);
    assert.equal(window.SatelliteTracker, active);
    assert.equal(listeners, 1);
});
