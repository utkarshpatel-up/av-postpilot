// node dev/measure_shake.js <file> <startFrame> <frames> — shake on moving shots:
// frame-to-frame median motion of a grid of patches, integrated, minus its ~1 s smoothing.
const { spawn } = require('child_process'); const { patch } = require('../electron/stabilization-quality');
const { bestMatch, smoothPath } = require('../electron/stabilization-points');
const [file, start, frames] = [process.argv[2], Number(process.argv[3]), Number(process.argv[4])]; const W = 3840, H = 2160, size = W * H;
const ff = spawn('ffmpeg', ['-v', 'error', '-ss', (start / 25).toFixed(3), '-i', file, '-frames:v', String(frames), '-f', 'rawvideo', '-pix_fmt', 'gray', '-']);
let buf = Buffer.alloc(0), prev = null; const cam = [[0, 0]];
const med = v => { const a = [...v].sort((x, y) => x - y); return a[a.length >> 1]; };
ff.stdout.on('data', d => { buf = Buffer.concat([buf, d]); while (buf.length >= size) {
  const f = { data: new Uint8Array(buf.subarray(0, size)), width: W, height: H }; buf = Buffer.from(buf.subarray(size));
  if (prev) { const steps = [];
    for (let gy = 1; gy < 9; gy++) for (let gx = 1; gx < 12; gx++) { if (process.env.TOP_ONLY && gy > 2) continue; const x = Math.round(gx * W / 12), y = Math.round(gy * H / 9), t = patch(prev, x, y); if (t.norm < 60) continue;
      const m = bestMatch(f, t, x, y, 24); if (m.score > .9) steps.push([m.x - x, m.y - y]); }
    const last = cam[cam.length - 1]; cam.push(steps.length >= 5 ? [last[0] + med(steps.map(s => s[0])), last[1] + med(steps.map(s => s[1]))] : last); }
  prev = f; } });
ff.on('close', () => { const s = smoothPath(cam, 12), fast = cam.map((c, n) => [c[0] - s[n][0], c[1] - s[n][1]]);
  const rms = Math.sqrt(fast.reduce((t, v) => t + v[0] ** 2 + v[1] ** 2, 0) / fast.length), max = Math.max(...fast.map(v => Math.hypot(...v)));
  const rng = a => Math.max(...cam.map(c => c[a])) - Math.min(...cam.map(c => c[a]));
  console.log(`total movement x ${rng(0).toFixed(0)} y ${rng(1).toFixed(0)} px`);
  console.log(`${cam.length} frames; fast shake rms ${rms.toFixed(2)} px, max ${max.toFixed(1)} px (integer-pixel matching)`); });
