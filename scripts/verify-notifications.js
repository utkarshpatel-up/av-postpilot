// Smoke-test the packaged Electron UI with isolated settings and no external sends.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const assert = require('assert/strict');
const root = path.resolve(__dirname, '..');
const dir = path.join(root, 'dist', 'notification-check');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ launchResolve: false, autosave: { enabled: false }, notify: { ntfy: { enabled: false, topic: 'legacy-personal' }, email: { enabled: false } } }));
const evalFile = path.join(dir, 'check.js');
fs.writeFileSync(evalFile, `(async () => {
  go('notify');
  await renderNotify();
  const wait = () => new Promise(r => setTimeout(r, 300));
  if (!$('nt-email-test') || !$('nt-ntfy-test')) throw Error('Missing channel test buttons');
  if (ntfyTopicList()[0] !== 'legacy-personal') throw Error('Legacy topic not preserved');
  $('nt-ntfy-topic').value = 'office-team';
  $('nt-ntfy-add').click();
  await wait();
  if (ntfyTopicList().length !== 2 || document.querySelectorAll('[data-copy-topic]').length !== 2) throw Error('Topic add failed');
  $('nt-ntfy-topic').value = 'office-team';
  $('nt-ntfy-add').click();
  await wait();
  if (ntfyTopicList().length !== 2) throw Error('Duplicate topic was added');
  $('nt-ntfy-topic').value = 'bad topic!';
  $('nt-ntfy-add').click();
  await wait();
  if (ntfyTopicList().length !== 2) throw Error('Invalid topic was added');
  document.querySelector('[data-del-topic="office-team"]').click();
  await wait();
  if (ntfyTopicList().length !== 1) throw Error('Topic removal failed');
  await addNtfyTopic('office-team');
  if (getComputedStyle($('nt-email-user')).backgroundColor !== getComputedStyle($('nt-email-recipients')).backgroundColor) throw Error('Email field does not match the app theme');
  $('nt-email-user').value = 'sender@gmail.com';
  $('nt-email-recipients').value = 'me@gmail.com, team@office.com';
  await saveEmailForm();
  if (settings.notify.email.recipients.length !== 2) throw Error('Recipients not saved');
  $('nt-email-on').checked = true;
  $('nt-email-on').dispatchEvent(new Event('change'));
  await wait();
  if (settings.notify.email.enabled || $('nt-email-on').checked) throw Error('Enabled without password');
  await pilot.setSecret('email', 'abcdefghijklmnop');
  await renderNotify();
  if ($('nt-email-has').textContent !== 'Password saved') throw Error('Secret state not displayed');
  $('nt-email-on').checked = true;
  $('nt-email-on').dispatchEvent(new Event('change'));
  await wait();
  if (!settings.notify.email.enabled) throw Error('Email not enabled');
  $('nt-email-clear').click();
  await wait();
  if (settings.notify.email.enabled || (await pilot.hasSecrets()).email) throw Error('Password removal failed');
  $('toast').classList.add('hidden');
  $('nt-ntfy-topics').scrollIntoView({ block: 'start' });
  return JSON.stringify({ ok: true, version: (await pilot.getInitial()).version, recipients: settings.notify.email.recipients, emailDisabled: !settings.notify.email.enabled });
})()`);
const child = spawn(path.join(root, 'dist', 'win-unpacked', 'AV PostPilot.exe'), [], {
  cwd: root, windowsHide: true,
  env: { ...process.env, AVPP_USERDATA: dir, AVPP_SCREENSHOT: dir, AVPP_PAGES: 'notify', AVPP_EVAL_FILE: evalFile, AVPP_MAXIMIZE: '1' },
  stdio: 'pipe',
});
let errors = '';
child.stderr.on('data', d => { errors += d; });
const timeout = setTimeout(() => { child.kill(); console.error('Packaged UI check timed out'); process.exitCode = 1; }, 45000);
child.on('error', err => { clearTimeout(timeout); console.error(err.message); process.exitCode = 1; });
child.on('exit', () => {
  clearTimeout(timeout);
  try {
    const result = JSON.parse(fs.readFileSync(path.join(dir, 'eval-result.txt'), 'utf8'));
    assert.equal(result.ok, true);
    assert.equal(result.version, require('../package.json').version);
    assert.equal(result.emailDisabled, true);
    assert.equal(result.recipients.length, 2);
    const saved = fs.readFileSync(path.join(dir, 'secrets.json'), 'utf8');
    assert.ok(!saved.includes('abcdefghijklmnop'));
    assert.ok(fs.statSync(path.join(dir, 'notify.png')).size > 0);
    console.log('Packaged UI verified: legacy topic migrated, + Add and remove work, duplicates/invalid topics rejected, email credential controls work. No external messages sent.');
    console.log('Screenshot: ' + path.join(dir, 'notify.png'));
  } catch (err) { console.error(err.message); if (errors) console.error(errors.slice(-2000)); process.exitCode = 1; }
});
