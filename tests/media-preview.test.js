const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { MediaPreview, parseScan } = require('../electron/media-preview');
const { bundledCli, findCli } = require('../electron/handbrake');

test('scan output gives frame rate, duration and size', () => {
  const out = `Input #0, mov,mp4, from 'a.mov':\n  Duration: 00:43:45.12, start: 0.000000\n[19:30:20] scan: 10 previews, 1920x1080, 23.976 fps, autocrop = 0/0/0/0\n  + duration: 00:43:45\n  + size: 1920x1080, pixel aspect: 1/1, display aspect: 1.78, 23.976 fps\n`;
  assert.deepStrictEqual(parseScan(out), { fps: 23.976, duration: 2625.12, size: '1920x1080' });
  assert.deepStrictEqual(parseScan('nothing'), { fps: null, duration: null, size: '' });
});

test('the built-in HandBrakeCLI is used before any other copy, unless one was chosen', { skip: !bundledCli() && 'run npm run fetch-handbrake first' }, () => {
  assert.strictEqual(findCli('', { PATH: '' }), bundledCli());
  const chosen = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hb-')), 'HandBrakeCLI.exe');
  fs.writeFileSync(chosen, '');
  assert.strictEqual(findCli(chosen, { PATH: '' }), chosen);
});

// A real file to try: the HDR sample that comes with Windows (VP9, 11 s).
const SAMPLE = path.join(process.env.SystemRoot || 'C:\Windows', 'SystemResources', 'Windows.UI.SettingsAppThreshold', 'SystemSettings', 'Assets', 'HDRSample.mkv');
test('probe and preview copy through the built-in HandBrakeCLI', { skip: (!bundledCli() || !fs.existsSync(SAMPLE)) && 'needs the built-in HandBrakeCLI and a sample file', timeout: 120000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-'));
  const mp = new MediaPreview({ dir, findCli: bundledCli });
  const info = await mp.probe(SAMPLE);
  assert.ok(Math.abs(info.fps - 23.976) < 0.01, JSON.stringify(info));
  assert.ok(info.duration > 10 && info.duration < 13);
  assert.strictEqual(mp.existing(SAMPLE), null);
  const seen = [];
  const copy = await mp.make(SAMPLE, (p) => seen.push(p));
  assert.ok(fs.statSync(copy).size > 1000);
  assert.strictEqual(mp.existing(SAMPLE), copy);
  assert.ok(seen.length > 0);
  const again = await mp.probe(copy);   // same frame rate in the copy
  assert.ok(Math.abs(again.fps - info.fps) < 0.01, JSON.stringify(again));
  await assert.rejects(mp.probe(path.join(dir, 'missing.mov')), /File not found/);
});
