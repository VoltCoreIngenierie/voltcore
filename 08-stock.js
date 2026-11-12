/* ═══════════════════════════════════════════════════════════
   VOLTCORE — 08-stock.js
   VERSION : v7.0.7
   RÔLE : Articles + familles + historique prix + alertes prix
          + pagination + étiquettes + import/export + picker
          pour factures.
          Normalisation + save + load + trash : gérés par Store.
   DÉPENDANCES : 00-core, 01-utils, 02-store
   ORDRE : 9ᵉ fichier chargé

   RÈGLES :
   - ES5 strict
   - Aucun catch silencieux
   - Fix C4 : recordPriceChange est appelé AVANT partage du tableau
   - Picker : closure IIFE pour chaque ligne (fix historique)
   ═══════════════════════════════════════════════════════════ */

'use strict';

(function (global) {

  if (!global.VOLTCORE || !global.VOLTCORE.Store || !global.VOLTCORE.Utils) {
    throw new Error('[08-stock] Modules requis non chargés');
  }

  var VC = global.VOLTCORE;
  var U = VC.Utils;
  var S = VC.Store;
  var St = VC.Stock || {};
  VC.Stock = St;

  /* ═══════════════════════════════════════════════════════════
     SECTION 1 — REGISTRATION STORE
     ═══════════════════════════════════════════════════════════ */

  S.register('articles', {
    type: 'array',
    saveKey: 'voltcore_articles',
    default: [],
    idPrefix: 'art',
    trash: true,
    backup: true,
    schema: {
      nom: 'string|required',
      designation: 'string',
      prix: 'float|0-99999999',
      prixAchat: 'float|0-99999999',
      seuil: 'float|0-99999999',
      stock: 'float|0-99999999',
      unite: 'string',
      famille: 'string',
      codeBarre: 'string',
      hs: 'bool',
      actif: 'bool',
      notes: 'string'
    }
  });

  S.register('familles', {
    type: 'array',
    saveKey: 'voltcore_familles',
    default: [],
    idPrefix: 'fam',
    trash: true,
    backup: true,
    schema: {
      nom: 'string|required',
      couleur: 'string'
    }
  });

  S.register('externalPrices', {
    type: 'object',
    saveKey: 'voltcore_external_prices',
    default: {},
    backup: true
  });

  /* ═══════════════════════════════════════════════════════════
     SECTION 2 — ÉTAT INTERNE
     ═══════════════════════════════════════════════════════════ */

  var _searchTerm = '';
  var _familleFilter = '';
  var _showMode = 'actif';
  var _page = 0;
  var _perPage = 50;
  var _filteredList = [];

  /* Picker state */
  var _pickerCb = null;
  var _pickerSearch = '';
  var _pickerFamille = '';

  /* ═══════════════════════════════════════════════════════════
     SECTION 3 — HELPERS ARTICLES
     ═══════════════════════════════════════════════════════════ */

  St.getById = function (id) {
    return S.getById('articles', id);
  };

  St.getNom = function (art) {
    if (!art) return '';
    return String(art.nom || art.designation || '');
  };

  St.getPrix = function (art) {
    if (!art) return 0;
    if (typeof art.prix === 'number') return art.prix;
    if (typeof art.prixVente === 'number') return art.prixVente;
    return U.parseNumber(art.prix || art.prixVente) || 0;
  };

  St.getPrixAchat = function (art) {
    if (!art) return 0;
    if (typeof art.prixAchat === 'number') return art.prixAchat;
    if (typeof art.purchasePrice === 'number') return art.purchasePrice;
    return U.parseNumber(art.prixAchat || art.purchasePrice) || 0;
  };

  St.getFamille = function (art) {
    if (!art) return '';
    return String(art.famille || art.familleNom || art.categorie || '').trim();
  };

  St.isHS = function (art) {
    if (!art) return false;
    return art.hs === true || art.isHS === true || art.horsStock === true;
  };

  St.isActif = function (art) {
    if (!art) return false;
    return art.actif !== false;
  };

  St.getStock = function (art) {
    if (!art) return 0;
    return U.parseNumber(art.stock || art.quantite || 0);
  };

  St.getSeuil = function (art) {
    if (!art) return 0;
    return U.parseNumber(art.seuil || art.alerteSeuil || 0);
  };

  St.exists = function (nom, excludeId) {
    if (!nom) return false;
    var normalized = U.normalizeText(nom);
    var list = S.getAll('articles');
    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      if (!a) continue;
      if (excludeId && String(a.id) === String(excludeId)) continue;
      if (U.normalizeText(St.getNom(a)) === normalized) return true;
    }
    return false;
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 4 — HELPERS FAMILLES
     ═══════════════════════════════════════════════════════════ */

  St.getFamilleById = function (id) {
    return S.getById('familles', id);
  };

  St.getFamilleNom = function (fam) {
    if (!fam) return '';
    if (typeof fam === 'string') return fam;
    return String(fam.nom || fam.name || '');
  };

  St.familleExists = function (nom, excludeId) {
    if (!nom) return false;
    var normalized = U.normalizeText(nom);
    var list = S.getAll('familles');
    for (var i = 0; i < list.length; i++) {
      var f = list[i];
      if (!f) continue;
      if (excludeId && String(f.id) === String(excludeId)) continue;
      if (U.normalizeText(St.getFamilleNom(f)) === normalized) return true;
    }
    return false;
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 5 — HISTORIQUE PRIX (prixUpdates dans article)
     ═══════════════════════════════════════════════════════════ */

  St.recordPriceChange = function (articleId, newPrix, newPrixAchat, source, note) {
    var art = St.getById(articleId);
    if (!art) return;

    var oldPrix = St.getPrix(art);
    var oldPrixAchat = St.getPrixAchat(art);

    if (!Array.isArray(art.prixUpdates)) art.prixUpdates = [];

    if (Math.abs(newPrix - oldPrix) > 0.001 || Math.abs(newPrixAchat - oldPrixAchat) > 0.001) {
      art.prixUpdates.push({
        date: new Date().toISOString(),
        oldPrix: oldPrix,
        newPrix: newPrix,
        oldPrixAchat: oldPrixAchat,
        newPrixAchat: newPrixAchat,
        source: String(source || 'edit'),
        note: String(note || '')
      });
      if (art.prixUpdates.length > 50) {
        art.prixUpdates = art.prixUpdates.slice(-50);
      }
    }
  };

  St.getPriceHistory = function (articleId) {
    var art = St.getById(articleId);
    if (!art || !Array.isArray(art.prixUpdates)) return [];
    return art.prixUpdates.slice().sort(function (a, b) {
      return String(b.date) > String(a.date) ? 1 : -1;
    });
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 6 — EXTERNAL PRICES (lecture / écriture)
     ═══════════════════════════════════════════════════════════ */

  St.recordExternalPrice = function (articleId, prixUnitaire, fournisseur, factureRef, date) {
    if (!articleId || typeof prixUnitaire !== 'number' || !isFinite(prixUnitaire)) return;

    var ext = S.getObject('externalPrices');
    var key = String(articleId);

    if (!Array.isArray(ext[key])) ext[key] = [];

    var entry = {
      prix: prixUnitaire,
      fournisseur: String(fournisseur || ''),
      factureRef: String(factureRef || ''),
      date: String(date || U.todayISO()).slice(0, 10)
    };

    /* Dédupe */
    for (var i = 0; i < ext[key].length; i++) {
      var e = ext[key][i];
      if (e.date === entry.date && e.fournisseur === entry.fournisseur && e.prix === entry.prix) {
        return;
      }
    }

    ext[key].push(entry);
    if (ext[key].length > 50) ext[key] = ext[key].slice(-50);

    S.setObject('externalPrices', ext);
  };

  St.cleanupExternalPricesFor = function (factureRef, fournisseur) {
    if (!factureRef && !fournisseur) return 0;

    var ext = S.getObject('externalPrices');
    var removed = 0;
    var artIds = Object.keys(ext);

    for (var i = 0; i < artIds.length; i++) {
      var list = ext[artIds[i]];
      if (!Array.isArray(list)) continue;

      var filtered = list.filter(function (e) {
        if (!e) return false;
        var matchRef = factureRef && String(e.factureRef || '').trim() === String(factureRef).trim();
        var matchSup = fournisseur && String(e.fournisseur || '').trim() === String(fournisseur).trim();
        if (matchRef && matchSup) {
          removed++;
          return false;
        }
        return true;
      });

      ext[artIds[i]] = filtered;
      if (filtered.length === 0) delete ext[artIds[i]];
    }

    if (removed > 0) S.setObject('externalPrices', ext);
    return removed;
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 7 — ALERTES PRIX
     ═══════════════════════════════════════════════════════════ */

  St.computePriceAlerts = function () {
    var out = [];
    var articles = S.getAll('articles');
    var ext = S.getObject('externalPrices');

    for (var i = 0; i < articles.length; i++) {
      var art = articles[i];
      if (!art || !art.id) continue;

      var entries = ext[String(art.id)];
      if (!Array.isArray(entries) || entries.length === 0) continue;

      var prixAchat = St.getPrixAchat(art);
      if (prixAchat <= 0) continue;

      var minPrix = Infinity, minF = '', minDate = '';
      for (var j = 0; j < entries.length; j++) {
        var e = entries[j];
        if (!e || typeof e.prix !== 'number' || e.prix <= 0) continue;
        if (e.prix < minPrix) {
          minPrix = e.prix;
          minF = String(e.fournisseur || '');
          minDate = String(e.date || '').slice(0, 10);
        }
      }

      if (!isFinite(minPrix)) continue;

      if (minPrix < prixAchat * 0.95) {
        out.push({
          articleId: art.id,
          articleNom: St.getNom(art),
          meilleurPrix: minPrix,
          prixAchatActuel: prixAchat,
          fournisseur: minF,
          ecartPct: ((prixAchat - minPrix) / prixAchat) * 100,
          date: minDate
        });
      }
    }

    out.sort(function (a, b) { return b.ecartPct - a.ecartPct; });
    return out;
  };

  St.countAlerts = function () {
    return St.computePriceAlerts().length;
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 8 — RENDU LISTE
     ═══════════════════════════════════════════════════════════ */

  St.render = function () {
    var container = document.getElementById('stockList');
    if (!container) return;

    var all = St.getFiltered();
    var total = all.length;
    var maxPage = Math.max(0, Math.ceil(total / _perPage) - 1);
    if (_page > maxPage) _page = maxPage;

    var start = _page * _perPage;
    var end = Math.min(start + _perPage, total);
    var slice = all.slice(start, end);

    _filteredList = all;

    /* Calcul alertes une seule fois (optimisation) */
    var alertsByArticle = {};
    var allAlerts = St.computePriceAlerts();
    for (var a = 0; a < allAlerts.length; a++) {
      alertsByArticle[String(allAlerts[a].articleId)] = allAlerts[a];
    }

    if (slice.length === 0) {
      container.innerHTML = '<div class="empty-state">Aucun article' +
        (_searchTerm || _showMode !== 'actif' ? ' pour ce filtre' : '') +
        '. Clique sur "+ Nouvel article" pour commencer.</div>';
      _updatePagination(0, 0, total);
      U.setText('stockCount', String(total));
      return;
    }

    var html = '';
    for (var i = 0; i < slice.length; i++) {
      html += St.renderRow(slice[i], alertsByArticle);
    }
    container.innerHTML = html;

    _updatePagination(_page, maxPage, total);
    U.setText('stockCount', String(total));
    St.renderFamilles();
  };

  St.renderRow = function (art, alertsByArticle) {
    if (!art) return '';

    var id = U.escapeAttr(art.id);
    var nom = U.escapeHtml(St.getNom(art) || '(Sans nom)');
    var famille = U.escapeHtml(St.getFamille(art) || '');
    var prix = St.getPrix(art);
    var prixAchat = St.getPrixAchat(art);
    var margePct = prix > 0 ? ((prix - prixAchat) / prix) * 100 : 0;
    var margeColor = margePct >= 20 ? 'var(--success)'
      : margePct >= 0 ? 'var(--warning)' : 'var(--danger)';

    var badges = '';
    if (St.isHS(art)) badges += '<span class="badge badge-hs">HS</span> ';
    if (!St.isActif(art)) badges += '<span class="badge badge-muted">Inactif</span> ';

    var stock = St.getStock(art);
    var seuil = St.getSeuil(art);
    if (seuil > 0 && stock <= seuil) {
      badges += '<span class="badge badge-warning">⚠ Stock bas</span> ';
    }

    var alert = alertsByArticle ? alertsByArticle[String(art.id)] : null;
    if (alert) {
      badges += '<span class="badge badge-info">💡 −' +
        alert.ecartPct.toFixed(0) + '%</span> ';
    }

    var metaParts = [];
    if (famille) metaParts.push(famille);
    metaParts.push('Prix : ' + U.formatMoney(prix));
    if (prixAchat > 0) metaParts.push('Achat : ' + U.formatMoney(prixAchat));

    return '<div class="stock-row" data-article-id="' + id + '">' +
      '<div class="stock-row-main">' +
        '<div class="stock-row-name">' + nom + ' ' + badges + '</div>' +
        '<div class="stock-row-meta">' + metaParts.join(' · ') + '</div>' +
        '<div class="stock-row-marge" style="color:' + margeColor + '">Marge : ' +
          margePct.toFixed(1) + '%</div>' +
      '</div>' +
      '<div class="stock-row-actions">' +
        '<button type="button" class="btn-icon" title="Détail" ' +
        'onclick="VC.Stock.openDetail(\'' + id + '\')">👁️</button>' +
        '<button type="button" class="btn-icon" title="Éditer" ' +
        'onclick="VC.Stock.openModal(\'' + id + '\')">✏️</button>' +
        '<button type="button" class="btn-icon btn-danger" title="Supprimer" ' +
        'onclick="VC.Stock.remove(\'' + id + '\')">🗑️</button>' +
      '</div>' +
    '</div>';
  };

  function _updatePagination(page, maxPage, total) {
    U.setText('stockPageInfo', total > 0
      ? 'Page ' + (page + 1) + ' / ' + (maxPage + 1) + ' — ' + total + ' article(s)'
      : '0 article');
    var prev = document.getElementById('stockPrevBtn');
    if (prev) prev.disabled = (page <= 0);
    var next = document.getElementById('stockNextBtn');
    if (next) next.disabled = (page >= maxPage);
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 9 — RENDU FAMILLES
     ═══════════════════════════════════════════════════════════ */

  St.renderFamilles = function () {
    /* Select filtre */
    var sel = document.getElementById('stockFamilleFilterSelect');
    if (sel) {
      var used = {};
      var articles = S.getAll('articles');
      for (var i = 0; i < articles.length; i++) {
        var f = St.getFamille(articles[i]);
        if (f) used[f] = true;
      }
      var names = Object.keys(used).sort(function (a, b) {
        return U.normalizeText(a) > U.normalizeText(b) ? 1 : -1;
      });
      var html = '<option value="">Toutes familles</option>';
      for (var j = 0; j < names.length; j++) {
        html += '<option value="' + U.escapeAttr(names[j]) + '"' +
          (names[j] === _familleFilter ? ' selected' : '') + '>' +
          U.escapeHtml(names[j]) + '</option>';
      }
      sel.innerHTML = html;
    }

    /* Liste familles (page Outils) */
    var listEl = document.getElementById('famillesList');
    if (!listEl) return;

    var familles = S.getAll('familles');
    if (familles.length === 0) {
      listEl.innerHTML = '<div class="empty-state">Aucune famille définie.</div>';
      return;
    }

    var h = '';
    for (var k = 0; k < familles.length; k++) {
      var fa = familles[k];
      var fid = U.escapeAttr(fa.id);
      h += '<div class="famille-row">' +
        '<span class="famille-color" style="background:' +
        U.escapeAttr(fa.couleur || '#0b3d91') + '"></span>' +
        '<span class="famille-nom">' + U.escapeHtml(St.getFamilleNom(fa)) + '</span>' +
        '<button type="button" class="btn-icon btn-danger" title="Supprimer" ' +
        'onclick="VC.Stock.deleteFamille(\'' + fid + '\')">🗑️</button>' +
        '</div>';
    }
    listEl.innerHTML = h;
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 10 — DÉTAIL
     ═══════════════════════════════════════════════════════════ */

  St.openDetail = function (id) {
    var art = St.getById(id);
    if (!art) {
      U.toast('Article introuvable.', 'error');
      return;
    }

    U.setText('articleDetailTitle', St.getNom(art));

    var html = '<div class="detail-section"><h3>Fiche article</h3><div class="detail-grid">';
    html += _detailItem('Famille', St.getFamille(art) || '—');
    html += _detailItem('Unité', String(art.unite || 'U'));
    html += _detailItem('Prix vente', U.formatMoney(St.getPrix(art)));
    html += _detailItem('Prix achat', U.formatMoney(St.getPrixAchat(art)));
    html += _detailItem('Code-barre', String(art.codeBarre || '—'));
    html += _detailItem('Stock', String(St.getStock(art)));
    html += _detailItem('Seuil', String(St.getSeuil(art)));
    html += _detailItem('Hors stock', St.isHS(art) ? 'Oui' : 'Non');
    html += '</div></div>';

    /* Historique prix interne */
    var hist = St.getPriceHistory(id);
    if (hist.length > 0) {
      html += '<div class="detail-section"><h3>Historique prix (' + hist.length + ')</h3>';
      html += '<div class="price-history">';
      for (var i = 0; i < Math.min(hist.length, 20); i++) {
        var h = hist[i];
        var upAchat = h.newPrixAchat > h.oldPrixAchat;
        var arrow = upAchat ? '↑' : (h.newPrixAchat < h.oldPrixAchat ? '↓' : '=');
        var color = upAchat ? 'var(--danger)'
          : (h.newPrixAchat < h.oldPrixAchat ? 'var(--success)' : 'var(--muted)');
        html += '<div class="price-history-row">' +
          '<span class="muted">' + U.escapeHtml(U.formatDate(h.date)) + '</span>' +
          ' — Achat : ' + U.formatMoney(h.oldPrixAchat) + ' → ' + U.formatMoney(h.newPrixAchat) +
          ' <span style="color:' + color + '">' + arrow + '</span>' +
          ' <span class="muted">(' + U.escapeHtml(h.source || 'edit') + ')</span>' +
          '</div>';
      }
      html += '</div></div>';
    }

    /* Alerte prix */
    var alerts = St.computePriceAlerts().filter(function (a) {
      return String(a.articleId) === String(id);
    });
    if (alerts.length > 0) {
      html += '<div class="detail-section"><h3>💡 Meilleur prix vu</h3>';
      var a = alerts[0];
      html += '<div class="alert-prix">' +
        'Fournisseur : ' + U.escapeHtml(a.fournisseur || '?') + '<br>' +
        'Prix : ' + U.formatMoney(a.meilleurPrix) + '<br>' +
        'Écart vs ton prix achat : −' + a.ecartPct.toFixed(1) + '%<br>' +
        '<span class="muted">Vu le ' + U.escapeHtml(U.formatDate(a.date)) + '</span>' +
        '</div></div>';
    }

    var body = document.getElementById('articleDetailBody');
    if (body) body.innerHTML = html;
    U.showFlex('articleDetailModal');
  };

  St.closeDetail = function () {
    U.hide('articleDetailModal');
  };

  function _detailItem(label, value) {
    return '<div class="detail-item">' +
      '<div class="detail-label">' + U.escapeHtml(label) + '</div>' +
      '<div class="detail-value">' + U.escapeHtml(value) + '</div>' +
      '</div>';
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 11 — FORMULAIRE ARTICLE
     ═══════════════════════════════════════════════════════════ */

  St.openModal = function (id) {
    var form = document.getElementById('articleForm');
    if (form) form.reset();

    /* Datalist familles */
    var dl = document.getElementById('famillesDatalist');
    if (dl) {
      var used = {};
      var articles = S.getAll('articles');
      for (var i = 0; i < articles.length; i++) {
        var f = St.getFamille(articles[i]);
        if (f) used[f] = true;
      }
      var keys = Object.keys(used);
      var opts = '';
      for (var k = 0; k < keys.length; k++) {
        opts += '<option value="' + U.escapeAttr(keys[k]) + '">';
      }
      dl.innerHTML = opts;
    }

    if (id) {
      var art = St.getById(id);
      if (!art) {
        U.toast('Article introuvable.', 'error');
        return;
      }
      U.setText('articleModalTitle', 'Modifier article');
      U.setVal('articleId', art.id);
      U.setVal('articleNom', St.getNom(art));
      U.setVal('articlePrix', St.getPrix(art));
      U.setVal('articlePrixAchat', St.getPrixAchat(art));
      U.setVal('articleSeuil', St.getSeuil(art));
      U.setVal('articleStock', St.getStock(art));
      U.setVal('articleUnite', art.unite || 'U');
      U.setVal('articleFamille', St.getFamille(art));
      U.setVal('articleCodeBarre', art.codeBarre || '');
      U.setVal('articleNotes', art.notes || '');
      U.setChecked('articleHS', St.isHS(art));
      U.setChecked('articleActif', St.isActif(art));
    } else {
      U.setText('articleModalTitle', 'Nouvel article');
      U.setVal('articleId', '');
      U.setChecked('articleHS', false);
      U.setChecked('articleActif', true);
    }

    U.setText('articleFormError', '');
    U.showFlex('articleModal');

    setTimeout(function () {
      try {
        var el = document.getElementById('articleNom');
        if (el) el.focus();
      } catch (e) {
        VC.logError('08-stock', 'openModal focus échoué', e);
      }
    }, 100);
  };

  St.closeModal = function () {
    U.hide('articleModal');
  };

  St.saveFromForm = function () {
    var errEl = document.getElementById('articleFormError');
    if (errEl) errEl.textContent = '';

    var id = U.getVal('articleId');
    var nom = U.getVal('articleNom');

    if (!nom) {
      if (errEl) errEl.textContent = 'Le nom est obligatoire.';
      return;
    }
    if (St.exists(nom, id)) {
      if (errEl) errEl.textContent = 'Un article avec ce nom existe déjà.';
      return;
    }

    var raw = {
      id: id || undefined,
      nom: nom,
      designation: nom,
      prix: U.getVal('articlePrix'),
      prixAchat: U.getVal('articlePrixAchat'),
      seuil: U.getVal('articleSeuil'),
      stock: U.getVal('articleStock'),
      unite: U.getVal('articleUnite') || 'U',
      famille: U.getVal('articleFamille'),
      codeBarre: U.getVal('articleCodeBarre'),
      notes: U.getVal('articleNotes'),
      hs: U.getChecked('articleHS'),
      actif: U.getChecked('articleActif')
    };

    /* FIX C4 : recordPriceChange AVANT de partager le tableau.
       On lit les prix AVANT sauvegarde, on log le changement sur
       l'existing, PUIS on sauvegarde. */
    if (id) {
      var existing = St.getById(id);
      if (existing) {
        raw.createdAt = existing.createdAt;
        raw.prixUpdates = Array.isArray(existing.prixUpdates) ? existing.prixUpdates.slice() : [];

        var newPrix = U.parseNumber(raw.prix);
        var newPrixAchat = U.parseNumber(raw.prixAchat);
        St.recordPriceChange(id, newPrix, newPrixAchat, 'edit');

        /* Récupère le tableau mis à jour par recordPriceChange */
        var updated = St.getById(id);
        if (updated && Array.isArray(updated.prixUpdates)) {
          raw.prixUpdates = updated.prixUpdates;
        }
      }
    }

    var saved = S.save('articles', raw);
    if (!saved) {
      if (errEl) errEl.textContent = 'Données invalides.';
      return;
    }

    St.closeModal();
    St.render();
    U.toast(id ? 'Article modifié' : 'Article créé', 'success', 2500);
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 12 — FORMULAIRE FAMILLE
     ═══════════════════════════════════════════════════════════ */

  St.openFamilleModal = function () {
    U.setVal('familleNom', '');
    U.setVal('familleCouleur', '#0b3d91');
    U.setText('familleFormError', '');
    U.showFlex('familleModal');
    setTimeout(function () {
      try {
        var el = document.getElementById('familleNom');
        if (el) el.focus();
      } catch (e) {
        VC.logError('08-stock', 'openFamilleModal focus échoué', e);
      }
    }, 100);
  };

  St.saveFamilleFromForm = function () {
    var errEl = document.getElementById('familleFormError');
    if (errEl) errEl.textContent = '';

    var nom = U.getVal('familleNom');
    if (!nom) {
      if (errEl) errEl.textContent = 'Nom obligatoire.';
      return;
    }
    if (St.familleExists(nom)) {
      if (errEl) errEl.textContent = 'Cette famille existe déjà.';
      return;
    }

    var saved = S.save('familles', {
      nom: nom,
      couleur: U.getVal('familleCouleur') || '#0b3d91'
    });

    if (!saved) {
      if (errEl) errEl.textContent = 'Données invalides.';
      return;
    }

    U.hide('familleModal');
    St.renderFamilles();
    St.render();
    U.toast('Famille créée', 'success', 2000);
  };

  St.deleteFamille = function (id) {
    if (!S.delete('familles', id)) return;
    St.renderFamilles();
    U.toast('Famille supprimée (les articles gardent leur texte)', 'info', 3000);
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 13 — SUPPRESSION ARTICLE
     ═══════════════════════════════════════════════════════════ */

  St.remove = function (id) {
    var art = St.getById(id);
    if (!art) return;

    /* Vérifie article utilisé dans une facture active */
    var docs = S.getAll('documents');
    for (var i = 0; i < docs.length; i++) {
      var d = docs[i];
      if (!d || d.statut === 'annulee' || d.annulee === true) continue;
      if (!Array.isArray(d.items)) continue;
      for (var j = 0; j < d.items.length; j++) {
        if (d.items[j] && String(d.items[j].articleId || '') === String(id)) {
          U.toast('Article utilisé dans une facture active. Suppression refusée.', 'error', 4000);
          return;
        }
      }
    }

    /* FIX R2 : vérifier aussi les achats */
    var purchases = S.getAll('purchaseInvoices');
    for (var p = 0; p < purchases.length; p++) {
      var pur = purchases[p];
      if (!pur || !Array.isArray(pur.lines)) continue;
      for (var pl = 0; pl < pur.lines.length; pl++) {
        if (pur.lines[pl] && String(pur.lines[pl].articleId || '') === String(id)) {
          U.toast('Article utilisé dans un achat. Suppression refusée.', 'error', 4000);
          return;
        }
      }
    }

    if (!U.confirm('Supprimer l\'article "' + St.getNom(art) + '" ?')) return;

    /* FIX R2 : préserver le nom de l'article dans les lignes de factures
       non actives (brouillon/annulée) et les lignes d'achat. */
    var articleNom = String(St.getNom(art) || '');
    for (var di = 0; di < docs.length; di++) {
      var docItem = docs[di];
      if (!docItem || !Array.isArray(docItem.items)) continue;
      for (var dj = 0; dj < docItem.items.length; dj++) {
        if (docItem.items[dj] && String(docItem.items[dj].articleId || '') === String(id)) {
          docItem.items[dj]._articleNomOrphelin = articleNom;
        }
      }
    }
    for (var pj = 0; pj < purchases.length; pj++) {
      var purItem = purchases[pj];
      if (!purItem || !Array.isArray(purItem.lines)) continue;
      for (var pk = 0; pk < purItem.lines.length; pk++) {
        if (purItem.lines[pk] && String(purItem.lines[pk].articleId || '') === String(id)) {
          purItem.lines[pk]._articleNomOrphelin = articleNom;
        }
      }
    }

    if (!S.delete('articles', id)) {
      U.toast('Erreur suppression.', 'error');
      return;
    }

    S.saveAll();

    St.render();
    U.toastUndo('Article supprimé : ' + St.getNom(art),
      function () { _restoreArticle(id); }, 5000);
  };

  function _restoreArticle(id) {
    var entries = S.getTrashEntries('articles');
    for (var i = 0; i < entries.length; i++) {
      if (entries[i].item && String(entries[i].item.id) === String(id)) {
        S.restoreFromTrash('articles', i);
        // FIX R32-R35 : nettoyer _articleNomOrphelin des lignes restaurées.
        var sid = String(id);
        var docs = S.getAll('documents');
        for (var di = 0; di < docs.length; di++) {
          var doc = docs[di];
          if (!doc || !Array.isArray(doc.items)) continue;
          for (var dj = 0; dj < doc.items.length; dj++) {
            var it = doc.items[dj];
            if (it && String(it.articleId || '') === sid &&
                it._articleNomOrphelin !== undefined) {
              delete it._articleNomOrphelin;
            }
          }
        }
        var purchases = S.getAll('purchaseInvoices');
        for (var pi = 0; pi < purchases.length; pi++) {
          var pur = purchases[pi];
          if (!pur || !Array.isArray(pur.lines)) continue;
          for (var pj = 0; pj < pur.lines.length; pj++) {
            var ln = pur.lines[pj];
            if (ln && String(ln.articleId || '') === sid &&
                ln._articleNomOrphelin !== undefined) {
              delete ln._articleNomOrphelin;
            }
          }
        }
        S.saveAll();
        St.render();
        U.toast('Article restauré', 'success', 2000);
        return;
      }
    }
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 14 — FILTRES + RECHERCHE + PAGINATION
     ═══════════════════════════════════════════════════════════ */

  St.setSearch = function (term) {
    _searchTerm = String(term || '');
    _page = 0;
    St.render();
  };

  St.setFilter = function (mode) {
    _showMode = String(mode || 'actif');
    _page = 0;
    St.render();
  };

  St.setFamilleFilter = function (famille) {
    _familleFilter = String(famille || '');
    _page = 0;
    St.render();
  };

  St.setPage = function (p) {
    _page = Math.max(0, parseInt(p, 10) || 0);
    St.render();
  };

  St.getFiltered = function () {
    var out = S.getAll('articles').slice();

    if (_showMode === 'actif') {
      out = out.filter(St.isActif);
    } else if (_showMode === 'hs') {
      out = out.filter(St.isHS);
    } else if (_showMode === 'alertes') {
      var alertIds = {};
      var alerts = St.computePriceAlerts();
      for (var a = 0; a < alerts.length; a++) {
        alertIds[String(alerts[a].articleId)] = true;
      }
      out = out.filter(function (art) { return alertIds[String(art.id)]; });
    } else if (_showMode === 'sans_famille') {
      out = out.filter(function (art) { return !St.getFamille(art); });
    }

    if (_familleFilter) {
      var fam = U.normalizeText(_familleFilter);
      out = out.filter(function (art) {
        return U.normalizeText(St.getFamille(art)) === fam;
      });
    }

    if (_searchTerm) {
      var term = U.normalizeText(_searchTerm);
      out = out.filter(function (art) {
        var hay = U.normalizeText([
          St.getNom(art), St.getFamille(art), art.codeBarre || ''
        ].join(' '));
        return hay.indexOf(term) >= 0;
      });
    }

    out.sort(function (x, y) {
      var nx = U.normalizeText(St.getNom(x));
      var ny = U.normalizeText(St.getNom(y));
      return nx > ny ? 1 : (nx < ny ? -1 : 0);
    });

    return out;
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 15 — IMPORT / EXPORT
     ═══════════════════════════════════════════════════════════ */

  St.exportJSON = function () {
    var articles = S.getAll('articles');
    var familles = S.getAll('familles');
    var data = {
      version: 1,
      exportedAt: new Date().toISOString(),
      count: articles.length,
      articles: articles,
      familles: familles
    };
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    U.downloadBlob(blob, 'voltcore-articles-' + U.todayISO() + '.json');
    U.toast(articles.length + ' article(s) exporté(s)', 'success');
  };

  St.exportCSV = function () {
    var articles = S.getAll('articles');
    var lines = [];
    lines.push(['Nom', 'Famille', 'Prix', 'PrixAchat', 'Stock', 'Seuil', 'Unite', 'CodeBarre', 'HS'].join('\t'));

    for (var i = 0; i < articles.length; i++) {
      var a = articles[i];
      if (!a) continue;
      lines.push([
        _csv(St.getNom(a)), _csv(St.getFamille(a)),
        String(St.getPrix(a)), String(St.getPrixAchat(a)),
        String(St.getStock(a)), String(St.getSeuil(a)),
        _csv(a.unite || 'U'), _csv(a.codeBarre || ''),
        St.isHS(a) ? 'Oui' : 'Non'
      ].join('\t'));
    }

    var csv = '\uFEFF' + lines.join('\r\n');
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    U.downloadBlob(blob, 'voltcore-articles-' + U.todayISO() + '.csv');
    U.toast('CSV exporté', 'success');
  };

  function _csv(v) {
    return String(v == null ? '' : v).replace(/\t/g, ' ').replace(/\r?\n/g, ' ');
  }

  /**
   * Import avec support des deux schémas :
   * - v6 (nom / prix / prixAchat / hs / actif)  → compatible
   * - article.json legacy (designation / pu / statut) → converti
   */
  St.importJSON = function (file) {
    return new Promise(function (resolve, reject) {
      if (!file) {
        reject(new Error('Fichier requis'));
        return;
      }

      var reader = new FileReader();
      reader.onload = function (ev) {
        try {
          var parsed = JSON.parse(ev.target.result);
          var arr = null, fams = null;

          if (Array.isArray(parsed)) {
            arr = parsed;
          } else if (parsed && Array.isArray(parsed.articles)) {
            arr = parsed.articles;
            fams = Array.isArray(parsed.familles) ? parsed.familles : null;
          }

          if (!arr) {
            reject(new Error('Format invalide : articles[] attendu'));
            return;
          }

          var added = 0, skipped = 0, invalid = 0;
          for (var i = 0; i < arr.length; i++) {
            var converted = _convertLegacyArticle(arr[i]);
            var clean = S.normalize('articles', converted);
            if (!clean) { invalid++; continue; }
            if (St.exists(clean.nom)) { skipped++; continue; }
            if (S.save('articles', clean)) added++;
            else invalid++;
          }

          /* Familles : accepte strings ET objects */
          if (fams) {
            for (var f = 0; f < fams.length; f++) {
              var famItem = fams[f];
              var nomFam = (typeof famItem === 'string') ? famItem
                : (famItem && (famItem.nom || famItem.name)) ? String(famItem.nom || famItem.name)
                : '';
              if (nomFam && !St.familleExists(nomFam)) {
                S.save('familles', {
                  nom: nomFam,
                  couleur: (famItem && famItem.couleur) ? famItem.couleur : '#0b3d91'
                });
              }
            }
          }

          St.render();
          St.renderFamilles();

          var msg = added + ' article(s) importé(s)';
          if (skipped > 0) msg += ' · ' + skipped + ' doublon(s)';
          if (invalid > 0) msg += ' · ' + invalid + ' invalide(s)';
          U.toast(msg, added > 0 ? 'success' : 'warning', 4000);

          resolve({ added: added, skipped: skipped, invalid: invalid });
        } catch (err) {
          VC.logError('08-stock', 'importJSON parse échoué', err);
          reject(err);
        }
      };
      reader.onerror = function () {
        reject(reader.error || new Error('Lecture échouée'));
      };
      reader.readAsText(file);
    });
  };

  /**
   * Convertit un article legacy (article.json / BASE_BLINDE) vers le schéma v7.
   * Champs legacy supportés :
   *   designation → nom
   *   pu          → prix
   *   statut='actif' → actif=true
   */
  function _convertLegacyArticle(raw) {
    if (!raw || typeof raw !== 'object') return raw;

    var out = {};
    var keys = Object.keys(raw);
    for (var i = 0; i < keys.length; i++) {
      out[keys[i]] = raw[keys[i]];
    }

    /* designation → nom */
    if (!out.nom && out.designation) out.nom = out.designation;

    /* pu → prix */
    if (out.pu != null && out.prix == null) out.prix = out.pu;

    /* statut string → actif bool */
    if (typeof out.statut === 'string') {
      out.actif = (out.statut.toLowerCase() === 'actif');
      delete out.statut;
    }

    return out;
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 16 — ÉTIQUETTES
     ═══════════════════════════════════════════════════════════ */

  St.printEtiquettes = function (articleIds) {
    var list;
    if (Array.isArray(articleIds) && articleIds.length > 0) {
      list = [];
      for (var i = 0; i < articleIds.length; i++) {
        var a = St.getById(articleIds[i]);
        if (a) list.push(a);
      }
    } else {
      list = St.getFiltered();
    }

    if (list.length === 0) {
      U.toast('Aucun article à imprimer.', 'warning');
      return;
    }

    var html = '<!DOCTYPE html><html><head><meta charset="UTF-8">' +
      '<title>Étiquettes — VOLTCORE</title><style>' +
      '@page{size:A4;margin:8mm}' +
      'body{margin:0;font-family:Arial,sans-serif;font-size:10px}' +
      '.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:2mm}' +
      '.label{border:1px solid #999;padding:3mm;height:32mm;box-sizing:border-box;overflow:hidden}' +
      '.label-name{font-weight:bold;font-size:11px;margin-bottom:1mm;max-height:5mm;overflow:hidden}' +
      '.label-famille{font-size:8px;color:#666;margin-bottom:1mm}' +
      '.label-code{font-family:monospace;font-size:9px;margin-bottom:1mm}' +
      '.label-prix{font-size:14px;font-weight:bold;color:#1A2B4C}' +
      '.label-unite{font-size:8px;color:#666}' +
      '</style></head><body><div class="grid">';

    for (var j = 0; j < list.length; j++) {
      var art = list[j];
      html += '<div class="label">';
      html += '<div class="label-name">' + U.escapeHtml(St.getNom(art)) + '</div>';
      var fam = St.getFamille(art);
      if (fam) html += '<div class="label-famille">' + U.escapeHtml(fam) + '</div>';
      if (art.codeBarre) html += '<div class="label-code">' + U.escapeHtml(art.codeBarre) + '</div>';
      html += '<div class="label-prix">' + U.formatMoney(St.getPrix(art)) + '</div>';
      html += '<div class="label-unite">/ ' + U.escapeHtml(art.unite || 'U') + '</div>';
      html += '</div>';
    }
    html += '</div></body></html>';

    var w = global.open('', '_blank');
    if (!w) {
      U.toast('Autorise les pop-ups pour imprimer.', 'warning');
      return;
    }
    w.document.write(html);
    w.document.close();
    setTimeout(function () {
      try { w.print(); } catch (e) {
        VC.logError('08-stock', 'printEtiquettes print échoué', e);
      }
    }, 500);
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 17 — PICKER ARTICLE (pour factures)
     ═══════════════════════════════════════════════════════════ */

  function _pickerEnsureModal() {
    if (document.getElementById('articlePickerModal')) return;

    var modal = document.createElement('div');
    modal.id = 'articlePickerModal';
    modal.className = 'modal';
    modal.style.display = 'none';
    modal.innerHTML =
      '<div class="modal-content modal-large">' +
        '<h2>📦 Sélectionner un article</h2>' +
        '<div class="search-bar" style="margin-bottom:12px">' +
          '<input type="text" id="apSearchInput" class="input-search" placeholder="Rechercher…">' +
          '<select id="apFamilleSelect" class="input-select">' +
            '<option value="">Toutes familles</option>' +
          '</select>' +
        '</div>' +
        '<div id="apList" style="max-height:400px;overflow:auto;margin-bottom:12px"></div>' +
        '<div class="modal-actions">' +
          '<button type="button" class="btn" onclick="VC.Stock.closePicker()">Annuler</button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(modal);

    var s = document.getElementById('apSearchInput');
    if (s) {
      s.addEventListener('input', U.debounce(function (ev) {
        _pickerSearch = ev.target.value || '';
        _pickerRenderList();
      }, 200));
    }
    var f = document.getElementById('apFamilleSelect');
    if (f) {
      f.addEventListener('change', function (ev) {
        _pickerFamille = ev.target.value || '';
        _pickerRenderList();
      });
    }
  }

  function _pickerPopulateFamilles() {
    var sel = document.getElementById('apFamilleSelect');
    if (!sel) return;

    var used = {};
    var articles = S.getAll('articles');
    for (var i = 0; i < articles.length; i++) {
      var fam = St.getFamille(articles[i]);
      if (fam) used[fam] = true;
    }
    var keys = Object.keys(used).sort(function (a, b) {
      var na = String(a).toLowerCase(), nb = String(b).toLowerCase();
      return na > nb ? 1 : (na < nb ? -1 : 0);
    });

    var html = '<option value="">Toutes familles</option>';
    for (var k = 0; k < keys.length; k++) {
      html += '<option value="' + U.escapeAttr(keys[k]) + '"' +
        (keys[k] === _pickerFamille ? ' selected' : '') + '>' +
        U.escapeHtml(keys[k]) + '</option>';
    }
    sel.innerHTML = html;
  }

  function _pickerRenderList() {
    var el = document.getElementById('apList');
    if (!el) return;

    var articles = S.getAll('articles');
    if (articles.length === 0) {
      el.innerHTML = '<div class="muted" style="padding:16px;text-align:center">Aucun article dans le stock.</div>';
      return;
    }

    var term = _pickerSearch ? U.normalizeText(_pickerSearch) : '';
    var famFilter = _pickerFamille ? _pickerFamille.toLowerCase() : '';

    var rows = [];
    for (var i = 0; i < articles.length; i++) {
      var art = articles[i];
      if (!art) continue;
      if (!St.isActif(art)) continue;

      var nom = St.getNom(art);
      var famille = St.getFamille(art);
      var codeBarre = String(art.codeBarre || '');

      if (famFilter && famille.toLowerCase() !== famFilter) continue;

      if (term) {
        var hay = U.normalizeText([nom, famille, codeBarre].join(' '));
        if (hay.indexOf(term) < 0) continue;
      }
      rows.push(art);
    }

    rows.sort(function (a, b) {
      var na = St.getNom(a).toLowerCase();
      var nb = St.getNom(b).toLowerCase();
      return na > nb ? 1 : (na < nb ? -1 : 0);
    });

    if (rows.length === 0) {
      el.innerHTML = '<div class="muted" style="padding:16px;text-align:center">Aucun article ne correspond.</div>';
      return;
    }

    var html = '';
    for (var j = 0; j < rows.length; j++) {
      var r = rows[j];
      var id = String(r.id || '');
      var nomR = St.getNom(r);
      var famR = St.getFamille(r);
      var prixR = St.getPrix(r);
      var uniteR = String(r.unite || 'U');

      html += '<div class="article-picker-row" data-ap-id="' + U.escapeAttr(id) + '" ' +
        'style="display:flex;justify-content:space-between;align-items:center;' +
        'padding:10px;border-bottom:1px solid #eee;cursor:pointer">' +
        '<div style="flex:1">' +
          '<div style="font-weight:600">' + U.escapeHtml(nomR) + '</div>' +
          '<div style="font-size:12px;color:#666">' +
            (famR ? U.escapeHtml(famR) + ' · ' : '') +
            U.formatMoney(prixR) + ' / ' + U.escapeHtml(uniteR) +
          '</div>' +
        '</div>' +
        '<div style="color:#1A2B4C;font-size:20px">➕</div>' +
      '</div>';
    }
    el.innerHTML = html;

    /* FIX closure historique : IIFE par ligne */
    var items = el.querySelectorAll('[data-ap-id]');
    for (var k = 0; k < items.length; k++) {
      (function (item) {
        item.addEventListener('click', function (ev) {
          try { ev.preventDefault(); } catch (e) {
            VC.logError('08-stock', 'picker click preventDefault échoué', e);
          }
          _pickerSelect(item.getAttribute('data-ap-id'));
        });
      })(items[k]);
    }
  }

  function _pickerSelect(articleId) {
    var art = St.getById(articleId);
    if (!art) {
      U.toast('Article introuvable.', 'error');
      return;
    }
    var cb = _pickerCb;
    _pickerCb = null;
    St.closePicker();
    if (typeof cb === 'function') {
      try { cb(art); } catch (e) {
        VC.logError('08-stock', 'picker callback échoué', e);
      }
    }
  }

  St.openPicker = function (callback) {
    _pickerCb = (typeof callback === 'function') ? callback : null;
    _pickerSearch = '';
    _pickerFamille = '';
    _pickerEnsureModal();
    _pickerPopulateFamilles();
    U.setVal('apSearchInput', '');
    U.setVal('apFamilleSelect', '');
    _pickerRenderList();
    U.showFlex('articlePickerModal');
    setTimeout(function () {
      try {
        var el = document.getElementById('apSearchInput');
        if (el) el.focus();
      } catch (e) {
        VC.logError('08-stock', 'openPicker focus échoué', e);
      }
    }, 100);
  };

  St.closePicker = function () {
    U.hide('articlePickerModal');
    _pickerCb = null;
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 18 — EVENTS
     ═══════════════════════════════════════════════════════════ */

  St.attachEvents = function () {
    U.on('stockSearchInput', 'input', U.debounce(function (ev) {
      St.setSearch(ev.target.value);
    }, 250));

    U.on('stockFilterSelect', 'change', function (ev) {
      St.setFilter(ev.target.value);
    });

    U.on('stockFamilleFilterSelect', 'change', function (ev) {
      St.setFamilleFilter(ev.target.value);
    });

    U.on('stockPrevBtn', 'click', function () {
      St.setPage(_page - 1);
    });

    U.on('stockNextBtn', 'click', function () {
      St.setPage(_page + 1);
    });

    U.on('btnAddArticle', 'click', function () {
      St.openModal(null);
    });

    U.on('btnAddFamille', 'click', function () {
      St.openFamilleModal();
    });

    U.on('btnImportStock', 'click', function () {
      var input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json,application/json';
      input.onchange = function (ev) {
        var f = ev.target.files && ev.target.files[0];
        if (!f) return;
        St.importJSON(f).catch(function (err) {
          U.toast('Import échoué : ' + (err.message || ''), 'error');
        });
      };
      input.click();
    });

    U.on('btnExportStockJSON', 'click', St.exportJSON);
    U.on('btnExportStockCSV', 'click', St.exportCSV);
    U.on('btnPrintEtiquettes', 'click', function () {
      St.printEtiquettes(null);
    });

    /* Subscribe : re-render auto */
    S.subscribe('articles', function () {
      St.render();
    });
    S.subscribe('familles', function () {
      St.renderFamilles();
    });

  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 19 — MARQUEUR
     ═══════════════════════════════════════════════════════════ */
  /* ═══════════════════════════════════════════════════════════
     FIX R32-R35-TER : nettoyage _articleNomOrphelin sur TOUS
     les chemins de restore. Subscribe au niveau module.
     ═══════════════════════════════════════════════════════════ */
  (function _watchArticleRestores() {
    S.subscribe('articles', function (ev) {
      try {
        if (!ev || ev.action !== 'restore' || !ev.item || !ev.item.id) return;
        var sid = String(ev.item.id);
        var docs = S.getAll('documents');
        var purchases = S.getAll('purchaseInvoices');
        var dirty = false;
        for (var di = 0; di < docs.length; di++) {
          var doc = docs[di];
          if (!doc || !Array.isArray(doc.items)) continue;
          for (var dj = 0; dj < doc.items.length; dj++) {
            var it = doc.items[dj];
            if (it && String(it.articleId || '') === sid &&
                it._articleNomOrphelin !== undefined) {
              delete it._articleNomOrphelin;
              dirty = true;
            }
          }
        }
        for (var pi = 0; pi < purchases.length; pi++) {
          var pur = purchases[pi];
          if (!pur || !Array.isArray(pur.lines)) continue;
          for (var pj = 0; pj < pur.lines.length; pj++) {
            var ln = pur.lines[pj];
            if (ln && String(ln.articleId || '') === sid &&
                ln._articleNomOrphelin !== undefined) {
              delete ln._articleNomOrphelin;
              dirty = true;
            }
          }
        }
        if (dirty) S.saveAll();
      } catch (e) {
        VC.logError('08-stock', 'restore cleanup flag échoué', e);
      }
    });
  })();
  VC._stockLoaded = true;

  VC.logInfo('08-stock', 'Module chargé');

})(window);