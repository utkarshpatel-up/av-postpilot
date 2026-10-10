const fs=require('fs');
const path=require('path');
const {grayFrame}=require('./stabilization-quality');
// Reads a few timeline frames (on the timeline copy) as gray bitmaps.
function createFrameGrabber({bridge,nativeImage,directory}) {
  return async function grab(clip,frames) {
    fs.mkdirSync(directory,{recursive:true});
    const file=path.join(directory,'frame.png');const out=[];
    try {
      for(const frame of frames) {
        // Remove the preceding frame so a failed export cannot reuse stale pixels.
        fs.rmSync(file,{force:true});
        const result=await bridge.stabilize({action:'frame',key:clip.key,frame,file});
        if(!result.ok)throw Error(result.error);
        const image=nativeImage.createFromPath(file);
        if(image.isEmpty())throw Error('Resolve returned an empty frame');
        const {width,height}=image.getSize();out.push(grayFrame(image.toBitmap(),width,height));
      }
      return out;
    } finally {fs.rmSync(file,{force:true});}
  };
}
module.exports={createFrameGrabber};
