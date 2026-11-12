/* ═══════════════════════════════════════════════════════════
   VOLTCORE — 27-migrate.js
   VERSION : v7.0.0
   RÔLE : Migration de schéma inter-versions + compatibilité
          avec les anciens formats (BASE_BLINDE_2026, article.json).
   DÉPENDANCES : 00-core, 01-utils, 02-store
   ORDRE : 28ᵉ fichier chargé (APRÈS Store, AVANT 28-backup)

   ARCHITECTURE :
   - upgradeItem(name, item)   → appelée par Store.loadArray par item
                                  (idempotent, simple field renames)
   - upgradeIfNeeded()         → appelée par 30-boot.js après loadAll
                                  (résolutions cross-refs, dédup)
   - fromLegacy(payload)       → appelée par 28-backup.js avant import
                                  (convertit BASE_BLINDE / article.json)
   - detectLegacyFormat()      → détecte si un payload est legacy

   FIX v7.0.0 :
   - C38 : BASE_BLINDE_2026 converti (designation→nom, dateEmission→date,
     clientNom→clientId/_clientNomOrphelin, fournisseurNom→fournisseur,
     lignes→lines, prixUnitaireHT→prixUnitaire, totalTTCDeclare→totalTTC)
   - C39 : article.json familles[] en strings → objects {id, nom}
   - items[].qte → items[].quantite, items[].pu → items[].prix
   - RÉTROCOMPAT : tous les champs inconnus préservés
   - Idempotent : re-exécutable sans corruption

   RÈGLES :
   - ES5 strict
   - Aucun catch silencieux
   - Ne JAMAIS supprimer un champ inconnu
   - Ne JAMAIS throw : en cas d'erreur, retourne l'item tel quel
   ═══════════════════════════════════════════════════════════ */

'use strict';

(function (global) {

  if (!global.VOLTCORE || !global.VOLTCORE.Store || !global.VOLTCORE.Utils) {
    throw new Error('[27-migrate] Modules requis non chargés');
  }

  var VC = global.VOLTCORE;
  var U = VC.Utils;
  var S = VC.Store;
  var M = VC.Migrate || {};
  VC.Migrate = M;

  /* ═══════════════════════════════════════════════════════════
     SECTION 1 — HELPERS
     ═══════════════════════════════════════════════════════════ */

  function _shallowCopy(obj) {
    var out = {};
    if (!obj || typeof obj !== 'object') return out;
    var keys = Object.keys(obj);
    for (var i = 0; i < keys.length; i++) {
      out[keys[i]] = obj[keys[i]];
    }
    return out;
  }

  function _num(v) {
    return U.parseNumber(v);
  }

  function _str(v) {
    return v == null ? '' : String(v);
  }

  /**
   * Convertit une condition texte ("30j", "45j", "reception")
   * en nombre de jours (delaiPaiement).
   */
  function _conditionsToDelai(cond) {
    var c = String(cond || '').toLowerCase().trim();
    if (!c) return 0;
    if (c === 'reception' || c === 'comptant' || c === 'immediat') return 0;

    var m = c.match(/^(\d+)\s*(j|jours?)?$/);
    if (m) {
      var n = parseInt(m[1], 10);
      if (isFinite(n) && n >= 0 && n <= 365) return n;
    }
    return 0;
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 2 — MIGRATION PAR ITEM (appelée par Store par load)
     ═══════════════════════════════════════════════════════════ */

  /**
   * Migre un item isolé. Ne fait QUE des renames simples et des
   * coercions de type. Ne résout PAS les références croisées
   * (impossible sans accès aux autres collections).
   *
   * Doit être IDEMPOTENTE : running twice = same result.
   *
   * @param name {string} collection name
   * @param rawItem {object}
   * @returns object (nouveau, l'original n'est pas muté)
   */
  M.upgradeItem = function (name, rawItem) {
    try {
      /* FIX R1 : familles en string (legacy article.json) doivent être
         converties AVANT le check typeof (sinon drop par normalize). */
      if (name === 'familles' && typeof rawItem === 'string') {
        return { nom: rawItem, couleur: '#0b3d91' };
      }

      if (!rawItem || typeof rawItem !== 'object') return rawItem;

      var item = _shallowCopy(rawItem);

      switch (name) {
        case 'articles':         return _upgradeArticle(item);
        case 'clients':          return _upgradeClient(item);
        case 'suppliers':        return _upgradeSupplier(item);
        case 'documents':        return _upgradeDocument(item);
        case 'purchaseInvoices': return _upgradePurchase(item);
        case 'chantiers':        return _upgradeChantier(item);
        case 'frais':            return _upgradeFrais(item);
        case 'hrEmployees':      return _upgradeEmployee(item);
        case 'hrWorkEntries':    return _upgradeWorkEntry(item);
        case 'hrTransactions':   return _upgradeTx(item);
        case 'bonsRoute':        return _upgradeBonRoute(item);
        case 'familles':         return _upgradeFamille(item);
        default:                 return item;
      }
    } catch (e) {
      VC.logError('27-migrate', 'upgradeItem(' + name + ') échoué', e);
      return rawItem;
    }
  };

  /* ── ARTICLES ── */
  function _upgradeArticle(item) {
    /* designation → nom */
    if (!item.nom && item.designation) {
      item.nom = _str(item.designation);
    }
    /* pu → prix (legacy article.json) */
    if (item.prix == null && item.pu != null) {
      item.prix = _num(item.pu);
    }
    /* statut: 'actif' → actif: true */
    if (typeof item.statut === 'string') {
      var s = item.statut.toLowerCase();
      if (s === 'actif' || s === 'active') item.actif = true;
      else if (s === 'inactif' || s === 'inactive') item.actif = false;
      delete item.statut;
    }
    /* prixVente → prix */
    if (item.prix == null && item.prixVente != null) {
      item.prix = _num(item.prixVente);
    }
    /* purchasePrice → prixAchat */
    if (item.prixAchat == null && item.purchasePrice != null) {
      item.prixAchat = _num(item.purchasePrice);
    }
    /* isHS/horsStock → hs */
    if (item.hs == null) {
      if (item.isHS === true || item.horsStock === true) item.hs = true;
      else if (item.isHS === false || item.horsStock === false) item.hs = false;
    }
    return item;
  }

  /* ── CLIENTS ── */
  function _upgradeClient(item) {
    /* matricule → mf */
    if (!item.mf && item.matricule) {
      item.mf = _str(item.matricule);
    }
    /* conditions → delaiPaiement */
    if ((item.delaiPaiement == null || item.delaiPaiement === '')
        && item.conditions != null) {
      item.delaiPaiement = _conditionsToDelai(item.conditions);
    }
    /* Délai numérique garantit */
    if (item.delaiPaiement != null) {
      item.delaiPaiement = U.clampInt(item.delaiPaiement, 0, 365, 0);
    }
    return item;
  }

  /* ── SUPPLIERS ── */
  function _upgradeSupplier(item) {
    if (!item.mf && item.matricule) {
      item.mf = _str(item.matricule);
    }
    /* specialite → notes (si notes absent) */
    if (!item.notes && item.specialite) {
      item.notes = _str(item.specialite);
    }
    return item;
  }

  /* ── DOCUMENTS ── */
  function _upgradeDocument(item) {
    /* dateEmission → date */
    if (!item.date && item.dateEmission) {
      item.date = String(item.dateEmission).slice(0, 10);
    }
    /* dateEcheance : conserver tel quel (pas dans le schéma v7 mais utile) */

    /* clientNom orphelin (si pas de clientId) */
    if (!item.clientId && item.clientNom) {
      item._clientNomOrphelin = _str(item.clientNom);
    }
    if (!item.clientId && item.clientMF && !item._clientMFOrphelin) {
      item._clientMFOrphelin = _str(item.clientMF);
    }
    if (!item.clientId && item.clientAdresse && !item._clientAdresseOrphelin) {
      item._clientAdresseOrphelin = _str(item.clientAdresse);
    }

    /* chantierReference → chantierId (peut être un id direct) */
    if (!item.chantierId && item.chantierReference) {
      item.chantierId = _str(item.chantierReference);
    }

    /* items : migre chaque ligne */
    if (Array.isArray(item.items)) {
      var newItems = [];
      for (var i = 0; i < item.items.length; i++) {
        newItems.push(_upgradeDocumentItem(item.items[i]));
      }
      item.items = newItems;
    }

    /* totals : s'assure que totals.total existe */
    if (item.totals && typeof item.totals === 'object') {
      if (item.totals.total == null && item.totals.totalTTC != null) {
        item.totals.total = _num(item.totals.totalTTC);
      }
    }

    /* statut legacy : emise/brouillon restent compatibles */
    return item;
  }

  function _upgradeDocumentItem(it) {
    if (!it || typeof it !== 'object') return it;
    var out = _shallowCopy(it);

    /* qte → quantite */
    if (out.quantite == null && out.qte != null) {
      out.quantite = _num(out.qte);
    }
    /* pu → prix */
    if (out.prix == null && out.pu != null) {
      out.prix = _num(out.pu);
    }
    /* remise garantie */
    if (out.remise == null) out.remise = 0;

    return out;
  }

  /* ── PURCHASES ── */
  function _upgradePurchase(item) {
    /* fournisseurNom → fournisseur + fournisseurId si possible */
    if (!item.fournisseur && item.fournisseurNom) {
      item.fournisseur = _str(item.fournisseurNom);
    }

    /* lignes → lines */
    if (!Array.isArray(item.lines) && Array.isArray(item.lignes)) {
      var newLines = [];
      for (var i = 0; i < item.lignes.length; i++) {
        var l = item.lignes[i];
        if (!l || typeof l !== 'object') continue;
        var copy = _shallowCopy(l);

        /* prixUnitaireHT → prixUnitaire */
        if (copy.prixUnitaire == null && copy.prixUnitaireHT != null) {
          copy.prixUnitaire = _num(copy.prixUnitaireHT);
        }
        /* articleComparable → articleId */
        if (!copy.articleId && copy.articleComparable) {
          copy.articleId = _str(copy.articleComparable);
        }
        /* tvaTaux → tvaRate (info) */
        newLines.push(copy);
      }
      item.lines = newLines;
    }

    /* totals déclarés → totals standard */
    if (item.totalTTC == null && item.totalTTCDeclare != null) {
      item.totalTTC = _num(item.totalTTCDeclare);
    }
    if (item.totalTTC == null && item.total != null) {
      item.totalTTC = _num(item.total);
    }
    /* Recalcule total si possible */
    if (item.totals == null && Array.isArray(item.lines)) {
      /* Sera recalculé par computePurchaseTotals si nécessaire */
      item.total = item.totalTTC;
    }

    /* date : compatibilité */
    if (!item.date && item.dateFacture) {
      item.date = String(item.dateFacture).slice(0, 10);
    }

    return item;
  }

  /* ── CHANTIERS ── */
  function _upgradeChantier(item) {
    /* dateDebut / dateFin déjà compatibles */
    if (item.date_debut && !item.dateDebut) {
      item.dateDebut = String(item.date_debut).slice(0, 10);
    }
    if (item.date_fin && !item.dateFin) {
      item.dateFin = String(item.date_fin).slice(0, 10);
    }
    return item;
  }

  /* ── FRAIS ── */
  function _upgradeFrais(item) {
    /* Généralement compatible */
    if (item.montant != null) item.montant = _num(item.montant);
    return item;
  }

  /* ── HR ── */
  function _upgradeEmployee(item) {
    /* tauxHoraire → hourlyRate */
    if (item.hourlyRate == null && item.tauxHoraire != null) {
      item.hourlyRate = _num(item.tauxHoraire);
    }
    if (item.date_embauche && !item.dateEmbauche) {
      item.dateEmbauche = String(item.date_embauche).slice(0, 10);
    }
    return item;
  }

  function _upgradeWorkEntry(item) {
    /* heures → hours */
    if (item.hours == null && item.heures != null) {
      item.hours = _num(item.heures);
    }
    return item;
  }

  function _upgradeTx(item) {
    /* Compatible */
    if (item.montant != null) item.montant = _num(item.montant);
    return item;
  }

  /* ── BONS ROUTE ── */
  function _upgradeBonRoute(item) {
    /* Compatible, mais on s'assure que les tableaux existent */
    if (!Array.isArray(item.materiel)) item.materiel = [];
    if (!Array.isArray(item.documents)) item.documents = [];
    return item;
  }

  /* ── FAMILLES ── */
  function _upgradeFamille(item) {
    /* Une famille legacy est parfois une string */
    if (typeof item === 'string') {
      return { nom: item, couleur: '#0b3d91' };
    }
    return item;
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 3 — MIGRATION PAR COLLECTION (post-loadAll)
     ═══════════════════════════════════════════════════════════ */

  /**
   * Appelée UNE FOIS après loadAll. Résout les références croisées
   * impossibles à faire par item.
   */
  M.upgradeIfNeeded = function () {
    var report = {
      documentsClientResolved: 0,
      documentsChantierResolved: 0,
      articlesDesignationFilled: 0,
      purchasesSupplierResolved: 0,
      famillesNormalized: 0
    };

    try {
      /* ── Documents : résoudre _clientNomOrphelin → clientId ── */
      report.documentsClientResolved = _resolveDocumentClients();

      /* ── Documents : résoudre chantierReference orphelin ── */
      report.documentsChantierResolved = _resolveDocumentChantiers();

      /* ── Articles : nom depuis designation (si upgradeItem a échoué) ── */
      report.articlesDesignationFilled = _fillArticleNoms();

      /* ── Purchases : fournisseur (texte) → supplierId ── */
      report.purchasesSupplierResolved = _resolvePurchaseSuppliers();

      /* ── Familles : strings → objects ── */
      report.famillesNormalized = _normalizeFamilles();

    } catch (e) {
      VC.logError('27-migrate', 'upgradeIfNeeded échoué', e);
    }

    var total = report.documentsClientResolved + report.documentsChantierResolved
      + report.articlesDesignationFilled + report.purchasesSupplierResolved
      + report.famillesNormalized;

    if (total > 0) {
      VC.logInfo('27-migrate', 'Migration post-load : ' + total +
        ' correction(s)', report);
      try { S.saveAll(); } catch (e) {
        VC.logError('27-migrate', 'saveAll post-migrate échoué', e);
      }
    }

    return report;
  };

  function _resolveDocumentClients() {
    var count = 0;
    var docs = S.getAll('documents');
    var clients = S.getAll('clients');

    /* Index par nom normalisé */
    var byName = {};
    for (var i = 0; i < clients.length; i++) {
      if (clients[i] && clients[i].nom) {
        byName[U.normalizeText(clients[i].nom)] = clients[i].id;
      }
    }

    for (var j = 0; j < docs.length; j++) {
      var d = docs[j];
      if (!d || d.clientId) continue;
      if (!d._clientNomOrphelin) continue;

      var key = U.normalizeText(d._clientNomOrphelin);
      if (byName[key]) {
        d.clientId = byName[key];
        count++;
      }
    }

    if (count > 0) S.saveAll();
    return count;
  }

  function _resolveDocumentChantiers() {
    var count = 0;
    var docs = S.getAll('documents');
    var chantiers = S.getAll('chantiers');

    var byName = {};
    for (var i = 0; i < chantiers.length; i++) {
      if (chantiers[i] && chantiers[i].nom) {
        byName[U.normalizeText(chantiers[i].nom)] = chantiers[i].id;
      }
    }

    for (var j = 0; j < docs.length; j++) {
      var d = docs[j];
      if (!d || !d.chantierId) continue;
      if (d.chantierId.indexOf('ch_') === 0) continue; /* déjà un ID */
      if (d.chantierId.indexOf('CH-') === 0) continue; /* déjà un ID */

      var key = U.normalizeText(d.chantierId);
      if (byName[key]) {
        d.chantierId = byName[key];
        count++;
      }
    }

    if (count > 0) S.saveAll();
    return count;
  }

  function _fillArticleNoms() {
    var count = 0;
    var articles = S.getAll('articles');

    for (var i = 0; i < articles.length; i++) {
      var a = articles[i];
      if (!a || a.nom) continue;
      if (a.designation) {
        a.nom = String(a.designation);
        count++;
      }
    }

    if (count > 0) S.saveAll();
    return count;
  }

  function _resolvePurchaseSuppliers() {
    var count = 0;
    var purchases = S.getAll('purchaseInvoices');
    var suppliers = S.getAll('suppliers');

    var byName = {};
    for (var i = 0; i < suppliers.length; i++) {
      if (suppliers[i] && suppliers[i].nom) {
        byName[U.normalizeText(suppliers[i].nom)] = suppliers[i].id;
      }
    }

    for (var j = 0; j < purchases.length; j++) {
      var p = purchases[j];
      if (!p || p.supplierId) continue;
      if (!p.fournisseur) continue;

      var key = U.normalizeText(p.fournisseur);
      if (byName[key]) {
        p.supplierId = byName[key];
        p.fournisseurId = byName[key];
        count++;
      }
    }

    if (count > 0) S.saveAll();
    return count;
  }

  function _normalizeFamilles() {
    var count = 0;
    var familles = S.getAll('familles');

    /* FIX R1 : mutation in-place (sur la référence interne) au lieu de
       construire un nouveau tableau + replaceAll (qui renormalise et
       peut dropper les items invalides). */
    for (var i = familles.length - 1; i >= 0; i--) {
      var f = familles[i];
      if (typeof f === 'string') {
        familles[i] = {
          nom: f,
          couleur: '#0b3d91',
          id: 'fam_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6)
        };
        count++;
      }
    }

    if (count > 0) S.saveAll();
    return count;
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 4 — DÉTECTION LEGACY
     ═══════════════════════════════════════════════════════════ */

  /**
   * Détecte si un payload JSON est au format legacy (BASE_BLINDE
   * ou article.json) plutôt qu'au format v7 natif.
   *
   * @returns { format: 'base_blinde' | 'article_json' | 'v7' | 'unknown' }
   */
  M.detectLegacyFormat = function (payload) {
    if (!payload || typeof payload !== 'object') {
      return 'unknown';
    }

    /* Format v7 natif : backup avec _voltcore_backup ou _version */
    if (payload._voltcore_backup === true) return 'v7';
    if (typeof payload._version === 'string' && payload._version.indexOf('7.') === 0) {
      return 'v7';
    }

    /* BASE_BLINDE : backupVersion + articles avec "designation" */
    if (payload.backupVersion === 7 || payload.backupVersion === 6) {
      var articles = payload.articles;
      if (Array.isArray(articles) && articles.length > 0) {
        var first = articles[0];
        if (first && typeof first === 'object') {
          /* Si designation mais pas nom → BASE_BLINDE-like */
          if (first.designation && !first.nom) return 'base_blinde';
          /* Si pu sans prix → article.json-like */
          if (first.pu != null && first.prix == null && first.designation) {
            return 'base_blinde';
          }
        }
      }
      /* Documents avec dateEmission → BASE_BLINDE */
      if (Array.isArray(payload.documents) && payload.documents.length > 0) {
        var d = payload.documents[0];
        if (d && d.dateEmission && !d.date) return 'base_blinde';
      }
      /* Si on a le bon format v7 mais pas les marqueurs, c'est v7 */
      return 'v7';
    }

    /* article.json : juste "articles" + "familles" en strings */
    if (Array.isArray(payload.articles) && payload.articles.length > 0) {
      var a0 = payload.articles[0];
      if (a0 && a0.designation && !a0.nom) {
        /* Vérifie familles strings */
        if (Array.isArray(payload.familles) &&
            payload.familles.length > 0 &&
            typeof payload.familles[0] === 'string') {
          return 'article_json';
        }
        return 'base_blinde';
      }
    }

    return 'unknown';
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 5 — CONVERSION LEGACY → V7
     ═══════════════════════════════════════════════════════════ */

  /**
   * Convertit un payload legacy en objet standard { clients, articles,
   * documents, suppliers, ... }. Retourne un objet avec les collections
   * prêtes à être importées via S.save/replaceAll.
   *
   * Format retourné : { collections: {name: array}, stats: {...}, warnings: [] }
   */
  M.fromLegacy = function (payload) {
    var result = {
      collections: {},
      stats: {
        clients: 0, articles: 0, suppliers: 0, documents: 0,
        purchases: 0, chantiers: 0, frais: 0, hrEmployees: 0,
        hrWorkEntries: 0, hrTransactions: 0, familles: 0
      },
      warnings: []
    };

    if (!payload || typeof payload !== 'object') {
      result.warnings.push('Payload invalide');
      return result;
    }

    var format = M.detectLegacyFormat(payload);
    VC.logInfo('27-migrate', 'Format détecté : ' + format);

    /* ── Clients ── */
    if (Array.isArray(payload.clients)) {
      var clients = [];
      for (var i = 0; i < payload.clients.length; i++) {
        var c = _upgradeClient(_shallowCopy(payload.clients[i]));
        if (c.nom) clients.push(c);
      }
      result.collections.clients = clients;
      result.stats.clients = clients.length;
    }

    /* ── Suppliers ── */
    if (Array.isArray(payload.suppliers)) {
      var sups = [];
      for (var j = 0; j < payload.suppliers.length; j++) {
        var sp = _upgradeSupplier(_shallowCopy(payload.suppliers[j]));
        if (sp.nom) sups.push(sp);
      }
      result.collections.suppliers = sups;
      result.stats.suppliers = sups.length;
    }

    /* ── Articles ── */
    if (Array.isArray(payload.articles)) {
      var arts = [];
      for (var k = 0; k < payload.articles.length; k++) {
        var a = _upgradeArticle(_shallowCopy(payload.articles[k]));
        if (a.nom) arts.push(a);
      }
      result.collections.articles = arts;
      result.stats.articles = arts.length;
    }

    /* ── Familles ── */
    if (Array.isArray(payload.familles)) {
      var fams = [];
      for (var l = 0; l < payload.familles.length; l++) {
        var f = payload.familles[l];
        if (typeof f === 'string') {
          fams.push({ nom: f, couleur: '#0b3d91' });
        } else if (f && typeof f === 'object' && f.nom) {
          fams.push(f);
        }
      }
      result.collections.familles = fams;
      result.stats.familles = fams.length;
    }

    /* ── Chantiers ── */
    if (Array.isArray(payload.chantiers)) {
      var chs = [];
      for (var m = 0; m < payload.chantiers.length; m++) {
        var ch = _upgradeChantier(_shallowCopy(payload.chantiers[m]));
        if (ch.nom) chs.push(ch);
      }
      result.collections.chantiers = chs;
      result.stats.chantiers = chs.length;
    }

    /* ── Documents ── */
    if (Array.isArray(payload.documents)) {
      var docs = [];
      for (var n = 0; n < payload.documents.length; n++) {
        var d = _upgradeDocument(_shallowCopy(payload.documents[n]));
        if (d.numero || d.date) docs.push(d);
      }
      result.collections.documents = docs;
      result.stats.documents = docs.length;
    }

    /* ── Purchases ── */
    if (Array.isArray(payload.purchaseInvoices)) {
      var purs = [];
      for (var p = 0; p < payload.purchaseInvoices.length; p++) {
        var pu = _upgradePurchase(_shallowCopy(payload.purchaseInvoices[p]));
        if (pu.numero || pu.date) purs.push(pu);
      }
      result.collections.purchaseInvoices = purs;
      result.stats.purchases = purs.length;
    }

    /* ── Frais ── */
    if (Array.isArray(payload.frais)) {
      var fs = [];
      for (var q = 0; q < payload.frais.length; q++) {
        var fr = _upgradeFrais(_shallowCopy(payload.frais[q]));
        if (fr.montant > 0) fs.push(fr);
      }
      result.collections.frais = fs;
      result.stats.frais = fs.length;
    }

    /* ── RH ── */
    if (Array.isArray(payload.hrEmployees)) {
      var emps = [];
      for (var r = 0; r < payload.hrEmployees.length; r++) {
        var emp = _upgradeEmployee(_shallowCopy(payload.hrEmployees[r]));
        if (emp.nom) emps.push(emp);
      }
      result.collections.hrEmployees = emps;
      result.stats.hrEmployees = emps.length;
    }

    if (Array.isArray(payload.hrWorkEntries)) {
      var works = [];
      for (var s = 0; s < payload.hrWorkEntries.length; s++) {
        works.push(_upgradeWorkEntry(_shallowCopy(payload.hrWorkEntries[s])));
      }
      result.collections.hrWorkEntries = works;
      result.stats.hrWorkEntries = works.length;
    }

    if (Array.isArray(payload.hrTransactions)) {
      var txs = [];
      for (var t = 0; t < payload.hrTransactions.length; t++) {
        txs.push(_upgradeTx(_shallowCopy(payload.hrTransactions[t])));
      }
      result.collections.hrTransactions = txs;
      result.stats.hrTransactions = txs.length;
    }

    /* ── Trash : format v7 attendu ── */
    if (payload.trash && typeof payload.trash === 'object') {
      result.collections.trash = payload.trash;
    }

    /* ── Config (rib, banque, mf, logo) ── */
    var config = {};
    if (payload.rib) config.rib = payload.rib;
    if (payload.banque) config.banque = payload.banque;
    if (payload.mf) config.mf = payload.mf;
    if (payload.rne) config.rne = payload.rne;
    if (payload.logo) config.logo = payload.logo;
    if (Object.keys(config).length > 0) {
      result.collections.config = config;
    }

    /* ── Compteurs ── */
    if (payload.compteurs && typeof payload.compteurs === 'object') {
      result.collections.compteurs = payload.compteurs;
    }

    /* ── Warnings ── */
    var docCount = result.stats.documents;
    var purCount = result.stats.purchases;
    if (docCount > 0) {
      result.warnings.push(docCount +
        ' document(s) converti(s) — vérifie que les clients sont bien rattachés.');
    }
    if (purCount > 0) {
      result.warnings.push(purCount +
        ' achat(s) converti(s) — vérifie les fournisseurs.');
    }

    return result;
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 6 — MARQUEUR
     ═══════════════════════════════════════════════════════════ */

  VC._migrateLoaded = true;

  VC.logInfo('27-migrate', 'Module chargé (compat BASE_BLINDE + article.json)');

})(window);