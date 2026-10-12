// Dev: list the media files an FCP XML points at (one Windows path per line).
const fs = require('fs');
const { fromUrl } = require('../electron/premiere-import');
const xml = fs.readFileSync(process.argv[2], 'utf8');
const files = new Set([...xml.matchAll(/<pathurl>([^<]*)<\/pathurl>/g)].map(m => fromUrl(m[1].replace(/&amp;/g, '&'))));
fs.writeFileSync(process.argv[3], [...files].join('\n') + '\n');
console.log(files.size, 'files');
