import assert from 'node:assert/strict';
import {test} from 'node:test';
import {parseIconManifest,parseHistoryIndex,iconFrame,tileRange} from '../tile-service.mjs';
import {fetchBytes} from '../tile-loader.mjs';

const run='2026-11-07T06:00',grid={west:5,north:55,lon_step:0.03,lat_step:0.02,width:300,height:200};
function manifest(){
  return {schema:'openwetter-tiles-3',model:'icon_d2',run,tile:128,grid,
    layers:{precip:{step_minutes:15,pack:'precip.pack',code:{},chunks:[
      {chunk:0,first_step_minutes:15,frames:24,tiles:[[0,0,100],[2,1,50]]},
      {chunk:1,first_step_minutes:375,frames:24,tiles:[[1,0,30]]}]}},
    series:{tile:32,path:'series/{n}.pack',parts:[2,1],tiles:[[0,0,10],[1,0,20],[2,0,5]],
      layers:[{name:'temperature',frames:1,step_minutes:60,first_step_minutes:60,lead_minutes:[60]}]}};
}
test('Packed layer: each tile is a byte range of the layer object, offsets running across chunks',()=>{
  const m=parseIconManifest(manifest(),'icon_d2/2026-11-07T0600/manifest.json',{base:'https://x/'});
  const f0=iconFrame(m,'precip',Date.parse(run+'Z')/1000+15*60),f1=iconFrame(m,'precip',Date.parse(run+'Z')/1000+375*60);
  assert.equal(f0.url(0,0),'https://x/icon_d2/2026-11-07T0600/precip.pack#bytes=0-99');
  assert.equal(f0.url(2,1),'https://x/icon_d2/2026-11-07T0600/precip.pack#bytes=100-149');
  assert.equal(f1.url(1,0),'https://x/icon_d2/2026-11-07T0600/precip.pack#bytes=150-179');
  assert.deepEqual(tileRange(f1.url(1,0)),{url:'https://x/icon_d2/2026-11-07T0600/precip.pack',first:150,last:179});
});
test('Packed series: blocks in parts, offsets restart in each part; a bad part count drops the series',()=>{
  const m=parseIconManifest(manifest(),'icon_d2/2026-11-07T0600/manifest.json',{base:'https://x/'});
  assert.equal(m.series.url(1,0),'https://x/icon_d2/2026-11-07T0600/series/0.pack#bytes=10-29');
  assert.equal(m.series.url(2,0),'https://x/icon_d2/2026-11-07T0600/series/1.pack#bytes=0-4');
  const bad=manifest();bad.series.parts=[2];
  assert.equal(parseIconManifest(bad,'icon_d2/r/manifest.json').series,null);
  const noSize=manifest();noSize.layers.precip.chunks[0].tiles[0]=[0,0];
  assert.equal(parseIconManifest(noSize,'icon_d2/r/manifest.json').layers.precip,undefined,'unknown sizes: layer unusable');
});
test('History index: packed slices use their offsets, older slices keep per-tile paths',()=>{
  const slice=(key,extra)=>({run:key.replace(/(\d\d)(\d\d)$/,'$1:$2'),run_key:key,start:0,
    layers:{precip:{step_minutes:15,first_step_minutes:15,frames:12,tiles:[[0,0,40],[1,0,60]],...extra.layer}},
    series:{tiles:[[0,0,7]],layers:[{name:'temperature',frames:3,step_minutes:60,first_step_minutes:60}],...extra.series},...extra.slice});
  const idx={schema:'openwetter-history-2',grid,tile:256,path:'icon_d2/history/{run_key}/{layer}/{x}_{y}.webp',
    series:{tile:64,path:'icon_d2/history/{run_key}/series/{x}_{y}.bin.gz'},slices:[
      slice('2026-11-07T0300',{layer:{offset:0},series:{offset:100},slice:{pack:'icon_d2/history/2026-11-07T0300/slice.pack'}}),
      slice('2026-11-07T0000',{layer:{},series:{},slice:{}})]};
  const [packed,old]=parseHistoryIndex(idx,{base:'https://x/'});
  const p=packed.layers.precip.chunks[0].urls;
  assert.equal(p.get('1_0'),'https://x/icon_d2/history/2026-11-07T0300/slice.pack#bytes=40-99');
  assert.equal(packed.series.url(0,0),'https://x/icon_d2/history/2026-11-07T0300/slice.pack#bytes=100-106');
  assert.equal(old.series.url(0,0),'https://x/icon_d2/history/2026-11-07T0000/series/0_0.bin.gz');
  assert.equal(iconFrame(old,'precip',old.runTime+900).url(1,0),'https://x/icon_d2/history/2026-11-07T0000/precip/1_0.webp');
});
test('Range fetch: 206 slice as sent; a server ignoring Range sends the object and the tile is cut out',async()=>{
  const body=Uint8Array.from({length:50},(_,i)=>i),seen=[];
  const real=globalThis.fetch;
  try{
    globalThis.fetch=async(url,init)=>{seen.push([url,init?.headers?.Range]);
      return url.includes('ranged')?new Response(body.slice(10,20),{status:206}):new Response(body,{status:200});};
    assert.deepEqual([...new Uint8Array(await fetchBytes('https://x/ranged.pack#bytes=10-19'))],[...body.slice(10,20)]);
    assert.deepEqual([...new Uint8Array(await fetchBytes('https://x/plain.pack#bytes=10-19'))],[...body.slice(10,20)]);
    assert.deepEqual(seen,[['https://x/ranged.pack','bytes=10-19'],['https://x/plain.pack','bytes=10-19']]);
    await assert.rejects(fetchBytes('https://x/plain.pack#bytes=40-59'),/too short/);
  }finally{globalThis.fetch=real;}
});
