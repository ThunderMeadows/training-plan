// Cache-first for the app shell: once installed it opens instantly and works with no signal,
// which matters in a gym basement. Bump CACHE when you deploy and old copies clear themselves.
const CACHE = 'card-v61y-c19y';
const ASSETS = ['./', './index.html', './manifest.json', './icon.svg', './apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const isPage = e.request.mode === 'navigate'
    || e.request.url.endsWith('/') || e.request.url.endsWith('/index.html');
  if (isPage) {
    // NETWORK-FIRST for the page itself: a deploy shows up on the very next open.
    // The cache is the offline fallback, not the front door - cache-first here is how
    // an update can hide behind a stale copy indefinitely.
    // Race the network against a short clock: on a slow or flaky connection, iOS sits on the
    // resume snapshot until this fetch settles - an untimed fetch can pin a stale screenshot
    // (whatever was last on screen) over a frozen-looking app for 30+ seconds. 3.5s and the
    // cached copy takes over; the fresh deploy still lands on the next good-signal open.
    e.respondWith(
      Promise.race([
        fetch(e.request),
        new Promise((_, rej) => setTimeout(() => rej(new Error('sw-timeout')), 3500))
      ]).then(res => {
        if (res && res.status === 200) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
        }
        return res;
      }).catch(() => caches.match(e.request).then(hit => hit || caches.match('./index.html')))
    );
    return;
  }
  // how-to clips: cache-first and keep them. They never change once filmed, and a clip that
  // has been watched once must still play in a gym basement with no signal.
  // the clip LIST must stay fresh, or clips added later would never appear: network first,
  // falling back to the cached copy only when offline.
  if (e.request.url.indexOf('/clips/index.json') > -1) {
    e.respondWith(
      fetch(e.request).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return res;
      }).catch(() => caches.match(e.request))
    );
    return;
  }
  if (e.request.url.indexOf('/clips/') > -1) {
    e.respondWith(
      caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return res;
      }).catch(() => hit))
    );
    return;
  }
  // assets (icon, manifest): cache-first with quiet refresh - they change rarely
  e.respondWith(
    caches.match(e.request).then(hit => {
      const net = fetch(e.request).then(res => {
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
        }
        return res;
      }).catch(() => hit);
      return hit || net;
    })
  );
});
