// Event messages to phone push, email and legacy chat integrations.
// Tokens are passed in by main.js (stored encrypted there), never kept here.
const { sendEmail, recipients } = require('./email');

async function post(url, body, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  if (!res.ok || (json && json.ok === false)) {
    const why = (json && (json.description || json.error?.message || json.message)) || text.slice(0, 200) || res.statusText;
    throw new Error(`${res.status} ${why}`);
  }
  return json;
}

async function get(url, headers = {}) {
  const res = await fetch(url, { headers: { accept: 'application/json', ...headers }, signal: AbortSignal.timeout(20000) });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json || json.ok === false) {
    throw new Error(`${res.status} ${(json && (json.description || json.error?.message || json.message)) || res.statusText}`);
  }
  return json;
}

const telegram = {
  send: (token, chatId, text) => post(`https://api.telegram.org/bot${token}/sendMessage`, { chat_id: chatId, text }),
  // Chats that recently messaged the bot or added it to a group.
  async findChats(token) {
    const json = await get(`https://api.telegram.org/bot${token}/getUpdates`);
    const chats = new Map();
    for (const u of json.result || []) {
      const c = (u.message || u.channel_post || u.my_chat_member || u.edited_message || {}).chat;
      if (c) chats.set(String(c.id), { id: String(c.id), name: c.title || [c.first_name, c.last_name].filter(Boolean).join(' ') || c.username || String(c.id), type: c.type });
    }
    return [...chats.values()];
  },
};

const whapi = {
  send: (token, to, text) => post('https://gate.whapi.cloud/messages/text', { to, body: text }, { authorization: `Bearer ${token}` }),
  async findGroups(token) {
    const json = await get('https://gate.whapi.cloud/groups?count=100', { authorization: `Bearer ${token}` });
    return (json.groups || []).map((g) => ({ id: g.id, name: g.name || g.id, type: 'group' }));
  },
};

// ntfy: push notifications to the ntfy phone app (free, no account). Everyone
// subscribed to the topic gets the alert. JSON publishing keeps emoji and any
// language safe (HTTP headers can't carry them).
const ntfy = {
  send(server, topic, token, { title, message, tags, priority }) {
    const base = String(server || 'https://ntfy.sh').replace(/\/+$/, '');
    const headers = token ? { authorization: `Bearer ${token}` } : {};
    return post(`${base}/`, { topic, title, message, tags, priority }, headers);
  },
};

// Topic names: letters, digits, _ and - only, up to 64 characters.
const validTopic = (t) => /^[-_A-Za-z0-9]{1,64}$/.test(String(t || ''));
function ntfyTopics(config = {}) {
  const list = Array.isArray(config.topics) ? config.topics : [config.topic];
  return [...new Set(list.map((t) => String(t || '').trim()).filter(validTopic))];
}

// Phone numbers: keep digits only (country code included, no "+").
function normaliseWhapiTarget(to) {
  const t = String(to).trim();
  return /@/.test(t) ? t : t.replace(/\D/g, '');
}

class Notifier {
  constructor({ getSettings, getSecret, log, pc, emailSend = sendEmail }) {
    Object.assign(this, { getSettings, getSecret, log, pc, emailSend });
  }

  // event: key from settings.notify.events; returns number of messages sent
  async notify(event, text) {
    const n = this.getSettings().notify;
    if (event && !n.events[event]) return 0;
    return this.sendAll(`${text}\n— ${this.pc}`);
  }

  async sendAll(text) {
    return (await this.sendReport(text)).sent;
  }

  async sendReport(text, only = null) {
    const n = this.getSettings().notify;
    const jobs = [];
    const include = (kind) => !only || only === kind;
    const tg = this.getSecret('telegram');
    if (include('telegram') && n.telegram.enabled && tg) {
      for (const c of n.telegram.chats) jobs.push(['Telegram', c.name || c.id, () => telegram.send(tg, c.id, text)]);
    }
    const wa = this.getSecret('whapi');
    if (include('whapi') && n.whapi.enabled && wa) {
      for (const c of n.whapi.chats) jobs.push(['WhatsApp', c.name || c.id, () => whapi.send(wa, normaliseWhapiTarget(c.id), text)]);
    }
    if (include('ntfy') && n.ntfy?.enabled) {
      const lines = text.split('\n');
      for (const topic of ntfyTopics(n.ntfy)) jobs.push(['ntfy', topic, () => ntfy.send(n.ntfy.server, topic, this.getSecret('ntfy'), {
        title: lines[0].slice(0, 120),            // first line = notification title
        message: lines.slice(1).join('\n') || lines[0],
        priority: /⚠️|failed|shuts down|⏻/i.test(text) ? 4 : 3,
      })]);
    }
    if (include('email') && n.email?.enabled) {
      try {
        for (const to of recipients(n.email.recipients)) {
          jobs.push(['Email', to, () => this.emailSend(n.email, this.getSecret('email'), to, text)]);
        }
      } catch (err) { jobs.push(['Email', 'recipients', () => Promise.reject(err)]); }
    }
    let sent = 0;
    const errors = [];
    await Promise.all(jobs.map(async ([svc, who, fn]) => {
      try { await fn(); sent++; } catch (err) {
        // Avoid exposing a credential if a service embeds it in its error.
        let detail = String(err.message || 'Delivery failed');
        for (const kind of ['telegram', 'whapi', 'ntfy', 'email']) {
          const secret = this.getSecret(kind);
          if (secret && secret.length >= 8) detail = detail.split(secret).join('[redacted]');
        }
        const message = `${svc} message to ${who} failed: ${detail}`;
        errors.push(message);
        this.log('warn', message);
      }
    }));
    return { sent, attempted: jobs.length, errors };
  }
}

module.exports = { Notifier, telegram, whapi, ntfy, validTopic, ntfyTopics, normaliseWhapiTarget };
