/** Real DWD ICON-D2 spatial fields. Never generates interpolated synthetic weather. */
import {nearestIndex, mercator} from './logic.mjs';

const validVars=new Set(['cloud','precip','temp']);
export function decodeField(base64,size){
  if(typeof base64!=='string')throw new TypeError('Invalid ICON field');
  const binary=atob(base64),bytes=new Uint8Array(binary.length);
  if(bytes.length!==size)throw new RangeError('ICON grid dimensions do not match field');
  for(let i=0;i<bytes.length;i++)bytes[i]=binary.charCodeAt(i);
  return bytes;
}
export function parseIconGrid(data){
  if(data?.schema!==1||data.model!=='ICON-D2'||!Array.isArray(data.frames)||data.frames.length<2)throw new Error('Invalid ICON-D2 data');
  const {width,height,bbox}=data;
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<10||height<10||width*height>800_000||
    !Array.isArray(bbox)||bbox.length!==4||bbox.some(v=>!Number.isFinite(v))||bbox[0]>=bbox[2]||bbox[1]>=bbox[3])throw new Error('Invalid ICON grid coordinates');
  const times=[];const frames=[];
  for(const frame of data.frames){
    if(!Number.isSafeInteger(frame.time)||frame.time<1700000000||frame.time<=times.at(-1))throw new Error('Invalid ICON forecast timestamps');
    const fields={};
    for(const name of validVars)fields[name]=decodeField(frame[name],width*height);
    times.push(frame.time);frames.push(fields);
  }
  return {model:'icon_d2',run:data.run,width,height,bbox,times,frames,resolutionNote:data.resolution_note};
}
export function gridIndex(grid,latitude,longitude){
  const [west,south,east,north]=grid.bbox;
  if(latitude<south||latitude>north||longitude<west||longitude>east)return -1;
  const col=Math.round((longitude-west)/(east-west)*(grid.width-1));
  const row=Math.round((north-latitude)/(north-south)*(grid.height-1));
  return row*grid.width+col;
}
export function gridValue(grid,field,latitude,longitude,time){
  if(!validVars.has(field))return null;
  const idx=gridIndex(grid,latitude,longitude),step=nearestIndex(grid.times,time);
  if(idx<0||step<0||Math.abs(grid.times[step]-time)>1800)return null;
  const raw=grid.frames[step][field][idx];
  if(raw===255)return null;
  if(field==='temp')return raw/2-50;
  if(field==='precip')return raw/10;
  return raw;
}
export function colorPixel(field,value){
  if(value===255)return [0,0,0,0];
  if(field==='precip'){
    if(value===0)return [0,0,0,0];
    if(value<5)return [74,181,248,108];
    if(value<20)return [28,129,237,177];
    if(value<60)return [17,215,141,198];
    if(value<120)return [248,227,71,222];
    return [235,75,88,238];
  }
  if(field==='cloud')return [224,226,239,Math.round(value*1.85)];
  throw new Error('Unsupported ICON map layer');
}
export function paintField(ctx,grid,field,step,width,height,zoom,mapCenter){
  if(!['cloud','precip'].includes(field)||!grid.frames[step])return;
  const values=grid.frames[step][field],off=document.createElement('canvas');
  off.width=grid.width;off.height=grid.height;
  const c=off.getContext('2d'),pixels=c.createImageData(grid.width,grid.height);
  for(let i=0;i<values.length;i++)pixels.data.set(colorPixel(field,values[i]),i*4);
  c.putImageData(pixels,0,0);
  const [west,south,east,north]=grid.bbox;
  const center=mercator(mapCenter.latitude,mapCenter.longitude,zoom);
  const lx=mercator(0,west,zoom).x,rx=mercator(0,east,zoom).x;
  const x=width/2+lx-center.x,w=rx-lx;
  for(let row=0;row<grid.height;row++){
    const latA=north-row*(north-south)/grid.height;
    const latB=north-(row+1)*(north-south)/grid.height;
    const top=height/2+mercator(latA,0,zoom).y-center.y;
    const bottom=height/2+mercator(latB,0,zoom).y-center.y;
    ctx.drawImage(off,0,row,grid.width,1,x,top,w,bottom-top+.2);
  }
}
export async function downloadIconGrid(url,{signal}={}){
  const response=await fetch(url,{signal,cache:'no-store'});
  if(!response.ok)throw new Error(`ICON grids HTTP ${response.status}`);
  if(!response.body||!('DecompressionStream' in globalThis))throw new Error('Android WebView needs gzip streaming support');
  const decompressed=response.body.pipeThrough(new DecompressionStream('gzip'));
  const text=await new Response(decompressed).text();
  return parseIconGrid(JSON.parse(text));
}
