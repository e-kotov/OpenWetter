/** Time-packed genuine ICON-D2 1-degree tiles.
 * Each compressed tile covers all 193 15-minute rain steps and 49 hourly
 * cloud/temperature steps, so after loading the visible viewport, scrubbing
 * needs NO network transfers to revisit any forecast time in the same run.
 */
import {visibleNativeCrop,paintNativeField,compressedFrame,findRasterFile} from './native-fields.mjs';
const MAX_DECODED_TILES=24;
const decoded=new Map(),pending=new Map();
const serialIndex=(manifest,tx,ty)=>manifest.run+':'+tx+':'+ty;
export function spatialTileInfo(manifest,tx,ty){
  if(manifest?.kind!=='icon')throw new Error('ICON-D2 manifest required');
  const t=manifest.point_series;
  if(!Number.isInteger(tx)||!Number.isInteger(ty)||tx<0||ty<0||tx>=t.tiles_x||ty>=t.tiles_y)
    throw new RangeError('Outside ICON-D2 tiles');
  const c0=tx*t.size,r0=ty*t.size;
  // Last block includes an extra shared endpoint pixel.
  const cols=Math.min(t.size+(tx===t.tiles_x-1?1:0),manifest.width-c0);
  const rows=Math.min(t.size+(ty===t.tiles_y-1?1:0),manifest.height-r0);
  if(cols<1||rows<1)throw new RangeError('Empty ICON-D2 tile');
  const n=cols*rows;
  return {tx,ty,c0,r0,cols,rows,n,
    url:manifest.base+t.path.replace('{x:02d}',String(tx).padStart(2,'0'))
      .replace('{y:02d}',String(ty).padStart(2,'0'))+'?run='+encodeURIComponent(manifest.run),
    expected:n*(manifest.precipitation.count*2+manifest.cloud.count+manifest.temp.count*2)};
}
export function visibleIconSpatialTiles(manifest,width,height,zoom,center){
  const crop=visibleNativeCrop(manifest,width,height,zoom,center);
  if(!crop)return [];
  const block=manifest.point_series.size,tiles=[];
  const firstX=Math.max(0,Math.floor(crop.c0/block)),
    lastX=Math.min(manifest.point_series.tiles_x-1,Math.floor(crop.c1/block));
  const firstY=Math.max(0,Math.floor(crop.r0/block)),
    lastY=Math.min(manifest.point_series.tiles_y-1,Math.floor(crop.r1/block));
  for(let ty=firstY;ty<=lastY;ty++)for(let tx=firstX;tx<=lastX;tx++)
    tiles.push(spatialTileInfo(manifest,tx,ty));
  // Fetch centre tiles first, so errors do not affect distant map regions.
  const mx=(crop.c0+crop.c1)/2/block,my=(crop.r0+crop.r1)/2/block;
  return tiles.sort((a,b)=>
    ((a.tx-mx)**2+(a.ty-my)**2)-((b.tx-mx)**2+(b.ty-my)**2));
}
export function peekIconSpatialTile(manifest,tx,ty){
  const key=serialIndex(manifest,tx,ty);
  const tile=decoded.get(key);if(!tile)return null;
  decoded.delete(key);decoded.set(key,tile);return tile;
}
export async function downloadIconSpatialTile(manifest,tx,ty,{signal}={}){
  const spec=spatialTileInfo(manifest,tx,ty),key=serialIndex(manifest,tx,ty);
  const already=peekIconSpatialTile(manifest,tx,ty);
  if(already)return already;
  if(!pending.has(key)){
    pending.set(key,(async()=>{
      const raw=await compressedFrame(spec.url,'series',spec.expected);
      const precipitationBytes=manifest.precipitation.count*spec.n*2;
      const cloudBytes=manifest.cloud.count*spec.n;
      const tile={...spec,manifest,
        precip:new Uint16Array(raw,0,manifest.precipitation.count*spec.n),
        cloud:new Uint8Array(raw,precipitationBytes,cloudBytes)};
      decoded.set(key,tile);
      while(decoded.size>MAX_DECODED_TILES)decoded.delete(decoded.keys().next().value);
      return tile;
    })().finally(()=>pending.delete(key)));
  }
  const result=await pending.get(key);
  if(signal?.aborted)throw new DOMException('ICON spatial tile cancelled','AbortError');
  return result;
}
export function spatialFieldValues(tile,field,time){
  if(!['precip','cloud'].includes(field))return null;
  const info=findRasterFile(tile.manifest,field,time);
  if(!info)return null;
  const source=tile[field];
  return source.subarray(info.index*tile.n,(info.index+1)*tile.n);
}
export function paintIconSpatialTile(ctx,tile,field,time,width,height,zoom,center){
  const values=spatialFieldValues(tile,field,time);if(!values)return;
  const {west,south,east,north,dx,dy}=(()=>{
    const [west,south,east,north]=tile.manifest.bbox;
    return {west,south,east,north,dx:(east-west)/(tile.manifest.width-1),
      dy:(north-south)/(tile.manifest.height-1)};
  })();
  // Each tile spans the centres of a regional patch; extend half a pixel
  // at each edge so neighbouring tiles are seamless in Web Mercator.
  const left=west+(tile.c0-.5)*dx,right=left+tile.cols*dx;
  const top=north-(tile.r0-.5)*dy,bottom=top-tile.rows*dy;
  const manifest={bbox:[left,bottom,right,top],width:tile.cols,height:tile.rows};
  paintNativeField(ctx,manifest,values,field,width,height,zoom,center,field==='cloud'?.58:.87);
}
export async function preloadIconSpatialViewport(manifest,width,height,zoom,center,
    {signal,onProgress}={}){
  const targets=visibleIconSpatialTiles(manifest,width,height,zoom,center);
  let done=0,errors=0;
  for(const spec of targets){
    if(signal?.aborted)return {done,total:targets.length,errors,cancelled:true};
    try{await downloadIconSpatialTile(manifest,spec.tx,spec.ty,{signal});}
    catch(error){if(signal?.aborted)return {done,total:targets.length,errors,cancelled:true};errors++;}
    done++;onProgress?.({done,total:targets.length,errors});
  }
  return {done,total:targets.length,errors,cancelled:false};
}
