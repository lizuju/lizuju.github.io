const { readdirSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { loadDurations } = require('./update-browser-durations.cjs');
const durations = loadDurations();

// Whole files keep their shared test servers and hooks together.
function allocate(files, project, count) {
    const column = durations.projects.indexOf(project);
    if (column < 0 || !Number.isInteger(count) || count < 1) throw new Error('Invalid browser project or shard count');
    const seconds = file => durations.seconds[file]?.[column] ?? 30;
    const shards = Array.from({ length: count }, () => ({ files: [], seconds: 0 }));
    for (const file of [...files].sort((a, b) => seconds(b) - seconds(a) || a.localeCompare(b))) {
        const shard = shards.reduce((best, candidate) => candidate.seconds < best.seconds ? candidate : best);
        shard.files.push(file);
        shard.seconds += seconds(file);
    }
    return shards;
}

const testFiles = () => readdirSync(path.join(__dirname, '../tests')).filter(file => file.endsWith('.spec.js')).map(file => `tests/${file}`);
module.exports = { allocate, testFiles };

if (require.main === module) {
    const [project, shard, ...extra] = process.argv.slice(2);
    const [index, count] = (shard || '').split('/').map(Number);
    if (!Number.isInteger(index) || index < 1 || index > count) throw new Error('Expected project and shard, e.g. webkit-desktop 1/4');
    const selected = allocate(testFiles(), project, count)[index - 1];
    console.log(`${project} ${shard}: ${selected.files.length} files, approximately ${Math.round(selected.seconds)}s from the timing baseline`);
    if (!selected.files.length) throw new Error('Empty browser shard');
    const result = spawnSync(process.execPath, [require.resolve('@playwright/test/cli'), 'test', `--project=${project}`, ...selected.files, ...extra], { stdio: 'inherit' });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
}
