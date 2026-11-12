/* ═══════════════════════════════════════════════════════════
   VOLTCORE — 07-suppl.js
   VERSION : v7.0.7
   RÔLE : CRUD fournisseurs, comparateur de prix par article,
          détection fournisseurs plus chers, import/export, impression.
          Normalisation + save + load + trash : gérés par Store.
   DÉPENDANCES : 00-core, 01-utils, 02-store
   ORDRE : 8ᵉ fichier chargé

   RÈGLES :
   - ES5 strict
   - Aucun catch silencieux
   - Ne JAMAIS lire/écrire localStorage directement
   - Historique prix : passage par externalPrices (Store)
   ═══════════════════════════════════════════════════════════ */

'use strict';

(function (global) {

  if (!global.VOLTCORE || !global.VOLTCORE.Store || !global.VOLTCORE.Utils) {
    throw new Error('[07-suppl] Modules requis non chargés');
  }

  var VC = global.VOLTCORE;
  var U = VC.Utils;
  var S = VC.Store;
  var Sup = VC.Suppliers || {};
  VC.Suppliers = Sup;

  /* ═══════════════════════════════════════════════════════════
     SECTION 1 — REGISTRATION STORE
     ═══════════════════════════════════════════════════════════ */

  S.register('suppliers', {
    type: 'array',
    saveKey: 'voltcore_suppliers',
    default: [],
    idPrefix: 'sup',
    trash: true,
    backup: true,
    schema: {
      nom: 'string|required',
      telephone: 'string',
      email: 'string',
      adresse: 'string',
      mf: 'string',
      rib: 'string',
      notes: 'string'
    }
  });

  /* ═══════════════════════════════════════════════════════════
     SECTION 2 — ÉTAT INTERNE
     ═══════════════════════════════════════════════════════════ */

  var _searchTerm = '';
  var _filter = 'all';

  /* ═══════════════════════════════════════════════════════════
     SECTION 3 — HELPERS
     ═══════════════════════════════════════════════════════════ */

  Sup.getById = function (id) {
    return S.getById('suppliers', id);
  };

  Sup.getNom = function (id) {
    var s = Sup.getById(id);
    return s ? String(s.nom || '') : '';
  };

  Sup.exists = function (nom, excludeId) {
    if (!nom) return false;
    var normalized = U.normalizeText(nom);
    var list = S.getAll('suppliers');
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      if (!s) continue;
      if (excludeId && String(s.id) === String(excludeId)) continue;
      if (U.normalizeText(s.nom || '') === normalized) return true;
    }
    return false;
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 4 — STATISTIQUES
     ═══════════════════════════════════════════════════════════ */

  /**
   * Calcule les stats d'un fournisseur :
   * - nbAchats et caAchats (depuis purchaseInvoices)
   * - nbArticles vus et écart prix moyen (depuis externalPrices)
   */
  Sup.getStats = function (supplierId) {
    var empty = { nbAchats: 0, caAchats: 0, nbArticles: 0, dernierAchat: '', ecartMoyen: 0 };
    if (!supplierId) return empty;

    var sup = Sup.getById(supplierId);
    if (!sup) return empty;

    var nomF = String(sup.nom || '');
    var purchases = S.getAll('purchaseInvoices');

    var caAchats = 0, dernierAchat = 0, dernierAchatIso = '';
    for (var i = 0; i < purchases.length; i++) {
      var p = purchases[i];
      if (!p) continue;
      var match = false;

      /* Match par ID ou par nom (fallback ancien code) */
      if (String(p.supplierId || p.fournisseurId || '') === String(supplierId)) {
        match = true;
      } else if (!p.supplierId && !p.fournisseurId && p.fournisseur === nomF) {
        match = true;
      }

      if (!match) continue;

      var total = (typeof p.totalTTC === 'number') ? p.totalTTC
                : (typeof p.total === 'number') ? p.total : 0;
      caAchats += total;

      var d = String(p.date || p.dateFacture || '').slice(0, 10);
      if (d) {
        var ts = Date.parse(d);
        if (!isNaN(ts) && ts > dernierAchat) {
          dernierAchat = ts;
          dernierAchatIso = d;
        }
      }
    }

    /* Articles vus + écart prix */
    var nbArticles = 0, ecartTotal = 0, ecartCount = 0;
    var ext = S.getObject('externalPrices');

    if (nomF) {
      var artIds = Object.keys(ext);
      for (var j = 0; j < artIds.length; j++) {
        var entries = ext[artIds[j]];
        if (!Array.isArray(entries)) continue;

        var seen = false;
        var prixF = 0;
        var prixMin = Infinity;

        for (var k = 0; k < entries.length; k++) {
          var e = entries[k];
          if (!e || typeof e.prix !== 'number' || !isFinite(e.prix)) continue;
          if (e.prix > 0 && e.prix < prixMin) prixMin = e.prix;
          if (String(e.fournisseur || '') === nomF) {
            seen = true;
            prixF = e.prix;
          }
        }

        if (seen) {
          nbArticles++;
          if (isFinite(prixMin) && prixMin > 0 && prixF > 0) {
            ecartTotal += ((prixF - prixMin) / prixMin) * 100;
            ecartCount++;
          }
        }
      }
    }

    return {
      nbAchats: purchases.length > 0 ? _countAchatsFor(supplierId, nomF) : 0,
      caAchats: caAchats,
      nbArticles: nbArticles,
      dernierAchat: dernierAchatIso,
      ecartMoyen: ecartCount > 0 ? ecartTotal / ecartCount : 0
    };
  };

  function _countAchatsFor(supplierId, nomF) {
    var purchases = S.getAll('purchaseInvoices');
    var count = 0;
    for (var i = 0; i < purchases.length; i++) {
      var p = purchases[i];
      if (!p) continue;
      if (String(p.supplierId || p.fournisseurId || '') === String(supplierId)) {
        count++;
      } else if (!p.supplierId && !p.fournisseurId && p.fournisseur === nomF) {
        count++;
      }
    }
    return count;
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 5 — COMPARATEUR DE PRIX
     ═══════════════════════════════════════════════════════════ */

  /**
   * Retourne la liste des prix vus pour un article, triée par prix croissant.
   * Un seul prix par fournisseur (le plus récent).
   */
  Sup.comparePrices = function (articleId) {
    var out = [];
    if (!articleId) return out;

    var ext = S.getObject('externalPrices');
    var entries = ext[String(articleId)];
    if (!Array.isArray(entries) || entries.length === 0) return out;

    var bySupplier = {};
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (!e || typeof e.prix !== 'number' || !isFinite(e.prix) || e.prix <= 0) continue;
      var f = String(e.fournisseur || '');
      if (!f) continue;

      var cur = bySupplier[f];
      if (!cur || String(e.date || '') > String(cur.date || '')) {
        bySupplier[f] = {
          fournisseur: f,
          prix: e.prix,
          date: String(e.date || '').slice(0, 10),
          factureRef: String(e.factureRef || '')
        };
      }
    }

    var keys = Object.keys(bySupplier);
    for (var k = 0; k < keys.length; k++) {
      out.push(bySupplier[keys[k]]);
    }

    out.sort(function (a, b) { return a.prix - b.prix; });
    return out;
  };

  Sup.getBestPrice = function (articleId) {
    var prices = Sup.comparePrices(articleId);
    return prices.length > 0 ? prices[0] : null;
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 6 — RENDU LISTE
     ═══════════════════════════════════════════════════════════ */

  Sup.render = function () {
    var container = document.getElementById('suppliersList');
    if (!container) return;

    var list = Sup.getFiltered();
    if (list.length === 0) {
      container.innerHTML = '<div class="empty-state">Aucun fournisseur' +
        (_searchTerm || _filter !== 'all' ? ' pour ce filtre' : '') +
        '. Clique sur "+ Nouveau fournisseur" pour commencer.</div>';
      _updateCount(0);
      return;
    }

    var html = '';
    for (var i = 0; i < list.length; i++) {
      html += Sup.renderRow(list[i]);
    }
    container.innerHTML = html;
    _updateCount(list.length);
  };

  Sup.renderRow = function (f) {
    if (!f) return '';
    var id = U.escapeAttr(f.id);
    var nom = U.escapeHtml(f.nom || '(Sans nom)');
    var tel = U.escapeHtml(f.telephone || '');
    var email = U.escapeHtml(f.email || '');

    var metaParts = [];
    if (tel) metaParts.push('📞 ' + tel);
    if (email) metaParts.push('✉️ ' + email);
    var meta = metaParts.length ? metaParts.join(' · ') : '<span class="muted">Aucun contact</span>';

    var stats = Sup.getStats(f.id);
    var badge = '';
    if (stats.ecartMoyen > 5) {
      badge = '<span class="badge badge-warning" title="Prix au-dessus du marché">+' +
        stats.ecartMoyen.toFixed(0) + '%</span>';
    }

    return '<div class="supplier-row" data-supplier-id="' + id + '">' +
      '<div class="supplier-row-main">' +
        '<div class="supplier-row-name">' + nom + ' ' + badge + '</div>' +
        '<div class="supplier-row-meta">' + meta + '</div>' +
      '</div>' +
      '<div class="supplier-row-actions">' +
        '<button type="button" class="btn-icon" title="Détail" ' +
        'onclick="VC.Suppliers.openDetail(\'' + id + '\')">👁️</button>' +
        '<button type="button" class="btn-icon" title="Éditer" ' +
        'onclick="VC.Suppliers.openModal(\'' + id + '\')">✏️</button>' +
        '<button type="button" class="btn-icon btn-danger" title="Supprimer" ' +
        'onclick="VC.Suppliers.remove(\'' + id + '\')">🗑️</button>' +
      '</div>' +
    '</div>';
  };

  function _updateCount(n) {
    U.setText('suppliersCount', String(n));
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 7 — DÉTAIL
     ═══════════════════════════════════════════════════════════ */

  Sup.openDetail = function (id) {
    var f = Sup.getById(id);
    if (!f) {
      U.toast('Fournisseur introuvable.', 'error');
      return;
    }

    U.setText('supplierDetailTitle', f.nom || 'Fournisseur');

    var stats = Sup.getStats(f.id);
    var ecartColor = stats.ecartMoyen > 5 ? 'var(--danger)'
      : stats.ecartMoyen < -5 ? 'var(--success)' : 'var(--warning)';

    var html = '';

    /* Bloc contact */
    html += '<div class="detail-section"><h3>Contact</h3><div class="detail-grid">';
    html += _detailItem('Téléphone', f.telephone || '—');
    html += _detailItem('Email', f.email || '—');
    html += _detailItem('Adresse', f.adresse || '—');
    html += _detailItem('MF', f.mf || '—');
    html += _detailItem('RIB', f.rib || '—');
    html += '</div></div>';

    /* Bloc activité */
    html += '<div class="detail-section"><h3>Activité</h3><div class="stats-grid">';
    html += _statItem('Achats', String(stats.nbAchats));
    html += _statItem('CA achats', U.formatMoney(stats.caAchats));
    html += _statItem('Articles vus', String(stats.nbArticles));
    html += _statItem('Écart prix', (stats.ecartMoyen >= 0 ? '+' : '') +
      stats.ecartMoyen.toFixed(1) + '%', ecartColor);
    html += '</div>';
    if (stats.dernierAchat) {
      html += '<div class="detail-last">Dernier achat : ' +
        U.escapeHtml(U.formatDate(stats.dernierAchat)) + '</div>';
    }
    html += '</div>';

    /* Bloc comparateur de prix */
    var articleIds = _getSupplierArticleIds(f.nom);
    if (articleIds.length > 0) {
      html += '<div class="detail-section"><h3>Comparateur de prix (' +
        articleIds.length + ' article(s))</h3>';
      html += '<div class="comparateur-list">';
      for (var i = 0; i < articleIds.length; i++) {
        var cmp = Sup.comparePrices(articleIds[i].articleId);
        if (cmp.length === 0) continue;
        html += _renderComparateurRow(articleIds[i].articleNom, cmp, f.nom);
      }
      html += '</div></div>';
    }

    if (f.notes) {
      html += '<div class="detail-section"><h3>Notes</h3><p class="detail-notes">' +
        U.escapeHtml(f.notes).replace(/\n/g, '<br>') + '</p></div>';
    }

    var body = document.getElementById('supplierDetailBody');
    if (body) body.innerHTML = html;
    U.showFlex('supplierDetailModal');
  };

  Sup.closeDetail = function () {
    U.hide('supplierDetailModal');
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

  function _getSupplierArticleIds(nomF) {
    var out = [];
    if (!nomF) return out;

    var ext = S.getObject('externalPrices');
    var articles = S.getAll('articles');
    var articlesById = {};
    for (var a = 0; a < articles.length; a++) {
      if (articles[a] && articles[a].id) articlesById[String(articles[a].id)] = articles[a];
    }

    var artIds = Object.keys(ext);
    var seen = {};

    for (var i = 0; i < artIds.length; i++) {
      var entries = ext[artIds[i]];
      if (!Array.isArray(entries)) continue;

      for (var j = 0; j < entries.length; j++) {
        if (entries[j] && String(entries[j].fournisseur || '') === String(nomF)) {
          if (!seen[artIds[i]]) {
            seen[artIds[i]] = true;
            var art = articlesById[String(artIds[i])];
            out.push({
              articleId: artIds[i],
              articleNom: art ? String(art.nom || art.designation || artIds[i]) : artIds[i]
            });
          }
          break;
        }
      }
    }
    return out;
  }

  function _renderComparateurRow(articleNom, prices, currentFournisseur) {
    var html = '<div class="comparateur-row">';
    html += '<div class="comparateur-article">' + U.escapeHtml(articleNom) + '</div>';
    html += '<div class="comparateur-prices">';
    for (var i = 0; i < prices.length; i++) {
      var p = prices[i];
      var isMine = String(p.fournisseur) === String(currentFournisseur);
      var cls = (i === 0 ? 'best' : '') + (isMine ? ' mine' : '');
      var mark = i === 0 ? '🥇 ' : (isMine ? '👤 ' : '');
      html += '<div class="comparateur-price ' + cls.trim() + '">' +
        mark + U.escapeHtml(p.fournisseur) + ' : ' + U.formatMoney(p.prix) +
        ' <span class="muted">(' + U.formatDate(p.date) + ')</span>' +
        '</div>';
    }
    html += '</div></div>';
    return html;
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 8 — FORMULAIRE
     ═══════════════════════════════════════════════════════════ */

  Sup.openModal = function (id) {
    var form = document.getElementById('supplierForm');
    if (form) form.reset();

    if (id) {
      var f = Sup.getById(id);
      if (!f) {
        U.toast('Fournisseur introuvable.', 'error');
        return;
      }
      U.setText('supplierModalTitle', 'Modifier fournisseur');
      U.setVal('supplierId', f.id);
      U.setVal('supplierNom', f.nom || '');
      U.setVal('supplierTelephone', f.telephone || '');
      U.setVal('supplierEmail', f.email || '');
      U.setVal('supplierAdresse', f.adresse || '');
      U.setVal('supplierMF', f.mf || '');
      U.setVal('supplierRIB', f.rib || '');
      U.setVal('supplierNotes', f.notes || '');
    } else {
      U.setText('supplierModalTitle', 'Nouveau fournisseur');
      U.setVal('supplierId', '');
    }

    U.setText('supplierFormError', '');
    U.showFlex('supplierModal');

    setTimeout(function () {
      try {
        var el = document.getElementById('supplierNom');
        if (el) el.focus();
      } catch (e) {
        VC.logError('07-suppl', 'openModal focus échoué', e);
      }
    }, 100);
  };

  Sup.closeModal = function () {
    U.hide('supplierModal');
  };

  Sup.saveFromForm = function () {
    var errEl = document.getElementById('supplierFormError');
    if (errEl) errEl.textContent = '';

    var id = U.getVal('supplierId');
    var nom = U.getVal('supplierNom');

    if (!nom) {
      if (errEl) errEl.textContent = 'Le nom est obligatoire.';
      return;
    }
    if (Sup.exists(nom, id)) {
      if (errEl) errEl.textContent = 'Un fournisseur avec ce nom existe déjà.';
      return;
    }

    var raw = {
      id: id || undefined,
      nom: nom,
      telephone: U.getVal('supplierTelephone'),
      email: U.getVal('supplierEmail'),
      adresse: U.getVal('supplierAdresse'),
      mf: U.getVal('supplierMF'),
      rib: U.getVal('supplierRIB'),
      notes: U.getVal('supplierNotes')
    };

    var saved = S.save('suppliers', raw);
    if (!saved) {
      if (errEl) errEl.textContent = 'Données invalides.';
      return;
    }

    Sup.closeModal();
    Sup.render();
    U.toast(id ? 'Fournisseur modifié' : 'Fournisseur créé', 'success', 2500);
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 9 — SUPPRESSION
     ═══════════════════════════════════════════════════════════ */

  Sup.remove = function (id) {
    var f = Sup.getById(id);
    if (!f) return;

    /* Vérification références */
    var purchases = S.getAll('purchaseInvoices');
    var refCount = 0;
    for (var i = 0; i < purchases.length; i++) {
      if (purchases[i] && String(purchases[i].supplierId || purchases[i].fournisseurId || '') === String(id)) {
        refCount++;
      }
    }

    var msg = 'Supprimer le fournisseur "' + (f.nom || '') + '" ?';
    if (refCount > 0) {
      msg = '⚠️ Ce fournisseur est référencé par ' + refCount +
        ' achat(s).\n\nContinuer quand même ?';
    }

    if (!U.confirm(msg)) return;

    /* FIX R2 : préserver le nom du fournisseur dans les achats liés */
    var supplierNom = String(f.nom || '');
    var purchases = S.getAll('purchaseInvoices');
    for (var pi = 0; pi < purchases.length; pi++) {
      var p = purchases[pi];
      if (!p) continue;
      if (String(p.supplierId || p.fournisseurId || '') === String(id)) {
        p._fournisseurNomOrphelin = supplierNom;
      }
    }

    if (!S.delete('suppliers', id)) {
      U.toast('Erreur suppression.', 'error');
      return;
    }

    S.saveAll();

    Sup.render();
    U.toastUndo('Fournisseur supprimé : ' + (f.nom || ''),
      function () { _restore(id); }, 5000);
  };

  function _restore(id) {
    var entries = S.getTrashEntries('suppliers');
    for (var i = 0; i < entries.length; i++) {
      if (entries[i].item && String(entries[i].item.id) === String(id)) {
        S.restoreFromTrash('suppliers', i);
        // FIX R32-R35 : nettoyer _fournisseurNomOrphelin des achats restaurés.
        var sid = String(id);
        var purchases = S.getAll('purchaseInvoices');
        for (var pi = 0; pi < purchases.length; pi++) {
          var p = purchases[pi];
          if (!p) continue;
          var pid = String(p.supplierId || p.fournisseurId || '');
          if (pid === sid && p._fournisseurNomOrphelin !== undefined) {
            delete p._fournisseurNomOrphelin;
          }
        }
        S.saveAll();
        Sup.render();
        U.toast('Fournisseur restauré', 'success', 2000);
        return;
      }
    }
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 10 — FILTRES
     ═══════════════════════════════════════════════════════════ */

  Sup.setSearch = function (term) {
    _searchTerm = String(term || '');
    Sup.render();
  };

  Sup.setFilter = function (filter) {
    _filter = String(filter || 'all');
    Sup.render();
  };

  Sup.getFiltered = function () {
    var out = S.getAll('suppliers').slice();

    if (_searchTerm) {
      var term = U.normalizeText(_searchTerm);
      out = out.filter(function (f) {
        if (!f) return false;
        var hay = U.normalizeText([f.nom, f.telephone, f.email, f.adresse, f.mf].join(' '));
        return hay.indexOf(term) >= 0;
      });
    }

    if (_filter === 'with_invoices') {
      out = out.filter(function (f) {
        return _countAchatsFor(f.id, f.nom) > 0;
      });
    } else if (_filter === 'without_invoices') {
      out = out.filter(function (f) {
        return _countAchatsFor(f.id, f.nom) === 0;
      });
    } else if (_filter === 'expensive') {
      out = out.filter(function (f) {
        return Sup.getStats(f.id).ecartMoyen > 5;
      });
    }

    out.sort(function (a, b) {
      var na = U.normalizeText(a.nom || '');
      var nb = U.normalizeText(b.nom || '');
      if (na === nb) return 0;
      return na > nb ? 1 : -1;
    });

    return out;
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 11 — IMPORT / EXPORT
     ═══════════════════════════════════════════════════════════ */

  Sup.exportJSON = function () {
    var suppliers = S.getAll('suppliers');
    var data = {
      version: 1,
      exportedAt: new Date().toISOString(),
      count: suppliers.length,
      suppliers: suppliers
    };
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    U.downloadBlob(blob, 'voltcore-fournisseurs-' + U.todayISO() + '.json');
    U.toast(suppliers.length + ' fournisseur(s) exporté(s)', 'success');
  };

  Sup.exportCSV = function () {
    var suppliers = S.getAll('suppliers');
    var lines = [];
    lines.push(['Nom', 'Téléphone', 'Email', 'Adresse', 'MF', 'RIB', 'Notes'].join('\t'));

    for (var i = 0; i < suppliers.length; i++) {
      var f = suppliers[i];
      if (!f) continue;
      lines.push([
        _csv(f.nom), _csv(f.telephone), _csv(f.email),
        _csv(f.adresse), _csv(f.mf), _csv(f.rib), _csv(f.notes)
      ].join('\t'));
    }

    var csv = '\uFEFF' + lines.join('\r\n');
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    U.downloadBlob(blob, 'voltcore-fournisseurs-' + U.todayISO() + '.csv');
    U.toast('CSV exporté', 'success');
  };

  function _csv(v) {
    return String(v == null ? '' : v).replace(/\t/g, ' ').replace(/\r?\n/g, ' ');
  }

  Sup.importJSON = function (file) {
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
            : (parsed && Array.isArray(parsed.suppliers)) ? parsed.suppliers : null;
          if (!arr) {
            reject(new Error('Format invalide : suppliers[] attendu'));
            return;
          }

          var added = 0, skipped = 0, invalid = 0;
          for (var i = 0; i < arr.length; i++) {
            var clean = S.normalize('suppliers', arr[i]);
            if (!clean) { invalid++; continue; }
            if (Sup.exists(clean.nom)) { skipped++; continue; }
            if (S.save('suppliers', clean)) added++;
            else invalid++;
          }

          Sup.render();

          var msg = added + ' fournisseur(s) importé(s)';
          if (skipped > 0) msg += ' · ' + skipped + ' doublon(s)';
          if (invalid > 0) msg += ' · ' + invalid + ' invalide(s)';
          U.toast(msg, added > 0 ? 'success' : 'warning', 4000);

          resolve({ added: added, skipped: skipped, invalid: invalid });
        } catch (err) {
          VC.logError('07-suppl', 'importJSON parse échoué', err);
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

  Sup.print = function () {
    var list = Sup.getFiltered();
    var html = '<!DOCTYPE html><html><head><meta charset="UTF-8">' +
      '<title>Fournisseurs — VOLTCORE</title><style>' +
      'body{font-family:Arial,sans-serif;margin:20px;font-size:12px}' +
      'h1{color:#1A2B4C;border-bottom:2px solid #1A2B4C;padding-bottom:6px}' +
      'table{width:100%;border-collapse:collapse;margin-top:10px}' +
      'th,td{border:1px solid #ccc;padding:6px;text-align:left}' +
      'th{background:#f0f0f0;font-weight:bold}' +
      '</style></head><body>';
    html += '<h1>Liste des fournisseurs</h1>';
    html += '<div>Total : ' + list.length + ' · ' + U.todayISO() + '</div>';
    html += '<table><thead><tr>' +
      '<th>Nom</th><th>Téléphone</th><th>Email</th><th>Adresse</th><th>MF</th>' +
      '</tr></thead><tbody>';
    for (var i = 0; i < list.length; i++) {
      var f = list[i];
      html += '<tr>' +
        '<td>' + U.escapeHtml(f.nom || '') + '</td>' +
        '<td>' + U.escapeHtml(f.telephone || '') + '</td>' +
        '<td>' + U.escapeHtml(f.email || '') + '</td>' +
        '<td>' + U.escapeHtml(f.adresse || '') + '</td>' +
        '<td>' + U.escapeHtml(f.mf || '') + '</td>' +
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
        VC.logError('07-suppl', 'print échoué', e);
      }
    }, 500);
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 13 — EVENTS
     ═══════════════════════════════════════════════════════════ */

  Sup.attachEvents = function () {
    U.on('suppliersSearchInput', 'input', U.debounce(function (ev) {
      Sup.setSearch(ev.target.value);
    }, 250));

    U.on('suppliersFilterSelect', 'change', function (ev) {
      Sup.setFilter(ev.target.value);
    });

    U.on('btnAddSupplier', 'click', function () {
      Sup.openModal(null);
    });

    U.on('btnImportSuppliers', 'click', function () {
      var input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json,application/json';
      input.onchange = function (ev) {
        var f = ev.target.files && ev.target.files[0];
        if (!f) return;
        Sup.importJSON(f).catch(function (err) {
          U.toast('Import échoué : ' + (err.message || ''), 'error');
        });
      };
      input.click();
    });

    U.on('btnExportSuppliersJSON', 'click', Sup.exportJSON);
    U.on('btnExportSuppliersCSV', 'click', Sup.exportCSV);
    U.on('btnPrintSuppliers', 'click', Sup.print);

    /* Subscribe pour re-render auto */
    S.subscribe('suppliers', function () {
      Sup.render();
    });

  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 14 — MARQUEUR
     ═══════════════════════════════════════════════════════════ */
  /* ═══════════════════════════════════════════════════════════
     FIX R32-R35-TER : nettoyage _fournisseurNomOrphelin sur
     TOUS les chemins de restore. Subscribe au niveau module.
     ═══════════════════════════════════════════════════════════ */
  (function _watchSupplierRestores() {
    S.subscribe('suppliers', function (ev) {
      try {
        if (!ev || ev.action !== 'restore' || !ev.item || !ev.item.id) return;
        var sid = String(ev.item.id);
        var purchases = S.getAll('purchaseInvoices');
        var dirty = false;
        for (var pi = 0; pi < purchases.length; pi++) {
          var p = purchases[pi];
          if (!p) continue;
          var pid = String(p.supplierId || p.fournisseurId || '');
          if (pid === sid && p._fournisseurNomOrphelin !== undefined) {
            delete p._fournisseurNomOrphelin;
            dirty = true;
          }
        }
        if (dirty) S.saveAll();
      } catch (e) {
        VC.logError('07-suppl', 'restore cleanup flag échoué', e);
      }
    });
  })();
  VC._supplLoaded = true;

  VC.logInfo('07-suppl', 'Module chargé');

})(window);