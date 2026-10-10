// Full-resolution, fixed-template motion checks. No Python or extra codec install.
// Frames come from Resolve's actual timeline output, including Fusion processing.
const LIMITS = { range: 3, jitter: .3, correlation: .94, agreement: .35, minPoints: 3 };
const median = values => { const a = [...values].sort((a,b)=>a-b); return a.length ? a[Math.floor(a.length/2)] : Infinity; };
function grayFrame(bitmap, width, height) {
  const data = new Uint8Array(width*height);
  for(let i=0,j=0;i<data.length;i++,j+=4) data[i]=(bitmap[j]*29+bitmap[j+1]*150+bitmap[j+2]*77)>>8;
  return { data,width,height };
}
function patch(frame,x,y) {
  const out=[];
  for(let dy=-16;dy<16;dy+=4) for(let dx=-16;dx<16;dx+=4) out.push(frame.data[(y+dy)*frame.width+x+dx]);
  const mean=out.reduce((a,b)=>a+b,0)/out.length;
  const centered=out.map(v=>v-mean), norm=Math.sqrt(centered.reduce((a,b)=>a+b*b,0));
  return { centered,norm };
}
function candidates(frame) {
  const found=[];
  // Multiple separated regions keep the subject's face from dominating the check.
  for(let gy=0;gy<4;gy++) for(let gx=0;gx<5;gx++) {
    const local=[];
    for(let y=Math.max(40,Math.floor(gy*frame.height/4));y<Math.min(frame.height-40,(gy+1)*frame.height/4);y+=20)
      for(let x=Math.max(40,Math.floor(gx*frame.width/5));x<Math.min(frame.width-40,(gx+1)*frame.width/5);x+=20) {
        const p=patch(frame,x,y); if(p.norm>60) local.push({x,y,texture:p.norm,template:p});
      }
    const chosen=[];
    for(const p of local.sort((a,b)=>b.texture-a.texture)){if(chosen.every(q=>Math.hypot(p.x-q.x,p.y-q.y)>80))chosen.push(p);if(chosen.length===3)break;}
    found.push(...chosen);
  }
  // Rails, signs and wall edges can be less textured than faces. Add references
  // along long image edges so crowd shots are not represented only by people.
  const lines=(vertical)=>{
    const along=vertical?frame.height:frame.width,across=vertical?frame.width:frame.height,rows=[];
    for(let a=40;a<across-40;a+=8){let score=0;
      for(let b=40;b<along-40;b+=8){const x=vertical?a:b,y=vertical?b:a;const i=y*frame.width+x;score+=Math.abs(frame.data[i+(vertical?4:4*frame.width)]-frame.data[i-(vertical?4:4*frame.width)]);}
      rows.push({a,score});
    }
    const selected=[];
    for(const row of rows.sort((a,b)=>b.score-a.score)){if(selected.every(r=>Math.abs(r.a-row.a)>64))selected.push(row);if(selected.length===4)break;}
    for(const {a} of selected)for(let b=Math.floor(along/10);b<along-40;b+=Math.floor(along/8)){
      const x=vertical?a:b,y=vertical?b:a;if(found.some(p=>Math.hypot(p.x-x,p.y-y)<40))continue;
      const template=patch(frame,x,y);if(template.norm>60)found.push({x,y,texture:template.norm,template});
    }
  };
  lines(false);lines(true);
  // Wall lettering above an audience may be soft, yet is more useful than a
  // sharp face. Keep perimeter probes even when a stronger feature is nearby.
  for(const fy of [.028,.05])for(let fx=.05;fx<.96;fx+=.05){
    const x=Math.round(fx*frame.width),y=Math.max(20,Math.round(fy*frame.height));
    if(x<20||x>=frame.width-20||y>=frame.height-20)continue;
    const template=patch(frame,x,y);if(template.norm>25)found.push({x,y,texture:template.norm,template});
  }
  return found;
}
function match(frame,reference,cx,cy) {
  let best={score:-1,x:cx,y:cy}; const scores=new Map();
  const scoreAt=(x,y)=>{
    if(x<17||y<17||x>=frame.width-17||y>=frame.height-17)return -1;
    let sum=0,sq=0,dot=0,k=0;
    for(let dy=-16;dy<16;dy+=4)for(let dx=-16;dx<16;dx+=4){const v=frame.data[(y+dy)*frame.width+x+dx];sum+=v;sq+=v*v;dot+=v*reference.centered[k++];}
    return dot/(reference.norm*Math.sqrt(Math.max(1,sq-sum*sum/64)));
  };
  cx=Math.round(cx);cy=Math.round(cy);
  for(let y=cy-12;y<=cy+12;y++)for(let x=cx-12;x<=cx+12;x++){
    const score=scoreAt(x,y);scores.set(`${x},${y}`,score);if(score>best.score)best={x,y,score};
  }
  const sub=(a,b,c)=>{const d=a-2*b+c;return d<-.000001?Math.max(-.5,Math.min(.5,.5*(a-c)/d)):0;};
  const at=(x,y)=>scores.get(`${x},${y}`)??scoreAt(x,y);
  return {score:best.score,x:best.x+sub(at(best.x-1,best.y),best.score,at(best.x+1,best.y)),y:best.y+sub(at(best.x,best.y-1),best.score,at(best.x,best.y+1))};
}
function metrics(path,scale=1) {
  const axis=k=>path.map(p=>p[k]*scale), xs=axis(0),ys=axis(1);
  const extent=a=>a.reduce((m,v)=>[Math.min(m[0],v),Math.max(m[1],v)],[Infinity,-Infinity]);
  let energy=0;
  for(let i=0;i<path.length;i++)for(let k=0;k<2;k++){
    let sum=0,count=0;for(let j=Math.max(0,i-12);j<=Math.min(path.length-1,i+12);j++){sum+=path[j][k];count++;}
    energy+=((path[i][k]-sum/count)*scale)**2;
  }
  const xr=extent(xs),yr=extent(ys);
  return {range:Math.max(xr[1]-xr[0],yr[1]-yr[0]),jitter:Math.sqrt(energy/(2*path.length))};
}
function assessment(points,frames,width,height) {
  const reliable=points.filter(p=>p.path.length===frames && p.minScore>=LIMITS.correlation);
  // Find whole-clip motion consensus, not merely agreement on the first frame.
  let group=[];
  for(const seed of reliable){const same=reliable.filter(p=>{
    let err=0;for(let n=0;n<frames;n++){const dx=(p.path[n][0]-p.path[0][0])-(seed.path[n][0]-seed.path[0][0]),dy=(p.path[n][1]-p.path[0][1])-(seed.path[n][1]-seed.path[0][1]);err+=dx*dx+dy*dy;}
    return Math.sqrt(err/frames)*3840/width<LIMITS.agreement;
  });if(same.length>group.length)group=same;}
  const spread=g=>g.some(a=>g.some(b=>Math.hypot((a.x-b.x)/width,(a.y-b.y)/height)>.3));
  // Two lower-confidence but coherent wall/rail matches can justify a retry,
  // never a Passed verdict. Blurred crowd backgrounds often need this fallback.
  let provisional=false;
  if(group.length<LIMITS.minPoints||!spread(group)){
    const possible=points.filter(p=>p.path.length===frames&&p.minScore>=.85);let fallback=[];
    for(const seed of possible){const same=possible.filter(p=>{let err=0;for(let n=0;n<frames;n++){const dx=(p.path[n][0]-p.path[0][0])-(seed.path[n][0]-seed.path[0][0]),dy=(p.path[n][1]-p.path[0][1])-(seed.path[n][1]-seed.path[0][1]);err+=dx*dx+dy*dy;}return Math.sqrt(err/frames)*3840/width<1.5;});if(same.length>fallback.length)fallback=same;}
    if(fallback.length>=2&&spread(fallback)){group=fallback;provisional=true;}
  }
  const separated=spread(group);
  if((group.length<LIMITS.minPoints&&!provisional)||!separated)return {status:'Needs review',reason:'Not enough independent stationary areas agree throughout the shot',score:null,points:group.length,candidates:[]};
  const motion=Array.from({length:frames},(_,n)=>[median(group.map(p=>p.path[n][0]-p.path[0][0])),median(group.map(p=>p.path[n][1]-p.path[0][1]))]);
  for(const p of group){let error=0;for(let n=0;n<frames;n++){error+=((p.path[n][0]-p.path[0][0])-motion[n][0])**2+((p.path[n][1]-p.path[0][1])-motion[n][1])**2;}p.disagreement=error/frames;}
  const m=metrics(motion,3840/width);
  // Require every consensus area to pass, not just their averaged movement.
  const individual=group.map(p=>metrics(p.path,3840/width));
  const range=Math.max(m.range,...individual.map(p=>p.range)),jitter=Math.max(m.jitter,...individual.map(p=>p.jitter));
  const steady=range<=LIMITS.range&&jitter<=LIMITS.jitter,passed=steady&&!provisional;
  return {status:passed?'Passed':steady?'Needs review':'Needs retry',reason:`${group.length} agreeing areas${provisional?' (insufficient confidence to pass)':''}; movement ${range.toFixed(2)} px, jitter ${jitter.toFixed(2)} px (4K equivalent)`,range,jitter,score:Math.max(range/LIMITS.range,jitter/LIMITS.jitter),points:group.length,candidates:group.sort((a,b)=>a.disagreement-b.disagreement||b.texture-a.texture).map(p=>({x:p.x/width,y:1-p.y/height,width:Math.max(.005,80/width),height:Math.max(.005,60/height)}))};
}
class MotionCheck {
  constructor(first,references) {
    this.width=first.width;this.height=first.height;this.frames=0;
    this.points=(references||candidates(first)).map(p=>({...p,template:p.template||patch(first,p.x,p.y),texture:p.texture||patch(first,p.x,p.y).norm,path:[],minScore:1,cx:p.x,cy:p.y}));
  }
  add(frame) {
    if(frame.width!==this.width||frame.height!==this.height)throw Error('Frame dimensions changed during verification');
    for(const p of this.points){const v=match(frame,p.template,p.cx,p.cy);p.cx=v.x;p.cy=v.y;p.minScore=Math.min(p.minScore,v.score);p.path.push([v.x,v.y]);}
    this.frames++;
  }
  result(){this.assessed=assessment(this.points,this.frames,this.width,this.height);return this.assessed;}
  references(){const chosen=this.assessed?.candidates||[];return this.points.filter(p=>chosen.some(a=>Math.abs(a.x-p.x/this.width)<1e-8&&Math.abs(a.y-(1-p.y/this.height))<1e-8)).map(({x,y,texture,template})=>({x,y,texture,template}));}
}
module.exports={MotionCheck,grayFrame,assessment,metrics,candidates,match,patch,LIMITS};
