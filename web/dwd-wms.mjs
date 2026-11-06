/* Rain beyond the ICON-D2 tiles: DWD's public WMS images of ICON-EU (1 h and
 * 3 h totals) and ICON Global (6 h totals). DWD draws them in fixed colour
 * classes; each pixel is mapped back to its class (a mm range per period)
 * and recoloured with OpenWetter's rain scale at the class's mean rate, so
 * the map reads like the ICON-D2 and radar layers. Class resolution only:
 * these are ranges, not exact values. Custom WMS styles are refused by DWD.
 */
import {mercator} from './logic.mjs';
import {paletteLUT} from './tile-service.mjs';
import {weatherDiskCache} from './frame-cache.mjs';

const BASE='https://maps.dwd.de/geoserver/dwd/';
export const WMS_RAIN=Object.freeze([
  Object.freeze({id:'eu1',layer:'Icon-eu_reg00625_fd_sl_TOTPREC01H',hours:1,horizon:78,model:'ICON-EU',maxZoom:8}),
  Object.freeze({id:'eu3',layer:'Icon-eu_reg00625_fd_sl_TOTPREC03H',hours:3,horizon:120,model:'ICON-EU',maxZoom:8}),
  Object.freeze({id:'glob6',layer:'Icon_reg025_fd_sl_TOTPREC06H',hours:6,horizon:180,model:'ICON',maxZoom:7}),
]);
const iso=t=>new Date(t*1000).toISOString().replace('.000Z','Z');
const parseISO=s=>{const t=Date.parse(s);return Number.isFinite(t)?Math.round(t/1000):null;};
const STEPS={PT1H:3600,PT3H:10800,PT6H:21600};

/** Time range, step and newest run of one layer from its GetCapabilities XML. */
export function parseWmsCapabilities(xml,layer,{now=Date.now()/1000}={}){
  if(typeof xml!=='string'||xml.length>500000||/<!DOCTYPE|<!ENTITY/i.test(xml))throw new Error('Invalid DWD WMS metadata');
  const at=xml.search(new RegExp(`<Name>(dwd:)?${layer.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}</Name>`));
  if(at<0)throw new Error(`DWD layer ${layer} unavailable`);
  const block=xml.slice(at,xml.indexOf('</Layer>',at));
  const dim=name=>(block.match(new RegExp(`<Dimension[^>]*name="${name}"[^>]*>([^<]*)</Dimension>`))||[])[1]?.trim();
  const range=(dim('time')||'').split('/');
  const first=parseISO(range[0]),last=parseISO(range[1]),step=STEPS[range[2]];
  const runs=(dim('REFERENCE_TIME')||'').split(',').map(s=>parseISO(s.trim()))
    .filter(t=>t!==null&&t<=now+120&&now-t<=24*3600).sort((a,b)=>b-a);
  const run=runs.find(t=>t%21600===0)??runs[0];
  if(first==null||last==null||!step||last<first||run==null)throw new Error(`DWD layer ${layer}: no usable forecast run`);
  return {first,last,step,run};
}
/** Colour classes from GetLegendGraphic (JSON, "intervals" colour map):
 * each entry's quantity is the upper bound of its class. */
export function parseWmsLegend(json){
  const entries=json?.Legend?.[0]?.rules?.[0]?.symbolizers?.[0]?.Raster?.colormap?.entries;
  if(!Array.isArray(entries)||entries.length<3)throw new Error('Invalid DWD legend');
  let lo=0;
  return entries.map(e=>{
    const hi=Number(e.quantity),c=String(e.color||'');
    if(!Number.isFinite(hi)||!/^#[0-9a-f]{6}$/i.test(c))throw new Error('Invalid DWD legend entry');
    const rgb=[1,3,5].map(i=>parseInt(c.slice(i,i+2),16)),out={rgb,lo,hi,dry:lo===0};
    lo=hi;return out;
  });
}
/** Rain rate (mm/h) representing a class: geometric mean of its bounds per hour. */
export function classRate(cls,hours){
  if(cls.dry)return 0;
  const hi=cls.hi>=1000?cls.lo*1.3:cls.hi;
  return Math.sqrt(Math.max(cls.lo,.01)*hi)/hours;
}
/** The newest-run period (end time) covering `time`, or null. */
export function wmsValidTime(meta,time,source){
  if(!meta||!Number.isFinite(time))return null;
  const T=meta.first+Math.ceil((time-meta.first)/meta.step)*meta.step;
  if(T<meta.first||T>meta.last||T<=meta.run||T>meta.run+source.horizon*3600)return null;
  return T;
}
/** Finest WMS source covering `time`: [source, validTime] or null. */
export function chooseWmsSource(metas,time){
  for(const s of WMS_RAIN){const T=wmsValidTime(metas?.[s.id],time,s);if(T!=null)return {source:s,time:T};}
  return null;
}
export function wmsTileURL(source,meta,time,z,x,y){
  const n=2**z,xx=((x%n)+n)%n,extent=20037508.342789244,span=extent*2/n;
  const west=-extent+xx*span,north=extent-y*span;
  const p=new URLSearchParams({SERVICE:'WMS',VERSION:'1.1.1',REQUEST:'GetMap',LAYERS:'dwd:'+source.layer,STYLES:'',
    FORMAT:'image/png',TRANSPARENT:'TRUE',SRS:'EPSG:3857',BBOX:[west,north-span,west+span,north].join(','),
    WIDTH:'256',HEIGHT:'256',TIME:iso(time),DIM_REFERENCE_TIME:iso(meta.run)});
  return BASE+'wms?'+p;
}
export function wmsTilesInView(source,meta,time,view){
  const z=Math.max(0,Math.min(source.maxZoom,Math.floor(view.zoom))),size=256*2**(view.zoom-z),n=2**z;
  const c=mercator(view.latitude,view.longitude,view.zoom),left=c.x-view.width/2,top=c.y-view.height/2,out=[];
  for(let x=Math.floor(left/size);x<=Math.floor((left+view.width)/size);x++)
    for(let y=Math.max(0,Math.floor(top/size));y<=Math.min(n-1,Math.floor((top+view.height)/size));y++)
      out.push({url:wmsTileURL(source,meta,time,z,x,y),left:x*size-left,top:y*size-top,size});
  return out;
}
/** Map every pixel to its class (nearest legend colour; 255 = none/dry) and
 * recolour with the rain LUT. `rgba` is modified in place. */
export function recolorPixels(rgba,classes,hours,lut){
  const n=rgba.length/4,index=new Uint8Array(n).fill(255);
  const codes=classes.map(c=>{const r=classRate(c,hours);if(!(r>0))return -1;
    return Math.max(1,Math.min(254,Math.round(1+253*Math.log(r/0.05)/Math.log(64/0.05))));});
  for(let i=0;i<n;i++){
    const o=i*4;
    if(rgba[o+3]<128){rgba[o+3]=0;continue;}
    let best=-1,bd=1e9;
    for(let k=0;k<classes.length;k++){const [r,g,b]=classes[k].rgb,d=(rgba[o]-r)**2+(rgba[o+1]-g)**2+(rgba[o+2]-b)**2;if(d<bd){bd=d;best=k;}}
    const code=bd<=300?codes[best]:-1;
    if(code<0){rgba[o+3]=0;continue;}
    index[i]=best;
    rgba[o]=lut[code*4];rgba[o+1]=lut[code*4+1];rgba[o+2]=lut[code*4+2];rgba[o+3]=lut[code*4+3];
  }
  return index;
}

/* ---------- browser side: metadata, tiles, painting ---------- */
let metas=null,metaPromise=null,metaTime=0;
export async function loadWmsMetadata({force=false}={}){
  if(!force&&metas&&Date.now()-metaTime<10*60_000)return metas;
  metaPromise??=(async()=>{
    const out={};
    await Promise.all(WMS_RAIN.map(async s=>{
      try{
        const [caps,legend]=await Promise.all([
          fetch(`${BASE}${s.layer}/wms?service=WMS&version=1.3.0&request=GetCapabilities`,{cache:'no-store'}).then(r=>{if(!r.ok)throw new Error('HTTP '+r.status);return r.text();}),
          fetch(`${BASE}wms?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetLegendGraphic&FORMAT=application/json&LAYER=dwd:${s.layer}`).then(r=>{if(!r.ok)throw new Error('HTTP '+r.status);return r.json();})]);
        out[s.id]={...parseWmsCapabilities(caps,s.layer),classes:parseWmsLegend(legend)};
      }catch{/* this source stays unavailable */}
    }));
    metas=out;metaTime=Date.now();return out;
  })().finally(()=>{metaPromise=null;});
  return metaPromise;
}
const LIMIT=80,tiles=new Map(),pending=new Map();
let lut=null;
async function tile(url,source,meta){
  if(tiles.has(url)){const t=tiles.get(url);tiles.delete(url);tiles.set(url,t);return t;}
  if(!pending.has(url))pending.set(url,(async()=>{
    let bytes=await weatherDiskCache.get('wms',url);
    if(!bytes){
      const r=await fetch(url);
      if(!r.ok||!(r.headers.get('content-type')||'').includes('image/png'))throw new Error('DWD WMS image unavailable');
      bytes=await r.arrayBuffer();await weatherDiskCache.put('wms',url,bytes);
    }
    const bitmap=await createImageBitmap(new Blob([bytes],{type:'image/png'}));
    const c=new OffscreenCanvas(256,256),ctx=c.getContext('2d',{willReadFrequently:true});
    ctx.drawImage(bitmap,0,0);bitmap.close?.();
    const data=ctx.getImageData(0,0,256,256);
    lut??=paletteLUT('precip');
    const index=recolorPixels(data.data,meta.classes,source.hours,lut);
    ctx.putImageData(data,0,0);
    const out={image:c.transferToImageBitmap?c.transferToImageBitmap():c,index};
    tiles.set(url,out);
    while(tiles.size>LIMIT){const k=tiles.keys().next().value;tiles.get(k).image.close?.();tiles.delete(k);}
    return out;
  })().finally(()=>pending.delete(url)));
  return pending.get(url);
}
/** Draw the WMS rain for `time` into ctx (CSS px). Resolves to the drawn
 * description, or null if another draw superseded this one. */
export async function paintWmsRain(ctx,view,choice,isCurrent){
  const meta=metas?.[choice.source.id];if(!meta)return null;
  const list=wmsTilesInView(choice.source,meta,choice.time,view);
  const loaded=await Promise.all(list.map(t=>tile(t.url,choice.source,meta).catch(()=>null)));
  if(!isCurrent())return null;
  ctx.clearRect(0,0,view.width,view.height);ctx.imageSmoothingEnabled=false;
  list.forEach((t,i)=>{if(loaded[i])ctx.drawImage(loaded[i].image,t.left,t.top,t.size,t.size);});
  // Class at the screen centre (the forecast marker).
  let centre=null;
  list.forEach((t,i)=>{const L=loaded[i];if(!L)return;const cx=view.width/2-t.left,cy=view.height/2-t.top;
    if(cx>=0&&cy>=0&&cx<t.size&&cy<t.size){const k=L.index[Math.floor(cy/t.size*256)*256+Math.floor(cx/t.size*256)];
      centre=k===255?{lo:0,hi:0}:{lo:meta.classes[k].lo/choice.source.hours,hi:meta.classes[k].hi/choice.source.hours};}});
  // Warm the next period.
  const next=wmsValidTime(meta,choice.time+meta.step,choice.source);
  if(next!=null)for(const t of wmsTilesInView(choice.source,meta,next,view))void tile(t.url,choice.source,meta).catch(()=>{});
  return {key:choice.source.id+':'+choice.time,source:choice.source,time:choice.time,run:meta.run,centre,complete:loaded.every(Boolean)};
}
export const wmsMetadata=()=>metas;
