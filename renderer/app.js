/* global pilot */
const $ = (id) => document.getElementById(id);
let settings = null;
let status = {};
let autosave = {};
let pcName = '';

// ------------------------------------------------------------------ helpers
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const time = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const ago = (t) => {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return new Date(t).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
};
const until = (t) => {
  const s = Math.max(0, Math.round((t - Date.now()) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

let toastTimer;
function toast(msg, bad = false) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.toggle('bad', bad);
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 4500);
}

async function save(mutate) {
  const next = structuredClone(settings);
  mutate(next);
  settings = await pilot.saveSettings(next);
  renderAutosaveForm();
  renderSettingsForm();
  renderRendersForm();
  renderDashboard();
}

// ------------------------------------------------------------------ navigation
function go(page) {
  document.querySelectorAll('.nav').forEach((b) => b.classList.toggle('active', b.dataset.page === page));
  document.querySelectorAll('.page').forEach((p) => p.classList.toggle('active', p.id === `page-${page}`));
  if (page === 'autosave') refreshDestChecks();
  if (page === 'newproject') renderNewProject();
  if (page === 'notify') renderNotify();
  if (page === 'renders') renderRendersForm();
  if (page === 'encoder' && !presets.length && status.connected && status.project) loadPresets(true);
  if (page === 'scene' && status.connected && status.project) loadSceneTimelines();
  if (page === 'episodes') {
    $('e-project').textContent = status.project?.name || 'no project open';
    if (status.connected && status.project) loadSeries();
  }
}
document.querySelectorAll('.nav').forEach((b) => b.addEventListener('click', () => go(b.dataset.page)));
document.querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => go(b.dataset.goto)));

// ------------------------------------------------------------------ dashboard
function renderDashboard() {
  const dot = $('d-resolve-dot');
  const openBtn = $('d-open-resolve');
  dot.className = 'dot';
  openBtn.classList.add('hidden');
  if (status.connected) {
    dot.classList.add('ok');
    $('d-resolve').textContent = 'Connected';
    $('d-resolve-sub').textContent = [status.product, status.version].filter(Boolean).join(' ');
  } else if (status.resolveRunning) {
    dot.classList.add('warn');
    $('d-resolve').textContent = 'Running, not connected';
    $('d-resolve-sub').textContent = status.scriptingOff
      ? 'Turn on Preferences → System → General → External scripting using: Local'
      : 'Waiting for Resolve to finish starting…';
  } else {
    dot.classList.add('bad');
    $('d-resolve').textContent = 'Not running';
    $('d-resolve-sub').textContent = '';
    openBtn.classList.remove('hidden');
  }

  const p = status.project;
  $('d-project').textContent = p ? p.name : '—';
  $('d-library').textContent = p ? p.dbName || '' : status.connected ? 'No project open' : '';
  const lt = $('d-libtype');
  if (p) {
    const net = p.dbType && p.dbType !== 'Disk';
    lt.textContent = net ? 'Network' : 'Local';
    lt.className = `badge ${net ? 'net' : 'local'}`;
  } else lt.className = 'badge hidden';

  const a = settings.autosave;
  const dests = a.destinations.filter((d) => d.enabled && d.path).length;
  if (!a.enabled) $('d-autosave').textContent = 'Off';
  else if (!dests) $('d-autosave').textContent = 'No save location';
  else if (autosave.running) $('d-autosave').textContent = 'Saving…';
  else $('d-autosave').textContent = autosave.nextRunAt ? `Next in ${until(autosave.nextRunAt)}` : 'On';
  const last = autosave.last;
  $('d-autosave-sub').textContent = last ? `${ago(last.time)}: ${last.message}` : `Every ${a.intervalMin} min · ${dests} location(s)`;
  $('d-save-now').disabled = !status.connected || autosave.running || !dests;

  const jobs = status.jobs || [];
  $('d-jobs').innerHTML = jobs.length
    ? jobs.map((j) => {
      const pct = Math.round(j.percent || 0);
      return `<tr><td>${esc(j.name || j.id)}</td><td>${esc(j.timeline)}</td>
        <td class="muted small">${esc(j.file)}</td>
        <td><span class="bar"><i style="width:${pct}%"></i></span>${esc(j.status || '')} ${j.status === 'Rendering' ? `${pct}%` : ''}</td></tr>`;
    }).join('')
    : `<tr><td colspan="4" class="muted">${status.connected ? 'No render jobs in this project' : '—'}</td></tr>`;
}

// ------------------------------------------------------------------ log
let logEntries = [];
function logItem(e) {
  return `<li class="${e.level}"><span class="t">${time(e.time)}</span><span class="m">${esc(e.msg)}</span></li>`;
}
function renderLog() {
  const rev = [...logEntries].reverse();
  $('d-log').innerHTML = rev.slice(0, 6).map(logItem).join('') || '<li class="muted">Nothing yet</li>';
  $('l-log').innerHTML = rev.map(logItem).join('') || '<li class="muted">Nothing yet</li>';
}

// ------------------------------------------------------------------ auto-save form
function renderAutosaveForm() {
  const a = settings.autosave;
  $('a-enabled').checked = a.enabled;
  $('a-interval').value = String(a.intervalMin);
  $('a-keepdays').value = a.keepDays;
  $('a-keepmin').value = a.keepMin;
  $('a-skipuntitled').checked = a.skipUntitled;

  const box = $('a-dests');
  if (!a.destinations.length) {
    box.innerHTML = '<div class="empty">No save locations yet. Click <strong>+ Add location</strong> and choose a folder (local disk, NAS, or a Google Drive / OneDrive folder).</div>';
  } else {
    box.innerHTML = a.destinations.map((d, i) => `
      <div class="dest-wrap" data-i="${i}">
        <div class="dest">
          <input type="checkbox" class="d-on" title="Use this location" ${d.enabled ? 'checked' : ''}>
          <input type="text" class="grow d-path" value="${esc(d.path)}" placeholder="Folder path">
          <span class="pill d-check"></span>
          <label class="check inline" title="Put this PC's saves in a folder named after the PC. On by default for network drives, off for local disks.">
            <input type="checkbox" class="d-pc"> PC folder</label>
          <button class="btn d-browse">Browse…</button>
          <button class="btn icon d-open" title="Open folder">↗</button>
          <button class="btn icon d-del" title="Remove">✕</button>
        </div>
        <code class="d-example"></code>
      </div>`).join('');
  }
  refreshDestChecks();
}

function examplePath(dest, usePc) {
  const proj = status.project?.name || 'My Project';
  const lib = status.project?.dbName || 'edit_share_18';
  const base = dest.replace(/[\\/]+$/, '');
  return [base, usePc ? pcName : null, lib, proj, `${proj}_2026-10-01_1415.drp`].filter(Boolean).join('\\');
}

async function refreshDestChecks() {
  for (const row of document.querySelectorAll('.dest-wrap')) {
    const d = settings.autosave.destinations[Number(row.dataset.i)];
    const p = row.querySelector('.d-path').value.trim();
    const pill = row.querySelector('.d-check');
    const pcBox = row.querySelector('.d-pc');
    const usePc = typeof d.pcFolder === 'boolean' ? d.pcFolder : await pilot.isNetworkPath(p);
    pcBox.checked = usePc;
    row.querySelector('.d-example').textContent = p ? examplePath(p, usePc) : '';
    if (!p) { pill.className = 'pill d-check hidden'; continue; }
    const ok = await pilot.checkPath(p);
    pill.className = `pill d-check ${ok ? 'ok' : 'bad'}`;
    pill.textContent = ok ? 'Reachable' : 'Not found';
  }
}

$('a-dests').addEventListener('click', async (e) => {
  const row = e.target.closest('.dest-wrap');
  if (!row) return;
  const i = Number(row.dataset.i);
  if (e.target.classList.contains('d-browse')) {
    const picked = await pilot.pickFolder(settings.autosave.destinations[i].path);
    if (picked) {
      const net = await pilot.isNetworkPath(picked);
      await save((s) => { Object.assign(s.autosave.destinations[i], { path: picked, pcFolder: net }); });
    }
  } else if (e.target.classList.contains('d-del')) {
    await save((s) => { s.autosave.destinations.splice(i, 1); });
  } else if (e.target.classList.contains('d-open')) {
    const r = await pilot.openPath(settings.autosave.destinations[i].path);
    if (r) toast(r, true);
  }
});
$('a-dests').addEventListener('change', async (e) => {
  const row = e.target.closest('.dest-wrap');
  if (!row) return;
  const i = Number(row.dataset.i);
  if (e.target.classList.contains('d-on')) await save((s) => { s.autosave.destinations[i].enabled = e.target.checked; });
  if (e.target.classList.contains('d-pc')) await save((s) => { s.autosave.destinations[i].pcFolder = e.target.checked; });
  if (e.target.classList.contains('d-path')) {
    const p = e.target.value.trim();
    const net = await pilot.isNetworkPath(p);
    await save((s) => { Object.assign(s.autosave.destinations[i], { path: p, pcFolder: net }); });
  }
});
$('a-add').addEventListener('click', async () => {
  const picked = await pilot.pickFolder();
  if (!picked) return;
  const net = await pilot.isNetworkPath(picked);
  await save((s) => { s.autosave.destinations.push({ path: picked, enabled: true, pcFolder: net }); });
});
$('a-enabled').addEventListener('change', (e) => save((s) => { s.autosave.enabled = e.target.checked; }));
$('a-interval').addEventListener('change', (e) => save((s) => { s.autosave.intervalMin = Number(e.target.value); }));
$('a-skipuntitled').addEventListener('change', (e) => save((s) => { s.autosave.skipUntitled = e.target.checked; }));
$('a-keepdays').addEventListener('change', (e) => save((s) => { s.autosave.keepDays = Math.max(1, Number(e.target.value) || 30); }));
$('a-keepmin').addEventListener('change', (e) => save((s) => { s.autosave.keepMin = Math.max(1, Number(e.target.value) || 20); }));

// ------------------------------------------------------------------ settings form
function renderSettingsForm() {
  $('s-resolve').value = settings.resolvePath;
  $('s-launch').checked = settings.launchResolve;
  $('s-hidden').checked = settings.startHidden;
}
$('s-resolve').addEventListener('change', (e) => save((s) => { s.resolvePath = e.target.value.trim(); }));
$('s-resolve-browse').addEventListener('click', async () => {
  const p = await pilot.pickResolve();
  if (p) await save((s) => { s.resolvePath = p; });
});
$('s-launch').addEventListener('change', (e) => save((s) => { s.launchResolve = e.target.checked; }));
$('s-hidden').addEventListener('change', (e) => save((s) => { s.startHidden = e.target.checked; }));

// ------------------------------------------------------------------ actions
$('d-save-now').addEventListener('click', async () => {
  const r = await pilot.saveNow();
  toast(r.message, !r.ok);
});
$('d-open-resolve').addEventListener('click', () => pilot.launchResolve());
$('l-open').addEventListener('click', () => pilot.openLog());

// ------------------------------------------------------------------ new project
const FOLDERS = ['Audio', 'Resolve Export', 'Reviewed Episode', 'Satsang Files', 'Scratch Disk', 'Titles'];
let days = [];   // scan results

function projectRoot() {
  const name = $('n-name').value.trim();
  const loc = $('n-location').value.trim().replace(/[\\/]+$/, '');
  return name && loc ? `${loc}\\${name}` : '';
}

function renderNewProject() {
  const root = projectRoot();
  $('n-root').textContent = root || '—';
  $('n-folders').innerHTML = FOLDERS.map((f) => `<span class="chip">${esc(f)}</span>`).join('');
  $('n-days').innerHTML = days.length
    ? days.map((d, i) => `
      <div class="day">
        <div class="day-head"><strong>${esc(d.name)}</strong>
          <button class="btn icon n-del" data-i="${i}" title="Remove">✕</button></div>
        ${d.error ? `<div class="warn-text small">${esc(d.error)}</div>` : ''}
        ${!d.error && !d.sessions.length ? '<div class="warn-text small">No clips found in this folder</div>' : ''}
        <ul>${d.sessions.map((s) => `<li><b>${esc(s.master)}</b> + <b>${esc(s.edit)}</b> · ${s.clips} clip(s) · ${esc(s.folder)}</li>`).join('')}</ul>
      </div>`).join('')
    : '<div class="empty">Add the day folders, e.g. <strong>2978 Dt-03 Jun 2026</strong>. You can pick several at once.</div>';
  const tl = days.reduce((n, d) => n + d.sessions.length * 2, 0);
  $('n-target').textContent = status.project
    ? `The project is created in the Resolve library that is open now: ${status.project.dbName || ''}. ${tl} timeline(s) will be made.`
    : 'Open Resolve first. The project is created in the library that is open in Resolve.';
}

$('n-name').addEventListener('input', renderNewProject);
$('n-location').addEventListener('input', renderNewProject);
$('n-location-browse').addEventListener('click', async () => {
  const p = await pilot.pickFolder($('n-location').value);
  if (p) { $('n-location').value = p; renderNewProject(); }
});
$('n-add').addEventListener('click', async () => {
  const picked = await pilot.pickFolders();
  if (!picked.length) return;
  const fresh = picked.filter((p) => !days.some((d) => d.dir.toLowerCase() === p.toLowerCase()));
  days = [...days, ...(await pilot.scanDays(fresh))].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  if (!$('n-name').value.trim() && days.length) {
    const nums = days.map((d) => d.number).filter(Boolean);
    $('n-name').value = nums.length > 1 ? `Edit-${nums[0]} to ${nums[nums.length - 1]}` : `Edit-${nums[0]}`;
  }
  renderNewProject();
});
$('n-days').addEventListener('click', (e) => {
  const b = e.target.closest('.n-del');
  if (!b) return;
  days.splice(Number(b.dataset.i), 1);
  renderNewProject();
});
$('n-create').addEventListener('click', async () => {
  const move = document.querySelector('input[name=n-move]:checked').value === 'move';
  const usable = days.filter((d) => d.sessions.length);
  if (!usable.length) return toast('Add at least one satsang folder with clips', true);
  const root = projectRoot();
  if (!root) return toast('Enter the project name and location', true);
  const how = move ? 'move (same drive) or copy (other drive)' : 'copy';
  if (!confirm(`Create "${$('n-name').value.trim()}"?\n\nThis will ${how} ${usable.length} folder(s) into:\n${root}\\Satsang Files\n\nNothing is ever deleted. Then the project is created in Resolve.`)) return;
  $('n-create').disabled = true;
  $('n-progress').classList.remove('hidden');
  const r = await pilot.createProject({ name: $('n-name').value, location: $('n-location').value.trim(), days: usable.map((d) => d.dir), move });
  $('n-create').disabled = false;
  if (r.ok) {
    $('n-progress-msg').textContent = `Done: ${r.imported} clip(s) imported, ${r.timelines.length} timeline(s) created${r.problems.length ? `, ${r.problems.length} warning(s), see Activity` : ''}`;
    $('n-bar').style.width = '100%';
    days = [];
    renderNewProject();
    toast(`Project "${r.project}" created`);
  } else {
    $('n-progress-msg').textContent = r.error;
    toast(r.error, true);
  }
});

// ------------------------------------------------------------------ episodes
let erows = [{ cue: '', count: 3 }];
let cues = [];
let seriesList = [];

function seriesForm() {
  const title = $('e-title').value.trim();
  return {
    title,
    series: $('e-same').checked ? title : $('e-series').value.trim(),
    subtitle: $('e-subtitle').value.trim(),
    start: Number($('e-start').value) || 0,
    showNumber: $('e-shownum').checked,
    size: Number($('e-size').value) || 0.11,
    rows: erows.filter((r) => r.cue.trim() && Number(r.count) > 0),
  };
}

function renderRows() {
  $('e-rows').innerHTML = erows.map((r, i) => `
    <div class="erow" data-i="${i}">
      <input type="text" class="e-cue" list="e-cues" value="${esc(r.cue)}" placeholder="2978">
      <span class="muted">×</span>
      <input type="number" class="e-count" min="1" max="200" value="${r.count}">
      <span class="muted">episodes</span>
      <button class="btn icon e-del" title="Remove">✕</button>
    </div>`).join('') + `<datalist id="e-cues">${cues.map((c) => `<option value="${esc(c)}">`).join('')}</datalist>`;
  $('e-cue-hint').innerHTML = cues.length
    ? `Click to add a folder to the selected row (an episode can use several): ${cues.map((c) => `<button class="chip e-chip" data-cue="${esc(c)}">${esc(c)}</button>`).join(' ')}`
    : 'Tip: an episode made from two folders can say "2978, 2980 M".';
  const sel = $('e-rows').querySelectorAll('.erow')[activeRow];
  if (sel) sel.classList.add('selected');
}

let activeRow = 0;
$('e-rows').addEventListener('focusin', (e) => {
  const row = e.target.closest('.erow');
  if (!row) return;
  activeRow = Number(row.dataset.i);
  $('e-rows').querySelectorAll('.erow').forEach((r) => r.classList.toggle('selected', r === row));
});
$('e-cue-hint').addEventListener('click', (e) => {
  const chip = e.target.closest('.e-chip');
  if (!chip) return;
  const r = erows[activeRow] || erows[erows.length - 1];
  const parts = r.cue.split(',').map((s) => s.trim()).filter(Boolean);
  if (!parts.includes(chip.dataset.cue)) parts.push(chip.dataset.cue);
  r.cue = parts.join(', ');
  renderRows();
  previewSeries();
});

let previewTimer;
function previewSeries() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(async () => {
    $('e-series').disabled = $('e-same').checked;
    if ($('e-same').checked) $('e-series').value = $('e-title').value;
    const f = seriesForm();
    const plan = f.series && f.rows.length ? await pilot.planSeries(f) : [];
    $('e-preview').innerHTML = plan.length
      ? plan.map((p) => `<li><span>${esc(p.name)}</span><span>${esc(`${p.line1}  /  ${p.subtitle}`)}</span></li>`).join('')
      : '<li class="muted">Fill in the title, series and at least one row</li>';
  }, 120);
}

$('e-rows').addEventListener('input', (e) => {
  const row = e.target.closest('.erow');
  if (!row) return;
  const r = erows[Number(row.dataset.i)];
  if (e.target.classList.contains('e-cue')) r.cue = e.target.value;
  if (e.target.classList.contains('e-count')) r.count = Number(e.target.value) || 0;
  previewSeries();
});
$('e-rows').addEventListener('click', (e) => {
  if (!e.target.classList.contains('e-del')) return;
  erows.splice(Number(e.target.closest('.erow').dataset.i), 1);
  if (!erows.length) erows.push({ cue: '', count: 3 });
  renderRows(); previewSeries();
});
$('e-addrow').addEventListener('click', () => {
  erows.push({ cue: '', count: 1 });
  activeRow = erows.length - 1;
  renderRows(); previewSeries();
});
['e-title', 'e-series', 'e-subtitle', 'e-start', 'e-size'].forEach((id) => $(id).addEventListener('input', previewSeries));
['e-same', 'e-shownum'].forEach((id) => $(id).addEventListener('change', previewSeries));

$('e-create').addEventListener('click', async () => {
  const f = seriesForm();
  if (!f.title || !f.series) return toast('Enter the title line and series name', true);
  if (!f.rows.length) return toast('Add at least one row with a folder and a count', true);
  const total = f.rows.reduce((n, r) => n + r.count, 0);
  if (!confirm(`Create ${total} episode timeline(s) in "${status.project?.name}"?`)) return;
  $('e-create').disabled = true;
  const r = await pilot.createSeries(f);
  $('e-create').disabled = false;
  if (!r.ok) return toast(r.error, true);
  toast(`Created ${r.made.length} episode(s)${r.skipped.length ? `, ${r.skipped.length} already existed` : ''}`, r.problems.length > 0);
  loadSeries();
});

// ------------------------------------------------------------------ rename
function renameForm() {
  const title = $('r-title').value.trim();
  return {
    title,
    series: $('r-same').checked ? title : $('r-series').value.trim(),
    start: Number($('r-start').value) || 0,
    showNumber: $('r-shownum').checked,
    subtitle: $('r-subtitle').value.trim(),
  };
}
const pickedSeries = () => seriesList.find((s) => s.series === $('r-pick').value);

let renameTimer;
function previewRename() {
  clearTimeout(renameTimer);
  renameTimer = setTimeout(async () => {
    $('r-series').disabled = $('r-same').checked;
    if ($('r-same').checked) $('r-series').value = $('r-title').value;
    const s = pickedSeries();
    const f = renameForm();
    $('r-go').disabled = !(s && f.title && f.series);
    if (!s) { $('r-preview').innerHTML = '<li class="muted">Choose a series</li>'; return; }
    if (!f.series) {
      $('r-preview').innerHTML = s.episodes.map((e) => `<li><span>${esc(e.name)}</span></li>`).join('');
      return;
    }
    const plan = await pilot.planRename({ seriesInfo: s, form: f });
    $('r-preview').innerHTML = plan.map((p) => `<li><span>${esc(p.old)} → ${esc(p.name)}</span><span>${esc(p.line1)}</span></li>`).join('');
  }, 120);
}

async function loadSeries() {
  const r = await pilot.listSeries();
  if (!r.ok) { toast(r.error, true); return; }
  seriesList = r.series;
  cues = r.cues;
  const keep = $('r-pick').value;
  $('r-pick').innerHTML = seriesList.length
    ? seriesList.map((s) => `<option value="${esc(s.series)}">${esc(s.series)} · ${s.count} episode(s), ${s.first}–${s.last}</option>`).join('')
    : '<option value="">No episode series in this project</option>';
  if (seriesList.some((s) => s.series === keep)) $('r-pick').value = keep;
  renderRows();
  previewRename();
}

$('r-refresh').addEventListener('click', loadSeries);
$('r-pick').addEventListener('change', previewRename);
['r-title', 'r-series', 'r-start', 'r-subtitle'].forEach((id) => $(id).addEventListener('input', previewRename));
['r-same', 'r-shownum'].forEach((id) => $(id).addEventListener('change', previewRename));
$('r-go').addEventListener('click', async () => {
  const s = pickedSeries();
  const f = renameForm();
  if (!confirm(`Rename ${s.count} episode(s) of "${s.series}" to "${f.series}"?\nTimeline names and title text will change. The part in brackets stays.`)) return;
  $('r-go').disabled = true;
  const r = await pilot.renameSeries({ seriesInfo: s, form: f });
  $('r-go').disabled = false;
  if (!r.ok) return toast(r.error, true);
  toast(`Renamed ${r.renamed} episode(s)`, r.problems.length > 0);
  loadSeries();
});

// ------------------------------------------------------------------ scene cut queue
let scene = { items: [], running: false };
let sceneTimelines = [];

async function loadSceneTimelines() {
  const r = await pilot.listSeries();
  if (!r.ok) { toast(r.error, true); return; }
  $('s-project').textContent = r.project;
  const all = r.allNames || [];
  sceneTimelines = all;
  $('s-timelines').innerHTML = all.length
    ? all.map((n) => `<label><input type="checkbox" value="${esc(n)}"> ${esc(n)}</label>`).join('')
    : '<div class="empty">No timelines in this project</div>';
  updateSelCount();
}
function selectedTimelines() {
  return [...$('s-timelines').querySelectorAll('input:checked')].map((i) => i.value);
}
function updateSelCount() {
  const n = selectedTimelines().length;
  $('s-add').disabled = !n;
  $('s-selcount').textContent = n ? `${n} selected` : '';
}
$('s-timelines').addEventListener('change', updateSelCount);
$('s-refresh').addEventListener('click', loadSceneTimelines);
$('s-add').addEventListener('click', async () => {
  const r = await pilot.sceneAdd(selectedTimelines());
  if (!r.ok) return toast(r.error, true);
  $('s-timelines').querySelectorAll('input:checked').forEach((i) => { i.checked = false; });
  updateSelCount();
});
$('s-queue').addEventListener('click', (e) => {
  const b = e.target.closest('.s-del');
  if (b) pilot.sceneRemove(Number(b.dataset.i));
});
$('s-clear').addEventListener('click', () => pilot.sceneClear());
$('s-start').addEventListener('click', async () => {
  const r = await pilot.sceneStart();
  if (!r.ok) toast(r.error, true);
});
$('s-stop').addEventListener('click', () => pilot.sceneStop());
$('s-after').addEventListener('change', (e) => save((s) => { s.scene.afterQueue = e.target.value; }));

function renderScene() {
  const labels = { waiting: 'Waiting', running: 'Detecting…', done: 'Done', failed: 'Failed' };
  $('s-queue').innerHTML = scene.items.length
    ? scene.items.map((it, i) => `<tr>
        <td>${esc(it.name)}</td>
        <td><span class="state ${it.state}">${labels[it.state] || it.state}</span></td>
        <td class="muted small">${it.state === 'done' ? `${it.cuts} cut(s) · ${fmtSec(it.seconds)}` : it.state === 'running' ? `started ${time(it.startedAt)}` : esc(it.error || '')}</td>
        <td>${it.state !== 'running' ? `<button class="btn icon s-del" data-i="${i}" title="Remove">✕</button>` : ''}</td></tr>`).join('')
    : '<tr><td colspan="4" class="muted">Empty. Tick timelines above and click "Add selected to queue".</td></tr>';
  const waiting = scene.items.filter((i) => i.state === 'waiting').length;
  $('s-start').disabled = scene.running || !waiting;
  $('s-start').textContent = scene.running ? 'Running…' : `Start queue${waiting ? ` (${waiting})` : ''}`;
  $('s-stop').disabled = !scene.running || scene.stopping;
  $('s-stop').textContent = scene.stopping ? 'Stopping after current…' : 'Stop after current';
  const badge = $('nav-scene-badge');
  badge.classList.toggle('hidden', !scene.running);
  badge.textContent = scene.running ? 'running' : '';
}
const fmtSec = (s) => (s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`);

// ------------------------------------------------------------------ renders
function renderRendersForm() {
  const r = settings.renders;
  $('rn-copy').checked = r.copyEnabled;
  $('rn-dest').value = r.copyDest;
  $('rn-after').value = r.afterQueue;
  $('s-after').value = settings.scene.afterQueue;
  $('enc-after').value = settings.encoder.afterQueue;
  renderCountdowns();
  renderShutdown();
  const hd = r.hd;
  $('hd-on').checked = hd.enabled;
  if (hd.preset && ![...$('hd-preset').options].some((o) => o.value === hd.preset)) {
    $('hd-preset').innerHTML = `<option value="${esc(hd.preset)}">${esc(hd.preset)}</option>`;
  }
  $('hd-preset').value = hd.preset;
  $('hd-dir').value = hd.dir;
  $('hd-suffix').value = hd.suffix;
  $('hd-onlyuhd').checked = hd.onlyUhd;
  $('hd-copy').checked = hd.copyEnabled;
  $('hd-copydest').value = hd.copyDest;
  $('hd-example').textContent = `e.g. DD Vitraag-8911 (1207)${hd.suffix || ''}.<ext from preset>`;
  checkPill('rn-dest', 'rn-dest-check');
  checkPill('hd-dir', 'hd-dir-check');
  checkPill('hd-copydest', 'hd-copy-check');
}
async function checkPill(inputId, pillId) {
  const p = $(inputId).value.trim();
  const pill = $(pillId);
  if (!p) { pill.className = 'pill hidden'; return; }
  const ok = await pilot.checkPath(p);
  pill.className = `pill ${ok ? 'ok' : 'bad'}`;
  pill.textContent = ok ? 'Reachable' : 'Not found';
}
const setHd = (mutate) => save((s) => mutate(s.renders.hd));
$('hd-on').addEventListener('change', (e) => setHd((h) => { h.enabled = e.target.checked; }));
$('hd-preset').addEventListener('change', (e) => setHd((h) => { h.preset = e.target.value; }));
$('hd-load').addEventListener('click', async () => {
  const r = await pilot.renderPresets();
  if (!r.ok) return toast(r.error, true);
  const cur = settings.renders.hd.preset;
  $('hd-preset').innerHTML = '<option value="">Choose a preset…</option>' + r.presets.map((p) => `<option value="${esc(p)}">${esc(p)}</option>`).join('');
  $('hd-preset').value = r.presets.includes(cur) ? cur : '';
  toast(`${r.presets.length} preset(s) loaded from Resolve`);
});
$('hd-dir').addEventListener('change', (e) => setHd((h) => { h.dir = e.target.value.trim(); }));
$('hd-dir-browse').addEventListener('click', async () => {
  const p = await pilot.pickFolder($('hd-dir').value);
  if (p) await setHd((h) => { h.dir = p; });
});
$('hd-suffix').addEventListener('change', (e) => setHd((h) => { h.suffix = e.target.value; }));
$('hd-onlyuhd').addEventListener('change', (e) => setHd((h) => { h.onlyUhd = e.target.checked; }));
$('hd-copy').addEventListener('change', (e) => setHd((h) => { h.copyEnabled = e.target.checked; }));
$('hd-copydest').addEventListener('change', (e) => setHd((h) => { h.copyDest = e.target.value.trim(); }));
$('hd-copy-browse').addEventListener('click', async () => {
  const p = await pilot.pickFolder($('hd-copydest').value);
  if (p) await setHd((h) => { h.copyDest = p; });
});
// Countdown boxes (min + s) next to each "shut down" choice: Scene Cuts and Renders each keep their own.
function fmtCountdown(secs) {
  const m = Math.floor(secs / 60), r = secs % 60;
  if (!m) return `${r} s`;
  return r ? `${m} min ${r} s` : `${m} min`;
}
function renderCountdowns() {
  document.querySelectorAll('.countdown').forEach((el) => {
    const group = el.dataset.for;
    const secs = settings[group].shutdownSeconds;
    el.querySelector('.cd-min').value = Math.floor(secs / 60);
    el.querySelector('.cd-sec').value = secs % 60;
    const select = { scene: $('s-after'), renders: $('rn-after'), encoder: $('enc-after') }[group];   // manual: always shown
    el.classList.toggle('hidden', Boolean(select) && select.value !== 'shutdown');
  });
}
document.querySelectorAll('.countdown').forEach((el) => el.addEventListener('change', () => {
  const m = Math.max(0, Number(el.querySelector('.cd-min').value) || 0);
  const sec = Math.max(0, Math.min(59, Number(el.querySelector('.cd-sec').value) || 0));
  const total = Math.max(10, m * 60 + sec);
  if (m * 60 + sec < 10) toast('The shortest countdown is 10 seconds', true);
  save((s) => { s[el.dataset.for].shutdownSeconds = total; });
}));
$('rn-copy').addEventListener('change', (e) => save((s) => { s.renders.copyEnabled = e.target.checked; }));
$('rn-dest').addEventListener('change', (e) => save((s) => { s.renders.copyDest = e.target.value.trim(); }));
$('rn-browse').addEventListener('click', async () => {
  const p = await pilot.pickFolder($('rn-dest').value);
  if (p) await save((s) => { s.renders.copyDest = p; });
});
$('rn-after').addEventListener('change', (e) => save((s) => { s.renders.afterQueue = e.target.value; }));
function renderCopies(r) {
  $('rn-copies').innerHTML = r.copies.length
    ? r.copies.slice().reverse().map((c) => `<li class="${c.state === 'failed' ? 'error' : ''}">
        <span class="t"><span class="state ${c.state === 'copied' ? 'done' : c.state === 'failed' ? 'failed' : 'running'}">${c.state === 'copying' ? `${c.pct}%` : c.state}</span></span>
        <span class="m">${esc(c.file)}${c.target ? ` → ${esc(c.target)}` : ''}${c.error ? `: ${esc(c.error)}` : ''}</span></li>`).join('')
    : '<li class="muted">None yet</li>';
}

// ------------------------------------------------------------------ shutdown banner
let shutdownAt = null;
let shutdownReason = '';
function renderShutdown() {
  const b = $('shutdown-banner');
  b.classList.toggle('hidden', !shutdownAt);
  const card = $('d-shutdown-card');
  card.classList.toggle('armed', Boolean(shutdownAt));
  $('d-shutdown-cancel').classList.toggle('hidden', !shutdownAt);
  if (shutdownAt) {
    const left = Math.max(0, Math.ceil((shutdownAt - Date.now()) / 1000));
    const clock = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
    $('shutdown-left').textContent = clock;
    $('d-shutdown').textContent = `In ${clock}`;
    $('d-shutdown-sub').textContent = shutdownReason === 'manual' ? 'Started by hand' : `Because the ${shutdownReason}`;
    return;
  }
  // Not counting down: show what's planned.
  const plan = [];
  if (settings.renders.afterQueue === 'shutdown') plan.push(`after renders${settings.renders.hd.enabled ? ' + HD review' : ''} (${fmtCountdown(settings.renders.shutdownSeconds)} countdown)`);
  if (settings.encoder.afterQueue === 'shutdown') plan.push(`after the encoder queue (${fmtCountdown(settings.encoder.shutdownSeconds)} countdown)`);
  if (settings.scene.afterQueue === 'shutdown') plan.push(`after the scene cut queue (${fmtCountdown(settings.scene.shutdownSeconds)} countdown)`);
  $('d-shutdown').textContent = plan.length ? 'Planned' : 'Not planned';
  $('d-shutdown-sub').textContent = plan.length ? `Shuts down ${plan.join(' and ')}` : 'Choose "shut down" on the Renders or Scene Cuts page';
}
$('shutdown-cancel').addEventListener('click', () => pilot.shutdownCancel());
$('d-shutdown-cancel').addEventListener('click', () => pilot.shutdownCancel());

// ------------------------------------------------------------------ notifications
const EVENTS = [
  ['renderDone', 'Each render job finishes'],
  ['queueDone', 'The whole render queue finishes'],
  ['renderCopied', 'A rendered file has been copied'],
  ['renderFailed', 'A render or copy fails'],
  ['sceneDone', 'Scene cuts finish on a timeline'],
  ['sceneQueueDone', 'The scene cut queue finishes'],
  ['encoderGroupDone', 'An encoder group finishes'],
  ['encoderQueueDone', 'The encoder queue finishes'],
  ['shutdown', 'The PC is about to shut down'],
  ['autosaveFailed', 'Auto-save has a problem (e.g. NAS offline)'],
  ['projectCreated', 'A new project is created'],
];

async function renderNotify() {
  const n = settings.notify;
  const has = await pilot.hasSecrets();
  $('nt-tg-on').checked = n.telegram.enabled;
  $('nt-wa-on').checked = n.whapi.enabled;
  for (const [k, id] of [['telegram', 'nt-tg-has'], ['whapi', 'nt-wa-has']]) {
    $(id).className = `pill ${has[k] ? 'ok' : 'bad'}`;
    $(id).textContent = has[k] ? 'Token saved' : 'No token';
  }
  renderChats('telegram', 'nt-tg-chats');
  renderChats('whapi', 'nt-wa-chats');
  $('nt-events').innerHTML = EVENTS.map(([k, label]) =>
    `<label class="check"><input type="checkbox" data-ev="${k}" ${n.events[k] ? 'checked' : ''}> ${label}</label>`).join('');
}

const found = { telegram: [], whapi: [] };
function renderChats(kind, el) {
  const chosen = settings.notify[kind].chats;
  const extra = found[kind].filter((f) => !chosen.some((c) => c.id === f.id));
  $(el).innerHTML = [
    ...chosen.map((c) => `<div class="chat"><span>✔ ${esc(c.name)}</span><span class="muted small">${esc(c.id)}</span>
      <button class="btn icon" data-kind="${kind}" data-del="${esc(c.id)}" title="Stop sending here">✕</button></div>`),
    ...extra.map((c) => `<div class="chat found"><span>${esc(c.name)} <span class="small">(${esc(c.type || '')})</span></span><span class="muted small">${esc(c.id)}</span>
      <button class="btn" data-kind="${kind}" data-add="${esc(c.id)}" data-name="${esc(c.name)}">Send here</button></div>`),
  ].join('') || '<div class="empty small">No chats yet</div>';
}

document.querySelectorAll('.chatlist').forEach((el) => el.addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const kind = b.dataset.kind;
  if (b.dataset.add) {
    await save((s) => { s.notify[kind].chats.push({ id: b.dataset.add, name: b.dataset.name }); });
  } else if (b.dataset.del) {
    await save((s) => { s.notify[kind].chats = s.notify[kind].chats.filter((c) => c.id !== b.dataset.del); });
  }
  renderNotify();
}));

for (const [kind, pre] of [['telegram', 'nt-tg'], ['whapi', 'nt-wa']]) {
  $(`${pre}-on`).addEventListener('change', (e) => save((s) => { s.notify[kind].enabled = e.target.checked; }));
  $(`${pre}-save`).addEventListener('click', async () => {
    await pilot.setSecret(kind, $(`${pre}-token`).value);
    $(`${pre}-token`).value = '';
    toast('Token saved (encrypted)');
    renderNotify();
  });
  $(`${pre}-find`).addEventListener('click', async () => {
    const r = await pilot.findChats(kind);
    if (!r.ok) return toast(r.error, true);
    found[kind] = r.chats;
    if (!r.chats.length) toast(kind === 'telegram' ? 'No chats yet: send the bot a message (or post in the group), then try again' : 'No groups found for this number', true);
    renderNotify();
  });
}
$('nt-wa-add').addEventListener('click', async () => {
  const id = $('nt-wa-phone').value.replace(/[^\d@.a-z]/gi, '');
  if (!id) return toast('Enter a number with country code, e.g. 919876543210', true);
  const name = $('nt-wa-phone-name').value.trim() || id;
  await save((s) => { s.notify.whapi.chats.push({ id, name }); });
  $('nt-wa-phone').value = ''; $('nt-wa-phone-name').value = '';
  renderNotify();
});
$('nt-events').addEventListener('change', (e) => {
  const k = e.target.dataset.ev;
  if (k) save((s) => { s.notify.events[k] = e.target.checked; });
});
$('nt-test').addEventListener('click', async () => {
  $('nt-test').disabled = true;
  const r = await pilot.sendTest();
  $('nt-test').disabled = false;
  toast(r.ok ? `Test sent to ${r.sent} chat(s)` : r.error, !r.ok);
});

// ------------------------------------------------------------------ encoder
let enc = { groups: [], running: false, stopping: false };
let presets = [];                      // from Resolve, loaded on demand
let encStructure = '';

const encCall = async (action, args) => {
  const r = await pilot.encoder(action, args);
  if (!r.ok) toast(r.error, true);
  return r;
};

async function loadPresets(quiet) {
  const r = await pilot.renderPresets();
  if (!r.ok) { if (!quiet) toast(r.error, true); return; }
  presets = r.presets;
  $('enc-presets-info').textContent = `${presets.length} presets from Resolve`;
  encStructure = '';                   // force a full redraw with the new list
  renderEncoder();
}

function presetOptions(selected, inheritLabel) {
  const list = presets.includes(selected) || !selected ? presets : [selected, ...presets];
  const first = inheritLabel !== undefined
    ? `<option value="">${esc(inheritLabel)}</option>`
    : `<option value="">${presets.length ? 'Choose a preset…' : 'Click "Load presets"'}</option>`;
  return first + list.map((p) => `<option value="${esc(p)}" ${p === selected ? 'selected' : ''}>${esc(p)}</option>`).join('');
}

function encStatus(it) {
  if (it.state === 'encoding') {
    return `<span class="bar"><i style="width:${Math.round(it.pct || 0)}%"></i></span>${Math.round(it.pct || 0)}%`;
  }
  if (it.state === 'done') return `<span class="state done">Done</span>${it.tookMs ? ` <span class="muted small">${fmtSec(Math.round(it.tookMs / 1000))}</span>` : ''}`;
  if (it.state === 'failed') return `<span class="state failed">Failed</span><div class="err">${esc(it.error || '')}</div>`;
  return '<span class="state">Waiting</span>';
}

function renderEncoder() {
  const key = JSON.stringify(enc.groups.map((g) => [g.id, g.name, g.preset, g.dir, g.suffix,
    g.items.map((i) => [i.id, i.preset, i.dir, i.state === 'encoding'])]));
  const box = $('enc-groups');
  const typing = document.activeElement && box.contains(document.activeElement) && document.activeElement.tagName === 'INPUT';
  if (key !== encStructure && !typing) {
    encStructure = key;
    box.innerHTML = enc.groups.length ? enc.groups.map((g) => `
      <div class="card enc-group" data-g="${g.id}">
        <div class="enc-sub"><span>Group</span><span>Preset</span><span>Output folder</span><span>Add to name</span><span></span></div>
        <div class="enc-head">
          <input type="text" class="g-name" value="${esc(g.name)}">
          <select class="g-preset">${presetOptions(g.preset)}</select>
          <div class="enc-path"><input type="text" class="g-dir" value="${esc(g.dir)}" placeholder="Output folder"><button class="btn g-browse">…</button></div>
          <input type="text" class="g-suffix" value="${esc(g.suffix)}" placeholder="_HD">
          <div class="btns">
            <button class="btn g-files">+ Files</button>
            <button class="btn g-folder">+ Folder</button>
            <button class="btn icon g-del" title="Remove group">✕</button>
          </div>
        </div>
        ${g.items.length ? `<table class="enc">
          <colgroup><col style="width:34%"><col style="width:22%"><col style="width:24%"><col style="width:13%"><col style="width:7%"></colgroup>
          <thead><tr><th>File</th><th>Preset</th><th>Output folder</th><th>Status</th><th></th></tr></thead>
          <tbody>${g.items.map((it) => `
            <tr data-i="${it.id}">
              <td class="fname" title="${esc(it.file)}">${esc(it.file.split(/[\\/]/).pop())}<small class="i-info">${esc(it.output ? `→ ${it.output}` : it.info || it.file)}</small></td>
              <td><select class="i-preset" ${it.state === 'encoding' ? 'disabled' : ''}>${presetOptions(it.preset, g.preset ? `Group: ${g.preset}` : 'Group preset')}</select></td>
              <td><div class="out">${it.dir ? `<span title="${esc(it.dir)}">${esc(it.dir)}</span><button class="btn icon i-dir-reset" title="Use the group folder">↺</button>` : `<span class="inherit">Group folder</span>`}
                <button class="btn icon i-dir" title="Own output folder">…</button></div></td>
              <td class="state-cell">${encStatus(it)}</td>
              <td>${it.state === 'encoding' ? '' : `${it.state !== 'waiting' ? '<button class="btn icon i-requeue" title="Encode again">↻</button>' : ''}<button class="btn icon i-del" title="Remove">✕</button>`}</td>
            </tr>`).join('')}</tbody></table>`
          : '<div class="enc-empty">Drop video files or folders here, or use + Files / + Folder</div>'}
      </div>`).join('')
      : '<div class="card enc-empty">No groups yet. Click <b>+ New group</b>, choose a preset and output folder, then add files.</div>';
  } else {
    // Only progress/status changed: update those cells, leave inputs alone.
    for (const g of enc.groups) for (const it of g.items) {
      const row = box.querySelector(`tr[data-i="${it.id}"]`);
      if (!row) continue;
      row.querySelector('.state-cell').innerHTML = encStatus(it);
      row.querySelector('.i-info').textContent = it.output ? `→ ${it.output}` : it.info || it.file;
    }
  }
  const waiting = enc.groups.reduce((n, g) => n + g.items.filter((i) => i.state === 'waiting').length, 0);
  $('enc-start').disabled = enc.running || !waiting;
  $('enc-start').textContent = enc.running ? 'Encoding…' : `Start queue${waiting ? ` (${waiting})` : ''}`;
  $('enc-stop').disabled = !enc.running || enc.stopping;
  $('enc-stop').textContent = enc.stopping ? 'Stopping after current…' : 'Stop after current';
  const badge = $('nav-enc-badge');
  badge.classList.toggle('hidden', !enc.running);
  badge.textContent = enc.running ? 'running' : '';
}

const groupOf = (el) => el.closest('.enc-group')?.dataset.g;
const itemOf = (el) => el.closest('tr[data-i]')?.dataset.i;

$('enc-groups').addEventListener('change', (e) => {
  const g = groupOf(e.target);
  if (!g) return;
  const t = e.target;
  if (t.classList.contains('g-name')) encCall('updateGroup', { id: g, fields: { name: t.value.trim() || 'Group' } });
  if (t.classList.contains('g-preset')) encCall('updateGroup', { id: g, fields: { preset: t.value } });
  if (t.classList.contains('g-dir')) encCall('updateGroup', { id: g, fields: { dir: t.value.trim() } });
  if (t.classList.contains('g-suffix')) encCall('updateGroup', { id: g, fields: { suffix: t.value } });
  if (t.classList.contains('i-preset')) encCall('updateItem', { group: g, id: itemOf(t), fields: { preset: t.value } });
});

$('enc-groups').addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const g = groupOf(b);
  const grp = enc.groups.find((x) => x.id === g);
  if (b.classList.contains('g-browse')) {
    const p = await pilot.pickFolder(grp?.dir);
    if (p) encCall('updateGroup', { id: g, fields: { dir: p } });
  } else if (b.classList.contains('g-files')) {
    const files = await pilot.pickFiles();
    if (files.length) encCall('addPaths', { id: g, paths: files });
  } else if (b.classList.contains('g-folder')) {
    const dir = await pilot.pickFolder();
    if (dir) {
      const r = await encCall('addPaths', { id: g, paths: [dir] });
      if (r.ok) toast(`${r.result.added} video file(s) added`);
    }
  } else if (b.classList.contains('g-del')) {
    if (!grp.items.length || confirm(`Remove group "${grp.name}" and its ${grp.items.length} file(s) from the queue?\n(The files themselves are not touched.)`)) encCall('removeGroup', { id: g });
  } else if (b.classList.contains('i-dir')) {
    const p = await pilot.pickFolder(grp?.dir);
    if (p) encCall('updateItem', { group: g, id: itemOf(b), fields: { dir: p } });
  } else if (b.classList.contains('i-dir-reset')) {
    encCall('updateItem', { group: g, id: itemOf(b), fields: { dir: '' } });
  } else if (b.classList.contains('i-requeue')) {
    encCall('updateItem', { group: g, id: itemOf(b), fields: { requeue: true } });
  } else if (b.classList.contains('i-del')) {
    encCall('removeItem', { group: g, id: itemOf(b) });
  }
});

// Drag & drop files/folders onto a group card.
$('enc-groups').addEventListener('dragover', (e) => {
  const card = e.target.closest('.enc-group');
  if (!card) return;
  e.preventDefault();
  card.classList.add('drop');
});
$('enc-groups').addEventListener('dragleave', (e) => {
  const card = e.target.closest('.enc-group');
  if (card && !card.contains(e.relatedTarget)) card.classList.remove('drop');
});
$('enc-groups').addEventListener('drop', async (e) => {
  const card = e.target.closest('.enc-group');
  if (!card) return;
  e.preventDefault();
  card.classList.remove('drop');
  const paths = [...e.dataTransfer.files].map((f) => pilot.pathForFile(f)).filter(Boolean);
  if (!paths.length) return;
  const r = await encCall('addPaths', { id: card.dataset.g, paths });
  if (r.ok) toast(`${r.result.added} video file(s) added${r.result.skipped ? `, ${r.result.skipped} skipped (not video)` : ''}`);
});
// Dropping outside a group must not open the file in the window.
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());

$('enc-add-group').addEventListener('click', async () => {
  const last = enc.groups[enc.groups.length - 1];
  await encCall('addGroup', { preset: last?.preset || '', dir: last?.dir || '' });
});
$('enc-load-presets').addEventListener('click', () => loadPresets(false));
$('enc-start').addEventListener('click', async () => {
  const r = await pilot.encoder('start');
  if (!r.ok) toast(r.error, true);
});
$('enc-stop').addEventListener('click', () => encCall('stop'));
$('enc-clear').addEventListener('click', () => encCall('clearFinished'));
$('enc-after').addEventListener('change', (e) => save((s) => { s.encoder.afterQueue = e.target.value; }));

// ------------------------------------------------------------------ start
(async () => {
  const init = await pilot.getInitial();
  ({ settings, status, autosave } = init);
  pcName = init.pc;
  logEntries = init.log;
  $('pc-name').textContent = init.pc;
  $('app-version').textContent = `v${init.version}`;
  $('s-about').textContent = `AV PostPilot v${init.version} · this PC: ${init.pc}`;
  renderDashboard();
  renderAutosaveForm();
  renderSettingsForm();
  renderLog();
  $('n-location').value = settings.project.location || '';
  document.querySelector(`input[name=n-move][value=${settings.project.move === false ? 'copy' : 'move'}]`).checked = true;
  $('e-title').value = settings.series.title || '';
  $('e-subtitle').value = settings.series.subtitle || '';
  $('e-size').value = settings.series.size || 0.11;
  scene = init.scene;
  shutdownAt = init.shutdownAt;
  shutdownReason = init.shutdownReason || '';
  renderScene();
  renderCopies(init.renders);
  renderRendersForm();
  renderShutdown();
  pilot.onScene((s) => { scene = s; renderScene(); });
  enc = init.encoder;
  renderEncoder();
  pilot.onEncoder((e) => { enc = e; renderEncoder(); });
  pilot.onRenders(renderCopies);
  pilot.onShutdown((s) => { shutdownAt = s.at; shutdownReason = s.reason || ''; renderShutdown(); });
  setInterval(renderShutdown, 500);
  renderNewProject();
  renderRows();
  previewSeries();
  previewRename();
  if (!settings.autosave.destinations.length) go('autosave');

  let lastProject = null;
  pilot.onStatus((s) => {
    status = s;
    renderDashboard();
    const key = s.project ? `${s.project.dbName}|${s.project.name}` : '';
    if (key !== lastProject) {
      lastProject = key;
      $('e-project').textContent = s.project?.name || 'no project open';
      renderNewProject();
    }
  });
  pilot.onProjectProgress((p) => {
    $('n-progress-msg').textContent = p.msg;
    if (p.total) $('n-bar').style.width = `${Math.round((p.done / p.total) * 100)}%`;
  });
  pilot.onAutosave((a) => { autosave = a; renderDashboard(); });
  pilot.onSettings((s) => { settings = s; renderAutosaveForm(); renderDashboard(); });
  pilot.onLog((e) => { logEntries.push(e); if (logEntries.length > 500) logEntries.shift(); renderLog(); });
  setInterval(renderDashboard, 1000);   // countdown
})();
