const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../../static/games/golden-hour/index.html'), 'utf8');
const bridge = html.match(/<script>([\s\S]*?)<\/script>/)[1];

function harness({ embedded = true, hidden = false } = {}) {
    const events = new Map();
    const pageEvents = new Map();
    const frames = new Map();
    let nextFrame = 1;
    let scheduled = 0;
    class AudioNode {
        constructor(context) { this.context = context; this.connects = 0; this.disconnects = 0; }
        connect(target) { this.target = target; this.connects++; return target; }
        disconnect() { this.target = null; this.disconnects++; }
    }
    class AudioDestinationNode extends AudioNode {}
    const parent = { postMessage() {} };
    const context = {
        navigator: { userAgent: 'Desktop' },
        matchMedia: () => ({ matches: false }),
        document: {
            hidden,
            documentElement: { classList: { add() {} } },
            addEventListener: (name, listener) => pageEvents.set(name, listener)
        },
        localStorage: { getItem: () => null },
        addEventListener: (name, listener) => events.set(name, listener),
        requestAnimationFrame(callback) {
            scheduled += 1;
            const id = nextFrame++;
            frames.set(id, callback);
            return id;
        },
        cancelAnimationFrame: (id) => frames.delete(id),
        setTimeout() {},
        AudioNode,
        AudioDestinationNode,
        GH: { G: { state: 'playing' }, debug: { stats: () => { throw new Error('unneeded stats'); } } }
    };
    context.window = context;
    context.parent = embedded ? parent : context;
    vm.runInNewContext(bridge, context);
    return {
        context,
        frames,
        get scheduled() { return scheduled; },
        frame(time) {
            const callbacks = [...frames.entries()];
            frames.clear();
            for (const [, callback] of callbacks) callback(time);
        },
        state(value) {
            events.get('message')({ source: parent, data: { source: 'gavin-desktop', type: 'game-state', ...value } });
        },
        visibility(value) {
            context.document.hidden = value;
            pageEvents.get('visibilitychange')();
        },
        audio(initialState = 'running') {
            const listeners = [];
            const operations = [];
            const audio = {
                state: initialState,
                currentTime: 2,
                addEventListener: (_, listener) => listeners.push(listener),
                createGain() {
                    const node = new AudioNode(audio);
                    node.gain = { value: 1, setTargetAtTime: (value) => { node.gain.value = value; } };
                    return node;
                },
                suspend: () => transition('suspended'),
                resume: () => transition('running')
            };
            function transition(state) {
                return new Promise((resolve) => operations.push(() => {
                    audio.state = state;
                    for (const listener of listeners) listener();
                    resolve();
                }));
            }
            const source = new AudioNode(audio);
            source.connect(new AudioDestinationNode(audio));
            return {
                audio,
                operations,
                get gain() { return source.target.gain.value; },
                async complete() {
                    assert.ok(operations.length, 'an audio transition is pending');
                    operations.shift()();
                    await Promise.resolve();
                    await Promise.resolve();
                }
            };
        }
    };
}

test('minimizing cancels native frames and resumes pending callbacks exactly once', () => {
    const h = harness();
    let called = 0;
    h.context.requestAnimationFrame(() => called++);
    assert.equal(h.frames.size, 1);
    h.state({ hidden: true });
    assert.equal(h.frames.size, 0);
    const scheduled = h.scheduled;
    for (let frame = 0; frame < 120; frame++) h.frame(frame * 16);
    assert.equal(h.scheduled, scheduled);
    assert.equal(called, 0);
    h.state({ hidden: false });
    h.state({ hidden: false });
    assert.equal(h.frames.size, 1);
    h.frame(2000);
    h.frame(2016);
    assert.equal(called, 1);
});

test('callbacks requested while hidden remain cancellable without native scheduling', () => {
    const h = harness({ hidden: true });
    const seen = [];
    const canceled = h.context.requestAnimationFrame(() => seen.push('canceled'));
    h.context.requestAnimationFrame(() => seen.push('kept'));
    h.context.cancelAnimationFrame(canceled);
    h.context.cancelAnimationFrame(99999);
    assert.equal(h.scheduled, 0);
    h.visibility(false);
    h.frame(100);
    assert.deepEqual(seen, ['kept']);
});

test('page visibility and desktop minimization both keep embedded frames suspended', () => {
    const h = harness();
    h.context.requestAnimationFrame(() => {});
    h.visibility(true);
    h.state({ hidden: true });
    h.visibility(false);
    assert.equal(h.frames.size, 0);
    h.state({ hidden: false });
    assert.equal(h.frames.size, 1);
});

test('standalone page stops its animation callbacks in the background', () => {
    const h = harness({ embedded: false });
    let called = 0;
    h.context.requestAnimationFrame(() => called++);
    h.visibility(true);
    assert.equal(h.frames.size, 0);
    h.visibility(false);
    h.frame(100);
    assert.equal(called, 1);
});

test('startup waits for both dragging and background suspension to end', async () => {
    const h = harness();
    h.state({ hold: true });
    let continued = false;
    const pending = h.context.__goldenHourWaitForBoot().then(() => { continued = true; });
    await Promise.resolve();
    assert.equal(continued, false);
    h.visibility(true);
    h.state({ hold: false });
    await Promise.resolve();
    assert.equal(continued, false);
    h.visibility(false);
    await pending;
    assert.equal(continued, true);
    await h.context.__goldenHourWaitForBoot();
});

test('standalone startup waits for a hidden page to become visible', async () => {
    const h = harness({ embedded: false, hidden: true });
    let continued = false;
    const pending = h.context.__goldenHourWaitForBoot().then(() => { continued = true; });
    await Promise.resolve();
    assert.equal(continued, false);
    h.visibility(false);
    await pending;
    assert.equal(continued, true);
});

test('frame pacing changes modes promptly without using expensive game diagnostics', () => {
    const h = harness();
    const seen = [];
    const loop = (time) => { seen.push(time); h.context.requestAnimationFrame(loop); };
    h.context.requestAnimationFrame(loop);
    h.frame(0);
    h.frame(8);
    h.frame(1000 / 60);
    h.context.GH.G.state = 'menu';
    h.frame(32);
    h.frame(48);
    h.state({ hold: true });
    h.frame(64);
    h.frame(66);
    h.frame(248);
    h.frame(264);
    h.state({ hold: false });
    h.context.GH.G.state = 'playing';
    h.frame(272);
    assert.deepEqual(seen, [0, 1000 / 60, 32, 66, 248, 272]);
});

for (const refreshRate of [60, 75, 90, 120, 144, 165, 240]) {
    test(`frame pacing keeps simulation independent of held drawing at ${refreshRate} Hz`, () => {
        for (const [state, hold, fps] of [
            ['playing', false, 60], ['menu', false, 30], ['paused', false, 30],
            ['playing', true, 60], ['menu', true, 30]
        ]) {
            const h = harness();
            h.context.GH.G.state = state;
            h.state({ hold });
            let simulated = 0;
            let rendered = 0;
            const loop = time => {
                simulated++;
                if (h.context.__goldenHourShouldRender(time)) rendered++;
                h.context.requestAnimationFrame(loop);
            };
            h.context.requestAnimationFrame(loop);
            for (let frame = 0; frame < refreshRate * 10; frame++) h.frame(frame * 1000 / refreshRate);
            assert.equal(simulated, fps * 10, `${state} simulation, hold=${hold}`);
            assert.equal(rendered, (hold ? 5 : fps) * 10, `${state} drawing, hold=${hold}`);
        }
    });
}

test('held drawing resumes immediately and does not catch up after a long gap', () => {
    const h = harness();
    const draw = time => h.context.__goldenHourShouldRender(time);
    assert.equal(draw(0), true);
    h.state({ hold: true });
    assert.equal(draw(10), true);
    assert.equal(draw(20), false);
    assert.equal(draw(209), false);
    assert.equal(draw(210), true);
    assert.equal(draw(1000), true);
    assert.equal(draw(1001), false);
    h.state({ hold: false });
    assert.equal(draw(1010), true);
    h.state({ hold: true });
    assert.equal(draw(1020), true);
    assert.equal(draw(1030), false);
});

test('clock reset epoch changes only when the game returns from actual suspension', () => {
    const h = harness();
    assert.equal(h.context.__goldenHourClockEpoch, 0);
    h.state({ hold: true });
    h.state({ hold: false });
    assert.equal(h.context.__goldenHourClockEpoch, 0, 'drawing holds must not discard simulation time');
    h.state({ hidden: true });
    h.visibility(true);
    h.state({ hidden: false });
    assert.equal(h.context.__goldenHourShouldRender(100), false);
    assert.equal(h.context.__goldenHourClockEpoch, 0, 'the page remains hidden');
    h.visibility(false);
    assert.equal(h.context.__goldenHourClockEpoch, 1);
    assert.equal(h.context.__goldenHourShouldRender(101), true);
    h.state({ hidden: false });
    h.visibility(false);
    assert.equal(h.context.__goldenHourClockEpoch, 1, 'duplicate visibility reports keep the clock');
    h.state({ hold: true, hidden: true });
    h.state({ hold: true, hidden: false });
    assert.equal(h.context.__goldenHourClockEpoch, 2);
    assert.equal(h.context.__goldenHourShouldRender(102), true, 'restoring a held game draws immediately');
});

test('playing cadence stays steady when the display refresh rate changes', () => {
    const h = harness();
    let rendered = 0;
    const loop = () => { rendered++; h.context.requestAnimationFrame(loop); };
    h.context.requestAnimationFrame(loop);
    let elapsed = 0;
    for (const refreshRate of [120, 90, 60, 144, 75, 165, 240]) {
        const before = rendered;
        for (let frame = 0; frame < refreshRate; frame++) h.frame(elapsed + frame * 1000 / refreshRate);
        assert.equal(rendered - before, 60, `${refreshRate} Hz segment`);
        elapsed += 1000;
    }
});

test('minor refresh jitter and rounded timestamps do not repeatedly drop playing frames', () => {
    for (const timestamp of [
        frame => frame * 1000 / 60 + (frame % 2 ? -0.5 : 0.5),
        frame => Math.round(frame * 1000 / 60)
    ]) {
        const h = harness();
        let rendered = 0;
        const loop = () => { rendered++; h.context.requestAnimationFrame(loop); };
        h.context.requestAnimationFrame(loop);
        for (let frame = 0; frame < 600; frame++) h.frame(frame ? timestamp(frame) : 0);
        assert.ok(rendered >= 599 && rendered <= 600, `${rendered} frames over ten seconds`);
    }
});

test('recovering from sustained slow rendering does not accumulate a catch-up workload', () => {
    for (const slowRate of [40, 50]) {
        const h = harness();
        let rendered = 0;
        const loop = () => { rendered++; h.context.requestAnimationFrame(loop); };
        h.context.requestAnimationFrame(loop);
        for (let frame = 0; frame < slowRate * 10; frame++) h.frame(frame * 1000 / slowRate);
        const before = rendered;
        for (let frame = 0; frame < 120; frame++) h.frame(10000 + frame * 1000 / 120);
        assert.ok(rendered - before >= 60 && rendered - before <= 61,
            `${rendered - before} frames in the first recovered second after ${slowRate} Hz`);
    }
});

test('long rendering gaps and hidden-page recovery do not create catch-up frames', () => {
    const h = harness();
    const seen = [];
    const loop = time => { seen.push(time); h.context.requestAnimationFrame(loop); };
    h.context.requestAnimationFrame(loop);
    h.frame(0);
    h.frame(1000);
    h.frame(1001);
    h.frame(1008);
    h.frame(1000 + 1000 / 60);
    h.visibility(true);
    h.visibility(false);
    h.frame(10000);
    h.frame(10001);
    h.frame(10008);
    h.frame(10000 + 1000 / 60);
    assert.deepEqual(seen, [0, 1000, 1000 + 1000 / 60, 10000, 10000 + 1000 / 60]);
});

test('a rapid hide and show starts a fresh frame interval', () => {
    const h = harness();
    const seen = [];
    const loop = time => { seen.push(time); h.context.requestAnimationFrame(loop); };
    h.context.requestAnimationFrame(loop);
    h.frame(0);
    h.visibility(true);
    h.visibility(false);
    h.frame(8);
    h.frame(16);
    h.frame(8 + 1000 / 60);
    assert.deepEqual(seen, [0, 8, 8 + 1000 / 60]);
});

test('callbacks sharing one native refresh get the same pacing decision', () => {
    const h = harness();
    const seen = [[], []];
    for (const timestamps of seen) {
        const loop = time => { timestamps.push(time); h.context.requestAnimationFrame(loop); };
        h.context.requestAnimationFrame(loop);
    }
    for (let frame = 0; frame < 120; frame++) h.frame(frame * 1000 / 120);
    assert.equal(seen[0].length, 60);
    assert.deepEqual(seen[0], seen[1]);
});

test('hidden game suspends its audio context and restores it without changing mute preference', async () => {
    const h = harness();
    const sound = h.audio();
    h.state({ hidden: true, muted: true });
    assert.equal(sound.gain, 0);
    await sound.complete();
    assert.equal(sound.audio.state, 'suspended');
    h.state({ hidden: false, muted: true });
    await sound.complete();
    assert.equal(sound.audio.state, 'running');
    assert.equal(sound.gain, 0);
    h.state({ muted: false });
    assert.equal(sound.gain, 1);
    assert.equal(sound.operations.length, 0);
});

test('fast hide/show transitions settle in the latest requested audio state', async () => {
    const h = harness();
    const sound = h.audio();
    h.state({ hidden: true });
    h.state({ hidden: false });
    assert.equal(sound.operations.length, 1);
    await sound.complete();
    assert.equal(sound.operations.length, 1);
    h.state({ hidden: true });
    await sound.complete();
    assert.equal(sound.operations.length, 1);
    await sound.complete();
    assert.equal(sound.audio.state, 'suspended');
    assert.equal(sound.operations.length, 0);
    h.state({ hidden: false });
    await sound.complete();
    assert.equal(sound.audio.state, 'running');
});

test('autoplay-suspended contexts stay suspended and active mute does not freeze the audio timeline', () => {
    const h = harness();
    const autoplay = h.audio('suspended');
    const running = h.audio();
    h.state({ muted: true });
    assert.equal(running.gain, 0);
    assert.equal(running.operations.length, 0);
    h.state({ hidden: true });
    h.state({ hidden: false });
    assert.equal(autoplay.operations.length, 0);
    assert.equal(autoplay.audio.state, 'suspended');
});

test('delayed UI sounds are discarded while hidden without suppressing Safari first-gesture sounds', () => {
    const game = fs.readFileSync(path.join(__dirname, '../../static/games/golden-hour/dist/game.js'), 'utf8');
    const callback = game.match(/sound:(f0=>[^,]+),hitSound:/)[1];
    const h = harness();
    const sound = h.audio('suspended');
    const heard = [];
    const play = vm.runInNewContext(`(${callback})`, {
        fo: { _engine: { ctx: sound.audio }, ui: (name) => heard.push(name) }
    });
    play('click');
    assert.deepEqual(heard, ['click'], 'Safari may still be suspended during the first user gesture');
    h.state({ hidden: true });
    play('unlock');
    play('unlock');
    assert.deepEqual(heard, ['click']);
    h.state({ hidden: false });
    sound.audio.state = 'running';
    play('click');
    assert.deepEqual(heard, ['click', 'click']);
});


test('system mute disconnects only the game output without freezing time or duplicating connections', () => {
    const h = harness();
    const sound = h.audio();
    const output = sound.audio.__goldenHourOutput;
    const destination = output.target;
    assert.ok(destination);
    assert.equal(output.connects, 1);
    h.state({ muted: true });
    h.state({ muted: true });
    assert.equal(output.target, null);
    assert.equal(output.disconnects, 1);
    assert.equal(output.muted, true);
    assert.equal(sound.audio.state, 'running');
    assert.equal(sound.operations.length, 0);
    sound.audio.currentTime += 60;
    h.state({ muted: false });
    h.state({ muted: false });
    assert.equal(output.target, destination);
    assert.equal(output.connects, 2);
    assert.equal(output.muted, false);
    assert.equal(sound.audio.currentTime, 62);
});

test('audio first created while muted starts disconnected and unmute attaches exactly once', () => {
    const h = harness();
    h.state({ muted: true });
    const sound = h.audio();
    const output = sound.audio.__goldenHourOutput;
    assert.equal(output.connects, 0);
    assert.equal(output.disconnects, 0);
    assert.equal(output.muted, true);
    h.state({ muted: false });
    h.state({ muted: false });
    assert.equal(output.connects, 1);
    assert.ok(output.target);
});

test('mute changes during pending visibility transitions preserve the latest connection and context state', async () => {
    const h = harness();
    const sound = h.audio();
    const output = sound.audio.__goldenHourOutput;
    h.state({ hidden: true, muted: true });
    h.state({ hidden: false, muted: false });
    await sound.complete();
    h.state({ hidden: false, muted: true });
    await sound.complete();
    assert.equal(sound.audio.state, 'running');
    assert.equal(output.target, null);
    assert.equal(output.muted, true);
    assert.equal(output.connects, 2);
    assert.equal(output.disconnects, 2);
    h.state({ hidden: true, muted: false });
    await sound.complete();
    assert.equal(sound.audio.state, 'suspended');
    assert.equal(output.muted, false);
    assert.equal(output.hidden, true);
    assert.equal(sound.gain, 0);
    h.state({ hidden: false, muted: false });
    await sound.complete();
    assert.equal(sound.audio.state, 'running');
    assert.equal(sound.gain, 1);
});

test('closed contexts are removed from system mute updates', () => {
    const h = harness();
    const sound = h.audio();
    const output = sound.audio.__goldenHourOutput;
    sound.audio.state = 'closed';
    h.state({ muted: true });
    const counts = [output.connects, output.disconnects];
    h.state({ muted: false });
    h.state({ hidden: true, muted: true });
    assert.deepEqual([output.connects, output.disconnects], counts);
    assert.equal(sound.operations.length, 0);
});
