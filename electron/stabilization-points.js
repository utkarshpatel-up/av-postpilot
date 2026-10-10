// Multi-point stabilization without per-frame verification.
// 1. pickPoints: from three stills (start, middle, end) keep textured details that
//    stay in place: chairs, rails, walls. People who move are rejected.
// 2. consensus: after Fusion tracks every point in one pass, the largest group of
//    paths that move together is the camera shake. Points that slip or sit on a
//    moving person disagree with that group and are left out.
const { candidates, patch } = require('./stabilization-quality');

const LIMITS = { agree: .8, agreeMax: 3, residual: .5, minPoints: 3, spread: .06 };

function score(frame, ref, x, y) {
  if (x < 17 || y < 17 || x >= frame.width - 17 || y >= frame.height - 17) return -1;
  let sum = 0, sq = 0, dot = 0, k = 0;
  for (let dy = -16; dy < 16; dy += 4) for (let dx = -16; dx < 16; dx += 4) {
    const v = frame.data[(y + dy) * frame.width + x + dx]; sum += v; sq += v * v; dot += v * ref.centered[k++];
  }
  return dot / (ref.norm * Math.sqrt(Math.max(1, sq - sum * sum / 64)));
}
// Best correlation within +-radius pixels (coarse step 2, then refine).
function bestMatch(frame, ref, cx, cy, radius) {
  let best = { score: -1, x: cx, y: cy };
  for (let y = cy - radius; y <= cy + radius; y += 2) for (let x = cx - radius; x <= cx + radius; x += 2) {
    const s = score(frame, ref, x, y); if (s > best.score) best = { score: s, x, y };
  }
  const c = best;
  for (let y = c.y - 1; y <= c.y + 1; y++) for (let x = c.x - 1; x <= c.x + 1; x++) {
    const s = score(frame, ref, x, y); if (s > best.score) best = { score: s, x, y };
  }
  return best;
}

// frames: gray frames [first, ...others]. Returns Fusion coordinates (y up).
function pickPoints(frames, { count = 8, exclude = [], minScore = .9 } = {}) {
  if (!frames.length) return [];
  const [first, ...others] = frames, W = first.width, H = first.height;
  const radius = Math.round(W / 120); // 32 px at 4K covers normal handheld shake
  const tolerance = Math.max(2, W / 1920); // 2 px at 4K
  const found = [];
  for (const c of candidates(first)) {
    // Fusion pattern is about 4% x 5% of the frame; keep it inside the picture.
    if (c.x < W * .05 || c.x > W * .95 || c.y < H * .06 || c.y > H * .94) continue;
    const moves = []; let worst = 1;
    for (const f of others) { const m = bestMatch(f, c.template, c.x, c.y, radius); worst = Math.min(worst, m.score); if (worst < minScore) break; moves.push([m.x - c.x, m.y - c.y]); }
    if (worst >= minScore) found.push({ ...c, worst, moves });
  }
  // Fixed details all move by the camera shake; a person moves on their own.
  const median = v => [...v].sort((a, b) => a - b)[v.length >> 1];
  const camera = others.map((_, k) => [0, 1].map(a => median(found.map(p => p.moves[k][a]))));
  const fixed = found.filter(p => p.moves.every((m, k) => Math.hypot(m[0] - camera[k][0], m[1] - camera[k][1]) <= tolerance));
  // One point per area, outer areas first: speakers usually fill the middle.
  const cells = new Map();
  for (const p of fixed.sort((a, b) => b.texture - a.texture)) {
    const key = Math.min(3, Math.floor(p.x / W * 4)) + ',' + Math.min(2, Math.floor(p.y / H * 3));
    if (!cells.has(key)) cells.set(key, []); cells.get(key).push(p);
  }
  const order = [...cells.entries()].sort(([a], [b]) => { const d = k => { const [x, y] = k.split(',').map(Number); return Math.hypot((x + .5) / 4 - .5, (y + .5) / 3 - .5); }; return d(b) - d(a); });
  const far = (p, q) => Math.hypot((p.x - q.x) / W, (p.y - q.y) / H) > LIMITS.spread;
  const chosen = [], taken = exclude.map(p => ({ x: p.x * W, y: (1 - p.y) * H }));
  for (let round = 0; chosen.length < count && round < 4; round++) for (const [, list] of order) {
    const p = list.find(p => chosen.every(q => far(p, q)) && taken.every(q => far(p, q)));
    if (p && chosen.length < count) chosen.push(p);
  }
  return chosen.map(p => ({ x: p.x / W, y: 1 - p.y / H }));
}

// paths: [[ [x,y] per frame ]] in Fusion coordinates. Returns the agreeing group
// (indices), source shake and the expected leftover after stabilizing.
function consensus(paths, width, height) {
  const k = 3840 / width; // report in 4K pixels like the rest of the app
  const rel = paths.map(p => p.map(([x, y]) => [(x - p[0][0]) * width * k, -(y - p[0][1]) * height * k]));
  const diff = (a, b) => { let sq = 0, max = 0; for (let n = 0; n < a.length; n++) { const d = Math.hypot(a[n][0] - b[n][0], a[n][1] - b[n][1]); sq += d * d; max = Math.max(max, d); } return { rms: Math.sqrt(sq / a.length), max }; };
  const ok = rel.map(p => p.length === rel[0].length && p.every(v => Number.isFinite(v[0]) && Number.isFinite(v[1])));
  let group = [];
  for (let i = 0; i < rel.length; i++) {
    if (!ok[i]) continue;
    const g = rel.map((p, j) => j).filter(j => ok[j] && (j === i || (d => d.rms < LIMITS.agree && d.max < LIMITS.agreeMax)(diff(rel[i], rel[j]))));
    if (g.length > group.length) group = g;
  }
  if (!group.length) return { group, points: 0, shake: null, residual: null };
  const mean = rel[0].map((_, n) => [0, 1].map(a => group.reduce((s, j) => s + rel[j][n][a], 0) / group.length));
  const residual = group.length > 1 ? Math.max(...group.map(j => diff(rel[j], mean).rms)) : null;
  let range = 0; for (const a of [0, 1]) { const v = mean.map(m => m[a]); range = Math.max(range, Math.max(...v) - Math.min(...v)); }
  let energy = 0;
  for (let n = 0; n < mean.length; n++) for (const a of [0, 1]) {
    let s = 0, c = 0; for (let j = Math.max(0, n - 12); j <= Math.min(mean.length - 1, n + 12); j++) { s += mean[j][a]; c++; }
    energy += (mean[n][a] - s / c) ** 2;
  }
  return { group, points: group.length, shake: { range, jitter: Math.sqrt(energy / (2 * mean.length)) }, residual };
}

function verdict(c) {
  if (c.points >= LIMITS.minPoints && c.residual <= LIMITS.residual) return { status: 'Passed', apply: true };
  if (c.points >= 2) return { status: 'Needs review', apply: true };
  return { status: 'Needs review', apply: false };
}
function describe(c) {
  if (!c.shake) return 'No fixed details could be tracked through the clip';
  return `${c.points} fixed point(s) agree; shake ${c.shake.range.toFixed(1)} px, jitter ${c.shake.jitter.toFixed(2)} px` +
    (c.residual == null ? '' : `; leftover about ${c.residual.toFixed(2)} px`) + ' (4K pixels)';
}
module.exports = { pickPoints, consensus, verdict, describe, bestMatch, LIMITS };
