/* ═══════════════════════════════════════════════════════════════
   VOLTCORE — 13-purchases.js
   VERSION : v6.7 (Session #3 — fix syntax error LOT 5, fichier
                   restauré + fallback export honnête)
   RÔLE : Achats fournisseurs, TVA déductible, paiements, attestation,
          alimentation comparateur prix + alertes + suppression undo
   DÉPENDANCES : 01-core.js (purchaseInvoices, purchaseModalLines,
                            editingPurchaseInvoiceId,
                            currentSupplierPaymentInvoiceId), 03-utils.js,
                            04-storage.js (saveAll, recordExternalPrice,
                            getTotalPaye, getResteAPayer,
                            getStatutPaiement), 07-suppliers.js,
                            08-stock.js
      EXPOSE : getPurchaseById, computePurchaseTotals, getTvaDeductibleFor,
            renderPurchases,
            renderPurchaseRow, openPurchaseModal, closePurchaseModal,
            addPurchaseLine, removePurchaseLine, updatePurchaseLine,
            renderPurchaseLines, savePurchaseInvoice,
            openPurchasePayment, savePurchasePayment,
            deletePurchaseInvoice, printPurchaseAttestation,
            setPurchasesSearch, setPurchasesFilter,
            getFilteredPurchases,
            exportPurchasesJSON, importPurchasesJSON,
            printPurchasesList, attachPurchasesEvents
   SECTION 1  : CONSTANTES
   SECTION 2  : HELPERS
   SECTION 3  : CALCULS (TVA déductible)
   SECTION 4  : RENDU LISTE
   SECTION 5  : MODAL SAISIE (lignes dynamiques)
   SECTION 6  : PAIEMENTS
   SECTION 7  : ATTESTATION
   SECTION 8  : SUPPRESSION + UNDO
   SECTION 9  : FILTRES + RECHERCHE
   SECTION 10 : IMPORT / EXPORT
   SECTION 11 : ÉVÉNEMENTS
   ═══════════════════════════════════════════════════════════════ */

/* ═══════════ SECTION 1 — CONSTANTES ═══════════ */

var __purchasesSearchTerm = '';
var __purchasesFilter = 'all';
var VOLTCORE_PURCHASE_TVA = 19;
var VOLTCORE_PURCHASE_TIMBRE = 1.000;

/* ═══════════ SECTION 2 — HELPERS ═══════════ */

function getPurchaseById(id) {
  try {
    if (!id || !Array.isArray(purchaseInvoices)) return null;
    var sid = String(id);
    for (var i = 0; i < purchaseInvoices.length; i++) {
      if (purchaseInvoices[i] && String(purchaseInvoices[i].id) === sid) return purchaseInvoices[i];
    }
    return null;
  } catch (e) { return null; }
}

function _purchGet(id) {
  try { var el = document.getElementById(id); return el ? String(el.value || '').trim() : ''; } catch (e) { return ''; }
}

function _purchSet(id, value) {
  try { var el = document.getElementById(id); if (el) el.value = value == null ? '' : value; } catch (e) {}
}

function _purchText(id, text) {
  try { var el = document.getElementById(id); if (el) el.textContent = String(text || ''); } catch (e) {}
}

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

function _purchSupplier(p) {
  if (!p) return null;
  var sid = p.supplierId || p.fournisseurId;
  if (sid && typeof getSupplierById === 'function') return getSupplierById(sid);
  return null;
}

function _purchSupplierName(p) {
  var f = _purchSupplier(p);
  if (f) return String(f.nom || '');
  if (p && p.fournisseur) return String(p.fournisseur);
  return '';
}

function _purchIsPaid(p) {
  var statut = (typeof getStatutPaiement === 'function') ? getStatutPaiement(p) : 'impayee';
  return statut === 'payee';
}

/* ═══════════ SECTION 3 — CALCULS (TVA déductible) ═══════════ */

/* Calcule les totaux d'un achat depuis ses lignes.
   Formule identique à L11 : HT + TVA + Timbre. */
function computePurchaseTotals(lines, tvaRate, timbre) {
  try {
    var arr = Array.isArray(lines) ? lines : [];
    var totalHT = 0;
    for (var i = 0; i < arr.length; i++) {
      var l = arr[i];
      if (!l) continue;
      var q = parseNumber(l.quantite);
      var pu = parseNumber(l.prixUnitaire || l.prix);
      if (q > 0 && pu >= 0) totalHT += q * pu;
    }
    var tvaPct = parseNumber(tvaRate);
    if (!isFinite(tvaPct) || tvaPct < 0) tvaPct = VOLTCORE_PURCHASE_TVA;
    var timbreM = parseNumber(timbre);
    if (!isFinite(timbreM) || timbreM < 0) timbreM = VOLTCORE_PURCHASE_TIMBRE;

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
  } catch (e) {
    console.warn('computePurchaseTotals :', e);
    return { totalHT: 0, tvaRate: 0, tva: 0, timbre: 0, totalTTC: 0, total: 0 };
  }
}

/* Récap TVA déductible sur une période (mois YYYY-MM). */
function getTvaDeductibleFor(monthIso) {
  try {
    var totalHT = 0, totalTVA = 0, count = 0;
    if (!Array.isArray(purchaseInvoices)) return { totalHT: 0, totalTVA: 0, count: 0 };
    var prefix = String(monthIso || '').slice(0, 7);
    for (var i = 0; i < purchaseInvoices.length; i++) {
      var p = purchaseInvoices[i];
      if (!p) continue;
      var d = _purchDate(p);
      if (prefix && d.slice(0, 7) !== prefix) continue;
      var t = computePurchaseTotals(p.lines, p.tvaRate, p.timbre);
      totalHT += t.totalHT;
      totalTVA += t.tva;
      count++;
    }
    return { totalHT: totalHT, totalTVA: totalTVA, count: count };
  } catch (e) {
    console.warn('getTvaDeductibleFor :', e);
    return { totalHT: 0, totalTVA: 0, count: 0 };
  }
}

/* ═══════════ SECTION 4 — RENDU LISTE ═══════════ */

function renderPurchases() {
  try {
    var container = document.getElementById('purchasesList');
    if (!container) return;

    var list = getFilteredPurchases();
    if (list.length === 0) {
      container.innerHTML = '<div class="empty-state">Aucun achat' +
        (__purchasesSearchTerm || __purchasesFilter !== 'all' ? ' pour ce filtre' : '') +
        '. Clique sur "+ Nouvel achat" pour enregistrer une facture fournisseur.</div>';
      _updatePurchasesCount(0);
      _updatePurchasesSummary(0, 0, 0);
      return;
    }

    var html = '', totalHT = 0, totalTTC = 0;
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      totalHT += computePurchaseTotals(p.lines, p.tvaRate, p.timbre).totalHT;
      totalTTC += _purchTotal(p);
      html += renderPurchaseRow(p);
    }
    container.innerHTML = html;
    _updatePurchasesCount(list.length);
    /* v6.7.1 — Calcule la vraie TVA (hors timbre) en sommant les lignes. */
var _totalTVA = 0;
for (var ii = 0; ii < list.length; ii++) {
  _totalTVA += computePurchaseTotals(list[ii].lines, list[ii].tvaRate, list[ii].timbre).tva;
}
_updatePurchasesSummary(totalHT, _totalTVA, totalTTC);
  } catch (e) { console.warn('renderPurchases :', e); }
}

function renderPurchaseRow(p) {
  try {
    if (!p) return '';
    var id = escapeAttr(p.id);
    var supplierName = escapeHtml(_purchSupplierName(p) || '—');
    var numero = escapeHtml(p.numero || p.refFacture || '—');
    var total = _purchTotal(p);
    var paid = (typeof getTotalPaye === 'function') ? getTotalPaye(p) : 0;
    var reste = (typeof getResteAPayer === 'function') ? getResteAPayer(p) : 0;
    var statut = (typeof getStatutPaiement === 'function') ? getStatutPaiement(p) : 'impayee';

    var statutColor = statut === 'payee' ? 'var(--success)'
                    : statut === 'partielle' ? 'var(--warning)'
                    : 'var(--danger)';

    return '<div class="purchase-row" data-purchase-id="' + id + '">' +
      '<div class="purchase-row-main">' +
        '<div class="purchase-row-header">' +
          '<strong>' + numero + '</strong>' +
          ' <span class="badge" style="background:' + statutColor + ';color:#fff">' +
          escapeHtml(_purchStatutLabel(statut)) + '</span>' +
        '</div>' +
        '<div class="purchase-row-meta">' +
          supplierName + ' · ' + escapeHtml(formatDate(_purchDate(p))) +
          (p.lines && p.lines.length ? ' · ' + p.lines.length + ' ligne(s)' : '') +
        '</div>' +
        '<div class="purchase-row-amounts">' +
          'Total : <strong>' + formatMoney(total) + '</strong>' +
          (reste > 0.001 ? ' · Reste : <strong style="color:var(--danger)">' +
            formatMoney(reste) + '</strong>' : '') +
        '</div>' +
      '</div>' +
      '<div class="purchase-row-actions">' +
        '<button type="button" class="btn-icon" title="Éditer" onclick="openPurchaseModal(\'' + id + '\')">✏️</button>' +
        (reste > 0.001
          ? '<button type="button" class="btn-icon" title="Payer" onclick="openPurchasePayment(\'' + id + '\')">💳</button>'
          : '') +
        '<button type="button" class="btn-icon" title="Attestation" onclick="printPurchaseAttestation(\'' + id + '\')">📄</button>' +
        '<button type="button" class="btn-icon btn-danger" title="Supprimer" onclick="deletePurchaseInvoice(\'' + id + '\')">🗑️</button>' +
      '</div>' +
    '</div>';
  } catch (e) { console.warn('renderPurchaseRow :', e); return ''; }
}

function _purchStatutLabel(s) {
  var m = { payee: 'Payée', partielle: 'Partielle', impayee: 'Impayée', annulee: 'Annulée' };
  return m[s] || s;
}

function _updatePurchasesCount(n) {
  try { var el = document.getElementById('purchasesCount'); if (el) el.textContent = String(n); } catch (e) {}
}

function _updatePurchasesSummary(ht, tva, ttc) {
  try {
    _purchText('purchasesTotalHT', formatMoney(ht));
    _purchText('purchasesTotalTVA', formatMoney(tva));
    _purchText('purchasesTotalTTC', formatMoney(ttc));
  } catch (e) {}
}

/* ═══════════ SECTION 5 — MODAL SAISIE ═══════════ */

function openPurchaseModal(purchaseId) {
  try {
    editingPurchaseInvoiceId = purchaseId ? String(purchaseId) : null;
    purchaseModalLines = [];

    _purchSet('purchaseDate', todayISO());
    _purchSet('purchaseRef', '');
    _purchSet('purchaseTvaRate', String(VOLTCORE_PURCHASE_TVA));
    _purchSet('purchaseTimbre', VOLTCORE_PURCHASE_TIMBRE.toFixed(3));
    _purchSet('purchaseNotes', '');

    _populatePurchaseSupplierSelect('');
    _populatePurchaseChantierSelect('');

    var title = document.getElementById('purchaseModalTitle');
    if (title) title.textContent = purchaseId ? 'Modifier achat' : 'Nouvel achat';

    var errEl = document.getElementById('purchaseFormError');
    if (errEl) errEl.textContent = '';

    if (purchaseId) {
      var p = getPurchaseById(purchaseId);
      if (!p) return;
      _purchSet('purchaseDate', _purchDate(p) || todayISO());
      _purchSet('purchaseRef', p.numero || p.refFacture || '');
      _purchSet('purchaseTvaRate', p.tvaRate != null ? p.tvaRate : VOLTCORE_PURCHASE_TVA);
      _purchSet('purchaseTimbre', p.timbre != null ? p.timbre : VOLTCORE_PURCHASE_TIMBRE);
      _purchSet('purchaseNotes', p.notes || '');
      _populatePurchaseSupplierSelect(p.supplierId || p.fournisseurId || '');
      _populatePurchaseChantierSelect(p.chantierId || '');

      if (Array.isArray(p.lines)) {
        for (var i = 0; i < p.lines.length; i++) {
          var l = p.lines[i];
          if (!l) continue;
          purchaseModalLines.push({
            articleId: String(l.articleId || ''),
            designation: String(l.designation || ''),
            quantite: parseNumber(l.quantite),
            prixUnitaire: parseNumber(l.prixUnitaire || l.prix),
            unite: String(l.unite || 'U')
          });
        }
      }
    }

    if (purchaseModalLines.length === 0) {
      purchaseModalLines.push({ articleId: '', designation: '', quantite: 1, prixUnitaire: 0, unite: 'U' });
    }

    renderPurchaseLines();
    updatePurchaseTotals();
    _bindPurchaseLineHandlers();

    var modal = document.getElementById('purchaseModal');
    if (modal) modal.style.display = 'flex';
  } catch (e) { console.warn('openPurchaseModal :', e); }
}

function closePurchaseModal() {
  try {
    var m = document.getElementById('purchaseModal');
    if (m) m.style.display = 'none';
    editingPurchaseInvoiceId = null;
    purchaseModalLines = [];
  } catch (e) {}
}

function _populatePurchaseSupplierSelect(selectedId) {
  try {
    var sel = document.getElementById('purchaseSupplierSelect');
    if (!sel) return;
    var html = '<option value="">— Sélectionner —</option>';
    if (Array.isArray(suppliers)) {
      var sorted = suppliers.slice().sort(function (a, b) {
        return normalizeText(a.nom || '') > normalizeText(b.nom || '') ? 1 : -1;
      });
      for (var i = 0; i < sorted.length; i++) {
        var f = sorted[i];
        var sid = String(f.id);
        html += '<option value="' + escapeAttr(sid) + '"' +
          (sid === String(selectedId || '') ? ' selected' : '') + '>' +
          escapeHtml(f.nom || '') + '</option>';
      }
    }
    sel.innerHTML = html;
  } catch (e) { console.warn('_populatePurchaseSupplierSelect :', e); }
}

function _populatePurchaseChantierSelect(selectedId) {
  try {
    var sel = document.getElementById('purchaseChantierSelect');
    if (!sel) return;
    var html = '<option value="">— Aucun —</option>';
    if (Array.isArray(savedChantiers)) {
      for (var i = 0; i < savedChantiers.length; i++) {
        var ch = savedChantiers[i];
        var sid = String(ch.id);
        html += '<option value="' + escapeAttr(sid) + '"' +
          (sid === String(selectedId || '') ? ' selected' : '') + '>' +
          escapeHtml(ch.nom || '') + '</option>';
      }
    }
    sel.innerHTML = html;
  } catch (e) {}
}

function addPurchaseLine() {
  try {
    purchaseModalLines.push({ articleId: '', designation: '', quantite: 1, prixUnitaire: 0, unite: 'U' });
    renderPurchaseLines();
    updatePurchaseTotals();
  } catch (e) { console.warn('addPurchaseLine :', e); }
}

function removePurchaseLine(index) {
  try {
    if (!Array.isArray(purchaseModalLines)) return;
    if (index < 0 || index >= purchaseModalLines.length) return;
    purchaseModalLines.splice(index, 1);
    if (purchaseModalLines.length === 0) {
      purchaseModalLines.push({ articleId: '', designation: '', quantite: 1, prixUnitaire: 0, unite: 'U' });
    }
    renderPurchaseLines();
    updatePurchaseTotals();
  } catch (e) { console.warn('removePurchaseLine :', e); }
}

function updatePurchaseLine(index, field, value) {
  try {
    if (!Array.isArray(purchaseModalLines)) return;
    var l = purchaseModalLines[index];
    if (!l) return;
    if (field === 'quantite' || field === 'prixUnitaire') {
      l[field] = parseNumber(value);
    } else {
      l[field] = String(value || '');
    }
    updatePurchaseTotals();
  } catch (e) { console.warn('updatePurchaseLine :', e); }
}

function renderPurchaseLines() {
  try {
    var tbody = document.getElementById('purchaseLinesBody');
    if (!tbody) return;
    var html = '';
    for (var i = 0; i < purchaseModalLines.length; i++) {
      var l = purchaseModalLines[i];
      var lt = parseNumber(l.quantite) * parseNumber(l.prixUnitaire);
      html += '<tr class="purchase-line-row">' +
        '<td><input type="text" value="' + escapeAttr(l.designation || '') + '" ' +
        'oninput="updatePurchaseLine(' + i + ', \'designation\', this.value)" placeholder="Désignation"></td>' +
        '<td class="col-qte"><input type="number" min="0" step="0.01" value="' +
        escapeAttr(l.quantite || '') + '" oninput="updatePurchaseLine(' + i + ', \'quantite\', this.value)"></td>' +
        '<td class="col-pu"><input type="number" min="0" step="0.001" value="' +
        escapeAttr(l.prixUnitaire || '') + '" oninput="updatePurchaseLine(' + i + ', \'prixUnitaire\', this.value)"></td>' +
        '<td class="col-total">' + escapeHtml(formatMoney(lt)) + '</td>' +
        '<td><button type="button" class="btn-icon btn-danger" ' +
        'onclick="removePurchaseLine(' + i + ')">🗑️</button></td>' +
        '</tr>';
    }
    tbody.innerHTML = html;
  } catch (e) { console.warn('renderPurchaseLines :', e); }
}

function updatePurchaseTotals() {
  try {
    var tvaRate = _purchGet('purchaseTvaRate');
    var timbre = _purchGet('purchaseTimbre');
    var t = computePurchaseTotals(purchaseModalLines, tvaRate, timbre);
    _purchText('purchaseTotalHT', formatMoney(t.totalHT));
    _purchText('purchaseTVA', formatMoney(t.tva));
    _purchText('purchaseTotalTTC', formatMoney(t.totalTTC));
  } catch (e) { console.warn('updatePurchaseTotals :', e); }
}

function _bindPurchaseLineHandlers() {
  try {
    var tvaInp = document.getElementById('purchaseTvaRate');
    if (tvaInp && !tvaInp.__bound) {
      tvaInp.__bound = true;
      tvaInp.addEventListener('input', updatePurchaseTotals);
    }
    var timbreInp = document.getElementById('purchaseTimbre');
    if (timbreInp && !timbreInp.__bound) {
      timbreInp.__bound = true;
      timbreInp.addEventListener('input', updatePurchaseTotals);
    }
  } catch (e) {}
}

function savePurchaseInvoice() {
  try {
    var errEl = document.getElementById('purchaseFormError');
    var supplierId = _purchGet('purchaseSupplierSelect');
    var date = _purchGet('purchaseDate');
    var ref = _purchGet('purchaseRef');
    var tvaRate = _purchGet('purchaseTvaRate');
    var timbre = _purchGet('purchaseTimbre');
    var chantierId = _purchGet('purchaseChantierSelect');
    var notes = _purchGet('purchaseNotes');

    if (!supplierId) { if (errEl) errEl.textContent = 'Sélectionne un fournisseur.'; return; }
    if (!isValidDateString(date)) { if (errEl) errEl.textContent = 'Date invalide.'; return; }

    var validLines = [];
    for (var i = 0; i < purchaseModalLines.length; i++) {
      var l = purchaseModalLines[i];
      if (!l) continue;
      if (!String(l.designation || '').trim()) continue;
      if (parseNumber(l.quantite) <= 0) continue;
      validLines.push({
        articleId: String(l.articleId || ''),
        designation: String(l.designation).trim(),
        quantite: parseNumber(l.quantite),
        prixUnitaire: parseNumber(l.prixUnitaire),
        unite: String(l.unite || 'U'),
        total: parseNumber(l.quantite) * parseNumber(l.prixUnitaire)
      });
    }
    if (validLines.length === 0) { if (errEl) errEl.textContent = 'Ajoute au moins une ligne valide.'; return; }

    var totals = computePurchaseTotals(validLines, tvaRate, timbre);

    var doc = {
      id: '',
      numero: ref || '',
      refFacture: ref || '',
      supplierId: supplierId,
      fournisseurId: supplierId,
      fournisseur: (typeof getSupplierName === 'function') ? getSupplierName(supplierId) : '',
      date: date,
      chantierId: chantierId || '',
      tvaRate: totals.tvaRate,
      timbre: totals.timbre,
      notes: notes,
      lines: validLines,
      totals: totals,
      totalTTC: totals.totalTTC,
      total: totals.totalTTC,
      paiements: [],
      createdAt: '',
      updatedAt: new Date().toISOString()
    };

    var editId = editingPurchaseInvoiceId;
    if (editId) {
      var existing = getPurchaseById(editId);
      if (!existing) { if (errEl) errEl.textContent = 'Achat introuvable.'; return; }
      doc.id = existing.id;
      doc.createdAt = existing.createdAt;
      doc.paiements = Array.isArray(existing.paiements) ? existing.paiements.slice() : [];
      var idx = purchaseInvoices.indexOf(existing);
      purchaseInvoices[idx] = doc;
    } else {
      doc.id = 'pur_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      doc.numero = ref || ('ACH-' + new Date().getFullYear() + '-' + String(purchaseInvoices.length + 1).padStart(4, '0'));
      doc.createdAt = new Date().toISOString();
      purchaseInvoices.push(doc);
    }

    /* Alimentation du comparateur de prix + alertes (L4, L5, L7) */
    if (typeof recordExternalPrice === 'function') {
      for (var k = 0; k < validLines.length; k++) {
        var vl = validLines[k];
        if (vl.articleId && vl.prixUnitaire > 0) {
          try {
            recordExternalPrice(vl.articleId, vl.prixUnitaire,
              doc.fournisseur, doc.numero, doc.date);
          } catch (err) { console.warn('recordExternalPrice :', err); }
        }
      }
    }

    if (typeof saveAll === 'function') saveAll();
    if (typeof logAction === 'function') {
      logAction(editId ? 'purchase.update' : 'purchase.create',
        doc.numero + ' ' + formatMoney(totals.totalTTC));
    }

    closePurchaseModal();
    renderPurchases();
    if (typeof showToast === 'function') {
      showToast(editId ? 'Achat modifié' : 'Achat enregistré : ' + doc.numero, 'success', 3000);
    }
  } catch (e) {
    console.warn('savePurchaseInvoice :', e);
    var errEl2 = document.getElementById('purchaseFormError');
    if (errEl2) errEl2.textContent = 'Erreur lors de l\'enregistrement.';
  }
}

/* ═══════════ SECTION 6 — PAIEMENTS ═══════════ */

function openPurchasePayment(purchaseId) {
  try {
    var p = getPurchaseById(purchaseId);
    if (!p) return;
    currentSupplierPaymentInvoiceId = String(purchaseId);

    var reste = (typeof getResteAPayer === 'function') ? getResteAPayer(p) : 0;
    _purchSet('supplierPaymentMontant', reste > 0 ? reste.toFixed(3) : '0.000');
    _purchSet('supplierPaymentDate', todayISO());
    _purchSet('supplierPaymentMode', 'virement');
    _purchSet('supplierPaymentNote', '');

    var errEl = document.getElementById('supplierPaymentFormError');
    if (errEl) errEl.textContent = '';

    var title = document.getElementById('supplierPaymentModalTitle');
    if (title) title.textContent = 'Paiement fournisseur — ' + (p.numero || '');

    var modal = document.getElementById('supplierPaymentModal');
    if (modal) modal.style.display = 'flex';
  } catch (e) { console.warn('openPurchasePayment :', e); }
}

function savePurchasePayment() {
  try {
    var p = getPurchaseById(currentSupplierPaymentInvoiceId);
    if (!p) return;

    var errEl = document.getElementById('supplierPaymentFormError');
    var montant = parseNumber(_purchGet('supplierPaymentMontant'));
    var date = _purchGet('supplierPaymentDate');
    var mode = _purchGet('supplierPaymentMode') || 'virement';
    var note = _purchGet('supplierPaymentNote');

    if (!(montant > 0)) { if (errEl) errEl.textContent = 'Montant > 0 requis.'; return; }
    if (!isValidDateString(date)) { if (errEl) errEl.textContent = 'Date invalide.'; return; }
    var reste = (typeof getResteAPayer === 'function') ? getResteAPayer(p) : 0;
    if (montant > reste + 0.01) {
      if (errEl) errEl.textContent = 'Montant > reste (' + formatMoney(reste) + ').';
      return;
    }

    if (!Array.isArray(p.paiements)) p.paiements = [];
    p.paiements.push({ date: date, montant: montant, mode: mode, note: note,
      addedAt: new Date().toISOString() });

    if (typeof saveAll === 'function') saveAll();
    if (typeof logAction === 'function') logAction('purchase.payment', p.numero + ' ' + formatMoney(montant));

    var modal = document.getElementById('supplierPaymentModal');
    if (modal) modal.style.display = 'none';
    currentSupplierPaymentInvoiceId = null;
    renderPurchases();
    if (typeof showToast === 'function') showToast('Paiement enregistré', 'success', 2500);
  } catch (e) {
    console.warn('savePurchasePayment :', e);
    var errEl2 = document.getElementById('supplierPaymentFormError');
    if (errEl2) errEl2.textContent = 'Erreur d\'enregistrement.';
  }
}

/* ═══════════ SECTION 7 — ATTESTATION ═══════════ */

/* Génère une attestation de paiement (ou de retenue) imprimable. */
function printPurchaseAttestation(purchaseId) {
  try {
    var p = getPurchaseById(purchaseId);
    if (!p) return;
    var supplier = _purchSupplier(p);
    var supplierName = _purchSupplierName(p) || '—';
    var total = _purchTotal(p);
    var paid = (typeof getTotalPaye === 'function') ? getTotalPaye(p) : 0;
    var reste = (typeof getResteAPayer === 'function') ? getResteAPayer(p) : 0;
    var t = computePurchaseTotals(p.lines, p.tvaRate, p.timbre);

    var html = '<!DOCTYPE html><html><head><meta charset="UTF-8">' +
      '<title>Attestation — ' + escapeHtml(p.numero || '') + '</title><style>' +
      '@page{size:A4;margin:20mm}body{font-family:Arial;font-size:12px;color:#333;line-height:1.5}' +
      'h1{text-align:center;color:#0b3d91;font-size:22px;margin-bottom:5px}' +
      '.subtitle{text-align:center;color:#666;margin-bottom:30px}' +
      '.box{padding:15px;background:#f5f7fb;border-left:3px solid #0b3d91;margin:20px 0}' +
      'table{width:100%;border-collapse:collapse;margin:15px 0}' +
      'th,td{border:1px solid #ccc;padding:8px;text-align:left;font-size:11px}' +
      'th{background:#0b3d91;color:#fff}.right{text-align:right}' +
      '.grand-total{background:#0b3d91;color:#fff;font-weight:bold}' +
      '.footer{margin-top:40px;text-align:center;font-size:10px;color:#666}' +
      '.signature{margin-top:50px;display:flex;justify-content:space-between}' +
      '.signature-box{width:45%;height:100px;border:1px dashed #999;padding:10px;font-size:10px;color:#666}' +
      '</style></head><body>';

    html += '<h1>ATTESTATION</h1>';
    html += '<div class="subtitle">Facture fournisseur N° ' + escapeHtml(p.numero || '') + '</div>';

    html += '<div class="box">';
    html += '<strong>Fournisseur :</strong> ' + escapeHtml(supplierName) + '<br>';
    if (supplier && supplier.mf) html += '<strong>MF :</strong> ' + escapeHtml(supplier.mf) + '<br>';
    if (supplier && supplier.adresse) html += '<strong>Adresse :</strong> ' + escapeHtml(supplier.adresse) + '<br>';
    html += '<strong>Date facture :</strong> ' + escapeHtml(formatDate(_purchDate(p)));
    html += '</div>';

    html += '<table><thead><tr><th>Désignation</th><th class="right">Qté</th>' +
      '<th class="right">P.U.</th><th class="right">Total</th></tr></thead><tbody>';
    if (Array.isArray(p.lines)) {
      for (var i = 0; i < p.lines.length; i++) {
        var l = p.lines[i];
        if (!l) continue;
        var lt = parseNumber(l.quantite) * parseNumber(l.prixUnitaire || l.prix);
        html += '<tr><td>' + escapeHtml(l.designation || '') + '</td>' +
          '<td class="right">' + parseNumber(l.quantite) + '</td>' +
          '<td class="right">' + formatMoney(parseNumber(l.prixUnitaire || l.prix)) + '</td>' +
          '<td class="right">' + formatMoney(lt) + '</td></tr>';
      }
    }
    html += '</tbody></table>';

    html += '<table><tbody>';
    html += '<tr><td>Total HT</td><td class="right">' + formatMoney(t.totalHT) + '</td></tr>';
    html += '<tr><td>TVA (' + t.tvaRate + '%)</td><td class="right">' + formatMoney(t.tva) + '</td></tr>';
    html += '<tr><td>Timbre</td><td class="right">' + formatMoney(t.timbre) + '</td></tr>';
    html += '<tr class="grand-total"><td>TOTAL TTC</td><td class="right">' + formatMoney(t.totalTTC) + '</td></tr>';
    html += '<tr><td>Déjà payé</td><td class="right">' + formatMoney(paid) + '</td></tr>';
    html += '<tr><td><strong>Reste à payer</strong></td><td class="right"><strong>' +
      formatMoney(reste) + '</strong></td></tr>';
    html += '</tbody></table>';

    html += '<div class="footer">Fait à Tunis, le ' + escapeHtml(formatDate(todayISO())) +
      '<br>VOLTCORE INGENIERIE — MF ' + escapeHtml(bankMF || '') + '</div>';

    html += '<div class="signature">' +
      '<div class="signature-box">Cachet & signature fournisseur</div>' +
      '<div class="signature-box">Cachet & signature VOLTCORE</div>' +
      '</div>';

    html += '</body></html>';

    var w = window.open('', '_blank');
    if (!w) {
      if (typeof showToast === 'function') showToast('Autorise les pop-ups pour imprimer.', 'warning', 4000);
      return;
    }
    w.document.open();
    w.document.write(html);
    w.document.close();
    setTimeout(function () { try { w.focus(); w.print(); } catch (e) {} }, 400);
  } catch (e) { console.warn('printPurchaseAttestation :', e); }
}

/* ═══════════ SECTION 8 — SUPPRESSION + UNDO ═══════════ */

function deletePurchaseInvoice(purchaseId) {
  try {
    var p = getPurchaseById(purchaseId);
    if (!p) return;
    var idx = purchaseInvoices.indexOf(p);
    if (idx < 0) return;
    purchaseInvoices.splice(idx, 1);

    if (!trash || typeof trash !== 'object') trash = { clients: [], articles: [], documents: [] };
    if (!Array.isArray(trash.purchases)) trash.purchases = [];
    var entry = { item: p, deletedAt: new Date().toISOString() };
    trash.purchases.push(entry);

    if (typeof saveAll === 'function') saveAll();
    if (typeof logAction === 'function') logAction('purchase.delete', p.numero);
    renderPurchases();

    if (typeof showUndoToast === 'function') {
      showUndoToast('Achat supprimé : ' + (p.numero || ''),
        function () {
          var i2 = trash.purchases.indexOf(entry);
          if (i2 >= 0) trash.purchases.splice(i2, 1);
          if (!getPurchaseById(p.id)) purchaseInvoices.push(p);
          if (typeof saveAll === 'function') saveAll();
          renderPurchases();
          if (typeof showToast === 'function') showToast('Achat restauré', 'success', 2000);
        }, 5000);
    }
  } catch (e) { console.warn('deletePurchaseInvoice :', e); }
}

/* ═══════════ SECTION 9 — FILTRES + RECHERCHE ═══════════ */

function setPurchasesSearch(term) {
  __purchasesSearchTerm = String(term || '');
  renderPurchases();
}

function setPurchasesFilter(filter) {
  __purchasesFilter = filter || 'all';
  renderPurchases();
}

function getFilteredPurchases() {
  try {
    if (!Array.isArray(purchaseInvoices)) return [];
    var out = purchaseInvoices.slice();

    if (__purchasesSearchTerm) {
      var term = normalizeText(__purchasesSearchTerm);
      out = out.filter(function (p) {
        if (!p) return false;
        var sn = _purchSupplierName(p);
        var hay = normalizeText([p.numero, p.refFacture, sn, p.notes].join(' '));
        return hay.indexOf(term) >= 0;
      });
    }

    if (__purchasesFilter === 'impayees') {
      out = out.filter(function (p) {
        var s = (typeof getStatutPaiement === 'function') ? getStatutPaiement(p) : 'impayee';
        return s === 'impayee' || s === 'partielle';
      });
    } else if (__purchasesFilter === 'payees') {
      out = out.filter(_purchIsPaid);
    } else if (__purchasesFilter === 'mois_courant') {
      var prefix = todayISO().slice(0, 7);
      out = out.filter(function (p) { return _purchDate(p).slice(0, 7) === prefix; });
    }

    out.sort(function (a, b) {
      var da = _purchDate(a), db = _purchDate(b);
      return da < db ? 1 : (da > db ? -1 : 0);
    });
    return out;
  } catch (e) { console.warn('getFilteredPurchases :', e); return []; }
}

/* ═══════════ SECTION 10 — IMPORT / EXPORT ═══════════ */

function exportPurchasesJSON() {
  try {
    var data = {
      version: 1,
      exportedAt: new Date().toISOString(),
      count: purchaseInvoices.length,
      purchases: purchaseInvoices
    };
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    var filename = 'voltcore-achats-' + todayISO() + '.json';
        if (typeof downloadBlob === 'function') downloadBlob(blob, filename);    
    if (typeof showToast === 'function') {
      showToast(purchaseInvoices.length + ' achat(s) exporté(s)', 'success');
    }
  } catch (e) { console.warn('exportPurchasesJSON :', e); }
}

function importPurchasesJSON(file, options) {
  return new Promise(function (resolve, reject) {
    try {
      if (!file) return reject(new Error('Fichier requis'));
      var mode = (options && options.mode) || 'merge';
      if (typeof checkImportRate === 'function' && !checkImportRate()) {
        return reject(new Error('Trop rapide — attends 2 secondes.'));
      }
      var reader = new FileReader();
      reader.onload = function (ev) {
        try {
          var parsed = JSON.parse(ev.target.result);
          var arr = Array.isArray(parsed) ? parsed
                    : (parsed && Array.isArray(parsed.purchases)) ? parsed.purchases : null;
          if (!arr) throw new Error('Format invalide : purchases[] attendu');

          var added = 0, invalid = 0;
          if (mode === 'replace') { if (typeof _pushAllToTrashBeforeReplace === 'function') _pushAllToTrashBeforeReplace('purchases', purchaseInvoices); purchaseInvoices = []; }
          for (var i = 0; i < arr.length; i++) {
            var p = arr[i];
            if (!p || typeof p !== 'object') { invalid++; continue; }
            if (!p.id) p.id = 'pur_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
            if (!Array.isArray(p.lines)) p.lines = [];
            if (!Array.isArray(p.paiements)) p.paiements = [];
            purchaseInvoices.push(p);
            added++;
          }

          if (typeof saveAll === 'function') saveAll();
          if (typeof logAction === 'function') logAction('purchase.import', added + ' ajoutés');
          renderPurchases();
          if (typeof showToast === 'function') {
            showToast(added + ' achat(s) importé(s)' + (invalid ? ' · ' + invalid + ' invalide(s)' : ''),
              added > 0 ? 'success' : 'warning', 4000);
          }
          resolve({ added: added, invalid: invalid });
        } catch (err) { reject(err); }
      };
      reader.onerror = function () { reject(reader.error || new Error('Lecture échouée')); };
      reader.readAsText(file);
    } catch (e) { reject(e); }
  });
}

function printPurchasesList() {
  try {
    var list = getFilteredPurchases();
    var html = '<!DOCTYPE html><html><head><meta charset="UTF-8">' +
      '<title>Achats — VOLTCORE</title><style>' +
      'body{font-family:Arial;margin:20px;font-size:11px}' +
      'h1{color:#0b3d91;border-bottom:2px solid #0b3d91;padding-bottom:6px}' +
      'table{width:100%;border-collapse:collapse;margin-top:10px}' +
      'th,td{border:1px solid #ccc;padding:6px;text-align:left}' +
      'th{background:#0b3d91;color:#fff}.right{text-align:right}' +
      '</style></head><body>';
    html += '<h1>Achats fournisseurs</h1><div>Total : ' + list.length + ' · ' + todayISO() + '</div>';
    html += '<table><thead><tr><th>Réf</th><th>Fournisseur</th><th>Date</th>' +
      '<th class="right">HT</th><th class="right">TVA</th><th class="right">TTC</th>' +
      '<th class="right">Payé</th><th class="right">Reste</th></tr></thead><tbody>';
    var sumHT = 0, sumTVA = 0, sumTTC = 0, sumPaid = 0, sumReste = 0;
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      var t = computePurchaseTotals(p.lines, p.tvaRate, p.timbre);
      var paid = (typeof getTotalPaye === 'function') ? getTotalPaye(p) : 0;
      var reste = (typeof getResteAPayer === 'function') ? getResteAPayer(p) : 0;
      sumHT += t.totalHT; sumTVA += t.tva; sumTTC += t.totalTTC;
      sumPaid += paid; sumReste += reste;
      html += '<tr><td>' + escapeHtml(p.numero || '') + '</td>' +
        '<td>' + escapeHtml(_purchSupplierName(p) || '—') + '</td>' +
        '<td>' + escapeHtml(formatDate(_purchDate(p))) + '</td>' +
        '<td class="right">' + formatMoney(t.totalHT) + '</td>' +
        '<td class="right">' + formatMoney(t.tva) + '</td>' +
        '<td class="right">' + formatMoney(t.totalTTC) + '</td>' +
        '<td class="right">' + formatMoney(paid) + '</td>' +
        '<td class="right">' + formatMoney(reste) + '</td></tr>';
    }
    html += '<tr style="background:#f0f0f0;font-weight:bold">' +
      '<td colspan="3">TOTAUX</td>' +
      '<td class="right">' + formatMoney(sumHT) + '</td>' +
      '<td class="right">' + formatMoney(sumTVA) + '</td>' +
      '<td class="right">' + formatMoney(sumTTC) + '</td>' +
      '<td class="right">' + formatMoney(sumPaid) + '</td>' +
      '<td class="right">' + formatMoney(sumReste) + '</td></tr>';
    html += '</tbody></table></body></html>';

    var w = window.open('', '_blank');
    if (!w) { if (typeof showToast === 'function') showToast('Autorise les pop-ups.', 'warning'); return; }
    w.document.write(html); w.document.close();
    setTimeout(function () { try { w.print(); } catch (e) {} }, 500);
  } catch (e) { console.warn('printPurchasesList :', e); }
}

/* ═══════════ SECTION 11 — ÉVÉNEMENTS ═══════════ */

function attachPurchasesEvents() {
  try {
    var searchInput = document.getElementById('purchasesSearchInput');
    if (searchInput && !searchInput.__bound) {
      searchInput.__bound = true;
      searchInput.addEventListener('input', debounce(function (ev) {
        setPurchasesSearch(ev.target.value);
      }, 250));
    }

    var filterSel = document.getElementById('purchasesFilterSelect');
    if (filterSel && !filterSel.__bound) {
      filterSel.__bound = true;
      filterSel.addEventListener('change', function (ev) {
        setPurchasesFilter(ev.target.value);
      });
    }

    var addBtn = document.getElementById('btnAddPurchase');
    if (addBtn && !addBtn.__bound) {
      addBtn.__bound = true;
      addBtn.addEventListener('click', function () { openPurchaseModal(null); });
    }

    var addLineBtn = document.getElementById('btnAddPurchaseLine');
    if (addLineBtn && !addLineBtn.__bound) {
      addLineBtn.__bound = true;
      addLineBtn.addEventListener('click', addPurchaseLine);
    }

    var saveBtn = document.getElementById('purchaseSaveBtn');
    if (saveBtn && !saveBtn.__bound) {
      saveBtn.__bound = true;
      saveBtn.addEventListener('click', savePurchaseInvoice);
    }

    var paySaveBtn = document.getElementById('supplierPaymentSaveBtn');
    if (paySaveBtn && !paySaveBtn.__bound) {
      paySaveBtn.__bound = true;
      paySaveBtn.addEventListener('click', savePurchasePayment);
    }

    var importBtn = document.getElementById('btnImportPurchases');
    if (importBtn && !importBtn.__bound) {
      importBtn.__bound = true;
      importBtn.addEventListener('click', function () {
        var input = document.createElement('input');
        input.type = 'file'; input.accept = '.json,application/json';
        input.onchange = function (ev) {
          var f = ev.target.files && ev.target.files[0];
          if (!f) return;
          importPurchasesJSON(f, { mode: 'merge' }).catch(function (err) {
            if (typeof showToast === 'function') showToast('Import échoué : ' + (err.message || ''), 'error');
          });
        };
        input.click();
      });
    }

    var exportBtn = document.getElementById('btnExportPurchases');
    if (exportBtn && !exportBtn.__bound) {
      exportBtn.__bound = true;
      exportBtn.addEventListener('click', exportPurchasesJSON);
    }

    var printBtn = document.getElementById('btnPrintPurchases');
    if (printBtn && !printBtn.__bound) {
      printBtn.__bound = true;
      printBtn.addEventListener('click', printPurchasesList);
    }
  } catch (e) { console.warn('attachPurchasesEvents :', e); }
}

console.log('✅ 13-purchases.js chargé — v6.7 (Session #3 — syntax error corrigé, fichier complet)');