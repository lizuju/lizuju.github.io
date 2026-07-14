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
        this.delta = currentTime - this.current;
        this.current = currentTime;
        this.elapsed = this.current - this.start;

        this.trigger('tick');

        this.animationFrameId = window.requestAnimationFrame(() => {
            this.tick();
        });
    }

    handleVisibilityChange = () => {
        if (document.hidden) {
            if (this.isPaused) return;
            this.isPaused = true;
            this.pausedAt = Date.now();
            window.cancelAnimationFrame(this.animationFrameId);
            return;
        }

        if (!this.isPaused) return;

        const currentTime = Date.now();
        this.start += currentTime - this.pausedAt;
        this.current = currentTime;
        this.delta = 16;
        this.isPaused = false;
        this.animationFrameId = window.requestAnimationFrame(() => {
            this.tick();
        });
    };

    destroy() {
        window.cancelAnimationFrame(this.animationFrameId);
        this.removeLoadingListener();
        document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    }
}
