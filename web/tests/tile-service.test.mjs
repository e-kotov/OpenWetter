import assert from 'node:assert/strict';
import {test} from 'node:test';
import {decodeRate,decodeCode,paletteLUT,parseRunTime,parseLatest,parseIconManifest,iconFrame,iconAdjacentChunk,
  chooseRun,parseHistoryIndex,cellAt,tileSize,tileBounds,tileTexel,tilesInView,parseRadarIndex,radarFrame,
  parseNowcastIndex,nowcastFrame,parseWarnings,activeWarnings,warningsAt,seriesLocation,parseSeriesBlock,
  seriesToChart,LAYER_INFO,ICON_LAYERS} from '../tile-service.mjs';
import {latitudeFromMercatorY,tileQuad} from '../raster-renderer.mjs';
import {mercator} from '../logic.mjs';

// Grid of the live ICON-D2 run 2026-11-06T09:00 (tile service manifest).
const GRID={west:-4.1616363525390625,north:58.16465377807617,lon_step:.03,lat_step:.02,width:824,height:757,row0:'north'};
const chunk=(chunk,first,tiles=[[3,2,1000],[6,5,10]])=>({chunk,first_step_minutes:first,frames:24,tiles});
function manifest(run='2026-11-06T09:00',extra={}){
  return {schema:'openwetter-tiles-2',model:'icon_d2',run,grid:GRID,tile:128,frames_per_chunk:24,
    layers:{precip:{step_minutes:15,chunks:Array.from({length:8},(_,i)=>chunk(i,15+i*360))},
      temperature:{step_minutes:60,chunks:[chunk(0,60),chunk(1,1500)]}},...extra};
}
const runKey=r=>r.replace(':','');
const parse=(run='2026-11-06T09:00',extra)=>parseIconManifest(manifest(run,extra),`icon_d2/${runKey(run)}/manifest.json`);

test('decode formulas match the published code tables',()=>{
  assert.equal(decodeRate(0),0);
  assert.equal(decodeRate(1),.05);
  assert.ok(Math.abs(decodeRate(254)-64)<1e-9);
  assert.equal(decodeRate(255),null);
  // Log scale: equal code steps are equal ratios.
  assert.ok(Math.abs(decodeRate(2)/decodeRate(1)-decodeRate(254)/decodeRate(253))<1e-9);
  assert.equal(decodeCode('temperature',130),5);       // Dortmund, run 09 UTC, 10 UTC frame
  assert.equal(decodeCode('dew_point',0),-60);
  assert.equal(decodeCode('pressure',113),1013);
  assert.equal(decodeCode('wind_speed',41),10.25);
  assert.equal(decodeCode('wind_direction',60),90);
  assert.equal(decodeCode('cloud_total',100),100);
  assert.equal(decodeCode('humidity',101),null,'percent codes above 100 are invalid');
  for(const layer of Object.keys(LAYER_INFO))assert.equal(decodeCode(layer,255),null,layer);
});
test('palettes: no-data is transparent everywhere, dry rain is transparent, values are coloured',()=>{
  for(const layer of Object.keys(LAYER_INFO)){
    const lut=paletteLUT(layer);
    assert.equal(lut.length,1024);
    assert.equal(lut[255*4+3],0,layer+' code 255');
  }
  for(const layer of ['precip','snow','radar','nowcast'])assert.equal(paletteLUT(layer)[3],0,layer+' dry');
  assert.ok(paletteLUT('precip')[200*4+3]>200,'heavy rain is nearly opaque');
  assert.ok(paletteLUT('temperature')[0*4+3]>0,'-60 °C is a value, not no-data');
  const t=paletteLUT('temperature');
  assert.notDeepEqual([...t.slice(100*4,100*4+3)],[...t.slice(160*4,160*4+3)],'-10 °C and +20 °C differ');
});
test('run times are UTC even without a zone suffix',()=>{
  assert.equal(parseRunTime('2026-11-06T09:00'),Date.UTC(2026,10,6,9)/1000);
  assert.equal(parseRunTime('2026-11-06T09:00Z'),Date.UTC(2026,10,6,9)/1000);
  assert.equal(parseRunTime('06.11.2026 09:00'),null);
});
test('latest.json: history is the index path, unsafe paths rejected, missing keys tolerated',()=>{
  const l=parseLatest({schema:'openwetter-tiles-2',icon_d2:{run:'2026-11-06T09:00',manifest:'icon_d2/2026-11-06T0900/manifest.json',
    history:'icon_d2/history/index.json'},radar:'../evil.json'});
  assert.equal(l.icon.runTime,Date.UTC(2026,10,6,9)/1000);
  assert.equal(l.history,'icon_d2/history/index.json');
  assert.equal(l.radar,null);assert.equal(l.warnings,null);
  // The pre-index format (a list of runs) is not history any more.
  assert.equal(parseLatest({schema:'openwetter-tiles-2',icon_d2:{run:'2026-11-06T09:00',
    manifest:'icon_d2/2026-11-06T0900/manifest.json',history:[{run:'2026-11-06T06:00'}]}}).history,null);
  assert.equal(parseLatest({schema:'openwetter-tiles-2',icon_d2:{run:'x',manifest:'../evil.json'}}).icon,null);
  assert.throws(()=>parseLatest({schema:'other'}));
});
test('ICON frames: valid times, chunk boundaries and tile URLs follow the manifest',()=>{
  const m=parse(),run=m.runTime;
  assert.equal(m.dir,'https://openwetter-data.ekotov.pro/icon_d2/2026-11-06T0900/');
  const first=iconFrame(m,'precip',run+900);
  assert.equal(first.chunk,0);assert.equal(first.index,0);
  assert.equal(first.url(3,2),'https://openwetter-data.ekotov.pro/icon_d2/2026-11-06T0900/precip/c00/3_2.webp');
  const boundary=iconFrame(m,'precip',run+(15+24*15)*60);
  assert.equal(boundary.chunk,1);assert.equal(boundary.index,0);
  assert.match(boundary.url(3,2),/precip\/c01\/3_2\.webp$/);
  assert.equal(iconFrame(m,'precip',run+(15+23*15)*60).index,23);
  // Hourly layers start one hour after the run; there is no +0 frame.
  assert.equal(iconFrame(m,'temperature',run),null);
  assert.equal(iconFrame(m,'temperature',run+3600).index,0);
  assert.equal(iconFrame(m,'temperature',run+3600+29*60).time,run+3600,'nearest hourly frame');
  assert.equal(iconFrame(m,'temperature',run+49*3600),null);
  assert.equal(iconFrame(m,'snow',run+3600),null,'unpublished layer');
  assert.equal(iconAdjacentChunk(m,first,1).chunk,1);
  assert.equal(iconAdjacentChunk(m,first,-1),null);
});
test('newest run covering a time is chosen',()=>{
  const now=parse('2026-11-06T09:00'),older=parse('2026-11-06T06:00');
  assert.equal(chooseRun([older,now],'temperature',now.runTime+2*3600).run,'2026-11-06T09:00');
  // 09:10 UTC: the 09 UTC run's first hourly frame is 10:00, so the 06 UTC run (09:00 frame) is used.
  assert.equal(chooseRun([now,older],'temperature',now.runTime+10*60).run,'2026-11-06T06:00');
  assert.equal(chooseRun([now],'temperature',now.runTime+10*60),null);
});
// Mirrors write_history_index in tools/icon-rs/src/icon.rs: slices newest first,
// rain/snow 12 frames from +15 min, hourly layers 3 frames from +60 min.
const slice=(run,tiles=[[1,1,900]])=>({run,run_key:runKey(run),start:Date.parse(run+'Z')/1000,layers:{
  precip:{step_minutes:15,first_step_minutes:15,frames:12,tiles},
  temperature:{step_minutes:60,first_step_minutes:60,frames:3,tiles:[[0,0,5],[1,1,7]]}}});
const historyIndex=(slices)=>({schema:'openwetter-history-1',generated_at:1,grid:GRID,tile:256,
  path:'icon_d2/history/{run_key}/{layer}/{x}_{y}.webp',codes:{},slices});
test('history index: each 3-hour slice behaves like a one-chunk run with its own tile URLs',()=>{
  const h=parseHistoryIndex(historyIndex([slice('2026-11-06T03:00'),slice('2026-11-06T06:00'),
    {run:'bad'},{run:'2026-11-06T00:00',run_key:'../x',layers:{}}]));
  assert.deepEqual(h.map(m=>m.run),['2026-11-06T06:00','2026-11-06T03:00'],'newest first, invalid slices dropped');
  const s6=h[0],r=s6.runTime;
  assert.equal(iconFrame(s6,'precip',r),null,'no +0 frame');
  const f=iconFrame(s6,'precip',r+15*60);
  assert.equal(f.index,0);assert.equal(f.frames,12);assert.equal(f.tile,256);
  assert.equal(f.url(1,1),'https://openwetter-data.ekotov.pro/icon_d2/history/2026-11-06T0600/precip/1_1.webp');
  assert.equal(iconFrame(s6,'precip',r+3*3600).index,11,'+3 h is the last slice frame');
  assert.equal(iconFrame(s6,'precip',r+3*3600+15*60),null);
  assert.equal(iconFrame(s6,'temperature',r+3*3600).index,2);
  assert.equal(iconFrame(s6,'temperature',r+4*3600),null);
  assert.ok(f.tiles.has('1_1')&&!f.tiles.has('0_0'),'dry rain tiles are absent');
  // Same run as a full manifest: distinct cache keys (different tile size).
  const full=parse('2026-11-06T06:00');
  assert.notEqual(iconFrame(full,'precip',r+15*60).key,f.key);
  assert.notEqual(iconFrame(full,'precip',r+15*60).chunkKey,f.chunkKey);
  // Coverage is contiguous across 3-hourly runs: (R, R+3h] comes from run R.
  const now=parse('2026-11-06T09:00'),all=[now,...h];
  assert.equal(chooseRun(all,'precip',now.runTime).run,'2026-11-06T06:00');
  assert.equal(chooseRun(all,'precip',now.runTime-3*3600).run,'2026-11-06T03:00');
  assert.equal(chooseRun(all,'precip',now.runTime+15*60).history,undefined,'the full run wins once it covers the time');
  assert.equal(chooseRun(all,'precip',now.runTime-6*3600),null);
  assert.throws(()=>parseHistoryIndex({...historyIndex([]),path:'https://evil/{run_key}/{layer}/{x}_{y}.webp'}));
  assert.throws(()=>parseHistoryIndex({schema:'openwetter-tiles-2'}));
});
test('pixel centres, tile edges and the narrower east/south tiles',()=>{
  const m=parse();
  // Ground truth from the live temperature tile: Dortmund is column 388, row 333 (tile 3_2, local 4,77).
  assert.deepEqual(cellAt(m.grid,51.5142,7.4653),{col:388,row:333});
  assert.equal(cellAt(m.grid,40,7),null);
  assert.deepEqual(tileSize(m.grid,128,6,5),{w:824-6*128,h:757-5*128});
  assert.deepEqual(tileSize(m.grid,128,0,0),{w:128,h:128});
  const b=tileBounds(m.grid,128,0,0);
  assert.ok(Math.abs(b.west-(GRID.west-.015))<1e-12,'west edge half a step outside the first centre');
  assert.ok(Math.abs(b.north-(GRID.north+.01))<1e-12);
  // A point exactly on pixel centre (col 3, row 5) samples the middle of that texel.
  const lon=GRID.west+3*.03,lat=GRID.north-5*.02,t=tileTexel(m.grid,128,0,0,lon,lat);
  assert.ok(Math.abs(t.u-3.5/128)<1e-9&&Math.abs(t.v-5.5/128)<1e-9);
  const edge=tileTexel(m.grid,128,6,0,GRID.west+(6*128+55)*.03,lat);
  assert.ok(Math.abs(edge.u-55.5/56)<1e-9,'last column of the 56-px east tile');
});
test('viewport tile selection covers only what is visible',()=>{
  const m=parse(),view={latitude:51.5142,longitude:7.4653,zoom:9,width:390,height:300};
  const tiles=tilesInView(m.grid,128,view);
  assert.deepEqual(tiles[0],{x:3,y:2},'Dortmund tile first');
  assert.ok(tiles.length<=2);
  const wide=tilesInView(m.grid,128,{...view,zoom:5,width:1200,height:900});
  assert.equal(wide.length,7*6,'zoomed out: the whole 7 x 6 tile grid');
  assert.deepEqual(tilesInView(m.grid,128,{latitude:-30,longitude:-60,zoom:7,width:390,height:300}),[]);
});
test('lat/lon <-> Web Mercator: shader latitude formula and tile quads agree with the base map',()=>{
  for(const lat of [-60,0,47.49,51.5142,58.17,70]){
    const y=mercator(lat,0,0).y/256;
    assert.ok(Math.abs(latitudeFromMercatorY(y)-lat)<1e-9,String(lat));
  }
  // Fragment at Dortmund's screen position resolves to Dortmund's grid row.
  const m=parse(),view={latitude:50,longitude:8,zoom:8,width:600,height:600};
  const c=mercator(view.latitude,view.longitude,view.zoom),p=mercator(51.5142,7.4653,view.zoom);
  const screenY=view.height/2+p.y-c.y,world=256*2**view.zoom;
  const lat=latitudeFromMercatorY((c.y-view.height/2+screenY)/world);
  assert.equal(Math.floor((GRID.north-lat)/GRID.lat_step+.5),333);
  const frame=iconFrame(m,'temperature',m.runTime+3600),q=tileQuad(frame,3,2,view);
  const north=GRID.north-(2*128-.5)*GRID.lat_step,west=GRID.west+(3*128-.5)*GRID.lon_step;
  assert.ok(Math.abs(q.y0-(view.height/2+mercator(north,0,8).y-c.y))<1e-6);
  assert.ok(Math.abs(q.x0-(view.width/2+mercator(0,west,8).x-c.x))<1e-6);
});
test('radar index: per-entry tile size, missing frames never invented, chunks win over duplicates',()=>{
  const start=1793952000;
  const r=parseRadarIndex({schema:'openwetter-radar-1',grid:{west:1.47,north:56.22,lon_step:.015,lat_step:.01,width:1151,height:1054,row0:'north'},
    tile:256,step_seconds:300,latest:start+24*300,
    chunks:[{start,frames:24,tile:256,path:'radar/c/'+start+'/{x}_{y}.webp',tiles:[[1,3,9]],missing_frames:[3]}],
    frames:[{time:start+300,tile:2048,path:'radar/f/x/{x}_{y}.webp',tiles:[[0,0,5]]},
      {time:start+24*300,tile:2048,path:'radar/f/'+(start+24*300)+'/{x}_{y}.webp',tiles:[[0,0,5]]}]},{now:start+24*300+60});
  assert.equal(r.frames.length,24,'23 chunk frames + 1 single frame');
  assert.ok(!r.frames.some(f=>f.time===start+3*300));
  assert.equal(r.frames.find(f=>f.time===start+300).tile,256);
  const last=radarFrame(r,r.frames.at(-1));
  assert.equal(last.tile,2048);assert.equal(last.frames,1);
  assert.equal(last.url(0,0),'https://openwetter-data.ekotov.pro/radar/f/'+(start+24*300)+'/0_0.webp');
  const tenth=radarFrame(r,r.frames.find(f=>f.time===start+10*300));
  assert.equal(tenth.index,10);assert.equal(tenth.frames,24);
  assert.equal(r.isStale,false);
  assert.throws(()=>parseRadarIndex({schema:'openwetter-radar-1',grid:{},tile:256}));
});
test('nowcast frames are addressed by valid time within the stacked tile',()=>{
  const n=parseNowcastIndex({schema:'openwetter-nowcast-1',issued:1000*300,grid:{west:1.47,north:56.22,lon_step:.015,lat_step:.01,width:1151,height:1054},
    tile:256,step_seconds:300,first_time:1001*300,frames:24,path:'nowcast/300000/{x}_{y}.webp',tiles:[[1,3,5]]});
  const f=nowcastFrame(n,1001*300+5*300);
  assert.equal(f.index,5);assert.equal(f.frames,24);assert.equal(f.source,'nowcast');
  assert.equal(nowcastFrame(n,1001*300+24*300),null);
});
test('warnings: active by time and listed only for places inside an area',()=>{
  const w=parseWarnings({schema:'openwetter-warnings-1',warnings:[
    {id:'a',event:'FROST',severity:'Minor',onset:100,expires:200,color:[255,235,59],headline:{en:'Frost'},
      areas:[{name:'square',polygons:[[[7,51],[8,51],[8,52],[7,52],[7,51]]]}]},
    {id:'b',event:'STORM',severity:'Severe',onset:150,expires:300,areas:[{name:'far',polygons:[[[10,48],[11,48],[11,49]]]}]}]});
  assert.deepEqual(activeWarnings(w,120).map(x=>x.id),['a']);
  assert.deepEqual(activeWarnings(w,160).map(x=>x.id),['b','a'],'most severe first');
  assert.deepEqual(activeWarnings(w,200).map(x=>x.id),['b'],'expiry is exclusive');
  assert.deepEqual(warningsAt(w,120,51.5,7.5).map(x=>x.id),['a']);
  assert.deepEqual(warningsAt(w,120,52.5,7.5),[]);
});
test('series blocks: edge block size, layer offsets and chart conversion',()=>{
  const layers=[{name:'precip',frames:8,step_minutes:15,first_step_minutes:15},
    {name:'temperature',frames:2,step_minutes:60,first_step_minutes:60},{name:'wind_speed',frames:2,step_minutes:60,first_step_minutes:60}];
  const m=parse(undefined,{series:{tile:32,path:'series/{x}_{y}.bin.gz',tiles:[[25,23],[0,0]],layers}});
  const loc=seriesLocation(m,GRID.north-(23*32+3)*.02,GRID.west+(25*32+7)*.03);
  assert.equal(loc.w,824-25*32);assert.equal(loc.h,757-23*32);
  assert.equal(loc.cell,3*loc.w+7);
  assert.equal(loc.url,'https://openwetter-data.ekotov.pro/icon_d2/2026-11-06T0900/series/25_23.bin.gz');
  assert.equal(seriesLocation(m,51.5,7.5),null,'block not published');
  const n=loc.w*loc.h,buf=new Uint8Array(loc.bytes).fill(255);
  for(let k=0;k<8;k++)buf[k*n+loc.cell]=k<4?0:1;     // dry, then 0.05 mm/h
  buf[8*n+loc.cell]=130;buf[9*n+loc.cell]=134;      // 5 °C, 7 °C
  buf[10*n+loc.cell]=40;buf[11*n+loc.cell]=40;      // 10 m/s
  const decoded=parseSeriesBlock(m,loc,buf.buffer);
  assert.deepEqual(decoded.temperature.value,[5,7]);
  assert.equal(decoded.precip.time[0],m.runTime+900);
  const chart=seriesToChart(decoded);
  assert.equal(chart.time.length,8);
  assert.deepEqual(chart.precipitation.slice(0,4),[null,null,null,0]);
  assert.equal(chart.precipitation[7],.05,'four 15-min steps at 0.05 mm/h = 0.05 mm in the hour');
  assert.equal(chart.temperature_2m[3],5,'10:00 UTC is the first hourly frame');
  assert.equal(chart.temperature_2m[5],6,'display interpolation between real model hours');
  assert.equal(chart.wind_speed_10m[3],36,'m/s converted to km/h for the chart');
  assert.throws(()=>parseSeriesBlock(m,loc,new ArrayBuffer(5)),/length/);
});
test('all 13 published ICON-D2 layers are known with units',()=>{
  assert.equal(ICON_LAYERS.length,13);
  for(const l of ICON_LAYERS)assert.ok(LAYER_INFO[l]?.unit,l);
});

test('review fixes: wind direction wraps through north; open-ended warnings; warning-area holes',()=>{
  const chart=seriesToChart({precip:{time:[0,900,1800,2700,3600],value:[0,0,0,0,0],step:900},
    wind_direction:{time:[0,3600],value:[350,10],step:3600}});
  assert.deepEqual(chart.wind_direction_10m,[350,355,0,5,10]);
  const square=[[0,0],[10,0],[10,10],[0,10]],hole=[[4,4],[6,4],[6,6],[4,6]];
  const p=parseWarnings({schema:'openwetter-warnings-1',warnings:[
    {id:'open',onset:null,expires:null,areas:[{name:'x',polygons:[square,hole]}]},
    {id:'bad',onset:'soon',expires:5,areas:[]}]});
  assert.deepEqual(p.warnings.map(w=>w.id),['open'],'null times are open-ended; malformed times are dropped');
  assert.equal(activeWarnings(p,2e9).length,1);
  assert.equal(warningsAt(p,2e9,2,2).length,1);
  assert.equal(warningsAt(p,2e9,5,5).length,0,'inside the hole');
});
