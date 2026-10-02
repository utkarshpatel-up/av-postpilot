// Runs one real auto-save against the running Resolve, without Electron.
const os = require('os');
const path = require('path');
const { ResolveBridge } = require('../electron/resolve-bridge');
const { AutoSaver } = require('../electron/autosave');

const log = (l, m) => console.log(l.toUpperCase(), m);
const bridge = new ResolveBridge({
  getFuscriptPath: () => 'C:\\Program Files\\Blackmagic Design\\DaVinci Resolve\\fuscript.exe',
  luaFile: path.join(__dirname, '..', 'electron', 'bridge.lua'),
  log,
});
const settings = { autosave: { enabled: true, intervalMin: 1, keepDays: 30, keepMin: 20, skipUntitled: true,
  destinations: [{ path: path.join(__dirname, 'dest-local'), enabled: true }] } };
const saver = new AutoSaver({ bridge, getSettings: () => settings, state: { fp: {} }, saveState: () => {},
  log, onChange: () => {}, tmpDir: path.join(os.tmpdir(), 'av-postpilot') });

(async () => {
  console.log('status', JSON.stringify(await bridge.status()));
  console.log('run', JSON.stringify(await saver.run('manual')));
  bridge.stop();
})();
