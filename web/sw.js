// Offline app shell only. Do not bulk-cache OSM, radar or forecast imagery;
// immutable weather tiles are cached separately by frame-cache.mjs.
const CACHE='openwetter-shell-14';
const FILES=['./','./index.html','./styles.css','./app.js','./logic.mjs','./tile-service.mjs','./tile-loader.mjs','./raster-renderer.mjs','./frame-transition.mjs','./frame-cache.mjs','./forecast.mjs','./meteogram.mjs','./gestures.mjs','./icons.mjs','./manifest.webmanifest','./icons/192.png','./icons/512.png'];
self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(FILES)).then(()=>self.skipWaiting()));});
self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('openwetter-shell-')&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',event=>{
  const url=new URL(event.request.url);
  if(url.origin!==self.location.origin || event.request.method!=='GET')return;
  event.respondWith(caches.match(event.request).then(cached=>cached||fetch(event.request)));
});
