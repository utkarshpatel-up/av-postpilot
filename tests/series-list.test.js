const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const XLSX = require('xlsx');
const { readSeriesFile, cleanNames, DEFAULT_NAMES } = require('../electron/series-list');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'avpp-series-'));

test('built-in list has the 68 studio series names', () => {
  assert.strictEqual(DEFAULT_NAMES.length, 68);
  assert.ok(DEFAULT_NAMES.includes('DD Vitraag') && DEFAULT_NAMES.includes('Aptavani-14-B4'));
});

test('csv, xlsx and xls all read the first column, header skipped, blanks and repeats dropped', () => {
  const dir = tmp();
  const rows = [['Series Name'], ['DD Hindi'], [''], ['NM Vitraag'], ['dd hindi'], ['  Gnan  ']];
  fs.writeFileSync(path.join(dir, 's.csv'), rows.map((r) => `"${r[0]}"`).join('\n'));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'S');
  XLSX.writeFile(wb, path.join(dir, 's.xlsx'));
  XLSX.writeFile(wb, path.join(dir, 's.xls'), { bookType: 'biff8' });
  for (const f of ['s.csv', 's.xlsx', 's.xls']) {
    assert.deepStrictEqual(readSeriesFile(path.join(dir, f)), ['DD Hindi', 'NM Vitraag', 'Gnan'], f);
  }
});

test('a list without a header keeps its first name; an empty file is an error', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'a.csv'), 'DD Hindi\nDD Vitraag\n');
  assert.deepStrictEqual(readSeriesFile(path.join(dir, 'a.csv')), ['DD Hindi', 'DD Vitraag']);
  fs.writeFileSync(path.join(dir, 'b.csv'), 'Series Name\n\n');
  assert.throws(() => readSeriesFile(path.join(dir, 'b.csv')), /no names/);
  assert.deepStrictEqual(cleanNames([' A ', 'a', null, 'B']), ['A', 'B']);
});
