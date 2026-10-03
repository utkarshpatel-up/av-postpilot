// Series names for the Episodes page suggestions, read from .csv / .xlsx / .xls:
// the first column of the first sheet; a header like "Series Name" is skipped.
const XLSX = require('xlsx');
const DEFAULT_NAMES = require('./series-default.json');

function cleanNames(values) {
  const seen = new Set();
  const out = [];
  for (const v of values) {
    const name = String(v ?? '').trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push(name);
  }
  return out;
}

function readSeriesFile(file) {
  const wb = XLSX.readFile(file, { raw: false, dense: true });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) throw new Error('the file has no sheets');
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: '' });
  let values = rows.map((r) => r[0]);
  if (values.length && /^(series|title)?\s*name(s)?$|^series$/i.test(String(values[0]).trim())) values = values.slice(1);
  const names = cleanNames(values);
  if (!names.length) throw new Error('no names found in the first column');
  return names;
}

module.exports = { readSeriesFile, cleanNames, DEFAULT_NAMES };
