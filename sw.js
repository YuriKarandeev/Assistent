/* Service worker приложения «Личный ассистент».
   Оболочка кэшируется, запросы к Firebase и CDN не перехватываются.
   Навигация — network-first: после обновления файла достаточно перезагрузить страницу. */
const CACHE_NAME = 'assistant-planer-v12';

const SHELL = [
  './',
  './index.html',
  './sync-merge.js',
  './ai.js',
  './voice.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-512-maskable.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then(function (cache) {
        // По одному: один отсутствующий файл не должен ломать установку
        return Promise.all(
          SHELL.map(function (url) {
            return cache.add(url).catch(function () { return null; });
          })
        );
      })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches
      .keys()
      .then(function (keys) {
        return Promise.all(
          keys.map(function (key) {
            return key === CACHE_NAME ? null : caches.delete(key);
          })
        );
      })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // Firebase, gstatic — напрямую

  // Навигация: сеть, при офлайне — кэшированная оболочка
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(function () {
        return caches.match('./index.html').then(function (cached) {
          return cached || Response.error();
        });
      })
    );
    return;
  }

  // Статика: из кэша сразу, обновление — в фоне
  event.respondWith(
    caches.match(request).then(function (cached) {
      const network = fetch(request)
        .then(function (response) {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then(function (cache) { cache.put(request, copy); });
          }
          return response;
        })
        .catch(function () { return cached || Response.error(); });
      return cached || network;
    })
  );
});
