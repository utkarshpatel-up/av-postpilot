// FFmpeg for every page. One copy ships with PostPilot, next to HandBrakeCLI:
// resources/ffmpeg in the installed app, vendor/ffmpeg/<target> when run from source
// (npm run fetch-ffmpeg puts it there). The audio engines (Feedback Cutter, Quiet Lift)
// get it on their PATH, so they use the same copy instead of carrying their own.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const exeName = (platform = process.platform) => (platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');

// vendor/ffmpeg/<win | mac-arm64 | mac-x64 | linux-x64 | linux-arm64>: one build per architecture.
function vendorTarget(platform = process.platform, arch = process.arch) {
  if (platform === 'win32') return 'win';
  if (platform === 'darwin') return `mac-${arch}`;
  if (platform === 'linux') return `linux-${arch}`;
  return '';
}

// The FFmpeg that comes with PostPilot, or null when this copy has none (not fetched).
function bundledFfmpeg(resourcesPath = process.resourcesPath, root = ROOT, platform = process.platform, arch = process.arch) {
  const target = vendorTarget(platform, arch);
  const dirs = [resourcesPath && path.join(resourcesPath, 'ffmpeg'), target && path.join(root, 'vendor', 'ffmpeg', target)];
  return dirs.filter(Boolean).map((d) => path.join(d, exeName(platform))).find((p) => fs.existsSync(p)) || null;
}

// A chosen path, else the built-in copy, else one installed on this computer.
// Launched from the macOS dock the app gets a minimal PATH without Homebrew, so those folders are tried too.
function findFfmpeg(chosen = '', env = process.env) {
  if (chosen && fs.existsSync(chosen)) return chosen;
  const builtIn = bundledFfmpeg();
  if (builtIn) return builtIn;
  const dirs = [...(env.PATH || env.Path || '').split(path.delimiter), ...(process.platform === 'win32' ? [] : ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'])];
  return dirs.filter(Boolean).map((d) => path.join(d, exeName())).find((p) => fs.existsSync(p)) || null;
}

// Environment for a program that looks for "ffmpeg" on PATH (the audio engines): the built-in
// copy's folder goes first. On Windows the variable is usually "Path"; that same key is changed,
// never a second one added (which one the child would see is undefined).
function withFfmpegOnPath(env = process.env, ffmpeg = bundledFfmpeg()) {
  if (!ffmpeg) return { ...env };
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  const rest = env[key] ? `${path.delimiter}${env[key]}` : '';
  return { ...env, [key]: `${path.dirname(ffmpeg)}${rest}` };
}

// Version, encoders and filters of an FFmpeg, asked once per path.
const infoCache = new Map();
function ffmpegInfo(ffmpeg) {
  if (infoCache.has(ffmpeg)) return infoCache.get(ffmpeg);
  const run = (args) => execFileSync(ffmpeg, ['-hide_banner', ...args], { encoding: 'utf8', windowsHide: true, timeout: 20000, maxBuffer: 8 << 20 });
  const names = (text) => new Set([...text.matchAll(/^ [A-Z.]{3,6} +(\w+)/gm)].map((m) => m[1]));
  const version = (run(['-version']).match(/ffmpeg version (\S+)/) || [])[1] || '';
  const info = { version, encoders: names(run(['-encoders'])), filters: names(run(['-filters'])) };
  infoCache.set(ffmpeg, info);
  return info;
}

module.exports = { bundledFfmpeg, findFfmpeg, withFfmpegOnPath, ffmpegInfo, vendorTarget, exeName };
