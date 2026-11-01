const test = require('node:test');
const assert = require('node:assert');
const { DEFAULTS, sendToResolve, normalizeLevel, isolationAmount } = require('../electron/toresolve');

function fake(reply) {
  const calls = [];
  return { calls, chainImport: async (a) => { calls.push(a); return reply(a); } };
}

test('the lifted file goes to Resolve with the bin and timeline settings', async () => {
  const f = fake((a) => ({ ok: true, timeline: a.name, bin: a.bin, clip: 'Talk-02-lifted.wav' }));
  const file = 'D:\\Talks\\Talk-02-lifted.wav';
  const r = await sendToResolve({ file, name: 'Talk-02', chainImport: f.chainImport, opts: DEFAULTS });
  assert.deepStrictEqual(f.calls, [{ file, bin: 'Audio Chain', timeline: 'new', name: 'Talk-02', normalize: -6.3, isolation: 20 }]);
  assert.deepStrictEqual(r, { file, timeline: 'Talk-02', bin: 'Audio Chain', normalized: null, isolationTrack: null, warning: null });
});

test('a blank bin uses the default, and no recording name uses the file\'s own', async () => {
  const f = fake(() => ({ ok: true, timeline: 't', bin: 'b' }));
  await sendToResolve({ file: '/x/a-lifted.wav', chainImport: f.chainImport, opts: { ...DEFAULTS, bin: '', timeline: 'current' } });
  assert.deepStrictEqual(f.calls[0], { file: '/x/a-lifted.wav', bin: 'Audio Chain', timeline: 'current', name: 'a-lifted', normalize: -6.3, isolation: 20 });
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

test('when Resolve refuses, the error names the file and the reason', async () => {
  const f = fake(() => ({ ok: false, error: 'No project open in Resolve' }));
  await assert.rejects(
    sendToResolve({ file: '/x/a-lifted.wav', chainImport: f.chainImport, opts: DEFAULTS }),
    /Resolve did not take a-lifted\.wav: No project open in Resolve/,
  );
});
