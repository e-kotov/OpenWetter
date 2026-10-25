import assert from 'node:assert/strict';
import {test} from 'node:test';
import {gzipSync} from 'node:zlib';
import {parseNativeManifest,downloadNativePointSeries} from '../native-fields.mjs';
import {spatialTileInfo,visibleIconSpatialTiles,downloadIconSpatialTile,
  spatialFieldValues,peekIconSpatialTile} from '../spatial-icon.mjs';
const start=1792908000;
const manifest=parseNativeManifest({
  schema:2,model:'ICON-D2',run:'2026-10-25T06:00',bbox:[4,47,6,49],
  width:161,height:161,start,end:start+48*3600,
  precipitation:{count:193,interval_minutes:15,path:'frames/precip/{index:03d}.bin.gz'},
  cloud:{count:49,interval_minutes:60,path:'frames/cloud/{index:03d}.bin.gz'},
  temp:{count:49,interval_minutes:60,path:'frames/temp/{index:03d}.bin.gz'},
  point_series:{size:80,tiles_x:2,tiles_y:2,path:'series/{x:02d}/{y:02d}.bin.gz'}
},'icon');
function storage(){
  const groups=new Map();return {async open(name){
    if(!groups.has(name)){
      const entries=new Map();groups.set(name,{
        async match(url){return entries.get(String(url.url||url))?.clone();},
        async put(url,response){entries.set(String(url.url||url),response.clone());},
        async keys(){return [...entries.keys()].map(k=>new Request(k));},
        async delete(url){return entries.delete(String(url.url||url));}
      });
    }
    return groups.get(name);
  }};
}
test('regional D2 tiles partition the geographic area with extra final endpoint row and column',()=>{
  const a=spatialTileInfo(manifest,0,0),b=spatialTileInfo(manifest,1,0),
    c=spatialTileInfo(manifest,1,1);
  assert.equal(a.cols,80);assert.equal(a.rows,80);
  assert.equal(b.cols,81);assert.equal(c.rows,81);
  assert.match(c.url,/series\/01\/01\.bin\.gz\?run=/);
  assert.throws(()=>spatialTileInfo(manifest,3,0));
});
test('viewport tile selection is bounded, sorted and does not require full-country rasters',()=>{
  const t=visibleIconSpatialTiles(manifest,390,300,9,{latitude:48,longitude:5.5});
  assert.ok(t.length>0&&t.length<=4);
  assert.ok(t.every(x=>x.tx<2&&x.ty<2));
});
test('one 48-hour D2 tile transfer serves many time steps with zero additional network requests',async()=>{
  const oldFetch=globalThis.fetch,oldCache=globalThis.caches;
  globalThis.caches=storage();
  const spec=spatialTileInfo(manifest,0,0),n=spec.n;
  const raw=Buffer.alloc(spec.expected);
  raw.writeUInt16LE(12,0);raw.writeUInt16LE(35,n*2);
  raw[193*n*2]=67;raw[193*n*2+n]=83;
  const gz=gzipSync(raw);let calls=0;
  globalThis.fetch=async url=>{
    assert.equal(String(url),spec.url);
    calls++;
    return new Response(gz,{status:200});
  };
  try{
    const t=await downloadIconSpatialTile(manifest,0,0);
    assert.equal(spatialFieldValues(t,'precip',start)[0],12);
    assert.equal(spatialFieldValues(t,'precip',start+900)[0],35);
    assert.equal(spatialFieldValues(t,'cloud',start)[0],67);
    assert.equal(spatialFieldValues(t,'cloud',start+3600)[0],83);
    assert.equal(spatialFieldValues(t,'cloud',start+1800)[0],67);
    const p=await downloadNativePointSeries(manifest,49,4);
    assert.equal(p.precipitation_15min[1],.35);
    assert.equal((await downloadIconSpatialTile(manifest,0,0)).url,spec.url);
    assert.equal(peekIconSpatialTile(manifest,0,0)?.n,n);
    assert.equal(calls,1,'Full 48h D2 tile and point-forecast series fetched only once');
  }finally{globalThis.fetch=oldFetch;globalThis.caches=oldCache;}
});
