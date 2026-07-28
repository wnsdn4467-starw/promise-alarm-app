/* Service Worker for Promise App PWA Installation & Offline Support */
const CACHE_VERSION = 'v107';
const CACHE_NAME = `promise-app-${CACHE_VERSION}`;

// ì¿¼ë¦¬?¤íŠ¸ë§??v=) ?†ì´ ?±ë¡?˜ê³ , ì¡°íšŒ ??ignoreSearch ë¡?ë§¤ì¹­?œë‹¤.
const ASSETS = [
  './',
  './index.html',
  './css/style.css',
  './css/enhance.css',
  './js/app.js',
  './js/gps.js',
  './manifest.json',
  './images/app_icon.png',
  './images/icon-192.png',
  './images/icon-512.png',
  './images/default_profile.jpg'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      // ê°œë³„ ?¤íŒ¨ê°€ ?„ì²´ ?¤ì¹˜ë¥?ë§‰ì? ?Šë„ë¡??˜ë‚˜??ì¶”ê?
      .then((cache) => Promise.all(
        ASSETS.map((url) => cache.add(new Request(url, { cache: 'reload' })).catch(() => null))
      ))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ?½ì† ?¬ì „ ?Œë¦¼(1?œê°„/30ë¶?10ë¶?5ë¶?1ë¶???????•˜ë©??±ìœ¼ë¡?ë³µê??œí‚¨??
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('./index.html');
    })
  );
});

self.addEventListener('fetch', (e) => {  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // ?¸ë? ?„ë©”??Firebase, ì§€???€?? Nominatim ???€ ìºì‹±?˜ì? ?Šê³  ?¤íŠ¸?Œí¬??ë§¡ê¸´??
  if (url.origin !== self.location.origin) return;

  // ?˜ì´ì§€ ?´ë™ ?”ì²­: ?¤íŠ¸?Œí¬ ?°ì„ , ?¤íŒ¨ ??ìºì‹œ??index.html
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put('./index.html', clone));
          return res;
        })
        .catch(() => caches.match('./index.html', { ignoreSearch: true }))
    );
    return;
  }

  // ??ì½”ë“œ(js/css)?€ manifest: ?¤íŠ¸?Œí¬ ?°ì„ .
  // ë°°í¬ ì§í›„ ?°ì—????ì½”ë“œê°€ ??ë²????¨ëŠ” ë¬¸ì œë¥?ë§‰ëŠ”?? (?¤í”„?¼ì¸???Œë§Œ ìºì‹œ ?¬ìš©)
  if (/\.(js|css)$/i.test(url.pathname) || url.pathname.endsWith('/manifest.json')) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.status === 200 && res.type === 'basic') {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
          }
          return res;
        })
        .catch(() => caches.match(req, { ignoreSearch: true }))
    );
    return;
  }

  // ?•ì  ?ì‚°: ìºì‹œ ?°ì„  + ë°±ê·¸?¼ìš´??ê°±ì‹  (stale-while-revalidate)
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.status === 200 && res.type === 'basic') {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
          }
          return res;
        })
        .catch(() => cached);

      return cached || network;
    })
  );
});
