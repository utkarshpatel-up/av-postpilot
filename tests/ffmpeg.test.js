const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ff = require('../electron/ffmpeg');
const fc = require('../electron/feedbackcutter');

const ROOT = path.join(__dirname, '..');
const pkg = require('../package.json');

test('one FFmpeg build per platform and architecture', () => {
  assert.strictEqual(ff.vendorTarget('win32', 'x64'), 'win');
  assert.strictEqual(ff.vendorTarget('darwin', 'arm64'), 'mac-arm64');
  assert.strictEqual(ff.vendorTarget('darwin', 'x64'), 'mac-x64');
  assert.strictEqual(ff.vendorTarget('linux', 'x64'), 'linux-x64');
  for (const t of ['win', 'mac-arm64', 'mac-x64', 'linux-x64', 'linux-arm64']) {
    const f = pkg.ffmpeg.files[t];
    assert.ok(f && /^https:\/\/files\.pythonhosted\.org\//.test(f.url) && /^[0-9a-f]{64}$/.test(f.sha256) && f.version, `pin for ${t}`);
  }
});

test('the installed app finds its own FFmpeg first, then the one from source', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-'));
  const res = path.join(dir, 'resources'), src = path.join(dir, 'src');
  const exe = ff.exeName('darwin');
  fs.mkdirSync(path.join(src, 'vendor', 'ffmpeg', 'mac-arm64'), { recursive: true });
  fs.writeFileSync(path.join(src, 'vendor', 'ffmpeg', 'mac-arm64', exe), '');
  assert.strictEqual(ff.bundledFfmpeg(res, src, 'darwin', 'arm64'), path.join(src, 'vendor', 'ffmpeg', 'mac-arm64', exe));
  assert.strictEqual(ff.bundledFfmpeg(res, src, 'darwin', 'x64'), null, 'an Intel Mac must not pick the Apple-silicon build');
  fs.mkdirSync(path.join(res, 'ffmpeg'), { recursive: true });
  fs.writeFileSync(path.join(res, 'ffmpeg', exe), '');
  assert.strictEqual(ff.bundledFfmpeg(res, src, 'darwin', 'arm64'), path.join(res, 'ffmpeg', exe));
});

test("FFmpeg's folder goes first on PATH, in the same variable (Windows calls it Path)", () => {
  const exe = path.join('X', 'ffmpeg', 'ffmpeg');
  const win = ff.withFfmpegOnPath({ Path: 'C:\\Windows', TEMP: 't' }, exe);
  assert.deepStrictEqual(Object.keys(win).sort(), ['Path', 'TEMP']);
  assert.strictEqual(win.Path, `${path.dirname(exe)}${path.delimiter}C:\\Windows`);
  assert.strictEqual(ff.withFfmpegOnPath({}, exe).PATH, path.dirname(exe));
  assert.deepStrictEqual(ff.withFfmpegOnPath({ PATH: '/usr/bin' }, null), { PATH: '/usr/bin' });
});

test('the audio engine gets the shared FFmpeg and no longer carries its own', () => {
  const engine = fc.createEngine({ script: 's.py', workDir: 'w', getExe: () => '' });
  const bundled = ff.bundledFfmpeg();
  const env = engine.getEnv();
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH');
  if (bundled) assert.ok(env[key].startsWith(path.dirname(bundled) + path.delimiter) || env[key] === path.dirname(bundled), env[key]);
  const build = fs.readFileSync(path.join(ROOT, 'scripts', 'build-feedback-engine.js'), 'utf8');
  assert.ok(!/--collect-all', 'imageio_ffmpeg/.test(build) && /'imageio_ffmpeg'\]\.flatMap/.test(build), 'imageio_ffmpeg stays out of the frozen engine');
  assert.ok(!/imageio-ffmpeg/.test(fs.readFileSync(path.join(ROOT, 'scripts', 'feedback-engine-requirements.txt'), 'utf8')));
  // both packaged apps carry resources/ffmpeg
  for (const os_ of ['win', 'mac']) assert.ok(pkg.build[os_].extraResources.some((r) => r.to === 'ffmpeg' && r.from.startsWith('vendor/ffmpeg/')), os_);
});

const BUILT_IN = ff.bundledFfmpeg();
test('the built-in FFmpeg can apply a LUT and encode H.265', { skip: !BUILT_IN && 'not fetched (npm run fetch-ffmpeg)' }, () => {
  const info = ff.ffmpegInfo(BUILT_IN);
  assert.ok(info.version, 'version');
  assert.ok(info.filters.has('lut3d') && info.filters.has('lut1d'), 'LUT filters');
  assert.ok(info.encoders.has('libx265') && info.encoders.has('aac'), 'x265 and AAC');
});
