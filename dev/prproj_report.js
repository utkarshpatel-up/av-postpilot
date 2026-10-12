// Dev: print the Premiere migration report. node dev/prproj_report.js <prproj>
const p = require('../electron/premiere-project');
console.time('analyze');
const r = p.analyze(process.argv[2], { fonts: ['Calibri Bold (TrueType)', 'Arial (TrueType)'] });
console.timeEnd('analyze');
console.table(r.sequences.map(s => ({ ...s, media: s.media.length, nested: s.nested.join(' | ') })));
console.table(r.media.map(m => ({ title: m.title.slice(0, 45), status: m.status, path: m.path.slice(0, 80) })));
console.log(r.counts, r.audioEffects, r.fonts);
console.log(r.titles);
for (const g of r.gradeGroups) console.log(`#${g.id} x${g.count}  ${g.summary.slice(0, 230)}`);
console.log(r.fixes.filter(f => f.notes.length));
