'use strict';
// PostPilot ⇄ Premiere Pro through the signed "AV PostPilot Link" helper.
// Install = copy the signed helper into the user's own CEP folder (no admin rights).
// Talk = job files in a per-user folder that the helper answers.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ID = 'com.avpostpilot.link';
const isWin = process.platform === 'win32';
const appData = () => process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const LINK = isWin ? path.join(appData(), 'av-postpilot-link') : path.join(os.homedir(), 'Library', 'Application Support', 'av-postpilot-link');
const EXT_DIR = isWin ? path.join(appData(), 'Adobe', 'CEP', 'extensions', ID) : path.join(os.homedir(), 'Library', 'Application Support', 'Adobe', 'CEP', 'extensions', ID);
const SOURCE = path.join(__dirname, 'premiere-link');

// Copy file by file: works from inside the packaged app (asar), keeps bytes exact for the signature.
function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const name of fs.readdirSync(from)) {
    const a = path.join(from, name), b = path.join(to, name);
    if (fs.statSync(a).isDirectory()) copyDir(a, b); else fs.writeFileSync(b, fs.readFileSync(a));
  }
}
const helperVersion = dir => { try { return (fs.readFileSync(path.join(dir, 'CSXS', 'manifest.xml'), 'utf8').match(/ExtensionBundleVersion="([^"]+)"/) || [])[1] || ''; } catch { return ''; } };

function findPremiere() {
  const roots = isWin ? [path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Adobe')] : ['/Applications'];
  const found = [];
  for (const r of roots) {
    let dirs = []; try { dirs = fs.readdirSync(r); } catch { continue; }
    for (const d of dirs.filter(x => /^Adobe Premiere Pro( \d{4})?$/.test(x))) {
      const exe = isWin ? path.join(r, d, 'Adobe Premiere Pro.exe') : path.join(r, d, `${d}.app`);
      if (fs.existsSync(exe)) found.push({ exe, year: +(d.match(/\d{4}/) || [0])[0] });
    }
  }
  return found.sort((a, b) => b.year - a.year)[0]?.exe || '';
}

class PremiereLink {
  constructor({ log = () => {}, spawn = require('child_process').spawn, wait = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
    Object.assign(this, { log, spawn, wait });
  }
  installed() { return helperVersion(EXT_DIR); }
  install() {
    const want = helperVersion(SOURCE);
    if (!want) throw Error('The Premiere helper is missing from this PostPilot build');
    fs.rmSync(EXT_DIR, { recursive: true, force: true });
    copyDir(SOURCE, EXT_DIR);
    fs.mkdirSync(path.join(LINK, 'jobs'), { recursive: true }); fs.mkdirSync(path.join(LINK, 'results'), { recursive: true });
    this.log('info', `Premiere link ${want} installed in ${EXT_DIR}`);
    return { ok: true, version: want, folder: EXT_DIR, alive: Boolean(this.alive()) };
  }
  alive() {
    try { const a = JSON.parse(fs.readFileSync(path.join(LINK, 'alive.json'), 'utf8')); return Date.now() - a.at < 8000 ? a : null; } catch { return null; }
  }
  status() {
    const a = this.alive();
    return { installed: this.installed(), bundled: helperVersion(SOURCE), premiere: findPremiere(), connected: Boolean(a), version: a?.version || '', project: a?.project || '', sequences: a?.sequences || [] };
  }
  async request(cmd, args = {}, timeoutMs = 120000) {
    const id = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const jobs = path.join(LINK, 'jobs'), result = path.join(LINK, 'results', `${id}.json`);
    fs.mkdirSync(jobs, { recursive: true });
    fs.writeFileSync(path.join(jobs, `${id}.json.tmp`), JSON.stringify({ id, cmd, args }));
    fs.renameSync(path.join(jobs, `${id}.json.tmp`), path.join(jobs, `${id}.json`));
    const until = Date.now() + timeoutMs; let nextDialogCheck = Date.now() + 5000; const seen = new Set();
    while (Date.now() < until) {
      if (fs.existsSync(result)) {
        const r = JSON.parse(fs.readFileSync(result, 'utf8')); fs.rmSync(result, { force: true });
        if (!r.ok) throw Error(`Premiere: ${r.error}`);
        return r;
      }
      if (!this.alive()) { fs.rmSync(path.join(jobs, `${id}.json`), { force: true }); throw Error('Premiere stopped answering (was it closed?)'); }
      // Premiere's "Load Project" notice (missing plugins) blocks scripting until closed.
      if (Date.now() > nextDialogCheck) {
        nextDialogCheck = Date.now() + 4000;
        for (const line of await this.dialogs()) {
          if (line.startsWith('pressed:')) this.log('info', 'Closed Premiere\'s "Load Project" notice (missing plugins are listed in the report)');
          else if (line.startsWith('seen:') && !seen.has(line)) { seen.add(line); this.log('warn', `Premiere shows "${line.slice(5)}": answer it in Premiere`); }
        }
      }
      await this.wait(400);
    }
    fs.rmSync(path.join(jobs, `${id}.json`), { force: true });
    throw Error(`Premiere did not answer within ${Math.round(timeoutMs / 1000)} s (is a dialog open in Premiere?)`);
  }
  dialogs() {
    if (!isWin) return Promise.resolve([]);
    const script = path.join(__dirname, 'premiere-dialogs.ps1');
    // From inside the packaged app the script sits in the asar; run it from a temp copy.
    const file = path.join(os.tmpdir(), 'postpilot-premiere-dialogs.ps1');
    try { fs.writeFileSync(file, fs.readFileSync(script)); } catch { return Promise.resolve([]); }
    return new Promise(resolve => require('child_process').execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file],
      { windowsHide: true, timeout: 20000 }, (err, out) => resolve(err ? [] : String(out).split(/\r?\n/).filter(Boolean))));
  }
  // Start Premiere if needed and wait for the helper to answer.
  async ensureRunning(timeoutMs = 4 * 60 * 1000) {
    if (this.alive()) return true;
    if (!this.installed()) throw Error('Set up the Premiere link first (Premiere Import page)');
    const exe = findPremiere(); if (!exe) throw Error('Premiere Pro is not installed on this PC');
    this.log('info', `Starting ${path.basename(exe)} for the Premiere link`);
    const child = isWin ? this.spawn(exe, [], { detached: true, stdio: 'ignore' }) : this.spawn('open', ['-a', exe], { detached: true, stdio: 'ignore' });
    child.unref?.();
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) { if (this.alive()) return true; await this.wait(2000); }
    throw Error('Premiere started but the PostPilot link did not answer. Restart Premiere once after setting up the link.');
  }
  // Open the project (if needed), export Final Cut Pro XML for each sequence, close it again if we opened it.
  // A project kept open in Premiere for several jobs; release() closes it only if we opened it.
  async session(project) {
    await this.ensureRunning();
    const before = this.alive();
    const opened = await this.request('open', { path: project }, 10 * 60 * 1000);
    return { project: opened.project || project, close: Boolean(opened.opened && (!before || before.project !== opened.project)) };
  }
  async release(s) { if (s && s.close) await this.request('close', { project: s.project }).catch(() => {}); }
  async exportXml(project, dir, names = [], session = null) {
    const s = session || await this.session(project);
    try {
      const r = await this.request('export', { project: s.project, dir: dir.replace(/\\/g, '/'), names }, 15 * 60 * 1000);
      return r.files.map(f => ({ ...f, file: path.normalize(f.file) }));
    } finally { if (!session) await this.release(s); }
  }
  // One sequence frame as PNG, and the same frame without the clip at { track, start }.
  async frame(s, sequence, frame, file, without, withoutFile) {
    const r = await this.request('export', { project: s.project, sequence, frame, file, without, withoutFile }, 3 * 60 * 1000);
    if (!r.ok || (without && !r.without)) throw Error('Premiere did not export the frame');
    return r;
  }
}

module.exports = { PremiereLink, findPremiere, LINK, EXT_DIR };
