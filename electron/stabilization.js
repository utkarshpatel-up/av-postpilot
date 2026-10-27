const { pickPoints, analyze, verdict, describe, edgeZoom, LIMITS } = require('./stabilization-points');
// Marked clips on one or more timelines -> per timeline a timeline copy -> per clip:
// pick fixed points from 5 frames, track them all in one Fusion pass, keep the
// points that agree, Match Move on those, then a slight zoom to hide black edges.
// clip.key is unique across timelines ("<timelineId>|<track:index>"); clip.lkey is
// the key the Resolve side knows within its scanned timeline.
// clip.alt: the forced tracker version of a clip done with Resolve's stabilizer.
class Stabilization {
  // history: { save(run), list(), load(id) } keeps every run so it can be reviewed later.
  constructor({ bridge, log, onChange, grab, saveReport = () => {}, history = { save() {}, list: () => [], load: () => null }, project = () => '', wait = ms => new Promise(r => setTimeout(r, ms)) }) {
    Object.assign(this, { bridge, log, onChange, grab, saveReport, history, project, wait });
    this.running = false; this.stopping = false; this.clips = []; this.timeline = ''; this.color = 'All'; this.luaTimeline = null;
  }
  summary() { return { copiesReady: this.copiesReady().length, running: this.running, stopping: this.stopping, hasCopy: Boolean(this.hasCopy), clips: this.clips, timeline: this.timeline, startedAt: this.startedAt, finishedAt: this.finishedAt, current: this.current, forcing: this.forcing || null, runId: this.runId || null }; }
  changed() { this.onChange(this.summary()); }
  // The run as kept in the history (written after the run and after every review action).
  record() {
    if (!this.runId) return;
    const copies = [...new Set(this.clips.flatMap(c => [c.copyTimelineName, c.alt?.copyTimelineName]).filter(Boolean))];
    this.history.save({ id: this.runId, date: new Date(this.startedAt || Date.now()).toISOString(), finishedAt: this.finishedAt || null, project: this.runProject || '', timelines: [...new Set(this.clips.map(c => c.timelineName).filter(Boolean))], copies, clips: this.clips });
  }
  async request(args) { const r = await this.bridge.stabilize(args); if (!r.ok) throw Error(r.error); return r; }
  async timelines() { return this.request({ action: 'list' }); }
  // Points Resolve's session at one timeline (opens it) and returns its marked clips.
  async scanOne(timelineId) {
    const r = await this.request({ action: 'scan', color: this.color, timeline: timelineId || undefined });
    this.luaTimeline = r.timelineId;
    return r;
  }
  async scan(color, timelineIds = []) {
    if (this.running) throw new Error('Wait for stabilization to finish');
    this.color = color || 'All';
    const ids = timelineIds.length ? timelineIds : [null];
    const clips = [], colors = new Set(), names = [];
    for (const id of ids) {
      const r = await this.scanOne(id);
      r.colors.forEach(c => colors.add(c)); names.push(r.timeline);
      for (const c of r.clips) clips.push({ ...c, lkey: c.key, key: `${r.timelineId}|${c.key}`, timelineId: r.timelineId, timelineName: r.timeline,
        status: c.fusion ? 'Existing Fusion — manual review' : 'Ready', selected: !c.fusion });
    }
    this.hasCopy = false; this.clips = clips; this.timeline = names.join(', '); this.runId = null; this.changed();
    return { ok: true, colors: [...colors].sort(), clips, timeline: this.timeline };
  }
  async preview(key, frame, file) {
    const clip = this.clips.find(c => c.key === key);
    if (!clip) throw Error('Find marked clips again');
    if (this.luaTimeline !== clip.timelineId) await this.scanOne(clip.timelineId);
    return this.request({ action: 'preview', key: clip.lkey, frame, file });
  }
  // anchors: optional [{key,x,y,width,height}] chosen by the editor; tracked as extra points.
  // moving: keys of clips where the camera moves on purpose (Smooth); all others Lock.
  async start(keys, anchors = [], moving = []) {
    if (this.running) throw new Error('Stabilization is already running');
    if (this.hasCopy) throw new Error('Find marked clips again before starting another batch');
    const selected = this.clips.filter(c => keys.includes(c.key));
    if (!selected.length) throw new Error('Choose at least one clip');
    if (selected.some(c => c.fusion)) throw new Error('Clips with existing Fusion effects are kept for manual review');
    for (const a of anchors) if (!Number.isFinite(a.x) || !Number.isFinite(a.y) || a.x <= .03 || a.x >= .97 || a.y <= .03 || a.y >= .97) throw new Error('Keep chosen points away from the frame edges');
    this.running = true; this.stopping = false; this.startedAt = Date.now(); this.finishedAt = null; this.current = null;
    this.runId = runId(this.startedAt); this.runProject = this.project();
    for (const c of selected) Object.assign(c, { motion: moving.includes(c.key), status: 'Waiting', reason: '', percent: 0, startedAt: null, elapsedMs: null, approved: false });
    this.changed();
    const groups = [...new Set(selected.map(c => c.timelineId))].map(id => selected.filter(c => c.timelineId === id));
    const copies = [];
    try {
      for (const group of groups) {
        if (this.stopping) { group.forEach(c => { c.status = 'Not started'; }); this.changed(); continue; }
        // Re-scan so Resolve's session matches this timeline, and check nothing moved.
        const fresh = await this.scanOne(group[0].timelineId);
        for (const c of group) if (!fresh.clips.some(f => f.key === c.lkey && f.start === c.start && f.frames === c.frames)) throw Error(`"${c.timelineName}" changed since the scan; find marked clips again`);
        const begin = await this.request({ action: 'begin' });
        copies.push(begin.timeline); this.timeline = copies.join(', '); this.hasCopy = true;
        for (const c of group) Object.assign(c, { copyTimelineId: begin.timelineId, copyTimelineName: begin.timeline });
        this.changed();
        for (const clip of group) {
          if (this.stopping) { clip.status = 'Not started'; this.changed(); continue; }
          this.current = clip.key; clip.startedAt = Date.now();
          await this.stabilizeClip(clip, anchors.filter(a => a.key === clip.key));
          clip.elapsedMs = Date.now() - clip.startedAt; this.changed();
        }
        await this.request({ action: 'finish' });
      }
      this.log('info', `Stabilization finished in ${copies.map(c => `"${c}"`).join(', ')}: ${selected.filter(c => c.status === 'Passed').length}/${selected.length} passed`);
    } catch (error) { this.log('error', `Stabilization stopped: ${error.message}. Timeline copies retained.`); throw error; }
    finally { this.running = false; this.current = null; this.finishedAt = Date.now(); this.saveReport({ timelines: copies, date: new Date().toISOString(), clips: this.clips }); this.record(); this.changed(); }
    return { ok: true, ...this.summary() };
  }
  // force: the tracker version even where the checks would use Resolve's stabilizer
  // (to compare both); always left for review.
  async stabilizeClip(clip, anchors, { force = false } = {}) {
    const set = (status, extra = {}) => { Object.assign(clip, { status }, extra); this.changed(); };
    try {
      set('Finding fixed points', { percent: 0, reason: '' });
      // First frame, two frames just after it (what moves like the camera), middle and end.
      const last = clip.frames - 1;
      const frames = await this.grab(clip, [...new Set([0, Math.min(2, last), Math.min(4, last), Math.round(last / 2), last])]);
      const own = anchors.map(a => ({ x: a.x, y: a.y, width: a.width, height: a.height }));
      const points = [...own, ...pickPoints(frames, { count: Math.max(4, 8 - own.length), exclude: own })];
      // Quick check: without at least 3 details that stayed put through the clip (or the
      // editor's own points) there is no rigid reference - use Resolve's stabilizer now.
      const fixed = points.filter(p => p.fixed).length;
      if (!force && !own.length && fixed === 0) return await this.resolveFallback(clip, 'no fixed detail stays in the picture');
      if (!points.length) throw Error('No details to track in this clip');
      set('Tracking', { points: points.length });
      await this.request({ action: 'track', key: clip.lkey, points });
      const began = Date.now(); let progress;
      do {
        await this.wait(1500); progress = await this.request({ action: 'progress' });
        if (progress.running) set('Tracking', { percent: progress.percent || 0 });
        if (Date.now() - began > 60 * 60 * 1000) throw Error('Tracking timed out; inspect Resolve');
      } while (progress.running);
      const paths = progress.paths.map(p => p.map(v => v.map(Number)));
      const c = analyze(paths, progress.width, progress.height, progress.fps || 25, clip.motion ? 'smooth' : 'lock'), v = verdict(c);
      // Trust check failed after tracking: the points disagree, so no rigid reference.
      if (!v.apply && !force) return await this.resolveFallback(clip, c.spread ? `tracked details disagree by about ${c.spread.toFixed(0)} px` : 'details could not be tracked reliably');
      const apply = v.apply || force;
      // Forced: the agreeing points, or all of them when none agree.
      const use = c.group?.length ? c.group : force ? points.map((_, i) => i) : [];
      const z = apply ? edgeZoom(c.edge) : { zoom: 1, capped: false };
      const status = force ? 'Tracker (forced)' : z.capped ? 'Needs review' : v.status;
      const smooth = Boolean(c.correction) && apply; // per-frame correction on the Transform node
      await this.request({ action: 'apply', key: clip.lkey, use: apply ? use.map(i => i + 1) : [], zoom: z.zoom, passed: status === 'Passed',
        mode: c.mode, cx: smooth ? c.correction.map(p => +p[0].toFixed(6)) : undefined, cy: smooth ? c.correction.map(p => +p[1].toFixed(6)) : undefined });
      const zoomNote = z.zoom > 1 ? `; zoom ${z.zoom.toFixed(3)}${z.capped ? ' (capped, edges may show)' : ''}` : '';
      // Forced past the safety check: say why it would have refused (describe() says "left unchanged").
      const why = force && !v.apply ? `Tracker version, used although the safety check would not: ${c.spread ? `the tracked details disagree by about ${c.spread.toFixed(0)} px (4K)` : 'the details could not be tracked reliably'}. Compare it with Resolve's version` : (force ? 'Tracker version. ' : '') + describe(c);
      set(status, { percent: 100, reason: why + zoomNote + (apply ? '' : '. Left unstabilized.'), shake: c.shake, residual: c.residual, used: c.points, zoom: z.zoom, mode: c.mode });
    } catch (error) {
      set('Needs review', { reason: error.message });
      if (/Timeline changed|Project changed|timed out/.test(error.message)) throw error;
      this.log('warn', `${clip.name}: ${error.message}`);
    }
  }
  async resolveFallback(clip, why) {
    Object.assign(clip, { status: "Resolve's stabilizer", percent: 0, reason: '' }); this.changed();
    await this.request({ action: 'resolvestab', key: clip.lkey });
    Object.assign(clip, { status: 'Stabilized (Resolve)', method: 'resolve', percent: 100,
      reason: `No rigid reference (${why}), so Resolve's own stabilizer was used (whole-picture analysis). Check it by eye, or try the tracker version to compare.` });
    this.changed();
  }
  // For a clip done with Resolve's stabilizer: also make the tracker version, in its own
  // timeline copy, to compare both. Either one can be approved afterwards.
  async forceTracker(key, anchors = []) {
    if (this.running) throw Error('Wait for stabilization to finish');
    const clip = this.clipFor(key);
    if (clip.method !== 'resolve') throw Error("Only for clips done with Resolve's stabilizer");
    if (clip.approved) throw Error('Already applied to your timeline');
    this.running = true; this.stopping = false; this.forcing = key; this.current = key; this.changed();
    try {
      const fresh = await this.scanOne(clip.timelineId);
      if (!fresh.clips.some(f => f.key === clip.lkey && f.start === clip.start && f.frames === clip.frames)) throw Error(`"${clip.timelineName}" changed since this clip was stabilized; find marked clips again`);
      const begin = await this.request({ action: 'begin', label: 'Tracker' });
      clip.alt = { status: 'Waiting', reason: '', percent: 0, copyTimelineId: begin.timelineId, copyTimelineName: begin.timeline, startedAt: Date.now(),
        lkey: clip.lkey, frames: clip.frames, start: clip.start, motion: clip.motion, name: clip.name, track: clip.track, index: clip.index };
      this.changed();
      await this.stabilizeClip(clip.alt, anchors, { force: true });
      clip.alt.elapsedMs = Date.now() - clip.alt.startedAt;
      await this.request({ action: 'finish' });
      this.log('info', `Tracker version of ${clip.name} made in "${begin.timeline}" to compare with Resolve's stabilizer`);
    } finally { this.running = false; this.forcing = null; this.current = null; this.finishedAt = this.finishedAt || Date.now(); this.record(); this.changed(); }
    return { ok: true, ...this.summary() };
  }
  // --- Review: jump to a clip, approve it onto your timeline, or undo that.
  clipFor(key) { const c = this.clips.find(c => c.key === key); if (!c) throw Error('Find marked clips again'); return c; }
  // where: 'copy' (first version), 'tracker' (forced tracker version) or 'original'.
  async review(key, where = 'copy') {
    const clip = this.clipFor(key);
    const v = where === 'tracker' ? clip.alt : clip;
    if (where !== 'original') {
      if (!v?.copyTimelineId) throw Error('Not stabilized yet');
      if (v.copyDeleted) throw Error('The stabilized copy was deleted');
    }
    return this.request({ action: 'goto', timeline: where === 'original' ? clip.timelineId : v.copyTimelineId, start: clip.start, frames: clip.frames });
  }
  canApprove(c) { return Boolean(c?.copyTimelineId) && !c.copyDeleted && ['Passed', 'Needs review', 'Stabilized (Resolve)', 'Tracker (forced)'].includes(c.status) && !/Left unstabilized|No details|No fixed|^Not started/.test(c.reason || ''); }
  // Something to apply from either version of this clip.
  hasVersion(c) { return this.canApprove(c) || this.canApprove(c.alt); }
  // version 'tracker': apply the forced tracker version instead of the first one.
  async approve(keys, { removeMarkers = false, file, version = 'main' } = {}) {
    if (this.running) throw Error('Wait for stabilization to finish');
    const done = [], failed = [];
    for (const key of keys) {
      const c = this.clipFor(key);
      if (c.approved) continue;
      try {
        const from = version === 'tracker' ? c.alt : c;
        if (!this.canApprove(from)) throw Error('nothing to apply for this clip');
        await this.request({ action: 'approve', copy: from.copyTimelineId, timeline: c.timelineId, track: c.track, index: c.index, start: c.start, frames: c.frames,
          color: c.clipColor || '', markers: c.markers || [], removeMarkers, file, method: from.method });
        Object.assign(c, { approved: true, approvedVersion: version === 'tracker' ? 'tracker' : 'main', markersRemoved: removeMarkers }); done.push(c);
      } catch (error) { failed.push(c.name + ': ' + error.message); }
      this.changed();
    }
    if (done.length) this.log('info', 'Stabilization applied to ' + done.length + ' clip(s) in your timeline' + (version === 'tracker' ? ' (tracker version)' : '') + (removeMarkers ? '; markers removed' : ''));
    this.record();
    return { ok: !failed.length, applied: done.length, error: failed.join('; ') };
  }
  // A copy may go once every clip in it that has something to apply was approved.
  copiesReady() {
    const inCopy = new Map();
    for (const c of this.clips) for (const v of [c, c.alt]) if (v?.copyTimelineId && !v.copyDeleted) inCopy.set(v.copyTimelineId, [...(inCopy.get(v.copyTimelineId) || []), c]);
    return [...inCopy].filter(([, clips]) => clips.filter(c => this.hasVersion(c)).every(c => c.approved)).map(([id]) => id);
  }
  async deleteCopies() {
    if (this.running) throw Error('Wait for stabilization to finish');
    const ids = this.copiesReady();
    if (!ids.length) throw Error('Approve every stabilized clip first');
    const back = this.clips.find(c => ids.includes(c.copyTimelineId) || ids.includes(c.alt?.copyTimelineId)).timelineId;
    const r = await this.request({ action: 'deletecopies', ids, back });
    for (const c of this.clips) for (const v of [c, c.alt]) if (v && ids.includes(v.copyTimelineId)) v.copyDeleted = true;
    this.record(); this.changed(); this.log('info', `Deleted ${r.deleted} stabilized copy timeline(s) after approval`);
    return { ok: true, deleted: r.deleted };
  }
  async undo(key) {
    if (this.running) throw Error('Wait for stabilization to finish');
    const c = this.clipFor(key);
    if (!c.approved) throw Error('Not applied to your timeline');
    if (c.method === 'resolve' && c.approvedVersion !== 'tracker') throw Error("Resolve's stabilizer can't be removed by script: in the Color page open the Tracker > Stabilizer for this clip and press reset");
    await this.request({ action: 'undo', timeline: c.timelineId, track: c.track, index: c.index, start: c.start, frames: c.frames, markers: c.markers || [], restoreMarkers: Boolean(c.markersRemoved) });
    Object.assign(c, { approved: false, approvedVersion: null, markersRemoved: false }); this.record(); this.changed();
    this.log('info', 'Stabilization removed from ' + c.name + ' in your timeline');
    return { ok: true };
  }
  stop() { this.stopping = true; this.changed(); return { ok: true }; }

  // Earlier runs, newest first; open one to review it again (also after a restart).
  runs() { return this.history.list(); }
  async openRun(id) {
    if (this.running) throw Error('Wait for stabilization to finish');
    const run = this.history.load(id);
    if (!run) throw Error('That stabilization record was not found');
    const now = this.project();
    if (run.project && now && run.project !== now) throw Error(`Open the project "${run.project}" in Resolve first`);
    // Mark copies someone deleted in Resolve since.
    const have = new Set(((await this.timelines()).timelines || []).map(t => t.id));
    for (const c of run.clips) for (const v of [c, c.alt]) if (v?.copyTimelineId && !have.has(v.copyTimelineId)) v.copyDeleted = true;
    Object.assign(this, { clips: run.clips, timeline: run.copies.join(', '), hasCopy: true, runId: run.id, runProject: run.project, startedAt: Date.parse(run.date), finishedAt: run.finishedAt || Date.parse(run.date), current: null });
    this.changed();
    return { ok: true, ...this.summary() };
  }
}

// "2026-10-27_114437": sortable and safe as a file name.
function runId(t) {
  const d = new Date(t), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

module.exports = { Stabilization, runId };
