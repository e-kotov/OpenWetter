/** Native-derived DWD ICON-D2 model and DWD RY observed radar data.
 * Raster display pixel size oversamples the original ~2 km ICON mesh and 1 km
 * radar. It does NOT increase meteorological model resolution or fidelity.
 */
import {mercator,unmercator,nearestIndex} from './logic.mjs';
import {weatherDiskCache} from './frame-cache.mjs';

export const ICON_BASE='https://raw.githubusercontent.com/e-kotov/OpenWetter/icon-data/';
export const RADAR_BASE='https://raw.githubusercontent.com/e-kotov/OpenWetter/radar-data/';
const MAX_ICON_FRAMES=7;
const MAX_RADAR_FRAMES=8;
const caches={icon:new Map(),radar:new Map()};
const pending=new Map();
const pendingCompressed=new Map();
const canvasCache=new WeakMap();

export function parseNativeManifest(data,kind){
  if(!data || !['icon','radar'].includes(kind) || !Number.isInteger(data.width) || !Number.isInteger(data.height) ||
     data.width<30 || data.height<30 || data.width*data.height>6_000_000 ||
     !Array.isArray(data.bbox) || data.bbox.length!==4 ||
     data.bbox.some(x=>!Number.isFinite(x)) || data.bbox[0]>=data.bbox[2] || data.bbox[1]>=data.bbox[3])
    throw new Error('Malformed native DWD map manifest');
  if(kind==='icon' && !(data.model==='ICON-D2' && data.schema===2 && Number.isSafeInteger(data.start) && Number.isSafeInteger(data.end)
     && data.precipitation?.count>=100 && data.cloud?.count>=25 && data.temp?.count>=25 && data.point_series?.size>0))
    throw new Error('Unsupported ICON-D2 manifest');
  if(kind==='radar' && !(data.product==='RADOLAN-RY' && data.schema===1 && Array.isArray(data.frames) && data.frames.length>0
    && data.frames.every(f=>Number.isSafeInteger(f.time)&& /^frames\/\d+\.bin\.gz$/.test(f.file))))
    throw new Error('Unsupported RADOLAN RY manifest');
  return {...data,base:kind==='icon'?ICON_BASE:RADAR_BASE,kind};
}
export async function fetchNativeManifest(kind,{signal}={}){
  const base=kind==='icon'?ICON_BASE:RADAR_BASE;
  const response=await fetch(base+'manifest.json?t='+Math.floor(Date.now()/300000),{cache:'no-store',signal});
  if(!response.ok)throw new Error(kind.toUpperCase()+' dataset HTTP '+response.status);
  const manifest=parseNativeManifest(await response.json(),kind);
  if(kind==='icon' && manifest.end < Date.now()/1000-900)throw new Error('DWD ICON-D2 data expired');
  if(kind==='radar' && manifest.frames.at(-1).time < Date.now()/1000-3600)throw new Error('DWD radar feed is more than one hour old');
  return manifest;
}
export function findRasterFile(manifest,field,timestamp){
  if(!manifest||!Number.isFinite(timestamp))return null;
  if(manifest.kind==='icon'){
    const obj=field==='precip'?manifest.precipitation:manifest[field];
    if(!obj || !['precip','cloud','temp'].includes(field))return null;
    const interval=obj.interval_minutes*60;
    const index=Math.max(0,Math.min(obj.count-1,Math.round((timestamp-manifest.start)/interval)));
    // Hourly cloud/temperature are held at the most recently available hour.
    const held=field!=='precip'?Math.max(0,Math.min(obj.count-1,Math.floor((timestamp-manifest.start)/interval))):index;
    const matchedTime=manifest.start+held*interval;
    if(timestamp<manifest.start-interval/2 || timestamp>manifest.end+interval/2)return null;
    return {url:manifest.base+obj.path.replace('{index:03d}',String(held).padStart(3,'0'))+'?run='+encodeURIComponent(manifest.run),
      index:held,time:matchedTime,field,count:manifest.width*manifest.height,bytesPerPixel:field==='cloud'?1:2};
  }
  if(field!=='radar')return null;
  const frames=manifest.frames,times=frames.map(f=>f.time);
  const index=nearestIndex(times,timestamp);
  if(index<0 || Math.abs(times[index]-timestamp)>5*60)return null;
  // Timestamped DWD RADOLAN files do not change when newer observations arrive.
  // Do not append the newest timestamp: it would bust caches for all older frames.
  return {url:manifest.base+frames[index].file,
    index,time:frames[index].time,field,count:manifest.width*manifest.height,bytesPerPixel:2};
}
/** Decode stored gzip bytes; the on-disk cache never stores inflated rasters. */
async function decompressGzip(bytes){
  if(typeof DecompressionStream!=='function')throw new Error('Android WebView requires gzip streaming support');
  const body=new Response(bytes).body;
  if(!body)throw new Error('Compressed raster stream unavailable');
  return new Response(body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
}
async function fetchCompressedFrame(url,kind,expectedRawLength){
  const stored=await weatherDiskCache.get(kind,url);
  if(stored){
    try{
      const raw=await decompressGzip(stored);
      if(raw.byteLength===expectedRawLength)return raw;
    }catch{/* A corrupt cached frame is repaired by a fresh network response. */}
  }
  // Immutable DWD frame URLs may also benefit from Android's normal HTTP cache.
  // Keep the fetch independent from any individual caller's abort signal:
  // shared prefetches remain useful if a gesture moves past a frame.
  const response=await fetch(url,{cache:stored?'reload':'default'});
  if(!response.ok)throw new Error('Weather frame HTTP '+response.status);
  const compressed=await response.arrayBuffer();
  const raw=await decompressGzip(compressed);
  if(raw.byteLength!==expectedRawLength)throw new Error('Truncated DWD raster frame');
  // CacheStorage persists in Android WebView even though our service worker is disabled.
  // If storage is denied or full, the small decoded-RAM LRU still works.
  await weatherDiskCache.put(kind,url,compressed);
  return raw;
}
/** Share in-flight compressed downloads between the point-series graph
 * and spatial map tile for the same DWD URL. CacheStorage alone cannot dedupe
 * two concurrent misses on a cold start.
 */
export async function compressedFrame(url,kind,expectedRawLength){
  if(!pendingCompressed.has(url)){
    pendingCompressed.set(url,fetchCompressedFrame(url,kind,expectedRawLength)
      .finally(()=>pendingCompressed.delete(url)));
  }
  const bytes=await pendingCompressed.get(url);
  if(bytes.byteLength!==expectedRawLength)throw new Error('Unexpected DWD field dimensions');
  return bytes;
}
/** Synchronous LRU lookup so scrubbing can display a cached frame immediately. */
export function peekNativeFrame(manifest,field,timestamp){
  const info=findRasterFile(manifest,field,timestamp);
  if(!info)return null;
  const cache=caches[manifest.kind];
  if(!cache?.has(info.url))return null;
  const values=cache.get(info.url);
  cache.delete(info.url);cache.set(info.url,values);
  return {...info,data:values};
}
export async function downloadNativeFrame(manifest,field,timestamp,{signal}={}){
  const info=findRasterFile(manifest,field,timestamp);
  if(!info)return null;
  if(signal?.aborted)throw new DOMException('Frame request aborted','AbortError');
  const cached=peekNativeFrame(manifest,field,timestamp);
  if(cached)return cached;
  const cache=caches[manifest.kind];
  if(!cache)throw new Error('Unsupported native weather data type');
  if(!pending.has(info.url)){
    pending.set(info.url,(async()=>{
      const bytes=await compressedFrame(info.url,manifest.kind,info.count*info.bytesPerPixel);
      const values=info.bytesPerPixel===1?new Uint8Array(bytes):new Uint16Array(bytes);
      cache.set(info.url,values);
      const max=manifest.kind==='radar'?MAX_RADAR_FRAMES:MAX_ICON_FRAMES;
      while(cache.size>max)cache.delete(cache.keys().next().value);
      return values;
    })().finally(()=>pending.delete(info.url)));
  }
  const data=await pending.get(info.url);
  if(signal?.aborted)throw new DOMException('Frame request aborted','AbortError');
  return {...info,data};
}
/** Warm entire public weather animation deliberately, never on a metered-data surprise.
 * ICON temperature is point-series data rather than a map overlay, so preload
 * only the two displayed forecast layers unless explicitly requested.
 */
export async function preloadNativeFrames(manifest,{onProgress,signal,fields}={}){
  if(!manifest)throw new Error('Load the DWD dataset before preloading');
  const jobs=[];
  if(manifest.kind==='radar'){
    for(const f of [...manifest.frames].reverse())jobs.push({field:'radar',time:f.time});
  }else{
    for(const field of fields||['precip','cloud']){
      if(!['precip','cloud','temp'].includes(field))throw new Error('Unsupported cache field '+field);
      const spec=field==='precip'?manifest.precipitation:manifest[field];
      for(let i=0;i<spec.count;i++)jobs.push({field,time:manifest.start+i*spec.interval_minutes*60});
    }
  }
  let done=0,errors=0;
  for(const job of jobs){
    if(signal?.aborted)return {done,total:jobs.length,errors,cancelled:true};
    try{await downloadNativeFrame(manifest,job.field,job.time,{signal});}
    catch(error){
      if(signal?.aborted)return {done,total:jobs.length,errors,cancelled:true};
      errors++;
    }
    done++;
    onProgress?.({done,total:jobs.length,errors});
  }
  return {done,total:jobs.length,errors,cancelled:false};
}
export async function weatherCacheStats(){
  const [radar,icon,series]=await Promise.all(['radar','icon','series'].map(k=>weatherDiskCache.stats(k)));
  return {radar,icon,series};
}
export function gridPixel(manifest,latitude,longitude){
  const [west,south,east,north]=manifest.bbox;
  if(latitude<south||latitude>north||longitude<west||longitude>east)return null;
  const col=Math.max(0,Math.min(manifest.width-1,Math.round((longitude-west)/(east-west)*(manifest.width-1))));
  const row=Math.max(0,Math.min(manifest.height-1,Math.round((north-latitude)/(north-south)*(manifest.height-1))));
  return {row,col};
}
export function parsePointSeries(manifest,latitude,longitude,buffer){
  if(manifest.kind!=='icon')throw new Error('Point series only available for native ICON-D2');
  const pixel=gridPixel(manifest,latitude,longitude);
  if(!pixel)return null;
  const block=manifest.point_series.size;
  const tx=Math.min(manifest.point_series.tiles_x-1,Math.floor(pixel.col/block));
  const ty=Math.min(manifest.point_series.tiles_y-1,Math.floor(pixel.row/block));
  const cols=Math.min(block+(tx===manifest.point_series.tiles_x-1?1:0),manifest.width-tx*block);
  const rows=Math.min(block+(ty===manifest.point_series.tiles_y-1?1:0),manifest.height-ty*block);
  const n=cols*rows;
  const i=(pixel.row-ty*block)*cols+(pixel.col-tx*block);
  const q=manifest.precipitation.count,h=manifest.cloud.count;
  const expected=(q*2+h*1+manifest.temp.count*2)*n;
  if(buffer.byteLength!==expected)throw new Error('ICON-D2 point series tile length mismatch');
  const view=new DataView(buffer), cloudOffset=q*n*2, tempOffset=cloudOffset+h*n;
  const precip=[],cloud=[],temp=[],times=[];
  for(let step=0;step<q;step++){
    times.push(manifest.start+step*900);
    const raw=view.getUint16((step*n+i)*2,true);
    precip.push(raw===65535?null:raw/100);
    const hour=Math.min(h-1,Math.floor(step/4));
    const c=view.getUint8(cloudOffset+hour*n+i),t=view.getUint16(tempOffset+(hour*n+i)*2,true);
    cloud.push(c===255?null:c);
    temp.push(t===65535?null:t/100-100);
  }
  return {time:times,precipitation_15min:precip,cloud_cover:cloud,temperature_2m:temp,
    // 1-hour accumulation displayed on the existing graph, ending at each 15-min step.
    precipitation:precip.map((v,index)=>{
      const values=precip.slice(Math.max(1,index-3),index+1);
      return values.length && values.every(x=>x!==null)?values.reduce((a,b)=>a+b,0):null;
    })};
}
export async function downloadNativePointSeries(manifest,latitude,longitude,{signal}={}){
  const p=gridPixel(manifest,latitude,longitude);if(!p)return null;
  const t=manifest.point_series,tx=Math.min(t.tiles_x-1,Math.floor(p.col/t.size)),ty=Math.min(t.tiles_y-1,Math.floor(p.row/t.size));
  const url=manifest.base+t.path.replace('{x:02d}',String(tx).padStart(2,'0')).replace('{y:02d}',String(ty).padStart(2,'0'))+'?run='+encodeURIComponent(manifest.run);
  const cols=Math.min(t.size+(tx===t.tiles_x-1?1:0),manifest.width-tx*t.size);
  const rows=Math.min(t.size+(ty===t.tiles_y-1?1:0),manifest.height-ty*t.size);
  const n=cols*rows;
  const expected=n*(manifest.precipitation.count*2+manifest.cloud.count+manifest.temp.count*2);
  if(signal?.aborted)throw new DOMException('Point series aborted','AbortError');
  const bytes=await compressedFrame(url,'series',expected);
  if(signal?.aborted)throw new DOMException('Point series aborted','AbortError');
  return parsePointSeries(manifest,latitude,longitude,bytes);
}
export function interpolatePointField(hourly,field,time){
  if(!hourly?.time?.length || !Array.isArray(hourly[field]))return null;
  const index=nearestIndex(hourly.time,time);
  if(index<0)return null;
  const one=hourly[field][index];
  if(Math.abs(hourly.time[index]-time)<1 || time<=hourly.time[0] || time>=hourly.time.at(-1))return one??null;
  const other=hourly.time[index]>time?index-1:index+1;
  const a=Math.min(index,other),b=Math.max(index,other);
  const va=hourly[field][a],vb=hourly[field][b];
  if(!Number.isFinite(va)||!Number.isFinite(vb))return one??null;
  const frac=Math.max(0,Math.min(1,(time-hourly.time[a])/(hourly.time[b]-hourly.time[a])));
  return va+(vb-va)*frac;
}
/** Make native DWD point graphs available independently of the optional
 * Open-Meteo point API. Wind and ancillary values stay null until that API
 * answers; genuine cloud, precipitation and temperature are never overwritten.
 */
export function composeIconD2Forecast(series,pointForecast=null,{fetchedAt=Date.now()}={}){
  if(!series||!Array.isArray(series.time)||!series.time.length||
     ['temperature_2m','precipitation','cloud_cover'].some(key=>
       !Array.isArray(series[key])||series[key].length!==series.time.length))
    throw new Error('Invalid ICON-D2 grid point series');
  const hourly={
    time:series.time,
    temperature_2m:series.temperature_2m,
    precipitation:series.precipitation,
    cloud_cover:series.cloud_cover,
  };
  const extras=['wind_speed_10m','wind_direction_10m','relative_humidity_2m','pressure_msl'];
  for(const key of extras){
    hourly[key]=Array.isArray(pointForecast?.hourly?.[key])&&
      pointForecast.hourly[key].length===pointForecast.hourly.time?.length
      ? series.time.map(t=>interpolatePointField(pointForecast.hourly,key,t))
      : Array(series.time.length).fill(null);
  }
  return {
    ...(pointForecast||{}),
    hourly,timezone:pointForecast?.timezone||'Europe/Berlin',
    fetchedAt:pointForecast?.fetchedAt||fetchedAt,
    rawPointForecast:pointForecast,
    fromRawGrid:true,
    gridOnly:!pointForecast,
  };
}
export function rgbaForField(field,raw){
  if(field==='cloud'){
    if(raw===255)return [0,0,0,0];
    return [220,231,244,Math.round(raw*1.8)];
  }
  if(raw===65535 || raw===0)return [0,0,0,0];
  const intensity=field==='radar'?raw/100:raw/25; // radar is mm/h; 15-minute rain converted to mm/h
  if(intensity<.2)return [100,178,248,95];
  if(intensity<1)return [52,155,248,165];
  if(intensity<4)return [24,132,236,195];
  if(intensity<10)return [24,216,157,205];
  if(intensity<25)return [242,222,66,220];
  return [238,70,80,240];
}
/** Convert the native-resolution pixels to a precomputed RGBA palette.
 *  Recolour ONLY the geographic area currently on screen: processing the
 *  entire 2401 x 1801 radar composite on every swipe causes long blank frames.
 */
const palettes=new Map();
function pixelPalette(field){
  if(palettes.has(field))return palettes.get(field);
  const n=field==='cloud'?256:65536;
  const palette=new Uint32Array(n);
  for(let i=0;i<n;i++){
    const [r,g,b,a]=rgbaForField(field,i);
    palette[i]=(r|(g<<8)|(b<<16)|(a<<24))>>>0;
  }
  palettes.set(field,palette);
  return palette;
}
export function visibleNativeCrop(manifest,width,height,zoom,center){
  if(!manifest || width<=0 || height<=0)return null;
  const [west,south,east,north]=manifest.bbox;
  const map=mercator(center.latitude,center.longitude,zoom);
  const nw=unmercator(map.x-width/2,map.y-height/2,zoom);
  const se=unmercator(map.x+width/2,map.y+height/2,zoom);
  // This dataset covers Germany, not the international date line.
  if(nw.lon>se.lon || se.lon<west || nw.lon>east || nw.lat<south || se.lat>north)return null;
  const left=Math.max(west,nw.lon),right=Math.min(east,se.lon);
  const top=Math.min(north,nw.lat),bottom=Math.max(south,se.lat);
  const c0=Math.max(0,Math.floor((left-west)/(east-west)*(manifest.width-1))-2);
  const c1=Math.min(manifest.width-1,Math.ceil((right-west)/(east-west)*(manifest.width-1))+2);
  const r0=Math.max(0,Math.floor((north-top)/(north-south)*(manifest.height-1))-2);
  const r1=Math.min(manifest.height-1,Math.ceil((north-bottom)/(north-south)*(manifest.height-1))+2);
  if(r1<r0||c1<c0)return null;
  return {c0,c1,r0,r1,map,west,south,east,north};
}
export function paintNativeField(ctx,manifest,values,field,width,height,zoom,center,alpha=1){
  if(!manifest||!values||!(width>0&&height>0))return;
  const crop=visibleNativeCrop(manifest,width,height,zoom,center);
  if(!crop)return;
  const {c0,c1,r0,r1,map,west,south,east,north}=crop;
  const cols=c1-c0+1,rows=r1-r0+1;
  const cacheKey=`${field}:${c0}:${c1}:${r0}:${r1}`;
  let retained=canvasCache.get(values);
  if(!retained || retained.key!==cacheKey){
    const canvas=document.createElement('canvas');canvas.width=cols;canvas.height=rows;
    const c=canvas.getContext('2d');
    const img=c.createImageData(cols,rows);
    const colored=new Uint32Array(img.data.buffer),palette=pixelPalette(field);
    for(let r=0;r<rows;r++){
      const src=(r+r0)*manifest.width+c0,dst=r*cols;
      for(let col=0;col<cols;col++)colored[dst+col]=palette[values[src+col]];
    }
    c.putImageData(img,0,0);
    retained={key:cacheKey,canvas};
    canvasCache.set(values,retained);
  }
  const srcCanvas=retained.canvas;
  const leftLon=west+c0*(east-west)/(manifest.width-1);
  const rightLon=west+(c1+1)*(east-west)/(manifest.width-1);
  const x=width/2+mercator(0,leftLon,zoom).x-map.x;
  const w=mercator(0,rightLon,zoom).x-mercator(0,leftLon,zoom).x;
  ctx.save();ctx.globalAlpha=alpha;ctx.imageSmoothingEnabled=false;
  for(let r=0;r<rows;r+=5){
    const end=Math.min(r+5,rows);
    const latTop=north-(r+r0)*(north-south)/(manifest.height-1);
    const latBottom=north-(end+r0)*(north-south)/(manifest.height-1);
    const top=height/2+mercator(latTop,0,zoom).y-map.y;
    const bottom=height/2+mercator(latBottom,0,zoom).y-map.y;
    ctx.drawImage(srcCanvas,0,r,cols,end-r,x,top,w,bottom-top+.2);
  }
  ctx.restore();
}
