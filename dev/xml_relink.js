// Dev: relink an FCP XML with the media found by the .prproj report. node dev/xml_relink.js <prproj> <in.xml> <out.xml>
const fs = require('fs');
const { analyze } = require('../electron/premiere-project');
const { relinkXml } = require('../electron/premiere-import');
const r = analyze(process.argv[2]);
const map = new Map(r.media.map(m => [m.original.toLowerCase(), m.path]));
const out = relinkXml(fs.readFileSync(process.argv[3], 'utf8'), p => map.get(p.toLowerCase()) || '');
fs.writeFileSync(process.argv[4], out.text);
console.log('relinked', out.relinked, 'missing', out.missing);
