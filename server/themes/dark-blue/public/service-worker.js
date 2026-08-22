const CACHE_NAME = 'central-west-alerts-static-v14-web-push';
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

self.addEventListener('push', function(event) {
  var data = {};
  try { data = event.data ? event.data.json() : {}; } catch (error) { data = {body: event.data.text()}; }
  event.waitUntil(self.registration.showNotification(data.title || 'Central West Alerts', {
    body: data.body || 'A new pager message was received.',
    icon: '/favicon.ico',
    badge: '/favicon.ico',
    tag: data.tag || 'central-west-alert',
    data: {url: data.url || '/'}
  }));
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  var target = event.notification.data && event.notification.data.url || '/';
  event.waitUntil(clients.matchAll({type: 'window', includeUncontrolled: true}).then(function(windows) {
    for (var i = 0; i < windows.length; i += 1) {
      if ('focus' in windows[i]) {
        windows[i].navigate(target);
        return windows[i].focus();
      }
    }
    return clients.openWindow(target);
  }));
});
