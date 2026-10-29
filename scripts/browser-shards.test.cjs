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
