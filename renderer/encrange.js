/* global pilot, $, esc, encCall, showToast */
// Encoder range window: play and scrub a file, mark In and Out (both frames included, like Premiere),
// and only that part is exported. The frame rate comes from the built-in HandBrakeCLI; files the
// player can't show (ProRes, MXF…) get a small preview copy with the same frame timing.
(() => {
'use strict';

const R = { open: false, group: null, item: null, fps: 25, last: 0, cur: 0, inF: null, outF: null, triedCopy: false, scrubbing: false };
const v = $('rg-video');

// ---------- timecode ----------
const base = () => Math.round(R.fps);
function tc(frame) {
  const f = frame % base();
  const s = Math.floor(frame / base());
  const p = (n) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}:${p(f)}`;
}
// "00:01:02:12", "1:02:12" (m:s:f), "62.5" (seconds) -> frame number, or null
function parseTc(text) {
  const t = text.trim();
  if (!t) return null;
  if (/^\d+(\.\d+)?$/.test(t)) return Math.round(Number(t) * R.fps);
  const parts = t.split(/[:;]/).map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return NaN;
  const [f, s = 0, m = 0, h = 0] = parts.reverse();
  return ((h * 60 + m) * 60 + s) * base() + f;
}
const clamp = (f) => Math.max(0, Math.min(R.last, f));
const inF = () => R.inF ?? 0;
const outF = () => R.outF ?? R.last;
const secs = (frames) => frames / R.fps;
const fmtLen = (s) => (s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.floor(s / 60) % 60} min` : s >= 60 ? `${Math.floor(s / 60)} min ${Math.round(s % 60)} s` : `${s.toFixed(s < 10 ? 2 : 1)} s`);

// ---------- video ----------
const frameAt = (t) => clamp(Math.floor(t * R.fps + 1e-4));
function seek(frame) {
  R.cur = clamp(frame);
  // the middle of the frame, so rounding never lands on the one before
  if (Number.isFinite(v.duration)) v.currentTime = Math.min((R.cur + 0.5) / R.fps, Math.max(0, v.duration - 0.001));
  draw();
}
function step(n) { v.pause(); seek(R.cur + n); }
function togglePlay() {
  if (v.paused) { if (R.cur >= R.last) seek(0); v.play().catch(() => {}); } else v.pause();
}
function follow() {
  // during playback show the frame that is actually on screen
  if (!R.open) return;
  if (v.requestVideoFrameCallback) {
    v.requestVideoFrameCallback((_now, meta) => {
      if (!v.paused && !R.scrubbing) { R.cur = clamp(Math.round(meta.mediaTime * R.fps)); draw(); }
      follow();
    });
  }
}

function overlay(html) {
  const o = $('rg-overlay');
  o.classList.toggle('hidden', !html);
  o.innerHTML = html || '';
}

// ---------- drawing ----------
const pct = (f) => (R.last ? (f / R.last) * 100 : 0);
function draw() {
  $('rg-playhead').style.left = `${pct(R.cur)}%`;
  $('rg-mark-in').style.left = `${pct(inF())}%`;
  $('rg-mark-out').style.left = `${pct(outF())}%`;
  $('rg-mark-in').classList.toggle('hidden', R.inF === null);
  $('rg-mark-out').classList.toggle('hidden', R.outF === null);
  $('rg-sel').style.left = `${pct(inF())}%`;
  $('rg-sel').style.width = `${pct(outF()) - pct(inF())}%`;
  if (document.activeElement !== $('rg-now')) $('rg-now').value = tc(R.cur);
  if (document.activeElement !== $('rg-in')) $('rg-in').value = R.inF === null ? '' : tc(R.inF);
  if (document.activeElement !== $('rg-out')) $('rg-out').value = R.outF === null ? '' : tc(R.outF);
  const whole = R.inF === null && R.outF === null;
  const n = outF() - inF() + 1;
  $('rg-dur').textContent = whole ? `Whole file · ${fmtLen(secs(R.last + 1))}` : `${tc(n)} · ${fmtLen(secs(n))}`;
  $('rg-save').textContent = whole ? 'Export whole file' : 'Use this range';
  $('rg-play').textContent = v.paused ? '▶' : '❚❚';
}
function drawTicks() {
  const dur = secs(R.last + 1);
  const W = $('rg-scrub').clientWidth || 800;
  const stepS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600].find((s) => dur / s <= W / 110) || 3600;
  let html = '';
  for (let t = 0; t <= dur; t += stepS) {
    const at = (t / dur) * 100;
    // labels at the ends stay inside the bar
    const shift = at < 4 ? 'none' : at > 96 ? 'translateX(-100%)' : '';
    html += `<span style="left:${at}%;${shift ? `transform:${shift}` : ''}">${tc(Math.round(t * R.fps)).replace(/^00:/, '')}</span>`;
  }
  $('rg-ticks').innerHTML = html;
}

// ---------- marks ----------
function setIn(f) {
  R.inF = f === null ? null : clamp(f);
  if (R.inF !== null && R.outF !== null && R.outF < R.inF) R.outF = null;
  draw();
}
function setOut(f) {
  R.outF = f === null ? null : clamp(f);
  if (R.inF !== null && R.outF !== null && R.outF < R.inF) R.inF = null;
  draw();
}

// ---------- open / close ----------
async function load(url) {
  v.src = url;
  v.playbackRate = Number($('rg-rate').value);
}

async function openRange(groupId, item) {
  Object.assign(R, { open: true, group: groupId, item, inF: null, outF: null, cur: 0, last: 0, triedCopy: false });
  $('rg-file').innerHTML = `<bdi dir="ltr">${esc(item.file)}</bdi>`;
  $('rg-meta').textContent = '';
  $('rg').classList.remove('hidden');
  overlay('<div>Reading the file…</div>');
  draw();
  const r = await pilot.encPreview('probe', item.file);
  if (!R.open || R.item !== item) return;
  if (!r.ok) return overlay(`<div><b>Can't read this file</b></div><div class="small">${esc(r.error)}</div>`);
  R.fps = r.fps;
  R.probe = r;
  $('rg-meta').textContent = [r.size, `${Number(r.fps.toFixed(3))} fps`].filter(Boolean).join(' · ');
  load(r.previewUrl || r.url);
  follow();
}

function close() {
  R.open = false;
  v.pause();
  v.removeAttribute('src');   // let go of the file
  v.load();
  $('rg').classList.add('hidden');
  if (R.making) pilot.encPreview('cancel');
}

async function makeCopy() {
  R.triedCopy = true;
  R.making = true;
  overlay(`<div><b>Making a preview copy</b></div><div class="small">Only for watching here: the export still uses the original file.</div>
    <div class="bar"><i id="rg-copy-bar" style="width:0%"></i></div><div class="small" id="rg-copy-pct">Starting…</div><button class="btn" id="rg-copy-cancel">Cancel</button>`);
  $('rg-copy-cancel').onclick = () => pilot.encPreview('cancel');
  const file = R.item.file;
  const r = await pilot.encPreview('make', file);
  R.making = false;
  if (!R.open || R.item?.file !== file) return;
  if (!r.ok) return overlay(`<div><b>No preview</b></div><div class="small">${esc(r.error)}</div><div class="small">You can still type the In and Out timecodes below.</div><button class="btn" id="rg-copy-retry">Try again</button>`), ($('rg-copy-retry').onclick = makeCopy);
  load(r.url);
}

function cantPlay() {
  if (R.triedCopy) return overlay('<div><b>This file can\'t be shown</b></div><div class="small">You can still type the In and Out timecodes below.</div>');
  overlay(`<div><b>This format can't be played here</b> (e.g. ProRes, DNxHD, MXF).</div>
    <div class="small">PostPilot can make a small preview copy with its built-in HandBrake. It keeps every frame where it is, so the range you pick is exact.</div>
    <button class="btn primary" id="rg-make-copy">Make preview copy</button>`);
  $('rg-make-copy').onclick = makeCopy;
}

v.addEventListener('loadedmetadata', () => {
  if (!R.open) return;
  if (!v.videoWidth) return cantPlay();   // e.g. audio decoded, video codec not supported
  const frames = Math.max(1, Math.round(v.duration * R.fps));
  R.last = frames - 1;
  const old = R.item.range;
  if (old) {
    // a range saved at another frame rate is carried over by time
    const conv = (f) => clamp(Math.round((f / old.fps) * R.fps));
    R.inF = conv(old.inFrame);
    R.outF = conv(old.outFrame);
  }
  overlay('');
  drawTicks();
  seek(R.inF ?? 0);
});
v.addEventListener('error', () => { if (R.open && v.getAttribute('src')) cantPlay(); });
v.addEventListener('play', draw);
v.addEventListener('pause', () => { R.cur = frameAt(v.currentTime); draw(); });
v.addEventListener('progress', () => {
  if (v.buffered.length && v.duration) $('rg-buffer').style.width = `${(v.buffered.end(v.buffered.length - 1) / v.duration) * 100}%`;
});
pilot.onEncPreview(({ file, pct: p }) => {
  if (!R.open || R.item?.file !== file || !$('rg-copy-bar')) return;
  $('rg-copy-bar').style.width = `${p}%`;
  $('rg-copy-pct').textContent = `${p}%`;
});
new ResizeObserver(() => { if (R.open && R.last) drawTicks(); }).observe($('rg-scrub'));

// ---------- scrubbing and dragging marks ----------
const frameAtX = (x) => {
  const r = $('rg-track-box').getBoundingClientRect();
  return clamp(Math.round(((x - r.left) / r.width) * R.last));
};
$('rg-scrub').querySelector('.rg-track').id = 'rg-track-box';
$('rg-scrub').addEventListener('pointerdown', (e) => {
  if (!R.last) return;
  const mark = e.target.closest('.rg-mark');
  const drag = mark ? (mark.id === 'rg-mark-in' ? setIn : setOut) : null;
  R.scrubbing = true;
  v.pause();
  $('rg-scrub').setPointerCapture(e.pointerId);
  const move = (ev) => { const f = frameAtX(ev.clientX); if (drag) drag(f); seek(f); };
  move(e);
  const up = () => {
    R.scrubbing = false;
    $('rg-scrub').removeEventListener('pointermove', move);
    $('rg-scrub').removeEventListener('pointerup', up);
    $('rg-scrub').removeEventListener('pointercancel', up);
  };
  $('rg-scrub').addEventListener('pointermove', move);
  $('rg-scrub').addEventListener('pointerup', up);
  $('rg-scrub').addEventListener('pointercancel', up);
});
// mouse wheel over the bar: one frame per notch (Shift: one second)
$('rg-scrub').addEventListener('wheel', (e) => {
  if (!R.last) return;
  e.preventDefault();
  step((e.deltaY > 0 || e.deltaX > 0 ? 1 : -1) * (e.shiftKey ? base() : 1));
}, { passive: false });

// ---------- buttons and fields ----------
$('rg-play').onclick = togglePlay;
$('rg-back').onclick = () => step(-1);
$('rg-fwd').onclick = () => step(1);
$('rg-go-in').onclick = () => { v.pause(); seek(inF()); };
$('rg-go-out').onclick = () => { v.pause(); seek(outF()); };
$('rg-set-in').onclick = () => setIn(R.cur);
$('rg-set-out').onclick = () => setOut(R.cur);
$('rg-rate').onchange = () => { v.playbackRate = Number($('rg-rate').value); };
$('rg-clear').onclick = () => { setIn(null); setOut(null); };
$('rg-close').onclick = $('rg-cancel').onclick = close;
$('rg').addEventListener('pointerdown', (e) => { if (e.target === $('rg')) close(); });
$('rg-save').onclick = async () => {
  const whole = R.inF === null && R.outF === null;
  const range = whole || !R.last ? null : { inFrame: inF(), outFrame: outF(), fps: R.fps };
  if (!R.last && (R.inF !== null || R.outF !== null)) return showToast('The file is not loaded yet', '', 'warn');
  const r = await encCall('updateItem', { group: R.group, id: R.item.id, fields: { range } });
  if (r.ok) close();
};
for (const [id, set] of [['rg-in', setIn], ['rg-out', setOut], ['rg-now', null]]) {
  const el = $(id);
  const apply = () => {
    const f = parseTc(el.value);
    if (Number.isNaN(f)) { showToast('Not a timecode', 'Use hh:mm:ss:ff, or seconds like 62.5', 'warn'); draw(); return; }
    if (set) set(f); else if (f !== null) { v.pause(); seek(f); }
    if (set && f !== null) seek(f);
  };
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); apply(); el.blur(); } if (e.key === 'Escape') { e.stopPropagation(); el.blur(); draw(); } });
  el.addEventListener('change', apply);
}

document.addEventListener('keydown', (e) => {
  if (!R.open) return;
  if (e.target.matches('input, select, textarea')) return;
  const k = e.code;
  let done = true;
  if (k === 'Space' || k === 'KeyK') togglePlay();
  else if (k === 'ArrowLeft') step(e.shiftKey ? -base() : -1);
  else if (k === 'ArrowRight') step(e.shiftKey ? base() : 1);
  else if (k === 'KeyI' && e.shiftKey) $('rg-go-in').click();
  else if (k === 'KeyO' && e.shiftKey) $('rg-go-out').click();
  else if (k === 'KeyI') setIn(R.cur);
  else if (k === 'KeyO') setOut(R.cur);
  else if (k === 'Home') { v.pause(); seek(0); }
  else if (k === 'End') { v.pause(); seek(R.last); }
  else if (k === 'Escape') close();
  else if (k === 'Enter') $('rg-save').click();
  else done = false;
  if (done) { e.preventDefault(); e.stopPropagation(); }
}, true);
// a focused button must not also react to Space (it clicks on key up)
document.addEventListener('keyup', (e) => {
  if (R.open && e.code === 'Space' && !e.target.matches('input, select, textarea')) e.preventDefault();
}, true);

window.openRange = openRange;
})();
