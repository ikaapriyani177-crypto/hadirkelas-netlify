const CACHE_NAME = 'hadirkelas-v3-no-pin';
const APP_SHELL = ['/', '/index.html', '/styles.css', '/app.js', '/manifest.json', '/assets/icon.svg'];
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))));
  self.clients.claim();
});
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.pathname === '/api' || url.pathname.startsWith('/.netlify/functions/')) return;
  if (url.origin !== self.location.origin) return;
  event.respondWith(fetch(event.request).then((response) => {
    if (response && response.ok) caches.open(CACHE_NAME).then((cache) => cache.put(event.request, response.clone()));
    return response;
  }).catch(() => caches.match(event.request).then((cached) => cached || caches.match('/index.html'))));
});
