const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const XLSX = require('xlsx');

test('spreadsheet discovery skips cells and worksheet changes parse only the requested sheet', () => {
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['first'], [123]]), 'First');
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['second'], [456]]), 'Second');
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
    assert.deepEqual(send({ type: 'load', id: 1, buffer }), [{ name: 'First' }, { name: 'Second' }]);
    assert.deepEqual(reads[0].parsed, []);
    assert.equal(send({ type: 'sheet', id: 2, sheet: { name: 'First' } }).rows[1][0], '123');
    assert.deepEqual(reads[1].parsed, ['First']);
    assert.equal(send({ type: 'sheet', id: 3, sheet: { name: 'Second' } }).rows[1][0], '456');
    assert.deepEqual(reads[2].parsed, ['Second']);
    send({ type: 'sheet', id: 4, sheet: { name: 'Second' } });
    assert.equal(reads.length, 3);
    assert.equal(send({ type: 'sheet', id: 5, sheet: { name: 'First' } }).rows[1][0], '123');
    assert.equal(reads.length, 4, 'only the current formatted worksheet is retained');
});
