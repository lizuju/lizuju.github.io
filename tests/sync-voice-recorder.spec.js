const { test, expect } = require('@playwright/test');
const { readFile } = require('node:fs/promises');
const vm = require('node:vm');
const path = require('node:path');
const { startSite, authorize, deviceId, keyId, profile } = require('./fixtures/sync-e2ee.cjs');

test.beforeEach(async ({ page }) => {
    await page.route('**/__voice-recorder-test__/**', async route => {
        if (route.request().url().endsWith('/recorder.js')) return route.fulfill({
            contentType: 'application/javascript',
            body: await readFile(path.join(__dirname, '../static/portfolio/js/apps/sync-voice-recorder.js'), 'utf8')
        });
        return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Voice recorder tests</title>' });
    });
    await page.goto('/__voice-recorder-test__/');
    await page.evaluate(async () => {
        const nativeContext = window.AudioContext || window.webkitAudioContext;
        const h = window.voiceHarness = { contexts: [], nodes: [], tracks: [], events: [], times: [], results: [], errors: [], holdPermission: false, holdClose: false, flush: true };
        class Context {
            constructor() {
                this.state = 'suspended';
                this.destination = {};
                this.audioWorklet = { addModule: async url => { this.moduleUrl = String(url); if (h.moduleError) throw new DOMException('Module unavailable', 'NotSupportedError'); } };
                this.closeCalls = 0;
                h.contexts.push(this);
                h.events.push('construct');
            }
            resume() { h.events.push('resume'); this.state = 'running'; return Promise.resolve(); }
            createMediaStreamSource() { return this.source = { connect() {}, disconnect() { this.disconnected = true; } }; }
            close() {
                this.closeCalls++;
                this.state = 'closed';
                if (h.holdClose) return new Promise(resolve => { h.releaseClose = resolve; });
                return Promise.resolve();
            }
        }
        class Node {
            constructor(context, name) {
                this.context = context;
                this.name = name;
                this.port = {
                    postMessage: data => { if (data.type === 'stop' && h.flush) queueMicrotask(() => this.emit({ type: 'stopped' })); },
                    close() { this.closed = true; }
                };
                h.nodes.push(this);
            }
            emit(data) { this.port.onmessage?.({ data }); }
            connect() {}
            disconnect() { this.disconnected = true; }
        }
        Object.defineProperty(window, 'AudioContext', { configurable: true, value: Context });
        Object.defineProperty(window, 'AudioWorkletNode', { configurable: true, value: Node });
        Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
            getUserMedia() {
                h.events.push('permission');
                if (h.denied) return Promise.reject(new DOMException('Microphone access denied', 'NotAllowedError'));
                const track = new EventTarget();
                track.stopCalls = 0;
                track.stop = () => { track.stopCalls++; };
                h.tracks.push(track);
                const stream = { getTracks: () => [track] };
                if (h.holdPermission) return new Promise(resolve => { h.grant = () => resolve(stream); });
                return Promise.resolve(stream);
            }
        } });
        const { VoiceRecorder } = await import('/__voice-recorder-test__/recorder.js');
        h.make = () => new VoiceRecorder({ onTime: ms => h.times.push(ms), onStop: result => h.results.push(result), onError: error => h.errors.push(error.name) });
        h.recorder = h.make();
        h.nativeContext = nativeContext;
    });
});

test('records only after start and writes a playable 16k mono PCM16 WAV with integer duration', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const h = window.voiceHarness;
        const idle = { state: h.recorder.state, contexts: h.contexts.length, tracks: h.tracks.length };
        const started = await h.recorder.start();
        h.nodes[0].emit({ type: 'samples', samples: Float32Array.from({ length: 16001 }, (_, i) => i % 2 ? 0.5 : -0.5) });
        const result = await h.recorder.stop();
        const bytes = await result.file.arrayBuffer();
        const header = new DataView(bytes);
        const decoder = new h.nativeContext();
        const audio = await decoder.decodeAudioData(bytes.slice(0));
        await decoder.close();
        return {
            idle, started, events: h.events, type: result.file.type, durationMs: result.durationMs, size: result.file.size,
            format: [header.getUint16(20, true), header.getUint16(22, true), header.getUint32(24, true), header.getUint16(34, true)],
            decoded: { channels: audio.numberOfChannels, duration: audio.duration },
            states: [h.recorder.state, h.nodes[0].port.closed, h.nodes[0].disconnected, h.contexts[0].closeCalls],
            stopped: h.tracks[0].stopCalls > 0, stops: h.results.length, errors: h.errors
        };
    });
    expect(result.idle).toEqual({ state: 'idle', contexts: 0, tracks: 0 });
    expect(result.started).toBe(true);
    expect(result.events).toEqual(['construct', 'resume', 'permission']);
    expect(result.type).toBe('audio/wav');
    expect(result.durationMs).toBe(1000);
    expect(result.size).toBe(44 + 16001 * 2);
    expect(result.format).toEqual([1, 1, 16000, 16]);
    expect(result.decoded.channels).toBe(1);
    expect(result.decoded.duration).toBeCloseTo(16001 / 16000, 3);
    expect(result.states).toEqual(['idle', true, true, 1]);
    expect(result.stopped).toBe(true);
    expect(result.stops).toBe(1);
    expect(result.errors).toEqual([]);
});

test('cancel during permission resolves start promptly and stops a late microphone stream', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const h = window.voiceHarness;
        h.holdPermission = true;
        const starting = h.recorder.start();
        await h.recorder.cancel();
        const started = await starting;
        h.grant();
        await Promise.resolve();
        return { started, state: h.recorder.state, stopped: h.tracks[0].stopCalls, closeCalls: h.contexts[0].closeCalls, nodes: h.nodes.length, results: h.results.length, errors: h.errors };
    });
    expect(result).toEqual({ started: false, state: 'idle', stopped: 1, closeCalls: 1, nodes: 0, results: 0, errors: [] });
});

test('permission and worklet errors preserve their names and release recording resources', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const h = window.voiceHarness;
        h.denied = true;
        const denied = await h.recorder.start();
        h.denied = false;
        h.moduleError = true;
        const unavailable = await h.recorder.start();
        return { denied, unavailable, errors: h.errors, closeCalls: h.contexts.map(context => context.closeCalls), stopped: h.tracks[0].stopCalls, state: h.recorder.state };
    });
    expect(result).toEqual({ denied: false, unavailable: false, errors: ['NotAllowedError', 'NotSupportedError'], closeCalls: [1, 1], stopped: 1, state: 'idle' });
});

test('stopping then cancelling while the worklet flushes never saves a partial voice message', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const h = window.voiceHarness;
        h.flush = false;
        await h.recorder.start();
        h.nodes[0].emit({ type: 'samples', samples: new Float32Array(160) });
        const stopping = h.recorder.stop();
        const immediatelyStopped = h.tracks[0].stopCalls > 0;
        await h.recorder.cancel();
        h.nodes[0].emit({ type: 'stopped' });
        return { result: await stopping, immediatelyStopped, state: h.recorder.state, closeCalls: h.contexts[0].closeCalls, results: h.results.length, errors: h.errors };
    });
    expect(result).toEqual({ result: null, immediatelyStopped: true, state: 'idle', closeCalls: 1, results: 0, errors: [] });
});

test('cancelling during context close is idempotent and stale errors cannot affect the next recording', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const h = window.voiceHarness;
        h.holdClose = true;
        await h.recorder.start();
        h.nodes[0].emit({ type: 'samples', samples: new Float32Array(160) });
        const staleError = h.nodes[0].onprocessorerror;
        const stopping = h.recorder.stop();
        await Promise.resolve();
        const cancelling = h.recorder.cancel();
        const closeCalls = h.contexts[0].closeCalls;
        h.releaseClose();
        await cancelling;
        const saved = await stopping;
        h.holdClose = false;
        await h.recorder.start();
        staleError();
        const current = h.recorder.state;
        await h.recorder.dispose();
        return { saved, closeCalls, current, state: h.recorder.state, results: h.results.length, errors: h.errors };
    });
    expect(result).toEqual({ saved: null, closeCalls: 1, current: 'recording', state: 'disposed', results: 0, errors: [] });
});

test('hardware interruptions stop capture and a missing worklet flush times out safely', async ({ page }) => {
    await page.clock.install();
    const interrupted = await page.evaluate(async () => {
        const h = window.voiceHarness;
        await h.recorder.start();
        h.tracks[0].dispatchEvent(new Event('ended'));
        return h.tracks[0].stopCalls > 0;
    });
    expect(interrupted).toBe(true);
    await expect.poll(() => page.evaluate(() => window.voiceHarness.errors)).toEqual(['NotReadableError']);
    await page.evaluate(async () => {
        const h = window.voiceHarness;
        h.flush = false;
        await h.recorder.start();
        h.stopping = h.recorder.stop();
    });
    await page.clock.fastForward(2100);
    expect(await page.evaluate(async () => ({ result: await window.voiceHarness.stopping, state: window.voiceHarness.recorder.state, errors: window.voiceHarness.errors })))
        .toEqual({ result: null, state: 'idle', errors: ['NotReadableError', 'NotReadableError'] });
});

test('timer stop and sample hard limit never create more than sixty seconds of PCM audio', async ({ page }) => {
    await page.clock.install();
    await page.evaluate(async () => {
        const h = window.voiceHarness;
        await h.recorder.start();
        h.nodes[0].emit({ type: 'samples', samples: new Float32Array(16000 * 61) });
    });
    await page.clock.fastForward(60000);
    const result = await page.evaluate(() => {
        const h = window.voiceHarness;
        return { count: h.results.length, durationMs: h.results[0].durationMs, size: h.results[0].file.size, state: h.recorder.state, stopped: h.tracks[0].stopCalls > 0 };
    });
    expect(result).toEqual({ count: 1, durationMs: 60000, size: 1920044, state: 'idle', stopped: true });
});

for (const trigger of ['manual', 'timer']) {
test(`a ${trigger} stop with no captured samples notifies the UI and releases every recording resource`, async ({ page }) => {
    if (trigger === 'timer') await page.clock.install();
    await page.evaluate(async () => { await window.voiceHarness.recorder.start(); });
    if (trigger === 'timer') await page.clock.fastForward(60000);
    else expect(await page.evaluate(() => window.voiceHarness.recorder.stop())).toBeNull();
    await expect.poll(() => page.evaluate(() => window.voiceHarness.errors)).toEqual(['NotReadableError']);
    expect(await page.evaluate(() => {
        const h = window.voiceHarness;
        return { state: h.recorder.state, results: h.results.length, stopped: h.tracks[0].stopCalls > 0, closeCalls: h.contexts[0].closeCalls, portClosed: h.nodes[0].port.closed, disconnected: h.nodes[0].disconnected };
    })).toEqual({ state: 'idle', results: 0, stopped: true, closeCalls: 1, portClosed: true, disconnected: true });
});
}

test('cancelling a zero-sample completion during context close suppresses its stale error', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const h = window.voiceHarness;
        h.holdClose = true;
        await h.recorder.start();
        const stopping = h.recorder.stop();
        await Promise.resolve();
        const cancelling = h.recorder.cancel();
        h.releaseClose();
        await cancelling;
        return { result: await stopping, errors: h.errors, state: h.recorder.state, results: h.results.length, closeCalls: h.contexts[0].closeCalls };
    });
    expect(result).toEqual({ result: null, errors: [], state: 'idle', results: 0, closeCalls: 1 });
});

test('the real worklet downsamples stereo at common device rates and hard stops at 960000 samples', async () => {
    const source = await readFile(path.join(__dirname, '../static/portfolio/js/apps/sync-voice-worklet.js'), 'utf8');
    for (const rate of [16000, 44100, 48000]) {
        let Processor;
        const messages = [];
        vm.runInNewContext(source, {
            sampleRate: rate, Float32Array,
            AudioWorkletProcessor: class { constructor() { this.port = { postMessage: message => messages.push(message) }; } },
            registerProcessor: (name, constructor) => { expect(name).toBe('gavin-sync-voice'); Processor = constructor; }
        });
        const processor = new Processor();
        let active = true;
        for (let frame = 0; frame < Math.ceil(rate * 61 / 128) && active; frame++) {
            active = processor.process([[new Float32Array(128).fill(0.5), new Float32Array(128).fill(-0.25)]]);
        }
        const chunks = messages.filter(message => message.type === 'samples');
        expect(chunks.reduce((sum, chunk) => sum + chunk.samples.length, 0)).toBe(960000);
        expect(chunks.every(chunk => chunk.samples.every(sample => sample === 0.125))).toBe(true);
        expect(messages.at(-1).type).toBe('limit');
        expect(active).toBe(false);
        processor.port.onmessage({ data: { type: 'stop' } });
        expect(messages.at(-1).type).toBe('limit');
    }
});

test('built chat records a silent synthetic microphone through the native AudioWorklet under its real CSP', async ({ page }) => {
    const processors = [];
    const site = await startSite('https://sync.test', async pathname => {
        if (!pathname.endsWith('.js')) return;
        const source = await readFile(path.join(__dirname, '../docs', pathname), 'utf8').catch(() => '');
        if (/registerProcessor\(["']gavin-sync-voice["']/.test(source)) processors.push(pathname);
    });
    await page.addInitScript(() => {
        const Context = window.AudioContext || window.webkitAudioContext;
        const createObjectURL = URL.createObjectURL.bind(URL);
        window.voiceBlobs = new Map();
        URL.createObjectURL = blob => {
            const url = createObjectURL(blob);
            window.voiceBlobs.set(url, blob);
            return url;
        };
        Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
            getUserMedia() {
                const context = new Context();
                window.syntheticMicrophone = context;
                const ready = context.resume();
                const oscillator = context.createOscillator();
                oscillator.frequency.value = 440;
                const destination = context.createMediaStreamDestination();
                oscillator.connect(destination);
                oscillator.start();
                return ready.then(() => destination.stream);
            }
        } });
    });
    await page.route('https://sync.test/**', route => {
        const pathname = new URL(route.request().url()).pathname;
        const body = pathname.endsWith('/key-grants') ? { grants: [], hasMore: false, keyId }
            : pathname.endsWith('/devices') ? { devices: [profile()], deviceId }
                : { ok: true };
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    });
    await page.routeWebSocket('wss://sync.test/**', socket => socket.onMessage(raw => {
        if (raw === 'ping') return socket.send('pong');
        if (JSON.parse(raw).type === 'auth') socket.send(JSON.stringify({ type: 'ready', deviceId, pairing: null, messages: [] }));
    }));
    try {
        await authorize(page, `${site.origin}/portfolio/chat/`);
        await page.reload();
        await expect(page.locator('[data-sync-status]')).toHaveAttribute('data-state', 'online');
        await page.locator('[data-sync-voice-record]').click();
        await expect(page.locator('[data-sync-voice-stop]')).toBeEnabled();
        await page.waitForTimeout(450);
        await page.locator('[data-sync-voice-stop]').click();
        const preview = page.locator('[data-sync-voice-preview]');
        await expect(preview).toBeVisible();
        const result = await preview.evaluate(async audio => {
            const bytes = await window.voiceBlobs.get(audio.src).arrayBuffer();
            const header = new DataView(bytes);
            const context = new (window.AudioContext || window.webkitAudioContext)();
            const decoded = await context.decodeAudioData(bytes.slice(0));
            await context.close();
            return {
                sampleRate: header.getUint32(24, true), channels: header.getUint16(22, true), bits: header.getUint16(34, true),
                duration: decoded.duration, nonzero: decoded.getChannelData(0).some(sample => Math.abs(sample) > 0.001)
            };
        });
        expect(result.sampleRate).toBe(16000);
        expect(result.channels).toBe(1);
        expect(result.bits).toBe(16);
        expect(result.duration).toBeGreaterThan(0.25);
        expect(result.duration).toBeLessThan(2);
        expect(result.nonzero).toBe(true);
        await expect.poll(() => processors.length).toBe(1);
        expect(processors[0]).toMatch(/^\/[0-9a-f]+\.js$/);
    } finally {
        await page.evaluate(() => window.syntheticMicrophone?.close()).catch(() => {});
        await page.goto('about:blank');
        await site.close();
    }
});
