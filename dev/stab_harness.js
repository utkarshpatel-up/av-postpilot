// npx electron dev/stab_harness.js <timelineIndex> <keys,comma>  — runs the real controller against Resolve
const { app, nativeImage } = require('electron');
const fs = require('fs'), path = require('path');
const { ResolveBridge } = require('../electron/resolve-bridge');
const { Stabilization } = require('../electron/stabilization');
const { createFrameGrabber } = require('../electron/stabilization-frames');
const dir = path.join(__dirname, 'stab-harness'); fs.mkdirSync(dir, { recursive: true });
for (const f of ['bridge.lua', 'stabilization.lua']) fs.copyFileSync(path.join(__dirname, '..', 'electron', f), path.join(dir, f));
const [tlIndex, keys] = process.argv.slice(-2);
app.whenReady().then(async () => {
  const log = (l, m) => console.log(new Date().toISOString().slice(11, 19), l, m);
  const bridge = new ResolveBridge({ getFuscriptPath: () => 'C:/Program Files/Blackmagic Design/DaVinci Resolve/fuscript.exe', luaFile: path.join(dir, 'bridge.lua'), log });
  const raw = bridge.stabilize.bind(bridge); bridge.stabilize = async a => { const r = await raw(a); if (a.action === 'track') fs.writeFileSync(path.join(dir, 'points.json'), JSON.stringify(a.points)); if (a.action === 'progress' && r.paths) fs.writeFileSync(path.join(dir, 'paths.json'), JSON.stringify(r)); if (a.action === 'apply') fs.writeFileSync(path.join(dir, 'apply.json'), JSON.stringify(a)); return r; };
  let last = '';
  const s = new Stabilization({ bridge, log, grab: createFrameGrabber({ bridge, nativeImage, directory: path.join(dir, 'frames') }),
    saveReport: r => fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(r, null, 1)),
    onChange: x => { const line = x.clips.filter(c => keys.split(',').includes(c.key)).map(c => `${c.key} ${c.status} ${c.status === 'Tracking' ? (c.percent || 0) + '%' : ''} ${c.reason || ''}`).join(' | '); if (line !== last) { last = line; log('state', line); } } });
  try {
    console.log(await bridge.status?.());
    const t0 = Date.now();
    const r = await s.scan('Blue'); if (!r.ok) throw Error(r.error); log('scan', r.timeline + ' ' + r.clips.map(c => c.key + (c.fusion ? '(fusion)' : '')).join(','));
    await s.start(keys.split(','));
    log('done', `${((Date.now() - t0) / 60000).toFixed(1)} min`);
  } catch (e) { log('ERROR', e.stack); }
  app.quit();
});
