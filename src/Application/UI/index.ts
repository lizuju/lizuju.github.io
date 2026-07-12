import { createUI, createVolumeUI, destroyUI } from './App';

export default class UI {
    constructor() {
        createUI();
        createVolumeUI();
    }

    destroy() {
        destroyUI();
    }
}
