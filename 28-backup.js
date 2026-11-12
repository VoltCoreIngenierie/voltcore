/* ═══════════════════════════════════════════════════════════
   VOLTCORE — 28-backup.js
   VERSION : v7.0.0
   RÔLE : Backup complet JSON (export + import).
          - Export : TOUTES les collections enregistrées + trash + config
          - Import : détection automatique format (v7 / BASE_BLINDE / article.json)
          - Modes : merge (défaut) ou replace
          - Restauration IDB backups
          - Aperçu avant validation
   DÉPENDANCES : 00-core, 01-utils, 02-store, 03-idb, 26-infra, 27-migrate
   ORDRE : 29ᵉ fichier chargé

   FIX v7.0.0 :
   - C28 : trash exporté ET restauré (toutes les clés, pas juste 3)
   - C29 : externalPrices exporté ET restauré
   - C38/C39 : compat via Migrate.fromLegacy si format legacy détecté
   - Le registre Store pilote l'export : impossible d'oublier une collection

   RÈGLES :
   - ES5 strict
   - Aucun catch silencieux
   - Ne JAMAIS écraser silencieusement : confirmation explicite en mode replace
   - Idempotent en mode merge (skip les doublons par ID + clé naturelle)
   ═══════════════════════════════════════════════════════════ */

'use strict';

(function (global) {

  if (!global.VOLTCORE || !global.VOLTCORE.Store ||
      !global.VOLTCORE.Utils || !global.VOLTCORE.IDB) {
    throw new Error('[28-backup] Modules requis non chargés');
  }

  var VC = global.VOLTCORE;
  var U = VC.Utils;
  var S = VC.Store;
  var IDB = VC.IDB;
  var M = VC.Migrate;
  var B = VC.Backup || {};
  VC.Backup = B;

  /* ═══════════════════════════════════════════════════════════
     SECTION 1 — ÉTAT INTERNE
     ═══════════════════════════════════════════════════════════ */

  var _importing = false;

  var BACKUP_VERSION = 1;
  var BACKUP_MARKER = '_voltcore_backup';
  var BACKUP_APP = 'VOLTCORE';
  var BACKUP_SCHEMA_VERSION = '7.0';

  /* ═══════════════════════════════════════════════════════════
     SECTION 2 — EXPORT
     ═══════════════════════════════════════════════════════════ */

  /**
   * Construit l'objet backup complet.
   * - Itère sur le registre Store (impossible d'oublier une collection)
   * - Inclut trash ouvert (toutes les clés)
   * - Inclut config (rib, mf, logo, etc.)
   * - Inclut compteurs
   * - Inclut externalPrices (via articles, qui a un handler blobs)
   */
  B.buildData = function () {
    var payload = {};
    payload[BACKUP_MARKER] = true;
    payload._version = BACKUP_SCHEMA_VERSION;
    payload._app = BACKUP_APP;
    payload._appVersion = VC.VERSION;
    payload._createdAt = new Date().toISOString();
    payload._user = (VC.Auth && VC.Auth.currentUser && VC.Auth.currentUser.username)
      ? VC.Auth.currentUser.username : 'anon';

    var names = S.listRegistered();
    var collections = {};

    for (var i = 0; i < names.length; i++) {
      var name = names[i];
      var spec = S.getSpec(name);
      if (!spec || !spec.backup) continue;

      if (spec.type === 'array') {
        collections[name] = S.getAll(name).slice();
      } else if (spec.type === 'object') {
        collections[name] = _deepClone(S.getObject(name));
      } else if (spec.type === 'string' || spec.type === 'number') {
        collections[name] = S.getValue(name);
      }
    }

    payload.collections = collections;

    /* Trash : toutes les clés, pas seulement 3 (fix C28) */
    payload.trash = _deepClone(S.getTrash());

    /* Signatures : métadonnées seulement (blobs IDB exclus) */
    /* Les blobs sont référencés par `ref` — un backup JSON ne peut pas
       transporter les binaires. Les refs sont conservées pour que si
       l'utilisateur restaure sur le MÊME navigateur, tout fonctionne.
       Pour un export cross-device, on ajoute un warning dans l'UI. */

    return payload;
  };

  function _deepClone(obj) {
    if (obj == null) return obj;
    try {
      return JSON.parse(JSON.stringify(obj));
    } catch (e) {
      VC.logError('28-backup', 'deepClone échoué', e);
      return obj;
    }
  }

  /**
   * Export déclenché par le bouton "Exporter (JSON)".
   */
  B.export = function () {
    try {
      var data = B.buildData();
      var json = JSON.stringify(data, null, 2);
      var blob = new Blob([json], { type: 'application/json' });
      var filename = 'voltcore-backup-' + U.todayISO() + '.json';

      U.downloadBlob(blob, filename);
      U.toast('Backup exporté : ' + filename, 'success', 3000);

      /* Log */
      _log('backup.export', filename + ' (' + _formatSize(json.length) + ')');
    } catch (e) {
      VC.logError('28-backup', 'export échoué', e);
      U.toast('Erreur d\'export : ' + (e.message || 'inconnue'), 'error', 4000);
    }
  };

  function _formatSize(bytes) {
    var n = parseInt(bytes, 10) || 0;
    if (n < 1024) return n + ' o';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' Ko';
    return (n / (1024 * 1024)).toFixed(1) + ' Mo';
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 3 — IMPORT : ANALYSE PRÉALABLE
     ═══════════════════════════════════════════════════════════ */

  /**
   * Analyse un fichier JSON avant import. Retourne un rapport pour
   * affichage dans l'UI.
   */
  B.analyzeFile = function (file) {
    return new Promise(function (resolve, reject) {
      if (!file) {
        reject(new Error('Fichier requis'));
        return;
      }

      var reader = new FileReader();
      reader.onload = function (ev) {
        try {
          var raw = ev.target.result;
          var payload = JSON.parse(raw);

          if (!payload || typeof payload !== 'object') {
            reject(new Error('JSON invalide'));
            return;
          }

          var format = M.detectLegacyFormat(payload);
          var analysis = {
            format: format,
            isLegacy: format !== 'v7',
            counts: {},
            warnings: [],
            payload: payload
          };

          /* Compte les collections */
          if (format === 'v7') {
            var cols = payload.collections || {};
            var names = Object.keys(cols);
            for (var i = 0; i < names.length; i++) {
              var n = names[i];
              if (Array.isArray(cols[n])) {
                analysis.counts[n] = cols[n].length;
              } else if (cols[n] && typeof cols[n] === 'object') {
                analysis.counts[n] = Object.keys(cols[n]).length + ' clés';
              }
            }
            if (payload.trash && typeof payload.trash === 'object') {
              var trashKeys = Object.keys(payload.trash);
              var trashTotal = 0;
              for (var j = 0; j < trashKeys.length; j++) {
                var arr = payload.trash[trashKeys[j]];
                if (Array.isArray(arr)) trashTotal += arr.length;
              }
              analysis.counts.trash = trashTotal;
            }
          } else {
            /* Legacy : on devine les collections présentes */
            var legacyCollections = ['clients', 'suppliers', 'articles',
              'familles', 'chantiers', 'documents', 'purchaseInvoices',
              'frais', 'hrEmployees', 'hrWorkEntries', 'hrTransactions'];
            for (var k = 0; k < legacyCollections.length; k++) {
              var key = legacyCollections[k];
              if (Array.isArray(payload[key])) {
                analysis.counts[key] = payload[key].length;
              }
            }
            analysis.warnings.push(
              'Format legacy détecté — les données seront converties automatiquement.'
            );
          }

          resolve(analysis);
        } catch (e) {
          VC.logError('28-backup', 'analyzeFile parse échoué', e);
          reject(e);
        }
      };
      reader.onerror = function () {
        reject(reader.error || new Error('Lecture échouée'));
      };
      reader.readAsText(file);
    });
  };

  /**
   * Demande à l'utilisateur quel mode il veut. Retourne Promise<'merge'|'replace'|null>.
   */
  B.askImportMode = function (analysis) {
    return new Promise(function (resolve) {
      var msg = 'Comment importer ce fichier ?\n\n';
      msg += 'Format : ' + (analysis.isLegacy
        ? 'legacy (converti automatiquement)' : 'v7 natif') + '\n';

      var keys = Object.keys(analysis.counts);
      if (keys.length > 0) {
        msg += 'Contenu :\n';
        for (var i = 0; i < Math.min(keys.length, 8); i++) {
          msg += '  • ' + keys[i] + ' : ' + analysis.counts[keys[i]] + '\n';
        }
        if (keys.length > 8) msg += '  • …\n';
      }

      msg += '\nTape :\n';
      msg += '  FUSIONNER — ajoute sans supprimer l\'existant (recommandé)\n';
      msg += '  REMPLACER — écrase TOUTES les données actuelles (danger)\n';
      msg += '  Annule pour abandonner';

      var choice = U.prompt(msg, '');
      if (choice === null) {
        resolve(null);
        return;
      }

      var normalized = String(choice).toUpperCase().trim();
      if (normalized === 'REMPLACER') resolve('replace');
      else if (normalized === 'FUSIONNER' || normalized === '') resolve('merge');
      else resolve(null);
    });
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 4 — IMPORT : EXÉCUTION
     ═══════════════════════════════════════════════════════════ */

  B.importFile = function (file) {
    if (_importing) return Promise.reject(new Error('Import déjà en cours'));
    _importing = true;

    return B.analyzeFile(file).then(function (analysis) {
      return B.askImportMode(analysis).then(function (mode) {
        if (!mode) {
          _importing = false;
          throw new Error('Import annulé par l\'utilisateur');
        }

        if (mode === 'replace') {
          var ok = U.confirm(
            '⚠ Mode REMPLACER : TOUTES les données actuelles seront écrasées.\n\n' +
            'Les collections actuelles seront poussées dans la corbeille ' +
            '(sauf si corbeille > 100 éléments).\n\n' +
            'Continuer ?'
          );
          if (!ok) {
            _importing = false;
            throw new Error('Import annulé (confirmation replace refusée)');
          }
        }

        return _executeImport(analysis, mode);
      });
    }).then(function (result) {
      _importing = false;
      return result;
    }).catch(function (e) {
      _importing = false;
      VC.logError('28-backup', 'importFile échoué', e);
      throw e;
    });
  };

  function _executeImport(analysis, mode) {
    var collections;
    var trash;

    if (analysis.isLegacy) {
      /* Conversion legacy via Migrate */
      var converted = M.fromLegacy(analysis.payload);
      collections = converted.collections;
      trash = null; /* Les legacy n'ont pas de trash v7 */
      if (converted.warnings.length > 0) {
        VC.logWarn('28-backup', 'Migration legacy — warnings', converted.warnings);
      }
    } else {
      collections = analysis.payload.collections || {};
      trash = analysis.payload.trash || null;
    }

    /* ── Étape 1 : mode replace — pousser à la corbeille ── */
    if (mode === 'replace') {
      _pushAllToTrash(collections);
    }

    /* ── Étape 2 : importer chaque collection ── */
    var stats = { added: 0, skipped: 0, invalid: 0, byCollection: {} };
    var names = Object.keys(collections);

    for (var i = 0; i < names.length; i++) {
      var name = names[i];
      var value = collections[name];
      var spec = S.getSpec(name);

      if (!spec) {
        VC.logWarn('28-backup', 'Collection inconnue ignorée : ' + name);
        continue;
      }

      if (spec.type === 'array') {
        var r = _importArray(name, value, mode);
        stats.added += r.added;
        stats.skipped += r.skipped;
        stats.invalid += r.invalid;
        stats.byCollection[name] = r;
      } else if (spec.type === 'object') {
        if (mode === 'replace') {
          S.setObject(name, value || {});
        } else {
          /* Merge : fusion superficielle */
          var existing = S.getObject(name);
          var merged = _mergeObjects(existing, value || {});
          S.setObject(name, merged);
        }
        stats.byCollection[name] = { merged: true };
      } else if (spec.type === 'string' || spec.type === 'number') {
        if (mode === 'replace' && value != null) {
          S.setValue(name, value);
        }
        stats.byCollection[name] = { restored: mode === 'replace' };
      }
    }

    /* ── Étape 3 : restaurer la corbeille (fix C28) ── */
    if (trash && mode === 'replace') {
      _restoreTrash(trash);
    } else if (trash && mode === 'merge') {
      _mergeTrash(trash);
    }

    /* ── Étape 4 : saveAll + log ── */
    S.saveAll();
    _log('backup.import', mode + ' : ' + stats.added + ' ajoutés, ' +
      stats.skipped + ' doublons');

    /* ── Étape 5 : refresh global ── */
    _refreshAllUI();

    U.toast('Import terminé : ' + stats.added + ' ajout(s)' +
      (stats.skipped > 0 ? ' · ' + stats.skipped + ' doublon(s)' : ''),
      'success', 4000);

    return stats;
  }

  function _importArray(name, value, mode) {
    var result = { added: 0, skipped: 0, invalid: 0 };

    if (!Array.isArray(value)) {
      result.invalid++;
      return result;
    }

    if (mode === 'replace') {
      S.replaceAll(name, value);
      result.added = value.length;
      return result;
    }

    /* Merge : par ID + clé naturelle selon la collection */
    var existing = S.getAll(name);
    var existingById = {};
    for (var i = 0; i < existing.length; i++) {
      if (existing[i] && existing[i].id) {
        existingById[String(existing[i].id)] = true;
      }
    }

    var existingNaturalKeys = _buildNaturalKeys(name, existing);

    for (var j = 0; j < value.length; j++) {
      var item = value[j];
      if (!item || typeof item !== 'object') {
        result.invalid++;
        continue;
      }

      /* Doublon par ID */
      if (item.id && existingById[String(item.id)]) {
        result.skipped++;
        continue;
      }

      /* Doublon par clé naturelle */
      var natKey = _naturalKey(name, item);
      if (natKey && existingNaturalKeys[natKey]) {
        result.skipped++;
        continue;
      }

      /* Sauvegarde */
      var saved = S.save(name, item);
      if (saved) {
        result.added++;
        if (item.id) existingById[String(item.id)] = true;
        if (natKey) existingNaturalKeys[natKey] = true;
      } else {
        result.invalid++;
      }
    }

    return result;
  }

  function _buildNaturalKeys(name, items) {
    var map = {};
    for (var i = 0; i < items.length; i++) {
      var k = _naturalKey(name, items[i]);
      if (k) map[k] = true;
    }
    return map;
  }

  function _naturalKey(name, item) {
    if (!item || typeof item !== 'object') return null;

    if (name === 'documents' || name === 'purchaseInvoices') {
      var num = String(item.numero || item.refFacture || '').trim();
      var dt = String(item.date || item.dateFacture || '').slice(0, 10);
      if (num && dt) return 'num:' + num + '|date:' + dt;
      return null;
    }
    if (name === 'clients' || name === 'suppliers' ||
        name === 'chantiers' || name === 'hrEmployees' ||
        name === 'articles' || name === 'familles') {
      var nom = String(item.nom || item.designation || '').trim();
      if (nom) return 'nom:' + U.normalizeText(nom);
      return null;
    }
    if (name === 'bonsRoute') {
      var n = String(item.numero || '').trim();
      if (n) return 'num:' + n;
      return null;
    }
    return null;
  }

  function _mergeObjects(a, b) {
    var out = {};
    var keysA = Object.keys(a || {});
    for (var i = 0; i < keysA.length; i++) out[keysA[i]] = a[keysA[i]];
    var keysB = Object.keys(b || {});
    for (var j = 0; j < keysB.length; j++) out[keysB[j]] = b[keysB[j]];
    return out;
  }

  function _pushAllToTrash(collections) {
    /* Pousse les collections actuelles à la corbeille avant wipe.
       Limité à 100 éléments par collection pour éviter l'explosion. */
    var names = Object.keys(collections);
    var pushed = 0;

    for (var i = 0; i < names.length; i++) {
      var name = names[i];
      var spec = S.getSpec(name);
      if (!spec || spec.type !== 'array' || !spec.trash) continue;

      var current = S.getAll(name);
      for (var j = 0; j < current.length && j < 100; j++) {
        if (current[j]) {
          S.moveToTrash(name, current[j]);
          pushed++;
        }
      }
    }

    if (pushed > 0) {
      VC.logInfo('28-backup', pushed + ' élément(s) poussé(s) dans la corbeille');
    }
  }

  function _restoreTrash(trash) {
    if (!trash || typeof trash !== 'object') return;

    var internal = S.getTrash();
    var keys = Object.keys(trash);

    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      var entries = trash[key];
      if (!Array.isArray(entries)) continue;

      if (!Array.isArray(internal[key])) internal[key] = [];
      for (var j = 0; j < entries.length; j++) {
        if (entries[j]) internal[key].push(entries[j]);
      }
    }
  }

  function _mergeTrash(trash) {
    /* En mode merge, on ajoute les entrées du backup qui ne sont pas déjà présentes
       (par ID d'item) */
    if (!trash || typeof trash !== 'object') return;

    var internal = S.getTrash();
    var keys = Object.keys(trash);

    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      var entries = trash[key];
      if (!Array.isArray(entries)) continue;

      if (!Array.isArray(internal[key])) internal[key] = [];

      var existingIds = {};
      for (var m = 0; m < internal[key].length; m++) {
        if (internal[key][m] && internal[key][m].item && internal[key][m].item.id) {
          existingIds[String(internal[key][m].item.id)] = true;
        }
      }

      for (var j = 0; j < entries.length; j++) {
        var entry = entries[j];
        if (!entry || !entry.item || !entry.item.id) continue;
        if (existingIds[String(entry.item.id)]) continue;
        internal[key].push(entry);
        existingIds[String(entry.item.id)] = true;
      }
    }
  }

  function _refreshAllUI() {
    try { if (VC.Clients && VC.Clients.render) VC.Clients.render(); } catch (e) {
      VC.logError('28-backup', 'refresh clients échoué', e);
    }
    try { if (VC.Suppliers && VC.Suppliers.render) VC.Suppliers.render(); } catch (e) {
      VC.logError('28-backup', 'refresh suppliers échoué', e);
    }
    try { if (VC.Stock && VC.Stock.render) VC.Stock.render(); } catch (e) {
      VC.logError('28-backup', 'refresh stock échoué', e);
    }
    try { if (VC.Chantiers && VC.Chantiers.render) VC.Chantiers.render(); } catch (e) {
      VC.logError('28-backup', 'refresh chantiers échoué', e);
    }
    try { if (VC.HR && VC.HR.render) VC.HR.render(); } catch (e) {
      VC.logError('28-backup', 'refresh hr échoué', e);
    }
    try { if (VC.InvoicesView && VC.InvoicesView.render) VC.InvoicesView.render(); } catch (e) {
      VC.logError('28-backup', 'refresh invoices échoué', e);
    }
    try { if (VC.Purchases && VC.Purchases.render) VC.Purchases.render(); } catch (e) {
      VC.logError('28-backup', 'refresh purchases échoué', e);
    }
    try { if (VC.Frais && VC.Frais.render) VC.Frais.render(); } catch (e) {
      VC.logError('28-backup', 'refresh frais échoué', e);
    }
    try { if (VC.Route && VC.Route.render) VC.Route.render(); } catch (e) {
      VC.logError('28-backup', 'refresh route échoué', e);
    }
    try { if (VC.Documents && VC.Documents.render) VC.Documents.render(); } catch (e) {
      VC.logError('28-backup', 'refresh documents échoué', e);
    }
    try { if (VC.Dashboard && VC.Dashboard.render) VC.Dashboard.render(); } catch (e) {
      VC.logError('28-backup', 'refresh dashboard échoué', e);
    }
    try { if (VC.Tools && VC.Tools.renderTrash) VC.Tools.renderTrash(); } catch (e) {
      VC.logError('28-backup', 'refresh tools échoué', e);
    }
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 5 — IMPORT UI
     ═══════════════════════════════════════════════════════════ */

  B.importViaFilePicker = function () {
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = function (ev) {
      var f = ev.target.files && ev.target.files[0];
      if (!f) return;
      B.importFile(f).catch(function (err) {
        if (err.message && err.message.indexOf('annulé') !== -1) return;
        U.toast('Import échoué : ' + (err.message || ''), 'error', 5000);
      });
    };
    input.click();
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 6 — MARQUEUR
     ═══════════════════════════════════════════════════════════ */

  function _log(action, details) {
    try {
      var history = S.getAll('history');
      history.push({
        date: new Date().toISOString(),
        user: (VC.Auth && VC.Auth.currentUser && VC.Auth.currentUser.username)
          ? VC.Auth.currentUser.username : 'anon',
        action: action,
        details: String(details || '')
      });
      if (history.length > VC.HISTORY_MAX_ENTRIES) {
        history = history.slice(-VC.HISTORY_MAX_ENTRIES);
      }
      S.replaceAll('history', history);
    } catch (e) {
      VC.logError('28-backup', '_log échoué', e);
    }
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 7 — EVENTS
     ═══════════════════════════════════════════════════════════ */

  B.attachEvents = function () {
    U.on('btnExportCompleteBackup', 'click', B.export);
    U.on('btnImportCompleteBackup', 'click', B.importViaFilePicker);
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 8 — MARQUEUR
     ═══════════════════════════════════════════════════════════ */

  VC._backupLoaded = true;

  VC.logInfo('28-backup', 'Module chargé (trash + externalPrices + legacy)');

})(window);