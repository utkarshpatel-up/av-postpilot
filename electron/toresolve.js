// After a Quiet Lift render: the lifted WAV is imported into a bin, put on a timeline, normalized
// (Normalize Audio Level, Sample Peak Program, Resolve 21.1+), Voice Isolation turned on for its
// track, and Resolve switches to the Fairlight page. null = off for normalize or isolation.
// A new timeline is one per clip: channel 1 of 260910_0083 on A1, channel 2 on A2 of timeline 260910_0083.
const path = require('path');

const DEFAULTS = { enabled: true, bin: 'Audio Chain', timeline: 'new', normalize: -6.3, isolation: 20 };

const stemOf = (file) => file.split(/[\\/]/).pop().replace(/\.[^.]+$/, '');

// a number in lo..hi (rounded when whole), or null for off / not usable
function setting(v, lo, hi, whole) {
  if (v === null || v === undefined || v === '') return null;
  const n = whole ? Math.round(Number(v)) : Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : null;
}
// "260910_0083-1" -> clip 260910_0083, channel 1 (the recorder's -1 / -2). One digit only, so
// "Talk-02" stays a recording of its own and "260910_0083" isn't channel 83. A -debleed suffix goes first.
function splitChannel(name) {
  const stem = name.replace(/[-_ ]?debleed$/i, '');
  const m = stem.match(/^(.+)[-_](\d)$/);
  return m ? { clip: m[1], channel: Number(m[2]) } : { clip: stem, channel: null };
}

const normalizeLevel = (v) => setting(v, -60, 0, false);   // dBFS sample peak
const isolationAmount = (v) => setting(v, 0, 100, true);   // as Resolve takes it

// chainImport(args): the Resolve bridge; opts: the toResolve settings.
// name: the recording's name; a new timeline is named after its clip, channels side by side.
async function sendToResolve({ file, name, chainImport, opts }) {
  const { clip, channel } = splitChannel(name || stemOf(file));
  const r = await chainImport({
    file, bin: opts.bin || DEFAULTS.bin, timeline: opts.timeline, name: clip, channel,
    normalize: normalizeLevel(opts.normalize), isolation: isolationAmount(opts.isolation),
  });
  if (!r.ok) throw new Error(`Resolve did not take ${path.basename(file)}: ${r.error || 'unknown error'}`);
  return {
    file, timeline: r.timeline, bin: r.bin, track: r.track ?? null,
    normalized: r.normalized ?? null, isolationTrack: r.isolationTrack ?? null, warning: r.warning || null,
  };
}

module.exports = { DEFAULTS, sendToResolve, splitChannel, normalizeLevel, isolationAmount };
