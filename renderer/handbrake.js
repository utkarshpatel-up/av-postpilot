/* global pilot, $, esc, toast, save, settings, fmtSec, renderShutdown */
// HandBrake Converter page: the AV team's HandBrakeCLI folder converter.
let hb = { running: false, items: [], counts: {} };
let hbPreview = null;     // last Preview result, shown until a run starts
let hbInfo = {};
const HB_FIELDS = { inputDir: 'hb-input', outputDir: 'hb-output', h264Dir: 'hb-h264', reportDir: 'hb-report', presetFile: 'hb-preset' };
const HB_KIND = { convert: 'Convert', copy: 'Copy', move: 'Move', skip: 'Skip' };
const HB_STATE = { waiting: 'Waiting', running: 'Running', done: 'Done', failed: 'Failed', skipped: 'Skipped' };
const HB_LIMIT = 1000;    // rows drawn at once; the report file has everything

async function hbLoadInfo() {
  const r = await pilot.handbrake('info');
  if (!r.ok) return;
  hbInfo = r;
  $('hb-report').placeholder = r.defaultReportDir;
  $('hb-cli').innerHTML = r.cli
    ? `<span class="pill ok">${r.builtIn ? 'Built in' : 'Found'}</span> <span class="muted">${r.builtIn ? `HandBrakeCLI ${esc(r.version || '')} comes with PostPilot` : esc(r.cli)}</span>`
    : '<span class="pill bad">Not found</span> <span class="muted">HandBrakeCLI normally comes with PostPilot. Reinstall PostPilot, or choose HandBrakeCLI here.</span>';
  const pc = $('hb-preset-check');
  pc.className = `pill ${r.preset ? 'ok' : 'bad'}${settings.handbrake.presetFile ? '' : ' hidden'}`;
  pc.textContent = r.preset ? `Preset: ${r.preset.trim()}` : (r.presetError || 'Not a HandBrake preset');
}

function hbRenderForm() {
  const h = settings.handbrake;
  for (const [k, id] of Object.entries(HB_FIELDS)) if (document.activeElement !== $(id)) $(id).value = h[k] || '';
  document.querySelector(`input[name=hb-mode][value=${h.convertSatsangs ? 'all' : 'clips'}]`).checked = true;
  $('hb-copy').value = h.copyMp4 ? 'copy' : 'move';
  $('hb-h264-row').classList.toggle('hidden', h.convertSatsangs);
  $('hb-copy-row').classList.toggle('hidden', h.convertSatsangs);
  hbLoadInfo();
  hbRender();
}

const hbSave = (mutate) => save((s) => mutate(s.handbrake)).then(() => { hbPreview = null; hbRenderForm(); });

function hbRow(i) {
  const name = i.src.split(/[\\/]/).pop();
  const target = i.dest ? `<div class="muted small">→ ${esc(i.dest)}${i.match ? ` · ${esc(i.match)}` : ''}</div>` : '';
  const why = i.reason ? `<div class="${i.error ? 'err' : 'muted small'}">${esc(i.reason)}</div>` : '';
  const err = i.error && i.error !== true ? `<div class="err">${esc(i.error)}</div>` : '';
  let st = '';
  if (i.state === 'running' && i.kind === 'convert') st = `<span class="bar"><i style="width:${(i.pct || 0).toFixed(1)}%"></i></span><span class="small">${Math.floor(i.pct || 0)}%</span>`;
  else if (i.state) st = `<span class="state ${i.state === 'skipped' ? '' : i.state}">${HB_STATE[i.state]}</span>${i.finishedAt && i.startedAt && i.kind === 'convert' && i.state === 'done' ? ` <span class="muted small">${fmtSec(Math.round((i.finishedAt - i.startedAt) / 1000))}</span>` : ''}`;
  return `<div class="hb-item"><span class="hb-kind">${HB_KIND[i.kind]}${i.h264 ? ' H264' : ''}</span>
    <div class="m">${esc(name)}<div class="muted small">${esc(i.src)}</div>${target}${why}${err}</div><span>${st}</span></div>`;
}

function hbRender() {
  const showRun = hb.running || (!hbPreview && hb.items.length);
  const items = showRun ? hb.items : hbPreview?.items || [];
  const showSkipped = $('hb-show-skipped').checked;
  const visible = items.filter((i) => showSkipped || (i.kind !== 'skip' && i.state !== 'skipped') || i.error || i.state === 'failed');
  const n = (k) => items.filter((i) => i.kind === k).length;
  $('hb-list-label').textContent = showRun ? (hb.running ? 'Converting' : 'Last run') : hbPreview ? 'Preview' : 'Files';
  $('hb-items').innerHTML = !items.length
    ? `<div class="empty">${hbPreview ? 'Nothing to do: the input folder has no files.' : 'Click "Preview" to see what will be converted, copied and skipped.'}</div>`
    : visible.slice(0, HB_LIMIT).map(hbRow).join('') + (visible.length > HB_LIMIT ? `<div class="empty">…and ${visible.length - HB_LIMIT} more (all are listed in the report file)</div>` : '')
      + (!visible.length ? '<div class="empty">Everything is skipped. Tick "Show skipped" to see why.</div>' : '');

  if (showRun) {
    const c = hb.counts;
    $('hb-summary').textContent = `${c.done} done · ${c.failed} failed · ${c.skipped} skipped${hb.running ? ` · ${c.waiting} waiting` : ''}${hb.error ? ` · ${hb.error}` : ''}`;
  } else if (hbPreview) {
    $('hb-summary').textContent = `${n('convert')} to convert · ${n('copy')} to copy${n('move') ? ` · ${n('move')} to move` : ''} · ${n('skip')} skipped${hbPreview.newDirs ? ` · ${hbPreview.newDirs} new folder(s)` : ''}`;
  } else $('hb-summary').textContent = '';

  const cur = hb.running && hb.items.find((i) => i.state === 'running');
  $('hb-progress').classList.toggle('hidden', !hb.running);
  if (hb.running) {
    const work = hb.items.filter((i) => i.kind !== 'skip');
    const finished = work.filter((i) => ['done', 'failed', 'skipped'].includes(i.state)).length + (cur?.kind === 'convert' ? (cur.pct || 0) / 100 : 0);
    $('hb-bar').style.width = `${work.length ? (finished / work.length) * 100 : 0}%`;
    $('hb-current').textContent = hb.stopping ? 'Stopping…' : cur
      ? `${HB_KIND[cur.kind]} ${cur.src.split(/[\\/]/).pop()}${cur.kind === 'convert' ? ` · ${Math.floor(cur.pct || 0)}%${cur.eta != null ? ` · ${fmtSec(cur.eta)} left` : ''}` : ''}`
      : 'Working…';
  }
  $('hb-start').disabled = hb.running;
  $('hb-start').textContent = hb.running ? 'Converting…' : 'Start converting';
  $('hb-preview').disabled = hb.running;
  $('hb-stop').disabled = !hb.running || hb.stopping;
  document.querySelectorAll('#page-handbrake input, #page-handbrake select, [data-hb-browse], #hb-preset-browse, #hb-cli-browse')
    .forEach((el) => { if (el.id !== 'hb-show-skipped' && el.id !== 'hb-after' && !el.closest('.countdown')) el.disabled = hb.running; });
  const badge = $('nav-hb-badge');
  badge.classList.toggle('hidden', !hb.running);
  badge.textContent = hb.running ? `${hb.counts.done + hb.counts.failed}/${hb.items.filter((i) => i.kind !== 'skip').length}` : '';
}

for (const [k, id] of Object.entries(HB_FIELDS)) $(id).addEventListener('change', (e) => hbSave((h) => { h[k] = e.target.value.trim(); }));
document.querySelectorAll('[data-hb-browse]').forEach((b) => b.addEventListener('click', async () => {
  const k = b.dataset.hbBrowse;
  const p = await pilot.pickFolder(settings.handbrake[k] || settings.handbrake.inputDir);
  if (p) hbSave((h) => { h[k] = p; });
}));
document.querySelectorAll('input[name=hb-mode]').forEach((r) => r.addEventListener('change', (e) => hbSave((h) => { h.convertSatsangs = e.target.value === 'all'; })));
$('hb-copy').addEventListener('change', (e) => hbSave((h) => { h.copyMp4 = e.target.value === 'copy'; }));
$('hb-after').addEventListener('change', (e) => save((s) => { s.handbrake.afterQueue = e.target.value; }));
$('hb-preset-browse').addEventListener('click', async () => {
  const r = await pilot.handbrake('pick-preset', { current: settings.handbrake.presetFile });
  if (!r.ok) return toast(r.error, true);
  if (r.path) hbSave((h) => { h.presetFile = r.path; });
});
$('hb-cli-browse').addEventListener('click', async () => {
  const r = await pilot.handbrake('pick-cli', { current: settings.handbrake.cliPath || hbInfo.cli });
  if (r.ok && r.path) hbSave((h) => { h.cliPath = r.path; });
});
$('hb-open-report').addEventListener('click', async () => {
  const msg = await pilot.openPath(settings.handbrake.reportDir || hbInfo.defaultReportDir);
  if (msg) toast('No reports yet: the folder is made by the first run', true);
});
$('hb-show-skipped').addEventListener('change', hbRender);
$('hb-preview').addEventListener('click', async () => {
  $('hb-preview').disabled = true;
  const r = await pilot.handbrake('preview');
  $('hb-preview').disabled = hb.running;
  if (!r.ok) return toast(r.error, true);
  hbPreview = r;
  if (!r.cli) toast('Preview ready, but HandBrakeCLI was not found: choose it before starting', true);
  hbRender();
});
$('hb-start').addEventListener('click', async () => {
  const r = await pilot.handbrake('start');
  if (!r.ok) toast(r.error, true);   // the preview stays so the editor can see what would run
});
$('hb-stop').addEventListener('click', () => pilot.handbrake('stop'));

pilot.onHandbrake((h) => { hb = h; if (h.running) hbPreview = null; hbRender(); renderShutdown(); });
pilot.handbrake('summary').then((r) => { if (r.ok) { hb = r; if (settings) hbRender(); } });
