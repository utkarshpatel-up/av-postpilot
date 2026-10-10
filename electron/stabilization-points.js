// Multi-point stabilization without per-frame verification.
// 1. pickPoints: from a few stills keep textured details that move like the camera.
//    Details that also stay matched across the whole clip (chairs, rails, walls) come
//    first; people who move on their own are rejected.
// 2. analyze: after Fusion tracks every point in one pass, the largest group of
//    paths that move together is the camera motion. Points that slip or sit on a
//    moving person disagree with that group and are left out.
//    - Lock: the camera should be still -> Match Move on the agreeing points.
//    - Smooth: the operator reframes -> keep the slow movement, remove only the
//      fast shake (a per-frame correction on a Transform node).
const { candidates, patch } = require('./stabilization-quality');

const LIMITS = { agree: .8, agreeMax: 3, residual: .5, minPoints: 3, spread: .06 };
const MODE = { lockDrift: 12 }; // 4K px of slow camera movement above which Smooth is used

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

function quarter(f) {
  const w = f.width >> 2, h = f.height >> 2, data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0; for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < 4; dx++) s += f.data[(y * 4 + dy) * f.width + x * 4 + dx];
    data[y * w + x] = s >> 4;
  }
  return { data, width: w, height: h };
}
// Median movement of the most textured details between two frames, in full-res px.
const quarterCache = new WeakMap();
function globalShift(a, b, cands) {
  const q = f => { if (!quarterCache.has(f)) quarterCache.set(f, quarter(f)); return quarterCache.get(f); };
  const qa = q(a), qb = q(b), reach = Math.round(qa.width / 12); // 80 px at quarter res = 320 px at 4K
  const moves = [];
  for (const c of [...cands].sort((x, y) => y.texture - x.texture).slice(0, 40)) {
    const x = Math.round(c.x / 4), y = Math.round(c.y / 4);
    if (x < reach + 20 || y < reach + 20 || x > qa.width - reach - 20 || y > qa.height - reach - 20) continue;
    const t = patch(qa, x, y); if (t.norm < 30) continue;
    const m = bestMatch(qb, t, x, y, reach); if (m.score >= .85) moves.push([(m.x - x) * 4, (m.y - y) * 4]);
  }
  if (moves.length < 5) return [0, 0];
  const med = v => [...v].sort((p, r) => p - r)[v.length >> 1];
  return [med(moves.map(m => m[0])), med(moves.map(m => m[1]))];
}

// frames: gray frames [first, ...near, ...far]. The near frames (a few frames after
// the first) decide what moves like the camera; far frames (later in the clip) only
// rank points that stay put the whole time. Returns Fusion coordinates (y up).
function pickPoints(frames, { count = 8, exclude = [], minScore = .85, near = 2 } = {}) {
  if (!frames.length) return [];
  const [first, ...others] = frames, W = first.width, H = first.height;
  const nearFrames = others.slice(0, near), farFrames = others.slice(near);
  const radius = Math.round(W / 120); // 32 px at 4K around the expected position
  const tolerance = Math.max(2, W / 1920); // 2 px at 4K
  const all = candidates(first);
  // A swinging camera can move the whole picture far more than 32 px; estimate that
  // global shift first (quarter resolution, wide search) and look around it.
  const shifts = others.map(f => globalShift(first, f, all));
  const found = [];
  for (const c of all) {
    // Fusion pattern is about 4% x 5% of the frame; keep it inside the picture.
    if (c.x < W * .05 || c.x > W * .95 || c.y < H * .06 || c.y > H * .94) continue;
    const at = (f, k) => bestMatch(f, c.template, c.x + shifts[k][0], c.y + shifts[k][1], radius);
    const moves = []; let ok = true;
    for (let k = 0; k < nearFrames.length; k++) { const m = at(nearFrames[k], k); if (m.score < minScore) { ok = false; break; } moves.push([m.x - c.x, m.y - c.y]); }
    if (!ok) continue;
    const far = farFrames.map((f, j) => { const m = at(f, near + j); return m.score >= .9 ? [m.x - c.x, m.y - c.y] : null; });
    found.push({ ...c, moves, far });
  }
  const median = v => v.length ? [...v].sort((a, b) => a - b)[v.length >> 1] : 0;
  const cam = nearFrames.map((_, k) => [0, 1].map(a => median(found.map(p => p.moves[k][a]))));
  // Moves like the camera over the next few frames (people moving on their own do not).
  const steady = found.filter(p => p.moves.every((m, k) => Math.hypot(m[0] - cam[k][0], m[1] - cam[k][1]) <= tolerance));
  // Also still in place later in the clip: a truly fixed detail. These are preferred.
  const farCam = farFrames.map((_, k) => { const v = steady.map(p => p.far[k]).filter(Boolean); return [0, 1].map(a => median(v.map(m => m[a]))); });
  for (const p of steady) p.fixed = p.far.every((m, k) => m && Math.hypot(m[0] - farCam[k][0], m[1] - farCam[k][1]) <= tolerance * 2);
  // One point per area, outer areas first: speakers usually fill the middle.
  const cells = new Map();
  for (const p of steady.sort((a, b) => (b.fixed - a.fixed) || (b.texture - a.texture))) {
    const key = Math.min(3, Math.floor(p.x / W * 4)) + ',' + Math.min(2, Math.floor(p.y / H * 3));
    if (!cells.has(key)) cells.set(key, []); cells.get(key).push(p);
  }
  const dist = k => { const [x, y] = k.split(',').map(Number); return Math.hypot((x + .5) / 4 - .5, (y + .5) / 3 - .5); };
  const order = [...cells.entries()].sort(([a, la], [b, lb]) => (lb[0].fixed - la[0].fixed) || (dist(b) - dist(a)));
  const far = (p, q) => Math.hypot((p.x - q.x) / W, (p.y - q.y) / H) > LIMITS.spread;
  const chosen = [], taken = exclude.map(p => ({ x: p.x * W, y: (1 - p.y) * H }));
  for (let round = 0; chosen.length < count && round < 4; round++) for (const [, list] of order) {
    const p = list.find(p => chosen.every(q => far(p, q)) && taken.every(q => far(p, q)));
    if (p && chosen.length < count) chosen.push(p);
  }
  // Busy shots (blurred crowd behind a sharp speaker) can leave too few clean points.
  // Top up with the best remaining details, edges first; the per-frame majority vote
  // in analyze() decides which of them really follow the camera.
  if (chosen.length < count) {
    const edgeFirst = (p, q) => Math.hypot(q.x / W - .5, q.y / H - .5) - Math.hypot(p.x / W - .5, p.y / H - .5);
    const rest = [...found, ...all.filter(c => c.x >= W * .05 && c.x <= W * .95 && c.y >= H * .06 && c.y <= H * .94)]
      .filter(p => !chosen.includes(p)).sort((p, q) => edgeFirst(p, q) || q.texture - p.texture);
    for (const p of rest) { if (chosen.length >= count) break; if (chosen.every(q => far(p, q)) && taken.every(q => far(p, q))) chosen.push({ ...p, fixed: false }); }
  }
  return chosen.map(p => ({ x: p.x / W, y: 1 - p.y / H, fixed: Boolean(p.fixed) }));
}

const diff = (a, b) => { let sq = 0, max = 0; for (let n = 0; n < a.length; n++) { const d = Math.hypot(a[n][0] - b[n][0], a[n][1] - b[n][1]); sq += d * d; max = Math.max(max, d); } return { rms: Math.sqrt(sq / a.length), max }; };
// Largest set of paths that agree with one another.
function findGroup(rel, ok) {
  let group = [];
  for (let i = 0; i < rel.length; i++) {
    if (!ok[i]) continue;
    const g = rel.map((p, j) => j).filter(j => ok[j] && (j === i || (d => d.rms < LIMITS.agree && d.max < LIMITS.agreeMax)(diff(rel[i], rel[j]))));
    if (g.length > group.length) group = g;
  }
  return group;
}
function summarize(rel, group) {
  const mean = rel[group[0]].map((_, n) => [0, 1].map(a => group.reduce((s, j) => s + rel[j][n][a], 0) / group.length));
  const residual = group.length > 1 ? Math.max(...group.map(j => diff(rel[j], mean).rms)) : null;
  let range = 0; for (const a of [0, 1]) { const v = mean.map(m => m[a]); range = Math.max(range, Math.max(...v) - Math.min(...v)); }
  let energy = 0;
  for (let n = 0; n < mean.length; n++) for (const a of [0, 1]) {
    let s = 0, c = 0; for (let j = Math.max(0, n - 12); j <= Math.min(mean.length - 1, n + 12); j++) { s += mean[j][a]; c++; }
    energy += (mean[n][a] - s / c) ** 2;
  }
  return { mean, residual, shake: { range, jitter: Math.sqrt(energy / (2 * mean.length)) } };
}
// Moving average applied twice (a soft ~1 second smoothing at win = fps/2). The path
// is mirrored through its end points first, so a pan carries on smoothly at the clip
// edges instead of being mistaken for shake there.
function smoothPath(p, win) {
  const pad = Math.min(2 * win, p.length - 1), last = p.length - 1;
  const ext = [];
  for (let k = pad; k >= 1; k--) ext.push([0, 1].map(a => 2 * p[0][a] - p[k][a]));
  ext.push(...p);
  for (let k = 1; k <= pad; k++) ext.push([0, 1].map(a => 2 * p[last][a] - p[last - k][a]));
  const once = q => q.map((_, n) => [0, 1].map(a => { let s = 0, c = 0; for (let j = Math.max(0, n - win); j <= Math.min(q.length - 1, n + win); j++) { s += q[j][a]; c++; } return s / c; }));
  return once(once(ext)).slice(pad, pad + p.length);
}
const toRel = (paths, width, height) => { const k = 3840 / width; return paths.map(p => p.map(([x, y]) => [(x - p[0][0]) * width * k, -(y - p[0][1]) * height * k])); };
const validPaths = rel => rel.map(p => p.length === rel[0].length && p.length > 1 && p.every(v => Number.isFinite(v[0]) && Number.isFinite(v[1])));

// paths: [[ [x,y] per frame ]] in Fusion coordinates. Lock analysis.
function consensus(paths, width, height) {
  const k = 3840 / width, rel = toRel(paths, width, height), group = findGroup(rel, validPaths(rel));
  if (!group.length) return { mode: 'lock', group, points: 0, shake: null, residual: null };
  const { mean, residual, shake } = summarize(rel, group);
  // Largest shift from the first frame, as a fraction of the frame (sets the edge zoom).
  const edge = { x: Math.max(...mean.map(m => Math.abs(m[0]))) / (width * k), y: Math.max(...mean.map(m => Math.abs(m[1]))) / (height * k) };
  return { mode: 'lock', group, points: group.length, shake, residual, edge, mean };
}
// Chooses Lock or Smooth. Smooth returns `correction`: per-frame Transform centre
// offsets in Fusion units (x right, y up) that cancel only the fast shake.
// force: 'auto' | 'lock' | 'smooth' (the editor's choice per clip).
function analyze(paths, width, height, fps = 25, force = 'auto') {
  const lock = consensus(paths, width, height);
  const win = Math.max(2, Math.round(fps / 2));
  if (force !== 'smooth' && lock.points >= LIMITS.minPoints) {
    const slow = smoothPath(lock.mean, win);
    let drift = 0; for (const a of [0, 1]) { const v = slow.map(m => m[a]); drift = Math.max(drift, Math.max(...v) - Math.min(...v)); }
    if (drift < MODE.lockDrift || force === 'lock') return lock;
  }
  // Smooth: decide frame by frame. On busy shots every tracker slips somewhere (a
  // person leans, someone walks past), so the camera step for each frame is the
  // median step of all trackers; a slipping tracker is outvoted only for that frame.
  const k = 3840 / width, rel = toRel(paths, width, height), N = rel[0] ? rel[0].length : 0;
  const live = rel.filter(p => p.length === N);
  const med = v => { const a = [...v].sort((x, y) => x - y); return a.length % 2 ? a[a.length >> 1] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2; };
  const follow = idx => {
    const cam = [[0, 0]], agreeing = [];
    for (let n = 1; n < N; n++) {
      const steps = idx.map(i => live[i]).map(p => [p[n][0] - p[n - 1][0], p[n][1] - p[n - 1][1]]).filter(v => Number.isFinite(v[0]) && Number.isFinite(v[1]));
      if (steps.length < 2) { cam.push(cam[n - 1]); agreeing.push(0); continue; }
      const m = [med(steps.map(v => v[0])), med(steps.map(v => v[1]))];
      agreeing.push(steps.filter(v => Math.hypot(v[0] - m[0], v[1] - m[1]) < SMOOTH.agreeStep).length);
      cam.push([cam[n - 1][0] + m[0], cam[n - 1][1] + m[1]]);
    }
    return { cam, agreeing };
  };
  if (N < 2) return { mode: 'smooth', group: [], points: 0, shake: null, residual: null };
  // Second pass: points on people drift away from the camera path over the clip even
  // when each step looks plausible. Keep only trackers that stayed close to the first
  // estimate (a few pixels), then follow the camera with those alone.
  const everyone = live.map((_, i) => i);
  let { cam, agreeing } = follow(everyone);
  const away = everyone.map(i => { let t = 0, c = 0; live[i].forEach((v, n) => { if (Number.isFinite(v[0]) && Number.isFinite(v[1])) { t += (v[0] - cam[n][0]) ** 2 + (v[1] - cam[n][1]) ** 2; c++; } }); return c ? Math.sqrt(t / c) : Infinity; });
  const keep = everyone.filter(i => away[i] <= Math.max(SMOOTH.stayPx, 3 * Math.min(...away)));
  if (keep.length >= 2 && keep.length < everyone.length) ({ cam, agreeing } = follow(keep));
  const used = keep.length >= 2 ? keep : everyone;
  // Trust check: the points used must agree with the final camera path over the whole
  // clip. If they wander apart (blurred crowd, nothing rigid in shot), any correction
  // would be a guess - better to leave the clip for a person to judge.
  const spread = Math.max(...used.map(i => { let t = 0, c = 0; live[i].forEach((v, n) => { if (Number.isFinite(v[0]) && Number.isFinite(v[1])) { t += (v[0] - cam[n][0]) ** 2 + (v[1] - cam[n][1]) ** 2; c++; } }); return c ? Math.sqrt(t / c) : Infinity; }));
  const slow = smoothPath(cam, win), fast = cam.map((c, n) => [c[0] - slow[n][0], c[1] - slow[n][1]]);
  let range = 0; for (const a of [0, 1]) { const v = fast.map(m => m[a]); range = Math.max(range, Math.max(...v) - Math.min(...v)); }
  const jitter = Math.sqrt(fast.reduce((s, m) => s + m[0] ** 2 + m[1] ** 2, 0) / (2 * N));
  const sorted = [...agreeing].sort((a, b) => a - b), typical = sorted[Math.floor(sorted.length * .1)] ?? 0;
  const weakFrames = agreeing.filter(a => a < LIMITS.minPoints).length;
  const toFusion = path => path.map(([x, y]) => [-x / (width * k), y / (height * k)]);
  const edgeOf = corr => ({ x: Math.max(...corr.map(c => Math.abs(c[0]))), y: Math.max(...corr.map(c => Math.abs(c[1]))) });
  const base = { group: used, points: typical, of: live.length, spread, weakFrames, frames: N, residual: null };
  // Full lock: cancel all movement around the middle of its range. Auto uses it when
  // the whole wander fits inside the zoom limit - a few dozen pixels is never a real
  // camera move. Bigger movement is treated as reframing and only smoothed.
  const mid = [0, 1].map(a => { const v = cam.map(c => c[a]); return (Math.max(...v) + Math.min(...v)) / 2; });
  const full = toFusion(cam.map(c => [c[0] - mid[0], c[1] - mid[1]]));
  let total = 0; for (const a of [0, 1]) { const v = cam.map(c => c[a]); total = Math.max(total, Math.max(...v) - Math.min(...v)); }
  if (force === 'lock' || (force === 'auto' && !edgeZoom(edgeOf(full)).capped)) {
    return { ...base, mode: 'lock', robust: true, shake: { range: total, jitter }, edge: edgeOf(full), correction: full };
  }
  const correction = toFusion(fast);
  return { ...base, mode: 'smooth', shake: { range, jitter }, edge: edgeOf(correction), correction };
}
const SMOOTH = { agreeStep: 2, weakShare: .02, stayPx: 4, trustPx: 6 }; // px per frame (4K); share of frames allowed below 3 agreeing

// Smallest centred zoom that keeps the shifted picture covering the frame, plus a
// small margin; capped so a wild clip never gets a heavy crop silently.
const ZOOM = { margin: .002, max: 1.03 };
function edgeZoom(edge) {
  if (!edge) return { zoom: 1, capped: false };
  const need = 1 + 2 * Math.max(edge.x, edge.y) + ZOOM.margin;
  const zoom = Math.ceil(Math.min(need, ZOOM.max) * 1000) / 1000;
  return { zoom, capped: need > ZOOM.max };
}
function verdict(c) {
  if (c.frames) {
    if (c.spread > SMOOTH.trustPx) return { status: 'Needs review', apply: false };
    if (!c.weakFrames && c.points >= LIMITS.minPoints) return { status: 'Passed', apply: true };
    if (c.weakFrames <= c.frames * SMOOTH.weakShare) return { status: 'Needs review', apply: true };
    return { status: 'Needs review', apply: false };
  }
  if (c.points >= LIMITS.minPoints && c.residual <= LIMITS.residual) return { status: 'Passed', apply: true };
  if (c.points >= 2) return { status: 'Needs review', apply: true };
  return { status: 'Needs review', apply: false };
}
function describe(c) {
  if (!c.shake) return 'No details could be tracked consistently through the clip';
  if (c.frames && c.spread > SMOOTH.trustPx) return `No rigid reference in this shot: the tracked details disagree by about ${c.spread.toFixed(0)} px (4K), so it was left unchanged. Try Choose points on chair backs or rails, or stabilize this one by hand`;
  if (c.frames) return `${c.mode === 'smooth' ? 'Smooth (keeps camera moves)' : 'Lock (all movement removed)'}: ${c.points}+ of ${c.of} points agree on ${c.weakFrames ? `all but ${c.weakFrames} frames` : 'every frame'}; ${c.mode === 'smooth' ? 'fast shake' : 'movement'} ${c.shake.range.toFixed(1)} px, jitter ${c.shake.jitter.toFixed(2)} px (4K pixels)`;
  return `Lock: ${c.points} point(s) agree; shake ${c.shake.range.toFixed(1)} px, jitter ${c.shake.jitter.toFixed(2)} px` +
    (c.residual == null ? '' : `; leftover about ${c.residual.toFixed(2)} px`) + ' (4K pixels)';
}
module.exports = { pickPoints, consensus, analyze, smoothPath, verdict, describe, edgeZoom, bestMatch, LIMITS, ZOOM, MODE, SMOOTH };
