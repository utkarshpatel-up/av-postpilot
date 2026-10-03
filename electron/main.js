const { app, BrowserWindow, Tray, Menu, ipcMain, dialog, shell, nativeImage, safeStorage, Notification } = require('electron');
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ResolveBridge } = require('./resolve-bridge');
const { AutoSaver } = require('./autosave');
const ps = require('./project-setup');
const ep = require('./episodes');
const { Notifier, telegram, whapi } = require('./notify');
const { RenderWatcher, copyVerified } = require('./renders');
const { collectHdFiles } = require('./hdreview');
const { SceneQueue } = require('./scenequeue');
const { Encoder } = require('./encoder');
const seriesList = require('./series-list');

// Developer checks can run beside a normal copy with their own settings folder.
if (process.env.AVPP_USERDATA) app.setPath('userData', process.env.AVPP_USERDATA);
if (!app.requestSingleInstanceLock()) { app.quit(); return; }

const DATA = app.getPath('userData');
const SETTINGS_FILE = path.join(DATA, 'settings.json');
const STATE_FILE = path.join(DATA, 'state.json');
const LOG_FILE = path.join(DATA, 'postpilot.log');
const RESOLVE_PREFS = path.join(process.env.APPDATA || '', 'Blackmagic Design', 'DaVinci Resolve', 'Preferences', 'config.dat');

const DEFAULTS = {
  resolvePath: 'C:\\Program Files\\Blackmagic Design\\DaVinci Resolve\\Resolve.exe',
  launchResolve: true,
  startHidden: false,
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
  notify: {
    telegram: { enabled: false, chats: [] },
    whapi: { enabled: false, chats: [] },
    events: {
      renderDone: true, renderFailed: true, renderCopied: false, queueDone: true,
      sceneDone: true, sceneQueueDone: true, encoderGroupDone: true, encoderQueueDone: true, shutdown: true, autosaveFailed: true, projectCreated: false,
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
    manual: { ...DEFAULTS.manual, ...(s.shutdownSeconds ? { shutdownSeconds: s.shutdownSeconds } : {}), ...(s.manual || {}) },
    renders: { ...DEFAULTS.renders, ...(s.shutdownSeconds ? { shutdownSeconds: s.shutdownSeconds } : {}), ...(s.renders || {}), hd: { ...DEFAULTS.renders.hd, ...(s.renders?.hd || {}) } },
    // older versions had one shared countdown
    scene: { ...DEFAULTS.scene, ...(s.shutdownSeconds ? { shutdownSeconds: s.shutdownSeconds } : {}), ...(s.scene || {}) },
    notify: {
      telegram: { ...DEFAULTS.notify.telegram, ...(s.notify?.telegram || {}) },
      whapi: { ...DEFAULTS.notify.whapi, ...(s.notify?.whapi || {}) },
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

const bridge = new ResolveBridge({
  getFuscriptPath: () => path.join(path.dirname(settings.resolvePath), 'fuscript.exe'),
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
  renders.update(status);
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

// Shut down with a countdown the user can cancel from the app or the tray.
let shutdownAt = null;
let shutdownReason = '';
let shutdownTimer = null;
const countdown = (v) => Math.min(24 * 3600, Math.max(10, Number(v) || 60));
const mmss = (s) => (s >= 60 ? `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ''}` : `${s} s`);
function scheduleShutdown(reason, seconds = countdown(settings.renders.shutdownSeconds)) {
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
  const group = { 'scene cut queue': 'scene', 'encoder queue': 'encoder' }[what] || 'renders';
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
  bridge, notifier, log, getSettings: () => settings,
  loadState: () => state.encoder,
  saveState: (e) => { state.encoder = e; writeJson(STATE_FILE, state); },
  onChange: () => { send('encoder', encoder.summary()); updateTray(); },
  onQueueDone: afterQueue,
});

const sceneQueue = new SceneQueue({
  bridge, notifier, log, getSettings: () => settings,
  onChange: () => { send('scene', sceneQueue.summary()); updateTray(); },
  onQueueDone: afterQueue,
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

function updateTray() {
  if (!tray) return;
  const a = settings.autosave;
  const proj = status.project ? status.project.name : 'no project';
  tray.setToolTip(`AV PostPilot\n${status.connected ? `Resolve: ${proj}` : 'Resolve not connected'}\nAuto-save ${a.enabled ? 'on' : 'off'}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open AV PostPilot', click: showWindow },
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
  settings = mergeSettings(next);
  writeJson(SETTINGS_FILE, settings);
  if (before.enabled !== settings.autosave.enabled || before.intervalMin !== settings.autosave.intervalMin) {
    autosaver.schedule();
  }
  send('settings', settings);
  updateTray();
  return settings;
}

// ------------------------------------------------------------------ IPC
ipcMain.handle('get-initial', () => ({
  settings, status, autosave: autosaver.summary(), log: logLines,
  scene: sceneQueue.summary(), encoder: encoder.summary(), renders: renders.summary(), shutdownAt, shutdownReason,
  pc: os.hostname(), version: app.getVersion(),
}));
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
ipcMain.handle('has-secrets', () => ({ telegram: Boolean(getSecret('telegram')), whapi: Boolean(getSecret('whapi')) }));
ipcMain.handle('set-secret', (_e, { kind, value }) => { setSecret(kind, String(value || '').trim()); return true; });
ipcMain.handle('find-chats', async (_e, kind) => {
  const token = getSecret(kind);
  if (!token) return { ok: false, error: 'Save the token first' };
  try {
    return { ok: true, chats: kind === 'telegram' ? await telegram.findChats(token) : await whapi.findGroups(token) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.handle('send-test', async () => {
  const n = await notifier.sendAll(`👋 Test message from AV PostPilot on ${os.hostname()}`);
  return n ? { ok: true, sent: n } : { ok: false, error: 'Nothing was sent. Check that a service is switched on, has a token and at least one chat, and see Activity for errors.' };
});

// ------------------------------------------------------------------ scene cuts + shutdown
ipcMain.handle('scene-add', (_e, names) => {
  try { sceneQueue.add(status.project?.name, names); return { ok: true }; } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('scene-remove', (_e, i) => sceneQueue.remove(i));
ipcMain.handle('scene-clear', () => sceneQueue.clearFinished());
ipcMain.handle('scene-start', () => {
  if (!status.connected) return { ok: false, error: 'Resolve is not connected' };
  // Answer straight away: the queue itself can run for hours.
  const run = sceneQueue.start(status.project?.name);
  return Promise.race([run, new Promise((r) => setTimeout(() => r({ ok: true, started: true }), 500))]);
});
ipcMain.handle('scene-stop', () => sceneQueue.stop());
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
  try {
    if (action === 'start') {
      if (!status.connected || !status.project) return { ok: false, error: 'Open a project in Resolve first (temporary items are made there and removed afterwards)' };
      // Answer straight away: the queue can run for hours.
      return Promise.race([encoder.start(), new Promise((r) => setTimeout(() => r({ ok: true, started: true }), 800))]);
    }
    const fn = ENC_ACTIONS[action];
    if (!fn) return { ok: false, error: `unknown action ${action}` };
    return { ok: true, result: await fn(args || {}) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
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
  if (!status.connected || !status.project) return { ok: false, error: 'Open a project in Resolve first' };
  return bridge.renderPresets();
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
app.on('before-quit', () => { quitting = true; bridge.stop(); });
app.on('window-all-closed', (e) => e.preventDefault());

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  tray = new Tray(nativeImage.createFromPath(iconPath('tray.png')));
  tray.on('click', showWindow);
  createWindow(!settings.startHidden);
  log('info', `AV PostPilot ${app.getVersion()} started on ${os.hostname()}`);
  if (settings.launchResolve) await launchResolve();
  autosaver.schedule();
  await poll();
  setInterval(poll, 3000);

  // Developer check: AVPP_SCREENSHOT=<folder> saves a picture of every page.
  if (process.env.AVPP_SCREENSHOT) {
    setTimeout(async () => {
      if (process.env.AVPP_MAXIMIZE) { win.maximize(); await new Promise((r) => setTimeout(r, 800)); }
      // AVPP_EVAL_FILE: page code to run first (developer checks only)
      if (process.env.AVPP_EVAL_FILE) {
        const out = await win.webContents.executeJavaScript(fs.readFileSync(process.env.AVPP_EVAL_FILE, 'utf8')).catch((e) => `error: ${e.message}`);
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
