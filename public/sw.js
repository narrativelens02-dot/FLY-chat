/* =====================================================
   FLYchat Service Worker v2 — Neon Backend
   - Offline caching untuk asset statis
   - Push notification support
===================================================== */

const CACHE_NAME = 'flychat-v2';
const CACHE_URLS = [
  '/',
  '/index.html',
  '/css/style.css',
  '/js/app.js',
  '/assets/default-avatar.svg',
  '/assets/icon.svg',
  'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap'
];

/* Install */
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(CACHE_URLS).catch(() => {}))
  );
  self.skipWaiting();
});

/* Activate — hapus cache lama */
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

/* Fetch — network first, fallback cache */
self.addEventListener('fetch', event => {
  const url = event.request.url;
  // Jangan cache API calls, socket.io, atau external services
  if (url.includes('/api/') || url.includes('socket.io') ||
      url.includes('nominatim') || url.includes('openstreetmap') ||
      url.includes('accounts.google.com')) {
    return;
  }
  event.respondWith(
    fetch(event.request)
      .then(res => {
        if (res && res.status === 200) {
          caches.open(CACHE_NAME).then(c => c.put(event.request, res.clone()));
        }
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});

/* Push notification */
self.addEventListener('push', event => {
  if (!event.data) return;
  let data = {};
  try { data = event.data.json(); } catch { data = { title: 'FLYchat', body: event.data.text() }; }
  event.waitUntil(
    self.registration.showNotification(data.title || 'FLYchat 🦋', {
      body:    data.body || 'Pesan baru',
      icon:    '/assets/icon.svg',
      badge:   '/assets/icon.svg',
      vibrate: [200, 100, 200],
      data:    { url: '/' }
    })
  );
});

/* Klik notifikasi */
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(wcs => {
      for (const wc of wcs) { if ('focus' in wc) return wc.focus(); }
      if (clients.openWindow) return clients.openWindow('/');
    })
  );
});
