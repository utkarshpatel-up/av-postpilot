// node dev/measure_src.js <file> <startFrame> <frames> [vf]
const {spawn}=require('child_process');const {MotionCheck}=require('../electron/stabilization-quality');
const [file,start,frames,vf]=process.argv.slice(2);const W=3840,H=2160,size=W*H;
const args=['-v','error','-ss',(start/25).toFixed(3),'-i',file,'-frames:v',frames];
if(vf)args.push('-vf',vf);args.push('-f','rawvideo','-pix_fmt','gray','-');
const ff=spawn('ffmpeg',args);let buf=Buffer.alloc(0),check,n=0;
ff.stdout.on('data',d=>{buf=Buffer.concat([buf,d]);while(buf.length>=size){const f={data:new Uint8Array(buf.subarray(0,size)),width:W,height:H};buf=buf.subarray(size);
 if(!check)check=new MotionCheck(f);check.add(f);n++;}});
ff.on('close',()=>{const r=check.result();console.log(n,'frames',r.status,r.reason,'points',check.points.length);
 const good=check.points.filter(p=>p.minScore>=.94).length;console.log('reliable(minScore>=.94):',good);});
ff.on('close',()=>{const a=check.assessed;const pts=check.points.filter(p=>a.candidates.some(c=>Math.abs(c.x-p.x/W)<1e-8&&Math.abs(c.y-(1-p.y/H))<1e-8));
 const med=v=>{v=[...v].sort((a,b)=>a-b);return v[v.length>>1]};
 let s='';for(let n=0;n<check.frames;n+=10)s+=`${n}:${med(pts.map(p=>p.path[n][0]-p.path[0][0])).toFixed(1)},${med(pts.map(p=>p.path[n][1]-p.path[0][1])).toFixed(1)} `;console.log(s);
 console.log('top candidates',a.candidates.slice(0,5).map(c=>`${c.x.toFixed(3)},${c.y.toFixed(3)}`).join(' '));});
