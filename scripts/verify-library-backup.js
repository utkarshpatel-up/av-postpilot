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
  if (document.querySelector('nav .nav:last-child').dataset.page !== 'librarybackup') throw Error('Library Backup is not last in sidebar');
  if ($('lb-mac-export')) throw Error('Legacy Mac installer still shown');
  if (!$('lb-libraries').textContent.includes('edit_share_18') || !$('lb-libraries').textContent.includes('42')) throw Error('Mac library/count not rendered');
  if (!$('lb-log').textContent.includes('Fixture backup finished')) throw Error('Backup log not rendered');
  if (!$('lb-server-form').classList.contains('hidden')) throw Error('Monitor mode shows server controls');
  if ($('lb-root-row').parentElement.id !== 'lb-monitor-folder-slot' || $('lb-age-row').parentElement.id !== 'lb-monitor-age-slot') throw Error('Monitor layout changed');
  $('lb-mode').value = 'server'; await saveLibraryForm(); await renderLibraryForm();
  if ($('lb-server-form').classList.contains('hidden')) throw Error('Server setup missing');
  if ($('lb-root-row').parentElement.id !== 'lb-server-folder-slot' || $('lb-age-row').parentElement.id !== 'lb-server-age-slot') throw Error('Server folder/age layout not moved');
  if (!$('lb-time-chips').textContent.includes('2:00 PM')) throw Error('Legacy schedule not shown in AM/PM');
  $('lb-time-hour').value = '12'; $('lb-time-minute').value = '00'; $('lb-time-period').value = 'AM'; $('lb-time-add').click();
  await new Promise(r => setTimeout(r, 250));
  if (!settings.libraryBackup.times.includes('00:00')) throw Error('Midnight conversion failed');
  document.querySelector('[data-edit-time="00:00"]').click();
  $('lb-time-period').value = 'PM'; $('lb-time-add').click();
  await new Promise(r => setTimeout(r, 250));
  if (!settings.libraryBackup.times.includes('12:00') || settings.libraryBackup.times.includes('00:00')) throw Error('Noon edit failed');
  $('lb-time-add').click(); await new Promise(r => setTimeout(r, 250));
  if (settings.libraryBackup.times.split(',').length !== 6) throw Error('Duplicate time was saved');
  document.querySelector('[data-remove-time="12:00"]').click(); await new Promise(r => setTimeout(r, 250));
  if (settings.libraryBackup.times.split(',').length !== 5) throw Error('Time removal failed');
  await pilot.setSecret('postgres', 'fixture-password'); await renderLibraryForm();
  if (!$('lb-password-has').textContent.includes('saved')) throw Error('Secret state missing');
  await pilot.setSecret('postgres', '');
  await saveLibraryForm(); await renderLibraryForm(); await refreshLibraryStatus();
  $('toast').classList.add('hidden');
  if (${Boolean(process.env.AVPP_DEV_UI)}) {
    settings.libraryBackup.root = '/Users/ambavideo/ResolveBackup';
    settings.libraryBackup.pgBin = '/Library/PostgreSQL/13/bin';
    $('lb-schedule').textContent = 'Export Mac schedule setup';
    $('lb-unattended-row').classList.add('hidden');
    $('lb-schedule-help').textContent = 'Run bash install.sh in the exported schedule folder on the Mac server. Keep this Mac user logged in and re-export after changing times.';
    await renderLibraryForm();
  }
  $('lb-server-form').scrollIntoView({ block: 'start' });
  return JSON.stringify({ ok: true, version: (await pilot.getInitial()).version, folderLayout: ['.backup-folder-pair', '#lb-server-folder-slot', '#lb-root-row', '#lb-root', '#lb-copyRoot'].map(selector => { const e=document.querySelector(selector), s=getComputedStyle(e), r=e.getBoundingClientRect(); return {selector,width:r.width,display:s.display,columns:s.gridTemplateColumns,flex:s.flex,min:s.minWidth}; }) });
})()`);
const child = spawn(process.env.AVPP_DEV_UI ? path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe') : path.join(root, 'dist', 'win-unpacked', 'AV PostPilot.exe'), process.env.AVPP_DEV_UI ? [root] : [], { cwd: root, windowsHide: true, env: { ...process.env, AVPP_USERDATA: dir, AVPP_SCREENSHOT: dir, AVPP_PAGES: 'librarybackup', AVPP_EVAL_FILE: evalFile }, stdio: 'pipe' });
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
    console.log(`${process.env.AVPP_DEV_UI ? 'Development preview' : 'Packaged'} library backup UI passed: counts/log, setup modes, AM/PM add/edit/remove, duplicate rejection and password controls.`);
  } catch (err) { console.error(err.message); console.error(errors.slice(-1000)); process.exitCode = 1; }
});
