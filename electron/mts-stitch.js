// Join AVCHD camera clips that were split mid-recording (00085.MTS + 00086.MTS ...) into one file.
// MPEG-TS joins by plain byte concatenation (same as `copy /b a + b`). Source clips are only ever read.
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const GIB = 1024 ** 3;
const SPLIT_MIN_BYTES = 1.9 * GIB;
const MAX_GAP_MS = 2 * 60 * 60 * 1000;

// Case-insensitive child lookup (cards are FAT/exFAT, but be safe on any filesystem).
function child(dir, name) {
  try { return fs.readdirSync(dir).find((n) => n.toLowerCase() === name.toLowerCase()) || null; } catch { return null; }
}
function descend(dir, parts) {
  let cur = dir;
  for (const p of parts) { const n = child(cur, p); if (!n) return null; cur = path.join(cur, n); }
  return cur;
}

// Accepts the STREAM folder itself or a card/volume root.
function findStream(dir) {
  if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`Folder not found: ${dir}`);
  if (path.basename(path.resolve(dir)).toUpperCase() === 'STREAM') return dir;
  for (const parts of [['PRIVATE', 'AVCHD', 'BDMV', 'STREAM'], ['AVCHD', 'BDMV', 'STREAM']]) {
    const found = descend(dir, parts);
    if (found) return found;
  }
  throw new Error(`No AVCHD STREAM folder found in ${dir} (expected PRIVATE/AVCHD/BDMV/STREAM).`);
}

function listClips(streamDir) {
  return fs.readdirSync(streamDir)
    .filter((n) => /^\d+\.mts$/i.test(n))
    .map((name) => {
      const p = path.join(streamDir, name);
      const st = fs.statSync(p);
      return { name, num: parseInt(name, 10), path: p, size: st.size, mtimeMs: st.mtimeMs };
    })
    .sort((a, b) => a.num - b.num);
}

// shortcut: "full segment" is guessed from size (camera cuts at a fixed limit); upgrade: read BDMV/PLAYLIST/*.MPL for exact segment lists.
function groupRecordings(clips, { splitMinBytes = SPLIT_MIN_BYTES, maxGapMs = MAX_GAP_MS } = {}) {
  const groups = [];
  let cur = null;
  for (const c of [...clips].sort((a, b) => a.num - b.num)) {
    const prev = cur && cur.clips[cur.clips.length - 1];
    const gap = prev ? c.mtimeMs - prev.mtimeMs : 0;
    if (prev && c.num === prev.num + 1 && prev.size >= splitMinBytes && gap > 0 && gap <= maxGapMs) {
      cur.clips.push(c);
      cur.totalSize += c.size;
    } else {
      cur = { clips: [c], totalSize: c.size, outName: `${String(c.num).padStart(5, '0')}_Full.MTS` };
      groups.push(cur);
    }
  }
  return groups;
}

const within = (parent, p) => { const r = path.relative(parent, p); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };

// The card = the volume root holding PRIVATE/AVCHD/BDMV/STREAM (or AVCHD/BDMV/STREAM).
function cardRoot(streamDir) {
  const avchd = path.dirname(path.dirname(path.resolve(streamDir)));
  const up = path.dirname(avchd);
  return path.basename(up).toUpperCase() === 'PRIVATE' ? path.dirname(up) : up;
}

async function stitch(group, destDir, { onProgress, signal, overwrite = false } = {}) {
  const clips = group.clips;
  if (!clips || !clips.length) throw new Error('Nothing to stitch.');
  destDir = path.resolve(destDir);
  const onCard = (d) => clips.some((c) => { const r = cardRoot(path.dirname(c.path)); return within(r, d) || within(fs.realpathSync(r), d); });
  const refuse = 'Refusing to write onto the camera card. Choose a folder on another drive.';
  if (onCard(destDir)) throw new Error(refuse);   // checked before mkdir so nothing is created on the card
  fs.mkdirSync(destDir, { recursive: true });
  if (onCard(fs.realpathSync(destDir))) throw new Error(refuse);
  const out = path.join(destDir, group.outName);
  const part = out + '.part';
  if (fs.existsSync(out) && !overwrite) throw new Error(`${group.outName} already exists in ${destDir}.`);

  const total = clips.reduce((s, c) => s + fs.statSync(c.path).size, 0);
  const fsStat = fs.statfsSync(destDir);
  if (fsStat.bavail * fsStat.bsize < total) throw new Error(`Not enough free space in ${destDir} (need ${(total / GIB).toFixed(2)} GiB).`);

  let done = 0;
  async function* chunks() {
    for (const clip of clips) {
      for await (const buf of fs.createReadStream(clip.path)) {
        done += buf.length;
        if (onProgress) onProgress({ done, total, percent: total ? Math.min(100, (done / total) * 100) : 100, clip: clip.name });
        yield buf;
      }
    }
  }
  try {
    await pipeline(Readable.from(chunks()), fs.createWriteStream(part), signal ? { signal } : {});
    const size = fs.statSync(part).size;
    if (size !== total) throw new Error(`Stitched size mismatch (${size} of ${total} bytes); output discarded.`);
    fs.renameSync(part, out);
  } catch (e) {
    fs.rmSync(part, { force: true });
    throw e;
  }
  return { outPath: out, size: total, clips: clips.length };
}

// Runs sequentially; multi-clip groups only unless includeSingles. Stops (rethrows) on abort.
async function stitchAll(groups, destDir, { includeSingles = false, ...opts } = {}) {
  const results = [];
  for (const g of groups) {
    if (g.clips.length < 2 && !includeSingles) continue;
    if (opts.signal && opts.signal.aborted) break;
    try {
      results.push({ group: g, ok: true, ...(await stitch(g, destDir, opts)) });
    } catch (e) {
      if (opts.signal && opts.signal.aborted) { results.push({ group: g, ok: false, error: 'Cancelled' }); break; }
      results.push({ group: g, ok: false, error: e.message });
    }
  }
  return results;
}

module.exports = { findStream, listClips, groupRecordings, stitch, stitchAll, SPLIT_MIN_BYTES, MAX_GAP_MS };
