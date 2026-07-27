/* Service Worker for Promise App PWA Installation & Offline Support */
const CACHE_VERSION = 'v42';
const CACHE_NAME = `promise-app-${CACHE_VERSION}`;

// 쿼리스트링(?v=) 없이 등록하고, 조회 시 ignoreSearch 로 매칭한다.
const ASSETS = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './js/gps.js',
  './manifest.json',
  './images/icon-192.png',
  './images/icon-512.png',
  './images/default_profile.jpg'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      // 개별 실패가 전체 설치를 막지 않도록 하나씩 추가
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

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // 외부 도메인(Firebase, 지도 타일, Nominatim 등)은 캐싱하지 않고 네트워크에 맡긴다.
  if (url.origin !== self.location.origin) return;

  // 페이지 이동 요청: 네트워크 우선, 실패 시 캐시된 index.html
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

  // 정적 자산: 캐시 우선 + 백그라운드 갱신 (stale-while-revalidate)
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
