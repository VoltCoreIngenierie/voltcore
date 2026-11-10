/* ═══════════════════════════════════════════════════════════════
   VOLTCORE — 22-pwa.js
   VERSION : v6.9.4 (Session #6 — CACHE_VERSION bumpée pour Sprint 1,
                     fix C1/C2/C3/I1/I4/I5 appliqués)
   RÔLE : Service Worker — app 100 % offline, mise à jour propre
   STRATÉGIE :
     - HTML  : network-first avec timeout 5s → fallback cache
     - JS/CSS/icons : cache-first
     - Chart.js CDN : cache-first (cors no-cors)
   ⚠️ RÈGLE DE VIE : à chaque modification d'un fichier JS/CSS/HTML,
       incrémenter CACHE_VERSION (v6.7.0 → v6.7.1 → v6.7.2 …).
       Sinon le SW continue de servir l'ancienne version du fichier
       depuis le cache indéfiniment.
   NOTE v6.7 : le payload SW_ACTIVATED inclut désormais `isFirstInstall`.
   Le fix cosmétique du toast "Mise à jour installée" à la 1ère install
   se fera dans index.html (à livrer en étape 22/23) : il suffit de
   tester `if (!d.isFirstInstall)` avant d'afficher le toast.
   SECTIONS :
     §1  CONSTANTES
     §2  INSTALL (precache)
     §3  ACTIVATE (cleanup + claim + first install detection)
     §4  FETCH (routage)
     §5  MESSAGES (SKIP_WAITING, GET_VERSION, CLEAR_CACHE)
     §6  LOGS
   ═══════════════════════════════════════════════════════════════ */

/* ═══════════ SECTION 1 — CONSTANTES ═══════════ */

var CACHE_VERSION = 'voltcore-v6.10.4';
var CACHE_PREFIX = 'voltcore-';
var STATIC_CACHE = CACHE_VERSION + '-static';
var HTML_CACHE = CACHE_VERSION + '-html';
var NETWORK_TIMEOUT_MS = 5000;

/* Liste exacte des fichiers de l'app — DOIT correspondre à index.html.
   Si tu ajoutes un fichier, ajoute-le ici ET bump CACHE_VERSION.
   Le try/catch par fichier (dans _precache) tolère un fichier absent
   sans bloquer l'installation.

   v6.7 : retrait de './23-users.js' et './24-article-picker.js' qui
   n'existent plus (fusionnés dans 02-auth.js Section 8 et 08-stock.js
   Section 15 depuis LOT 5). Les tenter produisait 2 warnings 404 à
   chaque install, sans bloquer (tolérance déjà en place), mais c'était
   du bruit inutile. */
var STATIC_ASSETS = [
  /* HTML + CSS + manifest */
  './',
  './index.html',
  './00-style.css',
  './manifest.json',

  /* JS — ordre de chargement (01 → 21) */
  './01-core.js',
  './02-auth.js',
  './03-utils.js',
  './04-storage.js',
  './05-alerts.js',
  './06-clients.js',
  './07-suppliers.js',
  './08-stock.js',
  './09-chantiers.js',
  './10-hr.js',
  './11-invoices.js',
  './12-invoices-view.js',
  './13-purchases.js',
  './14-expenses-bons.js',
  './15-scan-sign.js',
  './16-assistant-ia.js',
  './17-dash-reports.js',
  './18-mobile.js',
  './19-tools-save.js',
  './20-init-infra.js',
  './21-init-app.js',
  './23-bons-route.js',
  './24-documents.js',

  /* Icônes PWA (chemin aligné sur index.html + manifest.json) */
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/favicon.png',

  /* Chart.js CDN — mis en cache dès l'installation pour offline */
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js'
];

/* ═══════════ SECTION 2 — INSTALL ═══════════ */

self.addEventListener('install', function (event) {
  console.log('[SW] install — ' + CACHE_VERSION);
  event.waitUntil(
    _precache()
      .then(function () {
        /* Active immédiatement le nouveau SW (pas besoin de fermer l'onglet) */
        return self.skipWaiting();
      })
      .catch(function (e) {
        console.error('[SW] install failed :', e);
      })
  );
});

async function _precache() {
  var staticCache = await caches.open(STATIC_CACHE);
  var htmlCache = await caches.open(HTML_CACHE);

  var appAssets = STATIC_ASSETS.filter(function (u) {
    return u.indexOf('http') !== 0;
  });
  var remoteAssets = STATIC_ASSETS.filter(function (u) {
    return u.indexOf('http') === 0;
  });

  console.log('[SW] precache : ' + appAssets.length + ' locaux + ' +
    remoteAssets.length + ' distants');

  var okCount = 0, failCount = 0;

  /* 1. Fichiers locaux — un par un pour ne pas tout casser si un seul manque */
  for (var i = 0; i < appAssets.length; i++) {
    var url = appAssets[i];
    try {
      var req = new Request(url, { cache: 'reload' });
      var res = await fetch(req);
      if (res && res.ok) {
        if (url === './' || url === './index.html') {
          await htmlCache.put(url, res.clone());
        } else {
          await staticCache.put(url, res.clone());
        }
        okCount++;
      } else {
        failCount++;
        console.warn('[SW] precache skip (not ok) :', url, res && res.status);
      }
    } catch (e) {
      failCount++;
      console.warn('[SW] precache fail (single) :', url, e && e.message);
    }
  }

  /* 2. Fichiers distants (Chart.js) — no-cors, best-effort */
  for (var j = 0; j < remoteAssets.length; j++) {
    var rUrl = remoteAssets[j];
    try {
      var rRes = await fetch(new Request(rUrl, { mode: 'no-cors', cache: 'reload' }));
      if (rRes) {
        try {
          await staticCache.put(rUrl, rRes.clone());
          okCount++;
        } catch (putErr) {
          console.warn('[SW] precache put remote fail :', rUrl, putErr && putErr.message);
        }
      }
    } catch (e) {
      console.warn('[SW] precache remote fail :', rUrl, e && e.message);
    }
  }

  console.log('[SW] precache terminé — ' + okCount + ' OK, ' + failCount + ' KO (tolérés)');
}

/* ═══════════ SECTION 3 — ACTIVATE ═══════════ */

self.addEventListener('activate', function (event) {
  console.log('[SW] activate — ' + CACHE_VERSION);
  event.waitUntil(
    _cleanupOldCaches()
      .then(function (meta) {
        return self.clients.claim().then(function () {
          return meta;
        });
      })
      .then(function (meta) {
        /* v6.7 — on transmet isFirstInstall à la page pour qu'elle
           n'affiche pas le toast "Mise à jour installée" à la 1ère
           installation. */
        return _notifyClients({
          type: 'SW_ACTIVATED',
          version: CACHE_VERSION,
          isFirstInstall: !!(meta && meta.isFirstInstall)
        });
      })
  );
});

/* v6.7 — Détecte si c'est une première installation avant de nettoyer
   les anciens caches. Retourne un objet { isFirstInstall, deleted }.
   - isFirstInstall = true si aucun cache `voltcore-*` autre que le
     nouveau n'existait (donc l'utilisateur n'avait jamais installé
     l'app sur ce navigateur).
   - deleted = nombre de caches supprimés (info). */
async function _cleanupOldCaches() {
  var meta = { isFirstInstall: false, deleted: 0 };
  try {
    var keys = await caches.keys();
    var olderCaches = keys.filter(function (k) {
      return k.indexOf(CACHE_PREFIX) === 0 && k.indexOf(CACHE_VERSION) !== 0;
    });
    /* Si AUCUN ancien cache n'existe, on est en première installation */
    meta.isFirstInstall = (olderCaches.length === 0);

    for (var i = 0; i < olderCaches.length; i++) {
      console.log('[SW] suppression ancien cache :', olderCaches[i]);
      await caches.delete(olderCaches[i]);
      meta.deleted++;
    }
  } catch (e) {
    console.warn('[SW] cleanup fail :', e);
  }
  return meta;
}

/* ═══════════ SECTION 4 — FETCH (routage) ═══════════ */

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (!req || req.method !== 'GET') return;

  var url = req.url || '';

  /* Ignore les extensions navigateur et devtools */
  if (url.indexOf('chrome-extension://') === 0 ||
      url.indexOf('moz-extension://') === 0 ||
      url.indexOf('devtools://') === 0 ||
      url.indexOf('chrome://') === 0) {
    return;
  }

  var isSameOrigin = url.indexOf(self.location.origin) === 0;
  var isChartCDN = url.indexOf('cdn.jsdelivr.net/npm/chart.js') >= 0;

  /* Navigation (HTML) → network-first avec timeout */
  if (req.mode === 'navigate' || req.destination === 'document') {
    event.respondWith(_networkFirstHTML(req));
    return;
  }

  /* Assets statiques (JS/CSS/img/font) → cache-first */
  if (isSameOrigin || isChartCDN) {
    event.respondWith(_cacheFirst(req));
    return;
  }

  /* Le reste : réseau direct */
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

/* ═══════════ SECTION 5 — MESSAGES ═══════════ */

self.addEventListener('message', function (event) {
  var data = event.data || {};
  if (!data.type) return;

  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }

  if (data.type === 'GET_VERSION') {
    var replyPort = event.ports && event.ports[0];
    if (replyPort) {
      replyPort.postMessage({ version: CACHE_VERSION, active: true });
    } else if (event.source) {
      event.source.postMessage({ type: 'SW_VERSION', version: CACHE_VERSION });
    }
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
    var clientList = await self.clients.matchAll({ type: 'window' });
    for (var i = 0; i < clientList.length; i++) {
      try { clientList[i].postMessage(payload); } catch (e) {}
    }
  } catch (e) {}
}

/* ═══════════ SECTION 6 — LOGS ═══════════ */

try {
  console.log('[SW] Service Worker chargé — ' + CACHE_VERSION);
} catch (e) {}