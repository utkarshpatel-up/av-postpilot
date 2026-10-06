const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DEFAULTS, LibraryBackup, monitor, ownedRoot, prune, windowsSchedule, macSchedule } = require('../electron/library-backup');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'postpilot-backup-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  for (const n of ['psql', 'pg_dump', 'pg_restore', 'pg_dumpall']) fs.writeFileSync(path.join(bin, n + '.exe'), '');
  const settings = { ...DEFAULTS, mode: 'server', root: dir, pgBin: bin };
  const data = { libraries: [{ name: 'edit_share_18', count: 12 }], failDiscover: false, failVerify: false };
  const events = [];
  const tool = async (exe, args, env) => {
    assert.equal(env.PGPASSWORD, 'test-password');
    switch (path.basename(exe)) {
      case 'psql.exe': {
        const sql = args.at(-1);
        if (sql.includes('pg_database')) { if (data.failDiscover) throw Error('connection refused'); return JSON.stringify(data.libraries.map(l => l.name)); }
        if (sql.includes('to_regclass')) return 't';
        return String(data.libraries.find(l => l.name === args[args.indexOf('-d') + 1]).count);
      }
      case 'pg_dump.exe': case 'pg_dumpall.exe': fs.writeFileSync(args[args.indexOf('-f') + 1], 'mock archive'); return '';
      case 'pg_restore.exe': if (data.failVerify) throw Error('invalid archive'); return 'archive contents';
      default: throw Error('Unexpected tool');
    }
  };
  const engine = new LibraryBackup({ getSettings: () => settings, getPassword: () => 'test-password', tool, platform: 'win32', notify: async (...args) => events.push(args) });
  return { settings, data, engine, events, dir };
}

test('library backups publish verified archives, roles and secondary status', async t => {
  const f = fixture(t); f.settings.copyRoot = path.join(f.dir, 'secondary'); fs.mkdirSync(f.settings.copyRoot);
  const result = await f.engine.run(); assert.equal(result.ok, true);
  assert.equal(result.libraries[0].count, 12);
  assert.ok(fs.existsSync(result.libraries[0].file));
  assert.ok(fs.existsSync(path.join(f.settings.copyRoot, 'AV-PostPilot-Libraries', 'status.json')));
  assert.equal(fs.readdirSync(path.join(ownedRoot(f.settings), '_globals')).length, 1);
  assert.equal(monitor(f.settings).libraries.length, 1);
  assert.equal(f.engine.running, false);
});
test('project count drop preserves previous dump and emits an alert', async t => {
  const f = fixture(t); const first = await f.engine.run(); f.data.libraries[0].count = 3;
  const second = await f.engine.run(); assert.equal(second.ok, true);
  assert.ok(fs.existsSync(path.join(ownedRoot(f.settings), 'PROTECTED', 'edit_share_18', path.basename(first.libraries[0].file))));
  assert.ok(f.events.some(([kind]) => kind === 'libraryAlert'));
});
test('missing library is protected while discovery failure does not mark deletion', async t => {
  const f = fixture(t); await f.engine.run(); f.data.failDiscover = true;
  assert.equal((await f.engine.run()).ok, false);
  assert.equal(monitor(f.settings).state.libraries[0].missing, false);
  f.data.failDiscover = false; f.data.libraries = [];
  const missing = await f.engine.run(); assert.equal(missing.ok, false);
  assert.equal(missing.libraries[0].missing, true);
  assert.equal(monitor(f.settings).protectedFiles.length, 1);
});
test('invalid archive retains last good baseline and releases lock', async t => {
  const f = fixture(t); const first = await f.engine.run(); f.data.failVerify = true;
  const failed = await f.engine.run(); assert.equal(failed.ok, false);
  assert.equal(failed.libraries[0].file, first.libraries[0].file);
  assert.equal(failed.lastSuccess, first.lastSuccess);
  assert.equal(monitor(f.settings).locked, false);
  assert.equal(fs.readdirSync(path.dirname(first.libraries[0].file)).some(n => n.endsWith('.part')), false);
});
test('unreachable secondary still produces local dump and reports failure', async t => {
  const f = fixture(t); f.settings.copyRoot = path.join(f.dir, 'offline');
  const result = await f.engine.run(); assert.equal(result.ok, false);
  assert.ok(fs.existsSync(result.libraries[0].file)); assert.equal(result.lastSuccess, null);
});
test('lock and corrupt status prevent a backup from overwriting history', async t => {
  const f = fixture(t); const root = ownedRoot(f.settings); fs.mkdirSync(root);
  fs.mkdirSync(path.join(root, 'backup.lock'));
  assert.equal((await f.engine.run()).ok, false);
  fs.rmdirSync(path.join(root, 'backup.lock'));
  fs.writeFileSync(path.join(root, 'status.json'), '{broken');
  await assert.rejects(f.engine.run()); assert.equal(fs.existsSync(path.join(root, 'backup.lock')), false);
});
test('retention removes only aged owned archives beyond the minimum', t => {
  const f = fixture(t); const dir = path.join(f.dir, 'retention'); fs.mkdirSync(dir);
  for (let i = 0; i < 4; i++) { const file = path.join(dir, `pp-20200101-00000${i}-aabbccdd.dump`); fs.writeFileSync(file, 'data'); fs.utimesSync(file, new Date(2020, 0, 1, 0, 0, i), new Date(2020, 0, 1, 0, 0, i)); }
  fs.writeFileSync(path.join(dir, 'manual.dump'), 'keep');
  prune(dir, { keepDays: 30, keepMin: 2 }); assert.equal(fs.readdirSync(dir).length, 3);
});
test('existing Mac backup folders expose counts, protected archives and stale health', t => {
  const f = fixture(t); fs.mkdirSync(path.join(f.dir, 'db', 'edit_share'), { recursive: true }); fs.mkdirSync(path.join(f.dir, 'state')); fs.mkdirSync(path.join(f.dir, 'PROTECTED'));
  const file = path.join(f.dir, 'db', 'edit_share', 'mac.dump'); fs.writeFileSync(file, 'archive'); fs.utimesSync(file, new Date(2020, 0, 1), new Date(2020, 0, 1));
  fs.writeFileSync(path.join(f.dir, 'state', 'edit_share.count'), '25'); fs.writeFileSync(path.join(f.dir, 'PROTECTED', 'old.dump'), 'archive');
  const result = monitor(f.settings); assert.equal(result.libraries[0].count, 25); assert.equal(result.libraries[0].stale, true); assert.equal(result.protectedFiles.length, 1);
});
test('Windows schedule exports headless tasks without embedding credentials', t => {
  const f = fixture(t); const script = windowsSchedule(f.settings, "C:\\PostPilot's folder\\AV PostPilot.exe", 'C:\\Users\\editor\\AppData\\Roaming\\PostPilot', true);
  assert.ok(script.includes('--library-backup-run')); assert.ok(script.includes('Get-Credential')); assert.ok(script.includes("PostPilot''s folder")); assert.ok(!script.includes('test-password'));
  assert.throws(() => windowsSchedule({ times: '25:00' }, 'exe', 'data'));
});
test('Mac schedule escapes paths and exports a user launchd installer without credentials', t => {
  const f = fixture(t); const result = macSchedule(f.settings, '/Applications/A&B/AV PostPilot.app/Contents/MacOS/AV PostPilot', '/Users/editor/Library/Application Support/AV PostPilot');
  assert.ok(result.plist.includes('A&amp;B')); assert.ok(result.plist.includes('--library-backup-run'));
  assert.equal((result.plist.match(/<key>Hour<\/key>/g) || []).length, 5);
  assert.ok(result.installer.includes('launchctl bootstrap')); assert.ok(result.installer.includes(result.label));
  assert.ok(!result.plist.includes('test-password')); assert.ok(!result.installer.includes('sudo'));
});
test('protected snapshots from different libraries cannot overwrite each other', async t => {
  const f = fixture(t); f.data.libraries.push({ name: 'second_library', count: 8 });
  await f.engine.run(); for (const l of f.data.libraries) l.count--;
  await f.engine.run(); assert.equal(monitor(f.settings).protectedFiles.length, 2);
});
