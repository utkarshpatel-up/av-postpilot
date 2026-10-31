// Run on the native Mac build runner. No connections or scheduled tasks.
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { spawnSync } = require('child_process');
const asar = require('@electron/asar');
const dir = path.resolve('dist', process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'AV PostPilot.app');
const archive = path.join(dir, 'Contents', 'Resources', 'app.asar');
for (const name of ['library-backup.js', 'library-backup-headless.js', 'library-overdue.js']) {
  assert.ok(asar.extractFile(archive, `electron/${name}`).length > 0);
}
// HandBrakeCLI comes inside the app and must run on this Mac
const hbCli = path.join(dir, 'Contents', 'Resources', 'handbrake', 'HandBrakeCLI');
const hb = spawnSync(hbCli, ['--version'], { timeout: 30000, encoding: 'utf8' });
assert.ok(/HandBrake \d/.test(`${hb.stdout}${hb.stderr}`), hb.error?.message || hb.stderr);
const data = path.resolve('dist', 'mac-startup-check'); fs.mkdirSync(data, { recursive: true });
fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ libraryBackup: { mode: 'monitor', root: '' } }));
const run = spawnSync(path.join(dir, 'Contents', 'MacOS', 'AV PostPilot'), ['--library-backup-run', `--backup-user-data=${data}`], { timeout: 30000, encoding: 'utf8' });
assert.equal(run.status, 1, run.error?.message || run.stderr);
assert.ok(fs.readFileSync(path.join(data, 'library-backup-task.log'), 'utf8').includes('Choose an existing absolute backup folder'));
const health = spawnSync(path.join(dir, 'Contents', 'MacOS', 'AV PostPilot'), ['--library-backup-check', `--backup-user-data=${data}`], { timeout: 30000, encoding: 'utf8' });
assert.equal(health.status, 0, health.error?.message || health.stderr);
console.log('Native macOS headless entry point and PostPilot backup engine verified. No server contacted.');
