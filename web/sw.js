// Offline app shell only. Do not bulk-cache OSM or radar imagery.
const CACHE='openwetter-shell-6';
const FILES=['./','./index.html','./styles.css','./app.js','./logic.mjs','./native-fields.mjs','./frame-cache.mjs','./icon-grid.mjs','./manifest.webmanifest','./icons/192.png','./icons/512.png'];
self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(FILES)).then(()=>self.skipWaiting()));});
self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',event=>{
  const url=new URL(event.request.url);
  if(url.origin!==self.location.origin || event.request.method!=='GET')return;
  event.respondWith(caches.match(event.request).then(cached=>cached||fetch(event.request)));
});
