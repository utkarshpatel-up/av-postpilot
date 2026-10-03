const path = require('path');
const { Encoder } = require('../electron/encoder');
const e = new Encoder({ bridge: {}, notifier: {}, log: () => {}, onChange: () => {}, onQueueDone: () => {}, getSettings: () => ({}), loadState: () => null, saveState: () => {} });
const g = e.addGroup({});
const src = path.join(__dirname, 'enc_src');
console.log('file  ', JSON.stringify(e.addPaths(g.id, [path.join(src, 'clip25.mp4')])));
console.log('folder', JSON.stringify(e.addPaths(g.id, [src])));
console.log('literal', JSON.stringify(e.addPaths(g.id, ['C:\\Users\\admin\\Downloads\\av-postpilot\\dev\\enc_src\\clip30.mp4'])));
