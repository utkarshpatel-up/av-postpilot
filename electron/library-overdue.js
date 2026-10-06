const fs = require('fs');
const path = require('path');
const { monitor } = require('./library-backup');

// Shared by the open app and the independent hourly scheduled health task.
async function checkOverdue({ settings, stateFile, notify, now = Date.now() }) {
  const s = settings.libraryBackup;
  if (!settings.notify?.events?.libraryBackupOverdue || s?.mode !== 'server' || !s.root) return { checked: false };
  const lock = `${stateFile}.lock`;
  if (fs.existsSync(lock) && now - fs.statSync(lock).mtimeMs > 600000) fs.unlinkSync(lock);
  let fd;
  try { fd = fs.openSync(lock, 'wx'); } catch (err) { if (err.code === 'EEXIST') return { checked: false }; throw err; }
  try {
    let state;
    try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { state = {}; }
    if (state.root !== s.root) state = { root: s.root, started: now, known: [], alerted: [] };
    let health;
    try { health = monitor(s); } catch (err) { health = { ok: false, error: err.message }; }
    if (health.ok) {
      state.known = health.libraries.map(l => ({ name: l.name, time: l.time }));
      for (const l of health.state?.libraries || []) if (!state.known.some(k => k.name === l.name)) state.known.push({ name: l.name, time: l.lastSuccess || state.started });
    }
    const limit = (Number(s.staleHours) || 24) * 3600000;
    const items = state.known.length ? state.known : [{ name: 'No completed library backups', time: state.started, never: true }];
    const overdue = items.filter(l => now - l.time > limit);
    const pending = overdue.filter(l => !state.alerted.includes(l.name));
    state.alerted = state.alerted.filter(name => overdue.some(l => l.name === name));
    let sent = 0;
    if (pending.length) {
      const text = `⚠️ Library backup overdue\n${pending.map(l => `${l.name}\n${l.never ? 'No completed dump found since monitoring started.' : `Last dump: ${new Date(l.time).toLocaleString()} (${Math.floor((now - l.time) / 3600000)} hours ago)`}`).join('\n\n')}\nWarning limit: ${s.staleHours || 24} hours\n${health.ok ? '' : `Backup folder unavailable: ${s.root}\n`}Check the server's backup schedule and Library Backup log.`;
      sent = await notify('libraryBackupOverdue', text);
      if (sent > 0) state.alerted.push(...pending.map(l => l.name));
    }
    const tmp = `${stateFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state)); fs.renameSync(tmp, stateFile);
    return { checked: true, overdue: overdue.length, sent };
  } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}
module.exports = { checkOverdue };
