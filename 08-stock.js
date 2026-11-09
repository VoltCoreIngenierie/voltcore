/* ═══════════════════════════════════════════════════════════════
   VOLTCORE — 08-stock.js
   VERSION : v6.7 (Session #3 — closure _apRenderList corrigée,
                   ordre recordPriceChange corrigé, versions bumpées)
   RÔLE : Catalogue articles + familles + historique prix +
          alertes prix vus + pagination + étiquettes + import/export +
          sélecteur d'articles (pour factures)
   DÉPENDANCES : 01-core.js (savedArticles, familles, externalPrices,
                  trash, currentUser), 03-utils.js (helpers,
                  _fallbackDownload), 04-storage.js (saveAll)
   EXPOSE : getArticleById, getArticleNom, getArticlePrix,
            getArticlePrixAchat, getArticleFamille,
            articleExists, recordPriceChange, getPriceHistory,
            computeArticleStockAlerts, countArticleAlerts,
            renderStock, renderArticleRow, openArticleDetail,
            closeArticleDetail, openArticleModal, closeArticleModal,
            saveArticleFromForm, deleteArticle,
            openFamilleModal, saveFamilleFromForm, deleteFamille,
            renderFamilles, setStockSearch, setStockFilter,
            setStockFamilleFilter, setStockPage, getFilteredArticles,
            exportStockJSON, exportStockCSV, importStockJSON,
            printEtiquettes, attachStockEvents,
            openArticlePicker, closeArticlePicker,
            attachArticlePickerEvents
   SECTIONS :
     1  : ÉTAT
     2  : HELPERS ARTICLES
     3  : HELPERS FAMILLES
     4  : HISTORIQUE PRIX
     5  : ALERTES ARTICLES
     6  : RENDU LISTE
     7  : RENDU DÉTAIL
     8  : FORMULAIRE ARTICLE
     9  : FORMULAIRE FAMILLE
     10 : SUPPRESSION AVEC UNDO
     11 : RECHERCHE / FILTRES / PAGINATION
     12 : IMPORT / EXPORT
     13 : ÉTIQUETTES
     14 : ÉVÉNEMENTS
     15 : ARTICLE PICKER (sélecteur pour factures)
   ═══════════════════════════════════════════════════════════════ */

/* ═══════════ SECTION 1 — ÉTAT ═══════════ */

var __stockSearchTerm = '';
var __stockFamilleFilter = '';

/* ═══════════ SECTION 2 — HELPERS ARTICLES ═══════════ */

function getArticleById(id) {
  try {
    if (!id || !Array.isArray(savedArticles)) return null;
    var sid = String(id);
    for (var i = 0; i < savedArticles.length; i++) {
      if (savedArticles[i] && String(savedArticles[i].id) === sid) return savedArticles[i];
    }
    return null;
  } catch (e) {
    console.warn('getArticleById :', e);
    return null;
  }
}

/* Retourne le nom (support .nom, .designation, .name). */
function getArticleNom(art) {
  if (!art) return '';
  return String(art.nom || art.designation || art.name || '');
}

function getArticlePrix(art) {
  if (!art) return 0;
  if (typeof art.prix === 'number') return art.prix;
  if (typeof art.prixVente === 'number') return art.prixVente;
  return parseNumber(art.prix || art.prixVente) || 0;
}

function getArticlePrixAchat(art) {
  if (!art) return 0;
  if (typeof art.prixAchat === 'number') return art.prixAchat;
  if (typeof art.purchasePrice === 'number') return art.purchasePrice;
  return parseNumber(art.prixAchat || art.purchasePrice) || 0;
}

function getArticleFamille(art) {
  if (!art) return '';
  return String(art.famille || art.familleNom || art.categorie || '').trim();
}

function _articleIsHS(art) {
  if (!art) return false;
  return art.hs === true || art.isHS === true || art.horsStock === true;
}

function _articleIsActif(art) {
  if (!art) return false;
  return art.actif !== false;
}

function _articleStock(art) {
  if (!art) return 0;
  return parseFloat(art.stock || art.quantite || 0) || 0;
}

function _articleSeuil(art) {
  if (!art) return 0;
  return parseFloat(art.seuil || art.alerteSeuil || 0) || 0;
}

function articleExists(nom, excludeId) {
  try {
    if (!nom || !Array.isArray(savedArticles)) return false;
    var normalized = normalizeText(nom);
    for (var i = 0; i < savedArticles.length; i++) {
      var a = savedArticles[i];
      if (!a) continue;
      if (excludeId && String(a.id) === String(excludeId)) continue;
      if (normalizeText(getArticleNom(a)) === normalized) return true;
    }
    return false;
  } catch (e) { return false; }
}

/* Normalise un article brut avant stockage. */
function _normalizeArticle(raw) {
  if (!raw || typeof raw !== 'object') return null;
  var nom = String(raw.nom || raw.designation || raw.name || '').trim().replace(/\s+/g, ' ');
  if (!nom) return null;

  var out = {
    id: raw.id || ('art_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)),
    nom: nom,
    designation: nom,  /* alias compat */
    prix: parseNumber(raw.prix),
    prixAchat: parseNumber(raw.prixAchat),
    seuil: parseNumber(raw.seuil),
    stock: parseNumber(raw.stock),
    unite: String(raw.unite || 'U').trim(),
    famille: String(raw.famille || raw.familleNom || raw.categorie || '').trim(),
    codeBarre: String(raw.codeBarre || raw.codebarre || '').trim(),
    hs: raw.hs === true || raw.isHS === true || raw.horsStock === true,
    actif: raw.actif !== false,
    notes: String(raw.notes || '').trim(),
    prixUpdates: Array.isArray(raw.prixUpdates) ? raw.prixUpdates.slice(-50) : [],
    createdAt: raw.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  return out;
}

/* ═══════════ SECTION 3 — HELPERS FAMILLES ═══════════ */

function getFamilleById(id) {
  try {
    if (!id || !Array.isArray(familles)) return null;
    var sid = String(id);
    for (var i = 0; i < familles.length; i++) {
      if (familles[i] && String(familles[i].id) === sid) return familles[i];
    }
    return null;
  } catch (e) { return null; }
}

function getFamilleNom(famille) {
  if (!famille) return '';
  if (typeof famille === 'string') return famille;
  return String(famille.nom || famille.name || '');
}

function familleExists(nom, excludeId) {
  try {
    if (!nom || !Array.isArray(familles)) return false;
    var normalized = normalizeText(nom);
    for (var i = 0; i < familles.length; i++) {
      var f = familles[i];
      if (!f) continue;
      if (excludeId && String(f.id) === String(excludeId)) continue;
      if (normalizeText(getFamilleNom(f)) === normalized) return true;
    }
    return false;
  } catch (e) { return false; }
}

function _normalizeFamille(raw) {
  if (!raw || typeof raw !== 'object') return null;
  var nom = String(raw.nom || raw.name || '').trim().replace(/\s+/g, ' ');
  if (!nom) return null;
  return {
    id: raw.id || ('fam_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6)),
    nom: nom,
    couleur: String(raw.couleur || '#0b3d91').trim(),
    createdAt: raw.createdAt || new Date().toISOString()
  };
}

/* Rendu de la liste des familles utilisées (pour filtre + formulaire). */
function renderFamilles() {
  try {
    var sel = document.getElementById('stockFamilleFilterSelect');
    if (sel) {
      var used = {};
      if (Array.isArray(savedArticles)) {
        for (var i = 0; i < savedArticles.length; i++) {
          var f = getArticleFamille(savedArticles[i]);
          if (f) used[f] = true;
        }
      }
      var names = Object.keys(used).sort(function (a, b) {
        return normalizeText(a) > normalizeText(b) ? 1 : -1;
      });
      var html = '<option value="">Toutes familles</option>';
      for (var j = 0; j < names.length; j++) {
        html += '<option value="' + escapeAttr(names[j]) + '"' +
          (names[j] === __stockFamilleFilter ? ' selected' : '') + '>' +
          escapeHtml(names[j]) + '</option>';
      }
      sel.innerHTML = html;
    }

    var list = document.getElementById('famillesList');
    if (list) {
      var arr = Array.isArray(familles) ? familles : [];
      if (arr.length === 0) {
        list.innerHTML = '<div class="empty-state">Aucune famille définie.</div>';
      } else {
        var h = '';
        for (var k = 0; k < arr.length; k++) {
          var fa = arr[k];
          var fid = escapeAttr(fa.id);
          h += '<div class="famille-row">' +
            '<span class="famille-color" style="background:' + escapeAttr(fa.couleur || '#0b3d91') + '"></span>' +
            '<span class="famille-nom">' + escapeHtml(getFamilleNom(fa)) + '</span>' +
            '<button type="button" class="btn-icon btn-danger" title="Supprimer" ' +
            'onclick="deleteFamille(\'' + fid + '\')">🗑️</button>' +
            '</div>';
        }
        list.innerHTML = h;
      }
    }
  } catch (e) { console.warn('renderFamilles :', e); }
}

/* ═══════════ SECTION 4 — HISTORIQUE PRIX ═══════════ */

function recordPriceChange(articleId, newPrix, newPrixAchat, source, note) {
  try {
    var art = getArticleById(articleId);
    if (!art) return;
    var oldPrix = getArticlePrix(art);
    var oldPrixAchat = getArticlePrixAchat(art);

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
      if (art.prixUpdates.length > 50) art.prixUpdates = art.prixUpdates.slice(-50);
    }
  } catch (e) { console.warn('recordPriceChange :', e); }
}

function getPriceHistory(articleId) {
  try {
    var art = getArticleById(articleId);
    if (!art || !Array.isArray(art.prixUpdates)) return [];
    return art.prixUpdates.slice().sort(function (a, b) {
      return String(b.date) > String(a.date) ? 1 : -1;
    });
  } catch (e) { return []; }
}

/* ═══════════ SECTION 5 — ALERTES ARTICLES ═══════════ */

function computeArticleStockAlerts() {
  var out = [];
  try {
    if (!Array.isArray(savedArticles) || !externalPrices) return out;
    for (var i = 0; i < savedArticles.length; i++) {
      var art = savedArticles[i];
      if (!art || !art.id) continue;
      var key = String(art.id);
      var entries = externalPrices[key];
      if (!Array.isArray(entries) || entries.length === 0) continue;

      var prixAchat = getArticlePrixAchat(art);
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
          articleNom: getArticleNom(art),
          meilleurPrix: minPrix,
          prixAchatActuel: prixAchat,
          fournisseur: minF,
          ecartPct: ((prixAchat - minPrix) / prixAchat) * 100,
          date: minDate
        });
      }
    }
    out.sort(function (a, b) { return b.ecartPct - a.ecartPct; });
  } catch (e) { console.warn('computeArticleStockAlerts :', e); }
  return out;
}

function countArticleAlerts() {
  try { return computeArticleStockAlerts().length; }
  catch (e) { return 0; }
}

/* ═══════════ SECTION 6 — RENDU LISTE ═══════════ */

function renderStock() {
  try {
    var container = document.getElementById('stockList');
    if (!container) return;

    var all = getFilteredArticles();
    var total = all.length;
    var perPage = parseInt(window.__stockPerPage, 10) || 50;
    var page = parseInt(window.__stockPage, 10) || 0;
    var maxPage = Math.max(0, Math.ceil(total / perPage) - 1);
    if (page > maxPage) { page = maxPage; window.__stockPage = page; }
    var start = page * perPage;
    var end = Math.min(start + perPage, total);
    var slice = all.slice(start, end);

    /* LOT 4 — OPTIMISATION : calculer les alertes UNE SEULE FOIS */
    var alertsByArticleId = {};
    if (typeof computeArticleStockAlerts === 'function') {
      var allAlerts = computeArticleStockAlerts();
      for (var a = 0; a < allAlerts.length; a++) {
        alertsByArticleId[String(allAlerts[a].articleId)] = allAlerts[a];
      }
    }
    /* FIN OPTIMISATION */

    window.__stockFilteredList = all;

    if (slice.length === 0) {
      container.innerHTML = '<div class="empty-state">Aucun article' +
        (__stockSearchTerm || window.__stockShowMode !== 'actif' ? ' pour ce filtre' : '') +
        '. Clique sur "+ Nouvel article" pour commencer.</div>';
      _updateStockPagination(0, 0, total);
      _updateStockCount(total);
      return;
    }

    var html = '';
    for (var i = 0; i < slice.length; i++) {
      html += renderArticleRow(slice[i], alertsByArticleId);
    }
    container.innerHTML = html;
    _updateStockPagination(page, maxPage, total);
    _updateStockCount(total);
    renderFamilles();
  } catch (e) { console.warn('renderStock :', e); }
}

function renderArticleRow(art, alertsByArticleId) {
  try {
    if (!art) return '';
    var id = escapeAttr(art.id);
    var nom = escapeHtml(getArticleNom(art) || '(Sans nom)');
    var famille = escapeHtml(getArticleFamille(art) || '');
    var prix = getArticlePrix(art);
    var prixAchat = getArticlePrixAchat(art);
    var margePct = prix > 0 ? ((prix - prixAchat) / prix) * 100 : 0;
    var margeColor = margePct >= 20 ? 'var(--success)'
                    : margePct >= 0 ? 'var(--warning)'
                    : 'var(--danger)';

    var badges = '';
    if (_articleIsHS(art)) badges += '<span class="badge badge-hs" title="Hors stock">HS</span> ';
    if (!_articleIsActif(art)) badges += '<span class="badge badge-muted" title="Inactif">Inactif</span> ';
    var stock = _articleStock(art);
    var seuil = _articleSeuil(art);
    if (seuil > 0 && stock <= seuil) {
      badges += '<span class="badge badge-warning" title="Stock bas">⚠ Stock bas</span> ';
    }

    /* LOT 4 — OPTIMISATION : lookup O(1) au lieu de recalculer */
    var alert = alertsByArticleId ? alertsByArticleId[String(art.id)] : null;
    if (alert) {
      badges += '<span class="badge badge-info" title="Prix vu moins cher">💡 −' +
        alert.ecartPct.toFixed(0) + '%</span> ';
    }
    /* FIN OPTIMISATION */

    var metaParts = [];
    if (famille) metaParts.push(famille);
    metaParts.push('Prix : ' + formatMoney(prix));
    if (prixAchat > 0) metaParts.push('Achat : ' + formatMoney(prixAchat));
    var meta = metaParts.join(' · ');

    return '<div class="stock-row" data-article-id="' + id + '">' +
      '<div class="stock-row-main">' +
        '<div class="stock-row-name">' + nom + ' ' + badges + '</div>' +
        '<div class="stock-row-meta">' + meta + '</div>' +
        '<div class="stock-row-marge" style="color:' + margeColor + '">Marge : ' +
          margePct.toFixed(1) + '%</div>' +
      '</div>' +
      '<div class="stock-row-actions">' +
        '<button type="button" class="btn-icon" title="Détail" ' +
          'onclick="openArticleDetail(\'' + id + '\')">👁️</button>' +
        '<button type="button" class="btn-icon" title="Éditer" ' +
          'onclick="openArticleModal(\'' + id + '\')">✏️</button>' +
        '<button type="button" class="btn-icon btn-danger" title="Supprimer" ' +
          'onclick="deleteArticle(\'' + id + '\')">🗑️</button>' +
      '</div>' +
    '</div>';
  } catch (e) { console.warn('renderArticleRow :', e); return ''; }
}

function _updateStockCount(n) {
  try {
    var el = document.getElementById('stockCount');
    if (el) el.textContent = String(n);
  } catch (e) {}
}

function _updateStockPagination(page, maxPage, total) {
  try {
    var info = document.getElementById('stockPageInfo');
    if (info) info.textContent = total > 0
      ? 'Page ' + (page + 1) + ' / ' + (maxPage + 1) + ' — ' + total + ' article(s)'
      : '0 article';
    var prev = document.getElementById('stockPrevBtn');
    if (prev) prev.disabled = (page <= 0);
    var next = document.getElementById('stockNextBtn');
    if (next) next.disabled = (page >= maxPage);
  } catch (e) {}
}

/* ═══════════ SECTION 7 — RENDU DÉTAIL ═══════════ */

function openArticleDetail(id) {
  try {
    var art = getArticleById(id);
    if (!art) return;
    var modal = document.getElementById('articleDetailModal');
    var body = document.getElementById('articleDetailBody');
    var title = document.getElementById('articleDetailTitle');
    if (!modal || !body) return;

    if (title) title.textContent = getArticleNom(art);

    var html = '<div class="detail-section"><h3>Fiche article</h3><div class="detail-grid">';
    html += _artDetailItem('Famille', getArticleFamille(art) || '—');
    html += _artDetailItem('Unité', String(art.unite || 'U'));
    html += _artDetailItem('Prix vente', formatMoney(getArticlePrix(art)));
    html += _artDetailItem('Prix achat', formatMoney(getArticlePrixAchat(art)));
    html += _artDetailItem('Code-barre', String(art.codeBarre || '—'));
    html += _artDetailItem('Stock', String(_articleStock(art)));
    html += _artDetailItem('Seuil', String(_articleSeuil(art)));
    html += _artDetailItem('Hors stock', _articleIsHS(art) ? 'Oui' : 'Non');
    html += '</div></div>';

    var hist = getPriceHistory(id);
    if (hist.length > 0) {
      html += '<div class="detail-section"><h3>Historique prix (' + hist.length + ')</h3>';
      html += '<div class="price-history">';
      for (var i = 0; i < Math.min(hist.length, 20); i++) {
        var h = hist[i];
        var upAchat = h.newPrixAchat > h.oldPrixAchat;
        var arrow = upAchat ? '↑' : (h.newPrixAchat < h.oldPrixAchat ? '↓' : '=');
        var color = upAchat ? 'var(--danger)' : (h.newPrixAchat < h.oldPrixAchat ? 'var(--success)' : 'var(--muted)');
        html += '<div class="price-history-row">' +
          '<span class="muted">' + escapeHtml(formatDate(h.date)) + '</span>' +
          ' — Achat : ' + formatMoney(h.oldPrixAchat) + ' → ' + formatMoney(h.newPrixAchat) +
          ' <span style="color:' + color + '">' + arrow + '</span>' +
          ' <span class="muted">(' + escapeHtml(h.source || 'edit') + ')</span>' +
          '</div>';
      }
      html += '</div></div>';
    }

    var alerts = computeArticleStockAlerts().filter(function (a) {
      return String(a.articleId) === String(id);
    });
    if (alerts.length > 0) {
      html += '<div class="detail-section"><h3>💡 Meilleur prix vu</h3>';
      var a = alerts[0];
      html += '<div class="alert-prix">' +
        'Fournisseur : ' + escapeHtml(a.fournisseur || '?') + '<br>' +
        'Prix : ' + formatMoney(a.meilleurPrix) + '<br>' +
        'Écart vs ton prix achat : −' + a.ecartPct.toFixed(1) + '%<br>' +
        '<span class="muted">Vu le ' + escapeHtml(formatDate(a.date)) + '</span>' +
        '</div></div>';
    }

    body.innerHTML = html;
    modal.style.display = 'flex';
  } catch (e) { console.warn('openArticleDetail :', e); }
}

function closeArticleDetail() {
  try {
    var m = document.getElementById('articleDetailModal');
    if (m) m.style.display = 'none';
  } catch (e) {}
}

function _artDetailItem(label, value) {
  return '<div class="detail-item"><div class="detail-label">' + escapeHtml(label) +
    '</div><div class="detail-value">' + escapeHtml(value) + '</div></div>';
}

/* ═══════════ SECTION 8 — FORMULAIRE ARTICLE ═══════════
   v6.7 (Session #3) : ordre recordPriceChange corrigé.
   Avant : clean.prixUpdates était affecté AVANT recordPriceChange,
   donc le tableau poussé par recordPriceChange (sur existing.prixUpdates)
   était orphelin → 1er changement perdu pour les articles "legacy"
   (créés avant que le champ prixUpdates n'existe).
   Après : recordPriceChange écrit d'abord, PUIS clean partage le tableau.
*/

function openArticleModal(articleId) {
  try {
    var modal = document.getElementById('articleModal');
    var title = document.getElementById('articleModalTitle');
    if (!modal) return;

    var form = document.getElementById('articleForm');
    if (form) form.reset();

    /* Populate famille datalist */
    var dl = document.getElementById('famillesDatalist');
    if (dl) {
      var opts = '';
      var used = {};
      if (Array.isArray(savedArticles)) {
        for (var i = 0; i < savedArticles.length; i++) {
          var f = getArticleFamille(savedArticles[i]);
          if (f) used[f] = true;
        }
      }
      var keys = Object.keys(used);
      for (var k = 0; k < keys.length; k++) {
        opts += '<option value="' + escapeAttr(keys[k]) + '">';
      }
      dl.innerHTML = opts;
    }

    if (articleId) {
      var art = getArticleById(articleId);
      if (!art) return;
      if (title) title.textContent = 'Modifier article';
      _artFill('articleId', art.id);
      _artFill('articleNom', getArticleNom(art));
      _artFill('articlePrix', getArticlePrix(art));
      _artFill('articlePrixAchat', getArticlePrixAchat(art));
      _artFill('articleSeuil', _articleSeuil(art));
      _artFill('articleStock', _articleStock(art));
      _artFill('articleUnite', art.unite || 'U');
      _artFill('articleFamille', getArticleFamille(art));
      _artFill('articleCodeBarre', art.codeBarre || '');
      _artFill('articleNotes', art.notes || '');
      var hsCb = document.getElementById('articleHS');
      if (hsCb) hsCb.checked = _articleIsHS(art);
      var actifCb = document.getElementById('articleActif');
      if (actifCb) actifCb.checked = _articleIsActif(art);
    } else {
      if (title) title.textContent = 'Nouvel article';
      _artFill('articleId', '');
      var hsCb2 = document.getElementById('articleHS');
      if (hsCb2) hsCb2.checked = false;
      var actifCb2 = document.getElementById('articleActif');
      if (actifCb2) actifCb2.checked = true;
    }

    var errEl = document.getElementById('articleFormError');
    if (errEl) errEl.textContent = '';

    modal.style.display = 'flex';
    var nomInput = document.getElementById('articleNom');
    if (nomInput) setTimeout(function () { try { nomInput.focus(); } catch (e) {} }, 100);
  } catch (e) { console.warn('openArticleModal :', e); }
}

function closeArticleModal() {
  try {
    var m = document.getElementById('articleModal');
    if (m) m.style.display = 'none';
  } catch (e) {}
}

function _artFill(id, value) {
  try {
    var el = document.getElementById(id);
    if (el) el.value = (value === null || value === undefined) ? '' : value;
  } catch (e) {}
}

function _artGet(id) {
  try {
    var el = document.getElementById(id);
    return el ? String(el.value || '').trim() : '';
  } catch (e) { return ''; }
}

function _artChecked(id) {
  try { var el = document.getElementById(id); return !!(el && el.checked); }
  catch (e) { return false; }
}

function saveArticleFromForm() {
  try {
    var errEl = document.getElementById('articleFormError');
    var id = _artGet('articleId');
    var nom = _artGet('articleNom');

    if (!nom) {
      if (errEl) errEl.textContent = 'Le nom est obligatoire.';
      return;
    }
    if (articleExists(nom, id)) {
      if (errEl) errEl.textContent = 'Un article avec ce nom existe déjà.';
      return;
    }

    var raw = {
      id: id || undefined,
      nom: nom,
      prix: _artGet('articlePrix'),
      prixAchat: _artGet('articlePrixAchat'),
      seuil: _artGet('articleSeuil'),
      stock: _artGet('articleStock'),
      unite: _artGet('articleUnite') || 'U',
      famille: _artGet('articleFamille'),
      codeBarre: _artGet('articleCodeBarre'),
      notes: _artGet('articleNotes'),
      hs: _artChecked('articleHS'),
      actif: _artChecked('articleActif')
    };

    var clean = _normalizeArticle(raw);
    if (!clean) { if (errEl) errEl.textContent = 'Données invalides.'; return; }

    if (id) {
      var existing = getArticleById(id);
      if (!existing) { if (errEl) errEl.textContent = 'Article introuvable.'; return; }
      clean.createdAt = existing.createdAt;
      var idx = savedArticles.indexOf(existing);
      /* v6.7 — Ordre corrigé : recordPriceChange écrit d'abord dans
         existing.prixUpdates (créant le tableau si besoin), PUIS clean
         partage ce même tableau. Avant, clean récupérait une copie vide
         et l'entrée poussée par recordPriceChange devenait orpheline. */
      recordPriceChange(id, clean.prix, clean.prixAchat, 'edit');
      clean.prixUpdates = existing.prixUpdates || [];
      savedArticles[idx] = clean;
    } else {
      savedArticles.push(clean);
    }

    if (typeof saveAll === 'function') saveAll();
    if (typeof logAction === 'function') {
      logAction(id ? 'article.update' : 'article.create', clean.nom);
    }

    closeArticleModal();
    renderStock();
    if (typeof showToast === 'function') {
      showToast(id ? 'Article modifié' : 'Article créé', 'success', 2500);
    }
  } catch (e) {
    console.warn('saveArticleFromForm :', e);
    var errEl2 = document.getElementById('articleFormError');
    if (errEl2) errEl2.textContent = 'Erreur lors de l\'enregistrement.';
  }
}

/* ═══════════ SECTION 9 — FORMULAIRE FAMILLE ═══════════ */

function openFamilleModal() {
  try {
    var modal = document.getElementById('familleModal');
    if (!modal) return;
    _artFill('familleNom', '');
    _artFill('familleCouleur', '#0b3d91');
    var errEl = document.getElementById('familleFormError');
    if (errEl) errEl.textContent = '';
    modal.style.display = 'flex';
    var input = document.getElementById('familleNom');
    if (input) setTimeout(function () { try { input.focus(); } catch (e) {} }, 100);
  } catch (e) { console.warn('openFamilleModal :', e); }
}

function saveFamilleFromForm() {
  try {
    var errEl = document.getElementById('familleFormError');
    var nom = _artGet('familleNom');
    var couleur = _artGet('familleCouleur') || '#0b3d91';

    if (!nom) { if (errEl) errEl.textContent = 'Nom obligatoire.'; return; }
    if (familleExists(nom)) { if (errEl) errEl.textContent = 'Cette famille existe déjà.'; return; }

    var clean = _normalizeFamille({ nom: nom, couleur: couleur });
    if (!clean) { if (errEl) errEl.textContent = 'Données invalides.'; return; }

    if (!Array.isArray(familles)) familles = [];
    familles.push(clean);

    if (typeof saveAll === 'function') saveAll();
    if (typeof logAction === 'function') logAction('famille.create', clean.nom);

    var modal = document.getElementById('familleModal');
    if (modal) modal.style.display = 'none';
    renderFamilles();
    renderStock();
    if (typeof showToast === 'function') showToast('Famille créée', 'success', 2000);
  } catch (e) { console.warn('saveFamilleFromForm :', e); }
}

function deleteFamille(id) {
  try {
    if (!Array.isArray(familles)) return;
    var idx = familles.findIndex(function (f) { return f && String(f.id) === String(id); });
    if (idx < 0) return;
    var removed = familles.splice(idx, 1)[0];
    if (typeof saveAll === 'function') saveAll();
    if (typeof logAction === 'function') logAction('famille.delete', getFamilleNom(removed));
    renderFamilles();
    if (typeof showToast === 'function') {
      showToast('Famille supprimée (les articles gardent leur texte de famille)', 'info', 3000);
    }
  } catch (e) { console.warn('deleteFamille :', e); }
}

/* ═══════════ SECTION 10 — SUPPRESSION AVEC UNDO ═══════════ */

function deleteArticle(id) {
  try {
    var art = getArticleById(id);
    if (!art) return;

    /* Sécurité : refuse si article utilisé dans un doc non annulé */
    if (Array.isArray(savedDocuments)) {
      for (var i = 0; i < savedDocuments.length; i++) {
        var d = savedDocuments[i];
        if (!d || d.statut === 'annulee' || d.annulee === true) continue;
        if (Array.isArray(d.items)) {
          for (var j = 0; j < d.items.length; j++) {
            if (d.items[j] && String(d.items[j].articleId || '') === String(id)) {
              if (typeof showToast === 'function') {
                showToast('Article utilisé dans une facture active. Suppression refusée.', 'error', 4000);
              }
              return;
            }
          }
        }
      }
    }

    var idx = savedArticles.indexOf(art);
    if (idx < 0) return;
    savedArticles.splice(idx, 1);

    if (!trash || typeof trash !== 'object') trash = { clients: [], articles: [], documents: [] };
    if (!Array.isArray(trash.articles)) trash.articles = [];
    var entry = {
      item: art,
      deletedAt: new Date().toISOString(),
      deletedBy: (typeof currentUser !== 'undefined' && currentUser && currentUser.username) || 'anon'
    };
    trash.articles.push(entry);

    if (typeof saveAll === 'function') saveAll();
    if (typeof logAction === 'function') logAction('article.delete', getArticleNom(art));
    renderStock();

    if (typeof showUndoToast === 'function') {
      showUndoToast('Article supprimé : ' + getArticleNom(art),
        function () { _restoreDeletedArticle(entry, art); }, 5000);
    } else if (typeof showToast === 'function') {
      showToast('Article déplacé dans la corbeille.', 'info', 3000);
    }
  } catch (e) { console.warn('deleteArticle :', e); }
}

function _restoreDeletedArticle(entry, art) {
  try {
    if (!entry || !art) return;
    if (Array.isArray(trash.articles)) {
      var idx = trash.articles.indexOf(entry);
      if (idx >= 0) trash.articles.splice(idx, 1);
    }
    if (getArticleById(art.id)) return;
    savedArticles.push(art);
    if (typeof saveAll === 'function') saveAll();
    if (typeof logAction === 'function') logAction('article.restore', getArticleNom(art));
    renderStock();
    if (typeof showToast === 'function') {
      showToast('Article restauré : ' + getArticleNom(art), 'success', 2500);
    }
  } catch (e) { console.warn('_restoreDeletedArticle :', e); }
}

/* ═══════════ SECTION 11 — RECHERCHE / FILTRES / PAGINATION ═══════════ */

function setStockSearch(term) {
  __stockSearchTerm = String(term || '');
  window.__stockPage = 0;
  renderStock();
}

function setStockFilter(filter) {
  window.__stockShowMode = filter || 'actif';
  window.__stockPage = 0;
  renderStock();
}

function setStockFamilleFilter(famille) {
  __stockFamilleFilter = String(famille || '');
  window.__stockPage = 0;
  renderStock();
}

function setStockPage(page) {
  window.__stockPage = Math.max(0, parseInt(page, 10) || 0);
  renderStock();
}

function getFilteredArticles() {
  try {
    if (!Array.isArray(savedArticles)) return [];
    var out = savedArticles.slice();

    /* Filtre mode */
    var mode = window.__stockShowMode || 'actif';
    if (mode === 'actif') {
      out = out.filter(_articleIsActif);
    } else if (mode === 'hs') {
      out = out.filter(_articleIsHS);
    } else if (mode === 'alertes') {
      var alertIds = {};
      var alerts = computeArticleStockAlerts();
      for (var a = 0; a < alerts.length; a++) alertIds[String(alerts[a].articleId)] = true;
      out = out.filter(function (art) { return alertIds[String(art.id)]; });
    } else if (mode === 'sans_famille') {
      out = out.filter(function (art) { return !getArticleFamille(art); });
    }
    /* mode 'tous' → pas de filtre */

    /* Filtre famille */
    if (__stockFamilleFilter) {
      var fam = normalizeText(__stockFamilleFilter);
      out = out.filter(function (art) { return normalizeText(getArticleFamille(art)) === fam; });
    }

    /* Recherche */
    if (__stockSearchTerm) {
      var term = normalizeText(__stockSearchTerm);
      out = out.filter(function (art) {
        var hay = normalizeText([
          getArticleNom(art), getArticleFamille(art), art.codeBarre || ''
        ].join(' '));
        return hay.indexOf(term) >= 0;
      });
    }

    /* Tri par nom */
    out.sort(function (x, y) {
      var nx = normalizeText(getArticleNom(x));
      var ny = normalizeText(getArticleNom(y));
      return nx > ny ? 1 : (nx < ny ? -1 : 0);
    });

    return out;
  } catch (e) { console.warn('getFilteredArticles :', e); return []; }
}

/* ═══════════ SECTION 12 — IMPORT / EXPORT ═══════════ */

function exportStockJSON() {
  try {
    var data = {
      version: 1,
      exportedAt: new Date().toISOString(),
      count: savedArticles.length,
      articles: savedArticles,
      familles: familles
    };
    var json = JSON.stringify(data, null, 2);
    var blob = new Blob([json], { type: 'application/json' });
    var filename = 'voltcore-articles-' + todayISO() + '.json';
    if (typeof downloadBlob === 'function') downloadBlob(blob, filename);
    else if (typeof _fallbackDownload === 'function') _fallbackDownload(blob, filename);
    if (typeof showToast === 'function') showToast(savedArticles.length + ' article(s) exporté(s)', 'success');
  } catch (e) { console.warn('exportStockJSON :', e); }
}

function exportStockCSV() {
  try {
    var lines = [];
    lines.push(['Nom', 'Famille', 'Prix', 'PrixAchat', 'Stock', 'Seuil', 'Unite', 'CodeBarre', 'HS'].join('\t'));
    for (var i = 0; i < savedArticles.length; i++) {
      var a = savedArticles[i];
      if (!a) continue;
      lines.push([
        _artCsv(getArticleNom(a)),
        _artCsv(getArticleFamille(a)),
        String(getArticlePrix(a)),
        String(getArticlePrixAchat(a)),
        String(_articleStock(a)),
        String(_articleSeuil(a)),
        _artCsv(a.unite || 'U'),
        _artCsv(a.codeBarre || ''),
        _articleIsHS(a) ? 'Oui' : 'Non'
      ].join('\t'));
    }
    var csv = '\uFEFF' + lines.join('\r\n');
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    var filename = 'voltcore-articles-' + todayISO() + '.csv';
    if (typeof downloadBlob === 'function') downloadBlob(blob, filename);
    else if (typeof _fallbackDownload === 'function') _fallbackDownload(blob, filename);
    if (typeof showToast === 'function') showToast('CSV exporté', 'success');
  } catch (e) { console.warn('exportStockCSV :', e); }
}

function _artCsv(v) {
  return String(v == null ? '' : v).replace(/\t/g, ' ').replace(/\r?\n/g, ' ');
}

function importStockJSON(file, options) {
  return new Promise(function (resolve, reject) {
    try {
      if (!file) return reject(new Error('Fichier requis'));
      var mode = (options && options.mode) || 'merge';
      var reader = new FileReader();
      reader.onload = function (ev) {
        try {
          var parsed = JSON.parse(ev.target.result);
          var arr = null, famsArr = null;
          if (Array.isArray(parsed)) arr = parsed;
          else if (parsed && Array.isArray(parsed.articles)) {
            arr = parsed.articles;
            famsArr = Array.isArray(parsed.familles) ? parsed.familles : null;
          }
          if (!arr) throw new Error('Format invalide : articles[] attendu');

          var added = 0, skipped = 0, invalid = 0;
          if (mode === 'replace') { if (typeof _pushAllToTrashBeforeReplace === 'function') _pushAllToTrashBeforeReplace('articles', savedArticles); savedArticles = []; }

          for (var i = 0; i < arr.length; i++) {
            var clean = _normalizeArticle(arr[i]);
            if (!clean) { invalid++; continue; }
            if (articleExists(clean.nom)) { skipped++; continue; }
            savedArticles.push(clean);
            added++;
          }
          if (famsArr) {
            if (!Array.isArray(familles)) familles = [];
            for (var f = 0; f < famsArr.length; f++) {
              var cf = _normalizeFamille(famsArr[f]);
              if (cf && !familleExists(cf.nom)) familles.push(cf);
            }
          }

          if (typeof saveAll === 'function') saveAll();
          if (typeof logAction === 'function') logAction('article.import', added + ' ajoutés');
          renderStock();
          renderFamilles();
          if (typeof showToast === 'function') {
            var msg = added + ' article(s) importé(s)';
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

/* ═══════════ SECTION 13 — ÉTIQUETTES ═══════════ */

function printEtiquettes(articleIds) {
  try {
    var list;
    if (Array.isArray(articleIds) && articleIds.length > 0) {
      list = [];
      for (var i = 0; i < articleIds.length; i++) {
        var a = getArticleById(articleIds[i]);
        if (a) list.push(a);
      }
    } else {
      list = getFilteredArticles();
    }
    if (list.length === 0) {
      if (typeof showToast === 'function') showToast('Aucun article à imprimer.', 'warning');
      return;
    }

    var html = '<!DOCTYPE html><html><head><meta charset="UTF-8">' +
      '<title>Étiquettes — VOLTCORE</title>' +
      '<style>' +
      '@page{size:A4;margin:8mm}' +
      'body{margin:0;font-family:Arial,sans-serif;font-size:10px}' +
      '.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:2mm}' +
      '.label{border:1px solid #999;padding:3mm;height:32mm;box-sizing:border-box;overflow:hidden}' +
      '.label-name{font-weight:bold;font-size:11px;margin-bottom:1mm;max-height:5mm;overflow:hidden}' +
      '.label-famille{font-size:8px;color:#666;margin-bottom:1mm}' +
      '.label-code{font-family:monospace;font-size:9px;margin-bottom:1mm}' +
      '.label-prix{font-size:14px;font-weight:bold;color:#0b3d91}' +
      '.label-unite{font-size:8px;color:#666}' +
      '</style></head><body><div class="grid">';

    for (var j = 0; j < list.length; j++) {
      var a = list[j];
      html += '<div class="label">';
      html += '<div class="label-name">' + escapeHtml(getArticleNom(a)) + '</div>';
      var fam = getArticleFamille(a);
      if (fam) html += '<div class="label-famille">' + escapeHtml(fam) + '</div>';
      if (a.codeBarre) html += '<div class="label-code">' + escapeHtml(a.codeBarre) + '</div>';
      html += '<div class="label-prix">' + formatMoney(getArticlePrix(a)) + '</div>';
      html += '<div class="label-unite">/ ' + escapeHtml(a.unite || 'U') + '</div>';
      html += '</div>';
    }
    html += '</div></body></html>';

    var w = window.open('', '_blank');
    if (!w) {
      if (typeof showToast === 'function') showToast('Autorise les pop-ups pour imprimer.', 'warning');
      return;
    }
    w.document.write(html);
    w.document.close();
    setTimeout(function () { try { w.print(); } catch (e) {} }, 500);
  } catch (e) { console.warn('printEtiquettes :', e); }
}

/* ═══════════ SECTION 14 — ÉVÉNEMENTS ═══════════ */

function attachStockEvents() {
  try {
    var searchInput = document.getElementById('stockSearchInput');
    if (searchInput && !searchInput.__bound) {
      searchInput.__bound = true;
      searchInput.addEventListener('input', debounce(function (ev) {
        setStockSearch(ev.target.value);
      }, 250));
    }

    var filterSel = document.getElementById('stockFilterSelect');
    if (filterSel && !filterSel.__bound) {
      filterSel.__bound = true;
      filterSel.addEventListener('change', function (ev) {
        setStockFilter(ev.target.value);
      });
    }

    var familleSel = document.getElementById('stockFamilleFilterSelect');
    if (familleSel && !familleSel.__bound) {
      familleSel.__bound = true;
      familleSel.addEventListener('change', function (ev) {
        setStockFamilleFilter(ev.target.value);
      });
    }

    var prevBtn = document.getElementById('stockPrevBtn');
    if (prevBtn && !prevBtn.__bound) {
      prevBtn.__bound = true;
      prevBtn.addEventListener('click', function () {
        setStockPage((window.__stockPage || 0) - 1);
      });
    }

    var nextBtn = document.getElementById('stockNextBtn');
    if (nextBtn && !nextBtn.__bound) {
      nextBtn.__bound = true;
      nextBtn.addEventListener('click', function () {
        setStockPage((window.__stockPage || 0) + 1);
      });
    }

    var addBtn = document.getElementById('btnAddArticle');
    if (addBtn && !addBtn.__bound) {
      addBtn.__bound = true;
      addBtn.addEventListener('click', function () { openArticleModal(null); });
    }

    var addFamBtn = document.getElementById('btnAddFamille');
    if (addFamBtn && !addFamBtn.__bound) {
      addFamBtn.__bound = true;
      addFamBtn.addEventListener('click', openFamilleModal);
    }

    var importBtn = document.getElementById('btnImportStock');
    if (importBtn && !importBtn.__bound) {
      importBtn.__bound = true;
      importBtn.addEventListener('click', function () {
        var input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json,application/json';
        input.onchange = function (ev) {
          var f = ev.target.files && ev.target.files[0];
          if (!f) return;
          importStockJSON(f, { mode: 'merge' }).catch(function (err) {
            if (typeof showToast === 'function') {
              showToast('Import échoué : ' + (err.message || ''), 'error');
            }
          });
        };
        input.click();
      });
    }

    var exportJsonBtn = document.getElementById('btnExportStockJSON');
    if (exportJsonBtn && !exportJsonBtn.__bound) {
      exportJsonBtn.__bound = true;
      exportJsonBtn.addEventListener('click', exportStockJSON);
    }

    var exportCsvBtn = document.getElementById('btnExportStockCSV');
    if (exportCsvBtn && !exportCsvBtn.__bound) {
      exportCsvBtn.__bound = true;
      exportCsvBtn.addEventListener('click', exportStockCSV);
    }

    var etiqBtn = document.getElementById('btnPrintEtiquettes');
    if (etiqBtn && !etiqBtn.__bound) {
      etiqBtn.__bound = true;
      etiqBtn.addEventListener('click', function () { printEtiquettes(null); });
    }
  } catch (e) { console.warn('attachStockEvents :', e); }
}

/* ═══════════════════════════════════════════════════════════════
   SECTION 15 — ARTICLE PICKER (sélecteur pour factures)
   Anciennement dans 24-article-picker.js, fusionné ici au LOT 5.
   Appelé par 11-invoices.js via window.openArticlePicker(callback).
   La modale est créée dynamiquement à la première ouverture.

   v6.7 (Session #3) : closure _apRenderList corrigée.
   Avant : cliquer sur n'importe quelle ligne sélectionnait le DERNIER
   article de la liste (var k hoisté au scope fonction). Après : IIFE
   capture chaque ligne individuellement.
   ═══════════════════════════════════════════════════════════════ */

var __apCallback = null;
var __apSearch = '';
var __apFamille = '';

/* Helpers fallback (08 chargé après 03, mais garde-fou). */
function _apEscape(s) {
  if (typeof escapeHtml === 'function') return escapeHtml(s);
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function _apMoney(n) {
  if (typeof formatMoney === 'function') return formatMoney(n);
  var num = parseFloat(n) || 0;
  return num.toFixed(3).replace('.', ',') + ' DT';
}

/* Crée la modale si absente. */
function _apEnsureModal() {
  try {
    if (document.getElementById('articlePickerModal')) return;

    var modal = document.createElement('div');
    modal.id = 'articlePickerModal';
    modal.className = 'modal';
    modal.style.display = 'none';
    modal.innerHTML =
      '<div class="modal-content modal-large">' +
        '<h2>📦 Sélectionner un article</h2>' +
        '<div class="search-bar" style="margin-bottom:12px">' +
          '<input type="text" id="apSearchInput" class="input-search" placeholder="Rechercher (nom, famille, code-barre)…">' +
          '<select id="apFamilleSelect" class="input-select">' +
            '<option value="">Toutes familles</option>' +
          '</select>' +
        '</div>' +
        '<div id="apList" style="max-height:400px;overflow:auto;margin-bottom:12px"></div>' +
        '<div class="modal-actions">' +
          '<button type="button" class="btn" onclick="closeArticlePicker()">Annuler</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(modal);

    /* Bind recherche */
    var s = document.getElementById('apSearchInput');
    if (s && !s.__bound) {
      s.__bound = true;
      var debounced = (typeof debounce === 'function')
        ? debounce(function (ev) { __apSearch = ev.target.value || ''; _apRenderList(); }, 200)
        : function (ev) { __apSearch = ev.target.value || ''; _apRenderList(); };
      s.addEventListener('input', debounced);
    }
    var f = document.getElementById('apFamilleSelect');
    if (f && !f.__bound) {
      f.__bound = true;
      f.addEventListener('change', function (ev) {
        __apFamille = ev.target.value || '';
        _apRenderList();
      });
    }
  } catch (e) { console.warn('_apEnsureModal :', e); }
}

/* Peuple le select famille. */
function _apPopulateFamilles() {
  try {
    var sel = document.getElementById('apFamilleSelect');
    if (!sel) return;
    var used = {};
    if (Array.isArray(savedArticles)) {
      for (var i = 0; i < savedArticles.length; i++) {
        var fam = getArticleFamille(savedArticles[i]);
        if (fam) used[fam] = true;
      }
    }
    var keys = Object.keys(used).sort(function (a, b) {
      var na = String(a).toLowerCase(), nb = String(b).toLowerCase();
      return na > nb ? 1 : (na < nb ? -1 : 0);
    });
    var html = '<option value="">Toutes familles</option>';
    for (var k = 0; k < keys.length; k++) {
      html += '<option value="' + _apEscape(keys[k]) + '"' +
        (keys[k] === __apFamille ? ' selected' : '') + '>' +
        _apEscape(keys[k]) + '</option>';
    }
    sel.innerHTML = html;
  } catch (e) { console.warn('_apPopulateFamilles :', e); }
}

/* Filtre + rendu de la liste.
   v6.7 : IIFE pour la closure des clics. */
function _apRenderList() {
  try {
    var el = document.getElementById('apList');
    if (!el) return;

    if (!Array.isArray(savedArticles) || savedArticles.length === 0) {
      el.innerHTML = '<div class="muted" style="padding:16px;text-align:center">Aucun article dans le stock.</div>';
      return;
    }

    var term = '';
    if (__apSearch) {
      if (typeof normalizeText === 'function') term = normalizeText(__apSearch);
      else term = String(__apSearch).toLowerCase();
    }
    var famFilter = __apFamille ? String(__apFamille).toLowerCase() : '';

    var rows = [];
    for (var i = 0; i < savedArticles.length; i++) {
      var art = savedArticles[i];
      if (!art) continue;
      if (!_articleIsActif(art)) continue;

      var nom = getArticleNom(art);
      var famille = getArticleFamille(art);
      var codeBarre = String(art.codeBarre || '');

      if (famFilter) {
        var f = famille.toLowerCase();
        if (f !== famFilter) continue;
      }
      if (term) {
        var hay;
        if (typeof normalizeText === 'function') {
          hay = normalizeText([nom, famille, codeBarre].join(' '));
        } else {
          hay = (nom + ' ' + famille + ' ' + codeBarre).toLowerCase();
        }
        if (hay.indexOf(term) < 0) continue;
      }
      rows.push(art);
    }

    /* Tri par nom */
    rows.sort(function (a, b) {
      var na = getArticleNom(a).toLowerCase();
      var nb = getArticleNom(b).toLowerCase();
      return na > nb ? 1 : (na < nb ? -1 : 0);
    });

    if (rows.length === 0) {
      el.innerHTML = '<div class="muted" style="padding:16px;text-align:center">Aucun article ne correspond.</div>';
      return;
    }

    var html = '';
    for (var j = 0; j < rows.length; j++) {
      var a = rows[j];
      var id = String(a.id || '');
      var nomA = getArticleNom(a);
      var famA = getArticleFamille(a);
      var prix = getArticlePrix(a);
      var unite = String(a.unite || 'U');

      html += '<div class="article-picker-row" data-ap-id="' + _apEscape(id) + '" ' +
        'style="display:flex;justify-content:space-between;align-items:center;' +
        'padding:10px;border-bottom:1px solid #eee;cursor:pointer">' +
        '<div style="flex:1">' +
          '<div style="font-weight:600">' + _apEscape(nomA) + '</div>' +
          '<div style="font-size:12px;color:#666">' +
            (famA ? _apEscape(famA) + ' · ' : '') +
            _apMoney(prix) + ' / ' + _apEscape(unite) +
          '</div>' +
        '</div>' +
        '<div style="color:#0b3d91;font-size:20px">➕</div>' +
      '</div>';
    }
    el.innerHTML = html;

    /* v6.7 — Bind clic sur une ligne via IIFE (closure correcte) */
    var items = el.querySelectorAll('[data-ap-id]');
    for (var k = 0; k < items.length; k++) {
      (function (itemRef) {
        if (itemRef.__bound) return;
        itemRef.__bound = true;
        itemRef.addEventListener('click', function (ev) {
          try { ev.preventDefault(); } catch (e) {}
          var id = itemRef.getAttribute('data-ap-id');
          _apSelect(id);
        });
      })(items[k]);
    }
  } catch (e) { console.warn('_apRenderList :', e); }
}

/* Sélection d'un article → callback → ferme. */
function _apSelect(articleId) {
  try {
    var art = null;
    if (typeof getArticleById === 'function') art = getArticleById(articleId);
    if (!art && Array.isArray(savedArticles)) {
      for (var i = 0; i < savedArticles.length; i++) {
        if (savedArticles[i] && String(savedArticles[i].id) === String(articleId)) {
          art = savedArticles[i]; break;
        }
      }
    }
    if (!art) {
      if (typeof showToast === 'function') showToast('Article introuvable.', 'error');
      return;
    }
    var cb = __apCallback;
    __apCallback = null;
    closeArticlePicker();
    if (typeof cb === 'function') {
      try { cb(art); } catch (e) { console.warn('articlePicker callback :', e); }
    }
  } catch (e) { console.warn('_apSelect :', e); }
}

/* API publique — appelée par 11-invoices.js. */
function openArticlePicker(callback) {
  try {
    __apCallback = (typeof callback === 'function') ? callback : null;
    __apSearch = '';
    __apFamille = '';
    _apEnsureModal();
    _apPopulateFamilles();
    var s = document.getElementById('apSearchInput');
    if (s) s.value = '';
    var f = document.getElementById('apFamilleSelect');
    if (f) f.value = '';
    _apRenderList();
    var modal = document.getElementById('articlePickerModal');
    if (modal) modal.style.display = 'flex';
    if (s) setTimeout(function () { try { s.focus(); } catch (e) {} }, 100);
  } catch (e) { console.warn('openArticlePicker :', e); }
}

function closeArticlePicker() {
  try {
    var modal = document.getElementById('articlePickerModal');
    if (modal) modal.style.display = 'none';
    __apCallback = null;
  } catch (e) {}
}

function attachArticlePickerEvents() {
  /* Rien à faire a priori : tous les binds sont faits à la volée.
     Fonction conservée pour compat avec 21-init-app.js. */
  try { _apEnsureModal(); } catch (e) {}
}

/* Expose globalement (utilisé par 11-invoices.js). */
try {
  if (typeof window !== 'undefined') {
    window.openArticlePicker = openArticlePicker;
    window.closeArticlePicker = closeArticlePicker;
    window.attachArticlePickerEvents = attachArticlePickerEvents;
  }
} catch (e) {}

console.log('✅ 08-stock.js chargé — v6.7 (closure _apRenderList + ordre recordPriceChange corrigés)');