const {test}=require('node:test');
const assert=require('node:assert/strict');
const {assessment,MotionCheck}=require('../electron/stabilization-quality');
function points(motion){return [100,1500,3000,3700].map((x,i)=>({x,y:100+i*500,texture:200,template:{},minScore:.99,path:motion.map(([dx,dy])=>[x+dx,100+i*500+dy])}));}
test('steady reference passes while small coherent shake fails',()=>{
 const steady=Array.from({length:120},(_,i)=>[.1*Math.sin(i),0]);
 assert.equal(assessment(points(steady),120,3840,2160).status,'Passed');
 const shake=Array.from({length:120},(_,i)=>[0,1.5*Math.sin(i*.8)]);
 assert.equal(assessment(points(shake),120,3840,2160).status,'Needs retry');
});
test('unreliable or spatially concentrated references cannot produce a pass',()=>{
 const p=points(Array.from({length:120},()=>[0,0]));p[0].minScore=.7;p[1].minScore=.8;
 assert.equal(assessment(p,120,3840,2160).status,'Needs review');
 const q=points(Array.from({length:120},()=>[0,0])).map(p=>({...p,x:100,y:100}));
 assert.equal(assessment(q,120,3840,2160).status,'Needs review');
});
test('independently moving people cannot establish shared camera motion',()=>{
 const p=points(Array.from({length:120},()=>[0,0]));p.forEach((p,k)=>{p.path=p.path.map(([x,y],i)=>[x+i*(k+1),y]);});
 assert.equal(assessment(p,120,3840,2160).status,'Needs review');
});
test('matching catches a known translation in image pixels',()=>{
 const width=400,height=240,data=new Uint8Array(width*height);let seed=12;
 for(let i=0;i<data.length;i++){seed=(1664525*seed+1013904223)>>>0;data[i]=seed>>>24;}
 const check=new MotionCheck({data,width,height});check.add({data,width,height});
 const moved=new Uint8Array(data.length);for(let y=0;y<height;y++)for(let x=3;x<width;x++)moved[y*width+x]=data[y*width+x-3];
 check.add({data:moved,width,height});
 assert.ok(check.points.filter(p=>Math.abs((p.path[1][0]-p.path[0][0])-3)<.1).length>=3);
});
