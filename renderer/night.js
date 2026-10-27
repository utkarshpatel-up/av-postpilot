/* global pilot, $, esc, toast, status, time, fmtSec */
// Night queue page: steps from Scene Cuts, Stabilization, Renders and Encoder in one run.
let nq = { steps: [], running: false, project: null };
let nTimelines = [], nStabTimelines = [];
const N_TYPES = { scene: 'Scene cuts', stab: 'Stabilize', render: 'Render', encode: 'Encode' };
const N_STATE = { waiting: 'Waiting', running: 'Running…', done: 'Done', failed: 'Failed' };

async function nLoadLists() {
  $('n-project').textContent = status.project?.name || 'no project open';
  if (!status.connected || !status.project) { nRenderPick(); return; }
  const [scene, stab] = await Promise.all([pilot.listSeries(), pilot.stabilize('timelines')]);
  if (scene.ok) nTimelines = scene.allNames || [];
  // Stabilized copies are results, not sources.
  if (stab.ok) nStabTimelines = stab.timelines.filter((t) => !/ - PostPilot (Stabilized|Tracker) [\d -]*\d{6}$/.test(t.name));
  else if (!scene.ok) toast(stab.error || scene.error, true);
  const colors = [...new Set(nStabTimelines.flatMap((t) => Object.keys(t.markers || {})))].sort();
  const chosen = $('n-color').value;
  $('n-color').innerHTML = '<option value="All">All colors</option>' + colors.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
  $('n-color').value = colors.includes(chosen) ? chosen : 'All';
  nRenderPick();
}

function nRenderPick() {
  const type = $('n-type').value;
  $('n-color-box').classList.toggle('hidden', type !== 'stab');
  const box = $('n-pick');
  const none = (msg) => `<div class="empty">${msg}</div>`;
  if (type === 'scene') {
    box.innerHTML = nTimelines.length ? nTimelines.map((n) => `<label><input type="checkbox" value="${esc(n)}"> ${esc(n)}</label>`).join('') : none(status.project ? 'Click "Refresh lists"' : 'Open the project in Resolve');
  } else if (type === 'stab') {
    const color = $('n-color').value;
    box.innerHTML = nStabTimelines.length ? nStabTimelines.map((t) => {
      const n = color === 'All' ? t.count : (t.markers?.[color] || 0);
      return `<label><input type="checkbox" value="${esc(t.id)}" data-name="${esc(t.name)}" ${n ? '' : 'disabled'}> ${esc(t.name)} <span class="muted small">${n ? `${n} marker${n > 1 ? 's' : ''}` : 'no markers'}</span></label>`;
    }).join('') : none(status.project ? 'Click "Refresh lists"' : 'Open the project in Resolve');
  } else if (type === 'render') {
    const jobs = status.jobs || [];
    box.innerHTML = jobs.length ? jobs.map((j) => `<label><input type="checkbox" value="${esc(j.id)}"> ${esc(j.name || j.id)} · ${esc(j.timeline)} <span class="muted small">${esc(j.file || '')}${j.status && j.status !== 'Ready' ? ` · ${esc(j.status)} (renders again)` : ''}</span></label>`).join('')
      : none(status.project ? 'No jobs in Resolve\'s render queue. Add them on the Deliver page ("Add to Render Queue"), then come back.' : 'Open the project in Resolve');
  } else {
    const n = (typeof enc === 'undefined' ? [] : enc.groups).reduce((c, g) => c + g.items.filter((i) => i.state === 'waiting').length, 0);
    box.innerHTML = none(`${n} file(s) waiting on the Encoder page. This step encodes whatever is waiting there when it starts.`);
  }
  nPickInfo();
}
function nPicked() { return [...$('n-pick').querySelectorAll('input:checked')]; }
function nPickInfo() {
  const n = nPicked().length, type = $('n-type').value;
  $('n-add').disabled = nq.running;
  $('n-pick-info').textContent = n ? `${n} selected` : '';
}

async function nAdd() {
  const type = $('n-type').value;
  if (type !== 'encode' && !nPicked().length) {
    const why = !status.connected ? 'Resolve is not connected'
      : !status.project ? 'Open the project in Resolve first'
      : type === 'render' && !(status.jobs || []).length ? "Resolve's render queue is empty: add jobs on the Deliver page first"
      : type === 'stab' && !nStabTimelines.some((t) => t.count) ? 'No timeline has markers for stabilization'
      : `Tick at least one ${type === 'render' ? 'render job' : 'timeline'} in the list first`;
    return toast(why, true);
  }
  const args = { type };
  if (type === 'scene') args.timelines = nPicked().map((i) => i.value);
  if (type === 'stab') { args.timelines = nPicked().map((i) => ({ id: i.value, name: i.dataset.name })); args.color = $('n-color').value; }
  if (type === 'render') {
    const ids = nPicked().map((i) => i.value);
    args.jobs = (status.jobs || []).filter((j) => ids.includes(j.id)).map((j) => ({ id: j.id, name: j.name, timeline: j.timeline, file: j.file }));
  }
  if (type === 'render' || type === 'stab') {
    const c = await pilot.night('conflicts', args);
    if (c.ok && c.timelines.length && !confirm(`Caution: ${c.timelines.map((n) => `"${n}"`).join(', ')} ${type === 'render' ? 'is already in the stabilization step' : 'is already in a render step'}.\n\nThe render will use the original clips: stabilized clips are only applied after your review on the Stabilization page, so tonight's render won't include them.\n\nAdd it anyway?`)) return;
  }
  const r = await pilot.night('add', args);
  if (!r.ok) return toast(r.error, true);
  $('n-pick').querySelectorAll('input:checked').forEach((i) => { i.checked = false; });
  nPickInfo();
}

function nDetail(s) {
  if (s.type === 'scene') return s.timelines.map(esc).join(', ');
  if (s.type === 'stab') return `${s.timelines.map((t) => esc(t.name)).join(', ')}${s.color && s.color !== 'All' ? ` · ${esc(s.color)} markers` : ''}`;
  if (s.type === 'render') return s.jobs.map((j) => `${esc(j.name || j.id)} (${esc(j.timeline)})`).join(', ');
  return 'Files waiting on the Encoder page';
}
function nStepRow(s, i) {
  const took = s.finishedAt && s.startedAt ? ` · ${fmtSec(Math.round((s.finishedAt - s.startedAt) / 1000))}` : s.state === 'running' ? ` · started ${time(s.startedAt)}` : '';
  const btns = s.state === 'waiting' && !nq.running
    ? `${s.type !== 'encode' ? `<button class="btn icon" data-n-up="${s.id}" title="Earlier">↑</button><button class="btn icon" data-n-down="${s.id}" title="Later">↓</button>` : ''}<button class="btn icon" data-n-del="${s.id}" title="Remove">✕</button>` : '';
  return `<div class="n-step ${s.state}">
    <span class="n-num">${i + 1}</span>
    <div class="n-main"><strong>${N_TYPES[s.type]}</strong> <span class="muted small">${nDetail(s)}</span>
      ${s.result ? `<div class="small">${esc(s.result)}</div>` : ''}${s.error ? `<div class="err">${esc(s.error)}</div>` : ''}
      ${s.warning && s.state === 'waiting' ? `<div class="n-warn small">⚠ ${esc(s.warning)}</div>` : ''}</div>
    <span><span class="state ${s.state}">${N_STATE[s.state] || s.state}</span><span class="muted small">${took}</span></span>
    <span class="n-btns">${btns}</span></div>`;
}

function nRender() {
  $('n-steps').innerHTML = nq.steps.length ? nq.steps.map(nStepRow).join('') : '<div class="empty">No steps yet. Add them above in the order they should run.</div>';
  const waiting = nq.steps.filter((s) => s.state === 'waiting').length;
  $('n-start').disabled = nq.running || !waiting;
  $('n-start').textContent = nq.running ? 'Running…' : `Start night queue${waiting ? ` (${waiting} step${waiting > 1 ? 's' : ''})` : ''}`;
  $('n-stop').disabled = !nq.running || nq.stopping;
  $('n-stop').textContent = nq.stopping ? 'Stopping after current step…' : 'Stop after current step';
  $('n-clear').disabled = nq.running;
  const badge = $('nav-night-badge');
  badge.classList.toggle('hidden', !nq.running);
  badge.textContent = nq.running ? 'running' : '';
  nPickInfo();
}

$('n-steps').addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  let r;
  if (b.dataset.nDel) r = await pilot.night('remove', { id: Number(b.dataset.nDel) });
  if (b.dataset.nUp) r = await pilot.night('move', { id: Number(b.dataset.nUp), by: -1 });
  if (b.dataset.nDown) r = await pilot.night('move', { id: Number(b.dataset.nDown), by: 1 });
  if (r && !r.ok) toast(r.error, true);
});
$('n-type').addEventListener('change', nRenderPick);
$('n-color').addEventListener('change', nRenderPick);
$('n-pick').addEventListener('change', nPickInfo);
$('n-refresh').addEventListener('click', nLoadLists);
$('n-add').addEventListener('click', nAdd);
$('n-clear').addEventListener('click', () => pilot.night('clear'));
$('n-stop').addEventListener('click', () => pilot.night('stop'));
$('n-start').addEventListener('click', async () => {
  const warned = nq.steps.filter((s) => s.state === 'waiting' && s.warning);
  if (warned.length && !confirm(`Caution:\n\n${warned.map((s) => s.warning).join('\n\n')}\n\nStart anyway?`)) return;
  const r = await pilot.night('start');
  if (!r.ok) toast(r.error, true);
});
$('n-after').addEventListener('change', (e) => save((s) => { s.night.afterQueue = e.target.value; }));

pilot.onNight((n) => { nq = n; nRender(); renderShutdown(); });
pilot.night('summary').then((r) => { if (r.ok) { nq = r; nRender(); } });
if ($('page-night').classList.contains('active')) nLoadLists();   // PostPilot reopened on this page
