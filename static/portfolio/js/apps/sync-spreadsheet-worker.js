import * as XLSX from 'xlsx';
import { decodeText } from './sync-text.js';

let input;
let options;
const cachedSheets = new Map();
let cachedBytes = 0;
const CACHE_BYTES = 2 * 1024 * 1024;

self.onmessage = ({ data }) => {
    try {
        if (data.type === 'load') {
            input = data.delimited ? decodeText(data.buffer) : data.buffer;
            options = { type: data.delimited ? 'string' : 'array', sheetRows: 1000, cellFormula: false, cellHTML: false, bookVBA: false, raw: true };
            cachedSheets.clear();
            cachedBytes = 0;
            const workbook = XLSX.read(input, { ...options, bookSheets: true });
            const sheets = workbook.SheetNames.map(name => ({ name }));
            self.postMessage({ id: data.id, result: sheets });
        } else {
            const cached = cachedSheets.get(data.sheet.name);
            if (cached) {
                cachedSheets.delete(data.sheet.name);
                cachedSheets.set(data.sheet.name, cached);
                self.postMessage({ id: data.id, result: cached.result });
                return;
            }
            const workbook = XLSX.read(input, { ...options, sheets: data.sheet.name });
            const sheet = workbook.Sheets[data.sheet.name];
            const reference = sheet['!fullref'] || sheet['!ref'];
            const range = reference && XLSX.utils.decode_range(reference);
            const summary = {
                name: data.sheet.name,
                rows: range ? Math.min(range.e.r + 1, 1000) : 0,
                columns: range ? Math.min(range.e.c + 1, 50) : 0,
                limited: !!range && (range.e.r >= 1000 || range.e.c >= 50)
            };
            let bytes = summary.rows * 32;
            const rows = Array.from({ length: summary.rows }, (_, row) =>
                Array.from({ length: summary.columns }, (_, column) => {
                    const cell = sheet[XLSX.utils.encode_cell({ r: row, c: column })];
                    const value = cell ? XLSX.utils.format_cell(cell) : '';
                    bytes += value.length * 2 + 16;
                    return value;
                })
            );
            const columns = Array.from({ length: summary.columns }, (_, column) => XLSX.utils.encode_col(column));
            const result = { rows, columns, sheet: summary };
            if (bytes <= CACHE_BYTES) {
                while (cachedSheets.size >= 3 || cachedBytes + bytes > CACHE_BYTES) {
                    const oldest = cachedSheets.keys().next().value;
                    cachedBytes -= cachedSheets.get(oldest).bytes;
                    cachedSheets.delete(oldest);
                }
                cachedSheets.set(data.sheet.name, { result, bytes });
                cachedBytes += bytes;
            }
            self.postMessage({ id: data.id, result });
        }
    } catch (error) {
        self.postMessage({ id: data.id, error: error.message });
    }
};
