/* ═══════════════════════════════════════════════════════════
   VOLTCORE — 12-inv-view.js
   VERSION : v7.0.7
   RÔLE : Liste documents, détail, paiements, avoirs liés,
          suppression avec undo, partage WhatsApp/Email.
          PDF délégué à 13-inv-pdf.js.
          Normalisation + save + load + trash : gérés par Store.
   DÉPENDANCES : 00-core, 01-utils, 02-store, 04-alerts, 06-clients, 11-inv
   ORDRE : 13ᵉ fichier chargé

   FIX v7.0.0 :
   - C30 : WhatsApp via Clients.normalizePhone (plus de '0' initial)
   - PDF : délégation totale à 13-inv-pdf.js
   - Détail : section autoliquidation affichée si active

   RÈGLES :
   - ES5 strict
   - Aucun catch silencieux
   - Ne JAMAIS lire/écrire localStorage directement
   ═══════════════════════════════════════════════════════════ */

'use strict';

(function (global) {

  if (!global.VOLTCORE || !global.VOLTCORE.Store || !global.VOLTCORE.Utils) {
    throw new Error('[12-inv-view] Modules requis non chargés');
  }

  var VC = global.VOLTCORE;
  var U = VC.Utils;
  var S = VC.Store;
  var Doc = VC.Doc;
  var View = VC.InvoicesView || {};
  VC.InvoicesView = View;

  /* ═══════════════════════════════════════════════════════════
     SECTION 1 — ÉTAT INTERNE
     ═══════════════════════════════════════════════════════════ */

  var _searchTerm = '';
  var _filter = 'all';
  var _clientFilter = '';
  var _page = 0;
  var _perPage = 50;

  var _detailDocId = null;
  var _paymentDocId = null;

  var DOC_TYPE_LABELS = {
    devis: 'Devis',
    bl: 'Bon de livraison',
    facture: 'Facture',
    attachement: 'Attachement',
    avoir: 'Avoir'
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 2 — HELPERS
     ═══════════════════════════════════════════════════════════ */

  View.getById = function (id) {
    return S.getById('documents', id);
  };

  View.getTypeLabel = function (doc) {
    if (!doc) return 'Document';
    return DOC_TYPE_LABELS[doc.type] || 'Document';
  };

  function _docTotal(doc) {
    if (!doc) return 0;
    if (doc.totals && typeof doc.totals.total === 'number') return doc.totals.total;
    if (typeof doc.totalTTC === 'number') return doc.totalTTC;
    return 0;
  }

  function _docDate(doc) {
    if (!doc) return '';
    return String(doc.date || '').slice(0, 10);
  }

  function _statutLabel(statut) {
    var m = {
      brouillon: 'Brouillon',
      annulee: 'Annulée',
      payee: 'Payée',
      partielle: 'Partielle',
      impayee: 'Impayée',
      avoir: 'Avoir',
      emise: 'Émise'
    };
    return m[statut] || statut || '—';
  }

  function _statutColor(statut) {
    if (statut === 'payee') return 'var(--success)';
    if (statut === 'partielle') return 'var(--warning)';
    if (statut === 'impayee') return 'var(--danger)';
    if (statut === 'annulee') return 'var(--muted)';
    if (statut === 'avoir') return 'var(--info)';
    return 'var(--muted)';
  }

  function _docClientNom(doc) {
    if (!doc) return { nom: '', orphelin: false };
    if (doc.clientId && VC.Clients && typeof VC.Clients.getById === 'function') {
      var c = VC.Clients.getById(doc.clientId);
      if (c && c.nom) return { nom: String(c.nom), orphelin: false };
    }
    if (doc._clientNomOrphelin) {
      return { nom: String(doc._clientNomOrphelin), orphelin: true };
    }
    return { nom: '', orphelin: false };
  }

  function _lineTotal(it) {
    if (!it) return 0;
    return U.computeLineTotal(it);
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
    if (!isFinite(net) || net < 0) return 0;
    return net;
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 3 — RENDU LISTE + PAGINATION
     ═══════════════════════════════════════════════════════════ */

  View.render = function () {
    var container = document.getElementById('invoicesList');
    if (!container) return;

    var list = View.getFiltered();
    var total = list.length;

    /* Créer la pagination si absente */
    var pagContainer = document.getElementById('invoicesPagination');
    if (!pagContainer && container.parentNode) {
      pagContainer = document.createElement('div');
      pagContainer.id = 'invoicesPagination';
      pagContainer.className = 'pagination';
      pagContainer.style.marginTop = '16px';
      pagContainer.style.display = 'flex';
      pagContainer.style.justifyContent = 'center';
      pagContainer.style.alignItems = 'center';
      pagContainer.style.gap = '12px';

      var btnPrev = document.createElement('button');
      btnPrev.id = 'invoicesPrevBtn';
      btnPrev.className = 'btn btn-sm';
      btnPrev.textContent = '◀ Précédent';
      btnPrev.onclick = function () { View.setPage(_page - 1); };

      var spanInfo = document.createElement('span');
      spanInfo.id = 'invoicesPageInfo';
      spanInfo.className = 'muted';
      spanInfo.style.fontSize = '13px';

      var btnNext = document.createElement('button');
      btnNext.id = 'invoicesNextBtn';
      btnNext.className = 'btn btn-sm';
      btnNext.textContent = 'Suivant ▶';
      btnNext.onclick = function () { View.setPage(_page + 1); };

      pagContainer.appendChild(btnPrev);
      pagContainer.appendChild(spanInfo);
      pagContainer.appendChild(btnNext);

      try {
        container.parentNode.insertBefore(pagContainer, container.nextSibling);
      } catch (e) {
        VC.logError('12-inv-view', 'insertion pagination échouée', e);
      }
    }

    if (total === 0) {
      container.innerHTML = '<div class="empty-state">Aucun document' +
        (_searchTerm || _filter !== 'all' ? ' pour ce filtre' : '') +
        '. Clique sur "+ Nouveau document" pour commencer.</div>';
      U.setText('invoicesCount', '0');
      _updatePagination(0, 0, 0);
      return;
    }

    var maxPage = Math.max(0, Math.ceil(total / _perPage) - 1);
    if (_page > maxPage) _page = maxPage;

    var start = _page * _perPage;
    var end = Math.min(start + _perPage, total);
    var slice = list.slice(start, end);

    var html = '';
    for (var i = 0; i < slice.length; i++) {
      html += View.renderRow(slice[i]);
    }
    container.innerHTML = html;

    U.setText('invoicesCount', String(total));
    _updatePagination(_page, maxPage, total);
  };

  function _updatePagination(page, maxPage, total) {
    U.setText('invoicesPageInfo', total > 0
      ? 'Page ' + (page + 1) + ' / ' + (maxPage + 1) + ' — ' + total + ' doc(s)'
      : '0 document');
    var prev = document.getElementById('invoicesPrevBtn');
    if (prev) prev.disabled = (page <= 0);
    var next = document.getElementById('invoicesNextBtn');
    if (next) next.disabled = (page >= maxPage);
  }

  View.setPage = function (p) {
    _page = Math.max(0, parseInt(p, 10) || 0);
    View.render();
  };

  View.renderRow = function (doc) {
    if (!doc) return '';

    var id = U.escapeAttr(doc.id);
    var statut = Doc.getStatutPaiement(doc);
    var statutLbl = _statutLabel(statut);
    var statutColor = _statutColor(statut);

    var clientInfo = _docClientNom(doc);
    var clientNom;
    if (clientInfo.nom) {
      clientNom = U.escapeHtml(clientInfo.nom);
      if (clientInfo.orphelin) {
        clientNom += ' <span class="muted" style="font-size:10px">(non enregistré)</span>';
      }
    } else {
      clientNom = '<span class="muted">Sans client</span>';
    }

    var total = _docTotal(doc);
    var avoirTotal = Doc.getAvoirTotalForFacture(doc.id);
    var reste = Doc.getResteAPayer(doc);

    var amountsHtml = 'Total : <strong>' + U.formatMoney(total) + '</strong>';
    if (avoirTotal > 0.001) {
      amountsHtml += ' · Avoirs : <strong style="color:var(--info)">−' +
        U.formatMoney(avoirTotal) + '</strong>';
    }
    if (reste > 0.001) {
      amountsHtml += ' · Reste : <strong style="color:var(--danger)">' +
        U.formatMoney(reste) + '</strong>';
    }

    return '<div class="invoice-row" data-doc-id="' + id + '">' +
      '<div class="invoice-row-main">' +
        '<div class="invoice-row-header">' +
          '<span class="doc-type-badge doc-type-' + U.escapeAttr(doc.type || 'facture') + '">' +
          U.escapeHtml(View.getTypeLabel(doc)) + '</span>' +
          ' <strong>' + U.escapeHtml(doc.numero || '—') + '</strong>' +
          ' <span class="badge" style="background:' + statutColor + ';color:#fff">' +
          U.escapeHtml(statutLbl) + '</span>' +
        '</div>' +
        '<div class="invoice-row-meta">' +
          clientNom +
          ' · ' + U.escapeHtml(U.formatDate(_docDate(doc))) +
          (doc.sujet ? ' · ' + U.escapeHtml(doc.sujet) : '') +
        '</div>' +
        '<div class="invoice-row-amounts">' + amountsHtml + '</div>' +
      '</div>' +
      '<div class="invoice-row-actions">' +
        '<button type="button" class="btn-icon" title="Détail" ' +
        'onclick="VC.InvoicesView.openDetail(\'' + id + '\')">👁️</button>' +
        '<button type="button" class="btn-icon" title="Éditer" ' +
        'onclick="VC.Invoices.openEdit(\'' + id + '\')">✏️</button>' +
        '<button type="button" class="btn-icon" title="PDF" ' +
        'onclick="VC.InvoicesView.printPDF(\'' + id + '\')">🖨️</button>' +
        '<button type="button" class="btn-icon" title="WhatsApp" ' +
        'onclick="VC.InvoicesView.shareWhatsApp(\'' + id + '\')">💬</button>' +
        '<button type="button" class="btn-icon" title="Email" ' +
        'onclick="VC.InvoicesView.shareEmail(\'' + id + '\')">✉️</button>' +
        '<button type="button" class="btn-icon btn-danger" title="Supprimer" ' +
        'onclick="VC.InvoicesView.remove(\'' + id + '\')">🗑️</button>' +
      '</div>' +
    '</div>';
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 4 — FILTRES
     ═══════════════════════════════════════════════════════════ */

  View.setSearch = function (term) {
    _searchTerm = String(term || '');
    _page = 0;
    View.render();
  };

  View.setFilter = function (filter) {
    _filter = String(filter || 'all');
    _page = 0;
    View.render();
  };

  View.setClientFilter = function (clientId) {
    _clientFilter = String(clientId || '');
    _page = 0;
    View.render();
  };

  View.getFiltered = function () {
    var out = S.getAll('documents').slice();

    if (_searchTerm) {
      var term = U.normalizeText(_searchTerm);
      out = out.filter(function (d) {
        if (!d) return false;
        var clientNom = '';
        if (d.clientId && VC.Clients && typeof VC.Clients.getById === 'function') {
          var c = VC.Clients.getById(d.clientId);
          if (c) clientNom = c.nom || '';
        }
        var hay = U.normalizeText([
          d.numero, d.sujet, d.notes, clientNom, d._clientNomOrphelin || ''
        ].join(' '));
        return hay.indexOf(term) >= 0;
      });
    }

    if (_clientFilter) {
      out = out.filter(function (d) {
        return d && String(d.clientId || '') === _clientFilter;
      });
    }

    var f = _filter;
    if (f !== 'all') {
      if (f === 'impayees') {
        out = out.filter(function (d) {
          var s = Doc.getStatutPaiement(d);
          return s === 'impayee' || s === 'partielle';
        });
      } else if (f === 'payees') {
        out = out.filter(function (d) {
          return Doc.getStatutPaiement(d) === 'payee';
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
  };

  function _populateClientFilter() {
    var sel = document.getElementById('invoicesClientFilterSelect');
    if (!sel) return;

    var clients = S.getAll('clients').slice();
    clients.sort(function (a, b) {
      return U.normalizeText(a.nom || '') > U.normalizeText(b.nom || '') ? 1 : -1;
    });

    var html = '<option value="">Tous les clients</option>';
    for (var i = 0; i < clients.length; i++) {
      var c = clients[i];
      var sid = String(c.id);
      html += '<option value="' + U.escapeAttr(sid) + '"' +
        (sid === _clientFilter ? ' selected' : '') + '>' +
        U.escapeHtml(c.nom || '') + '</option>';
    }
    sel.innerHTML = html;
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 5 — DÉTAIL
     ═══════════════════════════════════════════════════════════ */

  View.openDetail = function (id) {
    var doc = View.getById(id);
    if (!doc) {
      U.toast('Document introuvable.', 'error');
      return;
    }
    _detailDocId = String(id);

    U.setText('invoiceDetailTitle',
      View.getTypeLabel(doc) + ' N° ' + (doc.numero || '—'));

    _renderDetailBody();
    U.showFlex('invoiceDetailModal');
  };

  View.closeDetail = function () {
    U.hide('invoiceDetailModal');
    _detailDocId = null;
  };

  function _renderDetailBody() {
    var body = document.getElementById('invoiceDetailBody');
    if (!body || !_detailDocId) return;

    var doc = View.getById(_detailDocId);
    if (!doc) return;

    var statut = Doc.getStatutPaiement(doc);
    var statutColor = _statutColor(statut);
    var total = _docTotal(doc);
    var avoirTotal = Doc.getAvoirTotalForFacture(doc.id);
    var paye = Doc.getTotalPaye(doc);
    var reste = Doc.getResteAPayer(doc);

    var html = '';

    /* En-tête */
    html += '<div class="detail-section">';
    html += '<div class="invoice-detail-header">';
    html += '<div><strong>N° ' + U.escapeHtml(doc.numero || '—') + '</strong>' +
      ' <span class="badge" style="background:' + statutColor + ';color:#fff">' +
      U.escapeHtml(_statutLabel(statut)) + '</span></div>';
    html += '<div class="muted">' + U.escapeHtml(U.formatDate(_docDate(doc))) + '</div>';
    html += '</div>';

    var clientInfo = _docClientNom(doc);
    if (clientInfo.nom) {
      var client = doc.clientId && VC.Clients
        ? VC.Clients.getById(doc.clientId) : null;
      html += '<div><strong>Client :</strong> ' + U.escapeHtml(clientInfo.nom);
      if (client && client.telephone) {
        html += ' <span class="muted">· ' + U.escapeHtml(client.telephone) + '</span>';
      }
      html += '</div>';
    } else {
      html += '<div><strong>Client :</strong> <span class="muted">Sans client</span></div>';
    }

    if (doc.chantierId && VC.Chantiers && typeof VC.Chantiers.getNom === 'function') {
      html += '<div><strong>Chantier :</strong> ' +
        U.escapeHtml(VC.Chantiers.getNom(doc.chantierId)) + '</div>';
    }
    if (doc.sujet) {
      html += '<div><strong>Sujet :</strong> ' + U.escapeHtml(doc.sujet) + '</div>';
    }
    if (doc.autoliquidation === true) {
      html += '<div style="margin-top:6px"><span class="badge badge-warning">' +
        '⚠️ Autoliquidation TVA activée</span></div>';
    }
    html += '</div>';

    /* Lignes */
    if (Array.isArray(doc.items) && doc.items.length > 0) {
      html += '<div class="detail-section"><h3>Lignes</h3>';
      html += '<table class="invoice-detail-table"><thead><tr>' +
        '<th>Désignation</th><th class="right">Qté</th><th class="right">P.U.</th>' +
        '<th class="right">Total</th></tr></thead><tbody>';

      for (var i = 0; i < doc.items.length; i++) {
        var it = doc.items[i];
        if (!it) continue;
        var lt = _lineTotal(it);
        var remise = U.parseNumber(it.remise);
        var designationCell = U.escapeHtml(it.designation || '');
        if (remise > 0) {
          designationCell += ' <span class="muted" style="font-size:11px">(−' +
            remise + '%)</span>';
        }
        html += '<tr><td>' + designationCell + '</td>' +
          '<td class="right">' + U.parseNumber(it.quantite) + ' ' +
          U.escapeHtml(it.unite || 'U') + '</td>' +
          '<td class="right">' + U.formatMoney(U.parseNumber(it.prix)) + '</td>' +
          '<td class="right">' + U.formatMoney(lt) + '</td></tr>';
      }
      html += '</tbody></table></div>';
    }

    /* Totaux */
    var t = doc.totals || {};
    html += '<div class="detail-section"><h3>Totaux</h3>';
    html += '<table class="invoice-detail-totals">';
    html += '<tr><td>Total HT</td><td class="right">' +
      U.formatMoney(t.totalHT || 0) + '</td></tr>';
    html += '<tr><td>TVA (' + (t.tvaRate || 0) + '%)</td><td class="right">' +
      U.formatMoney(t.tva || 0) + '</td></tr>';
    html += '<tr><td>Timbre</td><td class="right">' +
      U.formatMoney(t.timbre || 0) + '</td></tr>';
    html += '<tr class="bold"><td>Total TTC</td><td class="right">' +
      U.formatMoney(t.totalTTC || total) + '</td></tr>';

    if (t.retenueMontant > 0.001) {
      html += '<tr><td>Retenue IR</td><td class="right">− ' +
        U.formatMoney(t.retenueIR || 0) + '</td></tr>';
      html += '<tr><td>Retenue TVA</td><td class="right">− ' +
        U.formatMoney(t.retenueTVA || 0) + '</td></tr>';
    }
    if (t.retenueGarantie > 0.001) {
      html += '<tr><td>Retenue garantie</td><td class="right">− ' +
        U.formatMoney(t.retenueGarantie) + '</td></tr>';
    }
    if (avoirTotal > 0.001) {
      html += '<tr><td><strong>Avoirs</strong></td><td class="right" ' +
        'style="color:var(--danger)"><strong>− ' +
        U.formatMoney(avoirTotal) + '</strong></td></tr>';
    }

    var netApresAvoirs = _docNetApresAvoirs(doc, avoirTotal);
    html += '<tr class="bold"><td>Net après avoirs</td><td class="right">' +
      U.formatMoney(netApresAvoirs) + '</td></tr>';
    html += '<tr><td>Payé</td><td class="right">' +
      U.formatMoney(paye) + '</td></tr>';
    html += '<tr class="' + (reste > 0.001 ? 'danger' : 'success') + '">' +
      '<td><strong>Reste</strong></td>' +
      '<td class="right"><strong>' + U.formatMoney(reste) +
      '</strong></td></tr>';
    html += '</table></div>';

    /* Paiements */
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
        html += '<tr><td>' + U.escapeHtml(U.formatDate(p.date || '')) + '</td>' +
          '<td>' + U.escapeHtml(p.mode || '—') + '</td>' +
          '<td class="right">' + U.formatMoney(U.parseNumber(p.montant)) + '</td>' +
          '<td><button type="button" class="btn-icon btn-danger" ' +
          'onclick="VC.InvoicesView.removePayment(\'' + U.escapeAttr(doc.id) + '\',' +
          j + ')">🗑️</button></td></tr>';
      }
      html += '</tbody></table>';
    }
    if (reste > 0.001) {
      html += '<button type="button" class="btn btn-primary btn-sm" ' +
        'onclick="VC.InvoicesView.openPaymentModal(\'' + U.escapeAttr(doc.id) + '\')">' +
        '+ Ajouter un paiement</button>';
    }
    html += '</div>';

    /* Avoirs liés */
    if (doc.type === 'facture') {
      var avoirs = View.listAvoirsForFacture(doc.id);
      if (avoirs.length > 0) {
        html += '<div class="detail-section"><h3>Avoirs liés (' + avoirs.length + ')</h3>';
        for (var k = 0; k < avoirs.length; k++) {
          var av = avoirs[k];
          var avTotal = _docTotal(av);
          html += '<div style="display:flex;align-items:center;gap:8px;' +
            'padding:6px 0;border-bottom:1px solid var(--border)">' +
            '<span>📄 <strong>' + U.escapeHtml(av.numero || '') + '</strong></span>' +
            '<span>− ' + U.formatMoney(avTotal) + '</span>' +
            '<span class="muted">(' + U.escapeHtml(U.formatDate(_docDate(av))) + ')</span>' +
            '<button type="button" class="btn-icon btn-sm" ' +
            'onclick="VC.InvoicesView.openDetail(\'' + U.escapeAttr(av.id) + '\')">👁️</button>' +
            '</div>';
        }
        html += '</div>';
      }
    }

    /* Pièces jointes */
    var atts = Array.isArray(doc.attachments) ? doc.attachments : [];
    if (atts.length > 0) {
      html += '<div class="detail-section"><h3>Pièces jointes (' + atts.length + ')</h3>';
      for (var a = 0; a < atts.length; a++) {
        var att = atts[a];
        var icon = att.type === 'image' ? '🖼️' : '📄';
        var size = U.formatBytes(att.size || 0);
        html += '<div class="attachment-chip" style="display:inline-flex;margin:4px">' +
          icon + ' ' + U.escapeHtml(att.name || '') +
          ' <span class="muted">(' + U.escapeHtml(size) + ')</span>' +
          '</div>';
      }
      html += '</div>';
    }

    /* Actions */
    html += '<div class="detail-section detail-actions">';
    html += '<button type="button" class="btn" ' +
      'onclick="VC.Invoices.openEdit(\'' + U.escapeAttr(doc.id) + '\')">' +
      '✏️ Éditer</button> ';
    html += '<button type="button" class="btn" ' +
      'onclick="VC.InvoicesView.printPDF(\'' + U.escapeAttr(doc.id) + '\')">' +
      '🖨️ PDF</button> ';
    html += '<button type="button" class="btn" ' +
      'onclick="VC.InvoicesView.shareWhatsApp(\'' + U.escapeAttr(doc.id) + '\')">' +
      '💬 WhatsApp</button> ';
    html += '<button type="button" class="btn" ' +
      'onclick="VC.InvoicesView.shareEmail(\'' + U.escapeAttr(doc.id) + '\')">' +
      '✉️ Email</button>';

    if (doc.type === 'facture') {
      html += ' <button type="button" class="btn" ' +
        'onclick="VC.Invoices.createAvoir(\'' + U.escapeAttr(doc.id) + '\')">' +
        '↩️ Créer avoir</button>';

      if (typeof Doc.getGarantieStatut === 'function') {
        var gStatut = Doc.getGarantieStatut(doc);
        if (gStatut === 'en_attente') {
          var gMontant = Doc.getGarantieEnAttente(doc);
          if (gMontant > 0.001) {
            html += ' <button type="button" class="btn" ' +
              'style="background:var(--warning);color:#fff;border-color:var(--warning)" ' +
              'onclick="VC.InvoicesView.openLiberationGarantie(\'' +
              U.escapeAttr(doc.id) + '\')">🔓 Libérer garantie (' +
              U.formatMoney(gMontant) + ')</button>';
          }
        } else if (gStatut === 'liberee' && doc.dateLiberation) {
          html += ' <span class="badge badge-success" style="margin-left:8px">' +
            '🔓 Garantie libérée le ' + U.escapeHtml(U.formatDate(doc.dateLiberation)) +
            '</span>';
        }
      }
    }
    html += '</div>';

    body.innerHTML = html;
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 6 — PAIEMENTS
     ═══════════════════════════════════════════════════════════ */

  View.openPaymentModal = function (docId) {
    var doc = View.getById(docId);
    if (!doc) {
      U.toast('Document introuvable.', 'error');
      return;
    }

    _paymentDocId = String(docId);
    var reste = Doc.getResteAPayer(doc);

    U.setVal('paymentMontant', reste > 0 ? reste.toFixed(3) : '0.000');
    U.setVal('paymentDate', U.todayISO());
    U.setVal('paymentMode', 'espèces');
    U.setVal('paymentNote', '');
    U.setText('paymentFormError', '');

    U.setText('paymentModalTitle',
      'Paiement — ' + (doc.numero || '') +
      (reste > 0.001 ? ' (reste : ' + U.formatMoney(reste) + ')' : ''));

    U.showFlex('paymentModal');
  };

  View.savePayment = function () {
    var doc = View.getById(_paymentDocId);
    if (!doc) return;

    var errEl = document.getElementById('paymentFormError');
    if (errEl) errEl.textContent = '';

    var montant = U.parseNumber(U.getVal('paymentMontant'));
    var date = U.getVal('paymentDate');
    var mode = U.getVal('paymentMode') || 'espèces';
    var note = U.getVal('paymentNote');

    if (!(montant > 0)) {
      if (errEl) errEl.textContent = 'Montant > 0 requis.';
      return;
    }
    if (!U.isValidDateString(date)) {
      if (errEl) errEl.textContent = 'Date invalide.';
      return;
    }

    var reste = Doc.getResteAPayer(doc);
    if (montant > reste + 0.01) {
      if (errEl) errEl.textContent = 'Montant supérieur au reste (' +
        U.formatMoney(reste) + ').';
      return;
    }

    if (!Array.isArray(doc.paiements)) doc.paiements = [];
    doc.paiements.push({
      date: date,
      montant: montant,
      mode: mode,
      note: note,
      addedAt: new Date().toISOString()
    });

    if (!S.save('documents', doc)) {
      U.toast('Erreur sauvegarde paiement.', 'error');
      return;
    }

    if (VC.Clients && typeof VC.Clients.invalidateStatsCache === 'function' && doc.clientId) {
      VC.Clients.invalidateStatsCache(doc.clientId);
    }

    U.hide('paymentModal');
    _paymentDocId = null;

    View.render();
    if (_detailDocId) _renderDetailBody();
    U.toast('Paiement enregistré', 'success', 2500);
  };

  View.removePayment = function (docId, index) {
    var doc = View.getById(docId);
    if (!doc || !Array.isArray(doc.paiements)) return;
    if (index < 0 || index >= doc.paiements.length) return;

    var removed = doc.paiements[index];
    doc.paiements.splice(index, 1);

    if (!S.save('documents', doc)) {
      U.toast('Erreur suppression paiement.', 'error');
      return;
    }

    if (VC.Clients && typeof VC.Clients.invalidateStatsCache === 'function' && doc.clientId) {
      VC.Clients.invalidateStatsCache(doc.clientId);
    }

    View.render();
    if (_detailDocId) _renderDetailBody();

    U.toastUndo('Paiement supprimé (' +
      U.formatMoney(U.parseNumber(removed.montant)) + ')',
      function () {
        var d2 = View.getById(docId);
        if (!d2) return;
        if (!Array.isArray(d2.paiements)) d2.paiements = [];
        d2.paiements.splice(index, 0, removed);
        S.save('documents', d2);
        View.render();
        if (_detailDocId) _renderDetailBody();
        U.toast('Paiement restauré', 'success', 2000);
      }, 5000);
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 7 — AVOIRS LIÉS
     ═══════════════════════════════════════════════════════════ */

  View.listAvoirsForFacture = function (factureId) {
    if (!factureId) return [];
    var sid = String(factureId);
    var facture = View.getById(factureId);
    var avoirIdsFromFacture = (facture && Array.isArray(facture.avoirIds))
      ? facture.avoirIds.map(String) : [];

    var docs = S.getAll('documents');
    var seen = {};
    var out = [];

    for (var i = 0; i < docs.length; i++) {
      var d = docs[i];
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
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 8 — PDF (délégation)
     ═══════════════════════════════════════════════════════════ */

  View.printPDF = function (docId) {
    if (VC.InvoicePDF && typeof VC.InvoicePDF.print === 'function') {
      VC.InvoicePDF.print(docId);
      return;
    }
    U.toast('Module PDF non chargé.', 'error');
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 9 — PARTAGE WHATSAPP / EMAIL (FIX C30)
     ═══════════════════════════════════════════════════════════ */

  View.shareWhatsApp = function (docId) {
    var doc = View.getById(docId);
    if (!doc) return;

    var clientInfo = _docClientNom(doc);
    var client = doc.clientId && VC.Clients ? VC.Clients.getById(doc.clientId) : null;

    /* FIX C30 : utilise normalizePhone qui gère le 0 initial tunisien */
    var phone = '';
    if (client && client.telephone && VC.Clients && typeof VC.Clients.normalizePhone === 'function') {
      phone = VC.Clients.normalizePhone(client.telephone);
    }

    var net = _docNetApresAvoirs(doc, Doc.getAvoirTotalForFacture(doc.id));
    var text = 'Bonjour ' + (clientInfo.nom || '') + ',\n\n' +
      'Votre ' + View.getTypeLabel(doc) + ' N° ' + (doc.numero || '') +
      ' du ' + U.formatDate(_docDate(doc)) + '\n' +
      'Montant : ' + U.formatMoney(net) + '\n\n' +
      'Cordialement,\nVOLTCORE INGENIERIE';

    var url = phone
      ? 'https://wa.me/' + phone.replace(/^\+/, '') +
        '?text=' + encodeURIComponent(text)
      : 'https://wa.me/?text=' + encodeURIComponent(text);

    global.open(url, '_blank');
  };

  View.shareEmail = function (docId) {
    var doc = View.getById(docId);
    if (!doc) return;

    var clientInfo = _docClientNom(doc);
    var client = doc.clientId && VC.Clients ? VC.Clients.getById(doc.clientId) : null;

    var email = client && client.email ? client.email : '';
    var subject = View.getTypeLabel(doc) + ' N° ' + (doc.numero || '');
    var net = _docNetApresAvoirs(doc, Doc.getAvoirTotalForFacture(doc.id));
    var body = 'Bonjour ' + (clientInfo.nom || '') + ',\n\n' +
      'Veuillez trouver votre ' + View.getTypeLabel(doc) +
      ' N° ' + (doc.numero || '') + ' du ' + U.formatDate(_docDate(doc)) +
      '.\n\nMontant : ' + U.formatMoney(net) + '\n\n' +
      'Cordialement,\nVOLTCORE INGENIERIE';

    var url = 'mailto:' + encodeURIComponent(email) +
      '?subject=' + encodeURIComponent(subject) +
      '&body=' + encodeURIComponent(body);
    global.location.href = url;
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 10 — SUPPRESSION + UNDO
     ═══════════════════════════════════════════════════════════ */

  View.remove = function (docId) {
    var doc = View.getById(docId);
    if (!doc) return;

    /* Vérification avoirs liés */
    if (doc.type === 'facture') {
      var avoirs = View.listAvoirsForFacture(doc.id);
      if (avoirs.length > 0) {
        var msg1 = '⚠️ Cette facture a ' + avoirs.length + ' avoir(s) lié(s) :\n';
        for (var a = 0; a < avoirs.length && a < 5; a++) {
          msg1 += '• ' + (avoirs[a].numero || '—') + '\n';
        }
        msg1 += '\nSi tu supprimes la facture, les avoirs deviendront orphelins.\nContinuer ?';
        if (!U.confirm(msg1)) return;
      }
    }

    /* Avertir si avoir lié */
    if (doc.type === 'avoir' && doc.parentFactureId) {
      var parent = View.getById(doc.parentFactureId);
      if (parent) {
        var msg2 = '⚠️ Cet avoir est lié à la facture ' + (parent.numero || '') +
          '.\n\nSi tu supprimes l\'avoir, le solde de la facture augmentera.\nContinuer ?';
        if (!U.confirm(msg2)) return;
      }
    }

    if (!S.delete('documents', docId)) {
      U.toast('Erreur suppression.', 'error');
      return;
    }

    // FIX R-NEW : nettoyer les références croisées après suppression
    // Sans ce nettoyage :
    //   - une facture garde des avoirIds[] vers des avoirs supprimés
    //   - un avoir garde un parentFactureId vers une facture supprimée
    // Impact : Infra.detectOrphans() signalera des faux orphelins,
    //          et Doc.getAvoirTotalForFacture() cherchera des IDs fantômes.
    if (doc.type === 'avoir' && doc.parentFactureId) {
      var parentDoc = View.getById(doc.parentFactureId);
      if (parentDoc && Array.isArray(parentDoc.avoirIds)) {
        parentDoc.avoirIds = parentDoc.avoirIds.filter(function (id) {
          return String(id) !== String(docId);
        });
        S.save('documents', parentDoc);
      }
    }
    if (doc.type === 'facture') {
      // Récupère les avoirs AVANT qu'ils perdent la référence
      var linkedAvoirs = View.listAvoirsForFacture(doc.id);
      for (var la = 0; la < linkedAvoirs.length; la++) {
        linkedAvoirs[la].parentFactureId = '';
        S.save('documents', linkedAvoirs[la]);
      }
    }

    if (VC.Clients && typeof VC.Clients.invalidateStatsCache === 'function' && doc.clientId) {
      VC.Clients.invalidateStatsCache(doc.clientId);
    }

    View.render();
    if (_detailDocId && _detailDocId === String(docId)) View.closeDetail();

    U.toastUndo('Document supprimé : ' + (doc.numero || ''),
      function () {
        var entries = S.getTrashEntries('documents');
        for (var i = 0; i < entries.length; i++) {
          if (entries[i].item && String(entries[i].item.id) === String(docId)) {
            S.restoreFromTrash('documents', i);
            View.render();
            U.toast('Document restauré', 'success', 2000);
            return;
          }
        }
      }, 5000);
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 11 — GARANTIE BTP : LIBÉRATION
     ═══════════════════════════════════════════════════════════ */

  View.openLiberationGarantie = function (docId) {
    var doc = View.getById(docId);
    if (!doc) {
      U.toast('Document introuvable.', 'error');
      return;
    }

    var statut = Doc.getGarantieStatut(doc);
    if (statut !== 'en_attente') {
      U.toast('Aucune garantie en attente.', 'warning');
      return;
    }

    var garantieMax = Doc.getGarantieEnAttente(doc);
    if (!(garantieMax > 0.001)) {
      U.toast('Montant de garantie invalide.', 'warning');
      return;
    }

    U.setVal('libGarantieDocId', doc.id);
    U.setVal('libGarantieMontant', garantieMax.toFixed(3));
    U.setVal('libGarantieDate', U.todayISO());
    U.setVal('libGarantieMode', 'virement');
    U.setVal('libGarantieNote', '');

    U.setText('libGarantieTitle', '🔓 Libérer la garantie — ' + (doc.numero || ''));

    var clientNom = '—';
    if (doc.clientId && VC.Clients) {
      var c = VC.Clients.getById(doc.clientId);
      if (c) clientNom = c.nom || '—';
    }

    var infoEl = document.getElementById('libGarantieInfo');
    if (infoEl) {
      infoEl.innerHTML =
        'Facture <strong>' + U.escapeHtml(doc.numero || '') + '</strong> · ' +
        'Client <strong>' + U.escapeHtml(clientNom) + '</strong><br>' +
        'Garantie en attente : <strong>' + U.formatMoney(garantieMax) + '</strong>';
    }

    U.setText('libGarantieError', '');
    U.showFlex('liberationGarantieModal');

    setTimeout(function () {
      try {
        var el = document.getElementById('libGarantieMontant');
        if (el) { el.focus(); el.select(); }
      } catch (e) {
        VC.logError('12-inv-view', 'openLiberationGarantie focus échoué', e);
      }
    }, 100);
  };

  View.closeLiberationGarantie = function () {
    U.hide('liberationGarantieModal');
  };

  View.confirmLiberationGarantie = function () {
    var errEl = document.getElementById('libGarantieError');
    if (errEl) errEl.textContent = '';

    var docId = U.getVal('libGarantieDocId');
    var doc = View.getById(docId);
    if (!doc) {
      if (errEl) errEl.textContent = 'Document introuvable.';
      return;
    }

    var montant = U.parseNumber(U.getVal('libGarantieMontant'));
    var date = U.getVal('libGarantieDate');
    var mode = U.getVal('libGarantieMode') || 'virement';
    var note = U.getVal('libGarantieNote');

    if (!(montant > 0)) {
      if (errEl) errEl.textContent = 'Montant > 0 requis.';
      return;
    }
    if (!U.isValidDateString(date)) {
      if (errEl) errEl.textContent = 'Date invalide.';
      return;
    }

    var garantieMax = Doc.getGarantieEnAttente(doc);
    if (montant > garantieMax + 0.01) {
      if (errEl) errEl.textContent = 'Montant > garantie en attente (' +
        U.formatMoney(garantieMax) + ').';
      return;
    }

    /* Ajouter un paiement de type liberation_garantie */
    if (!Array.isArray(doc.paiements)) doc.paiements = [];
    doc.paiements.push({
      date: date,
      montant: montant,
      mode: mode,
      note: note || 'Libération garantie',
      type: 'liberation_garantie',
      addedAt: new Date().toISOString()
    });

    if (montant >= garantieMax - 0.001) {
      doc.garantieLiberee = true;
      doc.dateLiberation = date;
    }

    if (!S.save('documents', doc)) {
      U.toast('Erreur sauvegarde.', 'error');
      return;
    }

    if (VC.Clients && typeof VC.Clients.invalidateStatsCache === 'function' && doc.clientId) {
      VC.Clients.invalidateStatsCache(doc.clientId);
    }

    U.toast('Garantie libérée : ' + U.formatMoney(montant), 'success', 3000);
    View.closeLiberationGarantie();

    View.render();
    if (_detailDocId) _renderDetailBody();

    if (VC.Dashboard && typeof VC.Dashboard.render === 'function') {
      try { VC.Dashboard.render(); } catch (e) {
        VC.logError('12-inv-view', 'refresh dashboard échoué', e);
      }
    }
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 12 — EVENTS
     ═══════════════════════════════════════════════════════════ */

  View.attachEvents = function () {
    U.on('invoicesSearchInput', 'input', U.debounce(function (ev) {
      View.setSearch(ev.target.value);
    }, 250));

    U.on('invoicesFilterSelect', 'change', function (ev) {
      View.setFilter(ev.target.value);
    });

    U.on('invoicesClientFilterSelect', 'change', function (ev) {
      View.setClientFilter(ev.target.value);
    });

    U.on('btnAddInvoice', 'click', function () {
      VC.Invoices.openForm();
    });

    U.on('paymentSaveBtn', 'click', View.savePayment);
    U.on('libGarantieSaveBtn', 'click', View.confirmLiberationGarantie);

    /* Re-render auto sur changement de documents */
    S.subscribe('documents', function () {
      View.render();
    });

    /* Peupler le filtre client au démarrage + sur changement */
    _populateClientFilter();
    S.subscribe('clients', function () {
      _populateClientFilter();
    });
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 13 — MARQUEUR
     ═══════════════════════════════════════════════════════════ */

  VC._invViewLoaded = true;

  VC.logInfo('12-inv-view', 'Module chargé (WhatsApp corrigé, PDF délégué)');

})(window);