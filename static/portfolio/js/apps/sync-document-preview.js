import mammoth from 'mammoth/mammoth.browser';
import DOMPurify from 'dompurify';
import * as XLSX from 'xlsx';

export async function renderDocumentPreview({ container, url, kind, signal, translate }) {
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error('Document preview could not be loaded');
    const root = document.createElement('section');
    let disposed = false;
    const cleanup = () => { disposed = true; root.remove(); };

    if (kind === 'text') {
        const text = await response.text();
        if (signal.aborted) return cleanup;
        root.className = 'sync-document-text';
        const pre = document.createElement('pre');
        pre.textContent = text;
        root.append(pre);
    } else if (kind === 'word') {
        const arrayBuffer = await response.arrayBuffer();
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
        if (!root.textContent.trim() && !root.querySelector('img')) root.textContent = translate('syncPreviewDocumentEmpty');
    } else if (kind === 'spreadsheet') {
        const arrayBuffer = await response.arrayBuffer();
        if (signal.aborted) return cleanup;
        const workbook = XLSX.read(arrayBuffer, {
            type: 'array', sheetRows: 1000, cellFormula: false, cellHTML: false, bookVBA: false, raw: true, codepage: 65001
        });
        if (signal.aborted) return cleanup;
        root.className = 'sync-document-workbook';
        const tabs = document.createElement('nav');
        tabs.className = 'sync-document-tabs';
        tabs.setAttribute('aria-label', translate('syncPreviewSheets'));
        const limit = document.createElement('p');
        limit.className = 'sync-document-limit';
        limit.textContent = translate('syncPreviewSheetLimit', { rows: 1000, columns: 50 });
        const sheetContainer = document.createElement('div');
        sheetContainer.className = 'sync-document-sheet';
        sheetContainer.tabIndex = 0;
        const showSheet = (name) => {
            if (disposed || signal.aborted) return;
            for (const button of tabs.children) button.setAttribute('aria-pressed', String(button.textContent === name));
            sheetContainer.setAttribute('aria-label', translate('syncPreviewSheet', { name }));
            sheetContainer.replaceChildren();
            const sheet = workbook.Sheets[name];
            const fullRange = sheet['!fullref'] || sheet['!ref'];
            limit.hidden = true;
            if (!fullRange) {
                sheetContainer.textContent = translate('syncPreviewSheetEmpty');
                return;
            }
            const range = XLSX.utils.decode_range(fullRange);
            limit.hidden = range.e.r < 1000 && range.e.c < 50;
            const table = document.createElement('table');
            table.className = 'sync-document-table';
            const head = document.createElement('thead');
            const headings = document.createElement('tr');
            headings.append(document.createElement('th'));
            for (let column = 0; column <= Math.min(range.e.c, 49); column++) {
                const th = document.createElement('th');
                th.scope = 'col';
                th.textContent = XLSX.utils.encode_col(column);
                headings.append(th);
            }
            head.append(headings);
            const body = document.createElement('tbody');
            for (let row = 0; row <= Math.min(range.e.r, 999); row++) {
                const tr = document.createElement('tr');
                const heading = document.createElement('th');
                heading.scope = 'row';
                heading.textContent = String(row + 1);
                tr.append(heading);
                for (let column = 0; column <= Math.min(range.e.c, 49); column++) {
                    const td = document.createElement('td');
                    const cell = sheet[XLSX.utils.encode_cell({ r: row, c: column })];
                    td.textContent = cell ? XLSX.utils.format_cell(cell) : '';
                    tr.append(td);
                }
                body.append(tr);
            }
            table.append(head, body);
            sheetContainer.append(table);
            sheetContainer.scrollTop = 0;
            sheetContainer.scrollLeft = 0;
        };
        for (const name of workbook.SheetNames) {
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = name;
            button.addEventListener('click', () => showSheet(name), { signal });
            tabs.append(button);
        }
        root.append(tabs, limit, sheetContainer);
        if (workbook.SheetNames.length) showSheet(workbook.SheetNames[0]);
        else sheetContainer.textContent = translate('syncPreviewSheetEmpty');
    }

    if (!signal.aborted) container.replaceChildren(root);
    return cleanup;
}
