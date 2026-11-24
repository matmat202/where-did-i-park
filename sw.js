/* Service worker: cache everything, forever.
 *
 * This app has no server and no remote data — the only network requests are its own
 * files and the webfont. So it is cache-first across the board, which means it opens
 * instantly in a parking garage with no signal, which is exactly where it is needed.
 */
/* The page's module imports carry ?v=VERSION (index.html, zone.js; test.mjs holds them to
 * it). Navigations are network-first, so a phone opens the NEW index.html while the OLD
 * worker still answers for scripts from its cache; with bare './detector.js' that handed
 * the new page the old module, and an import the old one lacked (guideWatch, 2026-11-12)
 * killed the whole page on the first open after an update. A versioned URL is a cache
 * miss for any older worker, so the page and its modules always arrive as one release. */
const VERSION = 'park-v13';
const MODS = ['./detector.js', './landmarks.js', './zone.js', './zones.js'].map(u => `${u}?v=${VERSION}`);
const SHELL = ['./', './index.html', ...MODS, './manifest.webmanifest',
               './icons/icon-180.png', './icons/icon-192.png', './icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION)
    .then(c => Promise.all(SHELL.map(u =>   // past the HTTP cache: Pages allows 10 min
      c.add(new Request(u, { cache: 'reload' })).catch(() => {}))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(k => Promise.all(k.filter(x => x !== VERSION).map(x => caches.delete(x))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  // Navigations go network-first so an update lands, falling back to the cached shell.
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).catch(() => caches.match('./index.html')));
    return;
  }
  e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
    if (res.ok && new URL(req.url).origin === self.location.origin) {
      const copy = res.clone();
      caches.open(VERSION).then(c => c.put(req, copy));
    }
    return res;
  }).catch(() => hit)));
});
