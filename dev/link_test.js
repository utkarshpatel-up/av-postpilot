// Dev: start Premiere through the link, export XML for a project. node dev/link_test.js <prproj> <outdir>
const { PremiereLink } = require('../electron/premiere-link');
const l = new PremiereLink({ log: (lvl, m) => console.log(new Date().toISOString().slice(11, 19), lvl, m) });
(async () => {
  const t = Date.now();
  const files = await l.exportXml(process.argv[2], process.argv[3]);
  console.log(JSON.stringify(files, null, 1));
  console.log('seconds', Math.round((Date.now() - t) / 1000), 'status', JSON.stringify(l.status()));
})().catch(e => { console.log('ERROR', e.message); process.exit(1); });
