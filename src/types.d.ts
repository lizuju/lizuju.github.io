type Resource =
    | TextureResource
    | CubeTextureResource
    | ModelResource
    | AudioResource;

declare interface StyleSheetCSS {
    [key: string]: React.CSSProperties;
}

type TextureResource = {
    name: string;
    type: 'texture';
    path: string;
    stage?: 'critical' | 'deferred';
};

type CubeTextureResource = {
    name: string;
    type: 'cubeTexture';
    path: string[];
    stage?: 'critical' | 'deferred';
};

type ModelResource = {
    name: string;
    type: 'gltfModel';
    path: string;
    stage?: 'critical' | 'deferred';
};

type AudioResource = {
    name: string;
    type: 'audio';
    path: string;
    stage?: 'critical' | 'deferred';
};

type EnclosingPlane = {
    size: THREE.Vector2;
    position: THREE.Vector3;
    rotation: THREE.Euler;
};

type CameraKeyframe = {
    position: THREE.Vector3;
    focalPoint: THREE.Vector3;
};

type LoadedResource =
    | LoadedTexture
    | LoadedCubeTexture
    | LoadedModel
    | LoadedAudio;

type LoadedTexture = THREE.Texture;

type LoadedModel = import('three/examples/jsm/loaders/GLTFLoader').GLTF;

type LoadedCubeTexture = THREE.CubeTexture;

type LoadedAudio = AudioBuffer;

type ResourceType = 'texture' | 'cubeTexture' | 'gltfModel' | 'audio';
