const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { schedule, DEFAULTS, taskNames } = require('../electron/library-backup');
const s = { ...DEFAULTS, mode: 'server', root: '/tmp/x', times: '11:00,23:00' };

test('mac start writes both launch agents and bootstraps them; stop removes them', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lb-')), calls = [];
  const run = (cmd, args) => { calls.push([cmd, ...args].join(' ')); };
  assert.equal(schedule('start', s, '/Applications/AV PostPilot.app/Contents/MacOS/AV PostPilot', '/data', { platform: 'darwin', run, home, uid: 501 }).scheduled, true);
  const files = fs.readdirSync(path.join(home, 'Library', 'LaunchAgents'));
  assert.equal(files.length, 2);
  assert.match(fs.readFileSync(path.join(home, 'Library', 'LaunchAgents', files.find(f => !f.includes('health'))), 'utf8'), /<integer>23<\/integer>/);
  assert.equal(calls.filter(c => c.startsWith('launchctl bootstrap gui/501')).length, 2);
  schedule('stop', s, '/x', '/data', { platform: 'darwin', run, home, uid: 501 });
  assert.equal(fs.readdirSync(path.join(home, 'Library', 'LaunchAgents')).length, 0);
});
test('mac status is false when launchctl cannot find the job', () => {
  const run = () => { throw new Error('not found'); };
  assert.equal(schedule('status', s, '/x', '/data', { platform: 'darwin', run, home: os.tmpdir(), uid: 501 }).scheduled, false);
});
test('windows start registers both tasks without a password prompt; stop unregisters them', () => {
  const scripts = []; const run = (cmd, args) => { scripts.push(args.at(-1)); return ''; };
  schedule('start', s, 'C:\PostPilot\AV PostPilot.exe', 'C:\data', { platform: 'win32', run });
  assert.match(scripts[0], /Register-ScheduledTask/); assert.doesNotMatch(scripts[0], /Get-Credential/);
  schedule('stop', s, 'x', 'C:\data', { platform: 'win32', run });
  for (const n of taskNames('C:\data')) assert.match(scripts[1], new RegExp(n));
});
