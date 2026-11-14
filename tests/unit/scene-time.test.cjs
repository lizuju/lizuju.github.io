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

test('the immersive room draws its frame, then freezes until woken, skipping the frozen time', () => {
    const c = clock();
    c.time.freezeWhen = () => true;
    c.advance(16);
    c.frame();
    assert.equal(c.ticks, 1);
    assert.equal(c.frames.size, 0);
    assert.equal(c.timers.size, 0);
    c.advance(5000);
    c.frame();
    assert.equal(c.ticks, 1);
    const elapsed = c.time.elapsed;

    // A resize or camera move draws once, then the freeze holds again.
    c.time.wake();
    assert.equal(c.frames.size, 1);
    c.advance(16);
    c.frame();
    assert.equal(c.ticks, 2);
    assert.equal(c.time.delta, 16);
    assert.equal(c.time.elapsed, elapsed + 16);
    assert.equal(c.frames.size, 0);

    // Lifting the freeze brings back the normal loop, and waking a running loop adds nothing.
    c.time.freezeWhen = () => false;
    c.time.wake();
    c.advance(16);
    c.frame();
    assert.equal(c.ticks, 3);
    assert.equal(c.frames.size, 1);
    c.time.wake();
    assert.equal(c.frames.size, 1);
    c.advance(16);
    c.frame();
    assert.equal(c.ticks, 4);
});

test('hiding a frozen scene and showing it again draws one frame, and destroy stops the loop', () => {
    const c = clock();
    c.time.freezeWhen = () => true;
    c.frame();
    assert.equal(c.ticks, 1);
    c.visibility(true);
    c.advance(5000);
    c.frame();
    assert.equal(c.ticks, 1);
    c.visibility(false);
    c.time.resume();
    assert.equal(c.frames.size, 1);
    c.advance(16);
    c.frame();
    assert.equal(c.ticks, 2);
    assert.equal(c.time.delta, 16);
    assert.equal(c.frames.size, 0);
    c.time.wake();
    c.time.destroy();
    assert.equal(c.frames.size, 0);
    assert.equal(c.timers.size, 0);
});
