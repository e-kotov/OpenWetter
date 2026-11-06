import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MODELS, MODEL_IDS, forecastURL, parseForecast, nearestIndex, valueAtTime,
  axisLimits, hourFloor, pickGestureAxis, scrubTimestamp, forecastBounds,
  timelinePosition, placeKey, mercator, unmercator, radarTileURL, safeRadarMetadata,
  radarHistoryStartIndex,
  DWD_SATELLITE_CLOUDS, dwdWmsTileURL,
} from '../logic.mjs';

function data(){
  const base=hourFloor(Date.now()/1000);
  return {timezone:'Europe/Berlin',hourly:{time:[base,base+3600,base+7200],
    temperature_2m:[12,14,16],precipitation:[.1,0,2],wind_speed_10m:[5,10,8],cloud_cover:[30,60,90]}};
}
test('Only three German DWD ICON models, all with usable API URLs',()=>{
  assert.deepEqual(MODEL_IDS,['icon_d2','icon_eu','icon_global']);
  for(const model of MODEL_IDS){
    const u=new URL(forecastURL({latitude:51.51,longitude:7.47,model}));
    assert.equal(u.hostname,'api.open-meteo.com');
    assert.equal(u.pathname,'/v1/dwd-icon');
    assert.equal(u.searchParams.get('models'),model);
    assert.equal(Number(u.searchParams.get('forecast_hours')),MODELS[model].hours);
    assert.equal(u.searchParams.get('past_hours'),'9');
  }
  assert.throws(()=>forecastURL({latitude:200,longitude:7,model:'icon_d2'}));
  assert.throws(()=>forecastURL({latitude:52,longitude:7,model:'noaa'}));
});
test('Forecast integrity requires ordered times and all plotted fields',()=>{
  assert.equal(parseForecast(data()).hourly.time.length,3);
  const broken=data();broken.hourly.time[1]=broken.hourly.time[0];
  assert.throws(()=>parseForecast(broken),/not increasing/);
  delete broken.hourly.wind_speed_10m;
  assert.throws(()=>parseForecast(broken));
});
test('All model graphs use the same absolute timestamp; no false extrapolation',()=>{
  const d=data(),t=d.hourly.time[1];
  assert.equal(nearestIndex(d.hourly.time,t),1);
  assert.equal(valueAtTime(d,'temperature',t),14);
  assert.equal(valueAtTime(d,'precipitation',t+900),0);
  assert.equal(valueAtTime(d,'temperature',t+2700),16);
  assert.equal(valueAtTime(d,'temperature',t+5401),null);
  assert.equal(valueAtTime(d,'temperature',t+86400),null);
  assert.equal(valueAtTime(null,'temperature',t),null);
});
test('Vertical movement is faster; horizontal is finer at default settings',()=>{
  const start=hourFloor(1800000000),options={horizontalHours:4,verticalHours:24};
  const slow=scrubTimestamp(start,100,0,'horizontal',options);
  const fast=scrubTimestamp(start,0,-100,'vertical',options);
  assert.equal((slow-start)/3600,4);
  assert.equal((fast-start)/3600,24);
  assert.equal(scrubTimestamp(start,-100,0,'horizontal',options),start-4*3600);
  assert.equal(scrubTimestamp(start,0,100,'vertical',options),start-24*3600);
});
test('Gesture locks by dominant movement and ignores ambiguous tap',()=>{
  assert.equal(pickGestureAxis(0,1),null);
  assert.equal(pickGestureAxis(25,3),'horizontal');
  assert.equal(pickGestureAxis(3,-25),'vertical');
  assert.equal(pickGestureAxis(8,8),'horizontal');
});
test('Gesture sensitivity values change actual time increments, with safe clamping and reversal',()=>{
  const start=hourFloor(1800000000),bounds={minSeconds:start,maxSeconds:start+48*3600,stepSeconds:3600};
  assert.equal((scrubTimestamp(start,100,0,'horizontal',{...bounds,horizontalHours:12})-start)/3600,12);
  assert.equal((scrubTimestamp(start,0,-100,'vertical',{...bounds,verticalHours:36})-start)/3600,36);
  assert.equal(scrubTimestamp(start,0,-1000,'vertical',{...bounds,verticalHours:36}),bounds.maxSeconds);
  assert.equal(scrubTimestamp(start,90,0,'horizontal',{...bounds,horizontalHours:4}),start+4*3600);
  assert.equal(scrubTimestamp(start,0,0,'horizontal',{...bounds,horizontalHours:4}),start);
});
test('Shared 48-hour and five-day timeline geometry',()=>{
  const t=hourFloor(Date.now()/1000);
  assert.deepEqual(forecastBounds(t,48),{min:t,max:t+48*3600});
  assert.deepEqual(forecastBounds(t,120),{min:t,max:t+120*3600});
  assert.equal(timelinePosition(t+24*3600,t,t+48*3600),.5);
  assert.equal(timelinePosition(t+24*3600,t,t+120*3600),.2);
  assert.equal(timelinePosition(t-300,t,t+48*3600),0);
  assert.throws(()=>forecastBounds(t,75));
});
test('Forecast axis ranges are stable, including all-zero precipitation',()=>{
  assert.ok(axisLimits([10,10,10],'temperature').max>axisLimits([10,10,10],'temperature').min);
  assert.equal(axisLimits([0,0,0],'precipitation').min,0);
  assert.equal(axisLimits([20,30,40],'cloud').max,100);
  assert.equal(axisLimits([null,null],'temperature').max,1);
});
test('Location IDs and Mercator map coordinates are stable',()=>{
  assert.equal(placeKey({latitude:51.51011,longitude:7.46533}),'51.510,7.465');
  const xy=mercator(51.51,7.465,7),ll=unmercator(xy.x,xy.y,7);
  assert.ok(Math.abs(ll.lat-51.51)<.0001);
  assert.ok(Math.abs(ll.lon-7.465)<.0001);
});
test('Radar hosts are validated, frames are sorted and tile requests bounded',()=>{
  const meta=safeRadarMetadata({host:'https://tilecache.rainviewer.com',radar:{past:[
    {time:1760000600,path:'/v2/radar/1760000600'},
    {time:1760000000,path:'/v2/radar/1760000000'}
  ]}});
  assert.equal(meta.frames[0].time,1760000000);
  assert.match(radarTileURL(meta,0,7,24,62),/^https:\/\/tilecache\.rainviewer\.com/);
  assert.equal(radarTileURL(meta,0,7,2,-1),null);
  assert.throws(()=>safeRadarMetadata({host:'https://evil.test',radar:{past:[]}}));
});

test('Meteosat overlay requests DWD transparent WMS tiles with correct Web-Mercator boxes',()=>{
  const u=new URL(dwdWmsTileURL(DWD_SATELLITE_CLOUDS,0,0,0));
  assert.equal(u.hostname,'maps.dwd.de');
  assert.equal(u.searchParams.get('LAYERS'),DWD_SATELLITE_CLOUDS);
  assert.equal(u.searchParams.get('TRANSPARENT'),'TRUE');
  assert.equal(u.searchParams.get('FORMAT'),'image/png');
  assert.equal(u.searchParams.get('SRS'),'EPSG:3857');
  assert.equal(u.searchParams.get('REQUEST'),'GetMap');
  const bbox=u.searchParams.get('BBOX').split(',').map(Number);
  assert.ok(bbox[0]<-20037508&&bbox[2]>20037508);
  assert.ok(bbox[1]<-20037508&&bbox[3]>20037508);
  assert.equal(dwdWmsTileURL(DWD_SATELLITE_CLOUDS,4,0,2),
               dwdWmsTileURL(DWD_SATELLITE_CLOUDS,4,16,2));
  assert.throws(()=>dwdWmsTileURL('dwd:OtherLayer',4,1,1),/Unsupported/);
  assert.throws(()=>dwdWmsTileURL(DWD_SATELLITE_CLOUDS,4,1,-1),/Invalid/);
});

test('DWD radar timeline offers six real hours and a two-hour focus window without inventing frames',()=>{
  const latest=1792942200,frames=Array.from({length:73},(_,i)=>({time:latest-360*60+i*300}));
  assert.equal(radarHistoryStartIndex(frames,6),0);
  assert.equal(radarHistoryStartIndex(frames,2),48);
  assert.equal(frames.length,73);
  assert.equal(frames.at(-1).time-frames[0].time,6*3600);
  assert.equal(radarHistoryStartIndex([],6),0);
  const withGap=frames.filter((_,i)=>i!==50&&i!==51);
  assert.equal(withGap[radarHistoryStartIndex(withGap,2)].time,latest-2*3600);
  assert.throws(()=>radarHistoryStartIndex(frames,0),RangeError);
});
