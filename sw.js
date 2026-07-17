// Minimal offline service worker: cache-first for same-origin app shell.
// Cache name carries the build version so a new release busts the old cache.
const CACHE = "edit-pwa-1.1.22";
const ASSETS = [
  "./", "index.html", "app.css", "chrome-shim.js", "bookmarklet.js",
  "store.js", "extract.js", "popup.js", "manifest.webmanifest", "icon.svg", "icon-128.png",
];
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
// Network-first for same-origin GETs: always show the latest deploy when online,
// fall back to cache offline. (Cache-first made redeploys look "stuck".)
self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  e.respondWith(
    fetch(req).then((res) => {
      // Skip caching share-target / hash-add query navigations (unbounded, never
      // reused) and non-OK/redirected responses (cache.put rejects on redirected).
      if (res && res.ok && !res.redirected && !url.search) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => { /* ignore */ });
      }
      return res;
    }).catch(() => caches.match(req).then((r) => r || caches.match("index.html")))
  );
});
