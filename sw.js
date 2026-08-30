// Network-first: her zaman sunucudan taze dosya çek, sadece offline'da cache'e dön
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request, { cache: 'no-store' })
      .catch(() => caches.match(e.request))
  );
});

// Yeni SW yüklenince hemen devral, eski SW'yi bekletme
self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(clients.claim()));
