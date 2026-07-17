import * as THREE from 'three';

import Debug from './Utils/Debug';
import Sizes from './Utils/Sizes';
import Time from './Utils/Time';
import Camera from './Camera/Camera';
import Renderer from './Renderer';
import Mouse from './Utils/Mouse';

//@ts-ignore
import World from './World/World';
import Resources from './Utils/Resources';

import sources from './sources';

import Stats from 'stats.js';
import Loading from './Utils/Loading';

import UI from './UI';
import UIEventBus from './UI/EventBus';

let instance: Application | null = null;

export default class Application {
    debug: Debug;
    sizes: Sizes;
    time: Time;
    scene: THREE.Scene;
    cssScene: THREE.Scene;
    overlayScene: THREE.Scene;
    resources: Resources;
    camera: Camera;
    renderer: Renderer;
    world: World;
    mouse: Mouse;
    loading: Loading;
    ui: UI;
    stats: Stats | undefined;
    eventController: AbortController;

    constructor() {
        // Singleton
        if (instance) {
            return instance;
        }

        instance = this;
        this.eventController = new AbortController();

        // Global access
        //@ts-ignore
        // window.Application = this;

        // Setup
        this.debug = new Debug();
        this.sizes = new Sizes();
        this.mouse = new Mouse();
        this.loading = new Loading();
        this.time = new Time();
        this.scene = new THREE.Scene();
        this.cssScene = new THREE.Scene();
        this.overlayScene = new THREE.Scene();
        this.resources = new Resources(sources);
        this.camera = new Camera();
        this.renderer = new Renderer();
        this.camera.createControls();
        this.world = new World();

        this.ui = new UI();

        document.querySelector<HTMLAnchorElement>('.direct-entry')?.addEventListener('click', (event) => {
            if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            this.time.pause();
        }, { signal: this.eventController.signal });
        window.addEventListener('pageshow', () => {
            this.time.resume();
        }, { signal: this.eventController.signal });

        const urlParams = new URLSearchParams(window.location.search);
        if (urlParams.has('debug')) {
            this.stats = new Stats();
            this.stats.showPanel(0);

            document.body.appendChild(this.stats.dom);
        }

        // Resize event
        this.sizes.on('resize', () => {
            this.resize();
        });

        // Time tick event
        this.time.on('tick', () => {
            this.update();
        });
    }

    resize() {
        this.camera.resize();
        this.renderer.resize();
    }

    update() {
        if (this.stats) this.stats.begin();
        this.camera.update();
        this.world.update();
        this.renderer.update();
        if (this.stats) this.stats.end();
    }

    destroy() {
        this.sizes.off('resize');
        this.time.off('tick');
        this.resources.off('ready deferredReady');
        this.resources.destroy();
        this.eventController.abort();
        this.world.destroy();
        this.camera.destroy();
        this.ui.destroy();
        this.time.destroy();
        UIEventBus.clear();

        for (const scene of [this.scene, this.overlayScene, this.cssScene]) {
            scene.traverse((child) => {
                if (child instanceof THREE.Mesh) {
                    child.geometry.dispose();
                    const materials = Array.isArray(child.material)
                        ? child.material
                        : [child.material];
                    for (const material of materials) {
                        for (const key in material) {
                            const value = material[key];
                            if (value && typeof value.dispose === 'function') {
                                value.dispose();
                            }
                        }
                        material.dispose();
                    }
                }
            });
        }

        this.renderer.destroy();
        this.sizes.destroy();
        this.stats?.dom.remove();
        if (this.debug.active) this.debug.ui.destroy();
        instance = null;
    }
}
