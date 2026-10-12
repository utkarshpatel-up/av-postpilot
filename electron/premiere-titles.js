'use strict';
// Premiere titles → Resolve: each title clip in the XML becomes a clip of a transparent
// PNG (same track, time and length); PostPilot then builds a Text+ inside that clip.
const fs = require('fs');
const zlib = require('zlib');

// Transparent RGBA PNG of the given size (tiny on disk: all-zero rows compress well).
function transparentPng(width, height) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = buf => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height); // filter byte 0 + transparent pixels
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const toUrl = p => 'file://localhost/' + p.replace(/\\/g, '/').split('/').map((s, i) => i === 0 && /^[a-z]:$/i.test(s) ? s : encodeURIComponent(s)).join('/');
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Premiere's own generated clips are "files" without media, which Resolve can't import:
//   titles (GraphicAndType…) → clips of a transparent PNG (a Text+ is built inside later);
//   Bars and Tone            → clips of a colour bars still (its tone audio is left out);
//   Black Video (Slug) etc.  → a black Solid Color generator of the same length.
// Returns the new XML and what was replaced, titles in order: { track (1-based video), start, end }.
const kindOf = src => /^GraphicAndType/i.test(src) ? 'title' : /^BarsAndTone/i.test(src) ? 'bars' : 'black';
function placeTitles(text, { png, barsPng = '', width, height, name = 'PostPilot title' }) {
  const blocks = [];
  const re = /<clipitem\b[^>]*>|<\/clipitem>/g; const stack = []; let m;
  while ((m = re.exec(text))) {
    if (m[0][1] !== '/') stack.push(m.index);
    else { const s = stack.pop(); if (s !== undefined && !stack.length) blocks.push([s, m.index + m[0].length]); }
  }
  const synthetic = new Map(); // file id → kind
  for (const [a, b] of blocks) {
    const body = text.slice(a, b);
    const f = body.match(/<file id="([^"]+)">(?:(?!<\/file>)[\s\S])*?<mediaSource>([^<]+)<\/mediaSource>/);
    if (f && !/<pathurl>/.test(body)) synthetic.set(f[1], kindOf(f[2]));
  }
  if (!barsPng) for (const [id, k] of synthetic) if (k === 'bars') synthetic.set(id, 'black'); // no still: black
  const titles = []; const counts = { title: 0, bars: 0, black: 0, audio: 0 }; const defined = {};
  let out = ''; let last = 0;
  // Video track number of a position: count <track> openings inside <video> before it.
  // The sequence's own <video> block (clip files carry <video>/<audio> descriptions too: count depth).
  const videoStart = text.indexOf('<video>', text.indexOf('<media>', text.indexOf('<sequence')));
  let audioStart = -1;
  { const tag = /<video>|<\/video>/g; tag.lastIndex = videoStart; let depth = 0, t;
    while ((t = tag.exec(text))) { depth += t[0][1] === '/' ? -1 : 1; if (depth === 0) { audioStart = t.index; break; } } }
  const inAudio = pos => audioStart > 0 && pos > audioStart;
  const trackAt = pos => { if (pos < videoStart || inAudio(pos)) return 0; let n = 0, i = videoStart; while ((i = text.indexOf('<track', i + 1)) >= 0 && i < pos) if (/^<track[\s>]/.test(text.slice(i, i + 7))) n++; return n; };
  const stillFile = (key, file, label) => {
    if (defined[key]) return `<file id="postpilot-${key}"/>`;
    defined[key] = true;
    return `<file id="postpilot-${key}"><name>${esc(label)}.png</name><pathurl>${esc(toUrl(file))}</pathurl><media><video><samplecharacteristics><width>${width}</width><height>${height}</height></samplecharacteristics></video></media></file>`;
  };
  for (const [a, b] of blocks) {
    const body = text.slice(a, b);
    const id = (body.match(/<file id="([^"]+)"/) || [])[1];
    const kind = id && synthetic.get(id);
    if (!kind) continue;
    out += text.slice(last, a); last = b;
    if (inAudio(a)) { counts.audio++; continue; } // tone / silence of a generated clip
    const num = k => +(body.match(new RegExp(`<${k}>(-?\\d+)</${k}>`)) || [])[1];
    const start = num('start'), end = num('end'), len = end - start;
    counts[kind]++;
    if (kind === 'black') {
      const rate = (body.match(/<rate>[\s\S]*?<\/rate>/) || [''])[0];
      out += `<generatoritem id="postpilot-black-${counts.black}"><name>Black</name><enabled>TRUE</enabled><duration>${len}</duration>${rate}<start>${start}</start><end>${end}</end><in>0</in><out>${len}</out><effect><name>Color</name><effectid>Color</effectid><effectcategory>Matte</effectcategory><effecttype>generator</effecttype><mediatype>video</mediatype></effect></generatoritem>`;
      continue;
    }
    const label = kind === 'title' ? name : 'PostPilot colour bars';
    out += body
      .replace(/<file id="[^"]+"(?:\/>|>[\s\S]*?<\/file>)/, kind === 'title' ? stillFile('title', png, name) : stillFile('bars', barsPng, label))
      .replace(/<filter>[\s\S]*?<\/filter>/g, '')
      .replace(/<in>-?\d+<\/in>/, '<in>0</in>').replace(/<out>-?\d+<\/out>/, `<out>${len}</out>`)
      .replace(/<name>[^<]*<\/name>/, `<name>${esc(label)}</name>`);
    if (kind === 'title') titles.push({ track: trackAt(a), start, end });
  }
  return { text: out + text.slice(last), titles, counts };
}
// Does this XML use Premiere's Bars and Tone? (then a bars still is needed before importing)
const usesBars = text => /<mediaSource>BarsAndTone/i.test(text);

// PostScript font name ("Calibri-Bold") → Fusion family + style ("Calibri", "Bold"), using the
// installed font names ("Calibri Bold (TrueType)") when they are known.
const STYLE_WORDS = /^(Thin|Hairline|ExtraLight|UltraLight|Light|SemiLight|Regular|Book|Normal|Medium|SemiBold|DemiBold|Demi|Bold|ExtraBold|UltraBold|Heavy|Black|Italic|Oblique|Condensed|Narrow|Semibold|Semilight)$/i;
function fusionFont(postscript, installed = []) {
  const key = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  const ps = String(postscript || 'Arial');
  // PostScript names carry vendor bits: "TimesNewRomanPS-BoldItalicMT" → "TimesNewRoman-BoldItalic".
  const clean = ps.replace(/PS(?=-|$)/, '').replace(/MT$/, '');
  const match = installed.map(n => n.replace(/\s*\(.*\)\s*$/, '').trim()).find(n => key(n) === key(clean));
  const words = (match || clean.replace(/-/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2')).split(/\s+/);
  const style = []; while (words.length > 1 && STYLE_WORDS.test(words[words.length - 1])) style.unshift(words.pop());
  return { family: words.join(' '), style: style.join(' ') || 'Regular' };
}

// One Premiere text layer → Text+ settings. Measured on Premiere 24 vs Resolve renders (Calibri,
// 3840x2160): Text+ Size = px / (0.8 × width); line pitch = 1.185 × size + leading; Premiere's
// Position is the middle of the text box, Text+ centres glyphs 0.38 × size lower.
function textPlusSpec(layer, { width, height, installed = [] }) {
  const px = (layer.size || 0.11 * height) * (layer.scale || 100) / 100; // size unknown (legacy title): a typical title size
  const { family, style } = fusionFont(layer.font, installed);
  const c = Number(layer.color ?? 0xffffff);
  return {
    text: String(layer.text).replace(/\r\n?/g, '\n'),
    font: family, style: layer.bold && !/Bold/i.test(style) ? `${style === 'Regular' ? '' : style + ' '}Bold`.trim() : style,
    size: px / (0.8 * width),
    lineSpacing: (1.185 * px + (layer.leading || 0)) / (0.986 * px),
    tracking: 1 + (layer.tracking || 0) / 1000,
    cx: layer.x ?? 0.5,
    cy: 1 - ((layer.y ?? 0.5) * height - 0.381 * px) / height,
    r: ((c >> 16) & 255) / 255, g: ((c >> 8) & 255) / 255, b: (c & 255) / 255,
    alpha: (layer.opacity ?? 100) / 100,
  };
}

// ---- Measuring titles ----------------------------------------------------------------
// Text lines in a mask (1 = text): row runs split by gaps, each with its box.
function textLines(mask, width, height) {
  const rows = new Uint32Array(height);
  for (let y = 0; y < height; y++) { let n = 0; const o = y * width; for (let x = 0; x < width; x++) n += mask[o + x]; rows[y] = n; }
  const gap = Math.max(4, Math.round(height / 100));
  const lines = []; let cur = null;
  for (let y = 0; y < height; y++) {
    if (rows[y] > 0) { if (!cur) cur = { top: y, bottom: y }; cur.bottom = y; }
    else if (cur && y - cur.bottom > gap) { lines.push(cur); cur = null; }
  }
  if (cur) lines.push(cur);
  for (const l of lines) {
    let left = width, right = -1;
    for (let y = l.top; y <= l.bottom; y++) { const o = y * width; for (let x = 0; x < width; x++) if (mask[o + x]) { if (x < left) left = x; if (x > right) right = x; } }
    Object.assign(l, { left, right, width: right - left + 1, height: l.bottom - l.top + 1, cx: (left + right) / 2, cy: (l.top + l.bottom) / 2 });
  }
  return lines.filter(l => l.width > 2 && l.height > 2);
}

// Premiere: the frame with and without the title clip; text = what changed. Also its colour.
function premiereText(full, without) {
  const { width, height } = full; const n = width * height; const mask = new Uint8Array(n); const solid = new Uint8Array(n);
  const ch = full.channels, cb = without.channels;
  for (let i = 0; i < n; i++) {
    let d = 0;
    for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(full.data[i * ch + c] - without.data[i * cb + c]));
    const af = ch === 4 ? full.data[i * ch + 3] : 255, ab = cb === 4 ? without.data[i * cb + 3] : 255;
    // Over transparency (no clip below) Premiere's PNG keeps colour but drops alpha: compare alpha too.
    if (d > 60 || Math.abs(af - ab) > 128) { mask[i] = 1; if (af > 250 && (d > 120 || ab < 5)) solid[i] = 1; }
  }
  const lines = textLines(mask, width, height);
  // Colour per line: the fully covered text pixels (edges are blended with the background).
  for (const l of lines) {
    let r = 0, g = 0, b = 0, k = 0;
    for (let y = l.top; y <= l.bottom; y++) for (let x = l.left; x <= l.right; x++) { const i = y * width + x; if (solid[i]) { r += full.data[i * ch]; g += full.data[i * ch + 1]; b += full.data[i * ch + 2]; k++; } }
    l.color = k ? { r: r / k / 255, g: g / k / 255, b: b / k / 255 } : null;
  }
  return { lines, color: lines.find(l => l.color)?.color || null };
}

// One Text+ per text line, started from Premiere's measured lines (size from the line height,
// centred on the line); the fitting below then matches width and position.
function lineSpecs(layers, measured, { width, height, installed = [] }) {
  const text = layers.map(l => l.text).join('\r').split(/\r\n?|\n/).map(s => s.replace(/\s+$/, '')).filter(s => s.trim());
  if (!text.length || text.length !== measured.length) return null;
  const { family, style } = fusionFont(layers[0].font, installed);
  return text.map((t, i) => {
    const l = measured[i]; const c = l.color || { r: 1, g: 1, b: 1 };
    return { text: t, font: family, style, size: (l.height * 1.19) / (0.8 * width), lineSpacing: 1, tracking: 1, cx: l.cx / width, cy: 1 - l.cy / height, r: c.r, g: c.g, b: c.b, alpha: 1 };
  });
}

// Line by line: 'size' scales each Text+ by Premiere's line width; 'position' moves it onto the line.
function fitLines(specs, p, r, { width, height, step }) {
  if (p.length !== specs.length || r.length !== specs.length) return null;
  return specs.map((s, i) => step === 'size'
    ? { ...s, size: s.size * p[i].width / Math.max(1, r[i].width) }
    : { ...s, cx: s.cx + (p[i].cx - r[i].cx) / width, cy: s.cy - (p[i].cy - r[i].cy) / height });
}

// Resolve: the title rendered white over black.
function resolveText(img) {
  const { width, height, channels: ch, data } = img; const mask = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) mask[i] = data[i * ch] + data[i * ch + 1] + data[i * ch + 2] > 384 ? 1 : 0;
  return textLines(mask, width, height);
}

// How far Resolve's lines are from Premiere's (worst edge, in pixels).
function titleError(p, r) {
  if (!p.length || p.length !== r.length) return Infinity;
  return Math.max(...p.map((l, i) => Math.max(Math.abs(l.left - r[i].left), Math.abs(l.right - r[i].right), Math.abs(l.top - r[i].top), Math.abs(l.bottom - r[i].bottom))));
}

function writePng(file, width, height) {
  if (!fs.existsSync(file)) fs.writeFileSync(file, transparentPng(width, height));
  return file;
}

module.exports = { transparentPng, placeTitles, usesBars, writePng, fusionFont, textPlusSpec, textLines, premiereText, resolveText, lineSpecs, fitLines, titleError };
