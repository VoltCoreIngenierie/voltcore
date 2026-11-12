/* ═══════════════════════════════════════════════════════════
   VOLTCORE — sw.js
   VERSION : v7.0.7
   RÔLE : Service Worker — offline total.
   STRATÉGIE :
     - HTML → network-first (timeout 5s) + fallback cache
     - JS/CSS/icons → cache-first
     - Chart.js CDN → cache-first (no-cors)
   ⚠️ RÈGLE : à chaque modification d'un fichier JS/CSS/HTML,
       incrémenter CACHE_VERSION. Sinon le SW sert l'ancienne version.
   ═══════════════════════════════════════════════════════════ */

var CACHE_VERSION = 'voltcore-v7.0.7';
var CACHE_PREFIX = 'voltcore-';
var STATIC_CACHE = CACHE_VERSION + '-static';
var HTML_CACHE = CACHE_VERSION + '-html';
var NETWORK_TIMEOUT_MS = 5000;

var STATIC_ASSETS = [
  './',
  './index.html',
  './000-style.css',
  './001-theme.css',
  './manifest.json',

  './lib/opencv.js',

  './00-core.js',
  './01-utils.js',
  './02-store.js',
  './03-idb.js',
  './04-alerts.js',
  './05-auth.js',
  './06-clients.js',
  './07-suppl.js',
  './08-stock.js',
  './09-chant.js',
  './10-hr.js',
  './11-inv.js',
  './12-inv-view.js',
  './13-inv-pdf.js',
  './14-purch.js',
  './15-frais.js',
  './16-route.js',
  './17-docs.js',
  './18-scan.js',
  './19-scan-cv.js',
  './20-scan-js.js',
  './21-sign.js',
  './22-ia.js',
  './23-dash.js',
  './24-mobile.js',
  './25-tools.js',
  './26-infra.js',
  './27-migrate.js',
  './28-backup.js',
  './29-init.js',
  './30-boot.js',
  './99-sandbox.js',

  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/favicon.png',

  'https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js'
];

/* ═══════════ §1 — INSTALL ═══════════ */

self.addEventListener('install', function (event) {
  console.log('[SW] install — ' + CACHE_VERSION);
  event.waitUntil(
    _precache()
      .then(function () { return self.skipWaiting(); })
      .catch(function (e) { console.error('[SW] install failed :', e); })
  );
});

async function _precache() {
  var staticCache = await caches.open(STATIC_CACHE);
  var htmlCache = await caches.open(HTML_CACHE);

  var locals = STATIC_ASSETS.filter(function (u) { return u.indexOf('http') !== 0; });
  var remotes = STATIC_ASSETS.filter(function (u) { return u.indexOf('http') === 0; });

  console.log('[SW] precache : ' + locals.length + ' locaux + ' + remotes.length + ' distants');

  var ok = 0, fail = 0;

  for (var i = 0; i < locals.length; i++) {
    var url = locals[i];
    try {
      var res = await fetch(new Request(url, { cache: 'reload' }));
      if (res && res.ok) {
        if (url === './' || url === './index.html') {
          await htmlCache.put(url, res.clone());
        } else {
          await staticCache.put(url, res.clone());
        }
        ok++;
      } else {
        fail++;
        console.warn('[SW] skip (not ok) :', url, res && res.status);
      }
    } catch (e) {
      fail++;
      console.warn('[SW] fail :', url, e && e.message);
    }
  }

  for (var j = 0; j < remotes.length; j++) {
    var rUrl = remotes[j];
    try {
      var rRes = await fetch(new Request(rUrl, { mode: 'no-cors', cache: 'reload' }));
      if (rRes) {
        try { await staticCache.put(rUrl, rRes.clone()); ok++; }
        catch (e) { console.warn('[SW] put remote fail :', rUrl, e && e.message); }
      }
    } catch (e) {
      console.warn('[SW] remote fail :', rUrl, e && e.message);
    }
  }

  console.log('[SW] precache terminé — ' + ok + ' OK, ' + fail + ' KO (tolérés)');
}

/* ═══════════ §2 — ACTIVATE ═══════════ */

self.addEventListener('activate', function (event) {
  console.log('[SW] activate — ' + CACHE_VERSION);
  event.waitUntil(
    _cleanupOldCaches()
      .then(function (meta) {
        return self.clients.claim().then(function () { return meta; });
      })
      .then(function (meta) {
        return _notifyClients({
          type: 'SW_ACTIVATED',
          version: CACHE_VERSION,
          isFirstInstall: !!(meta && meta.isFirstInstall)
        });
      })
  );
});

async function _cleanupOldCaches() {
  var meta = { isFirstInstall: false, deleted: 0 };
  try {
    var keys = await caches.keys();
    var older = keys.filter(function (k) {
      return k.indexOf(CACHE_PREFIX) === 0 && k.indexOf(CACHE_VERSION) !== 0;
    });
    meta.isFirstInstall = (older.length === 0);
    for (var i = 0; i < older.length; i++) {
      console.log('[SW] suppression ancien cache :', older[i]);
      await caches.delete(older[i]);
      meta.deleted++;
    }
  } catch (e) {
    console.warn('[SW] cleanup fail :', e);
  }
  return meta;
}

/* ═══════════ §3 — FETCH ═══════════ */

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (!req || req.method !== 'GET') return;

  var url = req.url || '';

  if (url.indexOf('chrome-extension://') === 0 ||
      url.indexOf('moz-extension://') === 0 ||
      url.indexOf('devtools://') === 0 ||
      url.indexOf('chrome://') === 0) {
    return;
  }

  var isSameOrigin = url.indexOf(self.location.origin) === 0;
  var isChartCDN = url.indexOf('cdn.jsdelivr.net/npm/chart.js') >= 0;

  if (req.mode === 'navigate' || req.destination === 'document') {
    event.respondWith(_networkFirstHTML(req));
    return;
  }

  if (isSameOrigin || isChartCDN) {
    event.respondWith(_cacheFirst(req));
    return;
  }
});

async function _networkFirstHTML(req) {
  var cache = await caches.open(HTML_CACHE);
  try {
    var networkPromise = fetch(req, { cache: 'no-cache' });
    var timeoutPromise = new Promise(function (resolve) {
      setTimeout(function () { resolve(null); }, NETWORK_TIMEOUT_MS);
    });
    var winner = await Promise.race([networkPromise, timeoutPromise]);
    if (winner && winner.ok) {
      try { await cache.put(req, winner.clone()); } catch (e) {}
      return winner;
    }
    throw new Error('network timeout');
  } catch (e) {
    var cached = await cache.match(req) ||
                 await cache.match('./index.html') ||
                 await cache.match('./');
    if (cached) {
      console.log('[SW] HTML fallback cache pour', req.url);
      return cached;
    }
    return new Response(
      '<!DOCTYPE html><html><body style="font-family:Arial;padding:40px;text-align:center">' +
      '<h1>VOLTCORE hors ligne</h1>' +
      '<p>Reconnecte-toi une première fois pour activer le mode hors-ligne.</p>' +
      '<button onclick="location.reload()" style="padding:10px 20px">Réessayer</button>' +
      '</body></html>',
      { headers: { 'Content-Type': 'text/html;charset=UTF-8' } }
    );
  }
}

async function _cacheFirst(req) {
  var cached = await caches.match(req);
  if (cached) return cached;
  try {
    var res = await fetch(req);
    if (res && (res.ok || res.type === 'opaque')) {
      try {
        var cache = await caches.open(STATIC_CACHE);
        await cache.put(req, res.clone());
      } catch (e) {}
    }
    return res;
  } catch (e) {
    console.warn('[SW] cache-first miss offline :', req.url);
    return new Response('', { status: 404, statusText: 'Not Found (offline)' });
  }
}

/* ═══════════ §4 — MESSAGES ═══════════ */

self.addEventListener('message', function (event) {
  var data = event.data || {};
  if (!data.type) return;

  if (data.type === 'SKIP_WAITING') { self.skipWaiting(); return; }

  if (data.type === 'GET_VERSION') {
    var port = event.ports && event.ports[0];
    if (port) port.postMessage({ version: CACHE_VERSION, active: true });
    else if (event.source) event.source.postMessage({ type: 'SW_VERSION', version: CACHE_VERSION });
    return;
  }

  if (data.type === 'CLEAR_CACHE') {
    event.waitUntil(
      caches.keys().then(function (keys) {
        return Promise.all(keys.map(function (k) {
          if (k.indexOf(CACHE_PREFIX) === 0) return caches.delete(k);
          return null;
        }));
      }).then(function () {
        if (event.source) event.source.postMessage({ type: 'CACHE_CLEARED' });
      })
    );
    return;
  }
});

async function _notifyClients(payload) {
  try {
    var list = await self.clients.matchAll({ type: 'window' });
    for (var i = 0; i < list.length; i++) {
      try { list[i].postMessage(payload); } catch (e) {}
    }
  } catch (e) {}
}

try { console.log('[SW] chargé — ' + CACHE_VERSION); } catch (e) {}