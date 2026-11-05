import * as XLSX from 'xlsx';
import { decodeText } from './sync-text.js';

let input;
let options;
let current;

self.onmessage = ({ data }) => {
    try {
        if (data.type === 'load') {
            input = data.delimited ? decodeText(data.buffer) : data.buffer;
            options = { type: data.delimited ? 'string' : 'array', sheetRows: 1000, cellFormula: false, cellHTML: false, bookVBA: false, raw: true };
            current = null;
            const workbook = XLSX.read(input, { ...options, bookSheets: true });
            const sheets = workbook.SheetNames.map(name => ({ name }));
            self.postMessage({ id: data.id, result: sheets });
        } else {
            if (current?.sheet.name === data.sheet.name) {
                self.postMessage({ id: data.id, result: current });
                return;
            }
            current = null;
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
            const rows = Array.from({ length: summary.rows }, (_, row) =>
                Array.from({ length: summary.columns }, (_, column) => {
                    const cell = sheet[XLSX.utils.encode_cell({ r: row, c: column })];
                    return cell ? XLSX.utils.format_cell(cell) : '';
                })
            );
            const columns = Array.from({ length: summary.columns }, (_, column) => XLSX.utils.encode_col(column));
            current = { rows, columns, sheet: summary };
            self.postMessage({ id: data.id, result: current });
        }
    } catch (error) {
        self.postMessage({ id: data.id, error: error.message });
    }
};
