// node dev/edge_check.js <file> — darkest border strip per frame (black edge detector)
const { spawn } = require('child_process'); const W = 3840, H = 2160, size = W * H;
const ff = spawn('ffmpeg', ['-v', 'error', '-i', process.argv[2], '-f', 'rawvideo', '-pix_fmt', 'gray', '-']);
let buf = Buffer.alloc(0), n = 0, worst = 255, worstAt = 0, black = 0;
const strip = (f, x0, y0, w, h) => { let s = 0; for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) s += f[y * W + x]; return s / (w * h); };
ff.stdout.on('data', d => { buf = Buffer.concat([buf, d]); while (buf.length >= size) { const f = buf.subarray(0, size); buf = Buffer.from(buf.subarray(size));
  const m = Math.min(strip(f, 0, 0, W, 2), strip(f, 0, H - 2, W, 2), strip(f, 0, 0, 2, H), strip(f, W - 2, 0, 2, H));
  if (m < worst) { worst = m; worstAt = n; } if (m < 8) black++; n++; } });
ff.on('close', () => console.log(`${n} frames; darkest edge strip mean luma ${worst.toFixed(1)} at frame ${worstAt}; frames with a black edge: ${black}`));
