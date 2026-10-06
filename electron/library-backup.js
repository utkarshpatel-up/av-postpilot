const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const crypto = require('crypto');

const DEFAULTS = { mode: 'monitor', pgBin: '', host: 'localhost', port: 5432, user: 'postgres', root: '', copyRoot: '', times: '11:00,14:00,17:00,20:00,23:00', keepDays: 30, keepMin: 10, staleHours: 24 };
const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return fallback; } };
function writeJson(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2)); fs.renameSync(tmp, file);
}
function times(value) {
  const result = [...new Set(String(value).split(/[,\s]+/).filter(Boolean))].sort();
  if (!result.length || result.some(t => !/^([01]\d|2[0-3]):[0-5]\d$/.test(t))) throw new Error('Schedule: use HH:MM times separated by commas');
  return result;
}
function validate(s, platform = process.platform) {
  if (!s.root || !path.isAbsolute(s.root) || !fs.existsSync(s.root) || !fs.statSync(s.root).isDirectory()) throw new Error('Choose an existing absolute backup folder');
  if (!s.pgBin || !path.isAbsolute(s.pgBin)) throw new Error('Choose an absolute PostgreSQL bin folder');
  if (s.mode !== 'server') throw new Error('Switch to server mode to run backups');
  if (s.copyRoot && !path.isAbsolute(s.copyRoot)) throw new Error('Choose an absolute secondary backup folder');
  if (s.copyRoot && path.resolve(s.copyRoot).toLowerCase() === path.resolve(s.root).toLowerCase()) throw new Error('Local and secondary folders must be different');
  if (!s.host || /[\r\n]/.test(s.host) || !s.user || /[\r\n]/.test(s.user)) throw new Error('Enter the PostgreSQL host and user');
  if (!Number.isInteger(Number(s.port)) || Number(s.port) < 1 || Number(s.port) > 65535) throw new Error('Invalid PostgreSQL port');
  for (const key of ['keepDays', 'keepMin', 'staleHours']) if (!Number.isInteger(Number(s[key])) || Number(s[key]) < 1) throw new Error(`${key} must be a positive whole number`);
  for (const name of ['psql', 'pg_dump', 'pg_restore', 'pg_dumpall']) {
    if (!fs.existsSync(path.join(s.pgBin, name + (platform === 'win32' ? '.exe' : '')))) throw new Error(`PostgreSQL tool not found: ${name}. Choose its bin folder.`);
  }
  times(s.times);
}
function runTool(exe, args, env) {
  return new Promise((resolve, reject) => execFile(exe, args, { env, windowsHide: true, timeout: 2 * 60 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
    if (err) {
      // Do not include the command line or raw process environment in logs.
      let message = String(stderr || err.code || 'PostgreSQL tool failed').trim().slice(0, 1500);
      if (env.PGPASSWORD) message = message.split(env.PGPASSWORD).join('[redacted]');
      reject(new Error(message));
    } else resolve(String(stdout).trim());
  }));
}
function ownedRoot(s) { return path.join(s.root, 'AV-PostPilot-Libraries'); }
function copyFile(source, directory) {
  fs.mkdirSync(directory, { recursive: true });
  const dest = path.join(directory, path.basename(source));
  const part = `${dest}.${process.pid}.part`;
  try {
    fs.copyFileSync(source, part);
    if (fs.statSync(part).size !== fs.statSync(source).size) throw new Error('Incomplete backup copy');
    fs.renameSync(part, dest);
  } finally { if (fs.existsSync(part)) fs.unlinkSync(part); }
  return dest;
}
function prune(dir, s) {
  // Only this engine's timestamped files, in its dedicated namespace, are eligible.
  const files = fs.readdirSync(dir).filter(f => /^pp-\d{8}-\d{6}-[a-f0-9]{8}\.(dump|sql)$/.test(f))
    .map(f => ({ file: path.join(dir, f), time: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.time - a.time);
  for (const f of files.slice(Number(s.keepMin))) if (f.time < Date.now() - Number(s.keepDays) * 86400000) fs.unlinkSync(f.file);
}

class LibraryBackup {
  constructor({ getSettings, getPassword, notify = async () => {}, onChange = () => {}, log = () => {}, tool = runTool, platform = process.platform }) {
    Object.assign(this, { getSettings, getPassword, notify, onChange, log, tool, platform });
    this.running = false;
  }
  async command(s, program, args) {
    const env = { ...process.env, PGCONNECT_TIMEOUT: '15', PGPASSWORD: this.getPassword() || '' };
    return this.tool(path.join(s.pgBin, program + (this.platform === 'win32' ? '.exe' : '')), args, env);
  }
  async query(s, db, sql) {
    return this.command(s, 'psql', ['-h', s.host, '-p', String(s.port), '-U', s.user, '-w', '-X', '-A', '-t', '--set', 'ON_ERROR_STOP=1', '-d', db, '-c', sql]);
  }
  async discover(s) {
    const dbs = JSON.parse(await this.query(s, 'postgres', "SELECT COALESCE(json_agg(datname ORDER BY datname), '[]'::json) FROM pg_database WHERE NOT datistemplate AND datname <> 'postgres'"));
    const found = [];
    for (const name of dbs) {
      // Conventional Resolve library names; prevents libpq connection-string interpretation.
      if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error(`Unsupported database name: ${name}. Use letters, digits, - and _.`);
      if (await this.query(s, name, `SELECT to_regclass('public."SM_Project"') IS NOT NULL`) !== 't') continue;
      const count = Number(await this.query(s, name, 'SELECT count(*) FROM "SM_Project"'));
      if (!Number.isSafeInteger(count) || count < 0) throw new Error(`Invalid project count for ${name}`);
      found.push({ name, count });
    }
    return found;
  }
  async check() { const s = { ...DEFAULTS, ...this.getSettings() }; validate(s, this.platform); return this.discover(s); }
  async run() {
    if (this.running) return { ok: false, error: 'A database backup is already running' };
    const s = { ...DEFAULTS, ...this.getSettings() };
    validate(s, this.platform);
    const root = ownedRoot(s);
    fs.mkdirSync(root, { recursive: true });
    const file = path.join(root, 'status.json');
    const state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { libraries: [], lastSuccess: null };
    if (!Array.isArray(state.libraries)) throw new Error('Invalid backup status; preserve it and repair before running');
    const identity = `${s.host}:${s.port}`;
    if (state.server && state.server !== identity) throw new Error('This folder belongs to another PostgreSQL server. Choose a different backup folder.');
    state.server = identity;
    const lock = path.join(root, 'backup.lock');
    try { fs.mkdirSync(lock); } catch (err) {
      if (err.code === 'EEXIST') return { ok: false, error: 'Backup lock exists. Another process may be running. Remove the lock folder only after confirming no backup is active.' };
      throw err;
    }
    try { fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, started: Date.now() })); }
    catch (err) { fs.rmdirSync(lock); throw err; }
    this.running = true; this.onChange();
    const previousSuccess = state.lastSuccess;
    state.lastAttempt = Date.now(); state.errors = []; state.warnings = [];
    const emit = (level, message) => {
      this.log(level, message);
      fs.appendFileSync(path.join(root, 'backup.log'), `${new Date().toISOString()} ${level.toUpperCase()} ${message}\n`);
    };
    const suffix = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    const stamp = `pp-${suffix}-${crypto.randomBytes(4).toString('hex')}`;
    const secondary = s.copyRoot && fs.existsSync(s.copyRoot) ? path.join(s.copyRoot, 'AV-PostPilot-Libraries') : null;
    const protect = async (previous, reason) => {
      const warning = `${previous.name}: ${reason}`;
      state.warnings.push(warning); emit('warn', warning);
      if (previous.file && fs.existsSync(previous.file)) {
        copyFile(previous.file, path.join(root, 'PROTECTED', previous.name));
        if (secondary) {
          try { copyFile(previous.file, path.join(secondary, 'PROTECTED', previous.name)); }
          catch (err) { state.errors.push(`Protected secondary copy: ${err.message}`); }
        }
      } else state.errors.push(`${previous.name}: previous dump unavailable; could not protect it`);
      await this.notify('libraryAlert', `⚠️ Library backup alert: ${warning}\nCheck PROTECTED and the backup log.`);
    };
    try {
      emit('info', 'Starting library backup');
      if (s.copyRoot && !secondary) state.errors.push('Secondary backup root is unavailable; local backups will continue');
      const libraries = await this.discover(s); // Discovery failure must never be treated as a missing library.
      for (const previous of state.libraries) {
        const current = libraries.find(l => l.name === previous.name);
        if (!current && !previous.missing) { await protect(previous, 'library is missing from the server'); previous.missing = true; }
        if (current && current.count < previous.count) await protect(previous, `project count dropped ${previous.count} → ${current.count}`);
      }
      if (!libraries.length) throw new Error('No Resolve project libraries found');
      const globals = path.join(root, '_globals'); fs.mkdirSync(globals, { recursive: true });
      const globalFile = path.join(globals, `${stamp}.sql`);
      try {
        await this.command(s, 'pg_dumpall', ['-h', s.host, '-p', String(s.port), '-U', s.user, '-w', '--globals-only', '-f', `${globalFile}.part`]);
        fs.renameSync(`${globalFile}.part`, globalFile);
        if (secondary) copyFile(globalFile, path.join(secondary, '_globals'));
        prune(globals, s);
      } catch (err) { state.errors.push(`Roles/users backup: ${err.message}`); }
      finally { if (fs.existsSync(`${globalFile}.part`)) fs.unlinkSync(`${globalFile}.part`); }
      for (const library of libraries) {
        const dir = path.join(root, library.name); fs.mkdirSync(dir, { recursive: true });
        const out = path.join(dir, `${stamp}.dump`);
        try {
          await this.command(s, 'pg_dump', ['-h', s.host, '-p', String(s.port), '-U', s.user, '-w', '-Fc', '-f', `${out}.part`, '-d', library.name]);
          if (!fs.existsSync(`${out}.part`) || !fs.statSync(`${out}.part`).size) throw new Error('No dump written');
          await this.command(s, 'pg_restore', ['--list', `${out}.part`]);
          fs.renameSync(`${out}.part`, out);
          const item = { ...library, file: out, lastSuccess: Date.now(), missing: false, bytes: fs.statSync(out).size };
          const i = state.libraries.findIndex(l => l.name === library.name);
          if (i >= 0) state.libraries[i] = item; else state.libraries.push(item);
          if (secondary) { const copyDir = path.join(secondary, library.name); copyFile(out, copyDir); prune(copyDir, s); }
          prune(dir, s);
          emit('info', `Backed up ${library.name}: ${library.count} projects, ${item.bytes} bytes`);
        } catch (err) { state.errors.push(`${library.name}: ${err.message}`); }
        finally { if (fs.existsSync(`${out}.part`)) fs.unlinkSync(`${out}.part`); }
        writeJson(file, state); this.onChange();
      }
      if (!state.errors.length) state.lastSuccess = Date.now();
    } catch (err) { state.errors.push(err.message); }
    finally {
      state.lastFinished = Date.now();
      try {
        try {
          for (const error of state.errors) emit('error', error);
          writeJson(file, state);
          if (secondary) { copyFile(file, secondary); copyFile(path.join(root, 'backup.log'), secondary); }
        } catch (err) { state.errors.push(`Status/copy failed: ${err.message}`); state.lastSuccess = previousSuccess; try { writeJson(file, state); } catch {} }
        await this.notify(state.errors.length ? 'libraryBackupFailed' : 'libraryBackupDone', `${state.errors.length ? '⚠️ Library backup finished with errors' : '✅ Library backup finished'}\n${state.errors.join('\n') || `${state.libraries.filter(l => !l.missing).length} libraries backed up`}`);
      } finally {
        this.running = false; this.onChange();
        fs.unlinkSync(path.join(lock, 'owner.json')); fs.rmdirSync(lock);
      }
    }
    return { ok: !state.errors.length, ...state };
  }
}

function monitor(s) {
  if (!s.root || !fs.existsSync(s.root)) return { ok: false, error: 'Backup folder is not reachable', libraries: [], log: '' };
  const root = fs.existsSync(path.join(s.root, 'AV-PostPilot-Libraries')) ? ownedRoot(s) : s.root;
  const state = readJson(path.join(root, 'status.json'), null);
  const dbRoot = fs.existsSync(path.join(root, 'db')) ? path.join(root, 'db') : root;
  const libraries = [];
  for (const entry of fs.readdirSync(dbRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('_') || ['PROTECTED', 'state', 'scripts', 'backup.lock'].includes(entry.name)) continue;
    const dir = path.join(dbRoot, entry.name);
    const dumps = fs.readdirSync(dir).filter(f => f.endsWith('.dump')).map(f => ({ file: path.join(dir, f), ...fs.statSync(path.join(dir, f)) })).sort((a, b) => b.mtimeMs - a.mtimeMs);
    if (!dumps.length) continue;
    const saved = state?.libraries?.find(l => l.name === entry.name);
    const countFile = path.join(root, 'state', `${entry.name}.count`);
    const count = saved?.count ?? (fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, 'utf8').trim()) : null);
    libraries.push({ name: entry.name, count, file: dumps[0].file, bytes: dumps[0].size, time: dumps[0].mtimeMs, stale: Date.now() - dumps[0].mtimeMs > (Number(s.staleHours) || 24) * 3600000 });
  }
  const protectedFiles = [];
  for (const folder of ['PROTECTED', '_PROTECTED']) {
    const dir = path.join(root, folder);
    if (fs.existsSync(dir)) for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const item = path.join(dir, entry.name);
      if (entry.isFile() && entry.name.endsWith('.dump')) protectedFiles.push(item);
      if (entry.isDirectory()) protectedFiles.push(...fs.readdirSync(item).filter(f => f.endsWith('.dump')).map(f => path.join(item, f)));
    }
  }
  let log = '';
  const logFile = path.join(root, 'backup.log');
  if (fs.existsSync(logFile)) {
    const fd = fs.openSync(logFile, 'r');
    try { const size = fs.fstatSync(fd).size; const buf = Buffer.alloc(Math.min(size, 32000)); fs.readSync(fd, buf, 0, buf.length, Math.max(0, size - buf.length)); log = buf.toString('utf8').split('\n').slice(-80).join('\n'); } finally { fs.closeSync(fd); }
  }
  return { ok: true, root, libraries, protectedFiles, log, state, locked: fs.existsSync(path.join(root, 'backup.lock')) || fs.existsSync(path.join(root, 'state', 'lock')) };
}

function windowsSchedule(s, exe, data, unattended = false) {
  times(s.times);
  const quote = v => `'${String(v).replace(/'/g, "''")}'`;
  if ([exe, data].some(v => /["\r\n]/.test(v))) throw new Error('Unsupported executable/settings path');
  const name = `AVPostPilot-LibraryBackup-${crypto.createHash('sha256').update(data).digest('hex').slice(0, 8)}`;
  const args = `--library-backup-run --backup-user-data="${data}"`;
  return `$ErrorActionPreference = 'Stop'\n# Run on the PostgreSQL server as the Windows user who configured PostPilot.\n$action = New-ScheduledTaskAction -Execute ${quote(exe)} -Argument ${quote(args)}\n$triggers = @(${times(s.times).map(t => `(New-ScheduledTaskTrigger -Daily -At ${quote(t)})`).join(', ')})\n$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 12)\n${unattended ? `$credential = Get-Credential -UserName "$env:USERDOMAIN\\$env:USERNAME" -Message 'Use the same Windows account that saved PostPilot credentials'\nif ($credential.UserName -ne "$env:USERDOMAIN\\$env:USERNAME") { throw 'Use the current Windows account' }\nRegister-ScheduledTask -TaskName ${quote(name)} -Action $action -Trigger $triggers -Settings $settings -User $credential.UserName -Password $credential.GetNetworkCredential().Password -Force\n` : `$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\\$env:USERNAME" -LogonType Interactive -RunLevel Limited\nRegister-ScheduledTask -TaskName ${quote(name)} -Action $action -Trigger $triggers -Settings $settings -Principal $principal -Force\n`}Write-Host 'Backup schedule installed. Keep this app folder at the same path. Test the task in Task Scheduler.'\n`;
}
function macSchedule(s, exe, data) {
  const xml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
  const label = `com.avpostpilot.library-backup.${crypto.createHash('sha256').update(data).digest('hex').slice(0, 8)}`;
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${xml(exe)}</string><string>--library-backup-run</string><string>${xml(`--backup-user-data=${data}`)}</string></array>
<key>StartCalendarInterval</key><array>${times(s.times).map(t => { const [hour, minute] = t.split(':').map(Number); return `<dict><key>Hour</key><integer>${hour}</integer><key>Minute</key><integer>${minute}</integer></dict>`; }).join('')}</array>
<key>StandardOutPath</key><string>${xml(path.join(data, 'library-task-output.log'))}</string>
<key>StandardErrorPath</key><string>${xml(path.join(data, 'library-task-error.log'))}</string>
</dict></plist>
`;
  const installer = `#!/bin/bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$HOME/Library/LaunchAgents"
DEST="$HOME/Library/LaunchAgents/${label}.plist"
cp "$HERE/${label}.plist" "$DEST"
chmod 600 "$DEST"
launchctl bootout "gui/$(id -u)/${label}" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$DEST"
launchctl enable "gui/$(id -u)/${label}"
echo 'PostPilot library backup schedule installed. Keep this Mac user logged in and the app at the same path.'
`;
  return { label, plist, installer };
}
module.exports = { DEFAULTS, LibraryBackup, monitor, validate, times, prune, windowsSchedule, macSchedule, ownedRoot };
