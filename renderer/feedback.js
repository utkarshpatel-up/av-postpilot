/* global pilot, $, esc, showToast, save, settings, go */
// Feedback Cutter page: finds feedback rings in a speech recording and notches them out.
// Ported from the Feedback Cutter app's frontend; the engine runs in Python (electron/feedbackcutter).
// Wrapped in a function so its names (render, fmt, zoom…) don't clash with the other page scripts.
(() => {
'use strict';

let RESULT = null;          // last analysis: events, spectrogram geometry, files, job
let URLS = {};              // job file name -> file:// URL
let busy = false, started = false;
let unsaved = false;        // cleaned audio not saved yet (main asks before it is thrown away)
let listFile = '';          // opened from Project files: saving stays here for the next recording
const audio = $('fc-audio');
const page = $('page-feedback');
const toast = showToast;
const prefs = () => settings.feedbackCutter;
function savePrefs(patch) {
  Object.assign(settings.feedbackCutter, patch);
  save((s) => Object.assign(s.feedbackCutter, patch));
}

// focus + playback-mode state for looping one ring
let focusedId = null, playMode = 'continuous', panMoved = false;
const PREROLL = 0.25, POSTROLL = 0.25;   // seconds of context around a looped region
// an event shows only if its band AND severity are both enabled
const bandFilter = new Set(['Low', 'Low-mid', 'Mid', 'High']);
const sevFilter = new Set(['High', 'Med', 'Low']);
// Band boundaries (Hz): Low|Low-mid, Low-mid|Mid, Mid|High. Edited with the ✎ next to "Band".
const DEFAULT_BANDS = { b1: 250, b2: 500, b3: 4000 };
function loadBands() {
  try {
    const v = JSON.parse(localStorage.getItem('fc-band-ranges'));
    if (v && +v.b1 > 0 && +v.b2 > +v.b1 && +v.b3 > +v.b2) return { b1: +v.b1, b2: +v.b2, b3: +v.b3 };
  } catch {}
  return { ...DEFAULT_BANDS };
}
let BANDS = loadBands();
const bandOf = (f) => (f < BANDS.b1 ? 'Low' : f < BANDS.b2 ? 'Low-mid' : f < BANDS.b3 ? 'Mid' : 'High');
const fmtHz = (v) => (v >= 1000 ? `${(v / 1000).toFixed(v % 1000 ? 1 : 0)} kHz` : `${v} Hz`);

// Live sensitivity (dB). The engine returns every candidate; this threshold decides which count
// as detected right now. Manual (drawn) events always count.
let SENS = 22;
const isDetected = (e) => e.manual || e.prom_db >= SENS;
const detectedEvents = () => (RESULT ? RESULT.events.filter(isDetected) : []);
// numbers 1..N for detected auto-events in time order; manual events show ✎
function assignNums() {
  let n = 0;
  for (const e of RESULT.events) e._num = (!e.manual && e.prom_db >= SENS) ? ++n : null;
}
const numOf = (e) => (e.manual ? '✎' : e._num || '');
// changing the sensitivity re-runs the auto-tick over the detected set (manual stays on)
function applyAutoSelection() {
  RESULT.events.forEach((e) => { if (!e.manual) e.selected = e.prom_db >= SENS && !!e.auto; });
}
function visibleEvents() {
  if (!RESULT) return [];
  return detectedEvents().filter((e) => e.manual || (bandFilter.has(bandOf(e.freq)) && sevFilter.has(e.severity)));
}
const evById = (id) => RESULT.events.find((e) => e.id === id);
const checkedEvents = () => RESULT.events.filter((e) => e.selected);
function fmt(t) { t = Math.max(0, t || 0); return `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`; }

// ---------- engine ----------
async function engine(cmd, payload) {
  const r = await pilot.feedback('call', { cmd, payload });
  if (!r.ok) throw new Error(r.error);
  return r.data;
}
async function startEngine() {
  $('fc-engine-dot').className = 'dot';
  $('fc-engine').textContent = 'Starting engine…';
  try {
    const c = await engine('check');
    $('fc-engine-dot').className = c.ffmpeg ? 'dot ok' : 'dot warn';
    const which = c.builtin ? 'built-in engine' : `Python: ${prefs().python || 'python'}`;
    $('fc-engine').textContent = c.ffmpeg ? `Engine ready (${which})` : `Engine ready (${which}), but FFmpeg is missing: install imageio-ffmpeg (pip) or put ffmpeg on PATH`;
  } catch (e) {
    $('fc-engine-dot').className = 'dot err';
    $('fc-engine').textContent = 'Engine offline';
    toast('Feedback Cutter engine didn’t start',
      `${e.message}\n${prefs().python ? 'Check the Python path, or clear it to use the built-in engine.' : 'Install Python with numpy, scipy, soundfile, matplotlib and imageio-ffmpeg, or set its path here.'}`, 'err');
  }
}
const specCols = () => (prefs().specDetail === 'max' ? 1000000 : 2400);
async function loadUrls(names, bust) {
  for (const name of names) {
    const r = await pilot.feedback('url', { job: RESULT.job, name });
    if (!r.ok) throw new Error(r.error);
    URLS[name] = bust ? `${r.url}?v=${bust}` : r.url;
  }
}

// ---------- open / analyze ----------
function setProgress(pct, label) {
  if (pct != null) $('fc-barfill').style.width = `${Math.max(2, Math.min(100, pct))}%`;
  if (label != null) $('fc-plabel').textContent = label;
}
function showError(msg) {
  $('fc-err').hidden = !msg;
  $('fc-err').textContent = msg ? `Error: ${msg}` : '';
}
function setUnsaved(on) {
  unsaved = on;
  $('fc-save-state').textContent = on ? 'Not saved yet' : 'Saved';
  $('fc-save-state').className = on ? 'small warn-text' : 'small muted';
  pilot.feedback('unsaved', { unsaved: on ? { job: RESULT.job, name: RESULT.files.cleaned, source: RESULT.path } : null });
}
async function analyze(path) {
  if (busy || !path) return;
  if (unsaved && !(await pilot.feedback('confirm-discard')).go) return;
  unsaved = false;
  busy = true;
  savePrefs({ dir: path.replace(/[\\/][^\\/]*$/, '') });
  showError('');
  audio.pause();
  $('fc-results').hidden = true;
  $('fc-progress').hidden = false;
  setProgress(2, 'Starting…');
  try {
    const r = await engine('analyze', { path, sensitivity_db: +$('fc-sens').value, max_spec_cols: specCols() });
    RESULT = r;
    URLS = {};
    const f = r.files;
    await loadUrls([f.spec_before, f.spec_after, f.original_preview, f.cleaned_preview, f.removed_preview], Date.now());
    setProgress(100, 'Done');
    render();
    setUnsaved(true);
  } catch (e) {
    showError(e.message);
  } finally {
    $('fc-progress').hidden = true;
    busy = false;
  }
}
pilot.onFeedback(({ log: msg, pct, saved }) => {
  if (saved) setUnsaved(false);   // saved here or from the quit question
  else if (busy) setProgress(pct, msg);
});

// ---------- render ----------
function render() {
  const R = RESULT;
  focusedId = null;
  SENS = R.sensitivity != null ? R.sensitivity : +$('fc-sens').value;
  $('fc-sens').value = SENS;
  $('fc-sensval').textContent = `${SENS} dB`;
  assignNums();
  clearStale();
  $('fc-fname').textContent = R.filename;
  $('fc-fname').title = R.path;
  $('fc-fmeta').textContent = `${fmt(R.duration)} · ${R.channels}ch · ${(R.sr / 1000) | 0}k`;
  const img = $('fc-spec-before');
  setZoom(1);
  img.onload = () => { fitHeight(); renderBoxes(); renderMarks(); positionPlayhead(); drawAxes(); };
  img.src = URLS[R.files.spec_before];
  $('fc-spec-after').src = URLS[R.files.spec_after];
  renderList();
  $('fc-check-all').checked = false;
  renderBoxes(); renderMarks(); updateSummary();
  page.querySelectorAll('#fc-toggle button').forEach((x) => x.classList.toggle('active', x.dataset.src === 'original'));
  audio.currentTime = 0;
  loadSrc('original');
  $('fc-results').hidden = false;
}

function updateFilterCounts() {
  const auto = detectedEvents().filter((e) => !e.manual);   // counts follow the sensitivity
  page.querySelectorAll('#fc-filters .chip').forEach((chip) => {
    const c = chip.querySelector('.cnt');
    c.textContent = 'band' in chip.dataset
      ? auto.filter((e) => bandOf(e.freq) === chip.dataset.band).length
      : auto.filter((e) => e.severity === chip.dataset.sev).length;
  });
}

function renderList() {
  const list = $('fc-evlist');
  updateFilterCounts();
  if (!RESULT.events.length) { list.innerHTML = '<div class="empty">Nothing detected. Draw over any ring you hear.</div>'; syncCheckAll(); return; }
  const events = visibleEvents();
  if (!events.length) { list.innerHTML = '<div class="empty">No events match the current filters.</div>'; syncCheckAll(); return; }
  list.innerHTML = events.map((e) => (e.manual ? `
    <div class="evrow manual" data-id="${e.id}">
      <input type="checkbox" class="evchk" data-id="${e.id}" ${e.selected ? 'checked' : ''}>
      <span class="rnum" style="background:${evColor(e)}">✎</span>
      <span><span class="rfreq">${Math.round(e.freq_lo)}–${Math.round(e.freq_hi)} Hz</span> <span class="rtime">${fmt(e.t_start)}–${fmt(e.t_end)}</span></span>
      <span class="pill Manual" title="Remove this region">drawn ✕</span>
    </div>` : `
    <div class="evrow" data-id="${e.id}">
      <input type="checkbox" class="evchk" data-id="${e.id}" ${e.selected ? 'checked' : ''}>
      <span class="rnum" style="background:${evColor(e)}">${numOf(e)}</span>
      <span><span class="rfreq">${e.freq} Hz</span> <span class="rtime">${fmt(e.t_start)} · ${e.duration}s · ${e.prom_db}dB</span></span>
      <span class="pill ${esc(e.severity)}">${esc(e.severity)}</span>
    </div>`)).join('');
  list.querySelectorAll('.evrow').forEach((row) => {
    const id = +row.dataset.id;
    if (id === focusedId) row.classList.add('focus');
    row.addEventListener('mouseenter', () => highlight(id, true));
    row.addEventListener('mouseleave', () => highlight(id, false));
    row.addEventListener('click', (e) => {
      if (e.target.classList.contains('evchk')) return;
      if (e.target.classList.contains('Manual')) { deleteManual(id); return; }
      focusEvent(id);
    });
  });
  list.querySelectorAll('.evchk').forEach((c) => c.addEventListener('change', () => {
    evById(+c.dataset.id).selected = c.checked;
    renderBoxes(); renderMarks(); updateSummary(); syncCheckAll(); markStale();
  }));
  syncCheckAll();
}
function syncCheckAll() {
  const vis = visibleEvents();
  $('fc-check-all').checked = vis.length > 0 && vis.every((e) => e.selected);
}

// highlight one event, jump the play head to it and play; in loop mode it then repeats
function focusEvent(id) {
  focusedId = id;
  const e = evById(id);
  if (!e) return;
  page.querySelectorAll('.evrow').forEach((r) => r.classList.toggle('focus', +r.dataset.id === id));
  renderBoxes();
  const start = playMode === 'loop' ? Math.max(0, e.t_start - PREROLL) : e.t_start;
  audio.currentTime = start;
  if (audio.paused) audio.play();
  scrollSpecTo(start, true);
}

function updateSummary() {
  const R = RESULT, sel = checkedEvents().length;
  const det = detectedEvents().filter((e) => !e.manual);
  const hi = det.filter((e) => e.severity === 'High').length;
  $('fc-summary').innerHTML = `
    <div class="stat"><div class="n">${det.length}</div><div class="l">Detected @ ${SENS} dB</div></div>
    <div class="stat"><div class="n">${sel}</div><div class="l">Ticked to notch</div></div>
    <div class="stat"><div class="n">${hi}</div><div class="l">High severity</div></div>
    <div class="stat"><div class="n">${fmt(R.duration)}</div><div class="l">${R.channels}ch · ${(R.sr / 1000) | 0}k</div></div>`;
  $('fc-tickcount').textContent = `${sel} ticked`;
}

// The cleaned audio is made by Apply; after changing sensitivity or ticks it is out of date.
const markStale = () => { if (RESULT) $('fc-apply').classList.add('stale'); };
const clearStale = () => $('fc-apply').classList.remove('stale');

function reDetect() {
  applyAutoSelection();
  assignNums();
  if (focusedId != null && !isDetected(evById(focusedId))) focusedId = null;
  renderList(); renderBoxes(); renderMarks(); updateSummary();
  markStale();
}

// ---------- manual draw-to-notch ----------
let drawMode = false, nextManualId = 10000, dragStart = null, tempRect = null;
function imgFrac(clientX, clientY) {
  const r = $('fc-spec-before').getBoundingClientRect();
  return { fx: (clientX - r.left) / r.width, fy: (clientY - r.top) / r.height };
}
function xToTime(fx) { const g = RESULT.spec; return Math.max(0, Math.min(g.duration, ((fx - g.x0) / g.w) * g.duration)); }
function yToFreq(fy) {
  const g = RESULT.spec;
  const yf = Math.max(0, Math.min(1, (fy - g.y0) / g.h));
  if (g.ylog) { const lo = Math.log(g.fmin), hi = Math.log(g.fmax); return Math.exp(lo + (1 - yf) * (hi - lo)); }
  return g.fmax * (1 - yf);
}
function setDrawMode(on) {
  drawMode = on;
  $('fc-overlay').classList.toggle('drawing', on);
  $('fc-draw').classList.toggle('active', on);
  $('fc-draw').textContent = on ? 'Drawing… (click to finish)' : 'Draw a feedback region';
}
function addManualMark(t0, t1, f0, f1) {
  const ev = {
    id: nextManualId++, manual: true, selected: true,
    t_start: Math.min(t0, t1), t_end: Math.max(t0, t1),
    freq_lo: Math.min(f0, f1), freq_hi: Math.max(f0, f1),
    freq: (f0 + f1) / 2, prom_db: 0, duration: +Math.abs(t1 - t0).toFixed(2), severity: 'Manual', score: 0,
  };
  if (ev.t_end - ev.t_start < 0.03 || ev.freq_hi - ev.freq_lo < 2) return;   // stray click
  RESULT.events.push(ev);
  renderList(); renderBoxes(); renderMarks(); updateSummary(); markStale();
}
function deleteManual(id) {
  RESULT.events = RESULT.events.filter((e) => e.id !== id);
  renderList(); renderBoxes(); renderMarks(); updateSummary(); markStale();
}

// ---------- zoom & pan (time only; the frequency axis stays put) ----------
let zoom = 1;
function fitHeight() {
  const sc = $('fc-spec-scroll'), img = $('fc-spec-before');
  if (!img.naturalWidth) return;
  img.style.height = `${(sc.clientWidth * img.naturalHeight) / img.naturalWidth}px`;
  drawFreqAxis();
}
function setZoom(z, centerClientX) {
  const sc = $('fc-spec-scroll'), wrap = $('fc-spec-wrap');
  z = Math.max(1, Math.min(12, z));
  const rect = sc.getBoundingClientRect();
  const cx = (centerClientX != null ? centerClientX : rect.left + rect.width / 2) - rect.left;
  const curW = wrap.getBoundingClientRect().width || sc.clientWidth || 1;
  const frac = (sc.scrollLeft + cx) / curW;
  zoom = z;
  wrap.style.width = `${zoom * 100}%`;
  $('fc-zoom-label').textContent = `${zoom.toFixed(1)}×`;
  sc.classList.toggle('zoomed', zoom > 1.001);
  sc.scrollLeft = Math.max(0, frac * (sc.clientWidth || 1) * zoom - cx);
  drawTimeAxis();
}
function highlight(id, on) {
  page.querySelectorAll(`.box[data-id="${id}"],.evrow[data-id="${id}"],.mk[data-id="${id}"]`).forEach((el) => el.classList.toggle('hi', on));
}

// ---------- axis labels in HTML, so zooming the image never smears them ----------
const FREQ_TICKS = [100, 150, 200, 300, 500, 700, 1000, 1500, 2000, 3000, 5000, 7000, 10000, 12000];
function freqFrac(fr) {   // 0 = fmax at the top, 1 = fmin at the bottom
  const g = RESULT.spec;
  if (g.ylog) {
    const lo = Math.log(g.fmin), hi = Math.log(g.fmax);
    return 1 - (Math.log(Math.min(Math.max(fr, g.fmin), g.fmax)) - lo) / (hi - lo);
  }
  return 1 - fr / g.fmax;
}
function drawFreqAxis() {
  const ax = $('fc-freq-axis');
  if (!RESULT?.spec) return;
  ax.style.height = `${$('fc-spec-before').clientHeight || 0}px`;
  ax.innerHTML = '';
  const g = RESULT.spec;
  for (const fr of FREQ_TICKS) {
    if (fr < g.fmin || fr > g.fmax) continue;
    const b = document.createElement('b');
    b.style.top = `${freqFrac(fr) * 100}%`;
    b.textContent = fr >= 1000 ? `${fr % 1000 ? (fr / 1000).toFixed(1) : fr / 1000}k` : fr;
    ax.appendChild(b);
  }
}
function niceStep(span, target) {   // a 1/2/5·10^k step so ~target ticks fit
  const raw = span / Math.max(target, 1), mag = Math.pow(10, Math.floor(Math.log10(raw) || 0));
  for (const m of [1, 2, 5, 10]) if (raw <= m * mag) return m * mag;
  return 10 * mag;
}
function fmtClock(s) {
  if (s >= 60) return `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
  return `${Math.round(s * 10) / 10}s`;
}
function drawTimeAxis() {
  const ax = $('fc-time-axis');
  if (!RESULT?.spec) return;
  const sc = $('fc-spec-scroll'), g = RESULT.spec, dur = g.duration || 0;
  const wpx = $('fc-spec-wrap').getBoundingClientRect().width || sc.clientWidth || 1, view = sc.clientWidth || 1, scr = sc.scrollLeft;
  ax.innerHTML = '';
  if (!dur) return;
  const step = niceStep((dur * view) / wpx, 8);
  for (let tt = Math.max(0, Math.floor(((scr / wpx) * dur) / step) * step); tt <= dur + 1e-6; tt += step) {
    const x = (tt / dur) * wpx - scr;
    if (x < -2 || x > view + 2) continue;
    const b = document.createElement('b');
    b.style.left = `${x}px`;
    b.textContent = fmtClock(tt);
    ax.appendChild(b);
  }
}
const drawAxes = () => { drawFreqAxis(); drawTimeAxis(); };

// ---------- numbered boxes over the spectrogram, placed with the engine's geometry ----------
function boxStyle(e) {
  const g = RESULT.spec, pct = (v) => `${v * 100}%`;
  const xL = g.x0 + (e.t_start / g.duration) * g.w, xR = g.x0 + (e.t_end / g.duration) * g.w;
  const yTop = g.y0 + freqFrac(e.freq_hi) * g.h, yBot = g.y0 + freqFrac(e.freq_lo) * g.h;
  return { left: pct(xL), width: pct(Math.max(xR - xL, 0)), top: pct((yTop + yBot) / 2), height: pct(Math.max(yBot - yTop, 0)) };
}
function renderBoxes() {
  const ov = $('fc-overlay');
  ov.innerHTML = '';
  if (!RESULT?.spec) return;
  for (const e of detectedEvents()) {
    const b = document.createElement('div');
    b.className = `box ${e.selected ? 'ticked' : 'unticked'}${e.manual ? ' manual' : ''}${e.id === focusedId ? ' foc' : ''}`;
    b.dataset.id = e.id;
    b.style.setProperty('--c', evColor(e));
    Object.assign(b.style, boxStyle(e));
    b.innerHTML = `<span class="mid"></span><span class="num">${numOf(e)}</span>`;
    b.addEventListener('mouseenter', () => highlight(e.id, true));
    b.addEventListener('mouseleave', () => highlight(e.id, false));
    b.addEventListener('click', (ev) => { ev.stopPropagation(); focusEvent(e.id); });
    ov.appendChild(b);
  }
}

// one colour per event, shared by the timeline tick, the spectrogram box and the list
const PALETTE = ['#39d3ff', '#ff5ac8', '#ffd23f', '#7cff6b', '#ff8f3f', '#c98bff', '#4dffd0',
  '#ff7a7a', '#8ab4ff', '#ffe08a', '#b6ff8a', '#ff9ecb', '#66e0ff', '#ffbe6b', '#d0a6ff', '#8affc7'];
function evColor(e) { const i = RESULT ? RESULT.events.indexOf(e) : 0; return PALETTE[((i % PALETTE.length) + PALETTE.length) % PALETTE.length]; }

// thin coloured ticks on the playback timeline for the events being cut
function renderMarks() {
  const m = $('fc-marks');
  if (!RESULT) { m.innerHTML = ''; return; }
  const dur = RESULT.duration || 1;
  m.innerHTML = checkedEvents().map((e) => {
    const L = Math.max(0, Math.min(100, (e.t_start / dur) * 100));
    const lab = e.manual ? `${Math.round(e.freq_lo)}–${Math.round(e.freq_hi)} Hz` : `${e.freq} Hz`;
    return `<div class="mk" data-id="${e.id}" title="#${numOf(e)} · ${lab} @ ${fmt(e.t_start)}" style="left:${L}%;background:${evColor(e)};color:${evColor(e)}"></div>`;
  }).join('');
  m.querySelectorAll('.mk').forEach((mk) => {
    const id = +mk.dataset.id;
    mk.addEventListener('click', () => focusEvent(id));
    mk.addEventListener('mouseenter', () => highlight(id, true));
    mk.addEventListener('mouseleave', () => highlight(id, false));
  });
}

// ---------- apply (re-notch the ticked events) ----------
async function apply() {
  if (!RESULT || busy) return;
  busy = true;
  const btn = $('fc-apply');
  btn.classList.add('busy');
  btn.textContent = 'Notching…';
  try {
    await engine('renotch', { job: RESULT.job, events: checkedEvents(), max_spec_cols: specCols() });
    const f = RESULT.files, bust = Date.now();
    await loadUrls([f.spec_after, f.cleaned_preview, f.removed_preview], bust);
    $('fc-spec-after').src = URLS[f.spec_after];
    clearStale();
    setUnsaved(true);
    if (curSrc !== 'original') loadSrc(curSrc);
    btn.textContent = 'Applied ✓';
    setTimeout(() => { btn.textContent = 'Apply ↻'; }, 1500);
  } catch (e) {
    toast('Apply failed', e.message, 'err');
    btn.textContent = 'Apply ↻';
  } finally {
    btn.classList.remove('busy');
    busy = false;
  }
}

const EXPORTS = { cleaned: 'cleaned', removed: 'removed', markers: 'markers', events_csv: 'events' };
async function exportFile(kind) {
  if (!RESULT) return;
  if ($('fc-apply').classList.contains('stale') && kind !== 'events_csv') {
    toast('Not applied yet', 'Your latest ticks aren’t in the cleaned audio. Click Apply first, or save anyway from the older version.', 'warn');
  }
  const r = await pilot.feedback('export', { job: RESULT.job, name: RESULT.files[kind], source: RESULT.path, suffix: EXPORTS[kind] });
  if (!r.ok) return toast('Save failed', r.error, 'err');
  if (!r.path) return;
  if (kind === 'cleaned' && listFile && listFile.toLowerCase() === RESULT.path.toLowerCase()) {
    // a Project files recording: all of them get cleaned first, Quiet Lift's list picks them up later
    const next = pf.next(RESULT.path);
    const saved = r.path.split(/[\\/]/).pop();
    pf.refresh();
    if (!next) return toast('Saved, last one in the project', `${saved}. Quiet Lift's Project files lists the cleaned recordings.`, 'ok');
    return toast('Saved', `${saved}. Next: ${next.name}`, 'ok', { label: `Open ${next.name}`, run: () => pf.open(next) });
  }
  if (kind === 'cleaned') {
    // next step of the chain: the cleaned WAV becomes Quiet Lift's debleed track
    go('quietlift');
    window.qlTakeFile(r.path);
    return toast('Saved, now in Quiet Lift', `${r.path.split(/[\\/]/).pop()} is loaded as the debleed track. Analyze, check, then Render.`, 'ok');
  }
  toast('Saved', r.path, 'ok', { label: 'Show in folder', run: () => pilot.feedback('reveal', { path: r.path }) });
}

// ---------- A/B transport (small MP3 previews, so long files play straight away) ----------
let curSrc = 'original';
const PREVIEW = { original: 'original_preview', cleaned: 'cleaned_preview', removed: 'removed_preview' };
function loadSrc(name) {
  const t = audio.currentTime, playing = !audio.paused;
  curSrc = name;
  audio.src = URLS[RESULT.files[PREVIEW[name]]];
  audio.addEventListener('loadedmetadata', () => { audio.currentTime = Math.min(t, audio.duration || t); if (playing) audio.play(); }, { once: true });
}
function positionPlayhead() {
  if (!RESULT?.spec) return;
  const g = RESULT.spec, dur = audio.duration || g.duration || 1;
  $('fc-playhead').style.left = `${(g.x0 + (audio.currentTime / dur) * g.w) * 100}%`;
  $('fc-playhead').hidden = false;
}
function timeFromClientX(clientX) {
  const wrap = $('fc-spec-wrap').getBoundingClientRect();
  const g = RESULT.spec, dur = audio.duration || g.duration || 1;
  const fx = (clientX - wrap.left) / (wrap.width || 1);
  return Math.max(0, Math.min(dur, ((fx - g.x0) / g.w) * dur));
}
// keep the head in view when zoomed; force recentres (jumping to an event)
function scrollSpecTo(t, force) {
  const sc = $('fc-spec-scroll');
  if (zoom <= 1.001) return;
  const g = RESULT.spec, dur = audio.duration || g.duration || 1;
  const x = (g.x0 + (t / dur) * g.w) * $('fc-spec-wrap').getBoundingClientRect().width, view = sc.clientWidth;
  if (force || x < sc.scrollLeft + view * 0.1 || x > sc.scrollLeft + view * 0.9) sc.scrollLeft = Math.max(0, x - view * 0.5);
}
function enforceLoop() {
  if (playMode !== 'loop' || focusedId == null) return;
  const e = evById(focusedId);
  if (!e) return;
  const start = Math.max(0, e.t_start - PREROLL), end = e.t_end + POSTROLL;
  if (audio.currentTime >= end || audio.currentTime < start - 0.05) audio.currentTime = start;
}
// ~60 fps while playing; timeupdate alone is too coarse for the head
let rafId = null;
function ticker() {
  positionPlayhead(); enforceLoop();
  if (!audio.paused) { scrollSpecTo(audio.currentTime); rafId = requestAnimationFrame(ticker); } else rafId = null;
}

// ---------- band ranges editor ----------
function updateBandChipTitles() {
  const b = BANDS, t = { Low: `20 Hz – ${fmtHz(b.b1)}`, 'Low-mid': `${fmtHz(b.b1)} – ${fmtHz(b.b2)}`, Mid: `${fmtHz(b.b2)} – ${fmtHz(b.b3)}`, High: `${fmtHz(b.b3)} – 20 kHz` };
  page.querySelectorAll('#fc-filters .chip[data-band]').forEach((c) => { c.title = t[c.dataset.band]; });
}
function syncBandMirrors() { for (const k of ['b1', 'b2', 'b3']) $(`fc-${k}m`).textContent = $(`fc-${k}`).value; }
function openBandModal() {
  for (const k of ['b1', 'b2', 'b3']) $(`fc-${k}`).value = BANDS[k];
  syncBandMirrors();
  $('fc-band-err').textContent = '';
  $('fc-band-modal').hidden = false;
  $('fc-b1').focus();
}
const closeBandModal = () => { $('fc-band-modal').hidden = true; };

// ---------- wiring ----------
function bind() {
  const drop = $('fc-drop');
  drop.addEventListener('click', async () => {
    const r = await pilot.feedback('pick-audio', { current: prefs().dir });
    if (r.ok && r.path) analyze(r.path);
  });
  for (const ev of ['dragenter', 'dragover']) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); });
  for (const ev of ['dragleave', 'drop']) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); });
  drop.addEventListener('drop', (e) => { const f = e.dataTransfer.files[0]; if (f) analyze(pilot.pathForFile(f)); });

  let sensTimer = null;
  $('fc-sens').addEventListener('input', () => {
    $('fc-sensval').textContent = `${$('fc-sens').value} dB`;
    clearTimeout(sensTimer);
    sensTimer = setTimeout(() => {
      if (!RESULT) return;   // before a file is analyzed it only sets the starting value
      SENS = +$('fc-sens').value;
      reDetect();
    }, 90);
  });
  $('fc-sens').addEventListener('change', () => savePrefs({ sensitivity: +$('fc-sens').value }));
  $('fc-spec').onchange = () => savePrefs({ specDetail: $('fc-spec').value });
  $('fc-python').onchange = async () => {
    savePrefs({ python: $('fc-python').value.trim() });   // the main process restarts the engine
    await startEngine();
  };

  $('fc-draw').addEventListener('click', () => setDrawMode(!drawMode));
  const ov = $('fc-overlay');
  const positionSel = (a, b) => {
    if (!tempRect) return;
    Object.assign(tempRect.style, {
      left: `${Math.min(a.fx, b.fx) * 100}%`, top: `${Math.min(a.fy, b.fy) * 100}%`,
      width: `${Math.abs(a.fx - b.fx) * 100}%`, height: `${Math.abs(a.fy - b.fy) * 100}%`,
    });
  };
  ov.addEventListener('mousedown', (ev) => {
    if (!drawMode) return;
    ev.preventDefault();
    dragStart = imgFrac(ev.clientX, ev.clientY);
    tempRect = document.createElement('div');
    tempRect.className = 'drawsel';
    ov.appendChild(tempRect);
    positionSel(dragStart, dragStart);
  });
  window.addEventListener('mousemove', (ev) => { if (drawMode && dragStart) positionSel(dragStart, imgFrac(ev.clientX, ev.clientY)); });
  window.addEventListener('mouseup', (ev) => {
    if (!drawMode || !dragStart) return;
    const e = imgFrac(ev.clientX, ev.clientY), s = dragStart;
    dragStart = null;
    tempRect?.remove();
    tempRect = null;
    addManualMark(xToTime(s.fx), xToTime(e.fx), yToFreq(s.fy), yToFreq(e.fy));
  });

  const sc = $('fc-spec-scroll');
  sc.addEventListener('scroll', drawTimeAxis);
  $('fc-zoom-in').onclick = () => setZoom(zoom * 1.5);
  $('fc-zoom-out').onclick = () => setZoom(zoom / 1.5);
  $('fc-zoom-fit').onclick = () => setZoom(1);
  sc.addEventListener('wheel', (e) => {
    if (e.ctrlKey || e.metaKey) { e.preventDefault(); setZoom(zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15), e.clientX); } else if (e.shiftKey) { e.preventDefault(); sc.scrollLeft += e.deltaY; }
  }, { passive: false });
  let pan = null;
  sc.addEventListener('mousedown', (e) => { if (!drawMode && zoom > 1.001) pan = { x: e.clientX, s: sc.scrollLeft, active: false }; });
  window.addEventListener('mousemove', (e) => {
    if (!pan) return;
    const dx = e.clientX - pan.x;
    if (!pan.active && Math.abs(dx) > 4) { pan.active = true; sc.classList.add('grabbing'); }
    if (pan.active) { sc.scrollLeft = pan.s - dx; e.preventDefault(); }
  });
  window.addEventListener('mouseup', () => { if (pan) { if (pan.active) panMoved = true; sc.classList.remove('grabbing'); pan = null; } });

  // drag the play head to scrub; click an empty part of the spectrogram to jump there
  const head = $('fc-playhead');
  let dragging = false, wasPlaying = false;
  const seekX = (x) => { if (RESULT?.spec) { audio.currentTime = timeFromClientX(x); positionPlayhead(); } };
  head.addEventListener('mousedown', (e) => {
    if (!RESULT) return;
    dragging = true;
    wasPlaying = !audio.paused;
    if (wasPlaying) audio.pause();
    seekX(e.clientX);
    e.preventDefault(); e.stopPropagation();
  });
  window.addEventListener('mousemove', (e) => { if (dragging) { seekX(e.clientX); e.preventDefault(); } });
  window.addEventListener('mouseup', () => { if (dragging) { dragging = false; if (wasPlaying) audio.play(); } });
  sc.addEventListener('click', (e) => {
    if (!RESULT || drawMode || e.target.closest('.box,.playhead')) return;
    if (panMoved) { panMoved = false; return; }   // the click that ends a pan
    seekX(e.clientX);
  });

  $('fc-check-all').addEventListener('change', (e) => {
    visibleEvents().forEach((ev) => { ev.selected = e.target.checked; });
    renderList(); renderBoxes(); renderMarks(); updateSummary(); markStale();
  });
  page.querySelectorAll('#fc-filters .chip').forEach((chip) => chip.addEventListener('click', () => {
    const isBand = 'band' in chip.dataset;
    const set = isBand ? bandFilter : sevFilter, key = isBand ? chip.dataset.band : chip.dataset.sev;
    if (set.has(key)) set.delete(key); else set.add(key);
    chip.classList.toggle('active', set.has(key));
    if (RESULT) renderList();
  }));

  for (const k of ['b1', 'b2', 'b3']) $(`fc-${k}`).addEventListener('input', syncBandMirrors);
  $('fc-band-edit').onclick = openBandModal;
  $('fc-band-cancel').onclick = closeBandModal;
  $('fc-band-modal').addEventListener('click', (e) => { if (e.target.id === 'fc-band-modal') closeBandModal(); });
  $('fc-band-defaults').onclick = () => { for (const k of ['b1', 'b2', 'b3']) $(`fc-${k}`).value = DEFAULT_BANDS[k]; syncBandMirrors(); };
  $('fc-band-save').onclick = () => {
    const b1 = +$('fc-b1').value, b2 = +$('fc-b2').value, b3 = +$('fc-b3').value;
    if (!(b1 > 0 && b2 > b1 && b3 > b2)) {
      $('fc-band-err').textContent = 'Each boundary must be higher than the one before it.';
      return;
    }
    BANDS = { b1, b2, b3 };
    try { localStorage.setItem('fc-band-ranges', JSON.stringify(BANDS)); } catch {}
    closeBandModal();
    updateBandChipTitles();
    if (RESULT) { renderList(); updateSummary(); }
  };

  $('fc-apply').onclick = apply;
  page.querySelectorAll('[data-fc-export]').forEach((b) => { b.onclick = () => exportFile(b.dataset.fcExport); });

  $('fc-toggle').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || !RESULT) return;
    page.querySelectorAll('#fc-toggle button').forEach((x) => x.classList.toggle('active', x === b));
    loadSrc(b.dataset.src);
  });
  $('fc-pmode').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    page.querySelectorAll('#fc-pmode button').forEach((x) => x.classList.toggle('active', x === b));
    playMode = b.dataset.mode;
    const f = playMode === 'loop' && focusedId != null && evById(focusedId);
    if (f) audio.currentTime = Math.max(0, f.t_start - PREROLL);
  });
  $('fc-play').onclick = () => { if (RESULT) audio.paused ? audio.play() : audio.pause(); };
  audio.addEventListener('play', () => { $('fc-play').textContent = '⏸'; if (rafId == null) rafId = requestAnimationFrame(ticker); });
  audio.addEventListener('pause', () => { $('fc-play').textContent = '▶'; });
  audio.addEventListener('timeupdate', () => {
    $('fc-scrub').value = (audio.currentTime / (audio.duration || 1)) * 1000 || 0;
    $('fc-time').textContent = `${fmt(audio.currentTime)} / ${fmt(audio.duration)}`;
    positionPlayhead(); enforceLoop();
  });
  $('fc-scrub').addEventListener('input', (e) => { audio.currentTime = (e.target.value / 1000) * (audio.duration || 0); positionPlayhead(); });
  window.addEventListener('resize', () => { if (RESULT?.spec && page.classList.contains('active')) { fitHeight(); renderBoxes(); renderMarks(); drawAxes(); } });

  // Space = play/pause on this page, except while typing; Escape closes the band editor
  document.addEventListener('keydown', (e) => {
    if (!page.classList.contains('active')) return;
    if (e.key === 'Escape' && !$('fc-band-modal').hidden) { closeBandModal(); return; }
    if (e.code !== 'Space' || !RESULT) return;
    if (e.target?.closest('input[type=text],input[type=number],textarea,select,[contenteditable]')) return;
    e.preventDefault();
    audio.paused ? audio.play() : audio.pause();
  });
}

bind();
updateBandChipTitles();

// Project files: the recorder audio of the open Resolve project's Edit timelines (renderer/projectfiles.js)
function openListed(file) {
  listFile = file;
  analyze(file);
}
const pf = window.projectFiles($('fc-pf'), { kind: 'fc', pick: (_row, file) => openListed(file) });
$('fc-btn-project').onclick = () => pf.toggle();

// Called when the page is shown: the Python engine starts the first time. With a path, analyzes that file.
window.fcOpen = (file) => {
  if (!started) {
    started = true;
    $('fc-sens').value = prefs().sensitivity;
    $('fc-sensval').textContent = `${prefs().sensitivity} dB`;
    $('fc-spec').value = prefs().specDetail;
    $('fc-python').value = prefs().python || '';
    startEngine();
  }
  // the page was hidden while the window resized: re-measure the spectrogram
  if (RESULT?.spec) requestAnimationFrame(() => { fitHeight(); renderBoxes(); drawAxes(); positionPlayhead(); });
  if (file) analyze(file);
};
// stop playback when leaving the page
document.querySelectorAll('.nav').forEach((b) => b.addEventListener('click', () => { if (b.dataset.page !== 'feedback') audio.pause(); }));
})();
