// Dev: scan .prproj files for titles and colour-bar sources. node dev/find_bar_titles.js <folder>
const fs = require('fs'), path = require('path');
const p = require('../electron/premiere-project');
const files = [];
(function walk(d, depth) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name);
  if (e.isDirectory() && depth < 2) walk(f, depth + 1); else if (/\.prproj$/i.test(e.name)) files.push(f); } })(process.argv[2], 0);
for (const f of files) {
  try {
    const g = p.readProject(f);
    const xml = g.objects;
    // media whose name looks like bars, and synthetic sources (Bars and Tone etc.)
    const media = g.ofType('Media').map(m => p.val(m, 'Title') + ' | ' + p.val(m, 'FilePath')).filter(t => /bar|smpte|tone/i.test(t));
    const synth = [...new Set(g.objects.filter(o => /Synthetic|BarsAndTone|ColorMatte|Universal/i.test(o.name)).map(o => o.name))];
    const r = p.analyze(f);
    console.log(`\n== ${path.relative(process.argv[2], f)}  titles:${r.titles.length}`);
    for (const t of r.titles.slice(0, 3)) console.log('   title', t.sequence, 'V' + t.track, t.startFrame + '-' + t.endFrame, JSON.stringify(t.layers.map(l => [l.text.replace(/\r/g, ' / '), l.font, l.size, l.color])));
    if (media.length) console.log('   bars media:', media.slice(0, 4).join(' ;; '));
    if (synth.length) console.log('   synthetic:', synth.join(','));
  } catch (e) { console.log('ERR', f, e.message); }
}
