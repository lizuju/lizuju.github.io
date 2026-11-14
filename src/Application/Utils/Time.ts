import UIEventBus from '../UI/EventBus';
import EventEmitter from './EventEmitter';

export default class Time extends EventEmitter {
    start: number;
    current: number;
    elapsed: number;
    delta: number;
    animationFrameId: number;
    removeLoadingListener: () => void;
    isPaused: boolean;
    pausedAt: number;
    // While this returns true the loop draws the frame it is on and then stops scheduling
    // frames; wake() starts it again (see MonitorScreen: the room freezes behind a game).
    freezeWhen?: () => boolean;
    isFrozen: boolean;
    frozenAt: number;

    constructor() {
        super();

        // Setup
        this.start = Date.now();
        this.current = this.start;
        this.elapsed = 0;
        this.delta = 16;
        this.isPaused = false;
        this.pausedAt = 0;
        this.isFrozen = false;
        this.frozenAt = 0;

        this.animationFrameId = window.requestAnimationFrame(() => {
            this.tick();
        });

        this.removeLoadingListener = UIEventBus.on('loadingScreenDone', () => {
            this.start = Date.now();
        });
        document.addEventListener('visibilitychange', this.handleVisibilityChange);
    }

    tick() {
        if (this.isPaused || this.isFrozen) return;

        const currentTime = Date.now();
        this.delta = currentTime - this.current;
        this.current = currentTime;
        this.elapsed = this.current - this.start;

        this.trigger('tick');

        if (this.freezeWhen?.()) {
            this.isFrozen = true;
            this.frozenAt = Date.now();
            return;
        }
        this.animationFrameId = window.requestAnimationFrame(() => this.tick());
    }

    // Draws again after a freeze, or redraws once while the freeze still holds (a resize, a camera
    // move). Time spent frozen is skipped, so animations continue where they stopped.
    wake() {
        if (!this.isFrozen || this.isPaused) return;
        this.isFrozen = false;
        const currentTime = Date.now();
        this.start += currentTime - this.frozenAt;
        this.current = currentTime;
        this.delta = 16;
        window.cancelAnimationFrame(this.animationFrameId);
        this.animationFrameId = window.requestAnimationFrame(() => this.tick());
    }

    pause() {
        if (this.isPaused) return;

        // A hidden tab stops either way; resuming draws a frame and freezes again if it should.
        if (this.isFrozen) {
            this.isFrozen = false;
            this.start += Date.now() - this.frozenAt;
        }
        this.isPaused = true;
        this.pausedAt = Date.now();
        window.cancelAnimationFrame(this.animationFrameId);
    }

    resume() {
        if (!this.isPaused || document.hidden) return;

        const currentTime = Date.now();
        this.start += currentTime - this.pausedAt;
        this.current = currentTime;
        this.delta = 16;
        this.isPaused = false;
        this.animationFrameId = window.requestAnimationFrame(() => {
            this.tick();
        });
    }

    handleVisibilityChange = () => {
        if (document.hidden) {
            this.pause();
            return;
        }

        this.resume();
    };

    destroy() {
        window.cancelAnimationFrame(this.animationFrameId);
        this.removeLoadingListener();
        document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    }
}
