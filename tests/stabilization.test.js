const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Stabilization } = require('../electron/stabilization');
const { consensus, verdict, pickPoints } = require('../electron/stabilization-points');

// Camera shake shared by fixed points; a "person" point moves on its own.
const shake = n => [Math.sin(n / 3) * 2 / 3840, Math.cos(n / 2) * 3 / 2160];
const path = (x, y, own = () => [0, 0], noise = 0) => Array.from({ length: 200 }, (_, n) => { const s = shake(n), o = own(n); return [x + s[0] + o[0] + (n % 2 ? noise : -noise), y + s[1] + o[1]]; });
const person = n => [n * .00005, Math.sin(n / 7) * .004];

test('consensus keeps points that move together and drops a moving person', () => {
  const c = consensus([path(.2, .8), path(.7, .5), person && path(.4, .4, person), path(.8, .2)], 3840, 2160);
  assert.deepEqual(c.group, [0, 1, 3]);
  assert.ok(c.shake.range > 5 && c.residual < .1);
  assert.equal(verdict(c).status, 'Passed');
});
test('two agreeing points are applied but need review; one point is not applied', () => {
  const two = consensus([path(.2, .8), path(.7, .5), path(.4, .4, person)], 3840, 2160);
  assert.deepEqual(verdict(two), { status: 'Needs review', apply: true });
  const one = consensus([path(.2, .8), path(.4, .4, person)], 3840, 2160);
  assert.equal(verdict(one).apply, false);
});
test('missing tracking data excludes that point', () => {
  const broken = path(.5, .5); broken[50] = [NaN, NaN];
  const c = consensus([path(.2, .8), broken, path(.7, .3), path(.8, .6)], 3840, 2160);
  assert.deepEqual(c.group, [0, 2, 3]);
});
test('pickPoints keeps details that stay in place and rejects ones that move', () => {
  const W = 640, H = 360, make = shift => { const data = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const fixed = ((x >> 3) + (y >> 3)) % 2 ? 200 : 40; // static checker texture on the left half
      const mx = x - shift; const moving = (((mx >> 2) ^ (y >> 2)) * 37 % 255);
      data[y * W + x] = x < W / 2 ? fixed + ((x * 7 + y * 13) % 17) : moving;
    } return { data, width: W, height: H }; };
  const pts = pickPoints([make(0), make(40), make(80)], { count: 8 });
  assert.ok(pts.length >= 2);
  assert.ok(pts.every(p => p.x < .5), JSON.stringify(pts));
});

const { edgeZoom } = require('../electron/stabilization-points');
test('edge zoom covers the largest shift with a small margin and is capped', () => {
  assert.deepEqual(edgeZoom({ x: .001, y: .003 }), { zoom: 1.008, capped: false });
  assert.deepEqual(edgeZoom({ x: 0, y: 0 }), { zoom: 1.002, capped: false });
  assert.deepEqual(edgeZoom({ x: .05, y: 0 }), { zoom: 1.03, capped: true });
});

// Two timelines, two marked clips each.
function setup(paths) {
  const calls = [], clips = { A: [{ key: '1:1', start: 0, frames: 200, fusion: 0 }, { key: '1:2', start: 300, frames: 200, fusion: 0 }], B: [{ key: '1:5', start: 50, frames: 200, fusion: 0 }] };
  const s = new Stabilization({ log() {}, onChange() {}, wait: async () => {}, grab: async () => [], bridge: { stabilize: async a => { calls.push(a);
    if (a.action === 'scan') return { ok: true, colors: ['Blue'], clips: clips[a.timeline || 'A'], timeline: `TL ${a.timeline || 'A'}`, timelineId: a.timeline || 'A' };
    if (a.action === 'begin') return { ok: true, timeline: 'copy', timelineId: 'copy-id' };
    if (a.action === 'progress') return { ok: true, running: false, paths: paths(), width: 3840, height: 2160 };
    return { ok: true }; } } });
  return { s, calls };
}
const pts = key => [.2, .7, .8].map(v => ({ key, x: v, y: .5 }));
test('scan collects clips from several timelines with unique keys', async () => {
  const { s } = setup(() => []);
  const r = await s.scan('Blue', ['A', 'B']);
  assert.deepEqual(r.clips.map(c => c.key), ['A|1:1', 'A|1:2', 'B|1:5']);
  assert.equal(r.clips[2].lkey, '1:5');
});
test('queue: one copy per timeline, only agreeing trackers, edge zoom applied', async () => {
  const { s, calls } = setup(() => [path(.2, .8), path(.4, .4, person), path(.7, .5), path(.8, .2)]);
  await s.scan('Blue', ['A', 'B']);
  await s.start(['A|1:1', 'B|1:5'], [...pts('A|1:1'), { key: 'A|1:1', x: .4, y: .4 }, ...pts('B|1:5'), { key: 'B|1:5', x: .4, y: .4 }]);
  assert.deepEqual(calls.slice(2).map(a => a.action + (a.timeline ? ':' + a.timeline : '')), ['scan:A', 'begin', 'track', 'progress', 'apply', 'finish', 'scan:B', 'begin', 'track', 'progress', 'apply', 'finish']);
  const apply = calls.find(a => a.action === 'apply');
  assert.equal(apply.key, '1:1'); assert.deepEqual(apply.use, [1, 3, 4]); assert.ok(apply.zoom > 1 && apply.zoom < 1.01);
  assert.equal(s.clips.find(c => c.key === 'A|1:1').status, 'Passed');
});
test('a timeline edited after the scan stops before tracking', async () => {
  const { s, calls } = setup(() => []);
  await s.scan('Blue', ['A']); s.clips[0].start = 999;
  await assert.rejects(s.start(['A|1:1'], pts('A|1:1')), /changed since the scan/);
  assert.equal(calls.filter(a => a.action === 'begin').length, 0);
});
test('stop after the current clip skips the rest', async () => {
  let s; const x = setup(() => { s.stop(); return [path(.2, .8), path(.7, .5), path(.8, .2)]; }); s = x.s;
  await s.scan('Blue', ['A', 'B']);
  await s.start(['A|1:1', 'A|1:2', 'B|1:5'], [...pts('A|1:1'), ...pts('A|1:2'), ...pts('B|1:5')]);
  assert.equal(x.calls.filter(a => a.action === 'track').length, 1);
  assert.deepEqual(s.clips.map(c => c.status), ['Passed', 'Not started', 'Not started']);
});
test('existing Fusion clips and repeated batches are refused', async () => {
  const { s, calls } = setup(() => []);
  await s.scan('Blue', ['A']); s.clips[0].fusion = 1;
  await assert.rejects(s.start(['A|1:1']), /Fusion/);
  s.clips[0].fusion = 0; s.hasCopy = true;
  await assert.rejects(s.start(['A|1:1']), /Find marked clips/);
  assert.equal(calls.filter(a => a.action === 'begin').length, 0);
});

const { analyze } = require('../electron/stabilization-points');
test('a reframing camera gets Smooth: slow move kept, only the fast shake corrected', () => {
  // slow pan of 200 px plus a 3 px shake, seen by 4 points; one person moves on their own
  const pan = n => [n * 200 / 3840 / 300, 0];
  const p = (x, y, own) => path(x, y, n => { const a = pan(n), o = own ? own(n) : [0, 0]; return [a[0] + o[0], a[1] + o[1]]; });
  const c = analyze([p(.2, .8), p(.7, .5), p(.5, .3, n => [Math.sin(n / 9) * .01, 0]), p(.8, .2)], 3840, 2160, 25);
  assert.equal(c.mode, 'smooth');
  assert.ok(c.points >= 3 && c.weakFrames === 0, JSON.stringify({ points: c.points, weak: c.weakFrames }));
  // correction cancels the shake (a few px), never the 200 px pan
  const maxPx = Math.max(...c.correction.map(v => Math.abs(v[0]) * 3840));
  assert.ok(maxPx < 4, `correction ${maxPx}px`);
});
test('a still camera keeps Lock mode', () => {
  assert.equal(analyze([path(.2, .8), path(.7, .5), path(.8, .2)], 3840, 2160, 25).mode, 'lock');
});
test('approve sends the original clip position and colour; undo restores markers', async () => {
  const { s, calls } = setup(() => [path(.2, .8), path(.7, .5), path(.8, .2)]);
  await s.scan('Blue', ['A']);
  s.clips[0].clipColor = 'Blue'; s.clips[0].markers = [{ frame: 5, color: 'Blue' }];
  await s.start(['A|1:1'], pts('A|1:1'));
  const r = await s.approve(['A|1:1', 'A|1:2'], { removeMarkers: true, file: 'x.comp' });
  assert.equal(r.applied, 1); assert.match(r.error, /nothing to apply/);
  const a = calls.find(c => c.action === 'approve');
  assert.deepEqual([a.copy, a.timeline, a.track, a.index, a.color, a.removeMarkers], ['copy-id', 'A', undefined, undefined, 'Blue', true]);
  await s.undo('A|1:1');
  assert.equal(calls.find(c => c.action === 'undo').restoreMarkers, true);
  assert.equal(s.clips[0].approved, false);
});
test('no rigid reference: Resolve stabilizer is used, without tracking', async () => {
  const { s, calls } = setup(() => []);
  await s.scan('Blue', ['A']);
  await s.start(['A|1:1']); // no own points; grab returns no frames -> no fixed details
  assert.deepEqual(calls.filter(a => ['track', 'resolvestab'].includes(a.action)).map(a => a.action), ['resolvestab']);
  assert.equal(s.clips[0].status, 'Stabilized (Resolve)');
  assert.equal(s.canApprove(s.clips[0]), true);
});
test('points that disagree after tracking also fall back to Resolve', async () => {
  const wild = (x, y) => path(x, y, n => [Math.sin(n * x * 7) * .02, Math.cos(n * y * 5) * .02]);
  const { s, calls } = setup(() => [wild(.2, .8), wild(.7, .5), wild(.4, .3), wild(.8, .2)]);
  await s.scan('Blue', ['A']);
  await s.start(['A|1:1'], pts('A|1:1'));
  assert.ok(calls.some(a => a.action === 'resolvestab'));
  assert.equal(calls.some(a => a.action === 'apply'), false);
});

// Forced tracker version next to Resolve's stabilizer, and the run history.
function setupForce(paths) {
  const calls = [], saved = new Map();
  const clips = { A: [{ key: '1:1', start: 0, frames: 200, fusion: 0 }] };
  const history = { save: run => saved.set(run.id, JSON.parse(JSON.stringify(run))), list: () => [...saved.values()], load: id => saved.get(id) };
  const s = new Stabilization({ log() {}, onChange() {}, wait: async () => {}, grab: async () => [], history, project: () => 'P', bridge: { stabilize: async a => { calls.push(a);
    if (a.action === 'scan') return { ok: true, colors: ['Blue'], clips: clips.A, timeline: 'TL A', timelineId: 'A' };
    if (a.action === 'begin') return a.label === 'Tracker' ? { ok: true, timeline: 'TL A - PostPilot Tracker 2026-10-27 120000', timelineId: 'tracker-id' } : { ok: true, timeline: 'TL A - PostPilot Stabilized 2026-10-27 110000', timelineId: 'copy-id' };
    if (a.action === 'progress') return { ok: true, running: false, paths: paths(), width: 3840, height: 2160 };
    if (a.action === 'list') return { ok: true, timelines: [{ id: 'A' }, { id: 'copy-id' }] };
    return { ok: true }; } } });
  return { s, calls, saved };
}
const wild = (x, y) => path(x, y, n => [Math.sin(n * x * 7) * .02, Math.cos(n * y * 5) * .02]);
test('a clip done with Resolve can get a forced tracker version in its own copy', async () => {
  const { s, calls } = setupForce(() => [wild(.2, .8), wild(.7, .5), wild(.4, .3)]);
  await s.scan('Blue', ['A']);
  await s.start(['A|1:1']);                       // no fixed details -> Resolve's stabilizer
  const c = s.clips[0];
  assert.equal(c.method, 'resolve');
  await s.forceTracker('A|1:1', pts('A|1:1'));
  const begin = calls.filter(a => a.action === 'begin');
  assert.deepEqual(begin.map(a => a.label), [undefined, 'Tracker']);
  const apply = calls.find(a => a.action === 'apply');
  assert.ok(apply.use.length >= 1, 'forced: applied although the points disagree');
  assert.equal(c.status, 'Stabilized (Resolve)');  // the first version is kept
  assert.equal(c.alt.status, 'Tracker (forced)');
  assert.equal(c.alt.copyTimelineId, 'tracker-id');
  assert.match(c.alt.reason, /safety check would not/); assert.doesNotMatch(c.alt.reason, /left unchanged/);
});
test('either version can be approved; the tracker version can be undone; both copies can go', async () => {
  const { s, calls } = setupForce(() => [wild(.2, .8), wild(.7, .5), wild(.4, .3)]);
  await s.scan('Blue', ['A']); await s.start(['A|1:1']); await s.forceTracker('A|1:1', pts('A|1:1'));
  assert.deepEqual(s.copiesReady(), []);
  const r = await s.approve(['A|1:1'], { version: 'tracker', file: 'x.comp' });
  assert.equal(r.applied, 1);
  const a = calls.find(x => x.action === 'approve');
  assert.deepEqual([a.copy, a.method], ['tracker-id', undefined]);   // Fusion comp, not Resolve's stabilizer
  assert.equal(s.clips[0].approvedVersion, 'tracker');
  assert.deepEqual(s.copiesReady().sort(), ['copy-id', 'tracker-id']);
  await s.undo('A|1:1');
  assert.equal(s.clips[0].approved, false);
});
test('every run is kept and can be opened again for review', async () => {
  const { s, saved } = setupForce(() => [path(.2, .8), path(.7, .5), path(.8, .2)]);
  await s.scan('Blue', ['A']);
  await s.start(['A|1:1'], pts('A|1:1'));
  const [run] = saved.values();
  assert.match(run.id, /^\d{4}-\d{2}-\d{2}_\d{6}$/);
  assert.deepEqual([run.project, run.timelines, run.copies], ['P', ['TL A'], ['TL A - PostPilot Stabilized 2026-10-27 110000']]);
  await s.approve(['A|1:1'], { file: 'x.comp' });
  assert.equal(saved.get(run.id).clips[0].approved, true);       // review actions update the record
  // After a restart: a fresh instance opens the run with its clips.
  const fresh = new Stabilization({ log() {}, onChange() {}, history: { load: id => saved.get(id), list: () => [], save() {} }, project: () => 'P',
    bridge: { stabilize: async () => ({ ok: true, timelines: [{ id: 'A' }] }) } });
  const o = await fresh.openRun(run.id);
  assert.equal(o.clips[0].approved, true);
  assert.equal(o.clips[0].copyDeleted, true);    // its copy is no longer in the project
  assert.equal(o.hasCopy, true);
  const other = new Stabilization({ log() {}, onChange() {}, history: { load: id => saved.get(id) }, project: () => 'Other', bridge: {} });
  await assert.rejects(other.openRun(run.id), /Open the project "P"/);
});
