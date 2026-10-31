// Freezes the Feedback Cutter engine (electron/feedbackcutter/feedback_bridge.py + dsp.py) with
// Python, numpy, scipy, soundfile, matplotlib and FFmpeg into vendor/feedback-engine/win/, which the
// Windows build packs into the app (resources/feedback-engine): nobody needs Python installed.
//   node scripts/build-feedback-engine.js [--force]
// Needs Python 3 on the build PC (FEEDBACK_ENGINE_PYTHON, else `py -3`, else `python`); the packages
// come from scripts/feedback-engine-requirements.txt into vendor/feedback-engine/venv.
// Runs before dist:win / dist:zip and does nothing when the engine is already built from these sources.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BASE = path.join(ROOT, 'vendor', 'feedback-engine');
const dest = path.join(BASE, 'win');
const exe = path.join(dest, 'feedback-engine', 'feedback-engine.exe');
const stamp = path.join(dest, 'SOURCES');
const venv = path.join(BASE, 'venv');
const venvPython = path.join(venv, 'Scripts', 'python.exe');
const requirements = path.join(__dirname, 'feedback-engine-requirements.txt');
const sources = [requirements, __filename, ...['dsp.py', 'feedback_bridge.py'].map((f) => path.join(ROOT, 'electron', 'feedbackcutter', f))];

if (process.platform !== 'win32') {
  console.log('Feedback Cutter engine: only built for Windows; elsewhere the page uses the Python on PATH');
  process.exit(0);
}

// rebuilt whenever the engine code, the package list or this script changes
const hash = crypto.createHash('sha256');
for (const f of sources) hash.update(fs.readFileSync(f));
const digest = hash.digest('hex');
if (!process.argv.includes('--force') && fs.existsSync(exe) && fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8').trim() === digest) {
  console.log(`Feedback Cutter engine is already in ${path.relative(ROOT, dest)}`);
  process.exit(0);
}

const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit', cwd: ROOT });
function basePython() {
  const tries = process.env.FEEDBACK_ENGINE_PYTHON ? [[process.env.FEEDBACK_ENGINE_PYTHON]] : [['py', '-3'], ['python']];
  for (const [cmd, ...pre] of tries) {
    try { execFileSync(cmd, [...pre, '--version'], { stdio: 'ignore' }); return [cmd, pre]; } catch {}
  }
  throw new Error('Python 3 is needed to build the Feedback Cutter engine (set FEEDBACK_ENGINE_PYTHON)');
}

if (!fs.existsSync(venvPython)) {
  const [cmd, pre] = basePython();
  console.log(`Creating ${path.relative(ROOT, venv)}`);
  run(cmd, [...pre, '-m', 'venv', venv]);
}
run(venvPython, ['-m', 'pip', 'install', '--disable-pip-version-check', '-q', '-r', requirements]);

const work = path.join(BASE, 'pyinstaller');
fs.rmSync(dest, { recursive: true, force: true });
run(venvPython, ['-m', 'PyInstaller', '--noconfirm', '--clean', '--onedir', '--log-level', 'WARN',
  '--name', 'feedback-engine', '--distpath', dest, '--workpath', work, '--specpath', work,
  '--paths', path.join(ROOT, 'electron', 'feedbackcutter'),
  '--collect-all', 'imageio_ffmpeg',   // its FFmpeg: MP3 previews and non-WAV recordings
  ...['tkinter', 'IPython', 'PyQt5', 'PySide6', 'pytest'].flatMap((m) => ['--exclude-module', m]),
  path.join(ROOT, 'electron', 'feedbackcutter', 'feedback_bridge.py')]);
if (!fs.existsSync(exe)) throw new Error(`PyInstaller did not produce ${exe}`);
fs.writeFileSync(stamp, `${digest}\n`);
console.log(`Feedback Cutter engine → ${path.relative(ROOT, path.dirname(exe))}`);
