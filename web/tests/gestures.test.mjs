import test from 'node:test';
import assert from 'node:assert/strict';
import {TOUCH_SLOP,DEFAULT_SWIPE,secondsPerPixel,validSwipeSetting,createScrub,steppedTime} from '../gestures.mjs';

const WEEK=7*86400;
const scrub=(o={})=>createScrub({start:0,min:-1e9,max:1e9,horizontal:60,vertical:600,x:100,y:100,...o});
const drag=(s,points)=>{let t=0;for(const [x,y] of points){t+=16;s.move(x,y,t);}return t;};

test('Defaults swap Flowx: sideways fine (1.2 days per width), vertical coarse (120 % of range)',()=>{
  const h=secondsPerPixel(DEFAULT_SWIPE.horizontal,{rangeSeconds:WEEK,referencePx:412});
  const v=secondsPerPixel(DEFAULT_SWIPE.vertical,{rangeSeconds:WEEK,referencePx:412});
  assert.ok(Math.abs(h/60-4.19)<.01,h/60);
  assert.ok(Math.abs(v/60-29.36)<.01,v/60);
  assert.equal(secondsPerPixel({value:6,unit:'hours'},{rangeSeconds:WEEK,referencePx:360}),60);
  assert.throws(()=>secondsPerPixel({value:0,unit:'days'},{rangeSeconds:WEEK,referencePx:400}));
  assert.ok(validSwipeSetting({value:120,unit:'range'}));
  assert.ok(!validSwipeSetting({value:-1,unit:'days'}));
  assert.ok(!validSwipeSetting({value:1,unit:'weeks'}));
});
test('Nothing moves inside the touch slop; only movement beyond it counts',()=>{
  const s=scrub();
  drag(s,[[103,100],[105,100]]);
  assert.equal(s.time,0);assert.equal(s.active,false);
  drag(s,[[100+TOUCH_SLOP+4,100]]);
  assert.equal(s.time,4*60);
  // One large first move: only the part beyond the 6 px circle counts.
  const big=scrub();drag(big,[[130,100]]);assert.equal(big.time,(30-TOUCH_SLOP)*60);
});
test('Right and up are later; each move counts along its own dominant axis',()=>{
  const r=scrub();drag(r,[[110,100],[150,100]]);assert.equal(r.time,(50-6)*60);
  const u=scrub();drag(u,[[100,90],[100,50]]);assert.equal(u.time,(50-6)*600);
  const d=scrub();drag(d,[[100,110],[100,150]]);assert.equal(d.time,-(50-6)*600);
  // L-shape: 40 px right (fine), then 30 px up (coarse) in one gesture.
  const l=scrub();drag(l,[[110,100],[140,100],[140,85],[140,70]]);
  assert.equal(l.time,(40-6)*60+30*600);
  // An exact diagonal step counts as horizontal.
  const g=scrub();drag(g,[[110,100],[120,90]]);assert.equal(g.time,(10-6)*60+10*60);
});
test('Reversal is continuous and time is clamped to the range',()=>{
  const s=scrub();drag(s,[[110,100],[200,100],[110,100]]);assert.equal(s.time,(10-6)*60);
  const c=scrub({min:-600,max:1200});drag(c,[[110,100],[300,100]]);assert.equal(c.time,1200);
  drag(c,[[0,100]]);assert.equal(c.time,-600);
});
test('Momentum only after a quick release, along the release axis',()=>{
  const slow=scrub();drag(slow,[[110,100],[120,100],[130,100]]);
  assert.equal(slow.release(16*3+5),null);
  const fast=scrub();let t=0;for(const x of [130,160,190,220]){t+=8;fast.move(x,100,t);}
  const m=fast.release(t+1);
  assert.equal(m.axis,'horizontal');assert.ok(m.px>20&&m.px<200,m.px);
  const before=fast.time;fast.applyMomentum(m.axis,m.px);assert.equal(fast.time,before+m.px*60);
  // Lifting long after the last move: no momentum.
  const late=scrub();t=0;for(const x of [130,160,190,220]){t+=8;late.move(x,100,t);}
  assert.equal(late.release(t+200),null);
  assert.equal(scrub().release(10),null,'a tap has no momentum');
});
test('Stepping: whole minutes when smooth, data steps otherwise',()=>{
  assert.equal(steppedTime(1000,'smooth'),1020);
  assert.equal(steppedTime(1000,'data',900),900);
  assert.equal(steppedTime(5400,'data',3600),7200);
});
