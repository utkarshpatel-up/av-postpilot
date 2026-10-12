// Dev: create two test episodes (plain + colour bars) through bridge.lua. node dev/series_test.js
const { execFileSync } = require('child_process');
const { toLua } = require('../electron/resolve-bridge');
const bars = process.argv[2] || '';
const lines = [
  'series\t' + toLua({ bin: 'PostPilot Test', font: 'Calibri', style: 'Bold', size: 0.11, episodes: [{ name: 'PP Test Plain', line1: 'DD Vitrag - 9999', subtitle: '(Adalaj)' }] }),
  'series\t' + toLua({ bin: 'PostPilot Test', font: 'Calibri', style: 'Bold', size: 0.11, background: bars, centerY: 0.6, episodes: [{ name: 'PP Test Bars', line1: 'DD Vitrag - 9998', subtitle: '(Adalaj)' }] }),
  'quit',
];
const out = execFileSync('C:\\Program Files\\Blackmagic Design\\DaVinci Resolve\\fuscript.exe', ['-l', 'lua', 'C:\\Users\\admin\\Downloads\\av-postpilot\\electron\\bridge.lua'],
  { input: lines.join('\n') + '\n', encoding: 'utf8', cwd: 'C:\\Users\\admin\\Downloads\\av-postpilot\\electron', timeout: 120000 });
console.log(out.split('\n').filter(l => l.startsWith('{')).join('\n'));
