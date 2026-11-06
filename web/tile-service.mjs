/** OpenWetter tile service: pure parsing, time/tile selection, decoding and
 * palettes. No DOM access, so every function is testable in Node.
 *
 * Service layout (https://openwetter-data.ekotov.pro):
 *   latest.json                    rolling pointer, short cache
 *   icon_d2/<runKey>/manifest.json immutable ICON-D2 run manifest
 *   icon_d2/<runKey>/<layer>/cNN/<x>_<y>.webp   lossless grey WebP chunk tiles
 *   icon_d2/history/index.json     3-hour slices of earlier runs (max-age 60)
 *   icon_d2/history/<runKey>/<layer>/<x>_<y>.webp   history slice tiles
 *   radar/index.json, nowcast/index.json, warnings/index.json  (max-age 60)
 * Codes are 8-bit; 255 = no data. Each layer has its own decode formula.
 */
import {mercator,unmercator,wrappedLongitude} from './logic.mjs';

export const DATA_BASE='https://openwetter-data.ekotov.pro/';
export const NODATA=255;
export const ICON_LAYERS=Object.freeze(['precip','snow','cloud_total','cloud_low','cloud_mid','cloud_high',
  'temperature','dew_point','humidity','pressure','wind_speed','wind_gust','wind_direction']);

/* ---------- decode formulas (code -> physical value) ---------- */
const RAIN_MIN=0.05,RAIN_MAX=64;
/** Rain/snow rate in mm/h. 0 = dry (below 0.05 mm/h), 255 = no data. */
export function decodeRate(code){
  if(code===0)return 0;
  if(!(code>=1&&code<=254))return null;
  return RAIN_MIN*(RAIN_MAX/RAIN_MIN)**((code-1)/253);
}
const DECODERS={
  rate:decodeRate,
  percent:c=>c<=100?c:null,
  celsius:c=>c<NODATA?c/2-60:null,
  hpa:c=>c<NODATA?c+900:null,
  ms:c=>c<NODATA?c/4:null,
  degrees:c=>c<NODATA?c*1.5:null,
};
/** Layer metadata. `kind` selects the decode formula. */
export const LAYER_INFO=Object.freeze({
  precip:{kind:'rate',label:'Rain',unit:'mm/h',group:'Precipitation',palette:'rain'},
  snow:{kind:'rate',label:'Snowfall',unit:'mm/h (water)',group:'Precipitation',palette:'snow'},
  cloud_total:{kind:'percent',label:'Total cloud',unit:'%',group:'Clouds',palette:'cloud'},
  cloud_low:{kind:'percent',label:'Low cloud',unit:'%',group:'Clouds',palette:'cloud'},
  cloud_mid:{kind:'percent',label:'Mid cloud',unit:'%',group:'Clouds',palette:'cloud'},
  cloud_high:{kind:'percent',label:'High cloud',unit:'%',group:'Clouds',palette:'cloud'},
  temperature:{kind:'celsius',label:'Temperature (2 m)',unit:'°C',group:'Temperature & air',palette:'temperature'},
  dew_point:{kind:'celsius',label:'Dew point (2 m)',unit:'°C',group:'Temperature & air',palette:'temperature'},
  humidity:{kind:'percent',label:'Relative humidity',unit:'%',group:'Temperature & air',palette:'humidity'},
  pressure:{kind:'hpa',label:'Sea-level pressure',unit:'hPa',group:'Temperature & air',palette:'pressure'},
  wind_speed:{kind:'ms',label:'Wind speed (10 m)',unit:'m/s',group:'Wind',palette:'wind'},
  wind_gust:{kind:'ms',label:'Wind gusts (10 m)',unit:'m/s',group:'Wind',palette:'wind'},
  wind_direction:{kind:'degrees',label:'Wind direction (10 m)',unit:'° from',group:'Wind',palette:'direction'},
  radar:{kind:'rate',label:'Radar rain rate',unit:'mm/h',group:'Radar',palette:'rain'},
  nowcast:{kind:'rate',label:'Radar nowcast rain rate',unit:'mm/h',group:'Radar',palette:'rain'},
});
export function decodeCode(layer,code){
  const info=LAYER_INFO[layer];
  if(!info||!Number.isInteger(code)||code<0||code>NODATA)return null;
  if(code===NODATA)return null;
  return DECODERS[info.kind](code);
}

/* ---------- palettes: value-domain colour stops -> 256-entry code LUT ---------- */
/** Position (0..1) of a rain rate on the rain colour scale, spaced as Flowx's
 * legend: 0.05 mm/h at the start, 1, 5 and 20 mm/h at 1/4, 1/2 and 3/4, 50
 * near the end; logarithmic between those marks. */
export function rainScalePosition(v){
  if(!(v>0.05))return 0;
  if(v<=1)return .02+.23*Math.log(v/.05)/Math.log(20);
  if(v<=5)return .25+.25*Math.log(v)/Math.log(5);
  if(v<=20)return .5+.25*Math.log(v/5)/Math.log(4);
  return Math.min(1,.75+.22*Math.log(v/20)/Math.log(2.5));
}
// [value, '#rrggbb', alpha 0..1]. Values outside the first/last stop clamp.
export const PALETTE_STOPS=Object.freeze({
  // Flowx's magenta-blue-green-red ramp ("mbgr"), sampled from its colour-map image at the
  // positions of rainScalePosition (Flowx's legend: 1, 5, 20 mm/h at 1/4, 1/2, 3/4). Opaque
  // here: the layer opacity setting (default 90 %, as Flowx) applies on top.
  rain:[[0.05,'#d000d1',1],[0.2,'#4600b7',1],[0.5,'#0d00f1',1],[1,'#0140fd',1],[2,'#00e8fd',1],[3.5,'#00fd86',1],
    [5,'#00fd2b',1],[10,'#98fd00',1],[20,'#fd9800',1],[35,'#db0000',1],[50,'#990000',1],[64,'#800000',1]],
  snow:[[0.05,'#eef3ff',.45],[0.3,'#cbd8ff',.65],[1,'#9fb1ff',.8],[3,'#7a7cf0',.85],
    [10,'#9b4fd8',.9],[30,'#d23ac0',.92]],
  cloud:[[0,'#ffffff',0],[20,'#eef2f7',.18],[50,'#dfe5ee',.42],[80,'#cdd5e0',.66],[100,'#bfc8d4',.82]],
  temperature:[[-30,'#6b1fa8',.72],[-20,'#3b2fd1',.72],[-10,'#2a6fe0',.72],[-5,'#3aa0e8',.72],
    [0,'#a9e2f5',.72],[5,'#6fd39a',.72],[10,'#b4e05a',.72],[15,'#f2e14a',.72],[20,'#f7b23b',.72],
    [25,'#f2762e',.72],[30,'#e0392b',.72],[40,'#9e1b4a',.72]],
  humidity:[[0,'#b4652c',.65],[30,'#d9a35b',.6],[55,'#ece7b8',.5],[75,'#7fcfc6',.6],[90,'#3b97c9',.68],[100,'#1f5fa8',.72]],
  pressure:[[960,'#6a3fb0',.6],[980,'#3d7fd6',.6],[1000,'#76c8c6',.55],[1013,'#e7e6c6',.5],
    [1025,'#f2b35a',.6],[1040,'#d2553d',.65]],
  wind:[[0,'#cfe8ff',.12],[3,'#8fd0ff',.4],[6,'#57c785',.6],[10,'#eed43a',.72],[15,'#f08a2c',.8],
    [20,'#e2342f',.85],[28,'#a3268f',.9],[40,'#5b1f6b',.92]],
  // Cyclic: from N (blue) via E (green), S (orange), W (magenta) back to N.
  direction:[[0,'#3b7be8',.32],[90,'#3fbf6a',.32],[180,'#f0a030',.32],[270,'#d24fc0',.32],[360,'#3b7be8',.32]],
});
const hex=h=>[1,3,5].map(i=>parseInt(h.slice(i,i+2),16));
function colorAt(stops,v){
  if(v<=stops[0][0])return [...hex(stops[0][1]),stops[0][2]];
  for(let i=1;i<stops.length;i++){
    const [v1,c1,a1]=stops[i];
    if(v<=v1){
      const [v0,c0,a0]=stops[i-1],f=(v-v0)/(v1-v0),p=hex(c0),q=hex(c1);
      return [0,1,2].map(k=>p[k]+(q[k]-p[k])*f).concat(a0+(a1-a0)*f);
    }
  }
  const last=stops.at(-1);return [...hex(last[1]),last[2]];
}
/** 256 x RGBA8 lookup table, non-premultiplied. Code 255 (and "dry" code 0
 * for rain/snow/radar) is transparent. */
export function paletteLUT(layer){
  const info=LAYER_INFO[layer];if(!info)throw new RangeError('Unknown layer '+layer);
  const stops=PALETTE_STOPS[info.palette],lut=new Uint8Array(256*4);
  for(let code=0;code<256;code++){
    const v=decodeCode(layer,code);
    if(v==null||(info.kind==='rate'&&v===0))continue;
    const [r,g,b,a]=colorAt(stops,v);
    lut.set([Math.round(r),Math.round(g),Math.round(b),Math.round(a*255)],code*4);
  }
  return lut;
}
/** Legend stops for the UI: [{value,label,css}] in display order. */
export function legendFor(layer){
  const info=LAYER_INFO[layer];if(!info)return null;
  const stops=PALETTE_STOPS[info.palette];
  const fmt=v=>info.kind==='rate'?(v<1?String(v).replace(/^0/,''):String(Math.round(v))):String(Math.round(v));
  const items=(info.palette==='direction'?stops.slice(0,4):stops).map(([v,c,a])=>{
    const [r,g,b]=hex(c);
    return {value:v,label:info.palette==='direction'?['N','E','S','W'][v/90]:fmt(v),
      css:`rgba(${r},${g},${b},${Math.max(a,.35).toFixed(2)})`};
  });
  return {layer,label:info.label,unit:info.unit,items};
}

/* ---------- times ---------- */
/** "2026-11-06T09:00" (UTC, no zone suffix) -> unix seconds. */
export function parseRunTime(run){
  if(typeof run!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d)?Z?$/.test(run))return null;
  const t=Date.parse(run.endsWith('Z')?run:run+'Z');
  return Number.isFinite(t)?Math.round(t/1000):null;
}
const dirOf=path=>path.slice(0,path.lastIndexOf('/')+1);

/* ---------- latest.json ---------- */
export function parseLatest(data){
  if(!data||data.schema!=='openwetter-tiles-2')throw new Error('Unsupported tile service pointer');
  const path=p=>typeof p==='string'&&/^[\w./-]+\.json$/.test(p)&&!p.includes('..')?p:null;
  const d2=data.icon_d2,manifest=path(d2?.manifest);
  const icon=manifest?{run:d2.run,runTime:parseRunTime(d2.run),manifest}:null;
  // `history` is the path of the history index (icon_d2/history/index.json).
  return {generatedAt:data.generated_at,icon,history:path(d2?.history),
    radar:path(data.radar),nowcast:path(data.nowcast),warnings:path(data.warnings)};
}

/* ---------- grids ---------- */
export function parseGrid(g){
  const ok=g&&['west','north','lon_step','lat_step'].every(k=>Number.isFinite(g[k]))&&
    g.lon_step>0&&g.lat_step>0&&Number.isInteger(g.width)&&Number.isInteger(g.height)&&
    g.width>0&&g.height>0&&g.width*g.height<=4_000_000&&(g.row0??'north')==='north';
  if(!ok)throw new Error('Malformed data grid');
  return {west:g.west,north:g.north,lonStep:g.lon_step,latStep:g.lat_step,width:g.width,height:g.height};
}
/** Fractional pixel position (pixel centres at integers) of a lon/lat. */
export function lonLatToPixel(grid,lon,lat){
  return {col:(lon-grid.west)/grid.lonStep,row:(grid.north-lat)/grid.latStep};
}
/** Nearest grid cell for a point, or null outside the grid. */
export function cellAt(grid,lat,lon){
  const p=lonLatToPixel(grid,lon,lat),col=Math.round(p.col),row=Math.round(p.row);
  if(col<0||row<0||col>=grid.width||row>=grid.height)return null;
  return {col,row};
}
/** Width/height of tile (x,y); the east/south edge tiles are narrower. */
export function tileSize(grid,size,x,y){
  return {w:Math.max(0,Math.min(size,grid.width-x*size)),h:Math.max(0,Math.min(size,grid.height-y*size))};
}
/** Geographic outer edges of a tile: pixel edges sit half a step from centres. */
export function tileBounds(grid,size,x,y){
  const {w,h}=tileSize(grid,size,x,y);
  return {west:grid.west+(x*size-.5)*grid.lonStep,east:grid.west+(x*size+w-.5)*grid.lonStep,
    north:grid.north-(y*size-.5)*grid.latStep,south:grid.north-(y*size+h-.5)*grid.latStep,w,h};
}
/** Texture coordinates inside tile (x,y) for a lon/lat: u,v in 0..1 of the
 * tile's width / single-frame height. Used by the shader logic and tests. */
export function tileTexel(grid,size,x,y,lon,lat){
  const {w,h}=tileSize(grid,size,x,y),p=lonLatToPixel(grid,lon,lat);
  return {u:(p.col+.5-x*size)/w,v:(p.row+.5-y*size)/h};
}
/** Geographic bounds of the visible map (Web Mercator viewport). */
export function viewBounds(view){
  const c=mercator(view.latitude,view.longitude,view.zoom);
  const nw=unmercator(c.x-view.width/2,c.y-view.height/2,view.zoom);
  const se=unmercator(c.x+view.width/2,c.y+view.height/2,view.zoom);
  // Longitudes may wrap; this product covers Europe only, so use the unwrapped span.
  const west=wrappedLongitude(view.longitude)-view.width/2/(256*2**view.zoom)*360;
  const east=wrappedLongitude(view.longitude)+view.width/2/(256*2**view.zoom)*360;
  return {west,east,north:nw.lat,south:se.lat};
}
/** All tile coordinates of `grid` intersecting the viewport, centre first. */
export function tilesInView(grid,size,view){
  const b=viewBounds(view);
  const c0=Math.floor((b.west-grid.west)/grid.lonStep+.5),c1=Math.floor((b.east-grid.west)/grid.lonStep+.5);
  const r0=Math.floor((grid.north-b.north)/grid.latStep+.5),r1=Math.floor((grid.north-b.south)/grid.latStep+.5);
  const nx=Math.ceil(grid.width/size),ny=Math.ceil(grid.height/size);
  const x0=Math.max(0,Math.floor(c0/size)),x1=Math.min(nx-1,Math.floor(c1/size));
  const y0=Math.max(0,Math.floor(r0/size)),y1=Math.min(ny-1,Math.floor(r1/size));
  const out=[];
  for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++)out.push({x,y});
  const mx=(c0+c1)/2/size-.5,my=(r0+r1)/2/size-.5;
  return out.sort((a,b)=>((a.x-mx)**2+(a.y-my)**2)-((b.x-mx)**2+(b.y-my)**2));
}
const tileList=list=>{
  const m=new Map();
  for(const t of Array.isArray(list)?list:[])
    if(Array.isArray(t)&&Number.isInteger(t[0])&&Number.isInteger(t[1])&&t[0]>=0&&t[1]>=0)m.set(t[0]+'_'+t[1],t[2]??0);
  return m;
};

/* ---------- ICON run manifests (ICON-D2, ICON-EU, ICON Global) ---------- */
export const ICON_MODELS=Object.freeze({icon_d2:'ICON-D2',icon_eu:'ICON-EU',icon_global:'ICON'});
export function parseIconManifest(data,manifestPath,{base=DATA_BASE}={}){
  if(!data||data.schema!=='openwetter-tiles-2'||!ICON_MODELS[data.model]||typeof data.layers!=='object')
    throw new Error('Unsupported ICON manifest');
  const runTime=parseRunTime(data.run);
  if(runTime==null)throw new Error('ICON-D2 manifest has no valid run time');
  const grid=parseGrid(data.grid),size=data.tile;
  if(!Number.isInteger(size)||size<8||size>2048)throw new Error('Invalid tile size');
  const dir=base+dirOf(manifestPath);
  const layers={};
  for(const [name,l] of Object.entries(data.layers)){
    if(!LAYER_INFO[name]||!Number.isInteger(l?.step_minutes)||l.step_minutes<=0||!Array.isArray(l.chunks))continue;
    // ICON-EU and ICON Global change from hourly to 3-hourly frames: each chunk has its own step.
    const chunks=l.chunks.filter(c=>Number.isInteger(c?.chunk)&&Number.isInteger(c.first_step_minutes)&&Number.isInteger(c.frames)&&c.frames>0
        &&(c.step_minutes==null||Number.isInteger(c.step_minutes)&&c.step_minutes>0))
      .map(c=>({chunk:c.chunk,first:runTime+c.first_step_minutes*60,frames:c.frames,step:(c.step_minutes??l.step_minutes)*60,tiles:tileList(c.tiles)}))
      .sort((a,b)=>a.first-b.first);
    if(!chunks.length)continue;
    const last=chunks.at(-1);
    layers[name]={name,step:chunks[0].step,chunks,start:chunks[0].first,end:last.first+(last.frames-1)*last.step,
      period:LAYER_INFO[name].kind==='rate',code:l.code||{},missingTile:l.missing_tile||''};
  }
  let series=null;
  const s=data.series;
  if(s&&Number.isInteger(s.tile)&&s.tile>0&&typeof s.path==='string'&&Array.isArray(s.layers)){
    series={tile:s.tile,path:s.path,tiles:tileList(s.tiles),
      layers:s.layers.filter(x=>typeof x?.name==='string'&&Number.isInteger(x.frames)&&x.frames>0&&Number.isInteger(x.step_minutes))
        .map(x=>{const first=runTime+(x.first_step_minutes??x.step_minutes)*60;
          const times=Array.isArray(x.lead_minutes)&&x.lead_minutes.length===x.frames&&x.lead_minutes.every(Number.isInteger)
            ?x.lead_minutes.map(m=>runTime+m*60):Array.from({length:x.frames},(_,i)=>first+i*x.step_minutes*60);
          return {name:x.name,frames:x.frames,step:x.step_minutes*60,first,times};})};
  }
  return {kind:'icon',model:data.model,label:ICON_MODELS[data.model],run:data.run,runTime,generatedAt:data.generated_at,grid,tile:size,
    framesPerChunk:data.frames_per_chunk,dir,layers,series,source:data.source||'DWD '+ICON_MODELS[data.model]};
}
/** Chunk and frame index of `layer` for `time`. Rain and snow frames hold the
 * total of the period ending at the frame (t - step, t]; other layers are
 * instants, so the nearest frame is used (within half a step of the run). */
function locateFrame(L,time){
  if(L.period){
    for(const c of L.chunks){const last=c.first+(c.frames-1)*c.step;
      if(time>c.first-c.step&&time<=last+1e-6)return {c,k:Math.max(0,Math.ceil((time-c.first)/c.step-1e-9))};}
    // Exactly on a 15-minute D2 boundary before the first frame: nearest, as before.
  }
  let best=null;
  for(const c of L.chunks){
    const k=Math.max(0,Math.min(c.frames-1,Math.round((time-c.first)/c.step))),d=Math.abs(c.first+k*c.step-time);
    if(!best||d<best.d)best={c,k,d};
  }
  if(!best)return null;
  const first=L.chunks[0],last=L.chunks.at(-1);
  if(time<L.start-first.step/2||time>L.end+last.step/2)return null;
  return best;
}
/** Frame of `layer` valid nearest to `time` inside one run, or null when the
 * time lies outside the run (more than half a step before/after). */
export function iconFrame(manifest,layer,time){
  const L=manifest?.layers?.[layer];
  if(!L||!Number.isFinite(time))return null;
  const at=locateFrame(L,time);if(!at)return null;
  const chunk=at.c,index=at.k,frameTime=chunk.first+index*chunk.step;
  const pad=String(chunk.chunk).padStart(2,'0');
  // History slices hold the same run at another tile size, so their keys differ; so do models.
  const model=manifest.model||'icon_d2';
  const id=`${manifest.history?'icon-history':model==='icon_d2'?'icon':model}:${manifest.run}:${layer}`;
  return {source:'icon',model,label:manifest.label||ICON_MODELS[model],layer,time:frameTime,step:chunk.step,run:manifest.run,runTime:manifest.runTime,
    grid:manifest.grid,tile:manifest.tile,frames:chunk.frames,index,chunk:chunk.chunk,tiles:chunk.tiles,
    key:`${id}:${frameTime}`,
    url:manifest.tileUrl?(x,y)=>manifest.tileUrl(layer,x,y):(x,y)=>`${manifest.dir}${layer}/c${pad}/${x}_${y}.webp`,
    chunkKey:`${id}:c${pad}`};
}
/** Adjacent chunk descriptor (direction +1/-1) for lazy prefetch. */
export function iconAdjacentChunk(manifest,frame,direction=1){
  const L=manifest?.layers?.[frame?.layer];if(!L)return null;
  const i=L.chunks.findIndex(c=>c.chunk===frame.chunk),c=L.chunks[i+direction];
  if(!c)return null;
  return iconFrame(manifest,frame.layer,c.first+(direction>0?0:(c.frames-1)*c.step));
}
/** Newest run covering `time` for `layer`; manifests sorted in any order. */
export function chooseRun(manifests,layer,time){
  return [...manifests].filter(Boolean).sort((a,b)=>b.runTime-a.runTime)
    .find(m=>iconFrame(m,layer,time))||null;
}
/* ---------- ICON-D2 history (icon_d2/history/index.json) ---------- */
/** One slice per earlier run: the first 3 hours of every layer (rain/snow
 * 12 frames from +15 min, hourly layers 3 frames from +60 min), stored as a
 * single chunk of larger tiles. Each slice becomes a manifest-like object, so
 * chooseRun/iconFrame treat it like a run; `history: true` keeps its frame
 * keys apart from the full run's. Returned newest first. */
export function parseHistoryIndex(data,{base=DATA_BASE}={}){
  if(!data||data.schema!=='openwetter-history-1'||!Array.isArray(data.slices))throw new Error('Unsupported ICON-D2 history index');
  const grid=parseGrid(data.grid),size=data.tile,path=data.path;
  if(!Number.isInteger(size)||size<8||size>2048)throw new Error('Invalid history tile size');
  if(typeof path!=='string'||!['{run_key}','{layer}','{x}','{y}'].every(k=>path.includes(k))||path.includes('..')||/^[a-z]+:/i.test(path))
    throw new Error('Invalid history tile path');
  const out=[];
  for(const s of data.slices){
    const runTime=parseRunTime(s?.run);
    if(runTime==null||typeof s.run_key!=='string'||!/^[\w-]+$/.test(s.run_key)||typeof s.layers!=='object'||!s.layers)continue;
    const layers={};
    for(const [name,l] of Object.entries(s.layers)){
      if(!LAYER_INFO[name]||!Number.isInteger(l?.step_minutes)||l.step_minutes<=0||!Number.isInteger(l.first_step_minutes)||
        l.first_step_minutes<0||!Number.isInteger(l.frames)||l.frames<1)continue;
      const step=l.step_minutes*60,first=runTime+l.first_step_minutes*60;
      layers[name]={name,step,chunks:[{chunk:0,first,frames:l.frames,step,tiles:tileList(l.tiles)}],
        start:first,end:first+(l.frames-1)*step,period:LAYER_INFO[name].kind==='rate',code:data.codes?.[name]||{},missingTile:''};
    }
    if(!Object.keys(layers).length)continue;
    const runPath=path.replace('{run_key}',s.run_key);
    out.push({kind:'icon',model:'icon_d2',label:'ICON-D2',history:true,run:s.run,runTime,generatedAt:data.generated_at,grid,tile:size,framesPerChunk:null,
      dir:null,layers,series:null,source:data.source||'DWD ICON-D2',
      tileUrl:(layer,x,y)=>base+runPath.replace('{layer}',layer).replace('{x}',x).replace('{y}',y)});
  }
  return out.sort((a,b)=>b.runTime-a.runTime);
}
/** Valid times of a layer within one manifest, for building the timeline. */
export function layerTimes(manifest,layer){
  const L=manifest?.layers?.[layer];if(!L)return [];
  const out=[];for(const c of L.chunks)for(let i=0;i<c.frames;i++)out.push(c.first+i*c.step);return out;
}

/* ---------- radar & nowcast ---------- */
const relPath=p=>typeof p==='string'&&p.includes('{x}')&&p.includes('{y}')&&!p.includes('..')&&!/^[a-z]+:/i.test(p);
function fillPath(base,path,x,y){return base+path.replace('{x}',x).replace('{y}',y);}
// Each radar entry carries its own tile size (chunks 256, recent single frames
// one 2048 tile for the whole grid); fall back to the index-level value.
const entryTile=(value,fallback)=>{const t=value??fallback;return Number.isInteger(t)&&t>=8&&t<=4096?t:null;};
export function parseRadarIndex(data,{base=DATA_BASE,now=Date.now()/1000}={}){
  if(!data||data.schema!=='openwetter-radar-1')throw new Error('Unsupported radar index');
  const grid=parseGrid(data.grid),size=data.tile,step=data.step_seconds||300;
  if(!Number.isInteger(size)||size<8)throw new Error('Invalid radar tile size');
  const byTime=new Map();
  for(const c of Array.isArray(data.chunks)?data.chunks:[]){
    if(!Number.isSafeInteger(c?.start)||!Number.isInteger(c.frames)||c.frames<1||!relPath(c.path))continue;
    const missing=new Set(Array.isArray(c.missing_frames)?c.missing_frames:[]),tiles=tileList(c.tiles);
    const tile=entryTile(c.tile,size);if(!tile)continue;
    for(let i=0;i<c.frames;i++){
      if(missing.has(i))continue;
      const time=c.start+i*step;
      byTime.set(time,{time,index:i,frames:c.frames,tile,tiles,path:c.path,chunkKey:'radar:c'+c.start,chunkStart:c.start});
    }
  }
  for(const f of Array.isArray(data.frames)?data.frames:[]){
    const tile=entryTile(f?.tile,size);
    if(!Number.isSafeInteger(f?.time)||!relPath(f.path)||byTime.has(f.time)||!tile)continue;
    byTime.set(f.time,{time:f.time,index:0,frames:1,tile,tiles:tileList(f.tiles),path:f.path,chunkKey:'radar:f'+f.time});
  }
  const frames=[...byTime.values()].sort((a,b)=>a.time-b.time);
  const latest=frames.at(-1)?.time??null;
  return {kind:'radar',product:data.product||'DWD RADOLAN RY',generatedAt:data.generated_at,grid,tile:size,step,
    frames,latest,base,observationAgeSeconds:latest==null?null:Math.max(0,now-latest),
    isStale:latest==null||now-latest>3600};
}
export function radarFrame(index,frame){
  if(!index||!frame)return null;
  return {source:'radar',layer:'radar',time:frame.time,grid:index.grid,tile:frame.tile,frames:frame.frames,
    index:frame.index,tiles:frame.tiles,key:'radar:'+frame.time,chunkKey:frame.chunkKey,
    url:(x,y)=>fillPath(index.base,frame.path,x,y)};
}
export function parseNowcastIndex(data,{base=DATA_BASE}={}){
  if(!data||data.schema!=='openwetter-nowcast-1')throw new Error('Unsupported nowcast index');
  const grid=parseGrid(data.grid),size=data.tile,step=data.step_seconds||300;
  if(!Number.isInteger(size)||!Number.isSafeInteger(data.first_time)||!Number.isInteger(data.frames)||data.frames<1||!relPath(data.path))
    throw new Error('Malformed nowcast index');
  const tiles=tileList(data.tiles);
  const frames=Array.from({length:data.frames},(_,i)=>({time:data.first_time+i*step,index:i}));
  return {kind:'nowcast',product:data.product||'DWD RADVOR RV radar nowcast',issued:data.issued,grid,tile:size,step,
    frames,tiles,path:data.path,base,count:data.frames};
}
export function nowcastFrame(index,time){
  if(!index)return null;
  const f=index.frames.find(x=>x.time===time);if(!f)return null;
  return {source:'nowcast',layer:'nowcast',time:f.time,grid:index.grid,tile:index.tile,frames:index.count,
    index:f.index,tiles:index.tiles,key:`nowcast:${index.issued}:${f.time}`,chunkKey:'nowcast:'+index.issued,
    url:(x,y)=>fillPath(index.base,index.path,x,y)};
}

/* ---------- warnings ---------- */
const SEVERITY=['Minor','Moderate','Severe','Extreme'];
export function parseWarnings(data){
  if(!data||data.schema!=='openwetter-warnings-1'||!Array.isArray(data.warnings))throw new Error('Unsupported warnings index');
  const ring=r=>Array.isArray(r)&&r.length>=3&&r.every(p=>Array.isArray(p)&&Number.isFinite(p[0])&&Number.isFinite(p[1]));
  // CAP files may omit onset (then `effective`, else already active) or
  // expires (open-ended until cancelled); warnings.rs writes null for those.
  const time=(v,fallback)=>v==null?fallback:Number.isFinite(v)?v:undefined;
  return {generatedAt:data.generated_at,warnings:data.warnings
    .map(w=>w&&{w,onset:time(w.onset,time(w.effective,-Infinity)??-Infinity),expires:time(w.expires,Infinity)})
    .filter(x=>x&&x.onset!==undefined&&x.expires!==undefined)
    .map(({w,onset,expires})=>({id:String(w.id??''),event:String(w.event??''),severity:SEVERITY.includes(w.severity)?w.severity:'Minor',
      urgency:w.urgency,onset,expires,
      color:Array.isArray(w.color)&&w.color.length===3&&w.color.every(Number.isFinite)?w.color:[255,200,0],
      headline:w.headline||{},description:w.description||{},instruction:w.instruction||{},
      areas:(Array.isArray(w.areas)?w.areas:[]).map(a=>({name:String(a?.name??''),
        polygons:(Array.isArray(a?.polygons)?a.polygons:[]).filter(ring)}))}))};
}
export function activeWarnings(parsed,time){
  return (parsed?.warnings||[]).filter(w=>w.onset<=time&&time<w.expires)
    .sort((a,b)=>SEVERITY.indexOf(b.severity)-SEVERITY.indexOf(a.severity));
}
/** Ray casting point-in-polygon for a ring of [lon,lat]. */
export function pointInRing(lon,lat,ring){
  let inside=false;
  for(let i=0,j=ring.length-1;i<ring.length;j=i++){
    const [xi,yi]=ring[i],[xj,yj]=ring[j];
    if((yi>lat)!==(yj>lat)&&lon<(xj-xi)*(lat-yi)/(yj-yi)+xi)inside=!inside;
  }
  return inside;
}
/** Warnings (any time) whose areas contain the point. Rings combine by the
 * even-odd rule, like the map fill, so an inner ring is a hole. */
export function warningsCovering(parsed,lat,lon){
  return (parsed?.warnings||[]).filter(w=>w.areas.some(a=>a.polygons.filter(r=>pointInRing(lon,lat,r)).length%2===1));
}
export function warningsAt(parsed,time,lat,lon){
  return activeWarnings({warnings:warningsCovering(parsed,lat,lon)},time);
}

/* ---------- point series (chart) files ---------- */
/** Locate the series block for a point: url, block dimensions and offsets. */
export function seriesLocation(manifest,lat,lon){
  const s=manifest?.series;if(!s)return null;
  const cell=cellAt(manifest.grid,lat,lon);if(!cell)return null;
  const x=Math.floor(cell.col/s.tile),y=Math.floor(cell.row/s.tile);
  if(!s.tiles.has(x+'_'+y))return null;
  const {w,h}=tileSize(manifest.grid,s.tile,x,y);
  const bytes=s.layers.reduce((n,l)=>n+l.frames*w*h,0);
  return {x,y,w,h,bytes,cell:(cell.row-y*s.tile)*w+(cell.col-x*s.tile),
    url:manifest.dir+s.path.replace('{x}',x).replace('{y}',y)};
}
/** Extract decoded values of every series layer at one cell. */
export function parseSeriesBlock(manifest,location,buffer){
  const bytes=new Uint8Array(buffer);
  if(bytes.byteLength!==location.bytes)throw new Error('ICON-D2 series block length mismatch');
  const n=location.w*location.h,out={};
  let offset=0;
  for(const l of manifest.series.layers){
    const time=[],value=[];
    for(let k=0;k<l.frames;k++){
      time.push(l.first+k*l.step);
      value.push(LAYER_INFO[l.name]?decodeCode(l.name,bytes[offset+k*n+location.cell]):null);
    }
    out[l.name]={time,value,step:l.step};
    offset+=l.frames*n;
  }
  return out;
}
function interpolate(series,t){
  if(!series||!series.time.length)return null;
  const {time,value}=series;
  if(t<time[0]||t>time.at(-1))return null;
  const i=Math.min(time.length-1,Math.max(0,Math.floor((t-time[0])/series.step)));
  if(time[i]===t||i===time.length-1)return value[i];
  const a=value[i],b=value[i+1];
  if(a==null||b==null)return Math.abs(t-time[i])<=Math.abs(time[i+1]-t)?a:b;
  return a+(b-a)*(t-time[i])/(time[i+1]-time[i]);
}
/** Chart-ready ICON-D2 series on the 15-minute rain axis. Precipitation is
 * the 1-hour accumulation (mm) ending at each step, from 15-minute mean
 * rates; hourly fields are linearly interpolated between real model hours
 * for line display only. Missing layers stay absent (Open-Meteo fills in). */
export function seriesToChart(decoded){
  const axis=decoded.precip||decoded.temperature;
  if(!axis)return null;
  const time=axis.time,chart={time};
  if(decoded.precip){
    const r=decoded.precip.value,hours=decoded.precip.step/3600;
    chart.precipitation=time.map((_,i)=>{
      if(i<3)return null;
      const w=r.slice(i-3,i+1);
      return w.every(v=>v!=null)?Math.round(w.reduce((a,b)=>a+b,0)*hours*100)/100:null;
    });
  }
  const map={temperature_2m:'temperature',cloud_cover:'cloud_total',relative_humidity_2m:'humidity',pressure_msl:'pressure'};
  for(const [key,layer] of Object.entries(map))if(decoded[layer])chart[key]=time.map(t=>interpolate(decoded[layer],t));
  // Directions interpolate the short way round (350° → 10° passes north, not south).
  if(decoded.wind_direction){
    const d=decoded.wind_direction,unwrapped={...d,value:[]};
    let prev=null;
    for(const v of d.value){
      const u=v==null||prev==null?v:prev+((v-prev+540)%360-180);
      unwrapped.value.push(u);if(u!=null)prev=u;
    }
    chart.wind_direction_10m=time.map(t=>{const v=interpolate(unwrapped,t);return v==null?null:(v%360+360)%360;});
  }
  if(decoded.wind_speed)chart.wind_speed_10m=time.map(t=>{const v=interpolate(decoded.wind_speed,t);return v==null?null:v*3.6;});
  return chart;
}

/* ---------- byte helpers ---------- */
export const isGzip=bytes=>bytes.byteLength>2&&bytes[0]===0x1f&&bytes[1]===0x8b;
