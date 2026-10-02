// Episode series naming.
//   timeline name:  "<series>-<NN> (<cue>)"          e.g. "Hindi Shibir-01 (2978)"
//   title line 1:   "<title> -" or "<title> - <N>"   e.g. "DD Hindi -", "DD Hindi - 1750"
//   title line 2:   subtitle                         e.g. "(Hindi Shibir, Adalaj)"
// Renaming keeps whatever is in "(...)" exactly as it is.

const pad = (n, width) => String(n).padStart(width, '0');
const width = (start, count) => Math.max(2, String(start + count - 1).length);

function titleLine(title, n, showNumber) {
  const base = String(title).trim().replace(/\s*-\s*$/, '');
  return showNumber ? `${base} - ${n}` : `${base} -`;
}

// rows: [{ cue: "2978", count: 3 }, ...]
function planSeries({ series, title, subtitle, start, showNumber, rows }) {
  const total = rows.reduce((n, r) => n + (Number(r.count) || 0), 0);
  const w = width(Number(start), total);
  const out = [];
  let n = Number(start);
  for (const r of rows) {
    for (let i = 0; i < (Number(r.count) || 0); i++, n++) {
      const cue = String(r.cue || '').trim();
      out.push({
        name: `${series.trim()}-${pad(n, w)}${cue ? ` (${cue})` : ''}`,
        line1: titleLine(title, pad(n, w), showNumber),
        subtitle: subtitle || '',
      });
    }
  }
  return out;
}

// "Hindi Shibir-04 (2980 M)" -> { series: "Hindi Shibir", number: 4, tail: " (2980 M)" }
// Tolerates a missing ")" like "Hindi Shibir-10 (29".
function parseEpisode(name) {
  const m = /^(.*?)-(\d+)(\s*\(.*)?$/.exec(name);
  if (!m) return null;
  return { series: m[1], number: Number(m[2]), digits: m[2], tail: m[3] || '' };
}

// Group timeline names into series: [{ series, count, first, last, names }]
function findSeries(names) {
  const map = new Map();
  for (const name of names) {
    if (/^(Master|Edit)-/i.test(name)) continue;
    // Review timelines are named after the exported file ("… (1207).mov"): not episodes.
    if (/\.(mov|mp4|mxf|m4v|avi|mkv|mts|wav)$/i.test(name)) continue;
    const p = parseEpisode(name);
    if (!p) continue;
    if (!map.has(p.series)) map.set(p.series, []);
    map.get(p.series).push({ name, ...p });
  }
  return [...map.entries()]
    .map(([series, eps]) => {
      eps.sort((a, b) => a.number - b.number);
      return { series, count: eps.length, first: eps[0].number, last: eps[eps.length - 1].number, episodes: eps };
    })
    .filter((s) => s.count > 0)
    .sort((a, b) => a.series.localeCompare(b.series));
}

// Rename a series in its current episode order, keeping each "(...)" tail.
function planRename(seriesInfo, { series, title, subtitle, start, showNumber }) {
  const eps = seriesInfo.episodes;
  const w = width(Number(start), eps.length);
  return eps.map((e, i) => {
    const n = pad(Number(start) + i, w);
    return {
      old: e.name,
      name: `${series.trim()}-${n}${e.tail}`,
      line1: titleLine(title, n, showNumber),
      subtitle: subtitle ? subtitle : null,              // null = keep the current subtitle
    };
  });
}

module.exports = { planSeries, parseEpisode, findSeries, planRename, titleLine };
