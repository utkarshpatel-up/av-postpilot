// Keeps one fuscript.exe (Resolve's own Lua runner) alive with bridge.lua and
// sends it one command at a time. Commands are serialised so a long export never
// makes a status poll time out; a timed-out command restarts the bridge.
const { spawn } = require('child_process');
const readline = require('readline');
const fs = require('fs');
const path = require('path');

// JS value -> Lua table literal on one line. Strings are written byte by byte
// with \ddd escapes, so any path or title (UTF-8, quotes, newlines) is safe.
function toLua(v) {
  if (v === null || v === undefined) return 'nil';
  if (typeof v === 'boolean') return String(v);
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'nil';
  if (typeof v === 'string') {
    let s = '"';
    for (const b of Buffer.from(v, 'utf8')) {
      s += b < 32 || b > 126 || b === 34 || b === 92 ? `\\${String(b).padStart(3, '0')}` : String.fromCharCode(b);
    }
    return `${s}"`;
  }
  if (Array.isArray(v)) return `{${v.map(toLua).join(',')}}`;
  return `{${Object.entries(v).map(([k, x]) => `[${toLua(k)}]=${toLua(x)}`).join(',')}}`;
}

class ResolveBridge {
  constructor({ getFuscriptPath, luaFile, log }) {
    this.getFuscriptPath = getFuscriptPath;
    this.luaFile = luaFile;
    this.log = log;
    this.proc = null;
    this.queue = [];      // waiting { line, timeoutMs, resolve, reject }
    this.current = null;  // command sent, waiting for its answer
  }

  get busy() { return Boolean(this.current) || this.queue.length > 0; }

  start() {
    const exe = this.getFuscriptPath();
    if (!fs.existsSync(exe)) throw new Error(`Resolve scripting runner not found at ${exe}`);
    const proc = spawn(exe, ['-l', 'lua', this.luaFile], {
      windowsHide: true,
      cwd: path.dirname(this.luaFile),
    });
    this.proc = proc;
    readline.createInterface({ input: proc.stdout }).on('line', (line) => this.onLine(line));
    proc.stderr.on('data', (d) => this.log('warn', `bridge: ${String(d).trim()}`));
    proc.on('error', (err) => this.log('error', `bridge failed to start: ${err.message}`));
    proc.on('exit', () => {
      if (this.proc !== proc) return;
      this.proc = null;
      this.fail(new Error('bridge stopped'));
    });
  }

  stop() {
    const proc = this.proc;
    this.proc = null;
    if (proc) {
      try { proc.stdin.write('quit\n'); } catch { /* already gone */ }
      setTimeout(() => { try { proc.kill(); } catch { /* ignore */ } }, 1000);
    }
    this.fail(new Error('bridge stopped'));
  }

  fail(err) {
    const pending = [this.current, ...this.queue].filter(Boolean);
    this.current = null;
    this.queue = [];
    for (const c of pending) { clearTimeout(c.timer); c.reject(err); }
  }

  onLine(line) {
    if (!line.startsWith('{')) return;            // interpreter banner
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.ready) return;
    const c = this.current;
    if (!c) return;
    this.current = null;
    clearTimeout(c.timer);
    c.resolve(msg);
    this.pump();
  }

  pump() {
    if (this.current || this.queue.length === 0) return;
    if (!this.proc) {
      try { this.start(); } catch (err) { this.fail(err); return; }
    }
    const c = this.queue.shift();
    this.current = c;
    c.timer = setTimeout(() => {
      this.log('warn', `Resolve did not answer "${c.line.split('\t')[0]}" in time, restarting bridge`);
      const proc = this.proc;
      this.proc = null;
      this.current = null;
      c.reject(new Error('timed out'));
      if (proc) try { proc.kill(); } catch { /* ignore */ }
      this.pump();
    }, c.timeoutMs);
    this.proc.stdin.write(c.line + '\n');
  }

  request(line, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      this.queue.push({ line, timeoutMs, resolve, reject });
      this.pump();
    });
  }

  status() { return this.request('status', 15000); }
  stabilize(args) { return this.request(`stabilize\t${toLua(args)}`, 60000); }
  premiere(args) { return this.request(`premiere	${toLua(args)}`, 10 * 60 * 1000); }
  clipInfo() { return this.request('clipinfo', 5000); }
  setupProject(args) { return this.request(`setup\t${toLua(args)}`, 60 * 60 * 1000); }
  createSeries(args) { return this.request(`series\t${toLua(args)}`, 10 * 60 * 1000); }
  barsStill(dir) { return this.request(`barsstill	${toLua({ dir })}`, 2 * 60 * 1000); }
  listTimelines() { return this.request('timelines', 30000); }
  renderPresets() { return this.request('presets', 30000); }
  startHdBatch(args) { return this.request(`hdbatch\t${toLua(args)}`, 30 * 60 * 1000); }
  encodeStart(args) { return this.request(`encstart\t${toLua(args)}`, 5 * 60 * 1000); }
  encoderBegin(args) { return this.request(`encbegin\t${toLua(args)}`, 60000); }
  encoderFinish(args) { return this.request(`encfinish\t${toLua(args)}`, 60000); }
  jobStatus(id, token) { return this.request(`jobstatus\t${toLua({ id, token })}`, 30000); }
  stopRendering() { return this.request('stoprender', 30000); }
  startRendering(ids) { return this.request(`startrender	${toLua({ ids })}`, 60000); }
  hdCleanup(args) { return this.request(`hdcleanup\t${toLua(args)}`, 5 * 60 * 1000); }
  detectSceneCuts(name) { return this.request(`detect\t${toLua({ name })}`, 6 * 60 * 60 * 1000); }
  renameSeries(args) { return this.request(`rename\t${toLua(args)}`, 10 * 60 * 1000); }
  save() { return this.request('save', 60000); }
  chainImport(args) { return this.request(`chainimport	${toLua(args)}`, 5 * 60 * 1000); }
  exportProject(file) { return this.request(`export\t${file}`, 10 * 60 * 1000); }
}

module.exports = { ResolveBridge, toLua };
