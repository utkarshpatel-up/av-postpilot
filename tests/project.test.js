const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ps = require('../electron/project-setup');
const ep = require('../electron/episodes');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'avpp-proj-'));
const touch = (f, bytes = 10) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, Buffer.alloc(bytes)); };

test('session code is the word before Dt-', () => {
  assert.strictEqual(ps.sessionCode('Adalaj Hindi Shibir Parayan on Hindi Aptavani E. Dt-03-Jun-26 Dur-1h28m Clips-02'), 'E');
  assert.strictEqual(ps.sessionCode('01 Adalaj Hindi Shibir Satsang on Topic E1 Dt-05-Jun-26 Dur-1h23m Clips-02'), 'E1');
  assert.strictEqual(ps.sessionCode("02 Adalaj Hindi Shibir Pujyashree's Dinner, Informal Session E2. Dt-06-Jun-26 Dur-51m16s Clips-03"), 'E2');
  assert.strictEqual(ps.sessionCode('01 Adalaj Hindi Shibir Satsang on Topic M. Dt-07-Jun-26 Dur-1h26m Clips-02'), 'M');
  assert.strictEqual(ps.sessionCode('02 Adalaj Hindi Shibir General Satsang E. Dt-07-Jun-26 Dur-1h42m Clips-03'), 'E');
  assert.strictEqual(ps.sessionCode('Morning M2 Dt-01-Jan-26'), 'M2');
});

test('single session has no suffix, several get their code; clips in Clip-NN order', () => {
  const root = tmp();
  const one = path.join(root, '2978 Dt-03 Jun 2026');
  const s1 = path.join(one, 'Adalaj Parayan on Hindi Aptavani E. Dt-03-Jun-26 Clips-02');
  touch(path.join(s1, 'x Clip-02.MOV')); touch(path.join(s1, 'x Clip-01.MOV'));
  touch(path.join(s1, 'Clips for Insert', 'insert.MOV')); touch(path.join(s1, '.DS_Store'));
  const d1 = ps.scanDay(one);
  assert.strictEqual(d1.sessions.length, 1);
  assert.strictEqual(d1.sessions[0].master, 'Master-2978');
  assert.strictEqual(d1.sessions[0].edit, 'Edit-2978');
  assert.deepStrictEqual(d1.sessions[0].clips.map((c) => path.basename(c)), ['x Clip-01.MOV', 'x Clip-02.MOV']);

  const two = path.join(root, '2982 Dt-07 Jun 2026');
  touch(path.join(two, '01 Satsang on Topic M. Dt-07-Jun-26 Clips-02', 'a Clip-01.MOV'));
  touch(path.join(two, '02 General Satsang E. Dt-07-Jun-26 Clips-03', 'b Clip-10.MOV'));
  touch(path.join(two, '02 General Satsang E. Dt-07-Jun-26 Clips-03', 'b Clip-9.MOV'));
  const d2 = ps.scanDay(two);
  assert.deepStrictEqual(d2.sessions.map((s) => s.master), ['Master-2982 M', 'Master-2982 E']);
  assert.deepStrictEqual(d2.sessions[1].clips.map((c) => path.basename(c)), ['b Clip-9.MOV', 'b Clip-10.MOV']);
});

test('media tree mirrors nested folders including Clips for Insert', () => {
  const root = tmp();
  const day = path.join(root, '2978 Dt-03 Jun 2026');
  touch(path.join(day, 'S1', 'a Clip-01.MOV'));
  touch(path.join(day, 'S1', 'Clips for Insert', 'i.mp4'));
  const tree = ps.mediaTree(day, ['Satsang Files', '2978 Dt-03 Jun 2026']);
  assert.deepStrictEqual(tree.map((t) => t.bin.join('/')), [
    'Satsang Files/2978 Dt-03 Jun 2026',
    'Satsang Files/2978 Dt-03 Jun 2026/S1',
    'Satsang Files/2978 Dt-03 Jun 2026/S1/Clips for Insert',
  ]);
  assert.strictEqual(tree[2].files.length, 1);
});

test('copy keeps the original; same-drive move is a rename', async () => {
  const src = path.join(tmp(), '2978 Dt-03 Jun 2026');
  touch(path.join(src, 'S1', 'a Clip-01.MOV'), 5000);
  const dest1 = tmp();
  const r1 = await ps.transferFolder(src, dest1, { move: false });
  assert.strictEqual(r1.moved, false);
  assert.ok(fs.existsSync(src));
  assert.strictEqual(fs.statSync(path.join(dest1, '2978 Dt-03 Jun 2026', 'S1', 'a Clip-01.MOV')).size, 5000);
  await assert.rejects(ps.transferFolder(src, dest1, { move: false }), /already exists/);
  const dest2 = tmp();                                   // same drive (temp folder)
  const r2 = await ps.transferFolder(src, dest2, { move: true });
  assert.strictEqual(r2.moved, true);
  assert.ok(!fs.existsSync(src));
  assert.ok(fs.existsSync(path.join(dest2, '2978 Dt-03 Jun 2026', 'S1', 'a Clip-01.MOV')));
});

test('a folder in use is retried, then reported clearly without moving anything', async () => {
  const d = path.join(tmp(), 'busy-day');
  touch(path.join(d, 'a Clip-01.MOV'), 100);
  const realRename = fs.promises.rename;
  let calls = 0;
  fs.promises.rename = async () => { calls++; const e = new Error('EPERM'); e.code = 'EPERM'; throw e; };
  const realTimeout = global.setTimeout;
  global.setTimeout = (fn) => realTimeout(fn, 0);          // skip the 2 s waits in the test
  try {
    await assert.rejects(ps.transferFolder(d, tmp(), { move: true }), /a file in it is open/);
    assert.strictEqual(calls, 6);
    assert.ok(fs.existsSync(path.join(d, 'a Clip-01.MOV')));
  } finally {
    fs.promises.rename = realRename;
    global.setTimeout = realTimeout;
  }
});

test('across drives the original is never deleted, even with move on', async () => {
  const d = path.join(tmp(), 'other-drive-day');
  touch(path.join(d, 'a Clip-01.MOV'), 100);
  const realRename = fs.promises.rename;
  fs.promises.rename = async () => { const e = new Error('cross-device'); e.code = 'EXDEV'; throw e; };
  try {
    const r = await ps.transferFolder(d, tmp(), { move: true });
    assert.strictEqual(r.moved, false);
    assert.ok(fs.existsSync(path.join(d, 'a Clip-01.MOV')), 'original must still exist');
  } finally {
    fs.promises.rename = realRename;
  }
});

test('series names, titles with and without number', () => {
  const plan = ep.planSeries({ series: 'Hindi Shibir', title: 'DD Hindi', subtitle: '(Hindi Shibir, Adalaj)', start: 1, showNumber: false,
    rows: [{ cue: '2978', count: 3 }, { cue: '2980 M', count: 2 }] });
  assert.deepStrictEqual(plan.map((p) => p.name), [
    'Hindi Shibir-01 (2978)', 'Hindi Shibir-02 (2978)', 'Hindi Shibir-03 (2978)', 'Hindi Shibir-04 (2980 M)', 'Hindi Shibir-05 (2980 M)']);
  assert.strictEqual(plan[0].line1, 'DD Hindi -');
  const fin = ep.planSeries({ series: 'DD Hindi', title: 'DD Hindi', subtitle: '', start: 1750, showNumber: true, rows: [{ cue: '2978', count: 2 }] });
  assert.deepStrictEqual(fin.map((p) => [p.name, p.line1]), [['DD Hindi-1750 (2978)', 'DD Hindi - 1750'], ['DD Hindi-1751 (2978)', 'DD Hindi - 1751']]);
});

test('an episode can come from several folders, and renaming keeps that', () => {
  const plan = ep.planSeries({ series: 'Hindi Shibir', title: 'DD Hindi', subtitle: '', start: 7, showNumber: false,
    rows: [{ cue: '2978', count: 1 }, { cue: '2978, 2980 M', count: 1 }, { cue: '2980 M', count: 1 }] });
  assert.deepStrictEqual(plan.map((p) => p.name), ['Hindi Shibir-07 (2978)', 'Hindi Shibir-08 (2978, 2980 M)', 'Hindi Shibir-09 (2980 M)']);
  const renamed = ep.planRename(ep.findSeries(plan.map((p) => p.name))[0], { series: 'DD Hindi', title: 'DD Hindi', start: 1750, showNumber: true });
  assert.strictEqual(renamed[1].name, 'DD Hindi-1751 (2978, 2980 M)');
});

test('rename keeps the bracket part exactly, even a broken one', () => {
  const names = ['Master-2978', 'Edit-2978', 'Hindi Shibir-01 (2978)', 'Hindi Shibir-02 (2978)', 'Hindi Shibir-04 (2980 M)',
    'Hindi Shibir-03 (2980 M)', 'Hindi Shibir-10 (29', 'DD Vitraag-01 (3001)'];
  const found = ep.findSeries(names);
  assert.deepStrictEqual(found.map((s) => [s.series, s.count]), [['DD Vitraag', 1], ['Hindi Shibir', 5]]);
  const plan = ep.planRename(found[1], { series: 'DD Hindi', title: 'DD Hindi', start: 1750, showNumber: true });
  assert.deepStrictEqual(plan.map((p) => p.name), [
    'DD Hindi-1750 (2978)', 'DD Hindi-1751 (2978)', 'DD Hindi-1752 (2980 M)', 'DD Hindi-1753 (2980 M)', 'DD Hindi-1754 (29']);
  assert.strictEqual(plan[0].old, 'Hindi Shibir-01 (2978)');
  assert.strictEqual(plan[4].line1, 'DD Hindi - 1754');
  assert.strictEqual(plan[0].subtitle, null);
});

test('project folder template: user list, Satsang Files always included, re-run safe', () => {
  assert.deepStrictEqual(ps.projectFolders(), ['Audio', 'Resolve Export', 'Satsang Files', 'Scratch Disk']);
  assert.deepStrictEqual(ps.projectFolders(['Audio', 'Graphics']), ['Audio', 'Graphics', 'Satsang Files']);
  assert.deepStrictEqual(ps.projectFolders(['Audio', 'satsang files', 'Audio']), ['Audio', 'satsang files']);
  const loc = tmp();
  const root = ps.createProjectFolders(loc, 'Edit-1 to 2', ['Audio', 'Graphics']);
  ps.createProjectFolders(loc, 'Edit-1 to 2', ['Audio', 'Graphics']);      // again: no error
  assert.deepStrictEqual(fs.readdirSync(root).sort(), ['Audio', 'Graphics', 'Satsang Files']);
});

test('Satsang Files can be left out only when footage stays where it is', () => {
  assert.deepStrictEqual(ps.projectFolders(['Audio'], { needSatsang: true }), ['Audio', 'Satsang Files']);
  assert.deepStrictEqual(ps.projectFolders(['Audio'], { needSatsang: false }), ['Audio']);
  const root = ps.createProjectFolders(tmp(), 'Leave test', ['Audio'], { needSatsang: false });
  assert.deepStrictEqual(fs.readdirSync(root), ['Audio']);
});
