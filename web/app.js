import {
  MODELS, MODEL_IDS, VARIABLES, DEFAULT_PLACES, clamp, wrappedLongitude, clampLatitude,
  forecastURL, parseForecast, nearestIndex, valueAtTime, axisLimits, hourFloor,
  pickGestureAxis, scrubTimestamp, forecastBounds, timelinePosition, placeKey,
  radarHistoryStartIndex,
  mercator, unmercator, dwdWmsTileURL, DWD_SATELLITE_CLOUDS,
} from './logic.mjs';
import {DATA_BASE,ICON_LAYERS,LAYER_INFO,legendFor,decodeCode,parseLatest,parseIconManifest,iconFrame,
  iconAdjacentChunk,chooseRun,parseHistoryIndex,parseRadarIndex,radarFrame,parseNowcastIndex,nowcastFrame,
  parseWarnings,activeWarnings,warningsCovering} from './tile-service.mjs';
import {fetchPointer,fetchImmutableJSON,tileBlob} from './tile-loader.mjs';
import {createRasterRenderer,drawWindArrows,visibleFrameTiles} from './raster-renderer.mjs';
import {composeIconD2Forecast,downloadGridSeries} from './point-series.mjs';
import {weatherDiskCache} from './frame-cache.mjs';
import {fetchIconEuCapabilities,paintIconEuWms,iconEuValidTime} from './wms-eu.mjs';
import {createWeatherCrossfade} from './frame-transition.mjs';
import {continuousWeatherTimeline,continuousCursorIndex} from './continuous-timeline.mjs';
import {splitModelHistory,chartSeries} from './historical-charts.mjs';

const el=id=>document.getElementById(id);
const fields=[
  'appRoot','placesBtn','headerPlace','viewForecast','viewCompare','settingsBtn','searchForm','citySearch',
  'modelSelect','locateBtn','locationName','modelDescription','heroTemp','heroTime','quickRain','quickWind',
  'quickCloud','message','warningsList','plotsHeading','horizonPast','horizon48','horizon120','graphStack','playBtn','timeLabel',
  'timeRange','timeSlider','startLabel','endLabel','settingsPanel','horizontalSpeed','horizontalOutput',
  'verticalSpeed','verticalOutput','opacitySlider','opacityOutput','cloudOpacitySlider','cloudOpacityOutput',
  'map','baseTiles','iconCanvas','iconTransitionCanvas','radarCanvas','radarTransitionCanvas','cloudTiles','toggleRain','toggleClouds',
  'layersBtn','layersBtnLabel','layerPanel','layerList','closeLayers','toggleWarnings','warningsToggleRow','mapLegend','warningsCanvas',
  'mapPin','pinTemp','mapLayerName','mapModelName','modeContinuous','modeForecast','modeRadar','zoomIn','zoomOut',
  'boundaryTransitionCanvas','resetView','mapInstruction','radarAttribution','placesDrawer','drawerScrim','closePlaces',
  'placesList','savePlace','cacheRadarBtn','cacheForecastBtn','cacheProgress','smoothFrames',
  'forecastHorizonButtons','radarHistoryButtons','radarHours2','radarHours6','radarHours48',
];
const dom=Object.fromEntries(fields.map(k=>[k,el(k)]));
const defaultPlace={...DEFAULT_PLACES[0]};
const RADAR_WINDOWS=[2,6,48];
const state={
  place:defaultPlace, map:{latitude:defaultPlace.latitude,longitude:defaultPlace.longitude,zoom:7},
  favorites:DEFAULT_PLACES.map(x=>({...x})),
  model:'icon_d2',view:'forecast',mode:'forecast',continuousCursor:null,horizon:48,
  horizontalHours:4,verticalHours:24,radarOpacity:.75,cloudOpacity:.5,showRain:false,showClouds:false,
  anchor:hourFloor(Date.now()/1000),selectedTime:hourFloor(Date.now()/1000),
  forecasts:{},pastForecasts:{},forecast:null,forecastIndex:0,loadingModels:new Set(),modelErrors:{},
  radar:null,radarIndex:0,radarHours:6,displayedRadarTime:null,playing:false,
  radarUnavailable:false,nowcast:null,nowcastUnavailable:false,
  warnings:null,warningsUnavailable:false,showWarnings:true,
  smoothFrames:true,
  latest:null,icon:null,iconError:null,history:null,pastModel:false,iconLayer:'precip',
  gridSeries:null,euWms:null,euWmsError:null,
};
let fetchEpoch=0;
const fetchControllers=new Map();
let playTimer=null,mapRedrawRequest=0,graphRedrawRequest=0,forecastCursorRequest=0;
let cloudWarningIssued=false,pointSeriesEpoch=0,forecastPaintEpoch=0;
let cacheWarmupController=null,cacheWarmupKind=null;
let euMetadataLoading=null,forecastCanvasSource='';
const pointers=new Map();
let drag=null;
const FORECAST_MAX_AGE=45*60_000;
const STORAGE='openwetter.settings.v2';
const params=new URLSearchParams(location.search);
// After Android drops and restores the GL context every tile is reloaded and redrawn.
const renderer=createRasterRenderer({forceCanvas:params.has('canvas2d'),
  onContextRestored:()=>{for(const p of Object.values(painters))p.reset();requestMap();}});
const crossfades={
  forecast:createWeatherCrossfade(dom.iconCanvas,dom.iconTransitionCanvas,{
    durationMs:260,opacity:()=>1,enabled:()=>state.smoothFrames
  }),
  radar:createWeatherCrossfade(dom.radarCanvas,dom.radarTransitionCanvas,{
    durationMs:260,opacity:()=>state.radarOpacity,enabled:()=>state.smoothFrames
  })
};
function mapViewKey(layer,width,height,ratio,map,extra=''){
  return [layer,width,height,ratio,map.zoom,map.latitude.toFixed(6),
    map.longitude.toFixed(6),extra].join('|');
}

function save(){
  try{localStorage.setItem(STORAGE,JSON.stringify({place:state.place,favorites:state.favorites,
    model:state.model,horizon:state.horizon,horizontalHours:state.horizontalHours,
    verticalHours:state.verticalHours,radarOpacity:state.radarOpacity,cloudOpacity:state.cloudOpacity,
    showRain:state.showRain,showClouds:state.showClouds,iconLayer:state.iconLayer,showWarnings:state.showWarnings,
    radarHours:state.radarHours,smoothFrames:state.smoothFrames}));}catch{/* Browsers may deny storage. */}
}
function validPlace(p){return p&&typeof p.name==='string'&&p.name.length>0&&p.name.length<150&&Number.isFinite(p.latitude)&&Number.isFinite(p.longitude)&&Math.abs(p.latitude)<=85&&Math.abs(p.longitude)<=180;}
function loadPreferences(){
  try{
    const p=JSON.parse(localStorage.getItem(STORAGE)||'{}');
    if(validPlace(p.place)){
      state.place={...p.place};state.map.latitude=p.place.latitude;state.map.longitude=p.place.longitude;
    }
    if(Array.isArray(p.favorites))state.favorites=p.favorites.filter(validPlace).slice(0,20);
    if(Object.hasOwn(MODELS,p.model))state.model=p.model;
    if([48,120].includes(p.horizon))state.horizon=p.horizon;
    if(RADAR_WINDOWS.includes(p.radarHours))state.radarHours=p.radarHours;
    if(typeof p.smoothFrames==='boolean')state.smoothFrames=p.smoothFrames;
    if(Number.isFinite(p.horizontalHours))state.horizontalHours=clamp(p.horizontalHours,1,24);
    if(Number.isFinite(p.verticalHours))state.verticalHours=clamp(p.verticalHours,4,72);
    if(Number.isFinite(p.radarOpacity))state.radarOpacity=clamp(p.radarOpacity,.1,1);
    if(Number.isFinite(p.cloudOpacity))state.cloudOpacity=clamp(p.cloudOpacity,.1,1);
    if(typeof p.showRain==='boolean')state.showRain=p.showRain;
    if(typeof p.showClouds==='boolean')state.showClouds=p.showClouds;
    if(ICON_LAYERS.includes(p.iconLayer))state.iconLayer=p.iconLayer;
    if(typeof p.showWarnings==='boolean')state.showWarnings=p.showWarnings;
  }catch{/* Use defaults. */}
}
function showMessage(msg,error=false){dom.message.textContent=msg;dom.message.className=`message${msg?' visible':''}${error?' error':''}`;}
function zone(){return state.forecast?.timezone||'Europe/Berlin';}
function formatTime(seconds,options={weekday:'short',hour:'2-digit',minute:'2-digit'}){
  if(!Number.isFinite(seconds))return '—';
  return new Intl.DateTimeFormat('en-GB',{...options,timeZone:zone()}).format(new Date(seconds*1000));
}
function formatUTC(seconds){
  return Number.isFinite(seconds)?new Date(seconds*1000).toISOString().slice(11,16)+' UTC':'—';
}
function shortPlace(name){return name.split(',')[0]||name;}
function fmt(v,metric){if(v==null)return '—';return metric==='precipitation'?v.toFixed(1):String(Math.round(v));}
function continuousTime(){return combinedFrame()?.time??state.selectedTime;}
function chartTime(){return state.mode==='radar'?getRadarTime()??state.anchor:
  state.mode==='continuous'?continuousTime():state.selectedTime;}
function metricValue(model,metric){const time=chartTime();return valueAtTime(
  time<state.anchor?state.pastForecasts[model]:state.forecasts[model],metric,time);}
function chartBounds(){
  // The charts have no past-days data, so they keep the forecast window while the map shows past runs.
  const b=timeBounds({past:false});if(state.mode==='forecast'||state.view==='compare')return b;
  const start=state.radar?.frames?.[radarWindowStart()]?.time;
  return {min:Math.min(state.anchor,start??state.anchor-state.radarHours*3600),max:b.max};
}

/* ---------- ICON-D2 runs and frames ---------- */
function iconManifests(){return [state.icon,...(state.history?.slices||[])].filter(Boolean);}
/** Map layer for the current display: the rain sequence always uses precip. */
function displayedIconLayer(){return state.mode==='continuous'?'precip':state.iconLayer;}
function iconLayerSpec(layer=displayedIconLayer()){return state.icon?.layers?.[layer]||null;}
/** ICON frame valid at `time`, from the newest run covering it. Earlier
 * runs' 3-hour history slices are loaded lazily, only when needed. */
function iconFrameAt(layer,time){
  const manifest=chooseRun(iconManifests(),layer,time);
  if(manifest)return iconFrame(manifest,layer,time);
  // Only times before the newest run's first frame can be in a history slice.
  const start=state.icon?.layers?.[layer]?.start;
  if(start!=null&&time<start)void loadHistory();
  return null;
}
/** The history index (one small JSON file listing every slice), fetched at
 * most once per newest run; a missing index just means no history. */
let historyLoading=null;
function loadHistory(){
  const run=state.icon?.runTime,path=state.latest?.history;
  if(run==null||!path||state.history?.forRun===run)return historyLoading;
  if(historyLoading)return historyLoading;
  historyLoading=(async()=>{
    try{
      // The index is rewritten before latest.json moves to a new run, so a
      // fresh fetch after a run change already lists the previous run.
      const raw=await fetchPointer(DATA_BASE+path,{ttlMs:0});
      if(state.icon?.runTime!==run)return;
      // The newest run's own slice duplicates the run at another tile size.
      state.history={forRun:run,slices:raw?parseHistoryIndex(raw).filter(m=>m.runTime<run):[]};
      if(pastActive())state.selectedTime=clamp(state.selectedTime,...Object.values(timeBounds()));
      requestMap();updateTimeUI();updateOverlayUI();
    }catch{
      // Unreadable index: no history this session for this run; retried after the next run change.
      if(state.icon?.runTime===run)state.history={forRun:run,slices:[]};
    }finally{historyLoading=null;}
  })();
  return historyLoading;
}
/** Earliest time any loaded history slice covers for a layer, or null. */
function historyStart(layer){
  const starts=(state.history?.slices||[]).map(m=>m.layers[layer]?.start).filter(Number.isFinite);
  return starts.length?Math.min(...starts):null;
}
function combinedFrames(){
  const b=forecastBounds(state.anchor,state.horizon),spec=iconLayerSpec('precip');
  // ICON-EU keeps its hourly WMS rain; every other model's map is ICON-D2.
  const d2=state.model!=='icon_eu'&&spec;
  return continuousWeatherTimeline(state.radar?.frames,{historyHours:state.radarHours,now:Date.now()/1000,
    nowcastFrames:state.nowcast?.frames,
    start:d2?spec.start:b.min,end:d2?Math.min(b.max,spec.end):b.max,step:d2?spec.step:3600});
}
function combinedFrame(){const f=combinedFrames();return f[continuousCursorIndex(f,state.continuousCursor)]||null;}
const canvasGroup=kind=>kind==='forecast'?'forecast':'radar';
function setContinuousIndex(index){const frames=combinedFrames(),f=frames[clamp(Math.round(index),0,frames.length-1)];if(!f)return;
  const previous=combinedFrame();
  if(state.mode==='continuous'&&previous&&canvasGroup(previous.kind)!==canvasGroup(f.kind))beginBoundaryTransition(canvasGroup(previous.kind),canvasGroup(f.kind));
  state.continuousCursor=f;if(f.kind==='radar')state.radarIndex=nearestIndex(state.radar.frames.map(x=>x.time),f.time);
  else if(f.kind==='forecast')state.selectedTime=f.time;
  updateReadouts();updateTimeUI();requestCursor();requestGraphs();updateOverlayUI();requestMap();}
let boundaryTarget=null,boundaryVersion=0;
function beginBoundaryTransition(from,to){
  const origin=from==='radar'?dom.radarCanvas:dom.iconCanvas,layer=dom.boundaryTransitionCanvas;
  const w=origin.width,h=origin.height;
  if(!w||!h){boundaryTarget=null;layer.hidden=true;return;}
  boundaryTarget=to;boundaryVersion++;
  layer.width=w;layer.height=h;
  const c=layer.getContext('2d');c.clearRect(0,0,w,h);c.drawImage(origin,0,0);
  layer.style.transition='none';layer.style.opacity=String(from==='radar'?state.radarOpacity:1);
  layer.hidden=false;layer.dataset.fromSource=from;layer.dataset.toSource=to;
}
function completeBoundaryTransition(target){
  if(boundaryTarget!==target)return;
  const layer=dom.boundaryTransitionCanvas,version=++boundaryVersion;boundaryTarget=null;
  if(!state.smoothFrames||window.matchMedia?.('(prefers-reduced-motion: reduce)').matches){layer.hidden=true;return;}
  requestAnimationFrame(()=>{if(version!==boundaryVersion)return;layer.style.transition='opacity 360ms linear';layer.style.opacity='0';});
  setTimeout(()=>{if(version===boundaryVersion)layer.hidden=true;},400);
}
/** The forecast map is ICON-D2 tiles unless ICON-EU rain is selected. */
function usesD2Map(){return !(state.model==='icon_eu'&&state.iconLayer==='precip');}
/* ---------- past days: map of earlier ICON-D2 runs (history slices) ---------- */
const PAST_DAYS=5;
/** Past days apply to the ICON-D2 forecast map only. */
function pastModelAvailable(){
  return state.view==='forecast'&&state.mode==='forecast'&&usesD2Map()&&Boolean(state.icon&&state.latest?.history);
}
function pastActive(){return state.pastModel&&pastModelAvailable();}
/** From the oldest history slice (5 days; optimistic until the index is
 * loaded) up to the current hour, where the forecast range begins. */
function pastBounds(){
  const spec=iconLayerSpec(state.iconLayer),max=state.anchor,floor=max-PAST_DAYS*86400;
  const loaded=state.history?.forRun===state.icon?.runTime;
  const earliest=loaded?historyStart(state.iconLayer)??spec?.start??max:floor;
  return {min:Math.min(max,Math.max(floor,earliest)),max};
}
function setPastModel(on){
  on=Boolean(on)&&pastModelAvailable();
  if(on===state.pastModel&&on===pastActive())return;
  stopPlay();state.pastModel=on;
  if(on){
    void loadHistory();
    // Start at the latest past time, so scrubbing back walks into the past.
    const step=timelineStep();state.selectedTime=Math.floor(pastBounds().max/step)*step;
  }
  state.selectedTime=clamp(state.selectedTime,...Object.values(timeBounds()));
  refreshView();updateOverlayUI();
}
/** Back to the forecast range (no-op unless past days were on). */
function leavePast(){
  if(!state.pastModel)return;
  state.pastModel=false;state.selectedTime=clamp(state.anchor,...Object.values(timeBounds()));
}
function timeBounds({past=pastActive()}={}){
  if(past)return pastBounds();
  const b=forecastBounds(state.anchor,state.horizon),spec=iconLayerSpec(state.iconLayer);
  if(state.mode==='forecast'&&state.model==='icon_d2'&&spec){
    // History slices can cover times before a fresh run's first frame. Until
    // the index is loaded, allow the full range when the service has one.
    const loaded=state.history?.forRun===state.icon.runTime;
    const earliest=loaded?Math.min(spec.start,historyStart(state.iconLayer)??spec.start):state.latest?.history?b.min:spec.start;
    b.min=Math.max(b.min,Math.min(earliest,b.max));
    b.max=Math.max(b.min,Math.min(b.max,spec.end));
  }
  return b;
}
function timelineStep(){
  const spec=iconLayerSpec(state.iconLayer);
  return state.mode==='forecast'&&(state.model==='icon_d2'||pastActive())&&spec?spec.step:3600;
}

function requestMap(){if(!mapRedrawRequest)mapRedrawRequest=requestAnimationFrame(()=>{mapRedrawRequest=0;renderMap();});}
function requestGraphs(){if(!graphRedrawRequest)graphRedrawRequest=requestAnimationFrame(()=>{graphRedrawRequest=0;drawGraphs();});}
function requestCursor(){if(!forecastCursorRequest)forecastCursorRequest=requestAnimationFrame(()=>{forecastCursorRequest=0;updateCursor();});}
/** Bounded forecast API request; distinguish timeouts from deliberate
 * cancellation (e.g. switching locations). Never surface the browser's
 * misleading "signal is aborted without reason" as a weather-model failure.
 */
async function getJson(url,signal,ms=25000){
  const abort=new AbortController();
  const onAbort=()=>abort.abort(signal?.reason||new DOMException('Request cancelled','AbortError'));
  if(signal?.aborted)onAbort();
  else signal?.addEventListener('abort',onAbort,{once:true});
  const timeout=setTimeout(()=>
    abort.abort(new DOMException('Forecast request timed out','TimeoutError')),ms);
  try{
    const response=await fetch(url,{signal:abort.signal});
    if(!response.ok)throw new Error(`HTTP ${response.status}`);
    const json=await response.json();
    if(json?.error)throw new Error(json.reason||'API rejected request');
    return json;
  }catch(error){
    if(!signal?.aborted&&abort.signal.aborted)
      throw new Error(`Forecast request timed out after ${Math.round(ms/1000)} seconds`);
    throw error;
  }finally{clearTimeout(timeout);signal?.removeEventListener('abort',onAbort);}
}
async function getPointForecastJson(url,signal){
  let last;
  for(const ms of [25000,35000]){
    try{return await getJson(url,signal,ms);}
    catch(error){
      if(signal?.aborted)throw error;
      last=error;
      // Retry timeouts and temporary server/network errors, not invalid requests.
      if(!/timed out|abort|network|failed to fetch|HTTP (408|429|5\d\d)/i.test(error.message||''))
        throw error;
    }
  }
  throw last;
}
function cacheId(model){return `openwetter.forecast.v2.${model}.${placeKey(state.place)}`;}
function cachedModel(model){
  try{
    const obj=JSON.parse(localStorage.getItem(cacheId(model))||'null');
    if(obj&&Date.now()-obj.savedAt<12*3600_000)return parseForecast(obj.forecast);
  }catch{/* Cache missing or incomplete. */}
  return null;
}
async function loadModel(model,epoch=fetchEpoch){
  // A grid-only ICON-D2 forecast is useful but still needs a point-API attempt
  // to populate wind. It must not suppress later retries for 45 minutes.
  if(state.forecasts[model]&&!state.forecasts[model].gridOnly&&
      Date.now()-state.forecasts[model].fetchedAt<FORECAST_MAX_AGE)return;
  if(state.loadingModels.has(model))return;
  const controller=new AbortController();fetchControllers.set(model,controller);
  state.loadingModels.add(model);delete state.modelErrors[model];renderGraphs();
  if(model===state.model)showMessage(`Loading DWD ${MODELS[model].label} forecast…`);
  try{
    const result=parseForecast(await getPointForecastJson(forecastURL({...state.place,model}),controller.signal));
    if(controller.signal.aborted||epoch!==fetchEpoch)return;
    const {forecast,past}=splitModelHistory(result,state.anchor);
    state.forecasts[model]={...forecast,fetchedAt:Date.now()};
    state.pastForecasts[model]=past;
    if(model==='icon_d2')applyGridForecast();
    try{localStorage.setItem(cacheId(model),JSON.stringify({savedAt:Date.now(),forecast:result}));}catch{/* optional */}
    if(model===state.model){state.forecast=state.forecasts[model];showMessage('');}
  }catch(error){
    if(controller.signal.aborted||epoch!==fetchEpoch)return;
    const cached=cachedModel(model);
    // Keep already-available DWD grid graphs, even if the optional point
    // provider is offline or times out. A point error must not blank them.
    if(cached){
      const {forecast,past}=splitModelHistory(cached,state.anchor);
      state.forecasts[model]={...forecast,fetchedAt:Date.now()};state.pastForecasts[model]=past;
    }
    if(model==='icon_d2'&&state.gridSeries)applyGridForecast();
    const usable=state.forecasts[model];
    if(usable){
      state.modelErrors[model]=usable.gridOnly?
        'Point-API extras (where the grid has none) temporarily unavailable':
        'Using cached point forecast';
      if(model===state.model){
        state.forecast=usable;
        showMessage(usable.gridOnly?
          'DWD ICON-D2 charts ready from the map grid; Open-Meteo point data temporarily unavailable.':
          `${MODELS[model].label}: using cached data until the forecast service responds.`);
      }
    }else{
      state.modelErrors[model]=`Unavailable: ${error.message}`;
      if(model===state.model){
        state.forecast=null;
        showMessage(`${MODELS[model].label}: ${state.modelErrors[model]}`,true);
      }
    }
  }finally{
    if(epoch===fetchEpoch){state.loadingModels.delete(model);fetchControllers.delete(model);refreshView();}
  }
}
function loadModelsForView(){
  void loadModel(state.model);
  if(state.view==='compare')for(const model of MODEL_IDS)void loadModel(model);
}

/* ---------- tile service pointers ---------- */
async function loadIconRun({fresh=false}={}){
  const ttlMs=fresh?0:60_000;
  try{
    const raw=await fetchPointer(DATA_BASE+'latest.json',{ttlMs});
    if(!raw)throw new Error('tile service pointer not found');
    const latest=parseLatest(raw);state.latest=latest;
    if(!latest.icon)throw new Error('no ICON-D2 run published');
    if(state.icon?.dir!==DATA_BASE+latest.icon.manifest.slice(0,latest.icon.manifest.lastIndexOf('/')+1)){
      const manifest=parseIconManifest(await fetchImmutableJSON(DATA_BASE+latest.icon.manifest),latest.icon.manifest);
      // The previous run is not kept: the server deletes its tiles 30 minutes
      // after this run goes live; its first 3 hours are in the history index.
      state.icon=manifest;state.iconError=null;state.history=null;
      await loadPointSeries();
    }
    refreshView();buildLayerMenu();
  }catch(error){
    state.iconError=error.message;
    if(!state.icon){
      updateOverlayUI();requestMap();
      if(usesD2Map())showMessage('ICON-D2 map tiles unavailable: '+error.message,true);
    }
  }finally{
    // Radar, nowcast and warnings are independent of the ICON pointer; when
    // latest.json lacks their keys the fixed specification paths are used.
    void loadRadar(ttlMs);void loadNowcast(ttlMs);void loadWarnings(ttlMs);
  }
}
/** Judged against the clock now, not when the index was parsed, so a radar
 * feed that stops updating mid-session is flagged. */
function radarIsStale(){const t=state.radar?.latest;return t==null||Date.now()/1000-t>3600;}
function pointerURL(key,fallback){return DATA_BASE+(state.latest?.[key]||fallback);}
async function loadRadar(ttlMs=60_000){
  try{
    const raw=await fetchPointer(pointerURL('radar','radar/index.json'),{ttlMs});
    if(!raw){state.radarUnavailable=true;state.radar=null;afterPointerChange();return;}
    const index=parseRadarIndex(raw);
    if(state.radar?.latest===index.latest&&state.radar?.frames.length===index.frames.length){state.radarUnavailable=false;updateOverlayUI();return;}
    const hadRadar=Boolean(state.radar),followLatest=!hadRadar||state.radarIndex>=state.radar.frames.length-1;
    // A displayed scan that moved into a merged block has new tile URLs under
    // the same time: make the painter load and draw it again.
    const shownRadar=painters.radar.shown;
    if(shownRadar?.source==='radar'&&index.frames.find(f=>f.time===shownRadar.time)?.chunkKey!==shownRadar.chunkKey)painters.radar.reset();
    state.radar=index;state.radarUnavailable=!index.frames.length;
    if(followLatest)state.radarIndex=index.frames.length-1;
    else state.radarIndex=clamp(nearestIndex(index.frames.map(f=>f.time),getRadarTime()??index.latest),0,index.frames.length-1);
    if(state.mode==='continuous'&&!hadRadar&&index.frames.length)state.continuousCursor={kind:'radar',time:index.latest};
    afterPointerChange();
  }catch(error){
    if(!state.radar){state.radarUnavailable=true;afterPointerChange();}
  }
}
async function loadNowcast(ttlMs=60_000){
  try{
    const raw=await fetchPointer(pointerURL('nowcast','nowcast/index.json'),{ttlMs});
    if(!raw){state.nowcastUnavailable=true;state.nowcast=null;afterPointerChange();return;}
    const index=parseNowcastIndex(raw);
    if(state.nowcast?.issued===index.issued)return;
    state.nowcast=index;state.nowcastUnavailable=false;afterPointerChange();
  }catch{if(!state.nowcast){state.nowcastUnavailable=true;afterPointerChange();}}
}
async function loadWarnings(ttlMs=60_000){
  try{
    const raw=await fetchPointer(pointerURL('warnings','warnings/index.json'),{ttlMs});
    if(!raw){state.warningsUnavailable=true;state.warnings=null;afterPointerChange();return;}
    state.warnings=parseWarnings(raw);state.warningsUnavailable=false;projectedWarnings=null;warningsDrawKey='';afterPointerChange();
  }catch{if(!state.warnings){state.warningsUnavailable=true;afterPointerChange();}}
}
function afterPointerChange(){
  buildLayerMenu();updateReadouts();updateTimeUI();requestCursor();requestGraphs();requestMap();
}
function refreshPointers(){if(!document.hidden){void loadIconRun();}}
/** A listed tile that 404s was deleted by a newer publish: re-read every
 * index now (at most every 30 s) instead of waiting for the 2-minute refresh. */
let lastMissingRefresh=0;
function refreshAfterMissingTiles(result){
  if(!result?.missing||Date.now()-lastMissingRefresh<30_000)return;
  lastMissingRefresh=Date.now();void loadIconRun({fresh:true});
}

function updateCacheControls(){
  dom.cacheRadarBtn.textContent=cacheWarmupKind==='radar'?'Cancel radar download':'Cache visible radar area (past 6 h)';
  dom.cacheForecastBtn.textContent=cacheWarmupKind==='icon'?'Cancel forecast download':
    `Cache visible ICON-D2 ${LAYER_INFO[state.iconLayer].label.toLowerCase()} (48 h)`;
  dom.cacheRadarBtn.disabled=Boolean(cacheWarmupKind&&cacheWarmupKind!=='radar')||!state.radar;
  dom.cacheForecastBtn.disabled=Boolean(cacheWarmupKind&&cacheWarmupKind!=='icon')||!state.icon;
}
function mapView(){
  const r=dom.map.getBoundingClientRect();
  return {width:r.width,height:r.height,ratio:Math.min(2.5,window.devicePixelRatio||1),
    zoom:state.map.zoom,latitude:state.map.latitude,longitude:state.map.longitude};
}
/** URLs of the visible tiles for every chunk of the active ICON layer, or for
 * the radar chunks in the past 6 h (plus the current nowcast). Disk only. */
function cacheJobs(kind){
  const view=mapView(),urls=new Map();
  const add=frame=>{if(frame)for(const t of visibleFrameTiles(frame,view))urls.set(t.url,frame.source==='icon'?'icon':'radar');};
  if(kind==='icon'){
    const spec=iconLayerSpec(state.iconLayer);
    for(const c of spec?.chunks||[])add(iconFrame(state.icon,state.iconLayer,c.first));
  }else{
    const seen=new Set(),since=(state.radar?.latest??0)-6*3600;
    for(const f of state.radar?.frames||[])if(f.time>=since&&!seen.has(f.chunkKey)){seen.add(f.chunkKey);add(radarFrame(state.radar,f));}
    if(state.nowcast)add(nowcastFrame(state.nowcast,state.nowcast.frames[0].time));
  }
  return [...urls];
}
async function preloadWeatherCache(kind){
  if(cacheWarmupKind===kind){
    cacheWarmupController?.abort();
    dom.cacheProgress.textContent='Stopping cache download…';
    return;
  }
  if(cacheWarmupKind)return;
  const jobs=cacheJobs(kind);
  if(!jobs.length){
    dom.cacheProgress.textContent=(kind==='radar'?'Radar':'ICON-D2')+' tiles unavailable for this map view.';
    return;
  }
  const existing=await weatherDiskCache.stats(kind);
  if(!existing.available){
    dom.cacheProgress.textContent='Persistent storage unavailable in this WebView. Normal on-demand loading still works.';
    return;
  }
  const controller=new AbortController();
  cacheWarmupController=controller;cacheWarmupKind=kind;updateCacheControls();
  const label=kind==='radar'?'Radar':'Forecast';
  let done=0,errors=0;
  try{
    for(const [url,bucket] of jobs){
      if(controller.signal.aborted)break;
      try{await tileBlob(url,bucket);}catch{errors++;}
      done++;
      dom.cacheProgress.textContent=`${label} ${done}/${jobs.length} tiles${errors?' ('+errors+' failed)':''}…`;
    }
    const info=await weatherDiskCache.stats(kind);
    const mb=(info.bytes/(1024*1024)).toFixed(1);
    dom.cacheProgress.textContent=controller.signal.aborted?
      `${label} cache download paused. Already-downloaded tiles remain stored.`:
      errors?`${label} cached ${done-errors}/${jobs.length} tiles (${mb} MB on device); missing tiles can be retried.`:
      `${label} ready: ${jobs.length} tiles (${mb} MB compressed) stored on this device.`;
  }finally{
    cacheWarmupController=null;cacheWarmupKind=null;updateCacheControls();
  }
}

function closeDrawer(){dom.placesDrawer.hidden=true;dom.drawerScrim.hidden=true;dom.placesBtn.setAttribute('aria-expanded','false');}
function openDrawer(){renderPlaces();dom.placesDrawer.hidden=false;dom.drawerScrim.hidden=false;dom.placesBtn.setAttribute('aria-expanded','true');}
function renderPlaces(){
  dom.placesList.replaceChildren();
  state.favorites.forEach((p,i)=>{
    const row=document.createElement('div');row.className='place-item';
    if(placeKey(p)===placeKey(state.place))row.classList.add('active');
    const choose=document.createElement('button');choose.className='choose-place';choose.textContent=p.name;
    choose.addEventListener('click',()=>{setPlace(p);closeDrawer();});
    const remove=document.createElement('button');remove.className='remove-place';remove.textContent='×';remove.title=`Remove ${p.name}`;remove.setAttribute('aria-label',`Remove ${p.name}`);
    remove.addEventListener('click',()=>{state.favorites.splice(i,1);save();renderPlaces();});
    row.append(choose,remove);dom.placesList.append(row);
  });
  const already=state.favorites.some(p=>placeKey(p)===placeKey(state.place));
  dom.savePlace.disabled=already;dom.savePlace.textContent=already?'✓ Location saved':'☆ Save current location';
}
function setPlace(place,{center=true}={}){
  if(!validPlace(place))return;
  stopPlay();fetchEpoch++;
  for(const ctrl of fetchControllers.values())ctrl.abort();fetchControllers.clear();
  state.loadingModels.clear();state.modelErrors={};state.forecasts={};state.pastForecasts={};state.forecast=null;
  state.gridSeries=null;pointSeriesEpoch++;
  state.anchor=hourFloor(Date.now()/1000);state.selectedTime=clamp(state.anchor,...Object.values(timeBounds()));
  state.place={name:place.name,latitude:clampLatitude(place.latitude),longitude:wrappedLongitude(place.longitude)};
  if(center){state.map.latitude=state.place.latitude;state.map.longitude=state.place.longitude;}
  dom.citySearch.value=state.place.name;save();refreshView();requestMap();loadModelsForView();void loadPointSeries();
}
function selectModel(model){
  if(!Object.hasOwn(MODELS,model))return;
  state.model=model;state.forecast=state.forecasts[model]||null;
  if(!pastModelAvailable())leavePast();
  dom.modelSelect.value=model;stopPlay();save();refreshView();loadModelsForView();
  if(model==='icon_eu')void loadEuWms();
}
async function loadEuWms(){
  if(state.euWms&&Date.now()/1000-state.euWms.retrievedAt<570)return state.euWms;
  if(euMetadataLoading)return euMetadataLoading;
  euMetadataLoading=(async()=>{
    try{
      const meta=await fetchIconEuCapabilities();
      state.euWms=meta;state.euWmsError=null;
      if(state.model==='icon_eu')requestMap();
      updateOverlayUI();
      return meta;
    }catch(error){
      state.euWmsError=error.message;
      if(state.model==='icon_eu'){
        showMessage('DWD ICON-EU WMS unavailable: '+error.message,true);
        updateOverlayUI();
      }
      return null;
    }finally{euMetadataLoading=null;}
  })();
  return euMetadataLoading;
}
function plotsHeading(){
  return state.view==='compare'?'ICON model comparison · shared time':
    state.mode==='radar'||state.mode==='continuous'?'Past ICON estimates + forecasts':'Forecast graphs · future model data';
}
function setView(view){
  if(!['forecast','compare'].includes(view))return;
  state.view=view;stopPlay();
  if(view==='compare')leavePast();
  if(view==='compare'&&state.mode!=='forecast')state.mode='forecast';
  dom.appRoot.classList.toggle('compare-mode',view==='compare');
  dom.viewForecast.classList.toggle('active',view==='forecast');dom.viewCompare.classList.toggle('active',view==='compare');
  dom.viewForecast.setAttribute('aria-pressed',String(view==='forecast'));
  dom.viewCompare.setAttribute('aria-pressed',String(view==='compare'));
  dom.plotsHeading.textContent=plotsHeading();
  closeDrawer();refreshView();loadModelsForView();
}
function setHorizon(hours){
  if(![48,120].includes(hours))return;
  if(state.pastModel){state.pastModel=false;state.selectedTime=state.anchor;}
  state.horizon=hours;state.selectedTime=clamp(state.selectedTime,...Object.values(timeBounds()));
  save();refreshView();
}
function setSelectedTime(time){
  const {min,max}=timeBounds();
  const step=timelineStep();const next=clamp(Math.round(time/step)*step,min,max);
  if(next===state.selectedTime)return;
  state.selectedTime=next;state.forecastIndex=state.forecast?nearestIndex(state.forecast.hourly.time,next):0;
  updateReadouts();updateTimeUI();requestCursor();requestMap();
}
function getRadarTime(){return state.radar?.frames?.[state.radarIndex]?.time??null;}
function radarWindowStart(){
  return radarHistoryStartIndex(state.radar?.frames,state.radarHours);
}
function timeList(){
  return (state.radar?.frames||[]).slice(radarWindowStart()).map(f=>f.time);
}
function setRadarIndex(index){
  if(!state.radar?.frames?.length)return;
  const next=clamp(Math.round(index),radarWindowStart(),state.radar.frames.length-1);
  if(next===state.radarIndex)return;
  state.radarIndex=next;updateReadouts();updateTimeUI();requestCursor();requestGraphs();updateOverlayUI();requestMap();
}
function setRadarHours(hours){
  if(!RADAR_WINDOWS.includes(hours))return;
  stopPlay();
  state.radarHours=hours;
  if(state.radar?.frames?.length)state.radarIndex=Math.max(state.radarIndex,radarWindowStart());
  updateTimeUI();updateReadouts();requestCursor();requestGraphs();updateOverlayUI();requestMap();save();
}
function setMode(mode){
  if(!['forecast','radar','continuous'].includes(mode))return;
  if(mode==='radar'&&state.radarUnavailable)return;
  stopPlay();state.mode=mode;
  if(mode!=='forecast')leavePast();
  if(mode==='continuous'){
    const entries=combinedFrames();state.continuousCursor=entries.findLast(f=>f.kind==='radar')||entries[0]||null;
  }
  dom.modeContinuous.classList.toggle('active',mode==='continuous');
  dom.modeContinuous.setAttribute('aria-pressed',String(mode==='continuous'));
  dom.modeForecast.classList.toggle('active',mode==='forecast');dom.modeRadar.classList.toggle('active',mode==='radar');
  dom.modeForecast.setAttribute('aria-pressed',String(mode==='forecast'));
  dom.modeRadar.setAttribute('aria-pressed',String(mode==='radar'));
  updateOverlayUI();
  dom.mapInstruction.textContent=mode==='radar'?
    'ACTUAL rainfall measurements, not predictions. Swipe for older scans · 2 fingers pan':
    mode==='continuous'?'Observed radar, then radar nowcast, then ICON-D2 model. Swipe through time · 2 fingers pan':
    'MODEL prediction, not radar. Swipe for later hours · 2 fingers pan';
  dom.plotsHeading.textContent=plotsHeading();
  renderGraphs();updateReadouts();updateTimeUI();requestCursor();requestGraphs();requestMap();buildLayerMenu();
}
/** Choose a map layer from the layer menu. ICON layers use the forecast
 * timeline; radar, nowcast and the rain sequence use their own timelines. */
function selectMapLayer(id){
  if(id==='timeline'){setMode('continuous');}
  else if(id==='radar'){if(!state.radarUnavailable)setMode('radar');}
  else if(id==='nowcast'){
    if(!state.nowcast)return;
    setMode('continuous');
    const frames=combinedFrames(),i=frames.findIndex(f=>f.kind==='nowcast');
    if(i>=0)setContinuousIndex(i);
  }else if(ICON_LAYERS.includes(id)){
    state.iconLayer=id;
    if(state.mode!=='forecast')setMode('forecast');
    // Hourly layers have no 15-minute frames: snap to the layer's own step.
    const {min,max}=timeBounds(),step=timelineStep();
    state.selectedTime=clamp(Math.round(state.selectedTime/step)*step,min,max);
    save();updateReadouts();updateTimeUI();requestCursor();requestMap();
  }
  buildLayerMenu();updateCacheControls();
}
function selectedMenuLayer(){
  if(state.mode==='radar')return 'radar';
  if(state.mode==='continuous')return combinedFrame()?.kind==='nowcast'?'nowcast':'timeline';
  return state.iconLayer;
}
function buildLayerMenu(){
  const current=selectedMenuLayer();
  const entries=[
    {group:'Observed radar & nowcast',items:[
      {id:'timeline',label:'Rain sequence: radar → nowcast → ICON-D2',note:'observed, then radar-based forecast, then model'},
      ...(state.radarUnavailable?[]:[{id:'radar',label:'Radar · observed',note:'DWD RADOLAN RY, past 2 days'}]),
      ...(state.nowcast?[{id:'nowcast',label:'Radar nowcast · next 2 h',note:'DWD RADVOR, extrapolated, not observed'}]:[]),
    ]},
  ];
  const groups=new Map();
  for(const id of ICON_LAYERS){
    if(state.icon&&!state.icon.layers[id])continue;
    const info=LAYER_INFO[id];
    if(!groups.has(info.group))groups.set(info.group,[]);
    groups.get(info.group).push({id,label:info.label,note:info.unit});
  }
  for(const [group,items] of groups)entries.push({group:'ICON-D2 model forecast · '+group,items});
  dom.layerList.replaceChildren();
  for(const section of entries){
    const fs=document.createElement('fieldset');fs.className='layer-group';
    const lg=document.createElement('legend');lg.textContent=section.group;fs.append(lg);
    for(const item of section.items){
      const label=document.createElement('label');label.className='layer-option';
      const input=document.createElement('input');input.type='radio';input.name='mapLayer';input.value=item.id;
      input.checked=item.id===current;
      input.addEventListener('change',()=>{selectMapLayer(item.id);});
      const text=document.createElement('span');text.textContent=item.label;
      const note=document.createElement('small');note.textContent=item.note;
      label.append(input,text,note);fs.append(label);
    }
    dom.layerList.append(fs);
  }
  dom.warningsToggleRow.hidden=!state.warnings;
  dom.toggleWarnings.checked=state.showWarnings;
  dom.modeRadar.hidden=state.radarUnavailable;
  dom.layersBtnLabel.textContent=current==='timeline'?'Rain sequence':current==='radar'?'Radar (observed)':
    current==='nowcast'?'Radar nowcast':LAYER_INFO[current]?.label||current;
}
function toggleLayerPanel(open=dom.layerPanel.hidden){
  dom.layerPanel.hidden=!open;dom.layersBtn.setAttribute('aria-expanded',String(open));
  if(open)buildLayerMenu();
}
/** What the map currently shows. */
function currentDisplay(){
  const cf=state.mode==='continuous'?combinedFrame():null;
  const out={forecastKind:null,iconFrame:null,layer:null,time:null,radarFrame:null,radarKind:null};
  if(state.mode==='forecast'||cf?.kind==='forecast'){
    out.time=cf?cf.time:state.selectedTime;out.layer=cf?'precip':state.iconLayer;
    if(state.model==='icon_eu'&&out.layer==='precip')out.forecastKind='eu';
    else{out.forecastKind='icon';out.iconFrame=state.icon?iconFrameAt(out.layer,out.time):null;}
  }
  if(cf?.kind==='nowcast'){out.radarKind='nowcast';out.radarFrame=nowcastFrame(state.nowcast,cf.time);}
  else if(state.radar?.frames?.length&&(state.mode==='radar'||cf?.kind==='radar'||state.mode==='forecast'&&state.showRain)){
    const f=state.radar.frames[state.radarIndex];
    out.radarKind='radar';out.radarFrame=radarFrame(state.radar,f);
  }
  return out;
}
function updateOverlayUI(){
  const d=currentDisplay();
  const visibleRain=Boolean(d.radarKind);
  dom.toggleRain.setAttribute('aria-pressed',String(state.mode==='forecast'&&state.showRain));
  dom.toggleClouds.setAttribute('aria-pressed',String(state.showClouds));
  dom.toggleRain.hidden=state.mode!=='forecast'||state.radarUnavailable||!state.radar;
  dom.toggleRain.textContent='📡 Latest observed radar (not forecast)';
  dom.toggleClouds.textContent='☁ Latest satellite (observed)';
  dom.radarCanvas.hidden=!visibleRain;
  if(!visibleRain){crossfades.radar.stop();dom.radarTransitionCanvas.hidden=true;painters.radar.reset();}
  dom.cloudTiles.hidden=!state.showClouds;
  const observations=[];
  if(state.mode==='forecast'&&state.showRain&&visibleRain)observations.push('rain radar');
  if(state.showClouds)observations.push('satellite clouds');
  const info=d.layer?LAYER_INFO[d.layer]:null;
  const icon=d.iconFrame;
  // Radar-canvas labels describe the frame actually on screen, which may
  // still be the previous scan/nowcast while the requested one loads.
  const shownRadar=d.radarKind?painters.radar.shown:null;
  const radarKind=shownRadar?.source||d.radarKind;
  const radarLoading=d.radarFrame&&(!shownRadar||shownRadar.key!==d.radarFrame.key||!painters.radar.complete);
  const loadingNote=!radarLoading?'':d.radarKind==='nowcast'?` · loading nowcast ${formatTime(d.radarFrame.time)}`:` · loading ${formatTime(d.radarFrame.time)}`;
  const iconLoading=icon&&(painters.forecast.shown?.key!==icon.key||!painters.forecast.complete);
  dom.mapLayerName.textContent=
    radarKind==='nowcast'?'RADAR NOWCAST · extrapolated, not observed':
    radarKind==='radar'&&state.mode!=='forecast'?'OBSERVED RADAR · real past · 1 km':
    d.forecastKind==='eu'?(state.euWms?'FORECAST · ICON-EU hourly rain · ~7 km':'FORECAST · ICON-EU map loading'):
    d.forecastKind==='icon'?(!state.icon?'FORECAST map unavailable':
      pastActive()?`PAST · ICON-D2 ${info.label.toLowerCase()} · earlier model run, not observed`:`FORECAST · ICON-D2 ${info.label.toLowerCase()} · model`):
    'FORECAST map unavailable';
  dom.radarAttribution.textContent=(visibleRain?' · Radar © DWD':'')+(d.forecastKind==='icon'&&state.icon?' · ICON-D2 © DWD':'')+
    (state.showClouds?' · Satellite © DWD':'')+(state.showWarnings&&state.warnings?' · Warnings © DWD':'');
  const obsNote=observations.length?' · Observations do not follow ICON time':'';
  dom.mapModelName.textContent=
    d.radarKind&&state.mode!=='forecast'&&!shownRadar?(d.radarKind==='nowcast'?'Loading radar nowcast…':'Loading observed rainfall scans…'):
    radarKind==='nowcast'?`Nowcast for ${formatTime(shownRadar.time)} · issued ${formatTime(state.nowcast?.issued)} · DWD RADVOR${loadingNote}`:
    radarKind==='radar'&&state.mode!=='forecast'?
      `Observed ${formatTime(shownRadar.time)}${radarIsStale()?' · STALE RADAR':''}${loadingNote}`:
    d.forecastKind==='icon'?(icon?`${pastActive()?'Modelled':'Predicted'} ${formatTime(icon.time)} · DWD ICON-D2 run ${formatUTC(icon.runTime)}${iconLoading?' · loading':''}`+
        (state.model!=='icon_d2'?` · charts: ${MODELS[state.model].label}`:'')+obsNote:
      state.icon?(pastActive()&&state.history?.forRun!==state.icon.runTime?'Loading past ICON-D2 runs…':
        `No ICON-D2 ${info.label.toLowerCase()} for ${formatTime(d.time)}`)+obsNote:
      state.iconError?'ICON-D2 tiles not available':'Loading ICON-D2 tiles…'):
    d.forecastKind==='eu'?(state.euWms?`Predicted ${formatTime(d.time)} · ICON-EU${obsNote}`:
      state.euWmsError?'DWD EU map unavailable':'Loading DWD EU map…'):
    `DWD ${MODELS[state.model].label}`;
  updateLegend(d);
}
function updateLegend(d){
  const shownRadar=d.radarKind?painters.radar.shown?.source:null;
  const layer=d.radarKind&&(state.mode!=='forecast')?shownRadar||d.radarKind:d.forecastKind==='icon'?d.layer:null;
  const legend=layer?legendFor(layer):null;
  dom.mapLegend.hidden=!legend;
  if(!legend)return;
  const key=layer+'|'+legend.unit;
  if(dom.mapLegend.dataset.layer===key)return;
  dom.mapLegend.dataset.layer=key;
  const title=document.createElement('div');title.className='legend-title';
  title.textContent=(layer==='radar'?'Observed rain rate':layer==='nowcast'?'Nowcast rain rate':legend.label)+' · '+legend.unit;
  const bar=document.createElement('div');bar.className='legend-bar';
  for(const item of legend.items){
    const cell=document.createElement('span');cell.style.background=item.css;cell.textContent=item.label;bar.append(cell);
  }
  const children=[title,bar];
  if(layer==='wind_direction'){
    const note=document.createElement('div');note.className='legend-note';
    note.textContent='Arrows point where the wind blows to; colour shows where it comes from.';children.push(note);
  }
  dom.mapLegend.replaceChildren(...children);
}
function toggleObservation(which){
  if(which==='rain'){
    state.showRain=!state.showRain;
    if(state.showRain&&state.radar)state.radarIndex=state.radar.frames.length-1;
  }else if(which==='clouds'){state.showClouds=!state.showClouds;cloudWarningIssued=false;}
  else return;
  updateOverlayUI();save();requestMap();
}

function applyGridForecast(){
  const series=state.gridSeries;
  if(!series)return false;
  const current=state.forecasts.icon_d2;
  // The source is ONLY a genuine Open-Meteo ICON point forecast.
  // Never interpolate from a previous grid-only fallback as if it were wind.
  const point=current?.fromRawGrid?current.rawPointForecast:(current||null);
  const combined=composeIconD2Forecast(series,point);
  state.forecasts.icon_d2=combined;
  state.modelErrors.icon_d2=combined.gridOnly?
    'Point-API extras awaiting Open-Meteo':undefined;
  if(state.model==='icon_d2'){
    state.forecast=combined;
    showMessage(combined.gridOnly?
      'DWD ICON-D2 charts ready from the map grid; loading Open-Meteo point data…':'');
  }
  return true;
}
/** ICON-D2 chart series from the tile service (same grid as the map), if the
 * run manifest publishes `series`. Otherwise the Open-Meteo point API alone. */
async function loadPointSeries(){
  const manifest=state.icon,place={...state.place},epoch=++pointSeriesEpoch;
  if(!manifest?.series){state.gridSeries=null;return;}
  try{
    const series=await downloadGridSeries(manifest,place.latitude,place.longitude);
    if(epoch!==pointSeriesEpoch)return;
    state.gridSeries=series;
    if(series)applyGridForecast();
    refreshView();
  }catch(error){
    if(epoch!==pointSeriesEpoch)return;
    state.gridSeries=null;
    if(state.model==='icon_d2'&&!state.forecasts.icon_d2)showMessage('ICON-D2 grid series: '+error.message,true);
  }
}

/* ---------- map layers ---------- */
// Keep the currently painted pixels until the replacement frame has arrived.
function prepareRasterCanvas(layer,width,height,ratio){
  const pixelWidth=Math.max(1,Math.round(width*ratio)),pixelHeight=Math.max(1,Math.round(height*ratio));
  const resized=layer.width!==pixelWidth||layer.height!==pixelHeight;
  if(resized){layer.width=pixelWidth;layer.height=pixelHeight;}
  const ctx=layer.getContext('2d');
  ctx.setTransform(ratio,0,0,ratio,0,0);
  return {ctx,resized};
}
/** One map layer canvas fed by the GPU renderer. While a new frame's tiles
 * download, the previous complete frame stays visible; at a new map view the
 * previous time is redrawn at once if its tiles cover it. */
function createPainter(canvas,crossfade){
  let shown=null,shownScene='',complete=false,wantedKey='',loadTimer=0;
  function drawFrame(ctx,frame,view,scene,resized,extra){
    const finish=crossfade.beforeDraw(frame.key,scene,{resized});
    ctx.clearRect(0,0,view.width,view.height);
    renderer.draw(ctx,frame,view);
    extra?.(ctx,frame,view);
    finish();
    shown=frame;shownScene=scene;complete=renderer.ready(frame,view);
  }
  return {
    get shown(){return shown;},
    get complete(){return complete;},
    reset(){shown=null;shownScene='';complete=false;wantedKey='';clearTimeout(loadTimer);},
    paint(frame,view,{scene,extra,onShown,onError}={}){
      const {ctx,resized}=prepareRasterCanvas(canvas,view.width,view.height,view.ratio);
      if(resized)crossfade.stop();
      if(!frame){
        crossfade.stop();ctx.clearRect(0,0,view.width,view.height);
        shown=null;shownScene='';complete=false;wantedKey='';return 'empty';
      }
      const sceneChanged=resized||scene!==shownScene;
      if(!sceneChanged&&complete&&shown?.key===frame.key)return 'same';
      if(renderer.ready(frame,view)){
        drawFrame(ctx,frame,view,scene,resized,extra);onShown?.(frame);return 'drawn';
      }
      if(sceneChanged){
        // At a new map view keep showing the previous time of the SAME layer
        // and source while the new tiles load; never another layer's pixels.
        const sameSource=shown&&shown.layer===frame.layer&&shown.source===frame.source;
        if(sameSource&&shown.key!==frame.key&&renderer.ready(shown,view)){
          const previous=shown;drawFrame(ctx,previous,view,scene,resized,extra);complete=false;shown=previous;
        }else{drawFrame(ctx,frame,view,scene,resized,extra);complete=false;}
      }
      if(wantedKey!==frame.key){
        wantedKey=frame.key;clearTimeout(loadTimer);
        // During a fast scrub only the chunk under the finger is fetched.
        loadTimer=setTimeout(()=>{
          renderer.load(frame,view).then(result=>{
            if(result.failed)onError?.(result);
            if(wantedKey===frame.key){wantedKey='';requestMap();}
          }).catch(error=>{onError?.({error});});
        },state.playing?0:70);
      }
      return 'loading';
    },
  };
}
const painters={forecast:createPainter(dom.iconCanvas,crossfades.forecast),radar:createPainter(dom.radarCanvas,crossfades.radar)};
let prefetchTimer=0;
/** Lazily warm the neighbouring chunk when the cursor nears a chunk edge. */
function schedulePrefetch(frame,view){
  clearTimeout(prefetchTimer);
  prefetchTimer=setTimeout(()=>{
    let next=null;
    if(frame.source==='icon'){
      const manifest=iconManifests().find(m=>m.run===frame.run&&m.tile===frame.tile);
      if(manifest?.history){
        // A 3-hour history slice: warm the neighbouring runs' slices (or the newest run) on both sides.
        const step=manifest.layers[frame.layer].step;
        for(const dir of [-1,1])for(let k=1;k<=4;k++){
          const t=frame.time+dir*k*step,m=chooseRun(iconManifests(),frame.layer,t),f=m&&iconFrame(m,frame.layer,t);
          if(f&&f.chunkKey!==frame.chunkKey){renderer.prefetch(f,view);break;}
        }
      }
      else if(frame.index>=frame.frames-6)next=iconAdjacentChunk(manifest,frame,1);
      else if(frame.index<=3)next=iconAdjacentChunk(manifest,frame,-1);
    }else if(frame.source==='radar'&&state.radar){
      const i=state.radar.frames.findIndex(f=>f.time===frame.time);
      for(const j of [i-6,i+6]){
        const f=state.radar.frames[j];
        if(f&&f.chunkKey!==frame.chunkKey){next=radarFrame(state.radar,f);break;}
      }
    }
    if(next)renderer.prefetch(next,view);
  },400);
}
function paintLayers(view){
  const d=currentDisplay(),generation=++forecastPaintEpoch,map={...state.map};
  const canvasSource=state.mode+'/'+(d.forecastKind||'none');
  if(forecastCanvasSource!==canvasSource){
    crossfades.forecast.stop();painters.forecast.reset();
    prepareRasterCanvas(dom.iconCanvas,view.width,view.height,view.ratio).ctx.clearRect(0,0,view.width,view.height);
    forecastCanvasSource=canvasSource;
  }
  const scene=mapViewKey('forecast',view.width,view.height,view.ratio,map,[d.forecastKind,d.layer].join(':'));
  if(d.forecastKind==='icon'){
    painters.forecast.paint(d.iconFrame,view,{scene,
      extra:d.layer==='wind_direction'?(ctx,frame,v)=>drawWindArrows(ctx,renderer,frame,v):null,
      onShown:frame=>{
        updateOverlayUI();schedulePrefetch(frame,view);
        if(state.mode==='continuous'&&combinedFrame()?.kind==='forecast')completeBoundaryTransition('forecast');
        maybeSelfCheck(frame,view);
      },
      onError:result=>{refreshAfterMissingTiles(result);if(generation===forecastPaintEpoch)showMessage('Some ICON-D2 tiles are unavailable (partial map).',true);}});
  }else if(d.forecastKind==='eu'&&state.euWms){
    painters.forecast.reset();
    const {ctx,resized}=prepareRasterCanvas(dom.iconCanvas,view.width,view.height,view.ratio);
    if(resized)crossfades.forecast.stop();
    if(iconEuValidTime(state.euWms,d.time)===null){
      crossfades.forecast.stop();ctx.clearRect(0,0,view.width,view.height);
    }else void paintIconEuWms(ctx,state.euWms,d.time,view.width,view.height,map.zoom,map,
       ()=>generation===forecastPaintEpoch,
       ()=>crossfades.forecast.beforeDraw(`icon-eu:${state.euWms.run}:${d.time}`,scene,{resized}))
       .then(painted=>{if(painted&&generation===forecastPaintEpoch&&state.mode==='continuous'&&combinedFrame()?.kind==='forecast')completeBoundaryTransition('forecast');})
       .catch(error=>{if(generation===forecastPaintEpoch)showMessage('ICON-EU WMS tiles: '+error.message,true);});
  }else{
    painters.forecast.paint(null,view);
  }
  const radarScene=mapViewKey('radar',view.width,view.height,view.ratio,map,state.mode);
  painters.radar.paint(d.radarFrame,view,{scene:radarScene,
    onShown:frame=>{
      state.displayedRadarTime=frame.time;updateOverlayUI();
      if(frame.source==='radar')schedulePrefetch(frame,view);
      if(state.mode==='continuous'&&canvasGroup(combinedFrame()?.kind)==='radar')completeBoundaryTransition('radar');
    },
    onError:result=>{refreshAfterMissingTiles(result);if(d.radarFrame)showMessage((d.radarKind==='nowcast'?'Nowcast':'Radar')+' tiles partly unavailable.',true);}});
  if(d.radarFrame&&painters.radar.shown?.key!==d.radarFrame.key)updateOverlayUI();
}
let selfCheckDone=false;
/** ?debug=codes: prove decoded codes survive the GPU path exactly. */
function maybeSelfCheck(frame,view){
  if(selfCheckDone||!params.has('debug'))return;
  selfCheckDone=true;
  const tile=visibleFrameTiles(frame,view)[0];if(!tile)return;
  void tileBlob(tile.url,'icon').then(blob=>renderer.selfCheck(blob,frame.frames,frame.index)).then(result=>{
    console.info('OpenWetter code self-check',result);
    showMessage(`Code self-check (${result.renderer}/${result.format}): ${result.ok?'exact':'MISMATCH'} · ${result.checked} pixels, ${result.mismatches} mismatches`,!result.ok);
  }).catch(error=>showMessage('Code self-check failed: '+error.message,true));
}
/* ---------- warnings overlay ---------- */
let projectedWarnings=null,warningsDrawKey='',placeWarnings=null,warningsListKey='';
function warningTime(){return state.mode==='radar'?getRadarTime()??Date.now()/1000:chartTime();}
/** Polygons are redrawn only when the view or the set of active warnings
 * changes, not on every time step of a scrub. */
function drawWarnings(view){
  const canvas=dom.warningsCanvas,show=state.showWarnings&&Boolean(state.warnings);
  canvas.hidden=!show;
  if(!show){warningsDrawKey='';return;}
  const active=activeWarnings(state.warnings,warningTime());
  const key=mapViewKey('warnings',view.width,view.height,view.ratio,state.map,state.warnings.generatedAt)+'|'+active.map(w=>w.id).join(',');
  if(key===warningsDrawKey)return;
  warningsDrawKey=key;
  const {ctx}=prepareRasterCanvas(canvas,view.width,view.height,view.ratio);
  ctx.clearRect(0,0,view.width,view.height);
  if(!active.length)return;
  projectedWarnings??=new Map();
  const world=256*2**view.zoom,c=mercator(view.latitude,view.longitude,view.zoom);
  ctx.save();ctx.lineJoin='round';
  for(const w of [...active].reverse()){
    if(!projectedWarnings.has(w.id))projectedWarnings.set(w.id,w.areas.flatMap(a=>a.polygons.map(r=>
      r.map(([lon,lat])=>{const p=mercator(lat,lon,0);return [p.x/256,p.y/256];}))));
    const [r,g,b]=w.color;
    ctx.beginPath();
    for(const ring of projectedWarnings.get(w.id)){
      ring.forEach(([x,y],i)=>{const sx=view.width/2+x*world-c.x,sy=view.height/2+y*world-c.y;i?ctx.lineTo(sx,sy):ctx.moveTo(sx,sy);});
      ctx.closePath();
    }
    ctx.fillStyle=`rgba(${r},${g},${b},.2)`;ctx.fill('evenodd');
    ctx.strokeStyle=`rgba(${r},${g},${b},.9)`;ctx.lineWidth=1.4;ctx.stroke();
  }
  ctx.restore();
}
function renderWarningsList(){
  const list=dom.warningsList;
  if(!state.warnings){list.hidden=true;warningsListKey='';return;}
  // Point-in-polygon once per place and warnings index; per time step only the
  // validity window is checked.
  const placeId=placeKey(state.place)+'|'+state.warnings.generatedAt;
  if(placeWarnings?.id!==placeId)placeWarnings={id:placeId,
    list:warningsCovering(state.warnings,state.place.latitude,state.place.longitude)};
  const time=warningTime();
  const here=activeWarnings({warnings:placeWarnings.list},time);
  const key=placeId+'|'+here.map(w=>w.id).join(',');
  if(key===warningsListKey)return;
  warningsListKey=key;
  list.hidden=!here.length;
  if(!here.length){list.replaceChildren();return;}
  const items=here.map(w=>{
    const item=document.createElement('details');item.className='warning-item severity-'+w.severity.toLowerCase();
    item.style.setProperty('--warning-color',`rgb(${w.color.join(',')})`);
    const summary=document.createElement('summary');
    const from=Number.isFinite(w.onset)?formatTime(w.onset):'now',until=Number.isFinite(w.expires)?formatTime(w.expires):'further notice';
    summary.textContent=`⚠ ${w.headline.en||w.headline.de||w.event} · ${from} – ${until}`;
    const body=document.createElement('p');body.textContent=[w.description.en||w.description.de,w.instruction.en||w.instruction.de].filter(Boolean).join(' ');
    const src=document.createElement('small');src.textContent=`Official DWD warning · ${w.severity}`;
    item.append(summary,body,src);return item;
  });
  list.replaceChildren(...items);
}
function stopPlay(){if(playTimer)clearInterval(playTimer);playTimer=null;state.playing=false;dom.playBtn.textContent='▶';dom.playBtn.setAttribute('aria-label','Play weather timeline');}
function play(){
  if(state.playing){stopPlay();return;}
  if(state.mode==='radar'&&!timeList().length)return;
  if(state.mode==='continuous'&&!combinedFrames().length)return;
  state.playing=true;dom.playBtn.textContent='Ⅱ';dom.playBtn.setAttribute('aria-label','Pause weather timeline');
  playTimer=setInterval(()=>{
    if(state.mode==='radar'){
      if(state.radarIndex>=state.radar.frames.length-1){stopPlay();return;}
      setRadarIndex(state.radarIndex+1);
    }else if(state.mode==='continuous'){
      const frames=combinedFrames(),i=continuousCursorIndex(frames,state.continuousCursor);
      if(i>=frames.length-1){stopPlay();return;}setContinuousIndex(i+1);
    }else{
      if(state.selectedTime>=timeBounds().max){stopPlay();return;}
      setSelectedTime(state.selectedTime+timelineStep());
    }
  },state.mode==='radar'?700:state.mode==='continuous'?550:350);
}
const radarWindowLabel=h=>h===48?'2 days':h+'h';
function updateTimeUI(){
  const radarMode=state.mode==='radar',continuous=state.mode==='continuous';
  dom.forecastHorizonButtons.hidden=radarMode;
  dom.radarHistoryButtons.hidden=(!radarMode&&!continuous)||state.radarUnavailable;
  dom.modeForecast.textContent='◈ Forecast · future';
  dom.modeRadar.textContent=`◉ Radar · past ${radarWindowLabel(state.radarHours)}`;
  for(const h of RADAR_WINDOWS){
    const b=dom['radarHours'+h];b.classList.toggle('active',state.radarHours===h);b.setAttribute('aria-pressed',String(state.radarHours===h));
  }
  if(!state.playing)dom.playBtn.setAttribute('aria-label',radarMode?'Play observed radar history':pastActive()?'Play past model runs':'Play future forecast');
  dom.horizonPast.hidden=!pastModelAvailable();
  if(continuous){
    const frames=combinedFrames(),i=continuousCursorIndex(frames,state.continuousCursor),frame=frames[i];
    dom.timeSlider.min='0';dom.timeSlider.max=String(Math.max(1,frames.length-1));dom.timeSlider.value=String(Math.max(i,0));dom.timeSlider.step='1';dom.timeSlider.disabled=!frames.length;
    dom.timeSlider.setAttribute('aria-label','Observed radar, then radar nowcast, then model forecast');dom.timeLabel.textContent=frame?formatTime(frame.time):'Loading…';
    dom.startLabel.textContent=frames.length?formatTime(frames[0].time):'—';dom.endLabel.textContent=frames.length?formatTime(frames.at(-1).time):'—';
    dom.timeRange.textContent=frame?.kind==='radar'?'OBSERVED RADAR · then nowcast and ICON':
      frame?.kind==='nowcast'?'RADAR NOWCAST · extrapolated from radar, not observed':'ICON FORECAST · model prediction';
  }else if(radarMode){
    const times=timeList(),has=times.length>0;
    const firstIndex=radarWindowStart();
    dom.timeSlider.min=String(firstIndex);
    dom.timeSlider.max=String(has?state.radar.frames.length-1:firstIndex+1);
    dom.timeSlider.value=String(state.radarIndex);
    dom.timeSlider.step='1';
    dom.timeSlider.disabled=!has;
    dom.timeSlider.setAttribute('aria-label',`Observed radar time, past ${radarWindowLabel(state.radarHours)}`);
    dom.timeLabel.textContent=has?formatTime(getRadarTime()):'Loading observed radar…';
    dom.startLabel.textContent=has?formatTime(times[0]):'—';
    dom.endLabel.textContent=has?formatTime(times.at(-1)):'—';
    const durationMinutes=has?Math.round((times.at(-1)-times[0])/60):0;
    const actual=durationMinutes>=60?
      `${Math.floor(durationMinutes/60)}h${durationMinutes%60?' '+durationMinutes%60+'m':''}`:
      `${durationMinutes}m`;
    dom.timeRange.textContent=has?
      `OBSERVED RADAR · past ${actual} · 5-min scans`:
      `OBSERVED RADAR · loading ${radarWindowLabel(state.radarHours)} history`;
  }else{
    const b=timeBounds(),step=timelineStep();
    dom.timeSlider.min='0';
    dom.timeSlider.max=String(Math.max(1,Math.floor((b.max-b.min)/step)));
    dom.timeSlider.value=String(Math.round((state.selectedTime-b.min)/step));
    dom.timeSlider.step='1';
    dom.timeSlider.disabled=false;
    dom.timeSlider.setAttribute('aria-label',pastActive()?'Past model time, earlier ICON-D2 runs (not radar)':'Future model forecast time (not radar)');
    dom.timeLabel.textContent=formatTime(state.selectedTime);
    dom.startLabel.textContent=formatTime(b.min,{weekday:'short',hour:'2-digit'});
    dom.endLabel.textContent=formatTime(b.max,{weekday:'short',hour:'2-digit'});
    const spec=iconLayerSpec(state.iconLayer);
    dom.timeRange.textContent=pastActive()&&spec?`PAST · earlier ICON-D2 runs · ${LAYER_INFO[state.iconLayer].label.toLowerCase()} · model, not observed`:
      state.model==='icon_eu'&&state.iconLayer==='precip'?'FUTURE FORECAST · ICON-EU · hourly rain':
      spec?`FUTURE FORECAST · ICON-D2 · ${LAYER_INFO[state.iconLayer].label.toLowerCase()} · ${spec.step===900?'15-min':'hourly'}`:
      `FUTURE FORECAST · ICON · ${state.horizon===48?'48h':'5 days'}`;
  }
}
function updateReadouts(){
  const f=state.forecasts[state.model]||null;
  state.forecast=f;
  state.forecastIndex=f?nearestIndex(f.hourly.time,state.selectedTime):0;
  const temp=metricValue(state.model,'temperature');
  dom.heroTemp.textContent=temp==null?'—°':`${fmt(temp,'temperature')}°`;
  dom.heroTime.textContent=formatTime(chartTime())+(chartTime()<Date.now()/1000?' · ICON estimate':'');
  dom.quickRain.textContent=`${fmt(metricValue(state.model,'precipitation'),'precipitation')} mm`;
  dom.quickWind.textContent=`${fmt(metricValue(state.model,'wind'),'wind')} km/h`;
  dom.quickCloud.textContent=`${fmt(metricValue(state.model,'cloud'),'cloud')}%`;
  dom.pinTemp.textContent=temp==null?'—':`${fmt(temp,'temperature')}°`;
  updateOverlayUI();renderWarningsList();
  if(state.warnings&&state.showWarnings)requestMap();
  for(const row of dom.graphStack.querySelectorAll('[data-model][data-metric]')){
    const output=row.querySelector('.plot-value');if(!output)continue;
    const metric=row.dataset.metric, model=row.dataset.model;
    const v=metricValue(model,metric);
    output.textContent=v==null?'—':`${fmt(v,metric)} ${VARIABLES[metric].unit}`;
  }
  for(const row of dom.graphStack.querySelectorAll('[data-compare-values]')){
    const model=row.dataset.compareValues;
    const val=metricValue(model,'temperature'),rain=metricValue(model,'precipitation'),cloud=metricValue(model,'cloud');
    row.textContent=[`${fmt(val,'temperature')}°C`,`${fmt(rain,'precipitation')} mm`,`${fmt(cloud,'cloud')}%`].join(' · ');
  }
}
function refreshView(){
  dom.locationName.textContent=state.place.name;
  dom.headerPlace.textContent=shortPlace(state.place.name);
  dom.modelDescription.textContent=`${MODELS[state.model].label} · ${MODELS[state.model].subtitle}`+
    (state.forecasts[state.model]?.fromRawGrid?' · chart values from the DWD map grid':'');
  dom.modelSelect.value=state.model;
  const past=pastActive();
  dom.horizonPast.hidden=!pastModelAvailable();
  dom.horizonPast.classList.toggle('active',past);dom.horizonPast.setAttribute('aria-pressed',String(past));
  dom.horizon48.classList.toggle('active',!past&&state.horizon===48);
  dom.horizon120.classList.toggle('active',!past&&state.horizon===120);
  dom.horizon48.setAttribute('aria-pressed',String(!past&&state.horizon===48));
  dom.horizon120.setAttribute('aria-pressed',String(!past&&state.horizon===120));
  updateCacheControls();
  renderGraphs();updateReadouts();updateTimeUI();requestGraphs();requestMap();
}

function createPlotBody(model,metric){
  const body=document.createElement('div');body.className='plot-body';
  body.dataset.model=model;body.dataset.metric=metric;
  const canvas=document.createElement('canvas');canvas.setAttribute('aria-label',`${MODELS[model].label} ${metric==='composite'?'precipitation, temperature, and clouds':VARIABLES[metric].name} graph`);
  const line=document.createElement('div');line.className='plot-cursor';line.setAttribute('aria-hidden','true');
  body.append(canvas,line);
  return body;
}
function renderGraphs(){
  dom.graphStack.replaceChildren();
  if(state.view==='compare'){
    for(const model of MODEL_IDS){
      const outer=document.createElement('article');outer.className='compare-row';outer.dataset.comparison=model;
      const heading=document.createElement('div');heading.className='compare-head';
      const name=document.createElement('strong');name.textContent=`DWD ${MODELS[model].label}`;
      const summary=document.createElement('span');summary.className='compare-values';summary.dataset.compareValues=model;
      heading.append(name,summary);
      const plot=createPlotBody(model,'composite');
      const key=document.createElement('div');key.className='compare-key';key.innerHTML='<span class="key-rain">▰ Rain</span><span class="key-temp">━ Temperature</span><span class="key-cloud">▧ Clouds</span>';
      outer.append(heading,plot,key);
      if(state.modelErrors[model]){const error=document.createElement('div');error.className='plot-no-data';error.textContent=state.modelErrors[model];plot.append(error);}
      else if(!state.forecasts[model]){const busy=document.createElement('div');busy.className='plot-no-data';busy.textContent='Loading model forecast…';plot.append(busy);}
      dom.graphStack.append(outer);
    }
  }else{
    for(const metric of ['cloud','precipitation','temperature','wind']){
      const row=document.createElement('article');row.className='plot-row';row.dataset.model=state.model;row.dataset.metric=metric;
      const label=document.createElement('div');label.className='plot-label';
      const name=document.createElement('strong');name.textContent=VARIABLES[metric].name;
      const details=document.createElement('small');details.textContent=VARIABLES[metric].unit+(state.mode!=='forecast'?' · past: ICON model':'');
      label.append(name,details);
      const val=document.createElement('span');val.className='plot-value';
      const plot=createPlotBody(state.model,metric);
      row.append(label,plot,val);dom.graphStack.append(row);
    }
  }
  requestCursor();requestGraphs();
}
function plotAreaData(f,metric,min,max){
  if(!f)return [];
  const key=VARIABLES[metric].key;
  return f.hourly.time.map((t,i)=>({t,v:f.hourly[key][i]})).filter(({t})=>t>=min&&t<=max);
}
function drawGraphs(){
  for(const body of dom.graphStack.querySelectorAll('.plot-body')){
    const canvas=body.querySelector('canvas'),r=body.getBoundingClientRect();
    if(r.width<12||r.height<12)continue;
    const dpr=Math.min(window.devicePixelRatio||1,2);
    canvas.width=Math.round(r.width*dpr);canvas.height=Math.round(r.height*dpr);
    const ctx=canvas.getContext('2d');ctx.scale(dpr,dpr);
    const w=r.width,h=r.height,plotH=h-15;
    ctx.clearRect(0,0,w,h);
    const model=body.dataset.model,metric=body.dataset.metric;
    const f=state.forecasts[model],history=state.pastForecasts[model],{min,max}=chartBounds();
    const x=t=>timelinePosition(t,min,max)*w;
    const now=Date.now()/1000,hasPast=min<now;
    if(hasPast){
      ctx.fillStyle='#33536b45';ctx.fillRect(0,0,x(now),plotH);
    }
    for(let i=0;i<=state.horizon;i+=24){
      const x0=x(min+i*3600),x1=x(Math.min(max,min+(i+24)*3600));
      if((i/24)%2===1){ctx.fillStyle='#1a324b';ctx.fillRect(x0,0,x1-x0,plotH);}
    }
    ctx.strokeStyle='#35516a';ctx.lineWidth=.65;
    for(let j=1;j<=3;j++){const y=plotH*j/4;ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(w,y);ctx.stroke();}
    const tick=state.horizon===48&&max-min<=72*3600?12:24;
    for(let hours=0;hours<=state.horizon;hours+=tick){
      const t=state.anchor+hours*3600,xx=x(t);
      // x() clamps to the plot; skip ticks outside the window and the one under the start label.
      if(t<min||t>max||hasPast&&xx<34)continue;
      ctx.strokeStyle='#48637c66';ctx.beginPath();ctx.moveTo(xx,0);ctx.lineTo(xx,plotH);ctx.stroke();
      ctx.textAlign=hours===0?'left':hours===state.horizon?'right':'center';
      ctx.fillStyle='#a3bad3';ctx.font='10px system-ui';
      ctx.fillText(formatTime(t,{weekday:'short',hour:'2-digit'}),xx,h-3);
    }
    if(hasPast){
      ctx.strokeStyle='#a7d8f0';ctx.lineWidth=1.25;ctx.setLineDash([3,2]);ctx.beginPath();
      ctx.moveTo(x(now),0);ctx.lineTo(x(now),plotH);ctx.stroke();ctx.setLineDash([]);
      ctx.fillStyle='#c8d8e7';ctx.font='9px system-ui';ctx.textAlign='left';
      ctx.fillText('PAST · ICON estimate',5,10);
      ctx.textAlign='right';ctx.fillText('FORECAST',w-5,10);
      ctx.textAlign='left';ctx.fillText(formatTime(min,{hour:'2-digit',minute:'2-digit'}),0,h-3);
    }
    if(!f&&!history)continue;
    const plot=(variable,{opacity=1,lineWidth=1.7,fill=false}={})=>{
      const series=chartSeries(f,hasPast?history:null,VARIABLES[variable].key,min,max,now);
      const valid=[...series.past,...series.future].map(d=>d.v).filter(Number.isFinite);
      const {min:ymin,max:ymax}=axisLimits(valid,variable);
      const scale=v=>plotH-3-((v-ymin)/(ymax-ymin))*(plotH-9);
      const color=VARIABLES[variable].color;
      const renderSegment=(dataset,historical)=>{
        if(!dataset.length)return;
        if(VARIABLES[variable].chart==='bar'){
          const barWidth=Math.max(1.5,Math.min(13,w*3600/(max-min)*.8));
          ctx.fillStyle=color;ctx.globalAlpha=opacity*(historical ? 0.46 : 1);
          // Each value is the total of the hour ending at t (a rolling sum on the
          // 15-minute ICON-D2 axis), so only full hours get an hour-wide bar;
          // otherwise one shower would be drawn as four overlapping bars.
          for(const {t,v}of dataset)if(Number.isFinite(v)&&v>0&&t%3600===0){
            const xx=x(t);ctx.fillRect(xx-barWidth/2,scale(v),barWidth,Math.max(1,scale(0)-scale(v)));
          }
        }else{
          ctx.beginPath();let drawing=false,firstX=null,lastX=null;
          for(const {t,v}of dataset){
            if(!Number.isFinite(v)){drawing=false;continue;}
            const xx=x(t),yy=scale(v);
            if(!drawing){ctx.moveTo(xx,yy);drawing=true;if(firstX===null)firstX=xx;}
            else ctx.lineTo(xx,yy);
            lastX=xx;
          }
          if(fill&&firstX!==null&&lastX!==null){
            ctx.lineTo(lastX,plotH);ctx.lineTo(firstX,plotH);ctx.closePath();
            ctx.fillStyle=color;ctx.globalAlpha=.13*opacity*(historical ? 0.6 : 1);ctx.fill();
          }
          ctx.strokeStyle=color;ctx.globalAlpha=opacity*(historical ? 0.65 : 1);
          ctx.lineWidth=lineWidth;ctx.lineJoin='round';
          ctx.setLineDash(historical?[4,3]:[]);ctx.stroke();ctx.setLineDash([]);
        }
        ctx.globalAlpha=1;
      };
      renderSegment(series.past,true);
      renderSegment(series.future,false);
    };
    if(metric==='composite'){
      plot('cloud',{opacity:.52,fill:true,lineWidth:1});
      plot('precipitation',{opacity:.78});
      plot('temperature',{lineWidth:2.1});
    }else plot(metric,{fill:metric==='cloud'});
    if(f?.hourly?.time?.length&&f.hourly.time.at(-1)<max-1800){
      ctx.fillStyle='#9ebbd044';ctx.fillRect(x(f.hourly.time.at(-1))+2,0,w-x(f.hourly.time.at(-1)),plotH);
    }
  }
  updateCursor();
}
function updateCursor(){
  const {min,max}=chartBounds();
  const t=chartTime(),percentage=timelinePosition(t,min,max)*100,outside=t<min||t>max;
  for(const cursor of dom.graphStack.querySelectorAll('.plot-cursor')){cursor.style.left=`${percentage}%`;cursor.style.visibility=outside?'hidden':'';}
}
function timeFromGraphPointer(event,body){
  const r=body.getBoundingClientRect();
  stopPlay();const b=chartBounds(),time=b.min+clamp((event.clientX-r.left)/r.width,0,1)*(b.max-b.min);
  if(state.mode==='continuous'){
    const frames=combinedFrames();if(frames.length)setContinuousIndex(nearestIndex(frames.map(f=>f.time),time));
  }else if(state.mode==='radar'){
    if(time<Date.now()/1000||time<=state.radar?.frames?.at(-1)?.time){
      const times=timeList();if(times.length)setRadarIndex(radarWindowStart()+nearestIndex(times,time));
    }else{
      setMode('continuous');const frames=combinedFrames();
      if(frames.length)setContinuousIndex(nearestIndex(frames.map(f=>f.time),time));
    }
  }else{if(pastActive())setPastModel(false);setSelectedTime(time);}
}
function tileLayer(element,items){
  const existing=new Map([...element.children].map(n=>[n.dataset.key,n]));const keys=new Set();
  for(const t of items){
    keys.add(t.key);let img=existing.get(t.key);
    if(!img){
      img=document.createElement('img');img.dataset.key=t.key;img.src=t.url;img.alt='';img.draggable=false;img.decoding='async';
      img.addEventListener('error',()=>{
        img.style.opacity=0;
        if(element===dom.cloudTiles && state.showClouds && !cloudWarningIssued){
          cloudWarningIssued=true;showMessage('DWD satellite image unavailable; try again later.',true);
        }
      });element.append(img);
    }
    img.style.width=`${t.size}px`;img.style.height=`${t.size}px`;
    img.style.left=`${t.left}px`;img.style.top=`${t.top}px`;
  }
  for(const [key,node]of existing)if(!keys.has(key))node.remove();
}
function renderMap(){
  if(state.view==='compare')return;
  const r=dom.map.getBoundingClientRect();if(r.width<5||r.height<5)return;
  const z=state.map.zoom,point=mercator(state.map.latitude,state.map.longitude,z),
    topLeft={x:point.x-r.width/2,y:point.y-r.height/2},maxTile=2**z;
  const tiles=[];
  const minx=Math.floor(topLeft.x/256),maxx=Math.floor((topLeft.x+r.width)/256),
    miny=Math.max(0,Math.floor(topLeft.y/256)),maxy=Math.min(maxTile-1,Math.floor((topLeft.y+r.height)/256));
  for(let x=minx;x<=maxx;x++)for(let y=miny;y<=maxy;y++){
    const xx=((x%maxTile)+maxTile)%maxTile;
    tiles.push({key:`${z}/${xx}/${y}`,url:`https://tile.openstreetmap.org/${z}/${xx}/${y}.png`,size:256,left:x*256-topLeft.x,top:y*256-topLeft.y});
  }
  tileLayer(dom.baseTiles,tiles);
  const view=mapView();
  try{paintLayers(view);}catch(e){showMessage('Raster render error: '+e.message,true);}
  try{drawWarnings(view);}catch(e){dom.warningsCanvas.hidden=true;}
  // DWD Meteosat imagery is the most recent observed scene, not a future cloud forecast.
  if(state.showClouds){
    const satZoom=Math.min(z,9),scale=2**(z-satZoom),tileSize=256*scale,limit=2**satZoom;
    const clouds=[];
    const x0=Math.floor(topLeft.x/tileSize),x1=Math.floor((topLeft.x+r.width)/tileSize),
      y0=Math.max(0,Math.floor(topLeft.y/tileSize)),y1=Math.min(limit-1,Math.floor((topLeft.y+r.height)/tileSize));
    for(let x=x0;x<=x1;x++)for(let y=y0;y<=y1;y++){
      const xx=((x%limit)+limit)%limit;
      clouds.push({key:`${satZoom}/${xx}/${y}`,url:dwdWmsTileURL(DWD_SATELLITE_CLOUDS,satZoom,x,y),
        size:tileSize,left:x*tileSize-topLeft.x,top:y*tileSize-topLeft.y});
    }
    tileLayer(dom.cloudTiles,clouds);
  }else dom.cloudTiles.replaceChildren();
  const pin=mercator(state.place.latitude,state.place.longitude,z),world=256*2**z;
  let dx=pin.x-point.x;if(dx>world/2)dx-=world;if(dx< -world/2)dx+=world;
  const x=r.width/2+dx,y=r.height/2+(pin.y-point.y);
  dom.mapPin.style.left=`${x}px`;dom.mapPin.style.top=`${y}px`;
  dom.mapPin.hidden=x< -50||x>r.width+50||y< -50||y>r.height+50;
}
function pan(dx,dy){
  const p=mercator(state.map.latitude,state.map.longitude,state.map.zoom),result=unmercator(p.x-dx,p.y-dy,state.map.zoom);
  state.map.latitude=clampLatitude(result.lat);state.map.longitude=wrappedLongitude(result.lon);requestMap();
}
function zoom(delta){state.map.zoom=clamp(state.map.zoom+delta,3,12);requestMap();}
function radarSwipeTimestamp(startTime,dx,dy,axis){
  const speeds={horizontalHours:state.horizontalHours/12,verticalHours:state.verticalHours/12,stepSeconds:300,
    minSeconds:timeList()[0]??0,maxSeconds:timeList().at(-1)??0};
  return scrubTimestamp(startTime,dx,dy,axis,speeds);
}
function wireMapGestures(){
  dom.map.addEventListener('wheel',event=>{event.preventDefault();zoom(event.deltaY<0?1:-1);},{passive:false});
  dom.map.addEventListener('pointerdown',event=>{
    if(event.target.closest('button,a,input,select'))return;
    dom.map.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId,{x:event.clientX,y:event.clientY});
    if(pointers.size===1)drag={startX:event.clientX,startY:event.clientY,lastX:event.clientX,lastY:event.clientY,
      startTime:state.mode==='radar'?getRadarTime():state.selectedTime,startContinuousIndex:state.mode==='continuous'?continuousCursorIndex(combinedFrames(),state.continuousCursor):null,axis:null,wasMulti:false,mouse:event.pointerType==='mouse'};
    else if(pointers.size===2){
      const [a,b]=[...pointers.values()];drag={wasMulti:true,midX:(a.x+b.x)/2,midY:(a.y+b.y)/2,dist:Math.hypot(a.x-b.x,a.y-b.y)};
    }
  });
  dom.map.addEventListener('pointermove',event=>{
    if(!pointers.has(event.pointerId)||!drag)return;
    pointers.set(event.pointerId,{x:event.clientX,y:event.clientY});
    if(pointers.size===2){
      const [a,b]=[...pointers.values()],midX=(a.x+b.x)/2,midY=(a.y+b.y)/2,dist=Math.hypot(a.x-b.x,a.y-b.y);
      pan(midX-drag.midX,midY-drag.midY);
      if(dist>drag.dist*1.45){zoom(1);drag.dist=dist;}
      else if(dist<drag.dist/1.45){zoom(-1);drag.dist=dist;}
      drag.midX=midX;drag.midY=midY;
    }else if(pointers.size===1){
      const dx=event.clientX-drag.startX,dy=event.clientY-drag.startY;
      if(drag.mouse&&!event.shiftKey){pan(event.clientX-drag.lastX,event.clientY-drag.lastY);}
      else if(drag.startTime!=null){
        drag.axis??=pickGestureAxis(dx,dy);
        if(drag.axis){
          stopPlay();
          if(state.mode==='continuous'){
            const direction=drag.axis==='vertical'?-dy:dx;
            const speed=drag.axis==='vertical'?state.verticalHours:state.horizontalHours;
            const step=Math.round(direction*speed/100*4);
            setContinuousIndex(drag.startContinuousIndex+step);
          }else if(state.mode==='radar'){
            const t=radarSwipeTimestamp(drag.startTime,dx,dy,drag.axis);
            setRadarIndex(nearestIndex(timeList(),t));
          }else{
            const bound=timeBounds();
            const t=scrubTimestamp(drag.startTime,dx,dy,drag.axis,{
              horizontalHours:state.horizontalHours,verticalHours:state.verticalHours,
              minSeconds:bound.min,maxSeconds:bound.max,stepSeconds:timelineStep(),
            });
            setSelectedTime(t);
          }
        }
      }
      drag.lastX=event.clientX;drag.lastY=event.clientY;
    }
  });
  const pointerEnd=event=>{
    if(!pointers.has(event.pointerId))return;
    if(pointers.size===1&&drag&&!drag.wasMulti&&!drag.axis&&Math.hypot(event.clientX-drag.startX,event.clientY-drag.startY)<7){
      const rect=dom.map.getBoundingClientRect();
      const m=mercator(state.map.latitude,state.map.longitude,state.map.zoom);
      const p=unmercator(m.x+(event.clientX-rect.left-rect.width/2),m.y+(event.clientY-rect.top-rect.height/2),state.map.zoom);
      setPlace({name:'Selected map point',latitude:p.lat,longitude:p.lon},{center:false});
    }
    pointers.delete(event.pointerId);
    if(pointers.size<2)drag=null;
  };
  dom.map.addEventListener('pointerup',pointerEnd);dom.map.addEventListener('pointercancel',pointerEnd);
}
function wire(){
  dom.viewForecast.addEventListener('click',()=>setView('forecast'));
  dom.viewCompare.addEventListener('click',()=>setView('compare'));
  dom.modelSelect.addEventListener('change',event=>selectModel(event.target.value));
  dom.horizonPast.addEventListener('click',()=>setPastModel(!state.pastModel));
  dom.horizon48.addEventListener('click',()=>setHorizon(48));
  dom.horizon120.addEventListener('click',()=>setHorizon(120));
  for(const h of RADAR_WINDOWS)dom['radarHours'+h].addEventListener('click',()=>setRadarHours(h));
  dom.timeSlider.addEventListener('input',event=>{stopPlay();
    if(state.mode==='continuous')setContinuousIndex(Number(event.target.value));
    else if(state.mode==='radar')setRadarIndex(Number(event.target.value));
    else setSelectedTime(timeBounds().min+Number(event.target.value)*timelineStep());
  });
  dom.playBtn.addEventListener('click',play);
  dom.modeContinuous.addEventListener('click',()=>setMode('continuous'));
  dom.modeForecast.addEventListener('click',()=>setMode('forecast'));
  dom.modeRadar.addEventListener('click',()=>setMode('radar'));
  dom.toggleRain.addEventListener('click',()=>toggleObservation('rain'));
  dom.toggleClouds.addEventListener('click',()=>toggleObservation('clouds'));
  dom.layersBtn.addEventListener('click',()=>toggleLayerPanel());
  dom.closeLayers.addEventListener('click',()=>toggleLayerPanel(false));
  dom.toggleWarnings.addEventListener('change',event=>{state.showWarnings=event.target.checked;warningsDrawKey='';save();updateOverlayUI();requestMap();});
  for(const node of [dom.layerPanel,dom.mapLegend])node.addEventListener('pointerdown',event=>event.stopPropagation());
  dom.zoomIn.addEventListener('click',()=>zoom(1));dom.zoomOut.addEventListener('click',()=>zoom(-1));
  dom.resetView.addEventListener('click',()=>{state.map.latitude=state.place.latitude;state.map.longitude=state.place.longitude;requestMap();});
  dom.cacheRadarBtn.addEventListener('click',()=>{void preloadWeatherCache('radar');});
  dom.cacheForecastBtn.addEventListener('click',()=>{void preloadWeatherCache('icon');});
  dom.settingsBtn.addEventListener('click',()=>{
    dom.settingsPanel.hidden=!dom.settingsPanel.hidden;
    dom.settingsBtn.setAttribute('aria-expanded',String(!dom.settingsPanel.hidden));
  });
  dom.horizontalSpeed.addEventListener('input',event=>{
    state.horizontalHours=Number(event.target.value);dom.horizontalOutput.textContent=`${state.horizontalHours} h / 100 px`;save();
  });
  dom.verticalSpeed.addEventListener('input',event=>{
    state.verticalHours=Number(event.target.value);dom.verticalOutput.textContent=`${state.verticalHours} h / 100 px`;save();
  });
  dom.cloudOpacitySlider.addEventListener('input',event=>{
    state.cloudOpacity=Number(event.target.value)/100;dom.cloudTiles.style.opacity=String(state.cloudOpacity);
    dom.cloudOpacityOutput.textContent=`${Math.round(state.cloudOpacity*100)}%`;save();
  });
  dom.smoothFrames.addEventListener('change',event=>{
    state.smoothFrames=event.target.checked;
    if(!state.smoothFrames){crossfades.forecast.stop({forget:false});crossfades.radar.stop({forget:false});}
    save();
  });
  dom.opacitySlider.addEventListener('input',event=>{
    state.radarOpacity=Number(event.target.value)/100;
    crossfades.radar.updateOpacity();
    dom.opacityOutput.textContent=`${Math.round(state.radarOpacity*100)}%`;save();
  });
  dom.graphStack.addEventListener('pointerdown',event=>{
    const body=event.target.closest('.plot-body');if(!body)return;
    body.setPointerCapture(event.pointerId);
    timeFromGraphPointer(event,body);
  });
  dom.graphStack.addEventListener('pointermove',event=>{
    const body=event.target.closest('.plot-body');
    if(body&&(event.buttons||event.pressure>0))timeFromGraphPointer(event,body);
  });
  dom.searchForm.addEventListener('submit',async event=>{
    event.preventDefault();const query=dom.citySearch.value.trim();if(!query)return;
    showMessage('Searching for location…');
    try{
      const response=await getJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=1&language=en&format=json`,null,12000);
      const p=response.results?.[0];if(!p)throw new Error('No matching place');
      const name=[p.name,p.admin1,p.country].filter((x,i,a)=>x&&a.indexOf(x)===i).join(', ');
      setPlace({name,latitude:p.latitude,longitude:p.longitude});
    }catch(error){showMessage(`Location search: ${error.message}`,true);}
  });
  dom.locateBtn.addEventListener('click',()=>{
    if(!navigator.geolocation){showMessage('Location services not available.',true);return;}
    showMessage('Requesting location permission…');
    navigator.geolocation.getCurrentPosition(p=>setPlace({name:'My location',latitude:p.coords.latitude,longitude:p.coords.longitude}),
      e=>showMessage(`Location error: ${e.message}`,true),{timeout:12000,maximumAge:60000});
  });
  dom.placesBtn.addEventListener('click',()=>dom.placesDrawer.hidden?openDrawer():closeDrawer());
  dom.closePlaces.addEventListener('click',closeDrawer);dom.drawerScrim.addEventListener('click',closeDrawer);
  dom.savePlace.addEventListener('click',()=>{
    if(state.favorites.some(p=>placeKey(p)===placeKey(state.place)))return;
    state.favorites.push({...state.place});state.favorites=state.favorites.slice(-20);save();renderPlaces();
  });
  window.addEventListener('keydown',event=>{
    if(event.key==='Escape'){closeDrawer();toggleLayerPanel(false);dom.settingsPanel.hidden=true;dom.settingsBtn.setAttribute('aria-expanded','false');}
    if(event.target.matches('input,button,select,textarea'))return;
    if(event.key==='ArrowRight'){stopPlay();state.mode==='continuous'?setContinuousIndex(continuousCursorIndex(combinedFrames(),state.continuousCursor)+1):state.mode==='radar'?setRadarIndex(state.radarIndex+1):setSelectedTime(state.selectedTime+timelineStep());}
    if(event.key==='ArrowLeft'){stopPlay();state.mode==='continuous'?setContinuousIndex(continuousCursorIndex(combinedFrames(),state.continuousCursor)-1):state.mode==='radar'?setRadarIndex(state.radarIndex-1):setSelectedTime(state.selectedTime-timelineStep());}
  });
  window.addEventListener('resize',()=>{requestGraphs();requestMap();});
  if('ResizeObserver' in window)new ResizeObserver(()=>{requestGraphs();requestMap();}).observe(dom.graphStack);
  document.addEventListener('visibilitychange',()=>{if(document.hidden)stopPlay();else refreshPointers();});
  wireMapGestures();
}
/** Test/debug helper: decoded value of the displayed layer at a point. */
async function sampleAt(latitude,longitude){
  const d=currentDisplay(),frame=d.iconFrame||d.radarFrame;
  if(!frame)return null;
  const view={latitude,longitude,zoom:12,width:8,height:8,ratio:1};
  await renderer.load(frame,view);
  const code=renderer.sampleAt(frame,latitude,longitude);
  return {code,value:decodeCode(frame.layer,code),layer:frame.layer,time:frame.time,run:frame.run??null,renderer:renderer.kind};
}
async function selfCheckVisible(){
  const d=currentDisplay(),frame=d.iconFrame||d.radarFrame;if(!frame)return null;
  const tile=visibleFrameTiles(frame,mapView())[0];if(!tile)return null;
  return renderer.selfCheck(await tileBlob(tile.url,frame.source==='icon'?'icon':'radar'),frame.frames,frame.index);
}
loadPreferences();
wire();
dom.citySearch.value=state.place.name;
dom.horizontalSpeed.value=String(state.horizontalHours);
dom.verticalSpeed.value=String(state.verticalHours);
dom.horizontalOutput.textContent=`${state.horizontalHours} h / 100 px`;
dom.verticalOutput.textContent=`${state.verticalHours} h / 100 px`;
dom.opacitySlider.value=String(Math.round(state.radarOpacity*100));
dom.opacityOutput.textContent=`${Math.round(state.radarOpacity*100)}%`;
dom.radarCanvas.style.opacity=String(state.radarOpacity);
dom.smoothFrames.checked=state.smoothFrames;
dom.cloudOpacitySlider.value=String(Math.round(state.cloudOpacity*100));
dom.cloudOpacityOutput.textContent=`${Math.round(state.cloudOpacity*100)}%`;
dom.cloudTiles.style.opacity=String(state.cloudOpacity);
buildLayerMenu();updateOverlayUI();updateCacheControls();
refreshView();loadModelsForView();void loadIconRun();
if(state.model==='icon_eu')void loadEuWms();
void weatherDiskCache.dropOtherNamespaces();
setInterval(refreshPointers,120_000);
if('serviceWorker' in navigator&&!params.has('no-sw')&&(location.protocol==='https:'||location.hostname==='localhost')){
  window.addEventListener('load',()=>navigator.serviceWorker.register('./sw.js').catch(()=>{}));
}
// Unit and browser tests can inspect the state with ?test=1; no production dependency.
if(params.has('test'))window.openwetterTest={state,setSelectedTime,setHorizon,setMode,setView,setPlace,
  selectModel,renderMap,drawGraphs,updateCursor,chartBounds,chartTime,combinedFrames,setContinuousIndex,pickGestureAxis,
  toggleObservation,selectMapLayer,applyGridForecast,currentDisplay,timeBounds,renderer,sampleAt,selfCheckVisible,
  setRadarIndex,setRadarHours};
