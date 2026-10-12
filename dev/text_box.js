// Dev: bounding boxes of bright text per line. node dev/text_box.js <image|video> [alpha] [seconds]
// alpha = use the alpha channel (Premiere PNG); otherwise luma > 128.
const { execFileSync } = require('child_process');
const [file, mode, ss] = process.argv.slice(2);
const W = 3840, H = 2160;
const args = ['-v', 'error'];
if (ss) args.push('-ss', ss);
args.push('-i', file, '-frames:v', '1', '-vf', (mode === 'alpha' ? 'alphaextract,' : '') + `scale=${W}:${H},format=gray`, '-f', 'rawvideo', '-');
const px = execFileSync('ffmpeg', args, { maxBuffer: W * H * 2 });
const rows = [];
for (let y = 0; y < H; y++) { let n = 0; for (let x = 0; x < W; x++) if (px[y * W + x] > 128) n++; rows.push(n); }
// split into lines by empty row runs
const lines = []; let cur = null;
for (let y = 0; y < H; y++) {
  if (rows[y] > 0) { if (!cur) cur = { top: y, bottom: y }; cur.bottom = y; }
  else if (cur && y - cur.bottom > 20) { lines.push(cur); cur = null; }
}
if (cur) lines.push(cur);
for (const l of lines) {
  let left = W, right = 0;
  for (let y = l.top; y <= l.bottom; y++) for (let x = 0; x < W; x++) if (px[y * W + x] > 128) { if (x < left) left = x; if (x > right) right = x; }
  Object.assign(l, { left, right, width: right - left + 1, height: l.bottom - l.top + 1, cx: (left + right) / 2, cy: (l.top + l.bottom) / 2 });
}
console.log(JSON.stringify(lines));
