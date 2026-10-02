// Scene cut detection queue: runs Resolve's "Detect Scene Cuts" on several
// timelines one after another. Resolve is busy while it runs, so the queue
// pauses auto-save and status checks (they wait in the bridge queue).
const { fmt } = require('./renders');

class SceneQueue {
  constructor({ bridge, notifier, log, onChange, onQueueDone, getSettings }) {
    Object.assign(this, { bridge, notifier, log, onChange, onQueueDone, getSettings });
    this.items = [];          // { name, state: waiting|running|done|failed|skipped, cuts, seconds, error }
    this.running = false;
    this.stopAfterCurrent = false;
    this.project = null;
  }

  summary() {
    return { items: this.items, running: this.running, stopping: this.stopAfterCurrent, project: this.project };
  }

  add(project, names) {
    if (this.project && this.project !== project && this.items.some((i) => i.state === 'waiting')) {
      throw new Error(`The queue holds timelines from "${this.project}". Clear it first.`);
    }
    this.project = project;
    for (const name of names) {
      if (!this.items.some((i) => i.name === name && (i.state === 'waiting' || i.state === 'running'))) {
        this.items.push({ name, state: 'waiting' });
      }
    }
    this.onChange();
  }

  remove(index) {
    if (this.items[index] && this.items[index].state !== 'running') this.items.splice(index, 1);
    if (!this.items.length) this.project = null;
    this.onChange();
  }

  clearFinished() {
    this.items = this.items.filter((i) => i.state === 'waiting' || i.state === 'running');
    if (!this.items.length) this.project = null;
    this.onChange();
  }

  stop() { if (this.running) { this.stopAfterCurrent = true; this.onChange(); } }

  async start(currentProject) {
    if (this.running) return { ok: false, error: 'Already running' };
    if (!this.items.some((i) => i.state === 'waiting')) return { ok: false, error: 'Nothing waiting in the queue' };
    if (currentProject !== this.project) {
      return { ok: false, error: `Open the project "${this.project}" in Resolve first (the queue belongs to it).` };
    }
    this.running = true;
    this.stopAfterCurrent = false;
    this.onChange();
    const started = Date.now();
    let done = 0, failed = 0;
    this.log('info', `Scene cut queue started (${this.items.filter((i) => i.state === 'waiting').length} timeline(s))`);
    try {
      for (const item of this.items) {
        if (item.state !== 'waiting') continue;
        if (this.stopAfterCurrent) break;
        item.state = 'running';
        item.startedAt = Date.now();
        this.onChange();
        try {
          const r = await this.bridge.detectSceneCuts(item.name);
          if (!r.ok) throw new Error(r.error);
          Object.assign(item, { state: 'done', cuts: Math.max(0, r.after - r.before), seconds: r.seconds });
          done++;
          this.log('info', `Scene cuts on ${item.name}: ${item.cuts} cut(s) in ${fmt(r.seconds * 1000)}`);
          this.notifier.notify('sceneDone', `✂️ Scene cuts done: ${item.name}\n${item.cuts} cut(s) · ${fmt(r.seconds * 1000)}\nProject: ${this.project}`);
        } catch (err) {
          Object.assign(item, { state: 'failed', error: err.message });
          failed++;
          this.log('error', `Scene cuts failed on ${item.name}: ${err.message}`);
          this.notifier.notify('sceneDone', `⚠️ Scene cuts failed: ${item.name}\n${err.message}`);
        }
        this.onChange();
      }
    } finally {
      const stopped = this.stopAfterCurrent;
      this.running = false;
      this.stopAfterCurrent = false;
      this.onChange();
      const msg = `Scene cut queue ${stopped ? 'stopped' : 'finished'}: ${done} done${failed ? `, ${failed} failed` : ''} in ${fmt(Date.now() - started)}`;
      this.log('info', msg);
      this.notifier.notify('sceneQueueDone', `🎞️ ${msg}\nProject: ${this.project}`);
      if (!stopped) this.onQueueDone(this.getSettings().scene.afterQueue, 'scene cut queue');
    }
    return { ok: true, done, failed };
  }
}

module.exports = { SceneQueue };
