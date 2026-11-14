const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const m = require('../electron/mts-stitch');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mts-'));
const T0 = 1_700_000_000;
function card(files) { // files: [name, bytes, mtimeSec]
  const root = tmp();
  const stream = path.join(root, 'PRIVATE', 'AVCHD', 'BDMV', 'STREAM');
  fs.mkdirSync(stream, { recursive: true });
  for (const [n, len, t] of files) {
    const p = path.join(stream, n);
    fs.writeFileSync(p, Buffer.alloc(len, n.charCodeAt(4)));
    fs.utimesSync(p, t, t);
  }
  return { root, stream };
}
const O = { splitMinBytes: 100 };

test('findStream: root, STREAM dir, missing', () => {
  const { root, stream } = card([['00001.MTS', 5, T0]]);
  assert.strictEqual(m.findStream(root), stream);
  assert.strictEqual(m.findStream(stream), stream);
  assert.throws(() => m.findStream(tmp()), /No AVCHD STREAM/);
  assert.throws(() => m.findStream(path.join(root, 'nope')), /not found/);
  const r2 = tmp();
  fs.mkdirSync(path.join(r2, 'avchd', 'bdmv', 'stream'), { recursive: true });
  assert.ok(m.findStream(r2).endsWith(path.join('avchd', 'bdmv', 'stream')));
});

test('listClips: sorted, case-insensitive, ignores others', () => {
  const { stream } = card([['00010.mts', 3, T0], ['00002.MTS', 4, T0], ['readme.txt', 1, T0]]);
  const c = m.listClips(stream);
  assert.deepStrictEqual(c.map((x) => [x.name, x.num, x.size]), [['00002.MTS', 2, 4], ['00010.mts', 10, 3]]);
});

const clip = (num, size, t) => ({ name: `${num}.MTS`, num, path: `/x/${num}`, size, mtimeMs: t * 1000 });

test('groupRecordings', () => {
  const g = m.groupRecordings([
    clip(85, 100, 0), clip(86, 100, 600), clip(87, 100, 1200), clip(88, 40, 1500), // 85-88 one recording
    clip(89, 100, 1600), // single (consecutive but 88 was short)
    clip(91, 100, 1700), clip(92, 50, 1800), // number gap splits
    clip(93, 100, 2000), clip(94, 100, 2000 + 3 * 3600), // big mtime gap splits
  ], O);
  assert.deepStrictEqual(g.map((x) => x.clips.map((c) => c.num)), [[85, 86, 87, 88], [89], [91, 92], [93], [94]]);
  assert.strictEqual(g[0].outName, '00085_Full.MTS');
  assert.strictEqual(g[0].totalSize, 340);
  assert.strictEqual(m.groupRecordings([clip(1, 10, 0), clip(2, 10, 1)], O).length, 2);
  assert.strictEqual(m.groupRecordings([clip(1, 100, 5), clip(2, 100, 5)], O).length, 2); // mtime must advance
});

test('stitch: bytes equal concatenation, no .part, progress, source untouched', async () => {
  const { stream } = card([['00001.MTS', 120, T0], ['00002.MTS', 110, T0 + 60], ['00003.MTS', 30, T0 + 100]]);
  const [g] = m.groupRecordings(m.listClips(stream), O);
  assert.strictEqual(g.clips.length, 3);
  const dest = tmp();
  const seen = [];
  const r = await m.stitch(g, dest, { onProgress: (p) => seen.push(p) });
  const expect = Buffer.concat(g.clips.map((c) => fs.readFileSync(c.path)));
  assert.ok(fs.readFileSync(path.join(dest, '00001_Full.MTS')).equals(expect));
  assert.deepStrictEqual(fs.readdirSync(dest), ['00001_Full.MTS']);
  assert.strictEqual(r.size, 260);
  assert.strictEqual(seen[seen.length - 1].percent, 100);
  assert.strictEqual(fs.readdirSync(stream).length, 3);
  await assert.rejects(m.stitch(g, dest), /already exists/);
  await m.stitch(g, dest, { overwrite: true });
});

test('stitch: refuses destination on the card', async () => {
  const { root, stream } = card([['00001.MTS', 120, T0], ['00002.MTS', 10, T0 + 60]]);
  const [g] = m.groupRecordings(m.listClips(stream), O);
  await assert.rejects(m.stitch(g, stream), /camera card/);
  await assert.rejects(m.stitch(g, path.join(root, 'PRIVATE', 'AVCHD', 'out')), /camera card/);
  await assert.rejects(m.stitch(g, root), /camera card/);
  assert.deepStrictEqual(fs.readdirSync(stream).sort(), ['00001.MTS', '00002.MTS']);
});

test('stitch: abort removes .part; stitchAll skips singles and reports', async () => {
  const { stream } = card([['00001.MTS', 200000, T0], ['00002.MTS', 200000, T0 + 60], ['00004.MTS', 5, T0 + 90]]);
  const groups = m.groupRecordings(m.listClips(stream), { splitMinBytes: 100 });
  const dest = tmp();
  const ac = new AbortController();
  await assert.rejects(m.stitch(groups[0], dest, { signal: ac.signal, onProgress: () => ac.abort() }));
  assert.deepStrictEqual(fs.readdirSync(dest), []);
  const res = await m.stitchAll(groups, dest);
  assert.strictEqual(res.length, 1);
  assert.ok(res[0].ok);
  const res2 = await m.stitchAll(groups, dest, { includeSingles: true, overwrite: true });
  assert.strictEqual(res2.length, 2);
  assert.deepStrictEqual(fs.readdirSync(dest).sort(), ['00001_Full.MTS', '00004_Full.MTS']);
});
