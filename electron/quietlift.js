// Quiet Lift: raises long quiet stretches of speech in a debleed track, and only the words in them.
// The work is done by quiet_lift.py through a JSON-lines bridge (quietlift/quiet_lift_bridge.py),
// one Python process that keeps the last analysis in memory so Render doesn't re-read the files.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

// outDir: folder for the final (lifted) file, '' = next to the original recording
const DEFAULTS = { python: '', editor: 'audition', editorPaths: {}, markInput: true, options: {}, dir: '', outDir: '' };
const FILES = ['quiet_lift.py', 'quiet_lift_bridge.py', 'wav_markers.py'];
const defaultPython = () => (process.platform === 'win32' ? 'python' : 'python3');

// Python can't read files inside the packaged app (asar): give it its own copy.
function installScripts(dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const f of FILES) fs.writeFileSync(path.join(dir, f), fs.readFileSync(path.join(__dirname, 'quietlift', f)));
  return path.join(dir, 'quiet_lift_bridge.py');
}

// Also runs the Feedback Cutter engine (feedbackcutter.js): same protocol, its own name and arguments.
// getExe: a frozen engine (Python built in) to run instead of python + script, or '' for none;
// exeArgs: its arguments, when not the script's.
class QuietLift {
  constructor({ script, args = [], exeArgs = args, name = 'Quiet Lift', getPython = () => '', getExe = () => '', onLog = () => {} }) {
    this.script = script;
    this.getExe = getExe;
    this.args = args;
    this.exeArgs = exeArgs;
    this.name = name;
    this.getPython = getPython;
    this.onLog = onLog;
    this.proc = null;
    this.ready = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  start() {
    const exe = this.getExe();
    const python = exe || this.getPython() || defaultPython();
    const proc = spawn(python, exe ? this.exeArgs : ['-u', this.script, ...this.args], { windowsHide: true });
    this.proc = proc;
    proc.stdin.on('error', () => {});   // writing after it died: 'exit' reports that
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
    this.ready = new Promise((resolve, reject) => {
      proc.once('error', (e) => {
        if (this.proc === proc) this.proc = null;
        reject(new Error(`Could not start ${exe ? `the ${this.name} engine` : 'Python'} (${python}): ${e.message}`));
      });
      // Exiting before "ready" (e.g. numpy missing) must fail the waiting calls, not leave them hanging.
      proc.on('exit', (code) => {
        const err = new Error(`${this.name} engine stopped (code ${code}). ${lastLine(stderr)}`.trim());
        reject(err);
        if (this.proc !== proc) return;   // stopped on purpose: stop() already answered its calls
        this.proc = null;
        this.failAll(err);
      });
      readline.createInterface({ input: proc.stdout }).on('line', (line) => {
        let msg;
        try { msg = JSON.parse(line); } catch { return; }
        if (msg.type === 'ready') return resolve();
        const p = this.pending.get(msg.id);
        if (!p) return;
        if (msg.type === 'log') this.onLog(msg.msg, msg);
        else {
          this.pending.delete(msg.id);
          msg.type === 'result' ? p.resolve(msg.data) : p.reject(new Error(msg.msg));
        }
      });
    });
    this.ready.catch(() => {});
  }

  async call(cmd, payload = {}) {
    if (!this.proc) this.start();
    await this.ready;
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc.stdin.write(JSON.stringify({ id, cmd, ...payload }) + '\n');
    });
  }

  get busy() { return this.pending.size > 0; }

  // Also used after the Python path changes: the next call starts it again.
  stop() {
    const proc = this.proc;
    this.proc = null;
    proc?.kill();
    this.failAll(new Error(`${this.name} engine was restarted`));
  }

  failAll(err) {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }
}

// "Traceback ... ModuleNotFoundError: No module named 'numpy'" -> the useful last line
const lastLine = (s) => s.trim().split(/\r?\n/).pop() || '';

module.exports = { QuietLift, DEFAULTS, installScripts };
