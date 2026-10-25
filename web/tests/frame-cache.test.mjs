import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createPersistentWeatherCache} from '../frame-cache.mjs';

function fakeStorage(){
  const databases=new Map();
  const storage={
    opens:0,
    async open(name){
      storage.opens++;
      if(!databases.has(name)){
        const responses=new Map();
        databases.set(name,{
          async put(url,response){responses.set(String(url),response.clone());},
          async match(url){return responses.get(String(url))?.clone();},
          async keys(){return [...responses.keys()].map(url=>new Request(url));},
          async delete(url){return responses.delete(String(url.url||url));}
        });
      }
      return databases.get(name);
    }
  };
  return storage;
}
const key=n=>'https://raw.githubusercontent.com/e-kotov/OpenWetter/radar-data/frames/'+n+'.bin.gz';

test('compressed DWD frames persist across cache instances and avoid duplicate fetches',async()=>{
  const store=fakeStorage(),a=createPersistentWeatherCache({storage:store,namespace:'test-persist'});
  const bytes=new Uint8Array([31,139,8,0,5,4,3,2]);
  assert.equal(await a.get('radar',key(1)),null);
  assert.equal(await a.put('radar',key(1),bytes),true);
  const b=createPersistentWeatherCache({storage:store,namespace:'test-persist'});
  assert.deepEqual(new Uint8Array(await b.get('radar',key(1))),bytes);
  assert.deepEqual(await b.stats('radar'),{available:true,entries:1,bytes:bytes.byteLength});
});
test('bounded disk cache evicts oldest observations and retains newer ones',async()=>{
  const store=fakeStorage(),cache=createPersistentWeatherCache({
    storage:store,namespace:'test-bounded',maxEntries:{radar:2,icon:3,series:2}
  });
  for(let n=0;n<5;n++)assert.equal(await cache.put('radar',key(n),new Uint8Array([n,5])),true);
  assert.equal(await cache.get('radar',key(0)),null);
  assert.equal(await cache.get('radar',key(2)),null);
  assert.deepEqual(new Uint8Array(await cache.get('radar',key(3))),new Uint8Array([3,5]));
  assert.deepEqual(new Uint8Array(await cache.get('radar',key(4))),new Uint8Array([4,5]));
  assert.equal((await cache.stats('radar')).entries,2);
});
test('storage denial, unavailable browser storage and bad entries degrade safely',async()=>{
  const denied=createPersistentWeatherCache({storage:{open:async()=>{throw Error('denied')}}});
  assert.equal(await denied.get('radar',key(1)),null);
  assert.equal(await denied.put('radar',key(1),new Uint8Array([5])),false);
  assert.deepEqual(await denied.stats('radar'),{available:false,entries:0,bytes:0});
  const absent=createPersistentWeatherCache({storage:()=>undefined});
  assert.equal(await absent.get('icon',key(1)),null);
  assert.equal(await absent.put('icon',key(1),new Uint8Array([3])),false);
  const storage=fakeStorage(),cache=createPersistentWeatherCache({storage});
  await cache.put('radar',key(1),new Uint8Array([1,2,3]));
  const raw=await storage.open('openwetter-dwd-frames-v1-radar');
  await raw.put(key(1),new Response(new Uint8Array([1]),{headers:{'X-OpenWetter-Length':'999'}}));
  assert.equal(await cache.get('radar',key(1)),null);
});
test('radar identities remain independent of changing newest observation',async()=>{
  const storage=fakeStorage(),cache=createPersistentWeatherCache({storage});
  const url=key(1792922100);
  await cache.put('radar',url,new Uint8Array([31,139,8]));
  // A later manifest publication must not change the cache key for past radar frames.
  assert.deepEqual(new Uint8Array(await cache.get('radar',url)),new Uint8Array([31,139,8]));
});
