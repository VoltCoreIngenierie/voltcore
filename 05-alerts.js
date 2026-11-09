/* ═══════════════════════════════════════════════════════════════
   VOLTCORE — 05-alerts.js
   VERSION : v6.7 (Session #3 — bump version unifié, aucun changement
                   fonctionnel — fichier validé sans bug)
   RÔLE : Détection automatique des anomalies (articles, fournisseurs, clients)
   DÉPENDANCES : 01-core.js, 03-utils.js (helpers), 04-storage.js
                  (getNetRevenu, getResteAPayer, saveDismissedAlerts)
   EXPOSE : computeChantierMarge, computeClientMarge,
            computeArticleAlerts, computeFournisseurAlerts,
            computeClientAlerts, getAllAlerts, getAlertCounts,
            dismissAlertById, restoreAlertById,
            renderAlertBadges, openAlertsModal, closeAlertsModal,
            switchAlertsTab, attachAlertsUIEvents
   ═══════════════════════════════════════════════════════════════ */

/* ═══════════ SECTION 1 — CONSTANTES ═══════════ */

var VOLTCORE_ALERT_IMPAYE_DAYS = 30;
var VOLTCORE_ALERT_MARGE_MIN = 0.10;
var VOLTCORE_ALERT_DEPENDANCE_MAX = 0.50;
var VOLTCORE_ALERT_PRIX_ECART = 0.05;
var VOLTCORE_ALERT_PRIX_MAX_DAYS = 180;
var VOLTCORE_ALERT_FOURN_ECART = 0.05;
var VOLTCORE_ALERT_FOURN_MIN_COUNT = 3;

/* ═══════════ SECTION 2 — HELPERS GÉNÉRIQUES ═══════════ */

function _alertsGetId(prefix, a, b) {
  return prefix + '_' + String(a || '') + '_' + String(b || '');
}

function _alertsIsDismissed(id) {
  if (!Array.isArray(dismissedAlerts)) return false;
  return dismissedAlerts.indexOf(id) >= 0;
}

function _alertsFilter(list) {
  if (!Array.isArray(list)) return [];
  return list.filter(function (a) { return a && a.id && !_alertsIsDismissed(a.id); });
}

function _alertsDaysSince(iso) {
  if (!iso) return 0;
  try {
    var s = String(iso).slice(0, 10);
    var d = new Date(s + 'T12:00:00').getTime();
    if (!isFinite(d)) return 0;
    return Math.floor((Date.now() - d) / 86400000);
  } catch (e) { return 0; }
}

function _alertsGetDocTotal(doc) {
  if (!doc) return 0;
  if (doc.totals && typeof doc.totals.total === 'number') return doc.totals.total;
  if (typeof doc.totalTTC === 'number') return doc.totalTTC;
  return 0;
}

function _alertsGetDocDate(doc) {
  if (!doc) return '';
  return String(doc.date || doc.dateDoc || '').slice(0, 10);
}

function _alertsIsActive(doc) {
  if (!doc) return false;
  if (doc.statut === 'annulee' || doc.annulee === true) return false;
  if (doc.statut === 'brouillon') return false;
  return true;
}

function _alertsGetChantierId(obj) {
  if (!obj) return '';
  return String(obj.chantierId || obj.chantier || '').trim();
}

/* ═══════════ SECTION 3 — B5 : CALCUL DES MARGES ═══════════ */

function computeChantierMarge(chantierId) {
  var empty = { recettes: 0, achats: 0, frais: 0, rh: 0, marge: 0, margePct: 0, nbDocs: 0 };
  try {
    if (!chantierId) return empty;
    var cid = String(chantierId);

    var recettes = 0;
    var nbDocs = 0;
    if (Array.isArray(savedDocuments)) {
      for (var i = 0; i < savedDocuments.length; i++) {
        var d = savedDocuments[i];
        if (!d || d.type !== 'facture') continue;
        if (_alertsGetChantierId(d) !== cid) continue;
        if (!_alertsIsActive(d)) continue;
        
        var net = (typeof getNetRevenu === 'function') 
          ? getNetRevenu(d) 
          : _alertsGetDocTotal(d);
        recettes += net;
        nbDocs++;
      }
    }

    var achats = 0;
    if (Array.isArray(purchaseInvoices)) {
      for (var j = 0; j < purchaseInvoices.length; j++) {
        var p = purchaseInvoices[j];
        if (!p) continue;
        if (_alertsGetChantierId(p) !== cid) continue;
        var totalP = (typeof p.totalTTC === 'number') ? p.totalTTC
                   : (typeof p.total === 'number') ? p.total
                   : (typeof p.montant === 'number') ? p.montant : 0;
        achats += totalP;
      }
    }

    var fraisTotal = 0;
    if (Array.isArray(frais)) {
      for (var k = 0; k < frais.length; k++) {
        var f = frais[k];
        if (!f) continue;
        if (_alertsGetChantierId(f) !== cid) continue;
        var montantF = (typeof f.montant === 'number') ? f.montant : parseFloat(f.montant) || 0;
        fraisTotal += montantF;
      }
    }

    var rhTotal = 0;
    if (Array.isArray(hrWorkEntries) && Array.isArray(hrEmployees)) {
      var empById = {};
      for (var e = 0; e < hrEmployees.length; e++) {
        if (hrEmployees[e] && hrEmployees[e].id) empById[hrEmployees[e].id] = hrEmployees[e];
      }
      for (var h = 0; h < hrWorkEntries.length; h++) {
        var w = hrWorkEntries[h];
        if (!w) continue;
        if (_alertsGetChantierId(w) !== cid) continue;
        var heures = (typeof w.hours === 'number') ? w.hours
                   : (typeof w.heures === 'number') ? w.heures
                   : parseFloat(w.hours || w.heures) || 0;
        var emp = empById[w.employeeId];
        var taux = 0;
        if (w.rate != null) taux = parseFloat(w.rate) || 0;
        else if (emp && emp.hourlyRate != null) taux = parseFloat(emp.hourlyRate) || 0;
        else if (emp && emp.tauxHoraire != null) taux = parseFloat(emp.tauxHoraire) || 0;
        rhTotal += heures * taux;
      }
    }

    var marge = recettes - achats - fraisTotal - rhTotal;
    var margePct = recettes > 0 ? (marge / recettes) : 0;

    return {
      recettes: recettes,
      achats: achats,
      frais: fraisTotal,
      rh: rhTotal,
      marge: marge,
      margePct: margePct,
      nbDocs: nbDocs
    };
  } catch (e) {
    console.warn('computeChantierMarge(' + chantierId + ') :', e);
    return empty;
  }
}

function computeClientMarge(clientId) {
  var empty = { recettes: 0, achats: 0, frais: 0, rh: 0, marge: 0, margePct: 0, nbDocs: 0 };
  try {
    if (!clientId) return empty;
    var cid = String(clientId);

    var recettes = 0, achats = 0, fraisTot = 0, rh = 0, nbDocs = 0;

    if (Array.isArray(savedChantiers)) {
      for (var i = 0; i < savedChantiers.length; i++) {
        var ch = savedChantiers[i];
        if (!ch || String(ch.clientId || '') !== cid) continue;
        var m = computeChantierMarge(ch.id);
        recettes += m.recettes;
        achats += m.achats;
        fraisTot += m.frais;
        rh += m.rh;
        nbDocs += m.nbDocs;
      }
    }

    if (Array.isArray(savedDocuments)) {
      for (var j = 0; j < savedDocuments.length; j++) {
        var d = savedDocuments[j];
        if (!d || d.type !== 'facture') continue;
        if (String(d.clientId || '') !== cid) continue;
        if (_alertsGetChantierId(d)) continue;
        if (!_alertsIsActive(d)) continue;
        
        var net = (typeof getNetRevenu === 'function') 
          ? getNetRevenu(d) 
          : _alertsGetDocTotal(d);
        recettes += net;
        nbDocs++;
      }
    }

    if (Array.isArray(purchaseInvoices)) {
      for (var p = 0; p < purchaseInvoices.length; p++) {
        var pi = purchaseInvoices[p];
        if (!pi || String(pi.clientId || '') !== cid) continue;
        if (_alertsGetChantierId(pi)) continue;
        var tp = (typeof pi.totalTTC === 'number') ? pi.totalTTC
               : (typeof pi.total === 'number') ? pi.total : 0;
        achats += tp;
      }
    }
    if (Array.isArray(frais)) {
      for (var f = 0; f < frais.length; f++) {
        var fr = frais[f];
        if (!fr || String(fr.clientId || '') !== cid) continue;
        if (_alertsGetChantierId(fr)) continue;
        fraisTot += (typeof fr.montant === 'number') ? fr.montant : (parseFloat(fr.montant) || 0);
      }
    }

    var marge = recettes - achats - fraisTot - rh;
    var margePct = recettes > 0 ? (marge / recettes) : 0;
    return {
      recettes: recettes, achats: achats, frais: fraisTot, rh: rh,
      marge: marge, margePct: margePct, nbDocs: nbDocs
    };
  } catch (e) {
    console.warn('computeClientMarge(' + clientId + ') :', e);
    return empty;
  }
}

/* ═══════════ SECTION 4 — ALERTES ARTICLES ═══════════ */

function computeArticleAlerts() {
  var out = [];
  try {
    if (!Array.isArray(savedArticles)) return out;
    if (!externalPrices || typeof externalPrices !== 'object') return out;

    for (var i = 0; i < savedArticles.length; i++) {
      var art = savedArticles[i];
      if (!art || !art.id) continue;
      var key = String(art.id);
      var entries = externalPrices[key];
      if (!Array.isArray(entries) || entries.length === 0) continue;

      var recent = entries.filter(function (e) {
        return e && _alertsDaysSince(e.date) <= VOLTCORE_ALERT_PRIX_MAX_DAYS;
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

      var prixActuel = 0;
      if (typeof art.prixAchat === 'number') prixActuel = art.prixAchat;
      else if (typeof art.purchasePrice === 'number') prixActuel = art.purchasePrice;
      else if (typeof art.prix === 'number') prixActuel = art.prix;

      var id = _alertsGetId('art', art.id, minEntry.fournisseur || 'x');
      var nom = String(art.nom || art.designation || art.name || art.id);

      if (prixActuel > 0 && minPrix < prixActuel * (1 - VOLTCORE_ALERT_PRIX_ECART)) {
        var ecartPct = ((prixActuel - minPrix) / prixActuel) * 100;
        out.push({
          id: id, level: 'warning', articleId: art.id, articleNom: nom,
          message: 'Meilleur prix vu : ' + formatMoney(minPrix) +
                   ' chez ' + String(minEntry.fournisseur || '?') +
                   ' (−' + ecartPct.toFixed(1) + '% vs ton prix d\'achat)',
          valeur: ecartPct
        });
      } else if (minEntry.fournisseur) {
        out.push({
          id: id, level: 'info', articleId: art.id, articleNom: nom,
          message: 'Prix vu chez ' + String(minEntry.fournisseur) + ' : ' + formatMoney(minPrix),
          valeur: minPrix
        });
      }
    }
  } catch (e) { console.warn('computeArticleAlerts :', e); }
  return _alertsFilter(out);
}

/* ═══════════ SECTION 5 — ALERTES FOURNISSEURS ═══════════ */

function computeFournisseurAlerts() {
  var out = [];
  try {
    if (!Array.isArray(suppliers) || suppliers.length === 0) return out;
    if (!externalPrices || typeof externalPrices !== 'object') return out;

    var minParArticle = {};
    for (var articleId in externalPrices) {
      if (!externalPrices.hasOwnProperty(articleId)) continue;
      var entries = externalPrices[articleId];
      if (!Array.isArray(entries)) continue;
      var recent = entries.filter(function (e) {
        return e && typeof e.prix === 'number' && isFinite(e.prix) &&
               _alertsDaysSince(e.date) <= VOLTCORE_ALERT_PRIX_MAX_DAYS;
      });
      if (recent.length === 0) continue;
      var minP = Infinity;
      for (var i = 0; i < recent.length; i++) {
        if (recent[i].prix < minP) minP = recent[i].prix;
      }
      /* v6.8.1 — Ignore les prix 0 (faux positifs sinon) */
      if (isFinite(minP) && minP > 0) minParArticle[articleId] = minP;
    }

    for (var s = 0; s < suppliers.length; s++) {
      var f = suppliers[s];
      if (!f || !f.nom) continue;
      var nomF = String(f.nom);
      var plusCherCount = 0;
      var exemples = [];
      for (var aid in externalPrices) {
        if (!externalPrices.hasOwnProperty(aid)) continue;
        if (minParArticle[aid] == null) continue;
        var arr = externalPrices[aid];
        if (!Array.isArray(arr)) continue;
        var minP2 = minParArticle[aid];
        /* v6.8.1 — Garde anti division par 0 (déjà filtré plus haut,
           mais ceinture + bretelles pour données corrompues) */
        if (!minP2 || minP2 <= 0) continue;

        for (var j = 0; j < arr.length; j++) {
          var e = arr[j];
          if (!e || String(e.fournisseur || '') !== nomF) continue;
          if (_alertsDaysSince(e.date) > VOLTCORE_ALERT_PRIX_MAX_DAYS) continue;
          if (typeof e.prix !== 'number' || !isFinite(e.prix)) continue;
          if (e.prix > minP2 * (1 + VOLTCORE_ALERT_FOURN_ECART)) {
            /* v6.8.1 — Bug fix : le break est MAINTENANT à l'intérieur
               du test "plus cher". Avant, il était après le test, donc
               il bloquait la détection dès la 1re entrée non-plus-chère.
               Maintenant : compte 1× par article (max) et continue
               l'examen des entrées suivantes si pas plus cher. */
            plusCherCount++;
            if (exemples.length < 3) exemples.push(aid);
            break;
          }
          /* Pas plus cher → continue à examiner les autres entrées */
        }
      }
      if (plusCherCount >= VOLTCORE_ALERT_FOURN_MIN_COUNT) {
        var id = _alertsGetId('four', f.id || nomF, 'comp');
        out.push({
          id: id, level: 'warning', fournisseurId: f.id || null, fournisseurNom: nomF,
          message: 'Plus cher que la concurrence sur ' + plusCherCount + ' article(s).',
          valeur: plusCherCount
        });
      }
    }

    /* v6.8.1 — Diagnostic throttlé : signale les fournisseurs avec
       beaucoup d'articles plus chers (indicateur de compétitivité). */
    if (out.length > 0) {
      var now = Date.now();
      if (now - __lastFournAlertWarnAt > 60000) {
        __lastFournAlertWarnAt = now;
        try {
          console.warn('[Alerts] ' + out.length +
            ' fournisseur(s) plus cher(s) que la concurrence détecté(s).');
        } catch (e) {}
      }
    }
  } catch (e) { console.warn('computeFournisseurAlerts :', e); }
  return _alertsFilter(out);
}
/* v6.8.1 — Flag anti-spam pour le warning fournisseurs alertés.
   Déclaré au niveau module, juste avant la fonction. */
var __lastFournAlertWarnAt = 0;

/* ═══════════ SECTION 6 — ALERTES CLIENTS (LOT 4 : OPTIMISÉ) ═══════════ */

function computeClientAlerts() {
  var out = [];
  try {
    if (!Array.isArray(clients) || clients.length === 0) return out;

    /* 1. Pré-calcul des marges par chantier */
    var marginsByChantier = {};
    if (Array.isArray(savedChantiers)) {
      for (var i = 0; i < savedChantiers.length; i++) {
        var ch = savedChantiers[i];
        if (!ch || !ch.id) continue;
        marginsByChantier[String(ch.id)] = { recettes: 0, achats: 0, frais: 0, rh: 0, nbDocs: 0 };
      }
    }

    if (Array.isArray(savedDocuments)) {
      for (var d = 0; d < savedDocuments.length; d++) {
        var doc = savedDocuments[d];
        if (!doc || doc.type !== 'facture') continue;
        if (!_alertsIsActive(doc)) continue;
        var chId = String(doc.chantierId || '').trim();
        if (!chId || !marginsByChantier[chId]) continue;
        var net = (typeof getNetRevenu === 'function') ? getNetRevenu(doc) : _alertsGetDocTotal(doc);
        marginsByChantier[chId].recettes += net;
        marginsByChantier[chId].nbDocs++;
      }
    }

    if (Array.isArray(purchaseInvoices)) {
      for (var p = 0; p < purchaseInvoices.length; p++) {
        var pi = purchaseInvoices[p];
        if (!pi) continue;
        var chId2 = String(pi.chantierId || '').trim();
        if (!chId2 || !marginsByChantier[chId2]) continue;
        var totalPi = (typeof pi.totalTTC === 'number') ? pi.totalTTC : (typeof pi.total === 'number') ? pi.total : (typeof pi.montant === 'number') ? pi.montant : 0;
        marginsByChantier[chId2].achats += totalPi;
      }
    }

    if (Array.isArray(frais)) {
      for (var f = 0; f < frais.length; f++) {
        var fr = frais[f];
        if (!fr) continue;
        var chId3 = String(fr.chantierId || '').trim();
        if (!chId3 || !marginsByChantier[chId3]) continue;
        marginsByChantier[chId3].frais += (typeof fr.montant === 'number') ? fr.montant : parseNumber(fr.montant);
      }
    }

    if (Array.isArray(hrWorkEntries) && Array.isArray(hrEmployees)) {
      var empRate = {};
      for (var e = 0; e < hrEmployees.length; e++) {
        var emp = hrEmployees[e];
        if (!emp || !emp.id) continue;
        empRate[String(emp.id)] = parseNumber(emp.hourlyRate != null ? emp.hourlyRate : emp.tauxHoraire);
      }
      for (var h = 0; h < hrWorkEntries.length; h++) {
        var w = hrWorkEntries[h];
        if (!w) continue;
        var chId4 = String(w.chantierId || '').trim();
        if (!chId4 || !marginsByChantier[chId4]) continue;
        var hours = parseNumber(w.hours != null ? w.hours : w.heures);
        var rate = (w.rate != null) ? parseNumber(w.rate) : (empRate[String(w.employeeId)] || 0);
        marginsByChantier[chId4].rh += hours * rate;
      }
    }

    for (var cid in marginsByChantier) {
      if (!marginsByChantier.hasOwnProperty(cid)) continue;
      var m = marginsByChantier[cid];
      m.marge = m.recettes - m.achats - m.frais - m.rh;
      m.margePct = m.recettes > 0 ? (m.marge / m.recettes) : 0;
    }

    /* 2. Pré-calcul des marges par client */
    var marginsByClient = {};
    for (var ci = 0; ci < clients.length; ci++) {
      var cl = clients[ci];
      if (!cl || !cl.id) continue;
      marginsByClient[String(cl.id)] = { recettes: 0, achats: 0, frais: 0, rh: 0, nbDocs: 0 };
    }

    if (Array.isArray(savedChantiers)) {
      for (var j = 0; j < savedChantiers.length; j++) {
        var ch2 = savedChantiers[j];
        if (!ch2) continue;
        var clientId = String(ch2.clientId || '').trim();
        if (!clientId || !marginsByClient[clientId]) continue;
        var cm = marginsByChantier[String(ch2.id)];
        if (!cm) continue;
        var t = marginsByClient[clientId];
        t.recettes += cm.recettes; t.achats += cm.achats; t.frais += cm.frais; t.rh += cm.rh; t.nbDocs += cm.nbDocs;
      }
    }

    if (Array.isArray(savedDocuments)) {
      for (var dd = 0; dd < savedDocuments.length; dd++) {
        var doc2 = savedDocuments[dd];
        if (!doc2 || doc2.type !== 'facture') continue;
        if (!_alertsIsActive(doc2)) continue;
        if (String(doc2.chantierId || '').trim()) continue;
        var cid2 = String(doc2.clientId || '').trim();
        if (!cid2 || !marginsByClient[cid2]) continue;
        var net2 = (typeof getNetRevenu === 'function') ? getNetRevenu(doc2) : _alertsGetDocTotal(doc2);
        marginsByClient[cid2].recettes += net2;
        marginsByClient[cid2].nbDocs++;
      }
    }

    if (Array.isArray(purchaseInvoices)) {
      for (var pp = 0; pp < purchaseInvoices.length; pp++) {
        var pi2 = purchaseInvoices[pp];
        if (!pi2) continue;
        if (String(pi2.chantierId || '').trim()) continue;
        var cid3 = String(pi2.clientId || '').trim();
        if (!cid3 || !marginsByClient[cid3]) continue;
        var tot3 = (typeof pi2.totalTTC === 'number') ? pi2.totalTTC : (typeof pi2.total === 'number') ? pi2.total : 0;
        marginsByClient[cid3].achats += tot3;
      }
    }

    if (Array.isArray(frais)) {
      for (var ff = 0; ff < frais.length; ff++) {
        var fr2 = frais[ff];
        if (!fr2) continue;
        if (String(fr2.chantierId || '').trim()) continue;
        var cid4 = String(fr2.clientId || '').trim();
        if (!cid4 || !marginsByClient[cid4]) continue;
        marginsByClient[cid4].frais += (typeof fr2.montant === 'number') ? fr2.montant : parseNumber(fr2.montant);
      }
    }

    for (var cid5 in marginsByClient) {
      if (!marginsByClient.hasOwnProperty(cid5)) continue;
      var cm2 = marginsByClient[cid5];
      cm2.marge = cm2.recettes - cm2.achats - cm2.frais - cm2.rh;
      cm2.margePct = cm2.recettes > 0 ? (cm2.marge / cm2.recettes) : 0;
    }

    /* 3. CA total entreprise */
    var caTotal = 0;
    if (Array.isArray(savedDocuments)) {
      for (var dt = 0; dt < savedDocuments.length; dt++) {
        var docT = savedDocuments[dt];
        if (!docT || docT.type !== 'facture') continue;
        if (!_alertsIsActive(docT)) continue;
        caTotal += (typeof getNetRevenu === 'function') ? getNetRevenu(docT) : _alertsGetDocTotal(docT);
      }
    }

    /* 4. Vérification des alertes */
    for (var cc = 0; cc < clients.length; cc++) {
      var cl2 = clients[cc];
      if (!cl2 || !cl2.id) continue;
      var nom = String(cl2.nom || cl2.name || cl2.id);
      var clId = String(cl2.id);

      /* Impayés > 30j */
      var impayeTotal = 0, impayeCount = 0;
      if (Array.isArray(savedDocuments)) {
        for (var k = 0; k < savedDocuments.length; k++) {
          var d2 = savedDocuments[k];
          if (!d2 || d2.type !== 'facture') continue;
          if (String(d2.clientId || '') !== clId) continue;
          if (!_alertsIsActive(d2)) continue;
          var reste = (typeof getResteAPayer === 'function') ? getResteAPayer(d2) : 0;
          if (reste > 0.001) {
            var jours = _alertsDaysSince(_alertsGetDocDate(d2));
            if (jours > VOLTCORE_ALERT_IMPAYE_DAYS) {
              impayeTotal += reste;
              impayeCount++;
            }
          }
        }
      }
      if (impayeCount > 0) {
        out.push({
          id: _alertsGetId('cli', clId, 'impaye'),
          level: 'error', clientId: clId, clientNom: nom,
          message: impayeCount + ' facture(s) impayée(s) > ' + VOLTCORE_ALERT_IMPAYE_DAYS + 'j — total ' + formatMoney(impayeTotal),
          valeur: impayeTotal
        });
      }

      /* Marge faible */
      var mCl = marginsByClient[clId] || { recettes: 0, marge: 0, margePct: 0 };
      if (mCl.recettes > 0 && mCl.margePct < VOLTCORE_ALERT_MARGE_MIN) {
        out.push({
          id: _alertsGetId('cli', clId, 'marge'),
          level: 'warning', clientId: clId, clientNom: nom,
          message: 'Marge faible : ' + (mCl.margePct * 100).toFixed(1) + '% (CA ' + formatMoney(mCl.recettes) + ' · marge ' + formatMoney(mCl.marge) + ')',
          valeur: mCl.margePct
        });
      }

      /* Dépendance > 50% */
      if (caTotal > 0 && mCl.recettes > 0) {
        var part = mCl.recettes / caTotal;
        if (part > VOLTCORE_ALERT_DEPENDANCE_MAX) {
          out.push({
            id: _alertsGetId('cli', clId, 'dep'),
            level: 'warning', clientId: clId, clientNom: nom,
            message: 'Dépendance : ' + (part * 100).toFixed(1) + '% du CA total vient de ce client.',
            valeur: part
          });
        }
      }
    }
  } catch (e) {
    console.warn('computeClientAlerts :', e);
  }
  return _alertsFilter(out);
}

/* ═══════════ SECTION 7 — AGRÉGATION + COMPTEURS ═══════════ */

function getAllAlerts() {
  return {
    articles: computeArticleAlerts(),
    fournisseurs: computeFournisseurAlerts(),
    clients: computeClientAlerts()
  };
}

function getAlertCounts() {
  var all = getAllAlerts();
  return {
    articles: all.articles.length,
    fournisseurs: all.fournisseurs.length,
    clients: all.clients.length,
    total: all.articles.length + all.fournisseurs.length + all.clients.length
  };
}

/* ═══════════ SECTION 8 — DISMISS / RESTORE ═══════════ */

function dismissAlertById(id) {
  try {
    if (!id) return false;
    if (!Array.isArray(dismissedAlerts)) dismissedAlerts = [];
    if (dismissedAlerts.indexOf(id) >= 0) return true;
    dismissedAlerts.push(id);
    if (typeof saveDismissedAlerts === 'function') saveDismissedAlerts();
    renderAlertBadges();
    return true;
  } catch (e) { console.warn('dismissAlertById :', e); return false; }
}

function restoreAlertById(id) {
  try {
    if (!id || !Array.isArray(dismissedAlerts)) return false;
    var idx = dismissedAlerts.indexOf(id);
    if (idx < 0) return false;
    dismissedAlerts.splice(idx, 1);
    if (typeof saveDismissedAlerts === 'function') saveDismissedAlerts();
    renderAlertBadges();
    return true;
  } catch (e) { console.warn('restoreAlertById :', e); return false; }
}

/* ═══════════ SECTION 9 — RENDU DES BADGES ═══════════ */

function renderAlertBadges() {
  try {
    var counts = getAlertCounts();
    _updateBadge('alertCountArticles', counts.articles);
    _updateBadge('alertCountSuppliers', counts.fournisseurs);
    _updateBadge('alertCountClients', counts.clients);
    _updateBadge('alertCountTotal', counts.total);
  } catch (e) { console.warn('renderAlertBadges :', e); }
}

function _updateBadge(elementId, count) {
  try {
    var el = document.getElementById(elementId);
    if (!el) return;
    if (count > 0) {
      el.textContent = count > 99 ? '99+' : String(count);
      el.style.display = 'inline-block';
      el.classList.remove('badge-empty');
    } else {
      el.textContent = '';
      el.style.display = 'none';
      el.classList.add('badge-empty');
    }
  } catch (e) {}
}

/* ═══════════ SECTION 10 — RENDU DE LA MODALE ═══════════ */

var __alertsCurrentTab = 'clients';

function openAlertsModal(tab) {
  try {
    var modal = document.getElementById('alertsModal');
    if (!modal) return;
    __alertsCurrentTab = tab || 'clients';
    _renderAlertsModalContent();
    modal.style.display = 'flex';
  } catch (e) { console.warn('openAlertsModal :', e); }
}

function closeAlertsModal() {
  try {
    var modal = document.getElementById('alertsModal');
    if (modal) modal.style.display = 'none';
  } catch (e) {}
}

function switchAlertsTab(tab) {
  __alertsCurrentTab = tab || 'clients';
  _renderAlertsModalContent();
}

function _renderAlertsModalContent() {
  try {
    var container = document.getElementById('alertsModalBody');
    if (!container) return;

    var all = getAllAlerts();
    var tab = __alertsCurrentTab;
    var list = all[tab] || [];

    var tabsHtml = '';
    var tabs = [
      { key: 'clients', label: 'Clients', count: all.clients.length },
      { key: 'fournisseurs', label: 'Fournisseurs', count: all.fournisseurs.length },
      { key: 'articles', label: 'Articles', count: all.articles.length }
    ];
    for (var t = 0; t < tabs.length; t++) {
      var tb = tabs[t];
      tabsHtml += '<button type="button" class="alerts-tab' +
        (tb.key === tab ? ' active' : '') + '" ' +
        'onclick="switchAlertsTab(\'' + tb.key + '\')">' +
        escapeHtml(tb.label) +
        (tb.count > 0 ? ' <span class="alerts-tab-count">' + tb.count + '</span>' : '') +
        '</button>';
    }

    var listHtml = '';
    if (list.length === 0) {
      listHtml = '<div class="alerts-empty">Aucune alerte. Bon travail ! ✅</div>';
    } else {
      for (var i = 0; i < list.length; i++) {
        var a = list[i];
        var levelClass = 'alert-level-' + (a.level || 'info');
        listHtml += '<div class="alert-item ' + levelClass + '">' +
          '<div class="alert-item-body">' +
          '<div class="alert-item-title">' + escapeHtml(a.clientNom || a.fournisseurNom || a.articleNom || '') + '</div>' +
          '<div class="alert-item-msg">' + escapeHtml(a.message || '') + '</div>' +
          '</div>' +
          '<div class="alert-item-actions">' +
          '<button type="button" class="btn btn-sm" onclick="dismissAlertById(\'' + escapeAttr(a.id) + '\')">✓ Vu</button>' +
          '</div>' +
          '</div>';
      }
    }

    container.innerHTML = '<div class="alerts-tabs">' + tabsHtml + '</div>' +
      '<div class="alerts-list">' + listHtml + '</div>';
  } catch (e) { console.warn('_renderAlertsModalContent :', e); }
}

/* ═══════════ SECTION 11 — HANDLERS UI (LOT 3) ═══════════ */

function attachAlertsUIEvents() {
  try {
    var badges = [
      { id: 'alertCountClients', tab: 'clients' },
      { id: 'alertCountSuppliers', tab: 'fournisseurs' },
      { id: 'alertCountArticles', tab: 'articles' }
    ];
    for (var i = 0; i < badges.length; i++) {
      var el = document.getElementById(badges[i].id);
      if (el && !el.__bound) {
        el.__bound = true;
        (function (badge, tab) {
          badge.addEventListener('click', function (ev) {
            try { ev.stopPropagation(); ev.preventDefault(); } catch (e) {}
            openAlertsModal(tab);
          });
        })(el, badges[i].tab);
      }
    }

    var bell = document.getElementById('btnOpenAlerts');
    if (bell && !bell.__bound) {
      bell.__bound = true;
      bell.addEventListener('click', function () { openAlertsModal('clients'); });
    }
    
    var totalBadge = document.getElementById('alertCountTotal');
    if (totalBadge && !totalBadge.__bound) {
      totalBadge.__bound = true;
      totalBadge.addEventListener('click', function (ev) {
        try { ev.stopPropagation(); ev.preventDefault(); } catch (e) {}
        openAlertsModal('clients');
      });
    }
  } catch (e) { console.warn('attachAlertsUIEvents :', e); }
}

console.log('✅ 05-alerts.js chargé — v6.7 (Session #3 — version unifiée, aucun changement fonctionnel)');