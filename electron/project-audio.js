// Project files (Feedback Cutter and Quiet Lift pages): the recorder audio of every Edit timeline in the
// open Resolve project. Edit-2978's clips are in the day folder "2978 Dt-03 Jun 2026"; somewhere below it
// (Clips for Insert, a session folder) the Cam-XX (Audio) folders hold the recorder's WAVs, 260603_0083-1.wav.
// The 260603 in a name must be that folder's date, so another day's file can't land on Edit-2978.
const fs = require('fs');
const path = require('path');
const { dayNumber, clipNumber } = require('./project-setup');

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const AUDIO_DIR = /^cam[-\s]*\d+.*\(audio\)$/i;
const DERIVED = / \(fc-[a-z]+\)( \d+)?$|-lifted(-\d+)?$/i;   // Feedback Cutter / Quiet Lift output, not recordings
const NOT_RECORDING = /^RX Temp Save File/i;                      // iZotope RX's own temporary saves
const natural = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// "2978 Dt-03 Jun 2026" -> "260603", the YYMMDD the recorder puts at the start of its file names
function dayDate(dayName) {
  const m = /Dt-?\s*(\d{1,2})[\s-]+([a-z]{3})[a-z]*[\s-]+(\d{4}|\d{2})\b/i.exec(dayName);
  const mon = m ? MONTHS.indexOf(m[2].toLowerCase()) + 1 : 0;
  return mon ? `${m[3].slice(-2)}${String(mon).padStart(2, '0')}${m[1].padStart(2, '0')}` : null;
}

// "260603_0083-1" -> { date: '260603', clip: 83, channel: 1 } (-01 too); a renamed "Cam-05 … Clip-001" has no date
function recorderName(stem) {
  const m = /^(\d{6})_0*(\d+)(?:[-_]0?(\d))?$/.exec(stem);
  if (m) return { date: m[1], clip: Number(m[2]), channel: m[3] ? Number(m[3]) : null };
  return { date: null, clip: clipNumber(`${stem}.wav`), channel: null };
}

// Edit-2978 or "Edit-2978 E1" -> the folder "2978 Dt-…" its clips are in, or null
function dayFolder(timeline, files) {
  const num = /^Edit-(\S+)/.exec(timeline)?.[1];
  if (!num) return null;
  for (const f of files) {
    for (let d = path.dirname(f); d !== path.dirname(d); d = path.dirname(d)) {
      const name = path.basename(d);
      if (/\bDt-/i.test(name) && dayNumber(name) === num) return d;
    }
  }
  return null;
}

// Cam-XX (Audio) folders up to three levels below the day (day / session / Clips for Insert / Cam-04 (Audio))
function audioDirs(dir, depth = 4) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries.filter((x) => x.isDirectory()).sort((a, b) => natural(a.name, b.name))) {
    const p = path.join(dir, e.name);
    if (AUDIO_DIR.test(e.name)) out.push(p);
    else if (depth > 1) out.push(...audioDirs(p, depth - 1));
  }
  return out;
}

// how many leading folders two paths share
function shared(a, b) {
  const x = a.toLowerCase().split(/[\\/]/), y = b.toLowerCase().split(/[\\/]/);
  let n = 0;
  while (n < x.length && n < y.length && x[n] === y[n]) n++;
  return n;
}
// A day with sessions has several Edit timelines: the folder belongs to the one whose clips are nearest
const owner = (dir, timelines) => timelines.reduce((best, t) => {
  const score = Math.max(0, ...t.files.map((f) => shared(dir, f)));
  return score > best.score ? { t, score } : best;
}, { t: timelines[0], score: -1 }).t;

// The newest of the files in dir whose names match re, or ''
function newest(dir, names, re) {
  const hits = names.filter((n) => re.test(n)).map((n) => path.join(dir, n));
  return hits.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] || '';
}

// The recordings in one Cam-XX (Audio) folder, with their cleaned (FC) and lifted (QL) versions if saved
function recordings(dir, date) {
  const names = fs.readdirSync(dir).filter((n) => /\.wav$/i.test(n));
  const stemOf = (n) => n.replace(/\.wav$/i, '');
  return names.filter((n) => !DERIVED.test(stemOf(n)) && !NOT_RECORDING.test(n)).map((n) => {
    const stem = stemOf(n);
    const rec = recorderName(stem);
    return {
      file: path.join(dir, n), name: stem, clip: rec.clip, channel: rec.channel, date: rec.date,
      dateOk: rec.date ? rec.date === date : null,   // null: nothing in the name to check
      cleaned: newest(dir, names, new RegExp(`^${esc(stem)} \\(fc-cleaned\\)( \\d+)?\\.wav$`, 'i')),
      lifted: newest(dir, names, new RegExp(`^${esc(stem)}-lifted(-\\d+)?\\.wav$`, 'i')),
    };
  });
}

// timelines: [{ name, files }] from the bridge (edittimelines) -> { rows, missing }: one row per recording,
// in timeline, camera, clip, channel order; missing = Edit timelines whose day folder wasn't found.
function projectAudio(timelines) {
  const days = new Map();
  const missing = [];
  for (const t of timelines) {
    const day = dayFolder(t.name, t.files);
    if (!day) { missing.push(t.name); continue; }
    if (!days.has(day)) days.set(day, []);
    days.get(day).push(t);
  }
  const rows = [];
  for (const [day, tls] of days) {
    const date = dayDate(path.basename(day));
    for (const dir of audioDirs(day)) {
      const t = tls.length > 1 ? owner(dir, tls) : tls[0];
      for (const r of recordings(dir, date)) rows.push({ ...r, day: path.basename(day), dayDate: date, timeline: t.name, cam: path.basename(dir) });
    }
  }
  const order = new Map(timelines.map((t, i) => [t.name, i]));
  rows.sort((a, b) => order.get(a.timeline) - order.get(b.timeline) || natural(a.cam, b.cam) ||
    (a.clip ?? Infinity) - (b.clip ?? Infinity) || (a.channel ?? 0) - (b.channel ?? 0) || natural(a.name, b.name));
  return { rows, missing };
}

// Send to Resolve: which Edit timeline a lifted file goes on (the day folder it's in), or { why } when none.
function timelineFor(file, timelines) {
  const lower = file.toLowerCase();
  const cands = timelines.filter((t) => {
    const d = dayFolder(t.name, t.files);
    return d && lower.startsWith(d.toLowerCase() + path.sep);
  });
  if (!cands.length) return { why: 'not in the day folder of an Edit timeline in the open project' };
  const t = cands.length > 1 ? owner(path.dirname(file), cands) : cands[0];
  const day = path.basename(dayFolder(t.name, t.files));
  const rec = recorderName(path.basename(file).replace(/\.wav$/i, '').replace(DERIVED, ''));
  if (rec.date && dayDate(day) && rec.date !== dayDate(day)) return { why: `its date ${rec.date} isn't ${day}`, wrongDate: true };
  return { name: t.name, clip: rec.clip };
}

module.exports = { dayDate, recorderName, dayFolder, audioDirs, projectAudio, timelineFor };
