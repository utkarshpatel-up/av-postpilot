// HandBrake Converter: the AV team's convert_via_handbrakecli.py inside PostPilot.
// Mirrors an input folder to an output folder, converting .mov/.mp4 to H.265 .mp4
// with HandBrakeCLI and a preset exported from HandBrake, copying everything else.
// "Clips only" mode converts just the Cam-xx clips and then files the H264
// recordings into the matching satsang folders (by number, name or best match).
// With a LUT chosen, the videos are converted by PostPilot's FFmpeg instead (lut-convert.js):
// HandBrakeCLI has no LUT filter.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn: nodeSpawn } = require('child_process');
const { readPreset, readLut, describePreset, parseProbe, ffmpegArgs } = require('./lut-convert');
const ffmpegTools = require('./ffmpeg');

const VIDEO = new Set(['.mov', '.mp4']);
const JUNK = new Set(['thumbs.db', 'desktop.ini']);
const LCS_MIN = 30;   // shortest shared run of characters that counts as a name match
const LONG_PATH = 240;  // HandBrakeCLI cannot open paths around 250+ characters; keep a margin
const LUT_NAME = 'lut.cube';   // the LUT's copy in FFmpeg's working folder (see encodeLut)
const CAUSE = /\berror\b|fail|invalid|cannot|can't|unable|unsupported|not support|minimum required|not found|no such|no title|denied|nvcuda|out of memory/i;

const DEFAULTS = {
  inputDir: '', outputDir: '', h264Dir: '', reportDir: '', presetFile: '', cliPath: '', lutFile: '',
  convertSatsangs: true, copyMp4: true, afterQueue: 'nothing', shutdownSeconds: 60,
};

// The preset HandBrakeCLI should use: the first one in the exported file (nested or flat).
const presetName = (file) => readPreset(file).PresetName;

function lcsLen(a, b) {
  a = a.toLowerCase(); b = b.toLowerCase();
  const dp = new Array(b.length + 1).fill(0);
  let best = 0;
  for (let i = 1; i <= a.length; i++) {
    let prev = 0;
    for (let j = 1; j <= b.length; j++) {
      const t = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev + 1 : 0;
      if (dp[j] > best) best = dp[j];
      prev = t;
    }
  }
  return best;
}

const isInside = (p, parent) => {
  if (!parent) return false;
  const rel = path.relative(path.resolve(parent), path.resolve(p));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};
const subdirs = (dir) => { try { return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort(); } catch { return []; } };

// Step 1: walk the input folder. Returns the output folders to create and one item per file.
function planConvert({ inputDir, outputDir, h264Dir, convertSatsangs }) {
  const dirs = [], items = [];
  const walk = (dir) => {
    if (h264Dir && isInside(dir, h264Dir)) return;
    const rel = path.relative(inputDir, dir);
    dirs.push(path.join(outputDir, rel));
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const src = path.join(dir, e.name);
      if (e.isDirectory()) { walk(src); continue; }
      if (!e.isFile()) continue;
      if (e.name.startsWith('.')) { items.push({ kind: 'skip', src, reason: 'hidden file' }); continue; }
      const dest = path.join(outputDir, rel, e.name);
      if (!VIDEO.has(path.extname(e.name).toLowerCase())) { items.push({ kind: 'copy', src, dest }); continue; }
      const clip = rel.split(path.sep).some((part) => part.toLowerCase().startsWith('cam-'));
      if (!convertSatsangs && !clip) { items.push({ kind: 'skip', src, reason: 'not a clip (Clips only mode)' }); continue; }
      const out = dest.slice(0, -path.extname(dest).length) + '.mp4';
      if (fs.existsSync(out)) items.push({ kind: 'skip', src, dest: out, reason: 'already converted' });
      else items.push({ kind: 'convert', src, dest: out });
    }
  };
  walk(inputDir);
  return { dirs, items };
}

// Step 2 (Clips only mode): file each H264 recording under its satsang folder in the output.
// Names look like "2725 01 Adalaj General Satsang Mor. ….mp4": satsang number, optional
// session number, then the name. listDirs(dir) lists sub-folder names (planned ones too).
function planH264({ h264Dir, outputDir, copyMp4 }, listDirs = subdirs) {
  const items = [];
  const satsangs = {};
  for (const name of listDirs(outputDir)) { const id = name.split(' ')[0]; if (/^\d+$/.test(id)) satsangs[id] = path.join(outputDir, name); }
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const src = path.join(dir, e.name);
      if (e.isDirectory()) { walk(src); continue; }
      if (!e.isFile() || e.name.startsWith('.') || JUNK.has(e.name.toLowerCase())) continue;
      const kind = copyMp4 ? 'copy' : 'move';
      const parts = e.name.split(' ');
      if (parts.length < 2) { items.push({ kind: 'skip', src, reason: 'name has no satsang number in front' }); continue; }
      const [id, second] = parts;
      const session = /^\d+$/.test(second) ? second : '';
      const rest = (session ? parts.slice(2) : parts.slice(1)).join(' ');
      const base = satsangs[id];
      if (!rest) { items.push({ kind: 'skip', src, reason: 'name has nothing after the numbers' }); continue; }
      if (!base) { items.push({ kind: 'skip', src, reason: `no satsang folder ${id} in the output`, error: true }); continue; }
      const folders = listDirs(base);
      let dir2 = base, match = 'satsang folder (no sub-folder matched)';
      if (session) {
        const hit = folders.find((f) => f.startsWith(session));
        if (!hit) { items.push({ kind: 'skip', src, reason: `no sub-folder ${session} under ${path.basename(base)}`, error: true }); continue; }
        dir2 = path.join(base, hit); match = `session ${session}`;
      } else {
        const words = rest.split(/\s+/);
        const firstTwo = words.slice(0, 2).join(' ');
        const hit = words.length >= 2 && folders.find((f) => f.startsWith(firstTwo));
        if (hit) { dir2 = path.join(base, hit); match = `starts with "${firstTwo}"`; } else if (words.length >= 2) {
          let best = null, score = 0;
          for (const f of folders) { const s = lcsLen(rest, f); if (s > score) { score = s; best = f; } }
          if (best && score >= LCS_MIN) { dir2 = path.join(base, best); match = `closest name (${score} characters shared)`; }
        }
      }
      const dest = path.join(dir2, rest);
      if (fs.existsSync(dest) && fs.statSync(dest).size === fs.statSync(src).size) items.push({ kind: 'skip', src, dest, reason: 'already in the output' });
      else items.push({ kind, src, dest, match });
    }
  };
  walk(h264Dir);
  return items;
}

// Folder listing for the preview: what is on disk plus the folders step 1 would create.
function plannedLister(dirs) {
  const extra = {};
  for (const d of dirs) { const p = path.dirname(d); (extra[p] = extra[p] || new Set()).add(path.basename(d)); }
  return (dir) => [...new Set([...subdirs(dir), ...(extra[dir] || [])])].sort();
}

// HandBrakeCLI: the chosen path, next to PostPilot, on PATH or in the usual install folders.
// HandBrakeCLI ships inside PostPilot: resources/handbrake in the installed app,
// vendor/handbrake/<win|mac> when run from source (npm run fetch-handbrake puts it there).
function bundledCli(exe = process.platform === 'win32' ? 'HandBrakeCLI.exe' : 'HandBrakeCLI') {
  const os = { win32: 'win', darwin: 'mac' }[process.platform] || 'linux';
  const dirs = [process.resourcesPath && path.join(process.resourcesPath, 'handbrake'), path.join(__dirname, '..', 'vendor', 'handbrake', os)];
  return dirs.filter(Boolean).map((d) => path.join(d, exe)).find((p) => fs.existsSync(p)) || null;
}

function findCli(chosen, env = process.env) {
  const exe = process.platform === 'win32' ? 'HandBrakeCLI.exe' : 'HandBrakeCLI';
  if (chosen && fs.existsSync(chosen)) return chosen;
  const builtIn = bundledCli(exe);
  if (builtIn) return builtIn;
  const dirs = [
    ...(env.PATH || '').split(path.delimiter),
    path.dirname(process.execPath),
    ...(process.platform === 'win32'
      ? [path.join(env.ProgramFiles || 'C:\\Program Files', 'HandBrake'), path.join(env.ProgramFiles || 'C:\\Program Files', 'HandBrakeCLI')]
      : ['/opt/homebrew/bin', '/usr/local/bin', '/Applications']),
  ];
  for (const p of [chosen, ...dirs.filter(Boolean).map((d) => path.join(d, exe))]) if (p && fs.existsSync(p)) return p;
  return null;
}

const stamp = (d = new Date()) => d.toISOString().replace('T', ' ').slice(0, 19);
const fmtDur = (ms) => { const s = Math.round(ms / 1000); return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };

async function copyKeep(src, dest) {
  await fs.promises.copyFile(src, dest);
  const st = await fs.promises.stat(src);
  await fs.promises.utimes(dest, st.atime, st.mtime).catch(() => {});
}
async function moveFile(src, dest) {
  try { await fs.promises.rename(src, dest); } catch (err) {
    if (err.code !== 'EXDEV' && err.code !== 'EEXIST' && err.code !== 'EPERM') throw err;
    await copyKeep(src, dest);
    await fs.promises.unlink(src);
  }
}

// Windows: mkdir -p on an existing drive root (E:\) throws EPERM; an existing folder is fine.
function mkdirp(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (err) {
    if (err.code === 'EPERM' && fs.existsSync(dir) && fs.statSync(dir).isDirectory()) return;
    throw err;
  }
}

// "3D 33×33×33" / "1D 1024"
const lutSize = (lut) => (lut.kind === '3d' ? `3D ${lut.size}×${lut.size}×${lut.size}` : `1D ${lut.size}`);
// What the page shows about a LUT run (no Sets: it goes over IPC)
const lutSummary = (lut) => ({
  name: lut.name, file: lut.file, size: lutSize(lut), ffmpeg: lut.ffmpeg, version: lut.version,
  builtIn: Boolean(lut.ffmpeg) && lut.ffmpeg === ffmpegTools.bundledFfmpeg(),
  summary: lut.plan ? lut.plan.summary : [], ignored: lut.plan ? lut.plan.ignored : [],
});

// A hardware encoder that could not start, from FFmpeg's error output, or ''.
function ffmpegGpuFailure(text) {
  if (/nvenc/i.test(text) && /OpenEncodeSession|nvcuda|No capable devices|required nvenc API|minimum required Nvidia driver|Cannot load/i.test(text)) return 'NVIDIA NVENC';
  if (/qsv|mfx/i.test(text) && /Error (initializing|creating)|MFX session|failed to (create|initiali[sz]e)|unsupported/i.test(text)) return 'Intel Quick Sync';
  if (/amf/i.test(text) && /amfrt|AMF (failed|init)|Failed to (create|init)/i.test(text)) return 'AMD';
  if (/videotoolbox/i.test(text) && /cannot create compression session|Error: cannot|VTCompressionSession/i.test(text)) return 'Apple VideoToolbox';
  return '';
}

class HandBrake {
  // deps: getSettings() -> settings.handbrake, log, notifier, onChange, onQueueDone(action, what), spawn, defaultReportDir,
  // findFfmpeg() and ffmpegInfo(path) (electron/ffmpeg.js unless a test passes its own)
  constructor(deps) {
    Object.assign(this, { spawn: nodeSpawn, findFfmpeg: () => ffmpegTools.findFfmpeg(), ffmpegInfo: ffmpegTools.ffmpegInfo }, deps);
    this.lutRun = null;
    this.lutName = '';
    this.running = false;
    this.stopping = false;
    this.items = [];
    this.child = null;
    this.reportFile = null;
    this.startedAt = null;
    this.finishedAt = null;
    this.lastError = '';
  }

  summary() {
    const count = (k) => this.items.filter((i) => i.state === k).length;
    return {
      running: this.running, stopping: this.stopping, startedAt: this.startedAt, finishedAt: this.finishedAt,
      reportFile: this.reportFile, error: this.lastError, lut: this.lutName,
      counts: { total: this.items.length, done: count('done'), failed: count('failed'), skipped: count('skipped'), waiting: count('waiting') },
      items: this.items,
    };
  }
  changed() { this.onChange?.(this.summary()); }

  // Checks the settings; returns { cfg, cli, preset } or throws with a message for the page.
  check(needCli = true) {
    const s = { ...DEFAULTS, ...this.getSettings() };
    const must = (v, what) => { if (!v) throw Error(`Choose the ${what} first`); return path.resolve(v); };
    const cfg = { ...s, inputDir: must(s.inputDir, 'input folder'), outputDir: must(s.outputDir, 'output folder'), presetFile: must(s.presetFile, 'HandBrake preset file') };
    if (!fs.existsSync(cfg.inputDir)) throw Error(`Input folder not found: ${cfg.inputDir}`);
    if (!fs.existsSync(cfg.presetFile)) throw Error(`Preset file not found: ${cfg.presetFile}`);
    if (isInside(cfg.outputDir, cfg.inputDir)) throw Error('The output folder cannot be inside the input folder');
    cfg.h264Dir = s.h264Dir ? path.resolve(s.h264Dir) : '';
    if (!cfg.convertSatsangs) {
      if (!cfg.h264Dir) throw Error('Choose the H264 recordings folder (needed in Clips only mode)');
      if (!fs.existsSync(cfg.h264Dir)) throw Error(`H264 recordings folder not found: ${cfg.h264Dir}`);
    }
    const preset = presetName(cfg.presetFile);
    // With a LUT the videos go through FFmpeg, so HandBrakeCLI isn't needed
    if (s.lutFile) return { cfg, cli: null, preset, lut: this.checkLut(path.resolve(s.lutFile), cfg.presetFile, needCli) };
    const cli = findCli(s.cliPath);
    if (needCli && !cli) throw Error('HandBrakeCLI was not found. It normally comes with PostPilot; reinstall PostPilot or choose HandBrakeCLI on this page.');
    return { cfg, cli, preset };
  }

  // The LUT, the FFmpeg that will apply it and the preset's settings as FFmpeg uses them.
  // Throws with a message for the page (bad .cube, no FFmpeg, an encoder this FFmpeg lacks …).
  checkLut(file, presetFile, needFfmpeg = true) {
    const lut = { file, name: path.basename(file), ...readLut(file), ffmpeg: this.findFfmpeg(), version: '' };
    if (needFfmpeg && !lut.ffmpeg) throw Error('FFmpeg was not found. It comes with PostPilot; reinstall PostPilot.');
    let info = null;
    if (lut.ffmpeg) {
      try { info = this.ffmpegInfo(lut.ffmpeg); } catch (err) { throw Error(`FFmpeg could not run (${lut.ffmpeg}): ${err.message}`); }
      const filter = lut.kind === '1d' ? 'lut1d' : 'lut3d';
      if (!info.filters.has(filter)) throw Error(`This FFmpeg has no ${filter} filter, so it can't apply a LUT: ${lut.ffmpeg}`);
      lut.version = info.version;
    }
    lut.plan = presetFile && fs.existsSync(presetFile) ? describePreset(readPreset(presetFile), info && info.encoders) : null;
    return lut;
  }

  // What a run would do, without touching anything.
  preview() {
    const { cfg, cli, preset, lut } = this.check(false);
    const step1 = planConvert(cfg);
    const step2 = cfg.convertSatsangs ? [] : planH264(cfg, plannedLister(step1.dirs));
    return { cli, preset, lut: lut ? lutSummary(lut) : null, items: [...step1.items, ...step2], newDirs: step1.dirs.filter((d) => !fs.existsSync(d)).length };
  }

  report(line) {
    const text = `[${stamp()}] ${line}`;
    if (this.reportFile) try { fs.appendFileSync(this.reportFile, text + '\n'); } catch { /* the page still shows it */ }
  }

  async start() {
    if (this.running) return { ok: false, error: 'Already running' };
    let setup;
    try { setup = this.check(true); } catch (err) { return { ok: false, error: err.message }; }
    const { cfg, cli, preset, lut } = setup;
    this.outputRoot = cfg.outputDir;
    Object.assign(this, { running: true, stopping: false, items: [], startedAt: Date.now(), finishedAt: null, lastError: '', lutName: lut ? lut.name : '', lutRun: null });
    const reportDir = cfg.reportDir ? path.resolve(cfg.reportDir) : this.defaultReportDir;
    try {
      mkdirp(cfg.outputDir);
      mkdirp(reportDir);
      const d = new Date(), p2 = (n) => String(n).padStart(2, '0');
      this.reportFile = path.join(reportDir, `log_convert_satsang_${cfg.convertSatsangs ? 1 : 0}_${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}.txt`);
      this.report(`Input:        ${cfg.inputDir}`);
      this.report(`Output:       ${cfg.outputDir}`);
      this.report(`Preset file:  ${cfg.presetFile}`);
      this.report(`Preset name:  ${preset}`);
      if (lut) {
        this.report(`LUT:          ${lut.file} (${lutSize(lut)})`);
        this.report(`Converter:    FFmpeg ${lut.version} (${lut.ffmpeg}); HandBrakeCLI does not apply LUTs`);
        this.report(`From preset:  ${lut.plan.summary.join(', ')}`);
        if (lut.plan.ignored.length) this.report(`Not used:     ${lut.plan.ignored.join('; ')}`);
        // FFmpeg reads a copy, made once: the LUT can't change halfway through the run
        this.lutRun = { ...lut, dir: fs.mkdtempSync(path.join(os.tmpdir(), 'pp-lut-')) };
        fs.copyFileSync(lut.file, path.join(this.lutRun.dir, LUT_NAME));
      } else this.report(`HandBrakeCLI: ${cli}`);
      this.report(`Mode:         ${cfg.convertSatsangs ? 'Convert everything' : `Clips for Insert only, then ${cfg.copyMp4 ? 'copy' : 'move'} H264 recordings from ${cfg.h264Dir}`}`);
      // Mirror the folders first (empty ones too) so the H264 step can find its targets.
      const step1 = planConvert(cfg);
      for (const dir of step1.dirs) mkdirp(dir);
      this.items = step1.items.map((i, n) => ({ ...i, id: n + 1, state: i.kind === 'skip' ? 'skipped' : 'waiting' }));
      this.items.filter((i) => i.kind === 'skip').forEach((i) => this.report(`[SKIP] ${i.src} (${i.reason})`));
      this.changed();
      this.log('info', `HandBrake: ${step1.items.filter((i) => i.kind === 'convert').length} file(s) to convert`);
      await this.runItems(this.items, cli, cfg, preset);
      if (!cfg.convertSatsangs && !this.stopping) {
        const step2 = planH264(cfg).map((i, n) => ({ ...i, id: this.items.length + n + 1, state: i.kind === 'skip' ? 'skipped' : 'waiting', h264: true }));
        step2.filter((i) => i.kind === 'skip').forEach((i) => this.report(`[${i.error ? 'ERROR' : 'SKIP'}] H264 ${i.src} (${i.reason})`));
        this.items.push(...step2);
        this.changed();
        await this.runItems(step2, cli, cfg, preset);
      }
    } catch (err) {
      this.lastError = err.message;
      this.report(`[ERROR] ${err.message}`);
      this.log('error', `HandBrake: ${err.message}`);
    }
    if (this.lutRun) { fs.rmSync(this.lutRun.dir, { recursive: true, force: true }); this.lutRun = null; }
    const stopped = this.stopping;
    this.items.filter((i) => i.state === 'waiting').forEach((i) => { i.state = 'skipped'; i.reason = 'stopped'; });
    this.running = false; this.stopping = false; this.finishedAt = Date.now();
    const c = this.summary().counts;
    const msg = `HandBrake${lut ? ` (LUT ${lut.name})` : ''} ${stopped ? 'stopped' : 'finished'} in ${fmtDur(this.finishedAt - this.startedAt)}: ${c.done} done, ${c.failed} failed, ${c.skipped} skipped`;
    this.report(msg);
    this.log(c.failed || this.lastError ? 'warn' : 'info', msg);
    this.notifier?.notify('handbrakeDone', `🎞️ ${msg}${this.lastError ? `\n⚠️ ${this.lastError}` : ''}`);
    this.changed();
    if (!stopped) this.onQueueDone?.(this.getSettings().afterQueue, 'HandBrake conversion');
    return { ok: true, stopped, ...c };
  }

  async runItems(items, cli, cfg, preset) {
    for (const item of items) {
      if (this.stopping) break;
      if (item.state !== 'waiting') continue;
      item.state = 'running'; item.startedAt = Date.now(); item.pct = 0;
      this.changed();
      try {
        mkdirp(path.dirname(item.dest));
        if (item.kind === 'convert') {
          this.report(`[CONVERT] ${item.src} -> ${item.dest}`);
          await this.convert(item, cli, cfg.presetFile, preset);
        } else if (item.kind === 'move') {
          await moveFile(item.src, item.dest);
          this.report(`[MOVE${item.h264 ? '-H264' : ''}] ${item.src} -> ${item.dest}${item.match ? ` (${item.match})` : ''}`);
        } else {
          await copyKeep(item.src, item.dest);
          this.report(`[COPY${item.h264 ? '-H264' : ''}] ${item.src} -> ${item.dest}${item.match ? ` (${item.match})` : ''}`);
        }
        item.state = 'done';
        if (item.kind === 'convert') this.report(`[DONE] in ${fmtDur(Date.now() - item.startedAt)} converted ${item.src}`);
      } catch (err) {
        item.state = this.stopping && item.kind === 'convert' ? 'skipped' : 'failed';
        item.error = this.stopping && item.kind === 'convert' ? 'stopped' : err.message;
        this.report(`[ERROR] ${item.src}: ${item.error}`);
        if (err.detail) this.report(`${this.lutRun ? 'FFmpeg' : 'HandBrakeCLI'} details:\n${err.detail}`);
        if (item.state === 'failed') this.log('error', `HandBrake: ${path.basename(item.src)}: ${err.message}`);
      }
      item.finishedAt = Date.now();
      this.changed();
    }
  }

  // HandBrakeCLI cannot open long paths (even with Windows long paths on), and satsang
  // folder names are long. A long input is read through a junction to its folder in the
  // temp folder; a long output is written to a short temporary name and moved into place.
  async convert(item, cli, presetFile, preset) {
    const out = item.dest.length < LONG_PATH ? item.dest : path.join(this.outputRoot.length < 200 ? this.outputRoot : os.tmpdir(), `~postpilot-${process.pid}-${item.id}.mp4`);
    let link = null;
    try {
      let input = item.src;
      if (input.length >= LONG_PATH) {
        if (process.platform !== 'win32') throw Error(`The path is too long for HandBrakeCLI (${input.length} characters)`);
        link = { dir: fs.mkdtempSync(path.join(os.tmpdir(), 'pp-hb-')) };
        link.path = path.join(link.dir, 'in');
        try { fs.symlinkSync(path.dirname(input), link.path, 'junction'); } catch (err) {
          throw Error(`The path is too long for HandBrakeCLI (${input.length} characters) and a short link to it could not be made (${err.code || err.message}). Shorten the folder names.`);
        }
        input = path.join(link.path, path.basename(input));
      }
      if (this.lutRun) await this.encodeLut(item, input, out);
      else await this.encode(item, cli, presetFile, preset, input, out);
      if (out !== item.dest) await moveFile(out, item.dest);
    } catch (err) {
      try { fs.unlinkSync(out); } catch { /* not there */ }
      throw err;
    } finally {
      // Remove only the link itself, never what it points to (the source clips).
      if (link) { try { fs.unlinkSync(link.path); } catch { /* not made */ } try { fs.rmdirSync(link.dir); } catch { /* keep */ } }
    }
  }

  encode(item, cli, presetFile, preset, input, out) {
    return new Promise((resolve, reject) => {
      const args = ['-i', input, '-o', out, '--preset-import-file', presetFile, '--preset', preset];
      const command = `${cli} ${args.map((a) => `"${a}"`).join(' ')}`;
      // Everything HandBrakeCLI prints (stdout + stderr) goes to its own log next to the report,
      // progress lines at most once a minute; the cause is often far above the "Encode failed" footer.
      const logFile = this.reportFile ? this.reportFile.replace(/\.txt$/, `_${item.id}_handbrake.log`) : null;
      const log = (text) => { if (logFile) try { fs.appendFileSync(logFile, text); } catch { /* the report still has the rest */ } };
      log(`HandBrakeCLI: ${cli}\nPreset: ${preset} (${presetFile})\nCommand: ${command}\n\n`);
      const causes = [], tailLines = [];
      let partial = { out: '', err: '' }, lastProgress = 0, last = 0, gpu = '', tail = '', recentOut = '';
      const line = (l) => {
        l = l.trim();
        if (!l) return;
        if (/^Encoding: task/.test(l)) { if (Date.now() - lastProgress < 60000) return; lastProgress = Date.now(); }
        else {
          if (CAUSE.test(l) && !/\b0 [\w ]*errors/i.test(l) && causes.length < 20 && !causes.includes(l)) causes.push(l);
          tailLines.push(l); if (tailLines.length > 40) tailLines.shift();
        }
        log(`${l}\n`);
      };
      const feed = (which) => (buf) => {
        const text = partial[which] + String(buf);
        const parts = text.split(/\r\n|\n|\r/);
        partial[which] = parts.pop();
        parts.forEach(line);
      };
      const onOut = (buf) => {
        // "Encoding: task 1 of 1, 45.12 % (80.1 fps, avg 82.3 fps, ETA 00h03m10s)"
        // The output can arrive a few bytes at a time, splitting this line: look in the recent output.
        recentOut = (recentOut + buf).slice(-500);
        const m = [...recentOut.matchAll(/Encoding: task (\d+) of (\d+), ([\d.]+) %(?:.*?ETA (\d+)h(\d+)m(\d+)s)?/g)].pop();
        if (!m) return;
        const [, task, tasks, pct, h, mi, s] = m;
        item.pct = Math.min(100, ((Number(task) - 1) + Number(pct) / 100) / Number(tasks) * 100);
        item.eta = h != null ? Number(h) * 3600 + Number(mi) * 60 + Number(s) : null;
        if (Date.now() - last > 1000) { last = Date.now(); this.changed(); }
      };
      const fail = (message) => {
        const err = Error(message);
        err.detail = `${command}\n${causes.length ? `Error lines seen (first ${causes.length}):\n${causes.join('\n')}\n` : ''}Last output:\n${tailLines.join('\n')}${logFile ? `\nFull HandBrakeCLI log: ${logFile}` : ''}`;
        return err;
      };
      const child = this.child = this.spawn(cli, args, { windowsHide: true });
      const outFeed = feed('out'), errFeed = feed('err');
      child.stdout?.on('data', (buf) => { onOut(buf); outFeed(buf); });
      child.stderr?.on('data', (buf) => {
        errFeed(buf);
        tail = (tail + buf).slice(-4000);
        // The encoder of a hardware preset could not start (no such graphics card here).
        if (/hevc_nvenc|h264_nvenc|av1_nvenc/.test(tail) && /nvcuda|avcodec_open failed/i.test(tail)) gpu = 'NVIDIA NVENC';
        else if (/qsv.*(open|init).*fail/i.test(buf)) gpu = 'Intel Quick Sync';
        else if (/(amf|vce).*(open|init).*fail/i.test(buf)) gpu = 'AMD VCE';
      });
      child.on('error', (err) => { this.child = null; log(`Could not start: ${err.message}\n`); const e = fail(`Could not start HandBrakeCLI: ${err.message}`); e.code = err.code; reject(e); });
      child.on('close', (code) => {
        this.child = null;
        partial.out && line(partial.out); partial.err && line(partial.err);
        log(`\nExit code: ${code}\n`);
        if (code === 0 && !this.stopping && fs.existsSync(out)) { item.pct = 100; return resolve(); }
        // Never leave a half-written file: the next run would skip it as "already converted".
        try { fs.unlinkSync(out); } catch { /* not there */ }
        if (this.stopping) return reject(Error('stopped'));
        const nvLines = causes.filter((l) => /nvenc|minimum required|nvcuda/i.test(l));
        const gpuCause = (nvLines.length ? nvLines : causes).slice(0, 2);
        if (gpu) return reject(fail(`The ${gpu} encoder in this preset could not start${gpuCause.length ? `: ${gpuCause.join(' | ')}` : ''}. This can mean there is no such graphics card, but also an outdated graphics driver, another program using the encoder, or a different HandBrakeCLI version than the one that works for you (choose it with Choose…). The full output is in the HandBrake log next to the report.`));
        // The first error line is usually the cause; the last lines are often just the generic footer.
        const first = causes.find((l) => !/^Encode failed|^ERROR: Encode failed/i.test(l)) || causes[0];
        reject(fail(`HandBrakeCLI exit code ${code}${first ? `: ${first}` : ''}${tailLines.length ? ` (last output: ${tailLines.slice(-3).join(' | ')})` : ''}`));
      });
    });
  }

  // With a LUT: FFmpeg instead of HandBrakeCLI. It runs in the folder holding the LUT's copy, so the
  // filter names it "lut.cube" and the editor's path (D:\LUTs\…, with its colon and backslashes) never
  // has to survive FFmpeg's filter escaping. First a quick look at the file (size, colour, audio tracks).
  async encodeLut(item, input, out) {
    const { ffmpeg, dir, plan, kind } = this.lutRun;
    const logFile = this.reportFile ? this.reportFile.replace(/\.txt$/, `_${item.id}_ffmpeg.log`) : null;
    const log = (text) => { if (logFile) try { fs.appendFileSync(logFile, text); } catch { /* the report still has the rest */ } };
    const probe = parseProbe(await this.ffmpegProbe(ffmpeg, input, dir));
    if (!probe.video) throw Error('FFmpeg found no video in this file');
    const args = ffmpegArgs(plan, probe, { input, output: out, lut: { name: LUT_NAME, kind } });
    const command = `${ffmpeg} ${args.map((a) => `"${a}"`).join(' ')}`;
    log(`FFmpeg: ${ffmpeg}\nLUT: ${this.lutRun.file}\nFrom preset: ${plan.summary.join(', ')}\nCommand (in ${dir}): ${command}\n\n`);
    return new Promise((resolve, reject) => {
      const causes = [], tailLines = [];
      let errPart = '', outPart = '', tail = '', last = 0, lastLogged = 0;
      const progress = {};
      const errLine = (l) => {
        l = l.trim();
        if (!l) return;
        if (CAUSE.test(l) && causes.length < 20 && !causes.includes(l)) causes.push(l);
        tailLines.push(l); if (tailLines.length > 40) tailLines.shift();
        log(`${l}\n`);
      };
      // -progress pipe:1 writes blocks of key=value lines, each ending with progress=continue|end
      const outLine = (l) => {
        const [k, v] = l.trim().split('=');
        if (!k || v === undefined) return;
        progress[k] = v;
        if (k !== 'progress') return;
        const done = Number(progress.out_time_us) / 1e6, speed = parseFloat(progress.speed);
        if (probe.duration && done >= 0) {
          item.pct = Math.min(100, (done / probe.duration) * 100);
          item.eta = speed > 0 ? Math.max(0, Math.round((probe.duration - done) / speed)) : null;
        }
        if (Date.now() - lastLogged >= 60000) { lastLogged = Date.now(); log(`progress: ${progress.out_time || ''} of ${probe.duration || '?'} s, ${progress.speed || ''}\n`); }
        if (Date.now() - last > 1000) { last = Date.now(); this.changed(); }
      };
      const split = (part, buf, fn) => { const lines = (part + buf).split(/\r\n|\n|\r/); const rest = lines.pop(); lines.forEach(fn); return rest; };
      const fail = (message) => {
        const err = Error(message);
        err.detail = `${command}\n${causes.length ? `Error lines seen (first ${causes.length}):\n${causes.join('\n')}\n` : ''}Last output:\n${tailLines.join('\n')}${logFile ? `\nFull FFmpeg log: ${logFile}` : ''}`;
        return err;
      };
      const child = this.child = this.spawn(ffmpeg, args, { windowsHide: true, cwd: dir });
      child.stdout?.on('data', (buf) => { outPart = split(outPart, String(buf), outLine); });
      child.stderr?.on('data', (buf) => { tail = (tail + buf).slice(-4000); errPart = split(errPart, String(buf), errLine); });
      child.on('error', (err) => { this.child = null; log(`Could not start: ${err.message}\n`); const e = fail(`Could not start FFmpeg: ${err.message}`); e.code = err.code; reject(e); });
      child.on('close', (code) => {
        this.child = null;
        if (errPart) errLine(errPart);
        log(`\nExit code: ${code}\n`);
        if (code === 0 && !this.stopping && fs.existsSync(out)) { item.pct = 100; return resolve(); }
        try { fs.unlinkSync(out); } catch { /* not there */ }
        if (this.stopping) return reject(Error('stopped'));
        const gpu = ffmpegGpuFailure(tail);
        const first = causes.find((l) => !/^Conversion failed|^Error while|^Error opening output files/i.test(l)) || causes[0];
        if (gpu) return reject(fail(`The ${gpu} encoder in this preset could not start${first ? `: ${first}` : ''}. This PC may not have that graphics hardware, or its graphics driver is too old for this FFmpeg. Choose a preset with another encoder (x265 works everywhere). The full output is in the FFmpeg log next to the report.`));
        reject(fail(`FFmpeg exit code ${code}${first ? `: ${first}` : ''}${tailLines.length ? ` (last output: ${tailLines.slice(-3).join(' | ')})` : ''}`));
      });
    });
  }

  // "ffmpeg -i file" with no output: describes the file on stderr, then exits with an error (expected).
  ffmpegProbe(ffmpeg, input, cwd) {
    return new Promise((resolve, reject) => {
      let text = '';
      const child = this.child = this.spawn(ffmpeg, ['-hide_banner', '-nostdin', '-i', input], { windowsHide: true, cwd });
      child.stderr?.on('data', (buf) => { text = (text + buf).slice(-200000); });
      child.on('error', (err) => { this.child = null; reject(Error(`Could not start FFmpeg (${ffmpeg}): ${err.message}`)); });
      child.on('close', () => {
        this.child = null;
        if (this.stopping) return reject(Error('stopped'));
        if (!/Stream #/.test(text)) return reject(Error(`FFmpeg could not read this file: ${text.trim().split(/\r?\n/).pop() || 'no details'}`));
        resolve(text);
      });
    });
  }

  stop() {
    if (!this.running) return;
    this.stopping = true;
    try { this.child?.kill(); } catch { /* already gone */ }
    this.changed();
  }
}

module.exports = { bundledCli, HandBrake, DEFAULTS, presetName, planConvert, planH264, plannedLister, findCli, lcsLen, mkdirp, lutSummary, ffmpegGpuFailure };
