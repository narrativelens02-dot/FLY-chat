/* =====================================================
   FLYchat Service Worker
   - Push notification support
   - Offline caching untuk asset statis
===================================================== */

const CACHE_NAME  = 'flychat-v1';
const CACHE_URLS  = [
  '/',
  '/index.html',
  '/css/style.css',
  '/js/app.js',
  '/js/firebase-config.js',
  '/assets/default-avatar.svg',
  '/assets/icon.svg',
  'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap'
];

/* Install — pre-cache static assets */
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(CACHE_URLS).catch(() => {
        // Non-fatal: beberapa URL CDN mungkin gagal saat offline
      });
    })
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

/* Fetch — network first, fallback ke cache */
self.addEventListener('fetch', event => {
  // Jangan cache Firebase / API calls
  const url = event.request.url;
  if (url.includes('firestore') || url.includes('firebase') ||
      url.includes('googleapis.com/identitytoolkit') ||
      url.includes('nominatim') || url.includes('openstreetmap')) {
    return;
  }
  event.respondWith(
    fetch(event.request)
      .then(res => {
        if (res && res.status === 200) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
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
      body:    data.body  || 'Pesan baru',
      icon:    '/assets/icon.svg',
      badge:   '/assets/icon.svg',
      vibrate: [200, 100, 200],
      data:    { url: data.url || '/' },
      actions: [
        { action: 'open',    title: 'Buka' },
        { action: 'dismiss', title: 'Abaikan' }
      ]
    })
  );
});

/* Klik notifikasi — buka / fokus app */
self.addEventListener('notificationclick', event => {
  event.notification.close();
  if (event.action === 'dismiss') return;
  const targetUrl = event.notification.data?.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
      for (const wc of windowClients) {
        if (wc.url === targetUrl && 'focus' in wc) return wc.focus();
      }
      if (clients.openWindow) return clients.openWindow(targetUrl);
    })
  );
});
