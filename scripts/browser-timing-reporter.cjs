const { mkdirSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const { projects } = require('./browser-test-durations.json');

module.exports = class BrowserTimingReporter {
    constructor() { this.seconds = {}; }
    onTestEnd(test, result) {
        const column = projects.indexOf(test.parent.project().name);
        const file = path.relative(process.cwd(), test.location.file).split(path.sep).join('/');
        const values = this.seconds[file] ||= projects.map(() => null);
        values[column] = (values[column] || 0) + result.duration / 1000;
    }
    onEnd(result) {
        if (result.status !== 'passed') return;
        mkdirSync('test-results', { recursive: true });
        writeFileSync('test-results/browser-durations.json', JSON.stringify({ projects, seconds: this.seconds }) + '\n');
    }
};
