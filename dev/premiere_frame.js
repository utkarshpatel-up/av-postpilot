// Dev: export one frame from Premiere via the link. node dev/premiere_frame.js <prproj> <sequence> <frame> <out.png>
const { PremiereLink } = require('../electron/premiere-link');
const [project, sequence, frame, file] = process.argv.slice(2);
new PremiereLink().request('export', { project, sequence, frame: +frame, file }, 120000)
  .then(r => console.log(JSON.stringify(r)), e => console.log('ERR', e.message));
