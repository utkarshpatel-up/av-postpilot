// Media-Encoder-style queue inside PostPilot, using Resolve as the engine.
// Groups have a preset + output folder (+ optional file-name suffix); each file
// inherits them unless it has its own preset/output. Files are encoded one
// after another; each gets a temporary timeline matching its frame rate and
// size, rendered with the preset. Temporary items are removed when the run ends.
const fs = require('fs');
const path = require('path');
const { fmt } = require('./renders');

const VIDEO = /\.(mov|mp4|mxf|m4v|avi|mkv|mts|m2ts|braw|r3d|crm|wmv|mpg|mpeg|webm|mpeg4)$/i;
const uid = () => Math.random().toString(36).slice(2, 10);

function listVideos(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else if (VIDEO.test(e.name)) out.push(p);
    }
  };
  walk(dir);
  return out.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

// Output name: source name + suffix; if anything with that name already exists
// in the folder (any extension), add " (2)", " (3)"… so nothing is overwritten.
function outputName(dir, file, suffix) {
  const base = `${path.parse(file).name}${suffix || ''}`;
  let taken = [];
  try { taken = fs.readdirSync(dir).map((f) => path.parse(f).name.toLowerCase()); } catch { /* folder checked later */ }
  let name = base;
  for (let n = 2; taken.includes(name.toLowerCase()); n++) name = `${base} (${n})`;
  return name;
}

class Encoder {
  constructor({ bridge, notifier, log, onChange, onQueueDone, getSettings, loadState, saveState, pollMs = 2000 }) {
    Object.assign(this, { bridge, notifier, log, onChange, onQueueDone, getSettings, saveState, pollMs });
    const saved = loadState() || {};
    this.groups = (saved.groups || []).map((g) => ({
      ...g,
      // anything interrupted by closing the app goes back to waiting
      items: (g.items || []).map((i) => (i.state === 'encoding' ? { ...i, state: 'waiting', pct: 0 } : i)),
    }));
    this.running = false;
    this.stopping = false;
    this.currentJob = null;
    this.ids = new Set();             // Resolve job ids made by the encoder
  }

  summary() { return { groups: this.groups, running: this.running, stopping: this.stopping }; }
  changed() { this.saveState({ groups: this.groups }); this.onChange(); }

  group(id) { const g = this.groups.find((x) => x.id === id); if (!g) throw new Error('group not found'); return g; }

  addGroup(fields = {}) {
    const g = { id: uid(), name: fields.name || `Group ${this.groups.length + 1}`, preset: fields.preset || '', dir: fields.dir || '', suffix: fields.suffix || '', items: [] };
    this.groups.push(g);
    this.changed();
    return g;
  }

  updateGroup(id, fields) {
    const g = this.group(id);
    for (const k of ['name', 'preset', 'dir', 'suffix']) if (k in fields) g[k] = fields[k];
    this.changed();
  }

  removeGroup(id) {
    const g = this.group(id);
    if (g.items.some((i) => i.state === 'encoding')) throw new Error('This group is encoding right now');
    this.groups = this.groups.filter((x) => x !== g);
    this.changed();
  }

  // paths: files and/or folders (folders add their video files, including subfolders)
  addPaths(groupId, paths) {
    const g = this.group(groupId);
    let added = 0, skipped = 0;
    for (const p of paths) {
      let files = [];
      try { files = fs.statSync(p).isDirectory() ? listVideos(p) : [p]; } catch { skipped++; continue; }
      for (const f of files) {
        if (!VIDEO.test(f)) { skipped++; continue; }
        g.items.push({ id: uid(), file: f, preset: '', dir: '', state: 'waiting', pct: 0 });
        added++;
      }
    }
    this.changed();
    return { added, skipped };
  }

  updateItem(groupId, itemId, fields) {
    const it = this.group(groupId).items.find((i) => i.id === itemId);
    if (!it) throw new Error('file not found');
    for (const k of ['preset', 'dir']) if (k in fields) it[k] = fields[k];
    if (fields.requeue && it.state !== 'encoding') Object.assign(it, { state: 'waiting', pct: 0, error: '', output: '' });
    this.changed();
  }

  removeItem(groupId, itemId) {
    const g = this.group(groupId);
    const it = g.items.find((i) => i.id === itemId);
    if (it && it.state === 'encoding') throw new Error('This file is encoding right now');
    g.items = g.items.filter((i) => i.id !== itemId);
    this.changed();
  }

  clearFinished() {
    for (const g of this.groups) g.items = g.items.filter((i) => i.state === 'waiting' || i.state === 'encoding');
    this.groups = this.groups.filter((g) => g.items.length);
    this.changed();
  }

  // What a file will actually use (its own settings, else the group's).
  effective(g, it) { return { preset: it.preset || g.preset, dir: it.dir || g.dir }; }

  async stop() {
    if (!this.running) return;
    this.stopping = true;
    this.onChange();
  }

  async start() {
    if (this.running) return { ok: false, error: 'Already running' };
    const todo = [];
    for (const g of this.groups) for (const it of g.items) if (it.state === 'waiting') todo.push([g, it]);
    if (!todo.length) return { ok: false, error: 'Nothing waiting in the queue' };
    const missing = todo.find(([g, it]) => !this.effective(g, it).preset || !this.effective(g, it).dir);
    if (missing) return { ok: false, error: `"${path.basename(missing[1].file)}" has no preset or output folder` };

    this.running = true;
    this.stopping = false;
    this.onChange();
    const d = new Date();
    const p2 = (n) => String(n).padStart(2, '0');
    const folder = `PostPilot Encoder temp ${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
    const started = Date.now();
    let done = 0, failed = 0, n = 0;
    this.log('info', `Encoder started: ${todo.length} file(s)`);
    try {
      for (const g of this.groups) {
        let groupDone = 0, groupFailed = 0;
        for (const it of g.items) {
          if (it.state !== 'waiting') continue;
          if (this.stopping) break;
          n++;
          const ok = await this.encodeOne(g, it, folder, n);
          if (ok) { done++; groupDone++; } else { failed++; groupFailed++; }
        }
        if (groupDone + groupFailed > 0) {
          this.notifier.notify('encoderGroupDone', `🎞️ Encoder: "${g.name}" done: ${groupDone} file(s)${groupFailed ? `, ${groupFailed} failed` : ''}\nPreset: ${g.preset}`);
        }
        if (this.stopping) break;
      }
    } finally {
      const c = await this.bridge.hdCleanup({ folder }).catch((err) => ({ ok: false, error: err.message }));
      if (!c.ok) this.log('warn', `Encoder: temporary bin "${folder}" could not be removed${c.error ? `: ${c.error}` : ''}`);
      const stopped = this.stopping;
      this.running = false;
      this.stopping = false;
      this.changed();
      const msg = `Encoder ${stopped ? 'stopped' : 'finished'}: ${done} done${failed ? `, ${failed} failed` : ''} in ${fmt(Date.now() - started)}`;
      this.log('info', msg);
      this.notifier.notify('encoderQueueDone', `🎬 ${msg}`);
      if (!stopped) this.onQueueDone(this.getSettings().encoder.afterQueue, 'encoder queue');
    }
    return { ok: true, done, failed };
  }

  async encodeOne(g, it, folder, n) {
    const { preset, dir } = this.effective(g, it);
    Object.assign(it, { state: 'encoding', pct: 0, error: '', output: '', startedAt: Date.now() });
    this.changed();
    try {
      if (!fs.existsSync(it.file)) throw new Error('source file not found');
      if (!fs.existsSync(dir)) throw new Error(`output folder not reachable: ${dir}`);
      const name = outputName(dir, it.file, g.suffix);
      const r = await this.bridge.encodeStart({ folder, timeline: `${folder} ${n}`, file: it.file, preset, dir, name });
      if (!r.ok) throw new Error(r.error);
      this.ids.add(r.id);
      this.currentJob = r.id;
      it.info = [r.resolution, r.fps ? `${r.fps} fps` : ''].filter(Boolean).join(' · ');
      for (;;) {
        await new Promise((res) => setTimeout(res, this.pollMs));
        const s = await this.bridge.jobStatus(r.id).catch(() => null);
        if (!s || !s.ok) continue;
        if (s.status === 'Complete') {
          Object.assign(it, { state: 'done', pct: 100, output: s.dir && s.file ? path.join(s.dir, s.file) : '', tookMs: s.tookMs });
          this.log('info', `Encoded ${path.basename(it.file)} → ${it.output} (${preset}, ${fmt(s.tookMs)})`);
          return true;
        }
        if (s.status === 'Failed' || s.status === 'Cancelled') throw new Error(s.status === 'Cancelled' ? 'cancelled in Resolve' : (s.error || 'render failed'));
        if (typeof s.percent === 'number' && s.percent !== it.pct) { it.pct = s.percent; this.onChange(); }
      }
    } catch (err) {
      Object.assign(it, { state: 'failed', error: err.message });
      this.log('error', `Encoder: ${path.basename(it.file)} failed: ${err.message}`);
      return false;
    } finally {
      this.currentJob = null;
      this.changed();
    }
  }
}

module.exports = { Encoder, listVideos, outputName, VIDEO };
