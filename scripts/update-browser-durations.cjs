const { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const baseline = require('./browser-test-durations.json');
const defaultOutput = path.join(__dirname, '../output/browser-test-durations.json');

function observations(data) {
    const values = [];
    if (!Array.isArray(data?.projects) || !data.seconds || typeof data.seconds !== 'object') return values;
    for (const [file, seconds] of Object.entries(data.seconds)) {
        if (!/^tests\/[\w.-]+\.spec\.js$/.test(file) || !Array.isArray(seconds)) continue;
        data.projects.forEach((project, index) => {
            const column = baseline.projects.indexOf(project), value = seconds[index];
            if (column >= 0 && Number.isFinite(value) && value >= 0 && value <= 3600) values.push({ file, column, value: Math.max(0.1, value) });
        });
    }
    return values;
}

function loadDurations(file = defaultOutput) {
    const result = structuredClone(baseline);
    if (existsSync(file)) {
        try {
            for (const { file: name, column, value } of observations(JSON.parse(readFileSync(file, 'utf8')))) {
                (result.seconds[name] ||= baseline.projects.map(() => 30))[column] = value;
            }
        } catch { console.warn('Ignoring an unreadable browser timing baseline.'); }
    }
    return result;
}

function updateDurations(directory, output = defaultOutput) {
    const result = loadDurations(output);
    for (const file of readdirSync(directory, { recursive: true }).filter(file => file.endsWith('.json')).sort()) {
        const data = JSON.parse(readFileSync(path.join(directory, file), 'utf8'));
        for (const { file: name, column, value } of observations(data)) {
            const previous = result.seconds[name]?.[column];
            (result.seconds[name] ||= baseline.projects.map(() => 30))[column] = Math.round((previous === undefined ? value : previous * 0.7 + value * 0.3) * 10) / 10;
        }
    }
    mkdirSync(path.dirname(output), { recursive: true });
    writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
    return result;
}

module.exports = { loadDurations, updateDurations };
if (require.main === module) updateDurations(process.argv[2]);
