const { app, BrowserWindow, Tray, Menu, ipcMain, dialog, shell, nativeImage, safeStorage, Notification, net, screen, globalShortcut } = require('electron');
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const url = require('url');
const { ResolveBridge } = require('./resolve-bridge');
const { AutoSaver } = require('./autosave');
const ps = require('./project-setup');
const ep = require('./episodes');
const { Notifier, telegram, whapi, ntfyTopics, setHttpFetch } = require('./notify');
setHttpFetch((url, options) => net.fetch(url, options));
const { RenderWatcher, copyVerified } = require('./renders');
const { collectHdFiles } = require('./hdreview');
const { SceneQueue } = require('./scenequeue');
const { NightQueue } = require('./nightqueue');
const { Encoder } = require('./encoder');
const { HandBrake, DEFAULTS: HANDBRAKE_DEFAULTS, presetName: handbrakePreset, findCli: findHandbrakeCli, bundledCli } = require('./handbrake');
const { MediaPreview } = require('./media-preview');
const HANDBRAKE_VERSION = require('../package.json').handbrakeCli.version;
const { QuietLift, DEFAULTS: QUIET_LIFT_DEFAULTS, installScripts: installQuietLift } = require('./quietlift');
const feedbackCutter = require('./feedbackcutter');
const { Stabilization } = require('./stabilization');
const { createFrameGrabber } = require('./stabilization-frames');
const { PremiereImport } = require('./premiere-import');
const { PremiereLink } = require('./premiere-link');
const seriesList = require('./series-list');
const libraryBackup = require('./library-backup');
const { checkOverdue } = require('./library-overdue');

// Developer checks can run beside a normal copy with their own settings folder.
if (process.env.AVPP_USERDATA) app.setPath('userData', process.env.AVPP_USERDATA);
if (process.argv.includes('--library-backup-run') || process.argv.includes('--library-backup-check')) {
  const dataArg = process.argv.find(a => a.startsWith('--backup-user-data='));
  if (dataArg) app.setPath('userData', dataArg.slice('--backup-user-data='.length));
  require('./library-backup-headless')({ app, safeStorage, net });
  return; // Scheduled backups run separately without opening Resolve or the UI.
}
if (!app.requestSingleInstanceLock()) { app.quit(); return; }

const DATA = app.getPath('userData');
const SETTINGS_FILE = path.join(DATA, 'settings.json');
const STATE_FILE = path.join(DATA, 'state.json');
const LOG_FILE = path.join(DATA, 'postpilot.log');
const RESOLVE_PREFS = process.platform === 'darwin'
  ? path.join(os.homedir(), 'Library', 'Preferences', 'Blackmagic Design', 'DaVinci Resolve', 'config.dat')
  : path.join(process.env.APPDATA || '', 'Blackmagic Design', 'DaVinci Resolve', 'Preferences', 'config.dat');

const DEFAULTS = {
  resolvePath: process.platform === 'darwin' ? '/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/MacOS/Resolve' : 'C:\\Program Files\\Blackmagic Design\\DaVinci Resolve\\Resolve.exe',
  launchResolve: process.platform !== 'darwin',
  startHidden: false,
  clipInfo: false,
  clipInfoKey: 'Control+Alt+I',
  autosave: {
    enabled: true,
    intervalMin: 15,
    keepDays: 30,
    keepMin: 20,
    skipUntitled: true,
    destinations: [],
  },
  project: { location: '', footage: 'move', folders: ['Audio', 'Resolve Export', 'Satsang Files', 'Scratch Disk'] },
  series: { title: '', subtitle: '', font: 'Calibri', style: 'Bold', size: 0.11, background: 'plain', barsImage: '', names: null },   // names: null = built-in list
  renders: {
    copyEnabled: false, copyDest: '', afterQueue: 'nothing', shutdownSeconds: 60,
    hd: { enabled: false, preset: '', dir: '', suffix: '', onlyUhd: true, copyEnabled: false, copyDest: '' },
  },
  scene: { afterQueue: 'nothing', shutdownSeconds: 60 },
  manual: { shutdownSeconds: 60 },
  encoder: { afterQueue: 'nothing', shutdownSeconds: 60 },
  stab: { afterQueue: 'nothing', shutdownSeconds: 60, removeMarkers: false },
  night: { afterQueue: 'nothing', shutdownSeconds: 60 },
  handbrake: HANDBRAKE_DEFAULTS,
  quietLift: QUIET_LIFT_DEFAULTS,
  feedbackCutter: feedbackCutter.DEFAULTS,
  libraryBackup: libraryBackup.DEFAULTS,
  notify: {
    telegram: { enabled: false, chats: [] },
    whapi: { enabled: false, chats: [] },
    ntfy: { enabled: false, server: 'https://ntfy.sh', topics: [] },
    email: { enabled: false, user: '', recipients: [] },
    events: {
      renderDone: true, renderFailed: true, renderCopied: false, queueDone: true,
      sceneDone: true, sceneQueueDone: true, encoderGroupDone: true, encoderQueueDone: true, stabQueueDone: true, nightQueueDone: true, handbrakeDone: true, shutdown: true, autosaveFailed: true, projectCreated: false,
      libraryBackupDone: false, libraryBackupFailed: true, libraryAlert: true, libraryBackupOverdue: true,
    },
  },
};

// ------------------------------------------------------------------ storage
function readJson(file, fallback) {
  // Strip a byte-order mark: Notepad/PowerShell add one when a file is edited by hand.
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch { return fallback; }
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', JSON.stringify(data, null, 2));
  fs.renameSync(file + '.tmp', file);
}

let settings = mergeSettings(readJson(SETTINGS_FILE, {}));
const state = readJson(STATE_FILE, { fp: {} });
state.fp = state.fp || {};

function mergeSettings(s) {
  return {
    ...DEFAULTS, ...s,
    autosave: { ...DEFAULTS.autosave, ...(s.autosave || {}) },
    // older versions stored move: true/false
    project: { ...DEFAULTS.project, ...(s.project?.move === false ? { footage: 'copy' } : {}), ...(s.project || {}) },
    series: { ...DEFAULTS.series, ...(s.series || {}) },
    encoder: { ...DEFAULTS.encoder, ...(s.encoder || {}) },
    stab: { ...DEFAULTS.stab, ...(s.stab || {}) },
    night: { ...DEFAULTS.night, ...(s.night || {}) },
    handbrake: { ...DEFAULTS.handbrake, ...(s.handbrake || {}) },
    quietLift: { ...DEFAULTS.quietLift, ...(s.quietLift || {}) },
    feedbackCutter: { ...DEFAULTS.feedbackCutter, ...(s.feedbackCutter || {}) },
    libraryBackup: { ...DEFAULTS.libraryBackup, ...(s.libraryBackup || {}) },
    manual: { ...DEFAULTS.manual, ...(s.shutdownSeconds ? { shutdownSeconds: s.shutdownSeconds } : {}), ...(s.manual || {}) },
    renders: { ...DEFAULTS.renders, ...(s.shutdownSeconds ? { shutdownSeconds: s.shutdownSeconds } : {}), ...(s.renders || {}), hd: { ...DEFAULTS.renders.hd, ...(s.renders?.hd || {}) } },
    // older versions had one shared countdown
    scene: { ...DEFAULTS.scene, ...(s.shutdownSeconds ? { shutdownSeconds: s.shutdownSeconds } : {}), ...(s.scene || {}) },
    notify: {
      telegram: { ...DEFAULTS.notify.telegram, ...(s.notify?.telegram || {}) },
      whapi: { ...DEFAULTS.notify.whapi, ...(s.notify?.whapi || {}) },
      ntfy: { ...DEFAULTS.notify.ntfy, ...(s.notify?.ntfy || {}), topics: ntfyTopics(s.notify?.ntfy || {}) },
      email: { ...DEFAULTS.notify.email, ...(s.notify?.email || {}) },
      events: { ...DEFAULTS.notify.events, ...(s.notify?.events || {}) },
    },
  };
}

// ------------------------------------------------------------------ log
const logLines = [];
function log(level, msg) {
  const entry = { time: Date.now(), level, msg };
  logLines.push(entry);
  if (logLines.length > 500) logLines.shift();
  try {
    fs.mkdirSync(DATA, { recursive: true });
    fs.appendFileSync(LOG_FILE, `${new Date(entry.time).toISOString()} ${level.toUpperCase()} ${msg}\n`);
    if (fs.statSync(LOG_FILE).size > 2 * 1024 * 1024) {
      fs.renameSync(LOG_FILE, LOG_FILE + '.old');
    }
  } catch { /* logging must never crash the app */ }
  send('log', entry);
}

// ------------------------------------------------------------------ Resolve
const bridgeLua = path.join(DATA, 'bridge.lua');
fs.mkdirSync(DATA, { recursive: true });
fs.writeFileSync(bridgeLua, fs.readFileSync(path.join(__dirname, 'bridge.lua')));
fs.writeFileSync(path.join(DATA, 'stabilization.lua'), fs.readFileSync(path.join(__dirname, 'stabilization.lua')));
fs.writeFileSync(path.join(DATA, 'premiere.lua'), fs.readFileSync(path.join(__dirname, 'premiere.lua')));

const bridge = new ResolveBridge({
  getFuscriptPath: () => process.platform === 'darwin' ? '/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Libraries/Fusion/fuscript' : path.join(path.dirname(settings.resolvePath), 'fuscript.exe'),
  luaFile: bridgeLua,
  log,
});

const status = { resolveRunning: false, connected: false, scriptingOff: false, product: null, version: null, project: null, rendering: false, jobs: [] };

function isResolveRunning() {
  return new Promise((resolve) => {
    execFile('tasklist', ['/FI', 'IMAGENAME eq Resolve.exe', '/NH', '/FO', 'CSV'], { windowsHide: true },
      (err, out) => resolve(!err && /"Resolve\.exe"/i.test(out)));
  });
}

// Resolve stores "External scripting using" as System.Scripting.Mode (0 = None).
function scriptingDisabled() {
  try {
    const m = fs.readFileSync(RESOLVE_PREFS, 'utf8').match(/System\.Scripting\.Mode\s*=\s*(\d+)/);
    return m ? m[1] === '0' : false;
  } catch { return false; }
}

async function launchResolve() {
  if (await isResolveRunning()) return;
  if (!fs.existsSync(settings.resolvePath)) {
    log('error', `Resolve not found at ${settings.resolvePath}. Set the path on the Settings page.`);
    return;
  }
  log('info', 'Opening DaVinci Resolve…');
  spawn(settings.resolvePath, [], { detached: true, stdio: 'ignore', cwd: path.dirname(settings.resolvePath) }).unref();
}

let lastConnected = null;
let polling = false;
async function poll() {
  if (polling) return;
  polling = true;
  try { await pollOnce(); } finally { polling = false; }
}

async function pollOnce() {
  status.resolveRunning = await isResolveRunning();
  if (!status.resolveRunning) {
    Object.assign(status, { connected: false, project: null, rendering: false, jobs: [], scriptingOff: false });
    if (bridge.proc && !bridge.busy) bridge.stop();
  } else if (!bridge.busy) {
    try {
      const st = await bridge.status();
      // Resolve doesn't report the library while it renders: keep the last known one.
      if (st.project && !st.project.dbName && status.project?.name === st.project.name) {
        st.project.dbName = status.project.dbName;
        st.project.dbType = status.project.dbType;
      }
      Object.assign(status, {
        connected: Boolean(st.connected), product: st.product || null, version: st.version || null,
        project: st.project || null, rendering: Boolean(st.rendering), jobs: st.jobs || [],
      });
    } catch {
      status.connected = false;
    }
    status.scriptingOff = !status.connected && scriptingDisabled();
  }
  if (lastConnected !== status.connected) {
    if (status.connected) log('info', `Connected to ${status.product || 'Resolve'} ${status.version || ''}`.trim());
    else if (lastConnected) log('warn', 'Lost connection to Resolve');
    lastConnected = status.connected;
  }
  send('status', status);
  if (!encoder.running) renders.update(status);
  updateTray();
}

// Network location = UNC path (\\server\share) or a mapped network drive letter.
const driveTypeCache = new Map();
function isNetworkPath(p) {
  if (!p) return Promise.resolve(false);
  if (/^[\\/]{2}/.test(p)) return Promise.resolve(true);
  const m = /^([a-zA-Z]):/.exec(p);
  if (!m) return Promise.resolve(false);
  const drive = `${m[1].toUpperCase()}:`;
  if (driveTypeCache.has(drive)) return Promise.resolve(driveTypeCache.get(drive));
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `(Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='${drive}'").DriveType`],
    { windowsHide: true, timeout: 15000 }, (err, out) => {
      const net = !err && String(out).trim() === '4';   // 4 = network drive
      if (!err) driveTypeCache.set(drive, net);
      resolve(net);
    });
  });
}

// ------------------------------------------------------------------ auto-save
const autosaver = new AutoSaver({
  isNetworkPath,
  bridge,
  getSettings: () => settings,
  state,
  saveState: () => writeJson(STATE_FILE, state),
  log,
  onChange: () => { send('autosave', autosaver.summary()); updateTray(); },
  tmpDir: path.join(os.tmpdir(), 'av-postpilot'),
});

// ------------------------------------------------------------------ secrets (bot tokens)
// Encrypted with Windows' user-account protection (DPAPI via safeStorage).
const SECRETS_FILE = path.join(DATA, 'secrets.json');
function readSecrets() { return readJson(SECRETS_FILE, {}); }
function getSecret(kind) {
  const enc = readSecrets()[kind];
  if (!enc) return '';
  try { return safeStorage.decryptString(Buffer.from(enc, 'base64')); } catch { return ''; }
}
function setSecret(kind, value) {
  const all = readSecrets();
  if (value) all[kind] = safeStorage.encryptString(value).toString('base64');
  else delete all[kind];
  writeJson(SECRETS_FILE, all);
}

// ------------------------------------------------------------------ notifications, renders, scene cuts
const notifier = new Notifier({ getSettings: () => settings, getSecret, log, pc: os.hostname() });
// Per-module "Do nothing" (Scene Cuts, Renders, Encoder, Stabilization): that module's
// messages are not sent at all. Failures (renderFailed) and shutdown warnings still are.
const MODULE_EVENTS = { scene: ['sceneDone', 'sceneQueueDone'], renders: ['renderDone', 'queueDone', 'renderCopied'], encoder: ['encoderGroupDone', 'encoderQueueDone'], stab: ['stabQueueDone'], night: ['nightQueueDone'], handbrake: ['handbrakeDone'] };
const sendNotice = notifier.notify.bind(notifier);
notifier.notify = (event, ...rest) => {
  for (const [group, events] of Object.entries(MODULE_EVENTS)) if (events.includes(event) && settings[group]?.afterQueue === 'silent') return 0;
  return sendNotice(event, ...rest);
};

// Shut down with a countdown the user can cancel from the app or the tray.
let shutdownAt = null;
let shutdownReason = '';
let shutdownTimer = null;
const countdown = (v) => Math.min(24 * 3600, Math.max(10, Number(v) || 60));
const mmss = (s) => (s >= 60 ? `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ''}` : `${s} s`);
function scheduleShutdown(reason, seconds = countdown(settings.renders.shutdownSeconds)) {
  if (process.platform !== 'win32') { log('warn', 'Automatic shutdown is currently supported on Windows only'); return; }
  if (shutdownAt) return;
  shutdownAt = Date.now() + seconds * 1000;
  shutdownReason = reason;
  log('warn', `Shutting down in ${mmss(seconds)} (${reason}). Cancel in AV PostPilot.`);
  notifier.notify('shutdown', `⏻ ${os.hostname()} shuts down in ${mmss(seconds)} (${reason}).`);
  try { new Notification({ title: 'AV PostPilot', body: `Shutting down in ${mmss(seconds)} (${reason}). Open PostPilot to cancel.` }).show(); } catch { /* ignore */ }
  showWindow();
  sendShutdown();
  shutdownTimer = setTimeout(async () => {
    await bridge.save().catch(() => {});                  // save the Resolve project first
    log('warn', 'Shutting down now');
    execFile('shutdown', ['/s', '/t', '5', '/c', 'AV PostPilot: work finished'], { windowsHide: true });
  }, seconds * 1000);
  updateTray();
}
function cancelShutdown() {
  if (!shutdownAt) return;
  clearTimeout(shutdownTimer);
  shutdownAt = null;
  execFile('shutdown', ['/a'], { windowsHide: true }, () => {});
  log('info', 'Shutdown cancelled');
  notifier.notify('shutdown', `Shutdown of ${os.hostname()} was cancelled.`);
  sendShutdown();
  updateTray();
}
function sendShutdown() { send('shutdown', { at: shutdownAt, reason: shutdownReason }); }
function afterQueue(action, what) {
  if (action !== 'shutdown') return;
  // While the night queue runs, only its own choice counts (at its end).
  if (night?.running && what !== 'night queue') return;
  const group = { 'scene cut queue': 'scene', 'encoder queue': 'encoder', 'stabilization queue': 'stab', 'night queue': 'night', 'HandBrake conversion': 'handbrake' }[what] || 'renders';
  const secs = countdown(settings[group].shutdownSeconds);
  scheduleShutdown(`${what} finished`, secs);
}

const renders = new RenderWatcher({
  getSettings: () => settings, notifier, log,
  ignore: (id) => encoder.ids.has(id),
  startHd: async (jobs) => {
    const hd = settings.renders.hd;
    if (!hd.preset) return { ok: false, error: 'no HD preset chosen on the Renders page' };
    if (!hd.dir || !fs.existsSync(hd.dir)) return { ok: false, error: `HD render folder not reachable: ${hd.dir || '(not set)'}` };
    const usable = jobs.filter((j) => j.dir && j.file && fs.existsSync(path.join(j.dir, j.file)));
    if (!usable.length) return { ok: false, error: 'the finished render files could not be found' };
    const bases = usable.map((j) => path.parse(j.file).name);
    const d = new Date();
    const p2 = (n) => String(n).padStart(2, '0');
    // Temporary bin + timeline, removed again by finishHd.
    const folder = `PostPilot HD temp ${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
    const batch = { folder, dir: hd.dir, bases, suffix: hd.suffix || '', since: Date.now() };
    const r = await bridge.startHdBatch({
      preset: hd.preset, dir: hd.dir, folder,
      files: usable.map((j) => path.join(j.dir, j.file)),
      names: bases.map((b) => `${b}${hd.suffix || ''}`),
    });
    if (!r.ok) await bridge.hdCleanup({ folder }).catch(() => {});
    return { ...r, batch };
  },
  finishHd: async (batch) => {
    const { files, problems } = collectHdFiles(batch);
    const hd = settings.renders.hd;
    if (hd.copyEnabled && hd.copyDest) {
      if (!fs.existsSync(hd.copyDest)) {
        problems.push(`HD copy folder not reachable: ${hd.copyDest}`);
      } else {
        for (const f of files) {
          try {
            const target = await copyVerified(f, hd.copyDest);
            log('info', `Copied HD ${path.basename(f)} → ${target}`);
          } catch (err) {
            problems.push(`copy of ${path.basename(f)} failed: ${err.message}`);
          }
        }
      }
    }
    const c = await bridge.hdCleanup({ folder: batch.folder }).catch((err) => ({ ok: false, error: err.message }));
    if (c.ok) log('info', `Removed temporary HD timeline and bin "${batch.folder}"`);
    else problems.push(`temporary bin "${batch.folder}" could not be removed${c.error ? `: ${c.error}` : ''}`);
    return { files, problems };
  },
  onChange: () => send('renders', renders.summary()),
  onQueueDone: afterQueue,
});

const encoder = new Encoder({
  confirmStart: async (project) => {
    if (!project || night?.running) return true;   // the night queue asked when it was started
    const untitled = /^Untitled Project/i.test(project.name || '');
    const result = untitled ? await dialog.showMessageBox(win, {
      type: 'warning', title: 'Encode in a temporary project?',
      message: `Close "${project.name}" to start encoding?`,
      detail: 'This project has never been saved. If it is empty, PostPilot leaves it unsaved and encodes in a separate temporary project. If it has anything in it, encoding will not start; save it with a name in Resolve first.',
      buttons: ['Start encoding', 'Cancel'], defaultId: 1, cancelId: 1,
    }) : await dialog.showMessageBox(win, {
      type: 'warning', title: 'Encode in a temporary project?',
      message: `Save and close "${project.name}" to start encoding?`,
      detail: 'PostPilot will automatically save and close your project, then encode in a separate empty temporary project. When the queue finishes or stops, it will delete the temporary project.',
      buttons: ['Save and start encoding', 'Cancel'], defaultId: 1, cancelId: 1,
    });
    return result.response === 0;
  },
  bridge, notifier, log, getSettings: () => settings,
  loadState: () => state.encoder,
  saveState: (e) => { state.encoder = e; writeJson(STATE_FILE, state); },
  onChange: () => { send('encoder', encoder.summary()); updateTray(); },
  onQueueDone: afterQueue,
});
// Every stabilization run is kept (one file each) so it can be reviewed again later.
const STAB_HISTORY = path.join(DATA, 'stabilization-history');
const stabHistory = {
  file: (id) => { if (!/^[\w-]+$/.test(id)) throw Error('Bad record name'); return path.join(STAB_HISTORY, `${id}.json`); },
  save(run) { writeJson(this.file(run.id), run); },
  load(id) { return readJson(this.file(id), null); },
  list() {
    let names = [];
    try { names = fs.readdirSync(STAB_HISTORY).filter((n) => n.endsWith('.json')).sort().reverse().slice(0, 100); } catch {}
    return names.map((n) => readJson(path.join(STAB_HISTORY, n), null)).filter(Boolean).map((r) => {
      const count = (f) => r.clips.filter(f).length;
      return { id: r.id, date: r.date, project: r.project, timelines: r.timelines, copies: r.copies, clips: count((c) => c.copyTimelineId),
        applied: count((c) => c.approved), passed: count((c) => c.status === 'Passed'), resolve: count((c) => c.method === 'resolve'), tracker: count((c) => c.alt) };
    });
  },
};
const stabilization = new Stabilization({ bridge, log, onChange: s => send('stabilize', s),
  grab:createFrameGrabber({bridge,nativeImage,directory:path.join(DATA,'stabilization-check')}),
  saveReport:report=>fs.writeFileSync(path.join(DATA,'stabilization-last-report.json'),JSON.stringify(report,null,2)),
  history: stabHistory, project: () => status.project?.name || '' });
autosaver.isPaused = () => encoder.running || stabilization.running;

// Installed font names, for the Premiere title check (Windows registry / Mac font folders).
let fontCache = null;
function installedFonts() {
  if (fontCache) return fontCache;
  try {
    if (process.platform === 'win32') {
      const { execFileSync } = require('child_process');
      fontCache = ['HKLM', 'HKCU'].flatMap(h => {
        try { return execFileSync('reg', ['query', h + '\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts'], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/).map(l => l.trim().split(/\s+REG_SZ\s+/)[0]).filter(Boolean); } catch { return []; }
      });
    } else {
      fontCache = ['/Library/Fonts', '/System/Library/Fonts', path.join(os.homedir(), 'Library/Fonts')].flatMap(d => { try { return fs.readdirSync(d).map(f => f.replace(/\.[^.]+$/, '')); } catch { return []; } });
    }
  } catch { fontCache = null; }
  return fontCache;
}
const premiereLink = new PremiereLink({ log });
const premiere = new PremiereImport({ bridge, link: premiereLink, log, dir: path.join(DATA, 'premiere-import'), fonts: installedFonts, onChange: s => send('premiere', s) });

const sceneQueue = new SceneQueue({
  bridge, notifier, log, getSettings: () => settings,
  onChange: () => { send('scene', sceneQueue.summary()); updateTray(); },
  onQueueDone: afterQueue,
});

// HandBrake Converter: runs HandBrakeCLI on its own, Resolve is not involved.
const handbrake = new HandBrake({
  getSettings: () => settings.handbrake, log, notifier,
  defaultReportDir: path.join(DATA, 'handbrake-reports'),
  onChange: (h) => { send('handbrake', h); updateTray(); },
  onQueueDone: afterQueue,
});

// Encoder range window: frame rate + preview copies, made with the built-in HandBrakeCLI.
const mediaPreview = new MediaPreview({ dir: path.join(DATA, 'previews'), findCli: () => findHandbrakeCli(settings.handbrake.cliPath) });

// Quiet Lift: its Python engine starts the first time the page uses it.
const quietLift = new QuietLift({
  script: installQuietLift(path.join(DATA, 'quietlift')),
  getPython: () => process.env.QUIET_LIFT_PYTHON || settings.quietLift.python,
  onLog: (msg) => { log('info', `Quiet Lift: ${msg}`); send('quietlift', { log: msg }); },
});

// Feedback Cutter: also Python, also started the first time its page is opened.
const FEEDBACK_WORK = path.join(DATA, 'feedbackcutter', 'work');
const feedback = feedbackCutter.createEngine({
  script: feedbackCutter.installScripts(path.join(DATA, 'feedbackcutter')),
  workDir: FEEDBACK_WORK,
  getPython: () => process.env.FEEDBACK_CUTTER_PYTHON || settings.feedbackCutter.python,
  onLog: (msg, { pct }) => send('feedback', { log: msg, pct }),
});

const night = new NightQueue({
  getStatus: () => status, sceneQueue, stabilization, encoder, renders, bridge, log, notifier,
  loadState: () => state.night,
  saveState: (n) => { state.night = n; writeJson(STATE_FILE, state); },
  onChange: (n) => { send('night', n); updateTray(); },
  onFinished: (stopped) => { if (!stopped) afterQueue(settings.night.afterQueue, 'night queue'); },
});

// Auto-save trouble (e.g. NAS offline): one message per problem, not every 15 minutes.
let lastAutosaveAlert = '';
autosaver.onResult = (r) => {
  if (r.failed) {
    if (lastAutosaveAlert !== r.message) {
      lastAutosaveAlert = r.message;
      notifier.notify('autosaveFailed', `💾 Auto-save problem: ${r.message}\nSee the Activity page on ${os.hostname()}.`);
    }
  } else if (r.saved || r.unchanged) {
    lastAutosaveAlert = '';
  }
};

// ------------------------------------------------------------------ window + tray
let win = null;
let tray = null;
let quitting = false;

function iconPath(name) { return path.join(__dirname, '..', 'renderer', 'assets', name); }

function createWindow(show = true) {
  win = new BrowserWindow({
    width: 1100, height: 740, minWidth: 900, minHeight: 600,
    show, backgroundColor: '#16181d', title: 'AV PostPilot',
    icon: iconPath('icon.png'),
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.on('close', (e) => {
    if (!quitting) { e.preventDefault(); win.hide(); }
  });
}

function showWindow() {
  if (!win) createWindow();
  win.show();
  win.focus();
}

// Small always-on-top window with details of the clip under Resolve's playhead.
let clipWin = null, clipTimer = null, clipBusy = false;
// System-wide shortcut, so it also works while Resolve has focus.
let clipKey = '';
function registerClipKey() {
  if (clipKey === settings.clipInfoKey) return;
  if (clipKey) globalShortcut.unregister(clipKey);
  clipKey = settings.clipInfoKey || '';
  if (!clipKey) return;
  let ok = false;
  try { ok = globalShortcut.register(clipKey, () => applySettings({ ...settings, clipInfo: !settings.clipInfo })); } catch { ok = false; }
  if (!ok) { log('warn', `Clip Info shortcut ${clipKey} is not available (used by another app); choose another in Settings`); clipKey = ''; }
}
function syncClipInfo() {
  const open = clipWin && !clipWin.isDestroyed();
  if (settings.clipInfo && !open) openClipInfo();
  if (!settings.clipInfo && open) clipWin.close();
}
function openClipInfo() {
  const { workArea } = screen.getPrimaryDisplay();
  clipWin = new BrowserWindow({
    width: 320, height: 300, x: workArea.x + workArea.width - 340, y: workArea.y + workArea.height - 320,
    alwaysOnTop: true, frame: false, resizable: true, skipTaskbar: true, backgroundColor: '#16181d', title: 'Clip Info',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  clipWin.setAlwaysOnTop(true, 'floating');
  clipWin.loadFile(path.join(__dirname, '..', 'renderer', 'clipinfo.html'));
  clipTimer = setInterval(async () => {
    if (clipBusy || !clipWin || clipWin.isDestroyed()) return;
    clipBusy = true;
    try { const info = await bridge.clipInfo(); if (clipWin && !clipWin.isDestroyed()) clipWin.webContents.send('clipinfo', info); }
    catch (err) { if (clipWin && !clipWin.isDestroyed()) clipWin.webContents.send('clipinfo', { ok: false, error: err.message }); }
    finally { clipBusy = false; }
  }, 700);
  clipWin.on('closed', () => { clearInterval(clipTimer); clipWin = null; updateTray(); });
  // Developer check: AVPP_CLIPSHOT=<file.png> saves a picture of the window.
  if (process.env.AVPP_CLIPSHOT) setTimeout(async () => { log('info', `clip window visible=${clipWin.isVisible()} bounds=${JSON.stringify(clipWin.getBounds())}`); fs.writeFileSync(process.env.AVPP_CLIPSHOT, (await clipWin.webContents.capturePage()).toPNG()); }, 6000);
  updateTray();
}
ipcMain.handle('clipinfo-toggle', () => applySettings({ ...settings, clipInfo: !settings.clipInfo }));
// The window grows upwards when '+ more' is opened, so it stays in its corner.
ipcMain.handle('clipinfo-height', (_e, height) => {
  if (!clipWin || clipWin.isDestroyed()) return;
  const b = clipWin.getBounds(), h = Math.max(120, Math.min(900, Math.round(height)));
  clipWin.setBounds({ x: b.x, y: b.y + b.height - h, width: b.width, height: h });
});

function updateTray() {
  if (!tray) return;
  const a = settings.autosave;
  const proj = status.project ? status.project.name : 'no project';
  tray.setToolTip(`AV PostPilot\n${status.connected ? `Resolve: ${proj}` : 'Resolve not connected'}\nAuto-save ${a.enabled ? 'on' : 'off'}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open AV PostPilot', click: showWindow },
    { label: 'Clip Info window', type: 'checkbox', checked: settings.clipInfo, click: (item) => applySettings({ ...settings, clipInfo: item.checked }) },
    { type: 'separator' },
    { label: 'Save .drp now', enabled: status.connected && !autosaver.running, click: () => autosaver.run('manual') },
    { label: 'Auto-save', type: 'checkbox', checked: a.enabled, click: (item) => applySettings({ ...settings, autosave: { ...a, enabled: item.checked } }) },
    { type: 'separator' },
    shutdownAt
      ? { label: 'CANCEL SHUTDOWN', click: cancelShutdown }
      : { label: `Shut down this PC in ${mmss(countdown(settings.manual.shutdownSeconds))}…`, click: () => scheduleShutdown('manual', countdown(settings.manual.shutdownSeconds)) },
    { label: 'HD review after renders', type: 'checkbox', checked: settings.renders.hd.enabled,
      click: (item) => applySettings({ ...settings, renders: { ...settings.renders, hd: { ...settings.renders.hd, enabled: item.checked } } }) },
    { type: 'separator' },
    { label: 'Quit AV PostPilot', click: () => { quitting = true; app.quit(); } },
  ]));
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function applySettings(next) {
  const before = settings.autosave;
  const python = settings.quietLift.python;
  const fcPython = settings.feedbackCutter.python;
  settings = mergeSettings(next);
  if (python !== settings.quietLift.python) quietLift.stop();
  if (fcPython !== settings.feedbackCutter.python) feedback.stop();
  writeJson(SETTINGS_FILE, settings);
  if (before.enabled !== settings.autosave.enabled || before.intervalMin !== settings.autosave.intervalMin) {
    autosaver.schedule();
  }
  send('settings', settings);
  syncClipInfo();
  registerClipKey();
  updateTray();
  return settings;
}

// ------------------------------------------------------------------ IPC
const databaseBackup = new libraryBackup.LibraryBackup({
  getSettings: () => settings.libraryBackup, getPassword: () => getSecret('postgres'),
  notify: (...args) => notifier.notify(...args), log,
  onChange: () => send('library-backup', { running: databaseBackup.running }),
});
ipcMain.handle('library-backup', async (_e, action, options = {}) => {
  try {
    if (action === 'status') return { ...libraryBackup.monitor(settings.libraryBackup), running: databaseBackup.running };
    if (action === 'check') return { ok: true, libraries: await databaseBackup.check() };
    if (action === 'run') return await databaseBackup.run();
    if (['schedule-start', 'schedule-stop', 'schedule-status'].includes(action)) {
      const what = action.slice(9);
      if (what !== 'status') {
        if (!app.isPackaged) throw new Error('Scheduled backups need the installed app (it runs PostPilot itself at each time)');
        if (what === 'start') libraryBackup.validate(settings.libraryBackup);
      }
      const r = libraryBackup.schedule(what, settings.libraryBackup, process.execPath, DATA);
      if (what !== 'status') log('info', r.scheduled ? `Library backups scheduled daily at ${settings.libraryBackup.times}` : 'Scheduled library backups stopped');
      return { ok: true, ...r, times: settings.libraryBackup.times };
    }
    if (action === 'schedule') {
      if (process.platform === 'darwin' && app.isPackaged) {
        libraryBackup.validate(settings.libraryBackup);
        const picked = await dialog.showOpenDialog(win, { title: 'Choose where to export Mac backup schedule', properties: ['openDirectory', 'createDirectory'] });
        if (picked.canceled) return { ok: false, canceled: true };
        const dest = path.join(picked.filePaths[0], 'PostPilot-Mac-Library-Schedule');
        if (fs.existsSync(dest)) throw new Error('Schedule export folder already exists; choose another location');
        const source = libraryBackup.macSchedule(settings.libraryBackup, process.execPath, DATA);
        fs.mkdirSync(dest);
        fs.writeFileSync(path.join(dest, `${source.label}.plist`), source.plist);
        fs.writeFileSync(path.join(dest, `${source.healthLabel}.plist`), source.healthPlist);
        fs.writeFileSync(path.join(dest, 'install.sh'), source.installer, { mode: 0o700 });
        return { ok: true, file: dest };
      }
      if (process.platform !== 'win32' || !app.isPackaged) throw new Error('Export the Windows schedule from the packaged app on the server');
      libraryBackup.validate(settings.libraryBackup);
      const source = libraryBackup.windowsSchedule(settings.libraryBackup, process.execPath, DATA, Boolean(options.unattended)) + libraryBackup.windowsHealthSchedule(process.execPath, DATA, Boolean(options.unattended));
      const picked = await dialog.showSaveDialog(win, { title: 'Save Windows backup schedule setup', defaultPath: 'PostPilot-Backup-Schedule.ps1', filters: [{ name: 'PowerShell', extensions: ['ps1'] }] });
      if (picked.canceled) return { ok: false, canceled: true };
      fs.writeFileSync(picked.filePath, source, 'utf8');
      return { ok: true, file: picked.filePath };
    }
    throw new Error('Unknown library backup action');
  } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('get-initial', () => ({
  settings, status, autosave: autosaver.summary(), log: logLines, platform: process.platform,
  scene: sceneQueue.summary(), encoder: encoder.summary(), night: night.summary(), handbrake: handbrake.summary(), renders: renders.summary(), shutdownAt, shutdownReason,
  pc: os.hostname(), version: app.getVersion(),
}));
ipcMain.handle('stabilize', async (_e, args) => {
  try {
    if (args.action === 'summary') return { ok: true, ...stabilization.summary() };
    if (args.action === 'stop') return stabilization.stop();
    if (args.action === 'runs') return { ok: true, runs: stabilization.runs() };
    if (night.running) return { ok: false, error: 'The night queue is running' };
    if (encoder.running || sceneQueue.running || autosaver.running || shutdownAt) return { ok: false, error: 'Finish the current operation and cancel any planned shutdown first' };
    if (args.action === 'timelines') return await stabilization.timelines();
    if (args.action === 'scan') return await stabilization.scan(args.color, args.timelines || []);
    if (args.action === 'start') {
      let result;
      try { result = await stabilization.start(args.keys || [], args.anchors || [], args.moving || []); }
      catch (err) { notifier.notify('stabQueueDone', `🎥 Stabilization stopped on ${os.hostname()}: ${err.message}`); throw err; }
      const run = stabilization.clips.filter(c => (args.keys || []).includes(c.key));
      const passed = run.filter(c => c.status === 'Passed').length, review = run.filter(c => c.status === 'Needs review').length; const viaResolve = run.filter(c => c.status === 'Stabilized (Resolve)').length;
      notifier.notify('stabQueueDone', `🎥 Stabilization finished on ${os.hostname()}: ${passed}/${run.length} passed${viaResolve ? `, ${viaResolve} via Resolve's stabilizer` : ''}${review ? `, ${review} need review` : ''} in ${mmss(Math.round((stabilization.finishedAt - stabilization.startedAt) / 1000))}.`);
      afterQueue(settings.stab.afterQueue, 'stabilization queue');
      return result;
    }
    if (args.action === 'review') return await stabilization.review(args.key, args.where);
    if (args.action === 'approve') return await stabilization.approve(args.keys || [], { removeMarkers: Boolean(args.removeMarkers), file: path.join(DATA, 'stabilization-apply.comp'), version: args.version });
    if (args.action === 'force') return await stabilization.forceTracker(args.key, args.anchors || []);
    if (args.action === 'open') return await stabilization.openRun(args.id);
    if (args.action === 'undo') return await stabilization.undo(args.key);
    if (args.action === 'deletecopies') return await stabilization.deleteCopies();
    if (stabilization.running) return { ok: false, error: 'Wait for tracking to finish' };
    if (args.action === 'preview') {
      const file = path.join(DATA, 'stabilization-preview.png');
      const result = await stabilization.preview(args.key, args.frame, file);
      if (result.ok) return { ok: true, frame: result.frame, image: nativeImage.createFromPath(file).resize({ width: 1280 }).toDataURL() };
      return result;
    }
    return { ok: false, error: 'Unknown stabilization action' };
  } catch (error) { return { ok: false, error: error.message }; }
});
ipcMain.handle('premiere', async (_e, args) => {
  try {
    if (args.action === 'summary') return { ok: true, ...premiere.summary() };
    if (args.action === 'pick-project') {
      const r = await dialog.showOpenDialog(win, { title: 'Open a Premiere Pro project', properties: ['openFile'], filters: [{ name: 'Premiere Pro project', extensions: ['prproj'] }] });
      return { ok: true, file: r.canceled ? '' : r.filePaths[0] };
    }
    if (args.action === 'pick-xml') {
      const r = await dialog.showOpenDialog(win, { title: 'Add Final Cut Pro XML exported from Premiere', defaultPath: args.folder || undefined, properties: ['openFile', 'multiSelections'], filters: [{ name: 'Final Cut Pro XML', extensions: ['xml'] }] });
      return r.canceled ? { ok: true, added: 0, unknown: [] } : premiere.addXmls(r.filePaths);
    }
    if (args.action === 'link-status') return { ok: true, ...premiereLink.status() };
    if (args.action === 'link-install') return premiereLink.install();
    if (args.action === 'analyze') return { ok: true, ...premiere.analyze(args.file, args.roots || []) };
    if (args.action === 'rescan') { premiere.attachXmls(); return { ok: true, ...premiere.summary() }; }
    if (encoder.running || stabilization.running) return { ok: false, error: 'Finish Encoder / Stabilization first' };
    if (args.action === 'fetch-xml') return await premiere.fromPremiere(args.names || []);
    if (args.action === 'import') return await premiere.importSequences(args.names || [], { markGrades: args.markGrades !== false, newProject: args.newProject !== false });
    if (args.action === 'goto') return await premiere.goto(args.sequence, args.track, args.start);
    if (args.action === 'copygrade') return await premiere.copyGrade(args.sequence, args.look);
    return { ok: false, error: 'Unknown Premiere action' };
  } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('save-settings', (_e, next) => applySettings(next));
ipcMain.handle('save-now', () => autosaver.run('manual'));
ipcMain.handle('launch-resolve', () => launchResolve());
ipcMain.handle('pick-folder', async (_e, current) => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Choose a folder', defaultPath: current || undefined,
    properties: ['openDirectory', 'createDirectory'],
  });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('pick-resolve', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Find Resolve.exe', filters: [{ name: 'Resolve', extensions: ['exe'] }], properties: ['openFile'],
  });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('open-path', (_e, p) => (p && fs.existsSync(p) ? shell.openPath(p) : 'Folder not found'));
ipcMain.handle('open-log', () => shell.openPath(LOG_FILE));
ipcMain.handle('check-path', (_e, p) => Boolean(p) && fs.existsSync(p));
ipcMain.handle('is-network-path', (_e, p) => isNetworkPath(p));

// ------------------------------------------------------------------ project tools
ipcMain.handle('pick-folders', async (_e, current) => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Choose satsang day folders', defaultPath: current || undefined,
    properties: ['openDirectory', 'multiSelections'],
  });
  return r.canceled ? [] : r.filePaths;
});

ipcMain.handle('scan-days', (_e, dirs) => dirs.map((d) => {
  try {
    const s = ps.scanDay(d);
    return { dir: d, name: s.name, number: s.number,
      sessions: s.sessions.map((x) => ({ master: x.master, edit: x.edit, cue: x.cue, clips: x.clips.length, folder: path.basename(x.folder) })) };
  } catch (err) {
    return { dir: d, name: path.basename(d), error: err.message, sessions: [] };
  }
}));

let projectBusy = false;
// footage: 'move' (same drive, else copy) | 'copy' | 'leave' (import from where it is)
ipcMain.handle('create-project', async (_e, { name, location, days, footage }) => {
  if (stabilization.running) return { ok: false, error: 'Finish stabilization first' };
  footage = ['move', 'copy', 'leave'].includes(footage) ? footage : 'move';
  const move = footage === 'move';
  if (projectBusy) return { ok: false, error: 'A project is already being created' };
  projectBusy = true;
  const step = (msg, extra = {}) => { send('project-progress', { msg, ...extra }); log('info', msg); };
  try {
    name = String(name || '').trim();
    if (!name) throw new Error('Enter a project name');
    if (/[<>:"/\\|?*]/.test(name)) throw new Error('The project name can\'t contain < > : " / \\ | ? *');
    if (!location || !fs.existsSync(location)) throw new Error('Choose a project location that exists');
    if (!days.length) throw new Error('Add at least one satsang folder');
    if (!status.connected) throw new Error('Resolve is not connected');
    const satsang = path.join(location, name, 'Satsang Files');
    // A folder moved by an earlier attempt that stopped half-way is already in place.
    days = days.map((d) => (!fs.existsSync(d) && fs.existsSync(path.join(satsang, path.basename(d))) ? path.join(satsang, path.basename(d)) : d));
    for (const d of days) if (!fs.existsSync(d)) throw new Error(`Folder not found: ${d}`);

    const leave = footage === 'leave';
    const root = ps.createProjectFolders(location, name, settings.project.folders, { needSatsang: !leave });
    step(`Created folders in ${root}`);

    const moved = [];
    for (const d of days) {
      if (leave) { moved.push(d); continue; }        // footage stays where it is
      if (path.dirname(path.resolve(d)).toLowerCase() === satsang.toLowerCase()) { moved.push(d); continue; }   // already there
      step(`Bringing in ${path.basename(d)}…`);
      const r = await ps.transferFolder(d, satsang, {
        move,
        onProgress: (p) => send('project-progress', {
          msg: p.total ? `Copying ${path.basename(d)}: ${p.file}` : p.file, done: p.done, total: p.total }),
      });
      step(r.moved ? `Moved ${path.basename(d)} (same drive)` : `Copied ${path.basename(d)}, original left in place`);
      moved.push(r.dest);
    }

    const scanned = moved.map(ps.scanDay);
    const timelines = scanned.flatMap((d) => d.sessions.map((s) => ({ master: s.master, edit: s.edit, clips: s.clips })));
    const dirs = moved.flatMap((d) => ps.mediaTree(d, ['Satsang Files', path.basename(d)]));
    step(`Creating Resolve project "${name}" and importing footage…`);
    const res = await bridge.setupProject({ project: name, bins: ps.BINS, dirs, timelines });
    if (!res.ok) throw new Error(res.error);
    settings = mergeSettings({ ...settings, project: { ...settings.project, location, footage } });
    writeJson(SETTINGS_FILE, settings);
    step(`Project "${name}" ready: ${res.imported} clip(s), ${res.timelines.length} timeline(s)`);
    notifier.notify('projectCreated', `🆕 Project created: ${name}\n${res.timelines.join(', ')}`);
    for (const p of res.problems || []) log('warn', p);
    return { ok: true, root, ...res };
  } catch (err) {
    log('error', `New project failed: ${err.message}`);
    return { ok: false, error: err.message };
  } finally {
    projectBusy = false;
  }
});

// ------------------------------------------------------------------ notifications
ipcMain.handle('has-secrets', () => ({ telegram: Boolean(getSecret('telegram')), whapi: Boolean(getSecret('whapi')), ntfy: Boolean(getSecret('ntfy')), email: Boolean(getSecret('email')), postgres: Boolean(getSecret('postgres')) }));
ipcMain.handle('set-secret', (_e, { kind, value }) => { setSecret(kind, kind === 'postgres' ? String(value || '') : String(value || '').trim()); return true; });
ipcMain.handle('find-chats', async (_e, kind) => {
  const token = getSecret(kind);
  if (!token) return { ok: false, error: 'Save the token first' };
  try {
    return { ok: true, chats: kind === 'telegram' ? await telegram.findChats(token) : await whapi.findGroups(token) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.handle('send-test', async (_e, only) => {
  if (only && !['ntfy', 'email'].includes(only)) return { ok: false, error: 'Unknown notification service' };
  const report = await notifier.sendReport(`👋 Test message from AV PostPilot on ${os.hostname()}`, only);
  return {
    ...report, ok: report.sent > 0 && report.errors.length === 0,
    error: report.errors.join('\n') || (report.sent ? '' : 'Nothing was sent. Enable the service and configure its topic or recipients and credentials. See Activity for errors.'),
  };
});

// ------------------------------------------------------------------ scene cuts + shutdown
ipcMain.handle('scene-add', (_e, names) => {
  try { sceneQueue.add(status.project?.name, names); return { ok: true }; } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('scene-remove', (_e, i) => sceneQueue.remove(i));
ipcMain.handle('scene-clear', () => sceneQueue.clearFinished());
ipcMain.handle('scene-start', () => {
  if (night.running) return { ok: false, error: 'The night queue is running' };
  if (stabilization.running) return { ok: false, error: 'Finish stabilization first' };
  if (encoder.running) return { ok: false, error: 'Finish Encoder before starting scene cuts' };
  if (!status.connected) return { ok: false, error: 'Resolve is not connected' };
  // Answer straight away: the queue itself can run for hours.
  const run = sceneQueue.start(status.project?.name);
  return Promise.race([run, new Promise((r) => setTimeout(() => r({ ok: true, started: true }), 500))]);
});
ipcMain.handle('scene-stop', () => sceneQueue.stop());

// ------------------------------------------------------------------ night queue
ipcMain.handle('night', async (_e, { action, args = {} }) => {
  try {
    if (action === 'summary') return { ok: true, ...night.summary() };
    if (action === 'conflicts') return { ok: true, timelines: night.conflicts(args.type, args) };
    if (action === 'add') { night.add(status.project?.name, args.type, args); return { ok: true }; }
    if (action === 'remove') { night.remove(args.id); return { ok: true }; }
    if (action === 'move') { night.move(args.id, args.by); return { ok: true }; }
    if (action === 'clear') { night.clearFinished(); return { ok: true }; }
    if (action === 'stop') { night.stop(); return { ok: true }; }
    if (action === 'start') {
      if (!status.connected) return { ok: false, error: 'Resolve is not connected' };
      if (sceneQueue.running || stabilization.running || encoder.running || autosaver.running) return { ok: false, error: 'Wait for the current operation to finish' };
      if (status.rendering || renders.active || renders.settling || renders.hdBatch || renders.pendingCopies) return { ok: false, error: 'Wait for the current render to finish' };
      if (shutdownAt) return { ok: false, error: 'Cancel the shutdown countdown first' };
      const problem = night.check(status.project?.name);
      if (problem) return { ok: false, error: problem };
      // Ask now, while someone is at the PC: encoding saves and closes the project.
      // (AVPP_SCREENSHOT + AVPP_YES: scripted developer checks answer yes)
      if (night.steps.some((s) => s.type === 'encode' && s.state === 'waiting') && status.project && !(process.env.AVPP_SCREENSHOT && process.env.AVPP_YES)) {
        const r = await dialog.showMessageBox(win, {
          type: 'warning', title: 'Night queue with encoding',
          message: `The last step encodes in a temporary project: "${status.project.name}" will be saved and closed then.`,
          detail: 'PostPilot saves and closes your project when the Encoder step starts, encodes in a separate empty temporary project and deletes that project afterwards.',
          buttons: ['Start the night queue', 'Cancel'], defaultId: 1, cancelId: 1,
        });
        if (r.response !== 0) return { ok: true, cancelled: true };
      }
      // Answer straight away: the queue runs for hours.
      return Promise.race([night.start(), new Promise((r) => setTimeout(() => r({ ok: true, started: true }), 500))]);
    }
    return { ok: false, error: 'Unknown night queue action' };
  } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('shutdown-cancel', () => cancelShutdown());

// ------------------------------------------------------------------ encoder
const ENC_ACTIONS = {
  addGroup: (a) => encoder.addGroup(a),
  updateGroup: (a) => encoder.updateGroup(a.id, a.fields),
  removeGroup: (a) => encoder.removeGroup(a.id),
  addPaths: (a) => encoder.addPaths(a.id, a.paths),
  updateItem: (a) => encoder.updateItem(a.group, a.id, a.fields),
  removeItem: (a) => encoder.removeItem(a.group, a.id),
  clearFinished: () => encoder.clearFinished(),
  stop: () => encoder.stop(),
};
ipcMain.handle('encoder', async (_e, { action, args }) => {
  if (stabilization.running && action === 'start') return { ok: false, error: 'Finish stabilization first' };
  if (night.running && action === 'start') return { ok: false, error: 'The night queue is running' };
  try {
    if (action === 'start') {
      if (!status.connected) return { ok: false, error: 'Connect to Resolve first' };
      if (autosaver.running) return { ok: false, error: 'Wait for the current auto-save to finish' };
      if (sceneQueue.running || renders.active || renders.settling || renders.hdBatch || renders.finished.length || renders.pendingCopies || shutdownAt) return { ok: false, error: 'Finish the current scene/render queue and cancel any shutdown countdown before starting Encoder' };
      // Answer straight away: the queue can run for hours.
      return new Promise((resolve, reject) => {
        encoder.start(() => resolve({ ok: true, started: true })).then(resolve, reject);
      });
    }
    const fn = ENC_ACTIONS[action];
    if (!fn) return { ok: false, error: `unknown action ${action}` };
    return { ok: true, result: await fn(args || {}) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.handle('handbrake', async (_e, { action, args = {} }) => {
  try {
    if (action === 'summary') return { ok: true, ...handbrake.summary() };
    if (action === 'info') {
      const h = settings.handbrake;
      let preset = '', presetError = '';
      if (h.presetFile) try { preset = handbrakePreset(h.presetFile); } catch (err) { presetError = err.message; }
      const cli = findHandbrakeCli(h.cliPath);
      return { ok: true, cli, builtIn: Boolean(cli) && cli === bundledCli(), version: HANDBRAKE_VERSION, preset, presetError, defaultReportDir: path.join(DATA, 'handbrake-reports') };
    }
    if (action === 'preview') return { ok: true, ...handbrake.preview() };
    if (action === 'start') {
      // Answer straight away: a folder of satsangs can take all night.
      const r = handbrake.start();
      return Promise.race([r, new Promise((res) => setTimeout(() => res({ ok: true, started: true }), 300))]);
    }
    if (action === 'stop') { handbrake.stop(); return { ok: true }; }
    if (action === 'pick-preset' || action === 'pick-cli') {
      const preset = action === 'pick-preset';
      const r = await dialog.showOpenDialog(win, {
        title: preset ? 'Choose a preset exported from HandBrake' : 'Find HandBrakeCLI',
        defaultPath: args.current || undefined, properties: ['openFile'],
        filters: preset ? [{ name: 'HandBrake preset', extensions: ['json'] }] : process.platform === 'win32' ? [{ name: 'HandBrakeCLI', extensions: ['exe'] }] : [],
      });
      if (r.canceled) return { ok: true, path: null };
      if (preset) handbrakePreset(r.filePaths[0]);   // throws if it is not a HandBrake preset export
      return { ok: true, path: r.filePaths[0] };
    }
    return { ok: false, error: 'Unknown HandBrake action' };
  } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('enc-preview', async (_e, { action, file }) => {
  try {
    if (action === 'probe') {
      const info = await mediaPreview.probe(file);
      const copy = mediaPreview.existing(file);
      return { ok: true, ...info, url: url.pathToFileURL(file).href, previewUrl: copy ? url.pathToFileURL(copy).href : null };
    }
    if (action === 'make') {
      const copy = await mediaPreview.make(file, (pct) => send('enc-preview', { file, pct }));
      return { ok: true, url: url.pathToFileURL(copy).href };
    }
    if (action === 'cancel') { mediaPreview.cancel(); return { ok: true }; }
    return { ok: false, error: 'Unknown preview action' };
  } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('quietlift', async (_e, { action, args = {} }) => {
  try {
    if (action === 'call') return { ok: true, data: await quietLift.call(args.cmd, args.payload) };
    if (action === 'restart') { quietLift.stop(); return { ok: true }; }
    if (action === 'reveal') { shell.showItemInFolder(args.path); return { ok: true }; }
    const WAV = [{ name: 'WAV audio', extensions: ['wav'] }, { name: 'All files', extensions: ['*'] }];
    if (action === 'pick-wav' || action === 'pick-exe') {
      const exe = action === 'pick-exe';
      const r = await dialog.showOpenDialog(win, {
        title: exe ? 'Find the audio editor' : 'Choose a WAV file', defaultPath: args.current || undefined, properties: ['openFile'],
        filters: exe ? (process.platform === 'win32' ? [{ name: 'Programs', extensions: ['exe'] }] : []) : WAV,
      });
      return { ok: true, path: r.canceled ? null : r.filePaths[0] };
    }
    if (action === 'save-wav') {
      const r = await dialog.showSaveDialog(win, { title: 'Save the lifted file', defaultPath: args.current || undefined, filters: WAV });
      return { ok: true, path: r.canceled ? null : r.filePath };
    }
    return { ok: false, error: 'Unknown Quiet Lift action' };
  } catch (err) { return { ok: false, error: err.message }; }
});
// args: job, name (file in the job folder), source (the recording), suffix. Returns the saved path or null.
async function saveFeedbackFile(args) {
  const file = feedbackCutter.jobFile(FEEDBACK_WORK, args.job, args.name);
  const ext = path.extname(args.name).slice(1);
  const r = await dialog.showSaveDialog(win, {
    title: 'Save', defaultPath: path.join(path.dirname(args.source), feedbackCutter.exportName(args.source, args.suffix, ext)),
    filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
  });
  if (r.canceled) return null;
  await fs.promises.copyFile(file, r.filePath);
  log('info', `Feedback Cutter: saved ${r.filePath}`);
  if (feedbackUnsaved && args.job === feedbackUnsaved.job && args.name === feedbackUnsaved.name) {
    feedbackUnsaved = null;
    send('feedback', { saved: true });
  }
  return r.filePath;
}
// Cleaned audio exists only in the work folder until it is saved, and that folder is emptied
// when another recording is opened or PostPilot starts again. True = go ahead (saved or discarded).
let feedbackUnsaved = null, feedbackAsking = false;
async function askFeedbackUnsaved(question, discardLabel) {
  if (!feedbackUnsaved) return true;
  showWindow();
  if (feedbackAsking) return false;   // already asking (Quit clicked twice)
  feedbackAsking = true;
  try { return await askFeedbackSave(question, discardLabel); } finally { feedbackAsking = false; }
}
async function askFeedbackSave(question, discardLabel) {
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning', buttons: ['Save cleaned WAV…', discardLabel, 'Cancel'], defaultId: 0, cancelId: 2, noLink: true,
    title: 'Feedback Cutter', message: `The cleaned audio of ${path.basename(feedbackUnsaved.source)} is not saved.`,
    detail: `${question} The cleaned audio will be lost.`,
  });
  if (response === 2) return false;
  if (response === 0) {
    try {
      if (!(await saveFeedbackFile({ ...feedbackUnsaved, suffix: 'cleaned' }))) return false;
    } catch (err) { dialog.showErrorBox('Save failed', err.message); return false; }
  }
  feedbackUnsaved = null;
  return true;
}
ipcMain.handle('feedback', async (_e, { action, args = {} }) => {
  try {
    if (action === 'call') return { ok: true, data: await feedback.call(args.cmd, args.payload) };
    if (action === 'restart') { feedback.stop(); return { ok: true }; }
    if (action === 'url') return { ok: true, url: url.pathToFileURL(feedbackCutter.jobFile(FEEDBACK_WORK, args.job, args.name)).href };
    if (action === 'pick-audio') {
      const r = await dialog.showOpenDialog(win, {
        title: 'Choose a recording', defaultPath: args.current || undefined, properties: ['openFile'],
        filters: [{ name: 'Audio', extensions: ['wav', 'mp3', 'flac', 'm4a', 'aif', 'aiff', 'aac', 'ogg', 'wma'] }, { name: 'All files', extensions: ['*'] }],
      });
      return { ok: true, path: r.canceled ? null : r.filePaths[0] };
    }
    if (action === 'export') return { ok: true, path: await saveFeedbackFile(args) };
    // the cleaned audio the page has not saved yet ({ job, name, source } or null)
    if (action === 'unsaved') { feedbackUnsaved = args.unsaved || null; return { ok: true }; }
    if (action === 'confirm-discard') return { ok: true, go: await askFeedbackUnsaved('Open another recording anyway?', 'Open without saving') };
    if (action === 'reveal') { shell.showItemInFolder(args.path); return { ok: true }; }
    return { ok: false, error: 'Unknown Feedback Cutter action' };
  } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('pick-image', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Choose a colour bars picture', properties: ['openFile'], filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'tif', 'tiff', 'dpx', 'exr'] }] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('pick-files', async (_e, current) => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Add video files', defaultPath: current || undefined,
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Video', extensions: ['mov', 'mp4', 'mxf', 'm4v', 'avi', 'mkv', 'mts', 'm2ts', 'braw', 'r3d', 'crm', 'wmv', 'mpg', 'mpeg', 'webm'] }, { name: 'All files', extensions: ['*'] }],
  });
  return r.canceled ? [] : r.filePaths;
});
ipcMain.handle('render-presets', async () => {
  const st = await bridge.status();
  if (!st.connected) return { ok: false, error: 'Connect to Resolve first' };
  if (st.project) return bridge.renderPresets();
  if (encoder.running || autosaver.running) return { ok: false, error: 'Wait for the current operation to finish' };
  const token = require('crypto').randomUUID();
  const begin = await bridge.encoderBegin({ token, name: `PostPilot Encoder temp ${token}`, originalId: '' });
  if (!begin.ok) return begin;
  try { return await bridge.renderPresets(); }
  finally {
    const finish = await bridge.encoderFinish({ token });
    if (!finish.ok) log('warn', `Preset workspace cleanup: ${finish.error}`);
  }
});
ipcMain.handle('shutdown-now', () => scheduleShutdown('manual', countdown(settings.manual.shutdownSeconds)));

ipcMain.handle('plan-series', (_e, form) => ep.planSeries(form));

// Series-name suggestions: the imported list, or the built-in one.
ipcMain.handle('series-names', () => ({ names: settings.series.names || seriesList.DEFAULT_NAMES, custom: Boolean(settings.series.names) }));
ipcMain.handle('import-series-names', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Series list (first column = series names)', properties: ['openFile'],
    filters: [{ name: 'Spreadsheet', extensions: ['csv', 'xlsx', 'xls'] }],
  });
  if (r.canceled) return { ok: false, canceled: true };
  try {
    const names = seriesList.readSeriesFile(r.filePaths[0]);
    applySettings({ ...settings, series: { ...settings.series, names } });
    log('info', `Series list updated from ${path.basename(r.filePaths[0])}: ${names.length} name(s)`);
    return { ok: true, count: names.length, names };
  } catch (err) {
    return { ok: false, error: `Could not read ${path.basename(r.filePaths[0])}: ${err.message}` };
  }
});

ipcMain.handle('create-series', async (_e, form) => {
  if (stabilization.running) return { ok: false, error: 'Finish stabilization first' };
  if (!status.connected || !status.project) return { ok: false, error: 'Open the project in Resolve first' };
  const episodes = ep.planSeries(form);
  if (!episodes.length) return { ok: false, error: 'Add at least one episode' };
  settings = mergeSettings({ ...settings, series: { ...settings.series, title: form.title, subtitle: form.subtitle, size: form.size, background: form.background || 'plain', barsImage: form.barsImage || '' } });
  writeJson(SETTINGS_FILE, settings);
  // Colour bars: the user's own picture, or a still of Resolve's SMPTE bars.
  let background = null;
  if (form.background === 'bars') {
    if (form.barsImage) {
      if (!fs.existsSync(form.barsImage)) return { ok: false, error: `Colour bars picture not found: ${form.barsImage}` };
      background = form.barsImage;
    } else {
      const b = await bridge.barsStill(DATA);
      if (!b.ok) return { ok: false, error: b.error };
      background = b.path;
    }
  }
  const res = await bridge.createSeries({
    episodes, font: settings.series.font, style: settings.series.style, size: Number(form.size) || 0.11,
    background, centerY: background ? 0.6 : null,          // text in the upper bars, above the white/grey band
  });
  if (res.ok) {
    log('info', `Created ${res.made.length} episode timeline(s) in "${status.project.name}"`);
    if (res.skipped.length) log('warn', `Already existed, skipped: ${res.skipped.join(', ')}`);
    for (const p of res.problems) log('warn', p);
  }
  return res;
});

ipcMain.handle('list-series', async () => {
  if (!status.connected || !status.project) return { ok: false, error: 'Open the project in Resolve first' };
  const res = await bridge.listTimelines();
  if (!res.ok) return res;
  const cues = res.names.filter((n) => /^Master-/i.test(n)).map((n) => n.slice(7));
  return { ok: true, project: res.project, series: ep.findSeries(res.names), cues, allNames: res.names };
});

ipcMain.handle('plan-rename', async (_e, { seriesInfo, form }) => ep.planRename(seriesInfo, form));

ipcMain.handle('rename-series', async (_e, { seriesInfo, form }) => {
  if (stabilization.running) return { ok: false, error: 'Finish stabilization first' };
  const items = ep.planRename(seriesInfo, form);
  const oldSet = Object.fromEntries(items.map((i) => [i.old, true]));
  const res = await bridge.renameSeries({ items, oldSet });
  if (res.ok) {
    log('info', `Renamed "${seriesInfo.series}" → "${form.series}" (${res.renamed} episode(s))`);
    for (const p of res.problems) log('warn', p);
  }
  return res;
});

// ------------------------------------------------------------------ start
// The shortcut was clicked while PostPilot was already running (e.g. in the
// tray after Resolve was closed): bring the window back AND open Resolve.
app.on('second-instance', () => {
  showWindow();
  if (settings.launchResolve) launchResolve();
});
app.on('before-quit', e => {
  if (stabilization.running) { e.preventDefault(); log('warn', 'Stop after the current clip and wait for stabilization before quitting'); showWindow(); return; }
  if (encoder.running) { e.preventDefault(); log('warn', 'Stop Encoder and wait for the current file and project cleanup before quitting'); showWindow(); return; }
  if (databaseBackup.running) { e.preventDefault(); log('warn', 'Wait for the library backup to finish before quitting'); showWindow(); return; }
  if (handbrake.running) { e.preventDefault(); log('warn', 'Stop the HandBrake conversion before quitting'); showWindow(); return; }
  if (quietLift.busy) { e.preventDefault(); log('warn', 'Wait for Quiet Lift to finish before quitting'); showWindow(); return; }
  if (feedback.busy) { e.preventDefault(); log('warn', 'Wait for Feedback Cutter to finish before quitting'); showWindow(); return; }
  // (not in scripted developer checks: nobody is there to answer)
  if (feedbackUnsaved && !process.env.AVPP_SCREENSHOT) {
    e.preventDefault();
    quitting = false;   // closing the window hides it again while the question is open
    askFeedbackUnsaved('Quit anyway?', 'Quit without saving').then((go) => { if (go) { quitting = true; app.quit(); } });
    return;
  }
  quitting = true; bridge.stop(); quietLift.stop(); feedback.stop();
});
app.on('window-all-closed', (e) => e.preventDefault());

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  tray = new Tray(nativeImage.createFromPath(iconPath('tray.png')));
  tray.on('click', showWindow);
  createWindow(!settings.startHidden);
  log('info', `AV PostPilot ${app.getVersion()} started on ${os.hostname()}`);
  if (settings.launchResolve) await launchResolve();
  autosaver.schedule();
  const checkLibraryAge = () => checkOverdue({ settings, stateFile: path.join(DATA, 'library-overdue.json'), notify: (...args) => notifier.notify(...args) }).catch(err => log('warn', `Backup health check: ${err.message}`));
  checkLibraryAge();
  setInterval(checkLibraryAge, 5 * 60 * 1000);
  await poll();
  setInterval(poll, 3000);
  if (process.env.AVPP_CLIPINFO) settings.clipInfo = true;
  syncClipInfo();
  registerClipKey();

  // Developer check: AVPP_SCREENSHOT=<folder> saves a picture of every page.
  if (process.env.AVPP_SCREENSHOT) {
    setTimeout(async () => {
      if (process.env.AVPP_MAXIMIZE) { win.maximize(); await new Promise((r) => setTimeout(r, 800)); }
      // AVPP_EVAL_FILE: page code to run first (developer checks only)
      if (process.env.AVPP_EVAL_FILE) {
        // AVPP_SNAP_SECONDS: also save a picture every n seconds while that code runs
        let snap = 0;
        const snaps = process.env.AVPP_SNAP_SECONDS && setInterval(async () => {
          const file = path.join(process.env.AVPP_SCREENSHOT, `snap-${String(++snap).padStart(3, '0')}.png`);
          win.webContents.invalidate();             // a window behind others doesn't repaint by itself
          await new Promise((r) => setTimeout(r, 300));
          fs.writeFileSync(file, (await win.webContents.capturePage()).toPNG());
        }, Number(process.env.AVPP_SNAP_SECONDS) * 1000);
        const out = await win.webContents.executeJavaScript(fs.readFileSync(process.env.AVPP_EVAL_FILE, 'utf8')).catch((e) => `error: ${e.message}`);
        if (snaps) clearInterval(snaps);
        fs.writeFileSync(path.join(process.env.AVPP_SCREENSHOT, 'eval-result.txt'), String(out));
      }
      for (const page of (process.env.AVPP_PAGES || 'dashboard,newproject,episodes,autosave').split(',')) {
        if (page === 'shutdown-test') {
          // Countdown banner + Cancel button. The app quits seconds later, so even
          // a failed cancel can never shut the PC down.
          scheduleShutdown('test');
          await new Promise((r) => setTimeout(r, 2500));
          fs.writeFileSync(path.join(process.env.AVPP_SCREENSHOT, 'shutdown-banner.png'), (await win.webContents.capturePage()).toPNG());
          await win.webContents.executeJavaScript("document.getElementById('shutdown-cancel').click()");
          await new Promise((r) => setTimeout(r, 1500));
          fs.writeFileSync(path.join(process.env.AVPP_SCREENSHOT, 'shutdown-result.txt'), `shutdownAt after cancel: ${shutdownAt}`);
          continue;
        }
        const ok = await win.webContents.executeJavaScript(`(() => { const b = document.querySelector('[data-page="${page}"]'); if (b) b.click(); return Boolean(b); })()`);
        if (!ok) { log('warn', `screenshot: no page ${page}`); continue; }
        await new Promise((r) => setTimeout(r, 2500));
        fs.writeFileSync(path.join(process.env.AVPP_SCREENSHOT, `${page}.png`), (await win.webContents.capturePage()).toPNG());
      }
      quitting = true;
      app.quit();
    }, 3000);
  }
});
