/* ═══════════════════════════════════════════════════════════
   VOLTCORE — 04-alerts.js
   VERSION : v7.0.7
   RÔLE : Analyse métier + alertes.
          • VC.Doc : calculs documents (paiements, avoirs, dû)
          • VC.Alerts : marges, alertes, KPIs, badges UI
   DÉPENDANCES : 00-core, 01-utils, 02-store
   ORDRE : 5ᵉ fichier chargé

   RÈGLES :
   - ES5 strict
   - Aucun catch silencieux
   - Lecture collections via Store uniquement (jamais globals)
   - Alertes dédupliquées par ID stable (dismiss/restore)
   ═══════════════════════════════════════════════════════════ */

'use strict';

(function (global) {

  if (!global.VOLTCORE || !global.VOLTCORE.Store || !global.VOLTCORE.Utils) {
    throw new Error('[04-alerts] 00-core, 01-utils, 02-store requis');
  }

  var VC = global.VOLTCORE;
  var U = VC.Utils;
  var S = VC.Store;

  var Doc = VC.Doc || {};
  VC.Doc = Doc;

  var A = VC.Alerts || {};
  VC.Alerts = A;

  /* ═══════════════════════════════════════════════════════════
     SECTION 1 — REGISTRATION STORE
     ═══════════════════════════════════════════════════════════ */

  S.register('dismissedAlerts', {
    type: 'array',
    saveKey: 'voltcore_dismissed_alerts',
    default: [],
    schema: {
      id: 'string|required'
    },
    backup: true
  });

  /* ═══════════════════════════════════════════════════════════
     SECTION 2 — VC.Doc : CALCULS DOCUMENTS
     ═══════════════════════════════════════════════════════════ */

  Doc.getTotalPaye = function (doc) {
    if (!doc || !Array.isArray(doc.paiements)) return 0;
    var total = 0;
    for (var i = 0; i < doc.paiements.length; i++) {
      var p = doc.paiements[i];
      if (p && typeof p.montant === 'number' && isFinite(p.montant)) {
        total += p.montant;
      }
    }
    return total;
  };

  /**
   * Total des avoirs actifs liés à une facture.
   * Recherche par parentFactureId ET par avoirIds inverses.
   */
  Doc.getAvoirTotalForFacture = function (factureId) {
    if (!factureId) return 0;
    var docs = S.getAll('documents');
    var sid = String(factureId);
    var total = 0;

    for (var i = 0; i < docs.length; i++) {
      var d = docs[i];
      if (!d || d.type !== 'avoir') continue;
      if (d.statut === 'annulee' || d.annulee === true) continue;
      if (String(d.parentFactureId || '') !== sid) continue;

      var t = (d.totals && typeof d.totals.total === 'number') ? d.totals.total : 0;
      total += t;
    }
    return total;
  };

  /**
   * Calcule le "dû" d'un document (total − retenues − avoirs).
   * Point unique de calcul. Clampé à 0 minimum.
   */
  Doc.computeDuDoc = function (doc) {
    if (!doc || typeof doc !== 'object') return 0;

    var total = (doc.totals && typeof doc.totals.total === 'number')
      ? doc.totals.total
      : (typeof doc.totalTTC === 'number' ? doc.totalTTC : 0);
    if (!total) return 0;

    var retenue = (typeof doc.retenueMontant === 'number')
      ? doc.retenueMontant
      : (doc.totals && typeof doc.totals.retenueMontant === 'number')
        ? doc.totals.retenueMontant : 0;

    var retenueGarantie = (typeof doc.retenueGarantie === 'number')
      ? doc.retenueGarantie
      : (doc.totals && typeof doc.totals.retenueGarantie === 'number')
        ? doc.totals.retenueGarantie : 0;

    var avoir = Doc.getAvoirTotalForFacture(doc.id);

    var du = total - retenue - retenueGarantie - avoir;
    return du > 0 ? du : 0;
  };

  Doc.getStatutPaiement = function (doc) {
    if (!doc || typeof doc !== 'object') return 'brouillon';
    if (doc.statut === 'annulee' || doc.annulee === true) return 'annulee';
    if (doc.type === 'avoir') return 'avoir';

    var du = Doc.computeDuDoc(doc);
    if (!du) return 'brouillon';

    var paye = Doc.getTotalPaye(doc);
    var reste = du - paye;
    if (reste <= 0.001) return 'payee';
    if (paye > 0.001) return 'partielle';
    return 'impayee';
  };

  Doc.getResteAPayer = function (doc) {
    if (!doc || typeof doc !== 'object') return 0;
    var du = Doc.computeDuDoc(doc);
    var paye = Doc.getTotalPaye(doc);
    var reste = du - paye;
    return reste > 0 ? reste : 0;
  };

  Doc.getNetRevenu = function (doc) {
    if (!doc || typeof doc !== 'object') return 0;

    var total = (doc.totals && typeof doc.totals.total === 'number')
      ? doc.totals.total
      : (typeof doc.totalTTC === 'number' ? doc.totalTTC : 0);

    if (doc.type === 'avoir') {
      return total > 0 ? -total : 0;
    }
    if (doc.type === 'facture' || !doc.type) {
      var avoir = Doc.getAvoirTotalForFacture(doc.id);
      var net = total - avoir;
      return net > 0 ? net : 0;
    }
    return total;
  };

  Doc.getGarantieEnAttente = function (doc) {
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
  };

  Doc.getGarantieStatut = function (doc) {
    if (!doc || typeof doc !== 'object') return 'aucune';
    if (doc.statut === 'annulee' || doc.annulee === true) return 'annulee';
    if (doc.type && doc.type !== 'facture') return 'aucune';

    var g = Doc.getGarantieEnAttente(doc);
    if (g <= 0.001) return 'aucune';
    if (doc.garantieLiberee === true) return 'liberee';
    return 'en_attente';
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 3 — MARGES (chantiers + clients)
     ═══════════════════════════════════════════════════════════ */

  function _isActive(doc) {
    if (!doc) return false;
    if (doc.statut === 'annulee' || doc.annulee === true) return false;
    if (doc.statut === 'brouillon') return false;
    return true;
  }

  function _chantierIdOf(obj) {
    if (!obj) return '';
    return String(obj.chantierId || '').trim();
  }

  /* FIX R5 : cache des marges chantier. Invalidé sur tout changement
     des collections qui influencent le calcul. */
  var _chantierMargeCache = {};

  A._invalidateMargeCache = function () {
    _chantierMargeCache = {};
  };

  (function _watchMargeCacheInvalidation() {
    var watchList = ['documents', 'purchaseInvoices', 'frais',
                     'hrWorkEntries', 'hrEmployees', 'chantiers'];
    for (var i = 0; i < watchList.length; i++) {
      S.subscribe(watchList[i], (function () {
        try { A._invalidateMargeCache(); } catch (e) {
          VC.logError('04-alerts', 'invalidation marge cache échoué', e);
        }
      }));
    }
  })();

  A.computeChantierMarge = function (chantierId) {
    var empty = { recettes: 0, achats: 0, frais: 0, rh: 0, marge: 0, margePct: 0, nbDocs: 0 };
    if (!chantierId) return empty;

    var cid = String(chantierId);

    /* Cache hit */
    if (_chantierMargeCache[cid]) {
      return _chantierMargeCache[cid];
    }
    var docs = S.getAll('documents');
    var purchases = S.getAll('purchaseInvoices');
    var frais = S.getAll('frais');
    var works = S.getAll('hrWorkEntries');
    var emps = S.getAll('hrEmployees');

    var recettes = 0, nbDocs = 0;
    for (var i = 0; i < docs.length; i++) {
      var d = docs[i];
      if (!d || d.type !== 'facture') continue;
      if (_chantierIdOf(d) !== cid) continue;
      if (!_isActive(d)) continue;
      recettes += Doc.getNetRevenu(d);
      nbDocs++;
    }

    var achats = 0;
    for (var j = 0; j < purchases.length; j++) {
      var p = purchases[j];
      if (!p || _chantierIdOf(p) !== cid) continue;
      achats += (typeof p.totalTTC === 'number') ? p.totalTTC
              : (typeof p.total === 'number') ? p.total : 0;
    }

    var fraisTotal = 0;
    for (var k = 0; k < frais.length; k++) {
      var f = frais[k];
      if (!f || _chantierIdOf(f) !== cid) continue;
      fraisTotal += (typeof f.montant === 'number') ? f.montant : U.parseNumber(f.montant);
    }

    var rhTotal = 0;
    var rateById = {};
    for (var e = 0; e < emps.length; e++) {
      if (emps[e] && emps[e].id) {
        rateById[emps[e].id] = U.parseNumber(
          emps[e].hourlyRate != null ? emps[e].hourlyRate : emps[e].tauxHoraire
        );
      }
    }
    for (var w = 0; w < works.length; w++) {
      var we = works[w];
      if (!we || _chantierIdOf(we) !== cid) continue;
      var hrs = U.parseNumber(we.hours != null ? we.hours : we.heures);
      var rate = (we.rate != null) ? U.parseNumber(we.rate)
                                 : (rateById[we.employeeId] || 0);
      rhTotal += hrs * rate;
    }

    var marge = recettes - achats - fraisTotal - rhTotal;
    var margePct = recettes > 0 ? (marge / recettes) : 0;

    var result = {
      recettes: recettes, achats: achats, frais: fraisTotal, rh: rhTotal,
      marge: marge, margePct: margePct, nbDocs: nbDocs
    };

    _chantierMargeCache[cid] = result;
    return result;
  };

  A.computeClientMarge = function (clientId) {
    var empty = { recettes: 0, achats: 0, frais: 0, rh: 0, marge: 0, margePct: 0, nbDocs: 0 };
    if (!clientId) return empty;

    var cid = String(clientId);
    var chantiers = S.getAll('chantiers');
    var docs = S.getAll('documents');
    var purchases = S.getAll('purchaseInvoices');
    var frais = S.getAll('frais');

    var recettes = 0, achats = 0, fraisTot = 0, rh = 0, nbDocs = 0;

    /* Chantiers du client (agrégats) */
    for (var i = 0; i < chantiers.length; i++) {
      var ch = chantiers[i];
      if (!ch || String(ch.clientId || '') !== cid) continue;
      var m = A.computeChantierMarge(ch.id);
      recettes += m.recettes;
      achats += m.achats;
      fraisTot += m.frais;
      rh += m.rh;
      nbDocs += m.nbDocs;
    }

    /* Factures sans chantier (directes) */
    for (var j = 0; j < docs.length; j++) {
      var d = docs[j];
      if (!d || d.type !== 'facture') continue;
      if (String(d.clientId || '') !== cid) continue;
      if (_chantierIdOf(d)) continue;
      if (!_isActive(d)) continue;
      recettes += Doc.getNetRevenu(d);
      nbDocs++;
    }

    /* Achats sans chantier */
    for (var p = 0; p < purchases.length; p++) {
      var pi = purchases[p];
      if (!pi || String(pi.clientId || '') !== cid) continue;
      if (_chantierIdOf(pi)) continue;
      achats += (typeof pi.totalTTC === 'number') ? pi.totalTTC
              : (typeof pi.total === 'number') ? pi.total : 0;
    }

    /* Frais sans chantier */
    for (var f = 0; f < frais.length; f++) {
      var fr = frais[f];
      if (!fr || String(fr.clientId || '') !== cid) continue;
      if (_chantierIdOf(fr)) continue;
      fraisTot += U.parseNumber(fr.montant);
    }

    var marge = recettes - achats - fraisTot - rh;
    var margePct = recettes > 0 ? (marge / recettes) : 0;

    return {
      recettes: recettes, achats: achats, frais: fraisTot, rh: rh,
      marge: marge, margePct: margePct, nbDocs: nbDocs
    };
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 4 — ALERTES ARTICLES + FOURNISSEURS
     ═══════════════════════════════════════════════════════════ */

  function _daysSince(iso) {
    if (!iso) return 0;
    try {
      var s = String(iso).slice(0, 10);
      var d = new Date(s + 'T12:00:00').getTime();
      if (!isFinite(d)) return 0;
      return Math.floor((Date.now() - d) / 86400000);
    } catch (e) {
      VC.logError('04-alerts', '_daysSince échoué', e);
      return 0;
    }
  }

  A.computeArticleAlerts = function () {
    var out = [];
    var articles = S.getAll('articles');
    var ext = S.getObject('externalPrices');
    if (articles.length === 0) return out;

    for (var i = 0; i < articles.length; i++) {
      var art = articles[i];
      if (!art || !art.id) continue;

      var entries = ext[String(art.id)];
      if (!Array.isArray(entries) || entries.length === 0) continue;

      var recent = entries.filter(function (e) {
        return e && _daysSince(e.date) <= 180;
      });
      if (recent.length === 0) continue;

      var minPrix = Infinity, minEntry = null;
      for (var j = 0; j < recent.length; j++) {
        var e = recent[j];
        if (typeof e.prix === 'number' && isFinite(e.prix) && e.prix < minPrix) {
          minPrix = e.prix;
          minEntry = e;
        }
      }
      if (!minEntry) continue;

      var prixActuel = U.parseNumber(art.prixAchat || 0);
      if (prixActuel <= 0) continue;

      if (minPrix < prixActuel * 0.95) {
        out.push({
          id: 'art_' + art.id + '_' + (minEntry.fournisseur || 'x'),
          level: 'warning',
          articleId: art.id,
          articleNom: art.nom || art.designation || art.id,
          message: 'Meilleur prix vu : ' + U.formatMoney(minPrix) +
                   ' chez ' + String(minEntry.fournisseur || '?'),
          valeur: ((prixActuel - minPrix) / prixActuel) * 100
        });
      }
    }
    return out;
  };

  A.computeFournisseurAlerts = function () {
    var out = [];
    var suppliers = S.getAll('suppliers');
    var ext = S.getObject('externalPrices');
    if (suppliers.length === 0) return out;

    /* Prix min par article (parmi tous fournisseurs, <180j) */
    var minParArticle = {};
    var artKeys = Object.keys(ext);
    for (var i = 0; i < artKeys.length; i++) {
      var entries = ext[artKeys[i]];
      if (!Array.isArray(entries)) continue;
      var minP = Infinity;
      for (var j = 0; j < entries.length; j++) {
        var e = entries[j];
        if (!e || typeof e.prix !== 'number' || !isFinite(e.prix)) continue;
        if (_daysSince(e.date) > 180) continue;
        if (e.prix > 0 && e.prix < minP) minP = e.prix;
      }
      if (isFinite(minP) && minP > 0) minParArticle[artKeys[i]] = minP;
    }

    for (var s = 0; s < suppliers.length; s++) {
      var sup = suppliers[s];
      if (!sup || !sup.nom) continue;
      var nomF = String(sup.nom);
      var plusCherCount = 0;

      for (var artId in ext) {
        if (!ext.hasOwnProperty(artId)) continue;
        if (minParArticle[artId] == null) continue;
        var minP2 = minParArticle[artId];
        if (!minP2 || minP2 <= 0) continue;

        var arr = ext[artId];
        if (!Array.isArray(arr)) continue;

        var found = false;
        for (var k = 0; k < arr.length; k++) {
          var ek = arr[k];
          if (!ek || String(ek.fournisseur || '') !== nomF) continue;
          if (_daysSince(ek.date) > 180) continue;
          if (typeof ek.prix !== 'number' || !isFinite(ek.prix)) continue;
          if (ek.prix > minP2 * 1.05) {
            plusCherCount++;
            found = true;
            break;
          }
        }
      }

      if (plusCherCount >= 3) {
        out.push({
          id: 'four_' + (sup.id || nomF) + '_comp',
          level: 'warning',
          fournisseurId: sup.id || null,
          fournisseurNom: nomF,
          message: 'Plus cher que la concurrence sur ' + plusCherCount + ' article(s).',
          valeur: plusCherCount
        });
      }
    }
    return out;
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 5 — ALERTES CLIENTS
     ═══════════════════════════════════════════════════════════ */

  A.computeClientAlerts = function () {
    var out = [];
    var clients = S.getAll('clients');
    var docs = S.getAll('documents');
    if (clients.length === 0) return out;

    /* CA total entreprise (factures actives nettes) */
    var caTotal = 0;
    for (var d = 0; d < docs.length; d++) {
      var doc = docs[d];
      if (!doc || doc.type !== 'facture') continue;
      if (!_isActive(doc)) continue;
      caTotal += Doc.getNetRevenu(doc);
    }

    for (var i = 0; i < clients.length; i++) {
      var cl = clients[i];
      if (!cl || !cl.id) continue;
      var clId = String(cl.id);
      var nom = String(cl.nom || cl.name || cl.id);

      /* Impayés > 30j */
      var impayeTotal = 0, impayeCount = 0;
      for (var k = 0; k < docs.length; k++) {
        var d2 = docs[k];
        if (!d2 || d2.type !== 'facture') continue;
        if (String(d2.clientId || '') !== clId) continue;
        if (!_isActive(d2)) continue;

        var reste = Doc.getResteAPayer(d2);
        if (reste > 0.001) {
          var jours = _daysSince(String(d2.date || '').slice(0, 10));
          if (jours > 30) {
            impayeTotal += reste;
            impayeCount++;
          }
        }
      }
      if (impayeCount > 0) {
        out.push({
          id: 'cli_' + clId + '_impaye',
          level: 'error',
          clientId: clId,
          clientNom: nom,
          message: impayeCount + ' facture(s) impayée(s) > 30j — total ' + U.formatMoney(impayeTotal),
          valeur: impayeTotal
        });
      }

      /* Marge faible < 10% */
      var m = A.computeClientMarge(clId);
      if (m.recettes > 0 && m.margePct < 0.10) {
        out.push({
          id: 'cli_' + clId + '_marge',
          level: 'warning',
          clientId: clId,
          clientNom: nom,
          message: 'Marge faible : ' + (m.margePct * 100).toFixed(1) + '%',
          valeur: m.margePct
        });
      }

      /* Dépendance > 50% du CA */
      if (caTotal > 0 && m.recettes > 0) {
        var part = m.recettes / caTotal;
        if (part > 0.50) {
          out.push({
            id: 'cli_' + clId + '_dep',
            level: 'warning',
            clientId: clId,
            clientNom: nom,
            message: 'Dépendance : ' + (part * 100).toFixed(1) + '% du CA total vient de ce client.',
            valeur: part
          });
        }
      }
    }
    return out;
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 6 — AGRÉGATION + DISMISS
     ═══════════════════════════════════════════════════════════ */

  function _filterDismissed(list) {
    var dismissed = S.getAll('dismissedAlerts');
    var ids = {};
    for (var i = 0; i < dismissed.length; i++) {
      if (dismissed[i] && dismissed[i].id) ids[dismissed[i].id] = true;
    }
    var out = [];
    for (var j = 0; j < list.length; j++) {
      if (list[j] && list[j].id && !ids[list[j].id]) out.push(list[j]);
    }
    return out;
  }

  A.getAllAlerts = function () {
    return {
      articles: _filterDismissed(A.computeArticleAlerts()),
      fournisseurs: _filterDismissed(A.computeFournisseurAlerts()),
      clients: _filterDismissed(A.computeClientAlerts())
    };
  };

  A.getCounts = function () {
    var all = A.getAllAlerts();
    return {
      articles: all.articles.length,
      fournisseurs: all.fournisseurs.length,
      clients: all.clients.length,
      total: all.articles.length + all.fournisseurs.length + all.clients.length
    };
  };

  A.dismiss = function (id) {
    if (!id) return false;
    var dismissed = S.getAll('dismissedAlerts');
    for (var i = 0; i < dismissed.length; i++) {
      if (dismissed[i] && String(dismissed[i].id) === String(id)) return true;
    }
    S.save('dismissedAlerts', { id: String(id) });
    A.renderBadges();
    return true;
  };

  A.restore = function (id) {
    if (!id) return false;
    var dismissed = S.getAll('dismissedAlerts');
    for (var i = 0; i < dismissed.length; i++) {
      if (dismissed[i] && String(dismissed[i].id) === String(id)) {
        S.delete('dismissedAlerts', dismissed[i].id);
        A.renderBadges();
        return true;
      }
    }
    return false;
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 7 — KPIs DASHBOARD
     ═══════════════════════════════════════════════════════════ */

  A.computeDashboardKPIs = function () {
    var kpis = {
      caTotal: 0, caMois: 0, margeTotale: 0, beneficeNet: 0,
      impayes: 0, nbFactures: 0, nbClients: 0, nbChantiers: 0,
      achatsTotal: 0, fraisTotal: 0, rhTotal: 0, nbAlertes: 0,
      garantiesEnAttente: 0, nbGarantiesEnAttente: 0
    };

    var moisPrefix = U.todayISO().slice(0, 7);
    var docs = S.getAll('documents');
    var purchases = S.getAll('purchaseInvoices');
    var frais = S.getAll('frais');
    var works = S.getAll('hrWorkEntries');
    var emps = S.getAll('hrEmployees');
    var clients = S.getAll('clients');
    var chantiers = S.getAll('chantiers');

    for (var i = 0; i < docs.length; i++) {
      var d = docs[i];
      if (!d || d.type !== 'facture') continue;
      if (d.statut === 'annulee' || d.annulee === true) continue;

      var net = Doc.getNetRevenu(d);
      kpis.caTotal += net;
      kpis.nbFactures++;

      var dDate = String(d.date || '').slice(0, 10);
      if (dDate.slice(0, 7) === moisPrefix) kpis.caMois += net;

      var reste = Doc.getResteAPayer(d);
      if (reste > 0.001) kpis.impayes += reste;

      if (Doc.getGarantieStatut(d) === 'en_attente') {
        var g = Doc.getGarantieEnAttente(d);
        if (g > 0.001) {
          kpis.garantiesEnAttente += g;
          kpis.nbGarantiesEnAttente++;
        }
      }
    }

    for (var j = 0; j < purchases.length; j++) {
      var p = purchases[j];
      if (!p) continue;
      kpis.achatsTotal += (typeof p.totalTTC === 'number') ? p.totalTTC
                        : (typeof p.total === 'number') ? p.total : 0;
    }

    for (var k = 0; k < frais.length; k++) {
      if (frais[k]) kpis.fraisTotal += U.parseNumber(frais[k].montant);
    }

    var rateById = {};
    for (var e = 0; e < emps.length; e++) {
      if (emps[e] && emps[e].id) {
        rateById[emps[e].id] = U.parseNumber(
          emps[e].hourlyRate != null ? emps[e].hourlyRate : emps[e].tauxHoraire
        );
      }
    }
    for (var w = 0; w < works.length; w++) {
      var we = works[w];
      if (!we) continue;
      var hrs = U.parseNumber(we.hours != null ? we.hours : we.heures);
      var rate = (we.rate != null) ? U.parseNumber(we.rate)
                                  : (rateById[we.employeeId] || 0);
      kpis.rhTotal += hrs * rate;
    }

    kpis.nbClients = clients.length;
    for (var c = 0; c < chantiers.length; c++) {
      if (chantiers[c] && chantiers[c].statut !== 'annule') kpis.nbChantiers++;
    }

    kpis.nbAlertes = A.getCounts().total;

    kpis.margeTotale = kpis.caTotal - kpis.achatsTotal - kpis.fraisTotal - kpis.rhTotal;
    kpis.beneficeNet = kpis.margeTotale;

    return kpis;
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 8 — BADGES UI
     ═══════════════════════════════════════════════════════════ */

  A.renderBadges = function () {
    var counts = A.getCounts();
    _updateBadge('alertCountArticles', counts.articles);
    _updateBadge('alertCountSuppliers', counts.fournisseurs);
    _updateBadge('alertCountClients', counts.clients);
    _updateBadge('alertCountTotal', counts.total);
  };

  function _updateBadge(id, count) {
    try {
      var el = document.getElementById(id);
      if (!el) return;
      if (count > 0) {
        el.textContent = count > 99 ? '99+' : String(count);
        el.style.display = 'inline-block';
      } else {
        el.textContent = '';
        el.style.display = 'none';
      }
    } catch (e) {
      VC.logError('04-alerts', '_updateBadge(' + id + ') échoué', e);
    }
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 9 — MODALE ALERTES UI
     ═══════════════════════════════════════════════════════════ */

  var _currentTab = 'clients';

  A.openModal = function (tab) {
    _currentTab = tab || 'clients';
    _renderModal();
    U.showFlex('alertsModal');
  };

  A.closeModal = function () {
    U.hide('alertsModal');
  };

  A.switchTab = function (tab) {
    _currentTab = tab || 'clients';
    _renderModal();
  };

  function _renderModal() {
    try {
      var container = document.getElementById('alertsModalBody');
      if (!container) return;

      var all = A.getAllAlerts();
      var list = all[_currentTab] || [];

      var tabs = [
        { key: 'clients', label: 'Clients', count: all.clients.length },
        { key: 'fournisseurs', label: 'Fournisseurs', count: all.fournisseurs.length },
        { key: 'articles', label: 'Articles', count: all.articles.length }
      ];

      var tabsHtml = '';
      for (var t = 0; t < tabs.length; t++) {
        var tb = tabs[t];
        tabsHtml += '<button type="button" class="alerts-tab' +
          (tb.key === _currentTab ? ' active' : '') + '" ' +
          'onclick="VC.Alerts.switchTab(\'' + tb.key + '\')">' +
          U.escapeHtml(tb.label) +
          (tb.count > 0 ? ' <span class="alerts-tab-count">' + tb.count + '</span>' : '') +
          '</button>';
      }

      var listHtml = '';
      if (list.length === 0) {
        listHtml = '<div class="alerts-empty">Aucune alerte. ✅</div>';
      } else {
        for (var i = 0; i < list.length; i++) {
          var a = list[i];
          var levelClass = 'alert-level-' + (a.level || 'info');
          listHtml += '<div class="alert-item ' + levelClass + '">' +
            '<div class="alert-item-body">' +
            '<div class="alert-item-title">' +
            U.escapeHtml(a.clientNom || a.fournisseurNom || a.articleNom || '') +
            '</div>' +
            '<div class="alert-item-msg">' + U.escapeHtml(a.message || '') + '</div>' +
            '</div>' +
            '<div class="alert-item-actions">' +
            '<button type="button" class="btn btn-sm" ' +
            'onclick="VC.Alerts.dismiss(\'' + U.escapeAttr(a.id) + '\')">✓ Vu</button>' +
            '</div>' +
            '</div>';
        }
      }

      container.innerHTML = '<div class="alerts-tabs">' + tabsHtml + '</div>' +
        '<div class="alerts-list">' + listHtml + '</div>';
    } catch (e) {
      VC.logError('04-alerts', '_renderModal échoué', e);
    }
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 10 — MARQUEUR
     ═══════════════════════════════════════════════════════════ */

  /* ═══════════════════════════════════════════════════════════
     SECTION 11 — INVALIDATION AUTO DES BADGES (FIX Bug 7)
     ═══════════════════════════════════════════════════════════
     Chaque collection qui influe sur les alertes déclenche
     A.renderBadges() à chaque mutation. Couvre :
       - clients → computeClientAlerts
       - suppliers → computeFournisseurAlerts
       - articles → computeArticleAlerts
       - documents → computeClientAlerts (impayés + dépendance)
       - purchaseInvoices → computeFournisseurAlerts + marges
       - frais → computeChantierMarge (via clients)
       - hrEmployees / hrWorkEntries → computeChantierMarge
       - externalPrices → computeArticleAlerts + computeFournisseurAlerts
  */

  (function _watchAlertSources() {
    var watchList = [
      'clients', 'suppliers', 'articles', 'documents',
      'purchaseInvoices', 'frais', 'hrEmployees', 'hrWorkEntries',
      'externalPrices'
    ];
    for (var i = 0; i < watchList.length; i++) {
      S.subscribe(watchList[i], (function () {
        try {
          /* FIX R12 : debounce 300ms pour absorber les rafales
             (import, batch, multi-onglets) sans rendre N× les badges. */
          if (A.__badgeTimer) clearTimeout(A.__badgeTimer);
          A.__badgeTimer = setTimeout(function () {
            A.__badgeTimer = null;
            try { A.renderBadges(); } catch (e) {
              VC.logError('04-alerts', 'renderBadges auto échoué', e);
            }
          }, 300);
        } catch (e) {
          VC.logError('04-alerts', 'debounce renderBadges échoué', e);
        }
      }));
    }
  })();

  VC._alertsLoaded = true;

  VC.logInfo('04-alerts', 'Module chargé', {
    docHelpers: Object.keys(Doc).length,
    alertHelpers: Object.keys(A).length
  });

})(window);