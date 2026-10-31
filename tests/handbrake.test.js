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

test('a preset for a graphics card this PC lacks gets a clear message', async () => {
  const root = tree({ 'In/Cam-01/a.MOV': 'v', 'Preset/p.json': INPUT['Preset/p.json'], 'cli/HandBrakeCLI': '' });
  const cfg = { inputDir: path.join(root, 'In'), outputDir: path.join(root, 'Out'), presetFile: path.join(root, 'Preset/p.json'), cliPath: path.join(root, 'cli/HandBrakeCLI'), convertSatsangs: true };
  const nvenc = '[hevc_nvenc @ 0001] Cannot load nvcuda.dll\nencavcodecInit: avcodec_open failed\nERROR: Failure to initialise thread\naac-decoder done: 0 frames, 0 decoder errors\n';
  const hb = new HandBrake({ getSettings: () => cfg, log: () => {}, spawn: fakeSpawn([], { fail: () => true, stderr: nvenc }), defaultReportDir: path.join(root, 'R') });
  await hb.start();
  assert.match(hb.items[0].error, /NVIDIA NVENC encoder, which this PC does not have/);
});
