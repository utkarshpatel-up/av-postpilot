const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { HandBrake, presetName, planConvert, planH264, plannedLister, lcsLen, bundledCli } = require('../electron/handbrake');

function tree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-'));
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    if (body !== null) fs.writeFileSync(p, body);
  }
  return root;
}
const S1 = '2725 Dt- 22-March-2025';
const M = '01 Adalaj General Satsang Mor. Dt- 22-March-2025 Dur-1.26Min';
const E = '02 Adalaj General Satsang Eve. Dt- 22-March-2025 Dur-1.30Min';
const INPUT = {
  [`In/${S1}/${M}/Adalaj General Satsang Dt- 22-March-2025 Dur-1.26Min.MOV`]: 'v',
  [`In/${S1}/${M}/notes.txt`]: 'n',
  [`In/${S1}/${M}/Clips for Insert/Cam-01/SHGINF_S001_S001_T001.MOV`]: 'c1',
  [`In/${S1}/${M}/Clips for Insert/Cam-02/.hidden.MOV`]: 'h',
  [`In/${S1}/${E}/Adalaj General Satsang Eve. Dt- 22-March-2025 Dur-1.30Min.mp4`]: 'v2',
  'In/Empty/.keep': null,
  'Preset/p.json': JSON.stringify({ PresetList: [{ ChildrenArray: [{ PresetName: 'Fast 1080p25 H265 ' }] }] }),
};
const kinds = (items) => items.map((i) => `${i.kind} ${path.basename(i.src)}`);

test('preset name: nested ChildrenArray or flat preset', () => {
  const root = tree({ 'a.json': JSON.stringify({ PresetList: [{ PresetName: 'Flat' }] }), 'b.json': '{"PresetList":[]}' });
  assert.strictEqual(presetName(path.join(root, 'a.json')), 'Flat');
  assert.throws(() => presetName(path.join(root, 'b.json')), /No preset name/);
});

test('convert everything: videos to .mp4, other files copied, hidden skipped, folders mirrored', () => {
  const root = tree(INPUT);
  const out = path.join(root, 'Out');
  const { dirs, items } = planConvert({ inputDir: path.join(root, 'In'), outputDir: out, convertSatsangs: true });
  assert.deepStrictEqual(kinds(items).sort(), [
    'convert Adalaj General Satsang Dt- 22-March-2025 Dur-1.26Min.MOV',
    'convert Adalaj General Satsang Eve. Dt- 22-March-2025 Dur-1.30Min.mp4',
    'convert SHGINF_S001_S001_T001.MOV',
    'copy notes.txt',
    'skip .hidden.MOV',
  ]);
  assert.ok(items.find((i) => i.kind === 'convert').dest.endsWith('.mp4'));
  assert.ok(dirs.includes(path.join(out, 'Empty')));
  // already converted -> skipped on the next run
  const done = items.find((i) => i.src.endsWith('T001.MOV')).dest;
  fs.mkdirSync(path.dirname(done), { recursive: true });
  fs.writeFileSync(done, 'x');
  const again = planConvert({ inputDir: path.join(root, 'In'), outputDir: out, convertSatsangs: true });
  assert.strictEqual(again.items.find((i) => i.src.endsWith('T001.MOV')).reason, 'already converted');
});

test('clips only: only Cam-xx videos are converted', () => {
  const root = tree(INPUT);
  const { items } = planConvert({ inputDir: path.join(root, 'In'), outputDir: path.join(root, 'Out'), convertSatsangs: false });
  assert.deepStrictEqual(items.filter((i) => i.kind === 'convert').map((i) => path.basename(i.src)), ['SHGINF_S001_S001_T001.MOV']);
  assert.strictEqual(items.filter((i) => i.reason === 'not a clip (Clips only mode)').length, 2);
});

test('H264 recordings are filed by satsang number, session number, name or closest match', () => {
  const root = tree({
    [`Out/${S1}/${M}/x.mp4`]: 'x', [`Out/${S1}/${E}/y.mp4`]: 'y', 'Out/Misc/z': 'z',
    [`H264/2725 01 ${M.slice(3)} Clip-01.mp4`]: 'a',
    [`H264/2725 Adalaj General Satsang Eve. Dt- 22-March-2025 Dur-1.30Min.mp4`]: 'b',
    [`H264/2725 Something else.mp4`]: 'c',
    [`H264/2726 01 No folder.mp4`]: 'd',
    [`H264/2725 09 No session.mp4`]: 'e',
    'H264/Thumbs.db': 't',
  });
  const out = path.join(root, 'Out');
  const items = planH264({ h264Dir: path.join(root, 'H264'), outputDir: out, copyMp4: true });
  const by = (start) => items.find((i) => path.basename(i.src).startsWith(start));
  assert.strictEqual(by('2725 01').dest, path.join(out, S1, M, `${M.slice(3)} Clip-01.mp4`));
  assert.strictEqual(by('2725 01').kind, 'copy');
  assert.strictEqual(path.dirname(by('2725 Adalaj').dest), path.join(out, S1, E));   // first two words match neither, LCS does
  assert.strictEqual(path.dirname(by('2725 Something').dest), path.join(out, S1));   // no match: satsang folder itself
  assert.match(by('2726').reason, /no satsang folder 2726/);
  assert.match(by('2725 09').reason, /no sub-folder 09/);
  assert.strictEqual(items.length, 5);
  assert.strictEqual(planH264({ h264Dir: path.join(root, 'H264'), outputDir: out, copyMp4: false })[0].kind, 'move');
});

test('preview sees the satsang folders step 1 will create', () => {
  const root = tree({ ...INPUT, [`H264/2725 02 Adalaj General Satsang Eve.mp4`]: 'b' });
  const out = path.join(root, 'Out');
  const { dirs } = planConvert({ inputDir: path.join(root, 'In'), outputDir: out, convertSatsangs: false });
  const [item] = planH264({ h264Dir: path.join(root, 'H264'), outputDir: out, copyMp4: true }, plannedLister(dirs));
  assert.strictEqual(path.dirname(item.dest), path.join(out, S1, E));
});

test('lcsLen', () => {
  assert.strictEqual(lcsLen('abcXdef', 'zzABCq'), 3);
  assert.strictEqual(lcsLen('', 'a'), 0);
});

function fakeSpawn(calls, { fail = () => false, stderr = 'ERROR: invalid input\n' } = {}) {
  return (cli, args) => {
    calls.push(args);
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.kill = () => setImmediate(() => child.emit('close', null));
    const out = args[args.indexOf('-o') + 1];
    setImmediate(() => {
      child.stdout.emit('data', 'Encoding: task 1 of 1, 50.00 % (80 fps, avg 80 fps, ETA 00h00m02s)');
      fs.writeFileSync(out, 'partial');
      if (fail(args)) { child.stderr.emit('data', stderr); child.emit('close', 3); } else child.emit('close', 0);
    });
    return child;
  };
}

test('a run converts with the preset, copies, files H264 and writes a report', async () => {
  const root = tree({ ...INPUT, 'H264/2725 01 Adalaj Clip.mp4': 'h', 'cli/HandBrakeCLI': '' });
  const calls = [], notes = [], done = [];
  const cfg = { inputDir: path.join(root, 'In'), outputDir: path.join(root, 'Out'), h264Dir: path.join(root, 'H264'), presetFile: path.join(root, 'Preset/p.json'), cliPath: path.join(root, 'cli/HandBrakeCLI'), convertSatsangs: false, copyMp4: false, afterQueue: 'shutdown' };
  const hb = new HandBrake({
    getSettings: () => cfg, log: () => {}, notifier: { notify: (e, m) => notes.push([e, m]) },
    spawn: fakeSpawn(calls), defaultReportDir: path.join(root, 'Reports'), onQueueDone: (a, w) => done.push([a, w]),
  });
  const r = await hb.start();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(calls[0].slice(-4), ['--preset-import-file', cfg.presetFile, '--preset', 'Fast 1080p25 H265 ']);
  const moved = path.join(cfg.outputDir, S1, M, 'Adalaj Clip.mp4');
  assert.ok(fs.existsSync(moved) && !fs.existsSync(path.join(cfg.h264Dir, '2725 01 Adalaj Clip.mp4')));
  assert.ok(fs.existsSync(path.join(cfg.outputDir, S1, M, 'notes.txt')));
  assert.match(fs.readFileSync(hb.reportFile, 'utf8'), /\[MOVE-H264\]/);
  assert.match(path.basename(hb.reportFile), /^log_convert_satsang_0_\d{8}_\d{6}\.txt$/);
  assert.strictEqual(notes[0][0], 'handbrakeDone');
  assert.deepStrictEqual(done, [['shutdown', 'HandBrake conversion']]);
});

test('a failed conversion removes the half-written file and the run carries on', async () => {
  const root = tree({ ...INPUT, 'cli/HandBrakeCLI': '' });
  const calls = [];
  const cfg = { inputDir: path.join(root, 'In'), outputDir: path.join(root, 'Out'), presetFile: path.join(root, 'Preset/p.json'), cliPath: path.join(root, 'cli/HandBrakeCLI'), convertSatsangs: true };
  const hb = new HandBrake({ getSettings: () => cfg, log: () => {}, spawn: fakeSpawn(calls, { fail: (a) => a[1].endsWith('T001.MOV') }), defaultReportDir: path.join(root, 'R') });
  const r = await hb.start();
  assert.strictEqual(calls.length, 3);
  assert.strictEqual(r.failed, 1);
  const bad = hb.items.find((i) => i.state === 'failed');
  assert.match(bad.error, /exit code 3: ERROR: invalid input/);
  assert.ok(!fs.existsSync(bad.dest));
});

test('settings are checked before anything runs', async () => {
  const root = tree(INPUT);
  const base = { inputDir: path.join(root, 'In'), outputDir: path.join(root, 'Out'), presetFile: path.join(root, 'Preset/p.json'), cliPath: path.join(root, 'missing'), convertSatsangs: true };
  const run = (extra) => new HandBrake({ getSettings: () => ({ ...base, ...extra }), log: () => {}, defaultReportDir: root, spawn: () => { throw Error('ran'); } }).start();
  assert.match((await run({ outputDir: '' })).error, /output folder/);
  assert.match((await run({ outputDir: path.join(root, 'In', 'Out') })).error, /inside the input/);
  assert.match((await run({ convertSatsangs: false })).error, /H264 recordings folder/);
  // only when no copy is around: not built in (npm run fetch-handbrake) and not on PATH
  if (!bundledCli() && !process.env.PATH.split(path.delimiter).some((d) => fs.existsSync(path.join(d, process.platform === 'win32' ? 'HandBrakeCLI.exe' : 'HandBrakeCLI')))) {
    assert.match((await run({})).error, /HandBrakeCLI was not found/);
  }
});

test('long paths: input read through a short junction, output via a short temporary name', { skip: process.platform !== 'win32' }, async () => {
  const deep = 'D'.repeat(150);
  const clip = `${'c'.repeat(60)}.MOV`;
  const root = tree({ [`In/${deep}/Cam-01/${clip}`]: 'v', 'Preset/p.json': INPUT['Preset/p.json'] });
  const calls = [];
  const outDir = path.join(root, 'Out', deep, 'Cam-01');
  fs.mkdirSync(outDir, { recursive: true });
  const item = { id: 1, kind: 'convert', src: path.join(root, 'In', deep, 'Cam-01', clip), dest: path.join(outDir, `${'x'.repeat(Math.max(1, 255 - outDir.length))}.mp4`) };
  const hb = new HandBrake({ getSettings: () => ({}), log: () => {}, spawn: fakeSpawn(calls) });
  hb.outputRoot = path.join(root, 'Out');
  await hb.convert(item, 'HandBrakeCLI', path.join(root, 'Preset/p.json'), 'P');
  const input = calls[0][1];
  assert.ok(input.length < 240 && input.startsWith(os.tmpdir()) && input.endsWith(clip), input);
  assert.ok(!fs.existsSync(path.dirname(input)), 'junction removed');
  assert.ok(fs.existsSync(item.src), 'source clip kept');
  assert.match(path.basename(calls[0][3]), /^~postpilot-\d+-1\.mp4$/);
  assert.ok(fs.existsSync(item.dest) && !fs.existsSync(calls[0][3]));
});

test('progress and ETA are read even when HandBrakeCLI prints them a byte at a time', async () => {
  const root = tree({ 'out/.keep': '' });
  const out = path.join(root, 'out', 'a.mp4');
  let child;
  const spawn = () => {
    child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
    return child;
  };
  const hb = new HandBrake({ getSettings: () => ({}), log: () => {}, spawn });
  const item = { id: 1 };
  const done = hb.encode(item, 'HandBrakeCLI', 'p.json', 'P', 'in.mov', out);
  for (const ch of '\rEncoding: task 1 of 2, 10.00 %\rEncoding: task 1 of 2, 50.00 % (80 fps, avg 80 fps, ETA 00h01m05s)\r') child.stdout.emit('data', ch);
  assert.strictEqual(item.pct, 25);
  assert.strictEqual(item.eta, 65);
  fs.writeFileSync(out, 'v');
  child.emit('close', 0);
  await done;
  assert.strictEqual(item.pct, 100);
});

test('a preset for a graphics card this PC lacks gets a clear message', async () => {
  const root = tree({ 'In/Cam-01/a.MOV': 'v', 'Preset/p.json': INPUT['Preset/p.json'], 'cli/HandBrakeCLI': '' });
  const cfg = { inputDir: path.join(root, 'In'), outputDir: path.join(root, 'Out'), presetFile: path.join(root, 'Preset/p.json'), cliPath: path.join(root, 'cli/HandBrakeCLI'), convertSatsangs: true };
  const nvenc = '[hevc_nvenc @ 0001] Cannot load nvcuda.dll\nencavcodecInit: avcodec_open failed\nERROR: Failure to initialise thread\naac-decoder done: 0 frames, 0 decoder errors\n';
  const hb = new HandBrake({ getSettings: () => cfg, log: () => {}, spawn: fakeSpawn([], { fail: () => true, stderr: nvenc }), defaultReportDir: path.join(root, 'R') });
  await hb.start();
  assert.match(hb.items[0].error, /NVIDIA NVENC encoder in this preset could not start: .*nvcuda.*outdated graphics driver/);
});

test('mkdirp ignores EPERM on an existing folder (Windows drive root) but not real errors', () => {
  const { mkdirp } = require('../electron/handbrake');
  const real = fs.mkdirSync, dir = os.tmpdir();
  try {
    fs.mkdirSync = () => { throw Object.assign(Error('EPERM'), { code: 'EPERM' }); };
    mkdirp(dir); // exists: fine
    assert.throws(() => mkdirp(path.join(dir, 'pp-nope-' + process.pid, 'x')), /EPERM/);
  } finally { fs.mkdirSync = real; }
});

test('a failed encode reports the command and HandBrake output in the message and the report', async () => {
  const root = tree({ 'In/Cam-01/a.MOV': 'v', 'Preset/p.json': INPUT['Preset/p.json'], 'cli/HandBrakeCLI': '' });
  const cfg = { inputDir: path.join(root, 'In'), outputDir: path.join(root, 'Out'), presetFile: path.join(root, 'Preset/p.json'), cliPath: path.join(root, 'cli/HandBrakeCLI'), convertSatsangs: true };
  const hb = new HandBrake({ getSettings: () => cfg, log: () => {}, spawn: fakeSpawn([], { fail: () => true, stderr: 'x265 [error]: bad param\nEncode failed (error 3)\n' }), defaultReportDir: path.join(root, 'R') });
  await hb.start();
  assert.match(hb.items[0].error, /exit code 3.*last output: .*bad param/);
  const report = fs.readFileSync(hb.reportFile, 'utf8');
  assert.match(report, /details:[\s\S]*--preset-import-file[\s\S]*bad param/);
});

test('an early cause survives a long footer, stdout is captured, progress is rate-limited, a full log is written', async () => {
  const root = tree({ 'In/Cam-01/a.MOV': 'v', 'Preset/p.json': INPUT['Preset/p.json'], 'cli/HandBrakeCLI': '' });
  const cfg = { inputDir: path.join(root, 'In'), outputDir: path.join(root, 'Out'), presetFile: path.join(root, 'Preset/p.json'), cliPath: path.join(root, 'cli/HandBrakeCLI'), convertSatsangs: true };
  const spawn = (cli, args) => {
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
    setImmediate(() => {
      for (let i = 0; i < 50; i++) child.stdout.emit('data', `Encoding: task 1 of 1, ${i}.00 % (80 fps, avg 80 fps, ETA 00h00m02s)\r`);
      child.stdout.emit('data', 'x265 [error]: 10-bit main10 profile not supported by this build\n');
      child.stderr.emit('data', 'Bytes of footer noise\n'.repeat(600));   // > 4 KB pushes the cause out of a 4 KB tail
      child.stderr.emit('data', 'Encode failed (error 3)\nHandBrake has exited.');
      child.emit('close', 3);
    });
    return child;
  };
  const hb = new HandBrake({ getSettings: () => cfg, log: () => {}, spawn, defaultReportDir: path.join(root, 'R') });
  await hb.start();
  assert.match(hb.items[0].error, /exit code 3: x265 \[error\]: 10-bit main10/);
  const report = fs.readFileSync(hb.reportFile, 'utf8');
  assert.match(report, /Error lines seen[\s\S]*main10 profile not supported/);
  const logFile = hb.reportFile.replace(/\.txt$/, '_1_handbrake.log');
  const full = fs.readFileSync(logFile, 'utf8');
  assert.match(report, /Full HandBrakeCLI log:/);
  assert.match(full, /Command: .*--preset-import-file/);
  assert.match(full, /main10 profile not supported/);
  assert.match(full, /HandBrake has exited\./);
  assert.match(full, /Exit code: 3/);
  assert.equal((full.match(/Encoding: task/g) || []).length, 1, 'progress rate-limited');
});

test('a CLI that cannot start and a missing GPU both carry the command and log', async () => {
  const root = tree({ 'In/Cam-01/a.MOV': 'v', 'Preset/p.json': INPUT['Preset/p.json'], 'cli/HandBrakeCLI': '' });
  const cfg = { inputDir: path.join(root, 'In'), outputDir: path.join(root, 'Out'), presetFile: path.join(root, 'Preset/p.json'), cliPath: path.join(root, 'cli/HandBrakeCLI'), convertSatsangs: true };
  const noStart = () => { const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); setImmediate(() => c.emit('error', Object.assign(Error('spawn UNKNOWN'), { code: 'UNKNOWN' }))); return c; };
  const hb = new HandBrake({ getSettings: () => cfg, log: () => {}, spawn: noStart, defaultReportDir: path.join(root, 'R') });
  await hb.start();
  assert.match(hb.items[0].error, /Could not start HandBrakeCLI: spawn UNKNOWN/);
  assert.match(fs.readFileSync(hb.reportFile, 'utf8'), /details:[\s\S]*--preset/);
  const nvenc = '[hevc_nvenc @ 0001] Cannot load nvcuda.dll\nencavcodecInit: avcodec_open failed\n';
  const hb2 = new HandBrake({ getSettings: () => cfg, log: () => {}, spawn: fakeSpawn([], { fail: () => true, stderr: nvenc }), defaultReportDir: path.join(root, 'R2') });
  await hb2.start();
  assert.match(fs.readFileSync(hb2.reportFile, 'utf8'), /details:[\s\S]*nvcuda/);
});

test('an NVENC driver mismatch shows the driver requirement, even when split across output chunks', async () => {
  const root = tree({ 'In/Cam-01/a.MOV': 'v', 'Preset/p.json': INPUT['Preset/p.json'], 'cli/HandBrakeCLI': '' });
  const cfg = { inputDir: path.join(root, 'In'), outputDir: path.join(root, 'Out'), presetFile: path.join(root, 'Preset/p.json'), cliPath: path.join(root, 'cli/HandBrakeCLI'), convertSatsangs: true };
  const spawn = () => {
    const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.kill = () => {};
    setImmediate(() => {
      c.stderr.emit('data', 'Failed to read the optional fonts folder\n[hevc_nvenc @ 0001] Driver does not support the required nvenc API version. Required: 13.0 Found: 12.1\n');
      c.stderr.emit('data', '[hevc_nvenc @ 0001] The minimum required Nvidia driver for nvenc is 570.0 or newer\n');
      c.stderr.emit('data', 'encavcodecInit: avcodec_open failed\nEncode failed (error 3)\n');
      c.emit('close', 3);
    });
    return c;
  };
  const hb = new HandBrake({ getSettings: () => cfg, log: () => {}, spawn, defaultReportDir: path.join(root, 'R') });
  await hb.start();
  assert.match(hb.items[0].error, /NVENC encoder in this preset could not start: .*Required: 13\.0.*570\.0 or newer/);
  assert.doesNotMatch(hb.items[0].error, /fonts folder/);
});

test('Windows keeps a HandBrakeCLI whose NVENC works on drivers older than 570 (1.10+ needs 570)', () => {
  const { handbrakeCli: pin } = require('../package.json');
  assert.equal(pin.files.win.version, '1.9.2');
  assert.ok(pin.files.win.name.includes(pin.files.win.version));
  assert.ok(pin.files.mac.name.includes(pin.version), 'Mac stays on the main version');
});

// ---- With a LUT: FFmpeg converts instead of HandBrakeCLI ----
const { findFfmpeg, ffmpegInfo } = require('../electron/ffmpeg');
const { execFileSync } = require('child_process');
const LUT2 = `TITLE "test"\nLUT_3D_SIZE 2\n${Array(8).fill('1 0 0').join('\n')}\n`;
const FAKE_INFO = { version: '7.1', encoders: new Set(['libx265', 'hevc_nvenc', 'aac']), filters: new Set(['lut3d', 'lut1d']) };
const PROBE = `  Duration: 00:00:10.00, start: 0.000000, bitrate: 100 kb/s
  Stream #0:0[0x1](und): Video: prores (HQ) (apch / 0x68637061), yuv422p10le(tv, bt709, progressive), 1920x1080, 25 fps, 25 tbr, 12800 tbn (default)
  Stream #0:1[0x2](und): Audio: pcm_s16le (lpcm / 0x6D63706C), 48000 Hz, stereo, s16, 1536 kb/s (default)
At least one output file must be specified\n`;

// A stand-in FFmpeg: "-i file" alone describes the file; with -progress it "encodes", a few bytes at a time
function fakeFfmpeg(calls, { fail = () => false, stderr = 'Error while opening encoder\n', hang = false } = {}) {
  return (exe, args, opts) => {
    calls.push({ exe, args, opts, lut: opts.cwd && fs.existsSync(path.join(opts.cwd, 'lut.cube')) ? fs.readFileSync(path.join(opts.cwd, 'lut.cube'), 'utf8') : null });
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.kill = () => setImmediate(() => child.emit('close', null));
    setImmediate(() => {
      if (!args.includes('-progress')) { child.stderr.emit('data', PROBE); return child.emit('close', 1); }
      const out = args[args.length - 1];
      fs.writeFileSync(out, 'partial');
      for (const c of 'out_time_us=5000000\nspeed=2.00x\nprogress=continue\n') child.stdout.emit('data', c);
      if (hang) return;
      if (fail(args)) { child.stderr.emit('data', stderr); child.emit('close', 1); } else child.emit('close', 0);
    });
    return child;
  };
}
const lutHandBrake = (root, calls, extra = {}, spawnOpts = {}) => {
  const cfg = { inputDir: path.join(root, 'In'), outputDir: path.join(root, 'Out'), presetFile: path.join(root, 'Preset/p.json'), lutFile: path.join(root, 'LUTs/S-Log3 to 709.cube'), cliPath: path.join(root, 'no-handbrake'), convertSatsangs: true, ...extra };
  const hb = new HandBrake({ getSettings: () => cfg, log: () => {}, spawn: fakeFfmpeg(calls, spawnOpts), defaultReportDir: path.join(root, 'R'), findFfmpeg: () => path.join(root, 'ffmpeg'), ffmpegInfo: () => FAKE_INFO });
  return { hb, cfg };
};
const LUT_TREE = { ...INPUT, 'LUTs/S-Log3 to 709.cube': LUT2, 'Preset/p.json': JSON.stringify({ PresetList: [{ PresetName: 'Team', VideoEncoder: 'x265', VideoQualitySlider: 24, PictureWidth: 1920, PictureHeight: 1080, PictureDenoiseFilter: 'nlmeans', AudioList: [{ AudioEncoder: 'aac', AudioBitrate: 160, AudioMixdown: 'stereo' }] }] }) };

test('with a LUT every video goes through FFmpeg, not HandBrakeCLI, and the report says what was used', async () => {
  const root = tree(LUT_TREE);
  const calls = [];
  const { hb, cfg } = lutHandBrake(root, calls);
  const pv = hb.preview();
  assert.strictEqual(pv.lut.name, 'S-Log3 to 709.cube');
  assert.deepStrictEqual(pv.lut.ignored, ['Automatic cropping of black bars (the whole picture is kept)', 'Denoise (nlmeans)']);
  const r = await hb.start();
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.done, 4);   // 3 videos + notes.txt; HandBrakeCLI was never needed
  const encodes = calls.filter((c) => c.args.includes('-progress'));
  assert.strictEqual(encodes.length, 3);
  assert.strictEqual(calls.length, 6, 'one look at each file, then its encode');
  for (const c of encodes) {
    assert.strictEqual(c.exe, path.join(root, 'ffmpeg'));
    assert.strictEqual(c.lut, LUT2, 'FFmpeg reads a copy of the LUT from its working folder');
    assert.match(c.args[c.args.indexOf('-vf') + 1], /lut3d=file=lut\.cube:interp=tetrahedral/);
    assert.ok(!c.args.join(' ').includes('S-Log3'), "the editor's LUT path is never put into the filter");
  }
  assert.ok(!fs.existsSync(encodes[0].opts.cwd), 'the LUT copy is removed after the run');
  assert.strictEqual(hb.summary().lut, 'S-Log3 to 709.cube');
  const report = fs.readFileSync(hb.reportFile, 'utf8');
  assert.match(report, /LUT: {10}.*S-Log3 to 709\.cube \(3D 2×2×2\)/);
  assert.match(report, /Converter: {4}FFmpeg 7\.1 .*HandBrakeCLI does not apply LUTs/);
  assert.match(report, /From preset: {2}H\.265 x265, quality 24, up to 1920×1080/);
  assert.match(report, /Not used: {5}.*Denoise \(nlmeans\)/);
  assert.match(report, /HandBrake \(LUT S-Log3 to 709\.cube\) finished/);
  assert.ok(fs.existsSync(path.join(cfg.outputDir, S1, M, 'Clips for Insert', 'Cam-01', 'SHGINF_S001_S001_T001.mp4')));
  assert.ok(fs.readdirSync(path.join(root, 'R')).some((f) => /_1_ffmpeg\.log$/.test(f)), 'a full FFmpeg log per file');
});

test('progress and time left come from FFmpeg, even a byte at a time', async () => {
  const root = tree(LUT_TREE);
  const { hb } = lutHandBrake(root, [], {}, { hang: true });
  hb.start();
  for (let i = 0; i < 50 && !hb.items.some((x) => x.pct); i++) await new Promise((r) => setTimeout(r, 10));
  const cur = hb.items.find((x) => x.state === 'running');
  assert.deepStrictEqual([cur.pct, cur.eta], [50, 3]);   // 5 of 10 s done at 2x: 2.5 s left
  hb.stop();
});

test('a LUT run is refused up front: bad .cube, no FFmpeg, an encoder this FFmpeg lacks', async () => {
  const root = tree({ ...LUT_TREE, 'LUTs/half.cube': 'LUT_3D_SIZE 2\n1 0 0\n', 'Preset/vp9.json': JSON.stringify({ PresetList: [{ PresetName: 'W', VideoEncoder: 'vp9' }] }), 'Preset/vt.json': JSON.stringify({ PresetList: [{ PresetName: 'M', VideoEncoder: 'vt_h265' }] }) });
  const run = (extra, deps = {}) => { const { hb } = lutHandBrake(root, [], extra); Object.assign(hb, deps); return hb.start(); };
  assert.match((await run({ lutFile: path.join(root, 'LUTs/half.cube') })).error, /incomplete: 1 of 8/);
  assert.match((await run({ lutFile: path.join(root, 'LUTs/missing.cube') })).error, /LUT file not found/);
  assert.match((await run({}, { findFfmpeg: () => null })).error, /FFmpeg was not found/);
  assert.match((await run({ presetFile: path.join(root, 'Preset/vp9.json') })).error, /\(vp9\) can't be used with a LUT/);
  assert.match((await run({ presetFile: path.join(root, 'Preset/vt.json') })).error, /VideoToolbox, which PostPilot's FFmpeg on this computer doesn't have/);
  assert.match((await run({}, { ffmpegInfo: () => ({ ...FAKE_INFO, filters: new Set() }) })).error, /no lut3d filter/);
});

test('an NVENC preset on a PC without a working NVIDIA encoder gets the hardware message; the run carries on', async () => {
  const root = tree({ ...LUT_TREE, 'Preset/p.json': JSON.stringify({ PresetList: [{ PresetName: 'GPU', VideoEncoder: 'nvenc_h265', VideoQualitySlider: 30 }] }) });
  const { hb } = lutHandBrake(root, [], {}, { fail: (a) => a.includes('hevc_nvenc'), stderr: '[hevc_nvenc @ 0x1] OpenEncodeSessionEx failed: unsupported device (2): (no details)\n[vost#0:0/hevc_nvenc @ 0x2] Error while opening encoder - maybe incorrect parameters\nConversion failed!\n' });
  const r = await hb.start();
  assert.strictEqual(r.failed, 3);
  const bad = hb.items.find((i) => i.state === 'failed');
  assert.match(bad.error, /^The NVIDIA NVENC encoder in this preset could not start: \[hevc_nvenc @ 0x1\] OpenEncodeSessionEx failed/);
  assert.ok(!fs.existsSync(bad.dest), 'no half-written file is left');
  assert.match(fs.readFileSync(hb.reportFile, 'utf8'), /FFmpeg details:\n.*"-c:v" "hevc_nvenc"/);
});

test('Stop during a LUT conversion removes the unfinished file', async () => {
  const root = tree(LUT_TREE);
  const { hb } = lutHandBrake(root, [], {}, { hang: true });
  const run = hb.start();
  for (let i = 0; i < 50 && !hb.items.some((x) => x.state === 'running' && x.pct); i++) await new Promise((r) => setTimeout(r, 10));
  const cur = hb.items.find((x) => x.state === 'running');
  hb.stop();
  const r = await run;
  assert.strictEqual(r.stopped, true);
  assert.strictEqual(cur.state, 'skipped');
  assert.ok(!fs.existsSync(cur.dest));
});

// The real thing: PostPilot's FFmpeg (npm run fetch-ffmpeg) or one on PATH
const REAL = findFfmpeg();
const realOk = (() => { try { return REAL && ffmpegInfo(REAL).encoders.has('libx265'); } catch { return false; } })();
test('a real FFmpeg applies the LUT: every pixel comes out as the LUT says, tagged BT.709, fitted to the preset', { skip: !realOk && 'no FFmpeg with x265 (npm run fetch-ffmpeg)', timeout: 120000 }, async () => {
  const root = tree({ 'LUTs/red.cube': LUT2, 'In/x.txt': 'x' });
  const clip = path.join(root, 'In', 'Cam-01', 'A001.MOV');
  fs.mkdirSync(path.dirname(clip), { recursive: true });
  execFileSync(REAL, ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=1', '-f', 'lavfi', '-i', 'sine=duration=1',
    '-c:v', 'prores_ks', '-pix_fmt', 'yuv422p10le', '-c:a', 'pcm_s16le', clip]);
  const preset = path.join(root, 'p.json');
  fs.writeFileSync(preset, JSON.stringify({ PresetList: [{ PresetName: 'T', VideoEncoder: 'x265_10bit', VideoQualitySlider: 28, VideoPreset: 'ultrafast', PictureWidth: 320, PictureHeight: 320, AudioList: [{ AudioEncoder: 'aac', AudioBitrate: 96, AudioMixdown: 'mono' }] }] }));
  const cfg = { inputDir: path.join(root, 'In'), outputDir: path.join(root, 'Out'), presetFile: preset, lutFile: path.join(root, 'LUTs/red.cube'), convertSatsangs: true };
  const hb = new HandBrake({ getSettings: () => cfg, log: () => {}, defaultReportDir: path.join(root, 'R') });
  const r = await hb.start();
  assert.strictEqual(r.done, 2, JSON.stringify(hb.items.map((i) => i.error)));
  const out = path.join(cfg.outputDir, 'Cam-01', 'A001.mp4');
  let info = '';
  try { execFileSync(REAL, ['-hide_banner', '-i', out], { stdio: 'pipe' }); } catch (err) { info = String(err.stderr); }
  assert.match(info, /Video: hevc \(Main 10\) \(hvc1.*yuv420p10le\(tv, bt709, progressive\), 320x180/);
  assert.match(info, /Audio: aac .*mono/);
  const rgb = execFileSync(REAL, ['-loglevel', 'error', '-i', out, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 16 << 20 });
  let red = 0, other = 0;
  for (let i = 0; i < rgb.length; i += 3) { red += rgb[i]; other += rgb[i + 1] + rgb[i + 2]; }
  assert.ok(red / (rgb.length / 3) > 250 && other / (rgb.length / 3) < 6, 'all red');
});
