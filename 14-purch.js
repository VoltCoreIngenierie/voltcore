/* ═══════════════════════════════════════════════════════════
   VOLTCORE — 14-purch.js
   VERSION : v7.0.0
   RÔLE : Achats fournisseurs, TVA déductible, paiements,
          attestation imprimable, alimentation du comparateur
          de prix (externalPrices).
          Normalisation + save + load + trash : gérés par Store.
   DÉPENDANCES : 00-core, 01-utils, 02-store, 04-alerts, 07-suppl, 08-stock
   ORDRE : 15ᵉ fichier chargé

   FIX v7.0.0 :
   - C21 : externalPrices nettoyés en édition (avant re-push)
   - C22 : externalPrices nettoyés en suppression
   - TVA déductible calculée ligne par ligne (hors timbre)
   - Attestation avec signatures optionnelles

   RÈGLES :
   - ES5 strict
   - Aucun catch silencieux
   - Ne JAMAIS lire/écrire localStorage directement
   ═══════════════════════════════════════════════════════════ */

'use strict';

(function (global) {

  if (!global.VOLTCORE || !global.VOLTCORE.Store || !global.VOLTCORE.Utils) {
    throw new Error('[14-purch] Modules requis non chargés');
  }

  var VC = global.VOLTCORE;
  var U = VC.Utils;
  var S = VC.Store;
  var Doc = VC.Doc;
  var Pur = VC.Purchases || {};
  VC.Purchases = Pur;

  /* ═══════════════════════════════════════════════════════════
     SECTION 1 — REGISTRATION STORE
     ═══════════════════════════════════════════════════════════ */

  S.register('purchaseInvoices', {
    type: 'array',
    saveKey: 'voltcore_purchase_invoices',
    default: [],
    idPrefix: 'pur',
    trash: true,
    backup: true,
    schema: {
      numero: 'string',
      refFacture: 'string',
      supplierId: 'string',
      fournisseurId: 'string',
      fournisseur: 'string',
      date: 'date|required',
      chantierId: 'string',
      tvaRate: 'float|0-100',
      timbre: 'float|0-999',
      notes: 'string',
      totalTTC: 'float|0-99999999',
      total: 'float|0-99999999'
    }
  });

  /* ═══════════════════════════════════════════════════════════
     SECTION 2 — ÉTAT INTERNE
     ═══════════════════════════════════════════════════════════ */

  var _searchTerm = '';
  var _filter = 'all';
  var _editId = null;
  var _modalLines = [];
  var _currentPaymentId = null;

  /* ═══════════════════════════════════════════════════════════
     SECTION 3 — HELPERS
     ═══════════════════════════════════════════════════════════ */

  Pur.getById = function (id) {
    return S.getById('purchaseInvoices', id);
  };

  function _purchDate(p) {
    if (!p) return '';
    return String(p.date || p.dateFacture || '').slice(0, 10);
  }

  function _purchTotal(p) {
    if (!p) return 0;
    if (typeof p.totalTTC === 'number') return p.totalTTC;
    if (typeof p.total === 'number') return p.total;
    if (p.totals && typeof p.totals.totalTTC === 'number') return p.totals.totalTTC;
    return 0;
  }

  function _supplierName(p) {
    if (!p) return '';
    var sid = p.supplierId || p.fournisseurId;
    if (sid && VC.Suppliers && typeof VC.Suppliers.getById === 'function') {
      var f = VC.Suppliers.getById(sid);
      if (f) return String(f.nom || '');
    }
    /* FIX R2 : fallback orphelin (fournisseur supprimé) */
    if (p._fournisseurNomOrphelin) {
      return String(p._fournisseurNomOrphelin) + ' (non enregistré)';
    }
    if (p.fournisseur) return String(p.fournisseur);
    return '';
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 4 — CALCULS (TVA déductible)
     ═══════════════════════════════════════════════════════════ */

  /**
   * Calcule les totaux d'un achat depuis ses lignes.
   * Formule : HT + TVA + Timbre.
   */
  Pur.computeTotals = function (lines, tvaRate, timbre) {
    var arr = Array.isArray(lines) ? lines : [];
    var totalHT = 0;

    for (var i = 0; i < arr.length; i++) {
      var l = arr[i];
      if (!l) continue;
      var q = U.parseNumber(l.quantite);
      var pu = U.parseNumber(l.prixUnitaire != null ? l.prixUnitaire : l.prix);
      if (q > 0 && pu >= 0) totalHT += q * pu;
    }

    var tvaPct = U.parseNumber(tvaRate);
    if (!isFinite(tvaPct) || tvaPct < 0) tvaPct = VC.TVA_DEFAULT;
    if (tvaPct > 100) tvaPct = 100;

    var timbreM = U.parseNumber(timbre);
    if (!isFinite(timbreM) || timbreM < 0) timbreM = VC.TIMBRE_DEFAULT;

    var tva = totalHT * tvaPct / 100;
    var totalTTC = totalHT + tva + timbreM;

    return {
      totalHT: totalHT,
      tvaRate: tvaPct,
      tva: tva,
      timbre: timbreM,
      totalTTC: totalTTC,
      total: totalTTC
    };
  };

  /**
   * Récap TVA déductible sur une période YYYY-MM.
   */
  Pur.getTvaDeductible = function (monthIso) {
    var totalHT = 0, totalTVA = 0, count = 0;
    var prefix = String(monthIso || '').slice(0, 7);
    var purchases = S.getAll('purchaseInvoices');

    for (var i = 0; i < purchases.length; i++) {
      var p = purchases[i];
      if (!p) continue;
      var d = _purchDate(p);
      if (prefix && d.slice(0, 7) !== prefix) continue;
      var t = Pur.computeTotals(p.lines, p.tvaRate, p.timbre);
      totalHT += t.totalHT;
      totalTVA += t.tva;
      count++;
    }

    return { totalHT: totalHT, totalTVA: totalTVA, count: count };
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 5 — RENDU LISTE
     ═══════════════════════════════════════════════════════════ */

  Pur.render = function () {
    var container = document.getElementById('purchasesList');
    if (!container) return;

    var list = Pur.getFiltered();
    if (list.length === 0) {
      container.innerHTML = '<div class="empty-state">Aucun achat' +
        (_searchTerm || _filter !== 'all' ? ' pour ce filtre' : '') +
        '. Clique sur "+ Nouvel achat" pour enregistrer une facture fournisseur.</div>';
      U.setText('purchasesCount', '0');
      _updateSummary(0, 0, 0);
      return;
    }

    var html = '';
    var totalHT = 0, totalTVA = 0, totalTTC = 0;

    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      var t = Pur.computeTotals(p.lines, p.tvaRate, p.timbre);
      totalHT += t.totalHT;
      totalTVA += t.tva;
      totalTTC += _purchTotal(p);
      html += Pur.renderRow(p);
    }

    container.innerHTML = html;
    U.setText('purchasesCount', String(list.length));
    _updateSummary(totalHT, totalTVA, totalTTC);
  };

  function _updateSummary(ht, tva, ttc) {
    U.setText('purchasesTotalHT', U.formatMoney(ht));
    U.setText('purchasesTotalTVA', U.formatMoney(tva));
    U.setText('purchasesTotalTTC', U.formatMoney(ttc));
  }

  Pur.renderRow = function (p) {
    if (!p) return '';

    var id = U.escapeAttr(p.id);
    var supplierName = U.escapeHtml(_supplierName(p) || '—');
    var numero = U.escapeHtml(p.numero || p.refFacture || '—');
    var total = _purchTotal(p);
    var reste = Doc.getResteAPayer(p);
    var statut = Doc.getStatutPaiement(p);

    var statutColor = statut === 'payee' ? 'var(--success)'
      : statut === 'partielle' ? 'var(--warning)' : 'var(--danger)';
    var statutLabel = statut === 'payee' ? 'Payée'
      : statut === 'partielle' ? 'Partielle' : 'Impayée';

    return '<div class="purchase-row" data-purchase-id="' + id + '">' +
      '<div class="purchase-row-main">' +
        '<div class="purchase-row-header">' +
          '<strong>' + numero + '</strong>' +
          ' <span class="badge" style="background:' + statutColor + ';color:#fff">' +
          U.escapeHtml(statutLabel) + '</span>' +
        '</div>' +
        '<div class="purchase-row-meta">' +
          supplierName + ' · ' + U.escapeHtml(U.formatDate(_purchDate(p))) +
          (p.lines && p.lines.length ? ' · ' + p.lines.length + ' ligne(s)' : '') +
        '</div>' +
        '<div class="purchase-row-amounts">' +
          'Total : <strong>' + U.formatMoney(total) + '</strong>' +
          (reste > 0.001
            ? ' · Reste : <strong style="color:var(--danger)">' +
              U.formatMoney(reste) + '</strong>'
            : '') +
        '</div>' +
      '</div>' +
      '<div class="purchase-row-actions">' +
        '<button type="button" class="btn-icon" title="Éditer" ' +
        'onclick="VC.Purchases.openModal(\'' + id + '\')">✏️</button>' +
        (reste > 0.001
          ? '<button type="button" class="btn-icon" title="Payer" ' +
            'onclick="VC.Purchases.openPayment(\'' + id + '\')">💳</button>'
          : '') +
        '<button type="button" class="btn-icon" title="Attestation" ' +
        'onclick="VC.Purchases.printAttestation(\'' + id + '\')">📄</button>' +
        '<button type="button" class="btn-icon btn-danger" title="Supprimer" ' +
        'onclick="VC.Purchases.remove(\'' + id + '\')">🗑️</button>' +
      '</div>' +
    '</div>';
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 6 — MODAL SAISIE
     ═══════════════════════════════════════════════════════════ */

  Pur.openModal = function (id) {
    _editId = id ? String(id) : null;
    _modalLines = [];

    U.setVal('purchaseDate', U.todayISO());
    U.setVal('purchaseRef', '');
    U.setVal('purchaseTvaRate', String(VC.TVA_DEFAULT));
    U.setVal('purchaseTimbre', VC.TIMBRE_DEFAULT.toFixed(3));
    U.setVal('purchaseNotes', '');

    _populateSuppliersSelect('');
    _populateChantiersSelect('');

    U.setText('purchaseModalTitle', id ? 'Modifier achat' : 'Nouvel achat');
    U.setText('purchaseFormError', '');

    if (id) {
      var p = Pur.getById(id);
      if (!p) {
        U.toast('Achat introuvable.', 'error');
        return;
      }

      U.setVal('purchaseDate', _purchDate(p) || U.todayISO());
      U.setVal('purchaseRef', p.numero || p.refFacture || '');
      U.setVal('purchaseTvaRate', p.tvaRate != null ? p.tvaRate : VC.TVA_DEFAULT);
      U.setVal('purchaseTimbre', p.timbre != null ? p.timbre : VC.TIMBRE_DEFAULT);
      U.setVal('purchaseNotes', p.notes || '');
      _populateSuppliersSelect(p.supplierId || p.fournisseurId || '');
      _populateChantiersSelect(p.chantierId || '');

      if (Array.isArray(p.lines)) {
        for (var i = 0; i < p.lines.length; i++) {
          var l = p.lines[i];
          if (!l) continue;
          _modalLines.push({
            articleId: String(l.articleId || ''),
            designation: String(l.designation || ''),
            quantite: U.parseNumber(l.quantite),
            prixUnitaire: U.parseNumber(l.prixUnitaire != null ? l.prixUnitaire : l.prix),
            unite: String(l.unite || 'U')
          });
        }
      }
    }

    if (_modalLines.length === 0) {
      _modalLines.push({ articleId: '', designation: '', quantite: 1, prixUnitaire: 0, unite: 'U' });
    }

    _renderLines();
    _updateTotals();
    U.showFlex('purchaseModal');
  };

  Pur.closeModal = function () {
    U.hide('purchaseModal');
    _editId = null;
    _modalLines = [];
  };

  function _populateSuppliersSelect(selectedId) {
    var suppliers = S.getAll('suppliers').slice();
    suppliers.sort(function (a, b) {
      return U.normalizeText(a.nom || '') > U.normalizeText(b.nom || '') ? 1 : -1;
    });
    var items = [{ id: '', nom: '— Sélectionner —' }];
    for (var i = 0; i < suppliers.length; i++) {
      items.push({ id: suppliers[i].id, nom: suppliers[i].nom });
    }
    U.populateSelect('purchaseSupplierSelect', items, 'nom', 'id', selectedId || '');
  }

  function _populateChantiersSelect(selectedId) {
    var chantiers = S.getAll('chantiers').slice();
    chantiers.sort(function (a, b) {
      return U.normalizeText(a.nom || '') > U.normalizeText(b.nom || '') ? 1 : -1;
    });
    var items = [{ id: '', nom: '— Aucun —' }];
    for (var i = 0; i < chantiers.length; i++) {
      items.push({ id: chantiers[i].id, nom: chantiers[i].nom });
    }
    U.populateSelect('purchaseChantierSelect', items, 'nom', 'id', selectedId || '');
  }

  Pur.addLine = function () {
    _modalLines.push({
      articleId: '', designation: '', quantite: 1, prixUnitaire: 0, unite: 'U'
    });
    _renderLines();
    _updateTotals();
  };

  Pur.removeLine = function (index) {
    if (index < 0 || index >= _modalLines.length) return;
    _modalLines.splice(index, 1);
    if (_modalLines.length === 0) {
      _modalLines.push({ articleId: '', designation: '', quantite: 1, prixUnitaire: 0, unite: 'U' });
    }
    _renderLines();
    _updateTotals();
  };

  Pur.updateLine = function (index, field, value) {
    var l = _modalLines[index];
    if (!l) return;

    if (field === 'quantite' || field === 'prixUnitaire') {
      l[field] = U.parseNumber(value);
    } else {
      l[field] = String(value || '');
    }
    _updateTotals();
  };

  function _renderLines() {
    var tbody = document.getElementById('purchaseLinesBody');
    if (!tbody) return;

    var html = '';
    for (var i = 0; i < _modalLines.length; i++) {
      var l = _modalLines[i];
      var lt = U.parseNumber(l.quantite) * U.parseNumber(l.prixUnitaire);
      html += '<tr class="purchase-line-row">' +
        '<td><input type="text" value="' + U.escapeAttr(l.designation || '') + '" ' +
        'oninput="VC.Purchases.updateLine(' + i + ', \'designation\', this.value)" ' +
        'placeholder="Désignation"></td>' +
        '<td class="col-qte"><input type="number" min="0" step="0.01" value="' +
        U.escapeAttr(l.quantite || '') + '" ' +
        'oninput="VC.Purchases.updateLine(' + i + ', \'quantite\', this.value)"></td>' +
        '<td class="col-pu"><input type="number" min="0" step="0.001" value="' +
        U.escapeAttr(l.prixUnitaire || '') + '" ' +
        'oninput="VC.Purchases.updateLine(' + i + ', \'prixUnitaire\', this.value)"></td>' +
        '<td class="col-total">' + U.escapeHtml(U.formatMoney(lt)) + '</td>' +
        '<td><button type="button" class="btn-icon btn-danger" ' +
        'onclick="VC.Purchases.removeLine(' + i + ')">🗑️</button></td>' +
        '</tr>';
    }
    tbody.innerHTML = html;
  }

  function _updateTotals() {
    var tvaRate = U.getVal('purchaseTvaRate');
    var timbre = U.getVal('purchaseTimbre');
    var t = Pur.computeTotals(_modalLines, tvaRate, timbre);
    U.setText('purchaseTotalHT', U.formatMoney(t.totalHT));
    U.setText('purchaseTVA', U.formatMoney(t.tva));
    U.setText('purchaseTotalTTC', U.formatMoney(t.totalTTC));
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 7 — SAUVEGARDE (FIX C21)
     ═══════════════════════════════════════════════════════════ */

  Pur.save = function () {
    var errEl = document.getElementById('purchaseFormError');
    if (errEl) errEl.textContent = '';

    var supplierId = U.getVal('purchaseSupplierSelect');
    var date = U.getVal('purchaseDate');
    var ref = U.getVal('purchaseRef');
    var tvaRate = U.getVal('purchaseTvaRate');
    var timbre = U.getVal('purchaseTimbre');
    var chantierId = U.getVal('purchaseChantierSelect');
    var notes = U.getVal('purchaseNotes');

    if (!supplierId) {
      if (errEl) errEl.textContent = 'Sélectionne un fournisseur.';
      return;
    }
    if (!U.isValidDateString(date)) {
      if (errEl) errEl.textContent = 'Date invalide.';
      return;
    }

    /* Lignes valides */
    var validLines = [];
    for (var i = 0; i < _modalLines.length; i++) {
      var l = _modalLines[i];
      if (!l) continue;
      if (!String(l.designation || '').trim()) continue;
      if (U.parseNumber(l.quantite) <= 0) continue;
      validLines.push({
        articleId: String(l.articleId || ''),
        designation: String(l.designation).trim(),
        quantite: U.parseNumber(l.quantite),
        prixUnitaire: U.parseNumber(l.prixUnitaire),
        unite: String(l.unite || 'U'),
        total: U.parseNumber(l.quantite) * U.parseNumber(l.prixUnitaire)
      });
    }

    if (validLines.length === 0) {
      if (errEl) errEl.textContent = 'Ajoute au moins une ligne valide.';
      return;
    }

    var totals = Pur.computeTotals(validLines, tvaRate, timbre);
    var fournisseurNom = VC.Suppliers ? VC.Suppliers.getNom(supplierId) : '';

    /* FIX C21 : nettoyage externalPrices AVANT save */
    var existing = _editId ? Pur.getById(_editId) : null;
    if (existing) {
      var oldRef = existing.numero || existing.refFacture || '';
      var oldSupNom = _supplierName(existing);
      if (oldRef || oldSupNom) {
        Pur._cleanupExternalPrices(oldRef, oldSupNom);
      }
    }

    var doc = {
      numero: ref || '',
      refFacture: ref || '',
      supplierId: supplierId,
      fournisseurId: supplierId,
      fournisseur: fournisseurNom,
      date: date,
      chantierId: chantierId || '',
      tvaRate: totals.tvaRate,
      timbre: totals.timbre,
      notes: notes,
      lines: validLines,
      totals: totals,
      totalTTC: totals.totalTTC,
      total: totals.totalTTC,
      paiements: []
    };

    if (existing) {
      doc.id = existing.id;
      doc.createdAt = existing.createdAt;
      doc.paiements = Array.isArray(existing.paiements) ? existing.paiements.slice() : [];
    } else {
      if (!doc.numero) {
        doc.numero = 'ACH-' + new Date().getFullYear() + '-' +
          String(S.getAll('purchaseInvoices').length + 1).padStart(4, '0');
      }
      doc.createdAt = new Date().toISOString();
    }

    if (!S.save('purchaseInvoices', doc)) {
      if (errEl) errEl.textContent = 'Erreur de sauvegarde.';
      return;
    }

    /* Re-pousse les nouvelles entrées (après cleanup) */
    _recordExternalPrices(validLines, fournisseurNom, doc.numero, date);

    Pur.closeModal();
    Pur.render();
    U.toast(_editId ? 'Achat modifié' : 'Achat enregistré : ' + doc.numero,
      'success', 2500);
  };

  /**
   * FIX C21/C22 : supprime les entrées externalPrices correspondant à
   * (factureRef, fournisseur). Appelée avant re-push en édition et
   * avant suppression complète.
   */
  Pur._cleanupExternalPrices = function (factureRef, fournisseurNom) {
    if (!VC.Stock || typeof VC.Stock.cleanupExternalPricesFor !== 'function') return 0;
    return VC.Stock.cleanupExternalPricesFor(factureRef, fournisseurNom);
  };

  function _recordExternalPrices(lines, fournisseurNom, factureRef, date) {
    if (!VC.Stock || typeof VC.Stock.recordExternalPrice !== 'function') return;

    for (var i = 0; i < lines.length; i++) {
      var l = lines[i];
      if (!l.articleId || l.prixUnitaire <= 0) continue;
      try {
        VC.Stock.recordExternalPrice(
          l.articleId, l.prixUnitaire, fournisseurNom, factureRef, date
        );
      } catch (e) {
        VC.logError('14-purch', 'recordExternalPrice échoué', e);
      }
    }
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 8 — PAIEMENTS
     ═══════════════════════════════════════════════════════════ */

  Pur.openPayment = function (purchaseId) {
    var p = Pur.getById(purchaseId);
    if (!p) return;

    _currentPaymentId = String(purchaseId);
    var reste = Doc.getResteAPayer(p);

    U.setVal('supplierPaymentMontant', reste > 0 ? reste.toFixed(3) : '0.000');
    U.setVal('supplierPaymentDate', U.todayISO());
    U.setVal('supplierPaymentMode', 'virement');
    U.setVal('supplierPaymentNote', '');
    U.setText('supplierPaymentFormError', '');

    U.setText('supplierPaymentModalTitle',
      'Paiement fournisseur — ' + (p.numero || ''));

    U.showFlex('supplierPaymentModal');
  };

  Pur.savePayment = function () {
    var p = Pur.getById(_currentPaymentId);
    if (!p) return;

    var errEl = document.getElementById('supplierPaymentFormError');
    if (errEl) errEl.textContent = '';

    var montant = U.parseNumber(U.getVal('supplierPaymentMontant'));
    var date = U.getVal('supplierPaymentDate');
    var mode = U.getVal('supplierPaymentMode') || 'virement';
    var note = U.getVal('supplierPaymentNote');

    if (!(montant > 0)) {
      if (errEl) errEl.textContent = 'Montant > 0 requis.';
      return;
    }
    if (!U.isValidDateString(date)) {
      if (errEl) errEl.textContent = 'Date invalide.';
      return;
    }

    var reste = Doc.getResteAPayer(p);
    if (montant > reste + 0.01) {
      if (errEl) errEl.textContent = 'Montant > reste (' + U.formatMoney(reste) + ').';
      return;
    }

    if (!Array.isArray(p.paiements)) p.paiements = [];
    p.paiements.push({
      date: date,
      montant: montant,
      mode: mode,
      note: note,
      addedAt: new Date().toISOString()
    });

    if (!S.save('purchaseInvoices', p)) {
      U.toast('Erreur sauvegarde.', 'error');
      return;
    }

    U.hide('supplierPaymentModal');
    _currentPaymentId = null;
    Pur.render();
    U.toast('Paiement enregistré', 'success', 2500);
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 9 — ATTESTATION PDF
     ═══════════════════════════════════════════════════════════ */

  Pur.printAttestation = function (purchaseId) {
    var p = Pur.getById(purchaseId);
    if (!p) return;

    var supplier = p.supplierId ? VC.Suppliers.getById(p.supplierId) : null;
    var supplierName = _supplierName(p) || '—';
    var paid = Doc.getTotalPaye(p);
    var reste = Doc.getResteAPayer(p);
    var t = Pur.computeTotals(p.lines, p.tvaRate, p.timbre);

    var html = '<!DOCTYPE html><html><head><meta charset="UTF-8">' +
      '<title>Attestation — ' + U.escapeHtml(p.numero || '') + '</title><style>' +
      '@page{size:A4;margin:20mm}body{font-family:Arial;font-size:12px;color:#333;line-height:1.5}' +
      'h1{text-align:center;color:#1A2B4C;font-size:22px;margin-bottom:5px}' +
      '.subtitle{text-align:center;color:#666;margin-bottom:30px}' +
      '.box{padding:15px;background:#f5f7fb;border-left:3px solid #1A2B4C;margin:20px 0}' +
      'table{width:100%;border-collapse:collapse;margin:15px 0}' +
      'th,td{border:1px solid #ccc;padding:8px;text-align:left;font-size:11px}' +
      'th{background:#1A2B4C;color:#fff}.right{text-align:right}' +
      '.grand-total{background:#1A2B4C;color:#fff;font-weight:bold}' +
      '.footer{margin-top:40px;text-align:center;font-size:10px;color:#666}' +
      '.signature{margin-top:50px;display:flex;justify-content:space-between}' +
      '.signature-box{width:45%;height:100px;border:1px dashed #999;padding:10px;font-size:10px;color:#666}' +
      '</style></head><body>';

    html += '<h1>ATTESTATION</h1>';
    html += '<div class="subtitle">Facture fournisseur N° ' +
      U.escapeHtml(p.numero || '') + '</div>';

    html += '<div class="box">';
    html += '<strong>Fournisseur :</strong> ' + U.escapeHtml(supplierName) + '<br>';
    if (supplier && supplier.mf) {
      html += '<strong>MF :</strong> ' + U.escapeHtml(supplier.mf) + '<br>';
    }
    if (supplier && supplier.adresse) {
      html += '<strong>Adresse :</strong> ' + U.escapeHtml(supplier.adresse) + '<br>';
    }
    html += '<strong>Date facture :</strong> ' +
      U.escapeHtml(U.formatDate(_purchDate(p)));
    html += '</div>';

    html += '<table><thead><tr><th>Désignation</th><th class="right">Qté</th>' +
      '<th class="right">P.U.</th><th class="right">Total</th></tr></thead><tbody>';
    if (Array.isArray(p.lines)) {
      for (var i = 0; i < p.lines.length; i++) {
        var l = p.lines[i];
        if (!l) continue;
        var lt = U.parseNumber(l.quantite) *
          U.parseNumber(l.prixUnitaire != null ? l.prixUnitaire : l.prix);
        html += '<tr><td>' + U.escapeHtml(l.designation || '') + '</td>' +
          '<td class="right">' + U.parseNumber(l.quantite) + '</td>' +
          '<td class="right">' + U.formatMoney(U.parseNumber(l.prixUnitaire || l.prix)) + '</td>' +
          '<td class="right">' + U.formatMoney(lt) + '</td></tr>';
      }
    }
    html += '</tbody></table>';

    html += '<table><tbody>';
    html += '<tr><td>Total HT</td><td class="right">' + U.formatMoney(t.totalHT) + '</td></tr>';
    html += '<tr><td>TVA (' + t.tvaRate + '%)</td><td class="right">' +
      U.formatMoney(t.tva) + '</td></tr>';
    html += '<tr><td>Timbre</td><td class="right">' + U.formatMoney(t.timbre) + '</td></tr>';
    html += '<tr class="grand-total"><td>TOTAL TTC</td><td class="right">' +
      U.formatMoney(t.totalTTC) + '</td></tr>';
    html += '<tr><td>Déjà payé</td><td class="right">' + U.formatMoney(paid) + '</td></tr>';
    html += '<tr><td><strong>Reste à payer</strong></td><td class="right"><strong>' +
      U.formatMoney(reste) + '</strong></td></tr>';
    html += '</tbody></table>';

    html += '<div class="footer">Fait à Sfax, le ' +
      U.escapeHtml(U.formatDate(U.todayISO())) +
      '<br>VOLTCORE INGENIERIE</div>';

    html += '<div class="signature">' +
      '<div class="signature-box">Cachet & signature fournisseur</div>' +
      '<div class="signature-box">Cachet & signature VOLTCORE</div>' +
      '</div>';

    html += '</body></html>';

    var w = global.open('', '_blank');
    if (!w) {
      U.toast('Autorise les pop-ups pour imprimer.', 'warning', 4000);
      return;
    }
    w.document.open();
    w.document.write(html);
    w.document.close();
    setTimeout(function () {
      try { w.focus(); w.print(); } catch (e) {
        VC.logError('14-purch', 'print attestation échoué', e);
      }
    }, 400);
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 10 — SUPPRESSION (FIX C22)
     ═══════════════════════════════════════════════════════════ */

  Pur.remove = function (purchaseId) {
    var p = Pur.getById(purchaseId);
    if (!p) return;

    if (!U.confirm('Supprimer l\'achat "' + (p.numero || '') + '" ?')) return;

    /* FIX C22 : nettoyage externalPrices AVANT suppression */
    var ref = p.numero || p.refFacture || '';
    var supNom = _supplierName(p);
    if (ref || supNom) {
      Pur._cleanupExternalPrices(ref, supNom);
    }

    if (!S.delete('purchaseInvoices', purchaseId)) {
      U.toast('Erreur suppression.', 'error');
      return;
    }

    Pur.render();

    U.toastUndo('Achat supprimé : ' + (p.numero || ''), function () {
      var entries = S.getTrashEntries('purchaseInvoices');
      for (var i = 0; i < entries.length; i++) {
        if (entries[i].item && String(entries[i].item.id) === String(purchaseId)) {
          S.restoreFromTrash('purchaseInvoices', i);
          /* Re-pousse les externalPrices restaurées */
          _recordExternalPrices(
            p.lines || [], _supplierName(p), ref, _purchDate(p)
          );
          Pur.render();
          U.toast('Achat restauré', 'success', 2000);
          return;
        }
      }
    }, 5000);
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 11 — FILTRES
     ═══════════════════════════════════════════════════════════ */

  Pur.setSearch = function (term) {
    _searchTerm = String(term || '');
    Pur.render();
  };

  Pur.setFilter = function (filter) {
    _filter = String(filter || 'all');
    Pur.render();
  };

  Pur.getFiltered = function () {
    var out = S.getAll('purchaseInvoices').slice();

    if (_searchTerm) {
      var term = U.normalizeText(_searchTerm);
      out = out.filter(function (p) {
        if (!p) return false;
        var sn = _supplierName(p);
        var hay = U.normalizeText([p.numero, p.refFacture, sn, p.notes].join(' '));
        return hay.indexOf(term) >= 0;
      });
    }

    if (_filter === 'impayees') {
      out = out.filter(function (p) {
        var s = Doc.getStatutPaiement(p);
        return s === 'impayee' || s === 'partielle';
      });
    } else if (_filter === 'payees') {
      out = out.filter(function (p) {
        return Doc.getStatutPaiement(p) === 'payee';
      });
    } else if (_filter === 'mois_courant') {
      var prefix = U.todayISO().slice(0, 7);
      out = out.filter(function (p) {
        return _purchDate(p).slice(0, 7) === prefix;
      });
    }

    out.sort(function (a, b) {
      var da = _purchDate(a), db = _purchDate(b);
      return da < db ? 1 : (da > db ? -1 : 0);
    });

    return out;
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 12 — IMPORT / EXPORT
     ═══════════════════════════════════════════════════════════ */

  Pur.exportJSON = function () {
    var arr = S.getAll('purchaseInvoices');
    var data = {
      version: 1,
      exportedAt: new Date().toISOString(),
      count: arr.length,
      purchases: arr
    };
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    U.downloadBlob(blob, 'voltcore-achats-' + U.todayISO() + '.json');
    U.toast(arr.length + ' achat(s) exporté(s)', 'success');
  };

  Pur.importJSON = function (file) {
    return new Promise(function (resolve, reject) {
      if (!file) {
        reject(new Error('Fichier requis'));
        return;
      }

      var reader = new FileReader();
      reader.onload = function (ev) {
        try {
          var parsed = JSON.parse(ev.target.result);
          var arr = Array.isArray(parsed) ? parsed
            : (parsed && Array.isArray(parsed.purchases)) ? parsed.purchases : null;
          if (!arr) {
            reject(new Error('Format invalide : purchases[] attendu'));
            return;
          }

          var added = 0, invalid = 0;
          for (var i = 0; i < arr.length; i++) {
            var p = arr[i];
            if (!p || typeof p !== 'object') { invalid++; continue; }
            if (!Array.isArray(p.lines)) p.lines = [];
            if (!Array.isArray(p.paiements)) p.paiements = [];
            if (S.save('purchaseInvoices', p)) added++;
            else invalid++;
          }

          Pur.render();

          var msg = added + ' achat(s) importé(s)';
          if (invalid > 0) msg += ' · ' + invalid + ' invalide(s)';
          U.toast(msg, added > 0 ? 'success' : 'warning', 4000);

          resolve({ added: added, invalid: invalid });
        } catch (err) {
          VC.logError('14-purch', 'importJSON parse échoué', err);
          reject(err);
        }
      };
      reader.onerror = function () {
        reject(reader.error || new Error('Lecture échouée'));
      };
      reader.readAsText(file);
    });
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 13 — IMPRESSION LISTE
     ═══════════════════════════════════════════════════════════ */

  Pur.printList = function () {
    var list = Pur.getFiltered();
    var html = '<!DOCTYPE html><html><head><meta charset="UTF-8">' +
      '<title>Achats — VOLTCORE</title><style>' +
      'body{font-family:Arial;margin:20px;font-size:11px}' +
      'h1{color:#1A2B4C;border-bottom:2px solid #1A2B4C;padding-bottom:6px}' +
      'table{width:100%;border-collapse:collapse;margin-top:10px}' +
      'th,td{border:1px solid #ccc;padding:6px;text-align:left}' +
      'th{background:#1A2B4C;color:#fff}.right{text-align:right}' +
      '</style></head><body>';
    html += '<h1>Achats fournisseurs</h1><div>Total : ' + list.length +
      ' · ' + U.todayISO() + '</div>';
    html += '<table><thead><tr><th>Réf</th><th>Fournisseur</th><th>Date</th>' +
      '<th class="right">HT</th><th class="right">TVA</th><th class="right">TTC</th>' +
      '<th class="right">Payé</th><th class="right">Reste</th></tr></thead><tbody>';

    var sumHT = 0, sumTVA = 0, sumTTC = 0, sumPaid = 0, sumReste = 0;

    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      var t = Pur.computeTotals(p.lines, p.tvaRate, p.timbre);
      var paid = Doc.getTotalPaye(p);
      var reste = Doc.getResteAPayer(p);
      sumHT += t.totalHT;
      sumTVA += t.tva;
      sumTTC += t.totalTTC;
      sumPaid += paid;
      sumReste += reste;

      html += '<tr><td>' + U.escapeHtml(p.numero || '') + '</td>' +
        '<td>' + U.escapeHtml(_supplierName(p) || '—') + '</td>' +
        '<td>' + U.escapeHtml(U.formatDate(_purchDate(p))) + '</td>' +
        '<td class="right">' + U.formatMoney(t.totalHT) + '</td>' +
        '<td class="right">' + U.formatMoney(t.tva) + '</td>' +
        '<td class="right">' + U.formatMoney(t.totalTTC) + '</td>' +
        '<td class="right">' + U.formatMoney(paid) + '</td>' +
        '<td class="right">' + U.formatMoney(reste) + '</td></tr>';
    }
    html += '<tr style="background:#f0f0f0;font-weight:bold">' +
      '<td colspan="3">TOTAUX</td>' +
      '<td class="right">' + U.formatMoney(sumHT) + '</td>' +
      '<td class="right">' + U.formatMoney(sumTVA) + '</td>' +
      '<td class="right">' + U.formatMoney(sumTTC) + '</td>' +
      '<td class="right">' + U.formatMoney(sumPaid) + '</td>' +
      '<td class="right">' + U.formatMoney(sumReste) + '</td></tr>';
    html += '</tbody></table></body></html>';

    var w = global.open('', '_blank');
    if (!w) {
      U.toast('Autorise les pop-ups pour imprimer.', 'warning');
      return;
    }
    w.document.write(html);
    w.document.close();
    setTimeout(function () {
      try { w.print(); } catch (e) {
        VC.logError('14-purch', 'print list échoué', e);
      }
    }, 500);
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 14 — EVENTS
     ═══════════════════════════════════════════════════════════ */

  Pur.attachEvents = function () {
    U.on('purchasesSearchInput', 'input', U.debounce(function (ev) {
      Pur.setSearch(ev.target.value);
    }, 250));

    U.on('purchasesFilterSelect', 'change', function (ev) {
      Pur.setFilter(ev.target.value);
    });

    U.on('btnAddPurchase', 'click', function () {
      Pur.openModal(null);
    });

    U.on('btnAddPurchaseLine', 'click', Pur.addLine);
    U.on('purchaseSaveBtn', 'click', Pur.save);
    U.on('supplierPaymentSaveBtn', 'click', Pur.savePayment);

    /* Recalcul totaux au change des inputs TVA/timbre */
    U.on('purchaseTvaRate', 'input', _updateTotals);
    U.on('purchaseTimbre', 'input', _updateTotals);

    U.on('btnImportPurchases', 'click', function () {
      var input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json,application/json';
      input.onchange = function (ev) {
        var f = ev.target.files && ev.target.files[0];
        if (!f) return;
        Pur.importJSON(f).catch(function (err) {
          U.toast('Import échoué : ' + (err.message || ''), 'error');
        });
      };
      input.click();
    });

    U.on('btnExportPurchases', 'click', Pur.exportJSON);
    U.on('btnPrintPurchases', 'click', Pur.printList);

    /* Subscribe : re-render auto */
    S.subscribe('purchaseInvoices', function () {
      Pur.render();
    });
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 15 — MARQUEUR
     ═══════════════════════════════════════════════════════════ */

  VC._purchLoaded = true;

  VC.logInfo('14-purch', 'Module chargé (cleanup externalPrices C21/C22)');

})(window);