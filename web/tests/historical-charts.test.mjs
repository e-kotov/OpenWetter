import test from 'node:test';
import assert from 'node:assert/strict';
import {splitModelHistory,chartSeries,ICON_HISTORY_HOURS} from '../historical-charts.mjs';
const anchor=1800000000-anchorRemainder();
function anchorRemainder(){return 1800000000%3600;}
function mock(){
 const time=[-10,-9,-6,-3,-1,0,1,2].map(h=>anchor+h*3600);
 return {timezone:'Europe/Berlin',hourly:{
  time,temperature_2m:[1,2,3,4,5,6,7,8],
  precipitation:[0,0.1,0.4,0.2,0,1,2,3],
  wind_speed_10m:[5,6,7,8,9,10,11,12],
  cloud_cover:[11,21,31,41,51,61,71,81],
 }};
}
test('split model keeps historical estimates and forecast strictly apart',()=>{
 const raw=mock(),{forecast,past}=splitModelHistory(raw,anchor);
 assert.equal(ICON_HISTORY_HOURS,9);
 assert.deepEqual(past.hourly.time,raw.hourly.time.slice(1,5));
 assert.deepEqual(forecast.hourly.time,raw.hourly.time.slice(5));
 assert.deepEqual(past.hourly.temperature_2m,[2,3,4,5]);
 assert.equal(forecast.hourly.temperature_2m[0],6);
 assert.equal(past.source,'ARCHIVED_ICON_MODEL');
 assert.equal(raw.hourly.time.length,8,'splitting must not mutate original data');
});
test('history remains absent rather than manufacturing past weather',()=>{
 const raw=mock(),onlyFuture={...raw,hourly:Object.fromEntries(Object.entries(raw.hourly).map(([k,v])=>[k,v.slice(5)]))};
 const {past,forecast}=splitModelHistory(onlyFuture,anchor);
 assert.equal(past,null);
 const plotted=chartSeries(forecast,past,'temperature_2m',anchor-6*3600,anchor+2*3600,anchor);
 assert.deepEqual(plotted.past,[]);
 assert.equal(plotted.future.length,3);
});
test('series keeps historical and forecast rain separated and clips to chart bounds',()=>{
 const {forecast,past}=splitModelHistory(mock(),anchor);
 const plotted=chartSeries(forecast,past,'precipitation',anchor-6*3600,anchor+3600,anchor);
 assert.deepEqual(plotted.past.map(p=>p.v),[.4,.2,0]);
 assert.deepEqual(plotted.future.map(p=>p.v),[1,2]);
 assert.ok(plotted.past.every(p=>p.t<anchor));
 assert.ok(plotted.future.every(p=>p.t>=anchor));
});
