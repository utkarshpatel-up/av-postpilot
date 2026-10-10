const { pickPoints, analyze, verdict, describe, edgeZoom, LIMITS } = require('./stabilization-points');
// Marked clips on one or more timelines -> per timeline a timeline copy -> per clip:
// pick fixed points from 5 frames, track them all in one Fusion pass, keep the
// points that agree, Match Move on those, then a slight zoom to hide black edges.
// clip.key is unique across timelines ("<timelineId>|<track:index>"); clip.lkey is
// the key the Resolve side knows within its scanned timeline.
class Stabilization {
  constructor({ bridge, log, onChange, grab, saveReport = () => {}, wait = ms => new Promise(r => setTimeout(r, ms)) }) {
    Object.assign(this, { bridge, log, onChange, grab, saveReport, wait });
    this.running = false; this.stopping = false; this.clips = []; this.timeline = ''; this.color = 'All'; this.luaTimeline = null;
  }
  summary() { return { copiesReady: this.copiesReady().length, running: this.running, stopping: this.stopping, hasCopy: Boolean(this.hasCopy), clips: this.clips, timeline: this.timeline, startedAt: this.startedAt, finishedAt: this.finishedAt, current: this.current }; }
  changed() { this.onChange(this.summary()); }
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
    this.hasCopy = false; this.clips = clips; this.timeline = names.join(', '); this.changed();
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
    finally { this.running = false; this.current = null; this.finishedAt = Date.now(); this.saveReport({ timelines: copies, date: new Date().toISOString(), clips: this.clips }); this.changed(); }
    return { ok: true, ...this.summary() };
  }
  async stabilizeClip(clip, anchors) {
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
      if (!own.length && fixed === 0) return await this.resolveFallback(clip, 'no fixed detail stays in the picture');
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
      if (!v.apply) return await this.resolveFallback(clip, c.spread ? `tracked details disagree by about ${c.spread.toFixed(0)} px` : 'details could not be tracked reliably');
      const z = v.apply ? edgeZoom(c.edge) : { zoom: 1, capped: false };
      const status = z.capped ? 'Needs review' : v.status;
      const smooth = Boolean(c.correction) && v.apply; // per-frame correction on the Transform node
      await this.request({ action: 'apply', key: clip.lkey, use: v.apply ? c.group.map(i => i + 1) : [], zoom: z.zoom, passed: status === 'Passed',
        mode: c.mode, cx: smooth ? c.correction.map(p => +p[0].toFixed(6)) : undefined, cy: smooth ? c.correction.map(p => +p[1].toFixed(6)) : undefined });
      const zoomNote = z.zoom > 1 ? `; zoom ${z.zoom.toFixed(3)}${z.capped ? ' (capped, edges may show)' : ''}` : '';
      set(status, { percent: 100, reason: describe(c) + zoomNote + (v.apply ? '' : '. Left unstabilized.'), shake: c.shake, residual: c.residual, used: c.points, zoom: z.zoom, mode: c.mode });
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
      reason: `No rigid reference (${why}), so Resolve's own stabilizer was used (whole-picture analysis). Check it by eye.` });
    this.changed();
  }
  // --- Review: jump to a clip, approve it onto your timeline, or undo that.
  clipFor(key) { const c = this.clips.find(c => c.key === key); if (!c) throw Error('Find marked clips again'); return c; }
  async review(key, where = 'copy') {
    const c = this.clipFor(key);
    if (where === 'copy' && !c.copyTimelineId) throw Error('Not stabilized yet');
    if (where === 'copy' && c.copyDeleted) throw Error('The stabilized copy was deleted');
    return this.request({ action: 'goto', timeline: where === 'copy' ? c.copyTimelineId : c.timelineId, start: c.start, frames: c.frames });
  }
  canApprove(c) { return Boolean(c.copyTimelineId) && ['Passed', 'Needs review', 'Stabilized (Resolve)'].includes(c.status) && !/Left unstabilized|No details|No fixed|^Not started/.test(c.reason || ''); }
  async approve(keys, { removeMarkers = false, file } = {}) {
    if (this.running) throw Error('Wait for stabilization to finish');
    const done = [], failed = [];
    for (const key of keys) {
      const c = this.clipFor(key);
      if (c.approved) continue;
      try {
        if (!this.canApprove(c)) throw Error('nothing to apply for this clip');
        await this.request({ action: 'approve', copy: c.copyTimelineId, timeline: c.timelineId, track: c.track, index: c.index, start: c.start, frames: c.frames,
          color: c.clipColor || '', markers: c.markers || [], removeMarkers, file, method: c.method });
        Object.assign(c, { approved: true, markersRemoved: removeMarkers }); done.push(c);
      } catch (error) { failed.push(c.name + ': ' + error.message); }
      this.changed();
    }
    if (done.length) this.log('info', 'Stabilization applied to ' + done.length + ' clip(s) in your timeline' + (removeMarkers ? '; markers removed' : ''));
    return { ok: !failed.length, applied: done.length, error: failed.join('; ') };
  }
  // A copy may go once every clip in it that has something to apply was approved.
  copiesReady() {
    const ids = [...new Set(this.clips.filter(c => c.copyTimelineId && !c.copyDeleted).map(c => c.copyTimelineId))];
    return ids.filter(id => this.clips.filter(c => c.copyTimelineId === id && this.canApprove(c)).every(c => c.approved));
  }
  async deleteCopies() {
    if (this.running) throw Error('Wait for stabilization to finish');
    const ids = this.copiesReady();
    if (!ids.length) throw Error('Approve every stabilized clip first');
    const back = this.clips.find(c => ids.includes(c.copyTimelineId)).timelineId;
    const r = await this.request({ action: 'deletecopies', ids, back });
    for (const c of this.clips) if (ids.includes(c.copyTimelineId)) c.copyDeleted = true;
    this.changed(); this.log('info', `Deleted ${r.deleted} stabilized copy timeline(s) after approval`);
    return { ok: true, deleted: r.deleted };
  }
  async undo(key) {
    if (this.running) throw Error('Wait for stabilization to finish');
    const c = this.clipFor(key);
    if (!c.approved) throw Error('Not applied to your timeline');
    if (c.method === 'resolve') throw Error("Resolve's stabilizer can't be removed by script: in the Color page open the Tracker > Stabilizer for this clip and press reset");
    await this.request({ action: 'undo', timeline: c.timelineId, track: c.track, index: c.index, start: c.start, frames: c.frames, markers: c.markers || [], restoreMarkers: Boolean(c.markersRemoved) });
    Object.assign(c, { approved: false, markersRemoved: false }); this.changed();
    this.log('info', 'Stabilization removed from ' + c.name + ' in your timeline');
    return { ok: true };
  }
  stop() { this.stopping = true; this.changed(); return { ok: true }; }
}
module.exports = { Stabilization };
