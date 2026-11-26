// Puts FFmpeg into vendor/ffmpeg/<target>/, which the build packs into the app (resources/ffmpeg) for
// every page to use (electron/ffmpeg.js), like HandBrakeCLI.
//   node scripts/fetch-ffmpeg.js [win | mac | mac-arm64 | mac-x64 | linux-x64 | linux-arm64 ...]
// No target: the one for this computer. "mac" is both Mac architectures (the Mac build makes both apps).
// The binaries are the ones the imageio-ffmpeg wheels on PyPI carry, unchanged; the audio engine used to
// bundle the same ones. Wheel URL and SHA-256 per target are pinned in package.json (ffmpeg).
// Runs before npm start / dist:* and does nothing when the pinned build is already there.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const { ffmpeg: pin } = require('../package.json');
const { vendorTarget } = require('../electron/ffmpeg');

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// The one file of a zip (a wheel) whose name matches, without an unzip tool: GNU tar can't read zips.
function unzipOne(zip, match) {
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--) if (zip.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a zip file');
  let p = zip.readUInt32LE(eocd + 16);
  for (let n = zip.readUInt16LE(eocd + 10); n > 0; n--) {
    if (zip.readUInt32LE(p) !== 0x02014b50) throw new Error('broken zip directory');
    const method = zip.readUInt16LE(p + 10), size = zip.readUInt32LE(p + 20), full = zip.readUInt32LE(p + 24);
    const nameLen = zip.readUInt16LE(p + 28), extra = zip.readUInt16LE(p + 30), comment = zip.readUInt16LE(p + 32);
    const local = zip.readUInt32LE(p + 42);
    const name = zip.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extra + comment;
    if (!match.test(name)) continue;
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const data = zip.subarray(start, start + size);
    const out = method === 0 ? Buffer.from(data) : method === 8 ? zlib.inflateRawSync(data) : null;
    if (!out) throw new Error(`${name}: unsupported zip compression ${method}`);
    if (out.length !== full) throw new Error(`${name}: unpacked size is wrong`);
    return { name, data: out };
  }
  throw new Error(`no file matching ${match} in the zip`);
}

async function fetchTarget(target) {
  const file = pin.files[target];
  if (!file) throw new Error(`No FFmpeg pinned for "${target}" (package.json ffmpeg.files)`);
  const dest = path.join(ROOT, 'vendor', 'ffmpeg', target);
  const exe = path.join(dest, target === 'win' ? 'ffmpeg.exe' : 'ffmpeg');
  const stamp = path.join(dest, 'VERSION');
  const want = `${file.version} ${file.sha256}`;
  if (fs.existsSync(exe) && fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8').trim() === want) {
    console.log(`FFmpeg ${file.version} (${target}) is already in ${path.relative(ROOT, dest)}`);
    return;
  }
  const cache = path.join(ROOT, 'vendor', 'ffmpeg', 'downloads', path.basename(new URL(file.url).pathname));
  let wheel = fs.existsSync(cache) ? fs.readFileSync(cache) : null;
  if (!wheel || sha256(wheel) !== file.sha256) {
    console.log(`Downloading ${file.url}`);
    const res = await fetch(file.url);
    if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
    wheel = Buffer.from(await res.arrayBuffer());
    if (sha256(wheel) !== file.sha256) throw new Error(`${path.basename(cache)}: SHA-256 does not match the pinned one`);
    fs.mkdirSync(path.dirname(cache), { recursive: true });
    fs.writeFileSync(cache, wheel);
  }
  const { name, data } = unzipOne(wheel, /^imageio_ffmpeg\/binaries\/ffmpeg-[^/]+$/);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(exe, data, { mode: 0o755 });
  // FFmpeg is GPL (these builds include x264/x265): say what it is and where its source is
  fs.writeFileSync(path.join(dest, 'FFmpeg-NOTICE.txt'), [
    `FFmpeg ${file.version} (https://ffmpeg.org), a build licensed under the GNU General Public License`,
    'because it includes GPL libraries such as x264 and x265. Source code: https://ffmpeg.org/download.html',
    `This binary is ${path.basename(name)} from ${path.basename(cache)} (imageio-ffmpeg on PyPI), unchanged.`,
    `Run "${path.basename(exe)} -version" for the exact build and its configuration.`, '',
  ].join('\n'));
  fs.writeFileSync(stamp, `${want}\n`);
  console.log(`FFmpeg ${file.version} (${target}) → ${path.relative(ROOT, dest)}`);
}

const args = process.argv.slice(2).flatMap((a) => (a === 'mac' ? ['mac-arm64', 'mac-x64'] : [a]));
const targets = args.length ? args : [vendorTarget()];
(async () => { for (const t of targets) await fetchTarget(t); })()
  .catch((err) => { console.error(`fetch-ffmpeg: ${err.message}`); process.exit(1); });
