const { mkdirSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { projects } = require('./browser-test-durations.json');

module.exports = class BrowserTimingReporter {
    constructor() {
        this.seconds = {};
        this.started = new WeakMap();
    }
    onTestBegin(test, result) {
        if (result.workerIndex >= 0) this.started.set(result, performance.now());
    }
    onTestEnd(test, result) {
        const started = this.started.get(result);
        if (started === undefined) return;
        this.started.delete(result);
        const column = projects.indexOf(test.parent.project().name);
        const file = path.relative(process.cwd(), test.location.file).split(path.sep).join('/');
        const values = this.seconds[file] ||= projects.map(() => null);
        // Playwright's reported duration excludes beforeAll/afterAll and trace finalization.
        values[column] = (values[column] || 0) + (performance.now() - started) / 1000;
    }
    onEnd(result) {
        if (result.status !== 'passed') return;
        mkdirSync('test-results', { recursive: true });
        writeFileSync('test-results/browser-durations.json', JSON.stringify({ projects, seconds: this.seconds }) + '\n');
    }
};
