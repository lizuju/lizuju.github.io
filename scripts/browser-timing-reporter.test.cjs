const { test } = require('node:test');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, readFileSync, writeFileSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Reporter = require('./browser-timing-reporter.cjs');

test('timings include hooks once and keep interleaved workers and project columns separate', t => {
    let now = 0;
    t.mock.method(performance, 'now', () => now);
    const reporter = new Reporter();
    const chromium = { parent: { project: () => ({ name: 'chromium-desktop' }) }, location: { file: path.resolve('tests/hooks.spec.js') } };
    const webkit = { ...chromium, parent: { project: () => ({ name: 'webkit-desktop' }) } };
    const first = { workerIndex: 0, duration: 100 };
    const parallel = { workerIndex: 1, duration: 100 };
    reporter.onTestBegin(chromium, first);
    now = 100;
    reporter.onTestBegin(webkit, parallel);
    now = 400;
    reporter.onTestEnd(chromium, first);
    now = 1000;
    reporter.onTestEnd(webkit, parallel);
    assert.deepEqual(reporter.seconds['tests/hooks.spec.js'], [0.4, 0.9, null, null]);

    now = 2000;
    const second = { workerIndex: 0, duration: 100 };
    reporter.onTestBegin(chromium, second);
    now = 2200;
    reporter.onTestEnd(chromium, second);
    assert.ok(Math.abs(reporter.seconds['tests/hooks.spec.js'][0] - 0.6) < 0.000001);
});

test('never-started skips add no weight while executed skips retain their cleanup cost', t => {
    let now = 0;
    t.mock.method(performance, 'now', () => now);
    const reporter = new Reporter();
    const entry = { parent: { project: () => ({ name: 'webkit-mobile' }) }, location: { file: path.resolve('tests/skips.spec.js') } };
    const unstarted = { workerIndex: -1, duration: 0, status: 'skipped' };
    reporter.onTestBegin(entry, unstarted);
    now = 1000;
    reporter.onTestEnd(entry, unstarted);
    assert.deepEqual(reporter.seconds, {});

    const skipped = { workerIndex: 0, duration: 0, status: 'skipped' };
    reporter.onTestBegin(entry, skipped);
    now = 1500;
    reporter.onTestEnd(entry, skipped);
    assert.deepEqual(reporter.seconds['tests/skips.spec.js'], [null, null, null, 0.5]);
});

test('real Playwright beforeAll and afterAll are included in the measured file cost', t => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'browser-hook-timings-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    writeFileSync(path.join(directory, 'playwright.config.cjs'), `module.exports = {
        testDir: '.', workers: 1, projects: [{ name: 'chromium-desktop' }],
        reporter: [[${JSON.stringify(require.resolve('./browser-timing-reporter.cjs'))}]]
    };`);
    writeFileSync(path.join(directory, 'hooks.spec.js'), `
        const { test } = require(${JSON.stringify(require.resolve('@playwright/test'))});
        const { setTimeout } = require('node:timers/promises');
        test.beforeAll(() => setTimeout(200));
        test.afterAll(() => setTimeout(200));
        test('body', async () => {});
    `);
    const result = spawnSync(process.execPath, [require.resolve('@playwright/test/cli'), 'test'], { cwd: directory, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const measured = JSON.parse(readFileSync(path.join(directory, 'test-results/browser-durations.json'), 'utf8'));
    assert.ok(measured.seconds['hooks.spec.js'][0] >= 0.38, JSON.stringify(measured));
});
