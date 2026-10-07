const test = require('node:test');
const assert = require('node:assert/strict');
const { Notifier, setHttpFetch } = require('../electron/notify');

test('saved destinations toggle without deletion and route each event independently', async () => {
  const calls = [], mail = [];
  setHttpFetch(async (_url, opts) => { calls.push(JSON.parse(opts.body).topic); return { ok: true, text: async () => '{}' }; });
  const cfg = {
    telegram: { enabled: false }, whapi: { enabled: false },
    events: { encoderGroupDone: true, encoderQueueDone: true, renderDone: false },
    ntfy: { enabled: true, topics: ['personal', 'team', 'paused'], targets: { team: { events: { encoderGroupDone: false } }, paused: { enabled: false } } },
    email: { enabled: true, recipients: ['personal@example.com', 'team@example.com', 'paused@example.com'], targets: { 'team@example.com': { events: { encoderGroupDone: false } }, 'paused@example.com': { enabled: false } } },
  };
  const n = new Notifier({ getSettings: () => ({ notify: cfg }), getSecret: () => '', pc: 'PC', log: () => {}, emailSend: async (_cfg, _password, to) => mail.push(to) });
  try {
    assert.equal(await n.notify('encoderGroupDone', 'Group done'), 2);
    assert.deepEqual(calls.splice(0), ['personal']); assert.deepEqual(mail.splice(0), ['personal@example.com']);
    assert.equal(await n.notify('encoderQueueDone', 'Queue done'), 4);
    assert.deepEqual(calls.splice(0), ['personal', 'team']); assert.deepEqual(mail.splice(0), ['personal@example.com', 'team@example.com']);
    assert.equal(await n.notify('renderDone', 'Off globally'), 0);
    cfg.ntfy.targets.paused.enabled = true; cfg.email.targets['paused@example.com'].enabled = true;
    assert.equal(await n.notify('encoderQueueDone', 'Queue done'), 6);
    assert.equal(cfg.ntfy.topics.length, 3); assert.equal(cfg.email.recipients.length, 3);
    calls.length = 0; mail.length = 0;
    assert.equal((await n.sendReport('Channel test', 'ntfy')).sent, 3);
    assert.deepEqual(calls, ['personal', 'team', 'paused']); assert.equal(mail.length, 0);
  } finally { setHttpFetch((...args) => fetch(...args)); }
});
