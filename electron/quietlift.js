// Quiet Lift: raises long quiet stretches of speech in a debleed track, and only the words in them.
// The work is done by quiet_lift.py through a JSON-lines bridge (quietlift/quiet_lift_bridge.py),
// one Python process that keeps the last analysis in memory so Render doesn't re-read the files.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const DEFAULTS = { python: '', editor: 'audition', editorPaths: {}, markInput: true, options: {}, dir: '' };
const FILES = ['quiet_lift.py', 'quiet_lift_bridge.py', 'wav_markers.py'];
const defaultPython = () => (process.platform === 'win32' ? 'python' : 'python3');

// Python can't read files inside the packaged app (asar): give it its own copy.
function installScripts(dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const f of FILES) fs.writeFileSync(path.join(dir, f), fs.readFileSync(path.join(__dirname, 'quietlift', f)));
  return path.join(dir, 'quiet_lift_bridge.py');
}

class QuietLift {
  constructor({ script, getPython = () => '', onLog = () => {} }) {
    this.script = script;
    this.getPython = getPython;
    this.onLog = onLog;
    this.proc = null;
    this.ready = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  start() {
    const python = this.getPython() || defaultPython();
    const proc = spawn(python, ['-u', this.script], { windowsHide: true });
    this.proc = proc;
    proc.stdin.on('error', () => {});   // writing after it died: 'exit' reports that
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
    this.ready = new Promise((resolve, reject) => {
      proc.once('error', (e) => {
        if (this.proc === proc) this.proc = null;
        reject(new Error(`Could not start Python (${python}): ${e.message}`));
      });
      // Exiting before "ready" (e.g. numpy missing) must fail the waiting calls, not leave them hanging.
      proc.on('exit', (code) => {
        const err = new Error(`Quiet Lift engine stopped (code ${code}). ${lastLine(stderr)}`.trim());
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
        if (msg.type === 'log') this.onLog(msg.msg);
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
    this.failAll(new Error('Quiet Lift engine was restarted'));
  }

  failAll(err) {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }
}

// "Traceback ... ModuleNotFoundError: No module named 'numpy'" -> the useful last line
const lastLine = (s) => s.trim().split(/\r?\n/).pop() || '';

module.exports = { QuietLift, DEFAULTS, installScripts };
