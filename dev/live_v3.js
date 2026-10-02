const FUS = require('path').join('C:/Program Files/Blackmagic Design/DaVinci Resolve', 'fuscript.exe');
const path = require('path');
const { ResolveBridge } = require('../electron/resolve-bridge');
const { RenderWatcher } = require('../electron/renders');
const { SceneQueue } = require('../electron/scenequeue');
const { execFileSync } = require('child_process');
const log = (l, m) => console.log(l.toUpperCase(), m);
const bridge = new ResolveBridge({ getFuscriptPath: () => FUS, luaFile: path.join(__dirname, '..', 'electron', 'bridge.lua'), log });
const notifier = { notify: async (ev, t) => console.log(`  [notify:${ev}]`, t.replace(/\n/g, ' | ')) };
(async () => {
  const tl = await bridge.listTimelines();
  const names = tl.names.filter((n) => n.startsWith('CutQ'));
  const q = new SceneQueue({ bridge, notifier, log, onChange: () => {}, onQueueDone: (a, w) => console.log('  [after]', a, w), getSettings: () => ({ scene: { afterQueue: 'nothing' } }) });
  q.add(tl.project, []);
  

  const w = new RenderWatcher({ getSettings: () => ({ renders: { copyEnabled: true, copyDest: path.join(__dirname, 'copydest7'), afterQueue: 'shutdown' } }),
    notifier, log, onChange: () => {}, onQueueDone: (a, what) => { console.log('  [after]', a, what, '(shutdown NOT executed in test)'); done = true; } });
  let done = false;
  w.update(await bridge.status());
  // queue two jobs and start rendering from a separate script, like an editor would in Resolve
  const lua = `local p=bmd.scriptapp('Resolve','localhost'):GetProjectManager():GetCurrentProject()
    for i=1,p:GetTimelineCount() do local t=p:GetTimelineByIndex(i); if t:GetName():match('^CutQ') then p:SetCurrentTimeline(t)
      p:SetRenderSettings({TargetDir=[[${path.join(__dirname, 'renders7')}]], CustomName='EP-8911 Part '..i}); p:AddRenderJob() end end
    p:StartRendering()`;
  require('fs').writeFileSync(path.join(__dirname, 'start_render.lua'), lua);
  execFileSync(FUS, ['-l', 'lua', path.join(__dirname, 'start_render.lua')]);
  for (let i = 0; i < 40 && !done; i++) { const st = await bridge.status(); console.log(new Date().toISOString().slice(17,23), 'rendering=' + st.rendering, (st.jobs||[]).map((j) => j.id.slice(0,8) + ':' + j.file + ':' + j.status).join(', ')); w.update(st); console.log('   seen:', JSON.stringify([...w.seen].map(([k,v]) => k.slice(0,8)+'='+v)), 'project:', w.project); await new Promise((r) => setTimeout(r, 1000)); }
  console.log('copies', JSON.stringify(w.summary()));
  bridge.stop();
})();
