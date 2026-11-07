/* One-finger time scrubbing, modelled on the measured Flowx behaviour:
 * - a touch slop (6 px) before anything moves; the slop distance is not counted;
 * - every move event counts along its own dominant axis (|dx| >= |dy| is
 *   horizontal), so one gesture can scrub coarse and then fine;
 * - right = later, up = later;
 * - a quick release adds a short momentum run.
 * Pure logic: no DOM, unit-tested in tests/gestures.test.mjs.
 */
export const TOUCH_SLOP=6;
export const SPEED_UNITS=Object.freeze(['range','days','hours']);
/** OpenWetter defaults: Flowx's two speeds swapped, so sideways is the fine
 * direction (1.2 days per full-width swipe) and vertical the coarse one
 * (120 % of the 7-day range per full-width swipe). */
export const DEFAULT_SWIPE=Object.freeze({
  horizontal:Object.freeze({value:1.2,unit:'days'}),
  vertical:Object.freeze({value:120,unit:'range'}),
  stepping:'smooth',
});
/** Seconds of forecast time per screen pixel for one speed setting. A "full
 * swipe" is the reference length (the map width). */
export function secondsPerPixel(setting,{rangeSeconds,referencePx}){
  if(!setting||!SPEED_UNITS.includes(setting.unit)||!(setting.value>0))throw new RangeError('Invalid swipe speed');
  if(!(rangeSeconds>0)||!(referencePx>0))throw new RangeError('Invalid swipe reference');
  const span=setting.unit==='range'?rangeSeconds*setting.value/100:
    setting.unit==='days'?setting.value*86400:setting.value*3600;
  return span/referencePx;
}
export function validSwipeSetting(s){
  return Boolean(s&&SPEED_UNITS.includes(s.unit)&&Number.isFinite(s.value)&&s.value>0&&
    s.value<=(s.unit==='range'?1000:s.unit==='days'?30:720));
}
const clamp=(v,a,b)=>Math.min(b,Math.max(a,v));
/**
 * Scrub state machine. `move` takes absolute pointer positions and returns the
 * new time; `release` returns the momentum (in px along one axis) still to be
 * applied, which the caller animates with `applyMomentum`.
 */
export function createScrub({start,min,max,horizontal,vertical,slop=TOUCH_SLOP,x,y,t=0}){
  if(![start,min,max,horizontal,vertical,x,y].every(Number.isFinite)||max<min)throw new RangeError('Invalid scrub');
  let time=clamp(start,min,max),lastX=x,lastY=y,active=false;
  const samples=[{x,y,t}];
  function step(dx,dy){
    if(Math.abs(dx)>=Math.abs(dy))time+=dx*horizontal;
    else time-=dy*vertical;
    time=clamp(time,min,max);
  }
  return {
    get time(){return time;},
    get active(){return active;},
    move(nx,ny,nt=0){
      samples.push({x:nx,y:ny,t:nt});
      while(samples.length>2&&nt-samples[0].t>100)samples.shift();
      if(!active){
        const dist=Math.hypot(nx-x,ny-y);
        if(dist<slop)return time;
        // Count movement beyond the slop circle only.
        active=true;lastX=x+(nx-x)*slop/dist;lastY=y+(ny-y)*slop/dist;
      }
      step(nx-lastX,ny-lastY);lastX=nx;lastY=ny;
      return time;
    },
    /** Momentum after a quick release: px along the release's dominant axis. */
    release(nt=0){
      if(!active)return null;
      const first=samples.find(s=>nt-s.t<=100)||samples[0],last=samples.at(-1);
      const dt=Math.max(1,(last.t-first.t)||0);
      const vx=(last.x-first.x)/dt,vy=(last.y-first.y)/dt;
      const horizontalAxis=Math.abs(vx)>=Math.abs(vy),v=horizontalAxis?vx:vy;
      const speed=Math.abs(v);
      // Fitted to Flowx: ~1.1 px/ms adds ~5 px, ~2.3 px/ms adds ~30 px.
      if(speed<0.85||nt-last.t>60)return null;
      const px=Math.sign(v)*Math.min(200,20*(speed-0.85));
      return {axis:horizontalAxis?'horizontal':'vertical',px};
    },
    applyMomentum(axis,px){
      if(axis==='horizontal')step(px,0);else step(0,px);
      return time;
    },
  };
}
/** Round a scrubbed time for display/lookup: whole minutes when smooth,
 * otherwise the data step (e.g. 15 min or 1 h). */
export function steppedTime(time,stepping,dataStep=3600){
  const step=stepping==='smooth'?60:dataStep;
  return Math.round(time/step)*step;
}
