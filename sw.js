// Cache-first for the app shell: once installed it opens instantly and works with no signal,
// which matters in a gym basement. Bump SHELL when you deploy and old copies clear themselves.
//
// AUDIT 2026-09-11 (finding F20). There was ONE cache, named after the build, holding the shell
// AND any downloaded exercise clips. Activation deletes the previous build's cache, so every
// update silently destroyed every clip the athlete had downloaded - and the new pre-cache
// contains no clips, so there was no way back except another download over mobile data. Media
// that is expensive to fetch and never changes does not belong in a cache keyed on the build
// that happened to be installed when it was fetched.
//
// Two caches, two lifecycles:
//   SHELL  card-shell-<build>   replaced on every deploy. Cheap to refetch.
//   MEDIA  card-media-v1        SURVIVES deploys. Cleared only by an explicit request from the
//                               card, or by the browser under storage pressure.
const BUILD = 'v237c';
const SHELL = 'card-shell-' + BUILD;
const MEDIA = 'card-media-v1';
const ASSETS = ['./', './index.html', './manifest.json', './icon.svg', './apple-touch-icon.png',
  './icon-192.png', './icon-512.png', './icon-maskable-192.png', './icon-maskable-512.png'];

// A cap, so a long clip library cannot quietly consume the device. Checked before a write, and
// the oldest entries go first. Without one, "keep media forever" becomes "fill the phone".
const MEDIA_MAX_ENTRIES = 120;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

// FOUND BY SECOND REVIEW 2026-09-10 (finding E). This deleted EVERY cache on the origin whose
// name was not ours. thundermeadows.github.io hosts more than this card, and any other app or
// page there had its offline storage wiped the moment a Training Card update activated. A
// service worker owns its own caches and nothing else. Ownership is the 'card-' prefix this app
// has always used; anything else on the origin is somebody else's and is left alone.
//
// F20: and within our own caches, the media cache is not a build artifact. It is kept.
const CACHE_OWNED = /^card-/;
const CACHE_KEEP = new Set([SHELL, MEDIA]);

// Upgrading from v236 or earlier, the clips an athlete downloaded are sitting in that build's
// shell cache, and this activation is about to delete it. Move them into the media cache FIRST.
// Without this, splitting the caches would cost every existing athlete their downloads exactly
// once - the very loss F20 is about - and they would have no way to tell it from a bug.
async function rescueClipsFromOldCaches() {
  try {
    const names = (await caches.keys()).filter(k => CACHE_OWNED.test(k) && !CACHE_KEEP.has(k));
    if (!names.length) return;
    const media = await caches.open(MEDIA);
    for (const name of names) {
      const old = await caches.open(name);
      for (const req of await old.keys()) {
        if (req.url.indexOf('/clips/') < 0) continue;
        if (await media.match(req)) continue;                 // already migrated
        const res = await old.match(req);
        if (storable(res)) { try { await media.put(req, res.clone()); } catch (x) {} }
      }
    }
  } catch (e) { /* a failed migration costs a re-download, never the shell */ }
}

self.addEventListener('activate', e => {
  e.waitUntil(rescueClipsFromOldCaches()
    .then(() => caches.keys())
    .then(keys => Promise.all(keys
      .filter(k => !CACHE_KEEP.has(k) && CACHE_OWNED.test(k))
      .map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// F20. `Cache.put` REJECTS a 206 Partial Content response, and video players issue range
// requests constantly. v236 put whatever came back, so a seek produced an unhandled rejection and
// nothing was cached; it also cached error responses, so one 503 during a deploy became a
// permanently broken manifest served from cache while offline.
//
// One rule for every cache write in this file: a response is storable only if it is a complete,
// successful, same-origin-or-CORS-readable answer.
function storable(res) {
  return !!res
    && res.status === 200                 // not 206, not 204, not an error
    && !res.bodyUsed
    && (res.type === 'basic' || res.type === 'cors' || res.type === 'default');
}

async function putIfStorable(cacheName, req, res) {
  if (!storable(res)) return false;
  try {
    const c = await caches.open(cacheName);
    await c.put(req, res);
    return true;
  } catch (e) {
    return false;                          // quota, an opaque response, a rejected 206
  }
}

// Oldest-first trim. Cache.keys() returns insertion order, which is close enough to
// least-recently-added for this purpose and needs no side table to maintain.
async function trimMedia() {
  try {
    const c = await caches.open(MEDIA);
    const keys = await c.keys();
    if (keys.length <= MEDIA_MAX_ENTRIES) return;
    for (const k of keys.slice(0, keys.length - MEDIA_MAX_ENTRIES)) await c.delete(k);
  } catch (e) {}
}

// A range request cannot be answered from Cache.match with the full response - the player needs
// a 206 with a Content-Range. Slice the cached body ourselves so a downloaded clip can be seeked
// offline, which is the whole point of downloading it.
async function rangeFromCache(req) {
  const range = req.headers.get('range');
  const hit = await caches.match(new Request(req.url), { cacheName: MEDIA });
  if (!hit) return null;
  if (!range) return hit;
  const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!m) return hit;
  const buf = await hit.arrayBuffer();
  const total = buf.byteLength;
  let start = m[1] === '' ? null : parseInt(m[1], 10);
  let end = m[2] === '' ? null : parseInt(m[2], 10);
  if (start === null && end === null) return hit;
  if (start === null) { start = Math.max(0, total - end); end = total - 1; }      // suffix range
  if (end === null || end >= total) end = total - 1;
  if (start > end || start >= total) {
    return new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */' + total } });
  }
  const slice = buf.slice(start, end + 1);
  return new Response(slice, {
    status: 206,
    headers: {
      'Content-Type': hit.headers.get('Content-Type') || 'application/octet-stream',
      'Content-Length': String(slice.byteLength),
      'Content-Range': 'bytes ' + start + '-' + end + '/' + total,
      'Accept-Ranges': 'bytes'
    }
  });
}

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const isPage = e.request.mode === 'navigate'
    || e.request.url.endsWith('/') || e.request.url.endsWith('/index.html');

  if (isPage) {
    // NETWORK-FIRST for the page itself: a deploy shows up on the very next open. The cache is
    // the offline fallback, not the front door - cache-first here is how an update can hide
    // behind a stale copy indefinitely.
    // Race the network against a short clock: on a slow or flaky connection, iOS sits on the
    // resume snapshot until this fetch settles - an untimed fetch can pin a stale screenshot
    // over a frozen-looking app for 30+ seconds. 3.5s and the cached copy takes over; the fresh
    // deploy still lands on the next good-signal open.
    e.respondWith(
      Promise.race([
        fetch(e.request),
        new Promise((_, rej) => setTimeout(() => rej(new Error('sw-timeout')), 3500))
      ]).then(async res => {
        if (storable(res)) {
          const copy = res.clone();
          e.waitUntil(putIfStorable(SHELL, e.request, copy));
          return res;
        }
        // AUDIT 2026-09-11 (finding N11). Fallback only ran on a REJECTED fetch - a timeout or a
        // dead network. An HTTP error RESOLVES, so a 502 from the host or a 503 during a deploy
        // was handed straight to the athlete as an error page while a perfectly good copy of the
        // app sat in the cache. In a gym with flaky wifi that is the common case.
        const hit = await caches.match(e.request) || await caches.match('./index.html');
        return hit || res;
      }).catch(() => caches.match(e.request).then(hit => hit || caches.match('./index.html')))
    );
    return;
  }

  // The clip LIST must stay fresh, or clips added later would never appear: network first,
  // falling back to the cached copy only when offline.
  //
  // F20: and ONLY a successful response is cached. v236 cached whatever came back, so a 503
  // during a deploy replaced a good manifest with an error and then served that error offline,
  // for as long as the build lasted.
  if (e.request.url.indexOf('/clips/index.json') > -1) {
    e.respondWith(
      fetch(e.request).then(async res => {
        if (storable(res)) {
          const copy = res.clone();
          e.waitUntil(putIfStorable(MEDIA, e.request, copy));
          return res;
        }
        const hit = await caches.match(e.request, { cacheName: MEDIA });
        return hit || res;                    // a stale good manifest beats a fresh broken one
      }).catch(() => caches.match(e.request, { cacheName: MEDIA }))
    );
    return;
  }

  // Clips: cache-first and KEPT ACROSS UPDATES. They never change once filmed, and a clip that
  // has been watched once must still play in a gym basement with no signal - including seeking,
  // which is a range request the cache cannot answer on its own.
  if (e.request.url.indexOf('/clips/') > -1) {
    e.respondWith((async () => {
      const cached = await rangeFromCache(e.request);
      if (cached) return cached;
      try {
        // Fetch the WHOLE file rather than the requested range, so what lands in the cache is a
        // complete, seekable clip. A 206 cannot be stored and a cache full of fragments cannot
        // serve an offline player.
        const full = await fetch(new Request(e.request.url, { headers: {} }));
        if (storable(full)) {
          const copy = full.clone();
          e.waitUntil(putIfStorable(MEDIA, new Request(e.request.url), copy).then(trimMedia));
          if (e.request.headers.get('range')) {
            const viaCache = await rangeFromCache(e.request);
            if (viaCache) return viaCache;
          }
        }
        return full;
      } catch (err) {
        return new Response(null, { status: 504 });
      }
    })());
    return;
  }

  // assets (icon, manifest): cache-first with quiet refresh - they change rarely
  e.respondWith(
    caches.match(e.request).then(hit => {
      const net = fetch(e.request).then(res => {
        if (storable(res)) {
          const copy = res.clone();
          e.waitUntil(putIfStorable(SHELL, e.request, copy));
        }
        return res;
      }).catch(() => hit);
      return hit || net;
    })
  );
});

// The card asks for its downloaded media to be cleared - from Settings, or before an erase.
// Media outlives deploys now, so there has to be a way to get rid of it that is not "uninstall".
self.addEventListener('message', e => {
  const d = e.data || {};
  if (d.type === 'CLEAR_MEDIA') {
    e.waitUntil(caches.delete(MEDIA).then(ok => {
      try { e.source && e.source.postMessage({ type: 'MEDIA_CLEARED', ok: !!ok }); } catch (x) {}
    }));
  }
  if (d.type === 'MEDIA_USAGE') {
    e.waitUntil(caches.open(MEDIA).then(c => c.keys()).then(keys => {
      try { e.source && e.source.postMessage({ type: 'MEDIA_USAGE', count: keys.length, max: MEDIA_MAX_ENTRIES }); } catch (x) {}
    }).catch(() => {}));
  }
  if (d.type === 'SKIP_WAITING') self.skipWaiting();
});
