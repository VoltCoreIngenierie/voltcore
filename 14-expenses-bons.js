/* ═══════════════════════════════════════════════════════════════
   VOLTCORE — 14-expenses-bons.js
   VERSION : v6.7 (Session #3 — renommage _csvCellFrais pour éviter
                   la collision globale avec 06-clients.js, bump version)
   RÔLE : Notes de frais (9 catégories) + bons A/B/C/D imprimables
   DÉPENDANCES : 01-core.js (frais, currentBonType, currentBonData,
                            trash), 03-utils.js, 04-storage.js
                            (saveAll, incrementerNumeroBon, STORAGE_KEYS)
   EXPOSE : getFraisById, getFraisCategorieLabel, computeMonthlyFraisTotal,
            renderFrais, renderFraisRow, openFraisModal, closeFraisModal,
            saveFraisFromForm, deleteFrais,
            setFraisSearch, setFraisFilter, getFilteredFrais,
            exportFraisJSON, exportFraisCSV, importFraisJSON, printFraisList,
            attachExpensesBonsEvents
   NOTE v6.10.2 : sections Bons A/B/C/D supprimées (redondantes avec
                  module Bons Route 23-bons-route.js).
   SECTION 1  : CONSTANTES
   SECTION 2  : HELPERS FRAIS
   SECTION 3  : CALCULS FRAIS
   SECTION 4  : RENDU LISTE FRAIS
   SECTION 5  : FORM FRAIS
   SECTION 6  : SUPPRESSION FRAIS + UNDO
   SECTION 7  : FILTRES FRAIS
   SECTION 8  : HELPERS BONS
   SECTION 9  : ÉDITEUR BON
   SECTION 10 : IMPRESSION BON
   SECTION 11 : IMPORT / EXPORT FRAIS
   SECTION 12 : ÉVÉNEMENTS
   ═══════════════════════════════════════════════════════════════ */

/* ═══════════ SECTION 1 — CONSTANTES ═══════════ */

var FRAIS_CATEGORIES = [
  { id: 'transport',   label: 'Transport',   icon: '🚗' },
  { id: 'repas',       label: 'Repas',       icon: '🍽️' },
  { id: 'carburant',   label: 'Carburant',   icon: '⛽' },
  { id: 'fournitures', label: 'Fournitures', icon: '📚' },
  { id: 'loyer',       label: 'Loyer',       icon: '🏢' },
  { id: 'telephone',   label: 'Téléphone',   icon: '📱' },
  { id: 'assurance',   label: 'Assurance',   icon: '🛡️' },
  { id: 'salaires',    label: 'Salaires',    icon: '💰' },
  { id: 'autres',      label: 'Autres',      icon: '📝' }
];

/* v6.10.2 — BON_TYPES supprimé (bons A/B/C/D redondants avec Bons Route) */

var __fraisSearchTerm = '';
var __fraisFilter = 'all';

/* ═══════════ SECTION 2 — HELPERS FRAIS ═══════════ */

function getFraisById(id) {
  try {
    if (!id || !Array.isArray(frais)) return null;
    var sid = String(id);
    for (var i = 0; i < frais.length; i++) {
      if (frais[i] && String(frais[i].id) === sid) return frais[i];
    }
    return null;
  } catch (e) { return null; }
}

function getFraisCategorieLabel(catId) {
  for (var i = 0; i < FRAIS_CATEGORIES.length; i++) {
    if (FRAIS_CATEGORIES[i].id === catId) {
      return FRAIS_CATEGORIES[i].icon + ' ' + FRAIS_CATEGORIES[i].label;
    }
  }
  return '📝 Autres';
}

function _normalizeFrais(raw) {
  if (!raw || typeof raw !== 'object') return null;
  var montant = parseNumber(raw.montant);
  if (montant <= 0) return null;
  var cat = String(raw.categorie || 'autres').toLowerCase();
  var validCat = false;
  for (var i = 0; i < FRAIS_CATEGORIES.length; i++) {
    if (FRAIS_CATEGORIES[i].id === cat) { validCat = true; break; }
  }
  if (!validCat) cat = 'autres';
  return {
    id: raw.id || ('frais_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)),
    date: String(raw.date || todayISO()).slice(0, 10),
    categorie: cat,
    description: String(raw.description || '').trim(),
    montant: montant,
    chantierId: String(raw.chantierId || '').trim(),
    fournisseur: String(raw.fournisseur || '').trim(),
    notes: String(raw.notes || '').trim(),
    createdAt: raw.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function _fraisGet(id) {
  try { var el = document.getElementById(id); return el ? String(el.value || '').trim() : ''; } catch (e) { return ''; }
}
function _fraisSet(id, value) {
  try { var el = document.getElementById(id); if (el) el.value = value == null ? '' : value; } catch (e) {}
}
function _fraisText(id, text) {
  try { var el = document.getElementById(id); if (el) el.textContent = String(text || ''); } catch (e) {}
}

/* ═══════════ SECTION 3 — CALCULS FRAIS ═══════════ */

/* Total des frais pour un mois (YYYY-MM). */
function computeMonthlyFraisTotal(monthIso) {
  try {
    if (!Array.isArray(frais)) return 0;
    var prefix = String(monthIso || '').slice(0, 7);
    var total = 0;
    for (var i = 0; i < frais.length; i++) {
      var f = frais[i];
      if (!f) continue;
      if (prefix && String(f.date || '').slice(0, 7) !== prefix) continue;
      total += parseNumber(f.montant);
    }
    return total;
  } catch (e) { return 0; }
}

/* ═══════════ SECTION 4 — RENDU LISTE FRAIS ═══════════ */

function renderFrais() {
  try {
    var container = document.getElementById('fraisList');
    if (!container) return;

    var list = getFilteredFrais();
    if (list.length === 0) {
      container.innerHTML = '<div class="empty-state">Aucun frais' +
        (__fraisSearchTerm || __fraisFilter !== 'all' ? ' pour ce filtre' : '') +
        '. Clique sur "+ Nouveau frais" pour enregistrer une dépense.</div>';
      _updateFraisCount(0);
      _updateFraisTotal(0);
      return;
    }

    var html = '', total = 0;
    for (var i = 0; i < list.length; i++) {
      total += parseNumber(list[i].montant);
      html += renderFraisRow(list[i]);
    }
    container.innerHTML = html;
    _updateFraisCount(list.length);
    _updateFraisTotal(total);
  } catch (e) { console.warn('renderFrais :', e); }
}

function renderFraisRow(f) {
  try {
    if (!f) return '';
    var id = escapeAttr(f.id);
    var catLabel = getFraisCategorieLabel(f.categorie);
    var desc = escapeHtml(f.description || '');
    var chantierNom = f.chantierId && typeof getChantierNom === 'function'
      ? getChantierNom(f.chantierId) : '';

    return '<div class="frais-row" data-frais-id="' + id + '">' +
      '<div class="frais-row-main">' +
        '<div class="frais-row-header">' +
          '<span class="frais-cat">' + escapeHtml(catLabel) + '</span>' +
          ' <strong class="frais-montant">' + formatMoney(f.montant) + '</strong>' +
        '</div>' +
        '<div class="frais-row-meta">' +
          escapeHtml(formatDate(f.date)) +
          (desc ? ' · ' + desc : '') +
          (chantierNom ? ' · 🏗️ ' + escapeHtml(chantierNom) : '') +
        '</div>' +
      '</div>' +
      '<div class="frais-row-actions">' +
        '<button type="button" class="btn-icon" title="Éditer" ' +
          'onclick="openFraisModal(\'' + id + '\')">✏️</button>' +
        '<button type="button" class="btn-icon btn-danger" title="Supprimer" ' +
          'onclick="deleteFrais(\'' + id + '\')">🗑️</button>' +
      '</div>' +
    '</div>';
  } catch (e) { return ''; }
}

function _updateFraisCount(n) {
  try { var el = document.getElementById('fraisCount'); if (el) el.textContent = String(n); } catch (e) {}
}
function _updateFraisTotal(n) {
  try { var el = document.getElementById('fraisTotal'); if (el) el.textContent = formatMoney(n); } catch (e) {}
}

/* ═══════════ SECTION 5 — FORM FRAIS ═══════════ */

function openFraisModal(fraisId) {
  try {
    var modal = document.getElementById('fraisModal');
    if (!modal) return;

    _populateFraisCategories();
    _populateFraisChantierSelect('');

    if (fraisId) {
      var f = getFraisById(fraisId);
      if (!f) return;
      var title = document.getElementById('fraisModalTitle');
      if (title) title.textContent = 'Modifier frais';
      _fraisSet('fraisId', f.id);
      _fraisSet('fraisDate', f.date || todayISO());
      _fraisSet('fraisCategorie', f.categorie || 'autres');
      _fraisSet('fraisDescription', f.description || '');
      _fraisSet('fraisMontant', f.montant || '');
      _fraisSet('fraisFournisseur', f.fournisseur || '');
      _fraisSet('fraisNotes', f.notes || '');
      _populateFraisChantierSelect(f.chantierId || '');
    } else {
      var title2 = document.getElementById('fraisModalTitle');
      if (title2) title2.textContent = 'Nouveau frais';
      _fraisSet('fraisId', '');
      _fraisSet('fraisDate', todayISO());
      _fraisSet('fraisCategorie', 'autres');
      _fraisSet('fraisDescription', '');
      _fraisSet('fraisMontant', '');
      _fraisSet('fraisFournisseur', '');
      _fraisSet('fraisNotes', '');
    }

    var errEl = document.getElementById('fraisFormError');
    if (errEl) errEl.textContent = '';
    modal.style.display = 'flex';
  } catch (e) { console.warn('openFraisModal :', e); }
}

function closeFraisModal() {
  try {
    var m = document.getElementById('fraisModal');
    if (m) m.style.display = 'none';
  } catch (e) {}
}

function _populateFraisCategories() {
  try {
    var sel = document.getElementById('fraisCategorie');
    if (!sel) return;
    var html = '';
    for (var i = 0; i < FRAIS_CATEGORIES.length; i++) {
      var c = FRAIS_CATEGORIES[i];
      html += '<option value="' + c.id + '">' + c.icon + ' ' + escapeHtml(c.label) + '</option>';
    }
    sel.innerHTML = html;
  } catch (e) {}
}

function _populateFraisChantierSelect(selectedId) {
  try {
    var sel = document.getElementById('fraisChantierSelect');
    if (!sel) return;
    var html = '<option value="">— Aucun chantier —</option>';
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
  } catch (e) {}
}

function saveFraisFromForm() {
  try {
    var errEl = document.getElementById('fraisFormError');
    var id = _fraisGet('fraisId');
    var montant = parseNumber(_fraisGet('fraisMontant'));

    if (montant <= 0) {
      if (errEl) errEl.textContent = 'Montant > 0 requis.';
      return;
    }
    var date = _fraisGet('fraisDate');
    if (!isValidDateString(date)) {
      if (errEl) errEl.textContent = 'Date invalide.';
      return;
    }

    var raw = {
      id: id || undefined,
      date: date,
      categorie: _fraisGet('fraisCategorie'),
      description: _fraisGet('fraisDescription'),
      montant: montant,
      chantierId: _fraisGet('fraisChantierSelect'),
      fournisseur: _fraisGet('fraisFournisseur'),
      notes: _fraisGet('fraisNotes')
    };

    var clean = _normalizeFrais(raw);
    if (!clean) {
      if (errEl) errEl.textContent = 'Données invalides.';
      return;
    }

    if (id) {
      var existing = getFraisById(id);
      if (!existing) { if (errEl) errEl.textContent = 'Frais introuvable.'; return; }
      clean.createdAt = existing.createdAt;
      var idx = frais.indexOf(existing);
      frais[idx] = clean;
    } else {
      frais.push(clean);
    }

    if (typeof saveAll === 'function') saveAll();
    if (typeof logAction === 'function') {
      logAction(id ? 'frais.update' : 'frais.create',
        getFraisCategorieLabel(clean.categorie) + ' ' + formatMoney(clean.montant));
    }

    closeFraisModal();
    renderFrais();
    if (typeof showToast === 'function') {
      showToast(id ? 'Frais modifié' : 'Frais enregistré', 'success', 2500);
    }
  } catch (e) {
    console.warn('saveFraisFromForm :', e);
    var errEl2 = document.getElementById('fraisFormError');
    if (errEl2) errEl2.textContent = 'Erreur lors de l\'enregistrement.';
  }
}

/* ═══════════ SECTION 6 — SUPPRESSION FRAIS + UNDO ═══════════ */

function deleteFrais(id) {
  try {
    var f = getFraisById(id);
    if (!f) return;
    var idx = frais.indexOf(f);
    if (idx < 0) return;
    frais.splice(idx, 1);

    if (!trash || typeof trash !== 'object') trash = { clients: [], articles: [], documents: [] };
    if (!Array.isArray(trash.frais)) trash.frais = [];
    var entry = { item: f, deletedAt: new Date().toISOString() };
    trash.frais.push(entry);

    if (typeof saveAll === 'function') saveAll();
    if (typeof logAction === 'function') logAction('frais.delete', getFraisCategorieLabel(f.categorie));
    renderFrais();

    if (typeof showUndoToast === 'function') {
      showUndoToast('Frais supprimé : ' + formatMoney(f.montant),
        function () {
          var i2 = trash.frais.indexOf(entry);
          if (i2 >= 0) trash.frais.splice(i2, 1);
          if (!getFraisById(f.id)) frais.push(f);
          if (typeof saveAll === 'function') saveAll();
          renderFrais();
          if (typeof showToast === 'function') showToast('Frais restauré', 'success', 2000);
        }, 5000);
    }
  } catch (e) { console.warn('deleteFrais :', e); }
}

/* ═══════════ SECTION 7 — FILTRES FRAIS ═══════════ */

function setFraisSearch(term) {
  __fraisSearchTerm = String(term || '');
  renderFrais();
}

function setFraisFilter(filter) {
  __fraisFilter = filter || 'all';
  renderFrais();
}

function getFilteredFrais() {
  try {
    if (!Array.isArray(frais)) return [];
    var out = frais.slice();

    if (__fraisSearchTerm) {
      var term = normalizeText(__fraisSearchTerm);
      out = out.filter(function (f) {
        if (!f) return false;
        var hay = normalizeText([f.description, f.fournisseur, f.notes, getFraisCategorieLabel(f.categorie)].join(' '));
        return hay.indexOf(term) >= 0;
      });
    }

    var fil = __fraisFilter;
    if (fil === 'mois_courant') {
      var prefix = todayISO().slice(0, 7);
      out = out.filter(function (f) { return String(f.date || '').slice(0, 7) === prefix; });
    } else if (fil && fil.indexOf('cat:') === 0) {
      var cat = fil.slice(4);
      out = out.filter(function (f) { return f.categorie === cat; });
    }

    out.sort(function (a, b) {
      var da = String(a.date || ''), db = String(b.date || '');
      return da < db ? 1 : (da > db ? -1 : 0);
    });
    return out;
  } catch (e) { return []; }
}

/* v6.10.2 — Sections 8, 9, 10 (Bons A/B/C/D) supprimées.
   Remplacement fonctionnel : module Bons Route (23-bons-route.js)
   qui gère sortie/commande/déplacement avec workflow complet. */

/* ═══════════ SECTION 11 — IMPORT / EXPORT FRAIS ═══════════ */
function exportFraisJSON() {
  try {
    var data = {
      version: 1,
      exportedAt: new Date().toISOString(),
      count: frais.length,
      frais: frais
    };
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    var filename = 'voltcore-frais-' + todayISO() + '.json';
    if (typeof downloadBlob === 'function') downloadBlob(blob, filename);
    if (typeof showToast === 'function') showToast(frais.length + ' frais exporté(s)', 'success');
  } catch (e) { console.warn('exportFraisJSON :', e); }
}

function exportFraisCSV() {
  try {
    var lines = [];
    lines.push(['Date', 'Catégorie', 'Description', 'Montant', 'Chantier', 'Fournisseur', 'Notes'].join('\t'));
    for (var i = 0; i < frais.length; i++) {
      var f = frais[i];
      if (!f) continue;
      var chNom = f.chantierId && typeof getChantierNom === 'function' ? getChantierNom(f.chantierId) : '';
      lines.push([
        _csvCellFrais(f.date),
        _csvCellFrais(getFraisCategorieLabel(f.categorie)),
        _csvCellFrais(f.description),
        String(parseNumber(f.montant)),
        _csvCellFrais(chNom),
        _csvCellFrais(f.fournisseur),
        _csvCellFrais(f.notes)
      ].join('\t'));
    }
    var csv = '\uFEFF' + lines.join('\r\n');
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    var filename = 'voltcore-frais-' + todayISO() + '.csv';
    if (typeof downloadBlob === 'function') downloadBlob(blob, filename);
    if (typeof showToast === 'function') showToast('CSV exporté', 'success');
  } catch (e) { console.warn('exportFraisCSV :', e); }
}

/* v6.7 — Renommé _csvCell → _csvCellFrais pour éviter la collision
   globale avec _csvCellClients de 06-clients.js. Chaque fichier a
   désormais son propre helper CSV, plus de dépendance silencieuse
   à l'ordre de chargement. */
function _csvCellFrais(v) {
  return String(v == null ? '' : v).replace(/\t/g, ' ').replace(/\r?\n/g, ' ');
}

function importFraisJSON(file, options) {
  return new Promise(function (resolve, reject) {
    try {
      if (!file) return reject(new Error('Fichier requis'));
      if (typeof checkImportRate === 'function' && !checkImportRate()) {
        return reject(new Error('Trop rapide — attends 2 secondes.'));
      }
      var mode = (options && options.mode) || 'merge';
      var reader = new FileReader();
      reader.onload = function (ev) {
        try {
          var parsed = JSON.parse(ev.target.result);
          var arr = Array.isArray(parsed) ? parsed
                    : (parsed && Array.isArray(parsed.frais)) ? parsed.frais : null;
          if (!arr) throw new Error('Format invalide : frais[] attendu');

          var added = 0, invalid = 0;
          if (mode === 'replace') { if (typeof _pushAllToTrashBeforeReplace === 'function') _pushAllToTrashBeforeReplace('frais', frais); frais = []; }
          for (var i = 0; i < arr.length; i++) {
            var clean = _normalizeFrais(arr[i]);
            if (!clean) { invalid++; continue; }
            frais.push(clean);
            added++;
          }
          if (typeof saveAll === 'function') saveAll();
          if (typeof logAction === 'function') logAction('frais.import', added + ' ajoutés');
          renderFrais();
          if (typeof showToast === 'function') {
            showToast(added + ' frais importé(s)' + (invalid ? ' · ' + invalid + ' invalide(s)' : ''),
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

function printFraisList() {
  try {
    var list = getFilteredFrais();
    var html = '<!DOCTYPE html><html><head><meta charset="UTF-8">' +
      '<title>Frais — VOLTCORE</title><style>' +
      'body{font-family:Arial;margin:20px;font-size:11px}' +
      'h1{color:#0b3d91;border-bottom:2px solid #0b3d91;padding-bottom:6px}' +
      'table{width:100%;border-collapse:collapse;margin-top:10px}' +
      'th,td{border:1px solid #ccc;padding:6px;text-align:left}' +
      'th{background:#0b3d91;color:#fff}.right{text-align:right}' +
      '</style></head><body>';
    html += '<h1>Notes de frais</h1><div>Total : ' + list.length + ' · ' + todayISO() + '</div>';
    html += '<table><thead><tr><th>Date</th><th>Catégorie</th><th>Description</th>' +
      '<th>Chantier</th><th class="right">Montant</th></tr></thead><tbody>';
    var sum = 0;
    for (var i = 0; i < list.length; i++) {
      var f = list[i];
      var chNom = f.chantierId && typeof getChantierNom === 'function' ? getChantierNom(f.chantierId) : '—';
      sum += parseNumber(f.montant);
      html += '<tr><td>' + escapeHtml(formatDate(f.date)) + '</td>' +
        '<td>' + escapeHtml(getFraisCategorieLabel(f.categorie)) + '</td>' +
        '<td>' + escapeHtml(f.description || '—') + '</td>' +
        '<td>' + escapeHtml(chNom) + '</td>' +
        '<td class="right">' + formatMoney(parseNumber(f.montant)) + '</td></tr>';
    }
    html += '<tr style="background:#f0f0f0;font-weight:bold"><td colspan="4">TOTAL</td>' +
      '<td class="right">' + formatMoney(sum) + '</td></tr>';
    html += '</tbody></table></body></html>';

    var w = window.open('', '_blank');
    if (!w) { if (typeof showToast === 'function') showToast('Autorise les pop-ups.', 'warning'); return; }
    w.document.write(html); w.document.close();
    setTimeout(function () { try { w.print(); } catch (e) {} }, 500);
  } catch (e) { console.warn('printFraisList :', e); }
}

/* ═══════════ SECTION 12 — ÉVÉNEMENTS ═══════════ */

function attachExpensesBonsEvents() {
  try {
    /* ── FRAIS ── */
    _populateFraisCategories();

    var fraisFilterSel = document.getElementById('fraisFilterSelect');
    if (fraisFilterSel && !fraisFilterSel.__bound) {
      fraisFilterSel.__bound = true;
      var fHtml = '<option value="all">Toutes</option><option value="mois_courant">Mois courant</option>';
      for (var ci = 0; ci < FRAIS_CATEGORIES.length; ci++) {
        fHtml += '<option value="cat:' + FRAIS_CATEGORIES[ci].id + '">' +
          FRAIS_CATEGORIES[ci].icon + ' ' + escapeHtml(FRAIS_CATEGORIES[ci].label) + '</option>';
      }
      fraisFilterSel.innerHTML = fHtml;
      fraisFilterSel.addEventListener('change', function (ev) {
        setFraisFilter(ev.target.value);
      });
    }

    var fraisSearch = document.getElementById('fraisSearchInput');
    if (fraisSearch && !fraisSearch.__bound) {
      fraisSearch.__bound = true;
      fraisSearch.addEventListener('input', debounce(function (ev) {
        setFraisSearch(ev.target.value);
      }, 250));
    }

    var addFraisBtn = document.getElementById('btnAddFrais');
    if (addFraisBtn && !addFraisBtn.__bound) {
      addFraisBtn.__bound = true;
      addFraisBtn.addEventListener('click', function () { openFraisModal(null); });
    }

    var saveFraisBtn = document.getElementById('fraisSaveBtn');
    if (saveFraisBtn && !saveFraisBtn.__bound) {
      saveFraisBtn.__bound = true;
      saveFraisBtn.addEventListener('click', saveFraisFromForm);
    }

    var importFraisBtn = document.getElementById('btnImportFrais');
    if (importFraisBtn && !importFraisBtn.__bound) {
      importFraisBtn.__bound = true;
      importFraisBtn.addEventListener('click', function () {
        var input = document.createElement('input');
        input.type = 'file'; input.accept = '.json,application/json';
        input.onchange = function (ev) {
          var f = ev.target.files && ev.target.files[0];
          if (!f) return;
          importFraisJSON(f, { mode: 'merge' }).catch(function (err) {
            if (typeof showToast === 'function') showToast('Import échoué : ' + (err.message || ''), 'error');
          });
        };
        input.click();
      });
    }

    var exportFraisBtn = document.getElementById('btnExportFraisJSON');
    if (exportFraisBtn && !exportFraisBtn.__bound) {
      exportFraisBtn.__bound = true;
      exportFraisBtn.addEventListener('click', exportFraisJSON);
    }

    var exportFraisCsvBtn = document.getElementById('btnExportFraisCSV');
    if (exportFraisCsvBtn && !exportFraisCsvBtn.__bound) {
      exportFraisCsvBtn.__bound = true;
      exportFraisCsvBtn.addEventListener('click', exportFraisCSV);
    }

    var printFraisBtn = document.getElementById('btnPrintFrais');
    if (printFraisBtn && !printFraisBtn.__bound) {
      printFraisBtn.__bound = true;
      printFraisBtn.addEventListener('click', printFraisList);
    }

    /* v6.10.2 — Binds Bons A/B/C/D supprimés (voir module Bons Route) */
  } catch (e) { console.warn('attachExpensesBonsEvents :', e); }
}

console.log('✅ 14-expenses-bons.js chargé — v6.10.2 (frais seuls, bons A/B/C/D supprimés)');