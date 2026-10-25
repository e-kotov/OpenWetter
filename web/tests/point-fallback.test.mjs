import assert from 'node:assert/strict';
import {test} from 'node:test';
import {composeIconD2Forecast} from '../native-fields.mjs';
import {parseForecast,valueAtTime} from '../logic.mjs';

const start=1792933200;
const time=Array.from({length:9},(_,i)=>start+i*900);
const series={time,temperature_2m:time.map((_,i)=>10+i),
  precipitation:time.map((_,i)=>i/10),cloud_cover:time.map((_,i)=>i*10)};

test('D2 temperature/precipitation/cloud graphs render without a point-API response',()=>{
  const f=composeIconD2Forecast(series,null,{fetchedAt:1234567});
  assert.equal(f.gridOnly,true);
  assert.equal(f.fromRawGrid,true);
  assert.equal(f.timezone,'Europe/Berlin');
  assert.equal(f.hourly.wind_speed_10m.length,9);
  assert.ok(f.hourly.wind_speed_10m.every(x=>x===null));
  assert.equal(f.hourly.temperature_2m[5],15);
  assert.equal(f.hourly.precipitation[5],.5);
  assert.equal(f.hourly.cloud_cover[5],50);
  assert.equal(valueAtTime(f,'temperature',time[3]),13);
  assert.equal(valueAtTime(f,'cloud',time[2]),20);
  assert.equal(valueAtTime(f,'precipitation',time[2]),.2);
  assert.equal(valueAtTime(f,'wind',time[3]),null);
  assert.equal(parseForecast(f),f,'Grid-only D2 forecast satisfies the same graph schema');
});
test('wind data enriches D2 graphs without overwriting native rain/clouds/temp',()=>{
  const point={timezone:'Europe/Berlin',fetchedAt:567890, hourly:{
    time:[start,start+3600,start+7200],
    temperature_2m:[-20,-20,-20],precipitation:[99,99,99],cloud_cover:[0,0,0],
    wind_speed_10m:[12,20,28],wind_direction_10m:[180,180,180],
    relative_humidity_2m:[50,60,70],pressure_msl:[1013,1013,1012]
  }};
  const f=composeIconD2Forecast(series,point);
  assert.equal(f.gridOnly,false);
  assert.equal(f.rawPointForecast,point);
  assert.equal(f.hourly.wind_speed_10m[1],14);
  assert.equal(f.hourly.wind_speed_10m[8],28);
  assert.equal(f.hourly.temperature_2m[1],11);
  assert.equal(f.hourly.precipitation[1],.1);
  assert.equal(f.hourly.cloud_cover[1],10);
  assert.equal(parseForecast(f),f);
});
test('malformed grid inputs do not silently invent a forecast',()=>{
  assert.throws(()=>composeIconD2Forecast(null),/Invalid/);
  assert.throws(()=>composeIconD2Forecast({...series,precipitation:[]}),/Invalid/);
});
