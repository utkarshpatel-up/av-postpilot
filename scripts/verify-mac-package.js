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
// The audio engine comes inside both apps and must start with no Python: x64 runs under Rosetta here
for (const name of ['mac-arm64', 'mac']) {
  const engine = path.resolve('dist', name, 'AV PostPilot.app', 'Contents', 'Resources', 'feedback-engine', 'feedback-engine', 'feedback-engine');
  const work = path.resolve('dist', `engine-check-${name}`);
  const quiet = spawnSync(engine, ['quiet-lift'], { input: '{"id":1,"cmd":"defaults"}\n', timeout: 180000, encoding: 'utf8', env: { ...process.env, PATH: '/usr/bin:/bin' } });
  assert.ok(/"type": "result"/.test(quiet.stdout) && /"target"/.test(quiet.stdout), `Quiet Lift in ${name}: ${quiet.error?.message || quiet.stderr}`);
  const cutter = spawnSync(engine, [work], { input: '{"id":1,"cmd":"check"}\n', timeout: 180000, encoding: 'utf8', env: { ...process.env, PATH: '/usr/bin:/bin' } });
  const check = cutter.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((m) => m.type === 'result');
  assert.ok(check?.data.builtin && check.data.ffmpeg, `Feedback Cutter in ${name}: ${cutter.error?.message || cutter.stderr || cutter.stdout}`);
}
const data = path.resolve('dist', 'mac-startup-check'); fs.mkdirSync(data, { recursive: true });
fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ libraryBackup: { mode: 'monitor', root: '' } }));
const run = spawnSync(path.join(dir, 'Contents', 'MacOS', 'AV PostPilot'), ['--library-backup-run', `--backup-user-data=${data}`], { timeout: 30000, encoding: 'utf8' });
assert.equal(run.status, 1, run.error?.message || run.stderr);
assert.ok(fs.readFileSync(path.join(data, 'library-backup-task.log'), 'utf8').includes('Choose an existing absolute backup folder'));
const health = spawnSync(path.join(dir, 'Contents', 'MacOS', 'AV PostPilot'), ['--library-backup-check', `--backup-user-data=${data}`], { timeout: 30000, encoding: 'utf8' });
assert.equal(health.status, 0, health.error?.message || health.stderr);
console.log('Native macOS headless entry point, PostPilot backup engine and both audio engines verified. No server contacted.');
