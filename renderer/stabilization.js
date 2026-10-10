/* global pilot, $, esc, toast */
const stNav = document.createElement('button');
stNav.className = 'nav'; stNav.dataset.page = 'stabilization';
stNav.innerHTML = '<svg viewBox="0 0 24 24"><path d="M3 3h6v2H5v4H3zm12 0h6v6h-2V5h-4zM3 15h2v4h4v2H3zm16 0h2v6h-6v-2h4zM7 11h10v2H7z"/></svg>Stabilization';
document.querySelector('.nav[data-page="encoder"]').after(stNav);
stNav.addEventListener('click', () => go('stabilization'));
let st = { clips: [], running: false }, stKey = '', stPreview = null, stPreviewRequest = 0, stLoadedFrame = -1;
const stAnchors = new Map();
function stRender() {
  $('st-timeline').textContent = st.timeline || '';
  $('st-clips').innerHTML = st.clips.length ? st.clips.map(c => `<div class="st-clip"><label><input type="checkbox" data-st-select="${esc(c.key)}" ${c.selected ? 'checked' : ''} ${st.running || st.hasCopy || c.fusion ? 'disabled' : ''}> ${esc(c.marker)} · ${esc(c.color)} · ${esc(c.name)}</label><span class="muted small">${c.frames} frames · ${esc(c.status)} ${c.status === 'Tracking' ? `${c.points || ''} points · ${c.percent || 0}%` : ''}${stAnchors.get(c.key) ? ' · own point set' : ''}</span>${c.reason ? `<span class="muted small">${esc(c.reason)}</span>` : ''}<button class="btn" data-st-review="${esc(c.key)}" ${st.running || st.hasCopy || c.fusion ? 'disabled' : ''}>Choose points (optional)</button></div>`).join('') : 'No clips found for this marker color.';
  $('st-scan').disabled = st.running; $('st-color').disabled = st.running;
  $('st-start').disabled = st.running || st.hasCopy || !st.clips.some(c => c.selected);
  $('st-stop').disabled = !st.running || st.stopping;
  $('st-review').classList.toggle('hidden', Boolean(!stKey || st.running || st.hasCopy));
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
$('st-scan').addEventListener('click',async()=>{try{const r=await pilot.stabilize('scan',{color:$('st-color').value});if(!r.ok)throw Error(r.error);const chosen=$('st-color').value;$('st-color').innerHTML='<option value="All">All colors</option>'+r.colors.map(c=>`<option value="${esc(c)}">${esc(c)}</option>`).join('');$('st-color').value=r.colors.includes(chosen)?chosen:'All';stAnchors.clear();stKey='';stPreview=null;st={clips:r.clips.map(c=>({...c,selected:!c.fusion,status:c.fusion?'Existing Fusion — manual review':'Choose anchor'})),timeline:r.timeline,running:false};stRender();}catch(e){toast(e.message,true);}});
$('st-start').addEventListener('click',async()=>{const chosen=st.clips.filter(c=>c.selected);const anchors=[];for(const c of chosen){const a=stAnchors.get(c.key);if(!a)continue;anchors.push({key:c.key,x:a.x,y:a.y,width:a.width,height:a.height});for(const p of a.verificationPoints||[])anchors.push({key:c.key,x:p.x,y:p.y});}try{const r=await pilot.stabilize('start',{keys:chosen.map(c=>c.key),anchors});if(!r.ok)throw Error(r.error);$('st-result').textContent=`Finished: ${r.timeline}. Review the timeline copy in Resolve.`;}catch(e){$('st-result').textContent=e.message;toast(e.message,true);}});
$('st-stop').addEventListener('click',()=>pilot.stabilize('stop'));
pilot.onStabilize(s=>{const selections=new Map(st.clips.map(c=>[c.key,c.selected]));st={...s,clips:s.clips.map(c=>({...c,selected:selections.get(c.key)??c.selected}))};stRender();});
pilot.stabilize('summary').then(s=>{if(s.ok){st=s;stRender();}});
