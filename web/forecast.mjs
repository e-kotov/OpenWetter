/* Point forecast for the meteogram: DWD ICON-D2, ICON-EU and ICON Global from
 * one Open-Meteo request, stitched finest-first. The source of every hour is
 * kept, so the charts can mark where the forecast switches model. Pure logic.
 */
export const POINT_MODELS=Object.freeze(['icon_d2','icon_eu','icon_global']);
export const MODEL_LABELS=Object.freeze({icon_d2:'ICON-D2',icon_eu:'ICON-EU',icon_global:'ICON'});
export const PRESSURE_LEVELS=Object.freeze([1000,975,950,925,900,850,800,700,600,500,400,300,250,200]);
export const POINT_VARS=Object.freeze(['temperature_2m','dew_point_2m','precipitation','snowfall','cloud_cover',
  'wind_speed_10m','wind_gusts_10m','wind_direction_10m','pressure_msl','relative_humidity_2m','is_day',
  ...PRESSURE_LEVELS.map(p=>`cloud_cover_${p}hPa`)]);
const OM_BASE='https://api.open-meteo.com/v1/dwd-icon';
const PREVIOUS_BASE='https://previous-runs-api.open-meteo.com/v1/forecast';

function checkPoint(latitude,longitude){
  if(!Number.isFinite(latitude)||!Number.isFinite(longitude)||Math.abs(latitude)>90||Math.abs(longitude)>180)
    throw new RangeError('Invalid coordinates');
}
/** 7 forecast days plus yesterday, so "today from midnight" is always covered. */
export function pointForecastURL({latitude,longitude}){
  checkPoint(latitude,longitude);
  const p=new URLSearchParams({latitude:latitude.toFixed(4),longitude:longitude.toFixed(4),hourly:POINT_VARS.join(','),
    models:POINT_MODELS.join(','),forecast_days:'7',past_days:'1',timezone:'auto',timeformat:'unixtime'});
  return `${OM_BASE}?${p}`;
}
/** Yesterday's run for the same hours: the "change since the previous run" band. */
export function previousRunURL({latitude,longitude}){
  checkPoint(latitude,longitude);
  const p=new URLSearchParams({latitude:latitude.toFixed(4),longitude:longitude.toFixed(4),
    hourly:'temperature_2m,temperature_2m_previous_day1',models:'icon_seamless',forecast_days:'7',past_days:'1',
    timezone:'auto',timeformat:'unixtime'});
  return `${PREVIOUS_BASE}?${p}`;
}
const finite=v=>typeof v==='number'&&Number.isFinite(v);
/** Parse the multi-model response into per-model series plus one stitched
 * series (finest model with data wins, per hour). */
export function parsePointForecast(json){
  const h=json?.hourly;
  if(!h||!Array.isArray(h.time)||!h.time.length)throw new Error(json?.reason||'Missing hourly forecast');
  const time=h.time;
  for(let i=1;i<time.length;i++)if(!(time[i]>time[i-1]))throw new Error('Forecast timestamps are not increasing');
  const models={};
  for(const model of POINT_MODELS){
    const series={};let any=false;
    for(const v of POINT_VARS){
      const arr=h[`${v}_${model}`]??(POINT_MODELS.length===1?h[v]:undefined);
      series[v]=Array.isArray(arr)&&arr.length===time.length?arr.map(x=>finite(x)?x:null):Array(time.length).fill(null);
      if(series[v].some(x=>x!==null))any=true;
    }
    if(any)models[model]=series;
  }
  if(!Object.keys(models).length)throw new Error('No ICON model data for this place');
  const source=time.map((_,i)=>POINT_MODELS.find(m=>finite(models[m]?.temperature_2m[i]))??null);
  const stitched={};
  for(const v of POINT_VARS)stitched[v]=time.map((_,i)=>{
    const first=source[i];if(!first)return null;
    for(const m of POINT_MODELS.slice(POINT_MODELS.indexOf(first))){const x=models[m]?.[v][i];if(finite(x))return x;}
    return null;
  });
  const transitions=[];
  for(let i=1;i<time.length;i++)if(source[i]&&source[i-1]&&source[i]!==source[i-1])
    transitions.push({time:time[i],from:source[i-1],to:source[i]});
  return {timezone:json.timezone||'UTC',latitude:json.latitude,longitude:json.longitude,time,models,
    series:stitched,source,transitions};
}
/** Add the previous-run temperature (same timestamps) to a parsed forecast. */
export function attachPreviousRun(forecast,json){
  const h=json?.hourly;
  if(!forecast||!h||!Array.isArray(h.time))return forecast;
  const byTime=new Map(h.time.map((t,i)=>[t,h.temperature_2m_previous_day1?.[i]]));
  forecast.series.previous_temperature_2m=forecast.time.map(t=>finite(byTime.get(t))?byTime.get(t):null);
  return forecast;
}
/** Linear interpolation of one stitched variable at `time` (seconds). */
export function seriesValueAt(forecast,key,time,{angle=false}={}){
  const t=forecast?.time,v=forecast?.series?.[key];
  if(!t?.length||!v||!Number.isFinite(time))return null;
  if(time<=t[0])return v[0];
  if(time>=t.at(-1))return v.at(-1);
  let lo=0,hi=t.length-1;
  while(hi-lo>1){const m=(lo+hi)>>1;if(t[m]<=time)lo=m;else hi=m;}
  const a=v[lo],b=v[hi];
  if(!finite(a)||!finite(b))return finite(a)&&time-t[lo]<1800?a:finite(b)&&t[hi]-time<1800?b:null;
  const f=(time-t[lo])/(t[hi]-t[lo]);
  if(angle){const d=((b-a+540)%360)-180;return (a+d*f+360)%360;}
  return a+(b-a)*f;
}
/* ---------- local days (the forecast place's time zone) ---------- */
const offsetCache=new Map(),offsetMemo=new Map();
/** UTC offset in seconds of `zone` at instant `seconds`. Offsets change only
 * on quarter-hour boundaries, so results are memoised per 15 minutes
 * (formatToParts is slow and this runs many times per scrub frame). */
export function zoneOffset(seconds,zone){
  const key=zone+'|'+Math.floor(seconds/900),hit=offsetMemo.get(key);
  if(hit!==undefined)return hit;
  const value=computeOffset(Math.floor(seconds/900)*900,zone);
  if(offsetMemo.size>4000)offsetMemo.clear();
  offsetMemo.set(key,value);return value;
}
function computeOffset(seconds,zone){
  let fmt=offsetCache.get(zone);
  if(!fmt){fmt=new Intl.DateTimeFormat('en-US',{timeZone:zone,hourCycle:'h23',year:'numeric',month:'numeric',day:'numeric',
    hour:'numeric',minute:'numeric',second:'numeric'});offsetCache.set(zone,fmt);}
  const p=Object.fromEntries(fmt.formatToParts(new Date(seconds*1000)).map(x=>[x.type,Number(x.value)]));
  const asUTC=Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute,p.second)/1000;
  return Math.round((asUTC-Math.floor(seconds))/60)*60;
}
/** Local midnight (as a UTC instant) of the day containing `seconds`. */
export function localMidnight(seconds,zone){
  const local=seconds+zoneOffset(seconds,zone);
  const midnightLocal=Math.floor(local/86400)*86400;
  // Re-evaluate the offset at the candidate midnight (DST changes overnight).
  let guess=midnightLocal-zoneOffset(seconds,zone);
  guess=midnightLocal-zoneOffset(guess,zone);
  return guess;
}
/** The 7 local days shown in the charts, starting today at midnight. */
export function chartDays(now,zone,count=7){
  const days=[];let start=localMidnight(now,zone);
  for(let i=0;i<count;i++){
    const next=localMidnight(start+36*3600,zone);
    days.push({start,end:next});start=next;
  }
  return days;
}
/** Daily maximum and minimum of the stitched temperature per chart day. */
export function dailyExtremes(forecast,days){
  return days.map(({start,end})=>{
    const values=forecast?forecast.time.flatMap((t,i)=>t>=start&&t<end&&finite(forecast.series.temperature_2m[i])?[forecast.series.temperature_2m[i]]:[]):[];
    return values.length?{start,end,max:Math.max(...values),min:Math.min(...values)}:{start,end,max:null,min:null};
  });
}
