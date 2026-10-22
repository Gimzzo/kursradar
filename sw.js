// Kursradar Service Worker: App-Hülle offline-fähig, Marktdaten immer live (nicht gecacht)
const CACHE = 'kursradar-v4';
const SHELL = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png', './apple-touch-icon.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const req = e.request; if (req.method !== 'GET') return;
  let u; try { u = new URL(req.url); } catch (err) { return; }
  if (u.origin !== self.location.origin) return; // API-Aufrufe (CoinGecko, Yahoo, Claude …) nie cachen
  if (u.pathname.includes('/data/')) { e.respondWith(fetch(req).catch(() => new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } }))); return; } // Datenfeed immer frisch
  e.respondWith(fetch(req).then(r => { if (r && r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(req, copy)); } return r; }).catch(() => caches.match(req).then(m => m || caches.match('./index.html'))));
});
