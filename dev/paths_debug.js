// node dev/paths_debug.js — per-tracker summary of dev/stab-harness/paths.json
const r = require('./stab-harness/paths.json'), pts = require('./stab-harness/points.json');
const W = r.width, H = r.height, N = r.paths[0].length;
const marks = [0, 1, 2, 3, 4].map(k => Math.round(k * (N - 1) / 4));
r.paths.forEach((p, i) => {
  const q = p.map(v => v.map(Number)); let maxstep = 0, at = 0;
  for (let n = 1; n < q.length; n++) { const d = Math.hypot((q[n][0] - q[n - 1][0]) * W, (q[n][1] - q[n - 1][1]) * H); if (d > maxstep) { maxstep = d; at = n; } }
  console.log(i + 1, 'pt', pts[i].x.toFixed(2), pts[i].y.toFixed(2), 'fixed', pts[i].fixed, 'maxstep', maxstep.toFixed(1), '@', at, '|', marks.map(n => `${((q[n][0] - q[0][0]) * W).toFixed(0)},${(-(q[n][1] - q[0][1]) * H).toFixed(0)}`).join(' '));
});
