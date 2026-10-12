'use strict';
// Minimal PNG reader for 8-bit RGB/RGBA (Premiere's frame exports, Resolve's PNG renders).
const zlib = require('zlib');

function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw Error('Not a PNG file');
  let pos = 8, width = 0, height = 0, depth = 0, type = 0, interlace = 0; const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos); const name = buf.toString('latin1', pos + 4, pos + 8); const data = buf.subarray(pos + 8, pos + 8 + len);
    if (name === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); depth = data[8]; type = data[9]; interlace = data[12]; }
    else if (name === 'IDAT') idat.push(data);
    else if (name === 'IEND') break;
    pos += 12 + len;
  }
  const channels = { 2: 3, 6: 4, 0: 1, 4: 2 }[type];
  if (depth !== 8 || !channels || interlace) throw Error(`Unsupported PNG (depth ${depth}, type ${type}, interlace ${interlace})`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels; const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)]; const src = y * (stride + 1) + 1; const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[dst + x - channels] : 0;
      const b = y > 0 ? out[dst - stride + x] : 0;
      const c = x >= channels && y > 0 ? out[dst - stride + x - channels] : 0;
      let v = raw[src + x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      out[dst + x] = v & 255;
    }
  }
  return { width, height, channels, data: out };
}

module.exports = { decodePng };
