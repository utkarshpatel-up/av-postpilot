const { test } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');
const { transparentPng, placeTitles, fusionFont, textPlusSpec } = require('../electron/premiere-titles');

test('transparent PNG has the right size and only transparent pixels', () => {
  const png = transparentPng(64, 36);
  assert.equal(png.readUInt32BE(16), 64);
  assert.equal(png.readUInt32BE(20), 36);
  assert.equal(png[25], 6, 'RGBA');
  const idat = png.indexOf('IDAT');
  const raw = zlib.inflateSync(png.subarray(idat + 4, idat + 4 + png.readUInt32BE(idat - 4)));
  assert.equal(raw.length, (64 * 4 + 1) * 36);
  assert.ok(raw.every(b => b === 0));
});

test('titles become clips of the placeholder on the same track and time; other clips stay', () => {
  const title = (id, s, e) => `<clipitem id="${id}"><name>Graphic</name><start>${s}</start><end>${e}</end><in>900</in><out>1025</out><file id="file-42"><name>Graphic</name><mediaSource>GraphicAndType</mediaSource></file><filter><effect><name>Text</name></effect></filter></clipitem>`;
  const again = `<clipitem id="c9"><name>Graphic</name><start>500</start><end>550</end><in>0</in><out>50</out><file id="file-42"/></clipitem>`;
  const clip = '<clipitem id="c2"><name>A.mov</name><start>125</start><end>200</end><file id="file-1"><pathurl>file://localhost/E:/A.mov</pathurl></file></clipitem>';
  const xml = `<xmeml><sequence><media><video><track>${title('c1', 0, 125)}${clip}</track><track>${again}</track></video><audio><track></track></audio></media></sequence></xmeml>`;
  const r = placeTitles(xml, { png: 'E:\\Work\\PostPilot title 3840x2160.png', width: 3840, height: 2160 });
  assert.deepEqual(r.titles, [{ track: 1, start: 0, end: 125 }, { track: 2, start: 500, end: 550 }]);
  assert.ok(r.text.includes(clip), 'footage clip untouched');
  assert.ok(!/GraphicAndType|<filter>/.test(r.text));
  assert.equal((r.text.match(/<pathurl>file:\/\/localhost\/E:\/Work\/PostPilot%20title%203840x2160\.png<\/pathurl>/g) || []).length, 1, 'file defined once');
  assert.match(r.text, /<clipitem id="c1"><name>PostPilot title<\/name><start>0<\/start><end>125<\/end><in>0<\/in><out>125<\/out>/);
  assert.match(r.text, /<clipitem id="c9">[\s\S]*<file id="postpilot-title"\/>/);
});

test('PostScript font names map to Fusion family and style', () => {
  assert.deepEqual(fusionFont('Calibri-Bold', ['Calibri Bold (TrueType)']), { family: 'Calibri', style: 'Bold' });
  assert.deepEqual(fusionFont('TimesNewRomanPS-BoldItalicMT'), { family: 'Times New Roman', style: 'Bold Italic' });
  assert.deepEqual(fusionFont('ArialMT', ['Arial (TrueType)']), { family: 'Arial', style: 'Regular' });
  assert.deepEqual(fusionFont('SegoeUI-Semibold', ['Segoe UI Semibold (TrueType)']), { family: 'Segoe UI', style: 'Semibold' });
});

test('Premiere text layer → Text+ settings (values measured against Premiere renders)', () => {
  const s = textPlusSpec({ text: 'DD Vitrag - 8403 \r(Adalaj)', font: 'Calibri-Bold', size: 270, color: 0xffffff, leading: 36, x: 0.4979, y: 0.5366, scale: 100, opacity: 100 }, { width: 3840, height: 2160 });
  assert.equal(s.text, 'DD Vitrag - 8403 \n(Adalaj)');
  assert.deepEqual([s.font, s.style], ['Calibri', 'Bold']);
  assert.ok(Math.abs(s.size - 0.08789) < 1e-4);
  assert.ok(Math.abs(s.lineSpacing - 1.337) < 1e-3);
  assert.ok(Math.abs(s.cy - (1 - (0.5366 * 2160 - 0.381 * 270) / 2160)) < 1e-9);
  assert.deepEqual([s.r, s.g, s.b, s.alpha], [1, 1, 1, 1]);
  const red = textPlusSpec({ text: 'x', font: 'Arial', size: 100, color: 0xff0000, scale: 50, opacity: 40 }, { width: 1920, height: 1080 });
  assert.deepEqual([red.r, red.g, red.b, red.alpha], [1, 0, 0, 0.4]);
  assert.ok(Math.abs(red.size - 50 / (0.8 * 1920)) < 1e-9, 'scale applies to the size');
});

test('measuring: Premiere text is what the title adds (even over bars), with its colour; fitting is per line', () => {
  const { premiereText, resolveText, lineSpecs, fitLines, titleError } = require('../electron/premiere-titles');
  const W = 400, H = 200;
  const img = (ch, fill) => ({ width: W, height: H, channels: ch, data: Buffer.alloc(W * H * ch, fill) });
  const rect = (im, x0, y0, x1, y1, rgb) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const i = (y * W + x) * im.channels; im.data[i] = rgb[0]; im.data[i + 1] = rgb[1]; im.data[i + 2] = rgb[2]; if (im.channels === 4) im.data[i + 3] = 255; } };
  // Bars behind (in both frames), dark grey text on two lines only in the "with title" frame.
  const without = img(4, 0); rect(without, 0, 0, W - 1, H - 1, [200, 200, 0]);
  const full = img(4, 0); rect(full, 0, 0, W - 1, H - 1, [200, 200, 0]);
  rect(full, 100, 40, 300, 80, [30, 30, 30]); rect(full, 150, 120, 250, 170, [30, 30, 30]);
  const p = premiereText(full, without);
  assert.deepEqual(p.lines.map(l => [l.left, l.right, l.top, l.bottom]), [[100, 300, 40, 80], [150, 250, 120, 170]]);
  assert.ok(Math.abs(p.lines[0].color.r - 30 / 255) < 1e-9);
  const specs = lineSpecs([{ text: 'DD Hindi - 1495\r(Adalaj)', font: 'Calibri-Bold' }], p.lines, { width: W, height: H });
  assert.deepEqual(specs.map(s => s.text), ['DD Hindi - 1495', '(Adalaj)']);
  assert.equal(lineSpecs([{ text: 'one line only', font: 'Arial' }], p.lines, { width: W, height: H }), null, 'line count must match');
  // Resolve drew the lines half as wide and shifted: size doubles, then the centres move onto Premiere's.
  const res = img(3, 0); rect(res, 150, 50, 250, 70, [255, 255, 255]); rect(res, 175, 130, 225, 155, [255, 255, 255]);
  const r = resolveText(res);
  const sized = fitLines(specs, p.lines, r, { width: W, height: H, step: 'size' });
  assert.ok(Math.abs(sized[0].size / specs[0].size - 201 / 101) < 1e-9);
  const moved = fitLines(sized, p.lines, [{ ...p.lines[0], cx: 190, cy: 70 }, { ...p.lines[1], cx: 200, cy: 145 }], { width: W, height: H, step: 'position' });
  assert.ok(Math.abs(moved[0].cx - (sized[0].cx + 10 / W)) < 1e-9 && Math.abs(moved[0].cy - (sized[0].cy + 10 / H)) < 1e-9);
  assert.equal(titleError(p.lines, p.lines), 0);
});
