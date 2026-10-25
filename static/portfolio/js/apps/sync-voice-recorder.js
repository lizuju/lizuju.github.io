const SAMPLE_RATE = 16000;
const MAX_DURATION_MS = 60000;

export class VoiceRecorder {
    constructor({ onTime = () => {}, onStop = () => {}, onError = () => {} } = {}) {
        this.onTime = onTime;
        this.onStop = onStop;
        this.onError = onError;
        this.run = null;
        this.disposed = false;
    }

    get state() { return this.disposed ? 'disposed' : this.run?.state || 'idle'; }

    async start() {
        if (this.disposed || this.run) return false;
        const run = { state: 'starting', chunks: [], sampleCount: 0, listeners: [] };
        run.cancelledSetup = new Promise(resolve => { run.cancelSetup = resolve; });
        this.run = run;
        try {
            const Context = window.AudioContext || window.webkitAudioContext;
            if (!Context || !window.AudioWorkletNode || !navigator.mediaDevices?.getUserMedia) {
                throw new DOMException('Audio recording is unavailable', 'NotSupportedError');
            }
            run.context = new Context();
            const resumed = run.context.resume();
            const permission = navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false })
                .then(stream => {
                    run.stream = stream;
                    if (run.cancelled) stream.getTracks().forEach(track => track.stop());
                    return stream;
                });
            await Promise.race([Promise.all([resumed, permission]), run.cancelledSetup]);
            if (run.cancelled) return false;
            const interrupted = () => this.fail(run, new DOMException('Audio recording was interrupted', 'NotReadableError'));
            for (const track of run.stream.getTracks()) {
                for (const type of ['ended', 'mute']) {
                    track.addEventListener(type, interrupted);
                    run.listeners.push(() => track.removeEventListener(type, interrupted));
                }
            }
            await Promise.race([run.context.audioWorklet.addModule(new URL('./sync-voice-worklet.js', import.meta.url)), run.cancelledSetup]);
            if (run.cancelled) return false;
            run.node = new AudioWorkletNode(run.context, 'gavin-sync-voice', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
            run.node.onprocessorerror = interrupted;
            run.node.port.onmessage = ({ data }) => {
                if (run.cancelled) return;
                if (data?.type === 'samples') {
                    const samples = data.samples.subarray(0, SAMPLE_RATE * 60 - run.sampleCount);
                    run.chunks.push(samples);
                    run.sampleCount += samples.length;
                } else if (data?.type === 'stopped' || data?.type === 'limit') {
                    this.finish(run);
                }
            };
            run.source = run.context.createMediaStreamSource(run.stream);
            run.source.connect(run.node);
            run.node.connect(run.context.destination);
            run.context.onstatechange = () => {
                if (run.state === 'recording' && run.context.state !== 'running') interrupted();
            };
            run.state = 'recording';
            run.startedAt = performance.now();
            this.onTime(0);
            run.tick = setInterval(() => this.onTime(Math.min(MAX_DURATION_MS, performance.now() - run.startedAt)), 100);
            run.limit = setTimeout(() => this.stop(), MAX_DURATION_MS);
            return true;
        } catch (error) {
            if (!run.cancelled) await this.fail(run, error);
            return false;
        }
    }

    stop() {
        const run = this.run;
        if (!run) return Promise.resolve(null);
        if (run.state === 'starting') return this.cancel().then(() => null);
        if (run.result) return run.result;
        run.state = 'stopping';
        clearInterval(run.tick);
        clearTimeout(run.limit);
        run.result = new Promise(resolve => { run.resolve = resolve; });
        run.listeners.forEach(remove => remove());
        run.stream.getTracks().forEach(track => track.stop());
        run.flushTimeout = setTimeout(() => this.fail(run, new DOMException('Audio processing stopped responding', 'NotReadableError')), 2000);
        run.node.port.postMessage({ type: 'stop' });
        return run.result;
    }

    async finish(run) {
        if (run.cancelled || run.finishing || this.run !== run) return;
        run.finishing = true;
        run.state = 'stopping';
        run.result ||= new Promise(resolve => { run.resolve = resolve; });
        if (!run.sampleCount) {
            await this.cleanup(run);
            run.resolve(null);
            if (!run.cancelled) this.onError(new DOMException('No audio was captured', 'NotReadableError'));
            return;
        }
        const durationMs = Math.max(1, Math.round(run.sampleCount / SAMPLE_RATE * 1000));
        const buffer = new ArrayBuffer(44 + run.sampleCount * 2);
        const view = new DataView(buffer);
        const text = (offset, value) => { for (let index = 0; index < value.length; index++) view.setUint8(offset + index, value.charCodeAt(index)); };
        text(0, 'RIFF');
        view.setUint32(4, buffer.byteLength - 8, true);
        text(8, 'WAVEfmt ');
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true);
        view.setUint16(22, 1, true);
        view.setUint32(24, SAMPLE_RATE, true);
        view.setUint32(28, SAMPLE_RATE * 2, true);
        view.setUint16(32, 2, true);
        view.setUint16(34, 16, true);
        text(36, 'data');
        view.setUint32(40, run.sampleCount * 2, true);
        let offset = 44;
        for (const chunk of run.chunks) for (const value of chunk) {
            const sample = Math.max(-1, Math.min(1, value));
            view.setInt16(offset, sample < 0 ? sample * 32768 : sample * 32767, true);
            offset += 2;
        }
        const result = { file: new File([buffer], `voice-${Date.now()}.wav`, { type: 'audio/wav' }), durationMs };
        await this.cleanup(run);
        if (!run.cancelled) { this.onTime(durationMs); this.onStop(result); run.resolve?.(result); }
    }

    async fail(run, error) {
        if (run.cancelled || run.finishing || this.run !== run) return;
        run.cancelled = true;
        run.cancelSetup();
        await this.cleanup(run);
        run.resolve?.(null);
        if (!run.silent) this.onError(error);
    }

    cleanup(run) {
        run.cleanup ||= (async () => {
            clearInterval(run.tick);
            clearTimeout(run.limit);
            clearTimeout(run.flushTimeout);
            run.listeners.forEach(remove => remove());
            if (run.node) { run.node.port.onmessage = null; run.node.onprocessorerror = null; run.node.port.close(); run.node.disconnect(); }
            run.source?.disconnect();
            run.stream?.getTracks().forEach(track => track.stop());
            run.chunks.length = 0;
            if (run.context) {
                run.context.onstatechange = null;
                await run.context.close().catch(() => {});
            }
            if (this.run === run) this.run = null;
        })();
        return run.cleanup;
    }

    async cancel() {
        const run = this.run;
        if (!run) return;
        run.cancelled = true;
        run.silent = true;
        run.cancelSetup();
        await this.cleanup(run);
        run.resolve?.(null);
    }

    async dispose() {
        this.disposed = true;
        await this.cancel();
    }
}
