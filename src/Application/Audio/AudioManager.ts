import * as THREE from 'three';
import Application from '../Application';
import { AmbienceAudio, ComputerAudio } from './AudioSources';
import UIEventBus from '../UI/EventBus';
import { getMuteState } from './MuteState';

const DEFAULT_REF_DISTANCE = 10000;
export default class Audio {
    application: Application;
    listener: THREE.AudioListener;
    context: AudioContext;
    loadedAudio: { [key in string]: LoadedAudio };
    audioPool: { [key in string]: THREE.PositionalAudio | THREE.Audio };
    audioSources: {
        computer: ComputerAudio;
        ambience: AmbienceAudio;
    };
    scene: THREE.Scene;
    nextAudioId = 0;

    constructor() {
        this.application = new Application();
        this.listener = new THREE.AudioListener();
        this.context = this.listener.context;
        this.application.camera.instance.add(this.listener);
        this.loadedAudio = this.application.resources.items.audio;
        this.scene = this.application.scene;
        this.audioPool = {};

        this.audioSources = {
            computer: new ComputerAudio(this),
            ambience: new AmbienceAudio(this),
        };

        this.application.resources.on('deferredReady', () => {
            this.audioSources.ambience.start();
        });

        UIEventBus.on('loadingScreenDone', () => {
            if (!getMuteState()) this.syncContextState();
        });

        UIEventBus.on('muteToggle', (mute: boolean) => {
            this.listener.setMasterVolume(mute ? 0 : 1);
            if (mute) {
                this.application.camera.instance.remove(this.listener);
                for (const [key, audio] of Object.entries(this.audioPool)) {
                    if (audio.loop) continue;
                    this.releaseAudio(key);
                }
            } else {
                this.application.camera.instance.add(this.listener);
            }
            this.syncContextState();
        });
        this.listener.setMasterVolume(getMuteState() ? 0 : 1);
        if (getMuteState()) {
            this.application.camera.instance.remove(this.listener);
            this.syncContextState();
        }
    }

    private syncContextState() {
        const transition = getMuteState() ? this.context.suspend() : this.context.resume();
        transition.then(() => {
            if (this.application.eventController.signal.aborted) return;
            // An earlier transition can finish after a newer mute toggle.
            const outOfSync = getMuteState()
                ? this.context.state === 'running'
                : this.context.state === 'suspended';
            if (outOfSync) this.syncContextState();
        }).catch(() => undefined);
    }

    playAudio(
        sourceName: string,
        options: {
            volume?: number;
            randDetuneScale?: number;
            loop?: boolean;
            filter?: {
                type: BiquadFilterType;
                frequency: number;
            };
            position?: THREE.Vector3;
            refDistance?: number;
            pitch?: number;
        } = {}
    ) {
        if (getMuteState()) return '';
        this.syncContextState();

        // Get the audio source
        sourceName = this.getRandomVariant(sourceName);

        // Setup
        const buffer = this.loadedAudio[sourceName];
        if (!sourceName || !buffer) return '';
        const poolKey = `${sourceName}_${this.nextAudioId++}`;

        const audio = options.position
            ? new THREE.PositionalAudio(this.listener)
            : new THREE.Audio(this.listener);

        if (audio instanceof THREE.PositionalAudio && options.position) {
            audio.setRefDistance(options.refDistance || DEFAULT_REF_DISTANCE);
            audio.position.copy(options.position);
            this.scene.add(audio);
        }
        audio.setBuffer(buffer);

        if (options.filter) {
            const ac = audio.context;
            const filter = ac.createBiquadFilter();
            filter.type = options.filter.type; // Low pass filter
            filter.frequency.setValueAtTime(
                options.filter.frequency,
                ac.currentTime
            );
            // filter.frequency.linearRampToValueAtTime(2400, ac.currentTime + 2);

            audio.setFilter(filter);
        }

        // Set options
        audio.setLoop(options.loop ? true : false);
        audio.setVolume(options.volume || 1);

        audio.play();

        // add a filter to the audio

        // Calculate detune
        const detuneAmount =
            (Math.random() * 200 - 100) *
            (options.randDetuneScale ? options.randDetuneScale : 0);

        // Set detune after .play is called
        audio.setDetune(detuneAmount);

        if (options.pitch) {
            audio.setDetune(options.pitch * 100);
        }

        // Add to pool
        if (audio.source) {
            audio.source.onended = () => {
                audio.onEnded();
                this.releaseAudio(poolKey);
            };
            this.audioPool[poolKey] = audio;
        }
        return poolKey;
    }

    private releaseAudio(key: string) {
        const audio = this.audioPool[key];
        delete this.audioPool[key];
        audio.source!.onended = null;
        if (audio.isPlaying) audio.stop();
        audio.disconnect();
        if (audio instanceof THREE.PositionalAudio) audio.panner.disconnect();
        audio.gain.disconnect();
        audio.removeFromParent();
    }

    setAudioFilterFrequency(audio: string, frequency: number) {
        const a = this.audioPool[audio];

        if (a) {
            const ac = a.context;
            const filter = a.getFilter() as BiquadFilterNode;
            // clamp the frequency between 0 and 22500
            const f = Math.max(0, Math.min(22050, frequency));

            filter.frequency.setValueAtTime(f, ac.currentTime);
        }
    }

    setAudioVolume(audio: string, volume: number) {
        const a = this.audioPool[audio];
        if (a) {
            a.setVolume(volume);
        }
    }

    getRandomVariant(sourceName: string) {
        const variants = [];
        for (const key in this.loadedAudio) {
            if (key.includes(sourceName)) {
                variants.push(key);
            }
        }
        return variants[Math.floor(Math.random() * variants.length)];
    }

    update() {
        if (getMuteState()) return;
        for (const key in this.audioSources) {
            const _key = key as keyof typeof this.audioSources;
            this.audioSources[_key].update();
        }
    }

    destroy() {
        for (const key of Object.keys(this.audioPool)) this.releaseAudio(key);
        this.application.camera.instance.remove(this.listener);
        this.context.suspend().catch(() => undefined);
    }
}
