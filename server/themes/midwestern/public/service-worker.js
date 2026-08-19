const CACHE_NAME = 'central-west-alerts-static-v13-pwa-refresh';
const STATIC_ASSETS = [
  '/stylesheets/style.css',
  '/stylesheets/textAngular.css',
  '/javascripts/central-west.js',
  '/images/agencies/rfs.png',
  '/images/agencies/ses.svg',
  '/images/agencies/vra.png',
  '/favicon.ico',
  '/manifest.json'
];

self.addEventListener('install', function (event) {
  event.waitUntil(caches.open(CACHE_NAME).then(function (cache) { return cache.addAll(STATIC_ASSETS); }));
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (key) { return key !== CACHE_NAME; }).map(function (key) { return caches.delete(key); }));
  }));
  self.clients.claim();
});

self.addEventListener('fetch', function (event) {
  var url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.indexOf('/api/') === 0 || url.pathname.indexOf('/auth/') === 0) return;
  if (STATIC_ASSETS.indexOf(url.pathname) === -1) return;
  event.respondWith(caches.match(event.request).then(function (cached) {
    var network = fetch(event.request).then(function (response) {
      if (response.ok) caches.open(CACHE_NAME).then(function (cache) { cache.put(event.request, response.clone()); });
      return response;
    });
    return cached || network;
  }));
});
