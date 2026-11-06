/** GPU renderer for 8-bit coded weather tiles (ICON-D2, radar, nowcast).
 *
 * Exactness: tiles are lossless grey WebP. They are decoded with
 * createImageBitmap(blob,{colorSpaceConversion:'none',premultiplyAlpha:'none'}),
 * uploaded with UNPACK_COLORSPACE_CONVERSION_WEBGL = NONE and no
 * premultiplication, sampled NEAREST, and the red channel is the code.
 * A 256-entry palette texture maps code -> RGBA (255 = transparent).
 *
 * Geometry: the base map is Web Mercator, the data grid is regular lat/lon.
 * Longitude is linear in Mercator x, so the column is interpolated directly;
 * latitude is recovered per fragment from the Mercator y (no per-tile-corner
 * approximation). One shared offscreen WebGL canvas renders a frame, which
 * is then composited into the visible 2D layer canvas with drawImage, so the
 * existing crossfade/boundary transitions keep working unchanged.
 *
 * Memory: a whole chunk tile (all frames) is one or a few textures ("slabs",
 * split when taller than MAX_TEXTURE_SIZE). Decoded bitmaps are closed right
 * after upload; textures live in a byte-bounded LRU and are deleted on eviction.
 */
import {tileBounds,tilesInView,tileSize,paletteLUT,cellAt,NODATA} from './tile-service.mjs';
import {mercator,unmercator} from './logic.mjs';
import {tileBlob} from './tile-loader.mjs';

export const BITMAP_OPTIONS=Object.freeze({colorSpaceConversion:'none',premultiplyAlpha:'none'});
const GPU_BUDGET=56*1024*1024;
const CPU_BUDGET=40*1024*1024;
const MAX_DECODES=2;

const VERT=`
attribute vec2 aPos;
attribute vec2 aGeo;
varying vec2 vGeo;
void main(){vGeo=aGeo;gl_PointSize=1.0;gl_Position=vec4(aPos,0.0,1.0);}`;
const FRAG=`
precision highp float;
varying vec2 vGeo;            // x: column inside tile (texel units), y: Web Mercator y (0..1 world)
uniform sampler2D uTex;
uniform sampler2D uPalette;
uniform float uNorth, uLatStep, uRow0, uTileW, uTileH, uFrame, uTexRows, uAlpha, uIdentity;
const float PI=3.14159265358979;
void main(){
  float lat=degrees(2.0*atan(exp(PI*(1.0-2.0*vGeo.y)))-0.5*PI);
  float row=(uNorth-lat)/uLatStep+0.5-uRow0;
  float col=vGeo.x;
  if(row<0.0||row>=uTileH||col<0.0||col>=uTileW)discard;
  vec2 st=vec2((floor(col)+0.5)/uTileW,(uFrame*uTileH+floor(row)+0.5)/uTexRows);
  float code=floor(texture2D(uTex,st).r*255.0+0.5);
  if(uIdentity>0.5){gl_FragColor=vec4(code/255.0,0.0,0.0,1.0);return;}
  vec4 c=texture2D(uPalette,vec2((code+0.5)/256.0,0.5));
  float a=c.a*uAlpha;
  gl_FragColor=vec4(c.rgb*a,a);
}`;

function decodeLimiter(){
  let active=0;const queue=[];
  return task=>new Promise((resolve,reject)=>{
    const run=()=>{active++;task().then(resolve,reject).finally(()=>{active--;queue.shift()?.();});};
    if(active<MAX_DECODES)run();else queue.push(run);
  });
}
/** The fragment shader's latitude formula, in JS (normalised world Mercator
 * y in 0..1 -> degrees). Kept identical to FRAG and unit-tested. */
export const latitudeFromMercatorY=y=>(2*Math.atan(Math.exp(Math.PI*(1-2*y)))-Math.PI/2)*180/Math.PI;
const cacheKind=frame=>frame.source==='icon'?'icon':'radar';
/** Visible, published tiles of a frame (absent tiles are dry / outside the model). */
export function visibleFrameTiles(frame,view){
  if(!frame)return [];
  return tilesInView(frame.grid,frame.tile,view).filter(t=>frame.tiles.has(t.x+'_'+t.y))
    .map(t=>({...t,url:frame.url(t.x,t.y)}));
}
/** Screen rectangle (CSS px) and Mercator y range of a tile. */
export function tileQuad(frame,x,y,view){
  const b=tileBounds(frame.grid,frame.tile,x,y),world=256*2**view.zoom;
  const c=mercator(view.latitude,view.longitude,view.zoom);
  const lonX=lon=>view.width/2+(lon-view.longitude)/360*world;
  const my=lat=>mercator(lat,0,0).y/256;
  return {x0:lonX(b.west),x1:lonX(b.east),y0:view.height/2+my(b.north)*world-c.y,
    y1:view.height/2+my(b.south)*world-c.y,m0:my(b.north),m1:my(b.south),w:b.w,h:b.h};
}

export function createRasterRenderer({forceCanvas=false,fetchBlob=tileBlob,onContextRestored=null}={}){
  const limit=decodeLimiter();
  const entries=new Map();   // url -> {slabs:[{tex|codes,first,count}],w,h,frames,bytes}
  const pending=new Map();
  const failed=new Map();    // url -> time of failure (retry after 60 s)
  const colored=new Map();   // canvas fallback: url|frame|layer -> canvas
  const canvas=typeof document!=='undefined'?document.createElement('canvas'):null;
  let gl=null,gl2=false,prog=null,buf=null,loc={},palettes=new Map(),maxTex=4096;
  let format='canvas',bytesPerTexel=4,usedBytes=0,lost=false,fbo=null,formatVerified=false,generation=0;

  function initGL(){
    if(forceCanvas||!canvas)return false;
    const attrs={alpha:true,premultipliedAlpha:true,antialias:false,depth:false,stencil:false,preserveDrawingBuffer:false};
    gl=canvas.getContext('webgl2',attrs);gl2=Boolean(gl);
    if(!gl)gl=canvas.getContext('webgl',attrs)||canvas.getContext('experimental-webgl',attrs);
    if(!gl)return false;
    const hp=gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER,gl.HIGH_FLOAT);
    if(!hp||hp.precision<23){gl=null;return false;}
    const sh=(type,src)=>{const s=gl.createShader(type);gl.shaderSource(s,src);gl.compileShader(s);
      if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(s));return s;};
    prog=gl.createProgram();
    gl.attachShader(prog,sh(gl.VERTEX_SHADER,VERT));gl.attachShader(prog,sh(gl.FRAGMENT_SHADER,FRAG));
    gl.linkProgram(prog);
    if(!gl.getProgramParameter(prog,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    for(const n of ['aPos','aGeo'])loc[n]=gl.getAttribLocation(prog,n);
    for(const n of ['uTex','uPalette','uNorth','uLatStep','uRow0','uTileW','uTileH','uFrame','uTexRows','uAlpha','uIdentity'])
      loc[n]=gl.getUniformLocation(prog,n);
    buf=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buf);
    gl.enableVertexAttribArray(loc.aPos);gl.enableVertexAttribArray(loc.aGeo);
    gl.vertexAttribPointer(loc.aPos,2,gl.FLOAT,false,16,0);
    gl.vertexAttribPointer(loc.aGeo,2,gl.FLOAT,false,16,8);
    gl.uniform1i(loc.uTex,0);gl.uniform1i(loc.uPalette,1);
    gl.disable(gl.BLEND);gl.disable(gl.DEPTH_TEST);
    maxTex=gl.getParameter(gl.MAX_TEXTURE_SIZE)||4096;
    // A restored context keeps the upload format proven at startup (r8/luminance or the rgba fallback).
    if(!formatVerified){format=gl2?'r8':'luminance';bytesPerTexel=1;}
    palettes=new Map();fbo=null;
    return true;
  }
  function pixelStore(){
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL,gl.NONE);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,false);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,false);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT,1);
  }
  function texParams(){
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
  }
  function uploadCodes(source){
    const tex=gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,tex);texParams();pixelStore();
    if(format==='r8')gl.texImage2D(gl.TEXTURE_2D,0,gl.R8,gl.RED,gl.UNSIGNED_BYTE,source);
    else if(format==='luminance')gl.texImage2D(gl.TEXTURE_2D,0,gl.LUMINANCE,gl.LUMINANCE,gl.UNSIGNED_BYTE,source);
    else gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,source);
    return tex;
  }
  function palette(layer){
    if(palettes.has(layer))return palettes.get(layer);
    const tex=gl.createTexture();
    gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_2D,tex);texParams();
    gl.pixelStorei(gl.UNPACK_ALIGNMENT,1);gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,false);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,256,1,0,gl.RGBA,gl.UNSIGNED_BYTE,paletteLUT(layer));
    palettes.set(layer,tex);return tex;
  }
  function release(url){
    const e=entries.get(url);if(!e)return;
    if(gl&&!lost)for(const s of e.slabs)if(s.tex)gl.deleteTexture(s.tex);
    usedBytes-=e.bytes;entries.delete(url);
    for(const k of colored.keys())if(k.startsWith(url+'|'))colored.delete(k);
  }
  function evict(keep=new Set()){
    const budget=gl?GPU_BUDGET:CPU_BUDGET;
    for(const url of [...entries.keys()]){
      if(usedBytes<=budget)break;
      if(!keep.has(url))release(url);
    }
  }
  function touch(url){const e=entries.get(url);if(e){entries.delete(url);entries.set(url,e);}return e;}

  async function decodeAndStore(url,frames,kind){
    const blob=await fetchBlob(url,kind);
    await formatReady;
    return limit(async()=>{
      // Textures made in an earlier GL context (or CPU codes decoded while it
      // was lost) are useless after a context loss/restore: never store them.
      const startedIn=generation;
      const bitmap=await createImageBitmap(blob,BITMAP_OPTIONS);
      try{
        const w=bitmap.width,h=bitmap.height/frames;
        if(!Number.isInteger(h)||h<1)throw new Error('Tile height is not a multiple of its frame count');
        const slabs=[];
        if(gl&&!lost){
          const per=Math.max(1,Math.min(frames,Math.floor(maxTex/h)));
          for(let first=0;first<frames;first+=per){
            const count=Math.min(per,frames-first);
            const src=count===frames?bitmap:await createImageBitmap(bitmap,0,first*h,w,count*h,BITMAP_OPTIONS);
            try{slabs.push({tex:uploadCodes(src),first,count});}
            finally{if(src!==bitmap)src.close?.();}
          }
        }else{
          const c=document.createElement('canvas');c.width=w;c.height=bitmap.height;
          const ctx=c.getContext('2d',{willReadFrequently:true});ctx.drawImage(bitmap,0,0);
          slabs.push({codes:ctx.getImageData(0,0,w,bitmap.height).data,first:0,count:frames});
        }
        if(startedIn!==generation){
          if(gl&&!lost)for(const s of slabs)if(s.tex)gl.deleteTexture(s.tex);
          // Not a failure: leave the tile unloaded so the next draw fetches it again.
          return;
        }
        const bytes=w*bitmap.height*(gl&&!lost?bytesPerTexel:4);
        release(url);
        entries.set(url,{slabs,w,h,frames,bytes});usedBytes+=bytes;
      }finally{bitmap.close?.();}
    });
  }
  function ensure(url,frames,kind){
    if(touch(url))return Promise.resolve(true);
    const f=failed.get(url);
    if(f&&Date.now()-f<60_000)return Promise.reject(new Error('Tile recently unavailable'));
    if(!pending.has(url)){
      pending.set(url,decodeAndStore(url,frames,kind).then(()=>{failed.delete(url);return true;},
        error=>{failed.set(url,Date.now());throw error;}).finally(()=>pending.delete(url)));
    }
    return pending.get(url);
  }
  function ready(frame,view){
    return visibleFrameTiles(frame,view).every(t=>entries.has(t.url)||(failed.has(t.url)&&Date.now()-failed.get(t.url)<60_000));
  }
  /** Load every visible tile of the frame's chunk. Resolves {ok,failed,total}. */
  async function load(frame,view){
    const tiles=visibleFrameTiles(frame,view);
    const results=await Promise.allSettled(tiles.map(t=>ensure(t.url,frame.frames,cacheKind(frame))));
    const bad=results.filter(r=>r.status==='rejected').length;
    // 404/403: the publisher already deleted a tile the (older) index still lists.
    const missing=results.filter(r=>r.status==='rejected'&&[403,404].includes(r.reason?.status)).length;
    evict(new Set(tiles.map(t=>t.url)));
    return {ok:tiles.length-bad,failed:bad,missing,total:tiles.length};
  }
  function slabFor(entry,index){return entry.slabs.find(s=>index>=s.first&&index<s.first+s.count);}
  function sizeCanvas(view){
    const w=Math.max(1,Math.round(view.width*(view.ratio||1))),h=Math.max(1,Math.round(view.height*(view.ratio||1)));
    if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;}
    return {w,h};
  }
  const verts=new Float32Array(16);
  function drawTiles(frame,view,{identity=false,alpha=1}={}){
    gl.useProgram(prog);gl.bindBuffer(gl.ARRAY_BUFFER,buf);
    gl.uniform1f(loc.uIdentity,identity?1:0);gl.uniform1f(loc.uAlpha,alpha);
    gl.uniform1f(loc.uNorth,frame.grid.north);gl.uniform1f(loc.uLatStep,frame.grid.latStep);
    gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_2D,palette(frame.layer));
    let drawn=0;
    for(const t of visibleFrameTiles(frame,view)){
      const e=touch(t.url);if(!e)continue;
      const slab=slabFor(e,frame.index);if(!slab)continue;
      const q=tileQuad(frame,t.x,t.y,view);
      const cx=x=>x/view.width*2-1,cy=y=>1-y/view.height*2;
      verts.set([cx(q.x0),cy(q.y0),0,q.m0, cx(q.x1),cy(q.y0),q.w,q.m0,
        cx(q.x0),cy(q.y1),0,q.m1, cx(q.x1),cy(q.y1),q.w,q.m1]);
      gl.bufferData(gl.ARRAY_BUFFER,verts,gl.DYNAMIC_DRAW);
      gl.uniform1f(loc.uRow0,t.y*frame.tile);gl.uniform1f(loc.uTileW,e.w);gl.uniform1f(loc.uTileH,e.h);
      gl.uniform1f(loc.uFrame,frame.index-slab.first);gl.uniform1f(loc.uTexRows,slab.count*e.h);
      gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,slab.tex);
      gl.drawArrays(gl.TRIANGLE_STRIP,0,4);drawn++;
    }
    return drawn;
  }
  /* ----- Canvas 2D fallback (only when WebGL/highp is unavailable) ----- */
  const lutCache=new Map();
  function lut32(layer){
    if(!lutCache.has(layer)){
      const bytes=paletteLUT(layer),out=new Uint32Array(256),view=new DataView(bytes.buffer);
      for(let i=0;i<256;i++)out[i]=view.getUint32(i*4,true);
      lutCache.set(layer,out);
    }
    return lutCache.get(layer);
  }
  function coloredTile(url,e,frame){
    const key=url+'|'+frame.index+'|'+frame.layer;
    if(colored.has(key)){const c=colored.get(key);colored.delete(key);colored.set(key,c);return c;}
    const c=document.createElement('canvas');c.width=e.w;c.height=e.h;
    const ctx=c.getContext('2d'),img=ctx.createImageData(e.w,e.h),out=new Uint32Array(img.data.buffer);
    const codes=e.slabs[0].codes,lut=lut32(frame.layer),base=frame.index*e.h*e.w;
    for(let i=0;i<out.length;i++)out[i]=lut[codes[(base+i)*4]];
    ctx.putImageData(img,0,0);
    colored.set(key,c);while(colored.size>48)colored.delete(colored.keys().next().value);
    return c;
  }
  function drawCanvas2D(ctx,frame,view,alpha){
    ctx.save();ctx.globalAlpha=alpha;ctx.imageSmoothingEnabled=false;
    const c=mercator(view.latitude,view.longitude,view.zoom);
    for(const t of visibleFrameTiles(frame,view)){
      const e=touch(t.url);if(!e)continue;
      const src=coloredTile(t.url,e,frame),q=tileQuad(frame,t.x,t.y,view);
      for(let r=0;r<e.h;r+=4){
        const k=Math.min(4,e.h-r);
        const top=frame.grid.north-(t.y*frame.tile+r-.5)*frame.grid.latStep;
        const bottom=frame.grid.north-(t.y*frame.tile+r+k-.5)*frame.grid.latStep;
        const y0=view.height/2+mercator(top,0,view.zoom).y-c.y,y1=view.height/2+mercator(bottom,0,view.zoom).y-c.y;
        if(y1<0||y0>view.height)continue;
        ctx.drawImage(src,0,r,e.w,k,q.x0,y0,q.x1-q.x0,y1-y0+.3);
      }
    }
    ctx.restore();
  }
  /** Draw a ready frame into a 2D layer context (already scaled to CSS px). */
  function draw(ctx,frame,view,{alpha=1}={}){
    if(!frame)return 0;
    if(!gl||lost){drawCanvas2D(ctx,frame,view,alpha);return 1;}
    const {w,h}=sizeCanvas(view);
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.viewport(0,0,w,h);
    gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);
    const drawn=drawTiles(frame,view,{alpha});
    ctx.drawImage(canvas,0,0,view.width,view.height);
    return drawn;
  }
  /** Codes on a regular cols x rows grid of cell centres over the view
   * (row 0 = top). 255 where no data. GPU path: identity palette into a
   * small framebuffer + readPixels; no per-pixel JS work. */
  function sampleGrid(frame,view,cols,rows){
    const out=new Uint8Array(cols*rows).fill(NODATA);
    if(!frame||cols<1||rows<1)return out;
    if(!gl||lost){
      for(let j=0;j<rows;j++)for(let i=0;i<cols;i++){
        const c=mercator(view.latitude,view.longitude,view.zoom);
        const p=unmercator(c.x+((i+.5)/cols-.5)*view.width,c.y+((j+.5)/rows-.5)*view.height,view.zoom);
        out[j*cols+i]=cpuCode(frame,p.lat,p.lon);
      }
      return out;
    }
    if(!fbo){
      fbo={fb:gl.createFramebuffer(),tex:gl.createTexture(),w:0,h:0};
    }
    if(fbo.w!==cols||fbo.h!==rows){
      gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,fbo.tex);texParams();
      gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,cols,rows,0,gl.RGBA,gl.UNSIGNED_BYTE,null);
      gl.bindFramebuffer(gl.FRAMEBUFFER,fbo.fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,fbo.tex,0);
      fbo.w=cols;fbo.h=rows;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER,fbo.fb);gl.viewport(0,0,cols,rows);
    gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);
    drawSamplePoints(frame,view,cols,rows);
    const px=new Uint8Array(cols*rows*4);
    gl.readPixels(0,0,cols,rows,gl.RGBA,gl.UNSIGNED_BYTE,px);
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);
    for(let j=0;j<rows;j++)for(let i=0;i<cols;i++){
      const k=((rows-1-j)*cols+i)*4;           // GL rows start at the bottom
      out[j*cols+i]=px[k+3]?px[k]:NODATA;
    }
    return out;
  }
  /** One GL point per sample, at the centre of framebuffer pixel (i,j), with
   * its exact texel column and Mercator y computed here. Rasterising the map
   * quads into a tiny framebuffer instead would inherit the GPU's sub-pixel
   * vertex snapping, which at a few pixels wide is several screen pixels. */
  function drawSamplePoints(frame,view,cols,rows){
    gl.useProgram(prog);gl.bindBuffer(gl.ARRAY_BUFFER,buf);
    gl.uniform1f(loc.uIdentity,1);gl.uniform1f(loc.uAlpha,1);
    gl.uniform1f(loc.uNorth,frame.grid.north);gl.uniform1f(loc.uLatStep,frame.grid.latStep);
    gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_2D,palette(frame.layer));
    const world=256*2**view.zoom,c=mercator(view.latitude,view.longitude,view.zoom),g=frame.grid;
    for(const t of visibleFrameTiles(frame,view)){
      const e=touch(t.url);if(!e)continue;
      const slab=slabFor(e,frame.index);if(!slab)continue;
      const pts=[];
      for(let j=0;j<rows;j++)for(let i=0;i<cols;i++){
        const x=(i+.5)/cols*view.width,y=(j+.5)/rows*view.height;
        const lon=view.longitude+(x-view.width/2)/world*360,my=(c.y+y-view.height/2)/world;
        const u=(lon-g.west)/g.lonStep+.5-t.x*frame.tile;
        const row=(g.north-latitudeFromMercatorY(my))/g.latStep+.5-t.y*frame.tile;
        if(u>=0&&u<e.w&&row>=0&&row<e.h)pts.push((i+.5)/cols*2-1,1-(j+.5)/rows*2,u,my);
      }
      if(!pts.length)continue;
      gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(pts),gl.DYNAMIC_DRAW);
      gl.uniform1f(loc.uRow0,t.y*frame.tile);gl.uniform1f(loc.uTileW,e.w);gl.uniform1f(loc.uTileH,e.h);
      gl.uniform1f(loc.uFrame,frame.index-slab.first);gl.uniform1f(loc.uTexRows,slab.count*e.h);
      gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,slab.tex);
      gl.drawArrays(gl.POINTS,0,pts.length/4);
    }
  }
  function cpuCode(frame,lat,lon){
    const cell=cellAt(frame.grid,lat,lon);if(!cell)return NODATA;
    const x=Math.floor(cell.col/frame.tile),y=Math.floor(cell.row/frame.tile);
    if(!frame.tiles.has(x+'_'+y))return NODATA;
    const e=entries.get(frame.url(x,y));if(!e?.slabs[0]?.codes)return NODATA;
    const col=cell.col-x*frame.tile,row=cell.row-y*frame.tile;
    return e.slabs[0].codes[((frame.index*e.h+row)*e.w+col)*4];
  }
  /** Code at one geographic point for a loaded frame (pin readout, tests). */
  function sampleAt(frame,lat,lon){
    return sampleGrid(frame,{latitude:lat,longitude:lon,zoom:12,width:8,height:8,ratio:1},1,1)[0];
  }
  /** Proof that codes survive exactly: decode the same blob through the 2D
   * canvas path and through the WebGL texture + identity shader and compare
   * every pixel of one frame. */
  async function selfCheck(blob,frames,frameIndex=0){
    const bitmap=await createImageBitmap(blob,BITMAP_OPTIONS);
    try{
      const w=bitmap.width,h=bitmap.height/frames;
      const c=document.createElement('canvas');c.width=w;c.height=h;
      const ctx=c.getContext('2d',{willReadFrequently:true});
      ctx.drawImage(bitmap,0,frameIndex*h,w,h,0,0,w,h);
      const ref=ctx.getImageData(0,0,w,h).data;
      let nonGrey=0;
      for(let i=0;i<w*h;i++)if(ref[i*4]!==ref[i*4+1]||ref[i*4]!==ref[i*4+2])nonGrey++;
      if(!gl||lost)return {renderer:'canvas2d',format,checked:w*h,mismatches:0,nonGrey,ok:nonGrey===0};
      const per=Math.max(1,Math.min(frames,Math.floor(maxTex/h))),first=Math.floor(frameIndex/per)*per;
      const count=Math.min(per,frames-first);
      const src=count===frames?bitmap:await createImageBitmap(bitmap,0,first*h,w,count*h,BITMAP_OPTIONS);
      const tex=uploadCodes(src);if(src!==bitmap)src.close?.();
      // Direct texel-aligned render (no map projection) into a w x h target.
      const fb=gl.createFramebuffer(),target=gl.createTexture();
      gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,target);texParams();
      gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,w,h,0,gl.RGBA,gl.UNSIGNED_BYTE,null);
      gl.bindFramebuffer(gl.FRAMEBUFFER,fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,target,0);
      gl.viewport(0,0,w,h);gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);
      // Synthetic grid: north=0, latStep chosen so Mercator y maps rows linearly
      // enough? No: use an equatorial strip where one row = one pixel exactly.
      gl.useProgram(prog);gl.bindBuffer(gl.ARRAY_BUFFER,buf);
      const latStep=1e-3,north=0;
      const m=lat=>mercator(lat,0,0).y/256;
      verts.set([-1,1,0,m(north+.5*latStep), 1,1,w,m(north+.5*latStep),
        -1,-1,0,m(north-(h-.5)*latStep), 1,-1,w,m(north-(h-.5)*latStep)]);
      gl.bufferData(gl.ARRAY_BUFFER,verts,gl.DYNAMIC_DRAW);
      gl.uniform1f(loc.uIdentity,1);gl.uniform1f(loc.uAlpha,1);gl.uniform1f(loc.uNorth,north);
      gl.uniform1f(loc.uLatStep,latStep);gl.uniform1f(loc.uRow0,0);gl.uniform1f(loc.uTileW,w);
      gl.uniform1f(loc.uTileH,h);gl.uniform1f(loc.uFrame,frameIndex-first);gl.uniform1f(loc.uTexRows,count*h);
      gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,tex);
      gl.drawArrays(gl.TRIANGLE_STRIP,0,4);
      const px=new Uint8Array(w*h*4);gl.readPixels(0,0,w,h,gl.RGBA,gl.UNSIGNED_BYTE,px);
      gl.bindFramebuffer(gl.FRAMEBUFFER,null);
      gl.deleteFramebuffer(fb);gl.deleteTexture(target);gl.deleteTexture(tex);
      let mismatches=0,firstMismatch=null;
      for(let r=0;r<h;r++)for(let col=0;col<w;col++){
        const got=px[((h-1-r)*w+col)*4],want=ref[(r*w+col)*4];
        if(got!==want){mismatches++;firstMismatch??={row:r,col,got,want};}
      }
      return {renderer:gl2?'webgl2':'webgl',format,checked:w*h,mismatches,nonGrey,firstMismatch,ok:mismatches===0&&nonGrey===0};
    }finally{bitmap.close?.();}
  }
  /** Startup check of the upload path itself with all 256 codes. If the
   * single-channel upload is not byte-exact on this GPU, use RGBA8. */
  async function verifyUploadFormat(){
    if(!gl||typeof ImageData!=='function')return format;
    const w=16,h=16,img=new ImageData(w,h);
    for(let i=0;i<256;i++){img.data[i*4]=img.data[i*4+1]=img.data[i*4+2]=i;img.data[i*4+3]=255;}
    const c=document.createElement('canvas');c.width=w;c.height=h;c.getContext('2d').putImageData(img,0,0);
    const blob=await new Promise(r=>c.toBlob(r,'image/png'));
    if(!blob)return format;
    let result=await selfCheck(blob,1);
    if(!result.ok&&format!=='rgba'){format='rgba';bytesPerTexel=4;result=await selfCheck(blob,1);}
    return format;
  }
  const available=initGL();
  // No tile texture is uploaded before the single-channel format is proven exact.
  const formatReady=(available?verifyUploadFormat().catch(()=>{format='rgba';bytesPerTexel=4;}):Promise.resolve())
    .finally(()=>{formatVerified=true;});
  function forgetAll(){generation++;entries.clear();colored.clear();failed.clear();usedBytes=0;palettes=new Map();fbo=null;}
  if(canvas){
    canvas.addEventListener('webglcontextlost',event=>{event.preventDefault();lost=true;forgetAll();});
    // Tiles decoded while the context was lost hold CPU codes, not textures: drop them too.
    canvas.addEventListener('webglcontextrestored',()=>{lost=false;forgetAll();initGL();onContextRestored?.();});
  }
  return {
    get kind(){return gl&&!lost?(gl2?'webgl2':'webgl'):'canvas2d';},
    get format(){return format;},
    get usedBytes(){return usedBytes;},
    get textureCount(){return entries.size;},
    available,ready,load,draw,sampleGrid,sampleAt,selfCheck,formatReady,
    prefetch:(frame,view)=>{void load(frame,view).catch(()=>{});},
    isLoaded:url=>entries.has(url),
    clear(){for(const url of [...entries.keys()])release(url);},
  };
}

/** Sparse wind-direction arrows (direction the wind blows TO) drawn over the
 * map from codes sampled on a coarse grid. */
export function drawWindArrows(ctx,renderer,frame,view,{spacing=46}={}){
  const cols=Math.max(1,Math.floor(view.width/spacing)),rows=Math.max(1,Math.floor(view.height/spacing));
  const codes=renderer.sampleGrid(frame,view,cols,rows);
  ctx.save();ctx.lineCap='round';ctx.lineJoin='round';
  for(let j=0;j<rows;j++)for(let i=0;i<cols;i++){
    const code=codes[j*cols+i];if(code===NODATA)continue;
    const from=code*1.5*Math.PI/180,to=from+Math.PI;
    const x=(i+.5)*view.width/cols,y=(j+.5)*view.height/rows,len=13;
    const dx=Math.sin(to)*len,dy=-Math.cos(to)*len;
    const path=()=>{ctx.beginPath();ctx.moveTo(x-dx,y-dy);ctx.lineTo(x+dx,y+dy);
      const a=Math.atan2(dy,dx);
      ctx.moveTo(x+dx,y+dy);ctx.lineTo(x+dx-7*Math.cos(a-.45),y+dy-7*Math.sin(a-.45));
      ctx.moveTo(x+dx,y+dy);ctx.lineTo(x+dx-7*Math.cos(a+.45),y+dy-7*Math.sin(a+.45));};
    path();ctx.strokeStyle='rgba(8,22,38,.75)';ctx.lineWidth=4.2;ctx.stroke();
    path();ctx.strokeStyle='#ffffff';ctx.lineWidth=1.8;ctx.stroke();
  }
  ctx.restore();
}
