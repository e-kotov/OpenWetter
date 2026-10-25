import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ICON_EU_WMS_LAYER,ICON_EU_CAPABILITIES,iconEuValidTime,
  iconEuWmsTileURL,visibleIconEuWmsTiles} from '../wms-eu.mjs';
const now=1792908000;
const meta={kind:'icon_eu_wms',run:now-21600,first:now-86400,last:now+78*3600};
test('EU WMS comes from the real DWD hourly precipitation layer, not a D2 product',()=>{
  assert.equal(ICON_EU_WMS_LAYER,'dwd:Icon-eu_reg00625_fd_sl_TOTPREC01H');
  assert.ok(ICON_EU_CAPABILITIES.startsWith('https://maps.dwd.de/'));
  const u=new URL(iconEuWmsTileURL(meta,now+3600,8,130,81));
  assert.equal(u.hostname,'maps.dwd.de');
  assert.equal(u.searchParams.get('LAYERS'),ICON_EU_WMS_LAYER);
  assert.equal(u.searchParams.get('SRS'),'EPSG:3857');
  assert.equal(u.searchParams.get('FORMAT'),'image/png');
  assert.equal(u.searchParams.get('TIME'),new Date((now+3600)*1000).toISOString().replace('.000Z','Z'));
  assert.equal(u.searchParams.get('DIM_REFERENCE_TIME'),new Date(meta.run*1000).toISOString().replace('.000Z','Z'));
  assert.equal(u.searchParams.get('WIDTH'),'256');
  assert.equal(u.searchParams.get('TRANSPARENT'),'TRUE');
});
test('EU rainfall map refuses unavailable future times or timestamps before the run',()=>{
  assert.equal(iconEuValidTime(meta,now+78*3600),now+78*3600);
  assert.equal(iconEuValidTime(meta,now+79*3600),null);
  assert.equal(iconEuValidTime(meta,meta.run),null);
  assert.equal(iconEuValidTime(null,now),null);
});
test('EU WMS loads only the visible map tiles and caps native zoom to 8',()=>{
  const at={latitude:51.5,longitude:7.46};
  const small=visibleIconEuWmsTiles(meta,now+3600,390,290,7,at);
  const zoomed=visibleIconEuWmsTiles(meta,now+3600,390,290,11,at);
  assert.ok(small.length>=1&&small.length<=9);
  assert.ok(zoomed.length>=1&&zoomed.length<=9);
  assert.ok(zoomed.every(x=>x.size===256*2**3));
  assert.ok(small.every(x=>x.url.includes('DIM_REFERENCE_TIME=')));
});
