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
// Both apps carry PostPilot's one FFmpeg (resources/ffmpeg): it must run here (x64 under Rosetta),
// apply LUTs and encode H.265; and the audio engine must have no FFmpeg of its own any more
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
for (const name of ['mac-arm64', 'mac']) {
  const res = path.resolve('dist', name, 'AV PostPilot.app', 'Contents', 'Resources');
  const ffmpeg = path.join(res, 'ffmpeg', 'ffmpeg');
  const list = (what) => spawnSync(ffmpeg, ['-hide_banner', what], { timeout: 60000, encoding: 'utf8' }).stdout || '';
  assert.ok(/ffmpeg version 7/.test(list('-version')), `FFmpeg in ${name} does not run`);
  assert.ok(/ lut3d /.test(list('-filters')), `FFmpeg in ${name} has no lut3d`);
  const enc = list('-encoders');
  assert.ok(/ libx265 /.test(enc) && / hevc_videotoolbox /.test(enc), `FFmpeg in ${name} lacks x265 or VideoToolbox`);
  const extra = walk(path.join(res, 'feedback-engine')).filter((f) => /^ffmpeg/i.test(path.basename(f)));
  assert.deepEqual(extra, [], `a second FFmpeg inside the audio engine of ${name}`);
}
// The audio engine comes inside both apps and must start with no Python: x64 runs under Rosetta here.
// The app starts it with its FFmpeg first on PATH (withFfmpegOnPath): Feedback Cutter must pick that one.
for (const name of ['mac-arm64', 'mac']) {
  const res = path.resolve('dist', name, 'AV PostPilot.app', 'Contents', 'Resources');
  const engine = path.join(res, 'feedback-engine', 'feedback-engine', 'feedback-engine');
  const env = { ...process.env, PATH: `${path.join(res, 'ffmpeg')}:/usr/bin:/bin` };
  const work = path.resolve('dist', `engine-check-${name}`);
  const quiet = spawnSync(engine, ['quiet-lift'], { input: '{"id":1,"cmd":"defaults"}\n', timeout: 180000, encoding: 'utf8', env });
  assert.ok(/"type": "result"/.test(quiet.stdout) && /"target"/.test(quiet.stdout), `Quiet Lift in ${name}: ${quiet.error?.message || quiet.stderr}`);
  const cutter = spawnSync(engine, [work], { input: '{"id":1,"cmd":"check"}\n', timeout: 180000, encoding: 'utf8', env });
  const check = cutter.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((m) => m.type === 'result');
  assert.ok(check?.data.builtin && check.data.ffmpeg === path.join(res, 'ffmpeg', 'ffmpeg'), `Feedback Cutter in ${name}: ${cutter.error?.message || cutter.stderr || cutter.stdout}`);
}
const data = path.resolve('dist', 'mac-startup-check'); fs.mkdirSync(data, { recursive: true });
fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ libraryBackup: { mode: 'monitor', root: '' } }));
const run = spawnSync(path.join(dir, 'Contents', 'MacOS', 'AV PostPilot'), ['--library-backup-run', `--backup-user-data=${data}`], { timeout: 30000, encoding: 'utf8' });
assert.equal(run.status, 1, run.error?.message || run.stderr);
assert.ok(fs.readFileSync(path.join(data, 'library-backup-task.log'), 'utf8').includes('Choose an existing absolute backup folder'));
const health = spawnSync(path.join(dir, 'Contents', 'MacOS', 'AV PostPilot'), ['--library-backup-check', `--backup-user-data=${data}`], { timeout: 30000, encoding: 'utf8' });
assert.equal(health.status, 0, health.error?.message || health.stderr);
console.log('Native macOS headless entry point, PostPilot backup engine, the shared FFmpeg and both audio engines verified. No server contacted.');
