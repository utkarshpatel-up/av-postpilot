const fs = require('fs');
const path = require('path');
const os = require('os');
const { DEFAULTS, LibraryBackup } = require('./library-backup');
const { Notifier, setHttpFetch } = require('./notify');
const { checkOverdue } = require('./library-overdue');

module.exports = async function runHeadless({ app, safeStorage, net }) {
  await app.whenReady();
  setHttpFetch((...args) => net.fetch(...args));
  const data = app.getPath('userData');
  const read = file => JSON.parse(fs.readFileSync(path.join(data, file), 'utf8').replace(/^\uFEFF/, ''));
  try {
    const settings = read('settings.json');
    const secrets = fs.existsSync(path.join(data, 'secrets.json')) ? read('secrets.json') : {};
    const getSecret = key => secrets[key] ? safeStorage.decryptString(Buffer.from(secrets[key], 'base64')) : '';
    settings.notify = { ...settings.notify, telegram: settings.notify?.telegram || { enabled: false }, whapi: settings.notify?.whapi || { enabled: false }, events: settings.notify?.events || {} };
    const notifier = new Notifier({ getSettings: () => settings, getSecret, log: () => {}, pc: os.hostname() });
    if (process.argv.includes('--library-backup-check')) {
      await checkOverdue({ settings, stateFile: path.join(data, 'library-overdue.json'), notify: (...args) => notifier.notify(...args) });
      app.exit(0); return;
    }
    const engine = new LibraryBackup({ getSettings: () => ({ ...DEFAULTS, ...settings.libraryBackup }), getPassword: () => getSecret('postgres'), notify: (...args) => notifier.notify(...args) });
    const result = await engine.run();
    app.exit(result.ok ? 0 : 1);
  } catch (err) {
    // No database passwords or command-line environment in this diagnostic.
    try { fs.appendFileSync(path.join(data, 'library-backup-task.log'), `${new Date().toISOString()} ${err.message}\n`); }
    finally { app.exit(1); }
  }
};
