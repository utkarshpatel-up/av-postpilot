// node dev/pick_debug.js <startFrame> <frames>  — run pickPoints on source frames via ffmpeg
const {execFileSync}=require('child_process');const {pickPoints}=require('../electron/stabilization-points');
const [start,frames]=process.argv.slice(2).map(Number);const W=3840,H=2160;
const grab=f=>({data:new Uint8Array(execFileSync('ffmpeg',['-v','error','-ss',((start+f)/25).toFixed(3),'-i','F:/Indore MHT Satsang E. Dt-09-Jan-26 Dur-1h3m Clip-02.MOV','-frames:v','1','-f','rawvideo','-pix_fmt','gray','-'],{maxBuffer:1e8})),width:W,height:H});
const t=Date.now();const pts=pickPoints([0,.25,.5,.75,1].map(f=>grab(Math.round(f*(frames-1)))));
console.log((Date.now()-t)+'ms',pts.map(p=>`${p.x.toFixed(3)},${p.y.toFixed(3)}`).join(' '));
