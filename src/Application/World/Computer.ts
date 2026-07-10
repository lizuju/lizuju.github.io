import * as THREE from 'three';
import Application from '../Application';
import BakedModel from '../Utils/BakedModel';
import Resources from '../Utils/Resources';

export default class Computer {
    application: Application;
    scene: THREE.Scene;
    resources: Resources;
    bakedModel: BakedModel;

    constructor() {
        this.application = new Application();
        this.scene = this.application.scene;
        this.resources = this.application.resources;

        this.bakeModel();
        this.setModel();
    }

    bakeModel() {
        this.bakedModel = new BakedModel(
            this.resources.items.gltfModel.computerSetupModel,
            this.resources.items.texture.computerSetupTexture,
            900
        );
    }

    setModel() {
        this.scene.add(this.bakedModel.getModel());

        const canvas = document.createElement('canvas');
        canvas.width = 512;
        canvas.height = 128;
        const context = canvas.getContext('2d');
        if (!context) return;

        context.fillStyle = '#969495';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.fillStyle = '#30302f';
        context.font = '700 72px Arial';
        context.fillText('GAVIN', 42, 92);

        const brandPlate = new THREE.Mesh(
            new THREE.PlaneGeometry(360, 100),
            new THREE.MeshBasicMaterial({
                map: new THREE.CanvasTexture(canvas),
                side: THREE.DoubleSide,
                depthTest: false,
            })
        );
        brandPlate.position.set(-570, 380, 500);
        brandPlate.rotation.x = -3 * THREE.MathUtils.DEG2RAD;
        brandPlate.renderOrder = 10;
        this.scene.add(brandPlate);
    }
}
