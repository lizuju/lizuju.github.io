import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import Application from '../Application';
import EventEmitter from './EventEmitter';
import Loading from './Loading';
import UIEventBus from '../UI/EventBus';

const RESOURCE_TIMEOUT_MS = 30000;

export default class Resources extends EventEmitter {
    sources: Resource[];
    criticalSources: Resource[];
    deferredSources: Resource[];
    // Not sure about this one
    items: {
        texture: { [name: string]: LoadedTexture };
        cubeTexture: { [name: string]: LoadedCubeTexture };
        gltfModel: { [name: string]: LoadedModel };
        audio: { [name: string]: LoadedAudio };
    };
    toLoad: number;
    loaded: number;
    completed: number;
    failed: Resource[];
    pending: Map<string, Resource>;
    timeoutId: number | undefined;
    deferredPending: Map<string, Resource>;
    deferredFailed: Resource[];
    deferredTimeoutId: number | undefined;
    deferredStarted: boolean;
    removeDeferredLoadingListener: () => void;
    loaders: {
        gltfLoader: GLTFLoader;
        textureLoader: THREE.TextureLoader;
        cubeTextureLoader: THREE.CubeTextureLoader;
        audioLoader: THREE.AudioLoader;
    };
    application: Application;
    loading: Loading;

    constructor(sources: Resource[]) {
        super();

        this.sources = sources;
        this.criticalSources = sources.filter(
            (source) => source.stage !== 'deferred'
        );
        this.deferredSources = sources.filter(
            (source) => source.stage === 'deferred'
        );

        this.items = { texture: {}, cubeTexture: {}, gltfModel: {}, audio: {} };
        this.toLoad = this.criticalSources.length;
        this.loaded = 0;
        this.completed = 0;
        this.failed = [];
        this.pending = new Map(
            this.criticalSources.map((source) => [source.name, source])
        );
        this.deferredPending = new Map();
        this.deferredFailed = [];
        this.deferredStarted = false;
        this.application = new Application();
        this.loading = this.application.loading;

        this.removeDeferredLoadingListener = UIEventBus.on(
            'loadingScreenDone',
            () => this.startDeferredLoading()
        );

        this.setLoaders();
        this.startLoading();
    }

    setLoaders() {
        this.loaders = {
            gltfLoader: new GLTFLoader(),
            textureLoader: new THREE.TextureLoader(),
            cubeTextureLoader: new THREE.CubeTextureLoader(),
            audioLoader: new THREE.AudioLoader(),
        };
    }

    startLoading() {
        this.timeoutId = window.setTimeout(() => {
            for (const source of [...this.pending.values()]) {
                this.sourceFailed(source, new Error('Resource load timed out'));
            }
        }, RESOURCE_TIMEOUT_MS);

        this.loadSources(
            this.criticalSources,
            this.sourceLoaded.bind(this),
            this.sourceFailed.bind(this)
        );
    }

    loadSources(
        sources: Resource[],
        onLoad: (source: Resource, file: LoadedResource) => void,
        onError: (source: Resource, error: unknown) => void
    ) {
        for (const source of sources) {
            if (source.type === 'gltfModel') {
                this.loaders.gltfLoader.load(
                    source.path,
                    (file) => onLoad(source, file),
                    undefined,
                    (error) => onError(source, error)
                );
            } else if (source.type === 'texture') {
                this.loaders.textureLoader.load(
                    source.path,
                    (file) => {
                        file.encoding = THREE.sRGBEncoding;
                        onLoad(source, file);
                    },
                    undefined,
                    (error) => onError(source, error)
                );
            } else if (source.type === 'cubeTexture') {
                this.loaders.cubeTextureLoader.load(
                    source.path,
                    (file) => onLoad(source, file),
                    undefined,
                    (error) => onError(source, error)
                );
            } else if (source.type === 'audio') {
                this.loaders.audioLoader.load(
                    source.path,
                    (buffer) => onLoad(source, buffer),
                    undefined,
                    (error) => onError(source, error)
                );
            }
        }
    }

    sourceLoaded(source: Resource, file: LoadedResource) {
        if (!this.pending.delete(source.name)) return;

        this.items[source.type][source.name] = file;
        this.loaded++;
        this.completed++;

        this.loading.trigger('loadedSource', [
            source.name,
            this.completed,
            this.toLoad,
        ]);

        this.finishLoading();
    }

    sourceFailed(source: Resource, error: unknown) {
        if (!this.pending.delete(source.name)) return;

        this.failed.push(source);
        this.completed++;
        console.warn(`Failed to load resource: ${source.name}`, error);
        this.loading.trigger('failedSource', [
            source.name,
            this.completed,
            this.toLoad,
        ]);

        this.finishLoading();
    }

    finishLoading() {
        if (this.completed !== this.toLoad) return;

        if (this.timeoutId !== undefined) {
            window.clearTimeout(this.timeoutId);
            this.timeoutId = undefined;
        }

        if (this.failed.length === 0) {
            this.trigger('ready');
        } else {
            this.trigger('failed', [this.failed]);
        }
    }

    startDeferredLoading() {
        if (this.deferredStarted) return;
        this.deferredStarted = true;

        if (this.deferredSources.length === 0) {
            this.trigger('deferredReady');
            return;
        }

        this.deferredPending = new Map(
            this.deferredSources.map((source) => [source.name, source])
        );
        this.deferredTimeoutId = window.setTimeout(() => {
            for (const source of [...this.deferredPending.values()]) {
                this.deferredSourceFailed(
                    source,
                    new Error('Deferred resource load timed out')
                );
            }
        }, RESOURCE_TIMEOUT_MS);

        this.loadSources(
            this.deferredSources,
            this.deferredSourceLoaded.bind(this),
            this.deferredSourceFailed.bind(this)
        );
    }

    deferredSourceLoaded(source: Resource, file: LoadedResource) {
        if (!this.deferredPending.delete(source.name)) return;

        this.items[source.type][source.name] = file;
        this.finishDeferredLoading();
    }

    deferredSourceFailed(source: Resource, error: unknown) {
        if (!this.deferredPending.delete(source.name)) return;

        this.deferredFailed.push(source);
        console.warn(`Failed to load deferred resource: ${source.name}`, error);
        this.finishDeferredLoading();
    }

    finishDeferredLoading() {
        if (this.deferredPending.size !== 0) return;

        if (this.deferredTimeoutId !== undefined) {
            window.clearTimeout(this.deferredTimeoutId);
            this.deferredTimeoutId = undefined;
        }

        this.trigger('deferredReady', [this.deferredFailed]);
    }

    destroy() {
        this.removeDeferredLoadingListener();

        if (this.timeoutId !== undefined) {
            window.clearTimeout(this.timeoutId);
            this.timeoutId = undefined;
        }

        if (this.deferredTimeoutId !== undefined) {
            window.clearTimeout(this.deferredTimeoutId);
            this.deferredTimeoutId = undefined;
        }
    }
}
