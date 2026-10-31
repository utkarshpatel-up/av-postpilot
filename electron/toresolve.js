// After a Quiet Lift render: the lifted WAV is imported into a bin, put on a timeline, and Resolve
// switches to the Fairlight page.
const path = require('path');

const DEFAULTS = { enabled: true, bin: 'Audio Chain', timeline: 'new' };

const stemOf = (file) => file.split(/[\\/]/).pop().replace(/\.[^.]+$/, '');

// chainImport(args): the Resolve bridge; opts: the toResolve settings.
// name: what a new timeline is called (the recording's name).
async function sendToResolve({ file, name, chainImport, opts }) {
  const r = await chainImport({ file, bin: opts.bin || DEFAULTS.bin, timeline: opts.timeline, name: name || stemOf(file) });
  if (!r.ok) throw new Error(`Resolve did not take ${path.basename(file)}: ${r.error || 'unknown error'}`);
  return { file, timeline: r.timeline, bin: r.bin };
}

module.exports = { DEFAULTS, sendToResolve };
