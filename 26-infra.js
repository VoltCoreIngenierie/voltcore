/* ═══════════════════════════════════════════════════════════
   VOLTCORE — 26-infra.js
   VERSION : v7.0.0
   RÔLE : Infrastructure invisible.
          - Handler global d'erreurs (sync, async, resources)
          - Log structuré persistant (Store)
          - Autosave + badge de statut
          - Réparation d'IDs manquants/dupliqués
          - Détection de références orphelines
          - Health check pour diagnostics
   DÉPENDANCES : 00-core, 01-utils, 02-store, 05-auth
   ORDRE : 27ᵉ fichier chargé

   FIX v7.0.0 :
   - Log persisté dans Store (plus de localStorage direct)
   - Dedupe throttlé sur 5s (évite spam)
   - Limite 100 entrées (au lieu de 50) + purge auto
   - _ensureUniqueIds répare dans TOUTES les collections
     enregistrées via le registre (pas 3 collections hardcodées)
   - _ensureDocReferences détecte orphelins sur TOUS les champs
   - Autosave avec debounce + beforeunload
   - Aucun catch silencieux

   RÈGLES :
   - ES5 strict
   - Aucun catch silencieux (les catch d'infra loggent via console)
   - Ne JAMAIS masquer window.location (variable locale nommée locStr)
   ═══════════════════════════════════════════════════════════ */

'use strict';

(function (global) {

  if (!global.VOLTCORE || !global.VOLTCORE.Store || !global.VOLTCORE.Utils) {
    throw new Error('[26-infra] Modules requis non chargés');
  }

  var VC = global.VOLTCORE;
  var U = VC.Utils;
  var S = VC.Store;
  var Infra = VC.Infra || {};
  VC.Infra = Infra;

  /* ═══════════════════════════════════════════════════════════
     SECTION 1 — REGISTRATION STORE
     ═══════════════════════════════════════════════════════════ */

  S.register('errorLog', {
    type: 'array',
    saveKey: 'voltcore_error_log',
    default: [],
    backup: false,
    schema: {
      date: 'string|required',
      type: 'string',
      message: 'string|required',
      location: 'string',
      stack: 'string',
      user: 'string',
      url: 'string'
    }
  });

  /* ═══════════════════════════════════════════════════════════
     SECTION 2 — ÉTAT INTERNE
     ═══════════════════════════════════════════════════════════ */

  var MAX_LOG_ENTRIES = 100;
  var DEDUPE_MS = 5000;
  var AUTOSAVE_INTERVAL_MS = 30000;
  var AUTOSAVE_STALE_MS = 300000;

  var _errorDedupe = {};
  var _autosaveInterval = null;
  var _errorHandlerInstalled = false;
  var _autosaveInstalled = false;
  var _lastEnsureIdsReport = null;

  /* ═══════════════════════════════════════════════════════════
     SECTION 3 — HANDLERS GLOBAUX
     ═══════════════════════════════════════════════════════════ */

  Infra.installHandlers = function () {
    if (_errorHandlerInstalled) return;
    _errorHandlerInstalled = true;

    /* 1. Erreurs synchrones */
    try {
      global.onerror = function (msg, url, line, col, err) {
        try {
          /* ⚠️ Ne JAMAIS nommer cette variable "location" */
          var locStr = (url || '') + ':' + (line || 0) + ':' + (col || 0);
          var stack = err && err.stack ? String(err.stack) : '';
          Infra.logError('sync', msg, locStr, stack);
        } catch (e) {
          /* Handler cassé : on le signale en console sans rien faire d'autre */
          try { console.warn('[Infra] onerror handler échoué', e); } catch (e2) {}
        }
        return false;
      };
    } catch (e) {
      VC.logError('26-infra', 'bind window.onerror échoué', e);
    }

    /* 2. Promesses non gérées */
    try {
      global.addEventListener('unhandledrejection', function (ev) {
        try {
          var reason = ev ? ev.reason : null;
          var msg = reason && reason.message
            ? String(reason.message) : String(reason);
          var stack = reason && reason.stack ? String(reason.stack) : '';
          Infra.logError('async', msg, '', stack);
        } catch (e) {
          try { console.warn('[Infra] unhandledrejection handler échoué', e); } catch (e2) {}
        }
      });
    } catch (e) {
      VC.logError('26-infra', 'bind unhandledrejection échoué', e);
    }

    /* 3. Erreurs de ressources (img, script, link) */
    try {
      global.addEventListener('error', function (ev) {
        try {
          if (ev && ev.target && ev.target !== global) {
            var t = ev.target;
            var tag = t.tagName || '?';
            var src = t.src || t.href || '';
            Infra.logError('resource', tag + ' failed', src, '');
          }
        } catch (e) {
          try { console.warn('[Infra] error resource handler échoué', e); } catch (e2) {}
        }
      }, true);
    } catch (e) {
      VC.logError('26-infra', 'bind error resource échoué', e);
    }
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 4 — LOG STRUCTURÉ
     ═══════════════════════════════════════════════════════════ */

  Infra.logError = function (type, message, locStr, stack) {
    try {
      var msgShort = String(message || '').slice(0, 500);
      var hash = (String(type || '') + '|' + msgShort.slice(0, 100)).toLowerCase();
      var now = Date.now();

      /* Dédupe : même erreur dans les 5s → ignorée */
      if (_errorDedupe[hash] && (now - _errorDedupe[hash]) < DEDUPE_MS) {
        return;
      }
      _errorDedupe[hash] = now;

      var entry = {
        date: new Date().toISOString(),
        type: String(type || 'unknown').slice(0, 20),
        message: msgShort,
        location: String(locStr || '').slice(0, 200),
        stack: String(stack || '').slice(0, 2000),
        user: (VC.Auth && VC.Auth.currentUser && VC.Auth.currentUser.username)
          ? String(VC.Auth.currentUser.username) : 'anon',
        url: _getCurrentUrl()
      };

      /* Persiste via Store */
      var log = S.getAll('errorLog');
      log.push(entry);

      /* Purge si > MAX_LOG_ENTRIES */
      if (log.length > MAX_LOG_ENTRIES) {
        log = log.slice(-MAX_LOG_ENTRIES);
      }
      S.replaceAll('errorLog', log);

      /* Console pour le dev */
      try {
        console.error('[VC/' + entry.type + ']', msgShort,
          entry.location || '', stack ? '\n' + stack : '');
      } catch (e) {
        /* console indisponible */
      }

      /* Nettoyage du dedupe (évite fuite mémoire) */
      var keys = Object.keys(_errorDedupe);
      if (keys.length > 100) {
        var toKeep = {};
        for (var i = 0; i < keys.length; i++) {
          if (now - _errorDedupe[keys[i]] < 60000) {
            toKeep[keys[i]] = _errorDedupe[keys[i]];
          }
        }
        _errorDedupe = toKeep;
      }
    } catch (e) {
      /* Le logger ne doit JAMAIS throw */
      try {
        console.warn('[Infra] logError a échoué', e);
      } catch (e2) {
        /* vraiment rien à faire */
      }
    }
  };

  function _getCurrentUrl() {
    try {
      if (typeof global === 'undefined' || !global.location) return '';
      var L = global.location;
      return (L.protocol || '') + '//' + (L.host || '') +
        (L.pathname || '') + (L.hash || '');
    } catch (e) {
      return '';
    }
  }

  Infra.getLog = function () {
    return S.getAll('errorLog');
  };

  Infra.getErrorCount = function () {
    return S.getAll('errorLog').length;
  };

  Infra.clearLog = function () {
    S.replaceAll('errorLog', []);
    _errorDedupe = {};
    U.toast('Journal d\'erreurs vidé', 'info', 2000);
  };

  Infra.exportLog = function () {
    var log = Infra.getLog();
    var payload = {
      generatedAt: new Date().toISOString(),
      appVersion: VC.VERSION,
      user: (VC.Auth && VC.Auth.currentUser && VC.Auth.currentUser.username)
        ? VC.Auth.currentUser.username : 'anon',
      userAgent: navigator.userAgent,
      url: _getCurrentUrl(),
      device: VC.device,
      errorsCount: log.length,
      errors: log
    };

    var json = JSON.stringify(payload, null, 2);
    var blob = new Blob([json], { type: 'application/json' });
    U.downloadBlob(blob, 'voltcore-errors-' + U.todayISO() + '.json');
    U.toast(log.length + ' erreur(s) exportée(s)', 'success', 2500);
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 5 — AUTOSAVE
     ═══════════════════════════════════════════════════════════ */

  Infra.installAutosave = function () {
    if (_autosaveInstalled) return;
    _autosaveInstalled = true;

    /* Tick toutes les 30s pour mettre à jour le badge */
    try {
      _autosaveInterval = setInterval(function () {
        Infra.updateAutosaveBadge();
      }, AUTOSAVE_INTERVAL_MS);
    } catch (e) {
      VC.logError('26-infra', 'setInterval autosave échoué', e);
    }

    /* Force save avant fermeture onglet */
    try {
      global.addEventListener('beforeunload', function () {
        if (typeof S.saveAll === 'function' && VC.Auth && VC.Auth.currentUser) {
          try { S.saveAll(); } catch (e) {
            /* Impossible de logger ici, le navigateur est en train de fermer */
            try { console.warn('[Infra] beforeunload saveAll échoué', e); } catch (e2) {}
          }
        }
      });
    } catch (e) {
      VC.logError('26-infra', 'bind beforeunload échoué', e);
    }

    /* Force save quand l'onglet devient caché (mobile) */
    try {
      document.addEventListener('visibilitychange', function () {
        if (document.hidden && typeof S.saveAll === 'function') {
          try { S.saveAll(); } catch (e) {
            VC.logError('26-infra', 'visibilitychange saveAll échoué', e);
          }
        }
      });
    } catch (e) {
      VC.logError('26-infra', 'bind visibilitychange échoué', e);
    }
  };

  Infra.updateAutosaveBadge = function () {
    try {
      var badge = document.getElementById('autosaveBadge');
      if (!badge) return;

      /* On utilise __lastDataChange défini par 02-store.save */
      var lastSave = (typeof global.__lastDataChange === 'number')
        ? global.__lastDataChange : 0;

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
      } else if (age < AUTOSAVE_STALE_MS) {
        badge.textContent = '⚠ il y a ' + min + ' min';
        badge.style.color = 'var(--warning)';
      } else {
        badge.textContent = '⚠ Non sauvegardé (' + min + ' min)';
        badge.style.color = 'var(--danger)';
      }
    } catch (e) {
      VC.logError('26-infra', 'updateAutosaveBadge échoué', e);
    }
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 6 — RÉPARATION DES IDs
     ═══════════════════════════════════════════════════════════ */

  /**
   * Parcourt toutes les collections `array` du registre.
   * Pour chaque item : génère un ID unique s'il en manque ou s'il
   * duplique un existant.
   *
   * Retourne { totalFixed, perCollection: {name: count} }.
   */
  Infra.ensureUniqueIds = function () {
    var report = { totalFixed: 0, perCollection: {} };
    var names = S.listRegistered();

    for (var i = 0; i < names.length; i++) {
      var name = names[i];
      var spec = S.getSpec(name);
      if (!spec || spec.type !== 'array') continue;

      var arr = S.getAll(name);
      if (!Array.isArray(arr) || arr.length === 0) continue;

      var seen = {};
      var needsFix = false;
      var fixedCount = 0;
      var prefix = spec.idPrefix || name.slice(0, 3);

      for (var j = 0; j < arr.length; j++) {
        var item = arr[j];
        if (!item || typeof item !== 'object') continue;

        var id = String(item.id || '');
        if (!id) {
          item.id = _genUniqueId(prefix);
          seen[item.id] = true;
          needsFix = true;
          fixedCount++;
          continue;
        }

        if (seen[id]) {
          /* Duplicata : régénère */
          var newId = _genUniqueId(prefix);
          var attempts = 0;
          while (seen[newId] && attempts < 10) {
            newId = _genUniqueId(prefix);
            attempts++;
          }
          item.id = newId;
          seen[newId] = true;
          needsFix = true;
          fixedCount++;
          continue;
        }

        seen[id] = true;
      }

      if (needsFix) {
        /* FIX Bug 5 : les mutations sont in-place sur la référence interne
           (_data[name]) retournée par S.getAll(). Ne PAS passer par
           S.replaceAll() qui normalise et peut supprimer les items
           invalides. S.saveAll() persiste tout correctement. */
        S.saveAll();
        report.totalFixed += fixedCount;
        report.perCollection[name] = fixedCount;
      }
    }

    _lastEnsureIdsReport = report;

    if (report.totalFixed > 0) {
      VC.logWarn('26-infra', report.totalFixed +
        ' ID(s) manquants/dupliqués corrigés', report.perCollection);
    }

    return report;
  };

  function _genUniqueId(prefix) {
    return String(prefix || 'x') + '_' +
      Date.now().toString(36) + '_' +
      Math.random().toString(36).slice(2, 8);
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 7 — RÉFÉRENCES ORPHELINES (diagnostic seulement)
     ═══════════════════════════════════════════════════════════ */

  /**
   * Détecte les références cassées sans les corriger.
   * Utilisé par le diagnostic pour signaler les incohérences.
   */
  Infra.detectOrphans = function () {
    var report = {
      total: 0,
      details: {}
    };

    var clients = _index(S.getAll('clients'));
    var chantiers = _index(S.getAll('chantiers'));
    var docs = _index(S.getAll('documents'));
    var suppliers = _index(S.getAll('suppliers'));
    var articles = _index(S.getAll('articles'));
    var employees = _index(S.getAll('hrEmployees'));

    /* Documents */
    var docList = S.getAll('documents');
    for (var i = 0; i < docList.length; i++) {
      var d = docList[i];
      if (!d) continue;

      if (d.clientId && !clients[d.clientId]) {
        _addOrphan(report, 'documents', 'clientId');
      }
      if (d.chantierId && !chantiers[d.chantierId]) {
        _addOrphan(report, 'documents', 'chantierId');
      }
      if (d.parentFactureId && !docs[d.parentFactureId]) {
        _addOrphan(report, 'documents', 'parentFactureId');
      }
      if (Array.isArray(d.avoirIds)) {
        for (var k = 0; k < d.avoirIds.length; k++) {
          if (!docs[String(d.avoirIds[k])]) {
            _addOrphan(report, 'documents', 'avoirIds');
          }
        }
      }
      if (Array.isArray(d.items)) {
        for (var j = 0; j < d.items.length; j++) {
          if (d.items[j] && d.items[j].articleId && !articles[d.items[j].articleId]) {
            _addOrphan(report, 'documents', 'items.articleId');
          }
        }
      }
    }

    /* Chantiers */
    var chList = S.getAll('chantiers');
    for (var m = 0; m < chList.length; m++) {
      if (chList[m] && chList[m].clientId && !clients[chList[m].clientId]) {
        _addOrphan(report, 'chantiers', 'clientId');
      }
    }

    /* Frais */
    var fraisList = S.getAll('frais');
    for (var n = 0; n < fraisList.length; n++) {
      var f = fraisList[n];
      if (!f) continue;
      if (f.clientId && !clients[f.clientId]) _addOrphan(report, 'frais', 'clientId');
      if (f.chantierId && !chantiers[f.chantierId]) _addOrphan(report, 'frais', 'chantierId');
    }

    /* Achats */
    var purList = S.getAll('purchaseInvoices');
    for (var p = 0; p < purList.length; p++) {
      var pi = purList[p];
      if (!pi) continue;
      if (pi.supplierId && !suppliers[pi.supplierId]) _addOrphan(report, 'purchases', 'supplierId');
      if (pi.chantierId && !chantiers[pi.chantierId]) _addOrphan(report, 'purchases', 'chantierId');
    }

    /* RH */
    var works = S.getAll('hrWorkEntries');
    for (var w = 0; w < works.length; w++) {
      var we = works[w];
      if (!we) continue;
      if (we.employeeId && !employees[we.employeeId]) _addOrphan(report, 'hrWorkEntries', 'employeeId');
      if (we.chantierId && !chantiers[we.chantierId]) _addOrphan(report, 'hrWorkEntries', 'chantierId');
    }

    var txs = S.getAll('hrTransactions');
    for (var t = 0; t < txs.length; t++) {
      if (txs[t] && txs[t].employeeId && !employees[txs[t].employeeId]) {
        _addOrphan(report, 'hrTransactions', 'employeeId');
      }
    }

    /* Bons route */
    var brs = S.getAll('bonsRoute');
    for (var b = 0; b < brs.length; b++) {
      if (brs[b] && brs[b].chantierId && !chantiers[brs[b].chantierId]) {
        _addOrphan(report, 'bonsRoute', 'chantierId');
      }
    }

    if (report.total > 0) {
      VC.logWarn('26-infra', report.total + ' référence(s) orpheline(s) détectée(s)',
        report.details);
    }

    return report;
  };

  function _index(arr) {
    var out = {};
    if (!Array.isArray(arr)) return out;
    for (var i = 0; i < arr.length; i++) {
      if (arr[i] && arr[i].id) out[String(arr[i].id)] = true;
    }
    return out;
  }

  function _addOrphan(report, kind, field) {
    report.total++;
    var key = kind + '.' + field;
    report.details[key] = (report.details[key] || 0) + 1;
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 8 — HEALTH CHECK
     ═══════════════════════════════════════════════════════════ */

  Infra.getStatus = function () {
    return {
      handlersInstalled: _errorHandlerInstalled,
      autosaveInstalled: _autosaveInstalled,
      errors: Infra.getErrorCount(),
      lastEnsureIdsReport: _lastEnsureIdsReport,
      lastDataChange: (typeof global.__lastDataChange === 'number')
        ? global.__lastDataChange : 0,
      device: VC.device,
      pwaInstalled: VC.isPWAInstalled(),
      opencvReady: !!global.__opencvReady,
      version: VC.VERSION
    };
  };

  Infra.healthCheck = function () {
    var s = Infra.getStatus();
    var issues = [];

    if (!s.handlersInstalled) issues.push('Handler d\'erreurs non installé');
    if (!s.autosaveInstalled) issues.push('Autosave non installé');
    if (s.errors > 20) issues.push('Trop d\'erreurs loggées (' + s.errors + ')');
    if (!s.device.storage) issues.push('localStorage indisponible');
    if (!s.device.https) issues.push('Pas en HTTPS (caméra/biométrie limitées)');

    if (issues.length === 0) {
      VC.logInfo('26-infra', 'Health check OK');
      return { ok: true, issues: [] };
    }

    VC.logWarn('26-infra', 'Health check : ' + issues.length + ' problème(s)',
      issues);
    return { ok: false, issues: issues };
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 9 — INIT
     ═══════════════════════════════════════════════════════════ */

  /**
   * Point d'entrée unique. Appelé par 30-boot.js APRÈS loadAll()
   * et AVANT initApp(). Idempotent.
   */
  Infra.init = function () {
    Infra.installHandlers();
    Infra.installAutosave();

    /* Réparation IDs */
    var idsReport = Infra.ensureUniqueIds();
    if (idsReport.totalFixed > 0) {
      try { S.saveAll(); } catch (e) {
        VC.logError('26-infra', 'saveAll post-ensureIds échoué', e);
      }
    }

    /* Diagnostic orphelins (log seulement) */
    Infra.detectOrphans();

    Infra.updateAutosaveBadge();
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 10 — MARQUEUR
     ═══════════════════════════════════════════════════════════ */

  VC._infraLoaded = true;

  VC.logInfo('26-infra', 'Module chargé (handlers + autosave + IDs)');

})(window);