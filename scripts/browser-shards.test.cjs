const { test } = require('node:test');
const assert = require('node:assert/strict');
const { allocate, testFiles } = require('./run-browser-shard.cjs');

for (const [project, count] of Object.entries({ 'chromium-desktop': 2, 'webkit-desktop': 4, 'chromium-mobile': 1, 'webkit-mobile': 2 })) {
    test(`${project} runs each file once and balances the measured work`, () => {
        const files = [...testFiles(), 'tests/new-coverage.spec.js'];
        const shards = allocate(files, project, count);
        assert.deepEqual(shards.flatMap(shard => shard.files).sort(), files.sort());
        const loads = shards.map(shard => shard.seconds);
        assert.ok(Math.max(...loads) <= Math.min(...loads) * 1.1);
        assert.deepEqual(shards, allocate([...files].reverse(), project, count));
    });
}

const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadDurations, updateDurations } = require('./update-browser-durations.cjs');

test('calibration maps project columns, smooths new samples and preserves unmeasured files', t => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'browser-timings-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const output = path.join(directory, 'baseline.json'), samples = path.join(directory, 'samples');
    mkdirSync(samples);
    const initial = loadDurations(output);
    const file = 'tests/sync-crypto.spec.js';
    writeFileSync(path.join(samples, 'shard.json'), JSON.stringify({ projects: ['webkit-mobile', 'chromium-desktop'], seconds: {
        [file]: [100, 20], 'tests/new-coverage.spec.js': [8, null], '../invalid.spec.js': [10, 10], 'tests/bad.spec.js': [-1, '100']
    } }));
    const updated = updateDurations(samples, output);
    assert.equal(updated.seconds[file][0], Math.round((initial.seconds[file][0] * 0.7 + 6) * 10) / 10);
    assert.equal(updated.seconds[file][3], Math.round((initial.seconds[file][3] * 0.7 + 30) * 10) / 10);
    assert.equal(updated.seconds[file][1], initial.seconds[file][1]);
    assert.equal(updated.seconds['tests/new-coverage.spec.js'][3], 8);
    assert.equal(updated.seconds['tests/bad.spec.js'], undefined);
    assert.equal(updated.seconds['../invalid.spec.js'], undefined);
    assert.deepEqual(updated.seconds['tests/sync-space.spec.js'], initial.seconds['tests/sync-space.spec.js']);
    assert.deepEqual(loadDurations(output), updated);
});

test('missing and malformed prior baselines retain the checked-in timings', t => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'browser-timings-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const file = path.join(directory, 'baseline.json');
    const expected = loadDurations(file);
    writeFileSync(file, 'broken json');
    assert.deepEqual(loadDurations(file), expected);
});

test('timing reporter counts retries and publishes only successful runs', t => {
    const { spawnSync } = require('node:child_process');
    const directory = mkdtempSync(path.join(os.tmpdir(), 'browser-reporter-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const reporter = require.resolve('./browser-timing-reporter.cjs');
    const result = spawnSync(process.execPath, ['-e', `
        const assert = require('node:assert/strict');
        const fs = require('node:fs');
        const Reporter = require(${JSON.stringify(reporter)});
        const reporter = new Reporter();
        const test = { parent: { project: () => ({ name: 'webkit-desktop' }) }, location: { file: process.cwd() + '/tests/sync-space.spec.js' } };
        reporter.onTestEnd(test, { duration: 1000 });
        reporter.onTestEnd(test, { duration: 500 });
        reporter.onEnd({ status: 'failed' });
        assert.equal(fs.existsSync('test-results/browser-durations.json'), false);
        reporter.onEnd({ status: 'passed' });
        const data = JSON.parse(fs.readFileSync('test-results/browser-durations.json', 'utf8'));
        assert.deepEqual(data.seconds['tests/sync-space.spec.js'], [null, 1.5, null, null]);
    `], { cwd: directory, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
});
