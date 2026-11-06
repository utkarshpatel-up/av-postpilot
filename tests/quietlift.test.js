const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { QuietLift, installScripts } = require('../electron/quietlift');

const PYTHON = process.env.QUIET_LIFT_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const hasEngine = (() => {
  try { execFileSync(PYTHON, ['-c', 'import numpy, soundfile'], { stdio: 'ignore' }); return true; } catch { return false; }
})();
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ql-'));

// 16-bit mono WAV: 60 s of "speech" (bursts with gaps), 20-40 s about 10 dB quieter.
function speechWav(file, sr = 16000) {
  const n = sr * 60;
  const data = Buffer.alloc(n * 2);
  let seed = 1;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const word = (t % 0.6) < 0.4;                     // 0.4 s words, 0.2 s gaps
    const level = t >= 20 && t < 40 ? 0.09 : 0.3;     // quiet middle stretch
    data.writeInt16LE(Math.round((word ? level : 0.003) * rnd() * 32767), i * 2);
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
  const script = installScripts(dir);
  assert.strictEqual(script, path.join(dir, 'quiet_lift_bridge.py'));
  for (const f of ['quiet_lift.py', 'quiet_lift_bridge.py', 'wav_markers.py']) assert.ok(fs.existsSync(path.join(dir, f)), f);
});

test('a missing Python gives a clear error instead of hanging', async () => {
  const ql = new QuietLift({ script: 'x.py', getPython: () => path.join(tmp(), 'no-python.exe') });
  await assert.rejects(ql.call('defaults'), /Could not start Python/);
  assert.strictEqual(ql.proc, null);   // the next call tries again
});

test('an engine that dies before it is ready fails the call with its last error line', { skip: !hasEngine && 'Python not found' }, async () => {
  const script = path.join(tmp(), 'broken.py');
  fs.writeFileSync(script, 'import sys\nsys.stderr.write("ModuleNotFoundError: No module named \'numpy\'\\n")\nsys.exit(1)\n');
  const ql = new QuietLift({ script, getPython: () => PYTHON });
  await assert.rejects(ql.call('defaults'), /stopped \(code 1\)\. ModuleNotFoundError: No module named 'numpy'/);
});

test('a target level lifts speech that is not quiet for the file', { skip: !hasEngine && 'Python with numpy + soundfile not found' }, async () => {
  const dir = tmp();
  const input = path.join(dir, 'take-1-debleed.wav');
  speechWav(input);
  const ql = new QuietLift({ script: installScripts(path.join(dir, 'engine')), getPython: () => PYTHON });
  try {
    const defaults = await ql.call('defaults');
    assert.strictEqual(defaults.target, null);
    const options = { min_len: 5, max_gain: 30 };

    // Without a target the 0.3 level is the file's typical speech, so it is left alone.
    const plain = await ql.call('analyze', { input, options });
    assert.ok(plain.stretches.every((st) => st.start >= 15 && st.end <= 45), JSON.stringify(plain.stretches));
    const [before] = plain.stretches;

    // A target above it: the louder speech now counts too, and every lift reaches 5 dB higher.
    const a = await ql.call('analyze', { input, options: { ...options, target: plain.ref + 5 } });
    assert.strictEqual(a.hi, plain.ref + 5);
    assert.strictEqual(a.lo, plain.lo);   // the bleed limit stays measured from typical speech
    assert.ok(a.stretches.some((st) => st.start < 15 || st.end > 45), JSON.stringify(a.stretches));
    const after = a.stretches.find((st) => st.start <= 30 && st.end >= 30);
    assert.ok(Math.abs(after.gain - (before.gain + 5)) < 1, JSON.stringify({ before, after }));

    // A target below the bleed limit raises nothing.
    const none = await ql.call('analyze', { input, options: { ...options, target: plain.lo - 1 } });
    assert.strictEqual(none.stretches.length, 0);
  } finally {
    ql.stop();
  }
});

test('no peak ceiling by default: raised peaks keep their shape, and a ceiling flattens them', { skip: !hasEngine && 'Python with numpy + soundfile not found' }, async () => {
  const dir = tmp();
  const input = path.join(dir, 'take-1-debleed.wav');
  speechWav(input);
  const ql = new QuietLift({ script: installScripts(path.join(dir, 'engine')), getPython: () => PYTHON });
  // samples at full scale of the quiet stretch: the loudest one, and how many sit within 1 LSB of it
  const atTop = (file) => {
    const data = fs.readFileSync(file);
    let top = 0;
    const vals = [];
    for (let i = 44 + 25 * 16000 * 2; i < 44 + 35 * 16000 * 2; i += 2) { const v = Math.abs(data.readInt16LE(i)); vals.push(v); if (v > top) top = v; }
    return { top, count: vals.filter((v) => v >= top - 1).length };
  };
  try {
    const defaults = await ql.call('defaults');
    assert.strictEqual(defaults.ceiling, null);

    const free = path.join(dir, 'free.wav');
    const a = await ql.call('analyze', { input, options: { min_len: 5 } });
    const gain = a.stretches[0].gain;
    await ql.call('render', { output: free, skipped: [], mark_input: false });
    const src = atTop(input), out = atTop(free);
    const ratio = out.top / src.top;
    assert.ok(Math.abs(20 * Math.log10(ratio) - gain) < 1, `${ratio} vs +${gain} dB`);

    const limited = path.join(dir, 'limited.wav');
    const ceiling = 20 * Math.log10((src.top * 1.3) / 32768);
    await ql.call('analyze', { input, options: { min_len: 5, ceiling } });
    await ql.call('render', { output: limited, skipped: [], mark_input: false });
    assert.ok(atTop(limited).count > out.count * 5, JSON.stringify({ limited: atTop(limited), free: out }));   // only the ceiling piles samples up at the top
  } finally {
    ql.stop();
  }
});

test('a fixed-point file gets a smaller lift rather than clipping', { skip: !hasEngine && 'Python with numpy + soundfile not found' }, async () => {
  const dir = tmp();
  const input = path.join(dir, 'take-1-debleed.wav');
  speechWav(input);
  const ql = new QuietLift({ script: installScripts(path.join(dir, 'engine')), getPython: () => PYTHON });
  try {
    const output = path.join(dir, 'out.wav');
    await ql.call('analyze', { input, options: { min_len: 5, target: 20, max_gain: 40 } });
    await ql.call('render', { output, skipped: [], mark_input: false });
    const data = fs.readFileSync(output);
    let full = 0, top = 0;
    for (let i = 44; i + 1 < 44 + 60 * 16000 * 2; i += 2) { const v = Math.abs(data.readInt16LE(i)); if (v >= 32767) full++; if (v > top) top = v; }
    assert.strictEqual(full, 0);
    assert.ok(top > 25000, `loudest sample ${top}`);
  } finally {
    ql.stop();
  }
});

test('analyze, skip and render through the real engine', { skip: !hasEngine && 'Python with numpy + soundfile not found' }, async () => {
  const dir = tmp();
  const input = path.join(dir, 'take-1-debleed.wav');
  speechWav(input);
  const logs = [];
  const ql = new QuietLift({ script: installScripts(path.join(dir, 'engine')), getPython: () => PYTHON, onLog: (m) => logs.push(m) });
  try {
    const defaults = await ql.call('defaults');
    assert.strictEqual(typeof defaults.min_len, 'number');
    const a = await ql.call('analyze', { input, options: { min_len: 5 } });
    assert.ok(Math.abs(a.duration - 60) < 0.01);
    assert.strictEqual(a.stretches.length, 1, JSON.stringify(a.stretches));
    const [st] = a.stretches;
    assert.ok(st.start >= 15 && st.end <= 45 && st.gain > 0, JSON.stringify(st));
    assert.ok(logs.some((m) => /quiet stretch/.test(m)));

    await ql.call('skips', { skipped: [] });
    const output = path.join(dir, 'take-1-lifted.wav');
    const r = await ql.call('render', { output, skipped: [], mark_input: true });
    assert.strictEqual(r.output, output);
    assert.ok(r.marked_input);
    // outside the stretch the audio is bit-for-bit
    const src = fs.readFileSync(input);
    const out = fs.readFileSync(output);
    const sample = 44 + 2 * 16000 * 2;   // 2 s in
    assert.ok(src.subarray(sample, sample + 2000).equals(out.subarray(sample, sample + 2000)));
    await assert.rejects(ql.call('render', { output: input }), /can't be one of the input files/);
  } finally {
    ql.stop();
  }
});
