/** Native-derived DWD ICON-D2 model and DWD RY observed radar data.
 * Raster display pixel size oversamples the original ~2 km ICON mesh and 1 km
 * radar. It does NOT increase meteorological model resolution or fidelity.
 */
import {mercator,nearestIndex} from './logic.mjs';

export const ICON_BASE='https://raw.githubusercontent.com/e-kotov/OpenWetter/icon-data/';
export const RADAR_BASE='https://raw.githubusercontent.com/e-kotov/OpenWetter/radar-data/';
const MAX_FRAMES=18;
const cache=new Map();
const pending=new Map();
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
  return {url:manifest.base+frames[index].file+'?stamp='+frames.at(-1).time,
    index,time:frames[index].time,field,count:manifest.width*manifest.height,bytesPerPixel:2};
}
async function decompressGzip(response){
  if(!response.ok)throw new Error('Weather frame HTTP '+response.status);
  if(!response.body || typeof DecompressionStream!=='function')throw new Error('This Android WebView requires gzip streaming support');
  return new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
}
export async function downloadNativeFrame(manifest,field,timestamp,{signal}={}){
  const info=findRasterFile(manifest,field,timestamp);
  if(!info)return null;
  if(cache.has(info.url)){
    const value=cache.get(info.url);cache.delete(info.url);cache.set(info.url,value);return {...info,data:value};
  }
  if(!pending.has(info.url)){
    pending.set(info.url,(async()=>{
      const response=await fetch(info.url,{cache:'no-store',signal});
      const bytes=await decompressGzip(response);
      if(bytes.byteLength!==info.count*info.bytesPerPixel)throw new Error('Truncated DWD raster frame');
      const values=info.bytesPerPixel===1?new Uint8Array(bytes):new Uint16Array(bytes);
      cache.set(info.url,values);
      while(cache.size>MAX_FRAMES)cache.delete(cache.keys().next().value);
      return values;
    })().finally(()=>pending.delete(info.url)));
  }
  return {...info,data:await pending.get(info.url)};
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
  const response=await fetch(url,{cache:'no-store',signal});
  return parsePointSeries(manifest,latitude,longitude,await decompressGzip(response));
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
export function paintNativeField(ctx,manifest,values,field,width,height,zoom,center,alpha=1){
  if(!manifest||!values||!(width>0&&height>0))return;
  let bitmap=canvasCache.get(values);
  if(!bitmap){
    const canvas=document.createElement('canvas');canvas.width=manifest.width;canvas.height=manifest.height;
    const c=canvas.getContext('2d',{willReadFrequently:false}),pixels=c.createImageData(manifest.width,manifest.height);
    const rgba=pixels.data;
    for(let i=0;i<values.length;i++){
      const value=rgbaForField(field,values[i]);
      const j=i*4;rgba[j]=value[0];rgba[j+1]=value[1];rgba[j+2]=value[2];rgba[j+3]=value[3];
    }
    c.putImageData(pixels,0,0);
    bitmap=canvas;canvasCache.set(values,bitmap);
  }
  const [west,south,east,north]=manifest.bbox;
  const map=mercator(center.latitude,center.longitude,zoom);
  const x=width/2 + mercator(0,west,zoom).x-map.x;
  const w=mercator(0,east,zoom).x-mercator(0,west,zoom).x;
  ctx.save();ctx.globalAlpha=alpha;ctx.imageSmoothingEnabled=false;
  // Draw 2-5 latitude lines at a time; Mercator changes negligibly across a strip.
  const strip=field==='radar'?5:3;
  for(let row=0;row<manifest.height;row+=strip){
    const end=Math.min(row+strip,manifest.height);
    const latTop=north-row*(north-south)/(manifest.height-1);
    const latBottom=north-end*(north-south)/(manifest.height-1);
    const top=height/2+mercator(latTop,0,zoom).y-map.y;
    const bottom=height/2+mercator(latBottom,0,zoom).y-map.y;
    ctx.drawImage(bitmap,0,row,manifest.width,end-row,x,top,w,bottom-top+.2);
  }
  ctx.restore();
}
