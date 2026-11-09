/* ═══════════════════════════════════════════════════════════════
   VOLTCORE — 09-chantiers.js
   VERSION : v6.7 (Session #3 — fallback 30s, validation dates,
                   bump version)
   RÔLE : CRUD chantiers + marges B5 + mode actif + devis 1 clic +
          écart budget + import/export + impression + undo
   DÉPENDANCES : 01-core.js (savedChantiers, chantierActifId, trash,
                            currentUser), 03-utils.js (helpers),
                            04-storage.js (saveAll), 05-alerts.js
                            (computeChantierMarge)
   EXPOSE : getChantierById, getChantierNom, chantierExists,
            computeChantierStats, getActiveChantier,
            setActiveChantier, clearActiveChantier,
            renderActiveChantierBadge, renderChantiers,
            renderChantierRow, openChantierDetail, closeChantierDetail,
            openChantierModal, closeChantierModal, saveChantierFromForm,
            deleteChantier, createDevisFromChantier,
            createFactureFromChantier,
            setChantiersSearch, setChantiersFilter, getFilteredChantiers,
            exportChantiersJSON, exportChantiersCSV, importChantiersJSON,
            printChantiersList, printChantierRecap, attachChantiersEvents
   ═══════════════════════════════════════════════════════════════ */

/* ═══════════ SECTION 1 — ÉTAT + CONSTANTES ═══════════ */

var __chantiersSearchTerm = '';
var __chantiersFilter = 'all';

var CHANTIER_STATUTS = {
  planifie: 'Planifié',
  en_cours: 'En cours',
  termine: 'Terminé',
  annule: 'Annulé'
};

/* Pré-remplissage pour 11-invoices.js (lu à l'ouverture du formulaire) */
window.__pendingChantierPrefill = null;

/* ═══════════ SECTION 2 — HELPERS ═══════════ */

function getChantierById(id) {
  try {
    if (!id || !Array.isArray(savedChantiers)) return null;
    var sid = String(id);
    for (var i = 0; i < savedChantiers.length; i++) {
      if (savedChantiers[i] && String(savedChantiers[i].id) === sid) return savedChantiers[i];
    }
    return null;
  } catch (e) { console.warn('getChantierById :', e); return null; }
}

function getChantierNom(id) {
  var ch = getChantierById(id);
  return ch ? String(ch.nom || '') : '';
}

function chantierExists(nom, excludeId) {
  try {
    if (!nom || !Array.isArray(savedChantiers)) return false;
    var normalized = normalizeText(nom);
    for (var i = 0; i < savedChantiers.length; i++) {
      var ch = savedChantiers[i];
      if (!ch) continue;
      if (excludeId && String(ch.id) === String(excludeId)) continue;
      if (normalizeText(ch.nom || '') === normalized) return true;
    }
    return false;
  } catch (e) { return false; }
}

function _normalizeStatut(s) {
  var v = String(s || '').toLowerCase().trim();
  return CHANTIER_STATUTS[v] !== undefined ? v : 'en_cours';
}

function _getStatutLabel(statut) {
  return CHANTIER_STATUTS[statut] || CHANTIER_STATUTS.en_cours;
}

function _getStatutColor(statut) {
  if (statut === 'termine') return 'var(--success)';
  if (statut === 'annule') return 'var(--danger)';
  if (statut === 'planifie') return 'var(--info)';
  return 'var(--warning)';
}

function _normalizeChantier(raw) {
  if (!raw || typeof raw !== 'object') return null;
  var nom = String(raw.nom || raw.name || '').trim().replace(/\s+/g, ' ');
  if (!nom) return null;
  return {
    id: raw.id || ('ch_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)),
    nom: nom,
    clientId: String(raw.clientId || '').trim(),
    adresse: String(raw.adresse || '').trim(),
    dateDebut: String(raw.dateDebut || raw.date_debut || '').slice(0, 10),
    dateFin: String(raw.dateFin || raw.date_fin || '').slice(0, 10),
    budget: parseNumber(raw.budget),
    statut: _normalizeStatut(raw.statut),
    responsable: String(raw.responsable || '').trim(),
    notes: String(raw.notes || '').trim(),
    createdAt: raw.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

/* Peuple le <select id="chantierClientSelect"> avec les clients. */
function _populateClientsSelect(selectedId) {
  try {
    var sel = document.getElementById('chantierClientSelect');
    if (!sel) return;
    var html = '<option value="">— Aucun —</option>';
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
  } catch (e) { console.warn('_populateClientsSelect :', e); }
}

/* ═══════════ SECTION 3 — STATISTIQUES (B5) ═══════════ */

function computeChantierStats(chantierId) {
  var empty = {
    recettes: 0, achats: 0, frais: 0, rh: 0, marge: 0, margePct: 0,
    nbFactures: 0, budget: 0, ecartBudget: 0, partBudget: 0
  };
  try {
    var ch = getChantierById(chantierId);
    if (!ch) return empty;

    var m = (typeof computeChantierMarge === 'function')
      ? computeChantierMarge(chantierId)
      : { recettes: 0, achats: 0, frais: 0, rh: 0, marge: 0, margePct: 0, nbDocs: 0 };

    var budget = parseNumber(ch.budget);
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
  } catch (e) { console.warn('computeChantierStats :', e); return empty; }
}

/* ═══════════ SECTION 4 — MODE ACTIF ═══════════ */

function getActiveChantier() {
  try {
    return getChantierById(chantierActifId);
  } catch (e) { return null; }
}

function setActiveChantier(id) {
  try {
    var ch = getChantierById(id);
    if (!ch) {
      if (typeof showToast === 'function') showToast('Chantier introuvable.', 'error');
      return false;
    }
    chantierActifId = String(id);
    if (typeof saveAll === 'function') saveAll();
    if (typeof logAction === 'function') logAction('chantier.setActive', ch.nom);
    renderActiveChantierBadge();
    renderChantiers();
    if (typeof showToast === 'function') showToast('Chantier actif : ' + ch.nom, 'success');
    return true;
  } catch (e) { console.warn('setActiveChantier :', e); return false; }
}

function clearActiveChantier() {
  try {
    chantierActifId = null;
    if (typeof saveAll === 'function') saveAll();
    if (typeof logAction === 'function') logAction('chantier.clearActive', '');
    renderActiveChantierBadge();
    renderChantiers();
    if (typeof showToast === 'function') showToast('Aucun chantier actif.', 'info');
    return true;
  } catch (e) { console.warn('clearActiveChantier :', e); return false; }
}

function renderActiveChantierBadge() {
  try {
    var badge = document.getElementById('activeChantierBadge');
    if (!badge) return;
    var ch = getActiveChantier();
    if (ch) {
      badge.innerHTML = '🏗️ ' + escapeHtml(ch.nom) +
        ' <button type="button" class="btn-icon-mini" onclick="clearActiveChantier()" title="Désactiver">✕</button>';
      badge.style.display = 'inline-flex';
    } else {
      badge.innerHTML = '';
      badge.style.display = 'none';
    }
  } catch (e) {}
}

/* ═══════════ SECTION 5 — RENDU LISTE ═══════════ */

function renderChantiers() {
  try {
    var container = document.getElementById('chantiersList');
    if (!container) return;

    var list = getFilteredChantiers();
    if (list.length === 0) {
      container.innerHTML = '<div class="empty-state">Aucun chantier' +
        (__chantiersSearchTerm || __chantiersFilter !== 'all' ? ' pour ce filtre' : '') +
        '. Clique sur "+ Nouveau chantier" pour commencer.</div>';
      _updateChantiersCount(0);
      return;
    }

    var html = '';
    for (var i = 0; i < list.length; i++) html += renderChantierRow(list[i]);
    container.innerHTML = html;
    _updateChantiersCount(list.length);
  } catch (e) { console.warn('renderChantiers :', e); }
}

function renderChantierRow(ch) {
  try {
    if (!ch) return '';
    var id = escapeAttr(ch.id);
    var nom = escapeHtml(ch.nom || '(Sans nom)');
    var clientNom = ch.clientId ? escapeHtml(getClientName(ch.clientId)) : '<span class="muted">Sans client</span>';
    var isActive = chantierActifId && String(chantierActifId) === String(ch.id);

    var statut = _normalizeStatut(ch.statut);
    var statutLabel = _getStatutLabel(statut);
    var statutColor = _getStatutColor(statut);

    var stats = computeChantierStats(ch.id);
    var margeColor = stats.margePct >= 0.10 ? 'var(--success)'
                    : stats.margePct >= 0 ? 'var(--warning)'
                    : 'var(--danger)';

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
          ' <span class="badge" style="background:' + statutColor + ';color:#fff">' + escapeHtml(statutLabel) + '</span> ' +
          budgetBadge +
        '</div>' +
        '<div class="chantier-row-meta">' +
          clientNom +
          (ch.dateDebut ? ' · ' + escapeHtml(formatDate(ch.dateDebut)) : '') +
          (ch.dateFin ? ' → ' + escapeHtml(formatDate(ch.dateFin)) : '') +
        '</div>' +
        '<div class="chantier-row-marge" style="color:' + margeColor + '">' +
          'CA : ' + formatMoney(stats.recettes) +
          ' · Marge : ' + formatMoney(stats.marge) +
          ' (' + (stats.margePct * 100).toFixed(1) + '%)' +
        '</div>' +
      '</div>' +
      '<div class="chantier-row-actions">' +
        (isActive
          ? '<button type="button" class="btn-icon" title="Désactiver" onclick="clearActiveChantier()">⏹️</button>'
          : '<button type="button" class="btn-icon" title="Activer" onclick="setActiveChantier(\'' + id + '\')">▶️</button>') +
        '<button type="button" class="btn-icon" title="Détail" onclick="openChantierDetail(\'' + id + '\')">👁️</button>' +
        '<button type="button" class="btn-icon" title="Éditer" onclick="openChantierModal(\'' + id + '\')">✏️</button>' +
        '<button type="button" class="btn-icon" title="Devis" onclick="createDevisFromChantier(\'' + id + '\')">📝</button>' +
        '<button type="button" class="btn-icon btn-danger" title="Supprimer" onclick="deleteChantier(\'' + id + '\')">🗑️</button>' +
      '</div>' +
    '</div>';
  } catch (e) { console.warn('renderChantierRow :', e); return ''; }
}

function _updateChantiersCount(n) {
  try {
    var el = document.getElementById('chantiersCount');
    if (el) el.textContent = String(n);
  } catch (e) {}
}

/* ═══════════ SECTION 6 — RENDU DÉTAIL ═══════════ */

function openChantierDetail(id) {
  try {
    var ch = getChantierById(id);
    if (!ch) return;
    var modal = document.getElementById('chantierDetailModal');
    var body = document.getElementById('chantierDetailBody');
    var title = document.getElementById('chantierDetailTitle');
    if (!modal || !body) return;

    if (title) title.textContent = ch.nom || 'Chantier';

    var stats = computeChantierStats(id);
    var statut = _normalizeStatut(ch.statut);
    var statutColor = _getStatutColor(statut);

    var html = '';
    html += '<div class="detail-section"><h3>Informations</h3><div class="detail-grid">';
    html += _chDetailItem('Client', ch.clientId ? getClientName(ch.clientId) : '—');
    html += _chDetailItem('Statut', _getStatutLabel(statut));
    html += _chDetailItem('Responsable', ch.responsable || '—');
    html += _chDetailItem('Adresse', ch.adresse || '—');
    html += _chDetailItem('Date début', ch.dateDebut ? formatDate(ch.dateDebut) : '—');
    html += _chDetailItem('Date fin', ch.dateFin ? formatDate(ch.dateFin) : '—');
    html += '</div></div>';

    html += '<div class="detail-section"><h3>Marges (B5)</h3><div class="stats-grid">';
    html += _chStatItem('Recettes', formatMoney(stats.recettes));
    html += _chStatItem('Achats', formatMoney(stats.achats));
    html += _chStatItem('Frais', formatMoney(stats.frais));
    html += _chStatItem('RH', formatMoney(stats.rh));
    var margeColor = stats.margePct >= 0.10 ? 'var(--success)'
                    : stats.margePct >= 0 ? 'var(--warning)' : 'var(--danger)';
    html += _chStatItem('Marge', formatMoney(stats.marge), margeColor);
    html += _chStatItem('Marge %', (stats.margePct * 100).toFixed(1) + '%', margeColor);
    html += '</div></div>';

    if (stats.budget > 0) {
      var pct = stats.partBudget * 100;
      var bColor = pct > 110 ? 'var(--danger)' : pct > 90 ? 'var(--warning)' : 'var(--success)';
      html += '<div class="detail-section"><h3>Budget</h3>';
      html += '<div class="budget-bar"><div class="budget-fill" style="width:' +
        Math.min(100, pct) + '%;background:' + bColor + '"></div></div>';
      html += '<div class="budget-info">' +
        formatMoney(stats.recettes) + ' / ' + formatMoney(stats.budget) +
        ' (' + pct.toFixed(1) + '%) — reste ' + formatMoney(stats.ecartBudget) + '</div>';
      html += '</div>';
    }

    if (ch.notes) {
      html += '<div class="detail-section"><h3>Notes</h3><p class="detail-notes">' +
        escapeHtml(ch.notes).replace(/\n/g, '<br>') + '</p></div>';
    }

    html += '<div class="detail-section detail-actions">' +
      '<button type="button" class="btn btn-primary" onclick="createDevisFromChantier(\'' +
      escapeAttr(id) + '\')">📝 Créer un devis</button> ' +
      '<button type="button" class="btn" onclick="createFactureFromChantier(\'' +
      escapeAttr(id) + '\')">🧾 Créer une facture</button> ' +
      '<button type="button" class="btn" onclick="printChantierRecap(\'' +
      escapeAttr(id) + '\')">🖨️ Imprimer récap</button>' +
      '</div>';

    body.innerHTML = html;
    modal.style.display = 'flex';
  } catch (e) { console.warn('openChantierDetail :', e); }
}

function closeChantierDetail() {
  try {
    var m = document.getElementById('chantierDetailModal');
    if (m) m.style.display = 'none';
  } catch (e) {}
}

function _chDetailItem(label, value) {
  return '<div class="detail-item"><div class="detail-label">' + escapeHtml(label) +
    '</div><div class="detail-value">' + escapeHtml(value) + '</div></div>';
}

function _chStatItem(label, value, color) {
  return '<div class="stat-item"><div class="stat-value"' +
    (color ? ' style="color:' + color + '"' : '') + '>' + escapeHtml(value) +
    '</div><div class="stat-label">' + escapeHtml(label) + '</div></div>';
}

/* ═══════════ SECTION 7 — FORMULAIRE ═══════════ */

function openChantierModal(chantierId) {
  try {
    var modal = document.getElementById('chantierModal');
    var title = document.getElementById('chantierModalTitle');
    if (!modal) return;

    var form = document.getElementById('chantierForm');
    if (form) form.reset();

    if (chantierId) {
      var ch = getChantierById(chantierId);
      if (!ch) return;
      if (title) title.textContent = 'Modifier chantier';
      _chFill('chantierId', ch.id);
      _chFill('chantierNom', ch.nom || '');
      _chFill('chantierAdresse', ch.adresse || '');
      _chFill('chantierDateDebut', ch.dateDebut || '');
      _chFill('chantierDateFin', ch.dateFin || '');
      _chFill('chantierBudget', ch.budget || '');
      _chFill('chantierResponsable', ch.responsable || '');
      _chFill('chantierStatut', _normalizeStatut(ch.statut));
      _chFill('chantierNotes', ch.notes || '');
      _populateClientsSelect(ch.clientId);
    } else {
      if (title) title.textContent = 'Nouveau chantier';
      _chFill('chantierId', '');
      _chFill('chantierStatut', 'en_cours');
      _populateClientsSelect('');
    }

    var errEl = document.getElementById('chantierFormError');
    if (errEl) errEl.textContent = '';

    modal.style.display = 'flex';
    var nomInput = document.getElementById('chantierNom');
    if (nomInput) setTimeout(function () { try { nomInput.focus(); } catch (e) {} }, 100);
  } catch (e) { console.warn('openChantierModal :', e); }
}

function closeChantierModal() {
  try {
    var m = document.getElementById('chantierModal');
    if (m) m.style.display = 'none';
  } catch (e) {}
}

function _chFill(id, value) {
  try {
    var el = document.getElementById(id);
    if (el) el.value = (value === null || value === undefined) ? '' : value;
  } catch (e) {}
}

function _chGet(id) {
  try {
    var el = document.getElementById(id);
    return el ? String(el.value || '').trim() : '';
  } catch (e) { return ''; }
}

function saveChantierFromForm() {
  try {
    var errEl = document.getElementById('chantierFormError');
    var id = _chGet('chantierId');
    var nom = _chGet('chantierNom');

    if (!nom) { if (errEl) errEl.textContent = 'Le nom est obligatoire.'; return; }
    if (chantierExists(nom, id)) {
      if (errEl) errEl.textContent = 'Un chantier avec ce nom existe déjà.';
      return;
    }

    /* v6.7 — validation cohérence des dates.
       Un chantier ne peut pas se terminer avant de commencer. */
    var dateDebut = _chGet('chantierDateDebut');
    var dateFin = _chGet('chantierDateFin');
    if (dateDebut && dateFin && dateFin < dateDebut) {
      if (errEl) errEl.textContent = 'La date de fin (' + formatDate(dateFin) +
        ') ne peut pas être avant la date de début (' + formatDate(dateDebut) + ').';
      return;
    }

    var raw = {
      id: id || undefined,
      nom: nom,
      clientId: _chGet('chantierClientSelect'),
      adresse: _chGet('chantierAdresse'),
      dateDebut: dateDebut,
      dateFin: dateFin,
      budget: _chGet('chantierBudget'),
      responsable: _chGet('chantierResponsable'),
      statut: _chGet('chantierStatut'),
      notes: _chGet('chantierNotes')
    };

    var clean = _normalizeChantier(raw);
    if (!clean) { if (errEl) errEl.textContent = 'Données invalides.'; return; }

    if (id) {
      var existing = getChantierById(id);
      if (!existing) { if (errEl) errEl.textContent = 'Chantier introuvable.'; return; }
      clean.createdAt = existing.createdAt;
      var idx = savedChantiers.indexOf(existing);
      savedChantiers[idx] = clean;
    } else {
      savedChantiers.push(clean);
    }

    if (typeof saveAll === 'function') saveAll();
    if (typeof logAction === 'function') {
      logAction(id ? 'chantier.update' : 'chantier.create', clean.nom);
    }

    closeChantierModal();
    renderChantiers();
    if (typeof showToast === 'function') {
      showToast(id ? 'Chantier modifié' : 'Chantier créé', 'success', 2500);
    }
  } catch (e) {
    console.warn('saveChantierFromForm :', e);
    var errEl2 = document.getElementById('chantierFormError');
    if (errEl2) errEl2.textContent = 'Erreur lors de l\'enregistrement.';
  }
}

/* ═══════════ SECTION 8 — SUPPRESSION AVEC UNDO ═══════════ */

function deleteChantier(id) {
  try {
    var ch = getChantierById(id);
    if (!ch) return;

    var idx = savedChantiers.indexOf(ch);
    if (idx < 0) return;
    savedChantiers.splice(idx, 1);

    if (!trash || typeof trash !== 'object') {
      trash = { clients: [], articles: [], documents: [] };
    }
    if (!Array.isArray(trash.chantiers)) trash.chantiers = [];
    var entry = {
      item: ch,
      deletedAt: new Date().toISOString(),
      deletedBy: (currentUser && currentUser.username) || 'anon'
    };
    trash.chantiers.push(entry);

    /* Si ce chantier était actif, on le désactive */
    if (chantierActifId && String(chantierActifId) === String(id)) {
      chantierActifId = null;
      renderActiveChantierBadge();
    }

    if (typeof saveAll === 'function') saveAll();
    if (typeof logAction === 'function') logAction('chantier.delete', ch.nom);
    renderChantiers();

    if (typeof showUndoToast === 'function') {
      showUndoToast('Chantier supprimé : ' + (ch.nom || ''),
        function () { _restoreDeletedChantier(entry, ch); }, 5000);
    } else if (typeof showToast === 'function') {
      showToast('Chantier déplacé dans la corbeille.', 'info', 3000);
    }
  } catch (e) { console.warn('deleteChantier :', e); }
}

function _restoreDeletedChantier(entry, chObj) {
  try {
    if (!entry || !chObj) return;
    if (Array.isArray(trash.chantiers)) {
      var idx = trash.chantiers.indexOf(entry);
      if (idx >= 0) trash.chantiers.splice(idx, 1);
    }
    if (getChantierById(chObj.id)) return;
    savedChantiers.push(chObj);
    if (typeof saveAll === 'function') saveAll();
    if (typeof logAction === 'function') logAction('chantier.restore', chObj.nom);
    renderChantiers();
    if (typeof showToast === 'function') {
      showToast('Chantier restauré : ' + (chObj.nom || ''), 'success', 2500);
    }
  } catch (e) { console.warn('_restoreDeletedChantier :', e); }
}

/* ═══════════ SECTION 9 — DEVIS / FACTURE 1 CLIC ═══════════ */

function createDevisFromChantier(id) {
  try {
    var ch = getChantierById(id);
    if (!ch) return;

    var prefill = {
      type: 'devis',
      clientId: String(ch.clientId || ''),
      chantierId: String(ch.id),
      sujet: String(ch.nom || ''),
      notes: 'Chantier : ' + String(ch.nom || '')
    };
    window.__pendingChantierPrefill = prefill;

    if (typeof openInvoiceFormWithPrefill === 'function') {
      try { openInvoiceFormWithPrefill(prefill); return; } catch (e) {}
    }
    if (typeof openInvoiceForm === 'function') {
      try { openInvoiceForm(); return; } catch (e) {}
    }
    if (typeof showSection === 'function') {
      try { showSection('facturation'); } catch (e) {}
    }
    if (typeof showToast === 'function') {
      showToast('Devis préparé. Complète les articles dans Facturation.', 'info', 4000);
    }
  } catch (e) { console.warn('createDevisFromChantier :', e); }
}

function createFactureFromChantier(id) {
  try {
    var ch = getChantierById(id);
    if (!ch) return;

    var prefill = {
      type: 'facture',
      clientId: String(ch.clientId || ''),
      chantierId: String(ch.id),
      sujet: String(ch.nom || ''),
      notes: 'Chantier : ' + String(ch.nom || '')
    };
    window.__pendingChantierPrefill = prefill;

    if (typeof openInvoiceFormWithPrefill === 'function') {
      try { openInvoiceFormWithPrefill(prefill); return; } catch (e) {}
    }
    if (typeof openInvoiceForm === 'function') {
      try { openInvoiceForm(); return; } catch (e) {}
    }
    if (typeof showSection === 'function') {
      try { showSection('facturation'); } catch (e) {}
    }
    if (typeof showToast === 'function') {
      showToast('Facture préparée. Complète les articles dans Facturation.', 'info', 4000);
    }
  } catch (e) { console.warn('createFactureFromChantier :', e); }
}

/* ═══════════ SECTION 10 — RECHERCHE / FILTRES ═══════════ */

function setChantiersSearch(term) {
  __chantiersSearchTerm = String(term || '');
  renderChantiers();
}

function setChantiersFilter(filter) {
  __chantiersFilter = filter || 'all';
  renderChantiers();
}

function getFilteredChantiers() {
  try {
    if (!Array.isArray(savedChantiers)) return [];
    var out = savedChantiers.slice();

    if (__chantiersSearchTerm) {
      var term = normalizeText(__chantiersSearchTerm);
      out = out.filter(function (ch) {
        if (!ch) return false;
        var cn = ch.clientId ? getClientName(ch.clientId) : '';
        var hay = normalizeText([ch.nom, ch.adresse, ch.responsable, cn].join(' '));
        return hay.indexOf(term) >= 0;
      });
    }

    if (__chantiersFilter === 'actifs') {
      out = out.filter(function (ch) { return _normalizeStatut(ch.statut) === 'en_cours'; });
    } else if (__chantiersFilter === 'termines') {
      out = out.filter(function (ch) { return _normalizeStatut(ch.statut) === 'termine'; });
    } else if (__chantiersFilter === 'planifies') {
      out = out.filter(function (ch) { return _normalizeStatut(ch.statut) === 'planifie'; });
    } else if (__chantiersFilter === 'negatifs') {
      out = out.filter(function (ch) {
        return computeChantierStats(ch.id).margePct < 0;
      });
    }

    out.sort(function (a, b) {
      var na = normalizeText(a.nom || '');
      var nb = normalizeText(b.nom || '');
      return na > nb ? 1 : (na < nb ? -1 : 0);
    });
    return out;
  } catch (e) { console.warn('getFilteredChantiers :', e); return []; }
}

/* ═══════════ SECTION 11 — IMPORT / EXPORT ═══════════ */

function exportChantiersJSON() {
  try {
    var data = {
      version: 1,
      exportedAt: new Date().toISOString(),
      count: savedChantiers.length,
      chantiers: savedChantiers
    };
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    var filename = 'voltcore-chantiers-' + todayISO() + '.json';
    if (typeof downloadBlob === 'function') downloadBlob(blob, filename);
    else _chFallbackDownload(blob, filename);
    if (typeof showToast === 'function') showToast(savedChantiers.length + ' chantier(s) exporté(s)', 'success');
  } catch (e) { console.warn('exportChantiersJSON :', e); }
}

function exportChantiersCSV() {
  try {
    var lines = [];
    lines.push(['Nom', 'Client', 'Adresse', 'DateDebut', 'DateFin', 'Budget', 'Statut', 'Responsable', 'Notes'].join('\t'));
    for (var i = 0; i < savedChantiers.length; i++) {
      var ch = savedChantiers[i];
      if (!ch) continue;
      lines.push([
        _chCsv(ch.nom),
        _chCsv(ch.clientId ? getClientName(ch.clientId) : ''),
        _chCsv(ch.adresse),
        _chCsv(ch.dateDebut || ''),
        _chCsv(ch.dateFin || ''),
        String(parseNumber(ch.budget)),
        _chCsv(_getStatutLabel(_normalizeStatut(ch.statut))),
        _chCsv(ch.responsable || ''),
        _chCsv(ch.notes || '')
      ].join('\t'));
    }
    var csv = '\uFEFF' + lines.join('\r\n');
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    var filename = 'voltcore-chantiers-' + todayISO() + '.csv';
    if (typeof downloadBlob === 'function') downloadBlob(blob, filename);
    else _chFallbackDownload(blob, filename);
    if (typeof showToast === 'function') showToast('CSV exporté', 'success');
  } catch (e) { console.warn('exportChantiersCSV :', e); }
}

function _chCsv(v) {
  return String(v == null ? '' : v).replace(/\t/g, ' ').replace(/\r?\n/g, ' ');
}

/* v6.7 — Fallback download aligné sur 03-utils.js (30s au lieu de 1s). */
function _chFallbackDownload(blob, filename) {
  try {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { try { URL.revokeObjectURL(url); } catch (e) {} }, 30000);
  } catch (e) {
    console.warn('_chFallbackDownload :', e);
  }
}

function importChantiersJSON(file, options) {
  return new Promise(function (resolve, reject) {
    try {
      if (!file) return reject(new Error('Fichier requis'));
      var mode = (options && options.mode) || 'merge';
      var reader = new FileReader();
      reader.onload = function (ev) {
        try {
          var parsed = JSON.parse(ev.target.result);
          var arr = null;
          if (Array.isArray(parsed)) arr = parsed;
          else if (parsed && Array.isArray(parsed.chantiers)) arr = parsed.chantiers;
          if (!arr) throw new Error('Format invalide : chantiers[] attendu');

          var added = 0, skipped = 0, invalid = 0;
          if (mode === 'replace') { if (typeof _pushAllToTrashBeforeReplace === 'function') _pushAllToTrashBeforeReplace('chantiers', savedChantiers); savedChantiers = []; }

          for (var i = 0; i < arr.length; i++) {
            var clean = _normalizeChantier(arr[i]);
            if (!clean) { invalid++; continue; }
            if (chantierExists(clean.nom)) { skipped++; continue; }
            savedChantiers.push(clean);
            added++;
          }

          if (typeof saveAll === 'function') saveAll();
          if (typeof logAction === 'function') logAction('chantier.import', added + ' ajoutés');
          renderChantiers();
          if (typeof showToast === 'function') {
            var msg = added + ' chantier(s) importé(s)';
            if (skipped > 0) msg += ' · ' + skipped + ' doublon(s)';
            if (invalid > 0) msg += ' · ' + invalid + ' invalide(s)';
            showToast(msg, added > 0 ? 'success' : 'warning', 4000);
          }
          resolve({ added: added, skipped: skipped, invalid: invalid });
        } catch (err) { reject(err); }
      };
      reader.onerror = function () { reject(reader.error || new Error('Lecture échouée')); };
      reader.readAsText(file);
    } catch (e) { reject(e); }
  });
}

/* ═══════════ SECTION 12 — IMPRESSION ═══════════ */

function printChantiersList() {
  try {
    var list = getFilteredChantiers();
    var html = '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Chantiers — VOLTCORE</title>' +
      '<style>body{font-family:Arial;margin:20px;font-size:12px}' +
      'h1{color:#0b3d91;border-bottom:2px solid #0b3d91;padding-bottom:6px}' +
      'table{width:100%;border-collapse:collapse;margin-top:10px}' +
      'th,td{border:1px solid #ccc;padding:6px;text-align:left}' +
      'th{background:#f0f0f0}.right{text-align:right}' +
      '</style></head><body>';
    html += '<h1>Liste des chantiers</h1><div>Total : ' + list.length + ' · ' + todayISO() + '</div>';
    html += '<table><thead><tr><th>Nom</th><th>Client</th><th>Statut</th><th>Dates</th>' +
      '<th class="right">CA</th><th class="right">Marge</th><th class="right">Marge %</th>' +
      '</tr></thead><tbody>';
    for (var i = 0; i < list.length; i++) {
      var ch = list[i];
      var s = computeChantierStats(ch.id);
      html += '<tr><td>' + escapeHtml(ch.nom) + '</td>' +
        '<td>' + escapeHtml(ch.clientId ? getClientName(ch.clientId) : '—') + '</td>' +
        '<td>' + escapeHtml(_getStatutLabel(_normalizeStatut(ch.statut))) + '</td>' +
        '<td>' + escapeHtml((ch.dateDebut ? formatDate(ch.dateDebut) : '') +
          (ch.dateFin ? ' → ' + formatDate(ch.dateFin) : '')) + '</td>' +
        '<td class="right">' + formatMoney(s.recettes) + '</td>' +
        '<td class="right">' + formatMoney(s.marge) + '</td>' +
        '<td class="right">' + (s.margePct * 100).toFixed(1) + '%</td></tr>';
    }
    html += '</tbody></table></body></html>';

    var w = window.open('', '_blank');
    if (!w) { if (typeof showToast === 'function') showToast('Autorise les pop-ups.', 'warning'); return; }
    w.document.write(html); w.document.close();
    setTimeout(function () { try { w.print(); } catch (e) {} }, 500);
  } catch (e) { console.warn('printChantiersList :', e); }
}

function printChantierRecap(id) {
  try {
    var ch = getChantierById(id);
    if (!ch) return;
    var s = computeChantierStats(id);
    var factures = [];
    if (Array.isArray(savedDocuments)) {
      for (var i = 0; i < savedDocuments.length; i++) {
        var d = savedDocuments[i];
        if (!d || d.type !== 'facture') continue;
        if (String(d.chantierId || '') !== String(id)) continue;
        if (d.statut === 'annulee' || d.annulee === true) continue;
        factures.push(d);
      }
    }

    var html = '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Récap ' +
      escapeHtml(ch.nom) + '</title><style>' +
      'body{font-family:Arial;margin:20px;font-size:12px}' +
      'h1{color:#0b3d91;border-bottom:2px solid #0b3d91;padding-bottom:6px}' +
      'h2{color:#0b3d91;font-size:14px;margin-top:18px}' +
      'table{width:100%;border-collapse:collapse;margin-top:6px}' +
      'th,td{border:1px solid #ccc;padding:6px;text-align:left}' +
      'th{background:#f0f0f0}.right{text-align:right}.muted{color:#666}' +
      '</style></head><body>';
    html += '<h1>Récap chantier : ' + escapeHtml(ch.nom) + '</h1>';
    html += '<p class="muted">' + escapeHtml(ch.clientId ? getClientName(ch.clientId) : '—') + ' · ' +
      escapeHtml(_getStatutLabel(_normalizeStatut(ch.statut))) + '</p>';

    html += '<h2>Marges</h2><table><tbody>';
    html += '<tr><th>Recettes</th><td class="right">' + formatMoney(s.recettes) + '</td></tr>';
    html += '<tr><th>Achats</th><td class="right">' + formatMoney(s.achats) + '</td></tr>';
    html += '<tr><th>Frais</th><td class="right">' + formatMoney(s.frais) + '</td></tr>';
    html += '<tr><th>RH</th><td class="right">' + formatMoney(s.rh) + '</td></tr>';
    html += '<tr><th><strong>Marge</strong></th><td class="right"><strong>' +
      formatMoney(s.marge) + ' (' + (s.margePct * 100).toFixed(1) + '%)</strong></td></tr>';
    html += '</tbody></table>';

    if (factures.length > 0) {
      html += '<h2>Factures (' + factures.length + ')</h2><table><thead><tr>' +
        '<th>N°</th><th>Date</th><th class="right">Total</th></tr></thead><tbody>';
      for (var j = 0; j < factures.length; j++) {
        var f = factures[j];
        var total = (f.totals && typeof f.totals.total === 'number') ? f.totals.total
                   : (typeof f.totalTTC === 'number' ? f.totalTTC : 0);
        html += '<tr><td>' + escapeHtml(f.numero || '') + '</td>' +
          '<td>' + escapeHtml(formatDate(f.date || '')) + '</td>' +
          '<td class="right">' + formatMoney(total) + '</td></tr>';
      }
      html += '</tbody></table>';
    }

    html += '<div class="muted" style="margin-top:20px;text-align:center">VOLTCORE — ' +
      todayISO() + '</div></body></html>';

    var w = window.open('', '_blank');
    if (!w) { if (typeof showToast === 'function') showToast('Autorise les pop-ups.', 'warning'); return; }
    w.document.write(html); w.document.close();
    setTimeout(function () { try { w.print(); } catch (e) {} }, 500);
  } catch (e) { console.warn('printChantierRecap :', e); }
}

/* ═══════════ SECTION 13 — ÉVÉNEMENTS ═══════════ */

function attachChantiersEvents() {
  try {
    var searchInput = document.getElementById('chantiersSearchInput');
    if (searchInput && !searchInput.__bound) {
      searchInput.__bound = true;
      searchInput.addEventListener('input', debounce(function (ev) {
        setChantiersSearch(ev.target.value);
      }, 250));
    }

    var filterSel = document.getElementById('chantiersFilterSelect');
    if (filterSel && !filterSel.__bound) {
      filterSel.__bound = true;
      filterSel.addEventListener('change', function (ev) {
        setChantiersFilter(ev.target.value);
      });
    }

    var addBtn = document.getElementById('btnAddChantier');
    if (addBtn && !addBtn.__bound) {
      addBtn.__bound = true;
      addBtn.addEventListener('click', function () { openChantierModal(null); });
    }

    var importBtn = document.getElementById('btnImportChantiers');
    if (importBtn && !importBtn.__bound) {
      importBtn.__bound = true;
      importBtn.addEventListener('click', function () {
        var input = document.createElement('input');
        input.type = 'file'; input.accept = '.json,application/json';
        input.onchange = function (ev) {
          var f = ev.target.files && ev.target.files[0];
          if (!f) return;
          importChantiersJSON(f, { mode: 'merge' }).catch(function (err) {
            if (typeof showToast === 'function') showToast('Import échoué : ' + (err.message || ''), 'error');
          });
        };
        input.click();
      });
    }

    var exportJsonBtn = document.getElementById('btnExportChantiersJSON');
    if (exportJsonBtn && !exportJsonBtn.__bound) {
      exportJsonBtn.__bound = true;
      exportJsonBtn.addEventListener('click', exportChantiersJSON);
    }

    var exportCsvBtn = document.getElementById('btnExportChantiersCSV');
    if (exportCsvBtn && !exportCsvBtn.__bound) {
      exportCsvBtn.__bound = true;
      exportCsvBtn.addEventListener('click', exportChantiersCSV);
    }

    var printBtn = document.getElementById('btnPrintChantiers');
    if (printBtn && !printBtn.__bound) {
      printBtn.__bound = true;
      printBtn.addEventListener('click', printChantiersList);
    }
  } catch (e) { console.warn('attachChantiersEvents :', e); }
}

console.log('✅ 09-chantiers.js chargé — v6.7 (fallback 30s + validation dates)');