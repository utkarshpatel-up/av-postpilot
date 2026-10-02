// After an HD review render: Resolve names "Individual clips" output after the
// source clip plus a frame number ("EP 12 (1207)_00000000.mov"). Rename each file
// to "<episode name><suffix>.<ext>" so it reads like the encoder used to make.
const fs = require('fs');
const path = require('path');

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// bases: episode names without extension, e.g. "Hindi Shibir-07 (2980M, 2980E)"
// since: only files written after this time (ms) belong to this batch
function collectHdFiles({ dir, bases, suffix = '', since = 0 }) {
  const files = [], problems = [];
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch (err) { return { files, problems: [`HD folder not readable: ${err.message}`] }; }
  for (const base of bases) {
    // Resolve appends a frame number, with or without "_" (both seen live). Require
    // 6+ digits so "EP 1" can never pick up "EP 12".
    const re = new RegExp(`^${escapeRe(base)}(${escapeRe(suffix)})?([_ -]?\\d{6,})?\\.[^.]+$`, 'i');
    const match = entries
      .filter((f) => re.test(f) && !f.endsWith('.part'))
      .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .filter((x) => x.t >= since - 5000)
      .sort((a, b) => b.t - a.t)[0];
    if (!match) { problems.push(`no HD file found for "${base}"`); continue; }
    const ext = path.extname(match.f);
    let target = `${base}${suffix}${ext}`;
    if (match.f !== target) {
      for (let n = 2; fs.existsSync(path.join(dir, target)); n++) target = `${base}${suffix} (${n})${ext}`;
      try {
        fs.renameSync(path.join(dir, match.f), path.join(dir, target));
      } catch (err) {
        problems.push(`could not rename ${match.f}: ${err.message}`);
        target = match.f;
      }
    }
    files.push(path.join(dir, target));
  }
  return { files, problems };
}

module.exports = { collectHdFiles };
