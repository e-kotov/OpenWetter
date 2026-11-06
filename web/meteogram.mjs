/* Canvas meteogram graphs in the Flowx style: thin (64 px) strips sharing one
 * 7-day time axis. Each graph type has a list of elements the user can toggle
 * ("Edit graph") and value ranges ("Edit range"). Drawing only; no state.
 */
import {PRESSURE_LEVELS,MODEL_LABELS} from './forecast.mjs';

export const COLORS=Object.freeze({
  bandA:'#ffb600',bandB:'#ffc022',cloud:'#8e8e8e',precip:'#00539a',wind:'#548a20',gust:'#8cb85c',
  tempLine:'#005eac',warmer:'#ffdbcb',colder:'#d4e3ff',grid:'#d3e0ec',plain:'#f4f6f9',axis:'#5c6470',
  freezing:'#9494fd',transition:'#e53935',dayLine:'rgba(0,0,0,.16)',pressure:'#6a3fb0',humidity:'#1f78b4',dew:'#2e9d8f',
});
/** Element ids, labels and defaults per graph type (Flowx "Edit graph"). */
const COMMON=[
  ['timeMarks','Time marks',true],['legend','Legend',true],['yScales','Y scales (end)',true],['yGrid','Y grid',false],
  ['timeGrid','Time grid',true],['transitionLabels','Source transition labels',false],
  ['transitions','Source transitions',true],['warnings','Warnings',true],
];
export const GRAPH_TYPES=Object.freeze({
  everyday:{label:'Everyday',elements:[...COMMON,['gust','Wind gust line',false],['wind','Wind speed line',true],
    ['precip','Precipitation fill',true],['cloudLayers','Cloud layers',true],['bands','Bands',true],
    ['totalCloud','Total cloud fill',false],['background','Background',true]],
    ranges:{cloud:[0,100],precip:[0,4],wind:[0,75]}}, // wind in km/h (≈40 kt)
  temperature:{label:'Temperature',elements:[...COMMON.map(e=>e[0]==='yGrid'||e[0]==='transitionLabels'?[e[0],e[1],true]:e),
    ['levels','Temperature levels',true],['line','Temperature line',true],['delta','Temperature delta',true],
    ['dewPoint','Dew point line',false]],ranges:{temperature:null}},
  wind:{label:'Wind',elements:[...COMMON,['wind','Wind speed line',true],['gust','Wind gust line',true],['arrows','Direction arrows',true]],
    ranges:{wind:[0,75]}},
  pressure:{label:'Pressure',elements:[...COMMON,['line','Pressure line',true]],ranges:{pressure:null}},
  humidity:{label:'Humidity',elements:[...COMMON,['line','Relative humidity line',true],['totalCloud','Total cloud fill',true]],
    ranges:{humidity:[0,100]}},
});
export function defaultGraph(type){
  const t=GRAPH_TYPES[type];if(!t)throw new RangeError('Unknown graph type');
  return {type,elements:Object.fromEntries(t.elements.map(([id,,on])=>[id,on])),ranges:structuredClone(t.ranges)};
}
/** Value range definitions shown in "Edit range" (unit labels are filled in by the app). */
export const RANGE_LABELS=Object.freeze({cloud:'Cloud (%)',precip:'Precipitation (mm/h)',wind:'Wind speed',
  temperature:'Temperature (°C)',pressure:'Pressure (hPa)',humidity:'Relative humidity (%)'});

const finite=v=>typeof v==='number'&&Number.isFinite(v);
/** Smooth polyline through points (Catmull-Rom as Bezier); gaps (null) split it. */
function smoothPath(ctx,points,{move=true}={}){
  if(!points.length)return;
  if(move)ctx.moveTo(points[0][0],points[0][1]);else ctx.lineTo(points[0][0],points[0][1]);
  for(let i=0;i<points.length-1;i++){
    const p0=points[i-1]||points[i],p1=points[i],p2=points[i+1],p3=points[i+2]||p2;
    ctx.bezierCurveTo(p1[0]+(p2[0]-p0[0])/6,p1[1]+(p2[1]-p0[1])/6,p2[0]-(p3[0]-p1[0])/6,p2[1]-(p3[1]-p1[1])/6,p2[0],p2[1]);
  }
}
function runs(times,values,x,y){
  const out=[];let cur=[];
  times.forEach((t,i)=>{const v=values[i];if(finite(v)){cur.push([x(t),y(v),t,v]);}else if(cur.length){out.push(cur);cur=[];}});
  if(cur.length)out.push(cur);return out;
}
/** Three ticks lo, lo+step, lo+2*step covering [min,max] with a "nice" step
 * (Flowx-like 0 / 6 / 12). */
function niceTicks(min,max){
  const span=Math.max(1e-6,max-min),mag=10**Math.floor(Math.log10(span/2));
  for(const m of [1,2,3,4,5,6,8,10,12,15,20,25,30,40,50,60,80,100]){
    const step=m*mag,half=step/2,lo=Math.floor(min/half+1e-9)*half;
    if(lo+2*step>=max-1e-9){const r=v=>Math.round(v*1e6)/1e6;return {min:r(lo),max:r(lo+2*step),ticks:[r(lo),r(lo+step),r(lo+2*step)]};}
  }
  return {min,max,ticks:[min,(min+max)/2,max]};
}
/** Common geometry for one graph strip. */
function frame(ctx,w,h,view){
  const span=view.end-view.start;
  return {x:t=>(t-view.start)/span*w,w,h,ctx};
}
function inView(f,view){
  const i0=Math.max(0,f.time.findIndex(t=>t>=view.start-3600)),i1=f.time.findLastIndex(t=>t<=view.end+3600);
  return {time:f.time.slice(i0,i1+1),get:k=>(f.series[k]||[]).slice(i0,i1+1),source:f.source.slice(i0,i1+1)};
}
function drawTimeGrid(g,days,el,{line=COLORS.dayLine,ticks=true}={}){
  const {ctx,x,w,h}=g;
  if(el.timeGrid){ctx.strokeStyle=line;ctx.lineWidth=1;
    for(const d of days.slice(1)){const xx=Math.round(x(d.start))+.5;ctx.beginPath();ctx.moveTo(xx,0);ctx.lineTo(xx,h);ctx.stroke();}}
  if(el.timeMarks&&ticks){ctx.strokeStyle=line;ctx.lineWidth=1;
    for(const d of days)for(let k=1;k<4;k++){const xx=Math.round(x(d.start+k*(d.end-d.start)/4))+.5;
      if(xx<0||xx>w)continue;ctx.beginPath();ctx.moveTo(xx,0);ctx.lineTo(xx,4);ctx.moveTo(xx,h-4);ctx.lineTo(xx,h);ctx.stroke();}}
}
function drawYScale(g,ticks,scale,el,format=v=>String(Math.round(v))){
  const {ctx,w,h}=g;
  if(el.yGrid){ctx.strokeStyle=COLORS.grid;ctx.lineWidth=1;
    for(const v of ticks){const y=Math.round(scale(v))+.5;if(y<1||y>h-1)continue;ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(w,y);ctx.stroke();}}
  if(el.yScales){ctx.font='10px system-ui,sans-serif';ctx.textAlign='right';ctx.fillStyle=COLORS.axis;
    for(const v of ticks){const y=clampY(scale(v),h);ctx.textBaseline=y<8?'top':y>h-8?'bottom':'middle';ctx.fillText(format(v),w-2,y);}}
}
const clampY=(y,h)=>Math.max(0,Math.min(h,y));
function drawTransitions(g,f,view,el){
  if(!el.transitions)return;
  const {ctx,x,h}=g;
  for(const tr of f.transitions){
    if(tr.time<=view.start||tr.time>=view.end)continue;
    const xx=Math.round(x(tr.time))+.5;
    ctx.strokeStyle=COLORS.transition;ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(xx,0);ctx.lineTo(xx,h);ctx.stroke();
    if(el.transitionLabels){ctx.font='9px system-ui,sans-serif';ctx.fillStyle='#8a8f98';ctx.textBaseline='top';
      ctx.textAlign='right';ctx.fillText(MODEL_LABELS[tr.from].replace('ICON-',''),xx-2,2);
      ctx.textAlign='left';ctx.fillText(MODEL_LABELS[tr.to].replace('ICON-',''),xx+2,2);}
  }
}
function drawWarnings(g,warnings,el){
  if(!el.warnings||!warnings?.length)return;
  const {ctx,x,w}=g;
  for(const wn of warnings){
    const a=Math.max(0,x(wn.start)),b=Math.min(w,x(wn.end));if(b<=a)continue;
    ctx.fillStyle=`rgb(${wn.color.join(',')})`;ctx.fillRect(a,0,b-a,3);
  }
}
/* ---------- legend glyphs (top right, left of the y scale) ---------- */
function glyph(ctx,kind,cx,cy){
  ctx.save();ctx.translate(cx,cy);ctx.lineWidth=1.3;ctx.lineCap='round';
  if(kind==='cloud'||kind==='rain'){
    ctx.fillStyle=kind==='rain'?'#ffffff':'#ffffff';ctx.strokeStyle=kind==='rain'?COLORS.precip:'#6f6f6f';
    ctx.beginPath();ctx.arc(-3,1,3,Math.PI*.5,Math.PI*1.5);ctx.arc(0,-2,3.6,Math.PI,0);ctx.arc(3.5,1,3,Math.PI*1.5,Math.PI*.5);ctx.closePath();ctx.fill();ctx.stroke();
    if(kind==='rain'){for(const dx of [-3,0,3]){ctx.beginPath();ctx.moveTo(dx,5.5);ctx.lineTo(dx-1.2,8);ctx.stroke();}}
  }else if(kind==='wind'){
    ctx.strokeStyle=COLORS.wind;ctx.fillStyle=COLORS.wind;
    for(let k=0;k<3;k++){ctx.rotate(Math.PI*2/3);ctx.beginPath();ctx.ellipse(0,-3.4,1.6,3.4,0,0,Math.PI*2);ctx.fill();}
  }else if(kind==='thermo'||kind==='warmer'||kind==='colder'){
    ctx.strokeStyle=COLORS.tempLine;ctx.fillStyle=kind==='thermo'?COLORS.tempLine:'#ffffff';
    ctx.beginPath();ctx.moveTo(-1.4,3);ctx.lineTo(-1.4,-6);ctx.arc(0,-6,1.4,Math.PI,0);ctx.lineTo(1.4,3);ctx.stroke();
    ctx.beginPath();ctx.arc(0,5,2.6,0,Math.PI*2);ctx.fill();ctx.stroke();
    if(kind!=='thermo'){ctx.fillStyle='#333';ctx.beginPath();
      if(kind==='warmer'){ctx.moveTo(4,-5);ctx.lineTo(8,-5);ctx.lineTo(6,-8);}else{ctx.moveTo(4,-8);ctx.lineTo(8,-8);ctx.lineTo(6,-5);}
      ctx.fill();}
  }else if(kind==='line'){ctx.strokeStyle=arguments[4]||'#333';ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(-5,0);ctx.lineTo(5,0);ctx.stroke();}
  ctx.restore();
}
function drawLegend(g,items,el){
  if(!el.legend||!items.length)return;
  const {ctx,w}=g;let cx=w-(el.yScales?26:10);
  for(const [kind,color] of [...items].reverse()){glyph(ctx,kind,cx,10,color);cx-=18;}
}
/* ---------- graph types ---------- */
function drawEveryday(g,f,view,days,cfg,ctxInfo){
  const {ctx,x,w,h}=g,el=cfg.elements,r=cfg.ranges,d=inView(f,view);
  if(el.background){
    if(el.bands){const band=h/4;for(let i=0;i<4;i++){ctx.fillStyle=i%2?COLORS.bandB:COLORS.bandA;ctx.fillRect(0,Math.round(i*band),w,Math.ceil(band));}}
    else{ctx.fillStyle=COLORS.bandB;ctx.fillRect(0,0,w,h);}
  }else{ctx.fillStyle='#ffffff';ctx.fillRect(0,0,w,h);}
  ctx.fillStyle=COLORS.cloud;
  if(el.totalCloud){
    const [c0,c1]=r.cloud||[0,100];
    for(const run of runs(d.time,d.get('cloud_cover'),x,v=>Math.max(0,Math.min(1,(v-c0)/(c1-c0)))*h)){
      ctx.beginPath();ctx.moveTo(run[0][0],0);smoothPath(ctx,run,{move:false});ctx.lineTo(run.at(-1)[0],0);ctx.closePath();ctx.globalAlpha=.55;ctx.fill();ctx.globalAlpha=1;
    }
  }
  if(el.cloudLayers){
    // One lens-shaped band per pressure level, thickness ∝ cloud cover there;
    // neighbouring levels merge into deep cloud. Low levels at the bottom.
    const n=PRESSURE_LEVELS.length,top=h*.06,bottom=h*.94,spacing=(bottom-top)/(n-1);
    const yOf=p=>bottom-Math.log(1000/p)/Math.log(1000/PRESSURE_LEVELS.at(-1))*(bottom-top);
    for(const p of PRESSURE_LEVELS){
      const cy=yOf(p),values=d.get(`cloud_cover_${p}hPa`);
      for(const run of runs(d.time,values,x,()=>cy)){
        const half=run.map(([xx,,t,v])=>[xx,v/100*spacing*1.05]);
        if(half.every(([,hh])=>hh<.35))continue;
        ctx.beginPath();smoothPath(ctx,half.map(([xx,hh])=>[xx,cy-hh]));
        smoothPath(ctx,[...half].reverse().map(([xx,hh])=>[xx,cy+hh]),{move:false});ctx.closePath();ctx.fill();
      }
    }
  }
  if(el.precip){
    const [p0,p1]=r.precip||[0,4];
    ctx.fillStyle=COLORS.precip;
    for(const run of runs(d.time,d.get('precipitation'),x,v=>h-Math.max(0,Math.min(1,(v-p0)/(p1-p0)))*h)){
      if(run.every(p=>p[3]<=0))continue;
      ctx.beginPath();ctx.moveTo(run[0][0],h);smoothPath(ctx,run.map(p=>[p[0],Math.min(h,p[1])]),{move:false});
      ctx.lineTo(run.at(-1)[0],h);ctx.closePath();ctx.fill();
    }
  }
  const [w0,w1]=r.wind||[0,75],ws=v=>h-(v-w0)/(w1-w0)*h;
  const line=(key,color,dash)=>{ctx.strokeStyle=color;ctx.lineWidth=1.4;ctx.setLineDash(dash);
    for(const run of runs(d.time,d.get(key),x,v=>clampY(ws(v),h))){ctx.beginPath();smoothPath(ctx,run);ctx.stroke();}
    ctx.setLineDash([]);};
  if(el.gust)line('wind_gusts_10m',COLORS.gust,[3,2]);
  if(el.wind)line('wind_speed_10m',COLORS.wind,[]);
  drawTimeGrid(g,days,el);
  drawTransitions(g,f,view,el);
  drawWarnings(g,ctxInfo.warnings,el);
  drawYScale(g,[w0,(w0+w1)/2,w1],ws,el,v=>String(Math.round(ctxInfo.wind(v))));
  drawLegend(g,[el.cloudLayers||el.totalCloud?['cloud']:null,el.precip?['rain']:null,el.wind||el.gust?['wind']:null].filter(Boolean),el);
}
function autoRange(values,pad=.08,minSpan=2){
  const v=values.filter(finite);if(!v.length)return [0,1];
  let a=Math.min(...v),b=Math.max(...v);if(b-a<minSpan){const m=(a+b)/2;a=m-minSpan/2;b=m+minSpan/2;}
  const p=(b-a)*pad;return [a-p,b+p];
}
function lineGraph(g,f,view,days,cfg,{key,color,unitValue=v=>v,range,legend,format,bg=COLORS.plain,extra}){
  const {ctx,x,w,h}=g,el=cfg.elements,d=inView(f,view);
  ctx.fillStyle=bg;ctx.fillRect(0,0,w,h);
  const values=d.get(key).map(v=>finite(v)?unitValue(v):null);
  const [a,b]=range||autoRange(values);
  const nt=niceTicks(a,b),lo=range?a:nt.min,hi=range?b:nt.max,scale=v=>h-1-(v-lo)/(hi-lo)*(h-2);
  drawTimeGrid(g,days,el,{line:COLORS.grid});
  drawYScale(g,range?[lo,(lo+hi)/2,hi]:nt.ticks,scale,el,format);
  extra?.({d,scale,lo,hi});
  if(cfg.elements.line!==false){ctx.strokeStyle=color;ctx.lineWidth=1.5;
    for(const run of runs(d.time,values,x,scale)){ctx.beginPath();smoothPath(ctx,run);ctx.stroke();}}
  drawTransitions(g,f,view,el);drawWarnings(g,ctxInfo0(cfg),el);
  drawLegend(g,legend,el);
}
const ctxInfo0=cfg=>cfg._warnings;
function drawTemperature(g,f,view,days,cfg,info){
  const {ctx,x,w,h}=g,el=cfg.elements,d=inView(f,view);
  const temp=d.get('temperature_2m').map(v=>finite(v)?info.temp(v):null);
  const prev=d.get('previous_temperature_2m').map(v=>finite(v)?info.temp(v):null);
  const dew=d.get('dew_point_2m').map(v=>finite(v)?info.temp(v):null);
  const all=[...temp,...(el.delta?prev:[]),...(el.dewPoint?dew:[])];
  const fixed=cfg.ranges.temperature;
  const nt=niceTicks(...(fixed||autoRange(all,0,3))),lo=fixed?fixed[0]:nt.min,hi=fixed?fixed[1]:nt.max;
  const scale=v=>h-1-(v-lo)/(hi-lo)*(h-2);
  ctx.fillStyle=COLORS.plain;ctx.fillRect(0,0,w,h);
  drawTimeGrid(g,days,el,{line:COLORS.grid});
  drawYScale(g,fixed?[lo,(lo+hi)/2,hi]:nt.ticks,scale,el);
  if(el.delta){
    // Fill between this run and yesterday's run: blue where colder now, orange where warmer.
    for(let i=0;i<d.time.length-1;i++){
      const t0=temp[i],t1=temp[i+1],p0=prev[i],p1=prev[i+1];
      if(![t0,t1,p0,p1].every(finite))continue;
      const x0=x(d.time[i]),x1=x(d.time[i+1]),d0=t0-p0,d1=t1-p1;
      const seg=(xa,xb,ta,tb,pa,pb,colder)=>{ctx.fillStyle=colder?COLORS.colder:COLORS.warmer;ctx.beginPath();
        ctx.moveTo(xa,scale(ta));ctx.lineTo(xb,scale(tb));ctx.lineTo(xb,scale(pb));ctx.lineTo(xa,scale(pa));ctx.closePath();ctx.fill();};
      if(d0*d1>=0)seg(x0,x1,t0,t1,p0,p1,d0+d1<0);
      else{const f0=d0/(d0-d1),xm=x0+(x1-x0)*f0,tm=t0+(t1-t0)*f0;seg(x0,xm,t0,tm,p0,tm,d0<0);seg(xm,x1,tm,t1,tm,p1,d1<0);}
    }
  }
  if(el.levels){const zero=info.temp(0);if(zero>lo&&zero<hi){ctx.strokeStyle=COLORS.freezing;ctx.lineWidth=1;
    const y=Math.round(scale(zero))+.5;ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(w,y);ctx.stroke();}}
  if(el.dewPoint){ctx.strokeStyle=COLORS.dew;ctx.lineWidth=1.2;for(const run of runs(d.time,dew,x,scale)){ctx.beginPath();smoothPath(ctx,run);ctx.stroke();}}
  if(el.line){ctx.strokeStyle=COLORS.tempLine;ctx.lineWidth=1.5;for(const run of runs(d.time,temp,x,scale)){ctx.beginPath();smoothPath(ctx,run);ctx.stroke();}}
  drawTransitions(g,f,view,el);drawWarnings(g,info.warnings,el);
  drawLegend(g,[el.delta?['colder']:null,el.delta?['warmer']:null,el.line?['thermo']:null].filter(Boolean),el);
}
function drawWind(g,f,view,days,cfg,info){
  const {ctx,x,w,h}=g,el=cfg.elements,d=inView(f,view);
  const [w0,w1]=cfg.ranges.wind||[0,75],scale=v=>h-1-(v-w0)/(w1-w0)*(h-2);
  ctx.fillStyle=COLORS.plain;ctx.fillRect(0,0,w,h);
  drawTimeGrid(g,days,el,{line:COLORS.grid});drawYScale(g,[w0,(w0+w1)/2,w1],scale,el,v=>String(Math.round(info.wind(v))));
  if(el.gust){ctx.strokeStyle=COLORS.gust;ctx.setLineDash([3,2]);ctx.lineWidth=1.3;for(const run of runs(d.time,d.get('wind_gusts_10m'),x,v=>clampY(scale(v),h))){ctx.beginPath();smoothPath(ctx,run);ctx.stroke();}ctx.setLineDash([]);}
  if(el.wind){ctx.strokeStyle=COLORS.wind;ctx.lineWidth=1.5;for(const run of runs(d.time,d.get('wind_speed_10m'),x,v=>clampY(scale(v),h))){ctx.beginPath();smoothPath(ctx,run);ctx.stroke();}}
  if(el.arrows){const dir=d.get('wind_direction_10m');ctx.strokeStyle='#33465c';ctx.lineWidth=1.2;
    d.time.forEach((t,i)=>{if(t%(3*3600)!==0||!finite(dir[i]))return;const xx=x(t);if(xx<4||xx>w-30)return;
      ctx.save();ctx.translate(xx,h-8);ctx.rotate((dir[i]+180)*Math.PI/180);ctx.beginPath();ctx.moveTo(0,4);ctx.lineTo(0,-4);ctx.moveTo(-2.5,-1.5);ctx.lineTo(0,-4);ctx.lineTo(2.5,-1.5);ctx.stroke();ctx.restore();});}
  drawTransitions(g,f,view,el);drawWarnings(g,info.warnings,el);
  drawLegend(g,[el.wind||el.gust?['wind']:null].filter(Boolean),el);
}
/** Draw one graph into a canvas sized to its CSS box. */
export function drawGraph(canvas,cfg,forecast,view,days,info){
  const r=canvas.getBoundingClientRect(),dpr=Math.min(3,window.devicePixelRatio||1);
  const W=Math.max(1,Math.round(r.width*dpr)),H=Math.max(1,Math.round(r.height*dpr));
  if(canvas.width!==W||canvas.height!==H){canvas.width=W;canvas.height=H;}
  const ctx=canvas.getContext('2d');ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,r.width,r.height);
  const g=frame(ctx,r.width,r.height,view);
  if(!forecast){ctx.fillStyle=COLORS.plain;ctx.fillRect(0,0,r.width,r.height);
    ctx.fillStyle=COLORS.axis;ctx.font='11px system-ui,sans-serif';ctx.textAlign='center';ctx.textBaseline='middle';
    ctx.fillText(info.message||'Loading forecast…',r.width/2,r.height/2);return;}
  cfg._warnings=info.warnings;
  if(cfg.type==='everyday')drawEveryday(g,forecast,view,days,cfg,info);
  else if(cfg.type==='temperature')drawTemperature(g,forecast,view,days,cfg,info);
  else if(cfg.type==='wind')drawWind(g,forecast,view,days,cfg,info);
  else if(cfg.type==='pressure')lineGraph(g,forecast,view,days,cfg,{key:'pressure_msl',color:COLORS.pressure,
    range:cfg.ranges.pressure,legend:[['line',COLORS.pressure]]});
  else if(cfg.type==='humidity')lineGraph(g,forecast,view,days,cfg,{key:'relative_humidity_2m',color:COLORS.humidity,
    range:cfg.ranges.humidity||[0,100],legend:[['line',COLORS.humidity]],
    extra:({d})=>{if(!cfg.elements.totalCloud)return;ctx.fillStyle='rgba(142,142,142,.35)';
      for(const run of runs(d.time,d.get('cloud_cover'),g.x,v=>r.height-v/100*r.height)){ctx.beginPath();ctx.moveTo(run[0][0],r.height);
        smoothPath(ctx,run,{move:false});ctx.lineTo(run.at(-1)[0],r.height);ctx.closePath();ctx.fill();}}});
  delete cfg._warnings;
}
