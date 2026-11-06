import test from 'node:test';
import assert from 'node:assert/strict';
import {WMS_RAIN,parseWmsCapabilities,parseWmsLegend,classRate,wmsValidTime,chooseWmsSource,wmsTileURL,recolorPixels} from '../dwd-wms.mjs';
import {paletteLUT} from '../tile-service.mjs';

const run=Date.UTC(2026,10,6,12)/1000,now=run+3*3600;
const caps=(layer,first,last,step)=>`<WMS_Capabilities><Capability><Layer><Layer queryable="1"><Name>${layer}</Name>
  <Dimension name="time" default="current" units="ISO8601">${first}/${last}/${step}</Dimension>
  <Dimension name="REFERENCE_TIME" units="ISO8601">2026-11-06T00:00:00.000Z,2026-11-06T06:00:00.000Z,2026-11-06T12:00:00.000Z</Dimension>
  </Layer></Layer></Capability></WMS_Capabilities>`;
const legend=entries=>({Legend:[{rules:[{symbolizers:[{Raster:{colormap:{type:'intervals',entries}}}]}]}]});
const LAWA=legend([{quantity:'0.09',color:'#FFFFFF',opacity:'0.0'},{quantity:'1.99',color:'#C0C0C0'},{quantity:'4.99',color:'#FEFEC0'},{quantity:'5000.0',color:'#606060'}]);

test('Capabilities: time range, step and newest 6-hourly run of the requested layer',()=>{
  const m=parseWmsCapabilities(caps('Icon-eu_reg00625_fd_sl_TOTPREC03H','2026-11-05T09:00:00.000Z','2026-11-11T12:00:00.000Z','PT3H'),
    'Icon-eu_reg00625_fd_sl_TOTPREC03H',{now});
  assert.deepEqual(m,{first:Date.UTC(2026,10,5,9)/1000,last:Date.UTC(2026,10,11,12)/1000,step:10800,run});
  assert.throws(()=>parseWmsCapabilities(caps('Other','x','y','PT1H'),'Icon-eu_reg00625_fd_sl_TOTPREC03H',{now}),/unavailable/);
  assert.throws(()=>parseWmsCapabilities('<!DOCTYPE x>','a',{now}),/Invalid/);
});
test('Legend classes: upper bounds, dry first class; class rates per hour',()=>{
  const c=parseWmsLegend(LAWA);
  assert.deepEqual(c.map(x=>[x.lo,x.hi,x.dry]),[[0,.09,true],[.09,1.99,false],[1.99,4.99,false],[4.99,5000,false]]);
  assert.deepEqual(c[1].rgb,[192,192,192]);
  assert.equal(classRate(c[0],1),0);
  assert.ok(Math.abs(classRate(c[1],1)-Math.sqrt(.09*1.99))<1e-9);
  assert.ok(Math.abs(classRate(c[1],3)-Math.sqrt(.09*1.99)/3)<1e-9);
  assert.ok(classRate(c[3],1)<10,'open top class stays near its lower bound');
  assert.throws(()=>parseWmsLegend({}),/Invalid/);
});
test('Period choice: the newest run\'s period ending at or after the time, finest source first',()=>{
  const [eu1,eu3,glob]=WMS_RAIN;
  const metas={eu1:{first:run-3600*5,last:run+78*3600,step:3600,run},eu3:{first:run,last:run+120*3600,step:10800,run},
    glob6:{first:run,last:run+180*3600,step:10800,run}};
  assert.equal(wmsValidTime(metas.eu1,run+3600*10+60,eu1),run+11*3600);
  assert.equal(wmsValidTime(metas.eu1,run-3600,eu1),null,'not before the run');
  assert.equal(chooseWmsSource(metas,run+70*3600).source.id,'eu1');
  const c=chooseWmsSource(metas,run+100*3600+1);
  assert.equal(c.source.id,'eu3');assert.equal(c.time,run+102*3600);
  assert.equal(chooseWmsSource(metas,run+150*3600).source.id,'glob6');
  assert.equal(chooseWmsSource(metas,run+200*3600),null);
  assert.equal(chooseWmsSource({},run+10*3600),null);
  void glob;void eu3;
});
test('Tile URL asks DWD for the exact period and run in Web Mercator',()=>{
  const u=new URL(wmsTileURL(WMS_RAIN[0],{run},run+7200,3,4,2));
  assert.equal(u.searchParams.get('LAYERS'),'dwd:Icon-eu_reg00625_fd_sl_TOTPREC01H');
  assert.equal(u.searchParams.get('TIME'),'2026-11-06T14:00:00Z');
  assert.equal(u.searchParams.get('DIM_REFERENCE_TIME'),'2026-11-06T12:00:00Z');
  const q=20037508.342789244/4;
  u.searchParams.get('BBOX').split(',').map(Number).forEach((v,i)=>assert.ok(Math.abs(v-[0,q,q,2*q][i])<1e-6,v));
});
test('Recolouring: class colours become the rain scale; dry, transparent and unknown colours vanish',()=>{
  const c=parseWmsLegend(LAWA),lut=paletteLUT('precip');
  const px=new Uint8ClampedArray([192,192,192,255, 254,254,192,255, 255,255,255,0, 10,200,30,255, 193,191,192,255]);
  const index=recolorPixels(px,c,1,lut);
  assert.deepEqual([...index],[1,2,255,255,1]);
  assert.equal(px[11],0);assert.equal(px[15],0,'colour outside the legend is hidden');
  const code=r=>Math.round(1+253*Math.log(r/.05)/Math.log(64/.05));
  assert.deepEqual([...px.slice(0,4)],[...lut.slice(code(classRate(c[1],1))*4,code(classRate(c[1],1))*4+4)]);
  assert.notDeepEqual([...px.slice(0,4)],[...px.slice(4,8)],'heavier class, different colour');
});
