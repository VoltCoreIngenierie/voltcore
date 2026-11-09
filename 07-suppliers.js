/* ═══════════════════════════════════════════════════════════════
   VOLTCORE — 07-suppliers.js
   VERSION : v6.7 (Session #3 — fallback download 30s, bump version)
   RÔLE : CRUD fournisseurs, recherche, filtres, comparateur de
          prix par article, import/export, impression, undo
   DÉPENDANCES : 01-core.js (suppliers, purchaseInvoices, trash,
                  currentUser), 03-utils.js (helpers, downloadBlob,
                  confirmDialog, promptDialog), 04-storage.js (saveAll,
                  recordExternalPrice, getTotalPaye, getResteAPayer,
                  getStatutPaiement)
   EXPOSE : getSupplierById, getSupplierName, supplierExists,
            computeSupplierStats, renderSuppliers, renderSupplierRow,
            openSupplierDetail, closeSupplierDetail,
            openSupplierModal, closeSupplierModal,
            saveSupplierFromForm, deleteSupplier,
            setSuppliersSearch, setSuppliersFilter,
            getFilteredSuppliers, comparePricesForArticle,
            getBestSupplierForArticle,
            exportSuppliersJSON, exportSuppliersCSV,
            importSuppliersJSON, printSuppliersList,
            attachSuppliersEvents
   ═══════════════════════════════════════════════════════════════ */

/* ═══════════ SECTION 1 — ÉTAT + CONSTANTES ═══════════ */

var __suppliersSearchTerm = '';
var __suppliersFilter = 'all';
var __suppliersSortField = 'nom';
var __suppliersSortDir = 'asc';

/* LOT 4 — Cache des achats par fournisseur */
var __invoicesBySupplierCache = null;

function _invalidateSupplierInvoicesCache() {
  __invoicesBySupplierCache = null;
}

/* ═══════════ SECTION 2 — HELPERS ═══════════ */

function getSupplierById(id) {
  try {
    if (!id || !Array.isArray(suppliers)) return null;
    var sid = String(id);
    for (var i = 0; i < suppliers.length; i++) {
      if (suppliers[i] && String(suppliers[i].id) === sid) return suppliers[i];
    }
    return null;
  } catch (e) {
    console.warn('getSupplierById :', e);
    return null;
  }
}

function getSupplierName(id) {
  var f = getSupplierById(id);
  if (!f) return '';
  return String(f.nom || f.name || '');
}

function supplierExists(nom, excludeId) {
  try {
    if (!nom || !Array.isArray(suppliers)) return false;
    var normalized = normalizeText(nom);
    for (var i = 0; i < suppliers.length; i++) {
      var f = suppliers[i];
      if (!f) continue;
      if (excludeId && String(f.id) === String(excludeId)) continue;
      if (normalizeText(f.nom || f.name || '') === normalized) return true;
    }
    return false;
  } catch (e) {
    return false;
  }
}

function _normalizeSupplier(raw) {
  if (!raw || typeof raw !== 'object') return null;
  var out = {
    id: raw.id || ('sup_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)),
    nom: String(raw.nom || raw.name || '').trim().replace(/\s+/g, ' '),
    telephone: String(raw.telephone || '').trim(),
    email: String(raw.email || '').trim().toLowerCase(),
    adresse: String(raw.adresse || '').trim(),
    mf: String(raw.mf || raw.matriculeFiscale || '').trim(),
    rib: String(raw.rib || '').trim(),
    notes: String(raw.notes || '').trim(),
    createdAt: raw.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  if (!out.nom) return null;
  return out;
}

/* LOT 4 — Construction du cache des achats par fournisseur */
function _buildSupplierInvoicesCache() {
  var cache = {};
  try {
    if (!Array.isArray(purchaseInvoices)) return cache;
    for (var i = 0; i < purchaseInvoices.length; i++) {
      var p = purchaseInvoices[i];
      if (!p) continue;
      var sid = String(p.supplierId || p.fournisseurId || '');
      if (sid) {
        if (!cache[sid]) cache[sid] = [];
        cache[sid].push(p);
      } else if (p.fournisseur) {
        /* Fallback par nom si pas d'ID */
        var nameKey = '_name_' + String(p.fournisseur);
        if (!cache[nameKey]) cache[nameKey] = [];
        cache[nameKey].push(p);
      }
    }
  } catch (e) { console.warn('_buildSupplierInvoicesCache :', e); }
  return cache;
}

function _getInvoicesForSupplier(supplierId) {
  try {
    if (!supplierId) return [];
    if (__invoicesBySupplierCache === null) {
      __invoicesBySupplierCache = _buildSupplierInvoicesCache();
    }
    var sid = String(supplierId);
    var direct = __invoicesBySupplierCache[sid] || [];
    
    /* Complément par nom */
    var sup = (typeof getSupplierById === 'function') ? getSupplierById(supplierId) : null;
    var byName = [];
    if (sup && sup.nom) {
      byName = __invoicesBySupplierCache['_name_' + sup.nom] || [];
    }
    
    /* Fusion sans doublon */
    if (direct.length === 0) return byName;
    if (byName.length === 0) return direct;
    
    var seen = {};
    var out = [];
    for (var i = 0; i < direct.length; i++) { seen[direct[i].id] = true; out.push(direct[i]); }
    for (var j = 0; j < byName.length; j++) {
      if (!seen[byName[j].id]) { out.push(byName[j]); seen[byName[j].id] = true; }
    }
    return out;
  } catch (e) {
    console.warn('_getInvoicesForSupplier :', e);
    return [];
  }
}

/* ═══════════ SECTION 3 — STATISTIQUES ═══════════ */

function computeSupplierStats(supplierId) {
  var empty = { nbAchats: 0, caAchats: 0, nbArticles: 0, dernierAchat: '', ecartMoyen: 0 };
  try {
    if (!supplierId) return empty;
    var invoices = _getInvoicesForSupplier(supplierId);

    var caAchats = 0, dernierAchat = '';
    for (var i = 0; i < invoices.length; i++) {
      var p = invoices[i];
      var total = (typeof p.totalTTC === 'number') ? p.totalTTC
                : (typeof p.total === 'number') ? p.total : 0;
      caAchats += total;
      var d = String(p.date || p.dateFacture || '').slice(0, 10);
      if (d && (!dernierAchat || d > dernierAchat)) dernierAchat = d;
    }

    var nomF = getSupplierName(supplierId);
    var nbArticles = 0;
    var ecartTotal = 0, ecartCount = 0;
    
    if (nomF && externalPrices && typeof externalPrices === 'object') {
      for (var aid in externalPrices) {
        if (!externalPrices.hasOwnProperty(aid)) continue;
        var entries = externalPrices[aid];
        if (!Array.isArray(entries)) continue;
        var seen = false;
        var prixF = 0;
        var prixMin = Infinity;
        for (var j = 0; j < entries.length; j++) {
          var e = entries[j];
          if (!e || typeof e.prix !== 'number') continue;
          if (e.prix < prixMin) prixMin = e.prix;
          if (String(e.fournisseur || '') === nomF) { seen = true; prixF = e.prix; }
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
      nbAchats: invoices.length,
      caAchats: caAchats,
      nbArticles: nbArticles,
      dernierAchat: dernierAchat,
      ecartMoyen: ecartCount > 0 ? ecartTotal / ecartCount : 0
    };
  } catch (e) {
    console.warn('computeSupplierStats :', e);
    return empty;
  }
}

/* ═══════════ SECTION 4 — RENDU LISTE ═══════════ */

function renderSuppliers() {
  try {
    var container = document.getElementById('suppliersList');
    if (!container) return;

    var list = getFilteredSuppliers();

    if (list.length === 0) {
      container.innerHTML = '<div class="empty-state">Aucun fournisseur' +
        (__suppliersSearchTerm || __suppliersFilter !== 'all' ? ' pour ce filtre' : '') +
        '. Clique sur "+ Nouveau fournisseur" pour commencer.</div>';
      _updateSuppliersCount(0);
      return;
    }

    var html = '';
    for (var i = 0; i < list.length; i++) {
      html += renderSupplierRow(list[i]);
    }
    container.innerHTML = html;
    _updateSuppliersCount(list.length);
  } catch (e) {
    console.warn('renderSuppliers :', e);
  }
}

function renderSupplierRow(f) {
  try {
    if (!f) return '';
    var id = escapeAttr(f.id);
    var nom = escapeHtml(f.nom || '(Sans nom)');
    var tel = escapeHtml(f.telephone || '');
    var email = escapeHtml(f.email || '');
    var metaParts = [];
    if (tel) metaParts.push('📞 ' + tel);
    if (email) metaParts.push('✉️ ' + email);
    var meta = metaParts.length ? metaParts.join(' · ') : '<span class="muted">Aucun contact</span>';

    var badge = '';
    var stats = computeSupplierStats(f.id);
    if (stats.ecartMoyen > 5) {
      badge = '<span class="badge badge-warning" title="Prix au-dessus du marché">' +
        '+' + stats.ecartMoyen.toFixed(0) + '%</span>';
    }

    return '<div class="supplier-row" data-supplier-id="' + id + '">' +
      '<div class="supplier-row-main">' +
        '<div class="supplier-row-name">' + nom + ' ' + badge + '</div>' +
        '<div class="supplier-row-meta">' + meta + '</div>' +
      '</div>' +
      '<div class="supplier-row-actions">' +
        '<button type="button" class="btn-icon" title="Voir détail" ' +
          'onclick="openSupplierDetail(\'' + id + '\')">👁️</button>' +
        '<button type="button" class="btn-icon" title="Éditer" ' +
          'onclick="openSupplierModal(\'' + id + '\')">✏️</button>' +
        '<button type="button" class="btn-icon btn-danger" title="Supprimer" ' +
          'onclick="deleteSupplier(\'' + id + '\')">🗑️</button>' +
      '</div>' +
    '</div>';
  } catch (e) {
    console.warn('renderSupplierRow :', e);
    return '';
  }
}

function _updateSuppliersCount(n) {
  try {
    var el = document.getElementById('suppliersCount');
    if (el) el.textContent = String(n);
  } catch (e) {}
}

/* ═══════════ SECTION 5 — RENDU DÉTAIL ═══════════ */

function openSupplierDetail(id) {
  try {
    var f = getSupplierById(id);
    if (!f) return;
    var modal = document.getElementById('supplierDetailModal');
    var body = document.getElementById('supplierDetailBody');
    var title = document.getElementById('supplierDetailTitle');
    if (!modal || !body) return;

    if (title) title.textContent = f.nom || 'Fournisseur';

    var stats = computeSupplierStats(f.id);
    var ecartColor = stats.ecartMoyen > 5 ? 'var(--danger)'
                   : stats.ecartMoyen < -5 ? 'var(--success)'
                   : 'var(--warning)';

    var html = '';
    html += '<div class="detail-section">';
    html += '<h3>Contact</h3>';
    html += '<div class="detail-grid">';
    html += _supDetailItem('Téléphone', f.telephone || '—');
    html += _supDetailItem('Email', f.email || '—');
    html += _supDetailItem('Adresse', f.adresse || '—');
    html += _supDetailItem('MF', f.mf || '—');
    html += _supDetailItem('RIB', f.rib || '—');
    html += '</div>';
    html += '</div>';

    html += '<div class="detail-section">';
    html += '<h3>Activité</h3>';
    html += '<div class="stats-grid">';
    html += _supStatItem('Achats', String(stats.nbAchats));
    html += _supStatItem('CA achats', formatMoney(stats.caAchats));
    html += _supStatItem('Articles vus', String(stats.nbArticles));
    html += _supStatItem('Écart prix', (stats.ecartMoyen >= 0 ? '+' : '') +
      stats.ecartMoyen.toFixed(1) + '%', ecartColor);
    html += '</div>';
    if (stats.dernierAchat) {
      html += '<div class="detail-last">Dernier achat : ' +
        escapeHtml(formatDate(stats.dernierAchat)) + '</div>';
    }
    html += '</div>';

    var articles = _getSupplierArticleIds(f.nom);
    if (articles.length > 0) {
      html += '<div class="detail-section">';
      html += '<h3>Comparateur de prix (' + articles.length + ' article(s))</h3>';
      html += '<div class="comparateur-list">';
      for (var i = 0; i < articles.length; i++) {
        var cmp = comparePricesForArticle(articles[i].articleId);
        if (cmp.length === 0) continue;
        html += _renderComparateurRow(articles[i].articleNom, cmp, f.nom);
      }
      html += '</div>';
      html += '</div>';
    }

    if (f.notes) {
      html += '<div class="detail-section">';
      html += '<h3>Notes</h3>';
      html += '<p class="detail-notes">' + escapeHtml(f.notes).replace(/\n/g, '<br>') + '</p>';
      html += '</div>';
    }

    body.innerHTML = html;
    modal.style.display = 'flex';
  } catch (e) {
    console.warn('openSupplierDetail :', e);
  }
}

function closeSupplierDetail() {
  try {
    var modal = document.getElementById('supplierDetailModal');
    if (modal) modal.style.display = 'none';
  } catch (e) {}
}

function _supDetailItem(label, value) {
  return '<div class="detail-item">' +
    '<div class="detail-label">' + escapeHtml(label) + '</div>' +
    '<div class="detail-value">' + escapeHtml(value) + '</div>' +
    '</div>';
}

function _supStatItem(label, value, color) {
  return '<div class="stat-item">' +
    '<div class="stat-value"' + (color ? ' style="color:' + color + '"' : '') + '>' +
    escapeHtml(value) + '</div>' +
    '<div class="stat-label">' + escapeHtml(label) + '</div>' +
    '</div>';
}

function _getSupplierArticleIds(nomF) {
  var out = [];
  try {
    if (!nomF || !externalPrices) return out;
    var seen = {};
    for (var aid in externalPrices) {
      if (!externalPrices.hasOwnProperty(aid)) continue;
      var entries = externalPrices[aid];
      if (!Array.isArray(entries)) continue;
      for (var i = 0; i < entries.length; i++) {
        if (entries[i] && String(entries[i].fournisseur || '') === String(nomF)) {
          if (!seen[aid]) {
            seen[aid] = true;
            var art = null;
            if (Array.isArray(savedArticles)) {
              for (var j = 0; j < savedArticles.length; j++) {
                if (savedArticles[j] && String(savedArticles[j].id) === String(aid)) {
                  art = savedArticles[j]; break;
                }
              }
            }
            out.push({
              articleId: aid,
              articleNom: art ? String(art.nom || art.designation || aid) : aid
            });
          }
          break;
        }
      }
    }
  } catch (e) {
    console.warn('_getSupplierArticleIds :', e);
  }
  return out;
}

function _renderComparateurRow(articleNom, prices, currentFournisseur) {
  var html = '<div class="comparateur-row">';
  html += '<div class="comparateur-article">' + escapeHtml(articleNom) + '</div>';
  html += '<div class="comparateur-prices">';
  for (var i = 0; i < prices.length; i++) {
    var p = prices[i];
    var isMine = String(p.fournisseur) === String(currentFournisseur);
    var cls = (i === 0 ? 'best' : '') + (isMine ? ' mine' : '');
    var mark = i === 0 ? '🥇 ' : (isMine ? '👤 ' : '');
    html += '<div class="comparateur-price ' + cls.trim() + '">' +
      mark + escapeHtml(p.fournisseur) + ' : ' + formatMoney(p.prix) +
      ' <span class="muted">(' + formatDate(p.date) + ')</span>' +
      '</div>';
  }
  html += '</div></div>';
  return html;
}

/* ═══════════ SECTION 6 — FORMULAIRE ═══════════ */

function openSupplierModal(supplierId) {
  try {
    var modal = document.getElementById('supplierModal');
    var title = document.getElementById('supplierModalTitle');
    if (!modal) return;

    var form = document.getElementById('supplierForm');
    if (form) form.reset();

    if (supplierId) {
      var f = getSupplierById(supplierId);
      if (!f) return;
      if (title) title.textContent = 'Modifier fournisseur';
      _supFill('supplierId', f.id);
      _supFill('supplierNom', f.nom || '');
      _supFill('supplierTelephone', f.telephone || '');
      _supFill('supplierEmail', f.email || '');
      _supFill('supplierAdresse', f.adresse || '');
      _supFill('supplierMF', f.mf || '');
      _supFill('supplierRIB', f.rib || '');
      _supFill('supplierNotes', f.notes || '');
    } else {
      if (title) title.textContent = 'Nouveau fournisseur';
      _supFill('supplierId', '');
    }

    var errEl = document.getElementById('supplierFormError');
    if (errEl) errEl.textContent = '';

    modal.style.display = 'flex';
    var nomInput = document.getElementById('supplierNom');
    if (nomInput) setTimeout(function () { try { nomInput.focus(); } catch (e) {} }, 100);
  } catch (e) {
    console.warn('openSupplierModal :', e);
  }
}

function closeSupplierModal() {
  try {
    var modal = document.getElementById('supplierModal');
    if (modal) modal.style.display = 'none';
  } catch (e) {}
}

function _supFill(id, value) {
  try {
    var el = document.getElementById(id);
    if (el) el.value = value || '';
  } catch (e) {}
}

function _supGet(id) {
  try {
    var el = document.getElementById(id);
    return el ? String(el.value || '').trim() : '';
  } catch (e) {
    return '';
  }
}

function saveSupplierFromForm() {
  try {
    var errEl = document.getElementById('supplierFormError');
    var id = _supGet('supplierId');
    var nom = _supGet('supplierNom');

    if (!nom) {
      if (errEl) errEl.textContent = 'Le nom du fournisseur est obligatoire.';
      return;
    }

    if (supplierExists(nom, id)) {
      if (errEl) errEl.textContent = 'Un fournisseur avec ce nom existe déjà.';
      return;
    }

    var raw = {
      id: id || undefined,
      nom: nom,
      telephone: _supGet('supplierTelephone'),
      email: _supGet('supplierEmail'),
      adresse: _supGet('supplierAdresse'),
      mf: _supGet('supplierMF'),
      rib: _supGet('supplierRIB'),
      notes: _supGet('supplierNotes')
    };

    var clean = _normalizeSupplier(raw);
    if (!clean) {
      if (errEl) errEl.textContent = 'Données invalides.';
      return;
    }

    if (id) {
      var existing = getSupplierById(id);
      if (!existing) {
        if (errEl) errEl.textContent = 'Fournisseur introuvable.';
        return;
      }
      clean.createdAt = existing.createdAt;
      var idx = suppliers.indexOf(existing);
      suppliers[idx] = clean;
    } else {
      suppliers.push(clean);
    }

    if (typeof saveAll === 'function') saveAll();
    if (typeof logAction === 'function') {
      logAction(id ? 'supplier.update' : 'supplier.create', clean.nom);
    }

    closeSupplierModal();
    renderSuppliers();
    if (typeof showToast === 'function') {
      showToast(id ? 'Fournisseur modifié' : 'Fournisseur créé', 'success', 2500);
    }
  } catch (e) {
    console.warn('saveSupplierFromForm :', e);
    var errEl2 = document.getElementById('supplierFormError');
    if (errEl2) errEl2.textContent = 'Erreur lors de l\'enregistrement.';
  }
}

/* ═══════════ SECTION 7 — SUPPRESSION AVEC UNDO ═══════════ */

function deleteSupplier(id) {
  try {
    var f = getSupplierById(id);
    if (!f) return;

    /* LOT 1 — Vérification des références (achats) */
    var refs = { achats: 0 };
    var total = 0;

    if (Array.isArray(purchaseInvoices)) {
      for (var i = 0; i < purchaseInvoices.length; i++) {
        if (purchaseInvoices[i] && String(purchaseInvoices[i].supplierId || purchaseInvoices[i].fournisseurId) === String(id)) {
          refs.achats++;
        }
      }
    }

    total = refs.achats;

    if (total > 0) {
      var msg = '⚠️ Ce fournisseur est utilisé par :\n';
      if (refs.achats > 0) msg += '  • ' + refs.achats + ' achat(s)\n';
      msg += '\nSupprimer quand même ?';
      var ok = (typeof confirmDialog === 'function') ? confirmDialog(msg) : window.confirm(msg);
      if (!ok) return;
      if (typeof logAction === 'function') {
        logAction('supplier.delete_with_refs', f.nom + ' (' + total + ' références)');
      }
    }

    var idx = suppliers.indexOf(f);
    if (idx < 0) return;
    suppliers.splice(idx, 1);

    if (!trash || typeof trash !== 'object') {
      trash = { clients: [], articles: [], documents: [] };
    }
    if (!Array.isArray(trash.suppliers)) trash.suppliers = [];
    var entry = {
      item: f,
      deletedAt: new Date().toISOString(),
      deletedBy: (currentUser && currentUser.username) || 'anon'
    };
    trash.suppliers.push(entry);

    if (typeof saveAll === 'function') saveAll();
    if (typeof logAction === 'function') {
      logAction('supplier.delete', f.nom || id);
    }
    renderSuppliers();

    if (typeof showUndoToast === 'function') {
      showUndoToast(
        'Fournisseur supprimé : ' + (f.nom || ''),
        function () { _restoreDeletedSupplier(entry, f); },
        5000
      );
    } else if (typeof showToast === 'function') {
      showToast('Fournisseur déplacé dans la corbeille.', 'info', 3000);
    }
  } catch (e) {
    console.warn('deleteSupplier :', e);
    if (typeof showToast === 'function') showToast('Erreur lors de la suppression.', 'error');
  }
}

function _restoreDeletedSupplier(entry, supplierObj) {
  try {
    if (!entry || !supplierObj) return;
    if (Array.isArray(trash.suppliers)) {
      var idx = trash.suppliers.indexOf(entry);
      if (idx >= 0) trash.suppliers.splice(idx, 1);
    }
    if (getSupplierById(supplierObj.id)) return;
    suppliers.push(supplierObj);
    if (typeof saveAll === 'function') saveAll();
    if (typeof logAction === 'function') {
      logAction('supplier.restore', supplierObj.nom || supplierObj.id);
    }
    renderSuppliers();
    if (typeof showToast === 'function') {
      showToast('Fournisseur restauré : ' + (supplierObj.nom || ''), 'success', 2500);
    }
  } catch (e) {
    console.warn('_restoreDeletedSupplier :', e);
  }
}

/* ═══════════ SECTION 8 — RECHERCHE + FILTRES ═══════════ */

function setSuppliersSearch(term) {
  __suppliersSearchTerm = String(term || '');
  renderSuppliers();
}

function setSuppliersFilter(filter) {
  __suppliersFilter = filter || 'all';
  renderSuppliers();
}

function getFilteredSuppliers() {
  try {
    if (!Array.isArray(suppliers)) return [];
    var out = suppliers.slice();

    if (__suppliersSearchTerm) {
      var term = normalizeText(__suppliersSearchTerm);
      out = out.filter(function (f) {
        if (!f) return false;
        var hay = normalizeText([
          f.nom, f.telephone, f.email, f.adresse, f.mf
        ].join(' '));
        return hay.indexOf(term) >= 0;
      });
    }

    if (__suppliersFilter === 'with_invoices') {
      out = out.filter(function (f) {
        return _getInvoicesForSupplier(f.id).length > 0;
      });
    } else if (__suppliersFilter === 'without_invoices') {
      out = out.filter(function (f) {
        return _getInvoicesForSupplier(f.id).length === 0;
      });
    } else if (__suppliersFilter === 'expensive') {
      out = out.filter(function (f) {
        return computeSupplierStats(f.id).ecartMoyen > 5;
      });
    }

    out.sort(function (a, b) {
      var na = normalizeText(a.nom || '');
      var nb = normalizeText(b.nom || '');
      if (__suppliersSortDir === 'desc') return na < nb ? 1 : (na > nb ? -1 : 0);
      return na > nb ? 1 : (na < nb ? -1 : 0);
    });

    return out;
  } catch (e) {
    console.warn('getFilteredSuppliers :', e);
    return [];
  }
}

/* ═══════════ SECTION 9 — COMPARATEUR DE PRIX ═══════════ */

function comparePricesForArticle(articleId) {
  var out = [];
  try {
    if (!articleId || !externalPrices) return out;
    var key = String(articleId);
    var entries = externalPrices[key];
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

    for (var k in bySupplier) {
      if (bySupplier.hasOwnProperty(k)) out.push(bySupplier[k]);
    }

    out.sort(function (a, b) { return a.prix - b.prix; });
  } catch (e) {
    console.warn('comparePricesForArticle :', e);
  }
  return out;
}

function getBestSupplierForArticle(articleId) {
  var prices = comparePricesForArticle(articleId);
  return prices.length > 0 ? prices[0] : null;
}

/* ═══════════ SECTION 10 — IMPORT/EXPORT ═══════════ */

function exportSuppliersJSON() {
  try {
    var data = {
      version: 1,
      exportedAt: new Date().toISOString(),
      count: suppliers.length,
      suppliers: suppliers
    };
    var json = JSON.stringify(data, null, 2);
    var blob = new Blob([json], { type: 'application/json' });
    var filename = 'voltcore-fournisseurs-' + todayISO() + '.json';
    if (typeof downloadBlob === 'function') {
      downloadBlob(blob, filename);
    } else {
      _supFallbackDownload(blob, filename);
    }
    if (typeof showToast === 'function') {
      showToast(suppliers.length + ' fournisseur(s) exporté(s)', 'success');
    }
  } catch (e) {
    console.warn('exportSuppliersJSON :', e);
    if (typeof showToast === 'function') showToast('Erreur d\'export.', 'error');
  }
}

function exportSuppliersCSV() {
  try {
    var lines = [];
    lines.push(['Nom', 'Téléphone', 'Email', 'Adresse', 'MF', 'RIB', 'Notes'].join('\t'));
    for (var i = 0; i < suppliers.length; i++) {
      var f = suppliers[i];
      if (!f) continue;
      lines.push([
        _supCsvCell(f.nom),
        _supCsvCell(f.telephone),
        _supCsvCell(f.email),
        _supCsvCell(f.adresse),
        _supCsvCell(f.mf),
        _supCsvCell(f.rib),
        _supCsvCell(f.notes)
      ].join('\t'));
    }
    var csv = '\uFEFF' + lines.join('\r\n');
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    var filename = 'voltcore-fournisseurs-' + todayISO() + '.csv';
    if (typeof downloadBlob === 'function') {
      downloadBlob(blob, filename);
    } else {
      _supFallbackDownload(blob, filename);
    }
    if (typeof showToast === 'function') showToast('CSV exporté', 'success');
  } catch (e) {
    console.warn('exportSuppliersCSV :', e);
  }
}

function _supCsvCell(v) {
  return String(v == null ? '' : v).replace(/\t/g, ' ').replace(/\r?\n/g, ' ');
}

/* v6.7 — Fallback download aligné sur 03-utils.js (30s au lieu de 1s).
   Avant : URL révoquée trop tôt sur connexion lente → téléchargement
   tronqué possible. */
function _supFallbackDownload(blob, filename) {
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
    console.warn('_supFallbackDownload :', e);
  }
}

function importSuppliersJSON(file, options) {
  return new Promise(function (resolve, reject) {
    try {
      if (!file) return reject(new Error('Fichier requis'));
      var mode = (options && options.mode) || 'merge';
      var reader = new FileReader();
      reader.onload = function (ev) {
        try {
          var raw = ev.target.result;
          var parsed = JSON.parse(raw);
          var arr = null;
          if (Array.isArray(parsed)) arr = parsed;
          else if (parsed && Array.isArray(parsed.suppliers)) arr = parsed.suppliers;
          if (!arr) throw new Error('Format invalide : suppliers[] attendu');

          var added = 0, skipped = 0, invalid = 0;
          if (mode === 'replace') { if (typeof _pushAllToTrashBeforeReplace === 'function') _pushAllToTrashBeforeReplace('suppliers', suppliers); suppliers = []; }

          for (var i = 0; i < arr.length; i++) {
            var clean = _normalizeSupplier(arr[i]);
            if (!clean) { invalid++; continue; }
            if (supplierExists(clean.nom)) { skipped++; continue; }
            suppliers.push(clean);
            added++;
          }

          if (typeof saveAll === 'function') saveAll();
          if (typeof logAction === 'function') {
            logAction('supplier.import', added + ' ajoutés');
          }
          renderSuppliers();
          if (typeof showToast === 'function') {
            var msg = added + ' fournisseur(s) importé(s)';
            if (skipped > 0) msg += ' · ' + skipped + ' doublon(s) ignoré(s)';
            if (invalid > 0) msg += ' · ' + invalid + ' invalide(s)';
            showToast(msg, added > 0 ? 'success' : 'warning', 4000);
          }
          resolve({ added: added, skipped: skipped, invalid: invalid });
        } catch (err) {
          reject(err);
        }
      };
      reader.onerror = function () { reject(reader.error || new Error('Lecture échouée')); };
      reader.readAsText(file);
    } catch (e) {
      reject(e);
    }
  });
}

/* ═══════════ SECTION 11 — IMPRESSION ═══════════ */

function printSuppliersList() {
  try {
    var list = getFilteredSuppliers();
    var html = '<!DOCTYPE html><html><head><meta charset="UTF-8">' +
      '<title>Liste des fournisseurs — VOLTCORE</title>' +
      '<style>' +
      'body{font-family:Arial,sans-serif;margin:20px;font-size:12px}' +
      'h1{color:#0b3d91;font-size:18px;border-bottom:2px solid #0b3d91;padding-bottom:6px}' +
      'table{width:100%;border-collapse:collapse;margin-top:10px}' +
      'th,td{border:1px solid #ccc;padding:6px;text-align:left}' +
      'th{background:#f0f0f0;font-weight:bold}' +
      '.footer{margin-top:20px;font-size:10px;color:#666;text-align:center}' +
      '</style></head><body>';
    html += '<h1>Liste des fournisseurs</h1>';
    html += '<div>Total : ' + list.length + ' · ' + todayISO() + '</div>';
    html += '<table><thead><tr>' +
      '<th>Nom</th><th>Téléphone</th><th>Email</th><th>Adresse</th><th>MF</th>' +
      '</tr></thead><tbody>';
    for (var i = 0; i < list.length; i++) {
      var f = list[i];
      html += '<tr>' +
        '<td>' + escapeHtml(f.nom || '') + '</td>' +
        '<td>' + escapeHtml(f.telephone || '') + '</td>' +
        '<td>' + escapeHtml(f.email || '') + '</td>' +
        '<td>' + escapeHtml(f.adresse || '') + '</td>' +
        '<td>' + escapeHtml(f.mf || '') + '</td>' +
        '</tr>';
    }
    html += '</tbody></table>';
    html += '<div class="footer">VOLTCORE — Généré le ' + todayISO() + '</div>';
    html += '</body></html>';

    var w = window.open('', '_blank');
    if (!w) {
      if (typeof showToast === 'function') {
        showToast('Autorise les pop-ups pour imprimer.', 'warning');
      }
      return;
    }
    w.document.write(html);
    w.document.close();
    setTimeout(function () { try { w.print(); } catch (e) {} }, 500);
  } catch (e) {
    console.warn('printSuppliersList :', e);
  }
}

/* ═══════════ SECTION 12 — ÉVÉNEMENTS ═══════════ */

function attachSuppliersEvents() {
  try {
    var searchInput = document.getElementById('suppliersSearchInput');
    if (searchInput && !searchInput.__bound) {
      searchInput.__bound = true;
      searchInput.addEventListener('input', debounce(function (ev) {
        setSuppliersSearch(ev.target.value);
      }, 250));
    }

    var filterSel = document.getElementById('suppliersFilterSelect');
    if (filterSel && !filterSel.__bound) {
      filterSel.__bound = true;
      filterSel.addEventListener('change', function (ev) {
        setSuppliersFilter(ev.target.value);
      });
    }

    var addBtn = document.getElementById('btnAddSupplier');
    if (addBtn && !addBtn.__bound) {
      addBtn.__bound = true;
      addBtn.addEventListener('click', function () { openSupplierModal(null); });
    }

    var importBtn = document.getElementById('btnImportSuppliers');
    if (importBtn && !importBtn.__bound) {
      importBtn.__bound = true;
      importBtn.addEventListener('click', function () {
        var input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json,application/json';
        input.onchange = function (ev) {
          var f = ev.target.files && ev.target.files[0];
          if (!f) return;
          importSuppliersJSON(f, { mode: 'merge' }).catch(function (err) {
            if (typeof showToast === 'function') {
              showToast('Import échoué : ' + (err.message || ''), 'error');
            }
          });
        };
        input.click();
      });
    }

    var exportJsonBtn = document.getElementById('btnExportSuppliersJSON');
    if (exportJsonBtn && !exportJsonBtn.__bound) {
      exportJsonBtn.__bound = true;
      exportJsonBtn.addEventListener('click', exportSuppliersJSON);
    }

    var exportCsvBtn = document.getElementById('btnExportSuppliersCSV');
    if (exportCsvBtn && !exportCsvBtn.__bound) {
      exportCsvBtn.__bound = true;
      exportCsvBtn.addEventListener('click', exportSuppliersCSV);
    }

    var printBtn = document.getElementById('btnPrintSuppliers');
    if (printBtn && !printBtn.__bound) {
      printBtn.__bound = true;
      printBtn.addEventListener('click', printSuppliersList);
    }
  } catch (e) { console.warn('attachSuppliersEvents :', e); }
}

console.log('✅ 07-suppliers.js chargé — v6.7 (fallback download 30s)');