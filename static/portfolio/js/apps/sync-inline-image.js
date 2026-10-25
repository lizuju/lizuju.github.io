const waiting = new Set();
let loading = 0;
const pump = () => {
    while (loading < 3 && waiting.size) {
        const next = waiting.values().next().value;
        waiting.delete(next);
        next();
    }
};

export function createInlineImage({ name, resource, onPreview, onLoad, onError, viewport, retryLabel }) {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = 'sync-message-image';
    element.dataset.state = 'loading';
    element.style.aspectRatio = '4 / 3';
    const image = document.createElement('img');
    image.alt = name;
    image.decoding = 'async';
    image.hidden = true;
    const retry = document.createElement('span');
    retry.hidden = true;
    element.append(image, retry);
    let lease;
    let controller;
    let poster;
    let animated;
    let enabled = false;
    let visible = false;
    let running = false;
    let failed = false;
    let version = 0;
    let finishLoad;
    let observer;
    let disposed = false;

    const updateRetry = () => {
        retry.textContent = retryLabel();
        element.setAttribute('aria-label', failed ? `${name} · ${retry.textContent}` : name);
    };
    const releaseFull = () => {
        image.onload = null;
        image.onerror = null;
        controller?.abort();
        controller = null;
        lease?.release();
        lease = null;
        finishLoad?.();
        finishLoad = null;
    };
    const showPoster = () => {
        version++;
        releaseFull();
        image.src = poster;
        image.hidden = false;
    };
    const fail = error => {
        version++;
        releaseFull();
        resource.clear();
        if (poster) { image.src = poster; image.hidden = false; }
        else { image.removeAttribute('src'); image.hidden = true; }
        failed = true;
        retry.hidden = false;
        element.hidden = false;
        element.dataset.state = 'failed';
        updateRetry();
        onError?.(error);
    };
    const enqueue = () => {
        if (!enabled || !visible || disposed || running || failed || lease || (poster && !animated)) return;
        waiting.add(run);
        pump();
    };
    const run = async () => {
        if (!enabled || !visible || disposed || failed) return;
        loading++;
        running = true;
        const request = ++version;
        controller = new AbortController();
        try {
            const opened = await resource.acquire({ signal: controller.signal });
            if (request !== version || !enabled || disposed) { opened.release(); return; }
            lease = opened;
            animated = opened.animated;
            await new Promise(resolve => {
                finishLoad = resolve;
                image.onload = async () => {
                    image.onload = null;
                    element.style.aspectRatio = `${image.naturalWidth} / ${image.naturalHeight}`;
                    if (!poster) {
                        const canvas = document.createElement('canvas');
                        const scale = Math.min(1, 260 / image.naturalWidth, 200 / image.naturalHeight);
                        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
                        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
                        canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
                        const blob = await new Promise(done => canvas.toBlob(done, 'image/webp', 0.8));
                        if (request !== version || !enabled || disposed) { resolve(); return; }
                        if (!blob) { fail(new Error('image_preview_failed')); return; }
                        poster = URL.createObjectURL(blob);
                    }
                    if (request !== version || !enabled || disposed) { resolve(); return; }
                    image.hidden = false;
                    retry.hidden = true;
                    element.hidden = false;
                    element.dataset.state = 'loaded';
                    updateRetry();
                    if (!animated || !visible) showPoster();
                    else { image.onerror = null; finishLoad = null; resolve(); }
                    onLoad?.();
                };
                image.onerror = () => fail(new Error('image_preview_failed'));
                image.src = opened.url;
            });
        } catch (error) {
            if (request === version && enabled && !disposed && error.name !== 'AbortError') fail(error);
        } finally {
            running = false;
            loading--;
            enqueue();
            pump();
        }
    };
    element.addEventListener('click', () => {
        if (failed) {
            failed = false;
            retry.hidden = true;
            element.dataset.state = 'loading';
            enqueue();
        } else onPreview(element);
    });
    const pause = () => {
        enabled = false;
        visible = false;
        observer?.disconnect();
        observer = null;
        version++;
        waiting.delete(run);
        releaseFull();
        image.hidden = true;
        image.removeAttribute('src');
        if (!failed) element.dataset.state = 'loading';
        if (poster) URL.revokeObjectURL(poster);
        poster = null;
    };

    return {
        element,
        start() {
            if (disposed) return;
            updateRetry();
            if (enabled) return;
            enabled = true;
            observer = new IntersectionObserver(entries => {
                for (const entry of entries) {
                    visible = entry.isIntersecting;
                    if (visible) enqueue();
                    else {
                        waiting.delete(run);
                        if (poster && (lease || controller)) showPoster();
                    }
                }
            }, { root: viewport, rootMargin: '160px 0px' });
            observer.observe(element);
        },
        pause,
        dispose() {
            disposed = true;
            pause();
            element.hidden = true;
        }
    };
}
