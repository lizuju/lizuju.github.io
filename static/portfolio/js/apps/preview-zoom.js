export class PreviewZoom {
    constructor({ toolbar, onChange }) {
        this.value = 1;
        this.onChange = onChange;
        this.zoomOut = toolbar.querySelector('[data-preview-zoom-out]');
        this.zoomIn = toolbar.querySelector('[data-preview-zoom-in]');
        this.label = toolbar.querySelector('[data-preview-zoom-value]');
        this.zoomOut.addEventListener('click', () => this.set(this.value - 0.25));
        this.zoomIn.addEventListener('click', () => this.set(this.value + 0.25));
        toolbar.querySelector('[data-preview-zoom-fit]').addEventListener('click', () => this.reset());
        this.update();
    }

    update() {
        this.label.textContent = `${Math.round(this.value * 100)}%`;
        this.zoomOut.disabled = this.value <= 0.5;
        this.zoomIn.disabled = this.value >= 3;
    }

    set(value) {
        this.value = Math.max(0.5, Math.min(3, value));
        this.update();
        this.onChange(this.value);
    }

    reset() {
        this.set(1);
    }
}
