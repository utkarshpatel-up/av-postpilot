const test = require('node:test');
const assert = require('node:assert/strict');
const { sendEmail, recipients, emailOptions } = require('../electron/email');
const { Notifier } = require('../electron/notify');
const email = { enabled: true, user: 'sender@gmail.com', recipients: ['me@gmail.com', 'team@office.com'] };
const settings = () => ({ notify: {
  email, ntfy: { enabled: true, server: 'https://ntfy.sh', topic: 'studio-tests' },
  telegram: { enabled: false, chats: [] }, whapi: { enabled: false, chats: [] },
  events: { renderDone: true, renderFailed: false },
} });

test('recipient validation rejects header syntax and removes duplicates', () => {
  assert.deepEqual(recipients('ME@gmail.com, me@gmail.com; team@office.com'), ['me@gmail.com', 'team@office.com']);
  assert.throws(() => recipients(''), /at least one/);
  assert.throws(() => recipients('Me <me@gmail.com>'), /plain email/);
  assert.throws(() => recipients(['me@gmail.com\r\nBcc:other@gmail.com']), /plain email/);
  assert.throws(() => emailOptions(email, ''), /App Password/);
});

test('Gmail uses TLS, app password, full event body and one recipient', async () => {
  let options, message, closed = false;
  await sendEmail(email, 'abcd efgh ijkl mnop', 'team@office.com', '✅ Rendered: Episode.mov\nProject: Edit-1207\n— PC3', (opts) => {
    options = opts;
    return { sendMail: async (msg) => { message = msg; return { accepted: ['team@office.com'], rejected: [] }; }, close: () => { closed = true; } };
  });
  assert.equal(options.host, 'smtp.gmail.com');
  assert.equal(options.port, 465);
  assert.equal(options.secure, true);
  assert.equal(options.auth.pass, 'abcdefghijklmnop');
  assert.equal(options.disableFileAccess, true);
  assert.deepEqual(message.to, ['team@office.com']);
  assert.equal(message.subject, '[AV PostPilot] ✅ Rendered: Episode.mov');
  assert.match(message.text, /Project: Edit-1207\n— PC3/);
  assert.equal(closed, true);
});

test('rejected email is a failure and closes the transport', async () => {
  let closed = false;
  await assert.rejects(sendEmail(email, 'password', 'me@gmail.com', 'Hello', () => ({
    sendMail: async () => ({ accepted: [], rejected: ['me@gmail.com'] }), close: () => { closed = true; },
  })), /did not accept/);
  assert.equal(closed, true);
});

test('email failure does not stop ntfy; reports partial delivery and respects event and channel filters', async () => {
  const original = global.fetch;
  const calls = [], logs = [], emails = [];
  global.fetch = async (_url, opts) => { calls.push(JSON.parse(opts.body)); return { ok: true, text: async () => '{}' }; };
  try {
    const n = new Notifier({ getSettings: settings, getSecret: () => 'secret-value', pc: 'PC3', log: (_level, msg) => logs.push(msg),
      emailSend: async (_cfg, _pass, to, body) => { emails.push({ to, body }); if (to === 'team@office.com') throw new Error('Rejected secret-value'); },
    });
    assert.equal(await n.notify('renderDone', 'Rendered\nProject: Edit-1207'), 2);
    assert.equal(emails.length, 2);
    assert.match(emails[0].body, /— PC3$/);
    assert.equal(calls[0].title, 'Rendered');
    assert.match(calls[0].message, /— PC3$/);
    assert.ok(logs[0].includes('[redacted]'));
    assert.ok(!logs[0].includes('secret-value'));
    assert.equal(await n.notify('renderFailed', 'Skipped'), 0);
    const report = await n.sendReport('Test', 'email');
    assert.equal(report.sent, 1);
    assert.equal(report.attempted, 2);
    assert.equal(report.errors.length, 1);
    assert.equal(calls.length, 1);
    const before = emails.length;
    assert.equal((await n.sendReport('Test', 'ntfy')).sent, 1);
    assert.equal(emails.length, before);
  } finally { global.fetch = original; }
});

test('legacy settings work; invalid email recipients produce a clear error', async () => {
  const legacy = settings();
  delete legacy.notify.email;
  legacy.notify.ntfy.enabled = false;
  const n = new Notifier({ getSettings: () => legacy, getSecret: () => '', log: () => {}, pc: 'PC3' });
  assert.equal(await n.sendAll('Test'), 0);
  legacy.notify.email = { ...email, recipients: ['invalid'] };
  const report = await n.sendReport('Test');
  assert.equal(report.sent, 0);
  assert.match(report.errors[0], /plain email/);
});
