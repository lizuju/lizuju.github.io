class SyncVoiceProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();
        this.compressed = options?.processorOptions?.compressed === true;
        this.ratio = sampleRate / 16000;
        this.remaining = this.ratio;
        this.sum = 0;
        this.samples = new Float32Array(2048);
        this.offset = 0;
        this.count = 0;
        this.stopped = false;
        this.port.onmessage = ({ data }) => {
            if (data?.type !== 'stop' || this.stopped) return;
            this.stopped = true;
            this.flush();
            this.port.postMessage({ type: 'stopped', sampleCount: this.count });
        };
    }

    flush() {
        if (!this.offset) return;
        const samples = this.samples.slice(0, this.offset);
        this.port.postMessage({ type: 'samples', samples }, [samples.buffer]);
        this.offset = 0;
    }

    process(inputs, outputs) {
        if (this.stopped) return false;
        const channels = inputs[0];
        if (!channels?.length) return true;
        for (let frame = 0; frame < channels[0].length; frame++) {
            let mono = 0;
            for (const channel of channels) mono += channel[frame];
            mono /= channels.length;
            if (this.compressed) outputs[0][0][frame] = mono;
            let available = 1;
            while (available > 0) {
                const weight = Math.min(available, this.remaining);
                this.sum += mono * weight;
                this.remaining -= weight;
                available -= weight;
                if (this.remaining > 1e-8) continue;
                if (!this.compressed) this.samples[this.offset++] = this.sum / this.ratio;
                this.sum = 0;
                this.remaining = this.ratio;
                this.count++;
                if (this.offset === this.samples.length) this.flush();
                if (this.count === 16000 * 60) {
                    this.stopped = true;
                    this.flush();
                    this.port.postMessage({ type: 'limit', sampleCount: this.count });
                    return false;
                }
            }
        }
        return true;
    }
}

registerProcessor('gavin-sync-voice', SyncVoiceProcessor);
