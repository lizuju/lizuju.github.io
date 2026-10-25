const waiting = new Set();
let loading = 0;
const pump = () => {
    while (loading < 3 && waiting.size) {
        const next = waiting.values().next().value;
        waiting.delete(next);
        next();
    }
};

export function createInlineGif({ name, load, onPreview, onLoad, onError, viewport, target, retryLabel }) {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = 'sync-message-gif';
    element.hidden = true;
    const image = document.createElement('img');
    image.alt = name;
    image.decoding = 'async';
    const retry = document.createElement('span');
    retry.hidden = true;
    element.append(image, retry);
    let capability;
    let enabled = false;
    let visible = false;
    let running = false;
    let failed = false;
    let version = 0;
    let finishLoad;
    let observer;
    let renderedHeight = 0;
    let disposed = false;

    const updateRetry = () => {
        retry.textContent = retryLabel();
        element.setAttribute('aria-label', failed ? `${name} · ${retry.textContent}` : name);
    };
    const unload = () => {
        version++;
        waiting.delete(run);
        const height = element.offsetHeight || renderedHeight;
        if (!failed && height) element.style.minHeight = `${height}px`;
        image.onload = null;
        image.onerror = null;
        image.hidden = true;
        image.removeAttribute('src');
        capability?.dispose();
        capability = null;
        finishLoad?.();
        finishLoad = null;
        element.hidden = !failed && !element.style.minHeight;
    };
    const fail = (error) => {
        unload();
        failed = true;
        retry.hidden = false;
        element.hidden = false;
        element.dataset.state = 'failed';
        updateRetry();
        onError?.(error);
    };
    const enqueue = () => {
        if (!enabled || !visible || disposed || running || failed || capability) return;
        waiting.add(run);
        pump();
    };
    const run = async () => {
        if (!enabled || !visible || disposed || failed) return;
        loading++;
        running = true;
        const request = ++version;
        try {
            const opened = await load();
            if (request !== version || !enabled || !visible || disposed) { opened.dispose(); return; }
            capability = opened;
            await new Promise(resolve => {
                finishLoad = resolve;
                image.onload = () => {
                    image.hidden = false;
                    retry.hidden = true;
                    element.hidden = false;
                    element.style.minHeight = '';
                    element.dataset.state = 'loaded';
                    renderedHeight = element.offsetHeight;
                    updateRetry();
                    finishLoad = null;
                    resolve();
                    onLoad?.();
                };
                image.onerror = () => fail(new Error('image_preview_failed'));
                image.src = opened.url;
            });
        } catch (error) {
            if (request === version && enabled && !disposed) fail(error);
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
        } else if (capability) onPreview(element);
    });
    const pause = () => {
        enabled = false;
        visible = false;
        observer?.disconnect();
        observer = null;
        unload();
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
                    else unload();
                }
            }, { root: viewport, rootMargin: '160px 0px' });
            observer.observe(target);
        },
        pause,
        dispose() {
            disposed = true;
            pause();
            element.hidden = true;
        }
    };
}
