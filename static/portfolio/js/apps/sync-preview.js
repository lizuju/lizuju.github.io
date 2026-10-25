import { PreviewZoom } from './preview-zoom.js';
import { createImageResource } from './sync-image-resource.js';

(() => {
    const desktopApi = window.GavinDesktop;

    desktopApi.apps.syncPreview = (manager) => {
        const app = document.querySelector('[data-sync-preview-window]');
        const find = (name) => app.querySelector(`[data-sync-preview-${name}]`);
        const body = find('body');
        let current = null;
        const zoom = new PreviewZoom({ toolbar: find('toolbar'), onChange: () => layout() });
        let resizeTimer;
        const translate = (key, values = {}) => Object.entries(values).reduce((text, [key, value]) => text.replace(`{${key}}`, value), desktopApi.t()[key]);
        const setStatus = (key, values = {}) => {
            find('status').dataset.i18n = '';
            find('status').textContent = translate(key, values);
            if (current) current.status = { key, values };
        };
        const dispose = () => {
            if (!current) return;
            const previous = current;
            current = null;
            previous.controller.abort();
            previous.observer?.disconnect();
            previous.mediaObserver?.disconnect();
            previous.pages?.forEach((page) => {
                page.render?.cancel();
                if (page.canvas) { page.canvas.width = 0; page.canvas.height = 0; }
            });
            previous.pdfTask?.destroy().catch(() => {});
            previous.cleanup?.();
            previous.release?.();
            previous.imageLease?.release();
            previous.ownedImageResource?.dispose();
            body.querySelector('img')?.removeAttribute('src');
            const video = body.querySelector('video');
            if (video) { video.pause(); video.removeAttribute('src'); video.load(); }
            body.replaceChildren();
        };
        const entry = manager.registerWindow({
            id: 'sync-preview', element: app, task: document.querySelector('[data-sync-preview-task]'),
            titlebar: find('drag'), resizeHandle: find('resize'), actionAttribute: 'data-sync-preview-action',
            minWidth: 280, minHeight: 200,
            focusTarget: () => body,
            show: () => manager.showWindow(app, entry.task, { revealTask: true }),
            hide: (state) => {
                body.querySelector('video')?.pause();
                if (state === 'is-closed') dispose();
                manager.hideWindow(app, entry.task, state, { hideTask: state === 'is-closed' });
            }
        });
        const fail = (state) => {
            if (current !== state || state.controller.signal.aborted) return;
            state.failed = true;
            setStatus('syncPreviewFailed');
        };
        const renderPage = async (state, item) => {
            if (current !== state || !item.visible || item.canvas || item.loading || item.failed) return;
            item.loading = true;
            let canvas;
            try {
                const page = await state.pdf.getPage(item.index);
                if (current !== state || !item.visible) return;
                item.page = page;
                const original = page.getViewport({ scale: 1 });
                item.sheet.style.aspectRatio = `${original.width} / ${original.height}`;
                const viewport = page.getViewport({ scale: state.width / original.width });
                const ratio = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(4000000 / (viewport.width * viewport.height)));
                canvas = document.createElement('canvas');
                canvas.width = Math.ceil(viewport.width * ratio);
                canvas.height = Math.ceil(viewport.height * ratio);
                canvas.setAttribute('aria-label', `${item.index} / ${state.pdf.numPages}`);
                item.canvas = canvas;
                item.sheet.append(canvas);
                item.render = page.render({
                    canvasContext: canvas.getContext('2d'), viewport,
                    transform: [ratio, 0, 0, ratio, 0, 0]
                });
                await item.render.promise;
            } catch (error) {
                if (error.name !== 'RenderingCancelledException') { item.failed = true; fail(state); }
            } finally {
                item.loading = false;
                item.render = null;
                if (!item.visible) item.page?.cleanup();
                if (current === state && item.visible && !item.canvas) renderPage(state, item);
            }
        };
        const releasePage = (item) => {
            item.render?.cancel();
            if (item.canvas) { item.canvas.remove(); item.canvas.width = 0; item.canvas.height = 0; }
            item.canvas = null;
            if (!item.loading) item.page?.cleanup();
        };
        const layout = () => {
            if (!current) return;
            const width = Math.max(1, body.clientWidth - 24) * zoom.value;
            const image = body.querySelector('img');
            if (image) image.style.width = `${Math.min(width, image.naturalWidth * zoom.value)}px`;
            if (current.pages && current.width !== width) {
                current.width = width;
                body.style.setProperty('--sync-preview-width', `${width}px`);
                current.pages.forEach((item) => { releasePage(item); renderPage(current, item); });
            }
        };
        const loadPdf = async (state) => {
            const pdfjs = await import(/* webpackChunkName: "sync-pdf" */ 'pdfjs-dist/build/pdf.mjs');
            if (current !== state) return;
            pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).href;
            const assets = new URL('assets/pdfjs/', new URL(document.body.dataset.assetRoot || '.', document.baseURI)).href;
            state.pdfTask = pdfjs.getDocument({
                url: state.url, disableAutoFetch: true, disableStream: true, rangeChunkSize: 262144,
                cMapUrl: `${assets}cmaps/`, cMapPacked: true, standardFontDataUrl: `${assets}standard_fonts/`,
                wasmUrl: `${assets}wasm/`, isEvalSupported: false
            });
            state.pdf = await state.pdfTask.promise;
            const first = await state.pdf.getPage(1);
            if (current !== state) return;
            const original = first.getViewport({ scale: 1 });
            state.pages = Array.from({ length: state.pdf.numPages }, (_, index) => {
                const figure = document.createElement('figure');
                figure.className = 'sync-preview-page';
                const sheet = document.createElement('div');
                sheet.className = 'sync-preview-page-sheet';
                sheet.style.aspectRatio = `${original.width} / ${original.height}`;
                const caption = document.createElement('figcaption');
                caption.textContent = `${index + 1} / ${state.pdf.numPages}`;
                figure.append(sheet, caption);
                return { index: index + 1, figure, sheet, visible: false };
            });
            body.replaceChildren(...state.pages.map((item) => item.figure));
            layout();
            const items = new Map(state.pages.map((item) => [item.figure, item]));
            state.observer = new IntersectionObserver((entries) => {
                for (const entry of entries) {
                    const item = items.get(entry.target);
                    item.visible = entry.isIntersecting;
                    if (item.visible) renderPage(state, item);
                    else releasePage(item);
                }
            }, { root: body, rootMargin: '600px 0px' });
            state.pages.forEach((item) => state.observer.observe(item.figure));
            setStatus('syncPreviewPdfPages', { count: state.pdf.numPages });
        };
        const open = async (file) => {
            if (current?.id === file.id && !current.failed) {
                if (file.cleanup !== current.release) file.cleanup?.();
                entry.show();
                return;
            }
            dispose();
            const state = { ...file, release: file.cleanup, cleanup: null, controller: new AbortController() };
            current = state;
            zoom.reset();
            find('title').textContent = file.name;
            document.querySelector('[data-sync-preview-task-title]').textContent = file.name;
            find('toolbar').hidden = !['image', 'heic', 'pdf'].includes(file.kind);
            body.className = 'sync-preview-body';
            body.scrollTop = 0;
            body.scrollLeft = 0;
            setStatus('syncPreviewLoading');
            entry.show();
            layout();
            try {
                if (file.kind === 'pdf') await loadPdf(state);
                else if (['image', 'heic'].includes(file.kind)) {
                    const image = document.createElement('img');
                    image.alt = file.name;
                    body.append(image);
                    const resource = file.imageResource || (state.ownedImageResource = createImageResource({ kind: file.kind, name: file.name, load: async () => ({ url: file.url }) }));
                    state.imageLease = await resource.acquire({ signal: state.controller.signal });
                    if (current !== state) { state.imageLease.release(); return; }
                    image.src = state.imageLease.url;
                    await image.decode();
                    if (current !== state) return;
                    layout();
                    setStatus('syncPreviewImageHint');
                } else if (file.kind === 'video') {
                    const video = document.createElement('video');
                    video.controls = true;
                    video.playsInline = true;
                    video.preload = 'metadata';
                    video.src = file.url;
                    video.addEventListener('loadedmetadata', () => { if (current === state) setStatus('syncPreviewVideoHint'); });
                    video.addEventListener('error', () => fail(state));
                    const pauseHiddenVideo = () => {
                        if (document.hidden || app.closest('[inert], [hidden]')) video.pause();
                    };
                    state.mediaObserver = new MutationObserver(pauseHiddenVideo);
                    for (let ancestor = app; ancestor; ancestor = ancestor.parentElement) {
                        state.mediaObserver.observe(ancestor, { attributes: true, attributeFilter: ['inert', 'hidden'] });
                    }
                    document.addEventListener('visibilitychange', pauseHiddenVideo, { signal: state.controller.signal });
                    video.addEventListener('playing', pauseHiddenVideo);
                    body.append(video);
                } else {
                    const { renderDocumentPreview } = await import(/* webpackChunkName: "sync-documents" */ './sync-document-preview.js');
                    if (current !== state) return;
                    state.cleanup = await renderDocumentPreview({ container: body, url: file.url, name: file.name, kind: file.kind, signal: state.controller.signal, translate });
                    if (current === state) setStatus('syncPreviewDocumentHint');
                }
            } catch {
                state.imageLease?.release();
                state.imageLease = null;
                (state.imageResource || state.ownedImageResource)?.clear();
                fail(state);
            }
        };
        new ResizeObserver(() => {
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(layout, 120);
        }).observe(body);
        window.addEventListener('portfolio-language-change', () => {
            app.querySelectorAll('[data-i18n-aria]').forEach((element) => element.setAttribute('aria-label', translate(element.dataset.i18nAria)));
            if (current) {
                find('title').textContent = current.name;
                document.querySelector('[data-sync-preview-task-title]').textContent = current.name;
                if (current.status) setStatus(current.status.key, current.status.values);
            }
        });
        manager.onSession({ restore: () => { if (!current) entry.hide('is-closed'); } });
        return {
            open,
            remove: (id) => { if (current?.id === id) entry.hide('is-closed'); },
            close: () => { if (current) entry.hide('is-closed'); }
        };
    };
})();
