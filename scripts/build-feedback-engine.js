// Freezes the audio engines, Feedback Cutter (electron/feedbackcutter/feedback_bridge.py + dsp.py) and
// Quiet Lift (electron/quietlift/quiet_lift_bridge.py + quiet_lift.py), with Python, numpy, scipy,
// soundfile, matplotlib and FFmpeg into vendor/feedback-engine/<win, mac-arm64, mac-x64>/, which the
// build packs into the app (resources/feedback-engine): nobody needs Python installed. One program for
// both (scripts/feedback-engine-main.py picks the engine), so the packages are in the app once.
//   node scripts/build-feedback-engine.js [--force] [--arch arm64|x64]
// Needs Python 3 on the build computer (FEEDBACK_ENGINE_PYTHON, else `py -3` / `python3`, else `python`);
// the packages come from scripts/feedback-engine-requirements.txt into a venv under vendor/feedback-engine.
// A frozen Python runs on its own architecture only, so a Mac build runs this once per architecture,
// each time with a Python of that architecture (an x64 one runs under Rosetta on Apple silicon).
// Runs before dist:win / dist:zip and does nothing when the engine is already built from these sources.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { engineDigest, engineDir, engineExeName } = require('../electron/feedbackcutter');

const ROOT = path.join(__dirname, '..');
const BASE = path.join(ROOT, 'vendor', 'feedback-engine');
const WIN = process.platform === 'win32';
const archArg = process.argv.indexOf('--arch');
const arch = archArg > 0 ? process.argv[archArg + 1] : process.arch;
const dest = engineDir(ROOT, process.platform, arch);
if (!dest) {
  console.log('Audio engine: only built for Windows and Mac; elsewhere the pages use the Python on PATH');
  process.exit(0);
}
const exe = path.join(dest, 'feedback-engine', engineExeName());
const stamp = path.join(dest, 'SOURCES');
const venv = path.join(BASE, WIN ? 'venv' : `venv-${path.basename(dest)}`);
const venvPython = WIN ? path.join(venv, 'Scripts', 'python.exe') : path.join(venv, 'bin', 'python');
const requirements = path.join(__dirname, 'feedback-engine-requirements.txt');
const entry = path.join(__dirname, 'feedback-engine-main.py');

// rebuilt whenever the engine code, the package list or this script changes
const digest = engineDigest(ROOT);
if (!process.argv.includes('--force') && fs.existsSync(exe) && fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8').trim() === digest) {
  console.log(`Audio engine is already in ${path.relative(ROOT, dest)}`);
  process.exit(0);
}

const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit', cwd: ROOT });
// A universal Python runs as the computer's own architecture unless told otherwise. What it starts
// (PyInstaller's helpers) stays on the same one under Rosetta.
const macArch = arch === 'x64' ? 'x86_64' : arch;
const onArch = (cmd, args) => (WIN ? [cmd, args] : ['arch', [`-${macArch}`, cmd, ...args]]);
const runPython = (args) => run(...onArch(venvPython, args));
function basePython() {
  const tries = process.env.FEEDBACK_ENGINE_PYTHON ? [[process.env.FEEDBACK_ENGINE_PYTHON]] : [['py', '-3'], ['python3'], ['python']];
  for (const [cmd, ...pre] of tries) {
    try { execFileSync(cmd, [...pre, '--version'], { stdio: 'ignore' }); return [cmd, pre]; } catch {}
  }
  throw new Error('Python 3 is needed to build the audio engine (set FEEDBACK_ENGINE_PYTHON)');
}

if (!fs.existsSync(venvPython)) {
  const [cmd, pre] = basePython();
  console.log(`Creating ${path.relative(ROOT, venv)}`);
  run(...onArch(cmd, [...pre, '-m', 'venv', venv]));
}
if (!WIN) {   // PyInstaller builds for the Python running it: a wrong one must not pass for this architecture
  const machine = execFileSync(...onArch(venvPython, ['-c', 'import platform; print(platform.machine())']), { encoding: 'utf8' }).trim();
  if (machine !== macArch) throw new Error(`Building for ${arch} needs a Python of that architecture, but ${venvPython} is ${machine} (set FEEDBACK_ENGINE_PYTHON)`);
}
runPython(['-m', 'pip', 'install', '--disable-pip-version-check', '-q', '-r', requirements]);

const work = path.join(BASE, WIN ? 'pyinstaller' : `pyinstaller-${path.basename(dest)}`);
fs.rmSync(dest, { recursive: true, force: true });
runPython(['-m', 'PyInstaller', '--noconfirm', '--clean', '--onedir', '--log-level', 'WARN',
  '--name', 'feedback-engine', '--distpath', dest, '--workpath', work, '--specpath', work,
  '--paths', path.join(ROOT, 'electron', 'feedbackcutter'), '--paths', path.join(ROOT, 'electron', 'quietlift'),
  '--collect-all', 'imageio_ffmpeg',   // its FFmpeg: MP3 previews and non-WAV recordings
  ...['tkinter', 'IPython', 'PyQt5', 'PySide6', 'pytest'].flatMap((m) => ['--exclude-module', m]),
  entry]);
if (!fs.existsSync(exe)) throw new Error(`PyInstaller did not produce ${exe}`);
fs.writeFileSync(stamp, `${digest}\n`);
console.log(`Audio engine (Feedback Cutter, Quiet Lift) → ${path.relative(ROOT, path.dirname(exe))}`);
