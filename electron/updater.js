// Automatic updates (Windows installer builds only), on electron-updater 6 (GitHub releases feed).
// This class owns the state and the rules; main.js hands it the real autoUpdater and the busy check.
// Nothing ever quits or installs by itself: the user presses "Restart to install" and install()
// refuses while any job is running.
const fs = require('fs');
const path = require('path');

const FIRST_CHECK_MS = 30 * 1000;
const EVERY_MS = 4 * 60 * 60 * 1000;

// Why this copy cannot update itself ('' = it can).
function unsupportedReason({ platform = process.platform, isPackaged, execPath = process.execPath, resourcesPath = process.resourcesPath, env = process.env, exists = fs.existsSync } = {}) {
  if (!isPackaged) return 'Automatic updates are off while running from source (development build).';
  if (platform === 'darwin') return 'Automatic updates are not available on macOS yet (the app is not signed with an Apple Developer ID). Download the new DMG from the releases page.';
  if (platform !== 'win32') return 'Automatic updates are only available in the Windows installer.';
  if (env.PORTABLE_EXECUTABLE_FILE || !exists(path.join(path.dirname(execPath), `Uninstall ${path.basename(execPath, '.exe')}.exe`)) || !exists(path.join(resourcesPath || '', 'app-update.yml'))) {
    return 'This is the portable (ZIP) copy, which cannot update itself. Download the Windows Setup installer once to get automatic updates.';
  }
  return '';
}

class Updater {
  // deps: updater (electron-updater's autoUpdater), version, reason ('' = supported), busy() -> '' or why not now,
  //       onChange(summary), log(level, msg), timers { setTimeout, setInterval }
  constructor({ updater, version, reason = '', busy = () => '', onChange = () => {}, quit = () => {}, log = () => {}, timers = { setTimeout, setInterval } }) {
    Object.assign(this, { updater, version, reason, busy, onChange, quit, log, timers });
    this.state = reason ? 'disabled' : 'idle';   // disabled | idle | checking | downloading | ready | error
    this.available = ''; this.percent = 0; this.error = ''; this.checkedAt = null; this.installing = false;
    if (reason) return;
    Object.assign(updater, { autoDownload: false, autoInstallOnAppQuit: false, allowPrerelease: false, allowDowngrade: false });
    updater.on('update-available', (info) => { this.available = info?.version || ''; this.set('downloading', { percent: 0 }); this.download(); });
    updater.on('update-not-available', () => this.set('idle', { checkedAt: Date.now(), available: '' }));
    updater.on('download-progress', (p) => this.set('downloading', { percent: Math.round(p?.percent || 0) }));
    updater.on('update-downloaded', (info) => { this.available = info?.version || this.available; this.set('ready', { percent: 100 }); this.log('info', `Update ${this.available} downloaded; restart to install`); });
    updater.on('error', (err) => this.fail(err));
  }

  summary() {
    const { state, version, available, percent, error, checkedAt, reason, installing, quitBlocked } = this;
    return { state, version, available, percent, error, checkedAt, reason, installing, quitBlocked: Boolean(quitBlocked), enabled: !this.reason };
  }
  set(state, extra = {}) { Object.assign(this, { state, error: '' }, extra); this.onChange(this.summary()); }
  fail(err) {
    const msg = err?.message ? String(err.message).split('\n')[0] : String(err);
    // The installer could not start (electron-updater emits this instead of throwing): jobs may run again,
    // and its own "already called" latch must be cleared or every later install would be ignored.
    const wasInstalling = this.installing;
    if (this.installing) { this.installing = false; this.quitBlocked = false; if (this.updater) this.updater.quitAndInstallCalled = false; }
    if (!wasInstalling && this.state === 'error' && this.error === msg) return;
    this.log('warn', `Update: ${msg}`);
    Object.assign(this, { state: 'error', error: msg, checkedAt: Date.now() });
    this.onChange(this.summary());
  }

  // Start the periodic checks (first one shortly after launch, so startup stays quiet).
  start() {
    if (this.reason || this.started) return;
    this.started = true;
    this.timers.setTimeout(() => this.check(), FIRST_CHECK_MS)?.unref?.();
    this.timers.setInterval(() => this.check(), EVERY_MS)?.unref?.();
  }

  // Check, and download what is found. Never overlaps with a running check/download or a ready update.
  async check() {
    if (this.reason) return { ok: false, error: this.reason };
    if (this.state === 'checking' || this.state === 'downloading' || this.state === 'ready') return { ok: true, ...this.summary() };
    this.set('checking');
    try { await this.updater.checkForUpdates(); } catch (err) { this.fail(err); }
    // checkForUpdates resolved with no event at all (e.g. a feed that is not published yet)
    if (this.state === 'checking') this.set('idle', { checkedAt: Date.now() });
    return { ok: this.state !== 'error', ...this.summary() };
  }

  async download() {
    try { await this.updater.downloadUpdate(); } catch (err) { this.fail(err); }
  }

  // The quit was stopped by a before-quit guard. electron-updater already started the installer, so
  // do NOT reset its latch or allow jobs: stay pending (no second installer) until the app really quits.
  installAborted() {
    if (!this.installing) return;
    this.quitBlocked = true;
    this.onChange(this.summary());
  }

  // Restart into the new version, only when nothing is running and nothing is unsaved.
  install() {
    if (this.reason) return { ok: false, error: this.reason };
    if (this.state !== 'ready') return { ok: false, error: 'No update is ready to install' };
    const why = this.busy();
    // The installer is already running and waits for this app to quit: only quit again, never install twice.
    if (this.installing) return why ? { ok: false, error: `The update installer is waiting. ${why}` } : (this.quit(), { ok: true });
    if (why) return { ok: false, error: why };
    this.installing = true;
    this.onChange(this.summary());
    try { this.updater.quitAndInstall(false, true); } catch (err) { this.fail(err); }
    // an error emitted synchronously by electron-updater has already reset the flag
    return this.installing ? { ok: true } : { ok: false, error: this.error };
  }
}

// While an install is under way no new job may start (the app quits within seconds).
// Read-only and stopping actions stay allowed; everything else on these channels is refused.
const GATED = new Set(['library-backup', 'stabilize', 'premiere', 'save-now', 'create-project', 'scene-add', 'scene-start', 'shutdown-now', 'create-series', 'rename-series', 'launch-resolve', 'night', 'encoder', 'handbrake', 'quietlift', 'feedback', 'enc-preview']);
const SAFE = /^(summary|status|stop|cancel|restart|runs|preview|url|reveal|unsaved|confirm-discard|engine-outdated|list)$/;
function installGate(channel, args) {
  if (!GATED.has(channel)) return null;
  const action = typeof args[0] === 'string' ? args[0] : args[0]?.action;
  if (SAFE.test(action || '')) return null;
  return { ok: false, error: 'AV PostPilot is restarting to install an update. Wait a moment, then try again.' };
}

module.exports = { installGate, Updater, unsupportedReason, FIRST_CHECK_MS, EVERY_MS };
