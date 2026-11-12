/* ═══════════════════════════════════════════════════════════
   VOLTCORE — 15-frais.js
   VERSION : v7.0.0
   RÔLE : Notes de frais (9 catégories), import/export, impression.
          Normalisation + save + load + trash : gérés par Store.
   DÉPENDANCES : 00-core, 01-utils, 02-store, 09-chant
   ORDRE : 16ᵉ fichier chargé

   RÈGLES :
   - ES5 strict
   - Aucun catch silencieux
   - Ne JAMAIS lire/écrire localStorage directement
   ═══════════════════════════════════════════════════════════ */

'use strict';

(function (global) {

  if (!global.VOLTCORE || !global.VOLTCORE.Store || !global.VOLTCORE.Utils) {
    throw new Error('[15-frais] Modules requis non chargés');
  }

  var VC = global.VOLTCORE;
  var U = VC.Utils;
  var S = VC.Store;
  var Ch = VC.Chantiers;
  var F = VC.Frais || {};
  VC.Frais = F;

  /* ═══════════════════════════════════════════════════════════
     SECTION 1 — REGISTRATION STORE
     ═══════════════════════════════════════════════════════════ */

  S.register('frais', {
    type: 'array',
    saveKey: 'voltcore_frais',
    default: [],
    idPrefix: 'frais',
    trash: true,
    backup: true,
    schema: {
      date: 'date|required',
      categorie: 'enum|transport,repas,carburant,fournitures,loyer,telephone,assurance,salaires,banque,autres',
      description: 'string',
      /* FIX R-frais : required + plage commençant à 0.01 → 0 est rejeté */
      montant: 'float|0.01-999999999|required',
      chantierId: 'string',
      fournisseur: 'string',
      notes: 'string'
    }
  });

  /* ═══════════════════════════════════════════════════════════
     SECTION 2 — CONSTANTES + ÉTAT
     ═══════════════════════════════════════════════════════════ */

  var CATEGORIES = [
    { id: 'transport',   label: 'Transport',   icon: '🚗' },
    { id: 'repas',       label: 'Repas',       icon: '🍽️' },
    { id: 'carburant',   label: 'Carburant',   icon: '⛽' },
    { id: 'fournitures', label: 'Fournitures', icon: '📚' },
    { id: 'loyer',       label: 'Loyer',       icon: '🏢' },
    { id: 'telephone',   label: 'Téléphone',   icon: '📱' },
    { id: 'assurance',   label: 'Assurance',   icon: '🛡️' },
    { id: 'salaires',    label: 'Salaires',    icon: '💰' },
    { id: 'banque',      label: 'Banque',      icon: '🏦' },
    { id: 'autres',      label: 'Autres',      icon: '📝' }
  ];

  var _searchTerm = '';
  var _filter = 'all';

  /* ═══════════════════════════════════════════════════════════
     SECTION 3 — HELPERS
     ═══════════════════════════════════════════════════════════ */

  F.getById = function (id) {
    return S.getById('frais', id);
  };

  F.getCategorieLabel = function (catId) {
    for (var i = 0; i < CATEGORIES.length; i++) {
      if (CATEGORIES[i].id === catId) {
        return CATEGORIES[i].icon + ' ' + CATEGORIES[i].label;
      }
    }
    return '📝 Autres';
  };

  F.computeMonthlyTotal = function (monthIso) {
    var prefix = String(monthIso || '').slice(0, 7);
    var total = 0;
    var list = S.getAll('frais');

    for (var i = 0; i < list.length; i++) {
      var f = list[i];
      if (!f) continue;
      if (prefix && String(f.date || '').slice(0, 7) !== prefix) continue;
      total += U.parseNumber(f.montant);
    }
    return total;
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 4 — RENDU LISTE
     ═══════════════════════════════════════════════════════════ */

  F.render = function () {
    var container = document.getElementById('fraisList');
    if (!container) return;

    var list = F.getFiltered();
    if (list.length === 0) {
      container.innerHTML = '<div class="empty-state">Aucun frais' +
        (_searchTerm || _filter !== 'all' ? ' pour ce filtre' : '') +
        '. Clique sur "+ Nouveau frais" pour enregistrer une dépense.</div>';
      U.setText('fraisCount', '0');
      U.setText('fraisTotal', '0 DT');
      return;
    }

    var html = '';
    var total = 0;
    for (var i = 0; i < list.length; i++) {
      total += U.parseNumber(list[i].montant);
      html += F.renderRow(list[i]);
    }
    container.innerHTML = html;
    U.setText('fraisCount', String(list.length));
    U.setText('fraisTotal', U.formatMoney(total));
  };

  F.renderRow = function (f) {
    if (!f) return '';

    var id = U.escapeAttr(f.id);
    var catLabel = F.getCategorieLabel(f.categorie);
    var desc = U.escapeHtml(f.description || '');
    var chantierNom = f.chantierId && Ch ? Ch.getNom(f.chantierId) : '';

    return '<div class="frais-row" data-frais-id="' + id + '">' +
      '<div class="frais-row-main">' +
        '<div class="frais-row-header">' +
          '<span class="frais-cat">' + U.escapeHtml(catLabel) + '</span>' +
          ' <strong class="frais-montant">' + U.formatMoney(f.montant) + '</strong>' +
        '</div>' +
        '<div class="frais-row-meta">' +
          U.escapeHtml(U.formatDate(f.date)) +
          (desc ? ' · ' + desc : '') +
          (chantierNom ? ' · 🏗️ ' + U.escapeHtml(chantierNom) : '') +
        '</div>' +
      '</div>' +
      '<div class="frais-row-actions">' +
        '<button type="button" class="btn-icon" title="Éditer" ' +
        'onclick="VC.Frais.openModal(\'' + id + '\')">✏️</button>' +
        '<button type="button" class="btn-icon btn-danger" title="Supprimer" ' +
        'onclick="VC.Frais.remove(\'' + id + '\')">🗑️</button>' +
      '</div>' +
    '</div>';
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 5 — FORMULAIRE
     ═══════════════════════════════════════════════════════════ */

  F.openModal = function (id) {
    var form = document.getElementById('fraisForm');
    if (form) form.reset();

    _populateCategories();
    _populateChantiersSelect('');

    if (id) {
      var f = F.getById(id);
      if (!f) {
        U.toast('Frais introuvable.', 'error');
        return;
      }
      U.setText('fraisModalTitle', 'Modifier frais');
      U.setVal('fraisId', f.id);
      U.setVal('fraisDate', f.date || U.todayISO());
      U.setVal('fraisCategorie', f.categorie || 'autres');
      U.setVal('fraisDescription', f.description || '');
      U.setVal('fraisMontant', f.montant || '');
      U.setVal('fraisFournisseur', f.fournisseur || '');
      U.setVal('fraisNotes', f.notes || '');
      _populateChantiersSelect(f.chantierId || '');
    } else {
      U.setText('fraisModalTitle', 'Nouveau frais');
      U.setVal('fraisId', '');
      U.setVal('fraisDate', U.todayISO());
      U.setVal('fraisCategorie', 'autres');
      U.setVal('fraisDescription', '');
      U.setVal('fraisMontant', '');
      U.setVal('fraisFournisseur', '');
      U.setVal('fraisNotes', '');
    }

    U.setText('fraisFormError', '');
    U.showFlex('fraisModal');

    setTimeout(function () {
      try {
        var el = document.getElementById('fraisMontant');
        if (el) el.focus();
      } catch (e) {
        VC.logError('15-frais', 'openModal focus échoué', e);
      }
    }, 100);
  };

  F.closeModal = function () {
    U.hide('fraisModal');
  };

  function _populateCategories() {
    var sel = document.getElementById('fraisCategorie');
    if (!sel) return;

    var html = '';
    for (var i = 0; i < CATEGORIES.length; i++) {
      var c = CATEGORIES[i];
      html += '<option value="' + c.id + '">' + c.icon + ' ' +
        U.escapeHtml(c.label) + '</option>';
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
    U.populateSelect('fraisChantierSelect', items, 'nom', 'id', selectedId || '');
  }

  F.saveFromForm = function () {
    var errEl = document.getElementById('fraisFormError');
    if (errEl) errEl.textContent = '';

    var id = U.getVal('fraisId');
    var montant = U.parseNumber(U.getVal('fraisMontant'));
    var date = U.getVal('fraisDate');

    if (montant <= 0) {
      if (errEl) errEl.textContent = 'Montant > 0 requis.';
      return;
    }
    if (!U.isValidDateString(date)) {
      if (errEl) errEl.textContent = 'Date invalide.';
      return;
    }

    var raw = {
      id: id || undefined,
      date: date,
      categorie: U.getVal('fraisCategorie') || 'autres',
      description: U.getVal('fraisDescription'),
      montant: montant,
      chantierId: U.getVal('fraisChantierSelect'),
      fournisseur: U.getVal('fraisFournisseur'),
      notes: U.getVal('fraisNotes')
    };

    var saved = S.save('frais', raw);
    if (!saved) {
      if (errEl) errEl.textContent = 'Données invalides.';
      return;
    }

    F.closeModal();
    U.toast(id ? 'Frais modifié' : 'Frais enregistré', 'success', 2500);
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 6 — SUPPRESSION
     ═══════════════════════════════════════════════════════════ */

  F.remove = function (id) {
    var f = F.getById(id);
    if (!f) return;

    if (!U.confirm('Supprimer ce frais (' + U.formatMoney(f.montant) + ') ?')) return;

    if (!S.delete('frais', id)) {
      U.toast('Erreur suppression.', 'error');
      return;
    }

    U.toastUndo('Frais supprimé : ' + U.formatMoney(f.montant),
      function () { _restore(id); }, 5000);
  };

  function _restore(id) {
    var entries = S.getTrashEntries('frais');
    for (var i = 0; i < entries.length; i++) {
      if (entries[i].item && String(entries[i].item.id) === String(id)) {
        S.restoreFromTrash('frais', i);
        U.toast('Frais restauré', 'success', 2000);
        return;
      }
    }
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 7 — FILTRES
     ═══════════════════════════════════════════════════════════ */

  F.setSearch = function (term) {
    _searchTerm = String(term || '');
    F.render();
  };

  F.setFilter = function (filter) {
    _filter = String(filter || 'all');
    F.render();
  };

  F.getFiltered = function () {
    var out = S.getAll('frais').slice();

    if (_searchTerm) {
      var term = U.normalizeText(_searchTerm);
      out = out.filter(function (f) {
        if (!f) return false;
        var hay = U.normalizeText([
          f.description, f.fournisseur, f.notes,
          F.getCategorieLabel(f.categorie)
        ].join(' '));
        return hay.indexOf(term) >= 0;
      });
    }

    if (_filter === 'mois_courant') {
      var prefix = U.todayISO().slice(0, 7);
      out = out.filter(function (f) {
        return String(f.date || '').slice(0, 7) === prefix;
      });
    } else if (_filter.indexOf('cat:') === 0) {
      var cat = _filter.slice(4);
      out = out.filter(function (f) { return f.categorie === cat; });
    }

    out.sort(function (a, b) {
      var da = String(a.date || '');
      var db = String(b.date || '');
      return da < db ? 1 : (da > db ? -1 : 0);
    });

    return out;
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 8 — IMPORT / EXPORT
     ═══════════════════════════════════════════════════════════ */

  F.exportJSON = function () {
    var arr = S.getAll('frais');
    var data = {
      version: 1,
      exportedAt: new Date().toISOString(),
      count: arr.length,
      frais: arr
    };
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    U.downloadBlob(blob, 'voltcore-frais-' + U.todayISO() + '.json');
    U.toast(arr.length + ' frais exporté(s)', 'success');
  };

  F.exportCSV = function () {
    var arr = S.getAll('frais');
    var lines = [];
    lines.push([
      'Date', 'Catégorie', 'Description', 'Montant',
      'Chantier', 'Fournisseur', 'Notes'
    ].join('\t'));

    for (var i = 0; i < arr.length; i++) {
      var f = arr[i];
      if (!f) continue;
      var chNom = f.chantierId && Ch ? Ch.getNom(f.chantierId) : '';
      lines.push([
        _csv(f.date),
        _csv(F.getCategorieLabel(f.categorie)),
        _csv(f.description),
        String(U.parseNumber(f.montant)),
        _csv(chNom),
        _csv(f.fournisseur),
        _csv(f.notes)
      ].join('\t'));
    }

    var csv = '\uFEFF' + lines.join('\r\n');
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    U.downloadBlob(blob, 'voltcore-frais-' + U.todayISO() + '.csv');
    U.toast('CSV exporté', 'success');
  };

  function _csv(v) {
    return String(v == null ? '' : v).replace(/\t/g, ' ').replace(/\r?\n/g, ' ');
  }

  F.importJSON = function (file) {
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
            : (parsed && Array.isArray(parsed.frais)) ? parsed.frais : null;
          if (!arr) {
            reject(new Error('Format invalide : frais[] attendu'));
            return;
          }

          var added = 0, invalid = 0;
          for (var i = 0; i < arr.length; i++) {
            var clean = S.normalize('frais', arr[i]);
            if (!clean) { invalid++; continue; }
            if (S.save('frais', clean)) added++;
            else invalid++;
          }

          var msg = added + ' frais importé(s)';
          if (invalid > 0) msg += ' · ' + invalid + ' invalide(s)';
          U.toast(msg, added > 0 ? 'success' : 'warning', 4000);

          resolve({ added: added, invalid: invalid });
        } catch (err) {
          VC.logError('15-frais', 'importJSON parse échoué', err);
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
     SECTION 9 — IMPRESSION
     ═══════════════════════════════════════════════════════════ */

  F.print = function () {
    var list = F.getFiltered();
    var html = '<!DOCTYPE html><html><head><meta charset="UTF-8">' +
      '<title>Frais — VOLTCORE</title><style>' +
      'body{font-family:Arial;margin:20px;font-size:11px}' +
      'h1{color:#1A2B4C;border-bottom:2px solid #1A2B4C;padding-bottom:6px}' +
      'table{width:100%;border-collapse:collapse;margin-top:10px}' +
      'th,td{border:1px solid #ccc;padding:6px;text-align:left}' +
      'th{background:#1A2B4C;color:#fff}.right{text-align:right}' +
      '</style></head><body>';
    html += '<h1>Notes de frais</h1><div>Total : ' + list.length +
      ' · ' + U.todayISO() + '</div>';
    html += '<table><thead><tr><th>Date</th><th>Catégorie</th><th>Description</th>' +
      '<th>Chantier</th><th class="right">Montant</th></tr></thead><tbody>';

    var sum = 0;
    for (var i = 0; i < list.length; i++) {
      var f = list[i];
      var chNom = f.chantierId && Ch ? Ch.getNom(f.chantierId) : '—';
      sum += U.parseNumber(f.montant);
      html += '<tr><td>' + U.escapeHtml(U.formatDate(f.date)) + '</td>' +
        '<td>' + U.escapeHtml(F.getCategorieLabel(f.categorie)) + '</td>' +
        '<td>' + U.escapeHtml(f.description || '—') + '</td>' +
        '<td>' + U.escapeHtml(chNom) + '</td>' +
        '<td class="right">' + U.formatMoney(U.parseNumber(f.montant)) + '</td></tr>';
    }
    html += '<tr style="background:#f0f0f0;font-weight:bold">' +
      '<td colspan="4">TOTAL</td>' +
      '<td class="right">' + U.formatMoney(sum) + '</td></tr>';
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
        VC.logError('15-frais', 'print échoué', e);
      }
    }, 500);
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 10 — EVENTS
     ═══════════════════════════════════════════════════════════ */

  F.attachEvents = function () {
    _populateCategories();

    var filterSel = document.getElementById('fraisFilterSelect');
    if (filterSel) {
      var fHtml = '<option value="all">Toutes</option>' +
        '<option value="mois_courant">Mois courant</option>';
      for (var ci = 0; ci < CATEGORIES.length; ci++) {
        fHtml += '<option value="cat:' + CATEGORIES[ci].id + '">' +
          CATEGORIES[ci].icon + ' ' + U.escapeHtml(CATEGORIES[ci].label) + '</option>';
      }
      filterSel.innerHTML = fHtml;
    }

    U.on('fraisSearchInput', 'input', U.debounce(function (ev) {
      F.setSearch(ev.target.value);
    }, 250));

    U.on('fraisFilterSelect', 'change', function (ev) {
      F.setFilter(ev.target.value);
    });

    U.on('btnAddFrais', 'click', function () {
      F.openModal(null);
    });

    U.on('fraisSaveBtn', 'click', F.saveFromForm);

    U.on('btnImportFrais', 'click', function () {
      var input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json,application/json';
      input.onchange = function (ev) {
        var f = ev.target.files && ev.target.files[0];
        if (!f) return;
        F.importJSON(f).catch(function (err) {
          U.toast('Import échoué : ' + (err.message || ''), 'error');
        });
      };
      input.click();
    });

    U.on('btnExportFraisJSON', 'click', F.exportJSON);
    U.on('btnExportFraisCSV', 'click', F.exportCSV);
    U.on('btnPrintFrais', 'click', F.print);

    /* Subscribe : re-render auto */
    S.subscribe('frais', function () {
      F.render();
    });
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 11 — MARQUEUR
     ═══════════════════════════════════════════════════════════ */

  VC._fraisLoaded = true;

  VC.logInfo('15-frais', 'Module chargé');

})(window);