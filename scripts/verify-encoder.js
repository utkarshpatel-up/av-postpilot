// Isolated UI check; never starts Resolve encoding or copies user files.
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { spawn } = require('child_process');
const root = path.resolve(__dirname, '..');
const dir = path.join(root, 'dist', 'encoder-check');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ launchResolve: false, autosave: { enabled: false } }));
fs.writeFileSync(path.join(dir, 'state.json'), '{}');
const evalFile = path.join(dir, 'check.js');
fs.writeFileSync(evalFile, `(async () => {
  presets = ['H.264 Review'];
  const result = await pilot.encoder('addGroup', { name: 'Review exports', preset: 'H.264 Review', dir: 'D:/Exports', copyEnabled: false });
  if (!result.ok) throw Error(result.error);
  enc = (await pilot.getInitial()).encoder; go('encoder'); renderEncoder();
  const card = () => document.querySelector('[data-g="' + result.result.id + '"]');
  const row = () => card().querySelector('.g-copy-dir').parentElement;
  if (getComputedStyle(row()).display !== 'none') throw Error('Copy destination visible when off');
  card().querySelector('.g-copy-enabled').focus(); card().querySelector('.g-copy-enabled').click();
  if (getComputedStyle(row()).display === 'none') throw Error('Focused checkbox did not reveal destination immediately');
  await new Promise(r => setTimeout(r, 300));
  const input = card().querySelector('.g-copy-dir'); input.value = 'D:/Review'; input.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise(r => setTimeout(r, 300));
  card().querySelector('.g-copy-enabled').focus(); card().querySelector('.g-copy-enabled').click();
  await new Promise(r => setTimeout(r, 300));
  if (getComputedStyle(row()).display !== 'none' || card().querySelector('.g-copy-dir').value !== '') throw Error('Copy off must hide and clear destination');
  const saved = (await pilot.getInitial()).encoder.groups.find(g => g.id === result.result.id);
  if (saved.copyEnabled || saved.copyDir) throw Error('Cleared copy settings were not saved');
  card().querySelector('.g-copy-enabled').focus(); card().querySelector('.g-copy-enabled').click();
  await new Promise(r => setTimeout(r, 300));
  if (getComputedStyle(row()).display === 'none') throw Error('Destination did not reappear');
  return JSON.stringify({ ok: true, version: (await pilot.getInitial()).version });
})()`);
const dev = Boolean(process.env.AVPP_DEV_UI);
const child = spawn(dev ? path.join(root, 'node_modules/electron/dist/electron.exe') : path.join(root, 'dist/win-unpacked/AV PostPilot.exe'), dev ? [root] : [], {
  cwd: root, windowsHide: true, env: { ...process.env, AVPP_USERDATA: dir, AVPP_SCREENSHOT: dir, AVPP_EVAL_FILE: evalFile, AVPP_PAGES: 'encoder' }, stdio: 'pipe',
});
let errors = ''; child.stderr.on('data', d => { errors += d; });
const timer = setTimeout(() => { child.kill(); process.exitCode = 1; }, 45000);
child.on('error', e => { clearTimeout(timer); console.error(e.message); process.exitCode = 1; });
child.on('exit', () => {
  clearTimeout(timer);
  try {
    const result = JSON.parse(fs.readFileSync(path.join(dir, 'eval-result.txt'), 'utf8'));
    assert.equal(result.ok, true); assert.equal(result.version, require('../package.json').version);
    console.log('Encoder UI passed: focused checkbox reveals destination; disabling hides and clears the saved folder. No encoding started.');
  } catch (err) { console.error(err.message, errors.slice(-1000)); process.exitCode = 1; }
});
