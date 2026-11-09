/* ═══════════════════════════════════════════════════════════════
   VOLTCORE — 20-init-infra.js
   VERSION : v6.7 (Session #3 — bump version, messages revus)
   RÔLE : Infrastructure invisible — erreurs globales, autosave,
          IDs uniques, rattrapage des références orphelines
   DÉPENDANCES : 01-core.js (globaux), 03-utils.js (helpers),
                 04-storage.js (saveAll, STORAGE_KEYS, logAction)
   EXPOSE : installGlobalErrorHandler, logError, loadErrorLog,
            clearErrorLog, getErrorLogForExport,
            initAutosave, updateAutosaveBadge, forceAutosaveOnUnload,
            _ensureUniqueIds, _ensureDocReferences, getInfraStatus,
            initInfra
   SECTIONS :
     1 : CONSTANTES + ÉTAT
     2 : ERREURS — HANDLER GLOBAL
     3 : ERREURS — LOG + DIAGNOSTIC
     4 : AUTOSAVE + BADGE
     5 : IDs UNIQUES
     6 : RÉFÉRENCES ORPHELINES
     7 : INIT
   ═══════════════════════════════════════════════════════════════ */

/* ═══════════ SECTION 1 — CONSTANTES + ÉTAT ═══════════ */

var VOLTCORE_ERROR_LOG_KEY = 'voltcore_error_log';
var VOLTCORE_ERROR_LOG_MAX = 50;
var VOLTCORE_ERROR_DEDUPE_MS = 5000;
var VOLTCORE_AUTOSAVE_INTERVAL_MS = 30000;
var VOLTCORE_AUTOSAVE_STALE_MS = 300000;

var __errorDedupe = {};
var __autosaveInterval = null;
var __globalErrorHandlerInstalled = false;
var __autosaveInstalled = false;
var __lastEnsureIdsReport = null;

/* Construit l'URL courante sans jamais dépendre d'une variable nommée
   "location" (qui pourrait être shadowée par un paramètre local).
   Utilisé par logError et getErrorLogForExport. */
function _getCurrentPageUrl() {
  try {
    if (typeof window === 'undefined' || !window.location) return '';
    var L = window.location;
    return (L.protocol || '') + '//' + (L.host || '') +
      (L.pathname || '') + (L.hash || '');
  } catch (e) {
    return '';
  }
}

/* ═══════════ SECTION 2 — ERREURS — HANDLER GLOBAL ═══════════ */

function installGlobalErrorHandler() {
  if (__globalErrorHandlerInstalled) return;
  __globalErrorHandlerInstalled = true;

  try {
    window.onerror = function (msg, url, line, col, err) {
      try {
        /* ⚠️ Ne JAMAIS nommer cette variable "location" : elle masquerait
           window.location et casserait la construction d'URL en aval. */
        var locStr = (url || '') + ':' + (line || 0) + ':' + (col || 0);
        var stack = err && err.stack ? String(err.stack) : '';
        logError('sync', msg, locStr, stack);
      } catch (e) { /* ne jamais throw dans le handler */ }
      return false; /* laisse le navigateur faire son log aussi */
    };
  } catch (e) { console.warn('window.onerror :', e); }

  try {
    window.addEventListener('unhandledrejection', function (ev) {
      try {
        var reason = ev ? ev.reason : null;
        var msg = reason && reason.message ? String(reason.message) : String(reason);
        var stack = reason && reason.stack ? String(reason.stack) : '';
        logError('async', msg, '', stack);
      } catch (e) { /* silencieux */ }
    });
  } catch (e) { console.warn('unhandledrejection :', e); }

  try {
    window.addEventListener('error', function (ev) {
      /* Erreur sur ressource (img, script) : on log sans bloquer */
      if (ev && ev.target && ev.target !== window) {
        var t = ev.target;
        var tag = t.tagName || '?';
        var src = t.src || t.href || '';
        logError('resource', tag + ' failed', src, '');
      }
    }, true);
  } catch (e) { console.warn('error event resource :', e); }
}

/* ═══════════ SECTION 3 — ERREURS — LOG + DIAGNOSTIC ═══════════ */

function loadErrorLog() {
  try {
    var raw = localStorage.getItem(VOLTCORE_ERROR_LOG_KEY);
    if (!raw) return [];
    var parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(function (e) { return e && typeof e === 'object'; });
  } catch (e) { return []; }
}

function _saveErrorLog(list) {
  try {
    var arr = Array.isArray(list) ? list.slice(-VOLTCORE_ERROR_LOG_MAX) : [];
    localStorage.setItem(VOLTCORE_ERROR_LOG_KEY, JSON.stringify(arr));
  } catch (e) { /* silent */ }
}

/* Log d'erreur.
   ⚠️ Le 3ᵉ paramètre s'appelle locStr (PAS "location") pour ne JAMAIS
   masquer window.location. */
function logError(type, message, locStr, stack) {
  try {
    var msgShort = String(message || '').slice(0, 500);
    var hash = (String(type || '') + '|' + msgShort.slice(0, 100)).toLowerCase();
    var now = Date.now();

    /* Déduplication : même erreur dans les 5s → ignorée */
    if (__errorDedupe[hash] && (now - __errorDedupe[hash]) < VOLTCORE_ERROR_DEDUPE_MS) {
      return;
    }
    __errorDedupe[hash] = now;

    var entry = {
      date: new Date().toISOString(),
      type: String(type || 'unknown').slice(0, 20),
      message: msgShort,
      location: String(locStr || '').slice(0, 200),
      stack: String(stack || '').slice(0, 2000),
      user: (typeof currentUser !== 'undefined' && currentUser && currentUser.username)
        ? String(currentUser.username) : 'anon',
      url: _getCurrentPageUrl()
    };

    var log = loadErrorLog();
    log.push(entry);
    _saveErrorLog(log);

    /* Toast non-bloquant pour l'utilisateur */
    if (typeof showToast === 'function') {
      var toastMsg = 'Erreur : ' + msgShort.slice(0, 80);
      if (locStr) toastMsg += ' (' + String(locStr).slice(0, 40) + ')';
      try { showToast(toastMsg, 'error', 6000); } catch (e) {}
    }

    /* Console pour le dev */
    try {
      console.error('[VC Error]', type, message, locStr);
      if (stack) console.error(stack);
    } catch (e) {}

    /* Nettoyage du dictionnaire de dédup (évite fuite mémoire) */
    var keys = Object.keys(__errorDedupe);
    if (keys.length > 100) {
      var toKeep = {};
      for (var i = 0; i < keys.length; i++) {
        if (now - __errorDedupe[keys[i]] < 60000) {
          toKeep[keys[i]] = __errorDedupe[keys[i]];
        }
      }
      __errorDedupe = toKeep;
    }
  } catch (e) {
    /* Ne jamais rien throw depuis le logger */
    try { console.warn('logError failed :', e); } catch (e2) {}
  }
}

function clearErrorLog() {
  try {
    localStorage.removeItem(VOLTCORE_ERROR_LOG_KEY);
    __errorDedupe = {};
    if (typeof showToast === 'function') showToast('Journal d\'erreurs vidé', 'info', 2000);
  } catch (e) { console.warn('clearErrorLog :', e); }
}

function getErrorLogForExport() {
  try {
    var log = loadErrorLog();
    var payload = {
      generatedAt: new Date().toISOString(),
      appVersion: '6.7',
      user: (typeof currentUser !== 'undefined' && currentUser && currentUser.username)
        ? currentUser.username : 'anon',
      userAgent: navigator.userAgent,
      url: _getCurrentPageUrl(),
      isMobile: (window.VoltCore && window.VoltCore.estMobile) || false,
      isHTTPS: (window.VoltCore && window.VoltCore.estHTTPS) || false,
      storageKeys: (typeof STORAGE_KEYS === 'object')
        ? Object.keys(STORAGE_KEYS).length : 0,
      errorsCount: log.length,
      errors: log
    };
    return payload;
  } catch (e) {
    return { generatedAt: new Date().toISOString(), errorsCount: 0, errors: [] };
  }
}

/* ═══════════ SECTION 4 — AUTOSAVE + BADGE ═══════════ */

function initAutosave() {
  if (__autosaveInstalled) return;
  __autosaveInstalled = true;

  /* Tick toutes les 30s */
  try {
    __autosaveInterval = setInterval(function () {
      try { updateAutosaveBadge(); } catch (e) {}
    }, VOLTCORE_AUTOSAVE_INTERVAL_MS);
  } catch (e) { console.warn('setInterval autosave :', e); }

  /* Force save avant fermeture */
  try {
    window.addEventListener('beforeunload', forceAutosaveOnUnload);
  } catch (e) { console.warn('beforeunload :', e); }

  /* Force save quand l'onglet devient caché (mobile : changement d'app) */
  try {
    document.addEventListener('visibilitychange', function () {
      if (document.hidden && typeof saveAll === 'function') {
        try { saveAll(); } catch (e) {}
      }
    });
  } catch (e) { console.warn('visibilitychange :', e); }

  /* Mise à jour initiale */
  updateAutosaveBadge();
}

function updateAutosaveBadge() {
  try {
    var badge = document.getElementById('autosaveBadge');
    if (!badge) return;

    var lastSave = (typeof window.__lastDataChange === 'number')
      ? window.__lastDataChange : 0;
    if (!lastSave) {
      badge.textContent = '';
      badge.style.display = 'none';
      return;
    }

    var age = Date.now() - lastSave;
    var sec = Math.floor(age / 1000);
    var min = Math.floor(age / 60000);

    badge.style.display = 'inline-flex';

    if (sec < 60) {
      badge.textContent = '✓ Sauvegardé';
      badge.style.color = 'var(--success)';
    } else if (min < 5) {
      badge.textContent = '✓ il y a ' + min + ' min';
      badge.style.color = 'var(--success)';
    } else if (age < VOLTCORE_AUTOSAVE_STALE_MS) {
      badge.textContent = '⚠ il y a ' + min + ' min';
      badge.style.color = 'var(--warning)';
    } else {
      badge.textContent = '⚠ Non sauvegardé (' + min + ' min)';
      badge.style.color = 'var(--danger)';
    }
  } catch (e) { /* silencieux */ }
}

function forceAutosaveOnUnload() {
  try {
    /* On ne save que si l'utilisateur était connecté et que saveAll existe */
    if (typeof saveAll !== 'function') return;
    if (typeof currentUser === 'undefined' || !currentUser) return;

    /* Empêche la sauvegarde si un import est en cours (évite l'état partiel) */
    if (typeof __authBusy !== 'undefined' && __authBusy) return;
    if (typeof __iaImporting !== 'undefined' && __iaImporting) return;

    saveAll();
  } catch (e) {
    /* On ne peut plus rien faire à ce stade */
  }
}

/* ═══════════ SECTION 5 — IDs UNIQUES ═══════════ */

/* Génère un ID unique pour un type donné (préfixe court). */
function _genUniqueId(prefix) {
  var p = String(prefix || 'x');
  var ts = Date.now().toString(36);
  var rnd = Math.random().toString(36).slice(2, 8);
  return p + '_' + ts + '_' + rnd;
}

/* Vérifie et répare les IDs manquants ou dupliqués dans toutes les
   collections principales. Retourne un rapport.
   ⚠️ N'essaie PAS de mettre à jour les références externes
   (clientId, chantierId…) — les orphelins résultants sont acceptables
   car sans danger métier (l'app affiche "client supprimé" par ex.). */
function _ensureUniqueIds() {
  var report = {
    fixedClients: 0,
    fixedArticles: 0,
    fixedDocuments: 0,
    fixedSuppliers: 0,
    fixedChantiers: 0,
    fixedFrais: 0,
    fixedPurchases: 0,
    fixedHREmployees: 0,
    fixedHRWorkEntries: 0,
    fixedHRTransactions: 0,
    fixedFamilles: 0,
    totalFixed: 0
  };
  try {
    var collections = [
      { arr: (typeof clients !== 'undefined') ? clients : null, prefix: 'cli', key: 'fixedClients' },
      { arr: (typeof savedArticles !== 'undefined') ? savedArticles : null, prefix: 'art', key: 'fixedArticles' },
      { arr: (typeof savedDocuments !== 'undefined') ? savedDocuments : null, prefix: 'doc', key: 'fixedDocuments' },
      { arr: (typeof suppliers !== 'undefined') ? suppliers : null, prefix: 'sup', key: 'fixedSuppliers' },
      { arr: (typeof savedChantiers !== 'undefined') ? savedChantiers : null, prefix: 'ch', key: 'fixedChantiers' },
      { arr: (typeof frais !== 'undefined') ? frais : null, prefix: 'frais', key: 'fixedFrais' },
      { arr: (typeof purchaseInvoices !== 'undefined') ? purchaseInvoices : null, prefix: 'pur', key: 'fixedPurchases' },
      { arr: (typeof hrEmployees !== 'undefined') ? hrEmployees : null, prefix: 'emp', key: 'fixedHREmployees' },
      { arr: (typeof hrWorkEntries !== 'undefined') ? hrWorkEntries : null, prefix: 'wrk', key: 'fixedHRWorkEntries' },
      { arr: (typeof hrTransactions !== 'undefined') ? hrTransactions : null, prefix: 'tx', key: 'fixedHRTransactions' },
      { arr: (typeof familles !== 'undefined') ? familles : null, prefix: 'fam', key: 'fixedFamilles' }
    ];

    for (var i = 0; i < collections.length; i++) {
      var c = collections[i];
      if (!Array.isArray(c.arr)) continue;
      var seen = {};
      for (var j = 0; j < c.arr.length; j++) {
        var item = c.arr[j];
        if (!item || typeof item !== 'object') continue;

        var id = String(item.id || '');
        var needsFix = false;

        if (!id) {
          needsFix = true;
        } else if (seen[id]) {
          needsFix = true;
        }

        if (needsFix) {
          var newId = _genUniqueId(c.prefix);
          /* Sécurité : évite une collision avec un autre id fraîchement généré */
          var attempts = 0;
          while (seen[newId] && attempts < 10) {
            newId = _genUniqueId(c.prefix);
            attempts++;
          }
          item.id = newId;
          report[c.key]++;
          report.totalFixed++;
        }

        seen[item.id] = true;
      }
    }

    /* Historique */
    __lastEnsureIdsReport = report;

    if (report.totalFixed > 0) {
      if (typeof logAction === 'function') {
        logAction('infra.ids.repaired', report.totalFixed + ' IDs corrigés');
      }
      try {
        console.warn('[VC Infra] ' + report.totalFixed + ' ID(s) manquants ou dupliqués ont été corrigés', report);
      } catch (e) {}
    }
  } catch (e) {
    console.warn('_ensureUniqueIds :', e);
  }
  return report;
}

/* ═══════════ SECTION 6 — RÉFÉRENCES ORPHELINES ═══════════ */

/* Recense (sans corriger) les références cassées — utile pour diagnostic.
   Exemples détectés :
   - document.clientId pointant vers un client supprimé
   - frais.chantierId pointant vers un chantier supprimé
   - document.avoirIds pointant vers un avoir supprimé
   - document.parentFactureId pointant vers une facture supprimée */
function _ensureDocReferences() {
  var report = {
    orphanClientRefs: 0,
    orphanChantierRefs: 0,
    orphanAvoirRefs: 0,
    orphanParentRefs: 0,
    totalOrphans: 0
  };
  try {
    var clientIds = {};
    if (Array.isArray(clients)) {
      for (var i = 0; i < clients.length; i++) {
        if (clients[i] && clients[i].id) clientIds[String(clients[i].id)] = true;
      }
    }

    var chantierIds = {};
    if (Array.isArray(savedChantiers)) {
      for (var j = 0; j < savedChantiers.length; j++) {
        if (savedChantiers[j] && savedChantiers[j].id) chantierIds[String(savedChantiers[j].id)] = true;
      }
    }

    var docIds = {};
    if (Array.isArray(savedDocuments)) {
      for (var k = 0; k < savedDocuments.length; k++) {
        if (savedDocuments[k] && savedDocuments[k].id) docIds[String(savedDocuments[k].id)] = true;
      }
    }

    /* Documents : clientId, chantierId, parentFactureId, avoirIds */
    if (Array.isArray(savedDocuments)) {
      for (var d = 0; d < savedDocuments.length; d++) {
        var doc = savedDocuments[d];
        if (!doc) continue;

        if (doc.clientId && !clientIds[String(doc.clientId)]) {
          report.orphanClientRefs++;
        }
        if (doc.chantierId && !chantierIds[String(doc.chantierId)]) {
          report.orphanChantierRefs++;
        }
        if (doc.parentFactureId && !docIds[String(doc.parentFactureId)]) {
          report.orphanParentRefs++;
        }
        if (Array.isArray(doc.avoirIds)) {
          for (var a = 0; a < doc.avoirIds.length; a++) {
            if (!docIds[String(doc.avoirIds[a])]) {
              report.orphanAvoirRefs++;
            }
          }
        }
      }
    }

    /* Frais : clientId, chantierId */
    if (Array.isArray(frais)) {
      for (var f = 0; f < frais.length; f++) {
        var fr = frais[f];
        if (!fr) continue;
        if (fr.clientId && !clientIds[String(fr.clientId)]) report.orphanClientRefs++;
        if (fr.chantierId && !chantierIds[String(fr.chantierId)]) report.orphanChantierRefs++;
      }
    }

    /* Achats : fournisseurId, chantierId */
    if (Array.isArray(purchaseInvoices)) {
      for (var p = 0; p < purchaseInvoices.length; p++) {
        var pi = purchaseInvoices[p];
        if (!pi) continue;
        if (pi.chantierId && !chantierIds[String(pi.chantierId)]) report.orphanChantierRefs++;
      }
    }

    report.totalOrphans = report.orphanClientRefs + report.orphanChantierRefs +
      report.orphanAvoirRefs + report.orphanParentRefs;

    if (report.totalOrphans > 0) {
      try {
        console.warn('[VC Infra] Références orphelines détectées (non corrigées)', report);
      } catch (e) {}
    }
  } catch (e) {
    console.warn('_ensureDocReferences :', e);
  }
  return report;
}

/* ═══════════ SECTION 7 — INIT ═══════════ */

function getInfraStatus() {
  try {
    return {
      errorHandlerInstalled: __globalErrorHandlerInstalled,
      autosaveInstalled: __autosaveInstalled,
      errorCount: loadErrorLog().length,
      lastEnsureIdsReport: __lastEnsureIdsReport,
      lastDataChange: (typeof window.__lastDataChange === 'number') ? window.__lastDataChange : 0
    };
  } catch (e) {
    return { error: String(e && e.message) };
  }
}

/* Point d'entrée unique — appelé par bootSequence() dans 21-init-app.js
   APRÈS loadAll() et AVANT initApp().
   Idempotent : peut être appelé plusieurs fois sans effet de bord. */
function initInfra() {
  try {
    installGlobalErrorHandler();
    initAutosave();

    /* Réparation des IDs — critique pour la suite */
    var idsReport = _ensureUniqueIds();
    if (idsReport.totalFixed > 0 && typeof saveAll === 'function') {
      try { saveAll(); } catch (e) {}
    }

    /* Diagnostic des références orphelines (non corrigées, juste loggées) */
    _ensureDocReferences();

    updateAutosaveBadge();
  } catch (e) {
    /* Si même l'infra échoue, on ne bloque pas le boot */
    try { console.warn('initInfra :', e); } catch (e2) {}
  }
}

console.log('✅ 20-init-infra.js chargé — v6.7 (infra + logs erreurs + autosave)');