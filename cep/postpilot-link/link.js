// AV PostPilot Link (panel side, hidden). PostPilot drops job files into a folder in the
// user's profile; this answers them through host/link.jsx. Only the commands listed are run.
const fs = require('fs'), path = require('path'), os = require('os'), url = require('url');
const LINK = process.platform === 'win32'
  ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'av-postpilot-link')
  : path.join(os.homedir(), 'Library', 'Application Support', 'av-postpilot-link');
const JOBS = path.join(LINK, 'jobs'), RESULTS = path.join(LINK, 'results');
const COMMANDS = new Set(['status', 'open', 'export', 'close']);
const VERSION = '1.0.4';
for (const d of [JOBS, RESULTS]) fs.mkdirSync(d, { recursive: true });

const evalScript = s => new Promise(resolve => window.__adobe_cep__.evalScript(s, resolve));
// host/link.jsx next to this page; reloaded whenever PostPilot installs a newer one.
const JSX = url.fileURLToPath(new URL('host/link.jsx', document.location.href));
let loaded = { mtime: 0, error: '' };
async function ensureLoaded() {
  let mtime = 0; try { mtime = fs.statSync(JSX).mtimeMs; } catch (e) { loaded.error = `cannot read ${JSX}: ${e.message}`; return false; }
  if (mtime === loaded.mtime && await evalScript('typeof ppLink') === 'object') return true;
  const r = await evalScript(`(function(){try{$.evalFile(new File(${JSON.stringify(JSX.replace(/\\/g, '/'))}));return typeof ppLink;}catch(e){return 'line '+e.line+': '+e.message;}})()`);
  loaded = r === 'object' ? { mtime, error: '' } : { mtime: 0, error: r };
  return r === 'object';
}
async function run(cmd, args) {
  if (!COMMANDS.has(cmd)) return { ok: false, error: `Unknown command ${cmd}` };
  if (!await ensureLoaded()) return { ok: false, error: `Helper script not loaded: ${loaded.error}` };
  const raw = await evalScript(`ppLink.run(${JSON.stringify(cmd)}, ${JSON.stringify(args || {})})`);
  try { return JSON.parse(raw); } catch { return { ok: false, error: `Premiere answered: ${raw}` }; }
}
const writeJson = (file, data) => { fs.writeFileSync(file + '.tmp', JSON.stringify(data)); fs.renameSync(file + '.tmp', file); };

// Heartbeat on its own timer: it keeps going while Premiere works on a long job.
let job = null, last = {};
function beat() {
  try {
    writeJson(path.join(LINK, 'alive.json'), { at: Date.now(), pid: process.pid, helper: VERSION, jsx: JSX, jsxLoaded: loaded.mtime > 0, loadError: loaded.error,
      busy: job ? { cmd: job.cmd, since: job.since } : null, version: last.version || '', project: last.project || '', sequences: last.sequences || [], error: last.ok === false ? last.error : '', problems: last.problems || [] });
  } catch {}
}
setInterval(beat, 1000);

let running = false;
async function tick() {
  if (running) return; running = true;
  try {
    for (const f of fs.readdirSync(JOBS).filter(x => x.endsWith('.json')).sort()) {
      const file = path.join(JOBS, f); let j;
      try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { j = null; }
      try { fs.unlinkSync(file); } catch {}
      const id = j && String(j.id || '').replace(/[^\w-]/g, '');
      if (!id) continue;
      job = { cmd: j.cmd, since: Date.now() };
      const result = await run(j.cmd, j.args);
      job = null;
      writeJson(path.join(RESULTS, `${id}.json`), { ...result, id });
    }
    job = { cmd: 'status', since: Date.now() };
    last = await run('status');
  } catch (e) { last = { ok: false, error: String(e && e.message || e) }; }
  finally { job = null; running = false; }
}
setInterval(tick, 1500);
beat(); tick();
