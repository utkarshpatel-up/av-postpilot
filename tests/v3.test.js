const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Notifier, normaliseWhapiTarget, telegram } = require('../electron/notify');
const { RenderWatcher } = require('../electron/renders');
const { SceneQueue } = require('../electron/scenequeue');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'avpp-v3-'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const notifyCfg = (events = {}) => ({
  telegram: { enabled: true, chats: [{ id: '111', name: 'Me' }, { id: '-222', name: 'Edit group' }] },
  whapi: { enabled: true, chats: [{ id: '+91 98765-43210', name: 'Boss' }, { id: '1203@g.us', name: 'Team' }] },
  events: { renderDone: true, queueDone: true, renderFailed: true, renderCopied: true, sceneDone: true, sceneQueueDone: true, shutdown: true, ...events },
});

function fakeNotifier() {
  const sent = [];
  return { sent, notify: async (ev, text) => { sent.push({ ev, text }); return 1; } };
}

test('whapi numbers become digits, group ids stay', () => {
  assert.strictEqual(normaliseWhapiTarget('+91 98765-43210'), '919876543210');
  assert.strictEqual(normaliseWhapiTarget('120363@g.us'), '120363@g.us');
});

test('notifier sends to every Telegram and WhatsApp chat, with PC name, and respects events', async () => {
  const calls = [];
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body), auth: opts.headers.authorization });
    return { ok: true, status: 200, text: async () => '{"ok":true}' };
  };
  try {
    let settings = { notify: notifyCfg() };
    const n = new Notifier({ getSettings: () => settings, getSecret: (k) => `${k}-token`, log: () => {}, pc: 'EDIT-PC3' });
    assert.strictEqual(await n.notify('renderDone', 'EP 12 rendered'), 4);
    const tg = calls.filter((c) => c.url.includes('telegram'));
    const wa = calls.filter((c) => c.url.includes('whapi'));
    assert.deepStrictEqual(tg.map((c) => c.body.chat_id), ['111', '-222']);
    assert.ok(tg[0].url.includes('/bottelegram-token/sendMessage'));
    assert.deepStrictEqual(wa.map((c) => c.body.to), ['919876543210', '1203@g.us']);
    assert.strictEqual(wa[0].auth, 'Bearer whapi-token');
    assert.match(wa[0].body.body, /EP 12 rendered\n— EDIT-PC3/);
    settings = { notify: notifyCfg({ renderDone: false }) };
    calls.length = 0;
    assert.strictEqual(await n.notify('renderDone', 'x'), 0);
    assert.strictEqual(calls.length, 0);
  } finally {
    global.fetch = realFetch;
  }
});

test('a failing service is logged, the others still get the message', async () => {
  const realFetch = global.fetch;
  const logs = [];
  global.fetch = async (url) => (url.includes('telegram')
    ? { ok: false, status: 401, statusText: 'Unauthorized', text: async () => '{"ok":false,"description":"Unauthorized"}' }
    : { ok: true, status: 200, text: async () => '{}' });
  try {
    const n = new Notifier({ getSettings: () => ({ notify: notifyCfg() }), getSecret: () => 't', log: (l, m) => logs.push(m), pc: 'PC' });
    assert.strictEqual(await n.sendAll('hi'), 2);
    assert.ok(logs.some((m) => /Telegram message to Me failed: 401 Unauthorized/.test(m)));
  } finally {
    global.fetch = realFetch;
  }
});

test('telegram findChats lists people and groups from updates', async () => {
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ ok: true, result: [
    { message: { chat: { id: 111, first_name: 'Utkarsh', type: 'private' } } },
    { my_chat_member: { chat: { id: -222, title: 'Edit Team', type: 'group' } } },
    { message: { chat: { id: 111, first_name: 'Utkarsh', type: 'private' } } },
  ] }) });
  try {
    const chats = await telegram.findChats('t');
    assert.deepStrictEqual(chats.map((c) => [c.id, c.name]), [['111', 'Utkarsh'], ['-222', 'Edit Team']]);
  } finally {
    global.fetch = realFetch;
  }
});

function status(jobs, rendering) {
  return { connected: true, project: { name: 'Edit-1207 to 1208', dbName: 'edit_share_18' }, rendering, jobs };
}

test('render watcher: old completed jobs are ignored; new completions copy, notify and finish the queue', async () => {
  const outDir = tmp(), dest = tmp();
  fs.writeFileSync(path.join(outDir, 'DD Vitraag-8911 (1207).mov'), Buffer.alloc(3000));
  fs.writeFileSync(path.join(outDir, 'DD Vitraag-8912 (1207).mov'), Buffer.alloc(5000));
  const nf = fakeNotifier();
  const queueDone = [];
  const w = new RenderWatcher({
    getSettings: () => ({ renders: { copyEnabled: true, copyDest: dest, afterQueue: 'shutdown' } }),
    notifier: nf, log: () => {}, onChange: () => {}, onQueueDone: (a, what) => queueDone.push([a, what]), settleMs: 0,
  });
  const job = (id, st, file) => ({ id, status: st, file, dir: outDir, name: id, timeline: file, tookMs: 65000 });
  w.update(status([job('old', 'Complete', 'old.mov'), job('a', 'Ready', 'DD Vitraag-8911 (1207).mov'), job('b', 'Ready', 'DD Vitraag-8912 (1207).mov')], false));
  w.update(status([job('old', 'Complete', 'old.mov'), job('a', 'Rendering', 'DD Vitraag-8911 (1207).mov'), job('b', 'Ready', 'DD Vitraag-8912 (1207).mov')], true));
  w.update(status([job('old', 'Complete', 'old.mov'), job('a', 'Complete', 'DD Vitraag-8911 (1207).mov'), job('b', 'Rendering', 'DD Vitraag-8912 (1207).mov')], true));
  w.update(status([job('old', 'Complete', 'old.mov'), job('a', 'Complete', 'DD Vitraag-8911 (1207).mov'), job('b', 'Complete', 'DD Vitraag-8912 (1207).mov')], false));
  for (let i = 0; i < 50 && !queueDone.length; i++) await wait(50);
  assert.deepStrictEqual(fs.readdirSync(dest).sort(), ['DD Vitraag-8911 (1207).mov', 'DD Vitraag-8912 (1207).mov']);
  assert.strictEqual(fs.statSync(path.join(dest, 'DD Vitraag-8912 (1207).mov')).size, 5000);
  assert.ok(fs.existsSync(path.join(outDir, 'DD Vitraag-8911 (1207).mov')), 'original stays');
  assert.deepStrictEqual(nf.sent.filter((s) => s.ev === 'renderDone').length, 2, 'old job not reported');
  assert.match(nf.sent.find((s) => s.ev === 'renderDone').text, /1m 5s/);
  assert.ok(nf.sent.some((s) => s.ev === 'queueDone' && /2 job\(s\)/.test(s.text)));
  assert.deepStrictEqual(queueDone, [['shutdown', 'render queue']]);
});

test('render watcher: a job that finishes between two polls still counts', async () => {
  const nf = fakeNotifier();
  const queueDone = [];
  const w = new RenderWatcher({ getSettings: () => ({ renders: { copyEnabled: false, afterQueue: 'shutdown' } }), notifier: nf, log: () => {}, onChange: () => {}, onQueueDone: (a) => queueDone.push(a), settleMs: 0 });
  w.update(status([{ id: 'a', status: 'Ready', file: 'a.mov' }], false));
  w.update(status([{ id: 'a', status: 'Complete', file: 'a.mov' }], false));
  await wait(50);
  assert.deepStrictEqual(queueDone, ['shutdown']);
});

test('render watcher: library name disappearing while rendering is not a project switch', async () => {
  const nf = fakeNotifier();
  const queueDone = [];
  const w = new RenderWatcher({ getSettings: () => ({ renders: { copyEnabled: false, afterQueue: 'shutdown' } }), notifier: nf, log: () => {}, onChange: () => {}, onQueueDone: (a) => queueDone.push(a), settleMs: 0 });
  const st = (db, r, a, b) => ({ connected: true, rendering: r, project: { name: 'P', dbName: db }, jobs: [{ id: 'A', status: a }, { id: 'B', status: b }] });
  w.update(st('Local Database', false, 'Ready', 'Ready'));
  w.update(st(undefined, true, 'Rendering', 'Ready'));            // as recorded from Resolve
  w.update(st(undefined, true, 'Complete', 'Rendering'));
  w.update(st('Local Database', false, 'Complete', 'Complete'));
  await wait(50);
  assert.strictEqual(nf.sent.filter((s) => s.ev === 'renderDone').length, 2);
  assert.deepStrictEqual(queueDone, ['shutdown']);
});

test('render watcher: pressing Stop never shuts down', async () => {
  const nf = fakeNotifier();
  const queueDone = [];
  const w = new RenderWatcher({ getSettings: () => ({ renders: { copyEnabled: false, afterQueue: 'shutdown' } }), notifier: nf, log: () => {}, onChange: () => {}, onQueueDone: (a) => queueDone.push(a), settleMs: 0 });
  w.update(status([{ id: 'a', status: 'Ready' }, { id: 'b', status: 'Ready' }], false));
  w.update(status([{ id: 'a', status: 'Rendering' }, { id: 'b', status: 'Ready' }], true));
  w.update(status([{ id: 'a', status: 'Complete' }, { id: 'b', status: 'Rendering' }], true));
  w.update(status([{ id: 'a', status: 'Complete' }, { id: 'b', status: 'Cancelled' }], false));
  await wait(50);
  assert.deepStrictEqual(queueDone, []);
  assert.ok(nf.sent.some((s) => s.ev === 'queueDone' && /stopped/.test(s.text)));
});

test('scene queue runs timelines in order, reports cuts, and stops after current', async () => {
  const ran = [];
  const bridge = { detectSceneCuts: async (name) => { ran.push(name); await wait(5); return { ok: name !== 'Bad', error: 'nope', before: 3, after: 10, seconds: 75 }; } };
  const nf = fakeNotifier();
  const after = [];
  const q = new SceneQueue({ bridge, notifier: nf, log: () => {}, onChange: () => {}, onQueueDone: (a) => after.push(a), getSettings: () => ({ scene: { afterQueue: 'shutdown' } }) });
  q.add('Proj', ['Master-1207', 'Bad', 'Master-1208']);
  q.add('Proj', ['Master-1207']);                               // no duplicates
  assert.strictEqual(q.items.length, 3);
  assert.deepStrictEqual(await q.start('Other project'), { ok: false, error: 'Open the project "Proj" in Resolve first (the queue belongs to it).' });
  const r = await q.start('Proj');
  assert.deepStrictEqual(ran, ['Master-1207', 'Bad', 'Master-1208']);
  assert.deepStrictEqual([r.done, r.failed], [2, 1]);
  assert.strictEqual(q.items[0].cuts, 7);
  assert.ok(nf.sent.some((s) => s.ev === 'sceneQueueDone' && /2 done, 1 failed/.test(s.text)));
  assert.deepStrictEqual(after, ['shutdown']);

  const q2 = new SceneQueue({ bridge: { detectSceneCuts: async () => { q2.stop(); return { ok: true, before: 1, after: 2, seconds: 1 }; } },
    notifier: fakeNotifier(), log: () => {}, onChange: () => {}, onQueueDone: (a) => after.push(a), getSettings: () => ({ scene: { afterQueue: 'shutdown' } }) });
  q2.add('P', ['A', 'B']);
  await q2.start('P');
  assert.deepStrictEqual(q2.items.map((i) => i.state), ['done', 'waiting']);
  assert.deepStrictEqual(after, ['shutdown'], 'stopped queue does not shut down');
});

test('render watcher: a short gap between two jobs is not the end of the queue', async () => {
  const nf = fakeNotifier();
  const queueDone = [];
  const w = new RenderWatcher({ getSettings: () => ({ renders: { copyEnabled: false, afterQueue: 'shutdown' } }), notifier: nf, log: () => {}, onChange: () => {}, onQueueDone: (a) => queueDone.push(a), settleMs: 300 });
  w.update(status([{ id: 'a', status: 'Ready' }, { id: 'b', status: 'Ready' }], false));
  w.update(status([{ id: 'a', status: 'Rendering' }, { id: 'b', status: 'Ready' }], true));
  w.update(status([{ id: 'a', status: 'Complete' }, { id: 'b', status: 'Ready' }], false));   // gap between jobs
  await wait(100);
  w.update(status([{ id: 'a', status: 'Complete' }, { id: 'b', status: 'Ready' }], false));
  w.update(status([{ id: 'a', status: 'Complete' }, { id: 'b', status: 'Rendering' }], true));
  assert.deepStrictEqual(queueDone, [], 'must not finish during the gap');
  w.update(status([{ id: 'a', status: 'Complete' }, { id: 'b', status: 'Complete' }], false));
  w.update(status([{ id: 'a', status: 'Complete' }, { id: 'b', status: 'Complete' }], false));
  assert.deepStrictEqual(queueDone, [], 'still settling');
  await wait(350);
  w.update(status([{ id: 'a', status: 'Complete' }, { id: 'b', status: 'Complete' }], false));
  await wait(50);
  assert.deepStrictEqual(queueDone, ['shutdown']);
  assert.ok(nf.sent.some((s) => s.ev === 'queueDone' && s.text.includes('2 job(s) done')));
});

function hdWatcher({ hd, startHd, finishHd, copyDest = '' }) {
  const nf = fakeNotifier();
  const after = [];
  const w = new RenderWatcher({
    getSettings: () => ({ renders: { copyEnabled: Boolean(copyDest), copyDest, afterQueue: 'shutdown', hd } }),
    notifier: nf, log: () => {}, onChange: () => {}, onQueueDone: (a) => after.push(a), startHd, finishHd, settleMs: 0,
  });
  return { w, nf, after };
}
const P2 = { name: 'Edit-1207 to 1208', dbName: 'edit_share_18' };
const st2 = (rendering, jobs) => ({ connected: true, project: P2, rendering, jobs });

test('HD review pass: main renders -> one HD batch job -> finish (rename/copy/cleanup) -> then shutdown', async () => {
  const out = tmp();
  fs.writeFileSync(path.join(out, 'EP-11 (1207).mov'), Buffer.alloc(100));
  fs.writeFileSync(path.join(out, 'EP-12 (1207, 1208).mov'), Buffer.alloc(100));
  let asked = null;
  let finished = null;
  const { w, nf, after } = hdWatcher({
    hd: { enabled: true, preset: 'HD Review', onlyUhd: true },
    startHd: async (jobs) => { asked = jobs.map((j) => j.file); return { ok: true, ids: ['HD1'], mode: 'individual', batch: { folder: 'tmp-bin' } }; },
    finishHd: async (batch) => { finished = batch; return { files: ['X/EP-11 (1207)_HD.mp4', 'X/EP-12 (1207, 1208)_HD.mp4'], problems: [] }; },
  });
  const job = (id, file, s) => ({ id, status: s, dir: out, file, width: 3840, timeline: file });
  w.update(st2(false, [job('A', 'EP-11 (1207).mov', 'Ready'), job('B', 'EP-12 (1207, 1208).mov', 'Ready')]));
  w.update(st2(true, [job('A', 'EP-11 (1207).mov', 'Rendering'), job('B', 'EP-12 (1207, 1208).mov', 'Ready')]));
  w.update(st2(false, [job('A', 'EP-11 (1207).mov', 'Complete'), job('B', 'EP-12 (1207, 1208).mov', 'Complete')]));
  await wait(50);
  assert.deepStrictEqual(asked, ['EP-11 (1207).mov', 'EP-12 (1207, 1208).mov'], 'both episodes in one batch');
  assert.deepStrictEqual(after, [], 'no shutdown while the HD job is pending');
  // The HD job finishes before PostPilot ever saw it rendering: still counted.
  w.update(st2(false, [job('A', 'EP-11 (1207).mov', 'Complete'), job('B', 'EP-12 (1207, 1208).mov', 'Complete'),
    { id: 'HD1', status: 'Complete', dir: out, file: 'EP-11 (1207)_00000000.mov and more', width: 1920 }]));
  for (let i = 0; i < 40 && !after.length; i++) await wait(25);
  assert.deepStrictEqual(finished, { folder: 'tmp-bin' }, 'finishHd got the batch');
  assert.deepStrictEqual(after, ['shutdown']);
  assert.ok(nf.sent.some((s) => s.text.includes('HD review finished: 2 file(s)') && s.text.includes('EP-12 (1207, 1208)_HD.mp4')));
  assert.ok(!nf.sent.some((s) => s.ev === 'renderDone' && s.text.includes('00000000')), 'no confusing per-job message for the batch');
});

test('HD files: Resolve frame-number names are renamed to the episode name + suffix', () => {
  const { collectHdFiles } = require('../electron/hdreview');
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'Hindi Shibir-07 (2980M, 2980E)_00000000.mov'), 'a');
  fs.writeFileSync(path.join(dir, 'Hindi Shibir-08 (2980E)_HD.mp4'), 'b');          // per-episode fallback name
  fs.writeFileSync(path.join(dir, 'Hindi Shibir-10 (2981)00000000.mov'), 'c');      // seen live: no underscore
  fs.writeFileSync(path.join(dir, 'EP 12.mov'), 'd');                               // must not count as "EP 1"
  fs.writeFileSync(path.join(dir, 'Hindi Shibir-09 (2980E)_HD.mp4'), 'old');        // already there from before…
  fs.utimesSync(path.join(dir, 'Hindi Shibir-09 (2980E)_HD.mp4'), 1, 1);            // …and old: not this batch
  const r = collectHdFiles({ dir, bases: ['Hindi Shibir-07 (2980M, 2980E)', 'Hindi Shibir-08 (2980E)', 'Hindi Shibir-09 (2980E)', 'Hindi Shibir-10 (2981)', 'EP 1'], suffix: '_HD', since: Date.now() - 1000 });
  assert.deepStrictEqual(r.files.map((f) => path.basename(f)), ['Hindi Shibir-07 (2980M, 2980E)_HD.mov', 'Hindi Shibir-08 (2980E)_HD.mp4', 'Hindi Shibir-10 (2981)_HD.mov']);
  assert.deepStrictEqual(r.problems, ['no HD file found for "Hindi Shibir-09 (2980E)"', 'no HD file found for "EP 1"']);
  assert.ok(fs.existsSync(path.join(dir, 'EP 12.mov')), 'EP 12 untouched');
  assert.ok(!fs.existsSync(path.join(dir, 'Hindi Shibir-07 (2980M, 2980E)_00000000.mov')));
});

test('HD review switched off, or nothing bigger than HD: straight to shutdown', async () => {
  for (const [hd, width] of [[{ enabled: false }, 3840], [{ enabled: true, preset: 'x', onlyUhd: true }, 1920]]) {
    let called = false;
    const { w, after } = hdWatcher({ hd, startHd: async () => { called = true; return { ok: true, ids: ['X'] }; } });
    w.update(st2(false, [{ id: 'A', status: 'Ready', width }]));
    w.update(st2(false, [{ id: 'A', status: 'Complete', width }]));
    await wait(50);
    assert.strictEqual(called, false);
    assert.deepStrictEqual(after, ['shutdown']);
  }
});

test('HD review that cannot start is reported and never blocks shutdown', async () => {
  const { w, nf, after } = hdWatcher({
    hd: { enabled: true, preset: 'HD Review', onlyUhd: false },
    startHd: async () => ({ ok: false, error: 'HD render folder not reachable: Y:\HD' }),
  });
  w.update(st2(false, [{ id: 'A', status: 'Ready' }]));
  w.update(st2(false, [{ id: 'A', status: 'Complete' }]));
  await wait(50);
  assert.ok(nf.sent.some((s) => /HD review renders not started: HD render folder not reachable/.test(s.text)));
  assert.deepStrictEqual(after, ['shutdown']);
});

test('HD review timelines are not treated as episodes', () => {
  const ep = require('../electron/episodes');
  const found = ep.findSeries(['DD Vitraag-8911 (1207)', 'DD Vitraag-8911 (1207).mov', 'Hindi Shibir-07 (2980M, 2980E)_v2.mov']);
  assert.deepStrictEqual(found.map((s) => [s.series, s.count]), [['DD Vitraag', 1]]);
});
