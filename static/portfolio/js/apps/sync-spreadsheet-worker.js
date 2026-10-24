import * as XLSX from 'xlsx';

let workbook;

self.onmessage = ({ data }) => {
    try {
        if (data.type === 'load') {
            let input = data.buffer;
            if (data.delimited) {
                const bytes = new Uint8Array(data.buffer);
                if (bytes[0] === 0xff && bytes[1] === 0xfe) input = new TextDecoder('utf-16le').decode(bytes);
                else if (bytes[0] === 0xfe && bytes[1] === 0xff) input = new TextDecoder('utf-16be').decode(bytes);
                else {
                    try { input = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
                    catch { input = new TextDecoder('gb18030').decode(bytes); }
                }
            }
            workbook = XLSX.read(input, {
                type: data.delimited ? 'string' : 'array', sheetRows: 1000, cellFormula: false, cellHTML: false, bookVBA: false, raw: true
            });
            const sheets = workbook.SheetNames.map((name) => {
                const sheet = workbook.Sheets[name];
                const reference = sheet['!fullref'] || sheet['!ref'];
                const range = reference && XLSX.utils.decode_range(reference);
                return {
                    name,
                    rows: range ? Math.min(range.e.r + 1, 1000) : 0,
                    columns: range ? Math.min(range.e.c + 1, 50) : 0,
                    limited: !!range && (range.e.r >= 1000 || range.e.c >= 50)
                };
            });
            self.postMessage({ id: data.id, result: sheets });
        } else {
            const sheet = workbook.Sheets[data.sheet.name];
            const rows = Array.from({ length: data.sheet.rows }, (_, row) =>
                Array.from({ length: data.sheet.columns }, (_, column) => {
                    const cell = sheet[XLSX.utils.encode_cell({ r: row, c: column })];
                    return cell ? XLSX.utils.format_cell(cell) : '';
                })
            );
            const columns = Array.from({ length: data.sheet.columns }, (_, column) => XLSX.utils.encode_col(column));
            self.postMessage({ id: data.id, result: { rows, columns } });
        }
    } catch (error) {
        self.postMessage({ id: data.id, error: error.message });
    }
};
