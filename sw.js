const CACHE = 'flappy12-web-v9';
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './js/atlas.js',
  './js/game.js',
  './js/presentation.js',
  './js/renderer.js',
  './js/audio.js',
  './js/input.js',
  './js/main.js',
  './assets/atlas.png',
  './assets/sfx_die.wav',
  './assets/sfx_hit.wav',
  './assets/sfx_point.wav',
  './assets/sfx_swooshing.wav',
  './assets/sfx_wing.wav',
  './assets/icons/icon-180.png',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;

  // Binary assets are immutable: cache-first for instant load.
  if (url.pathname.includes('/assets/')) {
    e.respondWith(
      caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
        }
        return res;
      }))
    );
    return;
  }

  // HTML & JS modules: network-first (bypassing 10-minute CDN cache) with offline fallback.
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' }).then(res => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
      }
      return res;
    }).catch(() => caches.match(e.request))
  );
});
