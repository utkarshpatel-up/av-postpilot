// Content fingerprint of a .drp (a zip of XML files), used to skip saving
// exports when the project hasn't changed. Resolve regenerates a few internal
// IDs on every export, so those are blanked out before hashing. If Resolve adds
// other volatile fields, the result is an extra saved copy, never a missed one.
const fs = require('fs');
const zlib = require('zlib');
const crypto = require('crypto');

const VOLATILE = [
  [/(<SmPTZRPreset DbId=")[^"]*/g, '$1'],
  [/(<(?:Aux)?RenderCacheBA>)[^<]*/g, '$1'],
];

function readZipEntries(buf) {
  // Find the End Of Central Directory record (last 64 KB of the file).
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad zip directory');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + compSize);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error(`unsupported zip method ${method}`);
    entries.push({ name, data });
  }
  return entries;
}

function fingerprint(file) {
  const entries = readZipEntries(fs.readFileSync(file));
  entries.sort((a, b) => (a.name < b.name ? -1 : 1));
  const h = crypto.createHash('sha256');
  for (const e of entries) {
    let text = e.data.toString('utf8');
    for (const [re, rep] of VOLATILE) text = text.replace(re, rep);
    h.update(e.name).update('\0').update(text).update('\0');
  }
  return h.digest('hex');
}

module.exports = { fingerprint };
