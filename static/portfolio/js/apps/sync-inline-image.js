export function createInlineGif({ name, load, onPreview, onLoad, onError }) {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = 'sync-message-gif';
    element.hidden = true;
    const image = document.createElement('img');
    image.alt = name;
    image.decoding = 'async';
    element.append(image);
    element.addEventListener('click', () => onPreview(element));
    let capability;
    let pending;
    let disposed = false;

    const dispose = () => {
        disposed = true;
        element.hidden = true;
        image.onload = null;
        image.onerror = null;
        image.removeAttribute('src');
        capability?.dispose();
        capability = null;
    };
    image.onload = () => {
        element.hidden = false;
        onLoad?.();
    };
    image.onerror = () => {
        dispose();
        onError?.(new Error('image_preview_failed'));
    };

    return {
        element,
        start() {
            if (disposed) return Promise.resolve();
            if (!pending) pending = (async () => {
                try {
                    const opened = await load();
                    if (disposed) { opened.dispose(); return; }
                    capability = opened;
                    image.src = opened.url;
                } catch (error) {
                    if (!disposed) { dispose(); onError?.(error); }
                }
            })();
            return pending;
        },
        dispose
    };
}
