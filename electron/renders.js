// Watches Resolve's render queue (via the status poll) and acts when jobs finish:
// notify, copy the rendered file to a chosen folder, and after the whole queue
// optionally shut down. Only status changes seen while the app runs count, so
// old "Complete" jobs never trigger anything.
const fs = require('fs');
const path = require('path');

const fmt = (ms) => {
  if (!ms && ms !== 0) return '';
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}h ${m}m` : m ? `${m}m ${r}s` : `${r}s`;
};

async function copyVerified(src, destDir, onProgress) {
  const dest = path.join(destDir, path.basename(src));
  let target = dest;
  for (let n = 2; fs.existsSync(target); n++) {
    const p = path.parse(dest);
    target = path.join(p.dir, `${p.name} (${n})${p.ext}`);
  }
  const size = fs.statSync(src).size;
  const part = `${target}.part`;
  await new Promise((resolve, reject) => {
    let done = 0;
    const rs = fs.createReadStream(src, { highWaterMark: 8 * 1024 * 1024 });
    const ws = fs.createWriteStream(part);
    rs.on('data', (c) => { done += c.length; onProgress?.(done, size); });
    rs.on('error', reject); ws.on('error', reject); ws.on('finish', resolve);
    rs.pipe(ws);
  });
  if (fs.statSync(part).size !== size) { fs.rmSync(part, { force: true }); throw new Error('copy is incomplete'); }
  fs.renameSync(part, target);
  return target;
}

class RenderWatcher {
  // settleMs: how long Resolve must stay idle before the queue counts as finished.
  // Between two jobs Resolve briefly reports "not rendering"; without this wait a
  // queue of episodes would look finished after the first one.
  // startHd(jobs) -> { ok, ids, problems, error }: queues the HD review renders.
  // finishHd(batch) -> { files, problems }: rename/copy HD files, remove temporary items.
  // ignore(id) -> true for jobs another feature (the Encoder) made: not episodes.
  constructor({ getSettings, notifier, log, onChange, onQueueDone, startHd, finishHd, ignore, settleMs = 15000 }) {
    Object.assign(this, { getSettings, notifier, log, onChange, onQueueDone, startHd, finishHd, ignore, settleMs });
    this.idleSince = null;
    this.hdIds = new Set();         // jobs PostPilot added for the HD pass
    this.seen = new Map();          // jobId -> last status
    this.finished = [];             // jobs completed during this run of the queue
    this.copies = new Map();        // jobId -> { state, file, error, pct }
    this.pendingCopies = 0;
    this.wasRendering = false;
    this.project = null;
  }

  summary() {
    return { copies: [...this.copies.entries()].map(([id, c]) => ({ id, ...c })), pendingCopies: this.pendingCopies };
  }

  update(status) {
    if (!status.connected || !status.project) return;
    // Project name only: while rendering, Resolve stops reporting the library
    // name, and treating that as a project switch would lose finished jobs.
    const key = status.project.name;
    if (key !== this.project) {           // project switched: just learn current states
      this.project = key;
      this.seen.clear();
      for (const j of status.jobs || []) this.seen.set(j.id, j.status);
      this.wasRendering = status.rendering;
      return;
    }
    let changed = false;
    for (const j of status.jobs || []) {
      if (this.ignore?.(j.id)) continue;
      const before = this.seen.get(j.id);
      this.seen.set(j.id, j.status);
      if (before === j.status || before === undefined) continue;
      changed = true;
      if (j.status === 'Complete') this.jobDone(j, status.project.name);
      if (j.status === 'Cancelled') this.cancelled = true;
      if (j.status === 'Failed' || j.status === 'Cancelled') {
        this.log('warn', `Render ${j.status.toLowerCase()}: ${j.file || j.name}`);
        this.notifier.notify('renderFailed', `⚠️ Render ${j.status.toLowerCase()}: ${j.file || j.name}\nProject: ${status.project.name}`);
      }
    }
    // Queue state: "active" from the first sign of rendering (or a finished job,
    // since a short job can start and finish between two polls) until Resolve
    // has stayed idle for settleMs with no job changing.
    if (status.rendering) {
      if (!this.active && !this.finished.length) this.cancelled = false;   // a fresh run
      this.active = true;
      this.idleSince = null;
    } else if (changed) {
      this.idleSince = Date.now();                    // something just finished: start the wait
    } else if ((this.active || this.finished.length) && this.idleSince === null) {
      this.idleSince = Date.now();
    }
    if (!status.rendering && this.idleSince !== null && (this.active || this.finished.length)
        && Date.now() - this.idleSince >= this.settleMs) {
      this.idleSince = null;
      this.active = false;
      this.settling = true;
      this.queueStopped(status).finally(() => { this.settling = false; });
    }
    this.wasRendering = status.rendering;
  }

  jobDone(j, project) {
    const file = j.dir && j.file ? path.join(j.dir, j.file) : null;
    this.finished.push(j);
    if (this.hdIds.has(j.id)) {
      // HD batch job: its files are renamed, copied and reported by finishHd.
      this.log('info', `HD review job finished in ${fmt(j.tookMs)}`);
      return;
    }
    this.log('info', `Rendered: ${j.file || j.name} in ${fmt(j.tookMs)}`);
    this.notifier.notify('renderDone', `✅ Rendered: ${j.file || j.name}\nTimeline: ${j.timeline}\nTime: ${fmt(j.tookMs)}\nProject: ${project}`);
    const r = this.getSettings().renders;
    if (r.copyEnabled && r.copyDest && file) this.copy(j, file, r.copyDest);
  }

  // Which finished main renders get an HD review version.
  hdCandidates(jobs) {
    const hd = this.getSettings().renders.hd || {};
    return jobs.filter((j) => !this.hdIds.has(j.id) && (!hd.onlyUhd || (Number(j.width) || 0) > 1920));
  }

  async copy(j, file, destDir) {
    this.pendingCopies++;
    const entry = { state: 'copying', file: path.basename(file), pct: 0 };
    this.copies.set(j.id, entry);
    this.onChange();
    try {
      if (!fs.existsSync(file)) throw new Error(`rendered file not found: ${file}`);
      if (!fs.existsSync(destDir)) throw new Error(`copy folder not reachable: ${destDir}`);
      let last = 0;
      const target = await copyVerified(file, destDir, (done, size) => {
        const pct = Math.floor((done / size) * 100);
        if (pct !== last) { last = pct; entry.pct = pct; this.onChange(); }
      });
      Object.assign(entry, { state: 'copied', pct: 100, target });
      this.log('info', `Copied ${path.basename(file)} → ${target}`);
      this.notifier.notify('renderCopied', `📁 Copied: ${path.basename(file)}\nTo: ${destDir}`);
    } catch (err) {
      Object.assign(entry, { state: 'failed', error: err.message });
      this.log('error', `Copy of ${path.basename(file)} failed: ${err.message}`);
      this.notifier.notify('renderFailed', `⚠️ Copy failed: ${path.basename(file)}\n${err.message}`);
    } finally {
      this.pendingCopies--;
      this.onChange();
    }
  }

  async queueStopped(status) {
    const finished = this.finished;
    const done = finished.length;
    const stopped = this.cancelled;
    this.cancelled = false;
    if (!done) return;
    this.finished = [];
    const wasHdPass = finished.every((j) => this.hdIds.has(j.id));
    while (this.pendingCopies > 0) await new Promise((r) => setTimeout(r, 1000));   // copies first
    if (wasHdPass) {
      // Rename the HD files, copy them, remove the temporary bin/timeline.
      const batch = this.hdBatch;
      this.hdBatch = null;
      let res = { files: [], problems: [] };
      if (batch && !stopped && this.finishHd) {
        try { res = await this.finishHd(batch); } catch (err) { res.problems.push(err.message); }
      }
      for (const p of res.problems) this.log('warn', `HD review: ${p}`);
      const files = res.files.map((f) => `• ${path.basename(f)}`).join('\n');
      this.notifier.notify('queueDone', `🔁 HD review ${stopped ? 'stopped' : 'finished'}: ${res.files.length} file(s)\n${files}${res.problems.length ? `\n⚠️ ${res.problems.length} problem(s), see Activity` : ''}\nProject: ${status.project.name}`);
      this.log('info', `HD review ${stopped ? 'stopped' : 'finished'} (${res.files.length} file(s))`);
      if (!stopped) this.onQueueDone(this.getSettings().renders.afterQueue, 'render queue');
      return;
    }
    const list = finished.map((j) => `• ${j.file || j.name}`).join('\n');
    this.notifier.notify('queueDone', `🎬 Render ${stopped ? 'stopped' : 'finished'}: ${done} job(s) done\n${list}\nProject: ${status.project.name}`);
    this.log('info', `Render ${stopped ? 'stopped' : 'finished'} (${done} job(s))`);
    // Someone pressed Stop: they're at the PC, so never continue or shut down.
    if (stopped) return;

    // Optional second pass: HD review versions of the main renders. If it can't
    // start, report it and carry on, so it never blocks the rest of the night.
    const hd = this.getSettings().renders.hd || {};
    if (!wasHdPass && hd.enabled && this.startHd) {
      const todo = this.hdCandidates(finished);
      if (todo.length) {
        try {
          const r = await this.startHd(todo);
          for (const p of r.problems || []) this.log('warn', `HD review: ${p}`);
          if (r.ok) {
            // Known from the start, so even an HD job that finishes before the
            // next poll is still counted as a change to "Complete".
            r.ids.forEach((id) => { this.hdIds.add(id); this.seen.set(id, 'Queued'); });
            this.hdBatch = r.batch;
            this.active = true;           // the queue continues with the HD jobs
            this.log('info', `HD review: ${todo.length} episode(s) rendering with preset "${hd.preset}" (${r.mode === 'individual' ? 'one job, individual clips' : `${r.ids.length} job(s)`})`);
            this.notifier.notify('queueDone', `🔁 Starting HD review of ${todo.length} episode(s) (${hd.preset})`);
            return;                       // the after-queue action waits for these
          }
          throw new Error(r.error || 'could not start');
        } catch (err) {
          this.log('error', `HD review renders not started: ${err.message}`);
          this.notifier.notify('renderFailed', `⚠️ HD review renders not started: ${err.message}`);
        }
      }
    }
    this.onQueueDone(this.getSettings().renders.afterQueue, 'render queue');
  }
}

module.exports = { RenderWatcher, copyVerified, fmt };
