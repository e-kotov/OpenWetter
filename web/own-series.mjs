/* Point series from OpenWetter's own ICON tiles, so the graphs show the same
 * model values as the map. The publisher writes one gzip block per 32 x 32
 * grid cells with every layer and frame (the same 8-bit codes as the map
 * tiles). Here one place's values are read and turned into the hourly shape
 * of the Open-Meteo forecast: rain and snow as the amount of the preceding
 * hour, other values interpolated to the hour. Pure logic apart from
 * `loadOwnSeries`.
 */
import {cellAt,decodeCode} from './tile-service.mjs';

/** Tile layer -> forecast series key (Open-Meteo names, as the graphs use). */
export const SERIES_KEYS=Object.freeze({precip:'precipitation',snow:'snowfall',cloud_total:'cloud_cover',
  cloud_low:'cloud_cover_low',cloud_mid:'cloud_cover_mid',cloud_high:'cloud_cover_high',temperature:'temperature_2m',
  dew_point:'dew_point_2m',humidity:'relative_humidity_2m',pressure:'pressure_msl',wind_speed:'wind_speed_10m',
  wind_gust:'wind_gusts_10m',wind_direction:'wind_direction_10m'});
// Units as Open-Meteo: km/h for wind; snowfall in cm from mm of water (Open-Meteo's factor 0.7).
const CONVERT={wind_speed:v=>v*3.6,wind_gust:v=>v*3.6,snow:v=>v*0.7};
const AMOUNTS=new Set(['precip','snow']);

/** The series block holding a place, and the place's offset inside it. */
export function seriesBlock(manifest,lat,lon){
  const s=manifest?.series;if(!s||!manifest.dir)return null;
  const cell=cellAt(manifest.grid,lat,lon);if(!cell)return null;
  const bx=Math.floor(cell.col/s.tile),by=Math.floor(cell.row/s.tile);
  if(!s.tiles.has(bx+'_'+by))return null;
  const w=Math.min(s.tile,manifest.grid.width-bx*s.tile),h=Math.min(s.tile,manifest.grid.height-by*s.tile);
  return {url:manifest.dir+s.path.replace('{x}',bx).replace('{y}',by),offset:(cell.row-by*s.tile)*w+(cell.col-bx*s.tile),w,h};
}
/** One place's values per layer from an uncompressed block: times, values
 * (physical units as the graphs use) and the seconds each frame covers. */
export function readPointSeries(manifest,bytes,block){
  const s=manifest.series,plane=block.w*block.h;
  if(bytes.length!==s.layers.reduce((n,l)=>n+l.frames*plane,0))throw new Error('Series block size mismatch');
  const out={};let o=0;
  for(const l of s.layers){
    const values=new Array(l.frames);
    for(let f=0;f<l.frames;f++){
      const v=decodeCode(l.name,bytes[o+f*plane+block.offset]);
      values[f]=v==null?null:CONVERT[l.name]?CONVERT[l.name](v):v;
    }
    o+=l.frames*plane;
    const periods=l.times.map((t,i)=>i?t-l.times[i-1]:Math.min(l.step,t-manifest.runTime));
    out[l.name]={times:l.times,values,periods};
  }
  return out;
}
/** Amount over (a, b] from per-hour rates of frames covering (t - period, t]; null unless fully covered. */
function amount(L,a,b){
  let sum=0,covered=0;
  for(let i=0;i<L.times.length;i++){
    const end=L.times[i],overlap=Math.min(b,end)-Math.max(a,end-L.periods[i]);
    if(overlap<=0)continue;
    if(L.values[i]==null)return null;
    sum+=L.values[i]*overlap/3600;covered+=overlap;
  }
  return covered>=b-a-1?sum:null;
}
/** Value at instant T, interpolated between the frames around it. */
function instant(L,T,angle){
  const t=L.times;
  if(!t.length||T<t[0]||T>t.at(-1))return null;
  let i=0;while(i<t.length-1&&t[i+1]<T)i++;
  if(t[i]===T)return L.values[i];
  const a=L.values[i],b=L.values[i+1];if(a==null||b==null)return null;
  const f=(T-t[i])/(t[i+1]-t[i]);
  if(angle){const d=((b-a+540)%360)-180;return (a+d*f+360)%360;}
  return a+(b-a)*f;
}
/** Hourly series on the forecast's time axis (Open-Meteo hour stamps). */
export function toHourly(layers,hours){
  const out={};
  for(const [name,L] of Object.entries(layers)){
    const key=SERIES_KEYS[name];if(!key)continue;
    out[key]=hours.map(T=>AMOUNTS.has(name)?amount(L,T-3600,T):instant(L,T,name==='wind_direction'));
  }
  return out;
}
/** Replace the forecast's values with own-model ones where they exist, finest
 * model first (list order). Hours without own data (the past, beyond the
 * last run, hours before the finest own model starts) keep the Open-Meteo
 * values; variables the tiles lack (cloud by height) too. Returns a new forecast; `own[i]` marks the replaced hours. */
export function applyOwnSeries(forecast,list){
  if(!forecast||!list?.length)return forecast;
  const n=forecast.time.length,series={...forecast.series},models={...forecast.models};
  for(const k of Object.keys(series))series[k]=[...series[k]];
  const source=[...forecast.source],own=Array(n).fill(null);
  // Before the finest own model starts (the past), coarser own runs would
  // replace finer Open-Meteo hours; keep those as they are.
  const start=list[0].hourly.temperature_2m?.findIndex(v=>v!=null)??-1;
  for(let i=Math.max(0,start);i<n;i++){
    const m=list.find(x=>x.hourly.temperature_2m?.[i]!=null);
    if(!m)continue;
    own[i]=m.model;source[i]=m.model;
    for(const [k,v] of Object.entries(m.hourly)){if(v[i]==null)continue;(series[k]??=Array(n).fill(null))[i]=v[i];}
  }
  for(const m of list){
    const base=models[m.model]?{...models[m.model]}:{};
    for(const [k,v] of Object.entries(m.hourly)){const arr=[...(base[k]||Array(n).fill(null))];v.forEach((x,i)=>{if(x!=null)arr[i]=x;});base[k]=arr;}
    models[m.model]=base;
  }
  const transitions=[];
  for(let i=1;i<n;i++)if(source[i]&&source[i-1]&&source[i]!==source[i-1])transitions.push({time:forecast.time[i],from:source[i-1],to:source[i]});
  return {...forecast,series,models,source,transitions,own};
}

/* ---------- browser: download one block per model ---------- */
async function gunzip(buffer){
  const stream=new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
/** Own hourly series of every manifest (finest first) for a place. `get`
 * fetches an immutable URL as an ArrayBuffer (cached by the caller). */
export async function loadOwnSeries(manifests,place,hours,get){
  const out=[];
  for(const m of manifests){
    const block=seriesBlock(m,place.latitude,place.longitude);if(!block)continue;
    try{
      const bytes=await gunzip(await get(block.url));
      out.push({model:m.model||'icon_d2',run:m.run,hourly:toHourly(readPointSeries(m,bytes,block),hours)});
    }catch{/* this model falls back to Open-Meteo */}
  }
  return out;
}
