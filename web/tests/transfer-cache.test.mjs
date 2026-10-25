import assert from 'node:assert/strict';
import {test} from 'node:test';
import {gzipSync} from 'node:zlib';
import {parseNativeManifest,findRasterFile,downloadNativeFrame,downloadNativePointSeries,preloadNativeFrames,weatherCacheStats} from '../native-fields.mjs';

function fakeStore(){
  const stores=new Map();
  return {
    async open(name){
      if(!stores.has(name)){
        const entries=new Map();
        stores.set(name,{
          async match(url){return entries.get(String(url.url||url))?.clone();},
          async put(url,response){entries.set(String(url.url||url),response.clone());},
          async keys(){return [...entries.keys()].map(url=>new Request(url));},
          async delete(url){return entries.delete(String(url.url||url));}
        });
      }
      return stores.get(name);
    }
  };
}
const start=1792908000;
const radar=parseNativeManifest({
  schema:1,product:'RADOLAN-RY',bbox:[4,47,16,56],width:40,height:30,
  frames:Array.from({length:14},(_,i)=>({time:start+i*300,file:'frames/'+(start+i*300)+'.bin.gz'}))
},'radar');
const icon=parseNativeManifest({
  schema:2,model:'ICON-D2',run:'2026-10-25T06:00',bbox:[4,47,16,56],
  width:40,height:30,start,end:start+48*3600,
  precipitation:{count:193,interval_minutes:15,path:'frames/precip/{index:03d}.bin.gz'},
  cloud:{count:49,interval_minutes:60,path:'frames/cloud/{index:03d}.bin.gz'},
  temp:{count:49,interval_minutes:60,path:'frames/temp/{index:03d}.bin.gz'},
  point_series:{size:40,tiles_x:1,tiles_y:1,path:'series/{x:02d}/{y:02d}.bin.gz'}
},'icon');

test('radar keeps stable cache URLs across new five-minute publications',()=>{
  const old=findRasterFile(radar,'radar',start),later=parseNativeManifest({
    ...radar,frames:[...radar.frames,{time:start+14*300,file:'frames/'+(start+14*300)+'.bin.gz'}]
  },'radar');
  assert.equal(findRasterFile(later,'radar',start).url,old.url);
  assert.doesNotMatch(old.url,/stamp=/);
});
test('real gzip radar frames persist after decoded LRU eviction and whole-history preload',async()=>{
  const oldFetch=globalThis.fetch,oldCaches=globalThis.caches;
  globalThis.caches=fakeStore();
  const compressed=gzipSync(Buffer.from(new Uint16Array(40*30).fill(175).buffer));
  const calls=new Map();
  globalThis.fetch=async (url)=>{
    url=String(url);calls.set(url,(calls.get(url)||0)+1);
    return new Response(compressed,{status:200});
  };
  try{
    for(const f of radar.frames){
      const result=await downloadNativeFrame(radar,'radar',f.time);
      assert.equal(result.data[0],175);
    }
    const first=findRasterFile(radar,'radar',start).url;
    assert.equal(calls.get(first),1);
    assert.equal((await downloadNativeFrame(radar,'radar',start)).data[0],175);
    assert.equal(calls.get(first),1,'Old decoded frame should be loaded from persistent compressed cache');
    const before=[...calls.values()].reduce((a,b)=>a+b,0);
    const result=await preloadNativeFrames(radar);
    assert.equal(result.total,14);
    assert.equal(result.errors,0);
    assert.equal([...calls.values()].reduce((a,b)=>a+b,0),before,'Repeated preload must not fetch again');
    const stats=await weatherCacheStats();
    assert.equal(stats.radar.entries,14);
    assert.ok(stats.radar.bytes>0);
  }finally{globalThis.fetch=oldFetch;globalThis.caches=oldCaches;}
});
test('ICON point-series tiles remain cached across different selected locations',async()=>{
  const oldFetch=globalThis.fetch,oldCaches=globalThis.caches;
  globalThis.caches=fakeStore();
  const compressed=gzipSync(Buffer.alloc(40*30*(193*2+49+49*2)));
  let calls=0;
  globalThis.fetch=async ()=>{calls++;return new Response(compressed,{status:200});};
  try{
    const a=await downloadNativePointSeries(icon,51,7);
    const b=await downloadNativePointSeries(icon,52,8);
    assert.equal(a.time.length,193);
    assert.equal(b.cloud_cover.length,193);
    assert.equal(calls,1,'Two locations in the same point-series tile require one transfer');
    assert.equal((await weatherCacheStats()).series.entries,1);
  }finally{globalThis.fetch=oldFetch;globalThis.caches=oldCaches;}
});
