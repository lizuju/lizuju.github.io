import UIEventBus from '../UI/EventBus';
import EventEmitter from './EventEmitter';

export default class Time extends EventEmitter {
    start: number;
    current: number;
    elapsed: number;
    delta: number;
    animationFrameId: number;
    frameTimerId: number | undefined;
    removeLoadingListener: () => void;
    isPaused: boolean;
    pausedAt: number;
    throttleWhen?: () => boolean;

    constructor() {
        super();

        // Setup
        this.start = Date.now();
        this.current = this.start;
        this.elapsed = 0;
        this.delta = 16;
        this.isPaused = false;
        this.pausedAt = 0;

        this.animationFrameId = window.requestAnimationFrame(() => {
            this.tick();
        });

        this.removeLoadingListener = UIEventBus.on('loadingScreenDone', () => {
            this.start = Date.now();
        });
        document.addEventListener('visibilitychange', this.handleVisibilityChange);
    }

    tick() {
        if (this.isPaused) return;

        const currentTime = Date.now();
        if (this.throttleWhen?.() && currentTime - this.current < 100) {
            this.scheduleTick();
            return;
        }

        this.delta = currentTime - this.current;
        this.current = currentTime;
        this.elapsed = this.current - this.start;

        this.trigger('tick');

        this.scheduleTick();
    }

    scheduleTick() {
        if (this.isPaused) return;
        const delay = this.throttleWhen?.()
            ? Math.max(0, 100 - (Date.now() - this.current))
            : 0;
        const requestTick = () => {
            this.frameTimerId = undefined;
            this.animationFrameId = window.requestAnimationFrame(() => this.tick());
        };
        if (delay > 0) this.frameTimerId = window.setTimeout(requestTick, delay);
        else requestTick();
    }

    pause() {
        if (this.isPaused) return;

        this.isPaused = true;
        this.pausedAt = Date.now();
        window.cancelAnimationFrame(this.animationFrameId);
        window.clearTimeout(this.frameTimerId);
        this.frameTimerId = undefined;
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
        window.clearTimeout(this.frameTimerId);
        this.removeLoadingListener();
        document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    }
}
