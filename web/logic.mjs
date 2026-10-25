/* Pure application logic; intentionally independent of the browser for unit tests. */
export const MODELS = Object.freeze({
  icon_d2: {label: 'ICON-D2', subtitle: 'Germany + neighbours · ~2 km', hours: 48},
  icon_eu: {label: 'ICON-EU', subtitle: 'Europe · ~7 km', hours: 120},
  icon_global: {label: 'ICON Global', subtitle: 'Worldwide · ~11 km', hours: 120},
});
export const VARIABLES = Object.freeze({
  temperature: {key: 'temperature_2m', unit: '°C', name: 'Temperature', color: '#ffb76b', chart: 'line'},
  precipitation: {key: 'precipitation', unit: 'mm', name: 'Precipitation', color: '#56bffe', chart: 'bar'},
  wind: {key: 'wind_speed_10m', unit: 'km/h', name: 'Wind', color: '#86e4bd', chart: 'line'},
  cloud: {key: 'cloud_cover', unit: '%', name: 'Clouds', color: '#ddd2ef', chart: 'area'},
});
export const HOURLY = 'temperature_2m,precipitation,wind_speed_10m,wind_direction_10m,cloud_cover,relative_humidity_2m,pressure_msl';
export const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
export const wrappedLongitude = (lon) => ((lon+180)%360+360)%360-180;
export const clampLatitude = lat => clamp(lat,-85.05112878,85.05112878);
export const hourFloor = seconds => Math.floor(seconds/3600)*3600;
export const MODEL_IDS = Object.freeze(Object.keys(MODELS));
export const DEFAULT_PLACES = Object.freeze([
  {name:'Dortmund, Germany',latitude:51.5142,longitude:7.4653},
  {name:'Rostock, Germany',latitude:54.0924,longitude:12.0991},
  {name:'Düsseldorf, Germany',latitude:51.2277,longitude:6.7735},
]);

export function forecastURL({latitude,longitude,model}) {
  if(!Object.hasOwn(MODELS,model))throw new RangeError(`Unknown model: ${model}`);
  if(!Number.isFinite(latitude)||!Number.isFinite(longitude)||Math.abs(latitude)>90||Math.abs(longitude)>180)throw new RangeError('Invalid coordinates');
  const params=new URLSearchParams({latitude:String(latitude),longitude:String(longitude),hourly:HOURLY,
    models:model,forecast_hours:String(MODELS[model].hours),timezone:'auto',timeformat:'unixtime'});
  return `https://api.open-meteo.com/v1/dwd-icon?${params}`;
}
export function parseForecast(data) {
  if(!data||data.error||!data.hourly||!Array.isArray(data.hourly.time))throw new Error(data?.reason||'Missing hourly forecast');
  const times=data.hourly.time;
  if(!times.length||times.some(t=>!Number.isFinite(t)))throw new Error('Malformed forecast timestamps');
  for(let i=1;i<times.length;i++)if(times[i]<=times[i-1])throw new Error('Forecast timestamps are not increasing');
  for(const {key} of Object.values(VARIABLES))if(!Array.isArray(data.hourly[key])||data.hourly[key].length!==times.length)throw new Error(`Missing ${key} data`);
  return data;
}
/** First index of the most recent observed radar history window.
 * Manifest entries are sorted by UTC observation time, not a nominal
 * number of 5-minute positions: missing radar scans are not fabricated.
 */
export function radarHistoryStartIndex(frames,hours=6){
  if(!Array.isArray(frames)||!frames.length)return 0;
  if(!Number.isFinite(hours)||hours<=0)throw new RangeError('Invalid radar history length');
  const end=frames.at(-1).time,bound=end-hours*3600;
  const first=frames.findIndex(f=>f.time>=bound);
  return first<0?frames.length-1:first;
}
export function nearestIndex(timestamps,targetSeconds) {
  if(!timestamps?.length)return -1;
  let lo=0,hi=timestamps.length-1;
  while(lo<hi){const m=(lo+hi)>>1;if(timestamps[m]<targetSeconds)lo=m+1;else hi=m;}
  if(lo>0&&Math.abs(timestamps[lo-1]-targetSeconds)<=Math.abs(timestamps[lo]-targetSeconds))return lo-1;
  return lo;
}
export function valueAtTime(forecast,metric,timestamp,{toleranceSeconds=1800}={}){
  if(!forecast||!Object.hasOwn(VARIABLES,metric)||!Number.isFinite(timestamp))return null;
  const index=nearestIndex(forecast.hourly.time,timestamp);
  if(index<0||Math.abs(forecast.hourly.time[index]-timestamp)>toleranceSeconds)return null;
  const value=forecast.hourly[VARIABLES[metric].key][index];
  return typeof value==='number'&&Number.isFinite(value)?value:null;
}
export function valueAt(forecast,metric,index){
  if(!forecast||!Object.hasOwn(VARIABLES,metric))return null;
  const value=forecast.hourly?.[VARIABLES[metric].key]?.[index];
  return typeof value==='number'&&Number.isFinite(value)?value:null;
}
export function axisLimits(values,metric){
  const valid=values.filter(v=>typeof v==='number'&&Number.isFinite(v));
  if(!valid.length)return {min:0,max:1};
  let min=Math.min(...valid),max=Math.max(...valid);
  if(metric==='precipitation')return {min:0,max:Math.max(.25,max*1.12)};
  if(metric==='cloud')return {min:0,max:100};
  if(max-min<.01){min-=1;max+=1;}
  else{const pad=(max-min)*.1;min-=pad;max+=pad;}
  return {min,max};
}

export function pickGestureAxis(dx,dy,threshold=7){
  if(Math.hypot(dx,dy)<threshold)return null;
  return Math.abs(dy)>Math.abs(dx)?'vertical':'horizontal';
}
// Movement in the locked direction is absolute from pointer-down, so reversal is continuous.
// Right or up is later. Speeds are forecast HOURS per 100 screen pixels.
export function scrubTimestamp(startSeconds,dx,dy,axis,{horizontalHours=4,verticalHours=24,
  stepSeconds=3600,minSeconds=-Infinity,maxSeconds=Infinity}={}){
  if(axis!=='horizontal'&&axis!=='vertical')return startSeconds;
  if(!Number.isFinite(startSeconds)||stepSeconds<=0)throw new RangeError('Invalid time parameters');
  const speed=axis==='vertical'?verticalHours:horizontalHours;
  const movement=axis==='vertical'?-dy:dx;
  return clamp(Math.round((startSeconds+movement/100*speed*3600)/stepSeconds)*stepSeconds,minSeconds,maxSeconds);
}
export function forecastBounds(anchor,horizonHours){
  if(!Number.isFinite(anchor)||![48,120].includes(horizonHours))throw new RangeError('Invalid forecast window');
  return {min:anchor,max:anchor+horizonHours*3600};
}
export function timelinePosition(time,min,max){return max>min?clamp((time-min)/(max-min),0,1):0;}
export function placeKey({latitude,longitude}){return `${latitude.toFixed(3)},${longitude.toFixed(3)}`;}

export function safeRadarMetadata(payload){
  try{
    const domain=new URL(payload?.host);
    if(domain.protocol!=='https:'||!(domain.hostname==='rainviewer.com'||domain.hostname.endsWith('.rainviewer.com')))throw new Error('Invalid host');
    const frames=payload?.radar?.past;
    if(!Array.isArray(frames)||!frames.length)throw new Error('No radar frames');
    const clean=frames.filter(f=>Number.isSafeInteger(f.time)&&/^\/v2\/radar\/\d+$/.test(f.path));
    if(!clean.length)throw new Error('No valid radar frames');
    return {host:domain.origin,frames:clean.sort((a,b)=>a.time-b.time)};
  }catch{throw new Error('Invalid radar response');}
}
export function radarTileURL(radar,frameIndex,z,x,y){
  const frame=radar.frames[clamp(frameIndex,0,radar.frames.length-1)];
  const rz=clamp(Math.floor(z),0,7),max=2**rz;
  if(!frame||!Number.isInteger(x)||!Number.isInteger(y)||y<0||y>=max)return null;
  return `${radar.host}${frame.path}/256/${rz}/${((x%max)+max)%max}/${y}/2/1_1.png`;
}
export function mercator(lat,lon,zoom){
  const scale=256*2**zoom,theta=clampLatitude(lat)*Math.PI/180;
  return {x:(wrappedLongitude(lon)+180)/360*scale,y:(1-Math.log(Math.tan(theta)+1/Math.cos(theta))/Math.PI)/2*scale};
}
export function unmercator(x,y,zoom){
  const scale=256*2**zoom;
  return {lon:wrappedLongitude(x/scale*360-180),lat:Math.atan(Math.sinh(Math.PI*(1-2*y/scale)))*180/Math.PI};
}

// Render public DWD Meteosat imagery as transparent XYZ tiles in Web Mercator.
// This is an OBSERVATION overlay, not ICON forecast cloud cover.
export const DWD_SATELLITE_CLOUDS = 'dwd:Satellite_meteosat_1km_euat_rgb_clouds_day_and_night';
export function dwdWmsTileURL(layer, zoom, x, y) {
  if (layer !== DWD_SATELLITE_CLOUDS) throw new Error('Unsupported DWD WMS layer');
  if (!Number.isInteger(zoom) || zoom < 0 || zoom > 14 ||
      !Number.isInteger(x) || !Number.isInteger(y) || y < 0 || y >= 2**zoom)
    throw new Error('Invalid tile position');
  const count=2**zoom, xx=((x%count)+count)%count;
  const extent=20037508.342789244, tileSpan=2*extent/count;
  const left=-extent+xx*tileSpan, right=left+tileSpan,
    top=extent-y*tileSpan, bottom=top-tileSpan;
  const params=new URLSearchParams({
    SERVICE:'WMS',VERSION:'1.1.1',REQUEST:'GetMap',LAYERS:layer,STYLES:'',
    FORMAT:'image/png',TRANSPARENT:'TRUE',SRS:'EPSG:3857',
    BBOX:[left,bottom,right,top].join(','),WIDTH:'256',HEIGHT:'256',
  });
  return `https://maps.dwd.de/geoserver/dwd/wms?${params.toString()}`;
}
