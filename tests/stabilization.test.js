const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Stabilization } = require('../electron/stabilization');
const { consensus, verdict, pickPoints } = require('../electron/stabilization-points');

// Camera shake shared by fixed points; a "person" point moves on its own.
const shake = n => [Math.sin(n / 3) * 2 / 3840, Math.cos(n / 2) * 3 / 2160];
const path = (x, y, own = () => [0, 0], noise = 0) => Array.from({ length: 200 }, (_, n) => { const s = shake(n), o = own(n); return [x + s[0] + o[0] + (n % 2 ? noise : -noise), y + s[1] + o[1]]; });
const person = n => [n * .00005, Math.sin(n / 7) * .004];

test('consensus keeps points that move together and drops a moving person', () => {
  const c = consensus([path(.2, .8), path(.7, .5), person && path(.4, .4, person), path(.8, .2)], 3840, 2160);
  assert.deepEqual(c.group, [0, 1, 3]);
  assert.ok(c.shake.range > 5 && c.residual < .1);
  assert.equal(verdict(c).status, 'Passed');
});
test('two agreeing points are applied but need review; one point is not applied', () => {
  const two = consensus([path(.2, .8), path(.7, .5), path(.4, .4, person)], 3840, 2160);
  assert.deepEqual(verdict(two), { status: 'Needs review', apply: true });
  const one = consensus([path(.2, .8), path(.4, .4, person)], 3840, 2160);
  assert.equal(verdict(one).apply, false);
});
test('missing tracking data excludes that point', () => {
  const broken = path(.5, .5); broken[50] = [NaN, NaN];
  const c = consensus([path(.2, .8), broken, path(.7, .3), path(.8, .6)], 3840, 2160);
  assert.deepEqual(c.group, [0, 2, 3]);
});
test('pickPoints keeps details that stay in place and rejects ones that move', () => {
  const W = 640, H = 360, make = shift => { const data = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const fixed = ((x >> 3) + (y >> 3)) % 2 ? 200 : 40; // static checker texture on the left half
      const mx = x - shift; const moving = (((mx >> 2) ^ (y >> 2)) * 37 % 255);
      data[y * W + x] = x < W / 2 ? fixed + ((x * 7 + y * 13) % 17) : moving;
    } return { data, width: W, height: H }; };
  const pts = pickPoints([make(0), make(40), make(80)], { count: 8 });
  assert.ok(pts.length >= 2);
  assert.ok(pts.every(p => p.x < .5), JSON.stringify(pts));
});

function setup(paths) {
  const calls = [];
  const s = new Stabilization({ log() {}, onChange() {}, wait: async () => {},
    grab: async () => [], bridge: { stabilize: async a => { calls.push(a);
      if (a.action === 'begin') return { ok: true, timeline: 'copy' };
      if (a.action === 'progress') return { ok: true, running: false, paths: paths(), width: 3840, height: 2160 };
      return { ok: true }; } } });
  s.clips = [{ key: '1:1', fusion: 0, frames: 200 }, { key: '1:2', fusion: 0, frames: 200 }];
  return { s, calls };
}
test('batch: copy once, track user + picked points, apply only agreeing trackers', async () => {
  const { s, calls } = setup(() => [path(.2, .8), path(.4, .4, person), path(.7, .5), path(.8, .2)]);
  s.grab = async () => []; // no auto points found -> only the user points are tracked
  await s.start(['1:1'], [{ key: '1:1', x: .2, y: .8 }, { key: '1:1', x: .4, y: .4 }, { key: '1:1', x: .7, y: .5 }, { key: '1:1', x: .8, y: .2 }]);
  assert.deepEqual(calls.map(a => a.action), ['begin', 'track', 'progress', 'apply', 'finish']);
  assert.equal(calls[1].points.length, 4);
  assert.deepEqual(calls[3].use, [1, 3, 4]);
  assert.equal(calls[3].passed, true);
  assert.equal(s.clips[0].status, 'Passed');
});
test('stop after the current clip skips the next one', async () => {
  let s; const x = setup(() => { s.stop(); return [path(.2, .8), path(.7, .5), path(.8, .2)]; }); s = x.s;
  await s.start(['1:1', '1:2'], [.2, .7, .8].map(v => ({ key: '1:1', x: v, y: .5 })).concat([.2, .7, .8].map(v => ({ key: '1:2', x: v, y: .5 }))));
  assert.equal(x.calls.filter(a => a.action === 'track').length, 1);
  assert.equal(s.clips[1].status, 'Not started');
});
test('existing Fusion clips and repeated batches are refused', async () => {
  const { s, calls } = setup(() => []); s.clips[0].fusion = 1;
  await assert.rejects(s.start(['1:1']), /Fusion/); assert.equal(calls.length, 0);
  s.clips[0].fusion = 0; s.hasCopy = true;
  await assert.rejects(s.start(['1:1']), /Find marked clips/);
});
