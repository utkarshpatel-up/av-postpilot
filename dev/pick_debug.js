// node dev/pick_debug.js <file> <startFrame> <frames> — run the app's point picker on source frames via ffmpeg
const { execFileSync } = require('child_process'); const { pickPoints, bestMatch } = require('../electron/stabilization-points'); const { candidates } = require('../electron/stabilization-quality');
const [file, start, frames] = [process.argv[2], Number(process.argv[3]), Number(process.argv[4])]; const W = 3840, H = 2160;
const grab = f => ({ data: new Uint8Array(execFileSync('ffmpeg', ['-v', 'error', '-ss', ((start + f) / 25).toFixed(3), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 1e8 })), width: W, height: H });
const fr = [0, 2, 4, Math.round((frames - 1) / 2), frames - 1].map(grab);
const c = candidates(fr[0]); console.log('candidates', c.length);
// how far do candidates move between frame 0 and others (best match within 32px)?
const stats = fr.slice(1).map(f => { const m = c.slice(0, 40).map(p => bestMatch(f, p.template, p.x, p.y, 32)); return { good: m.filter(x => x.score >= .9).length, med: m.map(x => x.score).sort()[20]?.toFixed(2) }; });
console.log('per frame (of 40 candidates): score>=.9 count / median score', JSON.stringify(stats));
console.log('picked', pickPoints(fr).map(p => `${p.x.toFixed(3)},${p.y.toFixed(3)}`).join(' '));
