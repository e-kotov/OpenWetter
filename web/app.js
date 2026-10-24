import { MODELS, VARIABLES, clamp, wrappedLongitude, clampLatitude, forecastURL,
  parseForecast, nearestIndex, safeRadarMetadata, radarTileURL, mercator, unmercator,
  valueAt, axisLimits } from './logic.mjs';

const el = (id) => document.getElementById(id);
const state = {
  place: {latitude: 51.5142, longitude: 7.4653, name: 'Dortmund, Germany'},
  map: {latitude: 51.5142, longitude: 7.4653, zoom: 7},
  model: 'icon_d2', metric: 'temperature', mode: 'forecast',
  forecast: null, forecastIndex: 0, radar: null, radarIndex: 0,
  radarOpacity: .75, playing: false, lastFetch: 0,
};
const dom = Object.fromEntries([
  'citySearch','searchForm','modelSelect','locateBtn','map','baseTiles','radarTiles','mapPin','pinTemp',
  'mapLayerName','mapModelName','modeForecast','modeRadar','zoomIn','zoomOut','resetView','mapInstruction',
  'radarAttribution','pointCoordinates','locationName','modelDescription','heroTemp','heroUnit','heroTime',
  'quickTemp','quickRain','quickWind','quickCloud','message','metricButtons','forecastChart','graphTooltip','playBtn','timeLabel','timeRange','timeSlider',
  'startLabel','endLabel','settingsBtn','settingsPanel','opacitySlider','opacityOutput',
].map(k=>[k,el(k)]));
let forecastAbort;
let radarAbort;
let playingHandle = null;
let redrawRequest = 0;
const pointers = new Map();
let dragState = null;
const FORECAST_MAX_AGE = 45 * 60_000;
const radarEndpoint = 'https://api.rainviewer.com/public/weather-maps.json';
const save = () => {
  try { localStorage.setItem('openwetter.prefs.v1', JSON.stringify({place: state.place, model:state.model,metric:state.metric,radarOpacity:state.radarOpacity})); }
  catch { /* localStorage can be unavailable in private browsing */ }
};
const load = () => {
  try {
    const p = JSON.parse(localStorage.getItem('openwetter.prefs.v1') || '{}');
    if (p.place && Number.isFinite(p.place.latitude) && Number.isFinite(p.place.longitude) && Math.abs(p.place.latitude)<=85 && Math.abs(p.place.longitude)<=180 && typeof p.place.name === 'string') {
      state.place = p.place;
      state.map.latitude = p.place.latitude; state.map.longitude = p.place.longitude;
    }
    if (Object.hasOwn(MODELS,p.model)) state.model=p.model;
    if (Object.hasOwn(VARIABLES,p.metric)) state.metric=p.metric;
    if (Number.isFinite(p.radarOpacity)) state.radarOpacity=clamp(p.radarOpacity,.1,1);
  } catch { /* fall back to Dortmund */ }
};

function showMessage(msg, error=false) {
  dom.message.textContent=msg;
  dom.message.className = `message${msg?' visible':''}${error?' error':''}`;
}
function formatTime(unix, opts={weekday:'short',hour:'2-digit',minute:'2-digit'}) {
  if (!Number.isFinite(unix)) return '—';
  return new Intl.DateTimeFormat('en-GB',{...opts,timeZone:state.forecast?.timezone || undefined}).format(new Date(unix*1000));
}
function fmt(value,metric) {
  if (value == null) return '—';
  return metric==='precipitation' ? value.toFixed(1) : String(Math.round(value));
}
function requestRedrawMap() {
  if (!redrawRequest) redrawRequest=requestAnimationFrame(()=>{redrawRequest=0;renderMap();});
}
async function getJson(url, controller, ms=18000) {
  const timeout=setTimeout(()=>controller.abort(),ms);
  try {
    const response=await fetch(url,{signal:controller.signal});
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const json=await response.json();
    if (json?.error) throw new Error(json.reason || 'Data source rejected request');
    return json;
  } finally { clearTimeout(timeout); }
}
async function loadForecast() {
  forecastAbort?.abort();
  const thisController = new AbortController();
  forecastAbort = thisController;
  state.forecast=null;
  dom.modelSelect.value=state.model;
  showMessage(`Requesting ${MODELS[state.model].label} forecast from Open-Meteo…`);
  updateInfo(); drawChart();
  try {
    const data=parseForecast(await getJson(forecastURL({...state.place,model:state.model}),thisController));
    if(thisController.signal.aborted)return;
    state.forecast=data;
    state.forecastIndex=nearestIndex(data.hourly.time,Date.now()/1000);
    state.lastFetch=Date.now();
    showMessage('');
    updateInfo(); drawChart();
    requestRedrawMap();
    try { localStorage.setItem('openwetter.lastForecast.v1',JSON.stringify({place:state.place,model:state.model,ts:Date.now(),data})); } catch {}
  } catch(error) {
    if(thisController.signal.aborted)return;
    let usedCache=false;
    try {
      const saved=JSON.parse(localStorage.getItem('openwetter.lastForecast.v1')||'null');
      if(saved && saved.model===state.model && Math.abs(saved.place.latitude-state.place.latitude)<.0001 && Math.abs(saved.place.longitude-state.place.longitude)<.0001 && Date.now()-saved.ts < 24*3600_000) {
        state.forecast=parseForecast(saved.data);
        state.forecastIndex=nearestIndex(state.forecast.hourly.time,Date.now()/1000);
        showMessage(`Offline/stale forecast from ${Math.round((Date.now()-saved.ts)/60000)} minutes ago. Network request failed: ${error.message}`,true);
        usedCache=true;
      }
    } catch {}
    if(!usedCache) showMessage(`Forecast unavailable: ${error.message}. Check your connection, or select ICON Global if you are outside the ICON-D2 domain.`,true);
    updateInfo(); drawChart();
  }
}
async function loadRadar() {
  if (state.radar && Date.now()-state.radar.fetchedAt < 5*60_000) return;
  radarAbort?.abort();
  const controller=new AbortController(); radarAbort=controller;
  try {
    const info = safeRadarMetadata(await getJson(radarEndpoint,controller,12000));
    if(controller.signal.aborted)return;
    state.radar={...info,fetchedAt:Date.now()};
    state.radarIndex=info.frames.length-1;
    showMessage('');
    renderTime();requestRedrawMap();
  } catch(error) {
    if(controller.signal.aborted)return;
    showMessage(`Radar is unavailable: ${error.message}. Forecast graphs will still work.`,true);
  }
}
function setPlace(latitude,longitude,name,{center=true}={}) {
  latitude=clampLatitude(latitude);longitude=wrappedLongitude(longitude);
  stopPlay();
  state.place={latitude,longitude,name};
  if(center){state.map.latitude=latitude;state.map.longitude=longitude;}
  dom.citySearch.value=name;
  save();
  updateInfo();requestRedrawMap();loadForecast();
}
function updateInfo() {
  const {latitude,longitude,name}=state.place;
  const meta=MODELS[state.model];
  dom.locationName.textContent=name;
  dom.pointCoordinates.textContent=`${Math.abs(latitude).toFixed(2)}°${latitude>=0?'N':'S'}, ${Math.abs(longitude).toFixed(2)}°${longitude>=0?'E':'W'}`;
  dom.modelDescription.textContent=`DWD ${meta.label} · ${meta.subtitle.split('·').slice(1).join('·').trim()}`;
  dom.mapModelName.textContent=`DWD ${meta.label}`;
  const current=valueAt(state.forecast,state.metric,state.forecastIndex);
  dom.heroTemp.textContent=fmt(current,state.metric);
  dom.heroUnit.textContent=VARIABLES[state.metric].unit;
  dom.pinTemp.textContent=`${fmt(valueAt(state.forecast,'temperature',state.forecastIndex),'temperature')}°`;
  dom.heroTime.textContent=state.forecast?formatTime(state.forecast.hourly.time[state.forecastIndex]):'Connecting…';
  dom.quickTemp.textContent=`${fmt(valueAt(state.forecast,'temperature',state.forecastIndex),'temperature')} °C`;
  dom.quickRain.textContent=`${fmt(valueAt(state.forecast,'precipitation',state.forecastIndex),'precipitation')} mm`;
  dom.quickWind.textContent=`${fmt(valueAt(state.forecast,'wind',state.forecastIndex),'wind')} km/h`;
  dom.quickCloud.textContent=`${fmt(valueAt(state.forecast,'cloud',state.forecastIndex),'cloud')} %`;
  for(const b of dom.metricButtons.querySelectorAll('button')) {
    const active=b.dataset.metric===state.metric;
    b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));
  }
  dom.modeForecast.classList.toggle('active',state.mode==='forecast');
  dom.modeRadar.classList.toggle('active',state.mode==='radar');
  dom.modeForecast.setAttribute('aria-pressed',String(state.mode==='forecast'));
  dom.modeRadar.setAttribute('aria-pressed',String(state.mode==='radar'));
  dom.mapLayerName.textContent=state.mode==='radar'?'Observed precipitation radar':'Base map · point forecast';
  dom.radarAttribution.textContent=state.mode==='radar'?' · Radar © RainViewer':'';
  dom.radarTiles.style.display=state.mode==='radar'?'block':'none';
  dom.mapInstruction.textContent=state.mode==='radar'?'Observed radar history · swipe ↔ · 2 fingers to pan':'Swipe ↔ for forecast time · 2 fingers to pan';
  renderTime();
}
function timeArray() {
  return state.mode==='radar' ? (state.radar?.frames||[]).map(f=>f.time) : (state.forecast?.hourly.time||[]);
}
function getIndex() { return state.mode==='radar'?state.radarIndex:state.forecastIndex; }
function setTimeIndex(index) {
  const arr=timeArray();if(!arr.length)return;
  const next=clamp(Math.round(index),0,arr.length-1);
  if(state.mode==='radar') state.radarIndex=next;
  else state.forecastIndex=next;
  updateInfo();drawChart();
  if(state.mode==='radar')requestRedrawMap();
}
function renderTime() {
  const list=timeArray();
  const hasTimes=list.length>0;
  const index=hasTimes?clamp(getIndex(),0,list.length-1):0;
  dom.timeSlider.max=String(Math.max(1,list.length-1));
  dom.timeSlider.value=String(index);dom.timeSlider.disabled=!hasTimes;
  dom.timeLabel.textContent=hasTimes?formatTime(list[index]):'Loading time…';
  dom.startLabel.textContent=hasTimes?formatTime(list[0],{hour:'2-digit',minute:'2-digit',day:'numeric',month:'short'}):'—';
  dom.endLabel.textContent=hasTimes?formatTime(list.at(-1),{hour:'2-digit',minute:'2-digit',day:'numeric',month:'short'}):'—';
  dom.timeRange.textContent=state.mode==='radar'?'OBSERVED · NOT FORECAST':`FORECAST · ${MODELS[state.model].label}`;
}
function selectMetric(metric) {
  if(!Object.hasOwn(VARIABLES,metric))return;
  state.metric=metric;save();updateInfo();drawChart();
}
function setMode(mode) {
  if(state.mode===mode)return;
  stopPlay();state.mode=mode;
  updateInfo();drawChart();requestRedrawMap();
  if(mode==='radar')loadRadar();
}
function stopPlay() {if(playingHandle)clearInterval(playingHandle);playingHandle=null;state.playing=false;dom.playBtn.textContent='▶';dom.playBtn.setAttribute('aria-label','Play timeline');}
function play() {
  if(state.playing){stopPlay();return;}
  if(!timeArray().length)return;
  state.playing=true;dom.playBtn.textContent='Ⅱ';dom.playBtn.setAttribute('aria-label','Pause timeline');
  // Stop at final frame rather than loop and overuse public RainViewer tiles.
  playingHandle=setInterval(()=>{
    if(getIndex()>=timeArray().length-1) {stopPlay();return;}
    setTimeIndex(getIndex()+1);
  },state.mode==='radar'?2900:300);
}

function tileLayer(pane, items) {
  const existing=new Map(Array.from(pane.children).map(n=>[n.dataset.key,n]));
  const keys=new Set();
  for(const t of items) {
    const key=t.key;keys.add(key);
    let img=existing.get(key);
    if(!img) {
      img=document.createElement('img');img.dataset.key=key;
      img.src=t.url;img.alt='';img.draggable=false;img.decoding='async';
      img.addEventListener('error',()=>{img.style.opacity=0;});
      pane.append(img);
    }
    img.style.width=`${t.size}px`;img.style.height=`${t.size}px`;
    img.style.left=`${t.left}px`;img.style.top=`${t.top}px`;
  }
  for(const [key,img] of existing) if(!keys.has(key))img.remove();
}
function renderMap() {
  const bounds=dom.map.getBoundingClientRect();
  if(!bounds.width||!bounds.height)return;
  const z=state.map.zoom;
  const point=mercator(state.map.latitude,state.map.longitude,z);
  const topLeft={x:point.x-bounds.width/2,y:point.y-bounds.height/2};
  const size=2**z;
  const tiles=[];
  const minx=Math.floor(topLeft.x/256),maxx=Math.floor((topLeft.x+bounds.width)/256);
  const miny=Math.max(0,Math.floor(topLeft.y/256)),maxy=Math.min(size-1,Math.floor((topLeft.y+bounds.height)/256));
  for(let x=minx;x<=maxx;x++)for(let y=miny;y<=maxy;y++){
    const sx=((x%size)+size)%size;
    tiles.push({key:`${z}/${sx}/${y}`,url:`https://tile.openstreetmap.org/${z}/${sx}/${y}.png`,size:256,left:x*256-topLeft.x,top:y*256-topLeft.y});
  }
  tileLayer(dom.baseTiles,tiles);
  if(state.mode==='radar' && state.radar?.frames.length){
    const rz=Math.min(z,7),scale=2**(z-rz),sz=256*scale,limit=2**rz;
    const radarTiles=[];
    const rx0=Math.floor(topLeft.x/sz),rx1=Math.floor((topLeft.x+bounds.width)/sz);
    const ry0=Math.max(0,Math.floor(topLeft.y/sz)),ry1=Math.min(limit-1,Math.floor((topLeft.y+bounds.height)/sz));
    for(let x=rx0;x<=rx1;x++)for(let y=ry0;y<=ry1;y++) {
      const url=radarTileURL(state.radar,state.radarIndex,rz,x,y);
      if(url)radarTiles.push({key:`${state.radarIndex}/${rz}/${((x%limit)+limit)%limit}/${y}`,url,size:sz,left:x*sz-topLeft.x,top:y*sz-topLeft.y});
    }
    tileLayer(dom.radarTiles,radarTiles);
  } else {dom.radarTiles.replaceChildren();}
  const pin=mercator(state.place.latitude,state.place.longitude,z);
  let dx=pin.x-point.x;
  const maxWorld=256*2**z;
  if(dx>maxWorld/2)dx-=maxWorld;if(dx< -maxWorld/2)dx+=maxWorld;
  const px=bounds.width/2+dx,py=bounds.height/2+(pin.y-point.y);
  dom.mapPin.style.left=`${px}px`;dom.mapPin.style.top=`${py}px`;
  dom.mapPin.hidden=px < -50 || px > bounds.width+50 || py < -50 || py > bounds.height+50;
}
function pan(dx,dy) {
  const center=mercator(state.map.latitude,state.map.longitude,state.map.zoom);
  const result=unmercator(center.x-dx,center.y-dy,state.map.zoom);
  state.map.latitude=clampLatitude(result.lat);state.map.longitude=wrappedLongitude(result.lon);
  requestRedrawMap();
}
function zoom(delta) {state.map.zoom=clamp(state.map.zoom+delta,3,12);requestRedrawMap();}

function drawChart() {
  const canvas=dom.forecastChart;
  const rect=canvas.getBoundingClientRect();if(rect.width<10 || rect.height<10)return;
  const dpr=Math.min(window.devicePixelRatio||1,2);
  canvas.width=Math.round(rect.width*dpr);canvas.height=Math.round(rect.height*dpr);
  const ctx=canvas.getContext('2d');ctx.scale(dpr,dpr);
  const w=rect.width,h=rect.height;
  ctx.clearRect(0,0,w,h);
  const L=38,R=10,T=15,B=29;
  const pw=w-L-R,ph=h-T-B;
  if(ph<5||pw<10)return;
  const f=state.forecast;
  if(!f){ctx.fillStyle='#90aabd';ctx.font='13px system-ui';ctx.fillText('Waiting for forecast data…',L+12,h/2);return;}
  const {key,color,chart}=VARIABLES[state.metric];
  const nums=f.hourly[key];
  const size=nums.length;
  const {min,max}=axisLimits(nums,state.metric);
  const yval=v=>T+ph-(v-min)/(max-min)*ph;
  const xpos=i=>L+(size<=1?0:i/(size-1)*pw);
  // grid & ticks
  for(let t=0;t<=3;t++) {
    const y=T+(t/3)*ph;
    ctx.strokeStyle='rgba(156,187,213,.12)';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(L,y);ctx.lineTo(w-R,y);ctx.stroke();
    ctx.fillStyle='#7e9ab2';ctx.font='10px system-ui';ctx.textAlign='right';
    ctx.fillText(String(Math.round(max-(max-min)*t/3)),L-7,y+3);
  }
  if(chart==='bar') {
    const width=Math.min(11,Math.max(2,pw/size-1));
    ctx.fillStyle=color;
    nums.forEach((v,i)=>{if(typeof v!=='number')return;const xx=xpos(i);const yy=yval(v);ctx.globalAlpha=.75;ctx.fillRect(xx-width/2,yy,width,Math.max(1,yval(0)-yy));});
    ctx.globalAlpha=1;
  } else {
    ctx.beginPath();let inSegment=false;
    nums.forEach((v,i)=>{
      if(typeof v!=='number' || !Number.isFinite(v)){inSegment=false;return;}
      if(!inSegment){ctx.moveTo(xpos(i),yval(v));inSegment=true;}else ctx.lineTo(xpos(i),yval(v));
    });
    ctx.strokeStyle=color;ctx.lineWidth=2.2;ctx.lineJoin='round';ctx.stroke();
  }
  const nlabels=Math.max(2,Math.min(8,Math.floor(pw/95)));
  ctx.textAlign='center';ctx.fillStyle='#91a9bd';ctx.font='10px system-ui';
  for(let k=0;k<=nlabels;k++) {
    const i=Math.floor(k*(size-1)/nlabels);const x=xpos(i);
    ctx.fillText(formatTime(f.hourly.time[i],{weekday:'short',hour:'2-digit'}),clamp(x,L+25,w-30),h-8);
  }
  const selected=clamp(state.forecastIndex,0,size-1);
  const xp=xpos(selected);
  ctx.strokeStyle='rgba(255,255,255,.83)';ctx.setLineDash([3,4]);ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(xp,T);ctx.lineTo(xp,T+ph);ctx.stroke();ctx.setLineDash([]);
  const selectedVal=nums[selected];
  if(Number.isFinite(selectedVal)){
    ctx.beginPath();ctx.arc(xp,yval(selectedVal),4,0,2*Math.PI);ctx.fillStyle='#fff';ctx.fill();
    ctx.beginPath();ctx.arc(xp,yval(selectedVal),2.5,0,2*Math.PI);ctx.fillStyle=color;ctx.fill();
  }
  dom.graphTooltip.textContent=`${VARIABLES[state.metric].name} · ${state.mode==='radar'?'forecast independent of radar time':'point forecast'}`;
}
function graphIndex(event) {
  if(!state.forecast)return;
  const rect=dom.forecastChart.getBoundingClientRect();
  const rel=clamp((event.clientX-rect.left-38)/(rect.width-48),0,1);
  if(state.mode==='radar')setMode('forecast');
  setTimeIndex(Math.round(rel*(state.forecast.hourly.time.length-1)));
}

function wire() {
  dom.modelSelect.addEventListener('change',e=>{if(!Object.hasOwn(MODELS,e.target.value))return;state.model=e.target.value;stopPlay();save();loadForecast();});
  dom.metricButtons.addEventListener('click',e=>{const b=e.target.closest('button[data-metric]');if(b)selectMetric(b.dataset.metric);});
  dom.modeForecast.addEventListener('click',()=>setMode('forecast'));
  dom.modeRadar.addEventListener('click',()=>setMode('radar'));
  dom.timeSlider.addEventListener('input',e=>{stopPlay();setTimeIndex(Number(e.target.value));});
  dom.playBtn.addEventListener('click',play);
  dom.zoomIn.addEventListener('click',()=>zoom(1));dom.zoomOut.addEventListener('click',()=>zoom(-1));
  dom.resetView.addEventListener('click',()=>{state.map.latitude=state.place.latitude;state.map.longitude=state.place.longitude;requestRedrawMap();});
  dom.settingsBtn.addEventListener('click',()=>{dom.settingsPanel.hidden=!dom.settingsPanel.hidden;dom.settingsBtn.setAttribute('aria-expanded',String(!dom.settingsPanel.hidden));});
  dom.opacitySlider.addEventListener('input',e=>{state.radarOpacity=Number(e.target.value)/100;dom.radarTiles.style.opacity=state.radarOpacity;dom.opacityOutput.textContent=`${Math.round(state.radarOpacity*100)}%`;save();});
  dom.searchForm.addEventListener('submit',async e=>{
    e.preventDefault();const q=dom.citySearch.value.trim();if(!q)return;
    showMessage('Searching locations…');
    try {
      const controller=new AbortController();
      const r=await getJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=1&language=en&format=json`,controller,12000);
      const p=r.results?.[0];if(!p)throw new Error('No matching place');
      setPlace(p.latitude,p.longitude,[p.name,p.admin1,p.country].filter((v,i,a)=>v&&a.indexOf(v)===i).join(', '));
    }catch(err){showMessage(`Location search failed: ${err.message}`,true);}
  });
  dom.locateBtn.addEventListener('click',()=>{
    if(!navigator.geolocation){showMessage('Geolocation is unavailable in this browser.',true);return;}
    showMessage('Requesting location permission…');
    navigator.geolocation.getCurrentPosition(p=>setPlace(p.coords.latitude,p.coords.longitude,'My location'),e=>showMessage(`Location unavailable: ${e.message}`,true),{timeout:10000,enableHighAccuracy:false,maximumAge:60000});
  });
  dom.map.addEventListener('wheel',event=>{event.preventDefault();zoom(event.deltaY<0?1:-1);},{passive:false});
  dom.map.addEventListener('pointerdown',event=>{
    if(event.target.closest('button,a,select,input'))return;
    dom.map.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId,{x:event.clientX,y:event.clientY});
    if(pointers.size===1)dragState={startX:event.clientX,startY:event.clientY,lastX:event.clientX,lastY:event.clientY,startIndex:getIndex(),didPinch:false,kind:event.pointerType};
    if(pointers.size===2) {
      const [a,b]=[...pointers.values()];dragState={didPinch:true,midX:(a.x+b.x)/2,midY:(a.y+b.y)/2,dist:Math.hypot(a.x-b.x,a.y-b.y)};
    }
  });
  dom.map.addEventListener('pointermove',event=>{
    if(!pointers.has(event.pointerId)||!dragState)return;
    pointers.set(event.pointerId,{x:event.clientX,y:event.clientY});
    if(pointers.size===2) {
      const [a,b]=[...pointers.values()],midX=(a.x+b.x)/2,midY=(a.y+b.y)/2;
      const dist=Math.hypot(a.x-b.x,a.y-b.y);
      pan(midX-dragState.midX,midY-dragState.midY);
      if(dist>dragState.dist*1.48) {zoom(1);dragState.dist=dist;}
      else if(dist<dragState.dist/1.48){zoom(-1);dragState.dist=dist;}
      dragState.midX=midX;dragState.midY=midY;
    } else if(pointers.size===1) {
      if(event.pointerType==='mouse'){
        pan(event.clientX-dragState.lastX,event.clientY-dragState.lastY);
        dragState.lastX=event.clientX;dragState.lastY=event.clientY;
      } else {
        const delta=event.clientX-dragState.startX;
        const slow=1+Math.abs(event.clientY-dragState.startY)/65;
        const step=state.mode==='radar'?24:11;
        stopPlay();setTimeIndex(dragState.startIndex+Math.round(delta/(step*slow)));
      }
    }
  });
  const onUp=event=>{
    if(!pointers.has(event.pointerId))return;
    const first=pointers.size===1;
    if(first&&dragState&&!dragState.didPinch&&Math.hypot(event.clientX-dragState.startX,event.clientY-dragState.startY)<7) {
      const r=dom.map.getBoundingClientRect();
      const m=mercator(state.map.latitude,state.map.longitude,state.map.zoom);
      const p=unmercator(m.x+(event.clientX-r.left-r.width/2),m.y+(event.clientY-r.top-r.height/2),state.map.zoom);
      setPlace(p.lat,p.lon,'Selected map point',{center:false});
    }
    pointers.delete(event.pointerId);
    if(pointers.size<2)dragState=null;
  };
  dom.map.addEventListener('pointerup',onUp);dom.map.addEventListener('pointercancel',onUp);
  dom.forecastChart.addEventListener('pointerdown',event=>{dom.forecastChart.setPointerCapture(event.pointerId);graphIndex(event);});
  dom.forecastChart.addEventListener('pointermove',event=>{if(event.buttons||event.pressure>0)graphIndex(event);});
  window.addEventListener('resize',()=>{requestRedrawMap();drawChart();});
  if('ResizeObserver' in window)new ResizeObserver(()=>{requestRedrawMap();drawChart();}).observe(dom.forecastChart);
  window.addEventListener('keydown',e=>{
    if(e.target.matches('input,select,button'))return;
    if(e.key==='ArrowRight'){stopPlay();setTimeIndex(getIndex()+1);}
    if(e.key==='ArrowLeft'){stopPlay();setTimeIndex(getIndex()-1);}
  });
}
load();
dom.citySearch.value=state.place.name;
dom.modelSelect.value=state.model;
dom.radarTiles.style.opacity=state.radarOpacity;
dom.opacitySlider.value=Math.round(state.radarOpacity*100);
dom.opacityOutput.textContent=`${Math.round(state.radarOpacity*100)}%`;
wire();updateInfo();requestRedrawMap();loadForecast();
if('serviceWorker' in navigator && !new URLSearchParams(location.search).has('no-sw') && (location.protocol==='https:'||location.hostname==='localhost')) {
  window.addEventListener('load',()=>navigator.serviceWorker.register('./sw.js').catch(()=>{}));
}
// Optional testing surface; not enabled in regular use.
if(new URLSearchParams(location.search).has('test')) window.openwetterTest={state,setTimeIndex,setMode,selectMetric,zoom,renderMap,drawChart};
