// Dev: relinked XML → XML with PNG title placeholders. node dev/xml_titles.js <in.xml> <out.xml> <png>
const fs = require('fs');
const { placeTitles, writePng } = require('../electron/premiere-titles');
writePng(process.argv[4], 3840, 2160);
const r = placeTitles(fs.readFileSync(process.argv[2], 'utf8'), { png: process.argv[4], width: 3840, height: 2160 });
fs.writeFileSync(process.argv[3], r.text);
console.log(JSON.stringify(r.titles), fs.statSync(process.argv[4]).size, 'bytes png');
