/* ═══════════════════════════════════════════════════════════════
   VOLTCORE — 10-hr.js
   VERSION : v6.7 (Session #3 — fallback download 30s, bump version)
   RÔLE : RH complète (employés, journées, paiements, balance auto)
   DÉPENDANCES : 01-core.js (hrEmployees, hrWorkEntries, hrTransactions,
                            __hrWorkPage, __hrTxPage, __hrPerPage, trash),
                 03-utils.js (helpers), 04-storage.js (saveAll)
   EXPOSE : getHREmployeeById, getHREmployeeNom, hrEmployeeExists,
            computeHREmployeeStats, getWorkEntriesFor, getTransactionsFor,
            renderHR, renderHREmployeeRow, openHRDetail, closeHRDetail,
            openHREmployeeModal, closeHREmployeeModal, saveHREmployeeFromForm,
            openHRWorkModal, saveHRWorkFromForm,
            openHRTxModal, saveHRTxFromForm,
            deleteHREmployee, deleteHRWorkEntry, deleteHRTx,
            setHRSearch, setHRFilter, setHRWorkPage, setHRTxPage,
            exportHRJSON, importHRJSON, printHRRecap, attachHREvents
   ═══════════════════════════════════════════════════════════════ */

/* ═══════════ SECTION 1 — ÉTAT + CONSTANTES ═══════════ */

var __hrSearchTerm = '';
var __hrFilter = 'all';
var __hrDetailEmployeeId = null;
var __hrDetailTab = 'work';

var HR_TX_TYPES = {
  salaire: 'Salaire',
  avance: 'Avance',
  prime: 'Prime',
  autre: 'Autre'
};

/* ═══════════ SECTION 2 — HELPERS EMPLOYÉS ═══════════ */

function getHREmployeeById(id) {
  try {
    if (!id || !Array.isArray(hrEmployees)) return null;
    var sid = String(id);
    for (var i = 0; i < hrEmployees.length; i++) {
      if (hrEmployees[i] && String(hrEmployees[i].id) === sid) return hrEmployees[i];
    }
    return null;
  } catch (e) { return null; }
}

function getHREmployeeNom(id) {
  var e = getHREmployeeById(id);
  return e ? String(e.nom || '') : '';
}

function hrEmployeeExists(nom, excludeId) {
  try {
    if (!nom || !Array.isArray(hrEmployees)) return false;
    var normalized = normalizeText(nom);
    for (var i = 0; i < hrEmployees.length; i++) {
      var e = hrEmployees[i];
      if (!e) continue;
      if (excludeId && String(e.id) === String(excludeId)) continue;
      if (normalizeText(e.nom || '') === normalized) return true;
    }
    return false;
  } catch (e) { return false; }
}

function _getEmployeeRate(emp) {
  if (!emp) return 0;
  if (typeof emp.hourlyRate === 'number') return emp.hourlyRate;
  if (typeof emp.tauxHoraire === 'number') return emp.tauxHoraire;
  return parseNumber(emp.hourlyRate || emp.tauxHoraire);
}

function _normalizeEmployee(raw) {
  if (!raw || typeof raw !== 'object') return null;
  var nom = String(raw.nom || raw.name || '').trim().replace(/\s+/g, ' ');
  if (!nom) return null;
  return {
    id: raw.id || ('emp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)),
    nom: nom,
    poste: String(raw.poste || raw.role || '').trim(),
    telephone: String(raw.telephone || '').trim(),
    hourlyRate: parseNumber(raw.hourlyRate || raw.tauxHoraire),
    dateEmbauche: String(raw.dateEmbauche || '').slice(0, 10),
    actif: raw.actif !== false,
    notes: String(raw.notes || '').trim(),
    createdAt: raw.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

/* ═══════════ SECTION 3 — HELPERS JOURNÉES ═══════════ */

function _getWorkHours(w) {
  if (!w) return 0;
  if (typeof w.hours === 'number') return w.hours;
  if (typeof w.heures === 'number') return w.heures;
  return parseNumber(w.hours || w.heures);
}

function _getWorkRate(w) {
  if (!w) return 0;
  if (w.rate != null) return parseNumber(w.rate);
  var emp = getHREmployeeById(w.employeeId);
  return _getEmployeeRate(emp);
}

function _normalizeWorkEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!raw.employeeId) return null;
  var hours = parseNumber(raw.hours || raw.heures);
  if (hours <= 0) return null;
  return {
    id: raw.id || ('wrk_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)),
    employeeId: String(raw.employeeId),
    date: String(raw.date || todayISO()).slice(0, 10),
    hours: hours,
    rate: raw.rate != null ? parseNumber(raw.rate) : null,
    chantierId: String(raw.chantierId || ''),
    description: String(raw.description || '').trim(),
    createdAt: raw.createdAt || new Date().toISOString()
  };
}

function getWorkEntriesFor(employeeId) {
  try {
    if (!employeeId || !Array.isArray(hrWorkEntries)) return [];
    var sid = String(employeeId);
    var out = hrWorkEntries.filter(function (w) {
      return w && String(w.employeeId) === sid;
    });
    out.sort(function (a, b) {
      return String(b.date || '') > String(a.date || '') ? 1 : -1;
    });
    return out;
  } catch (e) { return []; }
}

/* ═══════════ SECTION 4 — HELPERS PAIEMENTS ═══════════ */

function _normalizeTx(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!raw.employeeId) return null;
  var montant = parseNumber(raw.montant);
  if (montant <= 0) return null;
  var type = String(raw.type || 'salaire').toLowerCase();
  if (!HR_TX_TYPES[type]) type = 'autre';
  return {
    id: raw.id || ('tx_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)),
    employeeId: String(raw.employeeId),
    date: String(raw.date || todayISO()).slice(0, 10),
    montant: montant,
    type: type,
    period: String(raw.period || '').trim(),
    note: String(raw.note || '').trim(),
    createdAt: raw.createdAt || new Date().toISOString()
  };
}

function getTransactionsFor(employeeId) {
  try {
    if (!employeeId || !Array.isArray(hrTransactions)) return [];
    var sid = String(employeeId);
    var out = hrTransactions.filter(function (t) {
      return t && String(t.employeeId) === sid;
    });
    out.sort(function (a, b) {
      return String(b.date || '') > String(a.date || '') ? 1 : -1;
    });
    return out;
  } catch (e) { return []; }
}

/* ═══════════ SECTION 5 — STATISTIQUES ═══════════ */

function computeHREmployeeStats(employeeId) {
  var empty = { totalDu: 0, totalPaye: 0, balance: 0, nbJours: 0, nbPaiements: 0, totalHeures: 0 };
  try {
    if (!employeeId) return empty;

    var works = getWorkEntriesFor(employeeId);
    var totalDu = 0, totalHeures = 0;
    for (var i = 0; i < works.length; i++) {
      var w = works[i];
      var h = _getWorkHours(w);
      var r = _getWorkRate(w);
      totalHeures += h;
      totalDu += h * r;
    }

    var txs = getTransactionsFor(employeeId);
    var totalPaye = 0;
    for (var j = 0; j < txs.length; j++) {
      totalPaye += parseNumber(txs[j].montant);
    }

    return {
      totalDu: totalDu,
      totalPaye: totalPaye,
      balance: totalDu - totalPaye,
      nbJours: works.length,
      nbPaiements: txs.length,
      totalHeures: totalHeures
    };
  } catch (e) { console.warn('computeHREmployeeStats :', e); return empty; }
}

/* ═══════════ SECTION 6 — RENDU LISTE ═══════════ */

function renderHR() {
  try {
    var container = document.getElementById('hrList');
    if (!container) return;

    var list = _getFilteredHREmployees();
    if (list.length === 0) {
      container.innerHTML = '<div class="empty-state">Aucun employé' +
        (__hrSearchTerm || __hrFilter !== 'all' ? ' pour ce filtre' : '') +
        '. Clique sur "+ Nouvel employé" pour commencer.</div>';
      _updateHRCount(0);
      return;
    }

    var html = '';
    for (var i = 0; i < list.length; i++) html += renderHREmployeeRow(list[i]);
    container.innerHTML = html;
    _updateHRCount(list.length);
  } catch (e) { console.warn('renderHR :', e); }
}

function renderHREmployeeRow(emp) {
  try {
    if (!emp) return '';
    var id = escapeAttr(emp.id);
    var nom = escapeHtml(emp.nom || '(Sans nom)');
    var poste = escapeHtml(emp.poste || '');
    var tel = escapeHtml(emp.telephone || '');

    var badges = '';
    if (emp.actif === false) badges += '<span class="badge badge-muted">Inactif</span> ';
    var stats = computeHREmployeeStats(emp.id);
    var balColor = stats.balance > 0.01 ? 'var(--danger)'
                 : stats.balance < -0.01 ? 'var(--success)'
                 : 'var(--muted)';
    var balLabel = stats.balance > 0.01 ? 'dû'
                 : stats.balance < -0.01 ? 'trop payé'
                 : 'à jour';

    return '<div class="hr-row" data-employee-id="' + id + '">' +
      '<div class="hr-row-main">' +
        '<div class="hr-row-name">' + nom + ' ' + badges + '</div>' +
        '<div class="hr-row-meta">' +
          (poste ? escapeHtml(poste) + ' · ' : '') +
          (tel ? '📞 ' + tel : '') +
          (stats.nbJours > 0 ? ' · ' + stats.nbJours + ' jour(s)' : '') +
        '</div>' +
        '<div class="hr-row-balance" style="color:' + balColor + '">' +
          'Balance : ' + formatMoney(stats.balance) + ' (' + balLabel + ')' +
        '</div>' +
      '</div>' +
      '<div class="hr-row-actions">' +
        '<button type="button" class="btn-icon" title="Détail" ' +
          'onclick="openHRDetail(\'' + id + '\')">👁️</button>' +
        '<button type="button" class="btn-icon" title="Éditer" ' +
          'onclick="openHREmployeeModal(\'' + id + '\')">✏️</button>' +
        '<button type="button" class="btn-icon" title="Journée" ' +
          'onclick="openHRWorkModal(\'' + id + '\')">📅</button>' +
        '<button type="button" class="btn-icon" title="Paiement" ' +
          'onclick="openHRTxModal(\'' + id + '\')">💰</button>' +
        '<button type="button" class="btn-icon btn-danger" title="Supprimer" ' +
          'onclick="deleteHREmployee(\'' + id + '\')">🗑️</button>' +
      '</div>' +
    '</div>';
  } catch (e) { console.warn('renderHREmployeeRow :', e); return ''; }
}

function _updateHRCount(n) {
  try {
    var el = document.getElementById('hrCount');
    if (el) el.textContent = String(n);
  } catch (e) {}
}

/* ═══════════ SECTION 7 — RENDU DÉTAIL (tabs) ═══════════ */

function openHRDetail(id) {
  try {
    var emp = getHREmployeeById(id);
    if (!emp) return;
    __hrDetailEmployeeId = String(id);
    __hrDetailTab = 'work';

    var modal = document.getElementById('hrDetailModal');
    if (!modal) return;

    var title = document.getElementById('hrDetailTitle');
    if (title) title.textContent = emp.nom || 'Employé';

    _renderHRDetailBody();
    modal.style.display = 'flex';
  } catch (e) { console.warn('openHRDetail :', e); }
}

function closeHRDetail() {
  try {
    var m = document.getElementById('hrDetailModal');
    if (m) m.style.display = 'none';
    __hrDetailEmployeeId = null;
  } catch (e) {}
}

function switchHRDetailTab(tab) {
  __hrDetailTab = (tab === 'tx') ? 'tx' : 'work';
  _renderHRDetailBody();
}

function _renderHRDetailBody() {
  try {
    var body = document.getElementById('hrDetailBody');
    if (!body || !__hrDetailEmployeeId) return;
    var emp = getHREmployeeById(__hrDetailEmployeeId);
    if (!emp) return;

    var stats = computeHREmployeeStats(emp.id);
    var html = '';

    html += '<div class="detail-section"><h3>Infos</h3><div class="detail-grid">';
    html += _hrDetailItem('Poste', emp.poste || '—');
    html += _hrDetailItem('Téléphone', emp.telephone || '—');
    html += _hrDetailItem('Taux horaire', formatMoney(_getEmployeeRate(emp)));
    html += _hrDetailItem('Date embauche', emp.dateEmbauche ? formatDate(emp.dateEmbauche) : '—');
    html += _hrDetailItem('Statut', emp.actif === false ? 'Inactif' : 'Actif');
    html += '</div></div>';

    html += '<div class="detail-section"><h3>Balance</h3><div class="stats-grid">';
    html += _hrStatItem('Heures', stats.totalHeures.toFixed(1) + 'h');
    html += _hrStatItem('Total dû', formatMoney(stats.totalDu));
    html += _hrStatItem('Total payé', formatMoney(stats.totalPaye));
    var balColor = stats.balance > 0.01 ? 'var(--danger)'
                 : stats.balance < -0.01 ? 'var(--success)' : 'var(--muted)';
    html += _hrStatItem('Balance', formatMoney(stats.balance), balColor);
    html += '</div></div>';

    html += '<div class="hr-tabs">';
    html += '<button type="button" class="hr-tab' + (__hrDetailTab === 'work' ? ' active' : '') +
      '" onclick="switchHRDetailTab(\'work\')">📅 Journées (' + stats.nbJours + ')</button>';
    html += '<button type="button" class="hr-tab' + (__hrDetailTab === 'tx' ? ' active' : '') +
      '" onclick="switchHRDetailTab(\'tx\')">💰 Paiements (' + stats.nbPaiements + ')</button>';
    html += '</div>';

    if (__hrDetailTab === 'work') html += _renderWorkTab();
    else html += _renderTxTab();

    body.innerHTML = html;
  } catch (e) { console.warn('_renderHRDetailBody :', e); }
}

function _renderWorkTab() {
  var works = getWorkEntriesFor(__hrDetailEmployeeId);
  var perPage = parseInt(window.__hrPerPage, 10) || 50;
  var page = parseInt(window.__hrWorkPage, 10) || 0;
  var maxPage = Math.max(0, Math.ceil(works.length / perPage) - 1);
  if (page > maxPage) page = maxPage;
  var slice = works.slice(page * perPage, (page + 1) * perPage);

  var html = '<div class="hr-tab-content">';
  html += '<div class="hr-tab-actions">' +
    '<button type="button" class="btn btn-primary btn-sm" onclick="openHRWorkModal(\'' +
    escapeAttr(__hrDetailEmployeeId) + '\')">+ Journée</button></div>';

  if (slice.length === 0) {
    html += '<div class="empty-state">Aucune journée enregistrée.</div>';
  } else {
    html += '<table class="hr-table"><thead><tr>' +
      '<th>Date</th><th>Heures</th><th>Taux</th><th>Chantier</th><th>Note</th><th></th>' +
      '</tr></thead><tbody>';
    for (var i = 0; i < slice.length; i++) {
      var w = slice[i];
      var taux = _getWorkRate(w);
      var chNom = w.chantierId ? getChantierNom(w.chantierId) : '—';
      html += '<tr>' +
        '<td>' + escapeHtml(formatDate(w.date)) + '</td>' +
        '<td>' + _getWorkHours(w).toFixed(1) + 'h</td>' +
        '<td>' + formatMoney(taux) + '</td>' +
        '<td>' + escapeHtml(chNom) + '</td>' +
        '<td>' + escapeHtml(w.description || '—') + '</td>' +
        '<td><button type="button" class="btn-icon btn-danger" ' +
        'onclick="deleteHRWorkEntry(\'' + escapeAttr(w.id) + '\')">🗑️</button></td>' +
        '</tr>';
    }
    html += '</tbody></table>';
  }

  html += _renderPagination('work', page, maxPage);
  html += '</div>';
  return html;
}

function _renderTxTab() {
  var txs = getTransactionsFor(__hrDetailEmployeeId);
  var perPage = parseInt(window.__hrPerPage, 10) || 50;
  var page = parseInt(window.__hrTxPage, 10) || 0;
  var maxPage = Math.max(0, Math.ceil(txs.length / perPage) - 1);
  if (page > maxPage) page = maxPage;
  var slice = txs.slice(page * perPage, (page + 1) * perPage);

  var html = '<div class="hr-tab-content">';
  html += '<div class="hr-tab-actions">' +
    '<button type="button" class="btn btn-primary btn-sm" onclick="openHRTxModal(\'' +
    escapeAttr(__hrDetailEmployeeId) + '\')">+ Paiement</button></div>';

  if (slice.length === 0) {
    html += '<div class="empty-state">Aucun paiement enregistré.</div>';
  } else {
    html += '<table class="hr-table"><thead><tr>' +
      '<th>Date</th><th>Type</th><th>Montant</th><th>Note</th><th></th>' +
      '</tr></thead><tbody>';
    for (var i = 0; i < slice.length; i++) {
      var t = slice[i];
      html += '<tr>' +
        '<td>' + escapeHtml(formatDate(t.date)) + '</td>' +
        '<td>' + escapeHtml(HR_TX_TYPES[t.type] || t.type) + '</td>' +
        '<td>' + formatMoney(t.montant) + '</td>' +
        '<td>' + escapeHtml(t.note || '—') + '</td>' +
        '<td><button type="button" class="btn-icon btn-danger" ' +
        'onclick="deleteHRTx(\'' + escapeAttr(t.id) + '\')">🗑️</button></td>' +
        '</tr>';
    }
    html += '</tbody></table>';
  }

  html += _renderPagination('tx', page, maxPage);
  html += '</div>';
  return html;
}

function _renderPagination(kind, page, maxPage) {
  if (maxPage <= 0) return '';
  var fn = kind === 'work' ? 'setHRWorkPage' : 'setHRTxPage';
  return '<div class="hr-pagination">' +
    '<button type="button" class="btn btn-sm"' + (page <= 0 ? ' disabled' : '') +
    ' onclick="' + fn + '(' + (page - 1) + ')">◀ Précédent</button>' +
    '<span class="muted">Page ' + (page + 1) + ' / ' + (maxPage + 1) + '</span>' +
    '<button type="button" class="btn btn-sm"' + (page >= maxPage ? ' disabled' : '') +
    ' onclick="' + fn + '(' + (page + 1) + ')">Suivant ▶</button>' +
    '</div>';
}

function _hrDetailItem(label, value) {
  return '<div class="detail-item"><div class="detail-label">' + escapeHtml(label) +
    '</div><div class="detail-value">' + escapeHtml(value) + '</div></div>';
}

function _hrStatItem(label, value, color) {
  return '<div class="stat-item"><div class="stat-value"' +
    (color ? ' style="color:' + color + '"' : '') + '>' + escapeHtml(value) +
    '</div><div class="stat-label">' + escapeHtml(label) + '</div></div>';
}

/* ═══════════ SECTION 8 — FORM EMPLOYÉ ═══════════ */

function openHREmployeeModal(employeeId) {
  try {
    var modal = document.getElementById('hrEmployeeModal');
    var title = document.getElementById('hrEmployeeModalTitle');
    if (!modal) return;

    var form = document.getElementById('hrEmployeeForm');
    if (form) form.reset();

    if (employeeId) {
      var emp = getHREmployeeById(employeeId);
      if (!emp) return;
      if (title) title.textContent = 'Modifier employé';
      _hrFill('hrEmployeeId', emp.id);
      _hrFill('hrEmployeeNom', emp.nom || '');
      _hrFill('hrEmployeePoste', emp.poste || '');
      _hrFill('hrEmployeeTelephone', emp.telephone || '');
      _hrFill('hrEmployeeRate', _getEmployeeRate(emp));
      _hrFill('hrEmployeeDate', emp.dateEmbauche || '');
      _hrFill('hrEmployeeNotes', emp.notes || '');
      var cb = document.getElementById('hrEmployeeActif');
      if (cb) cb.checked = emp.actif !== false;
    } else {
      if (title) title.textContent = 'Nouvel employé';
      _hrFill('hrEmployeeId', '');
      var cb2 = document.getElementById('hrEmployeeActif');
      if (cb2) cb2.checked = true;
    }

    var errEl = document.getElementById('hrEmployeeFormError');
    if (errEl) errEl.textContent = '';

    modal.style.display = 'flex';
    var nomInput = document.getElementById('hrEmployeeNom');
    if (nomInput) setTimeout(function () { try { nomInput.focus(); } catch (e) {} }, 100);
  } catch (e) { console.warn('openHREmployeeModal :', e); }
}

function closeHREmployeeModal() {
  try {
    var m = document.getElementById('hrEmployeeModal');
    if (m) m.style.display = 'none';
  } catch (e) {}
}

function _hrFill(id, value) {
  try {
    var el = document.getElementById(id);
    if (el) el.value = (value === null || value === undefined) ? '' : value;
  } catch (e) {}
}

function _hrGet(id) {
  try {
    var el = document.getElementById(id);
    return el ? String(el.value || '').trim() : '';
  } catch (e) { return ''; }
}

function _hrChecked(id) {
  try { var el = document.getElementById(id); return !!(el && el.checked); }
  catch (e) { return false; }
}

function saveHREmployeeFromForm() {
  try {
    var errEl = document.getElementById('hrEmployeeFormError');
    var id = _hrGet('hrEmployeeId');
    var nom = _hrGet('hrEmployeeNom');

    if (!nom) { if (errEl) errEl.textContent = 'Le nom est obligatoire.'; return; }
    if (hrEmployeeExists(nom, id)) {
      if (errEl) errEl.textContent = 'Un employé avec ce nom existe déjà.';
      return;
    }

    var raw = {
      id: id || undefined,
      nom: nom,
      poste: _hrGet('hrEmployeePoste'),
      telephone: _hrGet('hrEmployeeTelephone'),
      hourlyRate: _hrGet('hrEmployeeRate'),
      dateEmbauche: _hrGet('hrEmployeeDate'),
      notes: _hrGet('hrEmployeeNotes'),
      actif: _hrChecked('hrEmployeeActif')
    };

    var clean = _normalizeEmployee(raw);
    if (!clean) { if (errEl) errEl.textContent = 'Données invalides.'; return; }

    if (id) {
      var existing = getHREmployeeById(id);
      if (!existing) { if (errEl) errEl.textContent = 'Employé introuvable.'; return; }
      clean.createdAt = existing.createdAt;
      var idx = hrEmployees.indexOf(existing);
      hrEmployees[idx] = clean;
    } else {
      hrEmployees.push(clean);
    }

    if (typeof saveAll === 'function') saveAll();
    if (typeof logAction === 'function') {
      logAction(id ? 'hr.employee.update' : 'hr.employee.create', clean.nom);
    }

    closeHREmployeeModal();
    renderHR();
    if (typeof showToast === 'function') {
      showToast(id ? 'Employé modifié' : 'Employé créé', 'success', 2500);
    }
  } catch (e) {
    console.warn('saveHREmployeeFromForm :', e);
    var errEl2 = document.getElementById('hrEmployeeFormError');
    if (errEl2) errEl2.textContent = 'Erreur lors de l\'enregistrement.';
  }
}

/* ═══════════ SECTION 9 — FORM JOURNÉE ═══════════ */

function openHRWorkModal(employeeId) {
  try {
    var modal = document.getElementById('hrWorkModal');
    if (!modal) return;

    var form = document.getElementById('hrWorkForm');
    if (form) form.reset();

    _hrFill('hrWorkId', '');
    _hrFill('hrWorkEmployeeId', employeeId || '');
    _hrFill('hrWorkDate', todayISO());
    _hrFill('hrWorkHours', '8');

    _populateHREmployeesSelect('hrWorkEmployeeSelect', employeeId);
    _populateChantiersSelect('hrWorkChantierSelect', chantierActifId || '');

    var emp = getHREmployeeById(employeeId);
    if (emp) _hrFill('hrWorkRate', _getEmployeeRate(emp));

    var errEl = document.getElementById('hrWorkFormError');
    if (errEl) errEl.textContent = '';

    modal.style.display = 'flex';
  } catch (e) { console.warn('openHRWorkModal :', e); }
}

function _populateHREmployeesSelect(selectId, selectedId) {
  try {
    var sel = document.getElementById(selectId);
    if (!sel) return;
    var html = '<option value="">— Sélectionner —</option>';
    if (Array.isArray(hrEmployees)) {
      var actifs = hrEmployees.filter(function (e) { return e && e.actif !== false; });
      actifs.sort(function (a, b) {
        return normalizeText(a.nom || '') > normalizeText(b.nom || '') ? 1 : -1;
      });
      for (var i = 0; i < actifs.length; i++) {
        var e = actifs[i];
        var sid = String(e.id);
        html += '<option value="' + escapeAttr(sid) + '"' +
          (sid === String(selectedId || '') ? ' selected' : '') + '>' +
          escapeHtml(e.nom || '') + '</option>';
      }
    }
    sel.innerHTML = html;
  } catch (e) { console.warn('_populateHREmployeesSelect :', e); }
}

function _populateChantiersSelect(selectId, selectedId) {
  try {
    var sel = document.getElementById(selectId);
    if (!sel) return;
    var html = '<option value="">— Aucun —</option>';
    if (Array.isArray(savedChantiers)) {
      var sorted = savedChantiers.slice().sort(function (a, b) {
        return normalizeText(a.nom || '') > normalizeText(b.nom || '') ? 1 : -1;
      });
      for (var i = 0; i < sorted.length; i++) {
        var ch = sorted[i];
        var sid = String(ch.id);
        html += '<option value="' + escapeAttr(sid) + '"' +
          (sid === String(selectedId || '') ? ' selected' : '') + '>' +
          escapeHtml(ch.nom || '') + '</option>';
      }
    }
    sel.innerHTML = html;
  } catch (e) { console.warn('_populateChantiersSelect :', e); }
}

function saveHRWorkFromForm() {
  try {
    var errEl = document.getElementById('hrWorkFormError');
    var raw = {
      employeeId: _hrGet('hrWorkEmployeeSelect') || _hrGet('hrWorkEmployeeId'),
      date: _hrGet('hrWorkDate'),
      hours: _hrGet('hrWorkHours'),
      rate: _hrGet('hrWorkRate'),
      chantierId: _hrGet('hrWorkChantierSelect'),
      description: _hrGet('hrWorkDescription')
    };

    if (!raw.employeeId) { if (errEl) errEl.textContent = 'Employé requis.'; return; }
    if (!raw.date) { if (errEl) errEl.textContent = 'Date requise.'; return; }
    if (parseNumber(raw.hours) <= 0) { if (errEl) errEl.textContent = 'Heures > 0 requises.'; return; }

    var clean = _normalizeWorkEntry(raw);
    if (!clean) { if (errEl) errEl.textContent = 'Données invalides.'; return; }

    if (!Array.isArray(hrWorkEntries)) hrWorkEntries = [];
    hrWorkEntries.push(clean);

    if (typeof saveAll === 'function') saveAll();
    if (typeof logAction === 'function') {
      logAction('hr.work.add', getHREmployeeNom(clean.employeeId) + ' ' + clean.hours + 'h');
    }

    var modal = document.getElementById('hrWorkModal');
    if (modal) modal.style.display = 'none';
    renderHR();
    if (__hrDetailEmployeeId) _renderHRDetailBody();
    if (typeof showToast === 'function') showToast('Journée ajoutée', 'success', 2000);
  } catch (e) {
    console.warn('saveHRWorkFromForm :', e);
    var errEl2 = document.getElementById('hrWorkFormError');
    if (errEl2) errEl2.textContent = 'Erreur lors de l\'enregistrement.';
  }
}

/* ═══════════ SECTION 10 — FORM PAIEMENT ═══════════ */

function openHRTxModal(employeeId) {
  try {
    var modal = document.getElementById('hrTxModal');
    if (!modal) return;

    var form = document.getElementById('hrTxForm');
    if (form) form.reset();

    _hrFill('hrTxEmployeeId', employeeId || '');
    _hrFill('hrTxDate', todayISO());

    _populateHREmployeesSelect('hrTxEmployeeSelect', employeeId);

    if (employeeId) {
      var stats = computeHREmployeeStats(employeeId);
      if (stats.balance > 0.01) {
        _hrFill('hrTxMontant', stats.balance.toFixed(3));
      }
    }

    var errEl = document.getElementById('hrTxFormError');
    if (errEl) errEl.textContent = '';

    modal.style.display = 'flex';
  } catch (e) { console.warn('openHRTxModal :', e); }
}

function saveHRTxFromForm() {
  try {
    var errEl = document.getElementById('hrTxFormError');
    var raw = {
      employeeId: _hrGet('hrTxEmployeeSelect') || _hrGet('hrTxEmployeeId'),
      date: _hrGet('hrTxDate'),
      montant: _hrGet('hrTxMontant'),
      type: _hrGet('hrTxType') || 'salaire',
      period: _hrGet('hrTxPeriod'),
      note: _hrGet('hrTxNote')
    };

    if (!raw.employeeId) { if (errEl) errEl.textContent = 'Employé requis.'; return; }
    if (!raw.date) { if (errEl) errEl.textContent = 'Date requise.'; return; }
    if (parseNumber(raw.montant) <= 0) { if (errEl) errEl.textContent = 'Montant > 0 requis.'; return; }

    var clean = _normalizeTx(raw);
    if (!clean) { if (errEl) errEl.textContent = 'Données invalides.'; return; }

    if (!Array.isArray(hrTransactions)) hrTransactions = [];
    hrTransactions.push(clean);

    if (typeof saveAll === 'function') saveAll();
    if (typeof logAction === 'function') {
      logAction('hr.tx.add', getHREmployeeNom(clean.employeeId) + ' ' + clean.montant);
    }

    var modal = document.getElementById('hrTxModal');
    if (modal) modal.style.display = 'none';
    renderHR();
    if (__hrDetailEmployeeId) _renderHRDetailBody();
    if (typeof showToast === 'function') showToast('Paiement enregistré', 'success', 2000);
  } catch (e) {
    console.warn('saveHRTxFromForm :', e);
    var errEl2 = document.getElementById('hrTxFormError');
    if (errEl2) errEl2.textContent = 'Erreur lors de l\'enregistrement.';
  }
}

/* ═══════════ SECTION 11 — SUPPRESSION + UNDO ═══════════ */

function deleteHREmployee(id) {
  try {
    var emp = getHREmployeeById(id);
    if (!emp) return;

    var works = getWorkEntriesFor(id);
    var txs = getTransactionsFor(id);
    if (works.length > 0 || txs.length > 0) {
      if (typeof showToast === 'function') {
        showToast('Impossible : employé lié à ' + works.length + ' journée(s) et ' +
          txs.length + ' paiement(s). Supprime-les d\'abord.', 'error', 5000);
      }
      return;
    }

    var idx = hrEmployees.indexOf(emp);
    if (idx < 0) return;
    hrEmployees.splice(idx, 1);

    if (!trash || typeof trash !== 'object') trash = { clients: [], articles: [], documents: [] };
    if (!Array.isArray(trash.hrEmployees)) trash.hrEmployees = [];
    var entry = {
      item: emp,
      deletedAt: new Date().toISOString(),
      deletedBy: (currentUser && currentUser.username) || 'anon'
    };
    trash.hrEmployees.push(entry);

    if (typeof saveAll === 'function') saveAll();
    if (typeof logAction === 'function') logAction('hr.employee.delete', emp.nom);
    renderHR();

    if (typeof showUndoToast === 'function') {
      showUndoToast('Employé supprimé : ' + emp.nom,
        function () { _restoreDeletedHREmployee(entry, emp); }, 5000);
    }
  } catch (e) { console.warn('deleteHREmployee :', e); }
}

function _restoreDeletedHREmployee(entry, empObj) {
  try {
    if (!entry || !empObj) return;
    if (Array.isArray(trash.hrEmployees)) {
      var idx = trash.hrEmployees.indexOf(entry);
      if (idx >= 0) trash.hrEmployees.splice(idx, 1);
    }
    if (getHREmployeeById(empObj.id)) return;
    hrEmployees.push(empObj);
    if (typeof saveAll === 'function') saveAll();
    renderHR();
    if (typeof showToast === 'function') showToast('Employé restauré : ' + empObj.nom, 'success', 2500);
  } catch (e) { console.warn('_restoreDeletedHREmployee :', e); }
}

function deleteHRWorkEntry(id) {
  try {
    if (!Array.isArray(hrWorkEntries) || !id) return;
    var idx = hrWorkEntries.findIndex(function (w) { return w && String(w.id) === String(id); });
    if (idx < 0) return;
    var removed = hrWorkEntries[idx];
    hrWorkEntries.splice(idx, 1);

    if (!trash) trash = { clients: [], articles: [], documents: [] };
    if (!Array.isArray(trash.hrWorkEntries)) trash.hrWorkEntries = [];
    var entry = { item: removed, deletedAt: new Date().toISOString() };
    trash.hrWorkEntries.push(entry);

    if (typeof saveAll === 'function') saveAll();
    if (__hrDetailEmployeeId) _renderHRDetailBody();
    renderHR();

    if (typeof showUndoToast === 'function') {
      showUndoToast('Journée supprimée',
        function () {
          var i2 = trash.hrWorkEntries.indexOf(entry);
          if (i2 >= 0) trash.hrWorkEntries.splice(i2, 1);
          hrWorkEntries.push(removed);
          if (typeof saveAll === 'function') saveAll();
          if (__hrDetailEmployeeId) _renderHRDetailBody();
          renderHR();
        }, 5000);
    }
  } catch (e) { console.warn('deleteHRWorkEntry :', e); }
}

function deleteHRTx(id) {
  try {
    if (!Array.isArray(hrTransactions) || !id) return;
    var idx = hrTransactions.findIndex(function (t) { return t && String(t.id) === String(id); });
    if (idx < 0) return;
    var removed = hrTransactions[idx];
    hrTransactions.splice(idx, 1);

    if (!trash) trash = { clients: [], articles: [], documents: [] };
    if (!Array.isArray(trash.hrTransactions)) trash.hrTransactions = [];
    var entry = { item: removed, deletedAt: new Date().toISOString() };
    trash.hrTransactions.push(entry);

    if (typeof saveAll === 'function') saveAll();
    if (__hrDetailEmployeeId) _renderHRDetailBody();
    renderHR();

    if (typeof showUndoToast === 'function') {
      showUndoToast('Paiement supprimé',
        function () {
          var i2 = trash.hrTransactions.indexOf(entry);
          if (i2 >= 0) trash.hrTransactions.splice(i2, 1);
          hrTransactions.push(removed);
          if (typeof saveAll === 'function') saveAll();
          if (__hrDetailEmployeeId) _renderHRDetailBody();
          renderHR();
        }, 5000);
    }
  } catch (e) { console.warn('deleteHRTx :', e); }
}

/* ═══════════ SECTION 12 — RECHERCHE / FILTRES / PAGINATION ═══════════ */

function setHRSearch(term) {
  __hrSearchTerm = String(term || '');
  renderHR();
}

function setHRFilter(filter) {
  __hrFilter = filter || 'all';
  renderHR();
}

function setHRWorkPage(page) {
  window.__hrWorkPage = Math.max(0, parseInt(page, 10) || 0);
  _renderHRDetailBody();
}

function setHRTxPage(page) {
  window.__hrTxPage = Math.max(0, parseInt(page, 10) || 0);
  _renderHRDetailBody();
}

function _getFilteredHREmployees() {
  try {
    if (!Array.isArray(hrEmployees)) return [];
    var out = hrEmployees.slice();

    if (__hrSearchTerm) {
      var term = normalizeText(__hrSearchTerm);
      out = out.filter(function (e) {
        if (!e) return false;
        var hay = normalizeText([e.nom, e.poste, e.telephone].join(' '));
        return hay.indexOf(term) >= 0;
      });
    }

    if (__hrFilter === 'actifs') {
      out = out.filter(function (e) { return e.actif !== false; });
    } else if (__hrFilter === 'inactifs') {
      out = out.filter(function (e) { return e.actif === false; });
    } else if (__hrFilter === 'doivent') {
      out = out.filter(function (e) {
        return computeHREmployeeStats(e.id).balance > 0.01;
      });
    }

    out.sort(function (a, b) {
      var na = normalizeText(a.nom || '');
      var nb = normalizeText(b.nom || '');
      return na > nb ? 1 : (na < nb ? -1 : 0);
    });
    return out;
  } catch (e) { return []; }
}

/* ═══════════ SECTION 13 — IMPORT / EXPORT ═══════════ */

function exportHRJSON() {
  try {
    var data = {
      version: 1,
      exportedAt: new Date().toISOString(),
      employees: hrEmployees,
      workEntries: hrWorkEntries,
      transactions: hrTransactions
    };
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    var filename = 'voltcore-rh-' + todayISO() + '.json';
    if (typeof downloadBlob === 'function') downloadBlob(blob, filename);
    else _hrFallbackDownload(blob, filename);
    if (typeof showToast === 'function') {
      showToast((hrEmployees || []).length + ' employé(s) exporté(s)', 'success');
    }
  } catch (e) { console.warn('exportHRJSON :', e); }
}

/* v6.7 — Fallback download aligné sur 03-utils.js (30s au lieu de 1s). */
function _hrFallbackDownload(blob, filename) {
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
    console.warn('_hrFallbackDownload :', e);
  }
}

function importHRJSON(file, options) {
  return new Promise(function (resolve, reject) {
    try {
      if (!file) return reject(new Error('Fichier requis'));
      var mode = (options && options.mode) || 'merge';
      var reader = new FileReader();
      reader.onload = function (ev) {
        try {
          var parsed = JSON.parse(ev.target.result);
          if (!parsed || typeof parsed !== 'object') throw new Error('JSON invalide');

          var emps = Array.isArray(parsed.employees) ? parsed.employees : [];
          var works = Array.isArray(parsed.workEntries) ? parsed.workEntries : [];
          var txs = Array.isArray(parsed.transactions) ? parsed.transactions : [];

          var added = { employees: 0, workEntries: 0, transactions: 0 };
          if (mode === 'replace') { if (typeof _pushAllToTrashBeforeReplace === 'function') { _pushAllToTrashBeforeReplace('hrEmployees', hrEmployees); _pushAllToTrashBeforeReplace('hrWorkEntries', hrWorkEntries); _pushAllToTrashBeforeReplace('hrTransactions', hrTransactions); } hrEmployees = []; hrWorkEntries = []; hrTransactions = []; }

          for (var i = 0; i < emps.length; i++) {
            var clean = _normalizeEmployee(emps[i]);
            if (!clean) continue;
            if (hrEmployeeExists(clean.nom)) continue;
            hrEmployees.push(clean);
            added.employees++;
          }
          for (var j = 0; j < works.length; j++) {
            var cw = _normalizeWorkEntry(works[j]);
            if (cw) { hrWorkEntries.push(cw); added.workEntries++; }
          }
          for (var k = 0; k < txs.length; k++) {
            var ct = _normalizeTx(txs[k]);
            if (ct) { hrTransactions.push(ct); added.transactions++; }
          }

          if (typeof saveAll === 'function') saveAll();
          if (typeof logAction === 'function') logAction('hr.import', JSON.stringify(added));
          renderHR();
          if (typeof showToast === 'function') {
            showToast('Import RH : ' + added.employees + ' employé(s), ' +
              added.workEntries + ' journée(s), ' + added.transactions + ' paiement(s)',
              'success', 4000);
          }
          resolve(added);
        } catch (err) { reject(err); }
      };
      reader.onerror = function () { reject(reader.error || new Error('Lecture échouée')); };
      reader.readAsText(file);
    } catch (e) { reject(e); }
  });
}

function printHRRecap() {
  try {
    var emps = _getFilteredHREmployees();
    var html = '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>RH — VOLTCORE</title><style>' +
      'body{font-family:Arial;margin:20px;font-size:12px}' +
      'h1{color:#0b3d91;border-bottom:2px solid #0b3d91;padding-bottom:6px}' +
      'table{width:100%;border-collapse:collapse;margin-top:10px}' +
      'th,td{border:1px solid #ccc;padding:6px;text-align:left}' +
      'th{background:#f0f0f0}.right{text-align:right}' +
      '</style></head><body>';
    html += '<h1>Récap RH</h1><div>Total : ' + emps.length + ' · ' + todayISO() + '</div>';
    html += '<table><thead><tr><th>Nom</th><th>Poste</th><th>Téléphone</th>' +
      '<th class="right">Heures</th><th class="right">Total dû</th>' +
      '<th class="right">Total payé</th><th class="right">Balance</th>' +
      '</tr></thead><tbody>';
    var totDu = 0, totPaye = 0, totBal = 0;
    for (var i = 0; i < emps.length; i++) {
      var e = emps[i];
      var s = computeHREmployeeStats(e.id);
      totDu += s.totalDu; totPaye += s.totalPaye; totBal += s.balance;
      html += '<tr><td>' + escapeHtml(e.nom) + '</td><td>' + escapeHtml(e.poste || '') + '</td>' +
        '<td>' + escapeHtml(e.telephone || '') + '</td>' +
        '<td class="right">' + s.totalHeures.toFixed(1) + 'h</td>' +
        '<td class="right">' + formatMoney(s.totalDu) + '</td>' +
        '<td class="right">' + formatMoney(s.totalPaye) + '</td>' +
        '<td class="right">' + formatMoney(s.balance) + '</td></tr>';
    }
    html += '<tr style="background:#f0f0f0;font-weight:bold">' +
      '<td colspan="4">TOTAUX</td>' +
      '<td class="right">' + formatMoney(totDu) + '</td>' +
      '<td class="right">' + formatMoney(totPaye) + '</td>' +
      '<td class="right">' + formatMoney(totBal) + '</td></tr>';
    html += '</tbody></table></body></html>';

    var w = window.open('', '_blank');
    if (!w) { if (typeof showToast === 'function') showToast('Autorise les pop-ups.', 'warning'); return; }
    w.document.write(html); w.document.close();
    setTimeout(function () { try { w.print(); } catch (e) {} }, 500);
  } catch (e) { console.warn('printHRRecap :', e); }
}

/* ═══════════ SECTION 14 — ÉVÉNEMENTS ═══════════ */

function attachHREvents() {
  try {
    var searchInput = document.getElementById('hrSearchInput');
    if (searchInput && !searchInput.__bound) {
      searchInput.__bound = true;
      searchInput.addEventListener('input', debounce(function (ev) {
        setHRSearch(ev.target.value);
      }, 250));
    }

    var filterSel = document.getElementById('hrFilterSelect');
    if (filterSel && !filterSel.__bound) {
      filterSel.__bound = true;
      filterSel.addEventListener('change', function (ev) {
        setHRFilter(ev.target.value);
      });
    }

    var addBtn = document.getElementById('btnAddHREmployee');
    if (addBtn && !addBtn.__bound) {
      addBtn.__bound = true;
      addBtn.addEventListener('click', function () { openHREmployeeModal(null); });
    }

    var importBtn = document.getElementById('btnImportHR');
    if (importBtn && !importBtn.__bound) {
      importBtn.__bound = true;
      importBtn.addEventListener('click', function () {
        var input = document.createElement('input');
        input.type = 'file'; input.accept = '.json,application/json';
        input.onchange = function (ev) {
          var f = ev.target.files && ev.target.files[0];
          if (!f) return;
          importHRJSON(f, { mode: 'merge' }).catch(function (err) {
            if (typeof showToast === 'function') showToast('Import échoué : ' + (err.message || ''), 'error');
          });
        };
        input.click();
      });
    }

    var exportBtn = document.getElementById('btnExportHR');
    if (exportBtn && !exportBtn.__bound) {
      exportBtn.__bound = true;
      exportBtn.addEventListener('click', exportHRJSON);
    }

    var printBtn = document.getElementById('btnPrintHR');
    if (printBtn && !printBtn.__bound) {
      printBtn.__bound = true;
      printBtn.addEventListener('click', printHRRecap);
    }
  } catch (e) { console.warn('attachHREvents :', e); }
}

console.log('✅ 10-hr.js chargé — v6.7 (fallback download 30s)');