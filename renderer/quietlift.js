/* global pilot, $, esc, showToast, save, settings */
// Quiet Lift page: raises long quiet stretches of speech in a debleed track, and only the words in them.
// Wrapped in a function so its names (log, render, select…) don't clash with the other page scripts.
(() => {
'use strict';

const ROLES = [
  { key: 'input', title: 'Debleed track', hint: 'The track that gets lifted', icon: 'wave' },
  { key: 'original', title: 'Original', hint: 'Same mic, before debleed', icon: 'layers' },
  { key: 'other', title: 'Other mic', hint: "The other person's mic", icon: 'mic' },
];
const SETTINGS = [
  { group: 'Detection', items: [
    ['min_len', 'Minimum length', 's', 'A stretch must stay quiet at least this long.'],
    ['quiet_high', 'Quiet starts at', 'dB', 'How far below typical speech counts as quiet.'],
    ['quiet_low', 'Quiet ends at', 'dB', 'Below this it is treated as bleed, not quiet speech.'],
    ['contrast', 'Word contrast', 'dB', 'Real speech must sit this far above its own gaps.'],
    ['window', 'Judging window', 's', 'Seconds used to judge a stretch’s level.'],
    ['floor', 'Hard floor', 'dB', 'Never raise anything quieter than this. Blank = off.'],
  ] },
  { group: 'Lift', items: [
    ['max_gain', 'Maximum lift', 'dB', 'Never raise a stretch more than this.'],
    ['gate', 'Word gate', 'dB', 'Words = within this many dB of the stretch’s speech level.'],
    ['word_floor', 'Word floor', 'dB', 'Words must also be this far above the stretch’s gaps, so debleed residue isn’t raised.'],
    ['ceiling', 'Peak ceiling', 'dBFS', 'Raised peaks stay below this.'],
    ['release', 'Limiter release', 'ms', 'Release time of the limiter on raised words.'],
  ] },
  { group: 'Speakers', items: [
    ['removed', 'Debleed threshold', 'dB', 'If debleed removed more than this, the moment is bleed.'],
  ] },
];
const EDITOR_NAMES = { audition: 'Audition', rx: 'iZotope RX' };

const ICONS = {
  wave: '<path d="M3 12h2M7 8v8M11 5v14M15 9v6M19 11v2M21 12h0"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  swap: '<path d="M7 7h11l-3-3M17 17H6l3 3"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  phones: '<path d="M4 15v-3a8 8 0 0 1 16 0v3"/><rect x="3" y="14" width="4" height="6" rx="1.5"/><rect x="17" y="14" width="4" height="6" rx="1.5"/>',
  check: '<path d="m5 12 5 5 9-10"/>',
  alert: '<path d="M12 8v5M12 16.5v.5"/><circle cx="12" cy="12" r="9"/>',
  info: '<path d="M12 11v5M12 7.5v.5"/><circle cx="12" cy="12" r="9"/>',
};
const svg = (name) => `<svg viewBox="0 0 24 24">${ICONS[name]}</svg>`;

const S = {
  files: { input: '', original: '', other: '' },
  meta: {},
  output: '',
  defaults: {},
  analysis: null,
  skipped: new Set(),
  sel: -1,
  stale: false,
  detected: {},
  rendered: null, // { output, skips, markedInput } from the last render
  inputMarks: null, // skipKey() the debleed track's markers were last written with
  busy: false,
  started: false,
};
// Saved choices (editor, paths, markers switch, detection options) live in PostPilot's settings.
const prefs = () => settings.quietLift;
let optionsTimer;
function savePrefs(patch, delay = 0) {
  Object.assign(settings.quietLift, patch);   // seen straight away; written below
  clearTimeout(optionsTimer);
  const write = () => save((s) => Object.assign(s.quietLift, structuredClone(patch)));
  if (delay) optionsTimer = setTimeout(write, delay); else write();
}
// After Render: into Resolve (electron/toresolve.js). Its own settings block.
const resolvePrefs = () => settings.toResolve;
function saveResolvePrefs(patch) {
  Object.assign(settings.toResolve, patch);
  save((s) => Object.assign(s.toResolve, patch));
}

// ---------- bridge to the Python engine ----------
async function engine(cmd, payload) {
  const r = await pilot.quietLift('call', { cmd, payload });
  if (!r.ok) throw new Error(r.error);
  return r.data;
}
const pick = async (action, current) => (await pilot.quietLift(action, { current })).path || null;
const exists = (p) => pilot.checkPath(p);

// ---------- helpers ----------
const hms = (s) => {
  const r = Math.round(s);
  s = Math.abs(s % 1) === 0.5 && r % 2 ? r - 1 : r; // round half to even, like quiet_lift.py's hms()
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
const base = (p) => p.split(/[\\/]/).pop();
const dir = (p) => p.slice(0, Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/')));
const join = (folder, name) => folder + (folder.includes('\\') ? '\\' : '/') + name;
const fmtSize = (b) => (b > 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${(b / 1e6).toFixed(0)} MB`);
// same names quiet_lift_bridge.py writes into the WAV files
const markerId = (i) => `QL${String(i + 1).padStart(2, '0')}`;
const markerName = (i) => `${markerId(i)} ${S.skipped.has(i) ? 'skipped' : `+${S.analysis.stretches[i].gain.toFixed(1)} dB`}`;
const skipKey = () => [...S.skipped].sort((x, y) => x - y).join(',');
const toast = showToast;

function log(msg) {
  const el = $('ql-log');
  el.textContent += (el.textContent ? '\n' : '') + msg;
  el.scrollTop = el.scrollHeight;
  $('ql-activity-last').textContent = msg.split('\n')[0];
}

// ---------- files ----------
function renderFiles() {
  const box = $('ql-files');
  box.innerHTML = '';
  for (const r of ROLES) {
    const p = S.files[r.key];
    const m = S.meta[r.key];
    const card = document.createElement('div');
    card.className = `file ${p ? 'filled' : 'empty'}`;
    card.dataset.role = r.key;
    let body;
    if (p) {
      const chips = [];
      if (m) {
        chips.push(`<span class="chip">${hms(m.duration)}</span>`, `<span class="chip">${m.samplerate / 1000} kHz</span>`,
          `<span class="chip">${m.subtype}</span>`, `<span class="chip">${fmtSize(m.size)}</span>`);
        const ref = S.meta.input;
        if (r.key !== 'input' && ref) {
          const d = Math.abs(m.duration - ref.duration);
          chips.push(m.samplerate !== ref.samplerate ? '<span class="chip warn">Sample rate differs</span>'
            : d < 0.1 ? '<span class="chip ok">Lined up</span>' : `<span class="chip warn">${d.toFixed(1)} s longer/shorter</span>`);
        }
      }
      body = `<div class="file-name" title="${esc(p)}"><bdi dir="ltr">${esc(base(p))}</bdi></div><div class="file-meta">${chips.join('')}</div>`;
    } else {
      body = `<div class="drop-cta">Drop a WAV here or <b>browse</b></div>`;
    }
    card.innerHTML = `
      <div class="file-top">
        <div class="file-icon">${svg(r.icon)}</div>
        <div><div class="file-role">${r.title}</div><div class="file-hint">${r.hint}</div></div>
        ${p ? `<div class="file-actions"><button data-act="change" title="Replace">${svg('swap')}</button><button data-act="clear" title="Remove">${svg('x')}</button></div>` : ''}
      </div>${body}`;
    card.addEventListener('click', async (e) => {
      const act = e.target.closest('button')?.dataset.act;
      if (act === 'clear') return setFile(r.key, '');
      if (act === 'change' || !p) {
        const picked = await pick('pick-wav', p || (S.files.input ? dir(S.files.input) : prefs().dir));
        if (picked) setFile(r.key, picked);
      }
    });
    card.addEventListener('dragover', (e) => { e.preventDefault(); card.classList.add('drag'); });
    card.addEventListener('dragleave', () => card.classList.remove('drag'));
    card.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      card.classList.remove('drag');
      const f = e.dataTransfer.files[0];
      if (f) setFile(r.key, pilot.pathForFile(f));
    });
    box.appendChild(card);
  }
}

async function setFile(role, p) {
  S.files[role] = p;
  delete S.meta[role];
  if (S.analysis) markStale();
  if (p) {
    savePrefs({ dir: dir(p) });
    try { S.meta[role] = await engine('probe', { path: p }); } catch (e) { toast('Can’t read that file', e.message, 'err'); }
    if (role === 'input') await guessCompanions(p);
  }
  renderFiles();
  updateButtons();
}

// "Talk-02 (fc-cleaned).wav" (saved by Feedback Cutter) -> "Talk-02"
const recordingName = (p) => base(p).replace(/\.wav$/i, '').replace(/ \(fc-cleaned\)( \d+)?$/i, '');

// 260910_0084-1-debleed.wav -> original 260910_0084-1.wav, other mic 260910_0084-2.wav
async function guessCompanions(p) {
  const folder = dir(p);
  const stem = recordingName(p).replace(/[-_ ]?debleed$/i, '');
  const filled = [];
  const orig = join(folder, `${stem}.wav`);
  if (!S.files.original && orig.toLowerCase() !== p.toLowerCase() && (await exists(orig))) {
    S.files.original = orig;
    S.meta.original = await engine('probe', { path: orig }).catch(() => undefined);
    filled.push('original');
  }
  const m = stem.match(/^(.*[-_])(\d+)$/);
  if (!S.files.other && m) {
    for (const k of ['2', '1', '3', '4']) {
      const cand = join(folder, `${m[1]}${k}.wav`);
      if (k !== m[2] && (await exists(cand))) {
        S.files.other = cand;
        S.meta.other = await engine('probe', { path: cand }).catch(() => undefined);
        filled.push('other mic');
        break;
      }
    }
  }
  let out = join(folder, `${stem}-lifted.wav`);
  for (let i = 2; await exists(out); i++) out = join(folder, `${stem}-lifted-${i}.wav`);
  setOutput(out);
  if (filled.length) toast('Matched companion files', `Found the ${filled.join(' and ')} next to the debleed track.`, 'ok');
}

function setOutput(p) {
  S.output = p;
  $('ql-output-text').innerHTML = p ? `<bdi dir="ltr">${esc(p)}</bdi>` : 'Choose where to save';
  $('ql-output-field').title = p;
}

// ---------- settings drawer ----------
function options() { return prefs().options || {}; }
function renderSettings() {
  const body = $('ql-settings-body');
  body.innerHTML = SETTINGS.map((g) => `
    <div class="set-group"><div class="set-group-title">${g.group}</div>
      ${g.items.map(([k, label, unit, help]) => `
        <div class="set" data-key="${k}">
          <label for="ql-opt-${k}">${label}</label>
          <div class="num-input"><input id="ql-opt-${k}" data-key="${k}" inputmode="decimal" placeholder="off"><em>${unit}</em></div>
          <p>${help}</p>
        </div>`).join('')}
    </div>`).join('');
  for (const inp of body.querySelectorAll('input')) {
    const k = inp.dataset.key;
    const v = options()[k] ?? S.defaults[k];
    inp.value = v ?? '';
    inp.addEventListener('input', () => {
      const raw = inp.value.trim();
      if (raw === '' || !Number.isNaN(Number(raw))) {
        savePrefs({ options: { ...options(), [k]: raw === '' ? null : Number(raw) } }, 500);
        if (S.analysis) markStale();
      }
      markChanged();
    });
  }
  $('ql-python').value = prefs().python || '';
  markChanged();
}
function markChanged() {
  for (const row of $('ql-settings-body').querySelectorAll('.set')) {
    const k = row.dataset.key;
    const v = options()[k] === undefined ? S.defaults[k] : options()[k];
    row.classList.toggle('changed', (v ?? null) !== (S.defaults[k] ?? null));
  }
}
function openDrawer(open) {
  $('ql-drawer').classList.toggle('open', open);
  $('ql-scrim').hidden = !open;
}

// ---------- engine ----------
async function startEngine() {
  $('ql-engine-dot').className = 'dot';
  $('ql-engine').textContent = 'Starting engine…';
  try {
    S.defaults = await engine('defaults');
    S.detected = await engine('editors');
    $('ql-engine-dot').className = 'dot ok';
    $('ql-engine').textContent = 'Engine ready';
  } catch (e) {
    $('ql-engine-dot').className = 'dot err';
    $('ql-engine').textContent = 'Engine offline';
    toast('Quiet Lift engine didn’t start', `${e.message}\nIf a Python is set in the settings, it needs numpy + soundfile; blank uses the built-in engine.`, 'err');
  }
  renderSettings();
  renderEditor();
}

// ---------- analyze ----------
async function analyze() {
  if (S.busy) return;
  if (!S.files.input) return toast('Pick the debleed track first', '', 'warn');
  if (!S.files.original || !S.files.other) {
    toast('Running without all three files', 'Most accurate mode needs the original and the other mic too.', 'warn');
  }
  setBusy(true);
  $('ql-tl-busy').hidden = false;
  $('ql-tl-empty').hidden = true;
  const opts = {};
  for (const [k, v] of Object.entries(options())) if (v !== null && v !== undefined) opts[k] = v;
  if (options().floor === undefined && S.defaults.floor != null) opts.floor = S.defaults.floor;
  log(`— Analyze ${base(S.files.input)}`);
  try {
    const a = await engine('analyze', { input: S.files.input, original: S.files.original, other: S.files.other, options: opts });
    S.analysis = a;
    S.skipped = new Set(a.skipped);
    S.sel = a.stretches.length ? 0 : -1;
    S.stale = false;
    S.rendered = null;
    S.inputMarks = null;
    toast(`${a.stretches.length} quiet stretch${a.stretches.length === 1 ? '' : 'es'} found`,
      a.skipped.length ? `${a.skipped.length} skip(s) restored from last time.` : 'Double-click one to open it in your editor.', 'ok');
  } catch (e) {
    toast('Analysis failed', e.message, 'err');
    log(`ERROR: ${e.message}`);
  } finally {
    $('ql-tl-busy').hidden = true;
    setBusy(false);
    renderResults();
  }
}

function markStale() {
  if (S.stale) return;
  S.stale = true;
  renderResults();
}

function setBusy(b) {
  S.busy = b;
  const btn = $('ql-btn-analyze');
  btn.classList.toggle('loading', b);
  btn.querySelector('span').textContent = b ? 'Analyzing…' : S.analysis ? 'Re-analyze' : 'Analyze';
  updateButtons();
}

function updateButtons() {
  $('ql-btn-analyze').disabled = S.busy || !S.files.input;
  $('ql-btn-render').disabled = S.busy || !S.analysis || !S.output;
}

// ---------- results ----------
function renderResults() {
  const a = S.analysis;
  $('ql-tl-empty').hidden = !!a || !$('ql-tl-busy').hidden;
  const stats = $('ql-stats');
  if (!a) {
    stats.hidden = true;
    renderList();
    drawTimeline();
    return;
  }
  const lifted = a.stretches.filter((_, i) => !S.skipped.has(i));
  const liftedSec = lifted.reduce((t, s) => t + s.end - s.start, 0);
  stats.hidden = false;
  stats.innerHTML = `
    <div class="stat"><div class="stat-label">Typical speech</div><div class="stat-value">${a.ref.toFixed(1)}<small>dB</small></div></div>
    <div class="stat"><div class="stat-label">Quiet band</div><div class="stat-value">${a.lo.toFixed(0)} … ${a.hi.toFixed(0)}<small>dB</small></div></div>
    <div class="stat"><div class="stat-label">Stretches to lift</div><div class="stat-value grad">${lifted.length}<small>of ${a.stretches.length}</small></div></div>
    <div class="stat"><div class="stat-label">Time being lifted</div><div class="stat-value">${liftedSec >= 60 ? `${(liftedSec / 60).toFixed(1)}<small>min</small>` : `${liftedSec.toFixed(0)}<small>s</small>`}</div></div>`;
  $('ql-timeline-sub').textContent = `${hms(a.duration)} take · reference ${a.ref.toFixed(1)} dB`;
  renderList();
  drawTimeline();
}

function renderMarkerStatus() {
  const a = S.analysis;
  const pill = $('ql-marker-status');
  pill.hidden = !a || !a.stretches.length;
  if (pill.hidden) return;
  const r = S.rendered;
  let cls = '';
  let text;
  const n = `${a.stretches.length} marker${a.stretches.length === 1 ? '' : 's'}`;
  if (r && r.skips !== skipKey()) {
    cls = 'warn';
    text = `${svg('alert')}Skips changed since render. Render again to update markers`;
  } else if (r) {
    cls = 'ok';
    text = `${svg('check')}${n} in ${r.markedInput ? 'debleed + lifted' : 'lifted file'}`;
  } else if (S.inputMarks !== null && S.inputMarks !== skipKey()) {
    cls = 'warn';
    text = `${svg('alert')}Skips changed. Click Open again to update the debleed markers`;
  } else if (S.inputMarks !== null) {
    cls = 'ok';
    text = `${svg('check')}${n} in debleed track`;
  } else if (a.marked) {
    text = `${svg('info')}Debleed has ${a.marked} QL marker${a.marked === 1 ? '' : 's'} from earlier`;
  } else {
    text = `${svg('info')}${prefs().markInput ? 'Markers are added when you open or render' : 'Markers are added to the lifted file on render'}`;
  }
  pill.className = `marker-pill ${cls}`;
  pill.innerHTML = text;
}

function renderList() {
  const a = S.analysis;
  const list = $('ql-list');
  const sub = $('ql-list-sub');
  sub.style.color = S.stale ? 'var(--warn)' : '';
  sub.textContent = S.stale ? 'Files or settings changed: re-analyze to update this list'
    : a ? `${a.stretches.length - S.skipped.size} lifted · ${S.skipped.size} skipped` : 'Each stretch gets lifted unless you skip it';
  renderMarkerStatus();
  if (!a || !a.stretches.length) {
    list.innerHTML = `<div class="list-empty">${a ? 'No quiet stretches in this take: nothing will be changed.' : 'Stretches show up here after you analyze.'}</div>`;
    return;
  }
  const maxGain = Math.max(...a.stretches.map((s) => s.gain), 1);
  list.innerHTML = a.stretches.map((s, i) => {
    const sk = S.skipped.has(i);
    return `<div class="ql-row${i === S.sel ? ' sel' : ''}${sk ? ' skipped' : ''}" data-i="${i}" title="Marker: ${esc(markerName(i))}">
      <span class="idx">${markerId(i)}</span>
      <span class="time"><span>${hms(s.start)}</span><i>→</i><span>${hms(s.end)}</span></span>
      <span class="num">${(s.end - s.start).toFixed(0)} <small>s</small></span>
      <span class="num">${s.speech.toFixed(1)} <small>dB</small></span>
      <span class="num">${s.gaps.toFixed(1)} <small>dB</small></span>
      <span class="gain"><span class="gain-track"><span class="gain-fill" style="width:${(s.gain / maxGain) * 100}%"></span></span><span class="gain-val">+${s.gain.toFixed(1)} dB</span></span>
      <span><button class="listen-btn" data-act="listen">${svg('phones')}Open</button></span>
      <span><button class="toggle" data-act="skip"><span class="track"></span>${sk ? 'Skipped' : 'Lift'}</button></span>
    </div>`;
  }).join('');
}

function select(i, scroll = true) {
  if (!S.analysis || i < 0 || i >= S.analysis.stretches.length) return;
  S.sel = i;
  for (const r of $('ql-list').querySelectorAll('.ql-row')) r.classList.toggle('sel', Number(r.dataset.i) === i);
  if (scroll) $('ql-list').querySelector(`.ql-row[data-i="${i}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  drawTimeline();
}

async function toggleSkip(i) {
  if (!S.analysis || i < 0) return;
  S.skipped.has(i) ? S.skipped.delete(i) : S.skipped.add(i);
  renderResults();
  try { await engine('skips', { skipped: [...S.skipped] }); } catch (e) { toast('Couldn’t save skips', e.message, 'warn'); }
}

const editorPath = () => (prefs().editorPaths || {})[prefs().editor] || S.detected[prefs().editor];

async function listen(i) {
  const a = S.analysis;
  if (!a || i < 0) return;
  const editor = prefs().editor;
  const exe = editorPath();
  if (!exe) return toast(`${EDITOR_NAMES[editor]} not found`, 'Click the editor status in the bottom bar to choose its .exe.', 'warn');
  select(i, false);
  const btn = $('ql-list').querySelector(`.ql-row[data-i="${i}"] .listen-btn`);
  btn?.classList.add('working');
  try {
    const lifted = S.rendered?.output;
    const r = await engine('open', { editor_path: exe, lifted, skipped: [...S.skipped], mark_input: prefs().markInput });
    a.marked = r.marked;
    if (prefs().markInput && !r.marker_error) S.inputMarks = skipKey();
    renderMarkerStatus();
    const where = `${markerId(i)} at ${hms(a.stretches[i].start)}`;
    if (r.marker_error) {
      toast('Markers not updated', `${r.marker_error}. The file opened without the latest markers.`, 'warn');
    } else {
      toast(`Opened in ${EDITOR_NAMES[editor]}`, (r.files.length > 1
        ? `Debleed + lifted are both open. Jump to marker ${where} in each to compare.`
        : `Jump to marker ${where}. Render to open the lifted file alongside.`) +
        (prefs().markInput ? '\nIf the file was already open there, close it in the editor and click Open again to load the markers.' : ''), 'ok');
    }
  } catch (e) {
    toast('Couldn’t open the editor', e.message, 'err');
  } finally {
    btn?.classList.remove('working');
  }
}

// ---------- timeline ----------
const TL = { pad: { t: 12, b: 22 }, hit: [] };

function tlGeom() {
  const a = S.analysis;
  const cv = $('ql-canvas');
  const W = cv.clientWidth;
  const H = cv.clientHeight;
  const sorted = a.levels.filter((v) => v > -150).sort((x, y) => x - y);
  const p99 = sorted.length ? sorted[Math.floor(sorted.length * 0.995)] : a.ref;
  const yMax = Math.max(a.ref + 6, p99 + 2);
  const yMin = a.lo - 8;
  const x = (t) => (t / a.duration) * W;
  const y = (db) => TL.pad.t + (1 - (Math.min(Math.max(db, yMin), yMax) - yMin) / (yMax - yMin)) * (H - TL.pad.t - TL.pad.b);
  return { cv, W, H, x, y, yMin, yMax };
}

function drawTimeline() {
  const cv = $('ql-canvas');
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth;
  const H = cv.clientHeight;
  cv.width = W * dpr;
  cv.height = H * dpr;
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  const a = S.analysis;
  if (!a || !W) return;
  const { x, y, yMin } = tlGeom();
  const plotB = H - TL.pad.b;

  // quiet band + reference line
  g.fillStyle = 'rgba(47, 213, 240, 0.07)';
  g.fillRect(0, y(a.hi), W, y(a.lo) - y(a.hi));
  g.setLineDash([4, 4]);
  g.lineWidth = 1;
  g.strokeStyle = 'rgba(47, 213, 240, 0.35)';
  for (const v of [a.lo, a.hi]) { g.beginPath(); g.moveTo(0, y(v) + 0.5); g.lineTo(W, y(v) + 0.5); g.stroke(); }
  g.strokeStyle = 'rgba(255, 255, 255, 0.18)';
  g.beginPath(); g.moveTo(0, y(a.ref) + 0.5); g.lineTo(W, y(a.ref) + 0.5); g.stroke();
  g.setLineDash([]);

  // stretches
  TL.hit = [];
  a.stretches.forEach((s, i) => {
    let x0 = x(s.start);
    let x1 = x(s.end);
    if (x1 - x0 < 4) { const c = (x0 + x1) / 2; x0 = c - 2; x1 = c + 2; }
    TL.hit.push([Math.min(x0, (x0 + x1) / 2 - 4), Math.max(x1, (x0 + x1) / 2 + 4), i]);
    const sk = S.skipped.has(i);
    const sel = i === S.sel;
    const col = sk ? '255, 107, 138' : '52, 224, 184';
    g.fillStyle = `rgba(${col}, ${sel ? 0.3 : 0.14})`;
    g.fillRect(x0, 0, x1 - x0, plotB);
    g.fillStyle = `rgba(${col}, ${sel ? 1 : 0.85})`;
    g.fillRect(x0, 0, x1 - x0, 3);
    if (sel) { g.strokeStyle = `rgba(${col}, 0.9)`; g.lineWidth = 1; g.strokeRect(x0 + 0.5, 0.5, x1 - x0 - 1, plotB - 1); }
  });

  // level envelope: max per pixel column
  const n = a.levels.length;
  const cols = Math.max(1, Math.floor(W));
  const pts = new Array(cols);
  for (let c = 0; c < cols; c++) {
    const i0 = Math.floor((c / cols) * n);
    const i1 = Math.max(i0 + 1, Math.floor(((c + 1) / cols) * n));
    let m = -Infinity;
    for (let i = i0; i < i1 && i < n; i++) if (a.levels[i] > m) m = a.levels[i];
    pts[c] = y(Math.max(m, yMin));
  }
  const grad = g.createLinearGradient(0, TL.pad.t, 0, plotB);
  grad.addColorStop(0, 'rgba(139, 108, 255, 0.55)');
  grad.addColorStop(1, 'rgba(91, 140, 255, 0.02)');
  g.beginPath();
  g.moveTo(0, plotB);
  pts.forEach((py, c) => g.lineTo(c + 0.5, py));
  g.lineTo(W, plotB);
  g.closePath();
  g.fillStyle = grad;
  g.fill();
  g.beginPath();
  pts.forEach((py, c) => (c ? g.lineTo(c + 0.5, py) : g.moveTo(0, py)));
  g.strokeStyle = 'rgba(178, 160, 255, 0.95)';
  g.lineWidth = 1.2;
  g.stroke();

  // marker flags (QL01 ...), skipping any that would overlap the previous one
  g.font = '600 10px "Cascadia Mono", Consolas, monospace';
  g.textBaseline = 'middle';
  let lastEnd = -Infinity;
  for (const [x0, , i] of TL.hit) {
    const label = markerId(i);
    const w = g.measureText(label).width + 10;
    const lx = Math.min(Math.max(x0, 2), W - w - 2);
    if (lx < lastEnd + 4 && i !== S.sel) continue;
    lastEnd = lx + w;
    const col = S.skipped.has(i) ? '255, 107, 138' : '52, 224, 184';
    g.fillStyle = `rgba(${col}, ${i === S.sel ? 0.95 : 0.22})`;
    g.beginPath();
    g.roundRect(lx, 7, w, 16, 4);
    g.fill();
    g.fillStyle = i === S.sel ? '#0b0d12' : `rgb(${col})`;
    g.fillText(label, lx + 5, 15.5);
  }

  // axis
  g.fillStyle = 'rgba(255, 255, 255, 0.04)';
  g.fillRect(0, plotB, W, TL.pad.b);
  const steps = [15, 30, 60, 120, 300, 600, 900, 1800, 3600];
  const step = steps.find((s) => a.duration / s <= W / 90) || 3600;
  g.font = '10.5px "Cascadia Mono", Consolas, monospace';
  g.fillStyle = 'rgba(170, 178, 195, 0.75)';
  g.textBaseline = 'middle';
  for (let t = 0; t <= a.duration; t += step) {
    const px = x(t);
    g.fillRect(px, plotB, 1, 4);
    const label = hms(t);
    const tw = g.measureText(label).width;
    g.fillText(label, Math.min(Math.max(px - tw / 2, 4), W - tw - 4), plotB + 13);
  }
  g.fillStyle = 'rgba(255, 255, 255, 0.45)';
  g.textBaseline = 'bottom';
  g.fillText(`typical ${a.ref.toFixed(0)} dB`, 8, y(a.ref) - 3);
  g.fillStyle = 'rgba(47, 213, 240, 0.7)';
  g.fillText('quiet band', 8, y(a.lo) - 3);
}

function tlHit(px) {
  return TL.hit.find(([x0, x1]) => px >= x0 && px <= x1)?.[2] ?? -1;
}

function bindTimeline() {
  const cv = $('ql-canvas');
  cv.addEventListener('mousemove', (e) => {
    const a = S.analysis;
    if (!a) return;
    const r = cv.getBoundingClientRect();
    const px = e.clientX - r.left;
    const t = Math.max(0, Math.min(a.duration, (px / r.width) * a.duration));
    const lvl = a.levels[Math.min(a.levels.length - 1, Math.floor(t / a.step))];
    const i = tlHit(px);
    const cur = $('ql-cursor');
    const tip = $('ql-tip');
    cur.hidden = tip.hidden = false;
    cur.style.left = `${px}px`;
    tip.innerHTML = `<b>${hms(t)}</b> · ${lvl > -150 ? `${lvl.toFixed(1)} dB` : 'no speech'}` +
      (i >= 0 ? ` · ${markerId(i)} ${S.skipped.has(i) ? 'skipped' : `+${a.stretches[i].gain.toFixed(1)} dB`}` : '');
    const tw = tip.offsetWidth;
    tip.style.left = `${Math.min(Math.max(px + 12, 8), r.width - tw - 8)}px`;
    cv.style.cursor = i >= 0 ? 'pointer' : 'crosshair';
  });
  cv.addEventListener('mouseleave', () => { $('ql-cursor').hidden = $('ql-tip').hidden = true; });
  cv.addEventListener('click', (e) => {
    const i = tlHit(e.clientX - cv.getBoundingClientRect().left);
    if (i >= 0) select(i);
  });
  cv.addEventListener('dblclick', (e) => {
    const i = tlHit(e.clientX - cv.getBoundingClientRect().left);
    if (i >= 0) listen(i);
  });
  new ResizeObserver(() => drawTimeline()).observe(cv);
}

// ---------- editor / markers / output ----------
function renderEditor() {
  const editor = prefs().editor;
  for (const b of $('ql-editor-seg').querySelectorAll('button')) b.classList.toggle('on', b.dataset.editor === editor);
  const p = editorPath();
  const st = $('ql-editor-status');
  st.classList.toggle('bad', !p);
  st.innerHTML = p ? `${svg('check')}Found` : `${svg('alert')}Set path…`;
  st.title = p ? `${p}\n\nClick to choose a different .exe` : 'Choose the editor’s .exe';
}

function renderMarkSwitch() {
  const on = prefs().markInput;
  $('ql-mark-input').classList.toggle('on', on);
  $('ql-mark-input').lastElementChild.textContent = on ? 'Debleed + lifted' : 'Lifted only';
  renderMarkerStatus();
}

async function render() {
  const a = S.analysis;
  if (!a || S.busy) return;
  if (await exists(S.output)) {
    toast('Output already exists', `${base(S.output)} was not overwritten. Choose a new name.`, 'warn');
    const p = await pick('save-wav', S.output);
    if (!p) return;
    setOutput(p);
  }
  S.busy = true;
  updateButtons();
  const btn = $('ql-btn-render');
  btn.classList.add('loading');
  btn.querySelector('span').textContent = 'Rendering…';
  try {
    const r = await engine('render', { output: S.output, skipped: [...S.skipped], mark_input: prefs().markInput });
    S.rendered = { output: r.output, skips: skipKey(), markedInput: r.marked_input };
    if (r.marked_input) S.inputMarks = skipKey();
    if (r.marked_input) a.marked = r.markers;
    toast('Render complete', `${base(r.output)}: ${a.stretches.length - S.skipped.size} stretch(es) lifted, the rest is bit-for-bit.` +
      ` ${r.markers} QL marker(s) added to ${r.marked_input ? 'both files' : 'the lifted file'}.`, 'ok',
      { label: 'Show in folder', run: () => pilot.quietLift('reveal', { path: r.output }) });
    for (const msg of Object.values(r.marker_errors)) toast('Markers not added', msg, 'warn');
    renderMarkerStatus();
    if (resolvePrefs().enabled) await toResolve(r.output, btn);
    offerNext();
  } catch (e) {
    toast('Render failed', e.message, 'err');
  } finally {
    btn.classList.remove('loading');
    btn.querySelector('span').textContent = 'Render';
    S.busy = false;
    updateButtons();
  }
}

// The last step of the chain: the lifted file into a Resolve bin and timeline, then the Fairlight page.
async function toResolve(file, btn) {
  btn.querySelector('span').textContent = 'Sending to Resolve…';
  log('Sending to Resolve…');
  const r = await pilot.quietLift('to-resolve', { path: file, name: recordingName(S.files.input) });
  if (!r.ok) return toast('Not sent to Resolve', r.error, 'err');
  const done = (r.normalized !== null ? ` Normalized to ${r.normalized} dBFS.` : '') +
    (r.isolationTrack ? ` Voice Isolation ${resolvePrefs().isolation} on A${r.isolationTrack}.` : '');
  const where = `timeline "${r.timeline}"${r.track ? `, track A${r.track}` : ''}`;
  log(`In Resolve: ${base(r.file)} in bin "${r.bin}", ${where}.${done}`);
  toast('In Resolve', `${base(r.file)} is in bin "${r.bin}" and on ${where}.${done}`, 'ok');
  if (r.warning) toast('Not all done in Resolve', r.warning, 'warn');
}

// "-6.3" -> -6.3, blank -> null (off); outside lo..hi -> undefined (not taken)
function numberOrOff(v, lo, hi) {
  if (v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= lo && n <= hi ? n : undefined;
}

function renderResolveSwitch() {
  const on = resolvePrefs().enabled;
  $('ql-to-resolve').classList.toggle('on', on);
  $('ql-to-resolve').lastElementChild.textContent = on ? 'Send to Resolve' : 'Off';
  $('ql-res-bin').value = resolvePrefs().bin;
  $('ql-res-timeline').value = resolvePrefs().timeline;
  $('ql-res-normalize').value = resolvePrefs().normalize ?? '';
  $('ql-res-isolation').value = resolvePrefs().isolation ?? '';
}

// Project files: the open Resolve project's recordings, here their cleaned versions (renderer/projectfiles.js)
let listFile = '';
function openListed(row) {
  const file = pf.fileOf(row);
  if (!row.cleaned) toast('Not cleaned yet', `${row.name} has no Feedback Cutter save, so the recording itself is loaded.`, 'warn');
  listFile = file;
  window.qlTakeFile(file);
}
// after a Project files recording is rendered: the next one
function offerNext() {
  if (!listFile || listFile.toLowerCase() !== (S.files.input || '').toLowerCase()) return;
  const next = pf.next(listFile);
  pf.refresh();
  if (next) toast('Next in the project', next.name, 'ok', { label: `Open ${next.name}`, run: () => openListed(next) });
}

// Feedback Cutter's "Cleaned WAV…" hands its file over: a new debleed track, nothing kept from the last one.
window.qlTakeFile = (p) => {
  if (S.busy) return toast('Quiet Lift is busy', `Load ${base(p)} once it has finished.`, 'warn');
  S.files.original = '';
  S.files.other = '';
  S.meta = {};
  S.analysis = null;
  S.rendered = null;
  S.skipped = new Set();
  renderResults();
  setFile('input', p);
};

// ---------- wiring ----------
function bind() {
  $('ql-btn-analyze').onclick = analyze;
  $('ql-btn-render').onclick = render;
  $('ql-btn-settings').onclick = () => openDrawer(true);
  $('ql-drawer-close').onclick = $('ql-settings-done').onclick = $('ql-scrim').onclick = () => openDrawer(false);
  $('ql-settings-reset').onclick = () => {
    savePrefs({ options: {} });
    if (S.analysis) markStale();
    renderSettings();
  };
  $('ql-python').onchange = async () => {
    savePrefs({ python: $('ql-python').value.trim() });   // the main process restarts the engine
    await startEngine();
  };
  $('ql-activity-toggle').onclick = () => {
    const open = $('ql-log').hidden;
    $('ql-log').hidden = !open;
    $('ql-activity-toggle').parentElement.classList.toggle('open', open);
  };
  $('ql-editor-seg').onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    savePrefs({ editor: b.dataset.editor });
    renderEditor();
  };
  $('ql-editor-status').onclick = async () => {
    const p = await pick('pick-exe');
    if (!p) return;
    savePrefs({ editorPaths: { ...prefs().editorPaths, [prefs().editor]: p } });
    renderEditor();
  };
  $('ql-mark-input').onclick = () => {
    savePrefs({ markInput: !prefs().markInput });
    renderMarkSwitch();
  };
  $('ql-to-resolve').onclick = () => {
    saveResolvePrefs({ enabled: !resolvePrefs().enabled });
    renderResolveSwitch();
  };
  $('ql-res-bin').onchange = () => saveResolvePrefs({ bin: $('ql-res-bin').value.trim() || 'Audio Chain' });
  $('ql-res-timeline').onchange = () => saveResolvePrefs({ timeline: $('ql-res-timeline').value });
  for (const [id, key, lo, hi, round] of [['ql-res-normalize', 'normalize', -60, 0, false], ['ql-res-isolation', 'isolation', 0, 100, true]]) {
    $(id).onchange = () => {
      const v = numberOrOff($(id).value, lo, hi);
      if (v === undefined) toast('Not saved', `Use a number from ${lo} to ${hi}, or leave it blank for off.`, 'warn');
      else saveResolvePrefs({ [key]: round && v !== null ? Math.round(v) : v });
      renderResolveSwitch();
    };
  }
  $('ql-output-field').onclick = async () => {
    const p = await pick('save-wav', S.output || (S.files.input ? dir(S.files.input) : prefs().dir));
    if (p) { setOutput(p); updateButtons(); }
  };

  $('ql-list').addEventListener('click', (e) => {
    const row = e.target.closest('.ql-row');
    if (!row) return;
    const i = Number(row.dataset.i);
    const act = e.target.closest('button')?.dataset.act;
    if (act === 'skip') toggleSkip(i);
    else if (act === 'listen') listen(i);
    select(i, false);
  });
  $('ql-list').addEventListener('dblclick', (e) => {
    const row = e.target.closest('.ql-row');
    if (row && !e.target.closest('button')) listen(Number(row.dataset.i));
  });
  document.addEventListener('keydown', (e) => {
    if (!$('page-quietlift').classList.contains('active')) return;
    if ($('ql-drawer').classList.contains('open')) { if (e.key === 'Escape') openDrawer(false); return; }
    if (e.target.matches('input, textarea, select') || !S.analysis) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); select(Math.min(S.sel + 1, S.analysis.stretches.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); select(Math.max(S.sel - 1, 0)); }
    else if (e.key === 'Enter' && S.sel >= 0) { e.preventDefault(); listen(S.sel); }
    else if (e.key.toLowerCase() === 's' && S.sel >= 0) toggleSkip(S.sel);
  });
  pilot.onQuietLift((m) => { if (m.log) log(m.log); });
  bindTimeline();
}

bind();
renderFiles();
renderResults();
updateButtons();

// Called when the page is shown: the Python engine starts the first time.
const pf = window.projectFiles($('ql-pf'), { kind: 'ql', pick: (row) => openListed(row) });
$('ql-btn-project').onclick = () => pf.toggle();

window.qlOpen = () => {
  renderEditor();
  renderMarkSwitch();
  renderResolveSwitch();
  if (!S.started) { S.started = true; startEngine(); }
};
})();
