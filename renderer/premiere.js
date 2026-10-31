/* global pilot, $, esc, toast, go */
// Premiere Import page: report from the .prproj, XML import into Resolve, fix-ups.
const prNav = document.createElement('button');
prNav.className = 'nav'; prNav.dataset.page = 'premiere';
prNav.innerHTML = '<svg viewBox="0 0 24 24"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M12 18v-6M9 15l3 3 3-3"/></svg>Premiere Import';
document.querySelector('.nav[data-page="newproject"]').after(prNav);
prNav.addEventListener('click', () => go('premiere'));

let pr = { report: null, imported: {}, busy: false };
const prSelected = new Set();
const prTc = (f, fps) => { const r = Math.round(fps) || 25; const p = n => String(n).padStart(2, '0'); return `${p(Math.floor(f / (r * 3600)))}:${p(Math.floor(f / (r * 60)) % 60)}:${p(Math.floor(f / r) % 60)}:${p(f % r)}`; };
const prRoots = () => $('pr-roots').value.split(';').map(s => s.trim()).filter(Boolean);
async function prDo(promise) { try { const r = await promise; if (!r.ok) throw Error(r.error); return r; } catch (e) { toast(e.message, true); return null; } }

function prLink() {
  const l = pr.link;
  if (!l) { $('pr-link').textContent = ''; return; }
  const up = l.installed && l.installed === l.bundled;
  $('pr-link').innerHTML = !l.premiere ? '<span class="pill bad">Premiere not found</span> Add the XML by hand (File → Export → Final Cut Pro XML).'
    : !l.installed ? '<span class="pill bad">Premiere link not set up</span> One click, no admin rights; then PostPilot gets the XML from Premiere itself.'
    : l.connected ? `<span class="pill ok">Premiere link connected</span> Premiere ${esc(l.version)}${l.project ? ` · ${esc(l.project.split(/[\\/]/).pop())} open` : ''}`
    : `<span class="pill ok">Premiere link ${esc(l.installed)}</span> Premiere isn't running; PostPilot starts it when needed.${up ? '' : ' <span class="warn-text">A newer link comes with this PostPilot: update it.</span>'}`;
  $('pr-link-setup').textContent = l.installed ? (up ? 'Reinstall link' : 'Update Premiere link') : 'Set up Premiere link';
  $('pr-link-setup').disabled = !l.premiere || pr.busy;
}
function prRender() {
  prLink();
  const r = pr.report;
  $('pr-reanalyze').disabled = !r || pr.busy;
  if (!r) { $('pr-report').innerHTML = ''; return; }
  $('pr-file').textContent = r.file;
  const missing = r.media.filter(m => m.status === 'missing').length;
  const relinked = r.media.filter(m => m.status === 'relinked').length;
  const c = r.counts; const fps = (r.sequences[0] || {}).fps || 25;
  const box = (n, label, cls = '') => `<div class="card"><b style="font-size:22px" class="${cls}">${n}</b><span class="muted small">${label}</span></div>`;
  let h = `<div class="grid3">${box(r.sequences.length, 'sequences')}${box(`${r.media.length - missing}/${r.media.length}`, `media found${relinked ? ` · ${relinked} at a new location` : ''}`, missing ? 'warn-text' : '')}${box(c.grade, `Lumetri corrections in ${r.lookCount} looks`)}${box(r.fixes.length, 'clips to redo (titles, Mocha, speed…)')}</div>`;

  // What transfers
  const audio = Object.entries(r.audioEffects).map(([k, v]) => `${esc(k)} ×${v}`).join(', ');
  h += `<div class="card"><h3>What comes across</h3><p class="small"><span class="pill ok">transfers</span> cuts, tracks, motion (position/scale/rotation), opacity, audio levels, constant speed changes, markers${c.nested ? `, nested sequences (as compound clips)` : ''}${c.title ? `, titles ×${c.title} (rebuilt as Text+)` : ''}; the bins with all their media.</p>
    <p class="small"><span class="pill bad">redo in Resolve</span> Lumetri ×${c.grade}${c.denoise ? ` · Neat Video ×${c.denoise}` : ''}${c.mocha ? ` · Mocha Pro ×${c.mocha}` : ''}${c.effect ? ` · other effects ×${c.effect}` : ''}${audio ? ` · audio: ${audio}` : ''}</p>
    ${r.fonts.length ? `<p class="small">Title fonts: ${r.fonts.map(f => `${esc(f.name)} ${f.installed === false ? '<span class="pill bad">not installed</span>' : f.installed ? '<span class="pill ok">installed</span>' : ''}`).join(' · ')}</p>` : ''}</div>`;

  // Sequences
  const rows = r.sequences.map(s => {
    const im = pr.imported[s.name];
    const result = !im ? '' : im.ok
      ? `<span class="pill ok">imported</span> <span class="small">${im.videoItems}/${im.expected} clips${im.offline ? ` · <span class="warn-text">${im.offline} offline</span>` : ''} · ${im.markers} markers${im.titles ? ` · ${im.titles} title(s) rebuilt` : ''}${im.titlesLost ? ` · <span class="warn-text">${im.titlesLost} title(s) not rebuilt</span>` : ''}${im.markersLost ? ` · <span class="warn-text">${im.markersLost} not placed</span>` : ''}</span>`
      : `<span class="pill bad">failed</span> <span class="small">${esc(im.error)}</span>`;
    const xml = s.xml ? `<span class="small" title="${esc(s.xml)}">✔ ${esc(s.xml.split(/[\\/]/).pop())}</span>` : pr.link?.installed ? '<span class="small muted">from Premiere</span>' : '<span class="small warn-text">needs XML</span>';
    return `<tr><td><input type="checkbox" data-pr-seq="${esc(s.name)}" ${prSelected.has(s.name) ? 'checked' : ''} ${(!s.xml && !pr.link?.installed) || pr.busy || (im && im.ok) ? 'disabled' : ''}></td><td>${esc(s.name)}</td><td class="small">${s.width}×${s.height} · ${s.fps} fps · ${prTc(s.frames, s.fps)}</td><td class="small">${s.videoClips} / ${s.audioClips}</td><td>${xml}</td><td>${result}</td></tr>`;
  }).join('');
  h += `<div class="card"><h3>Sequences</h3>
    <p class="muted small">${pr.link?.installed
      ? 'Resolve imports the edit from Premiere’s XML. PostPilot has Premiere export it when you import (Premiere is started if needed; a project it opens is closed again without saving).'
      : 'Resolve imports the edit from Premiere’s XML. In Premiere select a sequence → <b>File → Export → Final Cut Pro XML…</b> and save it in the project folder (any sub-folder); PostPilot finds it by the sequence name. Or set up the Premiere link above.'}</p>
    <table class="jobs"><thead><tr><th></th><th>Sequence</th><th>Format</th><th>Video / audio clips</th><th>XML</th><th>Import</th></tr></thead><tbody>${rows}</tbody></table>
    <div class="row" style="margin-top:10px">${pr.link?.installed ? `<button class="btn" id="pr-xml-fetch" ${pr.busy ? 'disabled' : ''}>Get XML from Premiere</button>` : ''}<button class="btn" id="pr-xml-add" ${pr.busy ? 'disabled' : ''}>Add XML…</button><button class="btn" id="pr-xml-rescan" ${pr.busy ? 'disabled' : ''}>Look for XML again</button>
    <select id="pr-target" title="Where the timelines go"><option value="new">Into Resolve project “${esc(r.project)}” (created if needed)</option><option value="current">Into the project open in Resolve</option></select>
    <label class="small"><input type="checkbox" id="pr-mark-grades" checked> Marker on graded clips with their Lumetri settings</label>
    <button class="btn primary" id="pr-import" ${pr.busy || !prSelected.size ? 'disabled' : ''}>${pr.busy ? 'Working…' : (prSelected.size === r.sequences.length ? 'Import whole project into Resolve' : 'Import selected into Resolve')}</button></div>${pr.stage ? `<p class="small"><b>${esc(pr.stage)}</b></p>` : ''}
    <p class="muted small">Premiere's bins are rebuilt with all their media (also unused clips), footage pointed at where the files are now; each sequence goes into its own bin. A new project gets the sequence's frame rate and size; into the open project everything goes under <b>Premiere Import / ${esc(r.project)}</b>. Titles are rebuilt as Text+ with the same text, font, size and position. Markers: <b>Purple</b> = redo (Mocha, speed, title parts Text+ can't copy), <b>Sky</b> = Lumetri look.</p></div>`;

  // Looks per imported sequence
  const lookCards = r.sequences.filter(s => pr.imported[s.name]?.ok && (r.looksBySequence[s.name] || []).length).map(s => {
    const looks = r.looksBySequence[s.name];
    return `<h4>${esc(s.name)}</h4>` + looks.map(l => `<div class="st-clip"><span><b>Look ${l.id}</b> · ${l.count} clips</span><span class="muted small">${esc(l.summary)}</span>
      <span class="st-actions"><button class="btn" data-pr-go="${esc(s.name)}" data-track="${l.first.track}" data-start="${l.first.startFrame}">▶ First clip</button><button class="btn" data-pr-copy="${esc(s.name)}" data-look="${l.id}" title="Grade the first clip in Resolve, then copy its grade to the others">Copy its grade to the other ${l.count - 1}</button></span></div>`).join('');
  }).join('');
  if (lookCards) h += `<div class="card"><h3>Grade once per look</h3><p class="muted small">Clips that had identical Lumetri (and Neat Video) settings in Premiere. Grade the first clip in Resolve, then copy that grade to the rest.</p>${lookCards}</div>`;

  // Clips to redo
  if (r.fixes.length) {
    h += `<div class="card"><h3>Clips to redo</h3><table class="jobs"><thead><tr><th>Sequence</th><th>Time</th><th>Track</th><th>What</th><th></th></tr></thead><tbody>${r.fixes.map(f => `<tr><td class="small">${esc(f.sequence)}</td><td class="small">${prTc(f.startFrame, fps)}</td><td class="small">V${f.track}</td><td class="small">${f.notes.map(esc).join('<br>')}</td><td>${pr.imported[f.sequence]?.ok ? `<button class="btn" data-pr-go="${esc(f.sequence)}" data-track="${f.track}" data-start="${f.startFrame}">▶ Go</button>` : ''}</td></tr>`).join('')}</tbody></table></div>`;
  }

  // Media
  h += `<div class="card"><details class="more" ${missing ? 'open' : ''}><summary><b>Media</b> <span class="muted small">${r.media.length} files${missing ? ` · <span class="warn-text">${missing} missing</span>` : ''}</span></summary><table class="jobs"><tbody>${r.media.map(m => `<tr><td class="small">${esc(m.title)}</td><td><span class="pill ${m.status === 'missing' ? 'bad' : 'ok'}">${m.status}</span></td><td class="small" style="overflow-wrap:anywhere">${esc(m.path || m.original)}</td></tr>`).join('')}</tbody></table></details></div>`;
  $('pr-report').innerHTML = h;
}

$('pr-link-setup').addEventListener('click', async () => {
  const r = await prDo(pilot.premiere('link-install'));
  if (r) toast(r.alive ? 'Premiere link set up' : 'Premiere link set up. If Premiere is open, restart it once.');
  prRefreshLink();
});
async function prRefreshLink() { const l = await pilot.premiere('link-status'); if (l && l.ok) { pr.link = l; prLink(); } }
setInterval(() => { if ($('page-premiere').classList.contains('active') && !pr.busy) prRefreshLink(); }, 5000);
async function prAnalyze(file) {
  $('pr-file').textContent = 'Reading the project…';
  const r = await prDo(pilot.premiere('analyze', { file, roots: prRoots() }));
  if (!r) { $('pr-file').textContent = file; return; }
  pr = r; prSelected.clear();
  r.report.sequences.filter(s => s.xml || r.link?.installed).forEach(s => prSelected.add(s.name));
  prRender();
}
$('pr-open').addEventListener('click', async () => { const r = await prDo(pilot.premiere('pick-project')); if (r && r.file) prAnalyze(r.file); });
$('pr-reanalyze').addEventListener('click', () => pr.report && prAnalyze(pr.report.file));
$('pr-report').addEventListener('change', e => {
  const s = e.target.dataset.prSeq; if (s === undefined) return;
  if (e.target.checked) prSelected.add(s); else prSelected.delete(s);
  prRender();
});
$('pr-report').addEventListener('click', async e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.id === 'pr-xml-add') {
    const r = await prDo(pilot.premiere('pick-xml', { folder: pr.report.file.replace(/[\\/][^\\/]*$/, '') }));
    if (r && r.unknown.length) toast(`Not a sequence of this project: ${r.unknown.join(', ')}`, true);
    const s = await prDo(pilot.premiere('summary')); if (s) { pr = s; s.report.sequences.filter(x => x.xml && !s.imported[x.name]).forEach(x => prSelected.add(x.name)); prRender(); }
  } else if (b.id === 'pr-xml-fetch') {
    const names = prSelected.size ? [...prSelected] : pr.report.sequences.map(s => s.name);
    const r = await prDo(pilot.premiere('fetch-xml', { names }));
    if (r) toast(`Premiere exported ${r.exported} XML file(s)${r.failed.length ? `; failed: ${r.failed.join(', ')}` : ''}`, r.failed.length > 0);
  } else if (b.id === 'pr-xml-rescan') {
    const s = await prDo(pilot.premiere('rescan')); if (s) { pr = s; s.report.sequences.filter(x => x.xml && !s.imported[x.name]).forEach(x => prSelected.add(x.name)); prRender(); }
  } else if (b.id === 'pr-import') {
    const names = [...prSelected];
    const r = await prDo(pilot.premiere('import', { names, markGrades: $('pr-mark-grades').checked, newProject: $('pr-target').value === 'new' }));
    if (r) { const ok = r.results.filter(x => x.ok).length; toast(`Imported ${ok}/${r.results.length} sequence(s)`, ok < r.results.length); names.forEach(n => { if (pr.imported[n]?.ok) prSelected.delete(n); }); prRender(); }
  } else if (b.dataset.prGo) {
    await prDo(pilot.premiere('goto', { sequence: b.dataset.prGo, track: +b.dataset.track, start: +b.dataset.start }));
  } else if (b.dataset.prCopy) {
    if (!confirm('Copy the grade of the first clip of this look to the other clips? Their current grade is replaced.')) return;
    const r = await prDo(pilot.premiere('copygrade', { sequence: b.dataset.prCopy, look: +b.dataset.look }));
    if (r) toast(`Grade copied to ${r.copied} clip(s)${r.lost ? `, ${r.lost} not found (moved?)` : ''}`);
  }
});
pilot.onPremiere(s => { pr = s; for (const n of prSelected) if (s.imported[n]?.ok) prSelected.delete(n); prRender(); });
pilot.premiere('summary').then(s => { if (s && s.ok) { pr = s; prRender(); } });
