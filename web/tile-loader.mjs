/** Network access to the OpenWetter tile service.
 * - Rolling pointers (latest.json and the radar, nowcast and warnings index.json) use a short in-memory TTL
 *   and HTTP revalidation; a 404 resolves to null so callers can hide the
 *   feature instead of failing.
 * - Everything under a run/issue/time path is immutable: kept compressed in
 *   CacheStorage (frame-cache.mjs) and fetched at most once concurrently.
 */
import {weatherDiskCache} from './frame-cache.mjs';
import {isGzip} from './tile-service.mjs';

const MAX_PARALLEL=4;
let active=0;
const queue=[];
const inflight=new Map();
const jsonMemo=new Map();

function limited(task){
  return new Promise((resolve,reject)=>{
    const run=()=>{active++;task().then(resolve,reject).finally(()=>{active--;queue.shift()?.();});};
    if(active<MAX_PARALLEL)run();else queue.push(run);
  });
}
/** Short-lived JSON (pointer/index files). Returns null on HTTP 404/403. */
export async function fetchPointer(url,{ttlMs=60_000,signal}={}){
  const memo=jsonMemo.get(url);
  if(memo&&Date.now()-memo.at<ttlMs)return memo.value;
  if(memo?.pending)return memo.pending;
  const pending=(async()=>{
    const response=await fetch(url,{cache:'no-cache',signal});
    if(response.status===404||response.status===403)return null;
    if(!response.ok)throw new Error('HTTP '+response.status);
    return response.json();
  })();
  jsonMemo.set(url,{...memo,pending});
  try{
    const value=await pending;
    jsonMemo.set(url,{at:Date.now(),value});
    return value;
  }catch(error){
    if(memo)jsonMemo.set(url,memo);else jsonMemo.delete(url);
    throw error;
  }
}
/** Run manifests: small, kept in memory for the session and left to the
 * normal HTTP cache (not CacheStorage), so a manifest re-published under the
 * same run path is picked up on the next app start. */
export async function fetchImmutableJSON(url){
  const memo=jsonMemo.get(url);
  if(memo?.immutable)return memo.value;
  if(memo?.pending)return memo.pending;
  const pending=(async()=>{
    const response=await limited(()=>fetch(url,{cache:'default'}));
    if(!response.ok)throw new Error('HTTP '+response.status);
    return response.json();
  })();
  jsonMemo.set(url,{pending});
  try{const value=await pending;jsonMemo.set(url,{immutable:true,value});return value;}
  catch(error){jsonMemo.delete(url);throw error;}
}
/** Bytes of an immutable file; persistent disk cache, de-duplicated, capped. */
export function immutableBytes(url,kind){
  if(inflight.has(url))return inflight.get(url);
  const job=(async()=>{
    const stored=await weatherDiskCache.get(kind,url);
    if(stored)return stored;
    const bytes=await limited(async()=>{
      const response=await fetch(url,{cache:'default'});
      if(!response.ok){const e=new Error('HTTP '+response.status);e.status=response.status;throw e;}
      return response.arrayBuffer();
    });
    await weatherDiskCache.put(kind,url,bytes);
    return bytes;
  })().finally(()=>inflight.delete(url));
  inflight.set(url,job);
  return job;
}
export async function tileBlob(url,kind){
  return new Blob([await immutableBytes(url,kind)],{type:'image/webp'});
}
async function gunzip(bytes){
  if(typeof DecompressionStream!=='function')throw new Error('gzip streaming unsupported in this WebView');
  return new Response(new Response(bytes).body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
}
/** Point-series block. Cloudflare may already have removed the gzip layer
 * (Content-Encoding), so sniff the magic bytes before inflating. */
export async function seriesBytes(url){
  const raw=await immutableBytes(url,'series');
  return isGzip(new Uint8Array(raw,0,Math.min(4,raw.byteLength)))?gunzip(raw):raw;
}
export function loaderStats(){return {active,queued:queue.length,inflight:inflight.size};}
