import UIEventBus from '../UI/EventBus';
import EventEmitter from './EventEmitter';

export default class Time extends EventEmitter {
    start: number;
    current: number;
    elapsed: number;
    delta: number;
    animationFrameId: number;
    removeLoadingListener: () => void;

    constructor() {
        super();

        // Setup
        this.start = Date.now();
        this.current = this.start;
        this.elapsed = 0;
        this.delta = 16;

        this.animationFrameId = window.requestAnimationFrame(() => {
            this.tick();
        });

        this.removeLoadingListener = UIEventBus.on('loadingScreenDone', () => {
            this.start = Date.now();
        });
    }

    tick() {
        const currentTime = Date.now();
        this.delta = currentTime - this.current;
        this.current = currentTime;
        this.elapsed = this.current - this.start;

        this.trigger('tick');

        this.animationFrameId = window.requestAnimationFrame(() => {
            this.tick();
        });
    }

    destroy() {
        window.cancelAnimationFrame(this.animationFrameId);
        this.removeLoadingListener();
    }
}
