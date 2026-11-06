const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const XLSX = require('xlsx');

test('spreadsheet discovery skips cells and worksheet changes parse only the requested sheet', () => {
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['first'], [123]]), 'First');
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['second'], [456]]), 'Second');
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['third']]), 'Third');
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['fourth']]), 'Fourth');
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(Array.from({ length: 100 }, () => ['x'.repeat(20000)])), 'Bulky');
    const buffer = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
    const reads = [];
    let response;
    const context = vm.createContext({
        XLSX: { ...XLSX, read(input, options) {
            const result = XLSX.read(input, options);
            reads.push({ options, parsed: Object.keys(result.Sheets || {}) });
            return result;
        } },
        self: { postMessage(value) { response = JSON.parse(JSON.stringify(value)); } }
    });
    const source = readFileSync(require.resolve('../../static/portfolio/js/apps/sync-spreadsheet-worker.js'), 'utf8').replace(/^import .*;\n/gm, '');
    vm.runInContext(source, context);
    const send = data => { context.self.onmessage({ data }); assert.equal(response.error, undefined); return response.result; };
    assert.deepEqual(send({ type: 'load', id: 1, buffer }), ['First', 'Second', 'Third', 'Fourth', 'Bulky'].map(name => ({ name })));
    assert.deepEqual(reads[0].parsed, []);
    assert.equal(send({ type: 'sheet', id: 2, sheet: { name: 'First' } }).rows[1][0], '123');
    assert.deepEqual(reads[1].parsed, ['First']);
    assert.equal(send({ type: 'sheet', id: 3, sheet: { name: 'Second' } }).rows[1][0], '456');
    assert.deepEqual(reads[2].parsed, ['Second']);
    send({ type: 'sheet', id: 4, sheet: { name: 'Second' } });
    assert.equal(reads.length, 3);
    assert.equal(send({ type: 'sheet', id: 5, sheet: { name: 'First' } }).rows[1][0], '123');
    assert.equal(reads.length, 3, 'returning to a recent sheet reuses its formatted cells');
    send({ type: 'sheet', id: 6, sheet: { name: 'Third' } });
    send({ type: 'sheet', id: 7, sheet: { name: 'Fourth' } });
    send({ type: 'sheet', id: 8, sheet: { name: 'First' } });
    assert.equal(reads.length, 5, 'recent access keeps First in the three-sheet cache');
    send({ type: 'sheet', id: 9, sheet: { name: 'Second' } });
    assert.equal(reads.length, 6, 'the least recently used sheet is parsed again');
    for (let id = 10; id <= 11; id++) {
        assert.equal(send({ type: 'sheet', id, sheet: { name: 'Bulky' } }).rows.length, 100);
    }
    assert.equal(reads.length, 8, 'oversized formatted sheets are not retained in the cache');
    send({ type: 'sheet', id: 12, sheet: { name: 'First' } });
    assert.equal(reads.length, 8, 'an oversized sheet does not evict recent small sheets');
    send({ type: 'load', id: 13, buffer });
    send({ type: 'sheet', id: 14, sheet: { name: 'First' } });
    assert.equal(reads.length, 10, 'loading a new workbook clears the cache');
});
