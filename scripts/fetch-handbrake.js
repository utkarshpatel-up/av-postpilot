// Puts the official HandBrakeCLI into vendor/handbrake/<win|mac>/, which the build packs into the app
// (resources/handbrake), so PostPilot never needs HandBrake installed separately.
//   node scripts/fetch-handbrake.js [win|mac] [--zip path-to-already-downloaded-file]
// The version and SHA-256 of each download are pinned in package.json (handbrakeCli).
// Windows stays on 1.9.2 (a per-file "version"): 1.10+ needs NVIDIA driver 570+ for NVENC, 1.9.2 needs 551.76+.
// Runs before npm start / dist:* and does nothing when the right version is already there.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const { handbrakeCli: pin } = require('../package.json');
const args = process.argv.slice(2);
const target = args.find((a) => a === 'win' || a === 'mac') || (process.platform === 'darwin' ? 'mac' : 'win');
const zipArg = args.includes('--zip') ? args[args.indexOf('--zip') + 1] : process.env.HANDBRAKE_DOWNLOAD;
const file = pin.files[target];
const version = file.version || pin.version;
const dest = path.join(ROOT, 'vendor', 'handbrake', target);
const exe = path.join(dest, target === 'win' ? 'HandBrakeCLI.exe' : 'HandBrakeCLI');
const stamp = path.join(dest, 'VERSION');

const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

async function download() {
  const cache = path.join(ROOT, 'vendor', 'handbrake', 'downloads', file.name);
  for (const p of [zipArg, cache]) if (p && fs.existsSync(p) && sha256(p) === file.sha256) return p;
  if (zipArg) throw new Error(`${zipArg} is not ${file.name} (SHA-256 differs)`);
  const src = `https://github.com/HandBrake/HandBrake/releases/download/${version}/${file.name}`;
  console.log(`Downloading ${src}`);
  const res = await fetch(src);
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  fs.mkdirSync(path.dirname(cache), { recursive: true });
  fs.writeFileSync(`${cache}.part`, Buffer.from(await res.arrayBuffer()));
  if (sha256(`${cache}.part`) !== file.sha256) { fs.rmSync(`${cache}.part`); throw new Error(`${file.name}: SHA-256 does not match the pinned one`); }
  fs.renameSync(`${cache}.part`, cache);
  return cache;
}

function extractWin(zip, tmp) {
  // bsdtar reads zips: Windows 10+ has it in System32 (a GNU tar earlier on PATH, e.g. Git's, can't)
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  execFileSync(tar, ['-xf', zip, '-C', tmp]);
  return { cli: path.join(tmp, 'HandBrakeCLI.exe'), docs: path.join(tmp, 'doc') };
}

function extractMac(dmg, tmp) {
  if (process.platform !== 'darwin') throw new Error('The Mac HandBrakeCLI can only be unpacked on a Mac');
  const mount = path.join(tmp, 'mnt');
  fs.mkdirSync(mount);
  execFileSync('hdiutil', ['attach', dmg, '-nobrowse', '-readonly', '-mountpoint', mount]);
  try {
    const out = path.join(tmp, 'HandBrakeCLI');
    fs.copyFileSync(path.join(mount, 'HandBrakeCLI'), out);
    fs.chmodSync(out, 0o755);
    const docs = path.join(tmp, 'doc');
    fs.mkdirSync(docs);
    for (const f of fs.readdirSync(mount)) if (/^(COPYING|LICENSE)/i.test(f)) fs.copyFileSync(path.join(mount, f), path.join(docs, f));
    return { cli: out, docs };
  } finally {
    execFileSync('hdiutil', ['detach', mount, '-quiet']);
  }
}

(async () => {
  if (fs.existsSync(exe) && fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8').trim() === version) {
    console.log(`HandBrakeCLI ${version} (${target}) is already in ${path.relative(ROOT, dest)}`);
    return;
  }
  const src = await download();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hbcli-'));
  try {
    const { cli, docs } = target === 'win' ? extractWin(src, tmp) : extractMac(src, tmp);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(dest, { recursive: true });
    fs.copyFileSync(cli, exe);
    if (target === 'mac') fs.chmodSync(exe, 0o755);
    // HandBrake is GPL-2.0: its licence travels with the binary
    if (fs.existsSync(docs)) for (const f of fs.readdirSync(docs)) if (/^(COPYING|LICENSE)/i.test(f)) fs.copyFileSync(path.join(docs, f), path.join(dest, `HandBrake-${f}`));
    fs.writeFileSync(stamp, `${version}\n`);
    console.log(`HandBrakeCLI ${version} (${target}) → ${path.relative(ROOT, dest)}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch((err) => { console.error(`fetch-handbrake: ${err.message}`); process.exit(1); });
