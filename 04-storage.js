/* ═══════════════════════════════════════════════════════════════
   VOLTCORE — 04-storage.js
   VERSION : v6.7 (Session #3 — retenue garantie BTP intégrée au
                   calcul des paiements, getGarantieEnAttente ajouté)
   RÔLE : Persistance complète (saveAll, loadAll, trash, compteurs,
          statuts paiement, prix externes, logo, IndexedDB backup)
   DÉPENDANCES : 01-core.js (globaux), 03-utils.js (helpers)
   EXPOSE : STORAGE_KEYS, saveAll, loadAll, loadFrais, moveToTrash,
            restoreFromTrash, emptyTrash, getCompteurs, genererNumero,
            incrementerCompteur, incrementerNumeroBon, numeroDocExiste,
            getTotalPaye, getAvoirTotalForFacture, getNetRevenu,
            getStatutPaiement, getResteAPayer, getGarantieEnAttente,
            loadExternalPrices, saveExternalPrices, recordExternalPrice,
            getExternalPricesForFournisseur,
            cleanupExternalPricesForPurchase,
            getLogo, saveLogo, applyLogo,
            loadDismissedAlerts, saveDismissedAlerts, dismissAlert,
            autoBackupIfNeeded, checkImportRate
   ═══════════════════════════════════════════════════════════════ */

/* ═══════════ SECTION 1 — CONSTANTES + GLOBAUX ═══════════ */

var STORAGE_KEYS = {
  clients:          'voltcore_clients',
  articles:         'voltcore_articles',
  documents:        'voltcore_documents',
  familles:         'voltcore_familles',
  suppliers:        'voltcore_suppliers',
  chantiers:        'voltcore_chantiers',
  frais:            'voltcore_frais',
  bonsRoute:        'voltcore_bons_route',
  trash:            'voltcore_trash',
  log:              'voltcore_log',
  chantierActive:   'voltcore_chantier_actif',
  hrEmployees:      'voltcore_hr_employees',
  hrWorkEntries:    'voltcore_hr_work_entries',
  hrTransactions:   'voltcore_hr_transactions',
  purchaseInvoices: 'voltcore_purchase_invoices',
  rib:              'voltcore_rib',
  banque:           'voltcore_banque',
  mf:               'voltcore_mf',
  rne:              'voltcore_rne',
  logo:             'voltcore_logo',
  dark:             'voltcore_dark',
  compteurs:        'voltcore_compteurs',
  bonCounter:       'voltcore_bon_counter',
  /* v6.10.2 — bonDraftA/B/C/D supprimés (bons A/B/C/D redondants) */
  brouillonCourant: 'voltcore_brouillon_courant',
  savePrefs:        'voltcore_save_prefs',
  backupsRegistry:  'voltcore_backups_registry',
  internalBackup:   'voltcore_internal_backup',
  externalPrices:   'voltcore_external_prices',
  dismissedAlerts:  'voltcore_dismissed_alerts',
  docHistory:       'voltcore_doc_history',
  errorLog:         'voltcore_error_log',
  lastAutoBackup:   'voltcore_last_auto_backup',
  lastManualSave:   'voltcore_last_manual_save',
  lastCloudSave:    'voltcore_last_cloud_save',
  idbLastBackup:    'voltcore_idb_last_backup',
  /* v6.9.6 — signature & cachet par défaut (métadonnées) */
  signatureDefault: 'voltcore_signature_default',
  cachetDefault:    'voltcore_cachet_default',
  /* v6.9.8 — bibliothèque de documents (métadonnées ; blobs en IDB) */
  documentsLib:         'voltcore_documents_lib',
  documentsCategories:  'voltcore_documents_categories'
};

var compteurs = {};
var externalPrices = {};
var dismissedAlerts = [];
var docHistory = {};
var chantierActifId = null;

/* LOT 4 — Cache des avoirs pour performance */
var __avoirCache = null;

function _invalidateAvoirCache() {
  __avoirCache = null;
}

/* ═══════════ SECTION 2 — HELPERS JSON SÛRS ═══════════ */

function _safeGetJSON(key, fallback) {
  try {
    var raw = localStorage.getItem(key);
    if (raw === null || raw === undefined || raw === '') return fallback;
    var parsed = JSON.parse(raw);
    return (parsed === null || parsed === undefined) ? fallback : parsed;
  } catch (e) {
    console.warn('_safeGetJSON(' + key + ') :', e);
    return fallback;
  }
}

function _safeSetJSON(key, value) {
  try {
    var json = JSON.stringify(value);
    localStorage.setItem(key, json);
    return true;
  } catch (e) {
    if (e && (e.name === 'QuotaExceededError' || e.code === 22)) {
      console.error('Quota localStorage dépassé pour ' + key);
      if (typeof showToast === 'function') {
        showToast('Stockage plein. Exporte un backup puis supprime des données.', 'error', 6000);
      }
    } else {
      console.warn('_safeSetJSON(' + key + ') :', e);
    }
    return false;
  }
}

function safeLoadArray(key) {
  var v = _safeGetJSON(key, null);
  return Array.isArray(v) ? v : [];
}

function _safeLoadObject(key) {
  var v = _safeGetJSON(key, null);
  return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
}

function checkStorageQuota() {
  try {
    if (!navigator.storage || !navigator.storage.estimate) return null;
    return navigator.storage.estimate().then(function (est) {
      var usage = est.usage || 0;
      var quota = est.quota || 0;
      return quota ? Math.round((usage / quota) * 100) : 0;
    }).catch(function () { return null; });
  } catch (e) { return null; }
}

/* ═══════════ SECTION 3 — JOURNAL D'ACTIVITÉ ═══════════ */

var VOLTCORE_LOG_MAX = 500;

function logAction(action, details) {
  try {
    var entry = {
      date: new Date().toISOString(),
      user: (currentUser && currentUser.username) || 'anon',
      action: String(action || ''),
      details: String(details || '')
    };
    if (!Array.isArray(activityLog)) activityLog = [];
    activityLog.push(entry);
    if (activityLog.length > VOLTCORE_LOG_MAX) {
      activityLog = activityLog.slice(-VOLTCORE_LOG_MAX);
    }
    if (window.__logSaveTimer) clearTimeout(window.__logSaveTimer);
    window.__logSaveTimer = setTimeout(function () {
      window.__logSaveTimer = null;
      _safeSetJSON(STORAGE_KEYS.log, activityLog);
    }, 2000);
  } catch (e) {
    console.warn('logAction :', e);
  }
}

function loadLog() {
  activityLog = safeLoadArray(STORAGE_KEYS.log);
}

/* ═══════════ SECTION 4 — SYNCHRONISATION AVOIRS (B6) ═══════════ */

/* v6.8.1 — Flag anti-spam pour le warning avoirs orphelins.
   Déclaré au niveau module, en haut de la fonction. */
var __lastOrphanWarnAt = 0;

function _synchronizeAvoirIds() {
  try {
    if (!Array.isArray(savedDocuments)) return;
    var byId = {};
    for (var i = 0; i < savedDocuments.length; i++) {
      var d = savedDocuments[i];
      if (d && d.id) byId[d.id] = d;
    }
    for (var j = 0; j < savedDocuments.length; j++) {
      var doc = savedDocuments[j];
      if (doc && doc.type === 'facture') doc.avoirIds = [];
    }
    /* v6.8.1 — Compte les avoirs orphelins pour diagnostic.
       Un avoir orphelin = parentFactureId défini mais facture introuvable.
       Le lien est perdu (comportement voulu, éviter les références cassées),
       mais on loggue pour que l'utilisateur sache que quelque chose cloche. */
    var orphanAvoirs = [];
    for (var k = 0; k < savedDocuments.length; k++) {
      var avoir = savedDocuments[k];
      if (avoir && avoir.type === 'avoir' && avoir.parentFactureId) {
        var parent = byId[avoir.parentFactureId];
        if (parent && parent.type === 'facture') {
          if (!Array.isArray(parent.avoirIds)) parent.avoirIds = [];
          parent.avoirIds.push(avoir.id);
        } else {
          /* parentFactureId existe mais facture absente OU pas une facture */
          orphanAvoirs.push(avoir);
        }
      }
    }
    /* Warning throttlé : 1 par minute maximum (évite le spam console
       car saveAll peut être appelé plusieurs fois par minute). */
    if (orphanAvoirs.length > 0) {
      var now = Date.now();
      if (now - __lastOrphanWarnAt > 60000) {
        __lastOrphanWarnAt = now;
        try {
          var nums = [];
          for (var w = 0; w < Math.min(5, orphanAvoirs.length); w++) {
            nums.push(orphanAvoirs[w].numero || orphanAvoirs[w].id || '?');
          }
          var extra = orphanAvoirs.length > 5 ? ' (+' + (orphanAvoirs.length - 5) + ')' : '';
          console.warn('[Storage] ' + orphanAvoirs.length +
            ' avoir(s) orphelin(s) — facture parente introuvable. ' +
            'Lien supprimé. Avoirs : ' + nums.join(', ') + extra);
        } catch (e) {}
      }
    }
  } catch (e) {
    console.warn('_synchronizeAvoirIds :', e);
  }
  /* LOT 4 — Invalidation du cache après synchro */
  _invalidateAvoirCache();
}

/* ═══════════ SECTION 5 — saveAll (ÉCRITURE) ═══════════ */
/* ═══════════ v6.8.1 — Helpers anti-null pour saveAll ═══════════
   _safeSetJSON écrit JSON.stringify(null) = "null" si on lui passe null,
   ce qui écrase les données valides existantes en localStorage.
   Ces helpers SKIP l'écriture si la valeur est null/undefined, laissant
   l'ancien état intact (auto-guérison au prochain loadAll).
   Retournent true pour ne pas casser le flux `&& ok` de saveAll. */
function _saveArraySafe(key, arr) {
  if (!Array.isArray(arr)) {
    try {
      console.warn('[saveAll] ' + key +
        ' n\'est pas un array (reçu: ' + (arr === null ? 'null' : typeof arr) +
        '), écriture ignorée — données localStorage préservées.');
    } catch (e) {}
    return true;
  }
  return _safeSetJSON(key, arr);
}

function _saveObjectSafe(key, obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    try {
      console.warn('[saveAll] ' + key +
        ' n\'est pas un object (reçu: ' + (obj === null ? 'null' : typeof obj) +
        '), écriture ignorée — données localStorage préservées.');
    } catch (e) {}
    return true;
  }
  return _safeSetJSON(key, obj);
}

function saveAll() {
  try {
    /* LOT 4 — Invalider le cache avant de sauvegarder */
    _invalidateAvoirCache();

    _synchronizeAvoirIds();

    /* v6.8.1 — Écritures protégées contre null/undefined.
       Si un global est null (bug, import corrompu), l'ancien état
       localStorage est PRÉSERVÉ (auto-guérison au prochain loadAll).
       Voir _saveArraySafe / _saveObjectSafe ci-dessus. */
    var ok = true;
    ok = _saveArraySafe(STORAGE_KEYS.clients, clients) && ok;
    ok = _saveArraySafe(STORAGE_KEYS.articles, savedArticles) && ok;
    ok = _saveArraySafe(STORAGE_KEYS.documents, savedDocuments) && ok;
    ok = _saveArraySafe(STORAGE_KEYS.familles, familles) && ok;
    ok = _saveArraySafe(STORAGE_KEYS.suppliers, suppliers) && ok;
    ok = _saveArraySafe(STORAGE_KEYS.chantiers, savedChantiers) && ok;
    ok = _saveArraySafe(STORAGE_KEYS.frais, frais) && ok;
    ok = _saveObjectSafe(STORAGE_KEYS.trash, trash) && ok;
    ok = _saveArraySafe(STORAGE_KEYS.log, activityLog) && ok;
    ok = _saveArraySafe(STORAGE_KEYS.hrEmployees, hrEmployees) && ok;
    ok = _saveArraySafe(STORAGE_KEYS.hrWorkEntries, hrWorkEntries) && ok;
    ok = _saveArraySafe(STORAGE_KEYS.hrTransactions, hrTransactions) && ok;
    ok = _saveArraySafe(STORAGE_KEYS.purchaseInvoices, purchaseInvoices) && ok;
    ok = _saveArraySafe(STORAGE_KEYS.bonsRoute, bonsRoute) && ok;
    ok = _saveObjectSafe(STORAGE_KEYS.externalPrices, externalPrices) && ok;
    ok = _saveArraySafe(STORAGE_KEYS.dismissedAlerts, dismissedAlerts) && ok;

    if (chantierActifId) {
      _safeSetJSON(STORAGE_KEYS.chantierActive, chantierActifId);
    } else {
      try { localStorage.removeItem(STORAGE_KEYS.chantierActive); } catch (e) {}
    }

    window.__lastDataChange = Date.now();

    /* LOT 4 — Invalider aussi le cache fournisseurs */
    if (typeof _invalidateSupplierInvoicesCache === 'function') {
      _invalidateSupplierInvoicesCache();
    }

    try { autoBackupIfNeeded(); } catch (e) {}

    return ok;
  } catch (e) {
    console.error('saveAll :', e);
    if (typeof showToast === 'function') {
      showToast('Erreur critique lors de la sauvegarde.', 'error', 5000);
    }
    return false;
  }
}

/* ═══════════ SECTION 6 — loadAll (LECTURE) ═══════════ */

function loadAll() {
  try {
    clients = safeLoadArray(STORAGE_KEYS.clients);
    savedArticles = safeLoadArray(STORAGE_KEYS.articles);
    savedDocuments = safeLoadArray(STORAGE_KEYS.documents);
    familles = safeLoadArray(STORAGE_KEYS.familles);
    suppliers = safeLoadArray(STORAGE_KEYS.suppliers);
    savedChantiers = safeLoadArray(STORAGE_KEYS.chantiers);
    hrEmployees = safeLoadArray(STORAGE_KEYS.hrEmployees);
    hrWorkEntries = safeLoadArray(STORAGE_KEYS.hrWorkEntries);
    hrTransactions = safeLoadArray(STORAGE_KEYS.hrTransactions);
    purchaseInvoices = safeLoadArray(STORAGE_KEYS.purchaseInvoices);
    bonsRoute = safeLoadArray(STORAGE_KEYS.bonsRoute);
    dismissedAlerts = safeLoadArray(STORAGE_KEYS.dismissedAlerts);

    var t = _safeGetJSON(STORAGE_KEYS.trash, null);
    trash = (t && typeof t === 'object' && !Array.isArray(t))
      ? {
          clients: Array.isArray(t.clients) ? t.clients : [],
          articles: Array.isArray(t.articles) ? t.articles : [],
          documents: Array.isArray(t.documents) ? t.documents : []
        }
      : { clients: [], articles: [], documents: [] };

    activityLog = safeLoadArray(STORAGE_KEYS.log);
    externalPrices = _safeLoadObject(STORAGE_KEYS.externalPrices);
    compteurs = _safeLoadObject(STORAGE_KEYS.compteurs);

    var actif = _safeGetJSON(STORAGE_KEYS.chantierActive, null);
    chantierActifId = (typeof actif === 'string' && actif) ? actif : null;

    try {
      var rib = localStorage.getItem(STORAGE_KEYS.rib);
      if (typeof rib === 'string' && rib) bankRib = rib;
      var bnq = localStorage.getItem(STORAGE_KEYS.banque);
      if (typeof bnq === 'string' && bnq) bankName = bnq;
      var mf = localStorage.getItem(STORAGE_KEYS.mf);
      if (typeof mf === 'string' && mf) bankMF = mf;
      /* v6.8.1 — RNE */
      var rne = localStorage.getItem(STORAGE_KEYS.rne);
      if (typeof rne === 'string' && rne && typeof bankRNE !== 'undefined') bankRNE = rne;
    } catch (e) {}

    _synchronizeAvoirIds();
    loadFrais();
    docHistory = _safeLoadObject(STORAGE_KEYS.docHistory);

    try { applyLogo(); } catch (e) {}
    
    /* LOT 4 — Invalidation des caches */
    _invalidateAvoirCache();
    if (typeof _invalidateSupplierInvoicesCache === 'function') {
      _invalidateSupplierInvoicesCache();
    }

    /* v6.9.5 — Migration des pièces jointes vers IndexedDB (non-bloquante).
       Sort les dataURL du localStorage (gain ~80 % du quota).
       Idempotente : ne fait rien si tout est déjà migré.
       Robuste : un échec (mode privé, IDB bloqué) ne bloque pas le boot. */
    if (_hasAttachmentsToMigrate()) {
      _migrateAttachmentsToIDB().then(function (res) {
        if (res && res.migrated > 0 && typeof showToast === 'function') {
          try {
            showToast(res.migrated + ' pièce(s) jointe(s) migrée(s) — localStorage libéré',
              'info', 4000);
          } catch (e) {}
        }
      }).catch(function (e) {
        console.warn('Migration attachments échouée (non bloquant) :', e);
      });
    }

    /* v6.9.7 — Nettoyage des blobs orphelins (non-bloquant, idempotent).
       Supprime les blobs IDB qui ne sont référencés par AUCUN document
       actif, aucune corbeille, aucun brouillon. Protection absolue de
       sig_default et cachet_default. */
    try {
      _cleanOrphanBlobs().then(function (res) {
        if (res && res.cleaned > 0) {
          console.log('[Boot] ' + res.cleaned + ' blob(s) orphelin(s) nettoyé(s)');
        }
      }).catch(function () {});
    } catch (e) {}

    return true;
  } catch (e) {
    console.error('loadAll :', e);
    if (typeof showToast === 'function') {
      showToast('Erreur critique lors du chargement des données.', 'error', 6000);
    }
    return false;
  }
}

/* ═══════════ SECTION 7 — loadFrais ═══════════ */

function loadFrais() {
  try {
    frais = safeLoadArray(STORAGE_KEYS.frais);
    for (var i = 0; i < frais.length; i++) {
      var f = frais[i];
      if (!f || typeof f !== 'object') { frais.splice(i, 1); i--; continue; }
      if (!f.id) f.id = 'f_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
      if (typeof f.montant !== 'number') f.montant = parseFloat(f.montant) || 0;
    }
  } catch (e) {
    console.warn('loadFrais :', e);
    frais = [];
  }
}

/* ═══════════ SECTION 8 — CORBEILLE (trash) ═══════════ */

function moveToTrash(kind, item) {
  try {
    if (!trash || typeof trash !== 'object') trash = { clients: [], articles: [], documents: [] };
    if (!Array.isArray(trash[kind])) trash[kind] = [];
    var entry = {
      item: item,
      deletedAt: new Date().toISOString(),
      deletedBy: (currentUser && currentUser.username) || 'anon'
    };
    trash[kind].push(entry);
    saveAll();
    return true;
  } catch (e) {
    console.warn('moveToTrash :', e);
    return false;
  }
}

function restoreFromTrash(kind, index) {
  try {
    if (!trash || !Array.isArray(trash[kind])) return null;
    if (index < 0 || index >= trash[kind].length) return null;
    var entry = trash[kind].splice(index, 1)[0];
    saveAll();
    return entry ? entry.item : null;
  } catch (e) {
    console.warn('restoreFromTrash :', e);
    return null;
  }
}

function emptyTrash() {
  try {
    trash = { clients: [], articles: [], documents: [] };
    saveAll();
    return true;
  } catch (e) {
    console.warn('emptyTrash :', e);
    return false;
  }
}

/* ═══════════ SECTION 9 — COMPTEURS (numérotation) ═══════════ */

function saveCompteurs() {
  return _safeSetJSON(STORAGE_KEYS.compteurs, compteurs);
}

function getCompteurs() {
  return compteurs;
}

function genererNumero(type) {
  try {
    var t = String(type || '').toLowerCase();
    var prefixMap = {
      facture: 'FAC',
      devis: 'DEV',
      bl: 'BL',
      avoir: 'AV',
      bon: 'BON',
      achat: 'ACH'
    };
    var prefix = prefixMap[t] || 'DOC';
    var year = new Date().getFullYear();
    var key = t + '_' + year;
    var current = parseInt(compteurs[key], 10) || 0;
    var next = current + 1;
    return prefix + '-' + year + '-' + String(next).padStart(4, '0');
  } catch (e) {
    console.warn('genererNumero :', e);
    return 'DOC-????-0001';
  }
}

function incrementerCompteur(type) {
  try {
    var t = String(type || '').toLowerCase();
    var year = new Date().getFullYear();
    var key = t + '_' + year;
    compteurs[key] = (parseInt(compteurs[key], 10) || 0) + 1;
    saveCompteurs();
    return compteurs[key];
  } catch (e) {
    console.warn('incrementerCompteur :', e);
    return 0;
  }
}

/* v6.10.2 — incrementerNumeroBon supprimé (bons A/B/C/D redondants) */

/* LOT 2 — Détection de doublon de numéro */
function numeroDocExiste(numero, excludeId) {
  try {
    if (!numero || !Array.isArray(savedDocuments)) return false;
    var target = String(numero).trim().toLowerCase();
    if (!target) return false;
    for (var i = 0; i < savedDocuments.length; i++) {
      var d = savedDocuments[i];
      if (!d || !d.numero) continue;
      if (excludeId && String(d.id) === String(excludeId)) continue;
      if (String(d.numero).trim().toLowerCase() === target) return true;
    }
    return false;
  } catch (e) {
    console.warn('numeroDocExiste :', e);
    return false;
  }
}

/* ═══════════ SECTION 10 — STATUTS PAIEMENT + AVOIRS ═══════════
   v6.7 (Session #3) :
   - getStatutPaiement et getResteAPayer soustraient maintenant la
     retenue garantie BTP du "dû".
   - Nouveau helper getGarantieEnAttente(doc) qui retourne le montant
     de garantie retenu (information seulement, pour futur module
     "Libération de garantie").

   LOGIQUE RETENUE GARANTIE BTP :
   Une facture BTP peut avoir une retenue garantie (typiquement 5% du HT).
   Le client paie le NET À PAYER (TTC − retenues fiscales − garantie),
   et la garantie lui sera restituée plus tard (fin de chantier +
   expiration délai de garantie, typiquement 1 an).

   Du point de vue de l'app :
   - Le "reste à percevoir aujourd'hui" = netAPayer − paiements
   - La "garantie en attente" = montant retenu à recouvrer plus tard
   - Tant que netAPayer est versé → facture payée (vis-à-vis du
     présent), même si la garantie reste à libérer
   - Le CA (getNetRevenu) INCLUT la garantie car elle sera perçue
     (comptablement, c'est du CA facturé)
   ═══════════════════════════════════════════════════════════════ */

function getTotalPaye(doc) {
  try {
    if (!doc || !Array.isArray(doc.paiements)) return 0;
    var total = 0;
    for (var i = 0; i < doc.paiements.length; i++) {
      var p = doc.paiements[i];
      if (p && typeof p.montant === 'number' && isFinite(p.montant)) {
        total += p.montant;
      }
    }
    return total;
  } catch (e) {
    console.warn('getTotalPaye :', e);
    return 0;
  }
}

/* LOT 4 — Cache des avoirs */
function _buildAvoirCache() {
  var cache = {};
  try {
    if (!Array.isArray(savedDocuments)) return cache;
    for (var i = 0; i < savedDocuments.length; i++) {
      var d = savedDocuments[i];
      if (!d || d.type !== 'avoir') continue;
      if (d.statut === 'annulee' || d.annulee === true) continue;
      var parentId = String(d.parentFactureId || '');
      if (!parentId) continue;
      var total = (d.totals && typeof d.totals.total === 'number') ? d.totals.total : 0;
      cache[parentId] = (cache[parentId] || 0) + total;
    }
  } catch (e) { console.warn('_buildAvoirCache :', e); }
  return cache;
}

function getAvoirTotalForFacture(factureId) {
  try {
    if (!factureId) return 0;
    if (__avoirCache === null) {
      __avoirCache = _buildAvoirCache();
    }
    return __avoirCache[String(factureId)] || 0;
  } catch (e) {
    console.warn('getAvoirTotalForFacture :', e);
    return 0;
  }
}

/* Net revenu (déduction avoirs) — CA facturé.
   v6.7 : inchangé volontairement. Retourne totalTTC - avoirs.
   La retenue garantie est INCLUSE dans le CA (créance future).
   Pour connaître le "net à percevoir aujourd'hui", voir getResteAPayer. */
function getNetRevenu(doc) {
  try {
    if (!doc || typeof doc !== 'object') return 0;
    var total = (doc.totals && typeof doc.totals.total === 'number')
      ? doc.totals.total
      : (typeof doc.totalTTC === 'number' ? doc.totalTTC : 0);
    if (doc.type === 'avoir') {
      return total > 0 ? -total : 0;
    }
    if (doc.type === 'facture' || !doc.type) {
      var avoir = getAvoirTotalForFacture(doc.id);
      var net = total - avoir;
      return net > 0 ? net : 0;
    }
    return total;
  } catch (e) {
    console.warn('getNetRevenu :', e);
    return 0;
  }
}

/* ═══════════ SECTION 10.bis — CALCUL DU DÛ (v6.8.1) ═══════════
   ⚠️ POINT UNIQUE de calcul du dû d'un document.
   ⚠️ NE PAS DUPLIQUER cette fonction. Une seule définition.

   Formule : du = totalTTC − retenueMontant − retenueGarantie − avoirs
   Clampé à 0 minimum (une facture ne peut pas avoir un dû négatif).

   FALLBACK LEGACY (v6.8.1) :
   Lire doc.X EN PRIORITÉ, mais avec fallback doc.totals.X.
   - Nouveaux docs (v6.7+) : doc.retenueMontant existe (raccourci top-level)
   - Docs legacy (< v6.7) : seul doc.totals.retenueMontant existe
   Sans ce fallback, les vieilles factures apparaissent impayées par erreur. */
function _computeDuDoc(doc) {
  try {
    if (!doc || typeof doc !== 'object') return 0;

    /* Total TTC */
    var total = (doc.totals && typeof doc.totals.total === 'number')
      ? doc.totals.total
      : (typeof doc.totalTTC === 'number' ? doc.totalTTC : 0);
    if (!total) return 0;

    /* Retenue IR + TVA (doc.X priorité, fallback doc.totals.X) */
    var retenue = (typeof doc.retenueMontant === 'number')
      ? doc.retenueMontant
      : (doc.totals && typeof doc.totals.retenueMontant === 'number')
        ? doc.totals.retenueMontant
        : 0;

    /* Retenue garantie BTP (doc.X priorité, fallback doc.totals.X) */
    var retenueGarantie = (typeof doc.retenueGarantie === 'number')
      ? doc.retenueGarantie
      : (doc.totals && typeof doc.totals.retenueGarantie === 'number')
        ? doc.totals.retenueGarantie
        : 0;

    /* Avoirs liés */
    var avoir = getAvoirTotalForFacture(doc.id);

    /* Dû = TTC − retenues − avoirs */
    var du = total - retenue - retenueGarantie - avoir;
    if (du < 0) du = 0;
    return du;
  } catch (e) {
    console.warn('_computeDuDoc :', e);
    return 0;
  }
}


function getStatutPaiement(doc) {
  try {
    if (!doc || typeof doc !== 'object') return 'brouillon';
    if (doc.statut === 'annulee' || doc.annulee === true) return 'annulee';
    if (doc.type === 'avoir') return 'avoir';

    var du = _computeDuDoc(doc);
    if (!du) return 'brouillon';

    var paye = getTotalPaye(doc);
    var reste = du - paye;
    if (reste <= 0.001) return 'payee';
    if (paye > 0.001) return 'partielle';
    return 'impayee';
  } catch (e) {
    console.warn('getStatutPaiement :', e);
    return 'brouillon';
  }
}

function getResteAPayer(doc) {
  try {
    if (!doc || typeof doc !== 'object') return 0;
    var du = _computeDuDoc(doc);
    var paye = getTotalPaye(doc);
    var reste = du - paye;
    return reste > 0 ? reste : 0;
  } catch (e) {
    console.warn('getResteAPayer :', e);
    return 0;
  }
}


/* v6.7 — Retourne le montant de retenue garantie encore en attente
   de libération pour un document.
   - Retourne 0 si pas de garantie ou si annulée/avoir.
   - Sert au futur module "Libération de garantie" (à venir) et aux
     rapports qui veulent distinguer "impayé" de "garantie à libérer".
   NOTE : ce montant n'est PAS retiré de getResteAPayer (il est déjà
   retiré dans _computeDuDoc). Cette fonction est informative. */
function getGarantieEnAttente(doc) {
  try {
    if (!doc || typeof doc !== 'object') return 0;
    if (doc.statut === 'annulee' || doc.annulee === true) return 0;
    if (doc.type === 'avoir') return 0;
    if (doc.type && doc.type !== 'facture') return 0;
    var g = 0;
    if (doc.totals && typeof doc.totals.retenueGarantie === 'number') {
      g = doc.totals.retenueGarantie;
    } else if (typeof doc.retenueGarantie === 'number') {
      g = doc.retenueGarantie;
    }
    return g > 0 ? g : 0;
  } catch (e) {
    console.warn('getGarantieEnAttente :', e);
    return 0;
  }
}

/* ═══════════ SECTION 11 — PRIX EXTERNES ═══════════ */

function loadExternalPrices() {
  externalPrices = _safeLoadObject(STORAGE_KEYS.externalPrices);
}

function saveExternalPrices() {
  return _safeSetJSON(STORAGE_KEYS.externalPrices, externalPrices);
}

function recordExternalPrice(articleId, prixUnitaire, fournisseur, factureRef, date) {
  try {
    if (!articleId || typeof prixUnitaire !== 'number' || !isFinite(prixUnitaire)) return;
    if (!externalPrices || typeof externalPrices !== 'object') externalPrices = {};
    var key = String(articleId);
    if (!Array.isArray(externalPrices[key])) externalPrices[key] = [];
    var entry = {
      prix: prixUnitaire,
      fournisseur: String(fournisseur || ''),
      factureRef: String(factureRef || ''),
      date: String(date || new Date().toISOString().slice(0, 10))
    };
    for (var i = 0; i < externalPrices[key].length; i++) {
      var e = externalPrices[key][i];
      if (e.date === entry.date && e.fournisseur === entry.fournisseur && e.prix === entry.prix) {
        return;
      }
    }
    externalPrices[key].push(entry);
    if (externalPrices[key].length > 50) {
      externalPrices[key] = externalPrices[key].slice(-50);
    }
    saveExternalPrices();
  } catch (e) {
    console.warn('recordExternalPrice :', e);
  }
}

function getExternalPricesForFournisseur(fournisseur) {
  try {
    if (!externalPrices || !fournisseur) return {};
    var result = {};
    var f = String(fournisseur);
    for (var articleId in externalPrices) {
      if (!externalPrices.hasOwnProperty(articleId)) continue;
      var list = externalPrices[articleId];
      if (!Array.isArray(list)) continue;
      var filtered = list.filter(function (e) { return e && e.fournisseur === f; });
      if (filtered.length > 0) result[articleId] = filtered;
    }
    return result;
  } catch (e) {
    console.warn('getExternalPricesForFournisseur :', e);
    return {};
  }
}

/* LOT 2 — Nettoyage comparateur sur édition d'achat */
function cleanupExternalPricesForPurchase(purchase) {
  try {
    if (!purchase || !externalPrices || typeof externalPrices !== 'object') return 0;
    var ref = String(purchase.numero || purchase.refFacture || '').trim();
    var supplier = String(purchase.fournisseur || '').trim();
    if (!ref && !supplier) return 0;

    var removed = 0;
    for (var articleId in externalPrices) {
      if (!externalPrices.hasOwnProperty(articleId)) continue;
      var list = externalPrices[articleId];
      if (!Array.isArray(list)) continue;
      var filtered = list.filter(function (e) {
        if (!e) return false;
        var eRef = String(e.factureRef || '').trim();
        var eSup = String(e.fournisseur || '').trim();
        var matchRef = ref && eRef === ref;
        var matchSup = supplier && eSup === supplier;
        if (matchRef && matchSup) {
          removed++;
          return false;
        }
        return true;
      });
      externalPrices[articleId] = filtered;
      if (filtered.length === 0) {
        delete externalPrices[articleId];
      }
    }
    if (removed > 0) saveExternalPrices();
    return removed;
  } catch (e) {
    console.warn('cleanupExternalPricesForPurchase :', e);
    return 0;
  }
}

/* ═══════════ SECTION 12 — LOGO ═══════════ */

function getLogo() {
  try {
    return localStorage.getItem(STORAGE_KEYS.logo) || '';
  } catch (e) { return ''; }
}

function saveLogo(dataUrl) {
  try {
    if (dataUrl) {
      localStorage.setItem(STORAGE_KEYS.logo, String(dataUrl));
    } else {
      localStorage.removeItem(STORAGE_KEYS.logo);
    }
    applyLogo();
    return true;
  } catch (e) {
    console.warn('saveLogo :', e);
    return false;
  }
}

function applyLogo() {
  try {
    var dataUrl = getLogo();
    var imgs = document.querySelectorAll('[data-voltcore-logo]');
    for (var i = 0; i < imgs.length; i++) {
      var img = imgs[i];
      if (dataUrl) {
        img.src = dataUrl;
        img.style.display = '';
      } else {
        img.removeAttribute('src');
        img.style.display = 'none';
      }
    }
  } catch (e) {
    console.warn('applyLogo :', e);
  }
}

/* ═══════════ SECTION 13 — ALERTES MASQUÉES ═══════════ */

function loadDismissedAlerts() {
  dismissedAlerts = safeLoadArray(STORAGE_KEYS.dismissedAlerts);
}

function saveDismissedAlerts() {
  return _safeSetJSON(STORAGE_KEYS.dismissedAlerts, dismissedAlerts);
}

function dismissAlert(alertId) {
  try {
    if (!alertId) return;
    if (!Array.isArray(dismissedAlerts)) dismissedAlerts = [];
    if (dismissedAlerts.indexOf(alertId) >= 0) return;
    dismissedAlerts.push(alertId);
    saveDismissedAlerts();
  } catch (e) {
    console.warn('dismissAlert :', e);
  }
}

/* ═══════════ SECTION 14 — INDEXEDDB BACKUP ═══════════ */

var VOLTCORE_IDB_NAME = 'voltcore_backups';
/* v6.9.5 — v2 ajoute le store 'blobs' (pièces jointes, scans) */
/* v6.9.9 — v3 ajoute le store 'fsHandles' (dossier local) */
var VOLTCORE_IDB_VERSION = 3;
var VOLTCORE_IDB_STORE = 'backups';
var VOLTCORE_IDB_BLOBS_STORE = 'blobs';
var VOLTCORE_IDB_KEEP = 7;
var VOLTCORE_IDB_MAX_SIZE = 20 * 1024 * 1024;

/* v6.9.5 — Flag mémoire anti-boucle de migration (pas persisté) */
var __attachmentMigrationAttempted = false;

function _idbOpen() {
  return new Promise(function (resolve, reject) {
    if (!window.indexedDB) return reject(new Error('IndexedDB indisponible'));
    var req;
    try {
      req = indexedDB.open(VOLTCORE_IDB_NAME, VOLTCORE_IDB_VERSION);
    } catch (e) {
      return reject(e);
    }
    req.onupgradeneeded = function (ev) {
      var db = ev.target.result;
      if (!db.objectStoreNames.contains(VOLTCORE_IDB_STORE)) {
        var store = db.createObjectStore(VOLTCORE_IDB_STORE, { keyPath: 'id', autoIncrement: true });
        store.createIndex('date', 'date', { unique: false });
      }
      /* v6.9.5 — store blobs (pièces jointes, scans, signatures) */
      if (!db.objectStoreNames.contains(VOLTCORE_IDB_BLOBS_STORE)) {
        var blobsStore = db.createObjectStore(VOLTCORE_IDB_BLOBS_STORE, { keyPath: 'id' });
        blobsStore.createIndex('createdAt', 'createdAt', { unique: false });
      }
      /* v6.9.9 — store fsHandles (FileSystemDirectoryHandle sérialisé) */
      if (!db.objectStoreNames.contains('fsHandles')) {
        db.createObjectStore('fsHandles', { keyPath: 'id' });
      }
    };
    req.onsuccess = function () { resolve(req.result); };
    req.onerror = function () { reject(req.error || new Error('Ouverture IndexedDB échouée')); };
  });
}

/* LOT 1 — Sérialisation avec les vraies clés */
function _serializeAllStorage() {
  var out = {};
  for (var key in STORAGE_KEYS) {
    if (!STORAGE_KEYS.hasOwnProperty(key)) continue;
    try {
      var v = localStorage.getItem(STORAGE_KEYS[key]);
      if (v !== null && v !== undefined) {
        out[STORAGE_KEYS[key]] = v;
      }
    } catch (e) {}
  }
  return out;
}
/* ═══════════ v6.9.5 — CRUD BLOBS (pièces jointes) ═══════════
   Stockage binaire dans IndexedDB (store 'blobs').
   Chaque blob : { id: 'blob_xxx', data: Blob, mime: 'image/jpeg', createdAt: ISO }
   Objectif : sortir les dataURL des pièces jointes du localStorage
   (quota 5 Mo) et les stocker dans IDB (illimité en pratique). */

function _idbBlobsPut(id, blob, mime) {
  return new Promise(function (resolve, reject) {
    if (!id || !blob) return reject(new Error('id et blob requis'));
    _idbOpen().then(function (db) {
      var tx, store, req;
      try {
        tx = db.transaction(VOLTCORE_IDB_BLOBS_STORE, 'readwrite');
        store = tx.objectStore(VOLTCORE_IDB_BLOBS_STORE);
        req = store.put({
          id: String(id),
          data: blob,
          mime: String(mime || blob.type || 'application/octet-stream'),
          createdAt: new Date().toISOString()
        });
      } catch (e) {
        db.close();
        return reject(e);
      }
      req.onsuccess = function () { db.close(); resolve(req.result); };
      req.onerror = function () { db.close(); reject(req.error || new Error('idbBlobsPut échoué')); };
    }).catch(reject);
  });
}

function _idbBlobsGet(id) {
  return new Promise(function (resolve, reject) {
    if (!id) return resolve(null);
    _idbOpen().then(function (db) {
      var tx, store, req;
      try {
        tx = db.transaction(VOLTCORE_IDB_BLOBS_STORE, 'readonly');
        store = tx.objectStore(VOLTCORE_IDB_BLOBS_STORE);
        req = store.get(String(id));
      } catch (e) {
        db.close();
        return reject(e);
      }
      req.onsuccess = function () {
        db.close();
        resolve(req.result || null);
      };
      req.onerror = function () { db.close(); reject(req.error || new Error('idbBlobsGet échoué')); };
    }).catch(reject);
  });
}

function _idbBlobsDelete(id) {
  return new Promise(function (resolve, reject) {
    if (!id) return resolve(false);
    _idbOpen().then(function (db) {
      var tx, store, req;
      try {
        tx = db.transaction(VOLTCORE_IDB_BLOBS_STORE, 'readwrite');
        store = tx.objectStore(VOLTCORE_IDB_BLOBS_STORE);
        req = store.delete(String(id));
      } catch (e) {
        db.close();
        return reject(e);
      }
      req.onsuccess = function () { db.close(); resolve(true); };
      req.onerror = function () { db.close(); reject(req.error || new Error('idbBlobsDelete échoué')); };
    }).catch(reject);
  });
}

/* Conversion dataURL → Blob (Promise). Corrige l'absence de Blob natif
   dans les anciens navigateurs en repassant par Uint8Array. */
function _dataURLToBlob(dataUrl) {
  return new Promise(function (resolve, reject) {
    try {
      if (!dataUrl || typeof dataUrl !== 'string') return reject(new Error('dataUrl vide'));
      var parts = dataUrl.split(',');
      if (parts.length !== 2) return reject(new Error('format dataUrl invalide'));
      var mimeMatch = parts[0].match(/:(.*?);/);
      var mime = mimeMatch ? mimeMatch[1] : 'application/octet-stream';
      var binary = atob(parts[1]);
      var bytes = new Uint8Array(binary.length);
      for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      var blob = new Blob([bytes], { type: mime });
      resolve(blob);
    } catch (e) { reject(e); }
  });
}

/* Conversion Blob → dataURL (Promise) via FileReader. */
function _blobToDataURL(blob) {
  return new Promise(function (resolve, reject) {
    try {
      if (!blob) return reject(new Error('blob vide'));
      var reader = new FileReader();
      reader.onload = function (e) { resolve(e.target.result); };
      reader.onerror = function () { reject(reader.error || new Error('FileReader échoué')); };
      reader.readAsDataURL(blob);
    } catch (e) { reject(e); }
  });
}

/* Vérifie s'il reste des attachments avec data (pas encore migrés). */
function _hasAttachmentsToMigrate() {
  try {
    if (!Array.isArray(savedDocuments)) return false;
    for (var i = 0; i < savedDocuments.length; i++) {
      var d = savedDocuments[i];
      if (!d || !Array.isArray(d.attachments)) continue;
      for (var j = 0; j < d.attachments.length; j++) {
        if (d.attachments[j] && d.attachments[j].data) return true;
      }
    }
    return false;
  } catch (e) { return false; }
}

/* ═══════════ v6.9.5 — MIGRATION ATTACHMENTS → IDB ═══════════
   Parcourt tous les savedDocuments[].attachments[].
   Pour chaque attachment avec `data` (dataURL) :
     1. Génère un `ref` unique si absent
     2. Pousse le blob dans IDB
     3. Met `data = null` (libère localStorage)
   Idempotent : les attachments déjà migrés (data=null) sont ignorés.
   Robuste : un échec sur un item n'arrête pas la boucle.
   Résultat : Promise<{ migrated, failed, total }> */
function _migrateAttachmentsToIDB() {
  return new Promise(function (resolve) {
    try {
      if (__attachmentMigrationAttempted) {
        return resolve({ migrated: 0, failed: 0, total: 0, alreadyAttempted: true });
      }
      __attachmentMigrationAttempted = true;

      if (!Array.isArray(savedDocuments) || savedDocuments.length === 0) {
        return resolve({ migrated: 0, failed: 0, total: 0 });
      }

      /* Collecte */
      var toMigrate = [];
      for (var i = 0; i < savedDocuments.length; i++) {
        var doc = savedDocuments[i];
        if (!doc || !Array.isArray(doc.attachments)) continue;
        for (var j = 0; j < doc.attachments.length; j++) {
          var att = doc.attachments[j];
          if (!att) continue;
          if (!att.data) continue;
          if (!att.ref) {
            att.ref = 'blob_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
          }
          toMigrate.push({ doc: doc, att: att, ref: att.ref });
        }
      }

      if (toMigrate.length === 0) {
        return resolve({ migrated: 0, failed: 0, total: 0 });
      }

      console.log('[Migration] ' + toMigrate.length +
        ' pièce(s) jointe(s) à migrer vers IndexedDB…');

      var idx = 0, ok = 0, ko = 0;
      function next() {
        if (idx >= toMigrate.length) {
          if (ok > 0) {
            try { saveAll(); } catch (e) { console.warn('saveAll post-migration :', e); }
            console.log('[Migration] ' + ok +
              ' pièce(s) jointe(s) migrée(s) — localStorage libéré' +
              (ko > 0 ? ' · ' + ko + ' échec(s)' : ''));
          }
          return resolve({ migrated: ok, failed: ko, total: toMigrate.length });
        }
        var item = toMigrate[idx++];
        _dataURLToBlob(item.att.data).then(function (blob) {
          return _idbBlobsPut(item.ref, blob, blob.type);
        }).then(function () {
          item.att.data = null;
          if (!item.att.mime) item.att.mime = '';
          ok++;
          next();
        }).catch(function (e) {
          console.warn('[Migration] Échec pour ' + item.ref + ' :', e);
          ko++;
          next();
        });
      }
      next();
    } catch (e) {
      console.warn('_migrateAttachmentsToIDB :', e);
      resolve({ migrated: 0, failed: 0, total: 0, error: String(e.message || e) });
    }
  });
}

/* Charge les blobs manquants (attachments avec ref mais sans data).
   Utilisé par openEditInvoice pour reconstruire les dataURL temporaires
   nécessaires au formulaire. Mutate les objets att en place. */
   /* ═══════════ v6.9.7 — NETTOYAGE BLOBS ORPHELINS ═══════════
   Parcourt tous les blobs de l'IDB, compare aux refs utilisés :
     • savedDocuments[].attachments[].ref       (docs actifs)
     • trash.documents[].item.attachments[].ref (docs en corbeille)
     • brouillonCourant.attachments[].ref       (facture en cours)
     • sig_default / cachet_default             (TOUJOURS protégés)
   Supprime tout blob dont l'id n'est référencé nulle part.

   Idempotent, non-bloquant, robuste aux erreurs IDB. */
function _cleanOrphanBlobs() {
  return new Promise(function (resolve) {
    try {
      if (typeof indexedDB === 'undefined') {
        return resolve({ cleaned: 0, reason: 'no-idb' });
      }

      /* 1. Collecte des refs utilisés */
      var usedRefs = {};

      /* a) Attachments des documents actifs */
      if (Array.isArray(savedDocuments)) {
        for (var i = 0; i < savedDocuments.length; i++) {
          var doc = savedDocuments[i];
          if (!doc || !Array.isArray(doc.attachments)) continue;
          for (var j = 0; j < doc.attachments.length; j++) {
            var att = doc.attachments[j];
            if (att && att.ref) usedRefs[String(att.ref)] = true;
          }
        }
      }

      /* b) Attachments des documents en CORBEILLE (à protéger pour undo) */
      try {
        if (trash && typeof trash === 'object' && Array.isArray(trash.documents)) {
          for (var t = 0; t < trash.documents.length; t++) {
            var tEntry = trash.documents[t];
            if (!tEntry || !tEntry.item) continue;
            var tDoc = tEntry.item;
            if (!Array.isArray(tDoc.attachments)) continue;
            for (var ta = 0; ta < tDoc.attachments.length; ta++) {
              var tAtt = tDoc.attachments[ta];
              if (tAtt && tAtt.ref) usedRefs[String(tAtt.ref)] = true;
            }
          }
        }
      } catch (e) { /* silencieux */ }

      /* c) Attachments du brouillon courant */
      try {
        if (typeof STORAGE_KEYS !== 'undefined' && STORAGE_KEYS.brouillonCourant) {
          var raw = localStorage.getItem(STORAGE_KEYS.brouillonCourant);
          if (raw) {
            var draft = JSON.parse(raw);
            if (draft && Array.isArray(draft.attachments)) {
              for (var k = 0; k < draft.attachments.length; k++) {
                var dAtt = draft.attachments[k];
                if (dAtt && dAtt.ref) usedRefs[String(dAtt.ref)] = true;
              }
            }
          }
        }
      } catch (e) { /* silencieux */ }

      /* d) Signature & cachet par défaut — PROTECTION ABSOLUE */
      usedRefs[VOLTCORE_SIG_DEFAULT_REF] = true;
      usedRefs[VOLTCORE_CACHET_DEFAULT_REF] = true;

      /* 2. Scan des blobs IDB */
      _idbOpen().then(function (db) {
        var tx, store, req;
        try {
          tx = db.transaction(VOLTCORE_IDB_BLOBS_STORE, 'readonly');
          store = tx.objectStore(VOLTCORE_IDB_BLOBS_STORE);
          req = store.openCursor();
        } catch (e) {
          db.close();
          return resolve({ cleaned: 0, error: String(e.message || e) });
        }

        var toDelete = [];
        req.onsuccess = function (ev) {
          var cur = ev.target.result;
          if (cur) {
            var id = String(cur.value.id || '');
            if (id && !usedRefs[id]) toDelete.push(id);
            cur.continue();
          } else {
            db.close();
            if (toDelete.length === 0) {
              return resolve({ cleaned: 0 });
            }
            /* 3. Suppression séquentielle (évite les races) */
            var deleted = 0;
            var idx = 0;
            function nextDelete() {
              if (idx >= toDelete.length) {
                try {
                  console.log('[Cleanup] ' + deleted + ' blob(s) orphelin(s) supprimé(s)');
                } catch (e) {}
                return resolve({ cleaned: deleted });
              }
              var deleteId = toDelete[idx++];
              _idbBlobsDelete(deleteId).then(function () {
                deleted++;
                nextDelete();
              }).catch(function () {
                nextDelete();
              });
            }
            nextDelete();
          }
        };
        req.onerror = function () {
          db.close();
          resolve({ cleaned: 0, error: 'cursor error' });
        };
      }).catch(function (e) {
        resolve({ cleaned: 0, error: String(e.message || e) });
      });
    } catch (e) {
      console.warn('_cleanOrphanBlobs :', e);
      resolve({ cleaned: 0, error: String(e.message || e) });
    }
  });
}

function _loadMissingAttachmentBlobs(atts) {
  return new Promise(function (resolve) {
    try {
      if (!Array.isArray(atts) || atts.length === 0) return resolve();
      if (typeof indexedDB === 'undefined') return resolve();

      var pending = 0;
      for (var i = 0; i < atts.length; i++) {
        if (atts[i] && atts[i].ref && !atts[i].data) pending++;
      }
      if (pending === 0) return resolve();

      var done = 0;
      function checkDone() { if (done >= pending) resolve(); }

      for (var j = 0; j < atts.length; j++) {
        (function (att) {
          if (!att || !att.ref || att.data) return;
          _idbBlobsGet(att.ref).then(function (row) {
            if (!row || !row.data) { done++; return checkDone(); }
            return _blobToDataURL(row.data).then(function (dataUrl) {
              att.data = dataUrl;
              if (!att.mime && row.mime) att.mime = row.mime;
              done++;
              checkDone();
            }).catch(function () { done++; checkDone(); });
          }).catch(function () { done++; checkDone(); });
        })(atts[j]);
      }
    } catch (e) {
      console.warn('_loadMissingAttachmentBlobs :', e);
      resolve();
    }
  });
}

function _idbSaveBackup(payload) {
  return new Promise(function (resolve, reject) {
    var json;
    try { json = JSON.stringify(payload); }
    catch (e) { return reject(e); }
    if (json.length > VOLTCORE_IDB_MAX_SIZE) {
      return reject(new Error('Backup trop volumineux'));
    }
    _idbOpen().then(function (db) {
      var tx, store, req;
      try {
        tx = db.transaction(VOLTCORE_IDB_STORE, 'readwrite');
        store = tx.objectStore(VOLTCORE_IDB_STORE);
        req = store.add({
          date: new Date().toISOString(),
          size: json.length,
          payload: payload
        });
      } catch (e) {
        db.close();
        return reject(e);
      }
      req.onsuccess = function () {
        db.close();
        resolve(req.result);
      };
      req.onerror = function () {
        db.close();
        reject(req.error || new Error('Sauvegarde IDB échouée'));
      };
    }).catch(reject);
  });
}

function _idbListBackups() {
  return new Promise(function (resolve, reject) {
    _idbOpen().then(function (db) {
      var tx, store, req;
      try {
        tx = db.transaction(VOLTCORE_IDB_STORE, 'readonly');
        store = tx.objectStore(VOLTCORE_IDB_STORE);
        req = store.openCursor();
      } catch (e) {
        db.close();
        return reject(e);
      }
      var out = [];
      req.onsuccess = function (ev) {
        var cur = ev.target.result;
        if (cur) {
          out.push({
            id: cur.value.id,
            date: cur.value.date,
            size: cur.value.size
          });
          cur.continue();
        } else {
          db.close();
          out.sort(function (a, b) { return (a.date < b.date) ? 1 : -1; });
          resolve(out);
        }
      };
      req.onerror = function () {
        db.close();
        reject(req.error || new Error('Liste IDB échouée'));
      };
    }).catch(reject);
  });
}

function _idbRestoreBackup(id) {
  return new Promise(function (resolve, reject) {
    _idbOpen().then(function (db) {
      var tx, store, req;
      try {
        tx = db.transaction(VOLTCORE_IDB_STORE, 'readonly');
        store = tx.objectStore(VOLTCORE_IDB_STORE);
        req = store.get(id);
      } catch (e) {
        db.close();
        return reject(e);
      }
      req.onsuccess = function () {
        db.close();
        resolve(req.result ? req.result.payload : null);
      };
      req.onerror = function () {
        db.close();
        reject(req.error || new Error('Restauration IDB échouée'));
      };
    }).catch(reject);
  });
}

function _idbCleanOldBackups(keep) {
  var max = (typeof keep === 'number') ? keep : VOLTCORE_IDB_KEEP;
  return _idbListBackups().then(function (list) {
    if (list.length <= max) return 0;
    var toDelete = list.slice(max);
    return Promise.all(toDelete.map(function (b) {
      return new Promise(function (resolve) {
        _idbOpen().then(function (db) {
          var tx = db.transaction(VOLTCORE_IDB_STORE, 'readwrite');
          var store = tx.objectStore(VOLTCORE_IDB_STORE);
          var req = store.delete(b.id);
          req.onsuccess = function () { db.close(); resolve(true); };
          req.onerror = function () { db.close(); resolve(false); };
        }).catch(function () { resolve(false); });
      });
    })).then(function (results) {
      return results.filter(function (x) { return x; }).length;
    });
  }).catch(function () { return 0; });
}

function autoBackupIfNeeded() {
  try {
    var last = parseInt(localStorage.getItem(STORAGE_KEYS.idbLastBackup) || '0', 10);
    if (Date.now() - last < 24 * 3600 * 1000) return;
  } catch (e) { return; }

  var payload;
  try { payload = _serializeAllStorage(); } catch (e) { return; }

  _idbSaveBackup(payload).then(function (id) {
    try {
      localStorage.setItem(STORAGE_KEYS.idbLastBackup, String(Date.now()));
      localStorage.setItem(STORAGE_KEYS.lastAutoBackup, new Date().toISOString());
    } catch (e) {}
    console.log('✅ [IDB] Auto-backup enregistré (id=' + id + ')');
    _idbCleanOldBackups(VOLTCORE_IDB_KEEP).catch(function () {});
  }).catch(function (e) {
    console.warn('[IDB] Auto-backup échoué :', e);
  });
}

/* ═══════════ SECTION 15 — RATE-LIMIT IMPORTS ═══════════ */

var __lastImportTime = 0;
var VOLTCORE_IMPORT_MIN_INTERVAL = 2000;

function checkImportRate() {
  var now = Date.now();
  if (now - __lastImportTime < VOLTCORE_IMPORT_MIN_INTERVAL) {
    return false;
  }
  __lastImportTime = now;
  return true;
}

/* v6.7.1 — Sécurité data avant un import mode "replace".
   Pousse tous les items dans la corbeille avant le wipe. Évite une
   perte silencieuse si un import replace est lancé par mégarde.
   Cohérent avec le comportement déjà en place dans 06-clients.js. */
function _pushAllToTrashBeforeReplace(kind, arr) {
  try {
    if (!Array.isArray(arr) || arr.length === 0) return 0;
    if (!trash || typeof trash !== 'object') {
      trash = { clients: [], articles: [], documents: [] };
    }
    if (!Array.isArray(trash[kind])) trash[kind] = [];
    var stamp = new Date().toISOString();
    var user = (typeof currentUser !== 'undefined' && currentUser && currentUser.username) || 'anon';
    for (var i = 0; i < arr.length; i++) {
      if (!arr[i]) continue;
      trash[kind].push({
        item: arr[i],
        deletedAt: stamp,
        deletedBy: user,
        reason: 'import-replace'
      });
    }
    return arr.length;
  } catch (e) {
    console.warn('_pushAllToTrashBeforeReplace :', e);
    return 0;
  }
}

/* ═══════════ v6.8 — GARANTIE BTP : LIBÉRATION ═══════════
   Ajouts Session #4. Permettent de suivre et d'encaisser la retenue
   garantie (typiquement 5% du HT, restituée au client après la période
   de garantie — fin de chantier + 1 an).

   Aucune modification des fonctions existantes (getStatutPaiement,
   getResteAPayer, _computeDuDoc) : la garantie reste exclue du "dû"
   aujourd'hui, elle devient un encaissement séparé quand libérée. */

/* Statut de la garantie d'un document :
   - 'aucune'      : pas de retenue garantie sur ce doc
   - 'annulee'     : doc annulé
   - 'liberee'     : garantie déjà encaissée / restituée
   - 'en_attente'  : garantie retenue, pas encore libérée */
function getGarantieStatut(doc) {
  try {
    if (!doc || typeof doc !== 'object') return 'aucune';
    if (doc.statut === 'annulee' || doc.annulee === true) return 'annulee';
    if (doc.type && doc.type !== 'facture') return 'aucune';
    var g = getGarantieEnAttente(doc);
    if (g <= 0.001) return 'aucune';
    if (doc.garantieLiberee === true) return 'liberee';
    return 'en_attente';
  } catch (e) {
    console.warn('getGarantieStatut :', e);
    return 'aucune';
  }
}

/* Reste à percevoir TOUT COMPRIS sur un doc :
   - le reste classique (netAPayer − paiements)
   - + la garantie encore en attente
   Quand la garantie est libérée, elle sort de ce total.
   Une fois tout payé + garantie libérée → 0. */
function getResteTotalAvecGarantie(doc) {
  try {
    if (!doc) return 0;
    var reste = getResteAPayer(doc);
    var statut = getGarantieStatut(doc);
    if (statut === 'en_attente') {
      reste += getGarantieEnAttente(doc);
    }
    return Math.round(reste * 1000) / 1000;
  } catch (e) {
    console.warn('getResteTotalAvecGarantie :', e);
    return 0;
  }
}

/* Libère la garantie : ajoute un paiement de type 'liberation_garantie'
   et marque le doc comme libéré. Refuse si :
   - doc introuvable / pas une facture
   - pas de garantie en attente
   - garantie déjà libérée
   - doc annulé
   - montant invalide ou > garantie restante
   Retourne { ok: true, montant, doc } ou { ok: false, error }. */
function libererGarantie(docId, options) {
  try {
    if (!docId || !Array.isArray(savedDocuments)) {
      return { ok: false, error: 'Document introuvable' };
    }
    var doc = null;
    for (var i = 0; i < savedDocuments.length; i++) {
      if (savedDocuments[i] && String(savedDocuments[i].id) === String(docId)) {
        doc = savedDocuments[i];
        break;
      }
    }
    if (!doc) return { ok: false, error: 'Document introuvable' };

    var statut = getGarantieStatut(doc);
    if (statut === 'aucune') return { ok: false, error: 'Aucune garantie sur ce document' };
    if (statut === 'annulee') return { ok: false, error: 'Document annulé' };
    if (statut === 'liberee') return { ok: false, error: 'Garantie déjà libérée' };

    var garantieMax = getGarantieEnAttente(doc);
    var opts = options || {};
    var montant = parseNumber(opts.montant);
    if (!(montant > 0)) return { ok: false, error: 'Montant > 0 requis' };
    if (montant > garantieMax + 0.01) {
      return { ok: false, error: 'Montant > garantie en attente (' + formatMoney(garantieMax) + ')' };
    }

    var date = String(opts.date || '').slice(0, 10);
    if (!isValidDateString(date)) date = todayISO();
    var mode = String(opts.mode || 'virement').toLowerCase();
    var note = String(opts.note || '').trim();

    if (!Array.isArray(doc.paiements)) doc.paiements = [];
    doc.paiements.push({
      date: date,
      montant: montant,
      mode: mode,
      note: note || 'Libération garantie',
      type: 'liberation_garantie',
      addedAt: new Date().toISOString()
    });

    /* Si le montant libéré = garantie totale → flag libérée.
       Sinon (libération partielle) on laisse en attente (flag false). */
    if (montant >= garantieMax - 0.001) {
      doc.garantieLiberee = true;
      doc.dateLiberation = date;
    } else {
      doc.garantieLiberee = false;
    }

    doc.updatedAt = new Date().toISOString();

    if (typeof saveAll === 'function') saveAll();
    if (typeof invalidateClientStatsCache === 'function') {
      try { invalidateClientStatsCache(doc.clientId); } catch (e) {}
    }
    if (typeof logAction === 'function') {
      logAction('garantie.liberation', doc.numero + ' ' + formatMoney(montant));
    }

    return { ok: true, montant: montant, doc: doc };
  } catch (e) {
    console.warn('libererGarantie :', e);
    return { ok: false, error: 'Erreur : ' + (e.message || '') };
  }
}
/* ═══════════ v6.9.6 — SIGNATURE & CACHET PAR DÉFAUT ═══════════
   Une seule signature + un seul cachet, stockés en IDB (pas de quota).
   Métadonnées en localStorage (léger), blob binaire en IndexedDB. */

var VOLTCORE_SIG_DEFAULT_REF = 'sig_default';
var VOLTCORE_CACHET_DEFAULT_REF = 'cachet_default';

/* Lit les métadonnées de la signature par défaut.
   Retourne { ref, name, mime, size, uploadedAt } ou null. */
function getSignatureDefault() {
  try {
    var raw = localStorage.getItem(STORAGE_KEYS.signatureDefault);
    if (!raw) return null;
    var meta = JSON.parse(raw);
    if (!meta || typeof meta !== 'object' || !meta.ref) return null;
    return meta;
  } catch (e) { return null; }
}

function getCachetDefault() {
  try {
    var raw = localStorage.getItem(STORAGE_KEYS.cachetDefault);
    if (!raw) return null;
    var meta = JSON.parse(raw);
    if (!meta || typeof meta !== 'object' || !meta.ref) return null;
    return meta;
  } catch (e) { return null; }
}

/* Enregistre une nouvelle signature par défaut (écrase l'ancienne).
   - blob : Blob image
   - name : nom affiché
   Retourne Promise<{ ok, ref, name, size }>. */
function setSignatureDefault(blob, name) {
  return new Promise(function (resolve, reject) {
    try {
      if (!blob) return reject(new Error('Image requise'));
      if (blob.size > 500 * 1024) return reject(new Error('Image trop lourde (> 500 Ko après compression)'));
      _idbBlobsPut(VOLTCORE_SIG_DEFAULT_REF, blob, blob.type || 'image/png').then(function () {
        var meta = {
          ref: VOLTCORE_SIG_DEFAULT_REF,
          name: String(name || 'Signature'),
          mime: blob.type || 'image/png',
          size: blob.size,
          uploadedAt: new Date().toISOString()
        };
        localStorage.setItem(STORAGE_KEYS.signatureDefault, JSON.stringify(meta));
        if (typeof logAction === 'function') {
          try { logAction('settings.signature', meta.name); } catch (e) {}
        }
        resolve({ ok: true, ref: meta.ref, name: meta.name, size: meta.size });
      }).catch(reject);
    } catch (e) { reject(e); }
  });
}

function setCachetDefault(blob, name) {
  return new Promise(function (resolve, reject) {
    try {
      if (!blob) return reject(new Error('Image requise'));
      if (blob.size > 500 * 1024) return reject(new Error('Image trop lourde (> 500 Ko après compression)'));
      _idbBlobsPut(VOLTCORE_CACHET_DEFAULT_REF, blob, blob.type || 'image/png').then(function () {
        var meta = {
          ref: VOLTCORE_CACHET_DEFAULT_REF,
          name: String(name || 'Cachet'),
          mime: blob.type || 'image/png',
          size: blob.size,
          uploadedAt: new Date().toISOString()
        };
        localStorage.setItem(STORAGE_KEYS.cachetDefault, JSON.stringify(meta));
        if (typeof logAction === 'function') {
          try { logAction('settings.cachet', meta.name); } catch (e) {}
        }
        resolve({ ok: true, ref: meta.ref, name: meta.name, size: meta.size });
      }).catch(reject);
    } catch (e) { reject(e); }
  });
}

function deleteSignatureDefault() {
  return new Promise(function (resolve) {
    try { localStorage.removeItem(STORAGE_KEYS.signatureDefault); } catch (e) {}
    if (typeof _idbBlobsDelete === 'function') {
      _idbBlobsDelete(VOLTCORE_SIG_DEFAULT_REF).catch(function () {}).then(function () {
        resolve(true);
      });
    } else {
      resolve(true);
    }
  });
}

function deleteCachetDefault() {
  return new Promise(function (resolve) {
    try { localStorage.removeItem(STORAGE_KEYS.cachetDefault); } catch (e) {}
    if (typeof _idbBlobsDelete === 'function') {
      _idbBlobsDelete(VOLTCORE_CACHET_DEFAULT_REF).catch(function () {}).then(function () {
        resolve(true);
      });
    } else {
      resolve(true);
    }
  });
}

/* Charge les dataURL de la signature et du cachet par défaut.
   Retourne Promise<{ signatureDataUrl, cachetDataUrl }>.
   Valeurs null si non configurés ou si IDB échoue (jamais throw). */
function _loadDefaultSignatureCachetImages() {
  return new Promise(function (resolve) {
    var out = { signatureDataUrl: null, cachetDataUrl: null };
    try {
      var sigMeta = getSignatureDefault();
      var cacMeta = getCachetDefault();
      var pending = 0;

      function checkDone() {
        if (pending <= 0) resolve(out);
      }

      if (sigMeta && sigMeta.ref) {
        pending++;
        _idbBlobsGet(sigMeta.ref).then(function (row) {
          if (row && row.data) {
            return _blobToDataURL(row.data).then(function (d) {
              out.signatureDataUrl = d;
              pending--;
              checkDone();
            }).catch(function () { pending--; checkDone(); });
          }
          pending--; checkDone();
        }).catch(function () { pending--; checkDone(); });
      }

      if (cacMeta && cacMeta.ref) {
        pending++;
        _idbBlobsGet(cacMeta.ref).then(function (row) {
          if (row && row.data) {
            return _blobToDataURL(row.data).then(function (d) {
              out.cachetDataUrl = d;
              pending--;
              checkDone();
            }).catch(function () { pending--; checkDone(); });
          }
          pending--; checkDone();
        }).catch(function () { pending--; checkDone(); });
      }

      if (pending === 0) resolve(out);
    } catch (e) {
      console.warn('_loadDefaultSignatureCachetImages :', e);
      resolve(out);
    }
  });
}
/* ═══════════ v6.9.9 — FILE SYSTEM ACCESS API (dossier local) ═══════════
   Permet à l'utilisateur de choisir un dossier local (Chrome/Edge PC).
   Les nouveaux documents y sont copiés en plus d'IDB (copie miroir).
   Le handle est stocké dans IndexedDB (structured clone, pas localStorage).
   API dispo : Chrome 86+, Edge 86+. Non dispo : Firefox, Safari, mobile. */

var VOLTCORE_FS_HANDLE_ID = 'documents_dir';

function isFileSystemSupported() {
  try {
    return typeof window !== 'undefined' &&
           typeof window.showDirectoryPicker === 'function';
  } catch (e) { return false; }
}

/* Sauvegarde le handle du dossier dans IDB (structured clone). */
function _fsSaveHandle(handle) {
  return new Promise(function (resolve, reject) {
    try {
      if (!handle) return reject(new Error('handle requis'));
      _idbOpen().then(function (db) {
        var tx, store, req;
        try {
          tx = db.transaction('fsHandles', 'readwrite');
          store = tx.objectStore('fsHandles');
          req = store.put({
            id: VOLTCORE_FS_HANDLE_ID,
            handle: handle,
            name: String(handle.name || 'documents'),
            savedAt: new Date().toISOString()
          });
        } catch (e) {
          db.close();
          return reject(e);
        }
        req.onsuccess = function () { db.close(); resolve(true); };
        req.onerror = function () { db.close(); reject(req.error || new Error('saveHandle échoué')); };
      }).catch(reject);
    } catch (e) { reject(e); }
  });
}

/* Récupère le handle sauvegardé (null si absent). */
function _fsGetHandle() {
  return new Promise(function (resolve) {
    try {
      if (!isFileSystemSupported()) return resolve(null);
      _idbOpen().then(function (db) {
        var tx, store, req;
        try {
          tx = db.transaction('fsHandles', 'readonly');
          store = tx.objectStore('fsHandles');
          req = store.get(VOLTCORE_FS_HANDLE_ID);
        } catch (e) {
          db.close();
          return resolve(null);
        }
        req.onsuccess = function () {
          db.close();
          resolve(req.result ? req.result.handle : null);
        };
        req.onerror = function () { db.close(); resolve(null); };
      }).catch(function () { resolve(null); });
    } catch (e) { resolve(null); }
  });
}

/* Supprime le handle sauvegardé (déconnexion du dossier). */
function _fsClearHandle() {
  return new Promise(function (resolve) {
    try {
      _idbOpen().then(function (db) {
        var tx, store, req;
        try {
          tx = db.transaction('fsHandles', 'readwrite');
          store = tx.objectStore('fsHandles');
          req = store.delete(VOLTCORE_FS_HANDLE_ID);
        } catch (e) {
          db.close();
          return resolve(false);
        }
        req.onsuccess = function () { db.close(); resolve(true); };
        req.onerror = function () { db.close(); resolve(false); };
      }).catch(function () { resolve(false); });
    } catch (e) { resolve(false); }
  });
}

/* Vérifie la permission. Si 'prompt', demande à l'utilisateur.
   Retourne Promise<boolean>. */
function _fsVerifyPermission(handle, requestIfNeeded) {
  return new Promise(function (resolve) {
    try {
      if (!handle) return resolve(false);
      var opts = { mode: 'readwrite' };
      if (typeof handle.queryPermission === 'function') {
        handle.queryPermission(opts).then(function (perm) {
          if (perm === 'granted') return resolve(true);
          if (!requestIfNeeded) return resolve(false);
          if (typeof handle.requestPermission === 'function') {
            handle.requestPermission(opts).then(function (p2) {
              resolve(p2 === 'granted');
            }).catch(function () { resolve(false); });
          } else {
            resolve(false);
          }
        }).catch(function () { resolve(false); });
      } else {
        /* API ancienne : requestPermission direct */
        if (requestIfNeeded && typeof handle.requestPermission === 'function') {
          handle.requestPermission(opts).then(function (p) {
            resolve(p === 'granted');
          }).catch(function () { resolve(false); });
        } else {
          resolve(false);
        }
      }
    } catch (e) { resolve(false); }
  });
}

/* Écrit un fichier dans le dossier sous year/month/filename.
   Crée les sous-dossiers au besoin.
   Retourne Promise<{ ok, relativePath }>. */
function _fsWriteFile(handle, filename, blob) {
  return new Promise(function (resolve, reject) {
    try {
      if (!handle || !filename || !blob) return reject(new Error('handle/filename/blob requis'));
      var now = new Date();
      var year = String(now.getFullYear());
      var month = String(now.getMonth() + 1).padStart(2, '0');

      handle.getDirectoryHandle(year, { create: true }).then(function (yearDir) {
        return yearDir.getDirectoryHandle(month, { create: true });
      }).then(function (monthDir) {
        return monthDir.getFileHandle(filename, { create: true });
      }).then(function (fileHandle) {
        return fileHandle.createWritable();
      }).then(function (writable) {
        return writable.write(blob).then(function () {
          return writable.close();
        }).then(function () {
          resolve({ ok: true, relativePath: year + '/' + month + '/' + filename });
        });
      }).catch(reject);
    } catch (e) { reject(e); }
  });
}

/* Scan récursif du dossier (max 2 niveaux year/month).
   Retourne Promise<Array<{ path, name, size, file }>>.
   `file` = File object (peut être lu pour import). */
function _fsScanDir(handle, maxDepth) {
  return new Promise(function (resolve) {
    var depth = (typeof maxDepth === 'number') ? maxDepth : 2;
    var out = [];
    var extAccepted = ['.jpg', '.jpeg', '.png', '.webp', '.pdf'];

    function isAccepted(name) {
      var lower = String(name || '').toLowerCase();
      for (var i = 0; i < extAccepted.length; i++) {
        if (lower.slice(-extAccepted[i].length) === extAccepted[i]) return true;
      }
      return false;
    }

    function walk(dirHandle, currentDepth, pathPrefix) {
      return new Promise(function (resolveWalk) {
        var tasks = [];
        (async function () {
          try {
            for await (const entry of dirHandle.values()) {
              if (entry.kind === 'file') {
                if (!isAccepted(entry.name)) continue;
                tasks.push((function (fileEntry, relPath) {
                  return fileEntry.getFile().then(function (f) {
                    out.push({
                      path: relPath + fileEntry.name,
                      name: fileEntry.name,
                      size: f.size,
                      file: f
                    });
                  }).catch(function () {});
                })(entry, pathPrefix));
              } else if (entry.kind === 'directory' && currentDepth < depth) {
                tasks.push(walk(entry, currentDepth + 1, pathPrefix + entry.name + '/'));
              }
            }
            await Promise.all(tasks);
            resolveWalk();
          } catch (e) {
            resolveWalk();
          }
        })();
      });
    }

    walk(handle, 0, '').then(function () { resolve(out); });
  });
}

console.log('✅ 04-storage.js chargé — v6.9.9 (fsHandles + copie miroir dossier local)');