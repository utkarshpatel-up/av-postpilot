// After a Quiet Lift render: the lifted WAV is imported into a bin, put on a timeline, normalized
// (Normalize Audio Level, Sample Peak Program, Resolve 21.1+), Voice Isolation turned on for its
// track, and Resolve switches to the Fairlight page. null = off for normalize or isolation.
// A file in the day folder of an Edit timeline of the open project (Project files) goes on that timeline,
// on its own Rec tracks; any other a timeline per clip: channel 1 of 260910_0083 on A1, channel 2 on A2.
const path = require('path');
const { timelineFor } = require('./project-audio');

const DEFAULTS = { enabled: true, bin: 'Audio Chain', timeline: 'new', normalize: -6.3, isolation: 20 };

const stemOf = (file) => file.split(/[\\/]/).pop().replace(/\.[^.]+$/, '');

// a number in lo..hi (rounded when whole), or null for off / not usable
function setting(v, lo, hi, whole) {
  if (v === null || v === undefined || v === '') return null;
  const n = whole ? Math.round(Number(v)) : Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : null;
}
// "260910_0083-1" -> clip 260910_0083, channel 1 (the recorder's -1 / -2). One digit only (or the recorder's -01), so
// "Talk-02" stays a recording of its own and "260910_0083" isn't channel 83. A -debleed suffix goes first.
function splitChannel(name) {
  const stem = name.replace(/[-_ ]?debleed$/i, '');
  const m = stem.match(/^(.+)[-_](\d)$/) || stem.match(/^(\d{6}_\d+)[-_]0(\d)$/);   // the recorder's -01 too
  return m ? { clip: m[1], channel: Number(m[2]) } : { clip: stem, channel: null };
}

const normalizeLevel = (v) => setting(v, -60, 0, false);   // dBFS sample peak
const isolationAmount = (v) => setting(v, 0, 100, true);   // as Resolve takes it

// chainImport(args): the Resolve bridge; opts: the toResolve settings; editTimelines(): the open project's
// Edit timelines with their clips' files (bridge.editTimelines).
// name: the recording's name; a new timeline is named after its clip, channels side by side.
// source: the original recording; its folder picks the Edit timeline (the file may be saved elsewhere).
async function sendToResolve({ file, source, name, chainImport, opts, editTimelines }) {
  const { clip, channel } = splitChannel(name || stemOf(file));
  let edit = {}, note = null;
  if (opts.timeline !== 'current' && editTimelines) {
    edit = timelineFor(source || file, await editTimelines().catch(() => []));
    if (edit.mismatch) note = `Put on ${edit.name} anyway, but ${edit.mismatch}.`;
  }
  const r = await chainImport({
    file, bin: opts.bin || DEFAULTS.bin, timeline: opts.timeline, name: clip, channel, edit: edit.name || null, clipNo: edit.clip ?? null,
    normalize: normalizeLevel(opts.normalize), isolation: isolationAmount(opts.isolation),
  });
  if (!r.ok) throw new Error(`Resolve did not take ${path.basename(file)}: ${r.error || 'unknown error'}`);
  return {
    file, timeline: r.timeline, bin: r.bin, track: r.track ?? null,
    normalized: r.normalized ?? null, isolationTrack: r.isolationTrack ?? null,
    warning: [note, r.warning].filter(Boolean).join(' ') || null,
  };
}

module.exports = { DEFAULTS, sendToResolve, splitChannel, normalizeLevel, isolationAmount };
