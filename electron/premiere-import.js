'use strict';
// Premiere → Resolve: report (from the .prproj), import of Premiere's XML with relinked
// media, then markers on what did not transfer and grade copying per Lumetri look.
const fs = require('fs');
const path = require('path');
const { analyze, locate } = require('./premiere-project');
const { placeTitles, usesBars, writePng, textPlusSpec, premiereText, resolveText, lineSpecs, fitLines, titleError } = require('./premiere-titles');
const { decodePng } = require('./png');

const MARK = { fix: 'Purple', grade: 'Sky' };
const norm = p => String(p).replace(/\//g, '\\').toLowerCase();

const fromUrl = u => {
  let p = decodeURIComponent(u.replace(/^file:\/\/(localhost)?\/?/i, ''));
  if (/^[a-z]:/i.test(p)) p = p.replace(/\//g, '\\');
  else if (!p.startsWith('/')) p = '\\\\' + p.replace(/\//g, '\\'); // file://server/share
  return p;
};
const toUrl = p => {
  const unc = p.startsWith('\\\\');
  const parts = p.replace(/^\\\\/, '').split('\\').map((s, i) => i === 0 && /^[a-z]:$/i.test(s) ? s : encodeURIComponent(s));
  return unc ? `file://${parts.join('/')}` : `file://localhost/${parts.join('/')}`;
};
const xmlEsc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const xmlUnesc = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

// Name of the (first) sequence in a Final Cut Pro 7 XML, or '' when it isn't one.
function xmlSequenceName(text) {
  if (!/<xmeml[\s>]/.test(text)) return '';
  const m = text.match(/<xmeml[^>]*>\s*<sequence[^>]*>[\s\S]*?<name>([^<]*)<\/name>/);
  return m ? xmlUnesc(m[1]).trim() : '';
}

// Point every <pathurl> at the file's current location.
function relinkXml(text, find) {
  const changes = { relinked: 0, missing: new Set() };
  const out = text.replace(/<pathurl>([^<]*)<\/pathurl>/g, (all, url) => {
    const original = fromUrl(xmlUnesc(url));
    const found = find(original);
    if (!found) { changes.missing.add(original); return all; }
    if (norm(found) === norm(original)) return all;
    changes.relinked++;
    return `<pathurl>${xmlEsc(toUrl(found))}</pathurl>`;
  });
  return { text: out, relinked: changes.relinked, missing: [...changes.missing] };
}

function findXmls(folder, depth = 3) {
  const out = [];
  (function walk(dir, d) {
    let entries = []; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && d > 0 && !/^(Satsang Files|Scratch Disk|Adobe Premiere Pro .*Previews|Proxy)$/i.test(e.name)) walk(p, d - 1);
      else if (e.isFile() && /\.xml$/i.test(e.name)) {
        try {
          const fd = fs.openSync(p, 'r'); const buf = Buffer.alloc(16384); const n = fs.readSync(fd, buf, 0, buf.length, 0); fs.closeSync(fd);
          const name = xmlSequenceName(buf.slice(0, n).toString('utf8'));
          if (name) out.push({ file: p, sequence: name, modified: fs.statSync(p).mtimeMs });
        } catch { /* unreadable */ }
      }
    }
  })(folder, depth);
  return out;
}

class PremiereImport {
  constructor({ bridge, link = null, log = () => {}, dir, fonts = () => null, onChange = () => {} }) {
    Object.assign(this, { bridge, link, log, dir, fonts, onChange });
    this.report = null; this.imported = {}; this.busy = false; this.stage = '';
  }
  xmlDir() { return path.join(this.dir, 'xml', this.report.project.replace(/[<>:"/\\|?*]+/g, '_')); }
  async request(args) { const r = await this.bridge.premiere(args); if (!r.ok) throw Error(r.error); return r; }
  changed() { this.onChange(this.summary()); }

  analyze(file, roots = []) {
    if (!fs.existsSync(file)) throw Error('Project file not found');
    this.report = analyze(file, { roots, fonts: this.fonts() });
    this.roots = roots; this.imported = {};
    this.attachXmls();
    this.changed();
    this.log('info', `Premiere report: ${this.report.project}: ${this.report.sequences.length} sequences, ${this.report.media.filter(m => m.status === 'missing').length} missing media`);
    return this.summary();
  }
  attachXmls(extra = []) {
    const folder = path.dirname(this.report.file);
    const xmls = [...findXmls(folder), ...findXmls(this.xmlDir(), 0), ...extra];
    for (const s of this.report.sequences) {
      const match = xmls.filter(x => x.sequence === s.name).sort((a, b) => b.modified - a.modified)[0];
      s.xml = match ? match.file : (s.xml || '');
    }
  }
  addXmls(files) {
    if (!this.report) throw Error('Open a Premiere project first');
    const extra = []; const unknown = [];
    for (const f of files) {
      const name = xmlSequenceName(fs.readFileSync(f, 'utf8').slice(0, 65536));
      if (name && this.report.sequences.some(s => s.name === name)) extra.push({ file: f, sequence: name, modified: Date.now() });
      else unknown.push(path.basename(f));
    }
    this.attachXmls(extra);
    this.changed();
    return { ok: true, added: extra.length, unknown };
  }
  // Let Premiere export the XML itself through the PostPilot link.
  async fromPremiere(names, session = null) {
    if (!this.link || !this.link.installed()) throw Error('Set up the Premiere link first, or add the XML by hand');
    this.stage = 'Premiere is exporting the XML…'; this.changed();
    try {
      const files = await this.link.exportXml(this.report.file, this.xmlDir(), names, session);
      const failed = files.filter(f => !f.ok).map(f => f.name);
      this.log(failed.length ? 'warn' : 'info', `Premiere exported ${files.length - failed.length} XML file(s)${failed.length ? `; failed: ${failed.join(', ')}` : ''}`);
      this.attachXmls();
      return { ok: true, exported: files.length - failed.length, failed };
    } finally { this.stage = ''; this.changed(); }
  }
  finder() {
    const known = new Map(this.report.media.map(m => [norm(m.original), m.path]));
    const projectDir = path.dirname(this.report.file);
    const cache = new Map();
    return original => {
      const k = norm(original);
      if (known.has(k) && known.get(k)) return known.get(k);
      if (!cache.has(k)) cache.set(k, locate(original, { projectDir, roots: this.roots, exists: p => fs.existsSync(p) }).path);
      return cache.get(k);
    };
  }

  async importSequences(names, { markGrades = true, newProject = true } = {}) {
    if (!this.report) throw Error('Open a Premiere project first');
    if (this.busy) throw Error('An import is already running');
    this.busy = true; this.changed();
    const results = [];
    try {
      // Premiere keeps the project open for the whole run: XML export, then measuring titles.
      let session = null;
      if (this.link && this.link.installed()) {
        try { this.stage = 'Opening the project in Premiere…'; this.changed(); session = await this.link.session(this.report.file); }
        catch (err) { this.log('warn', `Premiere link: ${err.message}`); }
      }
      this.session = session;
      const need = names.filter(n => { const s = this.report.sequences.find(x => x.name === n); return s && !s.xml; });
      if (need.length && session) {
        try { await this.fromPremiere(need, session); } catch (err) { this.log('warn', `XML from Premiere: ${err.message}`); }
      }
      // A Resolve project named after the Premiere project, in the first sequence's format.
      if (newProject) {
        const first = this.report.sequences.find(s => s.name === names[0]) || this.report.sequences[0];
        this.stage = 'Opening the Resolve project…'; this.changed();
        const p = await this.request({ action: 'project', name: this.report.project, fps: first.fps, width: first.width, height: first.height });
        this.resolveProject = p.project;
        this.log('info', `Resolve project ${p.project}: ${p.width}x${p.height} at ${p.fps} fps`);
      }
      // Premiere's bins with all their media (in its own project: at the top, like Premiere;
      // in another project: under Premiere Import / <project>).
      const base = newProject ? [] : ['Premiere Import', this.report.project];
      const byUid = Object.fromEntries(this.report.media.map(m => [m.uid, m]));
      const bins = this.report.bins.map(b => ({ path: b.path, files: b.media.map(u => byUid[u]).filter(m => m && m.path).map(m => m.path) }));
      // Title placeholders: a transparent PNG per frame size, in Premiere's "Title" bin (or our own).
      // Premiere's Bars and Tone becomes a still of Resolve's SMPTE bars (made once, like the Episodes page).
      const pngs = {}; let barsPng = '';
      const xmlOf = s => { try { return s.xml ? fs.readFileSync(s.xml, 'utf8') : ''; } catch { return ''; } };
      const chosen = this.report.sequences.filter(x => names.includes(x.name));
      for (const s of chosen) {
        const xml = xmlOf(s); const key = `${s.width}x${s.height}`;
        if (/<mediaSource>GraphicAndType/i.test(xml) && !pngs[key]) { fs.mkdirSync(this.dir, { recursive: true }); pngs[key] = writePng(path.join(this.dir, `PostPilot title ${key}.png`), s.width, s.height); }
        if (!barsPng && usesBars(xml)) {
          const b = await this.bridge.barsStill(this.dir);
          if (b.ok) barsPng = b.path; else this.log('warn', `Colour bars still: ${b.error}; Bars and Tone becomes black`);
        }
      }
      if (Object.keys(pngs).length || barsPng) {
        const titleBin = bins.find(b => b.path.length === 1 && /^titles?$/i.test(b.path[0])) || (bins.push({ path: ['PostPilot Titles'], files: [] }), bins[bins.length - 1]);
        titleBin.files.push(...Object.values(pngs), ...(barsPng ? [barsPng] : []));
      }
      this.stage = 'Building the bins and importing the media…'; this.changed();
      const media = await this.request({ action: 'bins', base, bins });
      this.mediaResult = media;
      this.log(media.failed.length ? 'warn' : 'info', `Media: ${media.imported} imported, ${media.skipped} already there${media.failed.length ? `, ${media.failed.length} could not be imported` : ''}`);
      const sourceBins = bins.filter(b => b.files.length).map(b => [...base, ...b.path]);
      const binOf = name => { const b = this.report.bins.find(x => x.sequences.includes(name)); return [...base, ...(b ? b.path : [])]; };
      for (const name of names) {
        const seq = this.report.sequences.find(s => s.name === name);
        if (!seq) continue;
        try {
          if (!seq.xml) throw Error('No Premiere XML for this sequence yet');
          const placed = placeTitles(fs.readFileSync(seq.xml, 'utf8'), { png: pngs[`${seq.width}x${seq.height}`] || '', barsPng, width: seq.width, height: seq.height });
          const relinked = relinkXml(placed.text, this.finder());
          fs.mkdirSync(this.dir, { recursive: true });
          const xmlFile = path.join(this.dir, `${name.replace(/[<>:"/\\|?*]+/g, '_')}.xml`);
          fs.writeFileSync(xmlFile, relinked.text);
          this.stage = `Importing ${name} into Resolve…`; this.changed();
          const r = await this.request({ action: 'import', xml: xmlFile, name, binPath: binOf(name), sourceBins, fps: seq.fps, width: seq.width, height: seq.height });
          // Rebuild Premiere's titles as Text+ inside their placeholders.
          let titles = { made: 0, lost: [] };
          const specs = this.report.titles.filter(t => t.sequence === name).map(t => ({ track: t.track, start: t.startFrame,
            layers: t.layers.map(l => textPlusSpec(l, { width: seq.width, height: seq.height, installed: this.fonts() || [] })) }));
          if (specs.length) { this.stage = `Building ${specs.length} title(s) in ${name}…`; this.changed(); titles = await this.request({ action: 'titles', timeline: r.timelineId, titles: specs }); }
          // With Premiere at hand: fit every title to Premiere's own render, line by line.
          const fits = [];
          if (session) for (const t of this.report.titles.filter(x => x.sequence === name)) {
            this.stage = `Matching the title at ${t.startFrame} in ${name} to Premiere…`; this.changed();
            try { fits.push(await this.fitTitle(session, name, r.timelineId, t, seq)); }
            catch (err) { fits.push({ fitted: false, reason: err.message }); this.log('warn', `Title in ${name}: ${err.message}`); }
          }
          titles.fitted = fits.filter(x => x.fitted).length;
          titles.worst = Math.max(0, ...fits.filter(x => x.fitted).map(x => x.error));
          const marks = this.marksFor(name, markGrades);
          const m = marks.length ? await this.request({ action: 'mark', timeline: r.timelineId, marks }) : { placed: 0, lost: [] };
          const expected = seq.videoClips;
          const res = { name, ok: true, timelineId: r.timelineId, videoItems: r.videoItems, audioItems: r.audioItems, expected, offline: r.offline,
            relinked: relinked.relinked, missing: relinked.missing, titles: titles.made, titlesLost: titles.lost.length, titlesFitted: titles.fitted, titleError: titles.worst, markers: m.placed, markersLost: m.lost.length };
          this.imported[name] = res; results.push(res);
          this.log(r.offline || res.markersLost ? 'warn' : 'info', `Imported ${name}: ${r.videoItems}/${expected} video clips, ${r.offline} offline, ${titles.made} title(s) rebuilt, ${m.placed} markers`);
        } catch (err) {
          const res = { name, ok: false, error: err.message }; this.imported[name] = res; results.push(res);
          this.log('error', `Import of ${name} failed: ${err.message}`);
        }
        this.changed();
      }
    } finally {
      if (this.session) { await this.link.release(this.session); this.session = null; }
      this.busy = false; this.stage = ''; this.changed();
    }
    return { ok: true, results };
  }

  // Title fitting: Premiere renders the frame with and without the title (the difference is the
  // text); Resolve renders its Text+ white on black; sizes, then positions, are corrected per line.
  async fitTitle(session, name, timeline, t, seq) {
    const dir = path.join(this.dir, 'titles'); fs.mkdirSync(dir, { recursive: true });
    const W = seq.width, H = seq.height; const mid = Math.floor((t.endFrame - t.startFrame) / 2);
    const base = `${name.replace(/[<>:"/\\|?*]+/g, '_')} V${t.track} ${t.startFrame}`;
    const pf = await this.link.frame(session, name, t.startFrame + mid, path.join(dir, `${base} premiere.png`), { track: t.track, start: t.startFrame }, path.join(dir, `${base} premiere without.png`));
    const P = premiereText(decodePng(fs.readFileSync(pf.file)), decodePng(fs.readFileSync(pf.without)));
    let specs = lineSpecs(t.layers, P.lines, { width: W, height: H, installed: this.fonts() || [] });
    if (!specs) return { fitted: false, reason: `Premiere's frame shows ${P.lines.length} text line(s)` };
    const where = { timeline, track: t.track, start: t.startFrame };
    let n = 0;
    const render = async () => {
      const shot = `${base} resolve ${++n}`;
      for (const f of fs.readdirSync(dir)) if (f.startsWith(shot)) fs.rmSync(path.join(dir, f), { force: true });
      await this.request({ action: 'titleframe', ...where, frame: mid, dir, name: shot });
      const file = fs.readdirSync(dir).find(f => f.startsWith(shot) && /\.png$/i.test(f));
      if (!file) throw Error('Resolve did not render the title frame');
      return resolveText(decodePng(fs.readFileSync(path.join(dir, file))));
    };
    const set = () => this.request({ action: 'titleset', ...where, layers: specs.map((s, i) => ({ index: i + 1, size: s.size, lineSpacing: s.lineSpacing, cx: s.cx, cy: s.cy, r: s.r, g: s.g, b: s.b })) });
    await this.request({ action: 'titles', timeline, titles: [{ track: t.track, start: t.startFrame, layers: specs }] });
    for (const step of ['size', 'position']) {
      const R = await render();
      const next = fitLines(specs, P.lines, R, { width: W, height: H, step });
      if (!next) return { fitted: false, reason: `Resolve shows ${R.length} line(s), Premiere ${P.lines.length}` };
      specs = next; await set();
    }
    const error = Math.round(titleError(P.lines, await render()));
    for (const f of fs.readdirSync(dir)) if (f.startsWith(base)) fs.rmSync(path.join(dir, f), { force: true }); // measuring frames
    this.log(error <= 4 ? 'info' : 'warn', `Title "${specs.map(s => s.text).join(' / ')}" in ${name}: matched to Premiere within ${error} px`);
    return { fitted: true, error, lines: specs.length };
  }

  marksFor(sequence, markGrades) {
    const marks = [];
    const groups = Object.fromEntries(this.report.gradeGroups.map(g => [g.id, g]));
    for (const f of this.report.fixes.filter(x => x.sequence === sequence)) {
      if (f.notes.length) marks.push({ track: f.track, start: f.startFrame, frames: f.endFrame - f.startFrame, color: MARK.fix, name: 'Premiere: ' + f.notes.map(n => n.split(':')[0].split(' "')[0]).join(', '), note: f.notes.join('\n') });
      else if (f.grade && markGrades) marks.push({ track: f.track, start: f.startFrame, color: MARK.grade, name: `Look ${f.grade}`, note: groups[f.grade].summary });
    }
    return marks;
  }

  // Looks with more than one clip in an imported timeline: grade one, copy to the rest.
  looks(sequence) {
    if (!this.report) return [];
    return this.report.gradeGroups.map(g => ({ id: g.id, summary: g.summary, items: g.items.filter(i => i.sequence === sequence) }))
      .filter(g => g.items.length > 1);
  }
  async goto(sequence, track, start) {
    const t = this.imported[sequence]; if (!t || !t.ok) throw Error('Import this sequence first');
    return this.request({ action: 'goto', timeline: t.timelineId, start });
  }
  async copyGrade(sequence, lookId) {
    const t = this.imported[sequence]; if (!t || !t.ok) throw Error('Import this sequence first');
    const look = this.looks(sequence).find(g => g.id === lookId); if (!look) throw Error('Look not found');
    const [from, ...to] = look.items;
    const r = await this.request({ action: 'copygrade', timeline: t.timelineId, from: { track: from.track, start: from.startFrame }, to: to.map(i => ({ track: i.track, start: i.startFrame })) });
    this.log('info', `Copied Look ${lookId} to ${r.copied} clip(s) in ${sequence}`);
    return r;
  }

  summary() {
    const link = this.link ? this.link.status() : null;
    if (!this.report) return { busy: this.busy, stage: this.stage, link, report: null };
    const { fixes, gradeGroups, ...rest } = this.report;
    return { busy: this.busy, stage: this.stage, link, imported: this.imported,
      report: { ...rest, lookCount: gradeGroups.length, looks: gradeGroups.map(g => ({ id: g.id, count: g.count, summary: g.summary })),
        fixes: fixes.filter(f => f.notes.length),
        looksBySequence: Object.fromEntries(rest.sequences.map(s => [s.name, this.looks(s.name).map(g => ({ id: g.id, summary: g.summary, count: g.items.length, first: g.items[0] }))])) } };
  }
}

module.exports = { PremiereImport, relinkXml, xmlSequenceName, fromUrl, toUrl, findXmls };
