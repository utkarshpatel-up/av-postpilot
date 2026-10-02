const path = require('path');
const { ResolveBridge } = require('../electron/resolve-bridge');
const FUS = path.join('C:/Program Files/Blackmagic Design/DaVinci Resolve', 'fuscript.exe');
const bridge = new ResolveBridge({ getFuscriptPath: () => FUS, luaFile: path.join(__dirname, '..', 'electron', 'bridge.lua'), log: console.log });
(async () => {
  const src = path.join(__dirname, 'renders7', 'EP-8911 Part 5.mov');
  const r = await bridge.startHdJobs({ preset: 'YouTube - 720p', dir: path.join(__dirname, 'hd_out4'), bin: 'Reviewed Episode',
    jobs: [{ file: src, timeline: 'Review EP-8911 Part 5 b', name: 'EP-8911 Part 5_HD' }] });
  console.log('start', JSON.stringify(r));
  for (let i = 0; i < 60; i++) {
    const s = await bridge.status();
    const j = s.jobs.find((x) => r.ids.includes(x.id));
    if (j && j.status === 'Complete') { console.log('HD job', j.file, j.width + 'x' + j.height, j.status); break; }
    await new Promise((res) => setTimeout(res, 1000));
  }
  bridge.stop();
})();
