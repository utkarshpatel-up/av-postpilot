// Isolated packaged UI check: no PostgreSQL connection, sends, or task installation.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const assert = require('assert/strict');
const root = path.resolve(__dirname, '..');
const dir = path.join(root, 'dist', 'library-check');
const backup = path.join(dir, 'mac-fixture');
fs.mkdirSync(path.join(backup, 'db', 'edit_share_18'), { recursive: true });
fs.mkdirSync(path.join(backup, 'state'), { recursive: true });
fs.writeFileSync(path.join(backup, 'db', 'edit_share_18', 'fixture.dump'), 'test fixture, not a real dump');
fs.writeFileSync(path.join(backup, 'state', 'edit_share_18.count'), '42');
fs.writeFileSync(path.join(backup, 'backup.log'), 'Fixture backup finished');
fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ launchResolve: false, autosave: { enabled: false }, libraryBackup: { mode: 'monitor', root: backup }, notify: { ntfy: { enabled: false }, email: { enabled: false } } }));
const evalFile = path.join(dir, 'check.js');
fs.writeFileSync(evalFile, `(async () => {
  go('librarybackup'); await renderLibraryForm(); await refreshLibraryStatus();
  if (!$('lb-libraries').textContent.includes('edit_share_18') || !$('lb-libraries').textContent.includes('42')) throw Error('Mac library/count not rendered');
  if (!$('lb-log').textContent.includes('Fixture backup finished')) throw Error('Backup log not rendered');
  if (!$('lb-server-form').classList.contains('hidden')) throw Error('Monitor mode shows server controls');
  $('lb-mode').value = 'server'; await saveLibraryForm(); await renderLibraryForm();
  if ($('lb-server-form').classList.contains('hidden')) throw Error('Server setup missing');
  await pilot.setSecret('postgres', 'fixture-password'); await renderLibraryForm();
  if (!$('lb-password-has').textContent.includes('saved')) throw Error('Secret state missing');
  await pilot.setSecret('postgres', '');
  $('lb-mode').value = 'monitor'; await saveLibraryForm(); await renderLibraryForm(); await refreshLibraryStatus();
  return JSON.stringify({ ok: true, version: (await pilot.getInitial()).version });
})()`);
const child = spawn(path.join(root, 'dist', 'win-unpacked', 'AV PostPilot.exe'), [], { cwd: root, windowsHide: true, env: { ...process.env, AVPP_USERDATA: dir, AVPP_SCREENSHOT: dir, AVPP_PAGES: 'librarybackup', AVPP_EVAL_FILE: evalFile, AVPP_MAXIMIZE: '1' }, stdio: 'pipe' });
let errors = ''; child.stderr.on('data', d => { errors += d; });
const timeout = setTimeout(() => { child.kill(); console.error('UI check timed out'); process.exitCode = 1; }, 45000);
child.on('error', e => { clearTimeout(timeout); console.error(e.message); process.exitCode = 1; });
child.on('exit', () => {
  clearTimeout(timeout);
  try {
    const result = JSON.parse(fs.readFileSync(path.join(dir, 'eval-result.txt'), 'utf8'));
    assert.equal(result.ok, true); assert.equal(result.version, require('../package.json').version);
    assert.ok(!fs.readFileSync(path.join(dir, 'secrets.json'), 'utf8').includes('fixture-password'));
    assert.ok(fs.statSync(path.join(dir, 'librarybackup.png')).size > 0);
    console.log('Packaged library backup UI passed: Mac counts/log, setup modes, encrypted password controls.');
  } catch (err) { console.error(err.message); console.error(errors.slice(-1000)); process.exitCode = 1; }
});
