import { decodeText } from './sync-text.js';

export async function renderDocumentPreview({ container, url, name, kind, signal, translate }) {
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error('Document preview could not be loaded');
    const root = document.createElement('section');
    let disposed = false;
    let worker;
    let resizeObserver;
    let frame;
    let refreshLanguage = () => {};
    const pending = new Map();
    const cleanup = () => {
        if (disposed) return;
        disposed = true;
        worker?.terminate();
        resizeObserver?.disconnect();
        cancelAnimationFrame(frame);
        window.removeEventListener('portfolio-language-change', onLanguageChange);
        signal.removeEventListener('abort', cleanup);
        for (const request of pending.values()) request.reject(new DOMException('Preview closed', 'AbortError'));
        pending.clear();
        root.remove();
    };
    const onLanguageChange = () => refreshLanguage();
    signal.addEventListener('abort', cleanup, { once: true });
    window.addEventListener('portfolio-language-change', onLanguageChange);
    if (signal.aborted) { cleanup(); return cleanup; }

    try {
        if (kind === 'text') {
            const text = decodeText(await response.arrayBuffer());
            if (signal.aborted) return cleanup;
            root.className = 'sync-document-text';
            const pre = document.createElement('pre');
            pre.textContent = text;
            root.append(pre);
        } else if (kind === 'word') {
            const arrayBuffer = await response.arrayBuffer();
            if (signal.aborted) return cleanup;
            worker = new Worker(new URL('./sync-word-worker.js', import.meta.url), { type: 'module', name: 'word-preview' });
            let timeout;
            const conversion = new Promise((resolve, reject) => {
                pending.set(1, { reject });
                timeout = setTimeout(() => { worker.terminate(); reject(new Error('Word preview timed out')); }, 15000);
                worker.onmessage = ({ data }) => data.error ? reject(new Error(data.error)) : resolve(data.chunks);
                worker.onerror = () => reject(new Error('Word preview could not be loaded'));
                worker.postMessage(arrayBuffer, [arrayBuffer]);
            }).finally(() => { clearTimeout(timeout); pending.delete(1); worker.terminate(); });
            const [chunks, { default: DOMPurify }] = await Promise.all([
                conversion, import(/* webpackChunkName: "sync-word" */ 'dompurify')
            ]);
            if (signal.aborted) return cleanup;
            root.className = 'sync-document-word';
            container.replaceChildren(root);
            let sliceStarted = performance.now();
            for (const chunk of chunks) {
                signal.throwIfAborted();
                root.append(DOMPurify.sanitize(chunk, {
                    ALLOWED_TAGS: ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'strong', 'em', 'b', 'i', 'u', 's', 'br', 'hr', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'sup', 'sub', 'img', 'span'],
                    ALLOWED_ATTR: ['alt', 'src', 'colspan', 'rowspan', 'scope'],
                    ALLOWED_URI_REGEXP: /^data:image\/(?:png|jpeg|gif|webp|bmp);base64,/i,
                    RETURN_DOM_FRAGMENT: true
                }));
                if (performance.now() - sliceStarted >= 8) {
                    await new Promise(resolve => setTimeout(resolve, 0));
                    sliceStarted = performance.now();
                }
            }
            if (!root.textContent.trim() && !root.querySelector('img')) {
                refreshLanguage = () => { root.textContent = translate('syncPreviewDocumentEmpty'); };
            }
        } else if (kind === 'spreadsheet') {
            const source = await response.blob();
            if (signal.aborted) return cleanup;
            let nextId = 0;
            let workbookLoad;
            const stopWorker = error => {
                worker?.terminate();
                worker = null;
                for (const request of pending.values()) request.reject(error);
                pending.clear();
            };
            const request = (data, transfer = []) => new Promise((resolve, reject) => {
                const id = ++nextId;
                const timeout = setTimeout(() => stopWorker(new Error('Spreadsheet preview timed out')), 15000);
                pending.set(id, {
                    resolve: value => { clearTimeout(timeout); resolve(value); },
                    reject: error => { clearTimeout(timeout); reject(error); }
                });
                worker.postMessage({ ...data, id }, transfer);
            });
            const loadWorkbook = () => {
                if (!workbookLoad) workbookLoad = (async () => {
                    const buffer = await source.arrayBuffer();
                    signal.throwIfAborted();
                    worker = new Worker(new URL('./sync-spreadsheet-worker.js', import.meta.url), { type: 'module', name: 'spreadsheet-preview' });
                    worker.onmessage = ({ data }) => {
                        const request = pending.get(data.id);
                        if (!request) return;
                        pending.delete(data.id);
                        if (data.error) request.reject(new Error(data.error));
                        else request.resolve(data.result);
                    };
                    worker.onerror = event => stopWorker(new Error(event.message));
                    return request({ type: 'load', buffer, delimited: /\.(?:csv|tsv)$/i.test(name) }, [buffer]);
                })().finally(() => { workbookLoad = null; });
                return workbookLoad;
            };
            const sheets = await loadWorkbook();
            if (signal.aborted) return cleanup;
            root.className = 'sync-document-workbook';
            const tabs = document.createElement('nav');
            tabs.className = 'sync-document-tabs';
            const limit = document.createElement('p');
            limit.className = 'sync-document-limit';
            const sheetContainer = document.createElement('div');
            sheetContainer.className = 'sync-document-sheet';
            sheetContainer.tabIndex = 0;
            let activeSheet;
            let sheetRequest = 0;
            let sheetState = '';
            let renderRows = () => {};
            const rowHeight = 32;
            refreshLanguage = () => {
                tabs.setAttribute('aria-label', translate('syncPreviewSheets'));
                limit.textContent = translate('syncPreviewSheetLimit', { rows: 1000, columns: 50 });
                sheetContainer.setAttribute('aria-label', activeSheet
                    ? translate('syncPreviewSheet', { name: activeSheet.name })
                    : translate('syncPreviewSheets'));
                if (sheetState) {
                    sheetContainer.querySelector('[data-sheet-notice]').textContent = translate(sheetState);
                    const retry = sheetContainer.querySelector('button');
                    if (retry) retry.textContent = translate('syncPreviewRetry');
                } else if (!activeSheet?.rows) sheetContainer.textContent = translate('syncPreviewSheetEmpty');
            };
            const showSheet = async (sheet) => {
                if (disposed || signal.aborted) return;
                const generation = ++sheetRequest;
                activeSheet = sheet;
                sheetState = 'syncPreviewLoading';
                renderRows = () => {};
                const notice = document.createElement('p');
                notice.dataset.sheetNotice = '';
                sheetContainer.replaceChildren(notice);
                refreshLanguage();
                let data;
                try {
                    if (!worker) await loadWorkbook();
                    if (disposed || signal.aborted || generation !== sheetRequest) return;
                    data = await request({ type: 'sheet', sheet });
                } catch {
                    if (disposed || signal.aborted || generation !== sheetRequest) return;
                    sheetState = 'syncPreviewFailed';
                    const retry = document.createElement('button');
                    retry.type = 'button';
                    retry.addEventListener('click', () => showSheet(sheet), { signal });
                    sheetContainer.replaceChildren(notice, retry);
                    refreshLanguage();
                    return;
                }
                if (disposed || signal.aborted || generation !== sheetRequest) return;
                Object.assign(sheet, data.sheet);
                sheetState = '';
                for (const [index, button] of Array.from(tabs.children).entries()) {
                    button.setAttribute('aria-pressed', String(sheets[index] === sheet));
                }
                limit.hidden = !sheet.limited;
                sheetContainer.replaceChildren();
                sheetContainer.scrollTop = 0;
                sheetContainer.scrollLeft = 0;
                renderRows = () => {};
                if (sheet.rows) {
                    const table = document.createElement('table');
                    table.className = 'sync-document-table';
                    table.style.width = `${44 + sheet.columns * 160}px`;
                    table.setAttribute('aria-rowcount', String(sheet.rows + 1));
                    const head = document.createElement('thead');
                    const headings = document.createElement('tr');
                    headings.append(document.createElement('th'));
                    for (const column of data.columns) {
                        const th = document.createElement('th');
                        th.scope = 'col';
                        th.textContent = column;
                        headings.append(th);
                    }
                    head.append(headings);
                    const body = document.createElement('tbody');
                    let renderedStart = -1;
                    let renderedEnd = -1;
                    renderRows = () => {
                        const start = Math.max(0, Math.floor(sheetContainer.scrollTop / rowHeight) - 4);
                        const end = Math.min(sheet.rows, start + Math.ceil((sheetContainer.clientHeight || 400) / rowHeight) + 9);
                        if (start === renderedStart && end === renderedEnd) return;
                        renderedStart = start;
                        renderedEnd = end;
                        const fragment = document.createDocumentFragment();
                        const spacer = (height) => {
                            const tr = document.createElement('tr');
                            tr.className = 'sync-document-spacer';
                            tr.setAttribute('aria-hidden', 'true');
                            const td = document.createElement('td');
                            td.colSpan = sheet.columns + 1;
                            td.style.height = `${height}px`;
                            tr.append(td);
                            return tr;
                        };
                        if (start) fragment.append(spacer(start * rowHeight));
                        for (let row = start; row < end; row++) {
                            const tr = document.createElement('tr');
                            tr.setAttribute('aria-rowindex', String(row + 2));
                            const heading = document.createElement('th');
                            heading.scope = 'row';
                            heading.textContent = String(row + 1);
                            tr.append(heading);
                            for (const value of data.rows[row]) {
                                const td = document.createElement('td');
                                td.textContent = value;
                                td.title = value;
                                tr.append(td);
                            }
                            fragment.append(tr);
                        }
                        if (end < sheet.rows) fragment.append(spacer((sheet.rows - end) * rowHeight));
                        body.replaceChildren(fragment);
                    };
                    table.append(head, body);
                    sheetContainer.append(table);
                    renderRows();
                }
                refreshLanguage();
            };
            for (const sheet of sheets) {
                const button = document.createElement('button');
                button.type = 'button';
                button.textContent = sheet.name;
                button.addEventListener('click', () => {
                    showSheet(sheet);
                }, { signal });
                tabs.append(button);
            }
            sheetContainer.addEventListener('scroll', () => {
                cancelAnimationFrame(frame);
                frame = requestAnimationFrame(() => renderRows());
            }, { signal, passive: true });
            resizeObserver = new ResizeObserver(() => renderRows());
            resizeObserver.observe(sheetContainer);
            root.append(tabs, limit, sheetContainer);
            if (sheets.length) await showSheet(sheets[0]);
            else limit.hidden = true;
        }

        if (!signal.aborted) {
            refreshLanguage();
            container.replaceChildren(root);
        }
        return cleanup;
    } catch (error) {
        cleanup();
        throw error;
    }
}
