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

// AVCHD playlists (BDMV/PLAYLIST/*.MPL, Blu-ray MPLS layout) say exactly which clip continues which:
// a PlayItem whose connection_condition is 5 or 6 joins seamlessly onto the PlayItem before it.
// Returns Map(clip number -> number of the clip it continues), or null when there is no readable playlist.
function parseMpl(buf) {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'MPLS') return null;
  const start = buf.readUInt32BE(8);
  if (start + 10 > buf.length) return null;
  const items = [];
  let p = start + 10;
  for (let i = buf.readUInt16BE(start + 6); i > 0; i--) {
    if (p + 13 > buf.length) return null;
    const name = buf.toString('ascii', p + 2, p + 7);
    if (!/^\d{5}$/.test(name)) return null;
    items.push({ num: parseInt(name, 10), cc: buf[p + 12] & 0x0f });
    p += 2 + buf.readUInt16BE(p);
  }
  return items;
}
function readPlaylist(streamDir) {
  const dir = child(path.dirname(path.resolve(streamDir)), 'PLAYLIST');
  if (!dir) return null;
  const full = path.join(path.dirname(path.resolve(streamDir)), dir);
  const links = new Map();
  let any = false;
  for (const n of fs.readdirSync(full).filter((x) => /\.mpls?$/i.test(x))) {
    let items;
    try { items = parseMpl(fs.readFileSync(path.join(full, n))); } catch { items = null; }
    if (!items) continue;
    any = true;
    items.forEach((it, i) => { if (i && (it.cc === 5 || it.cc === 6)) links.set(it.num, items[i - 1].num); else if (!links.has(it.num)) links.set(it.num, null); });
  }
  return any ? links : null;
}

// Clips listed in the playlist are joined exactly as it says. Clips it does not list fall back to a guess:
// shortcut: "full segment" is guessed from size (camera cuts at a fixed limit); upgrade: only if a camera writes no playlist.
function groupRecordings(clips, { splitMinBytes = SPLIT_MIN_BYTES, maxGapMs = MAX_GAP_MS, playlist = null } = {}) {
  const groups = [];
  let cur = null;
  for (const c of [...clips].sort((a, b) => a.num - b.num)) {
    const prev = cur && cur.clips[cur.clips.length - 1];
    let joins = false;
    if (prev && c.num === prev.num + 1) {
      if (playlist && playlist.has(c.num) && playlist.has(prev.num)) joins = playlist.get(c.num) === prev.num;
      else { const gap = c.mtimeMs - prev.mtimeMs; joins = prev.size >= splitMinBytes && gap > 0 && gap <= maxGapMs; }
    }
    if (joins) {
      cur.clips.push(c);
      cur.totalSize += c.size;
    } else {
      cur = { clips: [c], totalSize: c.size, outName: `${String(c.num).padStart(5, '0')}_Full.MTS` };
      groups.push(cur);
    }
  }
  return groups;
}

// One call for the UI: card root or STREAM folder in, recordings out.
function scan(dir, opts = {}) {
  const stream = findStream(dir);
  const clips = listClips(stream);
  const playlist = readPlaylist(stream);
  return { stream, clips, usedPlaylist: Boolean(playlist), groups: groupRecordings(clips, { ...opts, playlist }) };
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
  let lastPercent = -1;
  async function* chunks() {
    for (const clip of clips) {
      for await (const buf of fs.createReadStream(clip.path)) {
        done += buf.length;
        // report each whole percent only: an 8 GB recording is ~130k chunks
        const percent = total ? Math.min(100, Math.floor((done / total) * 100)) : 100;
        if (onProgress && percent !== lastPercent) { lastPercent = percent; onProgress({ done, total, percent, clip: clip.name }); }
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

module.exports = { findStream, listClips, parseMpl, readPlaylist, groupRecordings, scan, stitch, stitchAll, SPLIT_MIN_BYTES, MAX_GAP_MS };
