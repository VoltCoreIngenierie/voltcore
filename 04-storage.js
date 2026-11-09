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
  bonDraftA:        'voltcore_bon_draft_A',
  bonDraftB:        'voltcore_bon_draft_B',
  bonDraftC:        'voltcore_bon_draft_C',
  bonDraftD:        'voltcore_bon_draft_D',
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
  idbLastBackup:    'voltcore_idb_last_backup'
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

function incrementerNumeroBon(letter) {
  try {
    var l = String(letter || 'A').toUpperCase();
    var key = 'bon_' + l;
    compteurs[key] = (parseInt(compteurs[key], 10) || 0) + 1;
    saveCompteurs();
    return compteurs[key];
  } catch (e) {
    console.warn('incrementerNumeroBon :', e);
    return 0;
  }
}

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
var VOLTCORE_IDB_VERSION = 1;
var VOLTCORE_IDB_STORE = 'backups';
var VOLTCORE_IDB_KEEP = 7;
var VOLTCORE_IDB_MAX_SIZE = 20 * 1024 * 1024;

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
console.log('✅ 04-storage.js chargé — v6.7 (retenue garantie BTP intégrée, getGarantieEnAttente ajouté)');