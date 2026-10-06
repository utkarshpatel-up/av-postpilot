const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Encoder, outputName, listVideos } = require('../electron/encoder');
const { RenderWatcher } = require('../electron/renders');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'avpp-enc-'));
const touch = (f) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, 'x'); };

// Fake Resolve: each job finishes after two status checks.
function fakeBridge({ fail = [] } = {}) {
  const calls = { start: [], cleanup: [] };
  let n = 0;
  const jobs = {};
  return {
    calls,
    encodeStart: async (a) => {
      calls.start.push(a);
      if (fail.includes(path.basename(a.file))) return { ok: false, error: 'could not import' };
      const id = `J${++n}`;
      jobs[id] = { left: 2, a };
      return { ok: true, id, fps: 25, resolution: '1920x1080' };
    },
    jobStatus: async (id) => {
      const j = jobs[id];
      j.left--;
      return j.left > 0
        ? { ok: true, status: 'Rendering', percent: 50 }
        : { ok: true, status: 'Complete', percent: 100, dir: j.a.dir, file: `${j.a.name}.mp4`, tookMs: 2000 };
    },
    hdCleanup: async (a) => { calls.cleanup.push(a.folder); return { ok: true }; },
  };
}

function makeEncoder(bridge, { saved = null, after = [] } = {}) {
  const notes = [];
  let state = saved;
  const e = new Encoder({
    bridge, log: () => {}, onChange: () => {}, pollMs: 1,
    notifier: { notify: async (ev, t) => notes.push({ ev, t }) },
    onQueueDone: (a, what) => after.push([a, what]),
    getSettings: () => ({ encoder: { afterQueue: 'shutdown' } }),
    loadState: () => state, saveState: (s) => { state = s; },
  });
  return { e, notes, after, state: () => state };
}

test('group preset/folder apply to files unless a file has its own', async () => {
  const src = tmp(), out1 = tmp(), out2 = tmp();
  for (const f of ['a.mov', 'b.mov', 'c.mp4']) touch(path.join(src, f));
  const bridge = fakeBridge();
  const { e, after, notes } = makeEncoder(bridge);
  const g1 = e.addGroup({ name: 'HD review', preset: 'Mov to H264 - for Sankul', dir: out1, suffix: '_HD' });
  e.addPaths(g1.id, [path.join(src, 'a.mov'), path.join(src, 'b.mov')]);
  e.updateItem(g1.id, g1.items[1].id, { preset: 'Apple ProRes 422', dir: out2 });
  const g2 = e.addGroup({ name: 'Single', preset: 'HEVC 100', dir: out2 });
  e.addPaths(g2.id, [path.join(src, 'c.mp4')]);
  const r = await e.start();
  assert.deepStrictEqual([r.done, r.failed], [3, 0]);
  assert.deepStrictEqual(bridge.calls.start.map((c) => [path.basename(c.file), c.preset, c.dir === out1 ? 'out1' : 'out2', c.name]), [
    ['a.mov', 'Mov to H264 - for Sankul', 'out1', 'a_HD'],
    ['b.mov', 'Apple ProRes 422', 'out2', 'b_HD'],
    ['c.mp4', 'HEVC 100', 'out2', 'c'],
  ]);
  assert.ok(g1.items.every((i) => i.state === 'done' && i.output));
  assert.strictEqual(bridge.calls.cleanup.length, 1, 'temporary bin removed once at the end');
  assert.match(bridge.calls.cleanup[0], /^PostPilot Encoder temp /);
  assert.ok(bridge.calls.start.every((c) => c.folder === bridge.calls.cleanup[0] && c.timeline.startsWith(c.folder)));
  assert.deepStrictEqual(after, [['shutdown', 'encoder queue']]);
  assert.strictEqual(notes.filter((n) => n.ev === 'encoderGroupDone').length, 2);
  assert.ok(notes.some((n) => n.ev === 'encoderQueueDone' && /3 done/.test(n.t)));
});

test('a failed file is reported and the queue carries on', async () => {
  const src = tmp(), out = tmp();
  touch(path.join(src, 'bad.mov')); touch(path.join(src, 'good.mov'));
  const bridge = fakeBridge({ fail: ['bad.mov'] });
  const { e } = makeEncoder(bridge);
  const g = e.addGroup({ preset: 'P', dir: out });
  e.addPaths(g.id, [path.join(src, 'bad.mov'), path.join(src, 'good.mov')]);
  const r = await e.start();
  assert.deepStrictEqual([r.done, r.failed], [1, 1]);
  assert.deepStrictEqual(g.items.map((i) => i.state), ['failed', 'done']);
  assert.match(g.items[0].error, /could not import/);
});

test('stop after current: the rest stays waiting and there is no shutdown', async () => {
  const src = tmp(), out = tmp();
  for (const f of ['1.mov', '2.mov', '3.mov']) touch(path.join(src, f));
  const bridge = fakeBridge();
  const after = [];
  const { e } = makeEncoder(bridge, { after });
  const g = e.addGroup({ preset: 'P', dir: out });
  e.addPaths(g.id, [src]);                            // whole folder
  const realStart = bridge.encodeStart;
  bridge.encodeStart = async (a) => { e.stop(); return realStart(a); };
  await e.start();
  assert.deepStrictEqual(g.items.map((i) => i.state), ['done', 'waiting', 'waiting']);
  assert.deepStrictEqual(after, []);
});

test('nothing starts without a preset and output folder', async () => {
  const src = tmp();
  touch(path.join(src, 'a.mov'));
  const { e } = makeEncoder(fakeBridge());
  const g = e.addGroup({ preset: '', dir: '' });
  e.addPaths(g.id, [path.join(src, 'a.mov')]);
  const r = await e.start();
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /no preset or output folder/);
});

test('output names never overwrite an existing file', () => {
  const out = tmp();
  touch(path.join(out, 'DD Hindi-1700_V2_HD.mp4'));
  assert.strictEqual(outputName(out, path.join(out, 'DD Hindi-1700_V2.mov'), '_HD'), 'DD Hindi-1700_V2_HD (2)');
  assert.strictEqual(outputName(out, path.join(out, 'DD Hindi-1701_V2.mov'), '_HD'), 'DD Hindi-1701_V2_HD');
});

test('folders add their video files (subfolders too), other files are skipped', () => {
  const src = tmp();
  touch(path.join(src, 'a.mov')); touch(path.join(src, 'sub', 'b.MP4')); touch(path.join(src, 'notes.txt'));
  assert.deepStrictEqual(listVideos(src).map((f) => path.relative(src, f)), ['a.mov', path.join('sub', 'b.MP4')]);
});

test('the queue is kept across restarts; an interrupted file goes back to waiting', () => {
  const saved = { groups: [{ id: 'g', name: 'G', preset: 'P', dir: 'D', suffix: '', items: [
    { id: 'i1', file: 'a.mov', state: 'encoding', pct: 40 }, { id: 'i2', file: 'b.mov', state: 'done', pct: 100 }] }] };
  const { e } = makeEncoder(fakeBridge(), { saved });
  assert.deepStrictEqual(e.groups[0].items.map((i) => [i.state, i.pct]), [['waiting', 0], ['done', 100]]);
});

test('render watcher ignores encoder jobs: no episode copy, HD pass or render shutdown', async () => {
  const sent = [];
  const after = [];
  const encIds = new Set(['ENC1']);
  const w = new RenderWatcher({
    getSettings: () => ({ renders: { copyEnabled: false, afterQueue: 'shutdown', hd: { enabled: true, preset: 'x' } } }),
    notifier: { notify: async (ev, t) => sent.push(ev) }, log: () => {}, onChange: () => {},
    onQueueDone: (a) => after.push(a), startHd: async () => { throw new Error('must not start'); },
    ignore: (id) => encIds.has(id), settleMs: 0,
  });
  const st = (r, s) => ({ connected: true, rendering: r, project: { name: 'P' }, jobs: [{ id: 'ENC1', status: s }] });
  w.update(st(false, 'Ready'));
  w.update(st(true, 'Rendering'));
  w.update(st(false, 'Complete'));
  await new Promise((r) => setTimeout(r, 50));
  assert.deepStrictEqual(sent, []);
  assert.deepStrictEqual(after, []);
});
