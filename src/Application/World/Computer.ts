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
        const sourceTexture =
            this.resources.items.texture.computerSetupTexture;
        const sourceImage = sourceTexture.image as HTMLImageElement;
        const canvas = document.createElement('canvas');
        canvas.width = sourceImage.naturalWidth;
        canvas.height = sourceImage.naturalHeight;

        const context = canvas.getContext('2d')!;
        context.drawImage(sourceImage, 0, 0);

        const labelCanvas = document.createElement('canvas');
        labelCanvas.width = 640;
        labelCanvas.height = 420;
        const labelContext = labelCanvas.getContext('2d')!;

        labelContext.fillStyle = '#272727';
        labelContext.beginPath();
        labelContext.moveTo(30, 0);
        labelContext.lineTo(610, 0);
        labelContext.quadraticCurveTo(640, 0, 640, 30);
        labelContext.lineTo(640, 390);
        labelContext.quadraticCurveTo(640, 420, 610, 420);
        labelContext.lineTo(30, 420);
        labelContext.quadraticCurveTo(0, 420, 0, 390);
        labelContext.lineTo(0, 30);
        labelContext.quadraticCurveTo(0, 0, 30, 0);
        labelContext.fill();

        labelContext.fillStyle = '#d8d8d8';
        labelContext.font = '700 italic 44px Arial';
        labelContext.fillText('Gavin 2026 Portfolio', 34, 60);
        labelContext.font = '700 27px Arial';
        labelContext.fillText('gavin inc', 34, 98);

        labelContext.font = '600 21px Arial';
        labelContext.fillText(
            'AI Agent, robotics and computer vision systems.',
            34,
            154
        );
        labelContext.fillText(
            'Designed and built by Li Zuju Gavin. Explore',
            34,
            183
        );
        labelContext.fillText('selected work at lizuju.github.io', 34, 212);

        labelContext.font = '600 20px Arial';
        labelContext.fillText('Model No.', 34, 285);
        labelContext.fillText('GVN-2026', 158, 285);
        labelContext.fillText('Profile', 34, 316);
        labelContext.fillText('github.com/lizuju', 158, 316);

        labelContext.strokeStyle = '#d8d8d8';
        labelContext.lineWidth = 5;
        labelContext.beginPath();
        labelContext.arc(370, 286, 38, 0, Math.PI * 2);
        labelContext.moveTo(332, 286);
        labelContext.lineTo(408, 286);
        labelContext.moveTo(370, 248);
        labelContext.lineTo(370, 324);
        labelContext.ellipse(370, 286, 17, 38, 0, 0, Math.PI * 2);
        labelContext.moveTo(337, 268);
        labelContext.quadraticCurveTo(370, 282, 403, 268);
        labelContext.moveTo(337, 304);
        labelContext.quadraticCurveTo(370, 290, 403, 304);
        labelContext.stroke();

        labelContext.font = '700 italic 38px Arial';
        labelContext.fillText('Gavin', 424, 282);
        labelContext.font = '700 23px Arial';
        labelContext.fillText('gavin inc', 426, 316);

        const barcodeWidths = [
            5, 2, 7, 3, 4, 8, 2, 5, 3, 7, 2, 6, 4, 3, 8, 2, 5, 6, 3,
            7, 2, 4, 8, 3, 5, 2, 7, 4, 6,
        ];
        let barcodeX = 332;
        for (const width of barcodeWidths) {
            labelContext.fillRect(barcodeX, 342, width, 50);
            barcodeX += width + 4;
        }

        labelContext.font = '600 17px Arial';
        labelContext.fillText('Designed for the web · 2026', 34, 385);
        labelContext.fillText('LIZUJU-GAVIN-2026', 332, 412);

        // The same product label is used by the monitor and computer UV islands.
        context.drawImage(labelCanvas, 2774, 3294, 220, 143);
        context.save();
        context.translate(1694, 748);
        context.rotate(-Math.PI / 2);
        context.drawImage(labelCanvas, 0, 0, 215, 141);
        context.restore();

        // Replace the original logo inside the monitor bezel's baked UV island.
        context.drawImage(
            sourceImage,
            830,
            2620,
            400,
            135,
            1280,
            2620,
            400,
            135
        );
        context.save();
        context.translate(1680, 2755);
        context.rotate(Math.PI);
        context.fillStyle = '#30302f';
        context.font = '700 72px Arial';
        context.fillText('Gavin', 58, 70);
        context.font = '700 24px Arial';
        context.fillText('gavin inc', 61, 103);
        context.restore();

        const brandedTexture = new THREE.CanvasTexture(canvas);
        brandedTexture.flipY = false;
        brandedTexture.encoding = THREE.sRGBEncoding;

        this.bakedModel = new BakedModel(
            this.resources.items.gltfModel.computerSetupModel,
            brandedTexture,
            900
        );
    }

    setModel() {
        this.scene.add(this.bakedModel.getModel());
    }
}
