/** Persistent cache of COMPRESSED, immutable public weather files
 * (lossless WebP tiles, gzip series blocks, DWD WMS PNGs).
 * Android WebView disables the service worker, so CacheStorage is used directly.
 * No basemap bulk downloads, private values, API keys or credentials are stored.
 */
const DEFAULT_LIMITS=Object.freeze({icon:700,radar:400,series:40,wms:360});
const MAX_FILE_BYTES=16*1024*1024;
export const CACHE_NAMESPACE='openwetter-tiles-v2';

export function createPersistentWeatherCache({
  storage=()=>globalThis.caches,
  namespace=CACHE_NAMESPACE,
  maxEntries=DEFAULT_LIMITS,
}={}){
  const name=kind=>namespace+'-'+kind;
  const validKind=kind=>Object.hasOwn(maxEntries,kind)&&Number.isInteger(maxEntries[kind])&&maxEntries[kind]>0;
  const backend=()=>{try{return typeof storage==='function'?storage():storage;}catch{return null;}};
  async function open(kind){
    if(!validKind(kind))return null;
    try{
      const b=backend();
      if(!b?.open)return null;
      return await b.open(name(kind));
    }catch{return null;} // private browsing, quota denial or unsupported WebView
  }
  async function get(kind,url){
    const cache=await open(kind);
    if(!cache)return null;
    try{
      const response=await cache.match(url);
      if(!response)return null;
      const bytes=await response.arrayBuffer();
      const expected=Number(response.headers.get('X-OpenWetter-Length'));
      if(bytes.byteLength<1||bytes.byteLength>MAX_FILE_BYTES||
         !Number.isFinite(expected)||expected!==bytes.byteLength){
        await cache.delete(url);
        return null;
      }
      return bytes;
    }catch{return null;}
  }
  async function put(kind,url,bytes){
    if(!validKind(kind)||!bytes||bytes.byteLength<1||bytes.byteLength>MAX_FILE_BYTES)return false;
    const cache=await open(kind);
    if(!cache)return false;
    try{
      await cache.put(url,new Response(bytes,{headers:{
        'Content-Type':'application/octet-stream',
        'X-OpenWetter-Length':String(bytes.byteLength),
      }}));
      const keys=await cache.keys();
      // Oldest insertions are evicted first; URLs are immutable, so an
      // evicted file is simply fetched again when next needed.
      for(const req of keys.slice(0,Math.max(0,keys.length-maxEntries[kind])))
        await cache.delete(req);
      return true;
    }catch{return false;}
  }
  async function stats(kind){
    const cache=await open(kind);
    if(!cache)return {available:false,entries:0,bytes:0};
    try{
      const keys=await cache.keys();
      let bytes=0;
      for(const key of keys){
        const response=await cache.match(key);
        bytes+=Number(response?.headers.get('X-OpenWetter-Length'))||0;
      }
      return {available:true,entries:keys.length,bytes};
    }catch{return {available:false,entries:0,bytes:0};}
  }
  /** Remove caches of retired data formats (e.g. the old GitHub gzip frames). */
  async function dropOtherNamespaces(prefix='openwetter-dwd-frames-'){
    try{
      const b=backend();
      if(!b?.keys||!b?.delete)return 0;
      const old=(await b.keys()).filter(k=>k.startsWith(prefix));
      await Promise.all(old.map(k=>b.delete(k)));
      return old.length;
    }catch{return 0;}
  }
  return {get,put,stats,dropOtherNamespaces};
}

export const weatherDiskCache=createPersistentWeatherCache();
