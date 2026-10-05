const test = require('node:test');
const assert = require('node:assert/strict');
const { Notifier, ntfyTopics } = require('../electron/notify');

test('legacy ntfy topic is preserved; an explicit empty list does not restore it', () => {
  assert.deepEqual(ntfyTopics({ topic: 'old-personal' }), ['old-personal']);
  assert.deepEqual(ntfyTopics({ topic: 'old-personal', topics: [] }), []);
  assert.deepEqual(ntfyTopics({ topics: ['team', 'team', ' personal ', 'bad topic!'] }), ['team', 'personal']);
});

test('ntfy sends once per unique topic and a failed topic does not block the others', async () => {
  const original = global.fetch;
  const calls = [], logs = [];
  global.fetch = async (_url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push(body);
    return body.topic === 'team' ? { ok: false, status: 403, text: async () => 'Forbidden' }
      : { ok: true, text: async () => '{}' };
  };
  try {
    const cfg = { ntfy: { enabled: true, topics: ['team', 'personal', 'personal'] },
      telegram: { enabled: false }, whapi: { enabled: false }, events: { queueDone: true } };
    const n = new Notifier({ getSettings: () => ({ notify: cfg }), getSecret: () => '', pc: 'PC3', log: (_l, msg) => logs.push(msg) });
    assert.equal(await n.notify('queueDone', 'Queue finished\n3 jobs done'), 1);
    assert.deepEqual(calls.map(c => c.topic), ['team', 'personal']);
    assert.equal(calls[1].title, 'Queue finished');
    assert.match(calls[1].message, /3 jobs done\n— PC3/);
    assert.match(logs[0], /ntfy message to team failed/);
    assert.equal(await n.notify('renderDone', 'Disabled event'), 0);
    cfg.ntfy.enabled = false;
    assert.equal((await n.sendReport('Test', 'ntfy')).attempted, 0);
  } finally { global.fetch = original; }
});
