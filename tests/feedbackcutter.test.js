const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const fc = require('../electron/feedbackcutter');

const PYTHON = process.env.FEEDBACK_CUTTER_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const hasEngine = (() => {
  try { execFileSync(PYTHON, ['-c', 'import numpy, scipy, soundfile, matplotlib'], { stdio: 'ignore' }); return true; } catch { return false; }
})();
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fc-'));

// 16-bit mono WAV: 12 s of noise with a steady 3 kHz ring from 4 s to 7 s (feedback).
// note: also a held 1100 Hz note with five overtones from 8 s to 11.5 s (not feedback).
function ringWav(file, sr = 22050, { note = false } = {}) {
  const n = sr * 12;
  const data = Buffer.alloc(n * 2);
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const ring = t >= 4 && t < 7 ? 0.4 * Math.min(1, (t - 4) * 4, (7 - t) * 4) * Math.sin(2 * Math.PI * 3000 * t) : 0;
    let sung = 0;
    if (note && t >= 8 && t < 11.5) {
      for (let h = 1; h <= 6; h++) sung += 0.15 / h * Math.sin(2 * Math.PI * 1100 * h * t);
      sung *= Math.min(1, (t - 8) * 20, (11.5 - t) * 20);
    }
    data.writeInt16LE(Math.round((0.05 * rnd() + ring + sung) * 32767 * 0.9), i * 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sr, 24); h.writeUInt32LE(sr * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([h, data]));
}

test('install copies the engine scripts next to each other', () => {
  const dir = tmp();
  assert.strictEqual(fc.installScripts(dir), path.join(dir, 'feedback_bridge.py'));
  for (const f of ['dsp.py', 'feedback_bridge.py']) assert.ok(fs.existsSync(path.join(dir, f)), f);
});

test('job files are limited to names inside a job folder', () => {
  const work = tmp();
  fs.mkdirSync(path.join(work, '0123456789ab'));
  fs.writeFileSync(path.join(work, '0123456789ab', 'cleaned.wav'), '');
  assert.strictEqual(fc.jobFile(work, '0123456789ab', 'cleaned.wav'), path.join(work, '0123456789ab', 'cleaned.wav'));
  assert.throws(() => fc.jobFile(work, '../escape', 'cleaned.wav'), /Bad file name/);
  assert.throws(() => fc.jobFile(work, '0123456789ab', '..\\x.wav'), /Bad file name/);
  assert.throws(() => fc.jobFile(work, '0123456789ab', 'removed.wav'), /gone/);
});

test('exports are named after the recording', () => {
  assert.strictEqual(fc.exportName('D:\\Talks\\Talk Clip-02.mp3', 'cleaned', 'wav'), 'Talk Clip-02 (fc-cleaned).wav');
  assert.strictEqual(fc.exportName('/x/a.b.wav', 'markers', 'csv'), 'a.b (fc-markers).csv');
});

test('a Python set on the page is used instead of the built-in engine', () => {
  const engine = fc.createEngine({ script: 's.py', workDir: 'w', getPython: () => 'C:\\py\\python.exe', getExe: () => 'C:\\x\\feedback-engine.exe' });
  assert.strictEqual(engine.getExe(), '');
  const builtin = fc.createEngine({ script: 's.py', workDir: 'w', getExe: () => 'C:\\x\\feedback-engine.exe' });
  assert.strictEqual(builtin.getExe(), 'C:\\x\\feedback-engine.exe');
});

test('each Mac architecture has its own engine build', () => {
  const root = path.join('r');
  assert.strictEqual(fc.engineDir(root, 'win32', 'x64'), path.join('r', 'vendor', 'feedback-engine', 'win'));
  assert.strictEqual(fc.engineDir(root, 'darwin', 'arm64'), path.join('r', 'vendor', 'feedback-engine', 'mac-arm64'));
  assert.strictEqual(fc.engineDir(root, 'darwin', 'x64'), path.join('r', 'vendor', 'feedback-engine', 'mac-x64'));
  assert.strictEqual(fc.engineDir(root, 'linux', 'x64'), '');
  assert.strictEqual(fc.engineExeName('win32'), 'feedback-engine.exe');
  assert.strictEqual(fc.engineExeName('darwin'), 'feedback-engine');
});

test('the built engine counts as out of date once a source file changes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-'));
  const files = ['scripts/feedback-engine-requirements.txt', 'scripts/build-feedback-engine.js', 'scripts/feedback-engine-main.py',
    'electron/feedbackcutter/dsp.py', 'electron/feedbackcutter/feedback_bridge.py',
    'electron/quietlift/quiet_lift.py', 'electron/quietlift/quiet_lift_bridge.py', 'electron/quietlift/wav_markers.py'];
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), f);
  }
  assert.strictEqual(fc.builtEngineOutdated(root), false);   // never built: nothing to go out of date
  const stamp = path.join(fc.engineDir(root), 'SOURCES');
  fs.mkdirSync(path.dirname(stamp), { recursive: true });
  fs.writeFileSync(stamp, `${fc.engineDigest(root)}\n`);
  assert.strictEqual(fc.builtEngineOutdated(root), false);
  fs.appendFileSync(path.join(root, 'electron/quietlift/quiet_lift.py'), '# edited');
  assert.strictEqual(fc.builtEngineOutdated(root), true);
});

const BUILTIN = fc.bundledEngine();
test('the built-in engine runs without Python', { skip: !BUILTIN && 'not built (npm run build-feedback-engine)', timeout: 180000 }, async () => {
  const dir = tmp();
  const input = path.join(dir, 'talk.wav');
  ringWav(input);
  const engine = fc.createEngine({ script: 'unused.py', workDir: path.join(dir, 'work'), getPython: () => '', getExe: () => BUILTIN });
  try {
    const check = await engine.call('check');
    assert.ok(check.builtin && check.ffmpeg, JSON.stringify(check));
    const r = await engine.call('analyze', { path: input });
    assert.ok(r.events.some((e) => e.selected && Math.abs(e.freq - 3000) < 60), JSON.stringify(r.events));
    assert.ok(fs.existsSync(path.join(r.dir, 'cleaned_preview.mp3')));
  } finally {
    engine.stop();
  }
});

test('a missing engine module fails with its error line', { skip: !hasEngine && 'Python not found' }, async () => {
  const script = path.join(tmp(), 'broken.py');
  fs.writeFileSync(script, 'import sys\nsys.stderr.write("ModuleNotFoundError: No module named \'scipy\'\\n")\nsys.exit(1)\n');
  const engine = fc.createEngine({ script, workDir: tmp(), getPython: () => PYTHON });
  await assert.rejects(engine.call('check'), /Feedback Cutter engine stopped \(code 1\)\. ModuleNotFoundError: No module named 'scipy'/);
});

test('analyze finds the ring, re-notch and old jobs are cleared', { skip: !hasEngine && 'Python with numpy, scipy, soundfile, matplotlib not found', timeout: 180000 }, async () => {
  const dir = tmp();
  const input = path.join(dir, 'talk.wav');
  ringWav(input);
  const work = path.join(dir, 'work');
  const progress = [];
  const engine = fc.createEngine({
    script: fc.installScripts(path.join(dir, 'engine')), workDir: work, getPython: () => PYTHON,
    onLog: (msg, { pct }) => progress.push([msg, pct]),
  });
  try {
    const check = await engine.call('check');
    assert.strictEqual(check.work, work);
    const r = await engine.call('analyze', { path: input, sensitivity_db: 22 });
    assert.strictEqual(r.filename, 'talk.wav');
    assert.ok(Math.abs(r.duration - 12) < 0.01);
    const ring = r.events.find((e) => Math.abs(e.freq - 3000) < 60);
    assert.ok(ring, JSON.stringify(r.events));
    assert.ok(ring.selected && ring.t_start < 4.6 && ring.t_end > 6.4, JSON.stringify(ring));
    assert.ok(progress.some(([m, p]) => /Scanning/.test(m) && p > 0));
    for (const name of Object.values(r.files)) assert.ok(fs.existsSync(fc.jobFile(work, r.job, name)), name);

    const before = fs.statSync(path.join(r.dir, 'removed.wav')).mtimeMs;
    assert.deepStrictEqual(await engine.call('renotch', { job: r.job, events: [] }), { n_selected: 0 });
    assert.ok(fs.statSync(path.join(r.dir, 'removed.wav')).mtimeMs >= before);

    const r2 = await engine.call('analyze', { path: input });
    assert.notStrictEqual(r2.job, r.job);
    assert.ok(!fs.existsSync(r.dir), 'the previous job is removed');
    await assert.rejects(engine.call('renotch', { job: r.job, events: [] }), /gone/);
  } finally {
    engine.stop();
  }
});

test("a held note's overtones are not ticked as feedback, the ring still is", { skip: !hasEngine && 'Python with numpy, scipy, soundfile, matplotlib not found', timeout: 180000 }, async () => {
  const dir = tmp();
  const input = path.join(dir, 'sung.wav');
  ringWav(input, 22050, { note: true });
  const engine = fc.createEngine({ script: fc.installScripts(path.join(dir, 'engine')), workDir: path.join(dir, 'work'), getPython: () => PYTHON });
  try {
    const r = await engine.call('analyze', { path: input });
    const picked = r.events.filter((e) => e.selected);
    assert.ok(picked.some((e) => Math.abs(e.freq - 3000) < 60), JSON.stringify(r.events));
    assert.deepStrictEqual(picked.filter((e) => Math.abs(e.freq - 3000) >= 60), [], 'only the ring is ticked');
  } finally {
    engine.stop();
  }
});
