/** Persistent cache of COMPRESSED public DWD weather frames.
 * Android WebView disables the service worker, so CacheStorage is used directly.
 * No basemap bulk downloads, private values, API keys or credentials are stored.
 */
const DEFAULT_LIMITS=Object.freeze({radar:30,icon:315,series:18});
const MAX_FILE_BYTES=16*1024*1024;

export function createPersistentWeatherCache({
  storage=()=>globalThis.caches,
  namespace='openwetter-dwd-frames-v1',
  maxEntries=DEFAULT_LIMITS,
}={}){
  const name=kind=>namespace+'-'+kind;
  const validKind=kind=>Object.hasOwn(maxEntries,kind)&&Number.isInteger(maxEntries[kind])&&maxEntries[kind]>0;
  async function open(kind){
    if(!validKind(kind))return null;
    try{
      const backend=typeof storage==='function'?storage():storage;
      if(!backend?.open)return null;
      return await backend.open(name(kind));
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
      // One complete 48-hour ICON-D2 cycle (291 map frames) fits at once.
      // Radar retains all 24 observed frames plus a little headroom.
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
  return {get,put,stats};
}

export const weatherDiskCache=createPersistentWeatherCache();
