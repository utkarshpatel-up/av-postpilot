// Seeds a sample Encoder queue into the screenshot test instance (dev/userdata-shot).
const fs = require('fs');
const path = require('path');
const d = path.join(__dirname, 'userdata-shot');
const read = (f) => { try { return JSON.parse(fs.readFileSync(path.join(d, f), 'utf8').replace(/^\uFEFF/, '')); } catch { return {}; } };
const st = read('state.json');
st.encoder = { groups: [
  { id: 'g1', name: 'HD review', preset: 'H.264 Master', dir: 'Y:\\Editing\\Utkarsh\\Exported Episode\\HD', suffix: '_HD', items: [
    { id: 'a', file: 'H:\\Edit-1207 to 1208\\Resolve Export\\DD Hindi-1700_V2.mov', state: 'done', pct: 100, tookMs: 251000, output: 'Y:\\Editing\\Utkarsh\\Exported Episode\\HD\\DD Hindi-1700_V2_HD.mov' },
    { id: 'b', file: 'H:\\Edit-1207 to 1208\\Resolve Export\\DD Hindi-1701_V2.mov', state: 'waiting', pct: 0, info: '3840x2160 · 25 fps' },
    { id: 'c', file: 'H:\\Edit-1207 to 1208\\Resolve Export\\DD Hindi-1702_V2.mov', preset: 'ProRes 422 HQ', dir: 'C:\\Users\\utkarsh\\Downloads', state: 'waiting', pct: 0 }] },
  { id: 'g2', name: 'Sankul', preset: 'H.264 Master', dir: 'C:\\Users\\utkarsh\\Downloads', suffix: '', items: [
    { id: 'e', file: 'H:\\Edit-1207 to 1208\\Satsang Files\\Adalaj Soneri Prabhat NRI & Other Center MHT Dt-28-11-18 Dur-44Min.mov', state: 'failed', error: 'output folder not reachable: Q:\\Review', pct: 0 }] },
] };
fs.writeFileSync(path.join(d, 'state.json'), JSON.stringify(st));
const s = read('settings.json');
s.encoder = { afterQueue: 'shutdown', shutdownSeconds: 600 };
fs.writeFileSync(path.join(d, 'settings.json'), JSON.stringify(s, null, 2));
console.log('seeded');
