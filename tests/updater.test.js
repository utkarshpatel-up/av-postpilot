const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { Updater, unsupportedReason } = require('../electron/updater');

function fake(over = {}) {
  const u = new EventEmitter();
  Object.assign(u, { calls: [], checkForUpdates: async () => { u.calls.push('check'); }, downloadUpdate: async () => { u.calls.push('download'); }, quitAndInstall: (...a) => u.calls.push(['install', ...a]) }, over);
  return u;
}
const make = (o = {}, busy = () => '') => { const updater = fake(o); const changes = []; return { updater, changes, up: new Updater({ updater, version: '3.3.1', busy, onChange: (s) => changes.push(s.state) }) }; };

test('unsupported modes explain themselves', () => {
  assert.match(unsupportedReason({ isPackaged: false }), /source/);
  assert.match(unsupportedReason({ isPackaged: true, platform: 'darwin' }), /macOS/);
  const win = { isPackaged: true, platform: 'win32', execPath: 'C:\\A\\AV PostPilot.exe', resourcesPath: 'C:\\A\\resources', env: {} };
  assert.match(unsupportedReason({ ...win, exists: () => false }), /portable/);
  assert.match(unsupportedReason({ ...win, env: { PORTABLE_EXECUTABLE_FILE: 'x' }, exists: () => true }), /portable/);
  assert.equal(unsupportedReason({ ...win, exists: () => true }), '');
});

test('disabled updater never touches electron-updater', async () => {
  const up = new Updater({ updater: null, version: '1', reason: 'dev' });
  assert.equal(up.state, 'disabled');
  assert.equal((await up.check()).ok, false);
  assert.equal(up.install().ok, false);
  up.start();
});

test('check -> available -> download -> ready -> install', async () => {
  const { updater, up, changes } = make();
  updater.checkForUpdates = async () => { updater.emit('update-available', { version: '3.4.0' }); };
  updater.downloadUpdate = async () => { updater.emit('download-progress', { percent: 42.4 }); updater.emit('update-downloaded', { version: '3.4.0' }); };
  assert.equal(updater.autoDownload, false); assert.equal(updater.autoInstallOnAppQuit, false);
  await up.check(); await new Promise((r) => setImmediate(r));
  assert.deepEqual(changes, ['checking', 'downloading', 'downloading', 'ready']);
  assert.equal(up.summary().available, '3.4.0');
  assert.deepEqual(up.install(), { ok: true });
  assert.deepEqual(updater.calls.pop(), ['install', false, true]);
  assert.equal(up.install().ok, true, 'a second press only quits again');
  assert.equal(updater.calls.filter((c) => Array.isArray(c)).length, 0, 'calls were popped: no second quitAndInstall');
});

test('no update: back to idle; checks do not overlap', async () => {
  let release; const { updater, up } = make();
  updater.checkForUpdates = () => new Promise((r) => { release = r; updater.calls.push('check'); });
  const a = up.check(), b = await up.check();
  assert.equal(b.state, 'checking');
  updater.emit('update-not-available', {}); release(); await a;
  assert.equal(up.state, 'idle');
  assert.equal(updater.calls.filter((c) => c === 'check').length, 1);
});

test('errors are shown once and Retry checks again', async () => {
  const { updater, up } = make();
  updater.checkForUpdates = async () => { const e = Error('net::ERR_INTERNET_DISCONNECTED\nstack'); updater.emit('error', e); throw e; };
  const r = await up.check();
  assert.equal(r.ok, false); assert.equal(up.state, 'error'); assert.equal(up.error, 'net::ERR_INTERNET_DISCONNECTED');
  updater.checkForUpdates = async () => updater.emit('update-not-available', {});
  await up.check();
  assert.equal(up.state, 'idle'); assert.equal(up.error, '');
});

test('a failed download is an error, not stuck downloading', async () => {
  const { updater, up } = make();
  updater.checkForUpdates = async () => updater.emit('update-available', { version: '3.4.0' });
  updater.downloadUpdate = async () => { throw Error('sha512 checksum mismatch'); };
  await up.check(); await new Promise((r) => setImmediate(r));
  assert.equal(up.state, 'error'); assert.match(up.error, /checksum/);
});

test('install is refused while busy, with the reason, and nothing is installed', async () => {
  let why = 'Finish or stop the running operation first';
  const { updater, up } = make({}, () => why);
  updater.checkForUpdates = async () => updater.emit('update-available', { version: '3.4.0' });
  updater.downloadUpdate = async () => updater.emit('update-downloaded', { version: '3.4.0' });
  assert.equal(up.install().ok, false);   // nothing ready yet
  await up.check(); await new Promise((r) => setImmediate(r));
  assert.deepEqual(up.install(), { ok: false, error: why });
  assert.ok(!updater.calls.some((c) => Array.isArray(c)));
  why = '';
  assert.equal(up.install().ok, true);
});

test('a throwing quitAndInstall is reported and can be retried', async () => {
  const { updater, up } = make();
  updater.checkForUpdates = async () => updater.emit('update-available', { version: '3.4.0' });
  updater.downloadUpdate = async () => updater.emit('update-downloaded', { version: '3.4.0' });
  updater.quitAndInstall = () => { throw Error('spawn EACCES'); };
  await up.check(); await new Promise((r) => setImmediate(r));
  assert.match(up.install().error, /EACCES/);
  assert.equal(up.installing, false);
});

test('start schedules a first check and a periodic one', () => {
  const { updater, up } = make(); const t = [];
  up.timers = { setTimeout: (f, ms) => (t.push(['t', ms]), {}), setInterval: (f, ms) => (t.push(['i', ms]), {}) };
  up.start();
  assert.deepEqual(t, [['t', 30000], ['i', 4 * 60 * 60 * 1000]]);
});

const { installGate } = require('../electron/updater');
const ready = async (o, busy) => {
  const m = make(o, busy);
  m.updater.checkForUpdates = async () => m.updater.emit('update-available', { version: '3.4.0' });
  m.updater.downloadUpdate = async () => m.updater.emit('update-downloaded', { version: '3.4.0' });
  await m.up.check(); await new Promise((r) => setImmediate(r));
  return m;
};

test('installer error emitted synchronously: not ok, flag reset, latch cleared, retry works', async () => {
  const { updater, up } = await ready({ quitAndInstallCalled: true });
  updater.quitAndInstall = () => updater.emit('error', Error('No update filepath provided'));
  const r = up.install();
  assert.deepEqual([r.ok, up.installing, up.state, updater.quitAndInstallCalled], [false, false, 'error', false]);
  assert.match(r.error, /filepath/);
  updater.checkForUpdates = async () => updater.emit('update-available', { version: '3.4.0' });
  await up.check(); await new Promise((r2) => setImmediate(r2));
  updater.quitAndInstall = () => {};
  assert.equal(up.install().ok, true);
});

test('installer error emitted later resets installing and reports', async () => {
  const { updater, up, changes } = await ready();
  up.install(); assert.equal(up.installing, true);
  updater.quitAndInstallCalled = true;
  updater.emit('error', Error('Cannot run installer: EACCES'));
  assert.deepEqual([up.installing, up.state, updater.quitAndInstallCalled], [false, 'error', false]);
  assert.equal(changes.at(-1), 'error');
});

test('a canceled quit keeps the install pending and never starts a second installer', async () => {
  const { up, updater } = await ready();
  let quits = 0; up.quit = () => quits++;
  let busy = ''; up.busy = () => busy;
  up.install(); up.installAborted(); busy = 'Stop HandBrake first';
  assert.equal(up.installing, true); assert.equal(up.summary().quitBlocked, true);
  assert.match(up.install().error, /waiting.*HandBrake/);
  busy = '';
  assert.equal(up.install().ok, true); assert.equal(quits, 1);
  assert.equal(updater.calls.filter((c) => Array.isArray(c)).length, 1, 'quitAndInstall called once');
  assert.equal(installGate('encoder', [{ action: 'start' }]).ok, false);
  updater.emit('error', Error('Cannot run installer')); // a true installer error still resets
  assert.deepEqual([up.installing, up.summary().quitBlocked], [false, false]);
});

test('while installing, new jobs are refused but stop/status are not', () => {
  assert.match(installGate('encoder', [{ action: 'start' }]).error, /restarting/);
  assert.match(installGate('library-backup', ['run']).error, /restarting/);
  assert.match(installGate('save-now', []).error, /restarting/);
  assert.match(installGate('enc-preview', [{ action: 'probe' }]).error, /restarting/);
  assert.equal(installGate('enc-preview', [{ action: 'cancel' }]), null);
  assert.equal(installGate('handbrake', [{ action: 'stop' }]), null);
  assert.equal(installGate('night', [{ action: 'summary' }]), null);
  assert.equal(installGate('update', [{ action: 'check' }]), null);
  assert.equal(installGate('save-settings', [{}]), null);
});

test('start is idempotent', () => {
  const { up } = make(); const t = [];
  up.timers = { setTimeout: () => t.push(1), setInterval: () => t.push(2) };
  up.start(); up.start();
  assert.deepEqual(t, [1, 2]);
});

test('main.js wiring: start on launch only, gate and pause while installing', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../electron/main.js'), 'utf8');
  assert.equal(src.match(/updater\.start\(\)/g).length, 1);
  const ready = src.slice(src.indexOf('app.whenReady()'));
  assert.ok(ready.indexOf('updater.start()') > 0 && ready.indexOf('updater.start()') < ready.indexOf('checkLibraryAge'));
  assert.ok(!/function applySettings[\s\S]{0,1500}updater\.start/.test(src));
  assert.match(src, /installGate\(channel, args\)/);
  assert.match(src, /autosaver\.isPaused = .*updater\.installing/);
  assert.match(src, /if \(shutdownAt \|\| updater\.installing\) return/);
  assert.match(src, /e\.defaultPrevented\) updater\.installAborted/);
});
