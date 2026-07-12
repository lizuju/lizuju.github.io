import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import Application from '../Application';
import EventEmitter from './EventEmitter';
import Loading from './Loading';

const RESOURCE_TIMEOUT_MS = 30000;

export default class Resources extends EventEmitter {
    sources: Resource[];
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
    timeoutId: number;
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

        this.items = { texture: {}, cubeTexture: {}, gltfModel: {}, audio: {} };
        this.toLoad = this.sources.length;
        this.loaded = 0;
        this.completed = 0;
        this.failed = [];
        this.pending = new Map(this.sources.map((source) => [source.name, source]));
        this.application = new Application();
        this.loading = this.application.loading;

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

        for (const source of this.sources) {
            if (source.type === 'gltfModel') {
                this.loaders.gltfLoader.load(
                    source.path,
                    (file) => this.sourceLoaded(source, file),
                    undefined,
                    (error) => this.sourceFailed(source, error)
                );
            } else if (source.type === 'texture') {
                this.loaders.textureLoader.load(
                    source.path,
                    (file) => {
                        file.encoding = THREE.sRGBEncoding;
                        this.sourceLoaded(source, file);
                    },
                    undefined,
                    (error) => this.sourceFailed(source, error)
                );
            } else if (source.type === 'cubeTexture') {
                this.loaders.cubeTextureLoader.load(
                    source.path,
                    (file) => this.sourceLoaded(source, file),
                    undefined,
                    (error) => this.sourceFailed(source, error)
                );
            } else if (source.type === 'audio') {
                this.loaders.audioLoader.load(
                    source.path,
                    (buffer) => this.sourceLoaded(source, buffer),
                    undefined,
                    (error) => this.sourceFailed(source, error)
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

        window.clearTimeout(this.timeoutId);

        if (this.failed.length === 0) {
            this.trigger('ready');
        } else {
            this.trigger('failed', [this.failed]);
        }
    }
}
