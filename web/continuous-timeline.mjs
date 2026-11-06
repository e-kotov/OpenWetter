/** A single source-labelled playback sequence built ONLY from real published
 * timestamps: observed radar, then the radar-based nowcast, then the model.
 * Index spacing is visual, not a claim of equally spaced observation times.
 * Missing scans are never synthesized; each later source starts strictly
 * after the previous one ends, and forecast slots start at/after now.
 */
export function continuousWeatherTimeline(radarFrames,{
  historyHours=6, now=Date.now()/1000, start=Infinity, end=-Infinity, step=900,
  nowcastFrames=[],
}={}){
  if(!Number.isFinite(now)||!Number.isFinite(historyHours)||historyHours<=0||
    !Number.isFinite(step)||step<300)throw new RangeError('Invalid weather timeline');
  const clean=list=>{
    const seen=new Set();
    return (Array.isArray(list)?list:[]).filter(f=>Number.isSafeInteger(f?.time))
      .sort((a,b)=>a.time-b.time)
      .filter(f=>{if(seen.has(f.time))return false;seen.add(f.time);return true;});
  };
  const available=clean(radarFrames).filter(f=>f.time<=now+300);
  const newest=available.at(-1)?.time;
  const observed=available.filter(f=>f.time>=newest-historyHours*3600)
    .map(f=>({kind:'radar',time:f.time}));
  const frames=[...observed];
  const nowcast=clean(nowcastFrames).filter(f=>newest==null||f.time>newest)
    .map(f=>({kind:'nowcast',time:f.time}));
  frames.push(...nowcast);
  const lastObservedOrNowcast=frames.at(-1)?.time;
  if(Number.isFinite(start)&&Number.isFinite(end)&&end>=start){
    const first=Math.ceil(Math.max(start,now,lastObservedOrNowcast==null?-Infinity:lastObservedOrNowcast+1)/step)*step;
    for(let time=first;time<=end;time+=step)
      frames.push({kind:'forecast',time});
  }
  return frames;
}
/** Retain the same published observation/forecast cursor across data refreshes. */
export function continuousCursorIndex(frames,cursor){
  if(!frames.length)return -1;
  if(!cursor)return Math.max(0,frames.findLastIndex(f=>f.kind==='radar'));
  const exact=frames.findIndex(f=>f.kind===cursor.kind&&f.time===cursor.time);
  if(exact>=0)return exact;
  let best=0,distance=Infinity;
  for(let i=0;i<frames.length;i++){
    const priority=frames[i].kind===cursor.kind?0:1e9;
    const next=Math.abs(frames[i].time-cursor.time)+priority;
    if(next<distance){distance=next;best=i;}
  }
  return best;
}
