import {
  MODELS, MODEL_IDS, VARIABLES, DEFAULT_PLACES, clamp, wrappedLongitude, clampLatitude,
  forecastURL, parseForecast, nearestIndex, valueAtTime, axisLimits, hourFloor,
  pickGestureAxis, scrubTimestamp, forecastBounds, timelinePosition, placeKey,
  mercator, unmercator, dwdWmsTileURL, DWD_SATELLITE_CLOUDS,
} from './logic.mjs';
import {fetchNativeManifest,downloadNativeFrame,downloadNativePointSeries,
  paintNativeField,interpolatePointField} from './native-fields.mjs';

const el=id=>document.getElementById(id);
const fields=[
  'appRoot','placesBtn','headerPlace','viewForecast','viewCompare','settingsBtn','searchForm','citySearch',
  'modelSelect','locateBtn','locationName','modelDescription','heroTemp','heroTime','quickRain','quickWind',
  'quickCloud','message','plotsHeading','horizon48','horizon120','graphStack','playBtn','timeLabel',
  'timeRange','timeSlider','startLabel','endLabel','settingsPanel','horizontalSpeed','horizontalOutput',
  'verticalSpeed','verticalOutput','opacitySlider','opacityOutput','cloudOpacitySlider','cloudOpacityOutput',
  'map','baseTiles','iconCanvas','radarCanvas','radarTiles','cloudTiles','toggleRain','toggleClouds',
  'toggleForecastRain','toggleForecastClouds',
  'mapPin','pinTemp','mapLayerName','mapModelName','modeForecast','modeRadar','zoomIn','zoomOut',
  'resetView','mapInstruction','radarAttribution','placesDrawer','drawerScrim','closePlaces',
  'placesList','savePlace',
];
const dom=Object.fromEntries(fields.map(k=>[k,el(k)]));
const defaultPlace={...DEFAULT_PLACES[0]};
const state={
  place:defaultPlace, map:{latitude:defaultPlace.latitude,longitude:defaultPlace.longitude,zoom:7},
  favorites:DEFAULT_PLACES.map(x=>({...x})),
  model:'icon_d2',view:'forecast',mode:'forecast',horizon:48,
  horizontalHours:4,verticalHours:24,radarOpacity:.75,cloudOpacity:.5,showRain:false,showClouds:false,
  anchor:hourFloor(Date.now()/1000),selectedTime:hourFloor(Date.now()/1000),
  forecasts:{},forecast:null,forecastIndex:0,loadingModels:new Set(),modelErrors:{},
  radar:null,radarIndex:0,playing:false,
  iconGrid:null,iconGridError:null,gridSeries:null,showForecastRain:true,showForecastClouds:false,
};
let fetchEpoch=0;
const fetchControllers=new Map();
let radarController=null,playTimer=null,mapRedrawRequest=0,graphRedrawRequest=0,forecastCursorRequest=0;
let cloudWarningIssued=false,pointSeriesEpoch=0,drawEpoch=0;
const pointers=new Map();
let drag=null;
const FORECAST_MAX_AGE=45*60_000;
const STORAGE='openwetter.settings.v2';

function save(){
  try{localStorage.setItem(STORAGE,JSON.stringify({place:state.place,favorites:state.favorites,
    model:state.model,horizon:state.horizon,horizontalHours:state.horizontalHours,
    verticalHours:state.verticalHours,radarOpacity:state.radarOpacity,cloudOpacity:state.cloudOpacity,
    showRain:state.showRain,showClouds:state.showClouds,
    showForecastRain:state.showForecastRain,showForecastClouds:state.showForecastClouds}));}catch{/* Browsers may deny storage. */}
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
    if(Number.isFinite(p.horizontalHours))state.horizontalHours=clamp(p.horizontalHours,1,24);
    if(Number.isFinite(p.verticalHours))state.verticalHours=clamp(p.verticalHours,4,72);
    if(Number.isFinite(p.radarOpacity))state.radarOpacity=clamp(p.radarOpacity,.1,1);
    if(Number.isFinite(p.cloudOpacity))state.cloudOpacity=clamp(p.cloudOpacity,.1,1);
    if(typeof p.showRain==='boolean')state.showRain=p.showRain;
    if(typeof p.showClouds==='boolean')state.showClouds=p.showClouds;
    if(typeof p.showForecastRain==='boolean')state.showForecastRain=p.showForecastRain;
    if(typeof p.showForecastClouds==='boolean')state.showForecastClouds=p.showForecastClouds;
  }catch{/* Use defaults. */}
}
function showMessage(msg,error=false){dom.message.textContent=msg;dom.message.className=`message${msg?' visible':''}${error?' error':''}`;}
function zone(){return state.forecast?.timezone||'Europe/Berlin';}
function formatTime(seconds,options={weekday:'short',hour:'2-digit',minute:'2-digit'}){
  if(!Number.isFinite(seconds))return '—';
  return new Intl.DateTimeFormat('en-GB',{...options,timeZone:zone()}).format(new Date(seconds*1000));
}
function shortPlace(name){return name.split(',')[0]||name;}
function fmt(v,metric){if(v==null)return '—';return metric==='precipitation'?v.toFixed(1):String(Math.round(v));}
function metricValue(model,metric){return valueAtTime(state.forecasts[model],metric,state.selectedTime);}
function timeBounds(){
  const b=forecastBounds(state.anchor,state.horizon);
  if(state.mode==='forecast' && state.model==='icon_d2' && state.iconGrid){
    b.min=Math.max(b.min,state.iconGrid.start);b.max=Math.max(b.min,Math.min(b.max,state.iconGrid.end));
  }
  return b;
}
function timelineStep(){return state.mode==='forecast'&&state.model==='icon_d2'&&state.iconGrid?900:3600;}

function requestMap(){if(!mapRedrawRequest)mapRedrawRequest=requestAnimationFrame(()=>{mapRedrawRequest=0;renderMap();});}
function requestGraphs(){if(!graphRedrawRequest)graphRedrawRequest=requestAnimationFrame(()=>{graphRedrawRequest=0;drawGraphs();});}
function requestCursor(){if(!forecastCursorRequest)forecastCursorRequest=requestAnimationFrame(()=>{forecastCursorRequest=0;updateCursor();});}
async function getJson(url,signal,ms=18000){
  const abort=new AbortController();
  const onAbort=()=>abort.abort();signal?.addEventListener('abort',onAbort,{once:true});
  const timeout=setTimeout(()=>abort.abort(),ms);
  try{
    const response=await fetch(url,{signal:abort.signal});
    if(!response.ok)throw new Error(`HTTP ${response.status}`);
    const json=await response.json();
    if(json?.error)throw new Error(json.reason||'API rejected request');
    return json;
  }finally{clearTimeout(timeout);signal?.removeEventListener('abort',onAbort);}
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
  if(state.forecasts[model]&&Date.now()-state.forecasts[model].fetchedAt<FORECAST_MAX_AGE)return;
  if(state.loadingModels.has(model))return;
  const controller=new AbortController();fetchControllers.set(model,controller);
  state.loadingModels.add(model);delete state.modelErrors[model];renderGraphs();
  if(model===state.model)showMessage(`Loading DWD ${MODELS[model].label} forecast…`);
  try{
    const result=parseForecast(await getJson(forecastURL({...state.place,model}),controller.signal));
    if(controller.signal.aborted||epoch!==fetchEpoch)return;
    state.forecasts[model]={...result,fetchedAt:Date.now()};
    if(model==='icon_d2')applyNativeGridForecast();
    try{localStorage.setItem(cacheId(model),JSON.stringify({savedAt:Date.now(),forecast:result}));}catch{/* optional */}
    if(model===state.model){state.forecast=state.forecasts[model];showMessage('');}
  }catch(error){
    if(controller.signal.aborted||epoch!==fetchEpoch)return;
    const fallback=cachedModel(model);
    if(fallback){state.forecasts[model]=fallback;state.modelErrors[model]='Cached data (offline or stale)';}
    else state.modelErrors[model]=`Unavailable: ${error.message}`;
    if(model===state.model){state.forecast=state.forecasts[model]||null;showMessage(`${MODELS[model].label}: ${state.modelErrors[model]}`,true);}
  }finally{
    if(epoch===fetchEpoch){state.loadingModels.delete(model);fetchControllers.delete(model);refreshView();}
  }
}
function loadModelsForView(){
  void loadModel(state.model);
  if(state.view==='compare')for(const model of MODEL_IDS)void loadModel(model);
}
async function loadRadar(){
  if(state.radar&&Date.now()-state.radar.fetchedAt<5*60_000)return;
  radarController?.abort();
  const controller=new AbortController();radarController=controller;
  try{
    const metadata=await fetchNativeManifest('radar',{signal:controller.signal});
    if(controller.signal.aborted)return;
    state.radar={...metadata,fetchedAt:Date.now()};state.radarIndex=metadata.frames.length-1;
    showMessage('');updateTimeUI();requestMap();
  }catch(error){if(!controller.signal.aborted)showMessage('Official DWD rain radar unavailable: '+error.message,true);}
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
  state.loadingModels.clear();state.modelErrors={};state.forecasts={};state.forecast=null;
  state.gridSeries=null;pointSeriesEpoch++;
  state.anchor=hourFloor(Date.now()/1000);state.selectedTime=state.anchor;
  state.place={name:place.name,latitude:clampLatitude(place.latitude),longitude:wrappedLongitude(place.longitude)};
  if(center){state.map.latitude=state.place.latitude;state.map.longitude=state.place.longitude;}
  dom.citySearch.value=state.place.name;save();refreshView();requestMap();loadModelsForView();void loadNativePointSeries();
}
function selectModel(model){
  if(!Object.hasOwn(MODELS,model))return;
  state.model=model;state.forecast=state.forecasts[model]||null;
  dom.modelSelect.value=model;stopPlay();save();refreshView();loadModelsForView();
}
function setView(view){
  if(!['forecast','compare'].includes(view))return;
  state.view=view;stopPlay();
  if(view==='compare'&&state.mode==='radar')state.mode='forecast';
  dom.appRoot.classList.toggle('compare-mode',view==='compare');
  dom.viewForecast.classList.toggle('active',view==='forecast');dom.viewCompare.classList.toggle('active',view==='compare');
  dom.viewForecast.setAttribute('aria-pressed',String(view==='forecast'));
  dom.viewCompare.setAttribute('aria-pressed',String(view==='compare'));
  dom.plotsHeading.textContent=view==='compare'?'ICON model comparison · shared time':'Weather variables · synchronized time';
  closeDrawer();refreshView();loadModelsForView();
}
function setHorizon(hours){
  if(![48,120].includes(hours))return;
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
function getRadarTime(){return state.radar?.frames?.[state.radarIndex]?.time||null;}
function setRadarIndex(index){
  if(!state.radar?.frames?.length)return;
  const next=clamp(Math.round(index),0,state.radar.frames.length-1);
  if(next===state.radarIndex)return;
  state.radarIndex=next;updateTimeUI();requestMap();
}
function timeList(){return state.radar?.frames?.map(f=>f.time)||[];}
function setMode(mode){
  if(!['forecast','radar'].includes(mode))return;
  stopPlay();state.mode=mode;
  dom.modeForecast.classList.toggle('active',mode==='forecast');dom.modeRadar.classList.toggle('active',mode==='radar');
  dom.modeForecast.setAttribute('aria-pressed',String(mode==='forecast'));
  dom.modeRadar.setAttribute('aria-pressed',String(mode==='radar'));
  updateOverlayUI();
  dom.mapInstruction.textContent=mode==='radar'?'Swipe ↔ / ↕ for past radar · 2 fingers to pan':'Swipe ↔ slowly / ↕ quickly · two fingers to move map';
  updateTimeUI();requestMap();
  if(mode==='radar'||state.showRain)void loadRadar();
}
function updateOverlayUI(){
  const visibleRain=state.mode==='radar'||state.showRain;
  dom.toggleRain.setAttribute('aria-pressed',String(visibleRain));
  dom.toggleClouds.setAttribute('aria-pressed',String(state.showClouds));
  const realGrid=state.mode==='forecast'&&state.model==='icon_d2'&&!!state.iconGrid;
  dom.toggleForecastRain.setAttribute('aria-pressed',String(state.showForecastRain));
  dom.toggleForecastClouds.setAttribute('aria-pressed',String(state.showForecastClouds));
  dom.toggleForecastRain.disabled=state.model!=='icon_d2';
  dom.toggleForecastClouds.disabled=state.model!=='icon_d2';
  dom.radarCanvas.hidden=!visibleRain;
  dom.radarTiles.style.display='none';
  dom.cloudTiles.hidden=!state.showClouds;
  const observations=[];
  if(visibleRain)observations.push('rain radar');
  if(state.showClouds)observations.push('satellite clouds');
  dom.mapLayerName.textContent=state.mode==='radar'?'DWD 1 km radar · observed':
    (realGrid?'ICON-D2 forecast · spatial grid':(observations.length?`Observed: ${observations.join(' + ')}`:'ICON forecast grid unavailable'));
  dom.radarAttribution.textContent=(visibleRain?' · Radar © DWD':'')+
    (state.showClouds?' · Satellite © DWD':'');
  dom.mapModelName.textContent=state.mode==='radar'?'Radar history · independent timeline':
    (realGrid?`DWD ICON ${state.iconGrid.run} · 0.0125° display raster`:(observations.length?'Observations do not follow ICON time':state.iconGridError?'Grids not yet published':`DWD ${MODELS[state.model].label}`));
}
function toggleObservation(which){
  if(which==='rain'){
    if(state.mode==='radar'){
      // The radar history timeline always shows rain; tapping the active chip hides it.
      setMode('forecast');state.showRain=false;
    }else state.showRain=!state.showRain;
    if(state.showRain)void loadRadar();
  }else if(which==='clouds'){state.showClouds=!state.showClouds;cloudWarningIssued=false;}
  else return;
  updateOverlayUI();save();requestMap();
}

function applyNativeGridForecast(){
  const model=state.forecasts.icon_d2,series=state.gridSeries,grid=state.iconGrid;
  if(!model||!series||!grid)return;
  const source=model.rawPointForecast||model;
  const hourly={time:series.time,temperature_2m:series.temperature_2m,
    precipitation:series.precipitation,cloud_cover:series.cloud_cover};
  for(const [name,values] of Object.entries(source.hourly)){
    if(name==='time'||Object.hasOwn(hourly,name))continue;
    if(Array.isArray(values))hourly[name]=series.time.map(t=>interpolatePointField(source.hourly,name,t));
  }
  state.forecasts.icon_d2={...source,hourly,rawPointForecast:source,fromRawGrid:true,
    fetchedAt:source.fetchedAt||Date.now()};
  if(state.model==='icon_d2')state.forecast=state.forecasts.icon_d2;
}
async function loadNativePointSeries(){
  const grid=state.iconGrid,place={...state.place},epoch=++pointSeriesEpoch;
  if(!grid)return;
  try{
    const series=await downloadNativePointSeries(grid,place.latitude,place.longitude);
    if(epoch!==pointSeriesEpoch)return;
    state.gridSeries=series;applyNativeGridForecast();refreshView();
  }catch(error){
    if(epoch!==pointSeriesEpoch)return;
    state.gridSeries=null;
    if(state.model==='icon_d2')showMessage('ICON point series: '+error.message,true);
  }
}
async function loadNativeGrid(){
  try{
    const grid=await fetchNativeManifest('icon');
    state.iconGrid=grid;state.iconGridError=null;
    await loadNativePointSeries();refreshView();
  }catch(error){
    state.iconGridError=error.message;state.iconGrid=null;state.gridSeries=null;
    updateOverlayUI();requestMap();
    if(state.model==='icon_d2')showMessage('ICON-D2 spatial map unavailable: '+error.message,true);
  }
}
function toggleNativeLayer(field){
  if(field==='precip')state.showForecastRain=!state.showForecastRain;
  else if(field==='cloud')state.showForecastClouds=!state.showForecastClouds;
  else return;updateOverlayUI();save();requestMap();
}
async function paintNativeGrid(){
  const canvas=dom.iconCanvas,radar=dom.radarCanvas,rect=dom.map.getBoundingClientRect();
  if(!rect.width||!rect.height)return;
  const width=rect.width,height=rect.height,ratio=Math.min(2.5,window.devicePixelRatio||1);
  for(const layer of [canvas,radar]){
    layer.width=Math.round(width*ratio);layer.height=Math.round(height*ratio);
    const ctx=layer.getContext('2d');ctx.setTransform(ratio,0,0,ratio,0,0);ctx.clearRect(0,0,width,height);
  }
  const generation=++drawEpoch,model=state.iconGrid,time=state.selectedTime,map={...state.map};
  if(state.mode==='forecast'&&state.model==='icon_d2'&&model&&(state.showForecastRain||state.showForecastClouds)){
    const results=await Promise.allSettled([
      state.showForecastClouds?downloadNativeFrame(model,'cloud',time):Promise.resolve(null),
      state.showForecastRain?downloadNativeFrame(model,'precip',time):Promise.resolve(null)
    ]);
    if(generation!==drawEpoch)return;
    const ctx=canvas.getContext('2d');
    const clouds=results[0].status==='fulfilled'?results[0].value:null;
    const rain=results[1].status==='fulfilled'?results[1].value:null;
    if(clouds)paintNativeField(ctx,model,clouds.data,'cloud',width,height,map.zoom,map,.58);
    if(rain)paintNativeField(ctx,model,rain.data,'precip',width,height,map.zoom,map,.87);
    if(state.showForecastRain)for(const dt of [-900,900])void downloadNativeFrame(model,'precip',time+dt).catch(()=>{});
  }
  // DWD RY rain radar now draws georeferenced 1km data on radarCanvas.
  dom.radarTiles.replaceChildren();
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
      startTime:state.mode==='radar'?getRadarTime():state.selectedTime,axis:null,wasMulti:false,mouse:event.pointerType==='mouse'};
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
          if(state.mode==='radar'){
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
  dom.horizon48.addEventListener('click',()=>setHorizon(48));
  dom.horizon120.addEventListener('click',()=>setHorizon(120));
  dom.timeSlider.addEventListener('input',event=>{stopPlay();
    if(state.mode==='radar')setRadarIndex(Number(event.target.value));
    else setSelectedTime(timeBounds().min+Number(event.target.value)*timelineStep());
  });
  dom.playBtn.addEventListener('click',play);
  dom.modeForecast.addEventListener('click',()=>setMode('forecast'));
  dom.modeRadar.addEventListener('click',()=>setMode('radar'));
  dom.toggleRain.addEventListener('click',()=>toggleObservation('rain'));
  dom.toggleClouds.addEventListener('click',()=>toggleObservation('clouds'));
  dom.toggleForecastRain.addEventListener('click',()=>toggleNativeLayer('precip'));
  dom.toggleForecastClouds.addEventListener('click',()=>toggleNativeLayer('cloud'));
  dom.zoomIn.addEventListener('click',()=>zoom(1));dom.zoomOut.addEventListener('click',()=>zoom(-1));
  dom.resetView.addEventListener('click',()=>{state.map.latitude=state.place.latitude;state.map.longitude=state.place.longitude;requestMap();});
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
  dom.opacitySlider.addEventListener('input',event=>{
    state.radarOpacity=Number(event.target.value)/100;
    dom.radarCanvas.style.opacity=String(state.radarOpacity);
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
    if(event.key==='Escape'){closeDrawer();dom.settingsPanel.hidden=true;dom.settingsBtn.setAttribute('aria-expanded','false');}
    if(event.target.matches('input,button,select,textarea'))return;
    if(event.key==='ArrowRight'){stopPlay();state.mode==='radar'?setRadarIndex(state.radarIndex+1):setSelectedTime(state.selectedTime+timelineStep());}
    if(event.key==='ArrowLeft'){stopPlay();state.mode==='radar'?setRadarIndex(state.radarIndex-1):setSelectedTime(state.selectedTime-timelineStep());}
  });
  window.addEventListener('resize',()=>{requestGraphs();requestMap();});
  if('ResizeObserver' in window)new ResizeObserver(()=>{requestGraphs();requestMap();}).observe(dom.graphStack);
  document.addEventListener('visibilitychange',()=>{if(document.hidden)stopPlay();});
  wireMapGestures();
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
dom.cloudOpacitySlider.value=String(Math.round(state.cloudOpacity*100));
dom.cloudOpacityOutput.textContent=`${Math.round(state.cloudOpacity*100)}%`;
dom.cloudTiles.style.opacity=String(state.cloudOpacity);
updateOverlayUI();
if(state.showRain)void loadRadar();
refreshView();loadModelsForView();void loadNativeGrid();
if('serviceWorker' in navigator&&!new URLSearchParams(location.search).has('no-sw')&&(location.protocol==='https:'||location.hostname==='localhost')){
  window.addEventListener('load',()=>navigator.serviceWorker.register('./sw.js').catch(()=>{}));
}
// Unit and browser tests can inspect the state with ?test=1; no production dependency.
if(new URLSearchParams(location.search).has('test'))window.openwetterTest={state,setSelectedTime,setHorizon,setMode,setView,setPlace,
  selectModel,renderMap,drawGraphs,updateCursor,pickGestureAxis,toggleObservation,toggleNativeLayer,applyNativeGridForecast};
