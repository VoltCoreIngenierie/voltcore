/* ═══════════════════════════════════════════════════════════
   VOLTCORE — 06-clients.js
   VERSION : v7.0.0
   RÔLE : CRUD clients, recherche/tri, détail, relance WhatsApp,
          import/export JSON+CSV, impression.
          Normalisation + save + load + trash : gérés par Store.
   DÉPENDANCES : 00-core, 01-utils, 02-store, 04-alerts
   ORDRE : 7ᵉ fichier chargé

   RÈGLES :
   - ES5 strict
   - Aucun catch silencieux
   - Ne JAMAIS lire/écrire localStorage directement (Store fait tout)
   - Aucun global var clients (utiliser Store.getAll('clients'))
   ═══════════════════════════════════════════════════════════ */

'use strict';

(function (global) {

  if (!global.VOLTCORE || !global.VOLTCORE.Store || !global.VOLTCORE.Utils) {
    throw new Error('[06-clients] Modules requis non chargés');
  }

  var VC = global.VOLTCORE;
  var U = VC.Utils;
  var S = VC.Store;
  var Doc = VC.Doc;
  var Cli = VC.Clients || {};
  VC.Clients = Cli;

  /* ═══════════════════════════════════════════════════════════
     SECTION 1 — REGISTRATION STORE
     ═══════════════════════════════════════════════════════════ */

  S.register('clients', {
    type: 'array',
    saveKey: 'voltcore_clients',
    default: [],
    idPrefix: 'cli',
    trash: true,
    backup: true,
    schema: {
      nom: 'string|required',
      telephone: 'string',
      email: 'string',
      adresse: 'string',
      mf: 'string',
      cin: 'string',
      notes: 'string',
      type: 'enum|particulier,entreprise,administration,sous-traitant',
      delaiPaiement: 'int|0-365',
      retenueSource: 'float|0-100',
      gouvernorat: 'string',
      adresseChantier: 'string',
      codeTVA: 'string',
      codeCategorie: 'string'
    }
  });

  /* ═══════════════════════════════════════════════════════════
     SECTION 2 — ÉTAT INTERNE
     ═══════════════════════════════════════════════════════════ */

  var _searchTerm = '';
  var _filter = 'all';
  var _sortField = 'nom';
  var _sortDir = 'asc';
  var _statsCache = {};
  var _statsCacheAt = {};

  var CACHE_TTL_MS = 30000;

  /* ═══════════════════════════════════════════════════════════
     SECTION 3 — HELPERS
     ═══════════════════════════════════════════════════════════ */

  Cli.getById = function (id) {
    return S.getById('clients', id);
  };

  Cli.getNom = function (id) {
    var c = Cli.getById(id);
    return c ? String(c.nom || '') : '';
  };

  Cli.exists = function (nom, excludeId) {
    if (!nom) return false;
    var normalized = U.normalizeText(nom);
    var clients = S.getAll('clients');
    for (var i = 0; i < clients.length; i++) {
      var c = clients[i];
      if (!c) continue;
      if (excludeId && String(c.id) === String(excludeId)) continue;
      if (U.normalizeText(c.nom || '') === normalized) return true;
    }
    return false;
  };

  Cli.getTypeLabel = function (type) {
    var t = String(type || 'particulier').toLowerCase();
    if (t === 'entreprise') return 'Entreprise';
    if (t === 'administration') return 'Administration';
    if (t === 'sous-traitant') return 'Sous-traitant';
    return 'Particulier';
  };

  Cli.getDelaiLabel = function (j) {
    var n = parseInt(j, 10);
    if (!n || n <= 0) return 'Comptant';
    return n + ' jours';
  };

  /**
   * Normalise un numéro tunisien ou international (format E.164).
   * Utilisé par la relance WhatsApp et le PDF facture.
   */
  Cli.normalizePhone = function (tel) {
    if (!tel) return '';
    var s = String(tel).trim();
    if (!s) return '';

    /* Retire tout sauf chiffres et + */
    s = s.replace(/[^0-9+]/g, '');
    if (!s) return '';

    /* Cas international avec + */
    if (s.charAt(0) === '+') {
      var digits = s.slice(1);
      if (digits.length >= 8 && digits.length <= 15) return '+' + digits;
      return '';
    }

    /* Préfixe 00 → + */
    if (s.indexOf('00') === 0) {
      var d2 = s.slice(2);
      if (d2.length >= 8 && d2.length <= 15) return '+' + d2;
      return '';
    }

    /* 216XXXXXXXX sans + */
    if (s.indexOf('216') === 0 && s.length >= 11 && s.length <= 14) {
      return '+' + s;
    }

    /* 0XXXXXXXX (9 chiffres) */
    if (s.charAt(0) === '0' && s.length === 9) {
      return '+216' + s.slice(1);
    }

    /* 8 chiffres locaux */
    if (s.length === 8) {
      return '+216' + s;
    }

    return '';
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 4 — STATISTIQUES
     ═══════════════════════════════════════════════════════════ */

  Cli.invalidateStatsCache = function (clientId) {
    if (clientId) {
      delete _statsCache[String(clientId)];
      delete _statsCacheAt[String(clientId)];
    } else {
      _statsCache = {};
      _statsCacheAt = {};
    }
  };

  Cli.getStats = function (clientId) {
    var empty = {
      nbFactures: 0, nbChantiers: 0, caTotal: 0, marge: 0, margePct: 0,
      impaye: 0, retardJours: 0, derniereFactureDate: '',
      dernierPaiementDate: '', aRisque: false
    };
    if (!clientId) return empty;

    var sid = String(clientId);
    var now = Date.now();

    /* Cache */
    if (_statsCache[sid] && (now - _statsCacheAt[sid]) < CACHE_TTL_MS) {
      return _statsCache[sid];
    }

    var client = Cli.getById(clientId);
    if (!client) return empty;

    var margeData = VC.Alerts.computeClientMarge(clientId);
    var docs = S.getAll('documents');
    var chantiers = S.getAll('chantiers');

    var impaye = 0, retardJours = 0;
    var derniereFactureDate = '', dernierPaiementDate = '';
    var delaiJ = client.delaiPaiement || 0;

    var today = new Date();
    today.setHours(0, 0, 0, 0);

    for (var i = 0; i < docs.length; i++) {
      var d = docs[i];
      if (!d || d.type !== 'facture') continue;
      if (String(d.clientId || '') !== sid) continue;
      if (d.statut === 'annulee' || d.annulee === true) continue;

      var r = Doc.getResteAPayer(d);
      if (r > 0) impaye += r;

      var dFact = String(d.date || '').slice(0, 10);
      if (dFact && dFact > derniereFactureDate) derniereFactureDate = dFact;

      if (r > 0 && dFact) {
        var tsF = Date.parse(dFact);
        if (!isNaN(tsF)) {
          var dtF = new Date(tsF);
          dtF.setHours(0, 0, 0, 0);
          var jours = Math.floor((today.getTime() - dtF.getTime()) / 86400000);
          var retard = jours - delaiJ;
          if (retard > retardJours) retardJours = retard;
        }
      }

      var paiements = d.paiements || [];
      for (var p = 0; p < paiements.length; p++) {
        var dP = String(paiements[p].date || '');
        if (dP && dP > dernierPaiementDate) dernierPaiementDate = dP;
      }
    }

    var nbChantiers = 0;
    for (var j = 0; j < chantiers.length; j++) {
      if (chantiers[j] && String(chantiers[j].clientId || '') === sid) nbChantiers++;
    }

    var caTotal = margeData.recettes || 0;
    var aRisque = (caTotal > 0) && (impaye > 0.30 * caTotal);

    var result = {
      nbFactures: margeData.nbDocs || 0,
      nbChantiers: nbChantiers,
      caTotal: caTotal,
      marge: margeData.marge || 0,
      margePct: margeData.margePct || 0,
      impaye: impaye,
      retardJours: retardJours,
      derniereFactureDate: derniereFactureDate,
      dernierPaiementDate: dernierPaiementDate,
      aRisque: aRisque
    };

    _statsCache[sid] = result;
    _statsCacheAt[sid] = now;
    return result;
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 5 — RENDU LISTE
     ═══════════════════════════════════════════════════════════ */

  Cli.render = function () {
    var container = document.getElementById('clientsList');
    if (!container) return;

    var list = Cli.getFiltered();
    if (list.length === 0) {
      container.innerHTML = '<div class="empty-state">Aucun client' +
        (_searchTerm || _filter !== 'all' ? ' pour ce filtre' : '') +
        '. Clique sur "+ Nouveau client" pour commencer.</div>';
      _updateCount(0);
      return;
    }

    var html = '';
    for (var i = 0; i < list.length; i++) {
      html += Cli.renderRow(list[i]);
    }
    container.innerHTML = html;
    _updateCount(list.length);
  };

  Cli.renderRow = function (c) {
    if (!c) return '';
    var id = U.escapeAttr(c.id);
    var nom = U.escapeHtml(c.nom || '(Sans nom)');
    var tel = U.escapeHtml(c.telephone || '');
    var email = U.escapeHtml(c.email || '');

    var metaParts = [];
    if (tel) metaParts.push('📞 ' + tel);
    if (email) metaParts.push('✉️ ' + email);
    metaParts.push('<span class="muted">[' + U.escapeHtml(Cli.getTypeLabel(c.type)) + ']</span>');

    var stats = Cli.getStats(c.id);
    var badges = '';
    if (stats.aRisque) badges += '<span class="badge badge-error" title="Client à risque">⚠️</span>';
    if (stats.impaye > 0.001) {
      badges += '<span class="badge badge-error">' + U.formatMoney(stats.impaye) + '</span>';
    }
    if (stats.retardJours > 0) {
      badges += '<span class="badge badge-warning">⏰ ' + stats.retardJours + 'j</span>';
    }

    return '<div class="client-row" data-client-id="' + id + '">' +
      '<div class="client-row-main">' +
        '<div class="client-row-name">' + nom + ' ' + badges + '</div>' +
        '<div class="client-row-meta">' + metaParts.join(' · ') + '</div>' +
      '</div>' +
      '<div class="client-row-actions">' +
        '<button type="button" class="btn-icon" title="Voir" ' +
        'onclick="VC.Clients.openDetail(\'' + id + '\')">👁️</button>' +
        '<button type="button" class="btn-icon" title="Éditer" ' +
        'onclick="VC.Clients.openModal(\'' + id + '\')">✏️</button>' +
        '<button type="button" class="btn-icon btn-danger" title="Supprimer" ' +
        'onclick="VC.Clients.remove(\'' + id + '\')">🗑️</button>' +
      '</div>' +
    '</div>';
  };

  function _updateCount(n) {
    U.setText('clientsCount', String(n));
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 6 — DÉTAIL
     ═══════════════════════════════════════════════════════════ */

  Cli.openDetail = function (id) {
    var c = Cli.getById(id);
    if (!c) {
      U.toast('Client introuvable.', 'error');
      return;
    }

    U.setText('clientDetailTitle', c.nom || 'Client');

    var stats = Cli.getStats(c.id);
    var margeColor = stats.margePct >= 0.10 ? 'var(--success)'
      : stats.margePct >= 0 ? 'var(--warning)' : 'var(--danger)';

    var html = '';

    /* Bloc contact */
    html += '<div class="detail-section"><h3>Contact</h3><div class="detail-grid">';
    html += _detailItem('Téléphone', c.telephone || '—');
    html += _detailItem('Email', c.email || '—');
    html += _detailItem('Adresse', c.adresse || '—');
    html += _detailItem('Type', Cli.getTypeLabel(c.type));
    html += _detailItem('Gouvernorat', c.gouvernorat || '—');
    html += _detailItem('Adresse chantier', c.adresseChantier || '—');
    html += '</div></div>';

    /* Bloc fiscal */
    html += '<div class="detail-section"><h3>Fiscal & paiement</h3><div class="detail-grid">';
    html += _detailItem('MF', c.mf || '—');
    html += _detailItem('CIN', c.cin || '—');
    html += _detailItem('Code TVA', c.codeTVA || '—');
    html += _detailItem('Code catégorie', c.codeCategorie || '—');
    html += _detailItem('Délai paiement', Cli.getDelaiLabel(c.delaiPaiement));
    html += _detailItem('Retenue source', (c.retenueSource || 0) + ' %');
    html += '</div></div>';

    /* Bloc activité */
    html += '<div class="detail-section"><h3>Activité</h3><div class="stats-grid">';
    html += _statItem('Factures', String(stats.nbFactures));
    html += _statItem('Chantiers', String(stats.nbChantiers));
    html += _statItem('CA total', U.formatMoney(stats.caTotal));
    html += _statItem('Marge', U.formatMoney(stats.marge), margeColor);
    html += _statItem('Marge %', (stats.margePct * 100).toFixed(1) + '%', margeColor);
    html += _statItem('Impayés', U.formatMoney(stats.impaye),
      stats.impaye > 0.001 ? 'var(--danger)' : '');
    html += _statItem('Retard', stats.retardJours > 0 ? (stats.retardJours + ' j') : '—',
      stats.retardJours > 0 ? 'var(--warning)' : '');
    html += _statItem('Dernière facture', stats.derniereFactureDate ? U.formatDate(stats.derniereFactureDate) : '—');
    html += _statItem('Dernier paiement', stats.dernierPaiementDate ? U.formatDate(stats.dernierPaiementDate) : '—');
    html += '</div></div>';

    /* Bouton relance WhatsApp */
    if (stats.impaye > 0.001) {
      html += '<div class="detail-section"><h3>Relance</h3>';
      html += '<button type="button" class="btn btn-warning" ' +
        'onclick="VC.Clients.relance(\'' + U.escapeAttr(c.id) + '\')">' +
        '📲 Relancer via WhatsApp (' + U.formatMoney(stats.impaye) + ')</button>';
      html += '</div>';
    }

    if (c.notes) {
      html += '<div class="detail-section"><h3>Notes</h3><p class="detail-notes">' +
        U.escapeHtml(c.notes).replace(/\n/g, '<br>') + '</p></div>';
    }

    var body = document.getElementById('clientDetailBody');
    if (body) body.innerHTML = html;
    U.showFlex('clientDetailModal');
  };

  Cli.closeDetail = function () {
    U.hide('clientDetailModal');
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
     SECTION 7 — RELANCE WHATSAPP
     ═══════════════════════════════════════════════════════════ */

  Cli.relance = function (id) {
    var c = Cli.getById(id);
    if (!c) return;

    var tel = Cli.normalizePhone(c.telephone);
    if (!tel) {
      U.toast('Aucun numéro valide pour ce client.', 'warning');
      return;
    }

    var stats = Cli.getStats(c.id);
    var msg = 'Bonjour ' + (c.nom || '') + ', ' +
      'nous vous rappelons que votre compte présente un solde impayé de ' +
      U.formatMoney(stats.impaye) + '. ' +
      'Merci de bien vouloir procéder au règlement. ' +
      'Cordialement, VOLTCORE INGENIERIE.';

    var url = 'https://wa.me/' + tel.replace(/^\+/, '') +
      '?text=' + encodeURIComponent(msg);
    global.open(url, '_blank');
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 8 — FORMULAIRE
     ═══════════════════════════════════════════════════════════ */

  Cli.openModal = function (id) {
    var form = document.getElementById('clientForm');
    if (form) form.reset();

    if (id) {
      var c = Cli.getById(id);
      if (!c) {
        U.toast('Client introuvable.', 'error');
        return;
      }
      U.setText('clientModalTitle', 'Modifier client');
      U.setVal('clientId', c.id);
      U.setVal('clientNom', c.nom || '');
      U.setVal('clientTelephone', c.telephone || '');
      U.setVal('clientEmail', c.email || '');
      U.setVal('clientAdresse', c.adresse || '');
      U.setVal('clientMF', c.mf || '');
      U.setVal('clientCIN', c.cin || '');
      U.setVal('clientNotes', c.notes || '');
      U.setVal('clientType', c.type || 'particulier');
      U.setVal('clientDelai', String(c.delaiPaiement || 0));
      U.setVal('clientRetenue', String(c.retenueSource || 0));
      U.setVal('clientGouvernorat', c.gouvernorat || '');
      U.setVal('clientAdresseChantier', c.adresseChantier || '');
      U.setVal('clientCodeTVA', c.codeTVA || '');
      U.setVal('clientCodeCategorie', c.codeCategorie || '');
    } else {
      U.setText('clientModalTitle', 'Nouveau client');
      U.setVal('clientId', '');
      U.setVal('clientType', 'particulier');
      U.setVal('clientDelai', '0');
      U.setVal('clientRetenue', '0');
    }

    U.setText('clientFormError', '');
    U.showFlex('clientModal');

    setTimeout(function () {
      try {
        var el = document.getElementById('clientNom');
        if (el) el.focus();
      } catch (e) {
        VC.logError('06-clients', 'openModal focus échoué', e);
      }
    }, 100);
  };

  Cli.closeModal = function () {
    U.hide('clientModal');
  };

  Cli.saveFromForm = function () {
    var errEl = document.getElementById('clientFormError');
    if (errEl) errEl.textContent = '';

    var id = U.getVal('clientId');
    var nom = U.getVal('clientNom');

    if (!nom) {
      if (errEl) errEl.textContent = 'Le nom est obligatoire.';
      return;
    }
    if (Cli.exists(nom, id)) {
      if (errEl) errEl.textContent = 'Un client avec ce nom existe déjà.';
      return;
    }

    var raw = {
      id: id || undefined,
      nom: nom,
      telephone: U.getVal('clientTelephone'),
      email: U.getVal('clientEmail'),
      adresse: U.getVal('clientAdresse'),
      mf: U.getVal('clientMF'),
      cin: U.getVal('clientCIN'),
      notes: U.getVal('clientNotes'),
      type: U.getVal('clientType') || 'particulier',
      delaiPaiement: U.getVal('clientDelai'),
      retenueSource: U.getVal('clientRetenue'),
      gouvernorat: U.getVal('clientGouvernorat'),
      adresseChantier: U.getVal('clientAdresseChantier'),
      codeTVA: U.getVal('clientCodeTVA'),
      codeCategorie: U.getVal('clientCodeCategorie')
    };

    var saved = S.save('clients', raw);
    if (!saved) {
      if (errEl) errEl.textContent = 'Données invalides.';
      return;
    }

    Cli.invalidateStatsCache(saved.id);
    Cli.closeModal();
    Cli.render();
    U.toast(id ? 'Client modifié' : 'Client créé', 'success', 2500);
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 9 — SUPPRESSION
     ═══════════════════════════════════════════════════════════ */

  /**
   * FIX M7 : vérification des références AVANT suppression.
   * Refuse si le client a des factures ou chantiers actifs,
   * sauf si l'utilisateur confirme explicitement.
   */
  Cli.remove = function (id) {
    var c = Cli.getById(id);
    if (!c) return;

    var refs = _countRefs(id);
    var total = refs.factures + refs.chantiers + refs.frais;

    var msg = 'Supprimer le client "' + (c.nom || '') + '" ?';
    if (total > 0) {
      msg = '⚠️ Ce client est référencé par :\n';
      if (refs.factures > 0) msg += '• ' + refs.factures + ' facture(s)\n';
      if (refs.chantiers > 0) msg += '• ' + refs.chantiers + ' chantier(s)\n';
      if (refs.frais > 0) msg += '• ' + refs.frais + ' frais\n';
      msg += '\nLes références deviendront orphelines.\nContinuer ?';
    }

    if (!U.confirm(msg)) return;

    /* FIX R2 : préserver le nom du client dans les enfants AVANT suppression.
       Ça évite les orphelins "Sans client" après coup — le nom reste
       affiché en tant que "(non enregistré)". */
    var clientNom = String(c.nom || '');
    var docs = S.getAll('documents');
    var chantiers = S.getAll('chantiers');
    var frais = S.getAll('frais');
    for (var di = 0; di < docs.length; di++) {
      if (docs[di] && String(docs[di].clientId || '') === String(id)) {
        docs[di]._clientNomOrphelin = clientNom;
      }
    }
    for (var ci = 0; ci < chantiers.length; ci++) {
      if (chantiers[ci] && String(chantiers[ci].clientId || '') === String(id)) {
        chantiers[ci]._clientNomOrphelin = clientNom;
      }
    }
    for (var fi = 0; fi < frais.length; fi++) {
      if (frais[fi] && String(frais[fi].clientId || '') === String(id)) {
        frais[fi]._clientNomOrphelin = clientNom;
      }
    }

    if (!S.delete('clients', id)) {
      U.toast('Erreur suppression.', 'error');
      return;
    }

    /* Persiste les mutations _clientNomOrphelin sur documents/chantiers/frais */
    S.saveAll();

    Cli.invalidateStatsCache(id);
    Cli.render();

    U.toastUndo('Client supprimé : ' + (c.nom || ''),
      function () { _restore(id); }, 5000);
  };

  function _countRefs(id) {
    var sid = String(id);
    var docs = S.getAll('documents');
    var chantiers = S.getAll('chantiers');
    var frais = S.getAll('frais');

    var factures = 0, nbCh = 0, nbFrais = 0;

    for (var i = 0; i < docs.length; i++) {
      if (docs[i] && String(docs[i].clientId || '') === sid) factures++;
    }
    for (var j = 0; j < chantiers.length; j++) {
      if (chantiers[j] && String(chantiers[j].clientId || '') === sid) nbCh++;
    }
    for (var k = 0; k < frais.length; k++) {
      if (frais[k] && String(frais[k].clientId || '') === sid) nbFrais++;
    }

    return { factures: factures, chantiers: nbCh, frais: nbFrais };
  }

  function _restore(id) {
    /* Retrouve l'index dans le trash */
    var trashEntries = S.getTrashEntries('clients');
    for (var i = 0; i < trashEntries.length; i++) {
      if (trashEntries[i].item && String(trashEntries[i].item.id) === String(id)) {
        S.restoreFromTrash('clients', i);
        Cli.invalidateStatsCache(id);
        Cli.render();
        U.toast('Client restauré', 'success', 2000);
        return;
      }
    }
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 10 — RECHERCHE / FILTRE / TRI
     ═══════════════════════════════════════════════════════════ */

  Cli.setSearch = function (term) {
    _searchTerm = String(term || '');
    Cli.render();
  };

  Cli.setFilter = function (filter) {
    _filter = String(filter || 'all');
    Cli.render();
  };

  Cli.setSort = function (field) {
    var f = String(field || 'nom');
    if (f === _sortField) {
      _sortDir = (_sortDir === 'asc') ? 'desc' : 'asc';
    } else {
      _sortField = f;
      _sortDir = 'asc';
    }
    Cli.render();
  };

  Cli.getFiltered = function () {
    var out = S.getAll('clients').slice();

    if (_searchTerm) {
      var term = U.normalizeText(_searchTerm);
      out = out.filter(function (c) {
        if (!c) return false;
        var hay = U.normalizeText([
          c.nom, c.telephone, c.email, c.adresse,
          c.mf, c.cin, c.gouvernorat, c.adresseChantier
        ].join(' '));
        return hay.indexOf(term) >= 0;
      });
    }

    if (_filter === 'with_docs') {
      out = out.filter(function (c) {
        var s = Cli.getStats(c.id);
        return s.nbFactures > 0 || s.nbChantiers > 0;
      });
    } else if (_filter === 'without_docs') {
      out = out.filter(function (c) {
        var s = Cli.getStats(c.id);
        return s.nbFactures === 0 && s.nbChantiers === 0;
      });
    } else if (_filter === 'with_impayes') {
      out = out.filter(function (c) {
        return Cli.getStats(c.id).impaye > 0.001;
      });
    } else if (_filter === 'a_risque') {
      out = out.filter(function (c) {
        return Cli.getStats(c.id).aRisque;
      });
    }

    var dir = (_sortDir === 'desc') ? -1 : 1;
    var field = _sortField;
    if (field === 'ca' || field === 'marge' || field === 'impaye' || field === 'retard') {
      out.sort(function (a, b) {
        var sa = Cli.getStats(a.id);
        var sb = Cli.getStats(b.id);
        var va = 0, vb = 0;
        if (field === 'ca') { va = sa.caTotal; vb = sb.caTotal; }
        else if (field === 'marge') { va = sa.marge; vb = sb.marge; }
        else if (field === 'impaye') { va = sa.impaye; vb = sb.impaye; }
        else if (field === 'retard') { va = sa.retardJours; vb = sb.retardJours; }
        if (va === vb) return 0;
        return (va < vb ? -1 : 1) * dir;
      });
    } else {
      out.sort(function (a, b) {
        var na = U.normalizeText(a.nom || '');
        var nb = U.normalizeText(b.nom || '');
        if (na === nb) return 0;
        return (na < nb ? -1 : 1) * dir;
      });
    }

    return out;
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 11 — IMPORT / EXPORT
     ═══════════════════════════════════════════════════════════ */

  Cli.exportJSON = function () {
    var clients = S.getAll('clients');
    var data = {
      version: 1,
      exportedAt: new Date().toISOString(),
      count: clients.length,
      clients: clients
    };
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    U.downloadBlob(blob, 'voltcore-clients-' + U.todayISO() + '.json');
    U.toast(clients.length + ' client(s) exporté(s)', 'success');
  };

  Cli.exportCSV = function () {
    var clients = S.getAll('clients');
    var lines = [];
    lines.push([
      'Nom', 'Type', 'Téléphone', 'Email', 'Adresse', 'Gouvernorat',
      'Adresse chantier', 'MF', 'CIN', 'Code TVA', 'Code catégorie',
      'Délai paiement', 'Retenue source', 'Notes'
    ].join('\t'));

    for (var i = 0; i < clients.length; i++) {
      var c = clients[i];
      if (!c) continue;
      lines.push([
        _csv(c.nom), _csv(Cli.getTypeLabel(c.type)),
        _csv(c.telephone), _csv(c.email), _csv(c.adresse),
        _csv(c.gouvernorat), _csv(c.adresseChantier),
        _csv(c.mf), _csv(c.cin), _csv(c.codeTVA), _csv(c.codeCategorie),
        _csv(Cli.getDelaiLabel(c.delaiPaiement)),
        _csv(String(c.retenueSource || 0)),
        _csv(c.notes)
      ].join('\t'));
    }
    var csv = '\uFEFF' + lines.join('\r\n');
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    U.downloadBlob(blob, 'voltcore-clients-' + U.todayISO() + '.csv');
    U.toast('CSV exporté', 'success');
  };

  function _csv(v) {
    return String(v == null ? '' : v).replace(/\t/g, ' ').replace(/\r?\n/g, ' ');
  }

  Cli.importJSON = function (file) {
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
            : (parsed && Array.isArray(parsed.clients)) ? parsed.clients : null;
          if (!arr) {
            reject(new Error('Format invalide : clients[] attendu'));
            return;
          }

          var added = 0, skipped = 0, invalid = 0;
          for (var i = 0; i < arr.length; i++) {
            var clean = S.normalize('clients', arr[i]);
            if (!clean) { invalid++; continue; }
            if (Cli.exists(clean.nom)) { skipped++; continue; }
            if (S.save('clients', clean)) added++;
            else invalid++;
          }

          Cli.invalidateStatsCache();
          Cli.render();

          var msg = added + ' client(s) importé(s)';
          if (skipped > 0) msg += ' · ' + skipped + ' doublon(s)';
          if (invalid > 0) msg += ' · ' + invalid + ' invalide(s)';
          U.toast(msg, added > 0 ? 'success' : 'warning', 4000);

          resolve({ added: added, skipped: skipped, invalid: invalid });
        } catch (err) {
          VC.logError('06-clients', 'importJSON parse échoué', err);
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
     SECTION 12 — IMPRESSION
     ═══════════════════════════════════════════════════════════ */

  Cli.print = function () {
    var list = Cli.getFiltered();
    var html = '<!DOCTYPE html><html><head><meta charset="UTF-8">' +
      '<title>Liste des clients — VOLTCORE</title><style>' +
      'body{font-family:Arial,sans-serif;margin:20px;font-size:12px}' +
      'h1{color:#1A2B4C;font-size:18px;border-bottom:2px solid #1A2B4C;padding-bottom:6px}' +
      'table{width:100%;border-collapse:collapse;margin-top:10px}' +
      'th,td{border:1px solid #ccc;padding:6px;text-align:left}' +
      'th{background:#f0f0f0;font-weight:bold}' +
      '</style></head><body>';
    html += '<h1>Liste des clients</h1>';
    html += '<div>Total : ' + list.length + ' · ' + U.todayISO() + '</div>';
    html += '<table><thead><tr>' +
      '<th>Nom</th><th>Type</th><th>Téléphone</th><th>Email</th><th>MF</th>' +
      '</tr></thead><tbody>';
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      html += '<tr>' +
        '<td>' + U.escapeHtml(c.nom || '') + '</td>' +
        '<td>' + U.escapeHtml(Cli.getTypeLabel(c.type)) + '</td>' +
        '<td>' + U.escapeHtml(c.telephone || '') + '</td>' +
        '<td>' + U.escapeHtml(c.email || '') + '</td>' +
        '<td>' + U.escapeHtml(c.mf || '') + '</td>' +
        '</tr>';
    }
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
        VC.logError('06-clients', 'print échoué', e);
      }
    }, 500);
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 13 — EVENTS
     ═══════════════════════════════════════════════════════════ */

  Cli.attachEvents = function () {
    U.on('clientsSearchInput', 'input', U.debounce(function (ev) {
      Cli.setSearch(ev.target.value);
    }, 250));

    U.on('clientsFilterSelect', 'change', function (ev) {
      Cli.setFilter(ev.target.value);
    });

    U.on('clientsSortSelect', 'change', function (ev) {
      Cli.setSort(ev.target.value);
      _updateSortDirButton();
    });

    U.on('clientsSortDirBtn', 'click', function () {
      Cli.setSort(_sortField);
      _updateSortDirButton();
    });

    U.on('btnAddClient', 'click', function () {
      Cli.openModal(null);
    });

    U.on('btnImportClients', 'click', function () {
      var input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json,application/json';
      input.onchange = function (ev) {
        var f = ev.target.files && ev.target.files[0];
        if (!f) return;
        Cli.importJSON(f).catch(function (err) {
          U.toast('Import échoué : ' + (err.message || ''), 'error');
        });
      };
      input.click();
    });

    U.on('btnExportClientsJSON', 'click', Cli.exportJSON);
    U.on('btnExportClientsCSV', 'click', Cli.exportCSV);
    U.on('btnPrintClients', 'click', Cli.print);

    /* Store subscribe pour re-render automatique */
    S.subscribe('clients', function () {
      Cli.invalidateStatsCache();
      Cli.render();
    });

    _updateSortDirButton();
  };

  function _updateSortDirButton() {
    var btn = document.getElementById('clientsSortDirBtn');
    if (btn) btn.textContent = (_sortDir === 'asc') ? '↑' : '↓';
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 14 — MARQUEUR
     ═══════════════════════════════════════════════════════════ */

  VC._clientsLoaded = true;

  VC.logInfo('06-clients', 'Module chargé');

})(window);