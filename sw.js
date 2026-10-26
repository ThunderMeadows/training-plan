const BUILD = 'v253-preview';

const SCOPE_TAG = function() {
    try {
        var p = new URL(self.registration.scope).pathname || '/';
        var t = p.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
        return t || 'root';
    } catch (e) {
        return 'root';
    }
}();

const SHELL = 'card-shell-' + SCOPE_TAG + '-' + BUILD;

const MEDIA = 'card-media-' + SCOPE_TAG + '-v1';

const CATALOG = 'card-catalog-' + SCOPE_TAG + '-v1';

const CATALOG_URL = '/clips/index.json';

const ASSETS = [ './', './index.html', './manifest.json', './icon.svg', './apple-touch-icon.png', './icon-192.png', './icon-512.png', './icon-maskable-192.png', './icon-maskable-512.png', './assets/img/run-run1.46ebdf3e76.webp', './assets/img/run-crouch.a5b9584441.webp', './assets/img/run-slideStart.d14c1117e6.webp', './assets/img/run-slideFlat.6f46b25e0b.webp', './assets/img/run-rise.70abb3d2ab.webp', './assets/img/run-run2.c156c1557e.webp', './assets/img/bulk-front.01a1fd3269.webp', './assets/img/bulk-sideL.d3fce6be8b.webp', './assets/img/bulk-back.52c187b5c9.webp', './assets/img/bulk-sideR.875f6e68f6.webp', './assets/img/bulk-tail.99495f7693.webp', './assets/img/mail-focused.1db6c6ac15.webp', './assets/img/mail-encouraging.504ef5d890.webp', './assets/img/mail-tough.2282b5a70c.webp', './assets/img/mail-playful.09dbd30ea5.webp', './assets/img/mail-reflective.da3fd77153.webp', './assets/img/anatomy-mask.6f15e48cb5.webp' ];

const MEDIA_MAX_ENTRIES = 120;

const PAGE_RACE_MS = 3500;

const MEDIA_MAX_BYTES = 300 * 1024 * 1024;

async function shellMatch(req) {
    try {
        const c = await caches.open(SHELL);
        return await c.match(req, {
            ignoreSearch: true
        }) || await c.match('./index.html');
    } catch (e) {
        return undefined;
    }
}

self.addEventListener('install', e => {
    e.waitUntil(caches.open(SHELL).then(c => c.addAll(ASSETS.map(u => new Request(u, {
        cache: 'reload'
    })))).then(() => self.skipWaiting()));
});

const CACHE_OWNED = new RegExp('^card-(?:shell|media|catalog)-' + SCOPE_TAG + '-');

const CACHE_KEEP = new Set([ SHELL, MEDIA, CATALOG ]);

const CACHE_SCOPED_ANY = /^card-(?:shell|media|catalog)-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*-/;

const CACHE_LEGACY_NAMES = /^(?:card-v\d+(?:-v\d+)?[a-z]?|card-shell-v\d+[a-z]?|card-media-v1)$/;

function isLegacyCache(name) {
    return CACHE_LEGACY_NAMES.test(name) && !CACHE_SCOPED_ANY.test(name);
}

async function legacyOwned(name) {
    try {
        const c = await caches.open(name);
        const scope = self.registration && self.registration.scope || new URL('./', self.location).href;
        return !!(await c.match(scope + 'index.html', {
            ignoreSearch: true
        }) || await c.match(scope, {
            ignoreSearch: true
        }));
    } catch (e) {
        return false;
    }
}

async function ownedNames() {
    const keys = await caches.keys(), out = [];
    for (const k of keys) {
        if (CACHE_KEEP.has(k)) continue;
        if (CACHE_OWNED.test(k)) out.push(k); else if (isLegacyCache(k) && await legacyOwned(k)) out.push(k);
    }
    return out;
}

async function rescueClipsFromOldCaches() {
    const drained = new Set;
    try {
        const names = await ownedNames();
        if (!names.length) return drained;
        const media = await caches.open(MEDIA);
        const catalog = await caches.open(CATALOG);
        for (const name of names) {
            let complete = true;
            try {
                const old = await caches.open(name);
                for (const req of await old.keys()) {
                    if (req.url.indexOf('/clips/') < 0) continue;
                    const isCatalog = req.url.indexOf(CATALOG_URL) > -1;
                    const target = isCatalog ? catalog : media;
                    if (await target.match(req)) continue;
                    const res = await old.match(req);
                    if (!storable(res)) continue;
                    try {
                        await target.put(req, res.clone());
                    } catch (x) {
                        complete = false;
                    }
                }
            } catch (e) {
                complete = false;
            }
            if (complete) drained.add(name);
        }
    } catch (e) {}
    return drained;
}

self.addEventListener('activate', e => {
    e.waitUntil(rescueClipsFromOldCaches().then(drained => ownedNames().then(keys => Promise.all(keys.filter(k => drained.has(k)).map(k => caches.delete(k))))).then(() => self.clients.claim()));
});

function storable(res) {
    return !!res && res.status === 200 && !res.bodyUsed && (res.type === 'basic' || res.type === 'cors' || res.type === 'default');
}

async function putIfStorable(cacheName, req, res) {
    if (!storable(res)) return false;
    try {
        const c = await caches.open(cacheName);
        await c.put(req, res);
        return true;
    } catch (e) {
        return false;
    }
}

async function trimMedia() {
    try {
        const c = await caches.open(MEDIA);
        const keys = (await c.keys()).filter(k => k.url.indexOf(CATALOG_URL) < 0);
        let drop = Math.max(0, keys.length - MEDIA_MAX_ENTRIES);
        let total = 0;
        const sizes = [];
        for (const k of keys) {
            const r = await c.match(k);
            const n = r ? +r.headers.get('Content-Length') || 0 : 0;
            sizes.push(n);
            total += n;
        }
        for (let i = 0; i < drop; i++) total -= sizes[i];
        while (drop < keys.length - 1 && total > MEDIA_MAX_BYTES) {
            total -= sizes[drop];
            drop++;
        }
        for (const k of keys.slice(0, drop)) await c.delete(k);
    } catch (e) {}
}

async function rangeFromCache(req) {
    const range = req.headers.get('range');
    const hit = await caches.match(new Request(req.url), {
        cacheName: MEDIA
    });
    if (!hit) return null;
    if (!range) return hit;
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!m) return hit;
    const blob = await hit.blob();
    const total = blob.size;
    let start = m[1] === '' ? null : parseInt(m[1], 10);
    let end = m[2] === '' ? null : parseInt(m[2], 10);
    if (start === null && end === null) return hit;
    if (start === null) {
        start = Math.max(0, total - end);
        end = total - 1;
    }
    if (end === null || end >= total) end = total - 1;
    if (start > end || start >= total) {
        return new Response(null, {
            status: 416,
            headers: {
                'Content-Range': 'bytes */' + total
            }
        });
    }
    const slice = blob.slice(start, end + 1);
    return new Response(slice, {
        status: 206,
        headers: {
            'Content-Type': hit.headers.get('Content-Type') || 'application/octet-stream',
            'Content-Length': String(slice.size),
            'Content-Range': 'bytes ' + start + '-' + end + '/' + total,
            'Accept-Ranges': 'bytes'
        }
    });
}

self.addEventListener('fetch', e => {
    if (e.request.method !== 'GET') return;
    const isPage = e.request.mode === 'navigate' || e.request.url.endsWith('/') || e.request.url.endsWith('/index.html');
    if (isPage) {
        const net = fetch(e.request);
        e.waitUntil(net.then(r => storable(r) ? putIfStorable(SHELL, e.request, r.clone()) : null).catch(() => null));
        e.respondWith(Promise.race([ net, new Promise((_, rej) => setTimeout(() => rej(new Error('sw-timeout')), PAGE_RACE_MS)) ]).then(async res => {
            if (storable(res)) return res;
            const hit = await shellMatch(e.request);
            return hit || res;
        }).catch(() => shellMatch(e.request)));
        return;
    }
    if (e.request.url.indexOf(CATALOG_URL) > -1) {
        e.respondWith(fetch(e.request).then(async res => {
            if (storable(res)) {
                const copy = res.clone();
                e.waitUntil(putIfStorable(CATALOG, e.request, copy));
                return res;
            }
            const hit = await caches.match(e.request, {
                cacheName: CATALOG
            }) || await caches.match(e.request, {
                cacheName: MEDIA
            });
            return hit || res;
        }).catch(async () => await caches.match(e.request, {
            cacheName: CATALOG
        }) || await caches.match(e.request, {
            cacheName: MEDIA
        })));
        return;
    }
    if (e.request.url.indexOf('/clips/') > -1) {
        e.respondWith((async () => {
            const cached = await rangeFromCache(e.request);
            if (cached) return cached;
            try {
                const full = await fetch(new Request(e.request.url, {
                    headers: {}
                }));
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
                return new Response(null, {
                    status: 504
                });
            }
        })());
        return;
    }
    e.respondWith(caches.match(e.request, {
        cacheName: SHELL
    }).then(hit => {
        const net = fetch(e.request).then(res => {
            if (storable(res)) {
                const copy = res.clone();
                e.waitUntil(putIfStorable(SHELL, e.request, copy));
            }
            return res;
        }).catch(() => hit);
        return hit || net;
    }));
});

self.addEventListener('message', e => {
    try {
        const scopePath = new URL(self.registration.scope).pathname;
        if (!e.source || !e.source.url || !new URL(e.source.url).pathname.startsWith(scopePath)) return;
    } catch (x) {
        return;
    }
    const d = e.data || {};
    if (d.type === 'CLEAR_MEDIA') {
        e.waitUntil(caches.delete(MEDIA).then(ok => {
            try {
                e.source && e.source.postMessage({
                    type: 'MEDIA_CLEARED',
                    ok: !!ok
                });
            } catch (x) {}
        }));
    }
    if (d.type === 'MEDIA_USAGE') {
        e.waitUntil(caches.open(MEDIA).then(c => c.keys()).then(keys => {
            try {
                e.source && e.source.postMessage({
                    type: 'MEDIA_USAGE',
                    count: keys.length,
                    max: MEDIA_MAX_ENTRIES
                });
            } catch (x) {}
        }).catch(() => {}));
    }
});
