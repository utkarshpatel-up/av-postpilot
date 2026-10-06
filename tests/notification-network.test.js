const test = require('node:test');
const assert = require('node:assert/strict');
const { setHttpFetch, ntfy, telegram, deliveryError, Notifier } = require('../electron/notify');

test('notification requests use the supplied browser transport for publish and chat lookup', async () => {
  const calls = [];
  setHttpFetch(async (url, options) => {
    calls.push({ url, options });
    return { ok: true, text: async () => '{}', json: async () => ({ ok: true, result: [] }) };
  });
  try {
    await ntfy.send('https://ntfy.sh', 'personal', 'test-token', { title: 'Render done', message: '— PC3' });
    await telegram.findChats('test-token');
    assert.equal(calls[0].url, 'https://ntfy.sh/');
    assert.equal(calls[0].options.headers.authorization, 'Bearer test-token');
    assert.equal(JSON.parse(calls[0].options.body).message, '— PC3');
    assert.ok(calls[0].options.signal);
    assert.match(calls[1].url, /getUpdates$/);
  } finally { setHttpFetch((...args) => fetch(...args)); }
});

test('network failure includes underlying cause and redacts credentials', async () => {
  const cause = new Error('Certificate validation failed test-secret');
  cause.code = 'CERT_HAS_EXPIRED';
  const error = new TypeError('fetch failed', { cause });
  assert.match(deliveryError(error), /CERT_HAS_EXPIRED/);
  setHttpFetch(async () => { throw error; });
  try {
    const n = new Notifier({ pc: 'PC3', log: () => {}, getSecret: () => 'test-secret', getSettings: () => ({ notify: {
      telegram: { enabled: false }, whapi: { enabled: false }, ntfy: { enabled: true, topics: ['personal'] },
    } }) });
    const result = await n.sendReport('Test', 'ntfy');
    assert.equal(result.sent, 0);
    assert.match(result.errors[0], /fetch failed.*Certificate validation failed.*CERT_HAS_EXPIRED/);
    assert.ok(!result.errors[0].includes('test-secret'));
  } finally { setHttpFetch((...args) => fetch(...args)); }
});
