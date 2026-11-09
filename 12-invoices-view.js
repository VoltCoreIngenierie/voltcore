/* ═══════════════════════════════════════════════════════════════
   VOLTCORE — 12-invoices-view.js
   VERSION : v6.7.2 (Session #3 — PDF aligné facture.html)
   RÔLE : Liste documents, filtres, détail, PDF, WhatsApp, Email,
          paiements, avoirs, suppression avec undo, pagination
   DÉPENDANCES : 01-core.js, 03-utils.js (v6.6+ avec
                  numberToFrenchWords), 04-storage.js,
                  06-clients.js
   ═══ PARTIE A — SECTIONS 1 à 6 ═══
   ═══════════════════════════════════════════════════════════════ */

/* ═══════════ SECTION 1 — ÉTAT + CONSTANTES ═══════════ */

var __invoicesSearchTerm = '';
var __invoicesFilter = 'all';
var __invoicesClientFilter = '';
var __invoiceDetailId = null;
var __paymentDocId = null;

var __invoicesPage = 0;
var __invoicesPerPage = 50;

var DOC_TYPE_LABELS = {
  devis: 'Devis', bl: 'Bon de livraison', facture: 'Facture',
  attachement: 'Attachement', avoir: 'Avoir'
};

/* ═══════════ SECTION 2 — HELPERS ═══════════ */

function getDocById(id) {
  try {
    if (!id || !Array.isArray(savedDocuments)) return null;
    var sid = String(id);
    for (var i = 0; i < savedDocuments.length; i++) {
      if (savedDocuments[i] && String(savedDocuments[i].id) === sid) return savedDocuments[i];
    }
    return null;
  } catch (e) { return null; }
}

function _docTotal(doc) {
  if (!doc) return 0;
  if (doc.totals && typeof doc.totals.total === 'number') return doc.totals.total;
  if (typeof doc.totalTTC === 'number') return doc.totalTTC;
  return 0;
}

function _docNet(doc) {
  if (!doc) return 0;
  if (typeof getNetRevenu === 'function') {
    var n = getNetRevenu(doc);
    return n < 0 ? 0 : n;
  }
  var total = _docTotal(doc);
  var retenue = (typeof doc.retenueMontant === 'number') ? doc.retenueMontant : 0;
  var net = total - retenue;
  return net > 0 ? net : 0;
}

function _docTypeLabel(doc) {
  if (!doc) return 'Document';
  return DOC_TYPE_LABELS[doc.type] || 'Document';
}

function _docDate(doc) {
  if (!doc) return '';
  return String(doc.date || '').slice(0, 10);
}

function _statutLabel(statut) {
  var m = {
    brouillon: 'Brouillon', annulee: 'Annulée', payee: 'Payée',
    partielle: 'Partielle', impayee: 'Impayée', avoir: 'Avoir'
  };
  return m[statut] || statut;
}

function _statutColor(statut) {
  if (statut === 'payee') return 'var(--success)';
  if (statut === 'partielle') return 'var(--warning)';
  if (statut === 'impayee') return 'var(--danger)';
  if (statut === 'annulee') return 'var(--muted)';
  if (statut === 'avoir') return 'var(--info)';
  return 'var(--muted)';
}

function _viewSet(id, value) {
  try { var el = document.getElementById(id); if (el) el.value = value == null ? '' : value; } catch (e) {}
}
function _viewGet(id) {
  try { var el = document.getElementById(id); return el ? String(el.value || '').trim() : ''; } catch (e) { return ''; }
}

function _docClientNom(doc) {
  if (!doc) return { nom: '', orphelin: false };
  if (doc.clientId && typeof getClientById === 'function') {
    var c = getClientById(doc.clientId);
    if (c && c.nom) return { nom: String(c.nom), orphelin: false };
  }
  if (doc._clientNomOrphelin) {
    return { nom: String(doc._clientNomOrphelin), orphelin: true };
  }
  return { nom: '', orphelin: false };
}

function _lineTotal(it) {
  if (!it) return 0;
  if (typeof computeLineTotal === 'function') return computeLineTotal(it);
  return parseNumber(it.quantite) * parseNumber(it.prix);
}

function _docAvoirTotal(doc, avoirsCache) {
  if (!doc || !doc.id) return 0;
  if (doc.type !== 'facture') return 0;
  if (avoirsCache && avoirsCache.hasOwnProperty(String(doc.id))) {
    return avoirsCache[String(doc.id)];
  }
  if (typeof getAvoirTotalForFacture === 'function') {
    return getAvoirTotalForFacture(doc.id);
  }
  return 0;
}

function _docNetApresAvoirs(doc, avoirTotal) {
  if (!doc) return 0;
  var t = doc.totals || {};
  var base;
  if (t.netAPayer != null && isFinite(t.netAPayer)) {
    base = parseFloat(t.netAPayer);
  } else {
    var total = _docTotal(doc);
    var retenue = (typeof t.retenueMontant === 'number') ? t.retenueMontant : 0;
    var retGarantie = (typeof t.retenueGarantie === 'number') ? t.retenueGarantie : 0;
    base = total - retenue - retGarantie;
  }
  var net = base - (avoirTotal || 0);
  /* v6.8.1 — Clamp à 0 : un avoir ne peut jamais rendre le net négatif.
     Les deux appelants actuels (_renderInvoiceDetailBody et _buildInvoiceHTML)
     clampent déjà, mais on centralise ici pour tout futur appelant
     (ex : rapport « Garanties » v6.9 qui pourrait l'utiliser directement).
     Si net < 0, cela signifie avoir > TTC → erreur de saisie ou cas
     extrême d'annulation. Afficher "-XXX DT" au client serait trompeur. */
  if (!isFinite(net) || net < 0) return 0;
  return net;
}

/* ═══════════ SECTION 3 — RENDU LISTE + PAGINATION ═══════════ */

function renderInvoices() {
  try {
    var container = document.getElementById('invoicesList');
    if (!container) return;

    var list = getFilteredInvoices();
    var total = list.length;

    var paginationContainer = document.getElementById('invoicesPagination');
    if (!paginationContainer && container.parentNode) {
      paginationContainer = document.createElement('div');
      paginationContainer.id = 'invoicesPagination';
      paginationContainer.className = 'pagination';
      paginationContainer.style.marginTop = '16px';
      paginationContainer.style.display = 'flex';
      paginationContainer.style.justifyContent = 'center';
      paginationContainer.style.alignItems = 'center';
      paginationContainer.style.gap = '12px';

      var btnPrev = document.createElement('button');
      btnPrev.id = 'invoicesPrevBtn';
      btnPrev.className = 'btn btn-sm';
      btnPrev.textContent = '◀ Précédent';
      btnPrev.onclick = function () { setInvoicesPage(__invoicesPage - 1); };

      var spanInfo = document.createElement('span');
      spanInfo.id = 'invoicesPageInfo';
      spanInfo.className = 'muted';
      spanInfo.style.fontSize = '13px';

      var btnNext = document.createElement('button');
      btnNext.id = 'invoicesNextBtn';
      btnNext.className = 'btn btn-sm';
      btnNext.textContent = 'Suivant ▶';
      btnNext.onclick = function () { setInvoicesPage(__invoicesPage + 1); };

      paginationContainer.appendChild(btnPrev);
      paginationContainer.appendChild(spanInfo);
      paginationContainer.appendChild(btnNext);

      try {
        container.parentNode.insertBefore(paginationContainer, container.nextSibling);
      } catch (e) {
        console.warn('Pagination :', e);
      }
    }

    if (total === 0) {
      container.innerHTML = '<div class="empty-state">Aucun document' +
        (__invoicesSearchTerm || __invoicesFilter !== 'all' ? ' pour ce filtre' : '') +
        '. Clique sur "+ Nouveau document" pour commencer.</div>';
      _updateInvoicesCount(0);
      _updateInvoicesPagination(0, 0, 0);
      return;
    }

    var perPage = __invoicesPerPage;
    var page = __invoicesPage;
    var maxPage = Math.max(0, Math.ceil(total / perPage) - 1);
    if (page > maxPage) { page = maxPage; __invoicesPage = page; }
    var start = page * perPage;
    var end = Math.min(start + perPage, total);
    var slice = list.slice(start, end);

    var avoirsCache = {};
    if (typeof getAvoirTotalForFacture === 'function') {
      for (var c = 0; c < slice.length; c++) {
        if (slice[c] && slice[c].id && slice[c].type === 'facture') {
          avoirsCache[String(slice[c].id)] = getAvoirTotalForFacture(slice[c].id);
        }
      }
    }

    var html = '';
    for (var i = 0; i < slice.length; i++) html += renderInvoiceRow(slice[i], avoirsCache);
    container.innerHTML = html;

    _updateInvoicesCount(total);
    _updateInvoicesPagination(page, maxPage, total);
  } catch (e) { console.warn('renderInvoices :', e); }
}

function _updateInvoicesPagination(page, maxPage, total) {
  try {
    var info = document.getElementById('invoicesPageInfo');
    if (info) {
      info.textContent = total > 0
        ? 'Page ' + (page + 1) + ' / ' + (maxPage + 1) + ' — ' + total + ' doc(s)'
        : '0 document';
    }
    var prev = document.getElementById('invoicesPrevBtn');
    if (prev) prev.disabled = (page <= 0);
    var next = document.getElementById('invoicesNextBtn');
    if (next) next.disabled = (page >= maxPage);
  } catch (e) {}
}

function setInvoicesPage(p) {
  __invoicesPage = Math.max(0, parseInt(p, 10) || 0);
  renderInvoices();
}

function _resetInvoicesPage() {
  __invoicesPage = 0;
}

function renderInvoiceRow(doc, avoirsCache) {
  try {
    if (!doc) return '';
    var id = escapeAttr(doc.id);
    var statut = (typeof getStatutPaiement === 'function') ? getStatutPaiement(doc) : 'emise';
    var statutLbl = _statutLabel(statut);
    var statutColor = _statutColor(statut);

    var clientInfo = _docClientNom(doc);
    var clientNom;
    if (clientInfo.nom) {
      clientNom = escapeHtml(clientInfo.nom);
      if (clientInfo.orphelin) {
        clientNom += ' <span class="muted" style="font-size:10px">(non enregistré)</span>';
      }
    } else {
      clientNom = '<span class="muted">Sans client</span>';
    }

    var total = _docTotal(doc);
    var avoirTotal = _docAvoirTotal(doc, avoirsCache);
    var reste = (typeof getResteAPayer === 'function') ? getResteAPayer(doc) : 0;

    var amountsHtml = 'Total : <strong>' + formatMoney(total) + '</strong>';
    if (avoirTotal > 0.001) {
      amountsHtml += ' · Avoirs : <strong style="color:var(--info)">−' + formatMoney(avoirTotal) + '</strong>';
    }
    if (reste > 0.001) {
      amountsHtml += ' · Reste : <strong style="color:var(--danger)">' + formatMoney(reste) + '</strong>';
    }

    return '<div class="invoice-row" data-doc-id="' + id + '">' +
      '<div class="invoice-row-main">' +
        '<div class="invoice-row-header">' +
          '<span class="doc-type-badge doc-type-' + escapeAttr(doc.type || 'facture') + '">' +
          escapeHtml(_docTypeLabel(doc)) + '</span>' +
          ' <strong>' + escapeHtml(doc.numero || '—') + '</strong>' +
          ' <span class="badge" style="background:' + statutColor + ';color:#fff">' +
          escapeHtml(statutLbl) + '</span>' +
        '</div>' +
        '<div class="invoice-row-meta">' +
          clientNom +
          ' · ' + escapeHtml(formatDate(_docDate(doc))) +
          (doc.sujet ? ' · ' + escapeHtml(doc.sujet) : '') +
        '</div>' +
        '<div class="invoice-row-amounts">' + amountsHtml + '</div>' +
      '</div>' +
      '<div class="invoice-row-actions">' +
        '<button type="button" class="btn-icon" title="Détail" onclick="openInvoiceDetail(\'' + id + '\')">👁️</button>' +
        '<button type="button" class="btn-icon" title="Éditer" onclick="openEditInvoice(\'' + id + '\')">✏️</button>' +
        '<button type="button" class="btn-icon" title="PDF" onclick="printInvoicePDF(\'' + id + '\')">🖨️</button>' +
        '<button type="button" class="btn-icon" title="WhatsApp" onclick="shareInvoiceWhatsApp(\'' + id + '\')">💬</button>' +
        '<button type="button" class="btn-icon" title="Email" onclick="shareInvoiceEmail(\'' + id + '\')">✉️</button>' +
        '<button type="button" class="btn-icon btn-danger" title="Supprimer" onclick="deleteInvoice(\'' + id + '\')">🗑️</button>' +
      '</div>' +
    '</div>';
  } catch (e) { console.warn('renderInvoiceRow :', e); return ''; }
}

function _updateInvoicesCount(n) {
  try { var el = document.getElementById('invoicesCount'); if (el) el.textContent = String(n); } catch (e) {}
}

/* ═══════════ SECTION 4 — FILTRES + RECHERCHE ═══════════ */

function setInvoicesSearch(term) {
  __invoicesSearchTerm = String(term || '');
  _resetInvoicesPage();
  renderInvoices();
}

function setInvoicesFilter(filter) {
  __invoicesFilter = filter || 'all';
  _resetInvoicesPage();
  renderInvoices();
}

function setInvoicesClientFilter(clientId) {
  __invoicesClientFilter = String(clientId || '');
  _resetInvoicesPage();
  renderInvoices();
}

function getFilteredInvoices() {
  try {
    if (!Array.isArray(savedDocuments)) return [];
    var out = savedDocuments.slice();

    if (__invoicesSearchTerm) {
      var term = normalizeText(__invoicesSearchTerm);
      out = out.filter(function (d) {
        if (!d) return false;
        var client = d.clientId && typeof getClientById === 'function' ? getClientById(d.clientId) : null;
        var hay = normalizeText([
          d.numero, d.sujet, d.notes,
          client ? client.nom : '',
          d._clientNomOrphelin || ''
        ].join(' '));
        return hay.indexOf(term) >= 0;
      });
    }

    if (__invoicesClientFilter) {
      out = out.filter(function (d) {
        return d && String(d.clientId || '') === __invoicesClientFilter;
      });
    }

    var f = __invoicesFilter;
    if (f !== 'all') {
      if (f === 'impayees') {
        out = out.filter(function (d) {
          var s = (typeof getStatutPaiement === 'function') ? getStatutPaiement(d) : '';
          return s === 'impayee' || s === 'partielle';
        });
      } else if (f === 'payees') {
        out = out.filter(function (d) {
          var s = (typeof getStatutPaiement === 'function') ? getStatutPaiement(d) : '';
          return s === 'payee';
        });
      } else if (f === 'annulees') {
        out = out.filter(function (d) { return d && d.statut === 'annulee'; });
      } else {
        out = out.filter(function (d) { return d && String(d.type) === f; });
      }
    }

    out.sort(function (a, b) {
      var da = _docDate(a), db = _docDate(b);
      if (da === db) return 0;
      return da < db ? 1 : -1;
    });
    return out;
  } catch (e) { console.warn('getFilteredInvoices :', e); return []; }
}

/* ═══════════ SECTION 5 — DÉTAIL MODAL ═══════════ */

function openInvoiceDetail(id) {
  try {
    var doc = getDocById(id);
    if (!doc) return;
    __invoiceDetailId = String(id);

    var title = document.getElementById('invoiceDetailTitle');
    if (title) title.textContent = _docTypeLabel(doc) + ' N° ' + (doc.numero || '—');

    _renderInvoiceDetailBody();

    var modal = document.getElementById('invoiceDetailModal');
    if (modal) modal.style.display = 'flex';
  } catch (e) { console.warn('openInvoiceDetail :', e); }
}

function closeInvoiceDetail() {
  try {
    var m = document.getElementById('invoiceDetailModal');
    if (m) m.style.display = 'none';
    __invoiceDetailId = null;
  } catch (e) {}
}

function _renderInvoiceDetailBody() {
  try {
    var body = document.getElementById('invoiceDetailBody');
    if (!body || !__invoiceDetailId) return;
    var doc = getDocById(__invoiceDetailId);
    if (!doc) return;

    var html = '';
    var statut = (typeof getStatutPaiement === 'function') ? getStatutPaiement(doc) : 'emise';
    var statutColor = _statutColor(statut);
    var total = _docTotal(doc);
    var avoirTotal = _docAvoirTotal(doc);
    var paye = (typeof getTotalPaye === 'function') ? getTotalPaye(doc) : 0;
    var reste = (typeof getResteAPayer === 'function') ? getResteAPayer(doc) : 0;

    html += '<div class="detail-section">';
    html += '<div class="invoice-detail-header">';
    html += '<div><strong>N° ' + escapeHtml(doc.numero || '—') + '</strong>' +
      ' <span class="badge" style="background:' + statutColor + ';color:#fff">' +
      escapeHtml(_statutLabel(statut)) + '</span></div>';
    html += '<div class="muted">' + escapeHtml(formatDate(_docDate(doc))) + '</div>';
    html += '</div>';

    var clientInfo = _docClientNom(doc);
    if (clientInfo.nom) {
      var client = doc.clientId && typeof getClientById === 'function' ? getClientById(doc.clientId) : null;
      html += '<div><strong>Client :</strong> ' + escapeHtml(clientInfo.nom);
      if (client && client.telephone) {
        html += ' <span class="muted">· ' + escapeHtml(client.telephone) + '</span>';
      } else if (clientInfo.orphelin) {
        html += ' <span class="muted">(non enregistré)</span>';
      }
      html += '</div>';
    } else {
      html += '<div><strong>Client :</strong> <span class="muted">Sans client</span></div>';
    }

    if (doc.chantierId && typeof getChantierNom === 'function') {
      html += '<div><strong>Chantier :</strong> ' + escapeHtml(getChantierNom(doc.chantierId)) + '</div>';
    }
    if (doc.sujet) html += '<div><strong>Sujet :</strong> ' + escapeHtml(doc.sujet) + '</div>';
    html += '</div>';

    if (Array.isArray(doc.items) && doc.items.length > 0) {
      html += '<div class="detail-section"><h3>Lignes</h3>';
      html += '<table class="invoice-detail-table"><thead><tr>' +
        '<th>Désignation</th><th class="right">Qté</th><th class="right">P.U.</th>' +
        '<th class="right">Total</th></tr></thead><tbody>';
      for (var i = 0; i < doc.items.length; i++) {
        var it = doc.items[i];
        if (!it) continue;
        var lt = _lineTotal(it);
        var remise = parseNumber(it.remise);
        var designationCell = escapeHtml(it.designation || '');
        if (remise > 0) {
          designationCell += ' <span class="muted" style="font-size:11px">(−' + remise + '%)</span>';
        }
        html += '<tr><td>' + designationCell + '</td>' +
          '<td class="right">' + parseNumber(it.quantite) + ' ' + escapeHtml(it.unite || 'U') + '</td>' +
          '<td class="right">' + formatMoney(parseNumber(it.prix)) + '</td>' +
          '<td class="right">' + formatMoney(lt) + '</td></tr>';
      }
      html += '</tbody></table></div>';
    }

    var t = doc.totals || {};
    html += '<div class="detail-section"><h3>Totaux</h3>';
    html += '<table class="invoice-detail-totals">';
    html += '<tr><td>Total HT</td><td class="right">' + formatMoney(t.totalHT || 0) + '</td></tr>';
    html += '<tr><td>TVA (' + (t.tvaRate || 0) + '%)</td><td class="right">' + formatMoney(t.tva || 0) + '</td></tr>';
    html += '<tr><td>Timbre</td><td class="right">' + formatMoney(t.timbre || 0) + '</td></tr>';
    html += '<tr class="bold"><td>Total TTC</td><td class="right">' + formatMoney(t.totalTTC || total) + '</td></tr>';

    if (t.retenueMontant > 0.001) {
      html += '<tr><td>Retenue IR</td><td class="right">− ' + formatMoney(t.retenueIR || 0) + '</td></tr>';
      html += '<tr><td>Retenue TVA</td><td class="right">− ' + formatMoney(t.retenueTVA || 0) + '</td></tr>';
    }
    if (t.retenueGarantie > 0.001) {
      html += '<tr><td>Retenue garantie</td><td class="right">− ' + formatMoney(t.retenueGarantie) + '</td></tr>';
    }

    if (avoirTotal > 0.001) {
      html += '<tr><td><strong>Avoirs</strong></td><td class="right" style="color:var(--danger)"><strong>− ' + formatMoney(avoirTotal) + '</strong></td></tr>';
    }

    var netApresAvoirs = _docNetApresAvoirs(doc, avoirTotal);
    if (netApresAvoirs < 0) netApresAvoirs = 0;
    html += '<tr class="bold"><td>Net après avoirs</td><td class="right">' + formatMoney(netApresAvoirs) + '</td></tr>';

    html += '<tr><td>Payé</td><td class="right">' + formatMoney(paye) + '</td></tr>';
    html += '<tr class="' + (reste > 0.001 ? 'danger' : 'success') + '"><td><strong>Reste</strong></td>' +
      '<td class="right"><strong>' + formatMoney(reste) + '</strong></td></tr>';
    html += '</table></div>';

    var paiements = Array.isArray(doc.paiements) ? doc.paiements : [];
    html += '<div class="detail-section"><h3>Paiements (' + paiements.length + ')</h3>';
    if (paiements.length === 0) {
      html += '<div class="muted">Aucun paiement enregistré.</div>';
    } else {
      html += '<table class="invoice-detail-table"><thead><tr>' +
        '<th>Date</th><th>Mode</th><th class="right">Montant</th><th></th>' +
        '</tr></thead><tbody>';
      for (var j = 0; j < paiements.length; j++) {
        var p = paiements[j];
        html += '<tr><td>' + escapeHtml(formatDate(p.date || '')) + '</td>' +
          '<td>' + escapeHtml(p.mode || '—') + '</td>' +
          '<td class="right">' + formatMoney(parseNumber(p.montant)) + '</td>' +
          '<td><button type="button" class="btn-icon btn-danger" ' +
          'onclick="removePayment(\'' + escapeAttr(doc.id) + '\',' + j + ')">🗑️</button></td></tr>';
      }
      html += '</tbody></table>';
    }
    if (reste > 0.001) {
      html += '<button type="button" class="btn btn-primary btn-sm" ' +
        'onclick="openPaymentModal(\'' + escapeAttr(doc.id) + '\')">+ Ajouter un paiement</button>';
    }
    html += '</div>';

    if (doc.type === 'facture') {
      var avoirs = listAvoirsForFacture(doc.id);
      if (avoirs.length > 0) {
        html += '<div class="detail-section"><h3>Avoirs liés (' + avoirs.length + ')</h3>';
        for (var k = 0; k < avoirs.length; k++) {
          var av = avoirs[k];
          var avTotal = _docTotal(av);
          html += '<div class="avoir-line" style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border)">' +
            '<span>📄 <strong>' + escapeHtml(av.numero || '') + '</strong></span>' +
            '<span>− ' + formatMoney(avTotal) + '</span>' +
            '<span class="muted">(' + escapeHtml(formatDate(_docDate(av))) + ')</span>' +
            '<button type="button" class="btn-icon btn-sm" onclick="openInvoiceDetail(\'' + escapeAttr(av.id) + '\')" title="Voir">👁️</button>' +
            '</div>';
        }
        html += '</div>';
      }
    }

    var atts = Array.isArray(doc.attachments) ? doc.attachments : [];
    if (atts.length > 0) {
      html += '<div class="detail-section"><h3>Pièces jointes (' + atts.length + ')</h3>';
      for (var a = 0; a < atts.length; a++) {
        var att = atts[a];
        var icon = att.type === 'image' ? '🖼️' : '📄';
        var size = (typeof formatBytes === 'function') ? formatBytes(att.size || 0) : '';
        html += '<div class="attachment-chip" style="display:inline-flex;margin:4px">' +
          icon + ' ' + escapeHtml(att.name || '') +
          (size ? ' <span class="muted">(' + escapeHtml(size) + ')</span>' : '') +
          '</div>';
      }
      html += '</div>';
    }

    html += '<div class="detail-section detail-actions">';
    html += '<button type="button" class="btn" onclick="openEditInvoice(\'' + escapeAttr(doc.id) + '\')">✏️ Éditer</button> ';
    html += '<button type="button" class="btn" onclick="printInvoicePDF(\'' + escapeAttr(doc.id) + '\')">🖨️ PDF</button> ';
    html += '<button type="button" class="btn" onclick="shareInvoiceWhatsApp(\'' + escapeAttr(doc.id) + '\')">💬 WhatsApp</button> ';
    html += '<button type="button" class="btn" onclick="shareInvoiceEmail(\'' + escapeAttr(doc.id) + '\')">✉️ Email</button>';
    if (doc.type === 'facture') {
      html += ' <button type="button" class="btn" onclick="createAvoirFromFacture(\'' + escapeAttr(doc.id) + '\')">↩️ Créer avoir</button>';

      /* v6.8.1 — Bouton « Libérer garantie BTP »
         Visible UNIQUEMENT si getGarantieStatut(doc) === 'en_attente'.
         Si déjà libérée → badge informatif avec date.
         Si aucune garantie → rien (pas de bruit visuel).
         Guard typeof systématique pour résilience si 04-storage.js
         n'est pas chargé (ne devrait pas arriver, mais garde-fou). */
      if (typeof getGarantieStatut === 'function') {
        var gStatut = getGarantieStatut(doc);
        if (gStatut === 'en_attente') {
          var gMontant = (typeof getGarantieEnAttente === 'function')
            ? getGarantieEnAttente(doc) : 0;
          if (gMontant > 0.001) {
            html += ' <button type="button" class="btn" ' +
              'style="background:var(--warning);color:#fff;border-color:var(--warning)" ' +
              'onclick="openLiberationGarantieModal(\'' + escapeAttr(doc.id) + '\')" ' +
              'title="Encaisser la garantie retenue (fin de délai de garantie)">' +
              '🔓 Libérer garantie (' + formatMoney(gMontant) + ')</button>';
          }
        } else if (gStatut === 'liberee' && doc.dateLiberation) {
          html += ' <span class="badge badge-success" style="margin-left:8px" ' +
            'title="Garantie restituée au client">' +
            '🔓 Garantie libérée le ' + escapeHtml(formatDate(doc.dateLiberation)) +
            '</span>';
        }
      }
    }
    html += '</div>';

    body.innerHTML = html;
  } catch (e) { console.warn('_renderInvoiceDetailBody :', e); }
}

/* ═══════════ SECTION 6 — PAIEMENTS ═══════════ */

function openPaymentModal(docId) {
  try {
    var doc = getDocById(docId);
    if (!doc) return;
    __paymentDocId = String(docId);

    var reste = (typeof getResteAPayer === 'function') ? getResteAPayer(doc) : 0;
    var avoirTotal = _docAvoirTotal(doc);

    _viewSet('paymentMontant', reste > 0 ? reste.toFixed(3) : '0.000');
    _viewSet('paymentDate', todayISO());
    _viewSet('paymentMode', 'espèces');
    _viewSet('paymentNote', '');

    var errEl = document.getElementById('paymentFormError');
    if (errEl) errEl.textContent = '';

    var title = document.getElementById('paymentModalTitle');
    if (title) {
      var titleText = 'Paiement — ' + (doc.numero || '');
      if (reste > 0.001) titleText += ' (reste : ' + formatMoney(reste) + ')';
      if (avoirTotal > 0.001) titleText += ' [avoirs : −' + formatMoney(avoirTotal) + ']';
      title.textContent = titleText;
    }

    var modal = document.getElementById('paymentModal');
    if (modal) modal.style.display = 'flex';
  } catch (e) { console.warn('openPaymentModal :', e); }
}

function savePaymentFromForm() {
  try {
    var doc = getDocById(__paymentDocId);
    if (!doc) return;

    var errEl = document.getElementById('paymentFormError');
    var montant = parseNumber(_viewGet('paymentMontant'));
    var date = _viewGet('paymentDate');
    var mode = _viewGet('paymentMode') || 'espèces';
    var note = _viewGet('paymentNote');

    if (!(montant > 0)) {
      if (errEl) errEl.textContent = 'Montant > 0 requis.';
      return;
    }
    if (!isValidDateString(date)) {
      if (errEl) errEl.textContent = 'Date invalide.';
      return;
    }
    var reste = (typeof getResteAPayer === 'function') ? getResteAPayer(doc) : 0;
    if (montant > reste + 0.01) {
      if (errEl) errEl.textContent = 'Montant supérieur au reste (' + formatMoney(reste) + ').';
      return;
    }

    if (!Array.isArray(doc.paiements)) doc.paiements = [];
    doc.paiements.push({
      date: date, montant: montant, mode: mode, note: note,
      addedAt: new Date().toISOString()
    });

    if (typeof saveAll === 'function') saveAll();

    if (typeof window.invalidateClientStatsCache === 'function' && doc.clientId) {
      window.invalidateClientStatsCache(doc.clientId);
    }

    if (typeof logAction === 'function') {
      logAction('doc.payment', doc.numero + ' ' + formatMoney(montant));
    }

    var modal = document.getElementById('paymentModal');
    if (modal) modal.style.display = 'none';
    __paymentDocId = null;

    renderInvoices();
    if (__invoiceDetailId) _renderInvoiceDetailBody();
    if (typeof showToast === 'function') showToast('Paiement enregistré', 'success', 2500);
  } catch (e) { console.warn('savePaymentFromForm :', e); }
}

function removePayment(docId, index) {
  try {
    var doc = getDocById(docId);
    if (!doc || !Array.isArray(doc.paiements)) return;
    if (index < 0 || index >= doc.paiements.length) return;
    var removed = doc.paiements[index];
    doc.paiements.splice(index, 1);

    if (typeof saveAll === 'function') saveAll();
    if (typeof window.invalidateClientStatsCache === 'function' && doc.clientId) {
      window.invalidateClientStatsCache(doc.clientId);
    }
    if (typeof logAction === 'function') {
      logAction('doc.payment.delete', doc.numero + ' ' + formatMoney(parseNumber(removed.montant)));
    }
    renderInvoices();
    if (__invoiceDetailId) _renderInvoiceDetailBody();

    if (typeof showUndoToast === 'function') {
      showUndoToast('Paiement supprimé (' + formatMoney(parseNumber(removed.montant)) + ')',
        function () {
          if (!Array.isArray(doc.paiements)) doc.paiements = [];
          doc.paiements.splice(index, 0, removed);
          if (typeof saveAll === 'function') saveAll();
          if (typeof window.invalidateClientStatsCache === 'function' && doc.clientId) {
            window.invalidateClientStatsCache(doc.clientId);
          }
          renderInvoices();
          if (__invoiceDetailId) _renderInvoiceDetailBody();
        }, 5000);
    } else if (typeof showToast === 'function') {
      showToast('Paiement supprimé', 'info', 2000);
    }
  } catch (e) { console.warn('removePayment :', e); }
}

/* ═══════════════════════════════════════════════════════════════
   ═══ SUITE PARTIE B ═══
   Sections 7 à 11 (prochaine réponse) :
   §7 PDF (nouveau _buildInvoiceHTML aligné facture.html)
   §8 WhatsApp/Email
   §9 Suppression + undo
   §10 Avoirs
   §11 Événements
   ═══════════════════════════════════════════════════════════════ */
   /* ═══════════ SECTION 7 — PDF (aligné facture.html) ═══════════ */

function printInvoicePDF(docId) {
  try {
    var doc = getDocById(docId);
    if (!doc) return;

    var html = _buildInvoiceHTML(doc);
    var w = window.open('', '_blank');
    if (!w) {
      if (typeof showToast === 'function') showToast('Autorise les pop-ups pour imprimer.', 'warning', 4000);
      return;
    }
    w.document.open();
    w.document.write(html);
    w.document.close();
    setTimeout(function () { try { w.focus(); w.print(); } catch (e) {} }, 400);
  } catch (e) { console.warn('printInvoicePDF :', e); }
}

/* _buildInvoiceHTML — v6.7.2
   Structure et CSS copiés à l'identique de facture.html
   (header bi-couleur, client doré, tableau navy, totaux crème,
   montant en lettres, observation, footer, signatures).
   Différences assumées vs facture.html :
   · Lignes de retenues (IR/TVA/garantie) et avoirs ajoutées
   · Si retenues/avoirs : "NET À PAYER" au lieu de "NET À PAYER TTC"
   · Bloc paiements ajouté si non vide
   · Mention activité client (codeCategorie → type)
   · Date d'échéance calculée depuis client.delaiPaiement
*/
function _buildInvoiceHTML(doc) {
  var clientInfo = _docClientNom(doc);
  var client = (doc.clientId && typeof getClientById === 'function') ? getClientById(doc.clientId) : null;
  var t = doc.totals || {};
  var avoirTotal = _docAvoirTotal(doc);

  /* v6.8.1 — Détection autoliquidation TVA (BTP Tunisie).
     Applicable UNIQUEMENT aux factures (pas aux devis/BL/avoirs).
     Déclencheurs : client.type 'sous-traitant' OU 'entreprise'.
     Justification : en BTP tunisien, une prestation de services à une
     entreprise assujettie est quasi systématiquement en autoliquidation.
     Si ton comptable dit le contraire pour un cas précis, ajouter un
     flag doc.autoliquidation explicite dans le formulaire facture
     (TODO v6.9). */
  var isAutoliquidation = (doc.type === 'facture' && client && (
    String(client.type || '').toLowerCase() === 'sous-traitant' ||
    String(client.type || '').toLowerCase() === 'entreprise'
  ));

  /* ─── Calculs ─── */
  var netFinal;
  if (t.netAPayer != null && isFinite(t.netAPayer)) {
    netFinal = t.netAPayer - avoirTotal;
  } else {
    var totalDoc = _docTotal(doc);
    netFinal = totalDoc - (t.retenueMontant || 0) - (t.retenueGarantie || 0) - avoirTotal;
  }
  if (netFinal < 0) netFinal = 0;

  var totalTTC = t.totalTTC || _docTotal(doc);
  var aRetenues = (t.retenueMontant || 0) > 0.001 || (t.retenueGarantie || 0) > 0.001 || avoirTotal > 0.001;
  var libelleNet     = aRetenues ? 'NET À PAYER'     : 'NET À PAYER TTC';
  var libelleLettres = aRetenues ? 'net à payer'     : 'TTC';

  /* ─── Date d'échéance ─── */
  var dateEm = _docDate(doc);
  var echeance = 'À réception';
  if (client && client.delaiPaiement != null) {
    if (client.delaiPaiement === 0) echeance = 'Comptant';
    else if (typeof addDaysISO === 'function') {
      echeance = formatDate(addDaysISO(dateEm, client.delaiPaiement));
    }
  }

  /* ─── Activité client ─── */
  var activite = '';
  if (client) activite = client.codeCategorie || client.type || '';

  /* ─── Titre ─── */
  var titre = _docTypeLabel(doc).toUpperCase() + ' N° ' + (doc.numero || '—');

  /* ─── Bloc client ─── */
  var clientNom     = clientInfo.nom || '—';
  var clientAdresse = (client && client.adresse) ? escapeHtml(client.adresse) : '';
  var clientMf      = (client && client.mf)      ? escapeHtml(client.mf)      : '—';
  var activiteHtml  = activite ? escapeHtml(activite) : '—';

  /* ─── Lignes items ─── */
  var itemsHtml = '';
  if (Array.isArray(doc.items)) {
    for (var i = 0; i < doc.items.length; i++) {
      var it = doc.items[i];
      if (!it) continue;
      var lt = _lineTotal(it);
      var remise = parseNumber(it.remise);
      var desigCell = escapeHtml(it.designation || '');
      if (remise > 0) {
        desigCell += ' <span style="font-size:9px;color:#999">(remise ' + remise + '%)</span>';
      }
      itemsHtml += '<tr>' +
        '<td>' + desigCell + '</td>' +
        '<td class="text-center">' + parseNumber(it.quantite) + (it.unite ? ' ' + escapeHtml(it.unite) : '') + '</td>' +
        '<td class="text-right">' + formatNumber(parseNumber(it.prix), 3) + '</td>' +
        '<td class="text-right">' + formatNumber(lt, 3) + '</td>' +
        '</tr>';
    }
  }
  if (!itemsHtml) {
    itemsHtml = '<tr><td colspan="4" style="text-align:center;color:#999;padding:20px">Aucune ligne</td></tr>';
  }

  /* ─── Totaux ─── */
  var totauxHtml = '';
  totauxHtml += '<div class="line"><strong>Total HT</strong> <span>' + formatNumber(t.totalHT || 0, 3) + ' DT</span></div>';
  totauxHtml += '<div class="line"><strong>TVA (' + (t.tvaRate || 0) + '%)</strong> <span>' + formatNumber(t.tva || 0, 3) + ' DT</span></div>';
  if ((t.timbre || 0) > 0.001) {
    totauxHtml += '<div class="line"><strong>Timbre fiscal</strong> <span>' + formatNumber(t.timbre, 3) + ' DT</span></div>';
  }
  totauxHtml += '<div class="line"><strong>Total TTC</strong> <span>' + formatNumber(totalTTC, 3) + ' DT</span></div>';

  if ((t.retenueIR || 0) > 0.001) {
    totauxHtml += '<div class="line"><strong>Retenue IR</strong> <span>− ' + formatNumber(t.retenueIR, 3) + ' DT</span></div>';
  }
  if ((t.retenueTVA || 0) > 0.001) {
    totauxHtml += '<div class="line"><strong>Retenue TVA</strong> <span>− ' + formatNumber(t.retenueTVA, 3) + ' DT</span></div>';
  }
  if ((t.retenueGarantie || 0) > 0.001) {
    var tauxG = t.retenueGarantieRate || 5;
    totauxHtml += '<div class="line"><strong>Retenue garantie (' + tauxG + '%)</strong> <span>− ' + formatNumber(t.retenueGarantie, 3) + ' DT</span></div>';
  }
  if (avoirTotal > 0.001) {
    totauxHtml += '<div class="line"><strong>Avoirs</strong> <span>− ' + formatNumber(avoirTotal, 3) + ' DT</span></div>';
  }
  totauxHtml += '<div class="line grand-total"><strong>' + libelleNet + '</strong> <span>' + formatNumber(netFinal, 3) + ' DT</span></div>';

  /* ─── Montant en lettres ─── */
  var montantLettres;
  if (typeof numberToFrenchWords === 'function') {
    montantLettres = numberToFrenchWords(netFinal);
  } else {
    montantLettres = '[' + formatNumber(netFinal, 3) + ' DT]';
    console.warn('_buildInvoiceHTML : numberToFrenchWords manquante — fallback numérique');
  }

  /* ─── Observation ─── */
  var observationHtml = '';
  if (doc.notes) {
    observationHtml = '<div class="observation"><strong>Observation :</strong> ' +
      escapeHtml(doc.notes).replace(/\n/g, '<br>') + '</div>';
  }

  /* ─── Paiements ─── */
  var paiementsHtml = '';
  var paiements = Array.isArray(doc.paiements) ? doc.paiements : [];
  if (paiements.length > 0) {
    paiementsHtml = '<div style="margin-top:18px">' +
      '<strong style="color:#1A2B4C;font-size:10px;text-transform:uppercase;letter-spacing:0.5px">Paiements enregistrés</strong>' +
      '<table style="width:100%;border-collapse:collapse;margin-top:8px;font-size:10px">' +
      '<thead><tr style="background:#1A2B4C;color:#fff">' +
      '<th style="padding:6px 8px;text-align:left">Date</th>' +
      '<th style="padding:6px 8px;text-align:left">Mode</th>' +
      '<th style="padding:6px 8px;text-align:right">Montant</th>' +
      '</tr></thead><tbody>';
    for (var j = 0; j < paiements.length; j++) {
      var p = paiements[j];
      paiementsHtml += '<tr>' +
        '<td style="padding:6px 8px;border-bottom:1px solid #e0e4e9">' + escapeHtml(formatDate(p.date || '')) + '</td>' +
        '<td style="padding:6px 8px;border-bottom:1px solid #e0e4e9">' + escapeHtml(p.mode || '—') + '</td>' +
        '<td style="padding:6px 8px;border-bottom:1px solid #e0e4e9;text-align:right">' + formatNumber(parseNumber(p.montant), 3) + ' DT</td>' +
        '</tr>';
    }
    paiementsHtml += '</tbody></table></div>';
  }

  /* ─── Variables société (v6.8.1 : bankRNE externalisé) ─── */
  var mfVal     = (typeof bankMF !== 'undefined' && bankMF)       ? bankMF       : '1977463P / A / M / 000';
  var ribVal    = (typeof bankRib !== 'undefined' && bankRib)     ? bankRib      : '07 054 0112101102584 69';
  var banqueVal = (typeof bankName !== 'undefined' && bankName)   ? bankName     : 'AMEN BANK';
  var rneVal    = (typeof bankRNE !== 'undefined' && bankRNE)     ? bankRNE      : '1977463P';

  /* ─── Logo ─── */
  var logo = (typeof getLogo === 'function') ? getLogo() : '';
  var logoHtml;
  if (logo) {
    logoHtml = '<img src="' + escapeAttr(logo) + '" style="max-height:60px;max-width:200px" alt="Logo">';
  } else {
    logoHtml = '<div class="logo-text">' +
      '<h1>VOLT<span>CORE</span></h1>' +
      '<div class="sub">INGÉNIERIE · ÉLECTRICITÉ · BÂTIMENT</div>' +
      '<div class="logo-underline"><div class="gold"></div><div class="red"></div></div>' +
      '</div>';
  }

  /* ─── Assemblage HTML ─── */
  var html = '<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><title>' +
    escapeHtml(titre) + '</title><style>';
  html += '@page{size:A4;margin:15mm}';
  html += '*{margin:0;padding:0;box-sizing:border-box}';
  html += 'body{font-family:\'Calibri\',\'Segoe UI\',Arial,sans-serif;background:#fff;padding:10px;font-size:10px;color:#1A2B4C;-webkit-print-color-adjust:exact;print-color-adjust:exact}';
  html += '.invoice-wrapper{max-width:950px;margin:0 auto;background:#fff;padding:20px 28px}';
  html += '.header{display:flex;justify-content:space-between;align-items:center;border-bottom:2px solid #C9A84C;padding-bottom:16px;margin-bottom:16px;flex-wrap:wrap;gap:10px}';
  html += '.logo-text h1{font-size:34px;font-weight:900;color:#1A2B4C;letter-spacing:1.5px;line-height:1;margin-bottom:4px}';
  html += '.logo-text h1 span{color:#E70013}';
  html += '.logo-text .sub{font-size:10px;color:#C9A84C;letter-spacing:3px;font-weight:700;text-transform:uppercase;margin-bottom:6px}';
  html += '.logo-underline{display:flex;height:3px;width:100%}';
  html += '.logo-underline .gold{width:65%;background:#C9A84C}';
  html += '.logo-underline .red{width:35%;background:#E70013}';
  html += '.company-info{text-align:right;font-size:10px;line-height:1.6;color:#2c3e66}';
  html += '.company-info strong{color:#1A2B4C}';
  html += '.invoice-title{text-align:center;font-size:22px;font-weight:700;color:#E70013;margin:4px 0 16px;letter-spacing:1px}';
  html += '.client-box{background:#F9FAFE;padding:12px 18px;border-radius:10px;border-left:4px solid #C9A84C;display:flex;justify-content:space-between;flex-wrap:wrap;gap:15px;margin-bottom:20px;font-size:10px;line-height:1.5}';
  html += '.client-box strong{color:#1A2B4C}';
  html += 'table.items{width:100%;border-collapse:collapse;margin:12px 0;font-size:10px}';
  html += 'table.items th{background:#1A2B4C;color:#fff;padding:10px 8px;text-align:center;font-weight:600;letter-spacing:0.5px}';
  html += 'table.items td{padding:8px;border-bottom:1px solid #e0e4e9;vertical-align:middle}';
  html += 'table.items tr:nth-child(even) td{background:#F9FAFE}';
  html += '.text-right{text-align:right}';
  html += '.text-center{text-align:center}';
  html += '.totals-box{width:50%;margin-left:auto;margin-top:15px;padding:15px 20px;background:#FEFCF5;border-radius:10px;border:1px solid #f0e5d0}';
  html += '.totals-box .line{display:flex;justify-content:space-between;padding:3px 0;font-size:11px;color:#1A2B4C}';
  html += '.totals-box .grand-total{font-size:16px;font-weight:800;color:#E70013;border-top:2px solid #C9A84C;padding-top:8px;margin-top:5px}';
  html += '.letter-amount{border:1px solid #C9A84C;background:#FEFAF2;border-radius:8px;padding:12px 16px;margin:18px 0 14px;font-size:11px;color:#1A2B4C}';
  html += '.observation{background:#f8f9fa;padding:10px 16px;border-radius:8px;font-size:10px;color:#444;border-left:3px solid #C9A84C;margin:12px 0 16px}';
  html += '.footer{border-top:1px solid #ddd;padding-top:12px;margin-top:16px;font-size:8px;text-align:center;color:#555;line-height:1.6}';
  html += '.footer strong{color:#1A2B4C}';
  html += '.footer .bank{margin-top:6px}';
  html += '.signature-area{display:flex;justify-content:space-between;margin-top:25px;font-size:10px}';
  html += '.signature-area div{width:38%;border-top:1px solid #999;padding-top:8px;text-align:center;color:#1A2B4C;font-weight:600}';
  html += '.clearfix::after{content:"";display:table;clear:both}';
  html += '@media print{body{padding:0}.invoice-wrapper{padding:0}}';
  html += '</style></head><body>';

  html += '<div class="invoice-wrapper">';

  /* Header */
  html += '<div class="header">';
  html += '<div class="logo-title">' + logoHtml + '</div>';
  html += '<div class="company-info">';
  html += '<strong>VOLTCORE INGENIERIE</strong><br>';
  html += 'Route Soukra KM 3, Cité El Habib<br>';
  html += 'Sfax Ouest – 3052, Tunisie<br>';
  html += '<strong>MF :</strong> ' + escapeHtml(mfVal) + '<br>';
  html += '<strong>RNE :</strong> ' + escapeHtml(rneVal) + '<br>';
  html += 'Tél : +216 51 176 186';
  html += '</div>';
  html += '</div>';

  /* Titre */
  html += '<div class="invoice-title">' + escapeHtml(titre) + '</div>';

  /* Bloc client */
  html += '<div class="client-box">';
  html += '<div>';
  html += '<strong>Date d\'émission :</strong> ' + escapeHtml(formatDate(dateEm)) + '<br>';
  html += '<strong>Échéance :</strong> ' + escapeHtml(echeance);
  html += '</div>';
  html += '<div>';
  html += '<strong>Facturé à :</strong><br>';
  html += '<strong>' + escapeHtml(clientNom) + '</strong><br>';
  if (clientAdresse) html += clientAdresse + '<br>';
  html += '<strong>MF :</strong> ' + clientMf + '<br>';
  html += '<strong>Activité :</strong> ' + activiteHtml;
  html += '</div>';
  html += '</div>';

  /* Tableau items */
  html += '<table class="items">';
  html += '<thead><tr>';
  html += '<th style="text-align:left;width:48%">Désignation</th>';
  html += '<th style="text-align:center;width:10%">Qté</th>';
  html += '<th style="text-align:right;width:21%">P.U. HT (TND)</th>';
  html += '<th style="text-align:right;width:21%">Total HT (TND)</th>';
  html += '</tr></thead>';
  html += '<tbody>' + itemsHtml + '</tbody>';
  html += '</table>';

  /* Totaux */
  html += '<div class="clearfix">';
  html += '<div class="totals-box">' + totauxHtml + '</div>';
  html += '</div>';

  /* Montant en lettres */
  html += '<div class="letter-amount">';
  html += 'Arrêtée la présente facture à la somme de : <strong>' +
    escapeHtml(montantLettres) + ' ' + libelleLettres + '</strong>.';
  html += '</div>';

  /* v6.8.1 — Mention légale autoliquidation (BTP Tunisie).
     Bloc conditionnel visible uniquement si isAutoliquidation === true.
     Placé après le montant en lettres et avant l'observation, à
     l'emplacement classique des mentions légales de facture. */
  if (isAutoliquidation) {
    html += '<div class="observation" style="border-left-color:#E70013">';
    html += '<strong>Autoliquidation de la TVA par le preneur</strong> — ';
    html += 'Prestation de services soumise au régime de l\'autoliquidation ' +
      'conformément à la réglementation en vigueur (Code de la TVA, Tunisie). ' +
      'La TVA doit être déclarée et acquittée par le client.';
    html += '</div>';
  }

  /* Observation */
  html += observationHtml;

  /* Paiements */
  html += paiementsHtml;

  /* Footer */
  html += '<div class="footer">';
  html += '<div>TVA récupérable sur présentation – Paiement à réception – Pénalités de retard 15% l\'an.</div>';
  html += '<div><strong>VOLTCORE INGENIERIE</strong> – SARL au capital 20 000 TND – RNE ' + escapeHtml(rneVal) + '</div>';
  html += '<div class="bank"><strong>Coordonnées bancaires :</strong> ' + escapeHtml(banqueVal) + ' – RIB : ' + escapeHtml(ribVal) + '</div>';
  html += '</div>';

  /* Signatures */
  html += '<div class="signature-area">';
  html += '<div>Cachet & Signature VOLTCORE</div>';
  html += '<div>Signature client</div>';
  html += '</div>';

  html += '</div>'; /* /invoice-wrapper */
  html += '</body></html>';
  return html;
}

/* ═══════════ SECTION 8 — WHATSAPP / EMAIL ═══════════ */

function shareInvoiceWhatsApp(docId) {
  try {
    var doc = getDocById(docId);
    if (!doc) return;
    var clientInfo = _docClientNom(doc);
    var client = doc.clientId && typeof getClientById === 'function' ? getClientById(doc.clientId) : null;

    var net = _docNet(doc);
    var avoirTotal = _docAvoirTotal(doc);

    var text = 'Bonjour ' + (clientInfo.nom || '') + ',\n\n' +
      'Votre ' + _docTypeLabel(doc) + ' N° ' + (doc.numero || '') + ' du ' +
      formatDate(_docDate(doc)) + '\n' +
      'Montant : ' + formatMoney(net) + '\n';
    if (avoirTotal > 0.001) {
      text += '(dont avoirs déduits : −' + formatMoney(avoirTotal) + ')\n';
    }
    text += '\nCordialement,\nVOLTCORE INGENIERIE';

    var phone = (client && client.telephone) ? String(client.telephone).replace(/[^\d]/g, '') : '';
    var url = phone ? 'https://wa.me/' + phone + '?text=' + encodeURIComponent(text)
                    : 'https://wa.me/?text=' + encodeURIComponent(text);
    window.open(url, '_blank');
  } catch (e) { console.warn('shareInvoiceWhatsApp :', e); }
}

function shareInvoiceEmail(docId) {
  try {
    var doc = getDocById(docId);
    if (!doc) return;
    var clientInfo = _docClientNom(doc);
    var client = doc.clientId && typeof getClientById === 'function' ? getClientById(doc.clientId) : null;

    var net = _docNet(doc);
    var avoirTotal = _docAvoirTotal(doc);

    var email = client && client.email ? client.email : '';
    var subject = _docTypeLabel(doc) + ' N° ' + (doc.numero || '');
    var body = 'Bonjour ' + (clientInfo.nom || '') + ',\n\n' +
      'Veuillez trouver votre ' + _docTypeLabel(doc) + ' N° ' + (doc.numero || '') +
      ' du ' + formatDate(_docDate(doc)) + '.\n\n' +
      'Montant : ' + formatMoney(net) + '\n';
    if (avoirTotal > 0.001) {
      body += '(dont avoirs déduits : −' + formatMoney(avoirTotal) + ')\n';
    }
    body += '\nCordialement,\nVOLTCORE INGENIERIE';

    var url = 'mailto:' + encodeURIComponent(email) +
      '?subject=' + encodeURIComponent(subject) +
      '&body=' + encodeURIComponent(body);
    window.location.href = url;
  } catch (e) { console.warn('shareInvoiceEmail :', e); }
}

/* ═══════════ SECTION 9 — SUPPRESSION + UNDO ═══════════ */

function deleteInvoice(docId) {
  try {
    var doc = getDocById(docId);
    if (!doc) return;

    if (doc.type === 'facture') {
      var avoirs = listAvoirsForFacture(doc.id);
      if (avoirs.length > 0) {
        var msg1 = '⚠️ Cette facture a ' + avoirs.length + ' avoir(s) lié(s) :\n';
        for (var a = 0; a < avoirs.length && a < 5; a++) {
          msg1 += '  • ' + (avoirs[a].numero || '—') + ' (' + formatMoney(_docTotal(avoirs[a])) + ')\n';
        }
        if (avoirs.length > 5) msg1 += '  • … et ' + (avoirs.length - 5) + ' autre(s)\n';
        msg1 += '\nSi tu supprimes la facture, les avoirs deviendront orphelins.\n\nContinuer quand même ?';
        var ok1 = (typeof confirmDialog === 'function') ? confirmDialog(msg1) : window.confirm(msg1);
        if (!ok1) return;
      }
    }

    if (doc.type === 'avoir' && doc.parentFactureId) {
      var parent = getDocById(doc.parentFactureId);
      if (parent) {
        var msg2 = '⚠️ Cet avoir est lié à la facture ' + (parent.numero || '') + '.\n';
        msg2 += 'Si tu supprimes l\'avoir, le solde de la facture augmentera de ' + formatMoney(_docTotal(doc)) + '.\n\nContinuer quand même ?';
        var ok2 = (typeof confirmDialog === 'function') ? confirmDialog(msg2) : window.confirm(msg2);
        if (!ok2) return;
      }
    }

    var idx = savedDocuments.indexOf(doc);
    if (idx < 0) return;
    savedDocuments.splice(idx, 1);

    if (!trash || typeof trash !== 'object') {
      trash = { clients: [], articles: [], documents: [] };
    }
    if (!Array.isArray(trash.documents)) trash.documents = [];
    var entry = {
      item: doc,
      deletedAt: new Date().toISOString(),
      deletedBy: (typeof currentUser !== 'undefined' && currentUser && currentUser.username) || 'anon'
    };
    trash.documents.push(entry);

    if (typeof saveAll === 'function') saveAll();
    if (typeof window.invalidateClientStatsCache === 'function' && doc.clientId) {
      window.invalidateClientStatsCache(doc.clientId);
    }
    if (typeof logAction === 'function') logAction('doc.delete', doc.numero);
    renderInvoices();
    if (__invoiceDetailId && __invoiceDetailId === String(docId)) closeInvoiceDetail();

    if (typeof showUndoToast === 'function') {
      showUndoToast('Document supprimé : ' + (doc.numero || ''),
        function () { _restoreDeletedInvoice(entry, doc); }, 5000);
    } else if (typeof showToast === 'function') {
      showToast('Document déplacé dans la corbeille.', 'info', 3000);
    }
  } catch (e) { console.warn('deleteInvoice :', e); }
}

function _restoreDeletedInvoice(entry, docObj) {
  try {
    if (!entry || !docObj) return;
    if (Array.isArray(trash.documents)) {
      var idx = trash.documents.indexOf(entry);
      if (idx >= 0) trash.documents.splice(idx, 1);
    }
    if (getDocById(docObj.id)) return;
    savedDocuments.push(docObj);
    if (typeof saveAll === 'function') saveAll();
    if (typeof window.invalidateClientStatsCache === 'function' && docObj.clientId) {
      window.invalidateClientStatsCache(docObj.clientId);
    }
    if (typeof logAction === 'function') logAction('doc.restore', docObj.numero);
    renderInvoices();
    if (typeof showToast === 'function') {
      showToast('Document restauré : ' + (docObj.numero || ''), 'success', 2500);
    }
  } catch (e) { console.warn('_restoreDeletedInvoice :', e); }
}

/* ═══════════ SECTION 10 — AVOIRS ═══════════ */

function listAvoirsForFacture(factureId) {
  try {
    if (!factureId || !Array.isArray(savedDocuments)) return [];
    var sid = String(factureId);

    var facture = getDocById(factureId);
    var avoirIdsFromFacture = (facture && Array.isArray(facture.avoirIds))
      ? facture.avoirIds.map(String) : [];

    var seen = {};
    var out = [];
    for (var i = 0; i < savedDocuments.length; i++) {
      var d = savedDocuments[i];
      if (!d || d.type !== 'avoir') continue;
      if (d.statut === 'annulee' || d.annulee === true) continue;

      var matchParent = String(d.parentFactureId || '') === sid;
      var matchId = avoirIdsFromFacture.indexOf(String(d.id)) >= 0;

      if ((matchParent || matchId) && !seen[d.id]) {
        seen[d.id] = true;
        out.push(d);
      }
    }
    return out;
  } catch (e) { return []; }
}

/* ═══════════ SECTION 11 — ÉVÉNEMENTS ═══════════ */

function attachInvoicesViewEvents() {
  try {
    var searchInput = document.getElementById('invoicesSearchInput');
    if (searchInput && !searchInput.__bound) {
      searchInput.__bound = true;
      searchInput.addEventListener('input', debounce(function (ev) {
        setInvoicesSearch(ev.target.value);
      }, 250));
    }

    var filterSel = document.getElementById('invoicesFilterSelect');
    if (filterSel && !filterSel.__bound) {
      filterSel.__bound = true;
      filterSel.addEventListener('change', function (ev) {
        setInvoicesFilter(ev.target.value);
      });
    }

    var clientSel = document.getElementById('invoicesClientFilterSelect');
    if (clientSel && !clientSel.__bound) {
      clientSel.__bound = true;
      clientSel.addEventListener('change', function (ev) {
        setInvoicesClientFilter(ev.target.value);
      });
    }

    var addBtn = document.getElementById('btnAddInvoice');
    if (addBtn && !addBtn.__bound) {
      addBtn.__bound = true;
      addBtn.addEventListener('click', function () {
        if (typeof openInvoiceForm === 'function') openInvoiceForm();
      });
    }

    var paySaveBtn = document.getElementById('paymentSaveBtn');
    if (paySaveBtn && !paySaveBtn.__bound) {
      paySaveBtn.__bound = true;
      paySaveBtn.addEventListener('click', savePaymentFromForm);
    }
  } catch (e) { console.warn('attachInvoicesViewEvents :', e); }
}

function _populateInvoicesClientFilter() {
  try {
    var sel = document.getElementById('invoicesClientFilterSelect');
    if (!sel) return;
    var html = '<option value="">Tous les clients</option>';
    if (Array.isArray(clients)) {
      var sorted = clients.slice().sort(function (a, b) {
        var na = normalizeText(a.nom || '');
        var nb = normalizeText(b.nom || '');
        if (na === nb) return 0;
        return na > nb ? 1 : -1;
      });
      for (var i = 0; i < sorted.length; i++) {
        var c = sorted[i];
        var sid = String(c.id);
        html += '<option value="' + escapeAttr(sid) + '"' +
          (sid === __invoicesClientFilter ? ' selected' : '') + '>' +
          escapeHtml(c.nom || '') + '</option>';
      }
    }
    sel.innerHTML = html;
  } catch (e) { console.warn('_populateInvoicesClientFilter :', e); }
}

try {
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', _populateInvoicesClientFilter);
    } else {
      setTimeout(_populateInvoicesClientFilter, 300);
    }
  }
} catch (e) {}

/* ═══════════════════════════════════════════════════════════════
   MODULE « Libération de garantie BTP » — v6.8.1
   ═══════════════════════════════════════════════════════════════

   Remplace le stub B4. Trois fonctions :
     • openLiberationGarantieModal(docId) — ouvre la modale, pré-remplit
     • closeLiberationGarantieModal()     — ferme + reset
     • confirmLiberationGarantie()        — valide + appelle libererGarantie

   Branché sur libererGarantie (04-storage.js) qui :
     • ajoute un paiement de type 'liberation_garantie'
     • pose doc.garantieLiberee = true si montant >= garantie totale
     • rafraîchit les caches (invalidateClientStatsCache)
     • log l'action

   Comportement :
     • Libération TOTALE : montant = garantie en attente → flag libérée
     • Libération PARTIELLE : montant < garantie → flag reste false,
       la garantie restante peut être libérée plus tard (autre appel)

   Appelée depuis :
     • 17-dash-reports.js → renderGarantiesReport (bouton « 🔓 Libérer »)
     • 12-invoices-view.js → _renderInvoiceDetailBody (bouton « 🔓 Libérer »
       dans la fiche facture — livré en G3)
   ═══════════════════════════════════════════════════════════════ */

/* Ouvre la modale de libération.
   Refuse silencieusement (toast) si :
     • docId vide ou doc introuvable
     • doc n'est pas une facture
     • garantie statut != 'en_attente'
     • montant garantie <= 0
   Pré-remplit :
     • montant  = garantie en attente (libération totale par défaut)
     • date     = aujourd'hui
     • mode     = virement
     • note     = vide */
function openLiberationGarantieModal(docId) {
  try {
    var modal = document.getElementById('liberationGarantieModal');
    if (!modal) {
      if (typeof showToast === 'function') {
        showToast('Modale de libération introuvable.', 'error');
      }
      return;
    }

    var doc = (typeof getDocById === 'function') ? getDocById(docId) : null;
    if (!doc) {
      if (typeof showToast === 'function') showToast('Document introuvable.', 'error');
      return;
    }

    if (typeof getGarantieStatut === 'function' && getGarantieStatut(doc) !== 'en_attente') {
      var st = getGarantieStatut(doc);
      var msg = st === 'liberee' ? 'Garantie déjà libérée pour ce document.'
              : st === 'annulee' ? 'Document annulé — pas de libération.'
              : 'Aucune garantie en attente sur ce document.';
      if (typeof showToast === 'function') showToast(msg, 'warning');
      return;
    }

    var garantieMax = (typeof getGarantieEnAttente === 'function')
      ? getGarantieEnAttente(doc) : 0;
    if (!(garantieMax > 0.001)) {
      if (typeof showToast === 'function') showToast('Aucune garantie à libérer.', 'warning');
      return;
    }

    /* Pré-remplissage */
    var docIdEl = document.getElementById('libGarantieDocId');
    if (docIdEl) docIdEl.value = String(doc.id);

    var titleEl = document.getElementById('libGarantieTitle');
    if (titleEl) titleEl.textContent = '🔓 Libérer la garantie — ' + (doc.numero || '');

    var infoEl = document.getElementById('libGarantieInfo');
    if (infoEl) {
      var clientNom = '—';
      if (doc.clientId && typeof getClientById === 'function') {
        var c = getClientById(doc.clientId);
        if (c) clientNom = c.nom || '—';
      }
      infoEl.innerHTML =
        'Facture <strong>' + escapeHtml(doc.numero || '') + '</strong> · ' +
        'Client <strong>' + escapeHtml(clientNom) + '</strong><br>' +
        'Garantie en attente : <strong>' + formatMoney(garantieMax) + '</strong>';
    }

    var montantEl = document.getElementById('libGarantieMontant');
    if (montantEl) montantEl.value = garantieMax.toFixed(3);

    var dateEl = document.getElementById('libGarantieDate');
    if (dateEl) dateEl.value = (typeof todayISO === 'function') ? todayISO() : '';

    var modeEl = document.getElementById('libGarantieMode');
    if (modeEl) modeEl.value = 'virement';

    var noteEl = document.getElementById('libGarantieNote');
    if (noteEl) noteEl.value = '';

    var errEl = document.getElementById('libGarantieError');
    if (errEl) errEl.textContent = '';

    modal.style.display = 'flex';

    if (montantEl) setTimeout(function () { try { montantEl.focus(); montantEl.select(); } catch (e) {} }, 100);
  } catch (e) {
    console.warn('openLiberationGarantieModal :', e);
    if (typeof showToast === 'function') showToast('Erreur à l\'ouverture.', 'error');
  }
}

/* Ferme la modale et nettoie les champs (évite fuite d'état entre 2 ouvertures). */
function closeLiberationGarantieModal() {
  try {
    var modal = document.getElementById('liberationGarantieModal');
    if (modal) modal.style.display = 'none';

    ['libGarantieDocId', 'libGarantieMontant', 'libGarantieDate',
     'libGarantieNote', 'libGarantieError'].forEach(function (id) {
      var el = document.getElementById(id);
      if (!el) return;
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') el.value = '';
      else el.textContent = '';
    });
  } catch (e) { console.warn('closeLiberationGarantieModal :', e); }
}

/* Valide le formulaire + appelle libererGarantie.
   Sur succès : toast + refresh + fermeture.
   Sur erreur : message dans libGarantieError + toast. */
function confirmLiberationGarantie() {
  try {
    var errEl = document.getElementById('libGarantieError');
    if (errEl) errEl.textContent = '';

    var docId = (document.getElementById('libGarantieDocId') || {}).value || '';
    if (!docId) {
      if (errEl) errEl.textContent = 'Document introuvable.';
      return;
    }

    var doc = (typeof getDocById === 'function') ? getDocById(docId) : null;
    if (!doc) {
      if (errEl) errEl.textContent = 'Document introuvable.';
      return;
    }

    var montantEl = document.getElementById('libGarantieMontant');
    var dateEl = document.getElementById('libGarantieDate');
    var modeEl = document.getElementById('libGarantieMode');
    var noteEl = document.getElementById('libGarantieNote');

    var montant = parseNumber(montantEl ? montantEl.value : 0);
    var date = dateEl ? String(dateEl.value || '').slice(0, 10) : '';
    var mode = (modeEl ? String(modeEl.value || 'virement') : 'virement').toLowerCase();
    var note = noteEl ? String(noteEl.value || '').trim() : '';

    /* Validations */
    if (!(montant > 0)) {
      if (errEl) errEl.textContent = 'Montant > 0 requis.';
      return;
    }
    if (!isValidDateString(date)) {
      if (errEl) errEl.textContent = 'Date invalide.';
      return;
    }
    var garantieMax = (typeof getGarantieEnAttente === 'function')
      ? getGarantieEnAttente(doc) : 0;
    if (montant > garantieMax + 0.01) {
      if (errEl) errEl.textContent = 'Montant > garantie en attente (' +
        formatMoney(garantieMax) + ').';
      return;
    }

    /* Appel au moteur (04-storage.js) */
    if (typeof libererGarantie !== 'function') {
      if (errEl) errEl.textContent = 'Module de libération indisponible.';
      return;
    }

    var res = libererGarantie(doc.id, {
      montant: montant,
      date: date,
      mode: mode,
      note: note
    });

    if (!res || !res.ok) {
      if (errEl) errEl.textContent = res && res.error ? res.error : 'Erreur inconnue.';
      if (typeof showToast === 'function') {
        showToast('Libération refusée : ' + (res && res.error ? res.error : 'erreur'), 'error', 4000);
      }
      return;
    }

    /* Succès */
    var montantLib = res.montant || montant;
    if (typeof showToast === 'function') {
      showToast('Garantie libérée : ' + formatMoney(montantLib), 'success', 3000);
    }

    closeLiberationGarantieModal();

    /* Refresh — chaque rendu est protégé par typeof */
    try { if (typeof renderGarantiesReport === 'function') renderGarantiesReport(); } catch (e) {}
    try { if (typeof renderInvoices === 'function') renderInvoices(); } catch (e) {}
    try { if (typeof _renderInvoiceDetailBody === 'function') _renderInvoiceDetailBody(); } catch (e) {}
    try { if (typeof renderDashboardKPIs === 'function') renderDashboardKPIs(); } catch (e) {}
    try {
      if (doc.clientId && typeof window.invalidateClientStatsCache === 'function') {
        window.invalidateClientStatsCache(doc.clientId);
      }
    } catch (e) {}
  } catch (e) {
    console.warn('confirmLiberationGarantie :', e);
    var errEl2 = document.getElementById('libGarantieError');
    if (errEl2) errEl2.textContent = 'Erreur : ' + (e.message || 'inconnue');
    if (typeof showToast === 'function') showToast('Erreur lors de la libération.', 'error', 4000);
  }
}

/* Expose globalement pour les onclick inline de 17-dash-reports.js
   et de la modale HTML (G1). */
try {
  if (typeof window !== 'undefined') {
    window.openLiberationGarantieModal = openLiberationGarantieModal;
    window.closeLiberationGarantieModal = closeLiberationGarantieModal;
    window.confirmLiberationGarantie = confirmLiberationGarantie;
  }
} catch (e) {}
console.log('✅ 12-invoices-view.js chargé — v6.7.2 (Session #3 — PDF aligné facture.html)');