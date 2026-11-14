// For the Encoder's range window: frame rate of a file (HandBrakeCLI --scan), and a small
// H.264 preview copy for files the app's player can't show (ProRes, DNxHD, MXF…).
// The copy keeps the source's frame timing, so a frame picked on it is the same frame in the source.
const { spawn: nodeSpawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// "+ size: 1920x1080, pixel aspect: 1/1, display aspect: 1.78, 23.976 fps" / "Duration: 00:43:45.12"
function parseScan(text) {
  const fps = Number((text.match(/\+ size: .*?([\d.]+) fps/) || text.match(/scan: .*?([\d.]+) fps/) || [])[1]) || null;
  const d = text.match(/Duration: (\d+):(\d\d):(\d\d(?:\.\d+)?)/);
  const duration = d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : null;
  const size = (text.match(/\+ size: (\d+x\d+)/) || [])[1] || '';
  return { fps, duration, size };
}

class MediaPreview {
  constructor({ dir, findCli, spawn = nodeSpawn, keepDays = 7 }) {
    Object.assign(this, { dir, findCli, spawn });
    this.child = null;
    // Old preview copies are removed: they're only needed while picking a range.
    try {
      for (const f of fs.readdirSync(dir)) {
        const p = path.join(dir, f);
        if (Date.now() - fs.statSync(p).mtimeMs > keepDays * 86400000) fs.rmSync(p, { force: true });
      }
    } catch { /* no folder yet */ }
  }

  cli() {
    const cli = this.findCli();
    if (!cli) throw new Error('HandBrakeCLI is missing from this copy of PostPilot');
    return cli;
  }

  run(args, onOut = () => {}) {
    return new Promise((resolve, reject) => {
      const child = this.spawn(this.cli(), args, { windowsHide: true });
      let all = '';
      const take = (buf) => { all = (all + buf).slice(-200000); onOut(String(buf)); };
      child.stdout?.on('data', take);
      child.stderr?.on('data', take);
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, out: all, child }));
      this.child = child;
    });
  }

  async probe(file) {
    if (!fs.existsSync(file)) throw new Error('File not found');
    const { out } = await this.run(['--scan', '-t', '0', '-i', file]);
    const info = parseScan(out);
    if (!info.fps) throw new Error('Could not read the frame rate of this file');
    return info;
  }

  previewPath(file) {
    const st = fs.statSync(file);
    const key = crypto.createHash('sha1').update(`${file}|${st.size}|${st.mtimeMs}`).digest('hex').slice(0, 16);
    return path.join(this.dir, `${key}.mp4`);
  }

  // Ready-made copy if there is one, else null.
  existing(file) {
    const p = this.previewPath(file);
    return fs.existsSync(p) ? p : null;
  }

  async make(file, onProgress = () => {}) {
    const out = this.previewPath(file);
    if (fs.existsSync(out)) return out;
    fs.mkdirSync(this.dir, { recursive: true });
    const part = `${out}.part.mp4`;
    // no -r: the frame rate and timing stay the source's
    const args = ['-i', file, '-o', part, '-f', 'av_mp4', '-e', 'x264', '--encoder-preset', 'ultrafast', '-q', '30',
      '--maxWidth', '960', '--maxHeight', '540', '-E', 'av_aac', '-B', '96', '--mixdown', 'stereo', '--no-markers'];
    // HandBrakeCLI's output can arrive a few bytes at a time, splitting progress lines between
    // chunks: look in the recent output, not just the newest chunk.
    let last = -1, recent = '';
    const r = await this.run(args, (s) => {
      recent = (recent + s).slice(-500);
      const m = [...recent.matchAll(/Encoding: task \d+ of \d+, ([\d.]+) %/g)].pop();
      if (m && Math.floor(m[1]) !== last) { last = Math.floor(m[1]); onProgress(last); }
    });
    this.child = null;
    if (r.code !== 0 || !fs.existsSync(part) || fs.statSync(part).size === 0) {
      fs.rmSync(part, { force: true });
      if (this.cancelled) { this.cancelled = false; throw new Error('Cancelled'); }
      const why = r.out.split(/\r?\n/).reverse().find((l) => /error|fail|invalid|no title/i.test(l));
      throw new Error(`Could not make a preview copy${why ? `: ${why.trim()}` : ''}`);
    }
    fs.renameSync(part, out);
    return out;
  }

  cancel() {
    if (!this.child) return;
    this.cancelled = true;
    this.child.kill();
  }
}

module.exports = { MediaPreview, parseScan };
