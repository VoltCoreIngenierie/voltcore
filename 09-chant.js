/* ═══════════════════════════════════════════════════════════
   VOLTCORE — 09-chant.js
   VERSION : v7.0.0
   RÔLE : CRUD chantiers, marges temps réel, mode actif,
          devis/facture 1 clic, import/export, impression.
          Normalisation + save + load + trash : gérés par Store.
   DÉPENDANCES : 00-core, 01-utils, 02-store, 04-alerts
   ORDRE : 10ᵉ fichier chargé

   RÈGLES :
   - ES5 strict
   - Aucun catch silencieux
   - FIX M6 : badge rafraîchi via subscribe (plus besoin de l'appeler au boot)
   - FIX M8 : deleteChantier vérifie les références (docs, frais, RH)
   - Ne JAMAIS lire/écrire localStorage directement
   ═══════════════════════════════════════════════════════════ */

'use strict';

(function (global) {

  if (!global.VOLTCORE || !global.VOLTCORE.Store || !global.VOLTCORE.Utils) {
    throw new Error('[09-chant] Modules requis non chargés');
  }

  var VC = global.VOLTCORE;
  var U = VC.Utils;
  var S = VC.Store;
  var A = VC.Alerts;
  var Doc = VC.Doc;
  var Ch = VC.Chantiers || {};
  VC.Chantiers = Ch;

  /* ═══════════════════════════════════════════════════════════
     SECTION 1 — REGISTRATION STORE
     ═══════════════════════════════════════════════════════════ */

  S.register('chantiers', {
    type: 'array',
    saveKey: 'voltcore_chantiers',
    default: [],
    idPrefix: 'ch',
    trash: true,
    backup: true,
    schema: {
      nom: 'string|required',
      clientId: 'string',
      adresse: 'string',
      dateDebut: 'date',
      dateFin: 'date',
      budget: 'float|0-99999999',
      statut: 'enum|planifie,en_cours,termine,annule',
      responsable: 'string',
      notes: 'string'
    }
  });

  S.register('chantierActif', {
    type: 'string',
    saveKey: 'voltcore_chantier_actif',
    default: '',
    backup: true
  });

  /* ═══════════════════════════════════════════════════════════
     SECTION 2 — ÉTAT INTERNE
     ═══════════════════════════════════════════════════════════ */

  var _searchTerm = '';
  var _filter = 'all';

  var STATUTS = {
    planifie: 'Planifié',
    en_cours: 'En cours',
    termine: 'Terminé',
    annule: 'Annulé'
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 3 — HELPERS
     ═══════════════════════════════════════════════════════════ */

  Ch.getById = function (id) {
    return S.getById('chantiers', id);
  };

  Ch.getNom = function (id) {
    var ch = Ch.getById(id);
    return ch ? String(ch.nom || '') : '';
  };

  Ch.exists = function (nom, excludeId) {
    if (!nom) return false;
    var normalized = U.normalizeText(nom);
    var list = S.getAll('chantiers');
    for (var i = 0; i < list.length; i++) {
      var ch = list[i];
      if (!ch) continue;
      if (excludeId && String(ch.id) === String(excludeId)) continue;
      if (U.normalizeText(ch.nom || '') === normalized) return true;
    }
    return false;
  };

  Ch.getStatutLabel = function (statut) {
    return STATUTS[statut] || STATUTS.en_cours;
  };

  Ch.getStatutColor = function (statut) {
    if (statut === 'termine') return 'var(--success)';
    if (statut === 'annule') return 'var(--danger)';
    if (statut === 'planifie') return 'var(--info)';
    return 'var(--warning)';
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 4 — STATISTIQUES
     ═══════════════════════════════════════════════════════════ */

  Ch.getStats = function (chantierId) {
    var empty = {
      recettes: 0, achats: 0, frais: 0, rh: 0, marge: 0, margePct: 0,
      nbFactures: 0, budget: 0, ecartBudget: 0, partBudget: 0
    };

    var ch = Ch.getById(chantierId);
    if (!ch) return empty;

    var m = A.computeChantierMarge(chantierId);

    var budget = U.parseNumber(ch.budget);
    var ecartBudget = budget > 0 ? budget - m.recettes : 0;
    var partBudget = budget > 0 ? (m.recettes / budget) : 0;

    return {
      recettes: m.recettes,
      achats: m.achats,
      frais: m.frais,
      rh: m.rh,
      marge: m.marge,
      margePct: m.margePct,
      nbFactures: m.nbDocs,
      budget: budget,
      ecartBudget: ecartBudget,
      partBudget: partBudget
    };
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 5 — MODE ACTIF
     ═══════════════════════════════════════════════════════════ */

  Ch.getActive = function () {
    var id = S.getValue('chantierActif');
    return id ? Ch.getById(id) : null;
  };

  Ch.setActive = function (id) {
    var ch = Ch.getById(id);
    if (!ch) {
      U.toast('Chantier introuvable.', 'error');
      return false;
    }
    S.setValue('chantierActif', String(id));
    /* renderBadge est appelé via subscribe */
    Ch.render();
    U.toast('Chantier actif : ' + ch.nom, 'success');
    return true;
  };

  Ch.clearActive = function () {
    S.setValue('chantierActif', '');
    Ch.render();
    U.toast('Aucun chantier actif.', 'info');
    return true;
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 6 — RENDU BADGE (header)
     ═══════════════════════════════════════════════════════════ */

  Ch.renderBadge = function () {
    var badge = document.getElementById('activeChantierBadge');
    if (!badge) return;

    var ch = Ch.getActive();
    if (ch) {
      badge.innerHTML = '🏗️ ' + U.escapeHtml(ch.nom) +
        ' <button type="button" class="btn-icon-mini" ' +
        'onclick="VC.Chantiers.clearActive()" title="Désactiver">✕</button>';
      badge.style.display = 'inline-flex';
    } else {
      badge.innerHTML = '';
      badge.style.display = 'none';
    }
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 7 — RENDU LISTE
     ═══════════════════════════════════════════════════════════ */

  Ch.render = function () {
    var container = document.getElementById('chantiersList');
    if (!container) return;

    var list = Ch.getFiltered();
    if (list.length === 0) {
      container.innerHTML = '<div class="empty-state">Aucun chantier' +
        (_searchTerm || _filter !== 'all' ? ' pour ce filtre' : '') +
        '. Clique sur "+ Nouveau chantier" pour commencer.</div>';
      U.setText('chantiersCount', '0');
      return;
    }

    var html = '';
    var activeId = String(S.getValue('chantierActif') || '');
    for (var i = 0; i < list.length; i++) {
      html += Ch.renderRow(list[i], activeId);
    }
    container.innerHTML = html;
    U.setText('chantiersCount', String(list.length));
  };

  Ch.renderRow = function (ch, activeId) {
    if (!ch) return '';

    var id = U.escapeAttr(ch.id);
    var nom = U.escapeHtml(ch.nom || '(Sans nom)');
    var clientNom = ch.clientId ? U.escapeHtml(Ch._getClientNom(ch.clientId)) : '<span class="muted">Sans client</span>';
    var isActive = activeId && String(activeId) === String(ch.id);

    var statut = String(ch.statut || 'en_cours');
    var statutLabel = Ch.getStatutLabel(statut);
    var statutColor = Ch.getStatutColor(statut);

    var stats = Ch.getStats(ch.id);
    var margeColor = stats.margePct >= 0.10 ? 'var(--success)'
      : stats.margePct >= 0 ? 'var(--warning)' : 'var(--danger)';

    var budgetBadge = '';
    if (stats.budget > 0) {
      var pct = stats.partBudget * 100;
      var bColor = pct > 110 ? 'var(--danger)' : pct > 90 ? 'var(--warning)' : 'var(--success)';
      budgetBadge = '<span class="badge" style="background:' + bColor + ';color:#fff">' +
        pct.toFixed(0) + '% budget</span>';
    }

    return '<div class="chantier-row' + (isActive ? ' active' : '') + '" data-chantier-id="' + id + '">' +
      '<div class="chantier-row-main">' +
        '<div class="chantier-row-name">' +
          (isActive ? '🏗️ ' : '') + nom +
          ' <span class="badge" style="background:' + statutColor + ';color:#fff">' +
          U.escapeHtml(statutLabel) + '</span> ' +
          budgetBadge +
        '</div>' +
        '<div class="chantier-row-meta">' +
          clientNom +
          (ch.dateDebut ? ' · ' + U.escapeHtml(U.formatDate(ch.dateDebut)) : '') +
          (ch.dateFin ? ' → ' + U.escapeHtml(U.formatDate(ch.dateFin)) : '') +
        '</div>' +
        '<div class="chantier-row-marge" style="color:' + margeColor + '">' +
          'CA : ' + U.formatMoney(stats.recettes) +
          ' · Marge : ' + U.formatMoney(stats.marge) +
          ' (' + (stats.margePct * 100).toFixed(1) + '%)' +
        '</div>' +
      '</div>' +
      '<div class="chantier-row-actions">' +
        (isActive
          ? '<button type="button" class="btn-icon" title="Désactiver" ' +
            'onclick="VC.Chantiers.clearActive()">⏹️</button>'
          : '<button type="button" class="btn-icon" title="Activer" ' +
            'onclick="VC.Chantiers.setActive(\'' + id + '\')">▶️</button>') +
        '<button type="button" class="btn-icon" title="Détail" ' +
        'onclick="VC.Chantiers.openDetail(\'' + id + '\')">👁️</button>' +
        '<button type="button" class="btn-icon" title="Éditer" ' +
        'onclick="VC.Chantiers.openModal(\'' + id + '\')">✏️</button>' +
        '<button type="button" class="btn-icon" title="Devis" ' +
        'onclick="VC.Chantiers.createDevis(\'' + id + '\')">📝</button>' +
        '<button type="button" class="btn-icon btn-danger" title="Supprimer" ' +
        'onclick="VC.Chantiers.remove(\'' + id + '\')">🗑️</button>' +
      '</div>' +
    '</div>';
  };

  /* Helper local : évite dépendance circulaire avec 06-clients */
  Ch._getClientNom = function (clientId) {
    if (!clientId) return '';
    if (VC.Clients && typeof VC.Clients.getNom === 'function') {
      return VC.Clients.getNom(clientId);
    }
    return '';
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 8 — DÉTAIL
     ═══════════════════════════════════════════════════════════ */

  Ch.openDetail = function (id) {
    var ch = Ch.getById(id);
    if (!ch) {
      U.toast('Chantier introuvable.', 'error');
      return;
    }

    U.setText('chantierDetailTitle', ch.nom || 'Chantier');

    var stats = Ch.getStats(id);
    var statut = String(ch.statut || 'en_cours');
    var statutColor = Ch.getStatutColor(statut);

    var html = '';

    /* Bloc infos */
    html += '<div class="detail-section"><h3>Informations</h3><div class="detail-grid">';
    html += _detailItem('Client', ch.clientId ? Ch._getClientNom(ch.clientId) : '—');
    html += _detailItem('Statut', Ch.getStatutLabel(statut));
    html += _detailItem('Responsable', ch.responsable || '—');
    html += _detailItem('Adresse', ch.adresse || '—');
    html += _detailItem('Date début', ch.dateDebut ? U.formatDate(ch.dateDebut) : '—');
    html += _detailItem('Date fin', ch.dateFin ? U.formatDate(ch.dateFin) : '—');
    html += '</div></div>';

    /* Bloc marges */
    html += '<div class="detail-section"><h3>Marges</h3><div class="stats-grid">';
    html += _statItem('Recettes', U.formatMoney(stats.recettes));
    html += _statItem('Achats', U.formatMoney(stats.achats));
    html += _statItem('Frais', U.formatMoney(stats.frais));
    html += _statItem('RH', U.formatMoney(stats.rh));
    var margeColor = stats.margePct >= 0.10 ? 'var(--success)'
      : stats.margePct >= 0 ? 'var(--warning)' : 'var(--danger)';
    html += _statItem('Marge', U.formatMoney(stats.marge), margeColor);
    html += _statItem('Marge %', (stats.margePct * 100).toFixed(1) + '%', margeColor);
    html += '</div></div>';

    /* Bloc budget */
    if (stats.budget > 0) {
      var pct = stats.partBudget * 100;
      var bColor = pct > 110 ? 'var(--danger)' : pct > 90 ? 'var(--warning)' : 'var(--success)';
      html += '<div class="detail-section"><h3>Budget</h3>';
      html += '<div class="budget-bar"><div class="budget-fill" style="width:' +
        Math.min(100, pct) + '%;background:' + bColor + '"></div></div>';
      html += '<div class="budget-info">' +
        U.formatMoney(stats.recettes) + ' / ' + U.formatMoney(stats.budget) +
        ' (' + pct.toFixed(1) + '%) — reste ' + U.formatMoney(stats.ecartBudget) + '</div>';
      html += '</div>';
    }

    /* Bloc notes */
    if (ch.notes) {
      html += '<div class="detail-section"><h3>Notes</h3><p class="detail-notes">' +
        U.escapeHtml(ch.notes).replace(/\n/g, '<br>') + '</p></div>';
    }

    /* Actions */
    html += '<div class="detail-section detail-actions">';
    html += '<button type="button" class="btn btn-primary" ' +
      'onclick="VC.Chantiers.createDevis(\'' + U.escapeAttr(id) + '\')">📝 Créer un devis</button> ';
    html += '<button type="button" class="btn" ' +
      'onclick="VC.Chantiers.createFacture(\'' + U.escapeAttr(id) + '\')">🧾 Créer une facture</button> ';
    html += '<button type="button" class="btn" ' +
      'onclick="VC.Chantiers.printRecap(\'' + U.escapeAttr(id) + '\')">🖨️ Récap</button>';
    html += '</div>';

    var body = document.getElementById('chantierDetailBody');
    if (body) body.innerHTML = html;
    U.showFlex('chantierDetailModal');
  };

  Ch.closeDetail = function () {
    U.hide('chantierDetailModal');
  };

  function _detailItem(label, value) {
    return '<div class="detail-item">' +
      '<div class="detail-label">' + U.escapeHtml(label) + '</div>' +
      '<div class="detail-value">' + U.escapeHtml(value) + '</div>' +
      '</div>';
  }

  function _statItem(label, value, color) {
    return '<div class="stat-item">' +
      '<div class="stat-value"' + (color ? ' style="color:' + color + '"' : '') + '>' +
      U.escapeHtml(value) + '</div>' +
      '<div class="stat-label">' + U.escapeHtml(label) + '</div>' +
      '</div>';
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 9 — FORMULAIRE
     ═══════════════════════════════════════════════════════════ */

  Ch.openModal = function (id) {
    var form = document.getElementById('chantierForm');
    if (form) form.reset();

    _populateClients(id ? Ch.getById(id).clientId : '');

    if (id) {
      var ch = Ch.getById(id);
      if (!ch) {
        U.toast('Chantier introuvable.', 'error');
        return;
      }
      U.setText('chantierModalTitle', 'Modifier chantier');
      U.setVal('chantierId', ch.id);
      U.setVal('chantierNom', ch.nom || '');
      U.setVal('chantierAdresse', ch.adresse || '');
      U.setVal('chantierDateDebut', ch.dateDebut || '');
      U.setVal('chantierDateFin', ch.dateFin || '');
      U.setVal('chantierBudget', ch.budget || '');
      U.setVal('chantierResponsable', ch.responsable || '');
      U.setVal('chantierStatut', ch.statut || 'en_cours');
      U.setVal('chantierNotes', ch.notes || '');
    } else {
      U.setText('chantierModalTitle', 'Nouveau chantier');
      U.setVal('chantierId', '');
      U.setVal('chantierStatut', 'en_cours');
    }

    U.setText('chantierFormError', '');
    U.showFlex('chantierModal');

    setTimeout(function () {
      try {
        var el = document.getElementById('chantierNom');
        if (el) el.focus();
      } catch (e) {
        VC.logError('09-chant', 'openModal focus échoué', e);
      }
    }, 100);
  };

  Ch.closeModal = function () {
    U.hide('chantierModal');
  };

  function _populateClients(selectedId) {
    var clients = S.getAll('clients').slice();
    clients.sort(function (a, b) {
      return U.normalizeText(a.nom || '') > U.normalizeText(b.nom || '') ? 1 : -1;
    });

    var items = [{ id: '', nom: '— Aucun —' }];
    for (var i = 0; i < clients.length; i++) {
      items.push({ id: clients[i].id, nom: clients[i].nom });
    }

    U.populateSelect('chantierClientSelect', items, 'nom', 'id', selectedId || '');
  }

  Ch.saveFromForm = function () {
    var errEl = document.getElementById('chantierFormError');
    if (errEl) errEl.textContent = '';

    var id = U.getVal('chantierId');
    var nom = U.getVal('chantierNom');

    if (!nom) {
      if (errEl) errEl.textContent = 'Le nom est obligatoire.';
      return;
    }
    if (Ch.exists(nom, id)) {
      if (errEl) errEl.textContent = 'Un chantier avec ce nom existe déjà.';
      return;
    }

    var dateDebut = U.getVal('chantierDateDebut');
    var dateFin = U.getVal('chantierDateFin');
    if (dateDebut && dateFin && dateFin < dateDebut) {
      if (errEl) errEl.textContent = 'La date de fin ne peut pas être avant la date de début.';
      return;
    }

    var raw = {
      id: id || undefined,
      nom: nom,
      clientId: U.getVal('chantierClientSelect'),
      adresse: U.getVal('chantierAdresse'),
      dateDebut: dateDebut,
      dateFin: dateFin,
      budget: U.getVal('chantierBudget'),
      responsable: U.getVal('chantierResponsable'),
      statut: U.getVal('chantierStatut') || 'en_cours',
      notes: U.getVal('chantierNotes')
    };

    var saved = S.save('chantiers', raw);
    if (!saved) {
      if (errEl) errEl.textContent = 'Données invalides.';
      return;
    }

    Ch.closeModal();
    U.toast(id ? 'Chantier modifié' : 'Chantier créé', 'success', 2500);
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 10 — SUPPRESSION (FIX M8)
     ═══════════════════════════════════════════════════════════ */

  Ch.remove = function (id) {
    var ch = Ch.getById(id);
    if (!ch) return;

    /* FIX M8 : vérifier les références AVANT suppression */
    var refs = _countRefs(id);
    var total = refs.factures + refs.frais + refs.rh + refs.bonsRoute;

    var msg = 'Supprimer le chantier "' + (ch.nom || '') + '" ?';
    if (total > 0) {
      msg = '⚠️ Ce chantier est référencé par :\n';
      if (refs.factures > 0) msg += '• ' + refs.factures + ' facture(s)\n';
      if (refs.frais > 0) msg += '• ' + refs.frais + ' frais\n';
      if (refs.rh > 0) msg += '• ' + refs.rh + ' journée(s) RH\n';
      if (refs.bonsRoute > 0) msg += '• ' + refs.bonsRoute + ' bon(s) route\n';
      msg += '\nLes références deviendront orphelines.\nContinuer ?';
    }

    if (!U.confirm(msg)) return;

    /* Si actif, désactive */
    if (String(S.getValue('chantierActif') || '') === String(id)) {
      S.setValue('chantierActif', '');
    }

    if (!S.delete('chantiers', id)) {
      U.toast('Erreur suppression.', 'error');
      return;
    }

    Ch.render();
    U.toastUndo('Chantier supprimé : ' + (ch.nom || ''),
      function () { _restore(id); }, 5000);
  };

  function _countRefs(id) {
    var sid = String(id);
    var docs = S.getAll('documents');
    var frais = S.getAll('frais');
    var works = S.getAll('hrWorkEntries');
    var bons = S.getAll('bonsRoute');

    var factures = 0, nbFrais = 0, nbRh = 0, nbBr = 0;

    for (var i = 0; i < docs.length; i++) {
      if (docs[i] && String(docs[i].chantierId || '') === sid) factures++;
    }
    for (var j = 0; j < frais.length; j++) {
      if (frais[j] && String(frais[j].chantierId || '') === sid) nbFrais++;
    }
    for (var k = 0; k < works.length; k++) {
      if (works[k] && String(works[k].chantierId || '') === sid) nbRh++;
    }
    for (var l = 0; l < bons.length; l++) {
      if (bons[l] && String(bons[l].chantierId || '') === sid) nbBr++;
    }

    return { factures: factures, frais: nbFrais, rh: nbRh, bonsRoute: nbBr };
  }

  function _restore(id) {
    var entries = S.getTrashEntries('chantiers');
    for (var i = 0; i < entries.length; i++) {
      if (entries[i].item && String(entries[i].item.id) === String(id)) {
        S.restoreFromTrash('chantiers', i);
        Ch.render();
        U.toast('Chantier restauré', 'success', 2000);
        return;
      }
    }
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 11 — DEVIS / FACTURE 1 CLIC
     ═══════════════════════════════════════════════════════════ */

  Ch.createDevis = function (id) {
    var ch = Ch.getById(id);
    if (!ch) return;

    var prefill = {
      type: 'devis',
      clientId: String(ch.clientId || ''),
      chantierId: String(ch.id),
      sujet: String(ch.nom || ''),
      notes: 'Chantier : ' + String(ch.nom || '')
    };

    global.__pendingChantierPrefill = prefill;

    if (VC.Invoices && typeof VC.Invoices.openWithPrefill === 'function') {
      VC.Invoices.openWithPrefill(prefill);
      return;
    }
    if (VC.Invoices && typeof VC.Invoices.openForm === 'function') {
      VC.Invoices.openForm();
      return;
    }

    U.toast('Devis préparé. Ouvre Facturation pour compléter.', 'info', 4000);

    if (VC.Nav && typeof VC.Nav.go === 'function') {
      VC.Nav.go('facturation');
    } else {
      var el = document.querySelector('[data-nav-section="facturation"]');
      if (el) el.click();
    }
  };

  Ch.createFacture = function (id) {
    var ch = Ch.getById(id);
    if (!ch) return;

    var prefill = {
      type: 'facture',
      clientId: String(ch.clientId || ''),
      chantierId: String(ch.id),
      sujet: String(ch.nom || ''),
      notes: 'Chantier : ' + String(ch.nom || '')
    };

    global.__pendingChantierPrefill = prefill;

    if (VC.Invoices && typeof VC.Invoices.openWithPrefill === 'function') {
      VC.Invoices.openWithPrefill(prefill);
      return;
    }
    if (VC.Invoices && typeof VC.Invoices.openForm === 'function') {
      VC.Invoices.openForm();
      return;
    }

    U.toast('Facture préparée. Ouvre Facturation pour compléter.', 'info', 4000);

    if (VC.Nav && typeof VC.Nav.go === 'function') {
      VC.Nav.go('facturation');
    }
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 12 — FILTRES
     ═══════════════════════════════════════════════════════════ */

  Ch.setSearch = function (term) {
    _searchTerm = String(term || '');
    Ch.render();
  };

  Ch.setFilter = function (filter) {
    _filter = String(filter || 'all');
    Ch.render();
  };

  Ch.getFiltered = function () {
    var out = S.getAll('chantiers').slice();

    if (_searchTerm) {
      var term = U.normalizeText(_searchTerm);
      out = out.filter(function (ch) {
        if (!ch) return false;
        var cn = ch.clientId ? Ch._getClientNom(ch.clientId) : '';
        var hay = U.normalizeText([ch.nom, ch.adresse, ch.responsable, cn].join(' '));
        return hay.indexOf(term) >= 0;
      });
    }

    if (_filter === 'actifs') {
      out = out.filter(function (ch) { return String(ch.statut || 'en_cours') === 'en_cours'; });
    } else if (_filter === 'termines') {
      out = out.filter(function (ch) { return String(ch.statut) === 'termine'; });
    } else if (_filter === 'planifies') {
      out = out.filter(function (ch) { return String(ch.statut) === 'planifie'; });
    } else if (_filter === 'negatifs') {
      out = out.filter(function (ch) {
        return Ch.getStats(ch.id).margePct < 0;
      });
    }

    out.sort(function (a, b) {
      var na = U.normalizeText(a.nom || '');
      var nb = U.normalizeText(b.nom || '');
      return na > nb ? 1 : (na < nb ? -1 : 0);
    });

    return out;
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 13 — IMPORT / EXPORT
     ═══════════════════════════════════════════════════════════ */

  Ch.exportJSON = function () {
    var chantiers = S.getAll('chantiers');
    var data = {
      version: 1,
      exportedAt: new Date().toISOString(),
      count: chantiers.length,
      chantiers: chantiers
    };
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    U.downloadBlob(blob, 'voltcore-chantiers-' + U.todayISO() + '.json');
    U.toast(chantiers.length + ' chantier(s) exporté(s)', 'success');
  };

  Ch.exportCSV = function () {
    var chantiers = S.getAll('chantiers');
    var lines = [];
    lines.push([
      'Nom', 'Client', 'Adresse', 'DateDebut', 'DateFin',
      'Budget', 'Statut', 'Responsable', 'Notes'
    ].join('\t'));

    for (var i = 0; i < chantiers.length; i++) {
      var ch = chantiers[i];
      if (!ch) continue;
      lines.push([
        _csv(ch.nom),
        _csv(ch.clientId ? Ch._getClientNom(ch.clientId) : ''),
        _csv(ch.adresse),
        _csv(ch.dateDebut || ''),
        _csv(ch.dateFin || ''),
        String(U.parseNumber(ch.budget)),
        _csv(Ch.getStatutLabel(ch.statut)),
        _csv(ch.responsable || ''),
        _csv(ch.notes || '')
      ].join('\t'));
    }

    var csv = '\uFEFF' + lines.join('\r\n');
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    U.downloadBlob(blob, 'voltcore-chantiers-' + U.todayISO() + '.csv');
    U.toast('CSV exporté', 'success');
  };

  function _csv(v) {
    return String(v == null ? '' : v).replace(/\t/g, ' ').replace(/\r?\n/g, ' ');
  }

  Ch.importJSON = function (file) {
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
            : (parsed && Array.isArray(parsed.chantiers)) ? parsed.chantiers : null;
          if (!arr) {
            reject(new Error('Format invalide : chantiers[] attendu'));
            return;
          }

          var added = 0, skipped = 0, invalid = 0;
          for (var i = 0; i < arr.length; i++) {
            var clean = S.normalize('chantiers', arr[i]);
            if (!clean) { invalid++; continue; }
            if (Ch.exists(clean.nom)) { skipped++; continue; }
            if (S.save('chantiers', clean)) added++;
            else invalid++;
          }

          Ch.render();

          var msg = added + ' chantier(s) importé(s)';
          if (skipped > 0) msg += ' · ' + skipped + ' doublon(s)';
          if (invalid > 0) msg += ' · ' + invalid + ' invalide(s)';
          U.toast(msg, added > 0 ? 'success' : 'warning', 4000);

          resolve({ added: added, skipped: skipped, invalid: invalid });
        } catch (err) {
          VC.logError('09-chant', 'importJSON parse échoué', err);
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
     SECTION 14 — IMPRESSION
     ═══════════════════════════════════════════════════════════ */

  Ch.printList = function () {
    var list = Ch.getFiltered();
    var html = '<!DOCTYPE html><html><head><meta charset="UTF-8">' +
      '<title>Chantiers — VOLTCORE</title><style>' +
      'body{font-family:Arial;margin:20px;font-size:12px}' +
      'h1{color:#1A2B4C;border-bottom:2px solid #1A2B4C;padding-bottom:6px}' +
      'table{width:100%;border-collapse:collapse;margin-top:10px}' +
      'th,td{border:1px solid #ccc;padding:6px;text-align:left}' +
      'th{background:#f0f0f0}.right{text-align:right}' +
      '</style></head><body>';
    html += '<h1>Liste des chantiers</h1>';
    html += '<div>Total : ' + list.length + ' · ' + U.todayISO() + '</div>';
    html += '<table><thead><tr><th>Nom</th><th>Client</th><th>Statut</th>' +
      '<th class="right">CA</th><th class="right">Marge</th><th class="right">Marge %</th>' +
      '</tr></thead><tbody>';

    for (var i = 0; i < list.length; i++) {
      var ch = list[i];
      var s = Ch.getStats(ch.id);
      html += '<tr><td>' + U.escapeHtml(ch.nom) + '</td>' +
        '<td>' + U.escapeHtml(ch.clientId ? Ch._getClientNom(ch.clientId) : '—') + '</td>' +
        '<td>' + U.escapeHtml(Ch.getStatutLabel(ch.statut)) + '</td>' +
        '<td class="right">' + U.formatMoney(s.recettes) + '</td>' +
        '<td class="right">' + U.formatMoney(s.marge) + '</td>' +
        '<td class="right">' + (s.margePct * 100).toFixed(1) + '%</td></tr>';
    }
    html += '</tbody></table></body></html>';

    _printHTML(html);
  };

  Ch.printRecap = function (id) {
    var ch = Ch.getById(id);
    if (!ch) return;

    var s = Ch.getStats(id);

    var html = '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Récap ' +
      U.escapeHtml(ch.nom) + '</title><style>' +
      'body{font-family:Arial;margin:20px;font-size:12px}' +
      'h1{color:#1A2B4C;border-bottom:2px solid #1A2B4C;padding-bottom:6px}' +
      'h2{color:#1A2B4C;font-size:14px;margin-top:18px}' +
      'table{width:100%;border-collapse:collapse;margin-top:6px}' +
      'th,td{border:1px solid #ccc;padding:6px;text-align:left}' +
      'th{background:#f0f0f0}.right{text-align:right}.muted{color:#666}' +
      '</style></head><body>';

    html += '<h1>Récap chantier : ' + U.escapeHtml(ch.nom) + '</h1>';
    html += '<p class="muted">' +
      U.escapeHtml(ch.clientId ? Ch._getClientNom(ch.clientId) : '—') +
      ' · ' + U.escapeHtml(Ch.getStatutLabel(ch.statut)) + '</p>';

    html += '<h2>Marges</h2><table><tbody>';
    html += '<tr><th>Recettes</th><td class="right">' + U.formatMoney(s.recettes) + '</td></tr>';
    html += '<tr><th>Achats</th><td class="right">' + U.formatMoney(s.achats) + '</td></tr>';
    html += '<tr><th>Frais</th><td class="right">' + U.formatMoney(s.frais) + '</td></tr>';
    html += '<tr><th>RH</th><td class="right">' + U.formatMoney(s.rh) + '</td></tr>';
    html += '<tr><th><strong>Marge</strong></th><td class="right"><strong>' +
      U.formatMoney(s.marge) + ' (' + (s.margePct * 100).toFixed(1) + '%)</strong></td></tr>';
    html += '</tbody></table>';

    html += '<div class="muted" style="margin-top:20px;text-align:center">VOLTCORE — ' +
      U.todayISO() + '</div></body></html>';

    _printHTML(html);
  };

  function _printHTML(html) {
    var w = global.open('', '_blank');
    if (!w) {
      U.toast('Autorise les pop-ups pour imprimer.', 'warning');
      return;
    }
    w.document.write(html);
    w.document.close();
    setTimeout(function () {
      try { w.print(); } catch (e) {
        VC.logError('09-chant', 'print échoué', e);
      }
    }, 500);
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 15 — EVENTS
     ═══════════════════════════════════════════════════════════ */

  Ch.attachEvents = function () {
    U.on('chantiersSearchInput', 'input', U.debounce(function (ev) {
      Ch.setSearch(ev.target.value);
    }, 250));

    U.on('chantiersFilterSelect', 'change', function (ev) {
      Ch.setFilter(ev.target.value);
    });

    U.on('btnAddChantier', 'click', function () {
      Ch.openModal(null);
    });

    U.on('btnImportChantiers', 'click', function () {
      var input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json,application/json';
      input.onchange = function (ev) {
        var f = ev.target.files && ev.target.files[0];
        if (!f) return;
        Ch.importJSON(f).catch(function (err) {
          U.toast('Import échoué : ' + (err.message || ''), 'error');
        });
      };
      input.click();
    });

    U.on('btnExportChantiersJSON', 'click', Ch.exportJSON);
    U.on('btnExportChantiersCSV', 'click', Ch.exportCSV);
    U.on('btnPrintChantiers', 'click', Ch.printList);

    /* Subscribe : re-render auto + badge rafraîchi */
    S.subscribe('chantiers', function () {
      Ch.render();
    });
    S.subscribe('chantierActif', function () {
      /* FIX M6 : le badge est rafraîchi à chaque changement de chantierActif,
         y compris au boot via loadAll + notifyOnLoad */
      Ch.renderBadge();
      Ch.render();
    });
    S.subscribe('clients', function () {
      Ch.render();
    });
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 16 — MARQUEUR
     ═══════════════════════════════════════════════════════════ */

  VC._chantLoaded = true;

  VC.logInfo('09-chant', 'Module chargé');

})(window);