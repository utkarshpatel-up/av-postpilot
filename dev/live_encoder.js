const path = require('path');
const { ResolveBridge } = require('../electron/resolve-bridge');
const { Encoder } = require('../electron/encoder');
const FUS = path.join('C:/Program Files/Blackmagic Design/DaVinci Resolve', 'fuscript.exe');
const bridge = new ResolveBridge({ getFuscriptPath: () => FUS, luaFile: path.resolve(__dirname, '../electron/bridge.lua'), log: console.log });
let st = null;
const e = new Encoder({
  bridge, log: (l, m) => console.log(l.toUpperCase(), m), onChange: () => {},
  notifier: { notify: async (ev, t) => console.log(`  [notify:${ev}]`, t.replace(/\n/g, ' | ')) },
  onQueueDone: (a, w) => console.log('  [after]', a, w),
  getSettings: () => ({ encoder: { afterQueue: 'nothing' } }), loadState: () => st, saveState: (s) => { st = s; },
});
(async () => {
  const g1 = e.addGroup({ name: 'HD', preset: 'H.264 Master', dir: path.join(__dirname, 'enc_g1'), suffix: '_HD' });
  e.addPaths(g1.id, [path.join(__dirname, 'enc_src', 'clip25.mp4'), path.join(__dirname, 'enc_src', 'clip30.mp4')]);
  e.updateItem(g1.id, g1.items[1].id, { preset: 'YouTube - 720p' });
  const g2 = e.addGroup({ name: 'Single', preset: 'H.264 Master', dir: path.join(__dirname, 'enc_g2') });
  e.addPaths(g2.id, [path.join(__dirname, 'enc_src', 'clip30.mp4')]);
  console.log('RESULT', JSON.stringify(await e.start()));
  for (const g of e.groups) for (const i of g.items) console.log(' ', g.name, path.basename(i.file), i.state, i.info, '->', i.output, i.error || '');
  bridge.stop();
})();
