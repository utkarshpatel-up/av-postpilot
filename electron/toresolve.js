// After a Quiet Lift render: the lifted WAV is imported into a bin, put on a timeline, normalized
// (Normalize Audio Level, Sample Peak Program, Resolve 21.1+), Voice Isolation turned on for its
// track, and Resolve switches to the Fairlight page. null = off for normalize or isolation.
const path = require('path');

const DEFAULTS = { enabled: true, bin: 'Audio Chain', timeline: 'new', normalize: -6.3, isolation: 20 };

const stemOf = (file) => file.split(/[\\/]/).pop().replace(/\.[^.]+$/, '');

// a number in lo..hi (rounded when whole), or null for off / not usable
function setting(v, lo, hi, whole) {
  if (v === null || v === undefined || v === '') return null;
  const n = whole ? Math.round(Number(v)) : Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : null;
}
const normalizeLevel = (v) => setting(v, -60, 0, false);   // dBFS sample peak
const isolationAmount = (v) => setting(v, 0, 100, true);   // as Resolve takes it

// chainImport(args): the Resolve bridge; opts: the toResolve settings.
// name: what a new timeline is called (the recording's name).
async function sendToResolve({ file, name, chainImport, opts }) {
  const r = await chainImport({
    file, bin: opts.bin || DEFAULTS.bin, timeline: opts.timeline, name: name || stemOf(file),
    normalize: normalizeLevel(opts.normalize), isolation: isolationAmount(opts.isolation),
  });
  if (!r.ok) throw new Error(`Resolve did not take ${path.basename(file)}: ${r.error || 'unknown error'}`);
  return {
    file, timeline: r.timeline, bin: r.bin,
    normalized: r.normalized ?? null, isolationTrack: r.isolationTrack ?? null, warning: r.warning || null,
  };
}

module.exports = { DEFAULTS, sendToResolve, normalizeLevel, isolationAmount };
