import {DEFAULT_PLACES,clamp,wrappedLongitude,clampLatitude,mercator,unmercator,placeKey,nearestIndex} from './logic.mjs';
import {DATA_BASE,LAYER_INFO,PALETTE_STOPS,rainScalePosition,decodeCode,parseLatest,parseIconManifest,iconFrame,iconAdjacentChunk,chooseRun,
  parseHistoryIndex,parseRadarIndex,radarFrame,parseNowcastIndex,nowcastFrame,parseWarnings,activeWarnings,
  warningsCovering} from './tile-service.mjs';
import {fetchPointer,fetchImmutableJSON,tileBlob,fetchBytes} from './tile-loader.mjs';
import {createRasterRenderer,drawWindArrows,visibleFrameTiles} from './raster-renderer.mjs';
import {weatherDiskCache} from './frame-cache.mjs';
import {loadOwnSeries,applyOwnSeries} from './own-series.mjs';
import {createWeatherCrossfade} from './frame-transition.mjs';
import {pointForecastURL,previousRunURL,parsePointForecast,attachPreviousRun,seriesValueAt,chartDays,dailyExtremes,
  POINT_MODELS,MODEL_LABELS} from './forecast.mjs';
import {GRAPH_TYPES,RANGE_LABELS,defaultGraph,drawGraph} from './meteogram.mjs';
import {DEFAULT_SWIPE,secondsPerPixel,validSwipeSetting,createScrub,steppedTime} from './gestures.mjs';
import {ICONS} from './icons.mjs';
import {loadWmsMetadata,chooseWmsSource,paintWmsRain,wmsMetadata} from './dwd-wms.mjs';

const $=id=>document.getElementById(id);
const dom=Object.fromEntries(['appRoot','placeBtn','placeName','modelName','infoBtn','moreBtn','meteo','extremes','graphs','days',
  'readout','clockBtn','readTime','readTemp','readRain','readWind','unitTemp','unitRain','unitWind','windDirIcon','nowLine','cursorLine',
  'map','baseTiles','wmsCanvas','iconCanvas','iconTransitionCanvas','radarCanvas','radarTransitionCanvas','warningsCanvas','mapChip','toast',
  'layerBar','sourceBtn','layerButtons','editLayersBtn','legend','legendBar','legendTicks','mapCredit','scrim','drawer','searchForm',
  'searchInput','placesList','addPlaceBtn','locateBtn','settingsBtn','offlineBtn','helpBtn','popupMenu','dialogLayer','page'].map(k=>[k,$(k)]));
const params=new URLSearchParams(location.search);
const STORAGE='openwetter.ui.v3';
const html=(s,...v)=>s.reduce((a,x,i)=>a+x+(i<v.length?String(v[i]).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])):''),'');
const icon=name=>`<span class="icon">${ICONS[name]||''}</span>`;
for(const node of document.querySelectorAll('[data-icon]'))node.innerHTML=ICONS[node.dataset.icon]||'';

/* ---------- map layers in the bottom bar ---------- */
const LAYERS=Object.freeze({
  precip:{label:'Precipitation',icon:'rain',kind:'rain'},
  cloud_total:{label:'Total cloud',icon:'cloud',kind:'field'},
  temperature:{label:'Temperature',icon:'thermo',kind:'field'},
  pressure:{label:'Pressure (MSL)',icon:'pressure',kind:'field'},
  wind_speed:{label:'Wind speed',icon:'wind',kind:'field'},
  wind_direction:{label:'Wind vectors',icon:'vectors',kind:'field'},
  warnings:{label:'DWD warnings',icon:'warning',kind:'warnings'},
  wind_gust:{label:'Wind gusts',icon:'gust',kind:'field'},
  snow:{label:'Snowfall',icon:'snow',kind:'field'},
  cloud_low:{label:'Low cloud',icon:'cloudLow',kind:'field'},
  cloud_mid:{label:'Mid cloud',icon:'cloud',kind:'field'},
  cloud_high:{label:'High cloud',icon:'cloudHigh',kind:'field'},
  humidity:{label:'Relative humidity',icon:'humidity',kind:'field'},
  dew_point:{label:'Dew point',icon:'dew',kind:'field'},
});
const DEFAULT_BAR=['precip','cloud_total','temperature','pressure','wind_speed','wind_direction','warnings'];
const UNIT_OPTIONS={temperature:['°C','°F'],precipitation:['mm/h','in/h'],wind:['km/h','m/s','kt','mph','bft'],pressure:['hPa','kPa','inHg']};
const SOURCE_OPTIONS=[
  {id:'seamless',label:'DWD ICON',note:'ICON-D2 2 km → ICON-EU 7 km → ICON 11 km'},
  {id:'icon_d2',label:'DWD ICON-D2',note:'Germany and neighbours, 2 km, 48 h'},
  {id:'icon_eu',label:'DWD ICON-EU',note:'Europe, 7 km, 5 days'},
  {id:'icon_global',label:'DWD ICON',note:'Global, 11 km, 7 days'},
];

/* ---------- state ---------- */
const defaultPlace={...DEFAULT_PLACES[0]};
const state={
  place:defaultPlace,favorites:DEFAULT_PLACES.map(p=>({...p})),
  map:{latitude:defaultPlace.latitude,longitude:defaultPlace.longitude,zoom:5.7},
  bar:[...DEFAULT_BAR],rain:true,field:null,warningsOn:true,lastPicked:'precip',
  graphs:[defaultGraph('everyday'),defaultGraph('temperature')],
  swipe:structuredClone(DEFAULT_SWIPE),units:{temperature:'°C',precipitation:'mm/h',wind:'km/h',pressure:'hPa'},
  source:'seamless',opacity:{rain:.9,field:.8},smoothFrames:true,
  time:Math.floor(Date.now()/60000)*60,point:null,pointError:null,pointLoading:false,
  latest:null,icon:null,iconError:null,history:null,radar:null,nowcast:null,warnings:null,
};
function save(){
  try{localStorage.setItem(STORAGE,JSON.stringify({place:state.place,favorites:state.favorites,map:state.map,bar:state.bar,
    rain:state.rain,field:state.field,warningsOn:state.warningsOn,lastPicked:state.lastPicked,graphs:state.graphs,swipe:state.swipe,
    units:state.units,source:state.source,opacity:state.opacity,smoothFrames:state.smoothFrames}));}catch{/* storage may be denied */}
}
const validPlace=p=>p&&typeof p.name==='string'&&p.name.length>0&&p.name.length<150&&Number.isFinite(p.latitude)&&
  Number.isFinite(p.longitude)&&Math.abs(p.latitude)<=85&&Math.abs(p.longitude)<=180;
function loadPreferences(){
  try{
    const p=JSON.parse(localStorage.getItem(STORAGE)||'{}');
    if(validPlace(p.place))state.place={...p.place};
    if(Array.isArray(p.favorites))state.favorites=p.favorites.filter(validPlace).slice(0,30);
    if(p.map&&[p.map.latitude,p.map.longitude,p.map.zoom].every(Number.isFinite))
      state.map={latitude:clampLatitude(p.map.latitude),longitude:wrappedLongitude(p.map.longitude),zoom:clamp(p.map.zoom,3,11)};
    else{state.map.latitude=state.place.latitude;state.map.longitude=state.place.longitude;}
    if(Array.isArray(p.bar)){const bar=p.bar.filter(id=>Object.hasOwn(LAYERS,id));if(bar.length)state.bar=[...new Set(bar)];}
    if(typeof p.rain==='boolean')state.rain=p.rain;
    if(p.field===null||LAYERS[p.field]?.kind==='field')state.field=p.field??null;
    if(typeof p.warningsOn==='boolean')state.warningsOn=p.warningsOn;
    if(Object.hasOwn(LAYERS,p.lastPicked))state.lastPicked=p.lastPicked;
    if(Array.isArray(p.graphs)){const g=p.graphs.filter(x=>GRAPH_TYPES[x?.type]).map(x=>{const d=defaultGraph(x.type);
      for(const k of Object.keys(d.elements))if(typeof x.elements?.[k]==='boolean')d.elements[k]=x.elements[k];
      for(const k of Object.keys(d.ranges))if(x.ranges?.[k]===null||(Array.isArray(x.ranges?.[k])&&x.ranges[k].length===2&&x.ranges[k].every(Number.isFinite)&&x.ranges[k][1]>x.ranges[k][0]))d.ranges[k]=x.ranges[k];
      return d;});if(g.length)state.graphs=g.slice(0,5);}
    for(const axis of ['horizontal','vertical'])if(validSwipeSetting(p.swipe?.[axis]))state.swipe[axis]={...p.swipe[axis]};
    if(['smooth','data'].includes(p.swipe?.stepping))state.swipe.stepping=p.swipe.stepping;
    for(const [k,opts] of Object.entries(UNIT_OPTIONS))if(opts.includes(p.units?.[k]))state.units[k]=p.units[k];
    if(SOURCE_OPTIONS.some(s=>s.id===p.source))state.source=p.source;
    for(const k of ['rain','field'])if(Number.isFinite(p.opacity?.[k]))state.opacity[k]=clamp(p.opacity[k],.1,1);
    if(typeof p.smoothFrames==='boolean')state.smoothFrames=p.smoothFrames;
  }catch{/* defaults */}
}

/* ---------- formatting & units ---------- */
const zone=()=>state.point?.timezone||'Europe/Berlin';
const fmtCache=new Map();
function fmt(seconds,opts){
  const key=zone()+JSON.stringify(opts);let f=fmtCache.get(key);
  if(!f){f=new Intl.DateTimeFormat('en-GB',{...opts,timeZone:zone()});fmtCache.set(key,f);}
  return Number.isFinite(seconds)?f.format(new Date(seconds*1000)):'—';
}
const hhmm=t=>fmt(t,{hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
const dayTime=t=>fmt(t,{weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
const utcHour=t=>Number.isFinite(t)?new Date(t*1000).toISOString().slice(11,13)+'z':'—';
const conv={
  temp:v=>state.units.temperature==='°F'?v*9/5+32:v,
  rain:v=>state.units.precipitation==='in/h'?v/25.4:v,
  wind:v=>{const u=state.units.wind;if(u==='m/s')return v/3.6;if(u==='kt')return v/1.852;if(u==='mph')return v/1.609344;
    if(u==='bft')return Math.min(12,Math.round(Math.cbrt((v/3.6/0.836)**2)));return v;},
  windFromMs:v=>conv.wind(v*3.6),
  pressure:v=>state.units.pressure==='kPa'?v/10:state.units.pressure==='inHg'?v*0.02953:v,
};
const rainText=v=>v==null?'—':conv.rain(v).toFixed(state.units.precipitation==='in/h'?2:1);
const pressureText=v=>state.units.pressure==='hPa'?String(Math.round(v)):conv.pressure(v).toFixed(state.units.pressure==='kPa'?1:2);
let toastTimer=0;
function toast(msg,{error=false,ms=2600}={}){
  clearTimeout(toastTimer);dom.toast.textContent=msg;dom.toast.className='toast'+(error?' error':'');dom.toast.hidden=!msg;
  if(msg)toastTimer=setTimeout(()=>{dom.toast.hidden=true;},ms);
}

/* ---------- the 7-day time axis ---------- */
function days(){return chartDays(Date.now()/1000,zone());}
function timeView(){const d=days();return {start:d[0].start,end:d.at(-1).end};}
function timeBounds(){const v=timeView();return {min:v.start,max:v.end-60};}
function setTime(t,{snap=true}={}){
  const {min,max}=timeBounds();
  const next=clamp(snap?steppedTime(t,state.swipe.stepping,state.swipe.stepping==='smooth'?60:dataStep()):t,min,max);
  if(next===state.time)return;
  state.time=next;onTimeChanged();
}
function dataStep(){
  const r=rainSource(state.time);
  if(state.field)return iconFrameAt(state.field,state.time)?.step||iconLayerSpec(state.field)?.step||3600;
  if(r==='wms')return chooseWmsSource(wmsMetadata(),state.time)?.source.hours*3600||3600;
  return r==='radar'?300:r==='nowcast'?300:iconFrameAt('precip',state.time)?.step||iconLayerSpec('precip')?.step||900;
}
function onTimeChanged(){updateReadout();updateCursor();updateDays();requestMap();}

/* ---------- tile service: ICON runs (D2, EU, Global), D2 history, radar, nowcast, warnings ---------- */
function iconManifests(){return [state.icon,...(state.history?.slices||[])].filter(Boolean);}
/** ICON-EU and ICON Global manifests, finest first (beyond ICON-D2's 48 h). */
function coarseManifests(){return [state.models?.icon_eu,state.models?.icon_global].filter(Boolean);}
function allManifests(){return [...iconManifests(),...coarseManifests()];}
/** Last time any ICON model has a map frame of `layer`. */
function iconLayerEnd(layer){return Math.max(-Infinity,...allManifests().filter(m=>!m.history).map(m=>m.layers?.[layer]?.end??-Infinity));}
function iconLayerSpec(layer){return state.icon?.layers?.[layer]||null;}
let historyLoading=null;
function loadHistory(){
  const run=state.icon?.runTime,path=state.latest?.history;
  if(run==null||!path||state.history?.forRun===run)return historyLoading;
  if(historyLoading)return historyLoading;
  historyLoading=(async()=>{
    try{const raw=await fetchPointer(DATA_BASE+path,{ttlMs:0});if(state.icon?.runTime!==run)return;
      state.history={forRun:run,slices:raw?parseHistoryIndex(raw).filter(m=>m.runTime<run):[]};requestMap();}
    catch{if(state.icon?.runTime===run)state.history={forRun:run,slices:[]};}
    finally{historyLoading=null;}
  })();
  return historyLoading;
}
/** ICON frame for `layer` at `time`: ICON-D2 (newest run covering it, older
 * runs' slices for earlier times), then ICON-EU, then ICON Global. */
function iconFrameAt(layer,time){
  const spec=iconLayerSpec(layer);
  if(spec){
    const t=Math.round(time/spec.step)*spec.step;
    const manifest=chooseRun(iconManifests(),layer,t);
    if(manifest)return iconFrame(manifest,layer,t);
    if(t<spec.start)void loadHistory();
  }
  for(const m of coarseManifests()){const f=iconFrame(m,layer,time);if(f&&(!spec||time>spec.end))return f;}
  return null;
}
async function loadCoarseModels(ttlMs){
  state.models??={};
  await Promise.all(['icon_eu','icon_global'].map(async id=>{
    try{
      const raw=await fetchPointer(DATA_BASE+id+'/latest.json',{ttlMs});
      if(!raw||typeof raw.manifest!=='string'||!raw.manifest.startsWith(id+'/')||raw.manifest.includes('..'))return;
      if(state.models[id]?.run===raw.run)return;
      state.models[id]=parseIconManifest(await fetchImmutableJSON(DATA_BASE+raw.manifest),raw.manifest);
      void loadPrevious(id,raw.previous?.manifest);
    }catch{/* this model stays unavailable; DWD map images cover rain beyond ICON-D2 */}
  }));
  requestMap();updateChip();void refreshOwnSeries();
}
/** Run of `model` started 24 hours before the newest one (graphs: change since the previous day's forecast). */
async function loadPrevious(model,path){
  state.previous??={};
  if(typeof path!=='string'||!path.startsWith(model+'/')||path.includes('..')){delete state.previous[model];return;}
  if(state.previous[model]?.path===path)return;
  try{state.previous[model]={path,manifest:parseIconManifest(await fetchImmutableJSON(DATA_BASE+path),path)};void refreshOwnSeries();}
  catch{delete state.previous[model];}
}
async function loadIconRun({fresh=false}={}){
  const ttlMs=fresh?0:60_000;
  try{
    const raw=await fetchPointer(DATA_BASE+'latest.json',{ttlMs});
    if(!raw)throw new Error('tile service pointer not found');
    const latest=parseLatest(raw);state.latest=latest;
    if(!latest.icon)throw new Error('no ICON-D2 run published');
    const dir=DATA_BASE+latest.icon.manifest.slice(0,latest.icon.manifest.lastIndexOf('/')+1);
    void loadPrevious('icon_d2',latest.icon.previous);
    if(state.icon?.dir!==dir){state.icon=parseIconManifest(await fetchImmutableJSON(DATA_BASE+latest.icon.manifest),latest.icon.manifest);
      state.iconError=null;state.history=null;}
  }catch(error){state.iconError=error.message;if(!state.icon)toast('ICON-D2 maps unavailable: '+error.message,{error:true});}
  finally{void loadRadar(ttlMs);void loadNowcast(ttlMs);void loadWarnings(ttlMs);void loadCoarseModels(ttlMs);requestMap();updateChip();}
}
const pointerURL=(key,fallback)=>DATA_BASE+(state.latest?.[key]||fallback);
async function loadRadar(ttlMs){
  try{const raw=await fetchPointer(pointerURL('radar','radar/index.json'),{ttlMs});
    if(!raw){state.radar=null;return;}
    const index=parseRadarIndex(raw);
    const shown=painters.rain.shown;
    if(shown?.source==='radar'&&index.frames.find(f=>f.time===shown.time)?.chunkKey!==shown.chunkKey)painters.rain.reset();
    state.radar=index.frames.length?index:null;
  }catch{/* keep the previous index */}
  finally{requestMap();updateChip();}
}
async function loadNowcast(ttlMs){
  try{const raw=await fetchPointer(pointerURL('nowcast','nowcast/index.json'),{ttlMs});
    state.nowcast=raw?parseNowcastIndex(raw):null;}catch{/* keep */}
  finally{requestMap();}
}
async function loadWarnings(ttlMs){
  try{const raw=await fetchPointer(pointerURL('warnings','warnings/index.json'),{ttlMs});
    state.warnings=raw?parseWarnings(raw):null;projected=null;warningsKey='';placeWarnings=null;}catch{/* keep */}
  finally{requestMap();requestGraphs();}
}
let lastMissingRefresh=0;
function refreshAfterMissingTiles(result){
  if(!result?.missing||Date.now()-lastMissingRefresh<30_000)return;
  lastMissingRefresh=Date.now();void loadIconRun({fresh:true});
}

/* ---------- precipitation: observed radar, then nowcast, then ICON-D2 ---------- */
function floorFrame(frames,t,tolerance=150){
  let lo=0,hi=frames.length-1,best=-1;
  while(lo<=hi){const m=(lo+hi)>>1;if(frames[m].time<=t+tolerance){best=m;lo=m+1;}else hi=m-1;}
  return best;
}
/** Which source shows rain at time t. */
function rainSource(t){
  const r=state.radar;
  if(r&&t<=r.latest+150&&t>=r.frames[0].time-150)return 'radar';
  const nc=state.nowcast?.frames;
  if(nc?.length&&t>(r?.latest??-Infinity)+150&&t<=nc.at(-1).time+150&&t>=nc[0].time-450)return 'nowcast';
  // ICON-D2 tiles first; beyond them DWD's ICON-EU / ICON Global map images.
  if(allManifests().length&&(iconFrameAt('precip',t)||t<iconLayerEnd('precip')))return 'forecast';
  if(chooseWmsSource(wmsMetadata(),t))return 'wms';
  return 'forecast';
}
function rainFrameAt(t){
  const source=rainSource(t);
  if(source==='radar'){const i=Math.max(0,floorFrame(state.radar.frames,t));return {source,frame:radarFrame(state.radar,state.radar.frames[i])};}
  if(source==='nowcast'){const fr=state.nowcast.frames,i=Math.max(0,floorFrame(fr,t));return {source,frame:nowcastFrame(state.nowcast,fr[i].time)};}
  if(source==='wms')return {source,frame:null,wms:chooseWmsSource(wmsMetadata(),t)};
  return {source,frame:allManifests().length?iconFrameAt('precip',t):null};
}

/* ---------- point forecast (charts + readout) ---------- */
let pointEpoch=0,pointController=null;
const pointCacheKey=p=>`openwetter.point.v3.${placeKey(p)}`;
async function loadPoint(){
  const place={...state.place},epoch=++pointEpoch;
  pointController?.abort();const controller=new AbortController();pointController=controller;
  state.pointLoading=true;state.pointError=null;
  const cached=(()=>{try{const c=JSON.parse(localStorage.getItem(pointCacheKey(place))||'null');
    return c&&Date.now()-c.savedAt<12*3600_000?c:null;}catch{return null;}})();
  if(cached&&!state.point){try{setPointBase(attachPreviousRun(parsePointForecast(cached.main),cached.previous));}catch{/* ignore */}}
  requestGraphs();
  try{
    const get=async url=>{const r=await fetch(url,{signal:controller.signal});if(!r.ok)throw new Error('HTTP '+r.status);
      const j=await r.json();if(j?.error)throw new Error(j.reason||'forecast service error');return j;};
    const [main,previous]=await Promise.all([get(pointForecastURL(place)),get(previousRunURL(place)).catch(()=>null)]);
    if(epoch!==pointEpoch)return;
    setPointBase(attachPreviousRun(parsePointForecast(main),previous));
    try{localStorage.setItem(pointCacheKey(place),JSON.stringify({savedAt:Date.now(),main,previous}));}catch{/* optional */}
  }catch(error){
    if(epoch!==pointEpoch||controller.signal.aborted)return;
    state.pointError=error.message;
    if(!state.point)toast('Forecast unavailable: '+error.message,{error:true});
  }finally{
    if(epoch===pointEpoch){state.pointLoading=false;renderMeteo();updateReadout();}
  }
}
/* The graphs use OpenWetter's own ICON tiles (the same values as the map)
 * wherever they cover an hour; Open-Meteo fills the rest (past hours, cloud
 * by height, the previous run). */
function setPointBase(forecast){state.pointOM=forecast;state.point=forecast;state.ownKey=null;void refreshOwnSeries();}
let ownEpoch=0;
async function refreshOwnSeries(){
  const base=state.pointOM;if(!base)return;
  if(!state.icon&&!coarseManifests().length)return;
  // ICON-D2: the newest run, then the history slices of earlier runs for the past hours.
  if(state.icon&&!state.history)void loadHistory()?.then(()=>refreshOwnSeries());
  const past=(state.history?.slices||[]).filter(m=>m.series&&m.runTime>=base.time[0]-6*3600);
  const groups=[{model:'icon_d2',manifests:[state.icon,...past].filter(Boolean)},
    ...coarseManifests().map(m=>({model:m.model,manifests:[m]}))].filter(g=>g.manifests.length);
  const prev=['icon_d2','icon_eu','icon_global'].map(model=>({model,manifests:[state.previous?.[model]?.manifest].filter(Boolean)}))
    .filter(g=>g.manifests.length);
  const place={...state.place},key=placeKey(place)+'|'+[...groups,...prev].map(g=>g.model+'@'+g.manifests.map(m=>m.run).join('+')).join(',');
  if(state.ownKey===key)return;
  const epoch=++ownEpoch;
  const get=async url=>{
    let bytes=await weatherDiskCache.get('series',url);
    if(!bytes){bytes=await fetchBytes(url);void weatherDiskCache.put('series',url,bytes);}
    return bytes;
  };
  const [own,previous]=await Promise.all([loadOwnSeries(groups,place,base.time,get),loadOwnSeries(prev,place,base.time,get)]);
  if(epoch!==ownEpoch||state.pointOM!==base)return;
  state.ownKey=key;state.point=applyOwnSeries(base,own,previous);
  renderMeteo();updateReadout();
}
/** Forecast object the charts use: the stitched series, or one model only. */
function chartForecast(){
  const f=state.point;if(!f||state.source==='seamless')return f;
  const m=f.models[state.source];if(!m)return null;
  return {...f,series:{...m,previous_temperature_2m:f.series.previous_temperature_2m},transitions:[],source:f.time.map(()=>state.source)};
}

/* ---------- meteogram ---------- */
let graphRequest=0;
function requestGraphs(){if(!graphRequest)graphRequest=requestAnimationFrame(()=>{graphRequest=0;drawGraphs();});}
function renderMeteo(){
  dom.graphs.replaceChildren(...state.graphs.map((cfg,i)=>{
    const div=document.createElement('div');div.className='graph';div.dataset.index=String(i);
    const c=document.createElement('canvas');c.setAttribute('aria-label',GRAPH_TYPES[cfg.type].label+' graph');div.append(c);return div;}));
  renderExtremes();updateDays();drawGraphs();updateCursor();
}
function placeWarningIntervals(){
  if(!state.warnings)return [];
  const id=placeKey(state.place)+'|'+state.warnings.generatedAt;
  if(placeWarnings?.id!==id)placeWarnings={id,list:warningsCovering(state.warnings,state.place.latitude,state.place.longitude)};
  const v=timeView();
  return placeWarnings.list.map(w=>({start:Number.isFinite(w.onset)?w.onset:v.start,end:Number.isFinite(w.expires)?w.expires:v.end,color:w.color}));
}
function graphInfo(){
  return {temp:conv.temp,wind:conv.wind,warnings:placeWarningIntervals(),
    message:state.pointError?'Forecast unavailable: '+state.pointError:'Loading forecast…'};
}
function drawGraphs(){
  const f=chartForecast(),view=timeView(),d=days(),info=graphInfo();
  dom.graphs.querySelectorAll('.graph').forEach((node,i)=>{const cfg=state.graphs[i];if(cfg)drawGraph(node.firstChild,cfg,f,view,d,info);});
  renderExtremes();updateCursor();
}
function renderExtremes(){
  const ex=dailyExtremes(chartForecast(),days());
  dom.extremes.replaceChildren(...ex.flatMap(e=>[['max',e.max],['min',e.min]].map(([k,v])=>{
    const s=document.createElement('span');s.className=k;s.textContent=v==null?'':String(Math.round(conv.temp(v)));return s;})));
}
function updateDays(){
  const d=days(),active=d.findIndex(x=>state.time>=x.start&&state.time<x.end);
  if(dom.days.children.length!==d.length||dom.days.dataset.start!==String(d[0].start)){
    dom.days.dataset.start=String(d[0].start);
    dom.days.replaceChildren(...d.map((x,i)=>{const b=document.createElement('button');b.textContent=fmt(x.start+43200,{weekday:'short'});
      b.dataset.index=String(i);return b;}));
  }
  [...dom.days.children].forEach((b,i)=>{b.classList.toggle('active',i===active);b.setAttribute('aria-pressed',String(i===active));});
}
/* Element boxes, read once per layout change instead of every scrub frame. */
let boxes=null;
function measure(){
  boxes??={graphs:dom.graphs.getBoundingClientRect(),meteo:dom.meteo.getBoundingClientRect(),map:dom.map.getBoundingClientRect()};
  return boxes;
}
function relayout(){boxes=null;}
function updateCursor(){
  const v=timeView(),{graphs:r,meteo:m}=measure();
  const top=r.top-m.top,height=r.height,x=t=>(t-v.start)/(v.end-v.start)*r.width;
  for(const [line,t] of [[dom.cursorLine,state.time],[dom.nowLine,Date.now()/1000]]){
    line.style.top=top+'px';line.style.height=height+'px';line.style.left=Math.round(x(t)-0.5)+'px';
    line.hidden=t<v.start||t>v.end;
  }
}
function updateReadout(){
  const f=chartForecast(),t=state.time;
  dom.readTime.textContent=hhmm(t);
  const temp=seriesValueAt(f,'temperature_2m',t),rain=seriesValueAt(f,'precipitation',t),
    wind=seriesValueAt(f,'wind_speed_10m',t),dir=seriesValueAt(f,'wind_direction_10m',t,{angle:true});
  dom.readTemp.textContent=temp==null?'—':String(Math.round(conv.temp(temp)));
  dom.readRain.textContent=rainText(rain);
  dom.readWind.textContent=wind==null?'—':String(Math.round(conv.wind(wind)));
  dom.unitTemp.textContent=state.units.temperature;dom.unitRain.textContent=state.units.precipitation;
  dom.unitWind.textContent=state.units.wind==='bft'?'Bft':state.units.wind;
  // Arrow points where the wind blows to.
  dom.windDirIcon.style.transform=dir==null?'':`rotate(${dir+90}deg)`;
}

/* ---------- map ---------- */
const renderer=createRasterRenderer({forceCanvas:params.has('canvas2d'),
  onContextRestored:()=>{for(const p of Object.values(painters))p.reset();requestMap();}});
const crossfades={
  field:createWeatherCrossfade(dom.iconCanvas,dom.iconTransitionCanvas,{durationMs:260,opacity:()=>state.opacity.field,enabled:()=>state.smoothFrames}),
  rain:createWeatherCrossfade(dom.radarCanvas,dom.radarTransitionCanvas,{durationMs:260,opacity:()=>state.opacity.rain,enabled:()=>state.smoothFrames}),
};
function prepareCanvas(layer,width,height,ratio){
  const w=Math.max(1,Math.round(width*ratio)),h=Math.max(1,Math.round(height*ratio)),resized=layer.width!==w||layer.height!==h;
  if(resized){layer.width=w;layer.height=h;}
  const ctx=layer.getContext('2d');ctx.setTransform(ratio,0,0,ratio,0,0);return {ctx,resized};
}
/** One layer canvas fed by the GPU renderer; keeps the previous complete frame
 * on screen while the next one downloads. */
function createPainter(canvas,crossfade){
  let shown=null,shownScene='',complete=false,wantedKey='',loadTimer=0;
  function drawFrame(ctx,frame,view,scene,resized,extra){
    const finish=crossfade.beforeDraw(frame.key,scene,{resized});
    ctx.clearRect(0,0,view.width,view.height);renderer.draw(ctx,frame,view);extra?.(ctx,frame,view);finish();
    shown=frame;shownScene=scene;complete=renderer.ready(frame,view);
  }
  return {
    get shown(){return shown;},get complete(){return complete;},
    reset(){shown=null;shownScene='';complete=false;wantedKey='';clearTimeout(loadTimer);},
    paint(frame,view,{scene,extra,onShown,onError}={}){
      const {ctx,resized}=prepareCanvas(canvas,view.width,view.height,view.ratio);
      if(resized)crossfade.stop();
      if(!frame){crossfade.stop();ctx.clearRect(0,0,view.width,view.height);shown=null;shownScene='';complete=false;wantedKey='';return;}
      const sceneChanged=resized||scene!==shownScene;
      if(!sceneChanged&&complete&&shown?.key===frame.key)return;
      if(renderer.ready(frame,view)){drawFrame(ctx,frame,view,scene,resized,extra);onShown?.(frame);return;}
      if(sceneChanged){
        const same=shown&&shown.layer===frame.layer&&shown.source===frame.source;
        if(same&&shown.key!==frame.key&&renderer.ready(shown,view)){const prev=shown;drawFrame(ctx,prev,view,scene,resized,extra);complete=false;shown=prev;}
        else{drawFrame(ctx,frame,view,scene,resized,extra);complete=false;}
      }
      if(wantedKey!==frame.key){
        wantedKey=frame.key;clearTimeout(loadTimer);
        loadTimer=setTimeout(()=>{renderer.load(frame,view).then(result=>{if(result.failed)onError?.(result);
          if(wantedKey===frame.key){wantedKey='';requestMap();}}).catch(error=>onError?.({error}));},gesture?40:70);
      }
    },
  };
}
const painters={field:createPainter(dom.iconCanvas,crossfades.field),rain:createPainter(dom.radarCanvas,crossfades.rain)};
let mapRequest=0;
function requestMap(){if(!mapRequest)mapRequest=requestAnimationFrame(()=>{mapRequest=0;renderMap();});}
function mapView(){
  const r=measure().map;
  return {width:r.width,height:r.height,ratio:Math.min(2.5,window.devicePixelRatio||1),zoom:state.map.zoom,
    latitude:state.map.latitude,longitude:state.map.longitude};
}
const viewKey=(v,extra)=>[v.width,v.height,v.ratio,v.zoom.toFixed(4),v.latitude.toFixed(5),v.longitude.toFixed(5),extra].join('|');
function renderBaseTiles(view){
  const tz=clamp(Math.round(view.zoom),2,18),scale=2**(view.zoom-tz),size=256*scale;
  const c=mercator(view.latitude,view.longitude,tz),left=c.x*scale-view.width/2,top=c.y*scale-view.height/2,n=2**tz;
  const want=new Map();
  for(let x=Math.floor(left/size);x<=Math.floor((left+view.width)/size);x++)
    for(let y=Math.max(0,Math.floor(top/size));y<=Math.min(n-1,Math.floor((top+view.height)/size));y++){
      const xx=((x%n)+n)%n;want.set(`${tz}/${x}/${y}`,{url:`https://tile.openstreetmap.org/${tz}/${xx}/${y}.png`,left:x*size-left,top:y*size-top});
    }
  const existing=new Map([...dom.baseTiles.children].map(n=>[n.dataset.key,n]));
  for(const [key,t] of want){
    let img=existing.get(key);
    if(!img){img=document.createElement('img');img.dataset.key=key;img.alt='';img.decoding='async';img.draggable=false;img.src=t.url;dom.baseTiles.append(img);}
    img.style.width=img.style.height=size+'px';img.style.transform=`translate(${t.left}px,${t.top}px)`;img.style.left=img.style.top='0';
  }
  for(const [key,node] of existing)if(!want.has(key))node.remove();
}
let shownRain=null,shownField=null;
function renderMap(){
  const view=mapView();if(view.width<5||view.height<5)return;
  renderBaseTiles(view);
  const fieldFrame=state.field&&allManifests().length?iconFrameAt(state.field,state.time):null;
  painters.field.paint(fieldFrame,view,{scene:viewKey(view,'field:'+state.field),
    extra:state.field==='wind_direction'?(ctx,frame,v)=>drawWindArrows(ctx,renderer,frame,v):null,
    onShown:frame=>{shownField=frame;updateChip();sampleChip();schedulePrefetch(frame,view);},
    onError:refreshAfterMissingTiles});
  if(!fieldFrame){shownField=null;}
  dom.iconCanvas.style.opacity=String(state.opacity.field);
  const rain=state.rain?rainFrameAt(state.time):null;
  painters.rain.paint(rain?.frame||null,view,{scene:viewKey(view,'rain'),
    onShown:frame=>{shownRain=frame;updateChip();sampleChip();schedulePrefetch(frame,view);},
    onError:refreshAfterMissingTiles});
  if(!rain?.frame)shownRain=null;
  dom.radarCanvas.style.opacity=String(state.opacity.rain);
  paintWmsLayer(view,rain);
  drawWarningsLayer(view);
  updateChip();updateLegend();
}
/* ICON-EU / ICON Global rain from DWD map images beyond the ICON-D2 tiles */
let wmsKey='',wmsGen=0,wmsShown=null;
function paintWmsLayer(view,rain){
  dom.wmsCanvas.style.opacity=String(state.opacity.rain);
  if(rain?.source!=='wms'||!rain.wms){
    if(wmsKey||wmsShown){wmsKey='';wmsGen++;wmsShown=null;const {ctx}=prepareCanvas(dom.wmsCanvas,view.width,view.height,view.ratio);ctx.clearRect(0,0,view.width,view.height);}
    return;
  }
  const key=viewKey(view,rain.wms.source.id+':'+rain.wms.time);
  if(key===wmsKey)return;
  wmsKey=key;const gen=++wmsGen;
  const {ctx}=prepareCanvas(dom.wmsCanvas,view.width,view.height,view.ratio);
  void paintWmsRain(ctx,view,rain.wms,()=>gen===wmsGen).then(r=>{if(r&&gen===wmsGen){wmsShown=r;updateChip();}})
    .catch(()=>{if(gen===wmsGen)toast('DWD map images unavailable',{error:true});});
}
let prefetchTimer=0;
function schedulePrefetch(frame,view){
  clearTimeout(prefetchTimer);
  prefetchTimer=setTimeout(()=>{
    let next=null;
    if(frame.source==='icon'){
      const manifest=allManifests().find(m=>m.run===frame.run&&m.tile===frame.tile&&(m.model||'icon_d2')===frame.model);
      if(manifest&&!manifest.history){if(frame.index>=frame.frames-6)next=iconAdjacentChunk(manifest,frame,1);else if(frame.index<=3)next=iconAdjacentChunk(manifest,frame,-1);}
    }else if(frame.source==='radar'&&state.radar){
      const i=state.radar.frames.findIndex(f=>f.time===frame.time);
      for(const j of [i-6,i+6]){const f=state.radar.frames[j];if(f&&f.chunkKey!==frame.chunkKey){next=radarFrame(state.radar,f);break;}}
    }
    if(next)renderer.prefetch(next,view);
  },400);
}
/* warnings polygons */
let projected=null,warningsKey='',placeWarnings=null;
function drawWarningsLayer(view){
  const canvas=dom.warningsCanvas,show=state.warningsOn&&Boolean(state.warnings);canvas.hidden=!show;
  if(!show){warningsKey='';return;}
  const active=activeWarnings(state.warnings,state.time);
  const key=viewKey(view,state.warnings.generatedAt)+'|'+active.map(w=>w.id).join(',');
  if(key===warningsKey)return;warningsKey=key;
  const {ctx}=prepareCanvas(canvas,view.width,view.height,view.ratio);ctx.clearRect(0,0,view.width,view.height);
  if(!active.length)return;
  projected??=new Map();
  const world=256*2**view.zoom,c=mercator(view.latitude,view.longitude,view.zoom);
  ctx.save();ctx.lineJoin='round';
  for(const w of [...active].reverse()){
    if(!projected.has(w.id))projected.set(w.id,w.areas.flatMap(a=>a.polygons.map(r=>r.map(([lon,lat])=>{const p=mercator(lat,lon,0);return [p.x/256,p.y/256];}))));
    const [r,g,b]=w.color;ctx.beginPath();
    for(const ring of projected.get(w.id)){ring.forEach(([x,y],i)=>{const sx=view.width/2+x*world-c.x,sy=view.height/2+y*world-c.y;i?ctx.lineTo(sx,sy):ctx.moveTo(sx,sy);});ctx.closePath();}
    ctx.fillStyle=`rgba(${r},${g},${b},.22)`;ctx.fill('evenodd');ctx.strokeStyle=`rgba(${r},${g},${b},.9)`;ctx.lineWidth=1.4;ctx.stroke();
  }
  ctx.restore();
}
/* value chip at the top of the map */
const chipValues={rain:null,field:null};
let sampleTimer=0;
function sampleChip(){
  clearTimeout(sampleTimer);
  sampleTimer=setTimeout(async()=>{
    for(const [k,frame] of [['rain',state.rain?shownRain:null],['field',state.field?shownField:null]]){
      if(!frame){chipValues[k]=null;continue;}
      try{const view={latitude:state.map.latitude,longitude:state.map.longitude,zoom:12,width:8,height:8,ratio:1};
        await renderer.load(frame,view);
        const code=renderer.sampleAt(frame,state.map.latitude,state.map.longitude);
        chipValues[k]={key:frame.key,value:code==null?null:decodeCode(frame.layer,code)};
      }catch{chipValues[k]=null;}
    }
    updateChip();
  },gesture?250:60);
}
function fieldValueText(layer,v){
  if(v==null)return ['—',''];
  const info=LAYER_INFO[layer];
  if(info.kind==='celsius')return [String(Math.round(conv.temp(v))),state.units.temperature];
  if(info.kind==='percent')return [String(Math.round(v)),'%'];
  if(info.kind==='hpa')return [pressureText(v),state.units.pressure];
  if(info.kind==='ms')return [String(Math.round(conv.windFromMs(v))),state.units.wind==='bft'?'Bft':state.units.wind];
  if(info.kind==='degrees')return [String(Math.round(v)),'°'];
  return [rainText(v),state.units.precipitation];
}
function chipLayer(ic,name,val,unit){
  const s=el('span',{className:'chip-layer'});s.innerHTML=icon(ic);
  s.append(el('span',{className:'chip-name',textContent:name}),' ',el('b',{textContent:val}),el('sup',{textContent:unit}));return s;
}
function updateChip(){
  const nodes=[];let source=null;
  if(state.rain){
    // Describe the frame actually on screen; say so while the requested one loads.
    const wanted=rainFrameAt(state.time),frame=shownRain,sampled=chipValues.rain?.key===frame?.key&&frame;
    if(wanted.source==='wms'){
      const w=wmsShown,c=w?.centre,loading=!w||w.key!==wanted.wms.source.id+':'+wanted.wms.time?' · loading':'';
      const val=!w||!c?'—':c.hi===0?rainText(0):`${rainText(c.lo)}–${rainText(c.hi)}`;
      nodes.push(chipLayer('rain','Precipitation',val,state.units.precipitation));
      source={text:w?`${w.source.model} ${w.source.hours} h · ${utcHour(w.run)}${loading}`:'Loading…',cls:''};
    }else{
    nodes.push(chipLayer('rain','Precipitation',sampled?rainText(chipValues.rain.value??0):'—',state.units.precipitation));
    const kind=frame?(frame.source==='icon'?'forecast':frame.source):null,loading=wanted.frame&&frame?.key!==wanted.frame.key?' · loading':'';
    source=kind==='radar'?{text:`Radar ${hhmm(frame.time)}${loading}`,cls:'observed'}:kind==='nowcast'?{text:`Nowcast ${hhmm(frame.time)}${loading}`,cls:'nowcast'}:
      kind==='forecast'?{text:`${frame.label||'ICON-D2'} ${utcHour(frame.runTime)}${loading}`,cls:''}:
      {text:wanted.frame?'Loading…':wanted.source==='forecast'&&state.icon?'No rain map for this time':'Loading…',cls:''};
    }
  }
  if(state.field){
    const frame=shownField,sampled=chipValues.field?.key===frame?.key&&frame,[val,unit]=fieldValueText(state.field,sampled?chipValues.field.value:null);
    nodes.push(chipLayer(LAYERS[state.field].icon,LAYERS[state.field].label,val,unit));
    const wanted=allManifests().length?iconFrameAt(state.field,state.time):null;
    source??={text:frame?`${frame.label||'ICON-D2'} ${utcHour(frame.runTime)}${wanted&&wanted.key!==frame.key?' · loading':''}`:state.icon?(wanted?'Loading…':'No map for this time'):'Loading…',cls:''};
  }
  if(!nodes.length)nodes.push(chipLayer('layers','No map layer','',''));
  if(source)nodes.push(el('span',{className:'chip-source '+source.cls,textContent:source.text}));
  dom.mapChip.replaceChildren(...nodes);
}
/* legend card */
function legendModel(layer){
  if(layer==='precip'||layer==='snow'){
    // Rain: Flowx's legend spacing (0, 1, 5, 20, 50 mm/h); snow: log-scaled rate.
    const lo=Math.log(0.05),hi=Math.log(60),stops=PALETTE_STOPS[layer==='snow'?'snow':'rain'];
    const pos=layer==='snow'?v=>(Math.log(Math.max(.05,v))-lo)/(hi-lo):rainScalePosition;
    const ticks=state.units.precipitation==='in/h'?[[0,'0 in/h'],[1/25.4*25.4,'0.04'],[5,'0.2'],[20,'0.8'],[50,'2']]:[[0,'0 mm/h'],[1,'1'],[5,'5'],[20,'20'],[50,'50']];
    const gradient=stops.map(([v,c,a])=>[pos(v),c,a]);
    // Flowx starts the rain bar with a short grey "dry" segment.
    if(layer==='precip')gradient.unshift([0,'#d6d9e0',1],[.02,'#d6d9e0',1]);
    return {gradient,ticks:ticks.map(([v,l])=>[v===0?0:pos(v),l])};
  }
  const info=LAYER_INFO[layer],stops=PALETTE_STOPS[info.palette];if(!stops)return null;
  const v0=stops[0][0],v1=stops.at(-1)[0],pos=v=>(v-v0)/(v1-v0);
  const label=v=>fieldValueText(layer,v)[0];
  const unit=fieldValueText(layer,v0)[1];
  const ticks=[v0,v0+(v1-v0)*.25,v0+(v1-v0)*.5,v0+(v1-v0)*.75,v1].map((v,i)=>[pos(v),i===0?`${label(v)} ${unit}`.trim():label(v)]);
  return {gradient:stops.map(([v,c,a])=>[pos(v),c,Math.max(a,.55)]),ticks};
}
function updateLegend(){
  const layer=state.lastPicked==='warnings'||!(state.lastPicked==='precip'?state.rain:state.lastPicked===state.field)?(state.field||(state.rain?'precip':null)):state.lastPicked;
  const model=layer?legendModel(layer):null;
  dom.legend.hidden=!model;if(!model)return;
  const key=layer+state.units.precipitation+state.units.temperature+state.units.wind+state.units.pressure;
  if(dom.legend.dataset.key===key)return;dom.legend.dataset.key=key;dom.legend.dataset.layer=layer;
  const rgba=(c,a)=>{const n=parseInt(c.slice(1),16);return `rgba(${n>>16},${n>>8&255},${n&255},${Math.min(1,a+.25)})`;};
  dom.legendBar.style.background=`linear-gradient(90deg,${model.gradient.map(([p,c,a])=>`${rgba(c,a)} ${(p*100).toFixed(1)}%`).join(',')})`;
  dom.legendTicks.replaceChildren(...model.ticks.map(([p,l])=>{const s=document.createElement('span');s.textContent=l;s.style.left=(p*100)+'%';return s;}));
}
/* layer bar */
function renderLayerBar(){
  dom.layerButtons.replaceChildren(...state.bar.map(id=>{
    const b=document.createElement('button');b.dataset.layer=id;b.setAttribute('aria-label',LAYERS[id].label);b.title=LAYERS[id].label;
    const on=id==='precip'?state.rain:id==='warnings'?state.warningsOn:state.field===id;
    b.classList.toggle('active',on);b.setAttribute('aria-pressed',String(on));b.innerHTML=icon(LAYERS[id].icon);return b;}));
}
function toggleLayer(id){
  const L=LAYERS[id];if(!L)return;
  if(L.kind==='rain')state.rain=!state.rain;
  else if(L.kind==='warnings'){state.warningsOn=!state.warningsOn;warningsKey='';}
  else state.field=state.field===id?null:id;
  state.lastPicked=id;save();renderLayerBar();updateLegend();requestMap();
}

/* ---------- gestures ---------- */
let gesture=null;
const pointers=new Map();
function referencePx(){return measure().map.width||400;}
function startScrub(x,y,t){
  const {min,max}=timeBounds(),range=max-min,ref=referencePx();
  return createScrub({start:state.time,min,max,x,y,t,
    horizontal:secondsPerPixel(state.swipe.horizontal,{rangeSeconds:range,referencePx:ref}),
    vertical:secondsPerPixel(state.swipe.vertical,{rangeSeconds:range,referencePx:ref})});
}
let momentumFrame=0;
function runMomentum(scrub,m){
  cancelAnimationFrame(momentumFrame);
  const start=performance.now(),dur=180;let applied=0;
  const tick=now=>{const k=Math.min(1,(now-start)/dur),eased=1-(1-k)**3,target=m.px*eased;
    setTime(scrub.applyMomentum(m.axis,target-applied));applied=target;if(k<1)momentumFrame=requestAnimationFrame(tick);};
  momentumFrame=requestAnimationFrame(tick);
}
function zoomAround(newZoom,sx,sy){
  const r=dom.map.getBoundingClientRect(),z0=state.map.zoom,z1=clamp(newZoom,3,11);
  const c0=mercator(state.map.latitude,state.map.longitude,z0),px=c0.x+(sx-r.width/2),py=c0.y+(sy-r.height/2);
  const k=2**(z1-z0),c1x=px*k-(sx-r.width/2),c1y=py*k-(sy-r.height/2);
  const p=unmercator(c1x,c1y,z1);state.map={latitude:clampLatitude(p.lat),longitude:wrappedLongitude(p.lon),zoom:z1};
}
function panBy(dx,dy){
  const p=mercator(state.map.latitude,state.map.longitude,state.map.zoom),q=unmercator(p.x-dx,p.y-dy,state.map.zoom);
  state.map.latitude=clampLatitude(q.lat);state.map.longitude=wrappedLongitude(q.lon);
}
let centerTimer=0;
/** After the map moved, the forecast place follows the centre marker. */
function scheduleCenterPlace(){
  clearTimeout(centerTimer);
  centerTimer=setTimeout(()=>{
    const r=dom.map.getBoundingClientRect(),a=mercator(state.place.latitude,state.place.longitude,state.map.zoom),
      b=mercator(state.map.latitude,state.map.longitude,state.map.zoom);
    save();
    if(Math.hypot(a.x-b.x,a.y-b.y)<Math.max(3,r.width*.01))return;
    setPlace({name:'Panned location',latitude:state.map.latitude,longitude:state.map.longitude},{center:false});
  },450);
}
function wireMapGestures(){
  const el=dom.map;
  el.addEventListener('pointerdown',e=>{
    if(e.target.closest('button,a,input,select,.map-chip'))return;
    el.setPointerCapture(e.pointerId);pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
    cancelAnimationFrame(momentumFrame);
    if(pointers.size===1){
      const pan=e.pointerType==='mouse'&&(e.ctrlKey||e.metaKey||e.button===2);
      gesture={kind:pan?'pan':'scrub',scrub:pan?null:startScrub(e.clientX,e.clientY,e.timeStamp),last:{x:e.clientX,y:e.clientY}};
    }else if(pointers.size===2){
      const [a,b]=[...pointers.values()];
      gesture={kind:'map',mid:{x:(a.x+b.x)/2,y:(a.y+b.y)/2},dist:Math.hypot(a.x-b.x,a.y-b.y),moved:false};
    }
  });
  el.addEventListener('pointermove',e=>{
    if(!pointers.has(e.pointerId)||!gesture)return;
    pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
    if(gesture.kind==='map'&&pointers.size>=2){
      const [a,b]=[...pointers.values()],mid={x:(a.x+b.x)/2,y:(a.y+b.y)/2},dist=Math.hypot(a.x-b.x,a.y-b.y);
      const r=el.getBoundingClientRect();
      panBy(mid.x-gesture.mid.x,mid.y-gesture.mid.y);
      if(gesture.dist>10&&dist>10)zoomAround(state.map.zoom+Math.log2(dist/gesture.dist),mid.x-r.left,mid.y-r.top);
      if(Math.hypot(mid.x-gesture.mid.x,mid.y-gesture.mid.y)>0.5)gesture.moved=true;
      gesture.mid=mid;gesture.dist=dist;requestMap();
    }else if(gesture.kind==='pan'){panBy(e.clientX-gesture.last.x,e.clientY-gesture.last.y);gesture.last={x:e.clientX,y:e.clientY};gesture.moved=true;requestMap();}
    else if(gesture.kind==='scrub'){setTime(gesture.scrub.move(e.clientX,e.clientY,e.timeStamp));}
  });
  const end=e=>{
    if(!pointers.has(e.pointerId))return;
    pointers.delete(e.pointerId);
    if(!gesture)return;
    if(gesture.kind==='scrub'&&pointers.size===0){
      const m=gesture.scrub.release(e.timeStamp);if(m)runMomentum(gesture.scrub,m);gesture=null;
    }else if(gesture.kind==='map'){
      if(gesture.moved)scheduleCenterPlace();else save();
      // The remaining finger must not start a scrub mid-gesture.
      gesture=pointers.size?{kind:'ignore'}:null;requestMap();
    }else if(gesture.kind==='pan'){if(gesture.moved)scheduleCenterPlace();gesture=null;}
    else if(pointers.size===0)gesture=null;
  };
  el.addEventListener('pointerup',end);el.addEventListener('pointercancel',end);
  el.addEventListener('contextmenu',e=>e.preventDefault());
  el.addEventListener('wheel',e=>{e.preventDefault();const r=el.getBoundingClientRect();
    zoomAround(state.map.zoom-e.deltaY/(e.deltaMode?3:300),e.clientX-r.left,e.clientY-r.top);requestMap();clearTimeout(centerTimer);
    centerTimer=setTimeout(save,300);},{passive:false});
}
function wireGraphGestures(){
  let press=null;
  dom.graphs.addEventListener('pointerdown',e=>{
    const node=e.target.closest('.graph');if(!node)return;
    press={node,x:e.clientX,y:e.clientY,id:e.pointerId,timer:setTimeout(()=>{
      const p=press;press=null;if(p)openGraphMenu(Number(p.node.dataset.index),p.x,p.y);},520)};
  });
  dom.graphs.addEventListener('pointermove',e=>{if(press&&e.pointerId===press.id&&Math.hypot(e.clientX-press.x,e.clientY-press.y)>8){clearTimeout(press.timer);press=null;}});
  const up=e=>{
    if(!press||e.pointerId!==press.id)return;clearTimeout(press.timer);
    const r=press.node.getBoundingClientRect(),v=timeView();press=null;
    if(e.type==='pointerup')setTime(v.start+clamp((e.clientX-r.left)/r.width,0,1)*(v.end-v.start));
  };
  dom.graphs.addEventListener('pointerup',up);dom.graphs.addEventListener('pointercancel',up);
  dom.graphs.addEventListener('contextmenu',e=>e.preventDefault());
}
function wireDays(){
  let lastTap=0;
  dom.days.addEventListener('click',e=>{
    const b=e.target.closest('button');if(!b)return;
    const now=performance.now();
    if(now-lastTap<350){lastTap=0;openCompare();return;}
    lastTap=now;toast('Double-tap a day to compare all models');
  });
}

/* ---------- places ---------- */
function setPlace(place,{center=true}={}){
  if(!validPlace(place))return;
  state.place={name:place.name,latitude:clampLatitude(place.latitude),longitude:wrappedLongitude(place.longitude)};
  if(center){state.map.latitude=state.place.latitude;state.map.longitude=state.place.longitude;}
  state.point=null;state.pointOM=null;placeWarnings=null;save();updateHeader();renderMeteo();updateReadout();requestMap();void loadPoint();
}
function updateHeader(){
  dom.placeName.textContent=state.place.name.split(',')[0]||state.place.name;
  const s=SOURCE_OPTIONS.find(x=>x.id===state.source);
  dom.modelName.textContent=s.id==='seamless'?'DWD ICON-D2 / EU / Global':s.label+(s.id==='icon_d2'?' 2 km':s.id==='icon_eu'?' 7 km':' 11 km');
}
function openDrawer(){renderPlaces();dom.drawer.hidden=false;dom.scrim.hidden=false;dom.placeBtn.setAttribute('aria-expanded','true');}
function closeDrawer(){dom.drawer.hidden=true;dom.scrim.hidden=true;dom.placeBtn.setAttribute('aria-expanded','false');}
function renderPlaces(){
  dom.placesList.replaceChildren(...state.favorites.map((p,i)=>{
    const row=document.createElement('div');row.className='place-row'+(placeKey(p)===placeKey(state.place)?' active':'');
    const choose=document.createElement('button');choose.className='choose';choose.innerHTML=icon('locate')+html`<span>${p.name}</span>`;
    choose.addEventListener('click',()=>{setPlace(p);closeDrawer();});
    const rm=document.createElement('button');rm.className='remove';rm.textContent='×';rm.setAttribute('aria-label','Remove '+p.name);
    rm.addEventListener('click',()=>{state.favorites.splice(i,1);save();renderPlaces();});
    row.append(choose,rm);return row;}));
  const saved=state.favorites.some(p=>placeKey(p)===placeKey(state.place));
  dom.addPlaceBtn.disabled=saved;dom.addPlaceBtn.lastChild.textContent=saved?'Place saved':'Save this place';
}

/* ---------- menus, dialogs and pages ---------- */
function openMenu(items,x,y){
  const m=dom.popupMenu;m.replaceChildren(...items.map(([label,ic,fn])=>{const b=document.createElement('button');b.setAttribute('role','menuitem');
    b.innerHTML=icon(ic)+html`<span>${label}</span>`;b.addEventListener('click',()=>{closeMenu();fn();});return b;}));
  m.hidden=false;const r=m.getBoundingClientRect();
  m.style.left=clamp(x,8,innerWidth-r.width-8)+'px';m.style.top=clamp(y,8,innerHeight-r.height-8)+'px';
  dom.scrim.hidden=false;dom.scrim.dataset.for='menu';
}
function closeMenu(){dom.popupMenu.hidden=true;if(dom.scrim.dataset.for==='menu'){dom.scrim.hidden=true;dom.scrim.dataset.for='';}}
/** Generic dialog: title, body element, actions [{label,fn,left}] (fn returning false keeps it open). */
function openDialog(title,body,actions=[{label:'Close'}]){
  const d=document.createElement('div');d.className='dialog';d.setAttribute('role','dialog');d.setAttribute('aria-label',title);
  const t=document.createElement('div');t.className='dialog-title';t.textContent=title;
  const b=document.createElement('div');b.className='dialog-body';b.append(body);
  const a=document.createElement('div');a.className='dialog-actions';
  for(const act of actions){const btn=document.createElement('button');btn.textContent=act.label;if(act.left)btn.className='left';
    btn.addEventListener('click',()=>{if(act.fn?.()===false)return;closeDialog();});a.append(btn);}
  d.append(t,b,a);dom.dialogLayer.replaceChildren(d);dom.dialogLayer.hidden=false;
}
function closeDialog(){dom.dialogLayer.hidden=true;dom.dialogLayer.replaceChildren();}
function openPage(title,subtitle,body,{onClose}={}){
  const bar=document.createElement('div');bar.className='page-bar';
  const back=document.createElement('button');back.className='round-button';back.setAttribute('aria-label','Back');back.innerHTML=ICONS.back;
  const h=document.createElement('h2');h.textContent=title;if(subtitle){const s=document.createElement('small');s.textContent=subtitle;h.append(s);}
  bar.append(back,h);
  const content=document.createElement('div');content.className='page-body';content.append(body);
  dom.page.replaceChildren(bar,content);dom.page.hidden=false;
  back.addEventListener('click',()=>{dom.page.hidden=true;dom.page.replaceChildren();onClose?.();});
}
function el(tag,props={},...children){const n=Object.assign(document.createElement(tag),props);n.append(...children);return n;}
function select(options,value,onChange){
  const s=el('select');for(const o of options){const opt=el('option',{value:o.value??o,textContent:o.label??o});s.append(opt);}
  s.value=value;s.addEventListener('change',()=>onChange(s.value));return s;
}
function fieldRow(label,control){return el('div',{className:'field-row'},el('label',{textContent:label}),control);}

function openMore(){
  const r=dom.moreBtn.getBoundingClientRect();
  openMenu([['Share','share',share],['Refresh','refresh',refresh]],r.right-190,r.bottom+4);
}
async function share(){
  const url=new URL(location.href);url.search=`?lat=${state.place.latitude.toFixed(4)}&lon=${state.place.longitude.toFixed(4)}`;
  try{if(navigator.share)await navigator.share({title:'OpenWetter · '+state.place.name,url:url.href});
    else{await navigator.clipboard.writeText(url.href);toast('Link copied');}}catch{/* cancelled */}
}
function refresh(){void loadIconRun({fresh:true});state.point=null;state.pointOM=null;void loadPoint();toast('Refreshing…');}
function openInfo(){
  const f=state.point,dl=el('dl',{className:'info-grid'});
  const row=(k,v)=>dl.append(el('dt',{textContent:k}),el('dd',{textContent:v}));
  row('Place',`${state.place.name} (${state.place.latitude.toFixed(3)}, ${state.place.longitude.toFixed(3)})`);
  row('Map model',state.icon?`DWD ICON-D2 run ${dayTime(state.icon.runTime)} (${utcHour(state.icon.runTime)})`:state.iconError||'loading…');
  for(const m of coarseManifests())row('Later days',`DWD ${m.label} run ${dayTime(m.runTime)} (${utcHour(m.runTime)})`);
  row('Radar',state.radar?`observed until ${dayTime(state.radar.latest)} · DWD RADOLAN`:'unavailable');
  row('Nowcast',state.nowcast?`issued ${dayTime(state.nowcast.issued)} · DWD RADVOR, next 2 h`:'unavailable');
  row('Warnings',state.warnings?`${state.warnings.warnings.length} active or upcoming · DWD`:'unavailable');
  row('Charts',f?`${Object.keys(f.models).map(m=>MODEL_LABELS[m]).join(' → ')} via Open-Meteo`:state.pointError||'loading…');
  if(f?.transitions.length)row('Model changes',f.transitions.map(t=>`${MODEL_LABELS[t.from]} → ${MODEL_LABELS[t.to]} at ${dayTime(t.time)}`).join('; '));
  const body=el('div',{},el('div',{className:'page-section',textContent:'Sources'}),dl,
    el('div',{className:'page-section',textContent:'How to read the map'}),
    el('p',{className:'note',textContent:'Precipitation is observed DWD radar up to the latest scan, then the DWD radar nowcast (about 2 hours), then the ICON-D2 model forecast. The label at the top right of the map says which one you are looking at. Other layers are ICON-D2 model fields; earlier hours come from earlier model runs.'}),
    el('div',{className:'page-section',textContent:'Attributions'}),
    el('p',{className:'note',innerHTML:'Weather data: <a href="https://opendata.dwd.de/" target="_blank" rel="noreferrer">Deutscher Wetterdienst</a> (CC BY 4.0). Point forecasts: <a href="https://open-meteo.com/" target="_blank" rel="noreferrer">Open-Meteo</a> (CC BY 4.0). Base map: © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors. Code: <a href="https://github.com/e-kotov/OpenWetter" target="_blank" rel="noreferrer">github.com/e-kotov/OpenWetter</a>.'}));
  openPage('Info','',body);
}
function openSource(){
  const list=el('div');
  for(const s of SOURCE_OPTIONS){
    const b=el('button',{className:'model-row'+(state.source===s.id?' active':'')});b.innerHTML=icon('layers')+html`<span>${s.label}<small>${s.note}</small></span>`;
    b.addEventListener('click',()=>{state.source=s.id;save();updateHeader();drawGraphs();updateReadout();closeDialog();});list.append(b);
  }
  list.append(el('p',{className:'note',textContent:'Charts follow the chosen model. Maps are ICON-D2 (Germany and neighbours) plus observed radar.'}));
  openDialog('Weather model',list,[{label:'Close'}]);
}
function openLayerEditor(){
  let draft=[...state.bar],tab='select';
  const body=el('div');
  const render=()=>{
    const tabs=el('div',{className:'tabs'});
    for(const [id,label] of [['select','Select'],['order','Order']]){const b=el('button',{textContent:label,className:tab===id?'active':''});
      b.addEventListener('click',()=>{tab=id;render();});tabs.append(b);}
    const list=el('div');
    if(tab==='select')for(const [id,L] of Object.entries(LAYERS)){
      const cb=el('input',{type:'checkbox',checked:draft.includes(id)});cb.setAttribute('aria-label',L.label);
      cb.addEventListener('change',()=>{draft=cb.checked?[...draft,id]:draft.filter(x=>x!==id);});
      const row=el('label',{className:'list-row'});row.innerHTML=icon(L.icon);row.append(el('span',{className:'label',textContent:L.label}),cb);list.append(row);
    }else draft.forEach((id,i)=>{
      const row=el('div',{className:'list-row'});row.innerHTML=icon(LAYERS[id].icon);row.append(el('span',{className:'label',textContent:LAYERS[id].label}));
      for(const [dir,ic] of [[-1,'up'],[1,'down']]){const b=el('button',{className:'order'});b.innerHTML=ICONS[ic];b.setAttribute('aria-label',(dir<0?'Move up ':'Move down ')+LAYERS[id].label);
        b.disabled=i+dir<0||i+dir>=draft.length;b.addEventListener('click',()=>{const j=i+dir;[draft[i],draft[j]]=[draft[j],draft[i]];render();});row.append(b);}
      list.append(row);});
    body.replaceChildren(tabs,list);
  };
  render();
  openDialog('Map menu',body,[{label:'Reset',left:true,fn:()=>{draft=[...DEFAULT_BAR];render();return false;}},{label:'Cancel'},
    {label:'Save',fn:()=>{if(!draft.length){toast('Choose at least one layer');return false;}state.bar=draft;
      if(state.field&&!draft.includes(state.field))state.field=null;save();renderLayerBar();requestMap();}}]);
}
function openSpectrum(){
  const layer=dom.legend.dataset.layer,key=layer==='precip'?'rain':'field';
  if(!layer)return;
  let value=state.opacity[key];
  const out=el('output',{textContent:Math.round(value*100)+' %'});
  const range=el('input',{type:'range',min:'10',max:'100',step:'5',value:String(Math.round(value*100))});
  range.addEventListener('input',()=>{value=Number(range.value)/100;out.textContent=range.value+' %';state.opacity[key]=value;requestMap();crossfades[key].stop({forget:false});});
  const before=state.opacity[key];
  const body=el('div',{},fieldRow('Opacity',el('span',{},range,' ',out)),
    el('div',{className:'field-block'},el('strong',{textContent:'Colours'}),el('div',{className:'legend card',style:'position:relative;box-shadow:none;padding:0'},
      el('span',{className:'legend-bar',style:'left:0;right:0;background:'+dom.legendBar.style.background}))),
    el('p',{className:'note',textContent:layer==='precip'?'One colour scale for observed radar, nowcast and forecast, so they can be compared directly.':'ICON-D2 '+LAYER_INFO[layer].label+', '+LAYER_INFO[layer].unit+'.'}));
  openDialog((layer==='precip'?'Precipitation':LAYERS[layer]?.label||'Layer')+' colours',body,[
    {label:'Reset',left:true,fn:()=>{state.opacity[key]=key==='rain'?.85:.8;range.value=String(Math.round(state.opacity[key]*100));out.textContent=range.value+' %';requestMap();return false;}},
    {label:'Cancel',fn:()=>{state.opacity[key]=before;requestMap();}},{label:'Save',fn:()=>{save();}}]);
}
function openGraphMenu(index,x,y){
  openMenu([['Compare','compare',openCompare],['Edit range','range',()=>openRange(index)],['Edit graph','edit',()=>openGraphEditor(index)],
    ['Add','add',()=>openAddGraph(index)],['Delete','trash',()=>deleteGraph(index)],['Help','help',openHelp]],x,y);
}
function openGraphEditor(index){
  const cfg=state.graphs[index];if(!cfg)return;
  const preview=el('div',{className:'graph'});const canvas=el('canvas');preview.append(canvas);
  const draw=()=>drawGraph(canvas,cfg,chartForecast(),timeView(),days(),graphInfo());
  const list=el('div');
  for(const [id,label] of GRAPH_TYPES[cfg.type].elements){
    const cb=el('input',{type:'checkbox',checked:cfg.elements[id]});cb.setAttribute('aria-label',label);
    cb.addEventListener('change',()=>{cfg.elements[id]=cb.checked;draw();save();requestGraphs();});
    list.append(el('label',{className:'list-row'},el('span',{className:'label',textContent:label}),cb));
  }
  const body=el('div',{},el('div',{className:'meteo-preview'},preview),el('p',{className:'page-hint',textContent:'Choose what this graph shows.'}),list);
  openPage('Edit graph',GRAPH_TYPES[cfg.type].label,body,{onClose:()=>renderMeteo()});
  requestAnimationFrame(draw);
}
function openRange(index){
  const cfg=state.graphs[index];if(!cfg)return;
  const body=el('div'),inputs={};
  const unitOf=k=>k==='wind'?(state.units.wind==='bft'?'km/h':state.units.wind):null;
  const toUser=(k,v)=>k==='wind'&&state.units.wind!=='bft'?conv.wind(v):v;
  const fromUser=(k,v)=>{if(k!=='wind'||state.units.wind==='bft')return v;return v/conv.wind(1);};
  const defaults=GRAPH_TYPES[cfg.type].ranges;
  for(const k of Object.keys(defaults)){
    const cur=cfg.ranges[k],auto=cur===null,custom=el('input',{type:'checkbox',checked:!auto});
    const lo=el('input',{type:'number',step:'any',value:auto?'':String(Math.round(toUser(k,cur[0])*10)/10)});
    const hi=el('input',{type:'number',step:'any',value:auto?'':String(Math.round(toUser(k,cur[1])*10)/10)});
    lo.disabled=hi.disabled=auto&&defaults[k]===null&&!custom.checked;
    custom.addEventListener('change',()=>{lo.disabled=hi.disabled=!custom.checked;});
    inputs[k]={custom,lo,hi};
    const label=RANGE_LABELS[k]+(unitOf(k)?` (${unitOf(k)})`:'');
    body.append(el('div',{className:'field-block'},el('label',{className:'list-row'},custom,el('span',{className:'label',textContent:label})),
      el('div',{className:'field-inline'},lo,hi),el('div',{className:'note',textContent:defaults[k]?`Default: ${defaults[k].map(v=>Math.round(toUser(k,v))).join(' – ')}`:'Default: automatic'})));
  }
  openDialog('Edit range',body,[{label:'Cancel'},{label:'Save',fn:()=>{
    for(const [k,{custom,lo,hi}] of Object.entries(inputs)){
      if(!custom.checked){cfg.ranges[k]=defaults[k]?[...defaults[k]]:null;continue;}
      const a=fromUser(k,Number(lo.value)),b=fromUser(k,Number(hi.value));
      if(!Number.isFinite(a)||!Number.isFinite(b)||b<=a){toast('Each range needs a minimum below its maximum',{error:true});return false;}
      cfg.ranges[k]=[a,b];
    }
    save();drawGraphs();
  }}]);
}
function openAddGraph(index){
  const list=el('div');
  for(const [type,t] of Object.entries(GRAPH_TYPES)){const b=el('button',{className:'model-row',textContent:t.label});
    b.addEventListener('click',()=>{if(state.graphs.length>=5){toast('Up to five graphs');return;}state.graphs.splice(index+1,0,defaultGraph(type));save();closeDialog();renderMeteo();});list.append(b);}
  openDialog('Add graph',list,[{label:'Cancel'}]);
}
function deleteGraph(index){
  if(state.graphs.length<=1){toast('Keep at least one graph');return;}
  state.graphs.splice(index,1);save();renderMeteo();
}
function openHelp(){
  openDialog('How to use OpenWetter',el('div',{},...[
    ['Swipe sideways on the map','change the time slowly (fine steps)'],['Swipe up or down','change the time quickly; up is later'],
    ['Two fingers','move or zoom the map; the forecast follows the square in the middle'],['Tap a graph','jump to that time'],
    ['Hold a graph','edit, add, remove or compare graphs'],['Tap the clock','back to now'],['Double-tap a day','compare all models'],
    ['Layer bar','tap icons to switch map layers; ⊕ to choose and order them'],['Colour bar','tap to change opacity'],
  ].map(([a,b])=>el('div',{className:'field-row'},el('strong',{textContent:a}),el('span',{className:'note',textContent:b})))),[{label:'Got it'}]);
}
function openSwipeSettings(){
  const draft=structuredClone(state.swipe);
  const axisBlock=(axis,label)=>{
    const num=el('input',{type:'number',step:'any',min:'0.1',value:String(draft[axis].value)});
    num.addEventListener('input',()=>{draft[axis].value=Number(num.value);});
    const unit=select([{value:'range',label:'% range'},{value:'days',label:'days'},{value:'hours',label:'hours'}],draft[axis].unit,v=>{draft[axis].unit=v;});
    return el('div',{className:'field-block'},el('strong',{textContent:label}),el('div',{className:'field-inline'},num,unit));
  };
  const stepping=select([{value:'smooth',label:'Smooth'},{value:'data',label:'Data steps'}],draft.stepping,v=>{draft.stepping=v;});
  const body=el('div',{},axisBlock('horizontal','Horizontal swipe speed'),axisBlock('vertical','Vertical swipe speed'),
    el('div',{className:'field-block'},el('strong',{textContent:'Time stepping'}),el('div',{className:'field-inline'},stepping)),
    el('p',{className:'note',textContent:'Speed is the time covered by one swipe across the whole map width. Right and up move later.'}));
  openDialog('Swipe settings',body,[{label:'Reset',left:true,fn:()=>{Object.assign(draft,structuredClone(DEFAULT_SWIPE));closeDialog();state.swipe=draft;save();openSwipeSettings();return false;}},
    {label:'Cancel'},{label:'Save',fn:()=>{if(!validSwipeSetting(draft.horizontal)||!validSwipeSetting(draft.vertical)){toast('Enter a positive speed',{error:true});return false;}
      state.swipe=draft;save();}}]);
}
function openSettings(){
  closeDrawer();
  const units=el('div');
  for(const [k,opts] of Object.entries(UNIT_OPTIONS))units.append(fieldRow({temperature:'Temperature',precipitation:'Precipitation',wind:'Wind',pressure:'Pressure'}[k],
    select(opts,state.units[k],v=>{state.units[k]=v;save();updateReadout();drawGraphs();updateChip();dom.legend.dataset.key='';updateLegend();})));
  const swipe=el('button',{className:'drawer-item',innerHTML:icon('settings')+'<span>Swipe settings</span>'});swipe.addEventListener('click',openSwipeSettings);
  const smooth=el('input',{type:'checkbox',checked:state.smoothFrames});smooth.addEventListener('change',()=>{state.smoothFrames=smooth.checked;save();});
  openPage('Settings','',el('div',{},el('div',{className:'page-section',textContent:'Units'}),units,
    el('div',{className:'page-section',textContent:'Controls'}),swipe,
    el('div',{className:'page-section',textContent:'Map'}),fieldRow('Smooth frame transitions',smooth)));
}
let cacheJob=null;
function openOffline(){
  closeDrawer();
  const progress=el('p',{className:'note',textContent:'Downloads the visible map area so you can scrub it without network. Maps you view are also kept automatically.'});
  const mk=(kind,label)=>{const b=el('button',{className:'drawer-item',innerHTML:icon('download')+html`<span>${label}</span>`});
    b.addEventListener('click',()=>void preloadCache(kind,progress));return b;};
  openDialog('Offline maps',el('div',{},mk('radar','Observed radar, past 6 h'),mk('icon','ICON-D2 rain, next 48 h'),progress),[{label:'Close'}]);
}
function cacheJobs(kind){
  const view=mapView(),urls=new Map();
  const add=frame=>{if(frame)for(const t of visibleFrameTiles(frame,view))urls.set(t.url,frame.source==='icon'?'icon':'radar');};
  if(kind==='icon')for(const c of iconLayerSpec('precip')?.chunks||[])add(iconFrame(state.icon,'precip',c.first));
  else{const seen=new Set(),since=(state.radar?.latest??0)-6*3600;
    for(const f of state.radar?.frames||[])if(f.time>=since&&!seen.has(f.chunkKey)){seen.add(f.chunkKey);add(radarFrame(state.radar,f));}
    if(state.nowcast)add(nowcastFrame(state.nowcast,state.nowcast.frames[0].time));}
  return [...urls];
}
async function preloadCache(kind,progress){
  if(cacheJob){cacheJob.abort();return;}
  const jobs=cacheJobs(kind);if(!jobs.length){progress.textContent='Nothing to download for this map view yet.';return;}
  const stats=await weatherDiskCache.stats(kind);if(!stats.available){progress.textContent='Storage is unavailable here; maps still load on demand.';return;}
  const controller=new AbortController();cacheJob=controller;let done=0,errors=0;
  try{for(const [url,bucket] of jobs){if(controller.signal.aborted)break;try{await tileBlob(url,bucket);}catch{errors++;}done++;
      progress.textContent=`${done}/${jobs.length} tiles${errors?` (${errors} failed)`:''}… tap again to stop`;}
    const info=await weatherDiskCache.stats(kind);
    progress.textContent=`${controller.signal.aborted?'Stopped':'Done'}: ${done-errors} tiles stored (${(info.bytes/1048576).toFixed(1)} MB on this device).`;
  }finally{cacheJob=null;}
}
/* model comparison page */
function openCompare(){
  const f=state.point;
  const body=el('div');
  const models=f?POINT_MODELS.filter(m=>f.models[m]):[];
  if(!models.length)body.append(el('p',{className:'note',textContent:state.pointError||'Loading forecast…'}));
  const groups=[];
  for(const m of models){
    const mf={...f,series:{...f.models[m],previous_temperature_2m:f.series.previous_temperature_2m},transitions:[],source:f.time.map(()=>m)};
    const block=el('div',{className:'compare-model'},el('h3',{textContent:'DWD '+MODEL_LABELS[m]+(m==='icon_d2'?' · 2 km':m==='icon_eu'?' · 7 km':' · 11 km')}));
    const wrap=el('div',{className:'meteo-preview'});
    for(const type of ['everyday','temperature']){const g=el('div',{className:'graph'}),c=el('canvas');g.append(c);wrap.append(g);groups.push([c,state.graphs.find(x=>x.type===type)||defaultGraph(type),mf]);}
    const cursor=el('div',{className:'time-cursor selected'});wrap.append(cursor);groups.push([null,null,null,cursor,wrap]);
    block.append(wrap);body.append(block);
  }
  body.append(el('p',{className:'page-hint',textContent:'Tap a graph to set the time. ICON-D2 ends after 48 hours and ICON-EU after 5 days.'}));
  const draw=()=>{const v=timeView(),d=days(),info=graphInfo();
    for(const [c,cfg,mf,cursor,wrap] of groups){
      if(c)drawGraph(c,cfg,mf,v,d,info);
      else{const w=wrap.getBoundingClientRect().width;cursor.style.top='0';cursor.style.height=wrap.getBoundingClientRect().height+'px';
        cursor.style.left=((state.time-v.start)/(v.end-v.start)*w)+'px';}
    }};
  body.addEventListener('click',e=>{const g=e.target.closest('.graph');if(!g)return;const r=g.getBoundingClientRect(),v=timeView();
    setTime(v.start+clamp((e.clientX-r.left)/r.width,0,1)*(v.end-v.start));draw();});
  openPage('Compare models',state.place.name,body);
  requestAnimationFrame(draw);
}

/* ---------- wiring ---------- */
function wire(){
  dom.placeBtn.addEventListener('click',()=>dom.drawer.hidden?openDrawer():closeDrawer());
  dom.scrim.addEventListener('click',()=>{closeDrawer();closeMenu();});
  dom.infoBtn.addEventListener('click',openInfo);
  dom.moreBtn.addEventListener('click',openMore);
  dom.clockBtn.addEventListener('click',()=>{cancelAnimationFrame(momentumFrame);setTime(Date.now()/1000);});
  dom.sourceBtn.addEventListener('click',openSource);
  dom.editLayersBtn.addEventListener('click',openLayerEditor);
  dom.layerButtons.addEventListener('click',e=>{const b=e.target.closest('button[data-layer]');if(b)toggleLayer(b.dataset.layer);});
  dom.legend.addEventListener('click',openSpectrum);
  dom.settingsBtn.addEventListener('click',openSettings);
  dom.offlineBtn.addEventListener('click',openOffline);
  dom.helpBtn.addEventListener('click',()=>{closeDrawer();openHelp();});
  dom.dialogLayer.addEventListener('click',e=>{if(e.target===dom.dialogLayer)closeDialog();});
  dom.addPlaceBtn.addEventListener('click',()=>{
    let p={...state.place};
    if(p.name==='Panned location'||p.name==='My location')p.name=`${p.name==='My location'?'My location':'Place'} ${p.latitude.toFixed(2)}, ${p.longitude.toFixed(2)}`;
    state.favorites.push(p);state.favorites=state.favorites.slice(-30);save();renderPlaces();});
  dom.locateBtn.addEventListener('click',()=>{
    if(!navigator.geolocation){toast('Location is not available',{error:true});return;}
    navigator.geolocation.getCurrentPosition(p=>{setPlace({name:'My location',latitude:p.coords.latitude,longitude:p.coords.longitude});closeDrawer();},
      e=>toast('Location: '+e.message,{error:true}),{timeout:12000,maximumAge:60000});
  });
  dom.searchForm.addEventListener('submit',async e=>{
    e.preventDefault();const q=dom.searchInput.value.trim();if(!q)return;
    try{const r=await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=1&language=en&format=json`);
      const j=await r.json(),p=j.results?.[0];if(!p)throw new Error('no matching place');
      setPlace({name:[p.name,p.admin1,p.country].filter((x,i,a)=>x&&a.indexOf(x)===i).join(', '),latitude:p.latitude,longitude:p.longitude});
      dom.searchInput.value='';closeDrawer();
    }catch(error){toast('Search: '+error.message,{error:true});}
  });
  window.addEventListener('keydown',e=>{
    if(e.key==='Escape'){closeDrawer();closeMenu();closeDialog();}
    if(e.target.matches('input,select,textarea')||!dom.page.hidden)return;
    const step={ArrowRight:3600,ArrowLeft:-3600,ArrowUp:900,ArrowDown:-900}[e.key];
    if(step){e.preventDefault();setTime(state.time+step);}
  });
  window.addEventListener('resize',()=>{relayout();requestGraphs();requestMap();});
  if('ResizeObserver' in window){const ro=new ResizeObserver(()=>{relayout();requestGraphs();requestMap();});
    for(const el of [dom.map,dom.meteo,dom.graphs,dom.extremes])ro.observe(el);}
  document.addEventListener('visibilitychange',()=>{if(!document.hidden){void loadIconRun();updateCursor();}});
  wireMapGestures();wireGraphGestures();wireDays();
}

/* ---------- start ---------- */
loadPreferences();
{
  const lat=Number(params.get('lat')),lon=Number(params.get('lon'));
  if(params.has('lat')&&params.has('lon')&&Number.isFinite(lat)&&Number.isFinite(lon)&&Math.abs(lat)<=85&&Math.abs(lon)<=180){
    state.place={name:params.get('name')||'Shared place',latitude:lat,longitude:lon};state.map.latitude=lat;state.map.longitude=lon;}
}
wire();updateHeader();renderLayerBar();renderMeteo();updateReadout();
void loadPoint();void loadIconRun();void loadWmsMetadata().then(()=>{requestMap();updateChip();});
void weatherDiskCache.dropOtherNamespaces();
setInterval(()=>{if(!document.hidden){void loadIconRun();void loadWmsMetadata().then(requestMap);}},120_000);
setInterval(()=>{updateCursor();updateDays();},60_000);
if('serviceWorker' in navigator&&!params.has('no-sw')&&(location.protocol==='https:'||location.hostname==='localhost'))
  window.addEventListener('load',()=>navigator.serviceWorker.register('./sw.js').catch(()=>{}));
if(params.has('test'))window.openwetterTest={state,setTime,setPlace,toggleLayer,timeBounds,timeView,rainSource,rainFrameAt,
  renderMap,drawGraphs,renderer,chartForecast,openCompare,openGraphMenu,openLayerEditor,
  sample:async(lat,lon)=>{const f=state.field?iconFrameAt(state.field,state.time):rainFrameAt(state.time).frame;if(!f)return null;await renderer.load(f,{latitude:lat,longitude:lon,zoom:12,width:8,height:8,ratio:1});
    const code=renderer.sampleAt(f,lat,lon);return {code,value:decodeCode(f.layer,code),layer:f.layer,time:f.time,source:f.source,index:f.index};}};
