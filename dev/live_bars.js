// Creates two episodes (plain + colour bars) with the real bridge and grabs a still of each.
const path = require('path');
const { ResolveBridge } = require('../electron/resolve-bridge');
const ep = require('../electron/episodes');
const FUS = path.join('C:/Program Files/Blackmagic Design/DaVinci Resolve', 'fuscript.exe');
const bridge = new ResolveBridge({ getFuscriptPath: () => FUS, luaFile: path.resolve(__dirname, '../electron/bridge.lua'), log: console.log });
(async () => {
  const stamp = Date.now() % 100000;
  const b = await bridge.barsStill(path.join(__dirname));
  console.log('bars still', JSON.stringify(b));
  for (const [bg, cue] of [[null, `plain${stamp}`], [b.path, `bars${stamp}`]]) {
    const plan = ep.planSeries({ series: 'DD Vitraag', title: 'DD Vitraag', subtitle: '(Adalaj)', start: 8912, showNumber: true, rows: [{ cue, count: 1 }] });
    const r = await bridge.createSeries({ episodes: plan, font: 'Calibri', style: 'Bold', size: 0.11, background: bg, centerY: bg ? 0.6 : null });
    console.log(bg ? 'bars' : 'plain', JSON.stringify(r));
  }
  // rename must still find the Text+ inside the bars title
  const tl = await bridge.listTimelines();
  const s = ep.findSeries(tl.names.filter((n) => n.includes(String(stamp)))).find((x) => x.series === 'DD Vitraag');
  const items = ep.planRename(s, { series: 'DD Vitraag', title: 'DD Vitraag', start: 9001, showNumber: true });
  console.log('rename', JSON.stringify(await bridge.renameSeries({ items, oldSet: Object.fromEntries(items.map((i) => [i.old, true])) })));
  bridge.stop();
})();
