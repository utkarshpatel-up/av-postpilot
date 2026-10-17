// Night queue: scene cuts, stabilization, renders and the Encoder queue as steps
// that run one after another, with one "when everything finishes" choice.
// Each step uses the existing module; their own after-queue choices are ignored
// while this runs (see afterQueue in main.js). Stabilization only makes the
// stabilized copies: nothing is applied to a timeline without the editor's review.
const { fmt } = require('./renders');

const TYPES = { scene: 'Scene cuts', stab: 'Stabilize', render: 'Render', encode: 'Encode' };
const TERMINAL = ['Complete', 'Failed', 'Cancelled'];

class NightQueue {
  // deps: getStatus, sceneQueue, stabilization, encoder, renders, bridge, log, notifier,
  // onChange, loadState, saveState, onFinished(stopped), wait
  constructor(deps) {
    Object.assign(this, { wait: (ms) => new Promise((r) => setTimeout(r, ms)), pollMs: 3000, startTimeoutMs: 120000, quietStartMs: 20000 }, deps);
    const saved = this.loadState?.() || {};
    this.project = saved.project || null;
    // A step that was running when the app closed did not finish.
    this.steps = (saved.steps || []).map((s) => (s.state === 'running' ? { ...s, state: 'failed', error: 'PostPilot was closed while this step ran' } : s));
    this.running = false;
    this.stopping = false;
    this.current = null;
    this.nextId = Math.max(0, ...this.steps.map((s) => s.id)) + 1;
  }

  summary() {
    return { project: this.project, steps: this.steps.map((s) => ({ ...s, warning: this.warningFor(s) })), running: this.running, stopping: this.stopping, current: this.current };
  }
  changed() { this.saveState?.({ project: this.project, steps: this.steps }); this.onChange?.(this.summary()); }

  // Renders of a timeline that is also being stabilized use its original,
  // un-reviewed clips: the stabilized copies are only applied after review.
  stabNames() { return new Set(this.steps.filter((s) => s.type === 'stab').flatMap((s) => s.timelines.map((t) => t.name))); }
  warningFor(step) {
    if (step.type !== 'render') return '';
    const stab = this.stabNames();
    const both = [...new Set(step.jobs.filter((j) => stab.has(j.timeline)).map((j) => j.timeline))];
    return both.length ? `${both.map((n) => `"${n}"`).join(', ')} ${both.length > 1 ? 'are' : 'is'} also in the stabilization step. The render uses the original clips: stabilized clips are only applied after your review.` : '';
  }
  // What adding this step would conflict with (for a confirmation before adding).
  conflicts(type, data) {
    if (type === 'render') {
      const stab = this.stabNames();
      return [...new Set((data.jobs || []).filter((j) => stab.has(j.timeline)).map((j) => j.timeline))];
    }
    if (type === 'stab') {
      const names = new Set((data.timelines || []).map((t) => t.name));
      return [...new Set(this.steps.filter((s) => s.type === 'render').flatMap((s) => s.jobs).filter((j) => names.has(j.timeline)).map((j) => j.timeline))];
    }
    return [];
  }

  add(project, type, data = {}) {
    if (this.running) throw new Error('Wait for the night queue to finish');
    if (!TYPES[type]) throw new Error('Unknown step');
    if (type !== 'encode' && !project) throw new Error('Open the project in Resolve first');
    const waiting = this.steps.some((s) => s.state === 'waiting');
    if (project && this.project && this.project !== project && waiting) throw new Error(`The night queue holds steps for "${this.project}". Clear it first.`);
    if (project) this.project = project;
    let step;
    if (type === 'scene') {
      if (!data.timelines?.length) throw new Error('Tick at least one timeline');
      step = { timelines: [...data.timelines] };
    } else if (type === 'stab') {
      if (!data.timelines?.length) throw new Error('Tick at least one timeline');
      // One stabilization step: a second one would replace the first one's review list.
      const old = this.steps.find((s) => s.type === 'stab' && s.state === 'waiting');
      if (old) {
        for (const t of data.timelines) if (!old.timelines.some((o) => o.id === t.id)) old.timelines.push(t);
        old.color = data.color || old.color;
        this.changed();
        return old;
      }
      if (this.steps.some((s) => s.type === 'stab')) throw new Error('Clear the finished stabilization step first');
      step = { timelines: data.timelines.map((t) => ({ id: t.id, name: t.name })), color: data.color || 'All' };
    } else if (type === 'render') {
      if (!data.jobs?.length) throw new Error('Tick at least one render job');
      step = { jobs: data.jobs.map((j) => ({ id: j.id, name: j.name, timeline: j.timeline, file: j.file })) };
    } else if (this.steps.some((s) => s.type === 'encode' && s.state === 'waiting')) {
      throw new Error('The Encoder queue is already a step');
    }
    step = { id: this.nextId++, type, state: 'waiting', ...step };
    // Encoding closes the project, so it always stays last.
    const enc = this.steps.findIndex((s) => s.type === 'encode' && s.state === 'waiting');
    if (type !== 'encode' && enc >= 0) this.steps.splice(enc, 0, step); else this.steps.push(step);
    this.changed();
    return step;
  }

  remove(id) {
    const i = this.steps.findIndex((s) => s.id === id);
    if (i < 0 || (this.running && this.steps[i].state !== 'waiting') || this.steps[i] === this.current) return;
    this.steps.splice(i, 1);
    if (!this.steps.length) this.project = null;
    this.changed();
  }

  move(id, by) {
    if (this.running) return;
    const i = this.steps.findIndex((s) => s.id === id), j = i + by;
    if (i < 0 || j < 0 || j >= this.steps.length) return;
    if (this.steps[i].type === 'encode' || this.steps[j].type === 'encode') throw new Error('Encoding closes the project, so it stays the last step');
    [this.steps[i], this.steps[j]] = [this.steps[j], this.steps[i]];
    this.changed();
  }

  clearFinished() {
    if (this.running) return;
    this.steps = this.steps.filter((s) => s.state === 'waiting');
    if (!this.steps.length) this.project = null;
    this.changed();
  }

  // Problems that stop the queue from starting at all.
  check(project) {
    const todo = this.steps.filter((s) => s.state === 'waiting');
    if (!todo.length) return 'Nothing waiting in the night queue';
    if (todo.some((s) => s.type !== 'encode') && project !== this.project) return `Open the project "${this.project}" in Resolve first (the night queue belongs to it).`;
    if (todo.some((s) => s.type === 'stab') && this.stabilization.clips.some((c) => c.copyTimelineId && !c.copyDeleted && !c.approved && this.stabilization.canApprove(c))) {
      return 'The last stabilization still has clips to review on the Stabilization page. Review them (or delete their copies) first: the night queue would replace that list.';
    }
    if (todo.some((s) => s.type === 'encode') && !this.encoder.groups.some((g) => g.items.some((i) => i.state === 'waiting'))) return 'The Encoder step has no files waiting on the Encoder page';
    return '';
  }

  stop() { if (this.running) { this.stopping = true; this.changed(); } }

  async start() {
    if (this.running) return { ok: false, error: 'Already running' };
    const problem = this.check(this.getStatus().project?.name);
    if (problem) return { ok: false, error: problem };
    this.running = true;
    this.stopping = false;
    this.changed();
    const started = Date.now();
    let cancelled = false;
    this.log('info', `Night queue started: ${this.steps.filter((s) => s.state === 'waiting').map((s) => TYPES[s.type]).join(' → ')}`);
    try {
      for (const step of this.steps) {
        if (step.state !== 'waiting') continue;
        if (this.stopping) break;
        this.current = step;
        Object.assign(step, { state: 'running', startedAt: Date.now(), error: '', result: '' });
        this.changed();
        try {
          step.result = await this[`run_${step.type}`](step);
          step.state = 'done';
        } catch (err) {
          Object.assign(step, { state: 'failed', error: err.message });
          if (err.cancelled) cancelled = true;
          this.log('error', `Night queue: ${TYPES[step.type]} failed: ${err.message}`);
        }
        step.finishedAt = Date.now();
        this.current = null;
        this.changed();
        if (cancelled) break;   // someone stopped the render in Resolve: they're at the PC
      }
    } finally {
      const stopped = this.stopping || cancelled;
      this.running = false;
      this.stopping = false;
      this.current = null;
      this.changed();
      const lines = this.steps.filter((s) => s.startedAt >= started).map((s) => `${s.state === 'done' ? '✔' : '✖'} ${TYPES[s.type]}: ${s.state === 'done' ? s.result : s.error}`);
      const msg = `Night queue ${stopped ? 'stopped' : 'finished'} in ${fmt(Date.now() - started)}`;
      this.log('info', msg);
      this.notifier.notify('nightQueueDone', `🌙 ${msg}\n${lines.join('\n')}${this.project ? `\nProject: ${this.project}` : ''}`);
      this.onFinished?.(stopped);
    }
    return { ok: true };
  }

  async run_scene(step) {
    const project = this.getStatus().project?.name;
    this.sceneQueue.add(project, step.timelines);
    const before = new Map(this.sceneQueue.items.map((i) => [i, i.state]));
    const r = await this.sceneQueue.start(project);
    if (!r.ok) throw new Error(r.error);
    const mine = this.sceneQueue.items.filter((i) => step.timelines.includes(i.name) && before.get(i) === 'waiting');
    const failed = mine.filter((i) => i.state === 'failed');
    const cuts = mine.reduce((n, i) => n + (i.cuts || 0), 0);
    if (failed.length === mine.length && mine.length) throw new Error(failed.map((i) => `${i.name}: ${i.error}`).join('; '));
    return `${mine.length - failed.length}/${mine.length} timeline(s), ${cuts} cut(s)${failed.length ? `; failed: ${failed.map((i) => i.name).join(', ')}` : ''}`;
  }

  async run_stab(step) {
    const scan = await this.stabilization.scan(step.color, step.timelines.map((t) => t.id));
    const keys = scan.clips.filter((c) => !c.fusion).map((c) => c.key);
    if (!keys.length) return 'no marked clips to stabilize';
    await this.stabilization.start(keys);
    const run = this.stabilization.clips.filter((c) => keys.includes(c.key));
    const passed = run.filter((c) => c.status === 'Passed').length;
    const review = run.filter((c) => c.status === 'Needs review').length;
    const viaResolve = run.filter((c) => c.status === 'Stabilized (Resolve)').length;
    this.notifier.notify('stabQueueDone', `🎥 Stabilization finished: ${passed}/${run.length} passed${viaResolve ? `, ${viaResolve} via Resolve's stabilizer` : ''}${review ? `, ${review} need review` : ''}. Review and apply them on the Stabilization page.`);
    return `${passed}/${run.length} passed${viaResolve ? `, ${viaResolve} via Resolve` : ''}${review ? `, ${review} need review` : ''}; waiting for your review (nothing applied)`;
  }

  async run_render(step) {
    const ids = step.jobs.map((j) => j.id);
    const r = await this.bridge.startRendering(ids);
    if (!r.ok) throw new Error(r.error);
    // Done when Resolve has rendered and the Renders page has finished its work
    // (copies, HD review pass) for these jobs.
    const begun = Date.now();
    let seen = false;
    for (;;) {
      await this.wait(this.pollMs);
      const st = this.getStatus();
      const w = this.renders;
      const busy = st.rendering || w.active || w.settling || w.hdBatch || w.finished.length || w.pendingCopies;
      if (st.rendering || w.active || w.finished.length) seen = true;
      const jobs = (st.jobs || []).filter((j) => ids.includes(j.id));
      if (!busy && (seen || (jobs.length && jobs.every((j) => TERMINAL.includes(j.status)) && Date.now() - begun > this.quietStartMs))) break;
      if (!seen && Date.now() - begun > this.startTimeoutMs) throw new Error('Resolve did not start rendering');
    }
    const jobs = (this.getStatus().jobs || []).filter((j) => ids.includes(j.id));
    const count = (s) => jobs.filter((j) => j.status === s).length;
    if (count('Cancelled')) { const e = new Error(`render stopped in Resolve (${count('Complete')}/${ids.length} rendered)`); e.cancelled = true; throw e; }
    const why = jobs.find((j) => j.status === 'Failed' && j.error)?.error;
    if (count('Failed') === ids.length) throw new Error(`every render job failed${why ? `: ${why}` : ''}`);
    return `${count('Complete')}/${ids.length} job(s) rendered${count('Failed') ? `, ${count('Failed')} failed${why ? ` (${why})` : ''}` : ''}${r.missing ? `, ${r.missing} no longer in the render queue` : ''}`;
  }

  async run_encode() {
    const r = await this.encoder.start();
    if (!r.ok) throw new Error(r.error);
    if (r.cancelled) throw new Error('not started');
    if (!r.done && r.failed) throw new Error(`all ${r.failed} file(s) failed`);
    return `${r.done} file(s) encoded${r.failed ? `, ${r.failed} failed` : ''}`;
  }
}

module.exports = { NightQueue, TYPES };
