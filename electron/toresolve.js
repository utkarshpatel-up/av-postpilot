// After a Quiet Lift render: the lifted WAV is imported into a bin, put on a timeline, and Resolve
// switches to the Fairlight page. The WAV is normalized by the engine at render (normalize, dBFS
// sample peak); Voice Isolation is turned on for its track here. null = off for either.
const path = require('path');

const DEFAULTS = { enabled: true, bin: 'Audio Chain', timeline: 'new', normalize: -6.3, isolation: 20 };

const stemOf = (file) => file.split(/[\\/]/).pop().replace(/\.[^.]+$/, '');

// Voice Isolation amount as Resolve takes it (whole number 0-100), or null for off
function isolationAmount(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : null;
}

// chainImport(args): the Resolve bridge; opts: the toResolve settings.
// name: what a new timeline is called (the recording's name).
async function sendToResolve({ file, name, chainImport, opts }) {
  const r = await chainImport({
    file, bin: opts.bin || DEFAULTS.bin, timeline: opts.timeline, name: name || stemOf(file), isolation: isolationAmount(opts.isolation),
  });
  if (!r.ok) throw new Error(`Resolve did not take ${path.basename(file)}: ${r.error || 'unknown error'}`);
  return { file, timeline: r.timeline, bin: r.bin, isolationTrack: r.isolationTrack ?? null, warning: r.warning || null };
}

module.exports = { DEFAULTS, sendToResolve, isolationAmount };
