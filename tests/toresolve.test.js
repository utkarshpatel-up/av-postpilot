const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DEFAULTS, sendToResolve, splitChannel, normalizeLevel, isolationAmount } = require('../electron/toresolve');

function fake(reply) {
  const calls = [];
  return { calls, chainImport: async (a) => { calls.push(a); return reply(a); } };
}

test('the lifted file goes to Resolve with the bin and timeline settings', async () => {
  const f = fake((a) => ({ ok: true, timeline: a.name, bin: a.bin, clip: 'Talk-02-lifted.wav' }));
  const file = 'D:\\Talks\\Talk-02-lifted.wav';
  const r = await sendToResolve({ file, name: 'Talk-02', chainImport: f.chainImport, opts: DEFAULTS });
  assert.deepStrictEqual(f.calls, [{ file, bin: 'Audio Chain', timeline: 'new', name: 'Talk-02', channel: null, edit: null, clipNo: null, normalize: null, isolation: 20 }]);
  assert.deepStrictEqual(r, { file, timeline: 'Talk-02', bin: 'Audio Chain', track: null, normalized: null, isolationTrack: null, warning: null });
});

test('a blank bin uses the default, and no recording name uses the file\'s own', async () => {
  const f = fake(() => ({ ok: true, timeline: 't', bin: 'b' }));
  await sendToResolve({ file: '/x/a-lifted.wav', chainImport: f.chainImport, opts: { ...DEFAULTS, bin: '', timeline: 'current' } });
  assert.deepStrictEqual(f.calls[0], { file: '/x/a-lifted.wav', bin: 'Audio Chain', timeline: 'current', name: 'a-lifted', channel: null, edit: null, clipNo: null, normalize: null, isolation: 20 });
});

test('Voice Isolation: off when blank, a whole number kept to 0-100; the track and a warning come back', async () => {
  assert.deepStrictEqual([null, undefined, '', 'x', 20, '35', 20.6, -5, 150].map(isolationAmount), [null, null, null, null, 20, 35, 21, 0, 100]);
  const f = fake(() => ({ ok: true, timeline: 't', bin: 'b', isolationTrack: 1, warning: 'could not turn on Voice Isolation' }));
  const r = await sendToResolve({ file: '/x/a.wav', chainImport: f.chainImport, opts: { ...DEFAULTS, isolation: null } });
  assert.strictEqual(f.calls[0].isolation, null);
  assert.strictEqual(r.isolationTrack, 1);
  assert.match(r.warning, /Voice Isolation/);
});

test('Normalize: off when blank, kept to -60..0 dBFS; what Resolve normalized to comes back', async () => {
  assert.deepStrictEqual([null, '', 'x', -6.3, '-9', 3, -80].map(normalizeLevel), [null, null, null, -6.3, -9, 0, -60]);
  const f = fake(() => ({ ok: true, timeline: 't', bin: 'b', normalized: -6.3 }));
  const r = await sendToResolve({ file: '/x/a.wav', chainImport: f.chainImport, opts: { ...DEFAULTS, normalize: '' } });
  assert.strictEqual(f.calls[0].normalize, null);
  assert.strictEqual(r.normalized, -6.3);
});

test('both channels of a clip go to one timeline: the name without -1 / -2, and the channel', async () => {
  assert.deepStrictEqual(splitChannel('260910_0083-1'), { clip: '260910_0083', channel: 1 });
  assert.deepStrictEqual(splitChannel('260910_0083-2'), { clip: '260910_0083', channel: 2 });
  assert.deepStrictEqual(splitChannel('260910_0084-1-debleed'), { clip: '260910_0084', channel: 1 });
  assert.deepStrictEqual(splitChannel('260910_0083'), { clip: '260910_0083', channel: null });   // not channel 83
  assert.deepStrictEqual(splitChannel('Talk-02'), { clip: 'Talk-02', channel: null });           // a talk number, not a channel
  const f = fake((a) => ({ ok: true, timeline: a.name, bin: a.bin, track: a.channel }));
  const opts = DEFAULTS;
  const one = await sendToResolve({ file: 'F:\Cam-04\260910_0083-1-lifted.wav', name: '260910_0083-1', chainImport: f.chainImport, opts });
  const two = await sendToResolve({ file: 'F:\Cam-04\260910_0083-2-lifted.wav', name: '260910_0083-2', chainImport: f.chainImport, opts });
  assert.deepStrictEqual(f.calls.map((c) => [c.name, c.channel]), [['260910_0083', 1], ['260910_0083', 2]]);
  assert.deepStrictEqual([one.timeline, one.track, two.timeline, two.track], ['260910_0083', 1, '260910_0083', 2]);
});

test('a file of a day folder goes on that day\'s Edit timeline, with a warning when its date is another day', async () => {
  const day = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tr-')), '2978 Dt-03 Jun 2026');
  const cam = path.join(day, 'Clips for Insert', 'Cam-04 (Audio)');
  const timelines = [{ name: 'Edit-2978', files: [path.join(day, 'Topic E Dt-03-Jun-26', 'Clip-01.mov')] }];
  const f = fake((a) => ({ ok: true, timeline: a.edit || a.name, bin: a.bin, track: 5 }));
  const editTimelines = async () => timelines;
  const r = await sendToResolve({ file: path.join(cam, '260603_0084-02-lifted.wav'), name: '260603_0084-02', chainImport: f.chainImport, opts: DEFAULTS, editTimelines });
  assert.deepStrictEqual([f.calls[0].edit, f.calls[0].clipNo, f.calls[0].channel, f.calls[0].name], ['Edit-2978', 84, 2, '260603_0084']);
  assert.deepStrictEqual([r.timeline, r.track, r.warning], ['Edit-2978', 5, null]);

  const wrong = await sendToResolve({ file: path.join(cam, '260602_0099-1-lifted.wav'), name: '260602_0099-1', chainImport: f.chainImport, opts: DEFAULTS, editTimelines });
  assert.deepStrictEqual([f.calls[1].edit, f.calls[1].clipNo], ['Edit-2978', 99]);
  assert.match(wrong.warning, /Put on Edit-2978 anyway, but the date in its name \(260602\) and the folder's date \(2978 Dt-03 Jun 2026\) don't match/);

  await sendToResolve({ file: path.join(cam, '260603_0083-1-lifted.wav'), name: '260603_0083-1', chainImport: f.chainImport, opts: DEFAULTS, editTimelines: async () => { throw new Error('Resolve not running'); } });
  assert.strictEqual(f.calls[2].edit, null);   // can't ask Resolve: a timeline per clip, as before
});

test('when Resolve refuses, the error names the file and the reason', async () => {
  const f = fake(() => ({ ok: false, error: 'No project open in Resolve' }));
  await assert.rejects(
    sendToResolve({ file: '/x/a-lifted.wav', chainImport: f.chainImport, opts: DEFAULTS }),
    /Resolve did not take a-lifted\.wav: No project open in Resolve/,
  );
});

test('a final file saved in another folder still goes on the Edit timeline of its original recording', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-'));
  const day = path.join(root, '2978 Dt-03 Jun 2026');
  const timelines = [{ name: 'Edit-2978', files: [path.join(day, 'Topic E Dt-03-Jun-26', 'Clip-01.mov')] }];
  const f = fake((a) => ({ ok: true, timeline: a.edit || a.name, bin: a.bin }));
  await sendToResolve({
    file: path.join(root, 'Finals', '260603_0083-1 (cleaned+lifted).wav'), source: path.join(day, 'Cam-04 (Audio)', '260603_0083-1.wav'),
    name: '260603_0083-1', chainImport: f.chainImport, opts: DEFAULTS, editTimelines: async () => timelines,
  });
  assert.deepStrictEqual([f.calls[0].edit, f.calls[0].clipNo, f.calls[0].channel], ['Edit-2978', 83, 1]);
});
