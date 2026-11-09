/* ═══════════════════════════════════════════════════════════════
   VOLTCORE — 11-invoices.js
   VERSION : v6.7 (Session #3 — remise + colonne + picker + garantie
                   BTP + préremplissage TVA/timbre + restauration)
   RÔLE : Formulaire facture/devis/BL/avoir, totaux (TVA + timbre
          + retenues IR/TVA + retenue garantie BTP), édition, avoirs,
          brouillon auto, pièces jointes (H = compression), prefill chantier
   DÉPENDANCES : 01-core.js (globaux), 03-utils.js (helpers, computeLineTotal),
                 04-storage.js (saveAll, genererNumero, STORAGE_KEYS),
                 06-clients.js (getClientById pour préremplissage TVA),
                 08-stock.js (getArticleById, openArticlePicker)
   EXPOSE : openInvoiceForm, openInvoiceFormWithPrefill,
            closeInvoiceForm, resetInvoiceForm,
            addInvoiceItem, removeInvoiceItem, updateInvoiceItem,
            computeInvoiceTotals, updateInvoiceTotalsDisplay,
            onInvoiceTypeChange, saveInvoice,
            editInvoice, openEditInvoice,
            openAvoirFromInvoice, createAvoirFromFacture,
            saveBrouillon, loadBrouillon, clearBrouillon,
            addInvoiceAttachment, removeInvoiceAttachment,
            renderInvoiceAttachments, attachInvoicesEvents
   SECTION 1  : CONSTANTES + ÉTAT
   SECTION 2  : TOTAUX (avec retenue garantie BTP)
   SECTION 3  : ITEMS (avec remise par ligne)
   SECTION 4  : OUVERTURE / FERMETURE
   SECTION 5  : PREFILL (L9) + PRÉREMPLISSAGE TVA SELON CLIENT
   SECTION 6  : SELECTS (clients, chantiers)
   SECTION 7  : TYPE DE DOCUMENT
   SECTION 8  : PIÈCES JOINTES (compression H)
   SECTION 9  : BROUILLON AUTO
   SECTION 10 : SAUVEGARDE
   SECTION 11 : ÉDITION
   SECTION 12 : AVOIRS
   SECTION 13 : ÉVÉNEMENTS
   ═══════════════════════════════════════════════════════════════ */

/* ═══════════ SECTION 1 — CONSTANTES + ÉTAT ═══════════ */

var VOLTCORE_TVA_DEFAULT = 19;
var VOLTCORE_TIMBRE_DEFAULT = 1.000;
var VOLTCORE_ATTACH_MAX_BYTES = 500 * 1024;

/* editDocIndex (déclaré en 01-core.js) reste utilisé pour compat
   mais on utilise un ID stable pour l'édition réelle. */
window.__invoiceEditId = null;
window.__pendingAvoirParentId = null;
window.__invoiceDirty = false;

var INVOICE_TYPES = {
  devis:      { label: 'Devis',       prefix: 'DEV', requiresClient: true },
  bl:         { label: 'Bon livraison', prefix: 'BL', requiresClient: true },
  facture:    { label: 'Facture',     prefix: 'FAC', requiresClient: true },
  attachement:{ label: 'Attachement', prefix: 'ATT', requiresClient: true },
  avoir:      { label: 'Avoir',       prefix: 'AV',  requiresClient: true }
};

/* ═══════════ SECTION 2 — TOTAUX ═══════════ */

/* Calcule tous les totaux à partir des items courants + paramètres form.
   v6.7 :
   - Utilise computeLineTotal(it) qui gère la remise par ligne (LOT 2)
   - Ajoute retenue garantie BTP (calculée sur le HT)
   - Ajoute netAvantGarantie (avant déduction garantie)
   - netAPayer = netAvantGarantie - retenueGarantie
   Retourne un objet avec tous les champs utilisés par les autres modules. */
function computeInvoiceTotals() {
  try {
    var items = Array.isArray(currentInvoiceItems) ? currentInvoiceItems : [];

    /* 1. Total HT */
    var totalHT = 0;
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (!it) continue;
      var q = parseNumber(it.quantite);
      var p = parseNumber(it.prix);
      if (q > 0 && p >= 0) totalHT += q * p;
    }

    /* 2. Paramètres */
    var tvaRate = parseNumber(_invGet('invoiceTVARate'));
    if (!isFinite(tvaRate) || tvaRate < 0) tvaRate = VOLTCORE_TVA_DEFAULT;
    var timbre = parseNumber(_invGet('invoiceTimbre'));
    if (!isFinite(timbre) || timbre < 0) timbre = VOLTCORE_TIMBRE_DEFAULT;
    var retIRRate = parseNumber(_invGet('invoiceRetenueIR'));
    if (!isFinite(retIRRate) || retIRRate < 0) retIRRate = 0;
    if (retIRRate > 100) retIRRate = 100;
    var retTVARate = parseNumber(_invGet('invoiceRetenueTVA'));
    if (!isFinite(retTVARate) || retTVARate < 0) retTVARate = 0;
    if (retTVARate > 100) retTVARate = 100;
    /* ⬇ NOUVEAU v6.8 : retenue garantie BTP (calculée sur HT) */
    var retGarantieRate = parseNumber(_invGet('invoiceRetenueGarantie'));
    if (!isFinite(retGarantieRate) || retGarantieRate < 0) retGarantieRate = 0;
    if (retGarantieRate > 100) retGarantieRate = 100;

    /* 3. TVA + TTC */
    var tva = totalHT * tvaRate / 100;
    var totalTTC = totalHT + tva + timbre;

    /* 4. Retenues IR + TVA */
    var retenueIR = totalHT * retIRRate / 100;
    var retenueTVA = tva * retTVARate / 100;
    var retenueMontant = retenueIR + retenueTVA;

    /* 5. Net avant garantie */
    var netAvantGarantie = totalTTC - retenueMontant;
    if (netAvantGarantie < 0) netAvantGarantie = 0;

    /* 6. Retenue garantie BTP (sur HT) */
    var retenueGarantie = totalHT * retGarantieRate / 100;

    /* 7. Net à payer = net avant garantie − garantie */
    var netAPayer = netAvantGarantie - retenueGarantie;
    if (netAPayer < 0) netAPayer = 0;

    return {
      totalHT: totalHT,
      tvaRate: tvaRate,
      tva: tva,
      timbre: timbre,
      totalTTC: totalTTC,
      retenueIRRate: retIRRate,
      retenueIR: retenueIR,
      retenueTVARate: retTVARate,
      retenueTVA: retenueTVA,
      retenueMontant: retenueMontant,
      retenueGarantieRate: retGarantieRate,
      retenueGarantie: retenueGarantie,
      netAvantGarantie: netAvantGarantie,
      total: totalTTC,
      netAPayer: netAPayer
    };
  } catch (e) {
    console.warn('computeInvoiceTotals :', e);
    return {
      totalHT: 0, tvaRate: 0, tva: 0, timbre: 0, totalTTC: 0,
      retenueIRRate: 0, retenueIR: 0, retenueTVARate: 0, retenueTVA: 0,
      retenueMontant: 0, retenueGarantieRate: 0, retenueGarantie: 0,
      netAvantGarantie: 0, total: 0, netAPayer: 0
    };
  }
}

/* Met à jour l'affichage des totaux dans le formulaire.
   v6.7 : ajoute le bloc retenue garantie BTP. */
function updateInvoiceTotalsDisplay() {
  try {
    var t = computeInvoiceTotals();
    _invSetText('totalHTDisplay', formatMoney(t.totalHT));
    _invSetText('tvaRateDisplay', t.tvaRate + '%');
    _invSetText('tvaDisplay', formatMoney(t.tva));
    _invSetText('timbreDisplay', formatMoney(t.timbre));
    _invSetText('totalTTCDisplay', formatMoney(t.totalTTC));
    _invSetText('retenueIRDisplay', formatMoney(t.retenueIR));
    _invSetText('retenueTVADisplay', formatMoney(t.retenueTVA));
    _invSetText('retenueMontantDisplay', formatMoney(t.retenueMontant));
    _invSetText('netAPayerDisplay', formatMoney(t.netAPayer));
    /* ⬇ NOUVEAU v6.8 : affichage garantie BTP */
    _invSetText('retenueGarantieDisplay', formatMoney(t.retenueGarantie));
    _invSetText('netAvantGarantieDisplay', formatMoney(t.netAvantGarantie));
    /* Affiche/masque les lignes retenues IR/TVA si 0 */
    var retBox = document.getElementById('retenuesSummary');
    if (retBox) retBox.style.display = (t.retenueMontant > 0.001) ? '' : 'none';
    /* ⬇ NOUVEAU v6.8 : affiche/masque le bloc garantie */
    var garBox = document.getElementById('garantieSummary');
    if (garBox) garBox.style.display = (t.retenueGarantie > 0.001) ? '' : 'none';
  } catch (e) { console.warn('updateInvoiceTotalsDisplay :', e); }
}

/* ═══════════ SECTION 3 — ITEMS ═══════════ */

function _invGet(id) {
  try {
    var el = document.getElementById(id);
    return el ? String(el.value || '').trim() : '';
  } catch (e) { return ''; }
}

function _invSetText(id, text) {
  try {
    var el = document.getElementById(id);
    if (el) el.textContent = String(text || '');
  } catch (e) {}
}

function _invSet(id, value) {
  try {
    var el = document.getElementById(id);
    if (el) el.value = (value === null || value === undefined) ? '' : value;
  } catch (e) {}
}

function _invSetChecked(id, value) {
  try { var el = document.getElementById(id); if (el) el.checked = !!value; } catch (e) {}
}

function _invGetChecked(id) {
  try { var el = document.getElementById(id); return !!(el && el.checked); } catch (e) { return false; }
}

/* Ajoute une ligne vide ou pré-remplie. */
function addInvoiceItem(data) {
  try {
    var item = {
      articleId: data && data.articleId ? String(data.articleId) : '',
      designation: data && data.designation ? String(data.designation) : '',
      quantite: data && data.quantite != null ? parseNumber(data.quantite) : 1,
      prix: data && data.prix != null ? parseNumber(data.prix) : 0,
      unite: data && data.unite ? String(data.unite) : 'U',
      remise: data && data.remise != null ? parseNumber(data.remise) : 0
    };
    if (!Array.isArray(currentInvoiceItems)) currentInvoiceItems = [];
    currentInvoiceItems.push(item);
    _invDirty();
    renderInvoiceItems();
    updateInvoiceTotalsDisplay();
  } catch (e) { console.warn('addInvoiceItem :', e); }
}

function removeInvoiceItem(index) {
  try {
    if (!Array.isArray(currentInvoiceItems)) return;
    if (index < 0 || index >= currentInvoiceItems.length) return;
    currentInvoiceItems.splice(index, 1);
    _invDirty();
    renderInvoiceItems();
    updateInvoiceTotalsDisplay();
  } catch (e) { console.warn('removeInvoiceItem :', e); }
}

/* Lit les champs input d'une ligne et met à jour currentInvoiceItems.
   v6.7 : clamp remise à [0, 100]. */
function updateInvoiceItem(index, field, value) {
  try {
    if (!Array.isArray(currentInvoiceItems)) return;
    var it = currentInvoiceItems[index];
    if (!it) return;
    if (field === 'quantite' || field === 'prix' || field === 'remise') {
      var v = parseNumber(value);
      if (field === 'remise') {
        if (v < 0) v = 0;
        if (v > 100) v = 100;
      }
      if (field === 'quantite' && v < 0) v = 0;
      if (field === 'prix' && v < 0) v = 0;
      it[field] = v;
    } else {
      it[field] = String(value || '');
    }
    _invDirty();
    updateInvoiceTotalsDisplay();
    /* Re-render pour mettre à jour la colonne Total (calculée par ligne) */
    if (field === 'quantite' || field === 'prix' || field === 'remise') {
      _updateItemRowTotal(index);
    }
  } catch (e) { console.warn('updateInvoiceItem :', e); }
}

/* Met à jour la cellule "Total" d'une ligne sans re-render complet. */
function _updateItemRowTotal(index) {
  try {
    if (!Array.isArray(currentInvoiceItems)) return;
    var it = currentInvoiceItems[index];
    if (!it) return;
    var container = document.getElementById('invoiceItemsBody');
    if (!container) return;
    var row = container.querySelector('tr.invoice-item-row[data-index="' + index + '"]');
    if (!row) return;
    var totalCell = row.querySelector('td.col-total');
    if (!totalCell) return;
    var total = (typeof computeLineTotal === 'function')
      ? computeLineTotal(it)
      : parseNumber(it.quantite) * parseNumber(it.prix);
    totalCell.textContent = formatMoney(total);
  } catch (e) { console.warn('_updateItemRowTotal :', e); }
}

/* Rendu du tableau d'items.
   v6.7 : ajout de la colonne "Remise %" manquante. */
function renderInvoiceItems() {
  try {
    var container = document.getElementById('invoiceItemsBody');
    if (!container) return;
    if (!Array.isArray(currentInvoiceItems)) currentInvoiceItems = [];

    var html = '';
    for (var i = 0; i < currentInvoiceItems.length; i++) {
      var it = currentInvoiceItems[i];
      /* v6.7 : utilise computeLineTotal pour gérer la remise */
      var ligneTotal = (typeof computeLineTotal === 'function')
        ? computeLineTotal(it)
        : parseNumber(it.quantite) * parseNumber(it.prix);
      html += '<tr class="invoice-item-row" data-index="' + i + '">' +
        '<td>' +
          '<input type="text" class="input-item" ' +
          'value="' + escapeAttr(it.designation || '') + '" ' +
          'oninput="updateInvoiceItem(' + i + ', \'designation\', this.value)" ' +
          'placeholder="Désignation">' +
        '</td>' +
        '<td class="col-qte">' +
          '<input type="number" step="0.01" min="0" ' +
          'value="' + escapeAttr(it.quantite || '') + '" ' +
          'oninput="updateInvoiceItem(' + i + ', \'quantite\', this.value)" ' +
          'class="input-qte">' +
        '</td>' +
        '<td class="col-unite">' +
          '<input type="text" ' +
          'value="' + escapeAttr(it.unite || 'U') + '" ' +
          'oninput="updateInvoiceItem(' + i + ', \'unite\', this.value)" ' +
          'class="input-unite">' +
        '</td>' +
        '<td class="col-pu">' +
          '<input type="number" step="0.001" min="0" ' +
          'value="' + escapeAttr(it.prix || '') + '" ' +
          'oninput="updateInvoiceItem(' + i + ', \'prix\', this.value)" ' +
          'class="input-pu">' +
        '</td>' +
        '<td class="col-remise">' +
          '<input type="number" step="0.01" min="0" max="100" ' +
          'value="' + escapeAttr(it.remise || '') + '" ' +
          'oninput="updateInvoiceItem(' + i + ', \'remise\', this.value)" ' +
          'class="input-remise" placeholder="0">' +
        '</td>' +
        '<td class="col-total">' + escapeHtml(formatMoney(ligneTotal)) + '</td>' +
        '<td class="col-action">' +
          '<button type="button" class="btn-icon btn-danger" ' +
          'onclick="removeInvoiceItem(' + i + ')" title="Supprimer">🗑️</button>' +
        '</td>' +
      '</tr>';
    }

    if (currentInvoiceItems.length === 0) {
      html = '<tr><td colspan="7" class="empty-items">' +
        'Aucune ligne. Clique sur "+ Ajouter une ligne" ou sélectionne un article.' +
        '</td></tr>';
    }

    container.innerHTML = html;
  } catch (e) { console.warn('renderInvoiceItems :', e); }
}

function _invDirty() {
  window.__invoiceDirty = true;
  /* Debounce save brouillon */
  if (window.__brouillonTimer) clearTimeout(window.__brouillonTimer);
  window.__brouillonTimer = setTimeout(function () {
    window.__brouillonTimer = null;
    try { saveBrouillon(); } catch (e) {}
  }, 1500);
}

/* Ajoute un article du stock comme ligne de facture. */
function addInvoiceItemFromArticle(articleId) {
  try {
    if (typeof getArticleById !== 'function') return;
    var art = getArticleById(articleId);
    if (!art) return;
    addInvoiceItem({
      articleId: art.id,
      designation: art.nom || art.designation || '',
      quantite: 1,
      prix: typeof art.prix === 'number' ? art.prix : parseNumber(art.prix),
      unite: art.unite || 'U'
    });
  } catch (e) { console.warn('addInvoiceItemFromArticle :', e); }
}

/* ═══════════ SECTION 4 — OUVERTURE / FERMETURE ═══════════ */

function openInvoiceForm() {
  try {
    /* Consomme le prefill L9 si présent */
    var p = window.__pendingChantierPrefill;
    window.__pendingChantierPrefill = null;

    _resetInvoiceForm();
    if (p && typeof p === 'object') _applyInvoicePrefill(p);

    var modal = document.getElementById('invoiceModal');
    if (modal) modal.style.display = 'flex';

    _populateInvoiceClientsSelect(_invGet('invoiceClientSelect'));
    _populateInvoiceChantiersSelect(_invGet('invoiceChantierSelect'));

    /* Charge le brouillon existant si présent */
    if (!window.__invoiceEditId) {
      try { loadBrouillon(); } catch (e) {}
    }

    var firstInput = document.getElementById('invoiceSujet');
    if (firstInput) setTimeout(function () { try { firstInput.focus(); } catch (e) {} }, 100);
  } catch (e) { console.warn('openInvoiceForm :', e); }
}

function openInvoiceFormWithPrefill(prefill) {
  try {
    if (prefill && typeof prefill === 'object') {
      window.__pendingChantierPrefill = prefill;
    }
    openInvoiceForm();
  } catch (e) { console.warn('openInvoiceFormWithPrefill :', e); }
}

function closeInvoiceForm() {
  try {
    var modal = document.getElementById('invoiceModal');
    if (modal) modal.style.display = 'none';
    window.__invoiceEditId = null;
    window.__pendingAvoirParentId = null;
    window.__invoiceDirty = false;
  } catch (e) {}
}

function resetInvoiceForm() {
  _resetInvoiceForm();
  var modal = document.getElementById('invoiceModal');
  if (modal) modal.style.display = 'flex';
}

function _resetInvoiceForm() {
  try {
    window.__invoiceEditId = null;
    window.__pendingAvoirParentId = null;
    window.__invoiceDirty = false;
    /* v6.8.1 — reset du flag de saisie manuelle du timbre.
       Sans ce reset, après avoir tapé 0 dans le timbre une fois,
       le flag restait true et bloquait la restauration à 1.000
       lors des changements de type suivants. */
    window.__invoiceTimbreUserZero = false;

    currentInvoiceItems = [];
    currentAttachments = [];

    _invSet('invoiceEditId', '');
    _invSet('invoiceType', 'facture');
    _invSet('invoiceNumero', '');
    _invSet('invoiceDate', todayISO());
    _invSet('invoiceSujet', '');
    _invSet('invoiceNotes', '');
    _invSet('invoiceClientSelect', '');
    _invSet('invoiceChantierSelect', '');
    _invSet('invoiceTVARate', VOLTCORE_TVA_DEFAULT);
    _invSet('invoiceTimbre', VOLTCORE_TIMBRE_DEFAULT.toFixed(3));
    _invSet('invoiceRetenueIR', '0');
    _invSet('invoiceRetenueTVA', '0');
    /* v6.8.1 — doublon supprimé (était présent 2 fois en v6.7) */
    _invSet('invoiceRetenueGarantie', '0');

    _invSetText('invoiceFormError', '');
    var numEl = document.getElementById('invoiceNumero');
    if (numEl) numEl.disabled = false;

    /* v6.8 — reset info libération garantie */
    var libInfo2 = document.getElementById('invoiceGarantieLiberationInfo');
    if (libInfo2) libInfo2.style.display = 'none';

    renderInvoiceItems();
    renderInvoiceAttachments();
    updateInvoiceTotalsDisplay();
    onInvoiceTypeChange('facture');
  } catch (e) { console.warn('_resetInvoiceForm :', e); }
}

/* ═══════════ SECTION 5 — PREFILL (L9) + PRÉREMPLISSAGE TVA ═══════════ */

/* v6.7 — Applique les valeurs par défaut TVA/timbre selon le client.
   Règles :
   - administration → TVA 0%, timbre 0
   - sous-traitant avec codeTVA numérique → utilise ce taux
   - entreprise/particulier/défaut → TVA 19%, timbre 1.000
   N'est appliqué que si le formulaire est vide (pas d'items) pour ne
   pas écraser une saisie manuelle déjà commencée. */
function _applyClientDefaults(clientId) {
  try {
    if (!clientId) return;
    /* v6.7.1 — N'écrase pas si des items existent déjà (l'utilisateur
       bosse). ⚠️ Conséquence : si un futur prefill passe items + clientId,
       les défauts TVA/timbre ne seront PAS appliqués. Actuellement ce
       n'est pas un cas d'usage (les prefills de 09-chantiers.js n'ont
       pas d'items), mais à garder en tête si la logique évolue. */
    if (Array.isArray(currentInvoiceItems) && currentInvoiceItems.length > 0) return;

    var client = (typeof getClientById === 'function') ? getClientById(clientId) : null;
    if (!client) return;

    var clientType = String(client.type || 'particulier').toLowerCase();
    var tvaRate = VOLTCORE_TVA_DEFAULT;
    var timbre = VOLTCORE_TIMBRE_DEFAULT;

    if (clientType === 'administration') {
      tvaRate = 0;
      timbre = 0;
    } else if (clientType === 'sous-traitant' && client.codeTVA) {
      var code = String(client.codeTVA).trim();
      if (/^\d+(\.\d+)?$/.test(code)) {
        var parsed = parseFloat(code);
        if (parsed >= 0 && parsed <= 100) tvaRate = parsed;
      }
    }
    /* entreprise / particulier / défaut : garde 19 / 1.000 */

    _invSet('invoiceTVARate', String(tvaRate));
    _invSet('invoiceTimbre', Number(timbre).toFixed(3));
    updateInvoiceTotalsDisplay();
  } catch (e) { console.warn('_applyClientDefaults :', e); }
}

function _applyInvoicePrefill(p) {
  try {
    if (!p) return;
    if (p.type && INVOICE_TYPES[p.type]) {
      _invSet('invoiceType', p.type);
      onInvoiceTypeChange(p.type);
    }
    if (p.clientId) _invSet('invoiceClientSelect', p.clientId);
    if (p.chantierId) _invSet('invoiceChantierSelect', p.chantierId);
    if (p.sujet) _invSet('invoiceSujet', p.sujet);
    if (p.notes) _invSet('invoiceNotes', p.notes);
    if (Array.isArray(p.items) && p.items.length > 0) {
      currentInvoiceItems = p.items.slice();
      renderInvoiceItems();
    }
    _populateInvoiceClientsSelect(p.clientId || '');
    _populateInvoiceChantiersSelect(p.chantierId || '');
    /* v6.7 — Applique TVA/timbre selon type client si client fourni */
    if (p.clientId) {
      _applyClientDefaults(p.clientId);
    }
    updateInvoiceTotalsDisplay();
  } catch (e) { console.warn('_applyInvoicePrefill :', e); }
}

/* ═══════════ SECTION 6 — SELECTS (clients, chantiers) ═══════════ */

function _populateInvoiceClientsSelect(selectedId) {
  try {
    var sel = document.getElementById('invoiceClientSelect');
    if (!sel) return;
    var html = '<option value="">— Sélectionner un client —</option>';
    if (Array.isArray(clients)) {
      var sorted = clients.slice().sort(function (a, b) {
        return normalizeText(a.nom || '') > normalizeText(b.nom || '') ? 1 : -1;
      });
      for (var i = 0; i < sorted.length; i++) {
        var c = sorted[i];
        var sid = String(c.id);
        html += '<option value="' + escapeAttr(sid) + '"' +
          (sid === String(selectedId || '') ? ' selected' : '') + '>' +
          escapeHtml(c.nom || '') + '</option>';
      }
    }
    sel.innerHTML = html;
  } catch (e) { console.warn('_populateInvoiceClientsSelect :', e); }
}

function _populateInvoiceChantiersSelect(selectedId) {
  try {
    var sel = document.getElementById('invoiceChantierSelect');
    if (!sel) return;
    var html = '<option value="">— Aucun chantier —</option>';
    if (Array.isArray(savedChantiers)) {
      var sorted = savedChantiers.slice().sort(function (a, b) {
        return normalizeText(a.nom || '') > normalizeText(b.nom || '') ? 1 : -1;
      });
      for (var i = 0; i < sorted.length; i++) {
        var ch = sorted[i];
        var sid = String(ch.id);
        var isActive = chantierActifId && String(chantierActifId) === sid;
        html += '<option value="' + escapeAttr(sid) + '"' +
          (sid === String(selectedId || '') ? ' selected' : '') + '>' +
          (isActive ? '🏗️ ' : '') + escapeHtml(ch.nom || '') + '</option>';
      }
    }
    sel.innerHTML = html;
  } catch (e) { console.warn('_populateInvoiceChantiersSelect :', e); }
}

/* ═══════════ SECTION 7 — TYPE DE DOCUMENT ═══════════ */

function onInvoiceTypeChange(type) {
  try {
    var t = String(type || 'facture').toLowerCase();
    if (!INVOICE_TYPES[t]) t = 'facture';

    var isAvoir = (t === 'avoir');
    var isDevis = (t === 'devis');
    var isFactureLike = (t === 'facture' || t === 'attachement' || t === 'bl');

       /* Avoir : timbre 0, retenue IR 0, retenue TVA 0, retenue garantie 0 */
    if (t === 'avoir') {
      _invSet('invoiceTimbre', '0');
      _invSet('invoiceRetenueIR', '0');
      _invSet('invoiceRetenueTVA', '0');
      _invSet('invoiceRetenueGarantie', '0');  /* ⬇ NOUVEAU v6.8 */
    }

    /* Devis : timbre 0, retenue garantie 0 (pas de garantie sur devis) */
    if (t === 'devis') {
      _invSet('invoiceTimbre', '0');
      _invSet('invoiceRetenueGarantie', '0');  /* ⬇ NOUVEAU v6.8 */
    } else if (isFactureLike) {
  var currentTimbre = parseFloat(_invGet('invoiceTimbre')) || 0;
  /* v6.7.1 — Ne restaure que si le timbre a été mis à 0 par
     onInvoiceTypeChange (flag mémorisé), pas si l'utilisateur
     l'a saisi manuellement. */
  if (currentTimbre === 0 && !window.__invoiceTimbreUserZero) {
    _invSet('invoiceTimbre', VOLTCORE_TIMBRE_DEFAULT.toFixed(3));
  }
}

/* Ajouter un listener pour mémoriser la saisie manuelle : dans
   attachInvoicesEvents, sur l'input invoiceTimbre :
     inp.addEventListener('input', function () {
       window.__invoiceTimbreUserZero = (parseFloat(inp.value) === 0);
     });
   Et reset à false dans _resetInvoiceForm. */
    /* Titre du bouton enregistrer */
    var btn = document.getElementById('invoiceSaveBtn');
    if (btn) {
      var labels = {
        devis: '💾 Enregistrer le devis',
        bl: '💾 Enregistrer le BL',
        facture: '💾 Enregistrer la facture',
        attachement: '💾 Enregistrer l\'attachement',
        avoir: '💾 Enregistrer l\'avoir'
      };
      btn.textContent = labels[t] || '💾 Enregistrer';
    }

    /* Badge type */
    var badge = document.getElementById('invoiceTypeBadge');
    if (badge) badge.textContent = INVOICE_TYPES[t].label;

    updateInvoiceTotalsDisplay();
  } catch (e) { console.warn('onInvoiceTypeChange :', e); }
}

/* ═══════════ SECTION 8 — PIÈCES JOINTES (compression H) ═══════════ */

function addInvoiceAttachment() {
  try {
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*,application/pdf';
    input.multiple = true;
    input.onchange = function (ev) {
      var files = ev.target.files;
      if (!files || files.length === 0) return;
      _processAttachmentFiles(files);
    };
    input.click();
  } catch (e) { console.warn('addInvoiceAttachment :', e); }
}

async function _processAttachmentFiles(files) {
  try {
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      if (!f) continue;
      var type = String(f.type || '');
      try {
        if (/^image\//.test(type)) {
          if (typeof compressImageWithFeedback !== 'function') {
            console.warn('compressImageWithFeedback absent');
            continue;
          }
          var dataUrl = await compressImageWithFeedback(f, VOLTCORE_ATTACH_MAX_BYTES);
          var approx = Math.round(dataUrl.length * 0.75);
          currentAttachments.push({
            name: String(f.name || 'image.jpg'),
            type: 'image',
            size: approx,
            data: dataUrl
          });
        } else if (type === 'application/pdf' || /\.pdf$/i.test(f.name || '')) {
          if (f.size > VOLTCORE_ATTACH_MAX_BYTES) {
            if (typeof showToast === 'function') {
              showToast('PDF trop gros (> ' + formatBytes(VOLTCORE_ATTACH_MAX_BYTES) + '). Compresse-le avant.', 'error', 4000);
            }
            continue;
          }
          var pdfData = await _readFileAsDataURL(f);
          currentAttachments.push({
            name: String(f.name || 'document.pdf'),
            type: 'pdf',
            size: f.size,
            data: pdfData
          });
        } else {
          if (typeof showToast === 'function') {
            showToast('Type de fichier non supporté : ' + type, 'warning');
          }
          continue;
        }
      } catch (err) {
        console.warn('Fichier échoué :', f.name, err);
        if (typeof showToast === 'function') {
          showToast('Impossible de traiter ' + (f.name || 'fichier'), 'error');
        }
      }
    }
    _invDirty();
    renderInvoiceAttachments();
  } catch (e) { console.warn('_processAttachmentFiles :', e); }
}

function _readFileAsDataURL(file) {
  return new Promise(function (resolve, reject) {
    try {
      var reader = new FileReader();
      reader.onload = function (e) { resolve(e.target.result); };
      reader.onerror = function () { reject(reader.error); };
      reader.readAsDataURL(file);
    } catch (e) { reject(e); }
  });
}

function removeInvoiceAttachment(index) {
  try {
    if (!Array.isArray(currentAttachments)) return;
    if (index < 0 || index >= currentAttachments.length) return;
    currentAttachments.splice(index, 1);
    _invDirty();
    renderInvoiceAttachments();
  } catch (e) { console.warn('removeInvoiceAttachment :', e); }
}

function renderInvoiceAttachments() {
  try {
    var container = document.getElementById('invoiceAttachmentsList');
    if (!container) return;
    if (!Array.isArray(currentAttachments)) currentAttachments = [];

    if (currentAttachments.length === 0) {
      container.innerHTML = '<div class="empty-attachments">Aucune pièce jointe.</div>';
      return;
    }

    var html = '';
    for (var i = 0; i < currentAttachments.length; i++) {
      var a = currentAttachments[i];
      var icon = a.type === 'image' ? '🖼️' : '📄';
      var size = formatBytes(a.size || 0);
      html += '<div class="attachment-chip">' +
        '<span>' + icon + ' ' + escapeHtml(a.name || '') + '</span>' +
        '<span class="muted">' + escapeHtml(size) + '</span>' +
        '<button type="button" class="btn-icon-mini btn-danger" ' +
        'onclick="removeInvoiceAttachment(' + i + ')" title="Retirer">✕</button>' +
        '</div>';
    }
    container.innerHTML = html;
  } catch (e) { console.warn('renderInvoiceAttachments :', e); }
}

/* ═══════════ SECTION 9 — BROUILLON AUTO ═══════════ */

function saveBrouillon() {
  try {
    if (!window.__invoiceDirty) return;
    if (!window.STORAGE_KEYS || !window.STORAGE_KEYS.brouillonCourant) return;
    var data = {
      type: _invGet('invoiceType') || 'facture',
      numero: _invGet('invoiceNumero'),
      date: _invGet('invoiceDate') || todayISO(),
      sujet: _invGet('invoiceSujet'),
      notes: _invGet('invoiceNotes'),
      clientId: _invGet('invoiceClientSelect'),
      chantierId: _invGet('invoiceChantierSelect'),
      tvaRate: _invGet('invoiceTVARate'),
      timbre: _invGet('invoiceTimbre'),
      retenueIR: _invGet('invoiceRetenueIR'),
      retenueTVA: _invGet('invoiceRetenueTVA'),
      /* v6.7 — sauvegarde aussi la retenue garantie */
      retenueGarantie: _invGet('invoiceRetenueGarantie'),
      items: (currentInvoiceItems || []).slice(),
      attachments: (currentAttachments || []).slice(),
      savedAt: new Date().toISOString()
    };
    localStorage.setItem(STORAGE_KEYS.brouillonCourant, JSON.stringify(data));
  } catch (e) { console.warn('saveBrouillon :', e); }
}

function loadBrouillon() {
  try {
    if (!window.STORAGE_KEYS || !window.STORAGE_KEYS.brouillonCourant) return false;
    var raw = localStorage.getItem(STORAGE_KEYS.brouillonCourant);
    if (!raw) return false;
    var data = JSON.parse(raw);
    if (!data || typeof data !== 'object') return false;

    _invSet('invoiceType', data.type || 'facture');
    _invSet('invoiceNumero', data.numero || '');
    _invSet('invoiceDate', data.date || todayISO());
    _invSet('invoiceSujet', data.sujet || '');
    _invSet('invoiceNotes', data.notes || '');
    _invSet('invoiceClientSelect', data.clientId || '');
    _invSet('invoiceChantierSelect', data.chantierId || '');
    _invSet('invoiceTVARate', data.tvaRate != null ? data.tvaRate : VOLTCORE_TVA_DEFAULT);
    _invSet('invoiceTimbre', data.timbre != null ? data.timbre : VOLTCORE_TIMBRE_DEFAULT);
    _invSet('invoiceRetenueIR', data.retenueIR || '0');
    _invSet('invoiceRetenueTVA', data.retenueTVA || '0');
    /* v6.7 — restaure retenue garantie */
    _invSet('invoiceRetenueGarantie', data.retenueGarantie || '0');

    currentInvoiceItems = Array.isArray(data.items) ? data.items.slice() : [];
    currentAttachments = Array.isArray(data.attachments) ? data.attachments.slice() : [];

    renderInvoiceItems();
    renderInvoiceAttachments();
    updateInvoiceTotalsDisplay();
    onInvoiceTypeChange(data.type || 'facture');

    window.__invoiceDirty = false;
    if (typeof showToast === 'function') {
      showToast('Brouillon restauré (' + currentInvoiceItems.length + ' ligne(s))', 'info', 2500);
    }
    return true;
  } catch (e) { console.warn('loadBrouillon :', e); return false; }
}

function clearBrouillon() {
  try {
    if (!window.STORAGE_KEYS) return;
    localStorage.removeItem(STORAGE_KEYS.brouillonCourant);
  } catch (e) {}
}

/* ═══════════ SECTION 10 — SAUVEGARDE ═══════════ */

function _validateInvoice() {
  try {
    var type = _invGet('invoiceType') || 'facture';
    var tdef = INVOICE_TYPES[type] || INVOICE_TYPES.facture;

    var clientId = _invGet('invoiceClientSelect');
    if (tdef.requiresClient && !clientId) {
      return { ok: false, error: 'Sélectionne un client.' };
    }
    var date = _invGet('invoiceDate');
    if (!date || !isValidDateString(date)) {
      return { ok: false, error: 'Date invalide.' };
    }
    if (!Array.isArray(currentInvoiceItems) || currentInvoiceItems.length === 0) {
      return { ok: false, error: 'Ajoute au moins une ligne.' };
    }
    for (var i = 0; i < currentInvoiceItems.length; i++) {
      var it = currentInvoiceItems[i];
      if (!it || !String(it.designation || '').trim()) {
        return { ok: false, error: 'Ligne ' + (i + 1) + ' : désignation vide.' };
      }
      if (parseNumber(it.quantite) <= 0) {
        return { ok: false, error: 'Ligne ' + (i + 1) + ' : quantité > 0 requise.' };
      }
      /* v6.8.1 — garde-fou quantité max (VOLTCORE_MAX_DOCUMENT_QTY = 10 M).
         Protège contre un copier-coller accidentel (ex : 1e12) qui ferait
         planter le rendu PDF ou fausserait le total HT. */
      if (parseNumber(it.quantite) > VOLTCORE_MAX_DOCUMENT_QTY) {
        return { ok: false, error: 'Ligne ' + (i + 1) + ' : quantité ' +
          parseNumber(it.quantite) + ' > ' + VOLTCORE_MAX_DOCUMENT_QTY +
          ' (saisie suspecte).' };
      }
      if (parseNumber(it.prix) < 0) {
        return { ok: false, error: 'Ligne ' + (i + 1) + ' : prix invalide.' };
      }
      /* v6.8.1 — garde-fou PU max (VOLTCORE_MAX_DOCUMENT_PU = 1 M DT).
         En Tunisie, un PU > 1 M DT n'a aucun sens métier même pour du
         matériel lourd. Typo = probable. */
      if (parseNumber(it.prix) > VOLTCORE_MAX_DOCUMENT_PU) {
        return { ok: false, error: 'Ligne ' + (i + 1) + ' : prix ' +
          parseNumber(it.prix) + ' DT > ' + VOLTCORE_MAX_DOCUMENT_PU +
          ' DT (saisie suspecte).' };
      }
      /* v6.7 — validation remise */
      var rem = parseNumber(it.remise);
      if (rem < 0 || rem > 100) {
        return { ok: false, error: 'Ligne ' + (i + 1) + ' : remise doit être entre 0 et 100.' };
      }
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: 'Erreur de validation : ' + (e.message || '') };
  }
}

function _buildDocumentFromForm() {
  try {
    var totals = computeInvoiceTotals();
    var items = [];
    for (var i = 0; i < currentInvoiceItems.length; i++) {
      var it = currentInvoiceItems[i];
      if (!it) continue;
      /* v6.7 — utilise computeLineTotal pour le total de ligne */
      var ligneTotal = (typeof computeLineTotal === 'function')
        ? computeLineTotal(it)
        : parseNumber(it.quantite) * parseNumber(it.prix);
      items.push({
        articleId: String(it.articleId || ''),
        designation: String(it.designation || '').trim(),
        quantite: parseNumber(it.quantite),
        prix: parseNumber(it.prix),
        unite: String(it.unite || 'U'),
        remise: parseNumber(it.remise),
        total: ligneTotal
      });
    }

      var type = _invGet('invoiceType') || 'facture';
    var doc = {
      id: '',
      numero: _invGet('invoiceNumero') || '',
      type: type,
      date: _invGet('invoiceDate') || todayISO(),
      clientId: _invGet('invoiceClientSelect'),
      chantierId: _invGet('invoiceChantierSelect') || '',
      sujet: _invGet('invoiceSujet'),
      notes: _invGet('invoiceNotes'),
      items: items,
      totals: totals,
      retenueMontant: totals.retenueMontant,
      retenueGarantie: totals.retenueGarantie,  /* ⬇ NOUVEAU v6.8 (raccourci) */
      paiements: [],
      attachments: (currentAttachments || []).slice(),
      parentFactureId: window.__pendingAvoirParentId || null,
      avoirIds: [],
      statut: 'emise',
      createdAt: '',
      updatedAt: new Date().toISOString()
    };
    return doc;
  } catch (e) { console.warn('_buildDocumentFromForm :', e); return null; }
}

function saveInvoice() {
  try {
    var v = _validateInvoice();
    if (!v.ok) {
      _invSetText('invoiceFormError', v.error);
      if (typeof showToast === 'function') showToast(v.error, 'error', 4000);
      return false;
    }
    _invSetText('invoiceFormError', '');

    var doc = _buildDocumentFromForm();
    if (!doc) {
      _invSetText('invoiceFormError', 'Erreur de construction.');
      return false;
    }

    /* Détermine si création ou édition */
    var editId = window.__invoiceEditId;
    if (editId) {
      var existing = null;
      if (Array.isArray(savedDocuments)) {
        for (var k = 0; k < savedDocuments.length; k++) {
          if (savedDocuments[k] && String(savedDocuments[k].id) === String(editId)) {
            existing = savedDocuments[k]; break;
          }
        }
      }
      if (!existing) {
        _invSetText('invoiceFormError', 'Document introuvable.');
        return false;
      }
      doc.id = existing.id;
      doc.numero = existing.numero;
      doc.createdAt = existing.createdAt;
      doc.paiements = Array.isArray(existing.paiements) ? existing.paiements.slice() : [];
      doc.avoirIds = Array.isArray(existing.avoirIds) ? existing.avoirIds.slice() : [];
      doc.statut = existing.statut || 'emise';
      /* v6.8 — préserve l'état de la garantie BTP à l'édition */
      doc.garantieLiberee = existing.garantieLiberee === true;
      doc.dateLiberation = existing.dateLiberation || null;
      var idx = savedDocuments.indexOf(existing);
      savedDocuments[idx] = doc;
      window.__invoiceEditId = null;
    } else {
      doc.id = 'doc_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      if (!doc.numero) doc.numero = genererNumero(doc.type);
      doc.createdAt = new Date().toISOString();
      savedDocuments.push(doc);
      incrementerCompteur(doc.type);
    }

    /* Si c'est un avoir, on ajoute l'ID au parent (sécurité immédiate,
       la sync complète se fera dans saveAll via _synchronizeAvoirIds) */
    if (doc.type === 'avoir' && doc.parentFactureId) {
      if (Array.isArray(savedDocuments)) {
        for (var p = 0; p < savedDocuments.length; p++) {
          if (savedDocuments[p] && String(savedDocuments[p].id) === String(doc.parentFactureId)) {
            if (!Array.isArray(savedDocuments[p].avoirIds)) savedDocuments[p].avoirIds = [];
            if (savedDocuments[p].avoirIds.indexOf(doc.id) < 0) {
              savedDocuments[p].avoirIds.push(doc.id);
            }
            break;
          }
        }
      }
    }

    saveAll();
    clearBrouillon();
    window.__invoiceDirty = false;
    window.__pendingAvoirParentId = null;

    if (typeof logAction === 'function') {
      logAction('doc.' + doc.type + '.' + (editId ? 'update' : 'create'),
        doc.numero + ' ' + formatMoney(doc.totals.total));
    }

    closeInvoiceForm();

    if (typeof showToast === 'function') {
      showToast('Document enregistré : ' + doc.numero, 'success', 3000);
    }

    /* Refresh global si dispo, sinon refresh facture list uniquement */
    try {
      if (typeof refreshAllUI === 'function') refreshAllUI();
      else if (typeof renderInvoices === 'function') renderInvoices();
    } catch (e) {}

    return true;
  } catch (e) {
    console.warn('saveInvoice :', e);
    _invSetText('invoiceFormError', 'Erreur lors de l\'enregistrement.');
    if (typeof showToast === 'function') showToast('Erreur d\'enregistrement.', 'error');
    return false;
  }
}

/* ═══════════ SECTION 11 — ÉDITION ═══════════ */

function editInvoice(docId) {
  openEditInvoice(docId);
}

function openEditInvoice(docId) {
  try {
    if (!docId || !Array.isArray(savedDocuments)) return;
    var doc = null;
    for (var i = 0; i < savedDocuments.length; i++) {
      if (savedDocuments[i] && String(savedDocuments[i].id) === String(docId)) {
        doc = savedDocuments[i]; break;
      }
    }
    if (!doc) {
      if (typeof showToast === 'function') showToast('Document introuvable.', 'error');
      return;
    }

    _resetInvoiceForm();
    window.__invoiceEditId = String(doc.id);

    _invSet('invoiceEditId', doc.id);
    _invSet('invoiceType', doc.type || 'facture');
    _invSet('invoiceNumero', doc.numero || '');
    var numEl = document.getElementById('invoiceNumero');
    if (numEl) numEl.disabled = true; /* on ne change pas le numéro en édition */
    _invSet('invoiceDate', String(doc.date || '').slice(0, 10) || todayISO());
    _invSet('invoiceSujet', doc.sujet || '');
    _invSet('invoiceNotes', doc.notes || '');

    _populateInvoiceClientsSelect(doc.clientId || '');
    _populateInvoiceChantiersSelect(doc.chantierId || '');

    var t = doc.totals || {};
    _invSet('invoiceTVARate', t.tvaRate != null ? t.tvaRate : VOLTCORE_TVA_DEFAULT);
    _invSet('invoiceTimbre', t.timbre != null ? t.timbre : VOLTCORE_TIMBRE_DEFAULT);
    _invSet('invoiceRetenueIR', t.retenueIRRate != null ? t.retenueIRRate : '0');
    _invSet('invoiceRetenueTVA', t.retenueTVARate != null ? t.retenueTVARate : '0');
    /* v6.7 — restaure la retenue garantie BTP */
    _invSet('invoiceRetenueGarantie', t.retenueGarantieRate != null ? t.retenueGarantieRate : '0');

    /* v6.8 — affiche l'info de libération si la garantie est déjà libérée */
    var libInfo = document.getElementById('invoiceGarantieLiberationInfo');
    var libDate = document.getElementById('invoiceGarantieLiberationDate');
    if (doc.garantieLiberee === true && doc.dateLiberation) {
      if (libInfo) libInfo.style.display = '';
      if (libDate) libDate.textContent = formatDate(doc.dateLiberation);
    } else {
      if (libInfo) libInfo.style.display = 'none';
      if (libDate) libDate.textContent = '';
    }

    /* Items */
    currentInvoiceItems = [];
    if (Array.isArray(doc.items)) {
      for (var j = 0; j < doc.items.length; j++) {
        var it = doc.items[j];
        if (!it) continue;
        currentInvoiceItems.push({
          articleId: it.articleId || '',
          designation: it.designation || '',
          quantite: it.quantite != null ? it.quantite : 1,
          prix: it.prix != null ? it.prix : 0,
          unite: it.unite || 'U',
          remise: it.remise || 0
        });
      }
    }

    /* Attachments */
    currentAttachments = Array.isArray(doc.attachments) ? doc.attachments.slice() : [];

    renderInvoiceItems();
    renderInvoiceAttachments();
    updateInvoiceTotalsDisplay();
    onInvoiceTypeChange(doc.type || 'facture');

    window.__invoiceDirty = false;

    var modal = document.getElementById('invoiceModal');
    if (modal) modal.style.display = 'flex';
  } catch (e) { console.warn('openEditInvoice :', e); }
}

/* ═══════════ SECTION 12 — AVOIRS ═══════════ */

/* Crée un avoir depuis une facture existante. */
function createAvoirFromFacture(invoiceId) {
  try {
    if (!invoiceId || !Array.isArray(savedDocuments)) return;
    var facture = null;
    for (var i = 0; i < savedDocuments.length; i++) {
      if (savedDocuments[i] && String(savedDocuments[i].id) === String(invoiceId)) {
        facture = savedDocuments[i]; break;
      }
    }
    if (!facture) {
      if (typeof showToast === 'function') showToast('Facture introuvable.', 'error');
      return;
    }
    if (facture.type !== 'facture') {
      if (typeof showToast === 'function') showToast('Un avoir se crée uniquement depuis une facture.', 'warning');
      return;
    }

    _resetInvoiceForm();
    window.__pendingAvoirParentId = String(facture.id);

    _invSet('invoiceType', 'avoir');
    _invSet('invoiceDate', todayISO());
    _invSet('invoiceSujet', 'Avoir sur facture ' + (facture.numero || ''));
    _invSet('invoiceNotes', 'Référence : ' + (facture.numero || '') +
      (facture.sujet ? ' — ' + facture.sujet : ''));

    _populateInvoiceClientsSelect(facture.clientId || '');
    _populateInvoiceChantiersSelect(facture.chantierId || '');

    var t = facture.totals || {};
    _invSet('invoiceTVARate', t.tvaRate != null ? t.tvaRate : VOLTCORE_TVA_DEFAULT);
    _invSet('invoiceTimbre', '0');
    _invSet('invoiceRetenueIR', '0');
    _invSet('invoiceRetenueTVA', '0');
    /* v6.7 — pas de retenue garantie sur un avoir */
    _invSet('invoiceRetenueGarantie', '0');

    /* Items de la facture, en quantité positive (avoir = facture inversée
       mais les montants restent positifs, la logique métier gère la déduction) */
    currentInvoiceItems = [];
    if (Array.isArray(facture.items)) {
      for (var j = 0; j < facture.items.length; j++) {
        var it = facture.items[j];
        if (!it) continue;
        currentInvoiceItems.push({
          articleId: it.articleId || '',
          designation: it.designation || '',
          quantite: it.quantite != null ? it.quantite : 1,
          prix: it.prix != null ? it.prix : 0,
          unite: it.unite || 'U',
          remise: it.remise || 0
        });
      }
    }
    currentAttachments = [];

    renderInvoiceItems();
    renderInvoiceAttachments();
    updateInvoiceTotalsDisplay();
    onInvoiceTypeChange('avoir');

    var modal = document.getElementById('invoiceModal');
    if (modal) modal.style.display = 'flex';

    if (typeof showToast === 'function') {
      showToast('Avoir préparé. Vérifie puis enregistre.', 'info', 3000);
    }
  } catch (e) { console.warn('createAvoirFromFacture :', e); }
}

/* Alias pour compat */
function openAvoirFromInvoice(invoiceId) {
  return createAvoirFromFacture(invoiceId);
}

/* ═══════════ SECTION 13 — ÉVÉNEMENTS ═══════════ */

function attachInvoicesEvents() {
  try {
    /* Bouton ajouter ligne */
    var addItemBtn = document.getElementById('btnAddInvoiceItem');
    if (addItemBtn && !addItemBtn.__bound) {
      addItemBtn.__bound = true;
      addItemBtn.addEventListener('click', function () {
        addInvoiceItem({
          designation: '',
          quantite: 1,
          prix: 0,
          unite: 'U'
        });
      });
    }

    /* v6.7 — Bouton "+ Depuis stock" branché sur le picker d'articles */
    var addFromStockBtn = document.getElementById('btnAddItemFromStock');
    if (addFromStockBtn && !addFromStockBtn.__bound) {
      addFromStockBtn.__bound = true;
      addFromStockBtn.addEventListener('click', function () {
        if (typeof openArticlePicker === 'function') {
          openArticlePicker(function (art) {
            try {
              addInvoiceItem({
                articleId: art.id,
                designation: art.nom || art.designation || '',
                quantite: 1,
                prix: typeof art.prix === 'number' ? art.prix : parseNumber(art.prix),
                unite: art.unite || 'U'
              });
            } catch (e) { console.warn('picker callback :', e); }
          });
        } else {
          /* Fallback prompt si 08-stock.js pas chargé */
          var aid = (typeof promptDialog === 'function')
            ? promptDialog('ID de l\'article (ex: art_xxx) :')
            : window.prompt('ID de l\'article :');
          if (aid) addInvoiceItemFromArticle(aid);
        }
      });
    }

    /* Bouton ajouter pièce jointe */
    var attachBtn = document.getElementById('btnAddInvoiceAttachment');
    if (attachBtn && !attachBtn.__bound) {
      attachBtn.__bound = true;
      attachBtn.addEventListener('click', addInvoiceAttachment);
    }

    /* Bouton brouillon explicite */
    var draftBtn = document.getElementById('btnSaveBrouillon');
    if (draftBtn && !draftBtn.__bound) {
      draftBtn.__bound = true;
      draftBtn.addEventListener('click', function () {
        window.__invoiceDirty = true;
        saveBrouillon();
        if (typeof showToast === 'function') showToast('Brouillon sauvegardé', 'success', 2000);
      });
    }

    /* Bouton vider brouillon */
    var clearDraftBtn = document.getElementById('btnClearBrouillon');
    if (clearDraftBtn && !clearDraftBtn.__bound) {
      clearDraftBtn.__bound = true;
      clearDraftBtn.addEventListener('click', function () {
        clearBrouillon();
        _resetInvoiceForm();
        if (typeof showToast === 'function') showToast('Brouillon vidé', 'info', 2000);
      });
    }

    /* Select type */
    var typeSel = document.getElementById('invoiceType');
    if (typeSel && !typeSel.__bound) {
      typeSel.__bound = true;
      typeSel.addEventListener('change', function (ev) {
        onInvoiceTypeChange(ev.target.value);
        _invDirty();
      });
    }

    /* v6.7 — Select client → préremplissage TVA/timbre selon type client */
    var clientSel = document.getElementById('invoiceClientSelect');
    if (clientSel && !clientSel.__bound) {
      clientSel.__bound = true;
      clientSel.addEventListener('change', function (ev) {
        _applyClientDefaults(ev.target.value);
        _invDirty();
      });
    }

    /* Inputs totaux (recalcul live) — v6.8.1
       Ajout : traçage de la saisie manuelle du timbre via
       window.__invoiceTimbreUserZero. Sans ce flag, onInvoiceTypeChange
       ne sait pas si l'utilisateur a tapé 0 intentionnellement. */
    var totalInputs = ['invoiceTVARate', 'invoiceTimbre', 'invoiceRetenueIR',
                       'invoiceRetenueTVA', 'invoiceRetenueGarantie'];
    for (var i = 0; i < totalInputs.length; i++) {
      var inp = document.getElementById(totalInputs[i]);
      if (inp && !inp.__bound) {
        inp.__bound = true;
        inp.addEventListener('input', function (ev) {
          updateInvoiceTotalsDisplay();
          _invDirty();
          /* Mémorise si l'utilisateur a tapé 0 dans le timbre.
             Utilise ev.target (pas inp) pour éviter le bug de closure. */
          if (ev && ev.target && ev.target.id === 'invoiceTimbre') {
            var v = parseFloat(ev.target.value);
            window.__invoiceTimbreUserZero = (v === 0);
          }
        });
      }
    }

    /* Champs texte / select → dirty */
    var dirtyFields = ['invoiceDate', 'invoiceSujet', 'invoiceNotes',
      'invoiceChantierSelect'];
    for (var j = 0; j < dirtyFields.length; j++) {
      var f = document.getElementById(dirtyFields[j]);
      if (f && !f.__bound) {
        f.__bound = true;
        f.addEventListener('change', function () { _invDirty(); });
      }
    }

    /* Bouton enregistrer */
    var saveBtn = document.getElementById('invoiceSaveBtn');
    if (saveBtn && !saveBtn.__bound) {
      saveBtn.__bound = true;
      saveBtn.addEventListener('click', saveInvoice);
    }
  } catch (e) { console.warn('attachInvoicesEvents :', e); }
}

/* Avertit si données non sauvegardées */
try {
  window.addEventListener('beforeunload', function (ev) {
    if (window.__invoiceDirty) {
      try { saveBrouillon(); } catch (e) {}
    }
  });
} catch (e) {}

console.log('✅ 11-invoices.js chargé — v6.7 (remise + colonne + picker + garantie BTP + préremplissage TVA)');