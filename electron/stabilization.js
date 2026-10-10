const { pickPoints, consensus, verdict, describe } = require('./stabilization-points');
// Marked clips -> timeline copy -> per clip: pick fixed points from 3 frames, track
// them all in one Fusion pass, keep the points that agree, Match Move on those.
class Stabilization {
  constructor({ bridge, log, onChange, grab, saveReport = () => {}, wait = ms => new Promise(r => setTimeout(r, ms)) }) {
    Object.assign(this, { bridge, log, onChange, grab, saveReport, wait }); this.running = false; this.stopping = false; this.clips = []; this.timeline = '';
  }
  summary() { return { running: this.running, stopping: this.stopping, hasCopy: Boolean(this.hasCopy), clips: this.clips, timeline: this.timeline }; }
  changed() { this.onChange(this.summary()); }
  async scan(color) {
    if (this.running) throw new Error('Wait for stabilization to finish');
    const result = await this.bridge.stabilize({ action: 'scan', color });
    if (result.ok) { this.hasCopy = false; this.clips = result.clips.map(c => ({ ...c, status: c.fusion ? 'Existing Fusion — manual review' : 'Ready', selected: !c.fusion })); this.timeline = result.timeline; this.changed(); }
    return result;
  }
  // anchors: optional [{key,x,y,width,height}] chosen by the editor; tracked as extra points.
  async start(keys, anchors = []) {
    if (this.running) throw new Error('Stabilization is already running');
    if (this.hasCopy) throw new Error('Find marked clips again before starting another batch');
    const selected = this.clips.filter(c => keys.includes(c.key));
    if (!selected.length) throw new Error('Choose at least one clip');
    if (selected.some(c => c.fusion)) throw new Error('Clips with existing Fusion effects are kept for manual review');
    for (const a of anchors) if (!Number.isFinite(a.x) || !Number.isFinite(a.y) || a.x <= .03 || a.x >= .97 || a.y <= .03 || a.y >= .97) throw new Error('Keep chosen points away from the frame edges');
    this.running = true; this.stopping = false; this.changed();
    try {
      const begin = await this.bridge.stabilize({ action: 'begin' });
      if (!begin.ok) throw new Error(begin.error); this.timeline = begin.timeline; this.hasCopy = true;
      for (const clip of selected) {
        if (this.stopping) { clip.status = 'Not started'; this.changed(); continue; }
        await this.stabilizeClip(clip, anchors.filter(a => a.key === clip.key));
      }
      const finished = await this.bridge.stabilize({ action: 'finish' });
      if (!finished.ok) throw new Error(finished.error);
      this.log('info', `Stabilization finished in "${this.timeline}": ${selected.filter(c => c.status === 'Passed').length}/${selected.length} passed`);
    } catch (error) { this.log('error', `Stabilization stopped: ${error.message}. Timeline copy retained.`); throw error; }
    finally { this.running = false; this.saveReport({ timeline: this.timeline, date: new Date().toISOString(), clips: this.clips }); this.changed(); }
    return { ok: true, ...this.summary() };
  }
  async stabilizeClip(clip, anchors) {
    const request = async args => { const r = await this.bridge.stabilize(args); if (!r.ok) throw Error(r.error); return r; };
    const set = (status, extra = {}) => { Object.assign(clip, { status }, extra); this.changed(); };
    try {
      set('Finding fixed points', { percent: 0, reason: '' });
      const frames = await this.grab(clip, [0, .25, .5, .75, 1].map(f => Math.round(f * (clip.frames - 1))));
      const own = anchors.map(a => ({ x: a.x, y: a.y, width: a.width, height: a.height }));
      const points = [...own, ...pickPoints(frames, { count: Math.max(4, 8 - own.length), exclude: own })];
      if (points.length < 2) { set('Needs review', { reason: 'No fixed details found; choose points manually' }); return; }
      set('Tracking', { points: points.length });
      await request({ action: 'track', key: clip.key, points });
      const began = Date.now(); let progress;
      do {
        await this.wait(1500); progress = await request({ action: 'progress' });
        if (progress.running) set('Tracking', { percent: progress.percent || 0 });
        if (Date.now() - began > 60 * 60 * 1000) throw Error('Tracking timed out; inspect Resolve');
      } while (progress.running);
      const paths = progress.paths.map(p => p.map(v => v.map(Number)));
      const c = consensus(paths, progress.width, progress.height), v = verdict(c);
      await request({ action: 'apply', key: clip.key, use: v.apply ? c.group.map(i => i + 1) : [], passed: v.status === 'Passed' });
      set(v.status, { percent: 100, reason: describe(c) + (v.apply ? '' : '. Left unstabilized.'), shake: c.shake, residual: c.residual, used: c.points });
    } catch (error) {
      set('Needs review', { reason: error.message });
      if (/Timeline changed|Project changed|timed out/.test(error.message)) throw error;
      this.log('warn', `${clip.name}: ${error.message}`);
    }
  }
  stop() { this.stopping = true; this.changed(); return { ok: true }; }
}
module.exports = { Stabilization };
