// npx electron dev/stab_harness.js "<timeline name>=<track:index>,..." ["<name>=<keys>"]  — real controller against Resolve
const { app, nativeImage } = require('electron');
const fs = require('fs'), path = require('path');
const { ResolveBridge } = require('../electron/resolve-bridge');
const { Stabilization } = require('../electron/stabilization');
const { createFrameGrabber } = require('../electron/stabilization-frames');
const dir = path.join(__dirname, 'stab-harness'); fs.mkdirSync(dir, { recursive: true });
for (const f of ['bridge.lua', 'stabilization.lua']) fs.copyFileSync(path.join(__dirname, '..', 'electron', f), path.join(dir, f));
const wanted = process.argv.slice(2).filter(a => a.includes('=')).map(a => { const [name, keys] = a.split('='); return { name, keys: keys.split(',') }; });
app.whenReady().then(async () => {
  const log = (l, m) => console.log(new Date().toISOString().slice(11, 19), l, m);
  const bridge = new ResolveBridge({ getFuscriptPath: () => 'C:/Program Files/Blackmagic Design/DaVinci Resolve/fuscript.exe', luaFile: path.join(dir, 'bridge.lua'), log });
  const raw = bridge.stabilize.bind(bridge); bridge.stabilize = async a => { const r = await raw(a); if (a.action === 'track') fs.writeFileSync(path.join(dir, 'points.json'), JSON.stringify(a.points)); if (a.action === 'progress' && r.paths) fs.writeFileSync(path.join(dir, 'paths.json'), JSON.stringify(r)); return r; };
  let last = '';
  const s = new Stabilization({ bridge, log, grab: createFrameGrabber({ bridge, nativeImage, directory: path.join(dir, 'frames') }),
    saveReport: r => fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(r, null, 1)),
    onChange: x => { const line = x.clips.filter(c => c.selectedForRun).map(c => `${c.timelineName} ${c.lkey}: ${c.status} ${c.status === 'Tracking' ? '' : c.reason || ''}`).join(' | '); if (line !== last) { last = line; log('state', line); } } });
  try {
    const t0 = Date.now();
    const { timelines } = await s.timelines();
    const ids = wanted.map(w => { const t = timelines.find(t => t.name === w.name); if (!t) throw Error('no timeline ' + w.name); w.id = t.id; return t.id; });
    await s.scan('All', ids);
    const keys = wanted.flatMap(w => w.keys.map(k => `${w.id}|${k}`));
    s.clips.forEach(c => { c.selectedForRun = keys.includes(c.key); });
    await s.start(keys);
    log('done', `${((Date.now() - t0) / 60000).toFixed(1)} min`);
  } catch (e) { log('ERROR', e.stack); }
  app.quit();
});
