const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

const source = ts.transpileModule(readFileSync('src/Application/Utils/Time.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
}).outputText;

function clock() {
    let now = 1000, nextId = 0, ticks = 0;
    const frames = new Map(), timers = new Map(), listeners = new Map();
    const document = {
        hidden: false,
        addEventListener: (type, fn) => listeners.set(type, fn),
        removeEventListener: type => listeners.delete(type)
    };
    const exports = {};
    vm.runInNewContext(source, {
        exports, document, Date: { now: () => now },
        require: name => ({ default: name.endsWith('EventEmitter')
            ? class { trigger() { ticks++; } }
            : { on: () => () => {} } }),
        window: {
            requestAnimationFrame(fn) { frames.set(++nextId, fn); return nextId; },
            cancelAnimationFrame(id) { frames.delete(id); },
            setTimeout(fn, delay) { timers.set(++nextId, { fn, at: now + delay }); return nextId; },
            clearTimeout(id) { timers.delete(id); }
        }
    });
    return {
        time: new exports.default(), frames, timers, document,
        get ticks() { return ticks; },
        advance(ms) {
            now += ms;
            for (const [id, timer] of [...timers]) if (timer.at <= now) {
                timers.delete(id);
                timer.fn();
            }
        },
        frame() {
            const pending = [...frames.values()];
            frames.clear();
            for (const fn of pending) fn();
        },
        visibility(hidden) { document.hidden = hidden; listeners.get('visibilitychange')(); }
    };
}

test('the immersive room sleeps between throttled updates without polling every display frame', () => {
    const c = clock();
    c.time.throttleWhen = () => true;
    c.advance(16);
    c.frame();
    assert.equal(c.ticks, 0);
    assert.equal(c.frames.size, 0);
    assert.equal(c.timers.size, 1);
    c.advance(83);
    assert.equal(c.frames.size, 0);
    c.advance(1);
    c.frame();
    assert.equal(c.ticks, 1);
    assert.equal(c.time.delta, 100);
    assert.equal(c.frames.size, 0);
    assert.equal(c.timers.size, 1);

    c.time.throttleWhen = () => false;
    c.advance(100);
    c.frame();
    assert.equal(c.ticks, 2);
    assert.equal(c.timers.size, 0);
    assert.equal(c.frames.size, 1);
    c.advance(16);
    c.frame();
    assert.equal(c.ticks, 3);
});

test('hiding or destroying the scene cancels the delayed wake and resume creates one loop', () => {
    const c = clock();
    c.time.throttleWhen = () => true;
    c.frame();
    c.visibility(true);
    assert.equal(c.timers.size, 0);
    c.advance(5000);
    c.frame();
    assert.equal(c.ticks, 0);
    assert.equal(c.frames.size, 0);
    c.visibility(false);
    c.time.resume();
    assert.equal(c.frames.size, 1);
    c.advance(100);
    c.frame();
    assert.equal(c.ticks, 1);
    assert.equal(c.time.delta, 100);
    c.time.destroy();
    assert.equal(c.timers.size, 0);
    assert.equal(c.frames.size, 0);
});
