/* Service worker приложения «Личный ассистент».
   Оболочка кэшируется, запросы к Firebase и CDN не перехватываются.
   Навигация — network-first: после обновления файла достаточно перезагрузить страницу.

   Про кэш GitHub Pages: статика отдаётся с Cache-Control: max-age=600, и
   обычный cache.add() складывал в новый кэш файлы из HTTP-кэша — то есть
   старые. Поэтому при установке запрашиваем с cache: 'reload' (в обход
   HTTP-кэша), а фоновое обновление — с cache: 'no-cache' (ревалидация,
   но без повторной загрузки неизменившегося файла). */
const CACHE_NAME = 'assistant-planer-v14';

const SHELL = [
  './',
  './index.html',
  './sync-merge.js',
  './ai.js',
  './voice.js',
  './push.js',
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
        // По одному: один отсутствующий файл не должен ломать установку.
        // cache: 'reload' — иначе браузер отдаст копию из HTTP-кэша (Pages
        // держит статику 10 минут) и новый кэш соберётся из старых файлов.
        return Promise.all(
          SHELL.map(function (url) {
            return cache.add(new Request(url, { cache: 'reload' })).catch(function () { return null; });
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

/* ---------- Уведомления ---------- */
/* Отправитель — GitHub Actions (cron), а не страница: iOS не даёт закрытому
   приложению никаких таймеров. Тело приходит в JSON: { title, body, tag, url }. */
self.addEventListener('push', function (event) {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { body: event.data ? event.data.text() : '' };
  }
  const title = data.title || 'Напоминание';
  const options = {
    body: data.body || 'Пора заняться делом',
    // Один и тот же ключ не висит в шторке дважды
    tag: data.tag || 'planer',
    icon: './icons/icon-192.png',
    badge: './icons/icon-192.png',
    data: { url: data.url || './', key: data.key || '' }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

/* Тап по уведомлению: если приложение уже открыто — фокусируем и переходим
   на нужную вкладку, иначе открываем новое окно. */
self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  const raw = (event.notification.data && event.notification.data.url) || './';
  let target;
  try {
    target = new URL(raw, self.registration.scope).href;
  } catch (e) {
    target = self.registration.scope;
  }
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
      const same = list.filter(function (client) {
        return client.url && client.url.indexOf(self.registration.scope) === 0;
      })[0];
      if (!same) return self.clients.openWindow(target);
      return same.focus().then(function (client) {
        if (client && typeof client.navigate === 'function' && client.url !== target) {
          return client.navigate(target).catch(function () { return client; });
        }
        return client;
      }).catch(function () { return same; });
    })
  );
});

/* Браузер сменил endpoint сам. Записать новую подписку в Firestore здесь нельзя
   (нет сессии Firebase), поэтому просим страницу пересоздать её при открытии. */
self.addEventListener('pushsubscriptionchange', function (event) {
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
      list.forEach(function (client) {
        if (client && typeof client.postMessage === 'function') {
          client.postMessage({ type: 'push-resubscribe' });
        }
      });
    })
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
      const network = fetch(request, { cache: 'no-cache' })
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
