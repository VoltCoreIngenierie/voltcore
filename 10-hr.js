/* ═══════════════════════════════════════════════════════════
   VOLTCORE — 10-hr.js
   VERSION : v7.0.0
   RÔLE : RH complète — employés, journées travaillées,
          paiements, balance automatique, pagination.
          Normalisation + save + load + trash : gérés par Store.
   DÉPENDANCES : 00-core, 01-utils, 02-store, 09-chant
   ORDRE : 11ᵉ fichier chargé

   RÈGLES :
   - ES5 strict
   - Aucun catch silencieux
   - FIX C4 : _getWorkRate fallback employé si rate est 0/vide/null
   - FIX C5 : auto-fill rate au change du select employé
   - FIX M8 : deleteEmployee refuse si références existent
   ═══════════════════════════════════════════════════════════ */

'use strict';

(function (global) {

  if (!global.VOLTCORE || !global.VOLTCORE.Store || !global.VOLTCORE.Utils) {
    throw new Error('[10-hr] Modules requis non chargés');
  }

  var VC = global.VOLTCORE;
  var U = VC.Utils;
  var S = VC.Store;
  var Ch = VC.Chantiers;
  var HR = VC.HR || {};
  VC.HR = HR;

  /* ═══════════════════════════════════════════════════════════
     SECTION 1 — REGISTRATION STORE
     ═══════════════════════════════════════════════════════════ */

  S.register('hrEmployees', {
    type: 'array',
    saveKey: 'voltcore_hr_employees',
    default: [],
    idPrefix: 'emp',
    trash: true,
    backup: true,
    schema: {
      nom: 'string|required',
      poste: 'string',
      telephone: 'string',
      hourlyRate: 'float|0-99999999',
      dateEmbauche: 'date',
      actif: 'bool',
      notes: 'string'
    }
  });

  S.register('hrWorkEntries', {
    type: 'array',
    saveKey: 'voltcore_hr_work_entries',
    default: [],
    idPrefix: 'wrk',
    trash: true,
    backup: true,
    schema: {
      employeeId: 'string|required',
      date: 'date|required',
      hours: 'float|0.01-24',
      rate: 'float|0-99999999',
      chantierId: 'string',
      description: 'string'
    }
  });

  S.register('hrTransactions', {
    type: 'array',
    saveKey: 'voltcore_hr_transactions',
    default: [],
    idPrefix: 'tx',
    trash: true,
    backup: true,
    schema: {
      employeeId: 'string|required',
      date: 'date|required',
      montant: 'float|0.01-999999999',
      type: 'enum|salaire,avance,prime,autre',
      period: 'string',
      note: 'string'
    }
  });

  /* ═══════════════════════════════════════════════════════════
     SECTION 2 — ÉTAT INTERNE
     ═══════════════════════════════════════════════════════════ */

  var _searchTerm = '';
  var _filter = 'all';
  var _detailEmployeeId = null;
  var _detailTab = 'work';
  var _workPage = 0;
  var _txPage = 0;
  var _perPage = 50;

  var TX_TYPES = {
    salaire: 'Salaire',
    avance: 'Avance',
    prime: 'Prime',
    autre: 'Autre'
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 3 — HELPERS EMPLOYÉS
     ═══════════════════════════════════════════════════════════ */

  HR.getEmployeeById = function (id) {
    return S.getById('hrEmployees', id);
  };

  HR.getEmployeeNom = function (id) {
    var e = HR.getEmployeeById(id);
    return e ? String(e.nom || '') : '';
  };

  HR.employeeExists = function (nom, excludeId) {
    if (!nom) return false;
    var normalized = U.normalizeText(nom);
    var list = S.getAll('hrEmployees');
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      if (!e) continue;
      if (excludeId && String(e.id) === String(excludeId)) continue;
      if (U.normalizeText(e.nom || '') === normalized) return true;
    }
    return false;
  };

  HR.getEmployeeRate = function (emp) {
    if (!emp) return 0;
    if (typeof emp.hourlyRate === 'number') return emp.hourlyRate;
    if (typeof emp.tauxHoraire === 'number') return emp.tauxHoraire;
    return U.parseNumber(emp.hourlyRate != null ? emp.hourlyRate : emp.tauxHoraire);
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 4 — HELPERS JOURNÉES (FIX C4)
     ═══════════════════════════════════════════════════════════ */

  HR.getWorkHours = function (w) {
    if (!w) return 0;
    if (typeof w.hours === 'number') return w.hours;
    if (typeof w.heures === 'number') return w.heures;
    return U.parseNumber(w.hours != null ? w.hours : w.heures);
  };

  /**
   * FIX C4 : détermine le taux effectif d'une journée.
   *
   * Comportement :
   *   - Si w.rate > 0 → utilise le taux explicite
   *   - Sinon (0, vide, null, undefined) → fallback au taux de l'employé
   *
   * L'ancien code faisait `if (w.rate != null) return parseNumber(w.rate)`
   * ce qui retournait 0 si rate était une string vide '', car `'' != null`
   * est true en JS. Résultat : l'employé n'était pas payé.
   */
  HR.getWorkRate = function (w) {
    if (!w) return 0;

    var explicit = U.parseNumber(w.rate);
    if (explicit > 0) return explicit;

    var emp = HR.getEmployeeById(w.employeeId);
    return HR.getEmployeeRate(emp);
  };

  HR.getWorkEntriesFor = function (employeeId) {
    if (!employeeId) return [];
    var sid = String(employeeId);
    var all = S.getAll('hrWorkEntries');
    var out = all.filter(function (w) {
      return w && String(w.employeeId) === sid;
    });
    out.sort(function (a, b) {
      return String(b.date || '') > String(a.date || '') ? 1 : -1;
    });
    return out;
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 5 — HELPERS PAIEMENTS
     ═══════════════════════════════════════════════════════════ */

  HR.getTransactionsFor = function (employeeId) {
    if (!employeeId) return [];
    var sid = String(employeeId);
    var all = S.getAll('hrTransactions');
    var out = all.filter(function (t) {
      return t && String(t.employeeId) === sid;
    });
    out.sort(function (a, b) {
      return String(b.date || '') > String(a.date || '') ? 1 : -1;
    });
    return out;
  };

  HR.getTxTypeLabel = function (type) {
    return TX_TYPES[type] || type;
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 6 — STATISTIQUES (balance)
     ═══════════════════════════════════════════════════════════ */

  HR.getEmployeeStats = function (employeeId) {
    var empty = { totalDu: 0, totalPaye: 0, balance: 0, nbJours: 0, nbPaiements: 0, totalHeures: 0 };
    if (!employeeId) return empty;

    var works = HR.getWorkEntriesFor(employeeId);
    var totalDu = 0, totalHeures = 0;

    for (var i = 0; i < works.length; i++) {
      var w = works[i];
      var h = HR.getWorkHours(w);
      var r = HR.getWorkRate(w);
      totalHeures += h;
      totalDu += h * r;
    }

    var txs = HR.getTransactionsFor(employeeId);
    var totalPaye = 0;
    for (var j = 0; j < txs.length; j++) {
      totalPaye += U.parseNumber(txs[j].montant);
    }

    return {
      totalDu: totalDu,
      totalPaye: totalPaye,
      balance: totalDu - totalPaye,
      nbJours: works.length,
      nbPaiements: txs.length,
      totalHeures: totalHeures
    };
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 7 — RENDU LISTE
     ═══════════════════════════════════════════════════════════ */

  HR.render = function () {
    var container = document.getElementById('hrList');
    if (!container) return;

    var list = HR.getFiltered();
    if (list.length === 0) {
      container.innerHTML = '<div class="empty-state">Aucun employé' +
        (_searchTerm || _filter !== 'all' ? ' pour ce filtre' : '') +
        '. Clique sur "+ Nouvel employé" pour commencer.</div>';
      U.setText('hrCount', '0');
      return;
    }

    var html = '';
    for (var i = 0; i < list.length; i++) {
      html += HR.renderRow(list[i]);
    }
    container.innerHTML = html;
    U.setText('hrCount', String(list.length));
  };

  HR.renderRow = function (emp) {
    if (!emp) return '';

    var id = U.escapeAttr(emp.id);
    var nom = U.escapeHtml(emp.nom || '(Sans nom)');
    var poste = U.escapeHtml(emp.poste || '');
    var tel = U.escapeHtml(emp.telephone || '');

    var badges = '';
    if (emp.actif === false) badges += '<span class="badge badge-muted">Inactif</span> ';

    var stats = HR.getEmployeeStats(emp.id);
    var balColor = stats.balance > 0.01 ? 'var(--danger)'
      : stats.balance < -0.01 ? 'var(--success)' : 'var(--muted)';
    var balLabel = stats.balance > 0.01 ? 'dû'
      : stats.balance < -0.01 ? 'trop payé' : 'à jour';

    return '<div class="hr-row" data-employee-id="' + id + '">' +
      '<div class="hr-row-main">' +
        '<div class="hr-row-name">' + nom + ' ' + badges + '</div>' +
        '<div class="hr-row-meta">' +
          (poste ? poste + ' · ' : '') +
          (tel ? '📞 ' + tel : '') +
          (stats.nbJours > 0 ? ' · ' + stats.nbJours + ' jour(s)' : '') +
        '</div>' +
        '<div class="hr-row-balance" style="color:' + balColor + '">' +
          'Balance : ' + U.formatMoney(stats.balance) + ' (' + balLabel + ')' +
        '</div>' +
      '</div>' +
      '<div class="hr-row-actions">' +
        '<button type="button" class="btn-icon" title="Détail" ' +
        'onclick="VC.HR.openDetail(\'' + id + '\')">👁️</button>' +
        '<button type="button" class="btn-icon" title="Éditer" ' +
        'onclick="VC.HR.openEmployeeModal(\'' + id + '\')">✏️</button>' +
        '<button type="button" class="btn-icon" title="Journée" ' +
        'onclick="VC.HR.openWorkModal(\'' + id + '\')">📅</button>' +
        '<button type="button" class="btn-icon" title="Paiement" ' +
        'onclick="VC.HR.openTxModal(\'' + id + '\')">💰</button>' +
        '<button type="button" class="btn-icon btn-danger" title="Supprimer" ' +
        'onclick="VC.HR.removeEmployee(\'' + id + '\')">🗑️</button>' +
      '</div>' +
    '</div>';
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 8 — DÉTAIL (avec tabs)
     ═══════════════════════════════════════════════════════════ */

  HR.openDetail = function (id) {
    var emp = HR.getEmployeeById(id);
    if (!emp) {
      U.toast('Employé introuvable.', 'error');
      return;
    }

    _detailEmployeeId = String(id);
    _detailTab = 'work';
    _workPage = 0;
    _txPage = 0;

    U.setText('hrDetailTitle', emp.nom || 'Employé');
    _renderDetailBody();
    U.showFlex('hrDetailModal');
  };

  HR.closeDetail = function () {
    U.hide('hrDetailModal');
    _detailEmployeeId = null;
  };

  HR.switchDetailTab = function (tab) {
    _detailTab = (tab === 'tx') ? 'tx' : 'work';
    _renderDetailBody();
  };

  function _renderDetailBody() {
    var body = document.getElementById('hrDetailBody');
    if (!body || !_detailEmployeeId) return;

    var emp = HR.getEmployeeById(_detailEmployeeId);
    if (!emp) return;

    var stats = HR.getEmployeeStats(emp.id);
    var html = '';

    /* Bloc infos */
    html += '<div class="detail-section"><h3>Infos</h3><div class="detail-grid">';
    html += _detailItem('Poste', emp.poste || '—');
    html += _detailItem('Téléphone', emp.telephone || '—');
    html += _detailItem('Taux horaire', U.formatMoney(HR.getEmployeeRate(emp)));
    html += _detailItem('Date embauche', emp.dateEmbauche ? U.formatDate(emp.dateEmbauche) : '—');
    html += _detailItem('Statut', emp.actif === false ? 'Inactif' : 'Actif');
    html += '</div></div>';

    /* Bloc balance */
    html += '<div class="detail-section"><h3>Balance</h3><div class="stats-grid">';
    html += _statItem('Heures', stats.totalHeures.toFixed(1) + 'h');
    html += _statItem('Total dû', U.formatMoney(stats.totalDu));
    html += _statItem('Total payé', U.formatMoney(stats.totalPaye));
    var balColor = stats.balance > 0.01 ? 'var(--danger)'
      : stats.balance < -0.01 ? 'var(--success)' : 'var(--muted)';
    html += _statItem('Balance', U.formatMoney(stats.balance), balColor);
    html += '</div></div>';

    /* Tabs */
    html += '<div class="hr-tabs">';
    html += '<button type="button" class="hr-tab' + (_detailTab === 'work' ? ' active' : '') +
      '" onclick="VC.HR.switchDetailTab(\'work\')">📅 Journées (' + stats.nbJours + ')</button>';
    html += '<button type="button" class="hr-tab' + (_detailTab === 'tx' ? ' active' : '') +
      '" onclick="VC.HR.switchDetailTab(\'tx\')">💰 Paiements (' + stats.nbPaiements + ')</button>';
    html += '</div>';

    if (_detailTab === 'work') html += _renderWorkTab();
    else html += _renderTxTab();

    body.innerHTML = html;
  }

  function _renderWorkTab() {
    var works = HR.getWorkEntriesFor(_detailEmployeeId);
    var maxPage = Math.max(0, Math.ceil(works.length / _perPage) - 1);
    if (_workPage > maxPage) _workPage = maxPage;

    var start = _workPage * _perPage;
    var slice = works.slice(start, start + _perPage);

    var html = '<div class="hr-tab-content">';
    html += '<div class="hr-tab-actions">' +
      '<button type="button" class="btn btn-primary btn-sm" ' +
      'onclick="VC.HR.openWorkModal(\'' + U.escapeAttr(_detailEmployeeId) + '\')">+ Journée</button>' +
      '</div>';

    if (slice.length === 0) {
      html += '<div class="empty-state">Aucune journée enregistrée.</div>';
    } else {
      html += '<table class="hr-table"><thead><tr>' +
        '<th>Date</th><th>Heures</th><th>Taux</th><th>Chantier</th>' +
        '<th>Note</th><th></th></tr></thead><tbody>';
      for (var i = 0; i < slice.length; i++) {
        var w = slice[i];
        var taux = HR.getWorkRate(w);
        var chNom = w.chantierId ? Ch.getNom(w.chantierId) : '—';
        html += '<tr>' +
          '<td>' + U.escapeHtml(U.formatDate(w.date)) + '</td>' +
          '<td>' + HR.getWorkHours(w).toFixed(1) + 'h</td>' +
          '<td>' + U.formatMoney(taux) + '</td>' +
          '<td>' + U.escapeHtml(chNom || '—') + '</td>' +
          '<td>' + U.escapeHtml(w.description || '—') + '</td>' +
          '<td><button type="button" class="btn-icon btn-danger" ' +
          'onclick="VC.HR.removeWorkEntry(\'' + U.escapeAttr(w.id) + '\')">🗑️</button></td>' +
          '</tr>';
      }
      html += '</tbody></table>';
    }

    html += _renderPagination('work', _workPage, maxPage);
    html += '</div>';
    return html;
  }

  function _renderTxTab() {
    var txs = HR.getTransactionsFor(_detailEmployeeId);
    var maxPage = Math.max(0, Math.ceil(txs.length / _perPage) - 1);
    if (_txPage > maxPage) _txPage = maxPage;

    var start = _txPage * _perPage;
    var slice = txs.slice(start, start + _perPage);

    var html = '<div class="hr-tab-content">';
    html += '<div class="hr-tab-actions">' +
      '<button type="button" class="btn btn-primary btn-sm" ' +
      'onclick="VC.HR.openTxModal(\'' + U.escapeAttr(_detailEmployeeId) + '\')">+ Paiement</button>' +
      '</div>';

    if (slice.length === 0) {
      html += '<div class="empty-state">Aucun paiement enregistré.</div>';
    } else {
      html += '<table class="hr-table"><thead><tr>' +
        '<th>Date</th><th>Type</th><th>Montant</th><th>Note</th><th></th>' +
        '</tr></thead><tbody>';
      for (var i = 0; i < slice.length; i++) {
        var t = slice[i];
        html += '<tr>' +
          '<td>' + U.escapeHtml(U.formatDate(t.date)) + '</td>' +
          '<td>' + U.escapeHtml(HR.getTxTypeLabel(t.type)) + '</td>' +
          '<td>' + U.formatMoney(t.montant) + '</td>' +
          '<td>' + U.escapeHtml(t.note || '—') + '</td>' +
          '<td><button type="button" class="btn-icon btn-danger" ' +
          'onclick="VC.HR.removeTx(\'' + U.escapeAttr(t.id) + '\')">🗑️</button></td>' +
          '</tr>';
      }
      html += '</tbody></table>';
    }

    html += _renderPagination('tx', _txPage, maxPage);
    html += '</div>';
    return html;
  }

  function _renderPagination(kind, page, maxPage) {
    if (maxPage <= 0) return '';
    var fn = kind === 'work' ? 'setWorkPage' : 'setTxPage';
    return '<div class="hr-pagination">' +
      '<button type="button" class="btn btn-sm"' + (page <= 0 ? ' disabled' : '') +
      ' onclick="VC.HR.' + fn + '(' + (page - 1) + ')">◀ Précédent</button>' +
      '<span class="muted">Page ' + (page + 1) + ' / ' + (maxPage + 1) + '</span>' +
      '<button type="button" class="btn btn-sm"' + (page >= maxPage ? ' disabled' : '') +
      ' onclick="VC.HR.' + fn + '(' + (page + 1) + ')">Suivant ▶</button>' +
      '</div>';
  }

  HR.setWorkPage = function (p) {
    _workPage = Math.max(0, parseInt(p, 10) || 0);
    _renderDetailBody();
  };

  HR.setTxPage = function (p) {
    _txPage = Math.max(0, parseInt(p, 10) || 0);
    _renderDetailBody();
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
     SECTION 9 — FORM EMPLOYÉ
     ═══════════════════════════════════════════════════════════ */

  HR.openEmployeeModal = function (id) {
    var form = document.getElementById('hrEmployeeForm');
    if (form) form.reset();

    if (id) {
      var emp = HR.getEmployeeById(id);
      if (!emp) {
        U.toast('Employé introuvable.', 'error');
        return;
      }
      U.setText('hrEmployeeModalTitle', 'Modifier employé');
      U.setVal('hrEmployeeId', emp.id);
      U.setVal('hrEmployeeNom', emp.nom || '');
      U.setVal('hrEmployeePoste', emp.poste || '');
      U.setVal('hrEmployeeTelephone', emp.telephone || '');
      U.setVal('hrEmployeeRate', HR.getEmployeeRate(emp));
      U.setVal('hrEmployeeDate', emp.dateEmbauche || '');
      U.setVal('hrEmployeeNotes', emp.notes || '');
      U.setChecked('hrEmployeeActif', emp.actif !== false);
    } else {
      U.setText('hrEmployeeModalTitle', 'Nouvel employé');
      U.setVal('hrEmployeeId', '');
      U.setChecked('hrEmployeeActif', true);
    }

    U.setText('hrEmployeeFormError', '');
    U.showFlex('hrEmployeeModal');

    setTimeout(function () {
      try {
        var el = document.getElementById('hrEmployeeNom');
        if (el) el.focus();
      } catch (e) {
        VC.logError('10-hr', 'openEmployeeModal focus échoué', e);
      }
    }, 100);
  };

  HR.closeEmployeeModal = function () {
    U.hide('hrEmployeeModal');
  };

  HR.saveEmployeeFromForm = function () {
    var errEl = document.getElementById('hrEmployeeFormError');
    if (errEl) errEl.textContent = '';

    var id = U.getVal('hrEmployeeId');
    var nom = U.getVal('hrEmployeeNom');

    if (!nom) {
      if (errEl) errEl.textContent = 'Le nom est obligatoire.';
      return;
    }
    if (HR.employeeExists(nom, id)) {
      if (errEl) errEl.textContent = 'Un employé avec ce nom existe déjà.';
      return;
    }

    var raw = {
      id: id || undefined,
      nom: nom,
      poste: U.getVal('hrEmployeePoste'),
      telephone: U.getVal('hrEmployeeTelephone'),
      hourlyRate: U.getVal('hrEmployeeRate'),
      dateEmbauche: U.getVal('hrEmployeeDate'),
      notes: U.getVal('hrEmployeeNotes'),
      actif: U.getChecked('hrEmployeeActif')
    };

    var saved = S.save('hrEmployees', raw);
    if (!saved) {
      if (errEl) errEl.textContent = 'Données invalides.';
      return;
    }

    HR.closeEmployeeModal();
    U.toast(id ? 'Employé modifié' : 'Employé créé', 'success', 2500);
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 10 — FORM JOURNÉE (FIX C5)
     ═══════════════════════════════════════════════════════════ */

  HR.openWorkModal = function (employeeId) {
    var form = document.getElementById('hrWorkForm');
    if (form) form.reset();

    _populateEmployeesSelect('hrWorkEmployeeSelect', employeeId || '');
    _populateChantiersSelect('hrWorkChantierSelect', S.getValue('chantierActif') || '');

    U.setVal('hrWorkId', '');
    U.setVal('hrWorkEmployeeId', employeeId || '');
    U.setVal('hrWorkDate', U.todayISO());
    U.setVal('hrWorkHours', '8');

    /* FIX C5 : pré-remplit le taux si employé fourni */
    if (employeeId) {
      var emp = HR.getEmployeeById(employeeId);
      if (emp) {
        U.setVal('hrWorkRate', String(HR.getEmployeeRate(emp)));
      }
    } else {
      U.setVal('hrWorkRate', '');
    }

    U.setText('hrWorkFormError', '');
    U.showFlex('hrWorkModal');
  };

  function _populateEmployeesSelect(selectId, selectedId) {
    var employees = S.getAll('hrEmployees').filter(function (e) {
      return e && e.actif !== false;
    });
    employees.sort(function (a, b) {
      return U.normalizeText(a.nom || '') > U.normalizeText(b.nom || '') ? 1 : -1;
    });

    var items = [{ id: '', nom: '— Sélectionner —' }];
    for (var i = 0; i < employees.length; i++) {
      items.push({ id: employees[i].id, nom: employees[i].nom });
    }

    U.populateSelect(selectId, items, 'nom', 'id', selectedId || '');
  }

  function _populateChantiersSelect(selectId, selectedId) {
    var chantiers = S.getAll('chantiers').slice();
    chantiers.sort(function (a, b) {
      return U.normalizeText(a.nom || '') > U.normalizeText(b.nom || '') ? 1 : -1;
    });

    var items = [{ id: '', nom: '— Aucun —' }];
    for (var i = 0; i < chantiers.length; i++) {
      items.push({ id: chantiers[i].id, nom: chantiers[i].nom });
    }

    U.populateSelect(selectId, items, 'nom', 'id', selectedId || '');
  }

  HR.saveWorkFromForm = function () {
    var errEl = document.getElementById('hrWorkFormError');
    if (errEl) errEl.textContent = '';

    var empId = U.getVal('hrWorkEmployeeSelect') || U.getVal('hrWorkEmployeeId');
    var date = U.getVal('hrWorkDate');
    var hours = U.getVal('hrWorkHours');

    if (!empId) {
      if (errEl) errEl.textContent = 'Employé requis.';
      return;
    }
    if (!date) {
      if (errEl) errEl.textContent = 'Date requise.';
      return;
    }
    if (U.parseNumber(hours) <= 0) {
      if (errEl) errEl.textContent = 'Heures > 0 requises.';
      return;
    }

    var raw = {
      employeeId: empId,
      date: date,
      hours: hours,
      rate: U.getVal('hrWorkRate'),
      chantierId: U.getVal('hrWorkChantierSelect'),
      description: U.getVal('hrWorkDescription')
    };

    var saved = S.save('hrWorkEntries', raw);
    if (!saved) {
      if (errEl) errEl.textContent = 'Données invalides.';
      return;
    }

    U.hide('hrWorkModal');
    U.toast('Journée ajoutée', 'success', 2000);
    if (_detailEmployeeId) _renderDetailBody();
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 11 — FORM PAIEMENT
     ═══════════════════════════════════════════════════════════ */

  HR.openTxModal = function (employeeId) {
    var form = document.getElementById('hrTxForm');
    if (form) form.reset();

    _populateEmployeesSelect('hrTxEmployeeSelect', employeeId || '');

    U.setVal('hrTxEmployeeId', employeeId || '');
    U.setVal('hrTxDate', U.todayISO());

    /* Pré-remplit le montant avec le solde dû si > 0 */
    if (employeeId) {
      var stats = HR.getEmployeeStats(employeeId);
      if (stats.balance > 0.01) {
        U.setVal('hrTxMontant', stats.balance.toFixed(3));
      }
    } else {
      U.setVal('hrTxMontant', '');
    }

    U.setText('hrTxFormError', '');
    U.showFlex('hrTxModal');
  };

  HR.saveTxFromForm = function () {
    var errEl = document.getElementById('hrTxFormError');
    if (errEl) errEl.textContent = '';

    var empId = U.getVal('hrTxEmployeeSelect') || U.getVal('hrTxEmployeeId');
    var date = U.getVal('hrTxDate');
    var montant = U.getVal('hrTxMontant');

    if (!empId) {
      if (errEl) errEl.textContent = 'Employé requis.';
      return;
    }
    if (!date) {
      if (errEl) errEl.textContent = 'Date requise.';
      return;
    }
    if (U.parseNumber(montant) <= 0) {
      if (errEl) errEl.textContent = 'Montant > 0 requis.';
      return;
    }

    var raw = {
      employeeId: empId,
      date: date,
      montant: montant,
      type: U.getVal('hrTxType') || 'salaire',
      period: U.getVal('hrTxPeriod'),
      note: U.getVal('hrTxNote')
    };

    var saved = S.save('hrTransactions', raw);
    if (!saved) {
      if (errEl) errEl.textContent = 'Données invalides.';
      return;
    }

    U.hide('hrTxModal');
    U.toast('Paiement enregistré', 'success', 2000);
    if (_detailEmployeeId) _renderDetailBody();
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 12 — SUPPRESSION
     ═══════════════════════════════════════════════════════════ */

  HR.removeEmployee = function (id) {
    var emp = HR.getEmployeeById(id);
    if (!emp) return;

    var works = HR.getWorkEntriesFor(id);
    var txs = HR.getTransactionsFor(id);

    if (works.length > 0 || txs.length > 0) {
      U.toast('Impossible : employé lié à ' + works.length +
        ' journée(s) et ' + txs.length + ' paiement(s). Supprime-les d\'abord.',
        'error', 5000);
      return;
    }

    if (!U.confirm('Supprimer l\'employé "' + (emp.nom || '') + '" ?')) return;

    if (!S.delete('hrEmployees', id)) {
      U.toast('Erreur suppression.', 'error');
      return;
    }

    U.toastUndo('Employé supprimé : ' + (emp.nom || ''),
      function () { _restoreEmployee(id); }, 5000);
  };

  function _restoreEmployee(id) {
    var entries = S.getTrashEntries('hrEmployees');
    for (var i = 0; i < entries.length; i++) {
      if (entries[i].item && String(entries[i].item.id) === String(id)) {
        S.restoreFromTrash('hrEmployees', i);
        U.toast('Employé restauré', 'success', 2000);
        return;
      }
    }
  }

  HR.removeWorkEntry = function (id) {
    var entry = S.getById('hrWorkEntries', id);
    if (!entry) return;

    if (!U.confirm('Supprimer cette journée ?')) return;

    S.delete('hrWorkEntries', id);
    if (_detailEmployeeId) _renderDetailBody();

    U.toastUndo('Journée supprimée', function () {
      var entries = S.getTrashEntries('hrWorkEntries');
      for (var i = 0; i < entries.length; i++) {
        if (entries[i].item && String(entries[i].item.id) === String(id)) {
          S.restoreFromTrash('hrWorkEntries', i);
          if (_detailEmployeeId) _renderDetailBody();
          U.toast('Journée restaurée', 'success', 2000);
          return;
        }
      }
    }, 5000);
  };

  HR.removeTx = function (id) {
    var entry = S.getById('hrTransactions', id);
    if (!entry) return;

    if (!U.confirm('Supprimer ce paiement ?')) return;

    S.delete('hrTransactions', id);
    if (_detailEmployeeId) _renderDetailBody();

    U.toastUndo('Paiement supprimé', function () {
      var entries = S.getTrashEntries('hrTransactions');
      for (var i = 0; i < entries.length; i++) {
        if (entries[i].item && String(entries[i].item.id) === String(id)) {
          S.restoreFromTrash('hrTransactions', i);
          if (_detailEmployeeId) _renderDetailBody();
          U.toast('Paiement restauré', 'success', 2000);
          return;
        }
      }
    }, 5000);
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 13 — FILTRES
     ═══════════════════════════════════════════════════════════ */

  HR.setSearch = function (term) {
    _searchTerm = String(term || '');
    HR.render();
  };

  HR.setFilter = function (filter) {
    _filter = String(filter || 'all');
    HR.render();
  };

  HR.getFiltered = function () {
    var out = S.getAll('hrEmployees').slice();

    if (_searchTerm) {
      var term = U.normalizeText(_searchTerm);
      out = out.filter(function (e) {
        if (!e) return false;
        var hay = U.normalizeText([e.nom, e.poste, e.telephone].join(' '));
        return hay.indexOf(term) >= 0;
      });
    }

    if (_filter === 'actifs') {
      out = out.filter(function (e) { return e.actif !== false; });
    } else if (_filter === 'inactifs') {
      out = out.filter(function (e) { return e.actif === false; });
    } else if (_filter === 'doivent') {
      out = out.filter(function (e) {
        return HR.getEmployeeStats(e.id).balance > 0.01;
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
     SECTION 14 — IMPORT / EXPORT
     ═══════════════════════════════════════════════════════════ */

  HR.exportJSON = function () {
    var data = {
      version: 1,
      exportedAt: new Date().toISOString(),
      employees: S.getAll('hrEmployees'),
      workEntries: S.getAll('hrWorkEntries'),
      transactions: S.getAll('hrTransactions')
    };
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    U.downloadBlob(blob, 'voltcore-rh-' + U.todayISO() + '.json');
    U.toast('Export RH effectué', 'success');
  };

  HR.importJSON = function (file) {
    return new Promise(function (resolve, reject) {
      if (!file) {
        reject(new Error('Fichier requis'));
        return;
      }

      var reader = new FileReader();
      reader.onload = function (ev) {
        try {
          var parsed = JSON.parse(ev.target.result);
          if (!parsed || typeof parsed !== 'object') {
            reject(new Error('JSON invalide'));
            return;
          }

          var emps = Array.isArray(parsed.employees) ? parsed.employees : [];
          var works = Array.isArray(parsed.workEntries) ? parsed.workEntries : [];
          var txs = Array.isArray(parsed.transactions) ? parsed.transactions : [];

          var added = { employees: 0, workEntries: 0, transactions: 0 };

          for (var i = 0; i < emps.length; i++) {
            var cleanE = S.normalize('hrEmployees', emps[i]);
            if (cleanE && !HR.employeeExists(cleanE.nom)) {
              if (S.save('hrEmployees', cleanE)) added.employees++;
            }
          }
          for (var j = 0; j < works.length; j++) {
            var cleanW = S.normalize('hrWorkEntries', works[j]);
            if (cleanW && S.save('hrWorkEntries', cleanW)) added.workEntries++;
          }
          for (var k = 0; k < txs.length; k++) {
            var cleanT = S.normalize('hrTransactions', txs[k]);
            if (cleanT && S.save('hrTransactions', cleanT)) added.transactions++;
          }

          U.toast('Import RH : ' + added.employees + ' employé(s), ' +
            added.workEntries + ' journée(s), ' + added.transactions + ' paiement(s)',
            'success', 4000);

          resolve(added);
        } catch (err) {
          VC.logError('10-hr', 'importJSON parse échoué', err);
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
     SECTION 15 — IMPRESSION
     ═══════════════════════════════════════════════════════════ */

  HR.print = function () {
    var emps = HR.getFiltered();
    var html = '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>RH — VOLTCORE</title><style>' +
      'body{font-family:Arial;margin:20px;font-size:12px}' +
      'h1{color:#1A2B4C;border-bottom:2px solid #1A2B4C;padding-bottom:6px}' +
      'table{width:100%;border-collapse:collapse;margin-top:10px}' +
      'th,td{border:1px solid #ccc;padding:6px;text-align:left}' +
      'th{background:#f0f0f0}.right{text-align:right}' +
      '</style></head><body>';
    html += '<h1>Récap RH</h1><div>Total : ' + emps.length + ' · ' + U.todayISO() + '</div>';
    html += '<table><thead><tr><th>Nom</th><th>Poste</th><th>Téléphone</th>' +
      '<th class="right">Heures</th><th class="right">Total dû</th>' +
      '<th class="right">Total payé</th><th class="right">Balance</th>' +
      '</tr></thead><tbody>';

    var totDu = 0, totPaye = 0, totBal = 0;
    for (var i = 0; i < emps.length; i++) {
      var e = emps[i];
      var s = HR.getEmployeeStats(e.id);
      totDu += s.totalDu;
      totPaye += s.totalPaye;
      totBal += s.balance;
      html += '<tr><td>' + U.escapeHtml(e.nom) + '</td>' +
        '<td>' + U.escapeHtml(e.poste || '') + '</td>' +
        '<td>' + U.escapeHtml(e.telephone || '') + '</td>' +
        '<td class="right">' + s.totalHeures.toFixed(1) + 'h</td>' +
        '<td class="right">' + U.formatMoney(s.totalDu) + '</td>' +
        '<td class="right">' + U.formatMoney(s.totalPaye) + '</td>' +
        '<td class="right">' + U.formatMoney(s.balance) + '</td></tr>';
    }

    html += '<tr style="background:#f0f0f0;font-weight:bold">' +
      '<td colspan="3">TOTAUX</td>' +
      '<td class="right">—</td>' +
      '<td class="right">' + U.formatMoney(totDu) + '</td>' +
      '<td class="right">' + U.formatMoney(totPaye) + '</td>' +
      '<td class="right">' + U.formatMoney(totBal) + '</td></tr>';
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
        VC.logError('10-hr', 'print échoué', e);
      }
    }, 500);
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 16 — EVENTS
     ═══════════════════════════════════════════════════════════ */

  HR.attachEvents = function () {
    U.on('hrSearchInput', 'input', U.debounce(function (ev) {
      HR.setSearch(ev.target.value);
    }, 250));

    U.on('hrFilterSelect', 'change', function (ev) {
      HR.setFilter(ev.target.value);
    });

    U.on('btnAddHREmployee', 'click', function () {
      HR.openEmployeeModal(null);
    });

    U.on('btnImportHR', 'click', function () {
      var input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json,application/json';
      input.onchange = function (ev) {
        var f = ev.target.files && ev.target.files[0];
        if (!f) return;
        HR.importJSON(f).catch(function (err) {
          U.toast('Import échoué : ' + (err.message || ''), 'error');
        });
      };
      input.click();
    });

    U.on('btnExportHR', 'click', HR.exportJSON);
    U.on('btnPrintHR', 'click', HR.print);

    /* FIX C5 : auto-fill taux au change du select employé (journée) */
    U.on('hrWorkEmployeeSelect', 'change', function (ev) {
      var empId = ev.target.value;
      U.setVal('hrWorkEmployeeId', empId);
      var emp = HR.getEmployeeById(empId);
      if (emp) {
        U.setVal('hrWorkRate', String(HR.getEmployeeRate(emp)));
      }
    });

    /* Idem pour le paiement : sync hidden input */
    U.on('hrTxEmployeeSelect', 'change', function (ev) {
      U.setVal('hrTxEmployeeId', ev.target.value);
    });

    /* Subscribe pour re-render auto */
    S.subscribe('hrEmployees', function () { HR.render(); });
    S.subscribe('hrWorkEntries', function () {
      HR.render();
      if (_detailEmployeeId) _renderDetailBody();
    });
    S.subscribe('hrTransactions', function () {
      HR.render();
      if (_detailEmployeeId) _renderDetailBody();
    });
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 17 — MARQUEUR
     ═══════════════════════════════════════════════════════════ */

  VC._hrLoaded = true;

  VC.logInfo('10-hr', 'Module chargé');

})(window);