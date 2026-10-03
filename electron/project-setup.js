// New-project helpers: scan satsang day folders, work out sessions/timelines,
// create the house folder structure and move the footage into it.
const fs = require('fs');
const path = require('path');

const PROJECT_FOLDERS = ['Audio', 'Resolve Export', 'Satsang Files', 'Scratch Disk'];   // default template
const BINS = ['Satsang Files', 'Sequence', 'Audio', 'Episode', 'Reviewed Episode'];
const VIDEO_EXT = new Set(['.mov', '.mp4', '.mxf', '.mts', '.m2ts', '.avi', '.mkv', '.braw', '.r3d', '.crm']);
const MEDIA_EXT = new Set([...VIDEO_EXT, '.wav', '.mp3', '.aac', '.m4a', '.aif', '.aiff', '.png', '.jpg', '.jpeg', '.tif', '.tiff', '.psd']);
const IGNORE = /^(\.|thumbs\.db$|desktop\.ini$)/i;
const INSERT_FOLDER = /^clips for insert$/i;

const natural = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

function listDir(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => !IGNORE.test(e.name));
}

// "2978 Dt-03 Jun 2026" -> "2978"
function dayNumber(dayName) {
  const m = /^\s*(\d+)/.exec(dayName);
  return m ? m[1] : dayName.trim();
}

// Session code = the short word just before "Dt-":
//   "...Aptavani E. Dt-03-Jun-26..."  -> "E"
//   "01 ...Topic E1 Dt-05-Jun-26..."  -> "E1"
//   "02 ...Session E2. Dt-06-Jun-26"  -> "E2"
function sessionCode(folderName) {
  const re = /(?:^|[\s,])([A-Za-z]\d?)\.?\s+Dt-/g;
  let m, last = null;
  while ((m = re.exec(folderName))) last = m[1];
  return last ? last.toUpperCase() : null;
}

function clipNumber(file) {
  const m = /clip[\s_-]*0*(\d+)/i.exec(path.parse(file).name);
  return m ? Number(m[1]) : null;
}

// Video clips of a session (not recursive, so "Clips for Insert" stays out),
// ordered by their Clip-NN number.
function sessionClips(dir) {
  return listDir(dir)
    .filter((e) => e.isFile() && VIDEO_EXT.has(path.extname(e.name).toLowerCase()))
    .map((e) => e.name)
    .sort((a, b) => {
      const na = clipNumber(a), nb = clipNumber(b);
      if (na !== null && nb !== null && na !== nb) return na - nb;
      return natural(a, b);
    })
    .map((n) => path.join(dir, n));
}

// Scan one day folder -> { name, number, sessions: [{ folder, code, suffix, clips, master, edit }] }
function scanDay(dayDir) {
  const name = path.basename(dayDir);
  const number = dayNumber(name);
  const subdirs = listDir(dayDir).filter((e) => e.isDirectory() && !INSERT_FOLDER.test(e.name)).map((e) => e.name).sort(natural);
  let sessions = subdirs
    .map((d) => ({ folder: path.join(dayDir, d), code: sessionCode(d) }))
    .map((s) => ({ ...s, clips: sessionClips(s.folder) }))
    .filter((s) => s.clips.length);
  if (!sessions.length) {
    const clips = sessionClips(dayDir);                 // clips directly in the day folder
    if (clips.length) sessions = [{ folder: dayDir, code: sessionCode(name), clips }];
  }
  const multi = sessions.length > 1;
  const used = new Set();
  sessions.forEach((s, i) => {
    let suffix = multi ? (s.code || String(i + 1)) : '';
    if (suffix && used.has(suffix)) suffix = `${suffix}${i + 1}`;
    used.add(suffix);
    s.suffix = suffix;
    const tag = suffix ? `${number} ${suffix}` : number;
    s.cue = tag;
    s.master = `Master-${tag}`;
    s.edit = `Edit-${tag}`;
  });
  return { dir: dayDir, name, number, sessions };
}

// Every folder (relative to a root) with the media files directly inside it,
// so the Media Pool can mirror the nested structure.
function mediaTree(root, rootBin) {
  const out = [];
  const walk = (dir, bin) => {
    const entries = listDir(dir).sort((a, b) => natural(a.name, b.name));
    const files = entries.filter((e) => e.isFile() && MEDIA_EXT.has(path.extname(e.name).toLowerCase())).map((e) => path.join(dir, e.name));
    out.push({ bin, files });
    for (const e of entries) if (e.isDirectory()) walk(path.join(dir, e.name), [...bin, e.name]);
  };
  walk(root, rootBin);
  return out;
}

// ------------------------------------------------------------------ moving footage
function walkFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else out.push(p);
    }
  };
  walk(dir);
  return out;
}

const sameVolume = (a, b) => path.parse(path.resolve(a)).root.toLowerCase() === path.parse(path.resolve(b)).root.toLowerCase();

// Bring a folder into destParent.
//  - same drive and move=true: moved (an instant rename, nothing is copied)
//  - different drive, or move=false: copied, every file size-checked;
//    the original is NEVER deleted.
// Returns { dest, moved }.
async function transferFolder(src, destParent, { move = true, onProgress = () => {} } = {}) {
  const dest = path.join(destParent, path.basename(src));
  if (fs.existsSync(dest)) throw new Error(`"${path.basename(src)}" already exists in ${destParent}`);
  if (move && sameVolume(src, destParent)) {
    // Windows refuses to move a folder while any file in it is open. Antivirus
    // or thumbnail indexing lets go within seconds, so retry before giving up.
    for (let attempt = 1; ; attempt++) {
      try {
        await fs.promises.rename(src, dest);
        onProgress({ done: 1, total: 1, file: path.basename(src) });
        return { dest, moved: true };
      } catch (err) {
        if (err.code === 'EXDEV') break;                  // really a different volume: copy instead
        if (['EPERM', 'EBUSY', 'EACCES'].includes(err.code) && attempt < 6) {
          onProgress({ done: 0, total: 0, file: `${path.basename(src)} is in use, retrying (${attempt}/5)…` });
          await new Promise((r) => setTimeout(r, 2000));
          continue;
        }
        if (['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) {
          throw new Error(`Windows won't move "${path.basename(src)}" because a file in it is open. ` +
            'Close any Explorer window or video player showing that folder, and close the Resolve project that uses those clips, then try again. ' +
            'Or choose "Always copy". Nothing was moved.');
        }
        throw err;
      }
    }
  }
  const files = walkFiles(src);
  const total = files.reduce((n, f) => n + fs.statSync(f).size, 0);
  let done = 0;
  for (const f of files) {
    const target = path.join(dest, path.relative(src, f));
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.copyFile(f, target);
    const size = fs.statSync(f).size;
    if (fs.statSync(target).size !== size) throw new Error(`Copy of ${f} is incomplete`);
    done += size;
    onProgress({ done, total, file: path.basename(f) });
  }
  return { dest, moved: false };
}

// folders: the user's template (New Project page). "Satsang Files" is added
// whenever footage is moved/copied into it (needSatsang); when footage is left
// where it is, the template decides. Re-running is fine.
function projectFolders(folders, { needSatsang = true } = {}) {
  const list = (Array.isArray(folders) ? folders : PROJECT_FOLDERS).map((f) => String(f).trim()).filter(Boolean);
  if (needSatsang && !list.some((f) => f.toLowerCase() === 'satsang files')) list.push('Satsang Files');
  return [...new Set(list)];
}

function createProjectFolders(location, projectName, folders, opts) {
  const root = path.join(location, projectName);
  fs.mkdirSync(root, { recursive: true });
  for (const f of projectFolders(folders, opts)) fs.mkdirSync(path.join(root, f), { recursive: true });
  return root;
}

module.exports = {
  PROJECT_FOLDERS, BINS, dayNumber, sessionCode, sessionClips, scanDay, mediaTree,
  transferFolder, createProjectFolders, projectFolders, clipNumber,
};
