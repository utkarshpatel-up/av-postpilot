// End-to-end v2 check against the running Resolve (test footage only).
const fs = require('fs');
const path = require('path');
const { ResolveBridge } = require('../electron/resolve-bridge');
const ps = require('../electron/project-setup');
const ep = require('../electron/episodes');

const bridge = new ResolveBridge({
  getFuscriptPath: () => 'C:\\Program Files\\Blackmagic Design\\DaVinci Resolve\\fuscript.exe',
  luaFile: path.join(__dirname, '..', 'electron', 'bridge.lua'),
  log: (l, m) => console.log(l, m),
});

(async () => {
  const name = `PP Test-2978 to 2980 ${Date.now() % 100000}`;
  const loc = path.join(__dirname, 'projects');
  const root = ps.createProjectFolders(loc, name);
  const sf = path.join(root, 'Satsang Files');
  const days = [];
  for (const d of fs.readdirSync(path.join(__dirname, 'testsrc'))) {
    days.push((await ps.transferFolder(path.join(__dirname, "testsrc", d), sf, { move: false })).dest);
  }
  const scanned = days.map(ps.scanDay);
  for (const d of scanned) for (const s of d.sessions) console.log(' ', s.master, '/', s.edit, s.clips.map((c) => path.basename(c)));
  const res = await bridge.setupProject({
    project: name, bins: ps.BINS,
    dirs: ps.mediaTree(sf, ['Satsang Files']).filter((d) => d.bin.length > 1),
    timelines: scanned.flatMap((d) => d.sessions.map((s) => ({ master: s.master, edit: s.edit, clips: s.clips }))),
  });
  console.log('SETUP', JSON.stringify(res));

  const plan = ep.planSeries({ series: 'Hindi Shibir', title: 'DD Hindi', subtitle: '(Hindi Shibir, Adalaj)', start: 1, showNumber: false,
    rows: [{ cue: '2978', count: 2 }, { cue: '2980 E1', count: 1 }] });
  console.log('SERIES', JSON.stringify(await bridge.createSeries({ episodes: plan, font: 'Calibri', style: 'Bold', size: 0.08 })));

  const tl = await bridge.listTimelines();
  const found = ep.findSeries(tl.names);
  console.log('FOUND', found.map((s) => `${s.series} x${s.count}`));
  const items = ep.planRename(found.find((s) => s.series === 'Hindi Shibir'), { series: 'DD Hindi', title: 'DD Hindi', start: 1750, showNumber: true });
  const oldSet = Object.fromEntries(items.map((i) => [i.old, true]));
  console.log('RENAME', JSON.stringify(await bridge.renameSeries({ items, oldSet })));
  console.log('AFTER', JSON.stringify((await bridge.listTimelines()).names));
  bridge.stop();
})().catch((e) => { console.error(e); bridge.stop(); });
