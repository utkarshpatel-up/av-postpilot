const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { checkOverdue } = require('../electron/library-overdue');
const { macSchedule, windowsHealthSchedule } = require('../electron/library-backup');
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'postpilot-age-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'backups', 'edit_share_18'); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'sample.dump'); fs.writeFileSync(file, 'sample');
  const now = Date.now(); fs.utimesSync(file, new Date(now - 25 * 3600000), new Date(now - 25 * 3600000));
  const settings = { libraryBackup: { mode: 'server', root: path.join(root, 'backups'), staleHours: 24 }, notify: { events: { libraryBackupOverdue: true } } };
  const messages = [];
  const args = { settings, stateFile: path.join(root, 'age.json'), now, notify: async (...message) => { messages.push(message); return 1; } };
  return { root, file, settings, messages, args, now };
}
test('overdue alert uses the notification event and is suppressed across checks and restarts', async t => {
  const f = setup(t); await checkOverdue(f.args); await checkOverdue({ ...f.args });
  assert.equal(f.messages.length, 1); assert.equal(f.messages[0][0], 'libraryBackupOverdue');
  assert.match(f.messages[0][1], /edit_share_18/); assert.match(f.messages[0][1], /25 hours ago/);
});
test('fresh backup resets the incident so a later overdue backup alerts again', async t => {
  const f = setup(t); await checkOverdue(f.args);
  fs.utimesSync(f.file, new Date(f.now), new Date(f.now)); await checkOverdue(f.args);
  await checkOverdue({ ...f.args, now: f.now + 25 * 3600000 }); assert.equal(f.messages.length, 2);
});
test('disabled checkbox and monitoring PCs send no overdue notifications', async t => {
  const f = setup(t); f.settings.notify.events.libraryBackupOverdue = false; await checkOverdue(f.args);
  f.settings.notify.events.libraryBackupOverdue = true; f.settings.libraryBackup.mode = 'monitor'; await checkOverdue(f.args);
  assert.equal(f.messages.length, 0);
});
test('no completed backup and unavailable root alert after the configured grace period', async t => {
  const f = setup(t); fs.rmSync(f.settings.libraryBackup.root, { recursive: true });
  await checkOverdue(f.args); assert.equal(f.messages.length, 0);
  await checkOverdue({ ...f.args, now: f.now + 25 * 3600000 }); assert.equal(f.messages.length, 1);
  assert.match(f.messages[0][1], /Backup folder unavailable/);
});
test('failed delivery retries rather than recording a successful alert', async t => {
  const f = setup(t); await checkOverdue({ ...f.args, notify: async () => 0 }); await checkOverdue(f.args);
  assert.equal(f.messages.length, 1);
});
test('exported schedules include independent hourly health checks', () => {
  const mac = macSchedule({ times: '11:00,14:00' }, '/Applications/AV PostPilot', '/Users/editor/settings');
  assert.match(mac.healthPlist, /--library-backup-check/); assert.match(mac.healthPlist, /<integer>3600<\/integer>/);
  assert.ok(mac.installer.includes(`${mac.healthLabel}.plist`));
  assert.match(windowsHealthSchedule('C:\\app.exe', 'C:\\settings'), /--library-backup-check/);
});
