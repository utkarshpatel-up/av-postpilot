// Auto-save: export the open project as .drp, and copy it to every enabled
// destination when its content changed since that destination's last copy.
// Layout: <destination>\[<PC>\]<library>\<project>\<project>_YYYY-MM-DD_HHMM.drp
// The PC folder is used on network drives (several PCs write there) and left
// out on local disks, unless the location says otherwise (pcFolder true/false).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fingerprint } = require('./drp-fingerprint');

function safeName(s) {
  const cleaned = String(s || 'Unnamed')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/[. ]+$/, '')
    .trim();
  return cleaned || 'Unnamed';
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

// Delete .drp files older than keepDays, but always keep the newest keepMin.
function prune(dir, keepDays, keepMin, log) {
  let files;
  try {
    files = fs.readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith('.drp'))
      .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
  } catch { return 0; }
  const cutoff = Date.now() - keepDays * 86400000;
  let removed = 0;
  for (const { f, t } of files.slice(keepMin)) {
    if (t < cutoff) {
      try { fs.unlinkSync(path.join(dir, f)); removed++; } catch (err) { log('warn', `could not delete old ${f}: ${err.message}`); }
    }
  }
  return removed;
}

class AutoSaver {
  constructor({ bridge, getSettings, state, saveState, log, onChange, tmpDir, isNetworkPath }) {
    Object.assign(this, { bridge, getSettings, state, saveState, log, onChange, tmpDir });
    this.isNetworkPath = isNetworkPath || (async (p) => /^[\\/]{2}/.test(p));
    this.timer = null;
    this.running = false;
    this.nextRunAt = null;
    this.last = null; // { time, project, result, saved, skipped, failed }
  }

  schedule() {
    clearTimeout(this.timer);
    const s = this.getSettings().autosave;
    if (!s.enabled) { this.nextRunAt = null; this.onChange(); return; }
    const ms = Math.max(1, Number(s.intervalMin) || 15) * 60000;
    this.nextRunAt = Date.now() + ms;
    this.timer = setTimeout(() => this.run('scheduled').finally(() => this.schedule()), ms);
    this.onChange();
  }

  summary() {
    return { running: this.running, nextRunAt: this.nextRunAt, last: this.last };
  }

  async run(reason = 'manual') {
    if (this.running) return { ok: false, message: 'A save is already running' };
    this.running = true;
    this.onChange();
    try {
      const result = await this.runOnce(reason);
      // Explain runs that saved nothing, but only when the reason changes,
      // so a quiet 15-minute loop doesn't flood the log.
      if (!result.saved && !result.failed && result.message !== this.last?.message) {
        this.log('info', `Auto-save: ${result.message}`);
      }
      this.last = { time: Date.now(), ...result };
      this.onResult?.(result);
      return result;
    } catch (err) {
      this.log('error', `Auto-save failed: ${err.message}`);
      this.last = { time: Date.now(), ok: false, message: err.message };
      return this.last;
    } finally {
      this.running = false;
      this.onChange();
    }
  }

  async runOnce(reason) {
    const settings = this.getSettings();
    const s = settings.autosave;
    const dests = (s.destinations || []).filter((d) => d.enabled && d.path);
    if (dests.length === 0) return { ok: false, message: 'No save location set. Add one on the Auto-save page.' };

    const st = await this.bridge.status();
    if (!st.connected) return { ok: false, message: 'Resolve is not connected' };
    if (!st.project) return { ok: false, message: 'No project open' };
    const project = st.project.name;
    if (s.skipUntitled && /^Untitled Project/i.test(project)) {
      return { ok: true, project, message: `Skipped "${project}" (not named yet)` };
    }
    const library = st.project.dbName || 'Unknown library';

    fs.mkdirSync(this.tmpDir, { recursive: true });
    const tmp = path.join(this.tmpDir, 'export.drp');
    try { fs.unlinkSync(tmp); } catch { /* none */ }

    let res = await this.bridge.exportProject(tmp);
    if (!res.ok) {
      // A project that was never saved can't be exported; save once and retry.
      await this.bridge.save().catch(() => {});
      res = await this.bridge.exportProject(tmp);
    }
    if (!res.ok || !fs.existsSync(tmp)) {
      this.log('error', `Could not export "${project}": ${res.error || 'no file written'}`);
      return { ok: false, project, message: `Export failed: ${res.error || 'no file written'}` };
    }

    const fp = fingerprint(tmp);
    const size = fs.statSync(tmp).size;
    const pc = safeName(os.hostname());
    let saved = 0, unchanged = 0, failed = 0;

    for (const d of dests) {
      const usePc = typeof d.pcFolder === 'boolean' ? d.pcFolder : await this.isNetworkPath(d.path);
      const rel = usePc
        ? path.join(pc, safeName(library), safeName(project))
        : path.join(safeName(library), safeName(project));
      const key = `${d.path}|${usePc ? 'pc' : 'nopc'}|${library}|${project}`;
      const prev = this.state.fp[key];
      if (prev && prev.fp === fp && prev.file && fs.existsSync(prev.file)) { unchanged++; continue; }

      if (!fs.existsSync(d.path)) {
        // Never create the destination root itself: if a NAS is offline that
        // would silently write to a wrong local folder.
        this.log('warn', `Save location not reachable, will retry: ${d.path}`);
        failed++;
        continue;
      }
      try {
        const dir = path.join(d.path, rel);
        fs.mkdirSync(dir, { recursive: true });
        let file = path.join(dir, `${safeName(project)}_${stamp()}.drp`);
        for (let n = 2; fs.existsSync(file); n++) file = path.join(dir, `${safeName(project)}_${stamp()}_${n}.drp`);
        fs.copyFileSync(tmp, file + '.part');
        if (fs.statSync(file + '.part').size !== size) throw new Error('copy is incomplete');
        fs.renameSync(file + '.part', file);
        this.state.fp[key] = { fp, file, time: Date.now() };
        saved++;
        this.log('info', `Saved "${project}" → ${file}`);
        const removed = prune(dir, s.keepDays, s.keepMin, this.log);
        if (removed) this.log('info', `Removed ${removed} old .drp from ${dir}`);
      } catch (err) {
        failed++;
        this.log('error', `Could not save to ${d.path}: ${err.message}`);
      }
    }
    this.saveState();

    let message;
    if (saved) message = `Saved "${project}" to ${saved} location(s)`;
    else if (unchanged && !failed) message = `"${project}" unchanged since last save`;
    else message = `"${project}" could not be saved`;
    if (unchanged && saved) message += `, ${unchanged} already up to date`;
    if (failed) message += `, ${failed} location(s) failed`;
    if (reason === 'manual' || saved || failed) this.log(failed ? 'warn' : 'info', message);
    return { ok: failed === 0, project, message, saved, unchanged, failed };
  }
}

module.exports = { AutoSaver, prune, safeName, stamp };
