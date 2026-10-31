/* global pilot, $, esc, toast */
const stNav = document.createElement('button');
stNav.className = 'nav'; stNav.dataset.page = 'stabilization';
stNav.innerHTML = '<svg viewBox="0 0 24 24"><path d="M3 8V5a2 2 0 0 1 2-2h3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M8 21H5a2 2 0 0 1-2-2v-3"/><circle cx="12" cy="12" r="3"/></svg>Stabilization';
document.querySelector('.nav[data-page="episodes"]').before(stNav);
stNav.addEventListener('click', () => go('stabilization'));
let st = { clips: [], running: false }, stKey = '', stPreview = null, stPreviewRequest = 0, stLoadedFrame = -1;
const stAnchors = new Map();
let stTimelines = [], stTlChecked = new Set();
async function stLoadTimelines() {
  try {
    const r = await pilot.stabilize('timelines'); if (!r.ok) throw Error(r.error);
    // Stabilized copies are results, not sources: keep them out of the list.
    stTimelines = r.timelines.filter(t => !/ - PostPilot (Stabilized|Tracker) [\d -]*\d{6}$/.test(t.name));
    const ids = new Set(stTimelines.map(t => t.id));
    stTlChecked = new Set([...stTlChecked].filter(id => ids.has(id)));
    if (!stTlChecked.size) stTimelines.filter(t => t.current).forEach(t => stTlChecked.add(t.id));
    stRenderTimelines();
  } catch (e) { $('st-timelines').textContent = e.message; }
}
function stRenderTimelines() {
  const color = $('st-color').value;
  $('st-timelines').innerHTML = stTimelines.map(t => {
    const n = color === 'All' ? t.count : (t.markers[color] || 0);
    return `<label><input type="checkbox" data-st-tl="${esc(t.id)}" ${stTlChecked.has(t.id) ? 'checked' : ''} ${st.running ? 'disabled' : ''}> ${esc(t.name)} <span class="muted small">${n ? `${n} marker${n > 1 ? 's' : ''}` : 'no markers'}${t.current ? ' · open in Resolve' : ''}</span></label>`;
  }).join('') || 'No timelines in this project.';
  $('st-timelines').querySelectorAll('[data-st-tl]').forEach(el => el.addEventListener('change', () => { el.checked ? stTlChecked.add(el.dataset.stTl) : stTlChecked.delete(el.dataset.stTl); }));
}
$('st-tl-refresh').addEventListener('click', stLoadTimelines);
$('st-tl-all').addEventListener('click', () => { const color = $('st-color').value; stTlChecked = new Set(stTimelines.filter(t => (color === 'All' ? t.count : t.markers[color]) > 0 && !/ - PostPilot (Stabilized|Tracker) /.test(t.name)).map(t => t.id)); stRenderTimelines(); });
$('st-color').addEventListener('change', stRenderTimelines);
stNav.addEventListener('click', stLoadTimelines);
const stClock = ms => { const t = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };
const stColor = { Passed: '#3ccf8e', 'Needs review': '#ff8c2a', 'Stabilized (Resolve)': '#e8c832' };
function stClipRow(c, i) {
  const head = i === 0 || st.clips[i - 1].timelineName !== c.timelineName ? `<div class="st-tl-head">${esc(c.timelineName || '')}</div>` : '';
  const running = st.running && st.current === c.key;
  const time = running && c.startedAt ? ` · ⏱ ${stClock(Date.now() - c.startedAt)}` : c.elapsedMs ? ` · ⏱ ${stClock(c.elapsedMs)}` : '';
  const pct = ['Tracking'].includes(c.status) ? ` ${c.percent || 0}%` : '';
  const done = Boolean(c.copyTimelineId) && !st.running && ['Passed', 'Needs review', 'Stabilized (Resolve)'].includes(c.status);
  const usable = done && !/Left unstabilized|No details|No fixed/.test(c.reason || '');
  // A clip done with Resolve's stabilizer can also get a forced tracker version (c.alt) to compare.
  const alt = c.alt, two = Boolean(alt);
  const altRunning = st.running && st.forcing === c.key;
  const altUsable = alt && !altRunning && alt.copyTimelineId && !alt.copyDeleted && !/Left unstabilized|No details/.test(alt.reason || '') && ['Tracker (forced)', 'Needs review'].includes(alt.status);
  const undoable = c.approved && !(c.method === 'resolve' && c.approvedVersion !== 'tracker');
  const tryTracker = c.method === 'resolve' && !alt && !c.approved && !c.copyDeleted && !st.running
    ? `<button class="btn" data-st-force="${esc(c.key)}" title="Also make a version with PostPilot's point tracker, in its own timeline copy, to compare with Resolve's stabilizer">🎯 Try tracker too</button>` : '';
  const actions = c.copyTimelineId && !running
    ? `<div class="st-actions"><button class="btn" data-st-go="${esc(c.key)}" data-where="copy" title="Jump to this clip in the stabilized copy" ${c.copyDeleted ? 'disabled' : ''}>▶ Review${two ? ' Resolve version' : ''}</button><button class="btn" data-st-go="${esc(c.key)}" data-where="original" title="Same clip in your original timeline">⇄ Original</button>${undoable ? `<button class="btn" data-st-undo="${esc(c.key)}" title="Remove the stabilization from your timeline again">↺ Undo</button>` : c.approved ? '' : usable ? `<button class="btn primary" data-st-approve="${esc(c.key)}" title="Apply this stabilization to the clip in your timeline">✔ Approve${two ? ' Resolve version' : ''}</button>` : ''}${tryTracker}</div>`
    : running ? '' : `<button class="btn" data-st-review="${esc(c.key)}" ${st.running || st.hasCopy || c.fusion ? 'disabled' : ''}>Choose points (optional)</button>`;
  const altTime = altRunning && alt?.startedAt ? ` · ⏱ ${stClock(Date.now() - alt.startedAt)}` : alt?.elapsedMs ? ` · ⏱ ${stClock(alt.elapsedMs)}` : '';
  const altRow = alt ? `<div class="st-alt"><span class="small"><b>Tracker version</b> · <b style="color:${c.approvedVersion === 'tracker' ? '#3ccf8e' : '#ff8c2a'}">${esc(c.approvedVersion === 'tracker' ? '✔ Applied to your timeline' : alt.status)}${alt.status === 'Tracking' ? ` ${alt.percent || 0}%` : ''}</b>${altTime}${alt.copyTimelineName ? ` · <span class="muted">${esc(alt.copyTimelineName)}</span>` : ''}</span>${alt.reason ? `<span class="muted small">${esc(alt.reason)}</span>` : ''}${altRunning ? '' : `<div class="st-actions"><button class="btn" data-st-go="${esc(c.key)}" data-where="tracker" ${alt.copyDeleted ? 'disabled' : ''}>▶ Review tracker version</button>${!c.approved && altUsable ? `<button class="btn primary" data-st-approve-tracker="${esc(c.key)}" title="Apply the tracker version to the clip in your timeline instead">✔ Approve tracker version</button>` : ''}</div>`}</div>` : '';
  const status = c.approved ? `✔ Applied to your timeline${two ? (c.approvedVersion === 'tracker' ? ' (tracker version)' : ' (Resolve version)') : ''}` : c.status;
  const motion = !c.copyTimelineId && !c.fusion ? `<label class="check inline small st-motion" title="Rare: the operator pans or reframes on purpose. Then only the fast shake is removed and the camera move is kept."><input type="checkbox" data-st-motion="${esc(c.key)}" ${c.motion ? 'checked' : ''} ${st.running ? 'disabled' : ''}> Camera moves on purpose (smooth only)</label>` : c.motion ? '<span class="muted small">Smooth: camera move kept</span>' : '';
  return `${head}<div class="st-clip${running ? ' st-running' : ''}"><label><input type="checkbox" data-st-select="${esc(c.key)}" ${c.selected ? 'checked' : ''} ${st.running || st.hasCopy || c.fusion ? 'disabled' : ''}> ${esc(c.marker)} · ${esc(c.color)}${c.note ? ` · ${esc(c.note)}` : ''}</label><span class="muted small">${c.frames} frames · ${esc(c.name)} · <b style="color:${c.approved ? '#3ccf8e' : stColor[c.status] || 'inherit'}">${esc(status)}${pct}</b>${time}</span>${c.reason ? `<span class="muted small">${esc(c.reason)}</span>` : ''}${c.copyTimelineName ? `<span class="muted small">In ${esc(c.copyTimelineName)}</span>` : ''}${motion}${actions}${altRow}</div>`;
}
function stLive() {
  const run = st.clips.filter(c => c.startedAt || c.elapsedMs || c.status === 'Waiting' || c.copyTimelineId);
  const box = $('st-live');
  if (!st.startedAt || !run.length) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  const finished = run.filter(c => c.elapsedMs != null).length, total = run.length;
  const cur = st.clips.find(c => c.key === st.current);
  const fraction = (finished + (cur ? (cur.percent || 0) / 100 : 0)) / total;
  $('st-live-bar').style.width = `${Math.round(fraction * 100)}%`;
  const passed = run.filter(c => c.status === 'Passed').length, review = run.filter(c => c.status === 'Needs review').length; const viaResolve = run.filter(c => c.status === 'Stabilized (Resolve)').length;
  const forced = st.forcing && st.clips.find(c => c.key === st.forcing);
  if (forced) {
    const a = forced.alt || {};
    $('st-live-bar').style.width = `${a.percent || 0}%`;
    $('st-live-text').innerHTML = `<b>Tracker version</b> · ${esc(forced.name)} · ${esc(a.status || 'preparing')}${a.status === 'Tracking' ? ` ${a.percent || 0}%` : ''}${a.startedAt ? ` · ${stClock(Date.now() - a.startedAt)}` : ''}`;
  } else if (st.running) {
    $('st-live-text').innerHTML = `<b>Clip ${Math.min(finished + 1, total)} of ${total}</b> · ${esc(cur ? cur.name : 'preparing')} · ${esc(cur ? cur.status : '')}${cur && cur.status === 'Tracking' ? ` ${cur.percent || 0}%` : ''}${cur && cur.startedAt ? ` · this clip ${stClock(Date.now() - cur.startedAt)}` : ''} · total ${stClock(Date.now() - st.startedAt)}${st.stopping ? ' · stopping after this clip' : ''}`;
  } else {
    $('st-live-text').innerHTML = `<b>Finished ${finished} clip${finished === 1 ? '' : 's'} in ${stClock((st.finishedAt || Date.now()) - st.startedAt)}</b> · ${passed} passed${viaResolve ? ` · ${viaResolve} via Resolve's stabilizer` : ''} · ${review} need review. Review each clip, then approve.`;
  }
  const approvable = st.clips.filter(c => c.copyTimelineId && !c.approved && ['Passed', 'Stabilized (Resolve)'].includes(c.status) && !/Left unstabilized/.test(c.reason || ''));
  $('st-approve-all').disabled = st.running || !approvable.length;
  $('st-delete-copies').disabled = st.running || !st.copiesReady;
  $('st-delete-copies').textContent = st.copiesReady ? `🗑 Delete stabilized cop${st.copiesReady > 1 ? 'ies' : 'y'} (${st.copiesReady})` : '🗑 Delete stabilized copies';
  $('st-approve-all').textContent = approvable.length ? `✔ Approve all passed (${approvable.length})` : '✔ Approve all passed';
}
setInterval(() => { if (st.running) { stLive(); const row = document.querySelector('.st-running'); if (row) stRender(); } }, 1000);
async function stDo(promise) { try { const r = await promise; if (r && r.ok === false) throw Error(r.error); return r; } catch (e) { toast(e.message, true); } }
function stRender() {
  $('st-timeline').textContent = st.timeline || '';
  $('st-clips').innerHTML = st.clips.length ? st.clips.map(stClipRow).join('') : 'No clips found for this marker color.';
  $('st-scan').disabled = st.running; $('st-color').disabled = st.running;
  $('st-start').disabled = st.running || st.hasCopy || !st.clips.some(c => c.selected);
  $('st-stop').disabled = !st.running || st.stopping;
  $('st-review').classList.toggle('hidden', Boolean(!stKey || st.running || st.hasCopy));
  stLive();
  $('st-clips').querySelectorAll('[data-st-go]').forEach(el => el.addEventListener('click', () => stDo(pilot.stabilize('review', { key: el.dataset.stGo, where: el.dataset.where }))));
  $('st-clips').querySelectorAll('[data-st-approve]').forEach(el => el.addEventListener('click', async () => { const r = await stDo(pilot.stabilize('approve', { keys: [el.dataset.stApprove], removeMarkers: $('st-remove-markers').checked })); if (r) toast('Applied to your timeline'); }));
  $('st-clips').querySelectorAll('[data-st-approve-tracker]').forEach(el => el.addEventListener('click', async () => { const r = await stDo(pilot.stabilize('approve', { keys: [el.dataset.stApproveTracker], version: 'tracker', removeMarkers: $('st-remove-markers').checked })); if (r) toast('Tracker version applied to your timeline'); }));
  $('st-clips').querySelectorAll('[data-st-force]').forEach(el => el.addEventListener('click', async () => { const r = await stDo(pilot.stabilize('force', { key: el.dataset.stForce })); if (r) { toast('Tracker version ready: compare both, then approve one'); stLoadRuns(); } }));
  $('st-clips').querySelectorAll('[data-st-undo]').forEach(el => el.addEventListener('click', async () => { const r = await stDo(pilot.stabilize('undo', { key: el.dataset.stUndo })); if (r) toast('Removed from your timeline'); }));
  $('st-clips').querySelectorAll('[data-st-motion]').forEach(el => el.addEventListener('change', () => { st.clips.find(c => c.key === el.dataset.stMotion).motion = el.checked; }));
  $('st-clips').querySelectorAll('[data-st-select]').forEach(el => el.addEventListener('change', () => { st.clips.find(c => c.key === el.dataset.stSelect).selected = el.checked; stRender(); }));
  $('st-clips').querySelectorAll('[data-st-review]').forEach(el => el.addEventListener('click', async () => {
    stKey = el.dataset.stReview; stPreview = null; stDraw(); const c = st.clips.find(c => c.key === stKey); const a = stAnchors.get(stKey);
    $('st-review-name').textContent = c.name; $('st-frame').max = c.frames - 1; $('st-frame').value = 0; $('st-frame-label').textContent = '0';
    $('st-anchor-x').value = a ? (a.x * 100).toFixed(3) : ''; $('st-anchor-y').value = a ? ((1-a.y)*100).toFixed(3) : ''; $('st-reviewed').checked = Boolean(a?.reviewed);
    $('st-pattern-width').value = (a?.width || .04)*100; $('st-pattern-height').value = (a?.height || .045)*100;
    $('st-point-mode').value='anchor';stRender(); await stLoadPreview();
  }));
}
function stDraw() {
  const canvas = $('st-canvas'), ctx = canvas.getContext('2d');ctx.clearRect(0,0,canvas.width,canvas.height);
  if (stPreview) ctx.drawImage(stPreview,0,0,canvas.width,canvas.height);
  const a=stAnchors.get(stKey);
  $('st-reference-count').textContent=a?.verificationPoints?.length?`${a.verificationPoints.length} extra point(s)`:'No extra points';
  for(const p of a?.verificationPoints||[]){const x=p.x*canvas.width,y=(1-p.y)*canvas.height;ctx.strokeStyle='#64b5f6';ctx.beginPath();ctx.moveTo(x-5,y);ctx.lineTo(x+5,y);ctx.moveTo(x,y-5);ctx.lineTo(x,y+5);ctx.stroke();}
  if (a) {const x=a.x*canvas.width,y=(1-a.y)*canvas.height,w=(a.width||.04)*canvas.width,h=(a.height||.045)*canvas.height;ctx.strokeStyle='#3ccf8e';ctx.lineWidth=2;ctx.strokeRect(x-w/2,y-h/2,w,h);ctx.beginPath();ctx.moveTo(x-6,y);ctx.lineTo(x+6,y);ctx.moveTo(x,y-6);ctx.lineTo(x,y+6);ctx.stroke();}
}
async function stLoadPreview() {
  if (!stKey || st.running || st.hasCopy) return;
  const request = ++stPreviewRequest, key = stKey, frame = Number($('st-frame').value);
  stLoadedFrame = -1;
  stPreview = null; stDraw();
  $('st-preview').disabled=true;
  try { const r=await pilot.stabilize('preview',{key,frame});if(request!==stPreviewRequest || key!==stKey)return;if(!r.ok)throw Error(r.error);
    if (r.image) { const image=new Image(); await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=()=>reject(Error('Preview could not be loaded'));image.src=r.image;});if(request!==stPreviewRequest || key!==stKey)return;stLoadedFrame=frame;stPreview=image;stDraw();return; }
    const {width,height,data}=r.thumbnail;const raw=Uint8Array.from(atob(data),c=>c.charCodeAt(0));if(raw.length!==width*height*3)throw Error('Unsupported Resolve preview format');
    const rgba=new Uint8ClampedArray(width*height*4);for(let i=0,j=0;i<raw.length;i+=3,j+=4){rgba[j]=raw[i];rgba[j+1]=raw[i+1];rgba[j+2]=raw[i+2];rgba[j+3]=255;}
    const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;canvas.getContext('2d').putImageData(new ImageData(rgba,width,height),0,0);stLoadedFrame=frame;stPreview=canvas;stDraw();
  } catch(e){if(request===stPreviewRequest)toast(e.message,true);}finally{if(request===stPreviewRequest)$('st-preview').disabled=false;}
}
function stSetAnchor(x,y) {
  stAnchors.set(stKey,{key:stKey,x,y,width:Number($('st-pattern-width').value)/100,height:Number($('st-pattern-height').value)/100,verificationPoints:stAnchors.get(stKey)?.verificationPoints,reviewed:false});$('st-reviewed').checked=false;
  $('st-anchor-x').value=(x*100).toFixed(3);$('st-anchor-y').value=((1-y)*100).toFixed(3);stDraw();
}
$('st-canvas').addEventListener('click',e=>{if(!stKey||!stPreview||stLoadedFrame!==0||Number($('st-frame').value)!==0){toast('Return to frame 0 and refresh before choosing a point',true);return;}const b=e.currentTarget.getBoundingClientRect(),x=(e.clientX-b.left)/b.width,y=1-(e.clientY-b.top)/b.height;if($('st-point-mode').value==='reference'){const a=stAnchors.get(stKey);if(!a){toast('Choose the tracking anchor first',true);return;}if(x<=.025||x>=.975||y<=.025||y>=.975){toast('Choose a point away from the frame edges',true);return;}a.verificationPoints=a.verificationPoints||[];if(a.verificationPoints.length>=12){toast('Use up to 12 verification points',true);return;}a.verificationPoints.push({x,y});a.reviewed=false;$('st-reviewed').checked=false;stDraw();}else stSetAnchor(x,y);});
$('st-clear-references').addEventListener('click',()=>{const a=stAnchors.get(stKey);if(a){a.verificationPoints=[];a.reviewed=false;$('st-reviewed').checked=false;stDraw();}});
for(const id of ['st-anchor-x','st-anchor-y']) $(id).addEventListener('change',()=>{if(!stKey||stLoadedFrame!==0||Number($('st-frame').value)!==0){toast('Return to frame 0 and refresh before choosing the anchor',true);return;}stSetAnchor(Number($('st-anchor-x').value)/100,1-Number($('st-anchor-y').value)/100);});
for(const id of ['st-pattern-width','st-pattern-height']) $(id).addEventListener('change',()=>{const a=stAnchors.get(stKey);if(a)stSetAnchor(a.x,a.y);});
$('st-reviewed').addEventListener('change',()=>{const a=stAnchors.get(stKey);if(a)a.reviewed=$('st-reviewed').checked;else{$('st-reviewed').checked=false;toast('Choose an anchor first',true);}});
$('st-frame').addEventListener('input',()=>{$('st-frame-label').textContent=$('st-frame').value;});
$('st-frame').addEventListener('change',stLoadPreview);$('st-preview').addEventListener('click',stLoadPreview);
$('st-scan').addEventListener('click',async()=>{try{if(!stTlChecked.size){toast('Tick at least one timeline',true);return;}const r=await pilot.stabilize('scan',{color:$('st-color').value,timelines:stTimelines.filter(t=>stTlChecked.has(t.id)).map(t=>t.id)});if(!r.ok)throw Error(r.error);const chosen=$('st-color').value;$('st-color').innerHTML='<option value="All">All colors</option>'+r.colors.map(c=>`<option value="${esc(c)}">${esc(c)}</option>`).join('');$('st-color').value=r.colors.includes(chosen)?chosen:'All';stAnchors.clear();stKey='';stPreview=null;st={clips:r.clips.map(c=>({...c,selected:!c.fusion,status:c.fusion?'Existing Fusion — manual review':'Ready'})),timeline:r.timeline,running:false};stRender();}catch(e){toast(e.message,true);}});
$('st-start').addEventListener('click',async()=>{const chosen=st.clips.filter(c=>c.selected);const anchors=[];for(const c of chosen){const a=stAnchors.get(c.key);if(!a)continue;anchors.push({key:c.key,x:a.x,y:a.y,width:a.width,height:a.height});for(const p of a.verificationPoints||[])anchors.push({key:c.key,x:p.x,y:p.y});}try{const r=await pilot.stabilize('start',{keys:chosen.map(c=>c.key),anchors,moving:chosen.filter(c=>c.motion).map(c=>c.key)});if(!r.ok)throw Error(r.error);$('st-result').textContent=`Finished: ${r.timeline}. Review the timeline copy in Resolve.`;}catch(e){$('st-result').textContent=e.message;toast(e.message,true);}});
$('st-stop').addEventListener('click',()=>pilot.stabilize('stop'));
pilot.onStabilize(s=>{const selections=new Map(st.clips.map(c=>[c.key,c.selected])),motions=new Map(st.clips.map(c=>[c.key,c.motion]));st={...s,clips:s.clips.map(c=>({...c,selected:selections.get(c.key)??c.selected,motion:c.motion??motions.get(c.key)}))};stRender();});
pilot.stabilize('summary').then(s=>{if(s.ok){st=s;stRender();}});

$('st-approve-all').addEventListener('click', async () => {
  const keys = st.clips.filter(c => c.copyTimelineId && !c.approved && ['Passed', 'Stabilized (Resolve)'].includes(c.status)).map(c => c.key);
  if (!keys.length) return;
  const r = await stDo(pilot.stabilize('approve', { keys, removeMarkers: $('st-remove-markers').checked }));
  if (r) toast(`Applied ${r.applied} clip(s) to your timeline`);
});
$('st-remove-markers').addEventListener('change', e => save(s => { s.stab.removeMarkers = e.target.checked; }));
$('st-after').addEventListener('change', e => save(s => { s.stab.afterQueue = e.target.value; }));
pilot.onSettings?.(s => { $('st-remove-markers').checked = Boolean(s.stab?.removeMarkers); $('st-after').value = s.stab?.afterQueue || 'nothing'; });
pilot.getInitial().then(init => { $('st-remove-markers').checked = Boolean(init.settings.stab?.removeMarkers); $('st-after').value = init.settings.stab?.afterQueue || 'nothing'; });

$('st-delete-copies').addEventListener('click', async () => {
  if (!confirm('Delete the stabilized copy timeline(s)? Every stabilized clip is already applied to your own timeline.')) return;
  const r = await stDo(pilot.stabilize('deletecopies'));
  if (r) toast(`Deleted ${r.deleted} copy timeline(s)`);
});

// Earlier runs: open one to review it again (the list is kept on disk).
async function stLoadRuns() {
  const r = await pilot.stabilize('runs');
  if (!r.ok) return;
  const when = d => new Date(d).toLocaleString([], { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  $('st-runs').innerHTML = r.runs.length ? `<table class="jobs"><thead><tr><th>When</th><th>Project</th><th>Timelines</th><th>Clips</th><th>Copy timelines</th><th></th></tr></thead><tbody>${r.runs.map(x => `<tr>
    <td>${esc(when(x.date))}</td><td>${esc(x.project || '')}</td><td>${esc(x.timelines.join(', '))}</td>
    <td>${x.clips} · ${x.passed} passed${x.resolve ? ` · ${x.resolve} via Resolve` : ''}${x.tracker ? ` · ${x.tracker} tracker version` : ''} · <b>${x.applied} applied</b></td>
    <td class="muted small">${esc(x.copies.join(', '))}</td>
    <td>${st.runId === x.id ? '<span class="muted">open above</span>' : `<button class="btn" data-st-run="${esc(x.id)}" ${st.running ? 'disabled' : ''}>Open</button>`}</td></tr>`).join('')}</tbody></table>` : 'None yet';
  $('st-runs').querySelectorAll('[data-st-run]').forEach(el => el.addEventListener('click', async () => {
    const o = await stDo(pilot.stabilize('open', { id: el.dataset.stRun }));
    if (!o) return;
    stKey = ''; stPreview = null; st = o; stRender(); stLoadRuns();
    $('st-clips').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));
}
$('st-runs-refresh').addEventListener('click', stLoadRuns);
stNav.addEventListener('click', stLoadRuns);
// Keep the list current: after a run, a tracker version, or a review action (applied counts).
let stRunsKey = '';
pilot.onStabilize(s => { const key = `${s.running}|${s.runId}|${s.clips.filter(c => c.approved).length}|${s.copiesReady}`; if (!s.running && key !== stRunsKey) stLoadRuns(); stRunsKey = key; });
stLoadRuns();
