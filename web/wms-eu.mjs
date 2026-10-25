/** Lightweight public Deutscher Wetterdienst ICON-EU hourly precipitation WMS.
 * NOT ICON-D2: its model resolution is approximately 6.5 km. This is an
 * explicit second model overlay, not a hidden replacement for the D2 forecast.
 */
import {mercator,nearestIndex} from './logic.mjs';
import {weatherDiskCache} from './frame-cache.mjs';
export const ICON_EU_WMS_LAYER='dwd:Icon-eu_reg00625_fd_sl_TOTPREC01H';
export const ICON_EU_WMS_BASE='https://maps.dwd.de/geoserver/dwd/wms';
export const ICON_EU_CAPABILITIES=
 'https://maps.dwd.de/geoserver/dwd/Icon-eu_reg00625_fd_sl_TOTPREC01H/wms?service=WMS&version=1.3.0&request=GetCapabilities';
const IMAGE_MEMORY_LIMIT=40;
const imageMemory=new Map(),imagePending=new Map();
let metadata=null,metadataRequest=null;
function parseISO(raw){const t=Date.parse(raw);return Number.isFinite(t)?Math.round(t/1000):null;}
export function parseIconEuCapabilities(xml,{now=Date.now()/1000}={}){
  if(typeof xml!=='string'||xml.length>400000||/<!DOCTYPE|<!ENTITY/i.test(xml))
    throw new Error('Invalid DWD WMS metadata');
  if(typeof DOMParser!=='function')throw new Error('XML parser unavailable');
  const document=new DOMParser().parseFromString(xml,'application/xml');
  if(document.getElementsByTagName('parsererror').length)
    throw new Error('Malformed DWD WMS metadata');
  const layers=[...document.getElementsByTagNameNS('*','Layer')];
  const layer=layers.find(el=>[...el.children].some(child=>
    child.localName==='Name'&&(child.textContent||'').trim().replace(/^dwd:/,'')==='Icon-eu_reg00625_fd_sl_TOTPREC01H'));
  if(!layer)throw new Error('DWD ICON-EU rainfall layer unavailable');
  const dimensions=[...layer.children].filter(el=>el.localName==='Dimension');
  const time=dimensions.find(el=>el.getAttribute('name')==='time');
  const reference=dimensions.find(el=>el.getAttribute('name')==='REFERENCE_TIME');
  if(!time||!reference)throw new Error('ICON-EU WMS missing forecast run/time dimensions');
  const range=(time.textContent||'').trim().split('/');
  if(range.length!==3||range[2]!=='PT1H')throw new Error('ICON-EU hourly availability invalid');
  const first=parseISO(range[0]),last=parseISO(range[1]);
  const runs=(reference.textContent||'').split(',').map(s=>parseISO(s.trim()))
    .filter(t=>t!==null&&t<=now+120&&now-t<=18*3600).sort((a,b)=>b-a);
  const recent=runs.find(t=>t%(6*3600)===0)??runs[0];
  if(recent==null||first==null||last==null||last<first||last-first>8*86400)
    throw new Error('No fresh DWD ICON-EU forecast');
  return {kind:'icon_eu_wms',run:recent,first,last,
    validUntil:Math.min(last,now+120*3600),retrievedAt:now};
}
export async function fetchIconEuCapabilities({signal,force=false}={}){
  if(!force&&metadata&&Date.now()/1000-metadata.retrievedAt<600)return metadata;
  if(!metadataRequest){
    metadataRequest=(async()=>{
      const r=await fetch(ICON_EU_CAPABILITIES,{signal,cache:'no-store'});
      if(!r.ok)throw new Error('ICON-EU WMS metadata HTTP '+r.status);
      const xml=await r.text();
      metadata=parseIconEuCapabilities(xml);
      return metadata;
    })().finally(()=>{metadataRequest=null;});
  }
  return metadataRequest;
}
export function iconEuValidTime(metadata,selected){
  if(!metadata||!Number.isFinite(selected))return null;
  const t=Math.round(selected/3600)*3600;
  if(t<metadata.first||t>metadata.last||t<=metadata.run)return null;
  return t;
}
function iso(t){return new Date(t*1000).toISOString().replace('.000Z','Z');}
export function iconEuWmsTileURL(meta,time,z,x,y){
  if(!meta||!Number.isInteger(z)||z<0||z>12||!Number.isInteger(x)||!Number.isInteger(y))
    throw new Error('Invalid DWD WMS tile');
  const count=2**z;if(y<0||y>=count)throw new Error('Invalid DWD tile row');
  const xx=((x%count)+count)%count;
  const extent=20037508.342789244,span=extent*2/count;
  const west=-extent+xx*span,east=west+span,north=extent-y*span,south=north-span;
  const params=new URLSearchParams({
    SERVICE:'WMS',VERSION:'1.1.1',REQUEST:'GetMap',LAYERS:ICON_EU_WMS_LAYER,
    STYLES:'',FORMAT:'image/png',TRANSPARENT:'TRUE',SRS:'EPSG:3857',
    BBOX:[west,south,east,north].join(','),WIDTH:'256',HEIGHT:'256',
    TIME:iso(time),DIM_REFERENCE_TIME:iso(meta.run)
  });
  return ICON_EU_WMS_BASE+'?'+params;
}
export function visibleIconEuWmsTiles(meta,time,width,height,zoom,center){
  if(!Number.isFinite(time)||!width||!height)return [];
  const z=Math.min(8,Math.max(0,Math.floor(zoom))),
    size=256*2**(zoom-z),world=2**z;
  const p=mercator(center.latitude,center.longitude,zoom),left=p.x-width/2,top=p.y-height/2;
  const result=[];
  for(let x=Math.floor(left/size);x<=Math.floor((left+width)/size);x++)
    for(let y=Math.max(0,Math.floor(top/size));y<=Math.min(world-1,Math.floor((top+height)/size));y++)
      result.push({key:z+'/'+x+'/'+y,left:x*size-left,top:y*size-top,size,
        url:iconEuWmsTileURL(meta,time,z,x,y)});
  return result;
}
function isPng(buffer){
  if(buffer.byteLength<24||buffer.byteLength>2*1024*1024)return false;
  const b=new Uint8Array(buffer),magic=[137,80,78,71,13,10,26,10];
  return magic.every((c,i)=>b[i]===c)&&new DataView(buffer).getUint32(16,false)===256
    &&new DataView(buffer).getUint32(20,false)===256;
}
function touchMemory(url,bitmap){
  if(imageMemory.has(url))imageMemory.delete(url);
  imageMemory.set(url,bitmap);
  while(imageMemory.size>IMAGE_MEMORY_LIMIT){
    const key=imageMemory.keys().next().value,image=imageMemory.get(key);
    imageMemory.delete(key);
    image?.close?.();
  }
}
async function decodePng(bytes){
  const blob=new Blob([bytes],{type:'image/png'});
  if(typeof createImageBitmap==='function')return createImageBitmap(blob);
  const url=URL.createObjectURL(blob),img=new Image();
  try{img.src=url;await img.decode();return img;}finally{URL.revokeObjectURL(url);}
}
export async function iconEuWmsImage(url){
  if(imageMemory.has(url)){const image=imageMemory.get(url);touchMemory(url,image);return image;}
  if(!imagePending.has(url)){
    imagePending.set(url,(async()=>{
      let bytes=await weatherDiskCache.get('wms',url);
      if(!bytes){
        const response=await fetch(url,{cache:'default'});
        if(!response.ok)throw new Error('ICON-EU WMS image HTTP '+response.status);
        if(!(response.headers.get('content-type')||'').toLowerCase().includes('image/png'))
          throw new Error('DWD WMS did not return PNG imagery');
        bytes=await response.arrayBuffer();
        if(!isPng(bytes))throw new Error('DWD WMS tile is not a valid 256px PNG');
        await weatherDiskCache.put('wms',url,bytes);
      }
      if(!isPng(bytes))throw new Error('DWD WMS PNG invalid');
      const image=await decodePng(bytes);
      touchMemory(url,image);
      return image;
    })().finally(()=>imagePending.delete(url)));
  }
  return imagePending.get(url);
}
export async function paintIconEuWms(ctx,metadata,time,width,height,zoom,center,isCurrent=()=>true){
  const t=iconEuValidTime(metadata,time);if(t===null)return false;
  const tiles=visibleIconEuWmsTiles(metadata,t,width,height,zoom,center);
  if(!tiles.length)return false;
  const fetched=await Promise.allSettled(tiles.map(t=>iconEuWmsImage(t.url)));
  if(fetched.some(x=>x.status==='rejected')){
    const first=fetched.find(x=>x.status==='rejected');
    throw first.reason;
  }
  if(!isCurrent())return false;
  ctx.clearRect(0,0,width,height);
  for(let i=0;i<tiles.length;i++){
    const tile=tiles[i];
    ctx.drawImage(fetched[i].value,tile.left,tile.top,tile.size,tile.size);
  }
  // Prefetch just the next hour in the current viewport, not the full model.
  const next=t+3600;
  if(iconEuValidTime(metadata,next)!==null){
    const wanted=visibleIconEuWmsTiles(metadata,next,width,height,zoom,center);
    for(const tile of wanted)void iconEuWmsImage(tile.url).catch(()=>{});
  }
  return true;
}
