/** Lightweight visual transition between real weather observations/forecasts.
 * Two canvas layers crossfade for 260 ms; NO meteorological values are
 * interpolated or synthesized. Original frame timestamps stay unchanged.
 */
export function mayBlendWeatherFrames(previousKey,previousScene,nextKey,nextScene,{enabled=true,resized=false}={}){
  return Boolean(enabled&&!resized&&previousKey!==null&&previousKey!==nextKey&&
    previousScene===nextScene&&nextScene!==null);
}
export function createWeatherCrossfade(front,outgoing,{
  durationMs=260,opacity=()=>1,enabled=()=>true,
  requestFrame=callback=>requestAnimationFrame(callback),
  computedOpacity=canvas=>Number(getComputedStyle(canvas).opacity),
}={}){
  let lastFrame=null,lastScene=null,revision=0;
  const scratch=document.createElement('canvas');
  const targetAlpha=()=>Math.min(1,Math.max(0,Number(opacity())||0));
  function stop({forget=true}={}){
    revision++;
    front.style.transition='none';
    front.style.opacity=String(targetAlpha());
    outgoing.style.transition='none';
    outgoing.style.opacity='0';
    outgoing.hidden=true;
    if(forget){lastFrame=null;lastScene=null;}
  }
  function beforeDraw(frameKey,sceneKey,{resized=false}={}){
    const blend=mayBlendWeatherFrames(lastFrame,lastScene,frameKey,sceneKey,{
      resized,enabled:enabled()&&!(
        typeof window.matchMedia==='function'&&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches)
    });
    const token=++revision;
    const alpha=targetAlpha();
    if(blend&&front.width&&front.height){
      // Snapshot the currently visible mixed frame. This avoids a jump when
      // rapid scrubbing interrupts an earlier, unfinished crossfade.
      scratch.width=front.width;scratch.height=front.height;
      const ctx=scratch.getContext('2d');
      ctx.setTransform(1,0,0,1,0,0);
      ctx.clearRect(0,0,scratch.width,scratch.height);
      if(alpha>0){
        ctx.globalAlpha=Math.max(0,Math.min(1,computedOpacity(front)/alpha));
        ctx.drawImage(front,0,0);
        if(!outgoing.hidden&&outgoing.width===front.width&&outgoing.height===front.height){
          ctx.globalAlpha=Math.max(0,Math.min(1,computedOpacity(outgoing)/alpha));
          ctx.drawImage(outgoing,0,0);
        }
        ctx.globalAlpha=1;
      }
      outgoing.width=front.width;outgoing.height=front.height;
      const old=outgoing.getContext('2d');
      old.setTransform(1,0,0,1,0,0);old.drawImage(scratch,0,0);
      front.style.transition='none';outgoing.style.transition='none';
      front.style.opacity='0';
      outgoing.hidden=false;
      outgoing.style.opacity=String(alpha);
      outgoing.dataset.fromFrame=String(lastFrame);
      outgoing.dataset.toFrame=String(frameKey);
    }else{
      front.style.transition='none';
      front.style.opacity=String(alpha);
      outgoing.style.transition='none';
      outgoing.style.opacity='0';
      outgoing.hidden=true;
      delete outgoing.dataset.fromFrame;
      delete outgoing.dataset.toFrame;
    }
    return ()=>{
      if(token!==revision)return;
      lastFrame=frameKey;lastScene=sceneKey;
      front.dataset.weatherFrame=String(frameKey);
      if(!blend)return;
      requestFrame(()=>{
        if(token!==revision)return;
        front.style.transition=`opacity ${durationMs}ms linear`;
        outgoing.style.transition=`opacity ${durationMs}ms linear`;
        front.style.opacity=String(targetAlpha());
        outgoing.style.opacity='0';
      });
    };
  }
  function updateOpacity(){
    const alpha=targetAlpha();
    // Respect the latest slider value while a transition is underway.
    front.style.opacity=String(alpha);
    if(!outgoing.hidden)outgoing.style.opacity='0';
  }
  return {beforeDraw,stop,updateOpacity,get lastFrame(){return lastFrame;},get lastScene(){return lastScene;}};
}
