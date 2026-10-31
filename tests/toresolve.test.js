const test = require('node:test');
const assert = require('node:assert');
const { DEFAULTS, sendToResolve } = require('../electron/toresolve');

function fake(reply) {
  const calls = [];
  return { calls, chainImport: async (a) => { calls.push(a); return reply(a); } };
}

test('the lifted file goes to Resolve with the bin and timeline settings', async () => {
  const f = fake((a) => ({ ok: true, timeline: a.name, bin: a.bin, clip: 'Talk-02-lifted.wav' }));
  const file = 'D:\\Talks\\Talk-02-lifted.wav';
  const r = await sendToResolve({ file, name: 'Talk-02', chainImport: f.chainImport, opts: DEFAULTS });
  assert.deepStrictEqual(f.calls, [{ file, bin: 'Audio Chain', timeline: 'new', name: 'Talk-02' }]);
  assert.deepStrictEqual(r, { file, timeline: 'Talk-02', bin: 'Audio Chain' });
});

test('a blank bin uses the default, and no recording name uses the file\'s own', async () => {
  const f = fake(() => ({ ok: true, timeline: 't', bin: 'b' }));
  await sendToResolve({ file: '/x/a-lifted.wav', chainImport: f.chainImport, opts: { ...DEFAULTS, bin: '', timeline: 'current' } });
  assert.deepStrictEqual(f.calls[0], { file: '/x/a-lifted.wav', bin: 'Audio Chain', timeline: 'current', name: 'a-lifted' });
});

test('when Resolve refuses, the error names the file and the reason', async () => {
  const f = fake(() => ({ ok: false, error: 'No project open in Resolve' }));
  await assert.rejects(
    sendToResolve({ file: '/x/a-lifted.wav', chainImport: f.chainImport, opts: DEFAULTS }),
    /Resolve did not take a-lifted\.wav: No project open in Resolve/,
  );
});
