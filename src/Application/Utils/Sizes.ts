import EventEmitter from './EventEmitter';

export default class Sizes extends EventEmitter {
    width: number;
    height: number;
    pixelRatio: number;
    resizeHandler: () => void;

    constructor() {
        super();

        // Setup
        this.width = window.innerWidth;
        this.height = window.innerHeight;
        this.pixelRatio = Math.min(window.devicePixelRatio, 2);

        // Resize event
        this.resizeHandler = () => {
            this.width = window.innerWidth;
            this.height = window.innerHeight;
            this.pixelRatio = Math.min(window.devicePixelRatio, 2);

            this.trigger('resize');
        };
        window.addEventListener('resize', this.resizeHandler);
    }

    destroy() {
        window.removeEventListener('resize', this.resizeHandler);
    }
}
