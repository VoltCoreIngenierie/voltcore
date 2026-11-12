/* ═══════════════════════════════════════════════════════════
   VOLTCORE — 16-route.js
   VERSION : v7.0.0
   RÔLE : Bons route (traçabilité Sfax ↔ Tunis).
          HORS COMPTABILITÉ : aucun champ montant/TVA/total.
          3 types (sortie/commande/deplacement) + 5 statuts.
          PDF imprimable + signature/cachet optionnels.
   DÉPENDANCES : 00-core, 01-utils, 02-store, 03-idb, 09-chant
   ORDRE : 17ᵉ fichier chargé

   ⚠️ RÈGLE ABSOLUE — HORS COMPTABILITÉ :
   - Aucun champ montant / tva / total dans le schéma
   - Aucune écriture dans documents ni frais
   - Aucune lecture par computeChantierMarge / computeDashboardKPIs
   - Aucune mention TOTAL TTC / TVA / NET À PAYER dans le PDF

   RÈGLES :
   - ES5 strict
   - Aucun catch silencieux
   - Ne JAMAIS lire/écrire localStorage directement
   ═══════════════════════════════════════════════════════════ */

'use strict';

(function (global) {

  if (!global.VOLTCORE || !global.VOLTCORE.Store || !global.VOLTCORE.Utils) {
    throw new Error('[16-route] Modules requis non chargés');
  }

  var VC = global.VOLTCORE;
  var U = VC.Utils;
  var S = VC.Store;
  var IDB = VC.IDB;
  var Ch = VC.Chantiers;
  var Rt = VC.Route || {};
  VC.Route = Rt;

  /* ═══════════════════════════════════════════════════════════
     SECTION 1 — REGISTRATION STORE
     ═══════════════════════════════════════════════════════════ */

  S.register('bonsRoute', {
    type: 'array',
    saveKey: 'voltcore_bons_route',
    default: [],
    idPrefix: 'br',
    trash: true,
    backup: true,
    schema: {
      numero: 'string|required',
      type: 'enum|sortie,commande,deplacement',
      dateCreation: 'date|required',
      dateDepart: 'date',
      dateRetour: 'date',
      vehicule: 'string|required',
      chauffeur: 'string',
      destination: 'enum|tunis,sfax,autre',
      adressePrecise: 'string',
      chantierId: 'string',
      kmDepart: 'float|0-9999999',
      kmRetour: 'float|0-9999999',
      statut: 'enum|brouillon,envoye,recu,retourne,archive',
      notes: 'string'
    }
  });

  /* ═══════════════════════════════════════════════════════════
     SECTION 2 — CONSTANTES + ÉTAT
     ═══════════════════════════════════════════════════════════ */

  var TYPES = {
    sortie: { label: 'Bon de sortie', icon: '📤' },
    commande: { label: 'Bon de commande', icon: '📥' },
    deplacement: { label: 'Bon de déplacement', icon: '🚐' }
  };

  var STATUTS = {
    brouillon: { label: 'Brouillon', icon: '📝', color: 'var(--muted)' },
    envoye: { label: 'Envoyé', icon: '📤', color: 'var(--info)' },
    recu: { label: 'Reçu', icon: '📥', color: 'var(--success)' },
    retourne: { label: 'Retourné', icon: '🔙', color: 'var(--warning)' },
    archive: { label: 'Archivé', icon: '📚', color: 'var(--muted)' }
  };

  var DESTINATIONS = {
    tunis: 'Tunis',
    sfax: 'Sfax',
    autre: 'Autre'
  };

  var MAX_KM = 9999999;
  var MAX_QTY = 10000000;
  var NUMERO_PREFIX = 'BR';

  var _searchTerm = '';
  var _filterType = 'all';
  var _filterStatut = 'all';
  var _filterDest = 'all';
  var _page = 0;
  var _perPage = 50;

  var _editId = null;
  var _modalMateriel = [];
  var _modalDocuments = [];

  /* ═══════════════════════════════════════════════════════════
     SECTION 3 — HELPERS
     ═══════════════════════════════════════════════════════════ */

  Rt.getById = function (id) {
    return S.getById('bonsRoute', id);
  };

  Rt.getTypeLabel = function (type) {
    var t = String(type || '').toLowerCase();
    return TYPES[t] ? TYPES[t].icon + ' ' + TYPES[t].label : '📄 ' + t;
  };

  Rt.getStatutLabel = function (statut) {
    var s = String(statut || 'brouillon').toLowerCase();
    return STATUTS[s] ? STATUTS[s].icon + ' ' + STATUTS[s].label : s;
  };

  Rt.getStatutColor = function (statut) {
    var s = String(statut || 'brouillon').toLowerCase();
    return STATUTS[s] ? STATUTS[s].color : 'var(--muted)';
  };

  Rt.getDestinationLabel = function (dest) {
    return DESTINATIONS[dest] || 'Autre';
  };

  Rt.computeKmParcourus = function (bon) {
    if (!bon) return 0;
    var dep = U.parseNumber(bon.kmDepart);
    var ret = U.parseNumber(bon.kmRetour);
    if (!ret || ret <= dep) return 0;
    return ret - dep;
  };

  Rt.numeroExists = function (numero, excludeId) {
    if (!numero) return false;
    var target = String(numero).trim().toLowerCase();
    var list = S.getAll('bonsRoute');
    for (var i = 0; i < list.length; i++) {
      var b = list[i];
      if (!b || !b.numero) continue;
      if (excludeId && String(b.id) === String(excludeId)) continue;
      if (String(b.numero).trim().toLowerCase() === target) return true;
    }
    return false;
  };

  function _genererNumero() {
    var year = new Date().getFullYear();
    var key = 'bonRoute_' + year;
    var c = S.getObject('compteurs');
    var next = (parseInt(c[key], 10) || 0) + 1;
    return NUMERO_PREFIX + '-' + year + '-' + String(next).padStart(4, '0');
  }

  function _incrementCompteur() {
    var year = new Date().getFullYear();
    var key = 'bonRoute_' + year;
    var c = S.getObject('compteurs');
    c[key] = (parseInt(c[key], 10) || 0) + 1;
    S.setObject('compteurs', c);
    return c[key];
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 4 — RENDU LISTE
     ═══════════════════════════════════════════════════════════ */

  Rt.render = function () {
    var container = document.getElementById('bonsRouteList');
    if (!container) return;

    var list = Rt.getFiltered();
    var total = list.length;

    if (total === 0) {
      container.innerHTML = '<div class="empty-state">Aucun bon route' +
        (_searchTerm || _filterType !== 'all' || _filterStatut !== 'all' ||
          _filterDest !== 'all' ? ' pour ce filtre' : '') +
        '. Clique sur "+ Nouveau bon route" pour commencer.</div>';
      U.setText('bonsRouteCount', '0');
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
      html += Rt.renderRow(slice[i]);
    }
    container.innerHTML = html;

    U.setText('bonsRouteCount', String(total));
    _updatePagination(_page, maxPage, total);
  };

  function _updatePagination(page, maxPage, total) {
    var pag = document.getElementById('bonsRoutePagination');
    if (!pag) return;
    pag.style.display = (total > 0) ? 'flex' : 'none';
    U.setText('bonsRoutePageInfo', total > 0
      ? 'Page ' + (page + 1) + ' / ' + (maxPage + 1) + ' — ' + total + ' bon(s)'
      : '0 bon');
    var prev = document.getElementById('bonsRoutePrevBtn');
    if (prev) prev.disabled = (page <= 0);
    var next = document.getElementById('bonsRouteNextBtn');
    if (next) next.disabled = (page >= maxPage);
  }

  Rt.renderRow = function (bon) {
    if (!bon) return '';

    var id = U.escapeAttr(bon.id);
    var numero = U.escapeHtml(bon.numero || '—');
    var typeLabel = U.escapeHtml(Rt.getTypeLabel(bon.type));
    var statutLabel = U.escapeHtml(Rt.getStatutLabel(bon.statut));
    var statutColor = Rt.getStatutColor(bon.statut);

    var destLabel = Rt.getDestinationLabel(bon.destination);
    var trajet = destLabel;
    if (bon.adressePrecise) trajet += ' — ' + bon.adressePrecise;

    var metaParts = [];
    if (bon.vehicule) metaParts.push('🚐 ' + U.escapeHtml(bon.vehicule));
    if (bon.chauffeur) metaParts.push('👤 ' + U.escapeHtml(bon.chauffeur));
    var dateStr = bon.dateCreation ? U.escapeHtml(U.formatDate(bon.dateCreation)) : '';
    if (bon.dateDepart) dateStr += ' → ' + U.escapeHtml(U.formatDate(bon.dateDepart));
    if (bon.dateRetour) dateStr += ' → ' + U.escapeHtml(U.formatDate(bon.dateRetour));
    if (dateStr) metaParts.push('📅 ' + dateStr);

    var km = Rt.computeKmParcourus(bon);
    var kmHtml = km > 0
      ? '<span class="bon-route-km" style="color:var(--text-light);' +
        'font-size:12px;margin-left:8px">📍 ' + km + ' km</span>'
      : '';

    var chantierHtml = '';
    if (bon.chantierId && Ch && typeof Ch.getNom === 'function') {
      var chNom = Ch.getNom(bon.chantierId);
      if (chNom) {
        chantierHtml = '<span class="bon-route-chantier" ' +
          'style="color:var(--text-light);font-size:12px;margin-left:8px">' +
          '🏗️ ' + U.escapeHtml(chNom) + '</span>';
      }
    }

    var contenuHtml = '';
    if (bon.type === 'sortie' && Array.isArray(bon.materiel) && bon.materiel.length > 0) {
      contenuHtml = '<span class="muted">📦 ' + bon.materiel.length + ' article(s)</span>';
    } else if (bon.type === 'commande' && Array.isArray(bon.documents) && bon.documents.length > 0) {
      contenuHtml = '<span class="muted">📄 ' + bon.documents.length + ' document(s)</span>';
    }

    return '<div class="bon-route-row" data-bon-route-id="' + id + '">' +
      '<div class="bon-route-row-main">' +
        '<div class="bon-route-row-header">' +
          '<span class="doc-type-badge">' + typeLabel + '</span>' +
          ' <strong>' + numero + '</strong>' +
          ' <span class="badge" style="background:' + statutColor + ';color:#fff">' +
          statutLabel + '</span>' + kmHtml + chantierHtml +
        '</div>' +
        '<div class="bon-route-row-meta">' +
          '📍 ' + U.escapeHtml(trajet) +
          (contenuHtml ? ' · ' + contenuHtml : '') +
        '</div>' +
        '<div class="bon-route-row-meta muted" style="font-size:11px">' +
          metaParts.join(' · ') +
        '</div>' +
      '</div>' +
      '<div class="bon-route-row-actions">' +
        '<button type="button" class="btn-icon" title="Détail" ' +
        'onclick="VC.Route.openDetail(\'' + id + '\')">👁️</button>' +
        '<button type="button" class="btn-icon" title="Éditer" ' +
        'onclick="VC.Route.openModal(\'' + id + '\')">✏️</button>' +
        '<button type="button" class="btn-icon" title="Imprimer" ' +
        'onclick="VC.Route.print(\'' + id + '\')">🖨️</button>' +
        '<button type="button" class="btn-icon btn-danger" title="Supprimer" ' +
        'onclick="VC.Route.remove(\'' + id + '\')">🗑️</button>' +
      '</div>' +
    '</div>';
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 5 — DÉTAIL
     ═══════════════════════════════════════════════════════════ */

  Rt.openDetail = function (id) {
    var bon = Rt.getById(id);
    if (!bon) {
      U.toast('Bon route introuvable.', 'error');
      return;
    }

    U.setText('bonRouteDetailTitle', 'Bon route ' + (bon.numero || ''));

    var html = '';

    /* Infos générales */
    html += '<div class="detail-section"><h3>Informations générales</h3>' +
      '<div class="detail-grid">';
    html += _detailItem('Numéro', bon.numero || '—');
    html += _detailItem('Type', Rt.getTypeLabel(bon.type));
    html += _detailItem('Statut', Rt.getStatutLabel(bon.statut));
    html += _detailItem('Date création',
      bon.dateCreation ? U.formatDate(bon.dateCreation) : '—');
    html += _detailItem('Date départ',
      bon.dateDepart ? U.formatDate(bon.dateDepart) : '—');
    html += _detailItem('Date retour',
      bon.dateRetour ? U.formatDate(bon.dateRetour) : '—');
    html += '</div></div>';

    /* Trajet */
    html += '<div class="detail-section"><h3>Trajet</h3><div class="detail-grid">';
    html += _detailItem('Destination', Rt.getDestinationLabel(bon.destination));
    if (bon.adressePrecise) {
      html += _detailItem('Adresse précise', bon.adressePrecise);
    }
    html += _detailItem('Véhicule', bon.vehicule || '—');
    html += _detailItem('Chauffeur', bon.chauffeur || '—');
    html += _detailItem('Km départ', String(bon.kmDepart || 0));
    html += _detailItem('Km retour', String(bon.kmRetour || 0));
    html += _detailItem('Km parcourus', String(Rt.computeKmParcourus(bon)));
    if (bon.chantierId && Ch && typeof Ch.getNom === 'function') {
      html += _detailItem('Chantier lié (info)', Ch.getNom(bon.chantierId) || '—');
    }
    html += '</div></div>';

    /* Matériel (type sortie) */
    if (bon.type === 'sortie' && Array.isArray(bon.materiel) && bon.materiel.length > 0) {
      html += '<div class="detail-section"><h3>Matériel sorti (' +
        bon.materiel.length + ')</h3>';
      html += '<table class="invoice-detail-table"><thead><tr>' +
        '<th>Désignation</th><th class="right">Qté</th>' +
        '<th>Unité</th><th>Observation</th></tr></thead><tbody>';
      for (var i = 0; i < bon.materiel.length; i++) {
        var m = bon.materiel[i];
        html += '<tr><td>' + U.escapeHtml(m.designation || '') + '</td>' +
          '<td class="right">' + U.escapeHtml(String(m.quantite || 0)) + '</td>' +
          '<td>' + U.escapeHtml(m.unite || 'U') + '</td>' +
          '<td>' + U.escapeHtml(m.observation || '') + '</td></tr>';
      }
      html += '</tbody></table></div>';
    }

    /* Documents (type commande) */
    if (bon.type === 'commande' && Array.isArray(bon.documents) && bon.documents.length > 0) {
      html += '<div class="detail-section"><h3>Documents commandés (' +
        bon.documents.length + ')</h3>';
      html += '<table class="invoice-detail-table"><thead><tr>' +
        '<th>Réf.</th><th>Désignation</th><th>Fournisseur</th>' +
        '<th class="right">Qté</th><th>Observation</th></tr></thead><tbody>';
      for (var j = 0; j < bon.documents.length; j++) {
        var d = bon.documents[j];
        html += '<tr><td>' + U.escapeHtml(d.reference || '') + '</td>' +
          '<td>' + U.escapeHtml(d.designation || '') + '</td>' +
          '<td>' + U.escapeHtml(d.fournisseur || '') + '</td>' +
          '<td class="right">' + U.escapeHtml(String(d.quantite || 0)) + '</td>' +
          '<td>' + U.escapeHtml(d.observation || '') + '</td></tr>';
      }
      html += '</tbody></table></div>';
    }

    /* Notes */
    if (bon.notes) {
      html += '<div class="detail-section"><h3>Notes</h3>' +
        '<p class="detail-notes">' +
        U.escapeHtml(bon.notes).replace(/\n/g, '<br>') + '</p></div>';
    }

    /* Actions */
    html += '<div class="detail-section detail-actions">' +
      '<button type="button" class="btn" onclick="VC.Route.closeDetail()">Fermer</button> ' +
      '<button type="button" class="btn btn-primary" ' +
      'onclick="VC.Route.closeDetail();VC.Route.openModal(\'' +
      U.escapeAttr(bon.id) + '\')">✏️ Éditer</button> ' +
      '<button type="button" class="btn" ' +
      'onclick="VC.Route.print(\'' + U.escapeAttr(bon.id) + '\')">🖨️ PDF</button>' +
      '</div>';

    var body = document.getElementById('bonRouteDetailBody');
    if (body) body.innerHTML = html;
    U.showFlex('bonRouteDetailModal');
  };

  Rt.closeDetail = function () {
    U.hide('bonRouteDetailModal');
  };

  function _detailItem(label, value) {
    return '<div class="detail-item">' +
      '<div class="detail-label">' + U.escapeHtml(label) + '</div>' +
      '<div class="detail-value">' + U.escapeHtml(String(value || '—')) + '</div>' +
      '</div>';
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 6 — FORMULAIRE
     ═══════════════════════════════════════════════════════════ */

  Rt.openModal = function (id) {
    _editId = id ? String(id) : null;
    _modalMateriel = [];
    _modalDocuments = [];

    U.setText('bonRouteFormError', '');

    _populateSelectType();
    _populateSelectStatut();
    _populateSelectDest();

    if (id) {
      var bon = Rt.getById(id);
      if (!bon) {
        U.toast('Bon route introuvable.', 'error');
        return;
      }
      U.setText('bonRouteModalTitle', 'Modifier bon route — ' + (bon.numero || ''));
      U.setVal('bonRouteId', bon.id);
      U.setVal('bonRouteNumero', bon.numero || '');
      U.setVal('bonRouteDateCreation', bon.dateCreation || '');
      U.setVal('bonRouteDateDepart', bon.dateDepart || '');
      U.setVal('bonRouteDateRetour', bon.dateRetour || '');
      U.setVal('bonRouteVehicule', bon.vehicule || '');
      U.setVal('bonRouteChauffeur', bon.chauffeur || '');
      U.setVal('bonRouteAdressePrecise', bon.adressePrecise || '');
      U.setVal('bonRouteKmDepart', bon.kmDepart || 0);
      U.setVal('bonRouteKmRetour', bon.kmRetour || 0);
      U.setVal('bonRouteNotes', bon.notes || '');
      U.setVal('bonRouteType', bon.type || 'sortie');
      U.setVal('bonRouteStatut', bon.statut || 'brouillon');
      U.setVal('bonRouteDestination', bon.destination || 'tunis');
      _populateChantiersSelect(bon.chantierId || '');

      _modalMateriel = Array.isArray(bon.materiel) ? bon.materiel.slice() : [];
      _modalDocuments = Array.isArray(bon.documents) ? bon.documents.slice() : [];
    } else {
      U.setText('bonRouteModalTitle', 'Nouveau bon route');
      U.setVal('bonRouteId', '');
      U.setVal('bonRouteNumero', _genererNumero());
      U.setVal('bonRouteDateCreation', U.todayISO());
      U.setVal('bonRouteDateDepart', '');
      U.setVal('bonRouteDateRetour', '');
      U.setVal('bonRouteVehicule', '');
      U.setVal('bonRouteChauffeur', '');
      U.setVal('bonRouteAdressePrecise', '');
      U.setVal('bonRouteKmDepart', 0);
      U.setVal('bonRouteKmRetour', 0);
      U.setVal('bonRouteNotes', '');
      U.setVal('bonRouteType', 'sortie');
      U.setVal('bonRouteStatut', 'brouillon');
      U.setVal('bonRouteDestination', 'tunis');
      _populateChantiersSelect('');
    }

    _toggleTypeSections(U.getVal('bonRouteType') || 'sortie');
    _renderMaterielTable();
    _renderDocTable();

    U.showFlex('bonRouteModal');

    setTimeout(function () {
      try {
        var el = document.getElementById('bonRouteVehicule');
        if (el) el.focus();
      } catch (e) {
        VC.logError('16-route', 'openModal focus échoué', e);
      }
    }, 100);
  };

  Rt.closeModal = function () {
    U.hide('bonRouteModal');
    _editId = null;
    _modalMateriel = [];
    _modalDocuments = [];
  };

  function _populateSelectType() {
    var sel = document.getElementById('bonRouteType');
    if (!sel) return;
    var html = '';
    var keys = ['sortie', 'commande', 'deplacement'];
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      html += '<option value="' + k + '">' +
        U.escapeHtml(TYPES[k].icon + ' ' + TYPES[k].label) + '</option>';
    }
    sel.innerHTML = html;
  }

  function _populateSelectStatut() {
    var sel = document.getElementById('bonRouteStatut');
    if (!sel) return;
    var html = '';
    var keys = ['brouillon', 'envoye', 'recu', 'retourne', 'archive'];
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      html += '<option value="' + k + '">' +
        U.escapeHtml(STATUTS[k].icon + ' ' + STATUTS[k].label) + '</option>';
    }
    sel.innerHTML = html;
  }

  function _populateSelectDest() {
    var sel = document.getElementById('bonRouteDestination');
    if (!sel) return;
    var html = '';
    var keys = Object.keys(DESTINATIONS);
    for (var i = 0; i < keys.length; i++) {
      html += '<option value="' + keys[i] + '">' +
        U.escapeHtml(DESTINATIONS[keys[i]]) + '</option>';
    }
    sel.innerHTML = html;
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
    U.populateSelect('bonRouteChantierSelect', items, 'nom', 'id', selectedId || '');
  }

  function _toggleTypeSections(type) {
    var t = String(type || 'sortie').toLowerCase();
    var matSec = document.getElementById('bonRouteMaterielSection');
    var docSec = document.getElementById('bonRouteDocSection');
    if (matSec) matSec.style.display = (t === 'sortie') ? '' : 'none';
    if (docSec) docSec.style.display = (t === 'commande') ? '' : 'none';
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 7 — TABLES DYNAMIQUES (matériel / documents)
     ═══════════════════════════════════════════════════════════ */

  Rt.addMaterielLine = function () {
    _modalMateriel.push({ designation: '', quantite: 1, unite: 'U', observation: '' });
    _renderMaterielTable();
  };

  Rt.removeMaterielLine = function (index) {
    if (index < 0 || index >= _modalMateriel.length) return;
    _modalMateriel.splice(index, 1);
    _renderMaterielTable();
  };

  Rt.updateMaterielLine = function (index, field, value) {
    var m = _modalMateriel[index];
    if (!m) return;
    if (field === 'quantite') {
      var q = U.parseNumber(value);
      if (q < 0) q = 0;
      if (q > MAX_QTY) q = MAX_QTY;
      m[field] = q;
    } else {
      m[field] = String(value || '').slice(0, 200);
    }
  };

  function _renderMaterielTable() {
    var tbody = document.getElementById('bonRouteMaterielBody');
    if (!tbody) return;

    var html = '';
    for (var i = 0; i < _modalMateriel.length; i++) {
      var m = _modalMateriel[i] || {};
      html += '<tr>' +
        '<td><input type="text" value="' + U.escapeAttr(m.designation || '') + '" ' +
        'oninput="VC.Route.updateMaterielLine(' + i + ', \'designation\', this.value)" ' +
        'placeholder="Désignation"></td>' +
        '<td class="col-qte"><input type="number" min="0" step="0.01" value="' +
        U.escapeAttr(m.quantite || '') + '" ' +
        'oninput="VC.Route.updateMaterielLine(' + i + ', \'quantite\', this.value)"></td>' +
        '<td class="col-unite"><input type="text" value="' +
        U.escapeAttr(m.unite || 'U') + '" ' +
        'oninput="VC.Route.updateMaterielLine(' + i + ', \'unite\', this.value)"></td>' +
        '<td><input type="text" value="' + U.escapeAttr(m.observation || '') + '" ' +
        'oninput="VC.Route.updateMaterielLine(' + i + ', \'observation\', this.value)" ' +
        'placeholder="Observation"></td>' +
        '<td class="col-action"><button type="button" class="btn-icon btn-danger" ' +
        'onclick="VC.Route.removeMaterielLine(' + i + ')">🗑️</button></td>' +
        '</tr>';
    }
    if (_modalMateriel.length === 0) {
      html = '<tr><td colspan="5" class="empty-items">Aucune ligne.</td></tr>';
    }
    tbody.innerHTML = html;
  }

  Rt.addDocLine = function () {
    _modalDocuments.push({
      reference: '', designation: '', fournisseur: '', quantite: 1, observation: ''
    });
    _renderDocTable();
  };

  Rt.removeDocLine = function (index) {
    if (index < 0 || index >= _modalDocuments.length) return;
    _modalDocuments.splice(index, 1);
    _renderDocTable();
  };

  Rt.updateDocLine = function (index, field, value) {
    var d = _modalDocuments[index];
    if (!d) return;
    if (field === 'quantite') {
      var q = U.parseNumber(value);
      if (q < 0) q = 0;
      if (q > MAX_QTY) q = MAX_QTY;
      d[field] = q;
    } else {
      var maxLen = (field === 'reference') ? 80
        : (field === 'fournisseur') ? 120 : 200;
      d[field] = String(value || '').slice(0, maxLen);
    }
  };

  function _renderDocTable() {
    var tbody = document.getElementById('bonRouteDocBody');
    if (!tbody) return;

    var html = '';
    for (var i = 0; i < _modalDocuments.length; i++) {
      var d = _modalDocuments[i] || {};
      html += '<tr>' +
        '<td><input type="text" value="' + U.escapeAttr(d.reference || '') + '" ' +
        'oninput="VC.Route.updateDocLine(' + i + ', \'reference\', this.value)" ' +
        'placeholder="Réf."></td>' +
        '<td><input type="text" value="' + U.escapeAttr(d.designation || '') + '" ' +
        'oninput="VC.Route.updateDocLine(' + i + ', \'designation\', this.value)" ' +
        'placeholder="Désignation"></td>' +
        '<td><input type="text" value="' + U.escapeAttr(d.fournisseur || '') + '" ' +
        'oninput="VC.Route.updateDocLine(' + i + ', \'fournisseur\', this.value)" ' +
        'placeholder="Fournisseur"></td>' +
        '<td class="col-qte"><input type="number" min="0" step="0.01" value="' +
        U.escapeAttr(d.quantite || '') + '" ' +
        'oninput="VC.Route.updateDocLine(' + i + ', \'quantite\', this.value)"></td>' +
        '<td><input type="text" value="' + U.escapeAttr(d.observation || '') + '" ' +
        'oninput="VC.Route.updateDocLine(' + i + ', \'observation\', this.value)" ' +
        'placeholder="Observation"></td>' +
        '<td class="col-action"><button type="button" class="btn-icon btn-danger" ' +
        'onclick="VC.Route.removeDocLine(' + i + ')">🗑️</button></td>' +
        '</tr>';
    }
    if (_modalDocuments.length === 0) {
      html = '<tr><td colspan="6" class="empty-items">Aucune ligne.</td></tr>';
    }
    tbody.innerHTML = html;
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 8 — SAUVEGARDE
     ═══════════════════════════════════════════════════════════ */

  Rt.save = function () {
    var errEl = document.getElementById('bonRouteFormError');
    if (errEl) errEl.textContent = '';

    var id = U.getVal('bonRouteId');
    var numero = U.getVal('bonRouteNumero');
    var type = U.getVal('bonRouteType') || 'sortie';
    var statut = U.getVal('bonRouteStatut') || 'brouillon';
    var dateCreation = U.getVal('bonRouteDateCreation');
    var dateDepart = U.getVal('bonRouteDateDepart');
    var dateRetour = U.getVal('bonRouteDateRetour');
    var vehicule = U.getVal('bonRouteVehicule');
    var chauffeur = U.getVal('bonRouteChauffeur');
    var destination = U.getVal('bonRouteDestination') || 'tunis';
    var adressePrecise = U.getVal('bonRouteAdressePrecise');
    var chantierId = U.getVal('bonRouteChantierSelect');
    var kmDepart = U.getVal('bonRouteKmDepart');
    var kmRetour = U.getVal('bonRouteKmRetour');
    var notes = U.getVal('bonRouteNotes');

    if (!numero) {
      if (errEl) errEl.textContent = 'Numéro requis.';
      return;
    }
    if (!vehicule) {
      if (errEl) errEl.textContent = 'Véhicule requis.';
      return;
    }
    if (!U.isValidDateString(dateCreation)) {
      if (errEl) errEl.textContent = 'Date de création invalide.';
      return;
    }
    if (dateDepart && !U.isValidDateString(dateDepart)) {
      if (errEl) errEl.textContent = 'Date de départ invalide.';
      return;
    }
    if (dateRetour && !U.isValidDateString(dateRetour)) {
      if (errEl) errEl.textContent = 'Date de retour invalide.';
      return;
    }
    if (dateDepart && dateRetour && dateRetour < dateDepart) {
      if (errEl) errEl.textContent = 'Date retour < date départ.';
      return;
    }
    if (Rt.numeroExists(numero, id)) {
      if (errEl) errEl.textContent = 'Numéro déjà utilisé : ' + numero;
      return;
    }

    /* Filtrer les lignes vides */
    var finalMateriel = [];
    for (var i = 0; i < _modalMateriel.length; i++) {
      var m = _modalMateriel[i];
      if (!m || !String(m.designation || '').trim()) continue;
      finalMateriel.push({
        designation: String(m.designation).trim().slice(0, 200),
        quantite: U.parseNumber(m.quantite),
        unite: String(m.unite || 'U').slice(0, 20),
        observation: String(m.observation || '').slice(0, 300)
      });
    }

    var finalDocs = [];
    for (var j = 0; j < _modalDocuments.length; j++) {
      var d = _modalDocuments[j];
      if (!d || !String(d.designation || '').trim()) continue;
      finalDocs.push({
        reference: String(d.reference || '').slice(0, 80),
        designation: String(d.designation).trim().slice(0, 200),
        fournisseur: String(d.fournisseur || '').slice(0, 120),
        quantite: U.parseNumber(d.quantite),
        observation: String(d.observation || '').slice(0, 300)
      });
    }

    var existing = id ? Rt.getById(id) : null;

    var raw = {
      id: id || undefined,
      numero: numero,
      type: type,
      statut: statut,
      dateCreation: dateCreation,
      dateDepart: dateDepart,
      dateRetour: dateRetour,
      vehicule: vehicule,
      chauffeur: chauffeur,
      destination: destination,
      adressePrecise: adressePrecise,
      chantierId: chantierId,
      kmDepart: kmDepart,
      kmRetour: kmRetour,
      materiel: finalMateriel,
      documents: finalDocs,
      notes: notes,
      createdAt: existing ? existing.createdAt : undefined
    };

    var saved = S.save('bonsRoute', raw);
    if (!saved) {
      if (errEl) errEl.textContent = 'Données invalides.';
      return;
    }

    /* Incrément compteur uniquement si nouveau */
    if (!id) _incrementCompteur();

    Rt.closeModal();
    U.toast(id ? 'Bon route modifié' : 'Bon route créé : ' + numero,
      'success', 2500);
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 9 — SUPPRESSION
     ═══════════════════════════════════════════════════════════ */

  Rt.remove = function (id) {
    var bon = Rt.getById(id);
    if (!bon) return;

    var msg = 'Supprimer le bon "' + (bon.numero || '') + '" ?';
    if (bon.statut && bon.statut !== 'brouillon') {
      msg = 'Le bon ' + (bon.numero || '') + ' est en statut « ' +
        Rt.getStatutLabel(bon.statut) + ' ».\n\nSupprimer quand même ?';
    }

    if (!U.confirm(msg)) return;

    if (!S.delete('bonsRoute', id)) {
      U.toast('Erreur suppression.', 'error');
      return;
    }

    U.toastUndo('Bon route supprimé : ' + (bon.numero || ''),
      function () { _restore(id); }, 5000);
  };

  function _restore(id) {
    var entries = S.getTrashEntries('bonsRoute');
    for (var i = 0; i < entries.length; i++) {
      if (entries[i].item && String(entries[i].item.id) === String(id)) {
        S.restoreFromTrash('bonsRoute', i);
        U.toast('Bon route restauré', 'success', 2000);
        return;
      }
    }
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 10 — FILTRES
     ═══════════════════════════════════════════════════════════ */

  Rt.setSearch = function (term) {
    _searchTerm = String(term || '');
    _page = 0;
    Rt.render();
  };

  Rt.setFilterType = function (type) {
    _filterType = String(type || 'all');
    _page = 0;
    Rt.render();
  };

  Rt.setFilterStatut = function (statut) {
    _filterStatut = String(statut || 'all');
    _page = 0;
    Rt.render();
  };

  Rt.setFilterDest = function (dest) {
    _filterDest = String(dest || 'all');
    _page = 0;
    Rt.render();
  };

  Rt.setPage = function (p) {
    _page = Math.max(0, parseInt(p, 10) || 0);
    Rt.render();
  };

  Rt.getFiltered = function () {
    var out = S.getAll('bonsRoute').slice();

    if (_searchTerm) {
      var term = U.normalizeText(_searchTerm);
      out = out.filter(function (b) {
        if (!b) return false;
        var hay = U.normalizeText([
          b.numero, b.vehicule, b.chauffeur, b.adressePrecise, b.notes,
          DESTINATIONS[b.destination] || ''
        ].join(' '));
        if (hay.indexOf(term) >= 0) return true;

        if (Array.isArray(b.materiel)) {
          for (var i = 0; i < b.materiel.length; i++) {
            var m = b.materiel[i];
            if (!m) continue;
            if (U.normalizeText(m.designation || '').indexOf(term) >= 0) return true;
          }
        }
        if (Array.isArray(b.documents)) {
          for (var j = 0; j < b.documents.length; j++) {
            var d = b.documents[j];
            if (!d) continue;
            if (U.normalizeText(d.reference || '').indexOf(term) >= 0) return true;
            if (U.normalizeText(d.designation || '').indexOf(term) >= 0) return true;
            if (U.normalizeText(d.fournisseur || '').indexOf(term) >= 0) return true;
          }
        }
        return false;
      });
    }

    if (_filterType !== 'all') {
      out = out.filter(function (b) { return b && b.type === _filterType; });
    }
    if (_filterStatut !== 'all') {
      out = out.filter(function (b) { return b && b.statut === _filterStatut; });
    }
    if (_filterDest !== 'all') {
      out = out.filter(function (b) { return b && b.destination === _filterDest; });
    }

    out.sort(function (a, b) {
      var da = String((a && a.dateCreation) || '');
      var db = String((b && b.dateCreation) || '');
      if (da === db) {
        var na = String((a && a.numero) || '');
        var nb = String((b && b.numero) || '');
        return na < nb ? 1 : (na > nb ? -1 : 0);
      }
      return da < db ? 1 : -1;
    });

    return out;
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 11 — IMPORT / EXPORT
     ═══════════════════════════════════════════════════════════ */

  Rt.exportJSON = function () {
    var arr = S.getAll('bonsRoute');
    var data = {
      version: 1,
      exportedAt: new Date().toISOString(),
      count: arr.length,
      bonsRoute: arr
    };
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    U.downloadBlob(blob, 'voltcore-bons-route-' + U.todayISO() + '.json');
    U.toast(arr.length + ' bon(s) route exporté(s)', 'success');
  };

  Rt.exportCSV = function () {
    var arr = S.getAll('bonsRoute');
    var lines = [];
    lines.push([
      'Numéro', 'Type', 'Statut', 'Date création', 'Date départ',
      'Date retour', 'Véhicule', 'Chauffeur', 'Destination',
      'Adresse précise', 'Km départ', 'Km retour', 'Km parcourus',
      'Chantier', 'Notes'
    ].join('\t'));

    for (var i = 0; i < arr.length; i++) {
      var b = arr[i];
      if (!b) continue;
      var chNom = b.chantierId && Ch ? Ch.getNom(b.chantierId) : '';
      lines.push([
        _csv(b.numero),
        _csv(Rt.getTypeLabel(b.type)),
        _csv(Rt.getStatutLabel(b.statut)),
        _csv(b.dateCreation || ''),
        _csv(b.dateDepart || ''),
        _csv(b.dateRetour || ''),
        _csv(b.vehicule || ''),
        _csv(b.chauffeur || ''),
        _csv(DESTINATIONS[b.destination] || ''),
        _csv(b.adressePrecise || ''),
        String(b.kmDepart || 0),
        String(b.kmRetour || 0),
        String(Rt.computeKmParcourus(b)),
        _csv(chNom),
        _csv(b.notes || '')
      ].join('\t'));
    }

    var csv = '\uFEFF' + lines.join('\r\n');
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    U.downloadBlob(blob, 'voltcore-bons-route-' + U.todayISO() + '.csv');
    U.toast('CSV exporté', 'success');
  };

  function _csv(v) {
    return String(v == null ? '' : v).replace(/\t/g, ' ').replace(/\r?\n/g, ' ');
  }

  Rt.importJSON = function (file) {
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
            : (parsed && Array.isArray(parsed.bonsRoute)) ? parsed.bonsRoute
            : (parsed && Array.isArray(parsed.data)) ? parsed.data : null;

          if (!arr) {
            reject(new Error('Format invalide : bonsRoute[] attendu'));
            return;
          }

          var added = 0, skipped = 0, invalid = 0;
          for (var i = 0; i < arr.length; i++) {
            var clean = S.normalize('bonsRoute', arr[i]);
            if (!clean) { invalid++; continue; }
            if (Rt.numeroExists(clean.numero, clean.id)) { skipped++; continue; }
            if (Rt.getById(clean.id)) { skipped++; continue; }
            if (S.save('bonsRoute', clean)) added++;
            else invalid++;
          }

          var msg = added + ' bon(s) route importé(s)';
          if (skipped > 0) msg += ' · ' + skipped + ' doublon(s)';
          if (invalid > 0) msg += ' · ' + invalid + ' invalide(s)';
          U.toast(msg, added > 0 ? 'success' : 'warning', 4000);

          resolve({ added: added, skipped: skipped, invalid: invalid });
        } catch (err) {
          VC.logError('16-route', 'importJSON parse échoué', err);
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
     SECTION 12 — IMPRESSION PDF
     ═══════════════════════════════════════════════════════════ */

  Rt.print = function (bonId) {
    var bon = Rt.getById(bonId);
    if (!bon) {
      U.toast('Bon route introuvable.', 'error');
      return;
    }

    _loadImages().then(function (images) {
      var html = Rt.buildHTML(bon, images);
      _openPrintWindow(html);
    }).catch(function (e) {
      VC.logError('16-route', 'print chargement images échoué', e);
      var html = Rt.buildHTML(bon, {});
      _openPrintWindow(html);
    });
  };

  function _loadImages() {
    var result = { signatureDataUrl: null, cachetDataUrl: null };
    var promises = [];

    try {
      var sigRaw = localStorage.getItem('voltcore_signature_default');
      var cacRaw = localStorage.getItem('voltcore_cachet_default');
      var sigMeta = sigRaw ? JSON.parse(sigRaw) : null;
      var cacMeta = cacRaw ? JSON.parse(cacRaw) : null;

      if (sigMeta && sigMeta.ref && IDB && IDB.blobs) {
        promises.push(IDB.blobs.get(sigMeta.ref).then(function (row) {
          if (row && row.data) {
            return IDB.blobToDataURL(row.data).then(function (d) {
              result.signatureDataUrl = d;
            });
          }
        }).catch(function (e) {
          VC.logError('16-route', 'load signature échoué', e);
        }));
      }

      if (cacMeta && cacMeta.ref && IDB && IDB.blobs) {
        promises.push(IDB.blobs.get(cacMeta.ref).then(function (row) {
          if (row && row.data) {
            return IDB.blobToDataURL(row.data).then(function (d) {
              result.cachetDataUrl = d;
            });
          }
        }).catch(function (e) {
          VC.logError('16-route', 'load cachet échoué', e);
        }));
      }
    } catch (e) {
      VC.logError('16-route', 'loadImages sync échoué', e);
    }

    return Promise.all(promises).then(function () { return result; });
  }

  Rt.buildHTML = function (bon, opts) {
    if (!bon) return '';

    var images = opts || {};
    var t = TYPES[bon.type] || TYPES.sortie;
    var destLabel = DESTINATIONS[bon.destination] || 'Autre';
    var statutLabel = Rt.getStatutLabel(bon.statut);
    var kmParcourus = Rt.computeKmParcourus(bon);
    var titre = String(t.label || 'Bon route').toUpperCase() +
      ' N° ' + (bon.numero || '—');

    var chantierNom = '';
    if (bon.chantierId && Ch && typeof Ch.getNom === 'function') {
      chantierNom = Ch.getNom(bon.chantierId) || '';
    }

    var lignesHtml = '';
    if (bon.type === 'sortie' && Array.isArray(bon.materiel)) {
      for (var i = 0; i < bon.materiel.length; i++) {
        var m = bon.materiel[i];
        if (!m) continue;
        lignesHtml += '<tr>' +
          '<td>' + U.escapeHtml(m.designation || '') + '</td>' +
          '<td class="text-center">' + U.escapeHtml(String(m.quantite || 0)) + '</td>' +
          '<td class="text-center">' + U.escapeHtml(m.unite || 'U') + '</td>' +
          '<td>' + U.escapeHtml(m.observation || '') + '</td>' +
          '</tr>';
      }
      if (!lignesHtml) {
        lignesHtml = '<tr><td colspan="4" style="text-align:center;color:#999;padding:16px">(Aucun matériel listé)</td></tr>';
      }
    } else if (bon.type === 'commande' && Array.isArray(bon.documents)) {
      for (var j = 0; j < bon.documents.length; j++) {
        var d = bon.documents[j];
        if (!d) continue;
        lignesHtml += '<tr>' +
          '<td>' + U.escapeHtml(d.reference || '') + '</td>' +
          '<td>' + U.escapeHtml(d.designation || '') + '</td>' +
          '<td>' + U.escapeHtml(d.fournisseur || '') + '</td>' +
          '<td class="text-center">' + U.escapeHtml(String(d.quantite || 0)) + '</td>' +
          '<td>' + U.escapeHtml(d.observation || '') + '</td>' +
          '</tr>';
      }
      if (!lignesHtml) {
        lignesHtml = '<tr><td colspan="5" style="text-align:center;color:#999;padding:16px">(Aucun document listé)</td></tr>';
      }
    }

    var tableauHtml = '';
    if (bon.type === 'sortie') {
      tableauHtml = '<table class="items"><thead><tr>' +
        '<th style="text-align:left;width:50%">Désignation</th>' +
        '<th style="text-align:center;width:12%">Qté</th>' +
        '<th style="text-align:center;width:10%">Unité</th>' +
        '<th style="text-align:left;width:28%">Observation</th>' +
        '</tr></thead><tbody>' + lignesHtml + '</tbody></table>';
    } else if (bon.type === 'commande') {
      tableauHtml = '<table class="items"><thead><tr>' +
        '<th style="text-align:left;width:14%">Réf.</th>' +
        '<th style="text-align:left;width:30%">Désignation</th>' +
        '<th style="text-align:left;width:20%">Fournisseur</th>' +
        '<th style="text-align:center;width:10%">Qté</th>' +
        '<th style="text-align:left;width:26%">Observation</th>' +
        '</tr></thead><tbody>' + lignesHtml + '</tbody></table>';
    }

    /* Bloc trajet */
    var trajetHtml = '<div class="info-box">';
    trajetHtml += '<div class="info-row"><span class="info-label">Véhicule</span>' +
      '<span class="info-value">' + U.escapeHtml(bon.vehicule || '—') + '</span></div>';
    trajetHtml += '<div class="info-row"><span class="info-label">Chauffeur</span>' +
      '<span class="info-value">' + U.escapeHtml(bon.chauffeur || '—') + '</span></div>';
    trajetHtml += '<div class="info-row"><span class="info-label">Destination</span>' +
      '<span class="info-value">' + U.escapeHtml(destLabel) +
      (bon.adressePrecise ? ' — ' + U.escapeHtml(bon.adressePrecise) : '') +
      '</span></div>';
    if (chantierNom) {
      trajetHtml += '<div class="info-row"><span class="info-label">Chantier lié</span>' +
        '<span class="info-value">' + U.escapeHtml(chantierNom) + '</span></div>';
    }
    trajetHtml += '<div class="info-row"><span class="info-label">Date départ</span>' +
      '<span class="info-value">' +
      (bon.dateDepart ? U.escapeHtml(U.formatDate(bon.dateDepart)) : '—') +
      '</span></div>';
    trajetHtml += '<div class="info-row"><span class="info-label">Date retour</span>' +
      '<span class="info-value">' +
      (bon.dateRetour ? U.escapeHtml(U.formatDate(bon.dateRetour)) : '—') +
      '</span></div>';
    trajetHtml += '<div class="info-row"><span class="info-label">Kilométrage</span>' +
      '<span class="info-value">Départ : ' + U.escapeHtml(String(bon.kmDepart || 0)) +
      ' km · Retour : ' + U.escapeHtml(String(bon.kmRetour || 0)) +
      ' km · Parcourus : <strong>' + kmParcourus + ' km</strong></span></div>';
    trajetHtml += '</div>';

    var notesHtml = '';
    if (bon.notes) {
      notesHtml = '<div class="observation"><strong>Notes :</strong> ' +
        U.escapeHtml(bon.notes).replace(/\n/g, '<br>') + '</div>';
    }

    /* Logo */
    var logo = '';
    try {
      logo = localStorage.getItem('voltcore_logo') || '';
    } catch (e) {
      VC.logError('16-route', 'lecture logo échouée', e);
    }

    var logoHtml;
    if (logo) {
      logoHtml = '<img src="' + U.escapeAttr(logo) +
        '" style="max-height:60px;max-width:200px" alt="Logo">';
    } else {
      logoHtml = '<div class="logo-text">' +
        '<h1>VOLT<span>CORE</span></h1>' +
        '<div class="sub">INGÉNIERIE · ÉLECTRICITÉ · BÂTIMENT</div>' +
        '<div class="logo-underline"><div class="gold"></div><div class="red"></div></div>' +
        '</div>';
    }

    /* Assemblage */
    var html = '<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8">' +
      '<title>' + U.escapeHtml(titre) + '</title><style>';
    html += '@page{size:A4;margin:15mm}';
    html += '*{margin:0;padding:0;box-sizing:border-box}';
    html += 'body{font-family:\'Calibri\',\'Segoe UI\',Arial,sans-serif;' +
      'background:#fff;padding:10px;font-size:11px;color:#1A2B4C;' +
      '-webkit-print-color-adjust:exact;print-color-adjust:exact}';
    html += '.wrapper{max-width:950px;margin:0 auto;padding:20px 28px}';
    html += '.header{display:flex;justify-content:space-between;align-items:center;' +
      'border-bottom:2px solid #C9A84C;padding-bottom:16px;margin-bottom:16px;' +
      'flex-wrap:wrap;gap:10px}';
    html += '.logo-text h1{font-size:34px;font-weight:900;color:#1A2B4C;' +
      'letter-spacing:1.5px;line-height:1;margin-bottom:4px}';
    html += '.logo-text h1 span{color:#E70013}';
    html += '.logo-text .sub{font-size:10px;color:#C9A84C;letter-spacing:3px;' +
      'font-weight:700;text-transform:uppercase;margin-bottom:6px}';
    html += '.logo-underline{display:flex;height:3px;width:100%}';
    html += '.logo-underline .gold{width:65%;background:#C9A84C}';
    html += '.logo-underline .red{width:35%;background:#E70013}';
    html += '.company-info{text-align:right;font-size:10px;line-height:1.6;color:#2c3e66}';
    html += '.company-info strong{color:#1A2B4C}';
    html += '.title{text-align:center;font-size:22px;font-weight:700;color:#E70013;' +
      'margin:4px 0 16px;letter-spacing:1px}';
    html += '.meta-box{background:#F9FAFE;padding:12px 18px;border-radius:10px;' +
      'border-left:4px solid #C9A84C;display:flex;justify-content:space-between;' +
      'flex-wrap:wrap;gap:15px;margin-bottom:16px;font-size:11px;line-height:1.5}';
    html += '.meta-box strong{color:#1A2B4C}';
    html += '.info-box{background:#FEFCF5;border:1px solid #F0E5D0;border-radius:8px;' +
      'padding:12px 16px;margin-bottom:16px;font-size:11px}';
    html += '.info-row{display:flex;padding:4px 0;border-bottom:1px dashed #F0E5D0}';
    html += '.info-row:last-child{border-bottom:none}';
    html += '.info-label{width:35%;font-weight:600;color:#666;text-transform:uppercase;' +
      'font-size:9px;letter-spacing:0.5px;padding-top:2px}';
    html += '.info-value{width:65%;color:#1A2B4C}';
    html += 'table.items{width:100%;border-collapse:collapse;margin:12px 0;font-size:11px}';
    html += 'table.items th{background:#1A2B4C;color:#fff;padding:10px 8px;' +
      'font-weight:600;letter-spacing:0.5px}';
    html += 'table.items td{padding:8px;border-bottom:1px solid #e0e4e9;vertical-align:middle}';
    html += 'table.items tr:nth-child(even) td{background:#F9FAFE}';
    html += '.text-center{text-align:center}';
    html += '.observation{background:#f8f9fa;padding:10px 16px;border-radius:8px;' +
      'font-size:10px;color:#444;border-left:3px solid #C9A84C;margin:12px 0 16px}';
    html += '.footer{border-top:1px solid #ddd;padding-top:12px;margin-top:16px;' +
      'font-size:8px;text-align:center;color:#555;line-height:1.6}';
    html += '.footer strong{color:#1A2B4C}';
    html += '.signature-area{display:flex;justify-content:space-between;' +
      'margin-top:30px;font-size:10px}';
    html += '.signature-area div{width:38%;border-top:1px solid #999;' +
      'padding-top:8px;text-align:center;color:#1A2B4C;font-weight:600}';
    html += '@media print{body{padding:0}.wrapper{padding:0}}';
    html += '</style></head><body>';

    html += '<div class="wrapper">';

    html += '<div class="header">';
    html += '<div class="logo-title">' + logoHtml + '</div>';
    html += '<div class="company-info">';
    html += '<strong>VOLTCORE INGENIERIE</strong><br>';
    html += 'Route Soukra KM 3, Cité El Habib<br>';
    html += 'Sfax Ouest – 3052, Tunisie<br>';
    html += 'Tél : +216 51 176 186';
    html += '</div>';
    html += '</div>';

    html += '<div class="title">' + U.escapeHtml(titre) + '</div>';

    html += '<div class="meta-box">';
    html += '<div><strong>Type :</strong> ' + U.escapeHtml(t.label || '') + '<br>' +
      '<strong>Statut :</strong> ' + U.escapeHtml(statutLabel) + '</div>';
    html += '<div><strong>Date création :</strong> ' +
      (bon.dateCreation ? U.escapeHtml(U.formatDate(bon.dateCreation)) : '—') + '<br>' +
      '<strong>Numéro :</strong> ' + U.escapeHtml(bon.numero || '—') + '</div>';
    html += '</div>';

    html += trajetHtml;
    html += tableauHtml;
    html += notesHtml;

    html += '<div style="text-align:center;font-size:9px;color:#999;' +
      'margin-top:20px;font-style:italic">' +
      'Document interne de traçabilité — n\'a pas valeur de facture ' +
      'ni de bon de commande comptable.</div>';

    html += '<div class="footer">';
    html += '<div><strong>VOLTCORE INGENIERIE</strong></div>';
    html += '</div>';

    html += '<div class="signature-area">';
    if (images.cachetDataUrl) {
      html += '<div><img src="' + U.escapeAttr(images.cachetDataUrl) + '" ' +
        'style="max-height:60px;max-width:180px;display:block;margin:0 auto 4px;' +
        'mix-blend-mode:multiply" alt="Cachet">' +
        '<span style="font-size:8px;color:#666">Cachet VOLTCORE</span></div>';
    } else {
      html += '<div>Cachet & Signature VOLTCORE</div>';
    }
    if (images.signatureDataUrl) {
      html += '<div><img src="' + U.escapeAttr(images.signatureDataUrl) + '" ' +
        'style="max-height:60px;max-width:180px;display:block;margin:0 auto 4px;' +
        'mix-blend-mode:multiply" alt="Signature">' +
        '<span style="font-size:8px;color:#666">Signature chauffeur</span></div>';
    } else {
      html += '<div>Signature chauffeur</div>';
    }
    html += '</div>';

    html += '</div></body></html>';
    return html;
  };

  function _openPrintWindow(html) {
    var w = global.open('', '_blank');
    if (!w) {
      U.toast('Autorise les pop-ups pour imprimer.', 'warning', 4000);
      return;
    }
    try {
      w.document.open();
      w.document.write(html);
      w.document.close();
      setTimeout(function () {
        try { w.focus(); w.print(); } catch (e) {
          VC.logError('16-route', 'print focus échoué', e);
        }
      }, 400);
    } catch (e) {
      VC.logError('16-route', 'openPrintWindow échoué', e);
      U.toast('Erreur d\'impression.', 'error');
    }
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 13 — EVENTS
     ═══════════════════════════════════════════════════════════ */

  Rt.attachEvents = function () {
    U.on('bonsRouteSearchInput', 'input', U.debounce(function (ev) {
      Rt.setSearch(ev.target.value);
    }, 250));

    U.on('bonsRouteFilterType', 'change', function (ev) {
      Rt.setFilterType(ev.target.value);
    });

    U.on('bonsRouteFilterStatut', 'change', function (ev) {
      Rt.setFilterStatut(ev.target.value);
    });

    U.on('bonsRouteFilterDestination', 'change', function (ev) {
      Rt.setFilterDest(ev.target.value);
    });

    U.on('btnAddBonRoute', 'click', function () {
      Rt.openModal(null);
    });

    U.on('btnAddBonRouteMaterielLine', 'click', Rt.addMaterielLine);
    U.on('btnAddBonRouteDocLine', 'click', Rt.addDocLine);
    U.on('bonRouteSaveBtn', 'click', Rt.save);

    /* Toggle sections au change type */
    U.on('bonRouteType', 'change', function (ev) {
      _toggleTypeSections(ev.target.value);
    });

    U.on('btnImportBonsRoute', 'click', function () {
      var input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json,application/json';
      input.onchange = function (ev) {
        var f = ev.target.files && ev.target.files[0];
        if (!f) return;
        Rt.importJSON(f).catch(function (err) {
          U.toast('Import échoué : ' + (err.message || ''), 'error');
        });
      };
      input.click();
    });

    U.on('btnExportBonsRouteJSON', 'click', Rt.exportJSON);
    U.on('btnExportBonsRouteCSV', 'click', Rt.exportCSV);

    /* Subscribe : re-render auto */
    S.subscribe('bonsRoute', function () {
      Rt.render();
    });
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 14 — MARQUEUR
     ═══════════════════════════════════════════════════════════ */

  VC._routeLoaded = true;

  VC.logInfo('16-route', 'Module chargé (HORS COMPTABILITÉ strict)');

})(window);