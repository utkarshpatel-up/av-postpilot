// Feedback Cutter: finds feedback rings in a speech recording and notches them out.
// The DSP is the Feedback Cutter project's dsp.py, run through a JSON-lines bridge
// (feedbackcutter/feedback_bridge.py) by the same engine class Quiet Lift uses.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { QuietLift: Engine } = require('./quietlift');

const DEFAULTS = { python: '', dir: '', sensitivity: 22, specDetail: 'pooled' };
const FILES = ['dsp.py', 'feedback_bridge.py'];
const JOB = /^[0-9a-f]{12}$/;
const NAME = /^[A-Za-z0-9_]+\.[A-Za-z0-9]+$/;

// Python can't read files inside the packaged app (asar): give it its own copy.
function installScripts(dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const f of FILES) fs.writeFileSync(path.join(dir, f), fs.readFileSync(path.join(__dirname, 'feedbackcutter', f)));
  return path.join(dir, 'feedback_bridge.py');
}

// A file of the current analysis (cleaned.wav, markers_audition.csv ...), checked so the
// renderer can only name files inside a job folder.
function jobFile(workDir, job, name) {
  if (!JOB.test(job || '') || !NAME.test(name || '')) throw new Error('Bad file name');
  const file = path.join(workDir, job, name);
  if (!fs.existsSync(file)) throw new Error('That file is gone. Analyze the recording again.');
  return file;
}

// "Talk Clip-02.mp3" + cleaned -> "Talk Clip-02 (fc-cleaned).wav", next to the source
// (split on both separators: path.basename on a Mac keeps a whole Windows path)
const exportName = (source, suffix, ext) => `${source.split(/[\\/]/).pop().replace(/\.[^.]+$/, '')} (fc-${suffix}).${ext}`;

// Where a build of the engine lives from source: vendor/feedback-engine/win, or mac-arm64 / mac-x64
// (a frozen Python runs on one architecture only). '' where it isn't built.
function engineDir(root, platform = process.platform, arch = process.arch) {
  const name = platform === 'win32' ? 'win' : platform === 'darwin' ? `mac-${arch}` : '';
  return name && path.join(root, 'vendor', 'feedback-engine', name);
}
const engineExeName = (platform = process.platform) => (platform === 'win32' ? 'feedback-engine.exe' : 'feedback-engine');

// The engine built into the app (scripts/build-feedback-engine.js): resources/feedback-engine when
// installed, vendor/feedback-engine/<win, mac-arch> from source. '' when there is none (not built).
function bundledEngine(resourcesPath = process.resourcesPath) {
  const dirs = [resourcesPath && path.join(resourcesPath, 'feedback-engine'), engineDir(path.join(__dirname, '..'))];
  if (!dirs[1]) return '';
  for (const d of dirs.filter(Boolean)) {
    const exe = path.join(d, 'feedback-engine', engineExeName());
    if (fs.existsSync(exe)) return exe;
  }
  return '';
}

// Hash of everything the built engine is made from; scripts/build-feedback-engine.js stamps it on a build.
function engineDigest(root) {
  const hash = crypto.createHash('sha256');
  for (const f of ['scripts/feedback-engine-requirements.txt', 'scripts/build-feedback-engine.js', 'scripts/feedback-engine-main.py',
    'electron/feedbackcutter/dsp.py', 'electron/feedbackcutter/feedback_bridge.py',
    'electron/quietlift/quiet_lift.py', 'electron/quietlift/quiet_lift_bridge.py', 'electron/quietlift/wav_markers.py']) {
    hash.update(fs.readFileSync(path.join(root, f)));
  }
  return hash.digest('hex');
}

// From source only: the built engine holds its own copy of the code, so after an edit it runs the old
// version until it is rebuilt. Installed apps have no sources here, and their engine is built with them.
function builtEngineOutdated(root = path.join(__dirname, '..')) {
  const dir = engineDir(root);
  const stamp = dir && path.join(dir, 'SOURCES');
  if (!stamp || !fs.existsSync(stamp)) return false;
  return fs.readFileSync(stamp, 'utf8').trim() !== engineDigest(root);
}

// A Python chosen on the page wins (e.g. to try a newer dsp.py); otherwise the built-in engine.
function createEngine({ script, workDir, getPython = () => '', getExe = bundledEngine, onLog }) {
  return new Engine({ script, args: [workDir], name: 'Feedback Cutter', getPython, getExe: () => (getPython() ? '' : getExe()), onLog });
}

module.exports = { DEFAULTS, installScripts, jobFile, exportName, createEngine, bundledEngine, engineDir, engineExeName, engineDigest, builtEngineOutdated };
