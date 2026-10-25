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
            const [{ default: mammoth }, { default: DOMPurify }] = await Promise.all([
                import(/* webpackChunkName: "sync-word" */ 'mammoth/mammoth.browser'),
                import(/* webpackChunkName: "sync-word" */ 'dompurify')
            ]);
            if (signal.aborted) return cleanup;
            const result = await mammoth.convertToHtml({ arrayBuffer }, { externalFileAccess: false });
            if (signal.aborted) return cleanup;
            root.className = 'sync-document-word';
            root.append(DOMPurify.sanitize(result.value, {
                ALLOWED_TAGS: ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'strong', 'em', 'b', 'i', 'u', 's', 'br', 'hr', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'sup', 'sub', 'img', 'span'],
                ALLOWED_ATTR: ['alt', 'src', 'colspan', 'rowspan', 'scope'],
                ALLOWED_URI_REGEXP: /^data:image\/(?:png|jpeg|gif|webp|bmp);base64,/i,
                RETURN_DOM_FRAGMENT: true
            }));
            if (!root.textContent.trim() && !root.querySelector('img')) {
                refreshLanguage = () => { root.textContent = translate('syncPreviewDocumentEmpty'); };
            }
        } else if (kind === 'spreadsheet') {
            const buffer = await response.arrayBuffer();
            if (signal.aborted) return cleanup;
            worker = new Worker(new URL('./sync-spreadsheet-worker.js', import.meta.url), { type: 'module', name: 'spreadsheet-preview' });
            let nextId = 0;
            const request = (data, transfer = []) => new Promise((resolve, reject) => {
                const id = ++nextId;
                pending.set(id, { resolve, reject });
                worker.postMessage({ ...data, id }, transfer);
            });
            worker.onmessage = ({ data }) => {
                const request = pending.get(data.id);
                if (!request) return;
                pending.delete(data.id);
                if (data.error) request.reject(new Error(data.error));
                else request.resolve(data.result);
            };
            worker.onerror = (event) => {
                for (const request of pending.values()) request.reject(new Error(event.message));
                pending.clear();
            };
            const sheets = await request({ type: 'load', buffer, delimited: /\.(?:csv|tsv)$/i.test(name) }, [buffer]);
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
            let renderRows = () => {};
            const rowHeight = 32;
            refreshLanguage = () => {
                tabs.setAttribute('aria-label', translate('syncPreviewSheets'));
                limit.textContent = translate('syncPreviewSheetLimit', { rows: 1000, columns: 50 });
                sheetContainer.setAttribute('aria-label', activeSheet
                    ? translate('syncPreviewSheet', { name: activeSheet.name })
                    : translate('syncPreviewSheets'));
                if (!activeSheet?.rows) sheetContainer.textContent = translate('syncPreviewSheetEmpty');
            };
            const showSheet = async (sheet) => {
                if (disposed || signal.aborted) return;
                const generation = ++sheetRequest;
                const data = await request({ type: 'sheet', sheet });
                if (disposed || signal.aborted || generation !== sheetRequest) return;
                activeSheet = sheet;
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
                    showSheet(sheet).catch(() => {
                        if (!disposed) sheetContainer.textContent = translate('syncPreviewFailed');
                    });
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
