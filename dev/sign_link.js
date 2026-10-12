// Dev: sign the Premiere helper (cep/postpilot-link) and unpack the signed copy into
// electron/premiere-link, which ships with the app. Run on Windows: node dev/sign_link.js
// Needs dev/tools/ZXPSignCmd.exe (Adobe CEP-Resources). The certificate stays in dev/tools.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { execFileSync } = require('child_process');
const root = path.join(__dirname, '..');
const tools = path.join(__dirname, 'tools');
const sign = path.join(tools, 'ZXPSignCmd.exe');
const p12 = path.join(tools, 'postpilot-link.p12'), passFile = path.join(tools, 'postpilot-link.pass');
const src = path.join(root, 'cep', 'postpilot-link');
const zxp = path.join(tools, 'postpilot-link.zxp');
const out = path.join(root, 'electron', 'premiere-link');
const run = args => execFileSync(sign, args, { encoding: 'utf8' });

if (!fs.existsSync(p12)) {
  fs.writeFileSync(passFile, crypto.randomBytes(18).toString('base64url'));
  run(['-selfSignedCert', 'IN', 'Gujarat', 'AV PostPilot', 'AV PostPilot Link', fs.readFileSync(passFile, 'utf8'), p12, '-validityDays', '9000']);
  console.log('created certificate', p12);
}
fs.rmSync(zxp, { force: true });
console.log(run(['-sign', src, zxp, p12, fs.readFileSync(passFile, 'utf8')]).trim());
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
execFileSync(process.platform === 'win32' ? path.join(process.env.SystemRoot, 'System32', 'tar.exe') : 'tar', ['-xf', zxp, '-C', out]); // bsdtar reads zip
console.log(run(['-verify', out]).trim());
