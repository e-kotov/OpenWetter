import test from 'node:test';
import assert from 'node:assert/strict';
import { MODELS, VARIABLES, clamp, wrappedLongitude, forecastURL, parseForecast,
  nearestIndex, safeRadarMetadata, radarTileURL, mercator, unmercator, axisLimits, valueAt } from '../logic.mjs';

test('all supported models are selectable with exact expected Open-Meteo models parameter',()=>{
  for(const model of Object.keys(MODELS)){
    const url = new URL(forecastURL({latitude:51.5142,longitude:7.4653,model}));
    assert.equal(url.hostname,'api.open-meteo.com');
    assert.equal(url.pathname,'/v1/dwd-icon');
    assert.equal(url.searchParams.get('models'),model);
    assert.match(url.searchParams.get('hourly'),/wind_speed_10m/);
    assert.equal(url.searchParams.get('timeformat'),'unixtime');
    assert.equal(url.searchParams.get('forecast_hours'), model==='icon_d2'?'48':'120');
  }
});
test('validates model names and coordinates',()=>{
  assert.throws(()=>forecastURL({latitude:100,longitude:1,model:'icon_d2'}),RangeError);
  assert.throws(()=>forecastURL({latitude:0,longitude:1,model:'gfs'}),RangeError);
  assert.throws(()=>forecastURL({latitude:NaN,longitude:1,model:'icon_d2'}),RangeError);
});
test('forecast validation detects API errors and missing variables',()=>{
  assert.throws(()=>parseForecast({error:true,reason:'unknown model'}),/unknown model/);
  assert.throws(()=>parseForecast({hourly:{time:[100],temperature_2m:[3]}}),/Missing precipitation/);
  const data={hourly:{time:[100,200]}};
  for(const {key} of Object.values(VARIABLES))data.hourly[key]=[3,4];
  assert.equal(parseForecast(data),data);
  assert.equal(valueAt(data,'temperature',1),4);
  assert.equal(valueAt(data,'wind',5),null);
});
test('selects nearest timestamp, including before and after the range',()=>{
  const t=[100,200,300,400];
  assert.equal(nearestIndex(t,50),0);
  assert.equal(nearestIndex(t,211),1);
  assert.equal(nearestIndex(t,999),3);
  assert.equal(nearestIndex([],200),0);
});
test('Mercator round-trip works across hemispheres and dateline',()=>{
  for(const [lat,lon] of [[51.5142,7.4653],[-37.8136,144.9631],[42,-179.8],[10,179.99],[0,0]]){
    const point=mercator(lat,lon,9),out=unmercator(point.x,point.y,9);
    assert.ok(Math.abs(out.lat-lat)<1e-7,`${lat}: ${out.lat}`);
    assert.ok(Math.abs(out.lon-lon)<1e-7,`${lon}: ${out.lon}`);
  }
  assert.equal(wrappedLongitude(181),-179);
  assert.equal(clamp(7,1,3),3);
});
test('radar URLs have zoom cap, wrapping and strict host validation',()=>{
  const meta=safeRadarMetadata({host:'https://tilecache.rainviewer.com',radar:{past:[{time:1234567890,path:'/v2/radar/1234567890'}]}});
  assert.equal(radarTileURL(meta,0,9,135,8),'https://tilecache.rainviewer.com/v2/radar/1234567890/256/7/7/8/2/1_1.png');
  assert.equal(radarTileURL(meta,0,7,2,128),null);
  assert.throws(()=>safeRadarMetadata({host:'https://tilecache.rainviewer.com.evil.example',radar:{past:[{time:123,path:'/v2/radar/123'}]}}),/Invalid radar/);
  assert.throws(()=>safeRadarMetadata({host:'https://tilecache.rainviewer.com',radar:{past:[{time:123,path:'//evil.com'}]}}),/Invalid radar/);
});
test('chart axes correctly cope with constant values and nulls',()=>{
  assert.deepEqual(axisLimits([null,null],'wind'),{min:0,max:1});
  assert.deepEqual(axisLimits([0,0,0],'temperature'),{min:-1,max:1});
  assert.equal(axisLimits([3,70],'cloud').max,100);
  assert.equal(axisLimits([3,70],'cloud').min,0);
});
