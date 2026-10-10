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
  renderNewProject();
  renderDashboard();
}

// ------------------------------------------------------------------ navigation
function go(page) {
  document.querySelectorAll('.nav').forEach((b) => b.classList.toggle('active', b.dataset.page === page));
  document.querySelectorAll('.page').forEach((p) => p.classList.toggle('active', p.id === `page-${page}`));
  try { localStorage.setItem('last-page', page); } catch {}
  if (page === 'autosave') refreshDestChecks();
  if (page === 'newproject') renderNewProject();
  if (page === 'notify') renderNotify();
  if (page === 'librarybackup') { renderLibraryForm(); refreshLibraryStatus(); }
  if (page === 'renders') renderRendersForm();
  if (page === 'encoder' && !presets.length && status.connected) loadPresets(true);
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
  $('s-clipinfo').checked = settings.clipInfo;
  $('s-clipkey').value = (settings.clipInfoKey || '').replace('Control', 'Ctrl');
}
$('s-resolve').addEventListener('change', (e) => save((s) => { s.resolvePath = e.target.value.trim(); }));
$('s-resolve-browse').addEventListener('click', async () => {
  const p = await pilot.pickResolve();
  if (p) await save((s) => { s.resolvePath = p; });
});
$('s-launch').addEventListener('change', (e) => save((s) => { s.launchResolve = e.target.checked; }));
$('s-hidden').addEventListener('change', (e) => save((s) => { s.startHidden = e.target.checked; }));
$('s-clipinfo').addEventListener('change', (e) => save((s) => { s.clipInfo = e.target.checked; }));
$('s-clipkey').addEventListener('keydown', (e) => {
  e.preventDefault();
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
  const key = e.key.length === 1 ? e.key.toUpperCase() : /^F\d+$/.test(e.key) ? e.key : '';
  const mods = [e.ctrlKey && 'Control', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Command'].filter(Boolean);
  if (!key || (!mods.length && !/^F\d+$/.test(key))) return toast('Use a modifier (Ctrl/Alt/Shift) with a letter, or an F-key', true);
  save((s) => { s.clipInfoKey = [...mods, key].join('+'); });
});
$('s-clipkey-clear').addEventListener('click', () => save((s) => { s.clipInfoKey = ''; }));

// ------------------------------------------------------------------ actions
$('d-save-now').addEventListener('click', async () => {
  const r = await pilot.saveNow();
  toast(r.message, !r.ok);
});
$('d-open-resolve').addEventListener('click', () => pilot.launchResolve());
$('l-open').addEventListener('click', () => pilot.openLog());

// ------------------------------------------------------------------ new project
let days = [];   // scan results

// Folder template, remembered in settings for every new project.
// "Satsang Files" is required unless footage is left where it is.
const footageMode = () => document.querySelector('input[name=n-move]:checked')?.value || 'move';
const isSatsang = (f) => f.toLowerCase() === 'satsang files';
function projectFolderList() {
  const list = [...(settings.project.folders || [])];
  if (footageMode() !== 'leave' && !list.some(isSatsang)) list.push('Satsang Files');
  return list;
}
$('n-folders').addEventListener('click', (e) => {
  const b = e.target.closest('[data-del-folder]');
  if (!b) return;
  const name = b.dataset.delFolder;
  if (isSatsang(name) && footageMode() !== 'leave') {
    toast('Satsang Files can only be removed with "Leave where it is": the footage is moved or copied into that folder.', true);
    return;
  }
  save((s) => { s.project.folders = projectFolderList().filter((f) => f !== name); });
});
document.querySelectorAll('input[name=n-move]').forEach((r) => r.addEventListener('change', () => {
  const back = r.value !== 'leave' && !(settings.project.folders || []).some(isSatsang);
  save((s) => {
    s.project.footage = r.value;
    if (back) s.project.folders = [...(s.project.folders || []), 'Satsang Files'];
  });
  if (back) toast('Satsang Files is back in the folder list: footage is moved or copied into it');
}));
function addProjectFolder() {
  const name = $('n-folder-new').value.trim();
  if (!name) return;
  if (/[<>:"/\\|?*]/.test(name)) return toast('A folder name can\'t contain < > : " / \\ | ? *', true);
  if (projectFolderList().some((f) => f.toLowerCase() === name.toLowerCase())) return toast('That folder is already in the list', true);
  $('n-folder-new').value = '';
  save((s) => { s.project.folders = [...projectFolderList(), name]; });
}
$('n-folder-add').addEventListener('click', addProjectFolder);
$('n-folder-new').addEventListener('keydown', (e) => { if (e.key === 'Enter') addProjectFolder(); });

function projectRoot() {
  const name = $('n-name').value.trim();
  const loc = $('n-location').value.trim().replace(/[\\/]+$/, '');
  return name && loc ? `${loc}\\${name}` : '';
}

function renderNewProject() {
  const root = projectRoot();
  $('n-root').textContent = root || '—';
  // Every folder can be removed; Satsang Files only with "Leave where it is" (the click explains why).
  $('n-folders').innerHTML = projectFolderList().map((f) => `<span class="chip">${esc(f)} <button class="chip-x" data-del-folder="${esc(f)}" title="${isSatsang(f) && footageMode() !== 'leave' ? 'Needed: footage is moved or copied here' : 'Remove from the template'}">✕</button></span>`).join('');
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
  const footage = footageMode();
  const usable = days.filter((d) => d.sessions.length);
  if (!usable.length) return toast('Add at least one satsang folder with clips', true);
  const root = projectRoot();
  if (!root) return toast('Enter the project name and location', true);
  const what = footage === 'leave'
    ? `use ${usable.length} folder(s) from where they are (nothing is moved or copied)`
    : `${footage === 'move' ? 'move (same drive) or copy (other drive)' : 'copy'} ${usable.length} folder(s) into:\n${root}\\Satsang Files`;
  if (!confirm(`Create "${$('n-name').value.trim()}"?\n\nThis will ${what}\n\nNothing is ever deleted. Then the project is created in Resolve.`)) return;
  $('n-create').disabled = true;
  $('n-progress').classList.remove('hidden');
  const r = await pilot.createProject({ name: $('n-name').value, location: $('n-location').value.trim(), days: usable.map((d) => d.dir), footage });
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
    background: document.querySelector('input[name=e-bg]:checked')?.value || 'plain',
    barsImage,
  };
}

// Title background: plain black, or colour bars (Resolve's SMPTE bars or the user's picture).
let barsImage = '';
function renderBars() {
  const bars = (document.querySelector('input[name=e-bg]:checked')?.value) === 'bars';
  $('e-bars-row').classList.toggle('hidden', !bars);
  $('e-bars-name').textContent = barsImage || 'Resolve SMPTE colour bars (made automatically at the project resolution)';
  $('e-bars-reset').classList.toggle('hidden', !barsImage);
}
document.querySelectorAll('input[name=e-bg]').forEach((r) => r.addEventListener('change', () => {
  renderBars();
  save((s) => { s.series.background = r.value; });
}));
$('e-bars-pick').addEventListener('click', async () => {
  const p = await pilot.pickImage();
  if (!p) return;
  barsImage = p;
  renderBars();
  save((s) => { s.series.barsImage = p; });
});
$('e-bars-reset').addEventListener('click', () => {
  barsImage = '';
  renderBars();
  save((s) => { s.series.barsImage = ''; });
});

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
// ------------------------------------------------------------------ series name suggestions
// Inline completion: typing shows the rest of the first matching name selected;
// Tab (or Enter) accepts it with the name's own spelling. The <datalist> dropdown
// also offers every name that contains the typed text.
let seriesNames = [];
async function loadSeriesNames() {
  const r = await pilot.seriesNames();
  seriesNames = r.names;
  $('e-names-info').textContent = `${r.names.length} series names for suggestions (${r.custom ? 'from your file' : 'built-in list'}). Type a few letters, Tab completes.`;
  $('series-names').innerHTML = r.names.map((n) => `<option value="${esc(n)}">`).join('');
}
function suggestionFor(typed) {
  if (!typed) return null;
  const t = typed.toLowerCase();
  const pool = [...seriesNames, ...seriesList.map((s) => s.series)];
  return pool.find((n) => n.toLowerCase().startsWith(t) && n.length > typed.length) || null;
}
document.querySelectorAll('input.suggest').forEach((input) => {
  input.addEventListener('input', (e) => {
    if (!e.inputType || e.inputType.startsWith('delete')) return;     // let Backspace/Delete work normally
    if (input.selectionStart !== input.value.length) return;          // only when typing at the end
    const typed = input.value;
    const match = suggestionFor(typed);
    if (!match) return;
    input.value = typed + match.slice(typed.length);
    input.setSelectionRange(typed.length, match.length);
    input.dataset.match = match;
  });
  input.addEventListener('keydown', (e) => {
    const hasHint = input.selectionStart < input.selectionEnd && input.selectionEnd === input.value.length && input.dataset.match;
    if (!hasHint || (e.key !== 'Tab' && e.key !== 'Enter')) return;
    e.preventDefault();
    input.value = input.dataset.match;                                // the list's own capitals
    input.setSelectionRange(input.value.length, input.value.length);
    delete input.dataset.match;
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new Event('change'));
  });
});
$('e-names-import').addEventListener('click', async () => {
  const r = await pilot.importSeriesNames();
  if (r.canceled) return;
  if (!r.ok) return toast(r.error, true);
  toast(`Series list updated: ${r.count} names`);
  loadSeriesNames();
});

function addEpisodeRow() {
  erows.push({ cue: '', count: 1 });
  activeRow = erows.length - 1;
  renderRows(); previewSeries();
  $('e-rows').querySelectorAll('.e-cue')[activeRow]?.focus();      // ready to type the next folder
}
$('e-addrow').addEventListener('click', addEpisodeRow);
// Enter in the last row adds a new row; in other rows it jumps to the next row.
$('e-rows').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || !e.target.matches('.e-cue, .e-count')) return;
  e.preventDefault();
  const i = Number(e.target.closest('.erow').dataset.i);
  if (i === erows.length - 1) addEpisodeRow();
  else $('e-rows').querySelectorAll('.e-cue')[i + 1]?.focus();
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
  $('st-after').value = settings.stab.afterQueue; $('st-remove-markers').checked = Boolean(settings.stab.removeMarkers);
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
    const select = { scene: $('s-after'), renders: $('rn-after'), encoder: $('enc-after'), stab: $('st-after') }[group];   // manual: always shown
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
  if (settings.stab?.afterQueue === 'shutdown') plan.push(`after the stabilization queue (${fmtCountdown(settings.stab.shutdownSeconds)} countdown)`);
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
  ['stabQueueDone', 'The stabilization queue finishes'],
  ['shutdown', 'The PC is about to shut down'],
  ['autosaveFailed', 'Auto-save has a problem (e.g. NAS offline)'],
  ['projectCreated', 'A new project is created'],
  ['libraryBackupDone', 'Library database backup finishes successfully'],
  ['libraryBackupFailed', 'Library database backup fails or has copy errors'],
  ['libraryAlert', 'A library disappears or its project count drops'],
  ['libraryBackupOverdue', 'Library backup is overdue (age limit in Library Backup)'],
];

async function renderNotify() {
  const n = settings.notify;
  const has = await pilot.hasSecrets();
  $('nt-tg-on').checked = n.telegram.enabled;
  $('nt-wa-on').checked = n.whapi.enabled;
  $('nt-ntfy-on').checked = n.ntfy.enabled;
  $('nt-email-on').checked = n.email.enabled;
  if (document.activeElement !== $('nt-email-user')) $('nt-email-user').value = n.email.user || '';
  renderDestinations('email', 'nt-email-targets', n.email.recipients || []);
  $('nt-email-has').className = `pill ${has.email ? 'ok' : 'bad'}`;
  $('nt-email-has').textContent = has.email ? 'Password saved' : 'No password';
  renderNtfyTopics();
  if (document.activeElement !== $('nt-ntfy-server')) $('nt-ntfy-server').value = n.ntfy.server || 'https://ntfy.sh';
  for (const [k, id] of [['telegram', 'nt-tg-has'], ['whapi', 'nt-wa-has'], ['ntfy', 'nt-ntfy-has']]) {
    $(id).className = `pill ${has[k] ? 'ok' : 'bad'}`;
    $(id).textContent = has[k] ? 'Token saved' : 'No token';
  }
  if (!has.ntfy) $('nt-ntfy-has').className = 'pill hidden';    // optional for ntfy
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
// ---- ntfy
const NTFY_TOPIC = /^[-_A-Za-z0-9]{1,64}$/;
function ntfyTopicList() { return settings.notify.ntfy.topics || []; }
function renderDestinations(kind, element, values) {
  const config = settings.notify[kind];
  $(element).innerHTML = values.map(value => {
    const target = config.targets?.[value] || {};
    return `<div class="notify-destination"><span class="chip ${target.enabled === false ? 'destination-off' : ''}"><label><input type="checkbox" data-target-on="${esc(value)}" data-target-kind="${kind}" ${target.enabled === false ? '' : 'checked'} aria-label="Send to ${esc(value)}"></label><button class="link" ${kind === 'ntfy' ? `data-copy-topic="${esc(value)}" title="Copy topic name"` : 'type="button"'}>${esc(value)}</button><button class="chip-x" data-target-delete="${esc(value)}" data-target-kind="${kind}" title="Remove destination">✕</button></span><details><summary>Alerts</summary><div class="destination-events">${EVENTS.map(([event, label]) => `<label class="check"><input type="checkbox" data-target-event="${event}" data-target-value="${esc(value)}" data-target-kind="${kind}" ${target.events?.[event] === false ? '' : 'checked'}> ${esc(label)}${settings.notify.events[event] ? '' : ' (off globally)'}</label>`).join('')}</div></details></div>`;
  }).join('') || '<div class="empty small">No saved destinations yet.</div>';
}
for (const element of ['nt-ntfy-topics', 'nt-email-targets']) {
  $(element).addEventListener('change', async e => {
    const t = e.target, kind = t.dataset.targetKind;
    if (!kind) return;
    await save(s => {
      const config = s.notify[kind]; config.targets ||= {};
      const value = t.dataset.targetOn || t.dataset.targetValue;
      config.targets[value] ||= {};
      if (t.dataset.targetOn) config.targets[value].enabled = t.checked;
      else { config.targets[value].events ||= {}; config.targets[value].events[t.dataset.targetEvent] = t.checked; }
    });
    if (t.dataset.targetOn) t.closest('.chip').classList.toggle('destination-off', !t.checked);
  });
  $(element).addEventListener('click', async e => {
    const b = e.target.closest('[data-target-delete]');
    if (!b) return;
    await save(s => {
      const config = s.notify[b.dataset.targetKind], value = b.dataset.targetDelete;
      const field = b.dataset.targetKind === 'ntfy' ? 'topics' : 'recipients';
      config[field] = config[field].filter(v => v !== value);
      if (config.targets) delete config.targets[value];
      if (!config[field].length) config.enabled = false;
    });
    await renderNotify();
  });
}
function renderNtfyTopics() {
  renderDestinations('ntfy', 'nt-ntfy-topics', ntfyTopicList());
}
async function addNtfyTopic(value) {
  const topic = (typeof value === 'string' ? value : $('nt-ntfy-topic').value).trim();
  if (!NTFY_TOPIC.test(topic)) return toast('Topic: letters, numbers, - and _ only (up to 64)', true);
  if (ntfyTopicList().includes(topic)) return toast('That topic is already in the list', true);
  await save((s) => { s.notify.ntfy.topics = [...ntfyTopicList(), topic]; delete s.notify.ntfy.topic; });
  $('nt-ntfy-topic').value = '';
  renderNtfyTopics();
}
$('nt-ntfy-add').addEventListener('click', addNtfyTopic);
$('nt-ntfy-topic').addEventListener('keydown', (e) => { if (e.key === 'Enter') addNtfyTopic(); });
$('nt-ntfy-topics').addEventListener('click', async (e) => {
  const button = e.target.closest('button');
  if (!button) return;
  if (button.dataset.copyTopic) {
    await navigator.clipboard.writeText(button.dataset.copyTopic);
    toast('Topic copied');
  } else if (button.dataset.delTopic) {
    await save((s) => {
      s.notify.ntfy.topics = ntfyTopicList().filter((t) => t !== button.dataset.delTopic);
      delete s.notify.ntfy.topic;
      if (!s.notify.ntfy.topics.length) s.notify.ntfy.enabled = false;
    });
    await renderNotify();
  }
});
$('nt-ntfy-on').addEventListener('change', (e) => {
  if (e.target.checked && !ntfyTopicList().length) {
    e.target.checked = false;
    return toast('Add at least one topic first', true);
  }
  save((s) => { s.notify.ntfy.enabled = e.target.checked; });
});
$('nt-ntfy-gen').addEventListener('click', async () => {
  const rnd = [...crypto.getRandomValues(new Uint8Array(6))].map((b) => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31]).join('');
  const t = `av-studio-${rnd}`;
  await addNtfyTopic(t);
  toast(`Topic "${t}" saved. Subscribe to it in the ntfy app.`);
});
$('nt-ntfy-server').addEventListener('change', (e) => save((s) => { s.notify.ntfy.server = e.target.value.trim() || 'https://ntfy.sh'; }));
$('nt-ntfy-save').addEventListener('click', async () => {
  await pilot.setSecret('ntfy', $('nt-ntfy-token').value);
  $('nt-ntfy-token').value = '';
  toast('Token saved (encrypted)');
  renderNotify();
});

// ---- Gmail email (credentials go only through the encrypted secret store)
const EMAIL_ADDRESS = /^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/;
function emailForm() {
  const user = $('nt-email-user').value.trim();
  const recipients = settings.notify.email.recipients || [];
  if (!EMAIL_ADDRESS.test(user)) throw new Error('Enter your Gmail sender address');
  if (!recipients.length || recipients.some((r) => !EMAIL_ADDRESS.test(r))) throw new Error('Enter recipient email addresses separated by commas');
  return { user, recipients };
}
async function saveEmailForm() {
  const fields = emailForm();
  await save((s) => Object.assign(s.notify.email, fields));
}
async function addEmailRecipients() {
  const values = $('nt-email-recipients').value.split(/[,;\n]+/).map(v => v.trim().toLowerCase()).filter(Boolean);
  if (!values.length) return;
  if (values.some(v => !EMAIL_ADDRESS.test(v))) return toast('Enter valid plain email addresses', true);
  await save(s => { s.notify.email.recipients = [...new Set([...(s.notify.email.recipients || []), ...values])]; });
  $('nt-email-recipients').value = '';
  renderDestinations('email', 'nt-email-targets', settings.notify.email.recipients);
}
$('nt-email-add').addEventListener('click', addEmailRecipients);
$('nt-email-recipients').addEventListener('keydown', e => { if (e.key === 'Enter') addEmailRecipients(); });
for (const id of ['nt-email-user']) {
  $(id).addEventListener('change', () => save((s) => {
    s.notify.email.user = $('nt-email-user').value.trim();
  }));
}
$('nt-email-on').addEventListener('change', async (e) => {
  const enabled = e.target.checked;
  try {
    if (enabled) {
      await saveEmailForm();
      if (!(await pilot.hasSecrets()).email) throw new Error('Save a Google App Password first');
    }
    await save((s) => { s.notify.email.enabled = enabled; });
  } catch (err) { e.target.checked = false; toast(err.message, true); }
});
$('nt-email-save').addEventListener('click', async () => {
  const password = $('nt-email-password').value.replace(/\s/g, '');
  if (!/^[A-Za-z]{16}$/.test(password)) return toast('Enter the 16-letter Google App Password, not your Gmail password', true);
  try {
    await pilot.setSecret('email', password);
    $('nt-email-password').value = '';
    toast('App Password saved (encrypted)');
    await renderNotify();
  } catch (err) { toast(err.message, true); }
});
$('nt-email-clear').addEventListener('click', async () => {
  await pilot.setSecret('email', '');
  await save((s) => { s.notify.email.enabled = false; });
  $('nt-email-password').value = '';
  await renderNotify();
  toast('Email password removed; email alerts switched off');
});
async function testNotifications(button, only) {
  button.disabled = true;
  try {
    if (only === 'email' || (!only && settings.notify.email.enabled)) await saveEmailForm();
    const r = await pilot.sendTest(only);
    toast(r.ok ? `Test accepted by ${r.sent} destination(s). Check your phone or inbox.` : `${r.sent ? `${r.sent} destination(s) accepted the test. ` : ''}${r.error}`, !r.ok);
  } catch (err) { toast(err.message, true); }
  finally { button.disabled = false; }
}
$('nt-ntfy-test').addEventListener('click', (e) => testNotifications(e.currentTarget, 'ntfy'));
$('nt-email-test').addEventListener('click', (e) => testNotifications(e.currentTarget, 'email'));

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
$('nt-test').addEventListener('click', (e) => testNotifications(e.currentTarget));

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
  if (it.state === 'done') return `<span class="state done">Done</span>${it.tookMs ? ` <span class="muted small">${fmtSec(Math.round(it.tookMs / 1000))}</span>` : ''}${it.copyState === 'copying' ? '<div class="muted small">Copying…</div>' : it.copyState === 'copied' ? `<div class="small" title="${esc(it.copiedTo)}">Copied</div>` : it.copyState === 'failed' ? `<div class="err">Copy failed: ${esc(it.copyError)}</div>` : ''}`;
  if (it.state === 'failed') return `<span class="state failed">Failed</span><div class="err">${esc(it.error || '')}</div>`;
  return '<span class="state">Waiting</span>';
}

function renderEncoder() {
  const key = JSON.stringify(enc.groups.map((g) => [g.id, g.name, g.preset, g.dir, g.suffix, g.copyEnabled, g.copyDir,
    g.items.map((i) => [i.id, i.preset, i.dir, i.state === 'encoding'])]));
  const box = $('enc-groups');
  const typing = document.activeElement && box.contains(document.activeElement) && document.activeElement.matches('input[type="text"]');
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
        <div class="enc-copy"><label><input type="checkbox" class="g-copy-enabled" ${g.copyEnabled ? 'checked' : ''}> Copy finished files</label><div class="enc-path ${g.copyEnabled ? '' : 'hidden'}"><input type="text" class="g-copy-dir" value="${esc(g.copyDir || '')}" placeholder="Copy destination folder" ${g.copyEnabled ? '' : 'disabled'}><button class="btn g-copy-browse" ${g.copyEnabled ? '' : 'disabled'}>Browse…</button></div></div>
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
  markSelected();
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
  if (t.classList.contains('g-copy-enabled')) {
    const row = t.closest('.enc-copy').querySelector('.enc-path');
    row.classList.toggle('hidden', !t.checked);
    row.querySelector('.g-copy-dir').disabled = !t.checked;
    row.querySelector('.g-copy-browse').disabled = !t.checked;
    if (!t.checked) row.querySelector('.g-copy-dir').value = '';
    encCall('updateGroup', { id: g, fields: { copyEnabled: t.checked } });
  }
  if (t.classList.contains('g-copy-dir')) encCall('updateGroup', { id: g, fields: { copyDir: t.value.trim() } });
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
  } else if (b.classList.contains('g-copy-browse')) {
    const p = await pilot.pickFolder(grp?.copyDir);
    if (p) encCall('updateGroup', { id: g, fields: { copyDir: p } });
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

// ---- selected group: the target of + Add Files / + Add Folder
let selectedGroup = null;
function currentGroupId() {
  if (enc.groups.some((g) => g.id === selectedGroup)) return selectedGroup;
  return enc.groups.length ? enc.groups[enc.groups.length - 1].id : null;
}
function markSelected() {
  const id = currentGroupId();
  document.querySelectorAll('.enc-group').forEach((c) => c.classList.toggle('selected', c.dataset.g === id));
}
$('enc-groups').addEventListener('mousedown', (e) => {
  const card = e.target.closest('.enc-group');
  if (card) { selectedGroup = card.dataset.g; markSelected(); }
});

// New group: same preset/folder as the selected one, so only what differs needs changing.
async function newGroup() {
  const from = enc.groups.find((g) => g.id === currentGroupId());
  const r = await encCall('addGroup', { preset: from?.preset || '', dir: from?.dir || '' });
  if (r.ok) { selectedGroup = r.result.id; markSelected(); }
  return r.ok ? r.result.id : null;
}
async function addToGroup(groupId, paths) {
  const id = groupId || currentGroupId() || await newGroup();
  if (!id || !paths.length) return;
  const r = await encCall('addPaths', { id, paths });
  if (r.ok) {
    selectedGroup = id;
    markSelected();
    toast(`${r.result.added} video file(s) added${r.result.skipped ? `, ${r.result.skipped} skipped (not video)` : ''}`);
  }
}

// ---- drag & drop: onto a group = add to it; anywhere else on the page = new group
const encPage = $('page-encoder');
encPage.addEventListener('dragover', (e) => {
  e.preventDefault();
  const card = e.target.closest('.enc-group');
  document.querySelectorAll('.enc-group.drop').forEach((c) => { if (c !== card) c.classList.remove('drop'); });
  if (card) card.classList.add('drop');
  encPage.classList.toggle('drop-new', !card);
});
encPage.addEventListener('dragleave', (e) => {
  if (!encPage.contains(e.relatedTarget)) {
    encPage.classList.remove('drop-new');
    document.querySelectorAll('.enc-group.drop').forEach((c) => c.classList.remove('drop'));
  }
});
encPage.addEventListener('drop', async (e) => {
  e.preventDefault();
  encPage.classList.remove('drop-new');
  document.querySelectorAll('.enc-group.drop').forEach((c) => c.classList.remove('drop'));
  const paths = [...e.dataTransfer.files].map((f) => pilot.pathForFile(f)).filter(Boolean);
  if (!paths.length) return;
  const card = e.target.closest('.enc-group');
  await addToGroup(card ? card.dataset.g : await newGroup(), paths);
});
// Dropping anywhere else in the window must not open the file in it.
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());

$('enc-add-group').addEventListener('click', newGroup);
$('enc-add-files').addEventListener('click', async () => {
  const files = await pilot.pickFiles();
  if (files.length) await addToGroup(null, files);
});
$('enc-add-folder').addEventListener('click', async () => {
  const dir = await pilot.pickFolder();
  if (dir) await addToGroup(null, [dir]);
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
const LIBRARY_FIELDS = ['mode', 'root', 'staleHours', 'pgBin', 'host', 'port', 'user', 'copyRoot', 'times', 'keepDays', 'keepMin'];
let libraryTimeEditing = null;
const libraryTimeList = () => [...new Set($('lb-times').value.split(/[,\s]+/).filter(Boolean))].sort();
function libraryTimeLabel(time) {
  const [h, m] = time.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}
function renderLibraryTimes() {
  $('lb-time-chips').innerHTML = libraryTimeList().map(time => `<span class="chip"><button class="link" data-edit-time="${esc(time)}" title="Edit time">${esc(libraryTimeLabel(time))}</button> <button class="chip-x" data-remove-time="${esc(time)}" aria-label="Remove ${esc(libraryTimeLabel(time))}">×</button></span>`).join('');
}
function resetLibraryTimeEditor() {
  libraryTimeEditing = null;
  $('lb-time-add').textContent = '+ Add time';
  $('lb-time-editor-label').textContent = 'Add a time';
  $('lb-time-cancel').classList.add('hidden');
}
$('lb-time-hour').innerHTML = Array.from({ length: 12 }, (_, i) => `<option>${i + 1}</option>`).join('');
$('lb-time-minute').innerHTML = Array.from({ length: 60 }, (_, i) => `<option>${String(i).padStart(2, '0')}</option>`).join('');
$('lb-time-hour').value = '9';
$('lb-time-chips').addEventListener('click', async e => {
  const edit = e.target.closest('[data-edit-time]');
  const remove = e.target.closest('[data-remove-time]');
  if (edit) {
    libraryTimeEditing = edit.dataset.editTime;
    const [h, m] = libraryTimeEditing.split(':').map(Number);
    $('lb-time-hour').value = String(h % 12 || 12);
    $('lb-time-minute').value = String(m).padStart(2, '0');
    $('lb-time-period').value = h >= 12 ? 'PM' : 'AM';
    $('lb-time-add').textContent = 'Save time';
    $('lb-time-editor-label').textContent = 'Edit time';
    $('lb-time-cancel').classList.remove('hidden');
  }
  if (remove) {
    const list = libraryTimeList();
    if (list.length <= 1) return toast('Keep at least one daily backup time', true);
    $('lb-times').value = list.filter(t => t !== remove.dataset.removeTime).join(',');
    resetLibraryTimeEditor(); renderLibraryTimes(); await saveLibraryForm();
  }
});
$('lb-time-add').addEventListener('click', async () => {
  const hour = Number($('lb-time-hour').value) % 12 + ($('lb-time-period').value === 'PM' ? 12 : 0);
  const time = `${String(hour).padStart(2, '0')}:${$('lb-time-minute').value}`;
  const list = libraryTimeList().filter(t => t !== libraryTimeEditing);
  if (list.includes(time)) return toast('That backup time is already added', true);
  $('lb-times').value = [...list, time].sort().join(',');
  resetLibraryTimeEditor(); renderLibraryTimes(); await saveLibraryForm();
});
$('lb-time-cancel').addEventListener('click', resetLibraryTimeEditor);
async function renderLibraryForm() {
  const s = settings.libraryBackup;
  const server = s.mode === 'server';
  $('lb-age-label').textContent = server ? 'Notify me if older than' : 'Mark stale if older than';
  $('lb-age-hint').textContent = server ? 'hours; enable overdue alerts in Notifications' : 'hours; stale status is displayed below';
  for (const [row, slot] of [['lb-root-row', server ? 'lb-server-folder-slot' : 'lb-monitor-folder-slot'], ['lb-age-row', server ? 'lb-server-age-slot' : 'lb-monitor-age-slot']]) {
    if ($(row).parentElement !== $(slot)) $(slot).appendChild($(row));
  }
  $('lb-root-label').textContent = server ? 'Local backup folder' : 'Backup folder';
  $('lb-root').placeholder = server ? 'Existing local folder on the server' : 'Local folder on the server, or a shared Mac/NAS backup folder';
  for (const key of LIBRARY_FIELDS) if (document.activeElement !== $(`lb-${key}`)) $(`lb-${key}`).value = s[key] ?? '';
  $('lb-server-form').classList.toggle('hidden', s.mode !== 'server');
  renderLibraryTimes();
  const has = (await pilot.hasSecrets()).postgres;
  $('lb-password-has').className = `pill ${has ? 'ok' : 'bad'}`;
  $('lb-password-has').textContent = has ? 'Password saved' : 'No password';
}
async function saveLibraryForm() {
  const fields = {};
  for (const key of LIBRARY_FIELDS) fields[key] = ['port', 'keepDays', 'keepMin', 'staleHours'].includes(key) ? Number($(`lb-${key}`).value) : $(`lb-${key}`).value.trim();
  await save((s) => { s.libraryBackup = fields; });
}
let libraryBusy = false;
async function refreshLibraryStatus() {
  const r = await pilot.libraryBackup('status');
  $('lb-status').textContent = !r.ok ? r.error : r.locked || r.running ? 'Backup running, or a backup lock needs attention.' : !r.libraries.length ? 'No completed library dumps found.' : r.libraries.some(l => l.stale) ? 'Attention: one or more backups are stale.' : 'Latest dump files are within the age limit.';
  $('lb-libraries').innerHTML = (r.libraries || []).map(l => `<tr><td>${esc(l.name)}</td><td>${esc(l.count ?? 'Unavailable')}</td><td>${esc(new Date(l.time).toLocaleString())}</td><td>${(l.bytes / 1048576).toFixed(1)} MB</td><td>${l.stale ? 'Stale' : 'Recent file'}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">No dumps to display</td></tr>';
  const state = r.state;
  $('lb-protected').textContent = `${(r.protectedFiles || []).length} protected snapshot(s).${state?.lastSuccess ? ` Last fully successful run: ${new Date(state.lastSuccess).toLocaleString()}.` : ''}${state?.errors?.length ? ` Latest run errors: ${state.errors.join('; ')}` : ''}${state?.warnings?.length ? ` Alerts: ${state.warnings.join('; ')}` : ''}`;
  $('lb-log').textContent = r.log || 'No shared log available.';
  $('lb-run').disabled = libraryBusy || r.running || r.locked;
}
for (const key of LIBRARY_FIELDS) $(`lb-${key}`).addEventListener('change', async () => { await saveLibraryForm(); await renderLibraryForm(); await refreshLibraryStatus(); });
document.querySelectorAll('[data-lb-browse]').forEach(button => button.addEventListener('click', async () => {
  const key = button.dataset.lbBrowse;
  const dir = await pilot.pickFolder($(`lb-${key}`).value);
  if (dir) { $(`lb-${key}`).value = dir; await saveLibraryForm(); await refreshLibraryStatus(); }
}));
$('lb-password-save').addEventListener('click', async () => {
  const value = $('lb-password').value;
  if (!value) return toast('Enter the PostgreSQL password', true);
  await pilot.setSecret('postgres', value);
  $('lb-password').value = '';
  await renderLibraryForm(); toast('PostgreSQL password saved (encrypted)');
});
async function libraryAction(action, button) {
  button.disabled = true;
  if (action === 'run') libraryBusy = true;
  try {
    await saveLibraryForm();
    const r = await pilot.libraryBackup(action, { unattended: $('lb-unattended').checked });
    if (r.canceled) return;
    const message = !r.ok ? r.error || r.errors?.join('; ') || 'Backup finished with errors' : action === 'check' ? `${r.libraries.length} Resolve libraries: ${r.libraries.map(l => `${l.name} (${l.count} projects)`).join(', ')}` : r.file ? `Setup exported: ${r.file}. Run it on the server.` : 'Database backup completed';
    $('lb-result').textContent = message;
    toast(message, !r.ok);
  } catch (err) { toast(err.message, true); }
  finally { libraryBusy = false; button.disabled = false; await refreshLibraryStatus(); }
}
for (const [id, action] of [['lb-check', 'check'], ['lb-run', 'run'], ['lb-schedule', 'schedule']]) $(id).addEventListener('click', e => libraryAction(action, e.currentTarget));
async function librarySchedule(what) {
  try {
    if (what !== 'status') await saveLibraryForm();
    const r = await pilot.libraryBackup(`schedule-${what}`);
    if (!r.ok) throw Error(r.error);
    $('lb-sched-state').textContent = r.scheduled ? `✅ Scheduled daily at ${r.times}` : 'Not scheduled';
    $('lb-sched-state').style.color = r.scheduled ? 'var(--ok, #3ccf8e)' : '';
    if (what !== 'status') toast(r.scheduled ? `Backups scheduled at ${r.times}` : 'Scheduled backups stopped');
  } catch (err) { if (what !== 'status') toast(err.message, true); else $('lb-sched-state').textContent = ''; }
}
$('lb-sched-start').addEventListener('click', () => librarySchedule('start'));
$('lb-sched-stop').addEventListener('click', () => librarySchedule('stop'));
document.querySelector('.nav[data-page="librarybackup"]')?.addEventListener('click', () => librarySchedule('status'));
$('lb-refresh').addEventListener('click', refreshLibraryStatus);
pilot.onLibraryBackup(() => { if ($('page-librarybackup').classList.contains('active')) refreshLibraryStatus(); });
setInterval(() => { if (settings && $('page-librarybackup').classList.contains('active')) refreshLibraryStatus(); }, 30000);

(async () => {
  const init = await pilot.getInitial();
  if (init.platform === 'darwin') {
    $('lb-pgBin').placeholder = '/Library/PostgreSQL/13/bin';
    $('lb-unattended').disabled = true;
    $('lb-unattended-row').classList.add('hidden');
    $('lb-schedule').textContent = 'Export Mac schedule setup';
    $('lb-schedule-help').textContent = 'Run bash install.sh in the exported schedule folder as this Mac user. The app can be closed, but the user must remain logged in with the login keychain unlocked. Keep the app and settings at the same paths. Use mounted NAS folders and re-export after changing times. Disable the old Mac backup schedule before replacing it with this engine.';
  }
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
  document.querySelector(`input[name=n-move][value=${['move', 'copy', 'leave'].includes(settings.project.footage) ? settings.project.footage : 'move'}]`).checked = true;
  $('e-title').value = settings.series.title || '';
  $('e-subtitle').value = settings.series.subtitle || '';
  $('e-size').value = settings.series.size || 0.11;
  barsImage = settings.series.barsImage || '';
  document.querySelector(`input[name=e-bg][value=${settings.series.background === 'bars' ? 'bars' : 'plain'}]`).checked = true;
  renderBars();
  loadSeriesNames();
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
  // Reopen the last page used; the very first run starts on the Dashboard.
  let lastPage = 'dashboard';
  try { lastPage = localStorage.getItem('last-page') || 'dashboard'; } catch {}
  go(document.getElementById(`page-${lastPage}`) ? lastPage : 'dashboard');

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
