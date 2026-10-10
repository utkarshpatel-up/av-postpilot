// Compare app's tracker consensus with independent source measurement (no Resolve render).
const {spawn}=require('child_process');const fs=require('fs');
const {MotionCheck}=require('../electron/stabilization-quality');const {consensus}=require('../electron/stabilization-points');
const [start,frames]=process.argv.slice(2).map(Number);const W=3840,H=2160,size=W*H;
const tr=JSON.parse(fs.readFileSync('dev/stab-harness/paths.json'));const use=JSON.parse(fs.readFileSync('dev/stab-harness/apply.json')).use;
const paths=tr.paths.map(p=>p.map(v=>v.map(Number)));const group=use.map(i=>i-1);
const rel=paths.map(p=>p.map(([x,y])=>[(x-p[0][0])*W,-(y-p[0][1])*H]));
const app=rel[0].map((_,n)=>[0,1].map(a=>group.reduce((s,j)=>s+rel[j][n][a],0)/group.length));
const ff=spawn('ffmpeg',['-v','error','-ss',(start/25).toFixed(3),'-i','F:/Indore MHT Satsang E. Dt-09-Jan-26 Dur-1h3m Clip-02.MOV','-frames:v',String(frames),'-f','rawvideo','-pix_fmt','gray','-']);
let buf=Buffer.alloc(0),check;
ff.stdout.on('data',d=>{buf=Buffer.concat([buf,d]);while(buf.length>=size){const f={data:new Uint8Array(buf.subarray(0,size)),width:W,height:H};buf=buf.subarray(size);if(!check)check=new MotionCheck(f);check.add(f);}});
ff.on('close',()=>{const r=check.result();const pts=check.points.filter(p=>r.candidates.some(c=>Math.abs(c.x-p.x/W)<1e-8&&Math.abs(c.y-(1-p.y/H))<1e-8));
 const med=v=>{v=[...v].sort((a,b)=>a-b);return v[v.length>>1]};const n=Math.min(app.length,check.frames);
 const ind=Array.from({length:n},(_,k)=>[med(pts.map(p=>p.path[k][0]-p.path[0][0])),med(pts.map(p=>p.path[k][1]-p.path[0][1]))]);
 const rng=(P,a)=>Math.max(...P.map(v=>v[a]))-Math.min(...P.map(v=>v[a]));
 let sq=0,mx=0;const after=[];for(let k=0;k<n;k++){const d=[ind[k][0]-app[k][0],ind[k][1]-app[k][1]];after.push(d);const e=Math.hypot(...d);sq+=e*e;mx=Math.max(mx,e);}
 console.log(`independent areas: ${pts.length}; source shake x ${rng(ind,0).toFixed(1)} y ${rng(ind,1).toFixed(1)} px`);
 console.log(`app trackers (${group.length}): shake x ${rng(app,0).toFixed(1)} y ${rng(app,1).toFixed(1)} px`);
 console.log(`predicted leftover after stabilizing: rms ${Math.sqrt(sq/n).toFixed(2)} px, max ${mx.toFixed(2)} px, range x ${rng(after,0).toFixed(2)} y ${rng(after,1).toFixed(2)}`);
});
