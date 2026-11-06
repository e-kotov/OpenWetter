import test from 'node:test';
import assert from 'node:assert/strict';
import {seriesBlock,readPointSeries,toHourly,applyOwnSeries} from '../own-series.mjs';
import {parseIconManifest} from '../tile-service.mjs';

const run=Date.UTC(2026,10,6,12)/1000;
/** A 40 x 3 grid (two 32-wide series blocks); precip every 15 min for 1 h, then
 * 3-hourly (ICON-EU style), temperature hourly then 3-hourly. */
function manifest(model='icon_eu'){
  const layer=(first,step,frames)=>({step_minutes:step,code:{},chunks:[{chunk:0,first_step_minutes:first,step_minutes:step,frames,tiles:[[0,0,1]]}]});
  return parseIconManifest({schema:'openwetter-tiles-2',model,run:'2026-11-06T12:00',tile:128,
    grid:{west:5,north:52,lon_step:0.1,lat_step:0.1,width:40,height:3},
    layers:{precip:layer(15,15,4),temperature:layer(60,60,2)},
    series:{tile:32,path:'series/{x}_{y}.bin.gz',tiles:[[0,0],[1,0]],layers:[
      {name:'precip',frames:6,step_minutes:15,first_step_minutes:15,lead_minutes:[15,30,45,60,240,420]},
      {name:'temperature',frames:4,step_minutes:60,first_step_minutes:60,lead_minutes:[60,120,300,480]}]}},
    `${model}/2026-11-06T1200/manifest.json`,{base:'https://x/'});
}
const rateCode=r=>r===0?0:Math.round(1+253*Math.log(r/0.05)/Math.log(64/0.05));

test('Series block and offset of a place: second block is 8 cells wide',()=>{
  const m=manifest(),b=seriesBlock(m,51.9,5+33*0.1);
  assert.deepEqual(b,{url:'https://x/icon_eu/2026-11-06T1200/series/1_0.bin.gz',offset:1*8+1,w:8,h:3});
  assert.equal(seriesBlock(m,10,5),null,'outside the grid');
});
test('Hourly values: rain as the preceding hour\'s amount across 15-minute and 3-hour frames; instants interpolated',()=>{
  const m=manifest(),b={offset:0,w:1,h:1};
  const bytes=Uint8Array.from([...[1,2,1,2].map(rateCode),rateCode(1),0, ...[120,122,128,140]]);
  const L=readPointSeries(m,bytes,b);
  assert.deepEqual(L.precip.periods,[900,900,900,900,10800,10800]);
  const hours=[1,2,3,4,5,6,7,9].map(h=>run+h*3600);
  const H=toHourly(L,hours);
  const p=H.precipitation.map(v=>v==null?null:Math.round(v*10)/10);
  assert.deepEqual(p,[1.5,1,1,1,0,0,0,null],'1 mm/h over 1-4 h is 1 mm each hour; dry 4-7 h');
  assert.deepEqual(H.temperature_2m.slice(0,4),[0,1,2,3],'codes /2 - 60; 2 h -> 5 h interpolated');
  assert.equal(H.temperature_2m[7],null,'past the last frame: no own value');
});
test('Own values replace Open-Meteo hours, finest model first; transitions follow',()=>{
  const time=[0,1,2,3].map(h=>run+h*3600);
  const om={time,series:{temperature_2m:[10,10,10,10],cloud_cover_850hPa:[50,50,50,50]},models:{},source:['icon_d2','icon_d2','icon_eu','icon_eu'],transitions:[]};
  const f=applyOwnSeries(om,[{model:'icon_d2',hourly:{temperature_2m:[null,1,null,null]}},{model:'icon_eu',hourly:{temperature_2m:[null,2,3,null]}}]);
  assert.deepEqual(f.series.temperature_2m,[10,1,3,10]);
  assert.deepEqual(f.own,[null,'icon_d2','icon_eu',null]);
  assert.deepEqual(f.series.cloud_cover_850hPa,[50,50,50,50],'cloud by height stays from Open-Meteo');
  assert.deepEqual(f.transitions.map(t=>[t.from,t.to]),[['icon_d2','icon_eu']]);
  assert.deepEqual(om.series.temperature_2m,[10,10,10,10],'input untouched');
  const past=applyOwnSeries(om,[{model:'icon_d2',hourly:{temperature_2m:[null,null,1,null]}},{model:'icon_eu',hourly:{temperature_2m:[2,2,2,2]}}]);
  assert.deepEqual(past.series.temperature_2m,[10,10,1,2],'before own ICON-D2 starts, Open-Meteo stays');
});
