import test from 'node:test';
import assert from 'node:assert/strict';
import {POINT_MODELS,POINT_VARS,PRESSURE_LEVELS,pointForecastURL,previousRunURL,parsePointForecast,attachPreviousRun,
  seriesValueAt,zoneOffset,localMidnight,chartDays,dailyExtremes} from '../forecast.mjs';

/** Open-Meteo multi-model shape: every variable suffixed with the model. ICON-D2
 * has 4 hours, ICON-EU 6, ICON Global 8 (nulls after each model's end). */
function response(){
  const t0=1793919600,time=Array.from({length:8},(_,i)=>t0+i*3600),len={icon_d2:4,icon_eu:6,icon_global:8};
  const base={icon_d2:10,icon_eu:20,icon_global:30},hourly={time};
  for(const m of POINT_MODELS)for(const v of POINT_VARS)
    hourly[`${v}_${m}`]=time.map((_,i)=>i<len[m]?base[m]+i:null);
  hourly.wind_gusts_10m_icon_d2=time.map(()=>null); // a variable ICON-D2 lacks
  return {latitude:51.5,longitude:7.5,timezone:'Europe/Berlin',hourly};
}
test('One request covers all three ICON models, 7 days plus yesterday, and cloud on pressure levels',()=>{
  const u=new URL(pointForecastURL({latitude:51.5142,longitude:7.4653}));
  assert.equal(u.hostname,'api.open-meteo.com');assert.equal(u.pathname,'/v1/dwd-icon');
  assert.equal(u.searchParams.get('models'),'icon_d2,icon_eu,icon_global');
  assert.equal(u.searchParams.get('forecast_days'),'7');assert.equal(u.searchParams.get('past_days'),'1');
  for(const p of PRESSURE_LEVELS)assert.ok(u.searchParams.get('hourly').includes(`cloud_cover_${p}hPa`));
  const prev=new URL(previousRunURL({latitude:51.5,longitude:7.5}));
  assert.equal(prev.hostname,'previous-runs-api.open-meteo.com');
  assert.ok(prev.searchParams.get('hourly').includes('temperature_2m_previous_day1'));
  assert.throws(()=>pointForecastURL({latitude:95,longitude:0}));
});
test('Stitching: finest model wins per hour, gaps fall back, transitions are recorded',()=>{
  const f=parsePointForecast(response());
  assert.deepEqual(f.source,['icon_d2','icon_d2','icon_d2','icon_d2','icon_eu','icon_eu','icon_global','icon_global']);
  assert.deepEqual(f.series.temperature_2m,[10,11,12,13,24,25,36,37]);
  assert.equal(f.series.wind_gusts_10m[0],20,'missing ICON-D2 gusts come from ICON-EU');
  assert.deepEqual(f.transitions.map(t=>[t.from,t.to]),[['icon_d2','icon_eu'],['icon_eu','icon_global']]);
  assert.equal(f.transitions[0].time,f.time[4]);
  assert.equal(Object.keys(f.models).length,3);
});
test('Rejects malformed responses',()=>{
  assert.throws(()=>parsePointForecast({error:true,reason:'bad'}),/bad/);
  const r=response();r.hourly.time[3]=r.hourly.time[2];assert.throws(()=>parsePointForecast(r),/increasing/);
  const empty=response();for(const k of Object.keys(empty.hourly))if(k!=='time')empty.hourly[k]=empty.hourly[k].map(()=>null);
  assert.throws(()=>parsePointForecast(empty),/No ICON/);
});
test('Previous run attaches by timestamp; interpolation, wind-direction wrap and gaps',()=>{
  const f=parsePointForecast(response());
  attachPreviousRun(f,{hourly:{time:[f.time[1],f.time[2]],temperature_2m_previous_day1:[5,6]}});
  assert.deepEqual(f.series.previous_temperature_2m.slice(0,4),[null,5,6,null]);
  assert.equal(seriesValueAt(f,'temperature_2m',f.time[0]+1800),10.5);
  f.series.wind_direction_10m[0]=350;f.series.wind_direction_10m[1]=10;
  assert.equal(Math.round(seriesValueAt(f,'wind_direction_10m',f.time[0]+1800,{angle:true})),0);
  f.series.temperature_2m[2]=null;
  assert.equal(seriesValueAt(f,'temperature_2m',f.time[2]-600),null);
  assert.equal(seriesValueAt(f,'temperature_2m',f.time[1]+600),11,'near a known value it is used');
});
test('Local days follow the place time zone, including the DST change',()=>{
  assert.equal(zoneOffset(Date.UTC(2026,6,1)/1000,'Europe/Berlin'),7200);
  assert.equal(zoneOffset(Date.UTC(2026,11,1)/1000,'Europe/Berlin'),3600);
  // 2026-10-25: clocks go back, the day has 25 hours.
  const mid=localMidnight(Date.UTC(2026,9,25,12)/1000,'Europe/Berlin');
  assert.equal(mid,Date.UTC(2026,9,24,22)/1000);
  const days=chartDays(Date.UTC(2026,9,24,15)/1000,'Europe/Berlin');
  assert.equal(days.length,7);
  assert.equal(days[1].end-days[1].start,25*3600);
  for(let i=1;i<7;i++)assert.equal(days[i].start,days[i-1].end);
  const nyc=chartDays(Date.UTC(2026,10,6,12)/1000,'America/New_York');
  assert.equal(nyc[0].start,Date.UTC(2026,10,6,5)/1000);
});
test('Daily maximum and minimum per chart day',()=>{
  const f=parsePointForecast(response());
  const ex=dailyExtremes(f,[{start:f.time[0],end:f.time[4]},{start:f.time[4],end:f.time[8-1]+3600},{start:0,end:1}]);
  assert.deepEqual(ex.map(e=>[e.max,e.min]),[[13,10],[37,24],[null,null]]);
});
