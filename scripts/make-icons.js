// Renders the app icon from SVG with Electron itself (no image tools needed).
// Run: npx electron scripts/make-icons.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// Clapper-slate top over a rounded tile, with a "play" arrow: post-production on autopilot.
const svg = (size) => `
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 256 256">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#ff6b4f"/><stop offset="1" stop-color="#c8361f"/>
    </linearGradient>
  </defs>
  <rect x="8" y="8" width="240" height="240" rx="56" fill="url(#g)"/>
  <g transform="rotate(-12 60 70)">
    <rect x="40" y="52" width="176" height="34" rx="8" fill="#1b1d22"/>
    <path d="M70 52h26l-20 34H50zM122 52h26l-20 34h-26zM174 52h26l-20 34h-26z" fill="#fff"/>
  </g>
  <rect x="40" y="104" width="176" height="112" rx="14" fill="#1b1d22"/>
  <path d="M108 128v64l56-32z" fill="#fff"/>
</svg>`;

// Render once at 256 px; smaller sizes are downscaled from it.
let master = null;
async function render(size) {
  if (!master) {
    const tmp = path.join(app.getPath('temp'), 'avpp-icon.html');
    fs.writeFileSync(tmp, `<html><body style="margin:0;background:transparent">${svg(256)}</body></html>`);
    const win = new BrowserWindow({ width: 256, height: 256, show: false, frame: false, transparent: true, webPreferences: { offscreen: true } });
    await win.loadFile(tmp);
    await new Promise((r) => setTimeout(r, 500));
    master = await win.webContents.capturePage({ x: 0, y: 0, width: 256, height: 256 });
    win.destroy();
  }
  return master.resize({ width: size, height: size, quality: 'best' }).toPNG();
}

// ICO containing PNG images (supported since Windows Vista).
function ico(pngs) {
  const header = Buffer.alloc(6 + 16 * pngs.length);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(pngs.length, 4);
  let offset = header.length;
  pngs.forEach(({ size, data }, i) => {
    const e = 6 + 16 * i;
    header.writeUInt8(size >= 256 ? 0 : size, e);
    header.writeUInt8(size >= 256 ? 0 : size, e + 1);
    header.writeUInt16LE(1, e + 4); header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(data.length, e + 8); header.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...pngs.map((p) => p.data)]);
}

app.whenReady().then(async () => {
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const pngs = [];
  for (const size of sizes) pngs.push({ size, data: await render(size) });
  const by = (s) => pngs.find((p) => p.size === s).data;
  fs.mkdirSync(path.join(ROOT, 'renderer', 'assets'), { recursive: true });
  fs.mkdirSync(path.join(ROOT, 'build'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'renderer', 'assets', 'icon.png'), by(256));
  fs.writeFileSync(path.join(ROOT, 'renderer', 'assets', 'tray.png'), by(32));
  fs.writeFileSync(path.join(ROOT, 'build', 'icon.ico'), ico(pngs));
  console.log('icons written');
  app.quit();
});
