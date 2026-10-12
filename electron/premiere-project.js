'use strict';
// Reads a Premiere Pro .prproj (gzip-compressed XML object graph) without Premiere.
const fs = require('fs');
const zlib = require('zlib');

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = s => s.indexOf('&') < 0 ? s : s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) =>
  e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1)) : (ENT[e] ?? m));

// Minimal XML parser: elements, attributes, text. Enough for Premiere's own output.
function parseXml(text) {
  const root = { name: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  const re = /<(\/?)([^\s>\/!?]+)((?:\s+[^\s=>\/]+\s*=\s*"[^"]*")*)\s*(\/?)>|<\?[^>]*\?>|<!--[\s\S]*?-->|([^<]+)/g;
  const attrRe = /([^\s=]+)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(text))) {
    const top = stack[stack.length - 1];
    if (m[5] !== undefined) { if (top.children.length === 0) top.text += m[5]; continue; }
    if (!m[2]) continue;
    if (m[1]) { stack.pop(); continue; }
    const node = { name: m[2], attrs: {}, children: [], text: '' };
    if (m[3]) { let a; attrRe.lastIndex = 0; while ((a = attrRe.exec(m[3]))) node.attrs[a[1]] = decode(a[2]); }
    top.children.push(node);
    if (!m[4]) stack.push(node);
  }
  return root;
}

const TICKS = 254016000000; // Premiere time units per second

class Graph {
  constructor(xml) {
    const doc = parseXml(xml).children.find(n => n.name === 'PremiereData');
    if (!doc) throw Error('Not a Premiere project');
    this.ids = new Map(); this.uids = new Map(); this.objects = doc.children;
    for (const n of doc.children) {
      if (n.attrs.ObjectID) this.ids.set(n.attrs.ObjectID, n);
      if (n.attrs.ObjectUID) this.uids.set(n.attrs.ObjectUID, n);
    }
  }
  deref(n) {
    if (!n) return null;
    if (n.attrs.ObjectRef) return this.ids.get(n.attrs.ObjectRef) || null;
    if (n.attrs.ObjectURef) return this.uids.get(n.attrs.ObjectURef) || null;
    return n;
  }
  ofType(name) { return this.objects.filter(n => n.name === name); }
}
// Path helpers: child('A/B/C') follows nested element names (first match); refs are followed with '>'.
const child = (n, path) => {
  for (const p of path.split('/')) { if (!n) return null; n = n.children.find(c => c.name === p) || null; }
  return n;
};
const kids = (n, name) => n ? n.children.filter(c => !name || c.name === name) : [];
const val = (n, path) => { const c = child(n, path); return c ? decode(c.text.trim()) : ''; };

function readProject(file) {
  const xml = zlib.gunzipSync(fs.readFileSync(file)).toString('utf8');
  return new Graph(xml);
}

// ---- Analysis -------------------------------------------------------------------------
const path = require('path');
const VIDEO = '228cda18-3625-4d2d-951e-348879e4ed93';
const num = s => { const v = parseFloat(String(s).split(',')[1]); return Number.isFinite(v) ? v : null; };
const r2 = v => Math.round(v * 100) / 100;

// Lumetri sliders worth naming: [index in the parameter list, label, default].
const LUMETRI = [
  [14, 'Temperature', 0], [15, 'Tint', 0], [16, 'Saturation', 100], [19, 'Exposure', 0], [20, 'Contrast', 0],
  [21, 'Highlights', 0], [22, 'Shadows', 0], [23, 'Whites', 0], [24, 'Blacks', 0],
  [38, 'Faded film', 0], [39, 'Sharpen', 0], [40, 'Vibrance', 0], [41, 'Creative saturation', 100], [108, 'Vignette', 0],
];
const LUMETRI_BLOBS = [[51, 'RGB curves'], [56, 'Hue vs Sat'], [59, 'Hue vs Hue'], [62, 'Hue vs Luma'], [65, 'Luma vs Sat'], [68, 'Sat vs Sat'], [77, 'Colour wheels'], [85, 'HSL secondary']];

function lumetri(g, comp) {
  const ps = kids(child(comp, 'Component/Params')).map(r => g.deref(r));
  const values = {}; const extras = [];
  for (const [i, name, def] of LUMETRI) {
    const p = ps[i]; if (!p) continue;
    const v = num(val(p, 'StartKeyframe')); if (v !== null && Math.abs(v - def) > 0.005) values[name] = r2(v);
    if (val(p, 'Keyframes')) extras.push(`${name} keyframed`);
  }
  for (const [i, name] of LUMETRI_BLOBS) {
    const b = ps[i] && val(ps[i], 'StartKeyframeValue');
    if (b && b.length > 60) extras.push(name);
  }
  for (const [i, label] of [[126, 'Input LUT'], [127, 'Look']]) { const s = ps[i] && val(ps[i], 'StartKeyframeValue'); if (s) extras.push(`${label}: ${s}`); }
  return { values, extras };
}
const fmtLumetri = l => [...Object.entries(l.values).map(([k, v]) => `${k} ${v > 0 && !/aturation/.test(k) ? '+' : ''}${v}`), ...l.extras].join(', ') || 'default settings';

// Essential Graphics text: UTF-16 JSON inside a base64 parameter.
function textOf(g, comp) {
  for (const p of kids(child(comp, 'Component/Params')).map(r => g.deref(r))) {
    const s = p.name === 'ArbVideoComponentParam' && val(p, 'StartKeyframeValue');
    if (!s || s.length < 50) continue;
    const b = Buffer.from(s, 'base64'); let i = 0;
    while (i < b.length - 1 && !(b[i] === 0x7b && b[i + 1] === 0)) i++;
    // Newer binary layout (titles upgraded from Legacy Titles): length-prefixed strings.
    if (i >= b.length - 1 && b.readUInt32LE(8) === 0x11223344) {
      const strings = [];
      for (let k = 0; k + 4 < b.length; k++) {
        const len = b.readUInt32LE(k);
        if (len < 1 || len > 2000 || k + 4 + len >= b.length || b[k + 4 + len] !== 0) continue;
        const str = b.toString('utf8', k + 4, k + 4 + len);
        if (/^[\x20-\x7e\r\n\u0080-￿]+$/.test(str) && !/�/.test(str)) { strings.push(str); k += 3 + len; }
      }
      const fonts = strings.filter(x => /^[A-Za-z][A-Za-z0-9]*(-[A-Za-z0-9]+)?$/.test(x) && !/\s/.test(x));
      const text = strings.filter(x => !fonts.includes(x)).sort((a, c) => c.length - a.length)[0] || '';
      const params = kids(child(comp, 'Component/Params')).map(r => g.deref(r));
      const pos = (val(params.find(x => val(x, 'Name') === 'Position'), 'StartKeyframe').split(',')[1] || '0.5:0.5').split(':').map(Number);
      // Sizes and layout are not decoded: with the Premiere link they are measured from Premiere's render.
      return { text: text.replace(/^[\r\n]+|[\r\n]+$/g, ''), fonts, look: { font: fonts[0], size: 0, align: 2, leading: 0, x: pos[0], y: pos[1], scale: 100, opacity: 100, legacy: true } };
    }
    try {
      const o = JSON.parse(b.slice(i).toString('utf16le').replace(/\0+$/, ''));
      const fonts = new Set(); let text = '';
      (function walk(x, k) {
        if (typeof x === 'string') { if (k === 'mText' && x) text = x; else if (k === 'mFontName' && !/^[0-9A-F-]{36}$/i.test(x)) fonts.add(x); }
        else if (x && typeof x === 'object') for (const kk in x) walk(x[kk], /^\d+$/.test(kk) || kk === 'mParamValues' ? k : kk);
      })(o, '');
      // Look of the first character run (what a single-style title uses).
      const tp = o.mTextParam || {}; const ss = tp.mStyleSheet || {};
      const first = k => { const v = ss[k] && ss[k].mParamValues && ss[k].mParamValues[0]; return v ? v[1] : undefined; };
      const look = {
        font: first('mFontName'), size: first('mFontSize'), color: first('mFillColor'), tracking: first('mTracking') || 0,
        stroke: first('mStrokeVisible') ? { color: first('mStrokeColor'), width: first('mStrokeWidth') } : null,
        align: tp.mAlignment, leading: tp.mLeading || 0, shadow: Boolean(tp.mShadowVisible), background: Boolean(tp.mBackFillVisible),
        italic: Boolean(first('mFauxItalic')), bold: Boolean(first('mFauxBold')),
      };
      // Placement: the layer's own Position / Scale / Opacity, next to the text in the same effect.
      const params = kids(child(comp, 'Component/Params')).map(r => g.deref(r));
      const named = n => params.find(x => val(x, 'Name') === n);
      const pos = (val(named('Position'), 'StartKeyframe').split(',')[1] || '0.5:0.5').split(':').map(Number);
      look.x = pos[0]; look.y = pos[1];
      look.scale = num(val(named('Scale'), 'StartKeyframe')) ?? 100;
      look.opacity = num(val(named('Opacity'), 'StartKeyframe')) ?? 100;
      look.animated = ['Position', 'Scale', 'Opacity'].some(n => val(named(n), 'Keyframes'));
      return { text, fonts: [...fonts], look };
    } catch { /* not the text blob */ }
  }
  return { text: '', fonts: [] };
}

function effectsOf(g, chainRef, audio) {
  const chain = g.deref(chainRef); const out = [];
  for (const r of kids(child(chain, 'ComponentChain/Components'))) {
    const c = g.deref(r); if (!c) continue;
    const base = child(c, 'Component') || child(c, 'AudioComponent/Component');
    if (val(base, 'Bypass') === 'true') continue; // switched off in Premiere
    const match = val(c, 'MatchName') || val(c, 'FilterMatchName') || val(base, 'MatchName');
    const name = val(base, 'DisplayName') || match;
    const instance = val(base, 'InstanceName');
    const e = { match, name };
    if (audio) e.kind = 'audio';
    else if (match === 'AE.ADBE Lumetri') { e.kind = 'grade'; e.lumetri = lumetri(g, c); e.detail = fmtLumetri(e.lumetri); }
    else if (/Neat_Video/i.test(match)) { e.kind = 'denoise'; e.profile = instance && instance !== name ? instance : ''; }
    else if (match === 'AE.ADBE Text') { e.kind = 'title'; Object.assign(e, textOf(g, c)); e.detail = e.text ? `"${e.text}"${e.fonts.length ? ' · ' + e.fonts.join(', ') : ''}` : 'empty text layer'; }
    else if (/mocha/i.test(match)) e.kind = 'mocha';
    else e.kind = 'effect';
    out.push(e);
  }
  return out;
}

function mediaOf(g, clip) {
  const src = g.deref(child(clip, 'Clip/Source'));
  if (!src) return {};
  if (src.name.endsWith('SequenceSource')) return { nested: val(g.deref(child(src, 'SequenceSource/Sequence')), 'Name') };
  const media = g.deref(child(src, 'MediaSource/Media'));
  return media ? { media: media.attrs.ObjectUID } : { source: src.name };
}

function trackItems(g, group, video) {
  const tracks = kids(child(group, 'TrackGroup/Tracks')).map(r => g.deref(r)).filter(Boolean);
  const items = []; let transitions = 0;
  tracks.forEach((t, ti) => {
    const ct = child(t, 'ClipTrack');
    transitions += kids(child(ct, 'TransitionItems/TrackItems')).length;
    for (const r of kids(child(ct, 'ClipItems/TrackItems'))) {
      const it = g.deref(r); if (!it) continue;
      const cti = child(it, 'ClipTrackItem');
      const sub = g.deref(child(cti, 'SubClip')); const clip = g.deref(child(sub, 'Clip'));
      const speed = parseFloat(val(clip, 'Clip/PlaybackSpeed')) || 1;
      items.push({
        track: ti + 1, start: +val(cti, 'TrackItem/Start'), end: +val(cti, 'TrackItem/End'),
        name: val(sub, 'Name'), speed: Math.abs(speed), reversed: speed < 0,
        // Clip effects plus master-clip effects (graphics keep their text layers on the master clip).
        effects: [...effectsOf(g, child(cti, 'ComponentOwner/Components'), !video), ...(video ? effectsOf(g, child(g.deref(child(sub, 'MasterClip')), 'VideoComponentChain'), false) : [])], ...mediaOf(g, clip),
      });
    }
  });
  return { tracks: tracks.length, items, transitions, fpsTicks: +val(group, 'TrackGroup/FrameRate') };
}

function sequences(g) {
  return g.ofType('Sequence').map(s => {
    const groups = kids(child(s, 'TrackGroups')).map(tg => ({ type: val(tg, 'First'), node: g.deref(child(tg, 'Second')) })).filter(x => x.node);
    const v = groups.find(x => x.type === VIDEO);
    const video = v ? trackItems(g, v.node, true) : { tracks: 0, items: [], transitions: 0 };
    const audio = groups.filter(x => x !== v).map(x => trackItems(g, x.node, false)).sort((x, y) => y.items.length - x.items.length)[0] || { tracks: 0, items: [], transitions: 0 };
    const rect = (val(v && v.node, 'FrameRect') || '0,0,0,0').split(',').map(Number);
    const fpsTicks = video.fpsTicks || 10160640000;
    const frame = t => Math.round(t / fpsTicks);
    for (const it of [...video.items, ...audio.items]) { it.startFrame = frame(it.start); it.endFrame = frame(it.end); }
    const end = Math.max(0, ...video.items.map(i => i.end), ...audio.items.map(i => i.end));
    return { name: val(s, 'Name'), width: rect[2] - rect[0], height: rect[3] - rect[1], fps: r2(TICKS / fpsTicks), frames: frame(end), video, audio };
  });
}

// Relinking: the original path, Premiere's own relative path and path history, then
// the tail of the original path under each search folder (project folder first).
function locate(original, { relative, history = [], projectDir, roots = [], exists }) {
  const tries = [original];
  // Paths are joined the way the folder they start from is written (Windows drive/UNC or POSIX).
  const P = dir => /^([a-z]:|[\\/]{2})/i.test(dir) ? path.win32 : path.posix;
  if (relative && projectDir) tries.push(P(projectDir).resolve(projectDir, ...relative.replace(/&amp;/g, '&').split(/[\\/]+/)));
  tries.push(...history);
  const parts = String(original).split(/[\\/]+/).filter(Boolean);
  for (const root of [projectDir, ...roots].filter(Boolean))
    for (let i = 1; i < parts.length; i++) tries.push(P(root).join(root, ...parts.slice(i)));
  for (const t of tries) if (t && exists(t)) return { path: t, status: t === original ? 'found' : 'relinked' };
  return { path: '', status: 'missing' };
}

// Premiere's bin tree: [{ path: ['Satsang Files', '1207 …'], media: [uid], sequences: [name] }],
// root first. Items sitting directly in the root have path [].
function binTree(g) {
  const root = g.ofType('RootProjectItem')[0];
  const out = [];
  (function walk(node, trail) {
    const bin = { path: trail, media: [], sequences: [] };
    out.push(bin);
    for (const r of kids(child(node, 'ProjectItemContainer/Items'))) {
      const it = g.deref(r); if (!it) continue;
      if (it.name === 'BinProjectItem') { walk(it, [...trail, val(it, 'ProjectItem/Name')]); continue; }
      if (it.name !== 'ClipProjectItem') continue;
      const master = g.deref(child(it, 'MasterClip'));
      const clip = g.deref(kids(child(master, 'Clips'))[0]);
      const src = clip && g.deref(child(clip, 'Clip/Source'));
      if (!src) continue;
      if (src.name.endsWith('SequenceSource')) bin.sequences.push(val(g.deref(child(src, 'SequenceSource/Sequence')), 'Name'));
      else { const media = g.deref(child(src, 'MediaSource/Media')); if (media) bin.media.push(media.attrs.ObjectUID); }
    }
  })(root, []);
  return out;
}

const fontKey = f => f.toLowerCase().replace(/[^a-z0-9]/g, '');

function analyze(file, { roots = [], exists = p => fs.existsSync(p), fonts = null, graph } = {}) {
  const g = graph || readProject(file);
  const projectDir = (/^([a-z]:|[\\/]{2})/i.test(file) ? path.win32 : path.posix).dirname(file);
  const seqs = sequences(g);
  const used = new Set(seqs.flatMap(s => [...s.video.items, ...s.audio.items].map(i => i.media).filter(Boolean)));
  const tree = binTree(g);
  const inBins = new Set(tree.flatMap(b => b.media));
  // Every file in the project's bins (also unused ones), plus any only reachable from a sequence.
  const media = g.ofType('Media').filter(m => used.has(m.attrs.ObjectUID) || inBins.has(m.attrs.ObjectUID)).map(m => {
    const original = val(m, 'ActualMediaFilePath') || val(m, 'FilePath');
    const history = m.children.filter(c => /^MediaFileHistory\d+$/.test(c.name)).map(c => decode(c.text.trim()));
    return { uid: m.attrs.ObjectUID, title: val(m, 'Title'), original, used: used.has(m.attrs.ObjectUID), ...locate(original, { relative: val(m, 'RelativePath'), history, projectDir, roots, exists }) };
  }).filter(m => /[\\/]/.test(m.original)); // graphics and generators have no file
  const files = new Set(media.map(m => m.uid));
  const bins = tree.map(b => ({ path: b.path, media: b.media.filter(u => files.has(u)), sequences: b.sequences }));
  const byUid = Object.fromEntries(media.map(m => [m.uid, m]));
  const installed = fonts && fonts.map(fontKey);
  const titles = []; const fontSet = new Set(); const groups = new Map(); const fixes = []; const audioFx = {};
  const counts = { grade: 0, denoise: 0, title: 0, mocha: 0, effect: 0, speed: 0, nested: 0, transitions: 0 };
  for (const s of seqs) {
    counts.transitions += s.video.transitions;
    for (const it of s.video.items) {
      const notes = []; const gradeParts = []; const layers = [];
      if (it.nested) counts.nested++;
      if (Math.abs(it.speed - 1) > 1e-6 || it.reversed) { counts.speed++; notes.push(`Speed ${r2(it.speed * 100)}%${it.reversed ? ' reversed' : ''}: check`); }
      for (const e of it.effects) {
        counts[e.kind] = (counts[e.kind] || 0) + 1;
        if (e.kind === 'grade') gradeParts.push('Lumetri: ' + e.detail);
        else if (e.kind === 'denoise') gradeParts.push(`Neat Video${e.profile ? ' (' + e.profile + ')' : ''}`);
        else if (e.kind === 'title') { if (!e.text) continue; // empty text layers render nothing
          layers.push({ text: e.text, ...e.look }); e.fonts.forEach(f => fontSet.add(f));
          // Rebuilt as Text+; only what that can't reproduce needs a look by the editor.
          const l = e.look || {}; const miss = [];
          if (l.stroke) miss.push('stroke'); if (l.shadow) miss.push('shadow'); if (l.background) miss.push('background box');
          if (l.align !== 2) miss.push('left/right alignment'); if (l.animated) miss.push('animation');
          if (miss.length) notes.push(`Title "${e.text.replace(/\s*\r\s*/g, ' / ')}": rebuilt without ${miss.join(', ')}`); }
        else if (e.kind === 'mocha') notes.push('Mocha Pro: redo this mask/track in Resolve');
        else notes.push(`${e.name}: no Resolve equivalent`);
      }
      if (layers.length) titles.push({ sequence: s.name, track: it.track, startFrame: it.startFrame, endFrame: it.endFrame, layers });
      let grade = 0;
      if (gradeParts.length) {
        const key = gradeParts.join(' + ');
        if (!groups.has(key)) groups.set(key, { summary: key, items: [] });
        groups.get(key).items.push({ sequence: s.name, track: it.track, startFrame: it.startFrame, endFrame: it.endFrame, name: it.name });
        grade = key;
      }
      if (notes.length || grade) fixes.push({ sequence: s.name, track: it.track, startFrame: it.startFrame, endFrame: it.endFrame, name: it.name, notes, grade });
    }
    for (const it of s.audio.items) for (const e of it.effects) audioFx[e.name] = (audioFx[e.name] || 0) + 1;
  }
  // Number grade groups largest first; fixes refer to them by number.
  const gradeGroups = [...groups.values()].sort((a, b) => b.items.length - a.items.length).map((x, i) => ({ id: i + 1, summary: x.summary, count: x.items.length, items: x.items }));
  const idOf = Object.fromEntries(gradeGroups.map(x => [x.summary, x.id]));
  for (const f of fixes) f.grade = f.grade ? idOf[f.grade] : 0;
  return {
    file, project: path.win32.basename(file, '.prproj'),
    sequences: seqs.map(s => ({ name: s.name, width: s.width, height: s.height, fps: s.fps, frames: s.frames,
      videoTracks: s.video.tracks, audioTracks: s.audio.tracks, videoClips: s.video.items.length, audioClips: s.audio.items.length,
      nested: [...new Set(s.video.items.map(i => i.nested).filter(Boolean))], transitions: s.video.transitions,
      media: [...new Set([...s.video.items, ...s.audio.items].map(i => byUid[i.media]?.title).filter(Boolean))] })),
    media, bins, counts, audioEffects: audioFx, titles,
    fonts: [...fontSet].map(f => ({ name: f, installed: installed ? installed.some(k => k.startsWith(fontKey(f))) : null })),
    gradeGroups, fixes,
  };
}

module.exports = { parseXml, readProject, Graph, child, kids, val, decode, TICKS, analyze, locate };
