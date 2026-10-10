// node dev/measure_points.js <file> <start> <frames> x,y ... (Fusion coords, y up) — track fixed spots from frame 0
const { spawn } = require('child_process'); const { patch } = require('../electron/stabilization-quality'); const { bestMatch, smoothPath } = require('../electron/stabilization-points');
const [file, start, frames, ...spots] = process.argv.slice(2); const W = 3840, H = 2160, size = W * H;
const pts = spots.map(s => { const [x, y] = s.split(',').map(Number); return { x: Math.round(x * W), y: Math.round((1 - y) * H), path: [] }; });
const ff = spawn('ffmpeg', ['-v', 'error', '-ss', (Number(start) / 25).toFixed(3), '-i', file, '-frames:v', frames, '-f', 'rawvideo', '-pix_fmt', 'gray', '-']);
let buf = Buffer.alloc(0);
ff.stdout.on('data', d => { buf = Buffer.concat([buf, d]); while (buf.length >= size) { const f = { data: new Uint8Array(buf.subarray(0, size)), width: W, height: H }; buf = Buffer.from(buf.subarray(size));
  for (const p of pts) { if (!p.t) p.t = patch(f, p.x, p.y); const last = p.path.at(-1) || [p.x, p.y]; const m = bestMatch(f, p.t, last[0], last[1], 24); p.path.push([m.x, m.y]); } } });
ff.on('close', () => { const mean = pts[0].path.map((_, n) => [0, 1].map(a => pts.reduce((s, p) => s + p.path[n][a] - p.path[0][a], 0) / pts.length));
  const rng = a => Math.max(...mean.map(m => m[a])) - Math.min(...mean.map(m => m[a]));
  const s = smoothPath(mean, 12), fast = mean.map((m, n) => Math.hypot(m[0] - s[n][0], m[1] - s[n][1]));
  console.log(`fixed spots: movement x ${rng(0).toFixed(1)} y ${rng(1).toFixed(1)} px; fast shake rms ${Math.sqrt(fast.reduce((t, v) => t + v * v, 0) / fast.length).toFixed(2)} max ${Math.max(...fast).toFixed(1)} px`); });
