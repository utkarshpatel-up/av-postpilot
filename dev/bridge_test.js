// Drives bridge.lua through fuscript.exe like the app will.
const { spawn } = require('child_process');
const readline = require('readline');
const path = require('path');
const os = require('os');

const FUSCRIPT = 'C:\\Program Files\\Blackmagic Design\\DaVinci Resolve\\fuscript.exe';
const BRIDGE = 'C:\\Users\\admin\\Downloads\\av-postpilot\\electron\\bridge.lua';
const cmds = process.argv.slice(2);

const p = spawn(FUSCRIPT, ['-l', 'lua', BRIDGE], { windowsHide: true });
const rl = readline.createInterface({ input: p.stdout });
let i = 0;
const t0 = Date.now();
rl.on('line', (l) => {
  if (!l.startsWith('{')) return;
  console.log(`[${Date.now() - t0}ms]`, l);
  if (i < cmds.length) p.stdin.write(cmds[i++].replace('{TMP}', os.tmpdir()) + '\n');
  else p.stdin.write('quit\n');
});
p.stderr.on('data', (d) => process.stderr.write(d));
p.on('exit', (c) => console.log('exit', c));
