const test = require('node:test');
const assert = require('node:assert');
const { NightQueue } = require('../electron/nightqueue');

function setup({ jobsAfter = 'Complete', stabClips = null, encoderWaiting = 1 } = {}) {
  const calls = [];
  const status = { connected: true, project: { name: 'P' }, rendering: false, jobs: [{ id: 'j1', name: 'Job 1', timeline: 'E1', status: 'Ready' }] };
  const sceneQueue = {
    items: [],
    add(project, names) { calls.push(['scene.add', project, names]); names.forEach((name) => this.items.push({ name, state: 'waiting' })); },
    async start() { calls.push(['scene.start']); this.items.forEach((i) => { if (i.state === 'waiting') Object.assign(i, { state: 'done', cuts: 3 }); }); return { ok: true }; },
  };
  const stabilization = {
    clips: stabClips || [],
    canApprove: (c) => c.status === 'Passed',
    async scan(color, ids) { calls.push(['stab.scan', color, ids]); this.clips = [{ key: 'a', status: 'Ready' }, { key: 'b', fusion: true }]; return { clips: this.clips }; },
    async start(keys) { calls.push(['stab.start', keys]); this.clips.find((c) => c.key === 'a').status = 'Passed'; },
    approve() { calls.push(['stab.approve']); },
  };
  const renders = { active: false, settling: false, hdBatch: null, finished: [], pendingCopies: 0 };
  const bridge = {
    async startRendering(ids) {
      calls.push(['render', ids]);
      status.rendering = true;
      setTimeout(() => { status.rendering = false; status.jobs.forEach((j) => { j.status = jobsAfter; }); }, 5);
      return { ok: true, started: ids.length };
    },
  };
  const encoder = { groups: [{ items: Array.from({ length: encoderWaiting }, () => ({ state: 'waiting' })) }], async start() { calls.push(['encode']); return { ok: true, done: 1, failed: 0 }; } };
  const notes = [];
  let finished = null;
  const q = new NightQueue({
    getStatus: () => status, sceneQueue, stabilization, encoder, renders, bridge,
    log: () => {}, notifier: { notify: (e, m) => notes.push([e, m]) },
    onFinished: (stopped) => { finished = { stopped }; },
    wait: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 10))), pollMs: 10, quietStartMs: 0,
  });
  return { q, calls, status, notes, stabilization, finished: () => finished };
}

test('encoding always stays the last step', () => {
  const { q } = setup();
  q.add(null, 'encode');
  q.add('P', 'scene', { timelines: ['E1'] });
  q.add('P', 'render', { jobs: [{ id: 'j1', timeline: 'E1' }] });
  assert.deepStrictEqual(q.steps.map((s) => s.type), ['scene', 'render', 'encode']);
  assert.throws(() => q.move(q.steps[1].id, 1), /last step/);
  q.move(q.steps[1].id, -1);
  assert.deepStrictEqual(q.steps.map((s) => s.type), ['render', 'scene', 'encode']);
  assert.throws(() => q.add(null, 'encode'), /already a step/);
});

test('one stabilization step: more timelines join it', () => {
  const { q } = setup();
  q.add('P', 'stab', { timelines: [{ id: 't1', name: 'E1' }] });
  q.add('P', 'stab', { timelines: [{ id: 't2', name: 'E2' }, { id: 't1', name: 'E1' }] });
  assert.strictEqual(q.steps.length, 1);
  assert.deepStrictEqual(q.steps[0].timelines.map((t) => t.id), ['t1', 't2']);
});

test('a render of a timeline in the stabilization step is warned about', () => {
  const { q } = setup();
  q.add('P', 'stab', { timelines: [{ id: 't1', name: 'E1' }] });
  assert.deepStrictEqual(q.conflicts('render', { jobs: [{ id: 'j1', timeline: 'E1' }, { id: 'j2', timeline: 'E9' }] }), ['E1']);
  q.add('P', 'render', { jobs: [{ id: 'j1', timeline: 'E1' }] });
  assert.match(q.summary().steps[1].warning, /"E1" is also in the stabilization step/);
  assert.deepStrictEqual(q.conflicts('stab', { timelines: [{ id: 't1', name: 'E1' }] }), ['E1']);
});

test('steps belong to one project', () => {
  const { q } = setup();
  q.add('P', 'scene', { timelines: ['E1'] });
  assert.throws(() => q.add('Other', 'scene', { timelines: ['X'] }), /Clear it first/);
  assert.match(q.check('Other'), /Open the project "P"/);
});

test('refuses to start while the last stabilization waits for review', () => {
  const { q } = setup({ stabClips: [{ key: 'x', copyTimelineId: 'c', status: 'Passed', approved: false }] });
  q.add('P', 'stab', { timelines: [{ id: 't1', name: 'E1' }] });
  assert.match(q.check('P'), /still has clips to review/);
});

test('runs every step in order, never approves stabilization, one finish', async () => {
  const { q, calls, finished, notes } = setup();
  q.add('P', 'scene', { timelines: ['E1'] });
  q.add('P', 'stab', { timelines: [{ id: 't1', name: 'E1' }], color: 'Orange' });
  q.add('P', 'render', { jobs: [{ id: 'j1', timeline: 'E1' }] });
  q.add(null, 'encode');
  const r = await q.start();
  assert.ok(r.ok);
  assert.deepStrictEqual(calls.map((c) => c[0]), ['scene.add', 'scene.start', 'stab.scan', 'stab.start', 'render', 'encode']);
  assert.deepStrictEqual(calls.find((c) => c[0] === 'stab.start')[1], ['a']);   // the Fusion clip is left alone
  assert.ok(!calls.some((c) => c[0] === 'stab.approve'));
  assert.deepStrictEqual(q.steps.map((s) => s.state), ['done', 'done', 'done', 'done']);
  assert.match(q.steps[1].result, /nothing applied/);
  assert.match(q.steps[2].result, /1\/1 job/);
  assert.deepStrictEqual(finished(), { stopped: false });
  assert.ok(notes.some(([e]) => e === 'nightQueueDone'));
});

test('a render stopped in Resolve stops the queue and keeps the PC on', async () => {
  const { q, calls, finished } = setup({ jobsAfter: 'Cancelled' });
  q.add('P', 'render', { jobs: [{ id: 'j1', timeline: 'E1' }] });
  q.add(null, 'encode');
  await q.start();
  assert.strictEqual(q.steps[0].state, 'failed');
  assert.strictEqual(q.steps[1].state, 'waiting');
  assert.ok(!calls.some((c) => c[0] === 'encode'));
  assert.deepStrictEqual(finished(), { stopped: true });
});

test('a failed step is reported and the next one runs', async () => {
  const { q, calls } = setup({ jobsAfter: 'Failed' });
  q.add('P', 'render', { jobs: [{ id: 'j1', timeline: 'E1' }] });
  q.add('P', 'scene', { timelines: ['E2'] });
  await q.start();
  assert.strictEqual(q.steps[0].state, 'failed');
  assert.match(q.steps[0].error, /every render job failed/);
  assert.strictEqual(q.steps[1].state, 'done');
  assert.ok(calls.some((c) => c[0] === 'scene.start'));
});

test('a step that was running when the app closed is marked failed', () => {
  const q = new NightQueue({ loadState: () => ({ project: 'P', steps: [{ id: 4, type: 'scene', state: 'running', timelines: ['E1'] }] }) });
  assert.strictEqual(q.steps[0].state, 'failed');
  assert.strictEqual(q.nextId, 5);
});
