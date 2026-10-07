const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AutoSaver, prune, safeName } = require('../electron/autosave');

const SAMPLE = path.join(__dirname, 'fixtures');   // small .drp exports from Resolve 21
const hasSamples = fs.existsSync(path.join(SAMPLE, 'e4.drp'));

function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'avpp-test-')); }

// Fake bridge that "exports" by copying a sample .drp.
function fakeBridge(project, sampleFile) {
  return {
    status: async () => ({ connected: true, project: { name: project, dbName: 'edit_share_18', dbType: 'PostgreSQL' } }),
    save: async () => ({ ok: true }),
    exportProject: async (file) => { fs.copyFileSync(sampleFile(), file); return { ok: true }; },
  };
}

function makeSaver(dests, bridge, extra = {}) {
  const settings = { autosave: { enabled: true, intervalMin: 15, keepDays: 30, keepMin: 20, skipUntitled: true, destinations: dests, ...extra } };
  return new AutoSaver({
    bridge, getSettings: () => settings, state: { fp: {} }, saveState: () => {},
    log: () => {}, onChange: () => {}, tmpDir: tmpdir(),
  });
}

const drps = (dir) => {
  const out = [];
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else if (p.endsWith('.drp')) out.push(p);
  });
  walk(dir);
  return out;
};

test('safeName strips characters Windows does not allow', () => {
  assert.strictEqual(safeName('EP 12: "Final" cut?'), 'EP 12_ _Final_ cut_');
  assert.strictEqual(safeName('name. '), 'name');
});

test('temporary encoder projects are never exported to backup folders', async () => {
  const dir = tmpdir();
  const bridge = { status: async () => ({ connected: true, encoderProject: true, project: { name: 'Temporary' } }), exportProject: async () => { throw Error('Must not export'); } };
  const result = await makeSaver([{ enabled: true, path: dir }], bridge).run();
  assert.match(result.message, /Skipped the temporary encoder project/);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('prune keeps the newest N even when all are old', () => {
  const dir = tmpdir();
  const old = Date.now() / 1000 - 90 * 86400;
  for (let i = 0; i < 15; i++) {
    const f = path.join(dir, `p_${i}.drp`);
    fs.writeFileSync(f, 'x');
    fs.utimesSync(f, old + i, old + i);
  }
  prune(dir, 30, 10, () => {});
  assert.strictEqual(fs.readdirSync(dir).length, 10);
});

test('unchanged project is saved once, changed project again', { skip: !hasSamples && 'needs tests/fixtures sample exports' }, async () => {
  const a = tmpdir(), b = tmpdir();
  let sample = 'e4.drp';
  const saver = makeSaver([{ path: a, enabled: true }, { path: b, enabled: true }],
    fakeBridge('EP 12', () => path.join(SAMPLE, sample)));

  let r = await saver.runOnce('test');
  assert.strictEqual(r.saved, 2);
  sample = 'e5.drp';                          // same content, different volatile ids
  r = await saver.runOnce('test');
  assert.strictEqual(r.saved, 0);
  assert.strictEqual(r.unchanged, 2);
  sample = 'e6.drp';                          // real change
  r = await saver.runOnce('test');
  assert.strictEqual(r.saved, 2);
  assert.strictEqual(drps(a).length, 2);
  assert.match(drps(a)[0], /edit_share_18[\\/]EP 12[\\/]EP 12_\d{4}-\d\d-\d\d_\d{4}(_\d)?\.drp$/);
});

test('offline location is skipped, never created, and catches up later', { skip: !hasSamples && 'needs tests/fixtures sample exports' }, async () => {
  const local = tmpdir();
  const nas = path.join(tmpdir(), 'nas-share');            // does not exist yet = offline
  const saver = makeSaver([{ path: local, enabled: true }, { path: nas, enabled: true }],
    fakeBridge('EP 1', () => path.join(SAMPLE, 'e4.drp')));

  let r = await saver.runOnce('test');
  assert.strictEqual(r.saved, 1);
  assert.strictEqual(r.failed, 1);
  assert.ok(!fs.existsSync(nas), 'must not create an offline destination');

  fs.mkdirSync(nas);                                       // NAS comes back
  r = await saver.runOnce('test');
  assert.strictEqual(r.saved, 1);
  assert.strictEqual(r.unchanged, 1);
  assert.strictEqual(drps(nas).length, 1);
});

test('PC folder: off for local disks, on for network, overridable', { skip: !hasSamples && 'needs tests/fixtures sample exports' }, async () => {
  const pc = safeName(os.hostname());
  const local = tmpdir(), net = tmpdir(), forced = tmpdir();
  const saver = makeSaver([
    { path: local, enabled: true },                      // auto: local disk -> no PC folder
    { path: net, enabled: true },                        // auto: treated as network below
    { path: forced, enabled: true, pcFolder: true },     // explicit override
  ], fakeBridge('EP 7', () => path.join(SAMPLE, 'e4.drp')));
  saver.isNetworkPath = async (p) => p === net;
  await saver.runOnce('test');
  const rel = (root) => path.relative(root, drps(root)[0]).split(path.sep);
  assert.deepStrictEqual(rel(local).slice(0, 2), ['edit_share_18', 'EP 7']);
  assert.deepStrictEqual(rel(net).slice(0, 3), [pc, 'edit_share_18', 'EP 7']);
  assert.deepStrictEqual(rel(forced).slice(0, 3), [pc, 'edit_share_18', 'EP 7']);
});

test('Untitled Project is skipped when the option is on', async () => {
  const saver = makeSaver([{ path: tmpdir(), enabled: true }], fakeBridge('Untitled Project', () => ''));
  const r = await saver.runOnce('test');
  assert.match(r.message, /Skipped/);
});
