/* ═══════════════════════════════════════════════════════════
   VOLTCORE — 17-docs.js
   VERSION : v7.0.7
   RÔLE : Bibliothèque de documents transversale.
          Métadonnées en localStorage, fichiers en IndexedDB.
          Catégories, recherche, upload, aperçu, partage natif,
          dossier local (File System Access), import/export.
   DÉPENDANCES : 00-core, 01-utils, 02-store, 03-idb
   ORDRE : 18ᵉ fichier chargé

   FIX v7.0.0 :
   - C3 : `blobs` handler enregistré dans Store → cleanOrphans protège les fichiers actifs
   - File System Access : copie miroir optionnelle (writeFile)
   - Share API : fallback download si non supporté
   - Sync dossier : doublon par (nom + taille)

   RÈGLES :
   - ES5 strict
   - Aucun catch silencieux
   - Ne JAMAIS lire/écrire localStorage directement
   ═══════════════════════════════════════════════════════════ */

'use strict';

(function (global) {

  if (!global.VOLTCORE || !global.VOLTCORE.Store ||
      !global.VOLTCORE.Utils || !global.VOLTCORE.IDB) {
    throw new Error('[17-docs] Modules requis non chargés');
  }

  var VC = global.VOLTCORE;
  var U = VC.Utils;
  var S = VC.Store;
  var IDB = VC.IDB;
  var D = VC.Documents || {};
  VC.Documents = D;

  /* ═══════════════════════════════════════════════════════════
     SECTION 1 — REGISTRATION STORE (FIX C3)
     ═══════════════════════════════════════════════════════════ */

  /**
   * FIX C3 : le handler `blobs` retourne le storageKey de chaque item.
   * `03-idb._cleanOrphanBlobs` lit `Store.getAllBlobRefs()` qui appelle
   * ce handler. Sans lui, les blobs des documents étaient supprimés
   * comme "orphelins" à chaque boot.
   */
  S.register('documentsLib', {
    type: 'array',
    saveKey: 'voltcore_documents_lib',
    default: [],
    idPrefix: 'doclib',
    trash: true,
    backup: true,
    blobs: function (item) {
      return (item && item.storageKey) ? [item.storageKey] : [];
    },
    schema: {
      nom: 'string|required',
      categorie: 'enum|facture,contrat,plan,attestation,photo,recu,autre',
      mime: 'string',
      taille: 'float|0-999999999',
      storage: 'enum|idb',
      storageKey: 'string|required',
      date: 'date',
      notes: 'string'
    }
  });

  S.register('documentsCategories', {
    type: 'array',
    saveKey: 'voltcore_documents_categories',
    default: [],
    backup: true,
    schema: {
      id: 'string|required',
      label: 'string',
      icon: 'string'
    }
  });

  /* ═══════════════════════════════════════════════════════════
     SECTION 2 — CONSTANTES + ÉTAT
     ═══════════════════════════════════════════════════════════ */

  var CATEGORIES_DEFAULT = [
    { id: 'facture',     label: 'Factures',        icon: '🧾' },
    { id: 'contrat',     label: 'Contrats',        icon: '📄' },
    { id: 'plan',        label: 'Plans',           icon: '📐' },
    { id: 'attestation', label: 'Attestations',    icon: '✅' },
    { id: 'photo',       label: 'Photos chantier', icon: '📷' },
    { id: 'recu',        label: 'Reçus',           icon: '🧾' },
    { id: 'autre',       label: 'Autres',          icon: '📎' }
  ];

  var ACCEPTED_MIMES = [
    'image/jpeg', 'image/png', 'image/webp', 'application/pdf'
  ];

  var _searchTerm = '';
  var _filterCat = 'all';
  var _filterLinked = 'all';
  var _page = 0;
  var _perPage = 50;

  var _fsHandle = null;

  /* ═══════════════════════════════════════════════════════════
     SECTION 3 — HELPERS
     ═══════════════════════════════════════════════════════════ */

  D.getById = function (id) {
    return S.getById('documentsLib', id);
  };

  D.getCategorieInfo = function (catId) {
    var id = String(catId || 'autre');

    /* Customs d'abord */
    var customs = S.getAll('documentsCategories');
    for (var i = 0; i < customs.length; i++) {
      if (customs[i] && customs[i].id === id) return customs[i];
    }
    /* Puis défauts */
    for (var j = 0; j < CATEGORIES_DEFAULT.length; j++) {
      if (CATEGORIES_DEFAULT[j].id === id) return CATEGORIES_DEFAULT[j];
    }
    return { id: 'autre', label: 'Autres', icon: '📎' };
  };

  D.getAllCategories = function () {
    var map = {};
    var out = [];

    for (var i = 0; i < CATEGORIES_DEFAULT.length; i++) {
      map[CATEGORIES_DEFAULT[i].id] = CATEGORIES_DEFAULT[i];
    }

    var customs = S.getAll('documentsCategories');
    for (var j = 0; j < customs.length; j++) {
      if (customs[j] && customs[j].id) map[customs[j].id] = customs[j];
    }

    var keys = Object.keys(map);
    for (var k = 0; k < keys.length; k++) {
      out.push(map[keys[k]]);
    }
    return out;
  };

  function _isImage(mime) {
    return String(mime || '').indexOf('image/') === 0;
  }

  function _isPdf(mime) {
    return String(mime || '') === 'application/pdf';
  }

  function _extensionForMime(mime) {
    if (_isPdf(mime)) return '.pdf';
    if (mime === 'image/png') return '.png';
    if (mime === 'image/webp') return '.webp';
    return '.jpg';
  }

  function _sanitizeFilename(name) {
    return String(name || 'document')
      .replace(/[\\/:*?"<>|]/g, '_')
      .slice(0, 100);
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 4 — CRUD
     ═══════════════════════════════════════════════════════════ */

  /**
   * Crée une nouvelle entrée document.
   * - Valide mime + taille
   * - Stocke le blob en IDB
   * - Crée l'entrée métadonnée dans Store
   * - Copie optionnelle dans le dossier local (FS Access)
   */
  D.createEntry = function (file, meta) {
    return new Promise(function (resolve, reject) {
      if (!file) {
        reject(new Error('Fichier requis'));
        return;
      }

      if (ACCEPTED_MIMES.indexOf(file.type) === -1) {
        reject(new Error('Type non accepté (JPEG/PNG/WebP ou PDF)'));
        return;
      }
      if (file.size > VC.DOCLIB_MAX_BYTES) {
        reject(new Error('Fichier trop lourd (> ' +
          U.formatBytes(VC.DOCLIB_MAX_BYTES) + ')'));
        return;
      }

      var storageKey = U.generateId('doclib_blob');
      var m = meta || {};
      var nom = String(m.nom || file.name || 'Sans nom').trim();

      IDB.blobs.put(storageKey, file, file.type).then(function () {
        var entry = {
          nom: nom.slice(0, 200),
          categorie: String(m.categorie || 'autre'),
          mime: file.type,
          taille: file.size,
          storage: 'idb',
          storageKey: storageKey,
          tags: Array.isArray(m.tags) ? m.tags.slice(0, 20) : [],
          notes: String(m.notes || '').slice(0, 500),
          date: String(m.date || U.todayISO()).slice(0, 10)
        };

        var saved = S.save('documentsLib', entry);
        if (!saved) {
          /* Cleanup : supprime le blob orphelin */
          IDB.blobs.delete(storageKey).catch(function (e) {
            VC.logError('17-docs', 'cleanup blob post-fail échoué', e);
          });
          reject(new Error('Enregistrement métadonnées échoué'));
          return;
        }

        /* FIX R4 : ne PAS mirror quand on importe DEPUIS le dossier
           (sinon on réécrit ce qu'on vient de lire → doublons). */
        if (!meta || !meta.skipMirror) {
          _mirrorToFolder(saved, file);
        }

        resolve(saved);
      }).catch(function (e) {
        VC.logError('17-docs', 'put blob échoué', e);
        reject(e);
      });
    });
  };

  D.updateMeta = function (id, changes) {
    var entry = D.getById(id);
    if (!entry) return false;
    if (!changes || typeof changes !== 'object') return false;

    var allowed = ['nom', 'categorie', 'tags', 'notes', 'date'];
    for (var i = 0; i < allowed.length; i++) {
      var k = allowed[i];
      if (changes.hasOwnProperty(k)) {
        if (k === 'tags') {
          entry.tags = Array.isArray(changes[k]) ? changes[k].slice(0, 20) : [];
        } else if (k === 'nom') {
          entry.nom = String(changes[k] || '').slice(0, 200);
        } else if (k === 'notes') {
          entry.notes = String(changes[k] || '').slice(0, 500);
        } else if (k === 'date') {
          entry.date = String(changes[k] || '').slice(0, 10);
        } else if (k === 'categorie') {
          entry.categorie = String(changes[k] || 'autre');
        }
      }
    }

    return !!S.save('documentsLib', entry);
  };

  D.remove = function (id) {
    var entry = D.getById(id);
    if (!entry) return false;

    if (!S.delete('documentsLib', id)) {
      U.toast('Erreur suppression.', 'error');
      return false;
    }

    /* Le blob sera supprimé par cleanOrphans au prochain boot
       OU directement si on veut accélérer :
       on ne supprime PAS le blob immédiatement pour permettre
       l'undo dans les 5 secondes. */

    U.toastUndo('Document supprimé : ' + entry.nom,
      function () { _restore(id); }, 5000);

    return true;
  };

  function _restore(id) {
    var entries = S.getTrashEntries('documentsLib');
    for (var i = 0; i < entries.length; i++) {
      if (entries[i].item && String(entries[i].item.id) === String(id)) {
        S.restoreFromTrash('documentsLib', i);
        D.render();
        U.toast('Document restauré', 'success', 2000);
        return;
      }
    }
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 5 — RENDU LISTE + VIGNETTES
     ═══════════════════════════════════════════════════════════ */

  D.render = function () {
    var container = document.getElementById('documentsList');
    if (!container) return;

    var list = D.getFiltered();
    var total = list.length;

    if (total === 0) {
      container.innerHTML = '<div class="empty-state" style="grid-column:1/-1">' +
        'Aucun document' +
        (_searchTerm || _filterCat !== 'all' || _filterLinked !== 'all'
          ? ' pour ce filtre' : '') +
        '. Clique sur "+ Nouveau document" pour commencer.</div>';
      U.setText('documentsCount', '0');
      var pag = document.getElementById('documentsPagination');
      if (pag) pag.style.display = 'none';
      return;
    }

    var maxPage = Math.max(0, Math.ceil(total / _perPage) - 1);
    if (_page > maxPage) _page = maxPage;

    var start = _page * _perPage;
    var end = Math.min(start + _perPage, total);
    var slice = list.slice(start, end);

    var html = '';
    for (var i = 0; i < slice.length; i++) {
      html += D.renderCard(slice[i]);
    }
    container.innerHTML = html;

    U.setText('documentsCount', String(total));
    _renderPagination(_page, maxPage, total);

    /* Charge les vignettes en async */
    for (var j = 0; j < slice.length; j++) {
      _loadThumbAsync(slice[j]);
    }
  };

  D.renderCard = function (doc) {
    if (!doc) return '';

    var id = U.escapeAttr(doc.id);
    var cat = D.getCategorieInfo(doc.categorie);
    var nom = U.escapeHtml(doc.nom || 'Sans nom');
    var isImg = _isImage(doc.mime);
    var isPdf = _isPdf(doc.mime);

    var thumbInner = '';
    if (isImg) {
      thumbInner = '<img data-doc-thumb="' + id + '" alt="" ' +
        'style="opacity:0;transition:opacity 0.2s">';
    } else if (isPdf) {
      thumbInner = '<span class="doc-icon">📄</span>';
    } else {
      thumbInner = '<span class="doc-icon">📎</span>';
    }

    var badge = isPdf ? '<span class="doc-type-badge">PDF</span>'
      : (isImg ? '<span class="doc-type-badge">IMG</span>' : '');

    var dateStr = doc.date ? U.formatDate(doc.date) : '';
    var sizeStr = U.formatBytes(doc.taille || 0);

    return '<div class="document-card" data-doclib-id="' + id + '" ' +
      'onclick="VC.Documents.openDetail(\'' + id + '\')" ' +
      'style="cursor:pointer">' +
      '<div class="document-card-thumb">' + thumbInner + badge + '</div>' +
      '<div class="document-card-body">' +
        '<div class="document-card-name" title="' + nom + '">' + nom + '</div>' +
        '<div class="document-card-meta">' +
          '<span>' + U.escapeHtml(cat.icon) + ' ' +
          U.escapeHtml(cat.label) + '</span>' +
          '<span>' + U.escapeHtml(sizeStr) + '</span>' +
        '</div>' +
        (dateStr
          ? '<div class="document-card-meta"><span>' +
            U.escapeHtml(dateStr) + '</span></div>'
          : '') +
      '</div>' +
      '<div class="document-card-actions">' +
        '<button type="button" class="btn-icon" title="Partager" ' +
        'onclick="event.stopPropagation();VC.Documents.handleShare(\'' + id + '\')">' +
        '📤</button>' +
        '<button type="button" class="btn-icon" title="Télécharger" ' +
        'onclick="event.stopPropagation();VC.Documents.download(\'' + id + '\')">' +
        '⬇️</button>' +
        '<button type="button" class="btn-icon btn-danger" title="Supprimer" ' +
        'onclick="event.stopPropagation();VC.Documents.remove(\'' + id + '\')">' +
        '🗑️</button>' +
      '</div>' +
    '</div>';
  };

  function _loadThumbAsync(doc) {
    if (!doc || !_isImage(doc.mime)) return;

    var img = document.querySelector('[data-doc-thumb="' + doc.id + '"]');
    if (!img) return;

    IDB.blobs.get(doc.storageKey).then(function (row) {
      if (!row || !row.data) return;
      var url = URL.createObjectURL(row.data);
      img.src = url;
      img.style.opacity = '1';
      /* URL conservée pour la session — GC au reload */
    }).catch(function (e) {
      VC.logError('17-docs', 'loadThumb échoué', e);
    });
  }

  function _renderPagination(page, maxPage, total) {
    var pag = document.getElementById('documentsPagination');
    if (!pag) return;
    if (maxPage <= 0) {
      pag.style.display = 'none';
      return;
    }
    pag.style.display = 'flex';
    U.setText('documentsPageInfo',
      'Page ' + (page + 1) + ' / ' + (maxPage + 1) + ' — ' + total + ' doc(s)');
    var prev = document.getElementById('documentsPrevBtn');
    if (prev) prev.disabled = (page <= 0);
    var next = document.getElementById('documentsNextBtn');
    if (next) next.disabled = (page >= maxPage);
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 6 — FILTRES
     ═══════════════════════════════════════════════════════════ */

  D.setSearch = function (term) {
    _searchTerm = String(term || '');
    _page = 0;
    D.render();
  };

  D.setFilterCat = function (cat) {
    _filterCat = String(cat || 'all');
    _page = 0;
    D.render();
  };

  D.setFilterLinked = function (link) {
    _filterLinked = String(link || 'all');
    _page = 0;
    D.render();
  };

  D.setPage = function (p) {
    _page = Math.max(0, parseInt(p, 10) || 0);
    D.render();
  };

  D.getFiltered = function () {
    var out = S.getAll('documentsLib').slice();

    if (_filterCat && _filterCat !== 'all') {
      out = out.filter(function (d) { return d && d.categorie === _filterCat; });
    }

    if (_filterLinked === 'linked') {
      out = out.filter(function (d) { return d && d.linkedTo && d.linkedTo.id; });
    } else if (_filterLinked === 'unlinked') {
      out = out.filter(function (d) {
        return !d || !d.linkedTo || !d.linkedTo.id;
      });
    }

    if (_searchTerm) {
      var term = U.normalizeText(_searchTerm);
      out = out.filter(function (d) {
        if (!d) return false;
        var hay = U.normalizeText([
          d.nom,
          (Array.isArray(d.tags) ? d.tags.join(' ') : ''),
          d.notes || ''
        ].join(' '));
        return hay.indexOf(term) >= 0;
      });
    }

    out.sort(function (a, b) {
      var da = String((a && a.date) || '');
      var db = String((b && b.date) || '');
      if (da === db) {
        var na = String((a && a.nom) || '').toLowerCase();
        var nb = String((b && b.nom) || '').toLowerCase();
        return na > nb ? 1 : (na < nb ? -1 : 0);
      }
      return da < db ? 1 : -1;
    });

    return out;
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 7 — UPLOAD MODAL
     ═══════════════════════════════════════════════════════════ */

  D.openUploadModal = function () {
    U.setVal('documentUploadFile', '');
    U.setVal('documentUploadNom', '');
    U.setVal('documentUploadTags', '');
    U.setVal('documentUploadNotes', '');
    U.setVal('documentUploadDate', U.todayISO());

    _populateUploadCategorie('facture');
    U.setText('documentUploadError', '');
    U.showFlex('documentUploadModal');
  };

  D.closeUploadModal = function () {
    U.hide('documentUploadModal');
  };

  function _populateUploadCategorie(selectedId) {
    var sel = document.getElementById('documentUploadCategorie');
    if (!sel) return;

    var cats = D.getAllCategories();
    var html = '<option value="">— Choisir —</option>';
    for (var i = 0; i < cats.length; i++) {
      var c = cats[i];
      html += '<option value="' + U.escapeAttr(c.id) + '"' +
        (String(selectedId || '') === c.id ? ' selected' : '') + '>' +
        U.escapeHtml(c.icon + ' ' + c.label) + '</option>';
    }
    sel.innerHTML = html;
  }

  function _populateFilterCategorie() {
    var sel = document.getElementById('documentsFilterCat');
    if (!sel) return;

    var cats = D.getAllCategories();
    var html = '<option value="all">Toutes catégories</option>';
    for (var i = 0; i < cats.length; i++) {
      var c = cats[i];
      html += '<option value="' + U.escapeAttr(c.id) + '"' +
        (String(_filterCat) === c.id ? ' selected' : '') + '>' +
        U.escapeHtml(c.icon + ' ' + c.label) + '</option>';
    }
    sel.innerHTML = html;
  }

  D.handleUploadForm = function () {
    var errEl = document.getElementById('documentUploadError');
    if (errEl) errEl.textContent = '';

    var fileInput = document.getElementById('documentUploadFile');
    if (!fileInput || !fileInput.files || !fileInput.files[0]) {
      if (errEl) errEl.textContent = 'Sélectionne un fichier.';
      return;
    }
    var file = fileInput.files[0];

    var cat = U.getVal('documentUploadCategorie') || 'autre';
    var nom = U.getVal('documentUploadNom') || file.name || 'Sans nom';
    var date = U.getVal('documentUploadDate') || U.todayISO();
    var tagsRaw = U.getVal('documentUploadTags');
    var tags = tagsRaw
      ? tagsRaw.split(',').map(function (t) { return t.trim(); })
          .filter(function (t) { return t; })
      : [];
    var notes = U.getVal('documentUploadNotes');

    D.createEntry(file, {
      nom: nom,
      categorie: cat,
      date: date,
      tags: tags,
      notes: notes
    }).then(function (entry) {
      D.closeUploadModal();
      D.render();
      U.toast('Document ajouté : ' + entry.nom, 'success', 2500);
    }).catch(function (err) {
      if (errEl) errEl.textContent = 'Erreur : ' + (err.message || 'inconnue');
    });
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 8 — DÉTAIL
     ═══════════════════════════════════════════════════════════ */

  D.openDetail = function (id) {
    var doc = D.getById(id);
    if (!doc) {
      U.toast('Document introuvable.', 'error');
      return;
    }

    U.setText('documentDetailTitle', doc.nom || 'Document');

    var cat = D.getCategorieInfo(doc.categorie);
    var isImg = _isImage(doc.mime);
    var isPdf = _isPdf(doc.mime);

    var html = '';

    /* Aperçu */
    html += '<div id="docDetailPreviewWrap" class="doc-detail-preview">' +
      '<div class="muted" style="padding:40px">Chargement…</div></div>';

    /* Infos */
    html += '<div class="detail-section"><h3>Informations</h3>' +
      '<div class="detail-grid">';
    html += _detailItem('Nom', doc.nom);
    html += _detailItem('Catégorie', cat.icon + ' ' + cat.label);
    html += _detailItem('Taille', U.formatBytes(doc.taille || 0));
    html += _detailItem('Date', doc.date ? U.formatDate(doc.date) : '—');
    if (Array.isArray(doc.tags) && doc.tags.length > 0) {
      html += _detailItem('Tags', doc.tags.join(', '));
    }
    if (doc.notes) {
      html += '<div class="detail-item" style="grid-column:1/-1">' +
        '<div class="detail-label">Notes</div>' +
        '<div class="detail-value">' + U.escapeHtml(doc.notes) + '</div></div>';
    }
    html += '</div></div>';

    /* Actions */
    html += '<div class="detail-section detail-actions">';
    html += '<button type="button" class="btn" ' +
      'onclick="VC.Documents.handleShare(\'' + U.escapeAttr(doc.id) + '\')">' +
      '📤 Partager</button> ';
    html += '<button type="button" class="btn" ' +
      'onclick="VC.Documents.download(\'' + U.escapeAttr(doc.id) + '\')">' +
      '⬇️ Télécharger</button> ';
    html += '<button type="button" class="btn" ' +
      'onclick="VC.Documents.openInTab(\'' + U.escapeAttr(doc.id) + '\')">' +
      '🔗 Ouvrir</button> ';
    html += '<button type="button" class="btn" ' +
      'onclick="VC.Documents.rename(\'' + U.escapeAttr(doc.id) + '\')">' +
      '✏️ Renommer</button> ';
    html += '<button type="button" class="btn btn-danger" ' +
      'onclick="VC.Documents.remove(\'' + U.escapeAttr(doc.id) + '\');' +
      'VC.Documents.closeDetail();">🗑️ Supprimer</button>';
    html += '</div>';

    var body = document.getElementById('documentDetailBody');
    if (body) body.innerHTML = html;
    U.showFlex('documentDetailModal');

    /* Charge l'aperçu */
    IDB.blobs.get(doc.storageKey).then(function (row) {
      var wrap = document.getElementById('docDetailPreviewWrap');
      if (!wrap) return;
      if (!row || !row.data) {
        wrap.innerHTML = '<div class="muted" style="padding:40px">' +
          'Fichier introuvable</div>';
        return;
      }

      var url = URL.createObjectURL(row.data);
      if (isImg) {
        wrap.innerHTML = '<img src="' + url + '" alt="Aperçu">';
      } else if (isPdf) {
        wrap.innerHTML = '<iframe src="' + url + '" title="Aperçu PDF"></iframe>';
      } else {
        wrap.innerHTML = '<div class="muted" style="padding:40px">' +
          'Aperçu non disponible</div>';
      }
    }).catch(function (e) {
      VC.logError('17-docs', 'openDetail load preview échoué', e);
      var wrap2 = document.getElementById('docDetailPreviewWrap');
      if (wrap2) wrap2.innerHTML = '<div class="muted" style="padding:40px">' +
        'Erreur de chargement</div>';
    });
  };

  D.closeDetail = function () {
    U.hide('documentDetailModal');
  };

  function _detailItem(label, value) {
    return '<div class="detail-item">' +
      '<div class="detail-label">' + U.escapeHtml(label) + '</div>' +
      '<div class="detail-value">' + U.escapeHtml(value) + '</div>' +
      '</div>';
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 9 — ACTIONS
     ═══════════════════════════════════════════════════════════ */

  D.download = function (id) {
    var doc = D.getById(id);
    if (!doc) return;

    IDB.blobs.get(doc.storageKey).then(function (row) {
      if (!row || !row.data) {
        U.toast('Fichier introuvable.', 'error');
        return;
      }

      var ext = _extensionForMime(doc.mime);
      var filename = _sanitizeFilename(doc.nom);
      if (!/\.[a-z0-9]{2,4}$/i.test(filename)) filename += ext;

      U.downloadBlob(row.data, filename);
    }).catch(function (e) {
      VC.logError('17-docs', 'download échoué', e);
      U.toast('Erreur de téléchargement.', 'error');
    });
  };

  D.openInTab = function (id) {
    var doc = D.getById(id);
    if (!doc) return;

    IDB.blobs.get(doc.storageKey).then(function (row) {
      if (!row || !row.data) {
        U.toast('Fichier introuvable.', 'error');
        return;
      }
      var url = URL.createObjectURL(row.data);
      global.open(url, '_blank');
    }).catch(function (e) {
      VC.logError('17-docs', 'openInTab échoué', e);
    });
  };

  D.rename = function (id) {
    var doc = D.getById(id);
    if (!doc) return;

    var nouveau = U.prompt('Nouveau nom :', doc.nom);
    if (nouveau === null) return;

    var trimmed = String(nouveau).trim();
    if (!trimmed) return;

    if (D.updateMeta(id, { nom: trimmed })) {
      D.render();
      U.toast('Document renommé.', 'success', 2000);
      var detailModal = document.getElementById('documentDetailModal');
      if (detailModal && detailModal.style.display === 'flex') {
        D.openDetail(id);
      }
    }
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 10 — PARTAGE NATIF
     ═══════════════════════════════════════════════════════════ */

  function _canShareFiles() {
    try {
      if (typeof navigator === 'undefined' || typeof navigator.share !== 'function') {
        return false;
      }
      if (typeof navigator.canShare !== 'function') return false;

      var testFile = new File(['x'], 'test.txt', { type: 'text/plain' });
      return navigator.canShare({ files: [testFile] });
    } catch (e) {
      VC.logError('17-docs', 'canShareFiles échoué', e);
      return false;
    }
  }

  D.share = function (id) {
    return new Promise(function (resolve) {
      var doc = D.getById(id);
      if (!doc) {
        resolve({ ok: false, method: 'not-found' });
        return;
      }

      IDB.blobs.get(doc.storageKey).then(function (row) {
        if (!row || !row.data) {
          resolve({ ok: false, method: 'blob-missing' });
          return;
        }

        var ext = _extensionForMime(doc.mime);
        var filename = _sanitizeFilename(doc.nom);
        if (!/\.[a-z0-9]{2,4}$/i.test(filename)) filename += ext;

        if (_canShareFiles()) {
          try {
            var file = new File([row.data], filename, {
              type: doc.mime || row.mime
            });
            navigator.share({
              files: [file],
              title: doc.nom,
              text: 'Document VOLTCORE : ' + doc.nom
            }).then(function () {
              resolve({ ok: true, method: 'share' });
            }).catch(function (err) {
              if (err && err.name === 'AbortError') {
                resolve({ ok: false, method: 'cancelled' });
                return;
              }
              VC.logError('17-docs', 'share échoué, fallback download', err);
              U.downloadBlob(row.data, filename);
              resolve({ ok: true, method: 'download' });
            });
          } catch (e) {
            VC.logError('17-docs', 'share file creation échouée', e);
            U.downloadBlob(row.data, filename);
            resolve({ ok: true, method: 'download' });
          }
        } else {
          U.downloadBlob(row.data, filename);
          resolve({ ok: true, method: 'download' });
        }
      }).catch(function (err) {
        VC.logError('17-docs', 'share blob load échoué', err);
        resolve({ ok: false, method: 'error' });
      });
    });
  };

  D.handleShare = function (id) {
    D.share(id).then(function (res) {
      if (!res.ok) {
        if (res.method === 'cancelled') return;
        U.toast('Partage impossible (' + (res.method || 'erreur') + ').',
          'warning', 3000);
        return;
      }
      if (res.method === 'share') {
        U.toast('Document partagé.', 'success', 2000);
      } else if (res.method === 'download') {
        U.toast('Document téléchargé (partage natif indisponible).',
          'info', 3000);
      }
    });
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 11 — FILE SYSTEM ACCESS
     ═══════════════════════════════════════════════════════════ */

  function _renderFsBanner() {
    var banner = document.getElementById('documentsFsBanner');
    if (!banner) return;

    if (!IDB.fs.isSupported()) {
      banner.style.display = 'none';
      return;
    }
    banner.style.display = 'flex';

    var nameEl = document.getElementById('documentsFsName');
    var chooseBtn = document.getElementById('btnChooseDocumentsFolder');
    var syncBtn = document.getElementById('btnSyncDocumentsFolder');
    var forgetBtn = document.getElementById('btnForgetDocumentsFolder');

    if (_fsHandle) {
      if (nameEl) nameEl.textContent = _fsHandle.name || '(dossier)';
      if (chooseBtn) chooseBtn.textContent = '🔄 Changer';
      if (syncBtn) syncBtn.style.display = '';
      if (forgetBtn) forgetBtn.style.display = '';
    } else {
      if (nameEl) nameEl.textContent = 'Aucun dossier sélectionné (IndexedDB uniquement)';
      if (chooseBtn) chooseBtn.textContent = '📂 Choisir un dossier';
      if (syncBtn) syncBtn.style.display = 'none';
      if (forgetBtn) forgetBtn.style.display = 'none';
    }
  }

  function _initFsHandle() {
    if (!IDB.fs.isSupported()) return;
    IDB.fs.getHandle().then(function (h) {
      if (h) {
        _fsHandle = h;
        _renderFsBanner();
      }
    }).catch(function (e) {
      VC.logError('17-docs', 'initFsHandle échoué', e);
    });
  }

  D.chooseFolder = function () {
    if (!IDB.fs.isSupported()) {
      U.toast('Non supporté sur ce navigateur.', 'warning');
      return;
    }

    global.showDirectoryPicker({ mode: 'readwrite' }).then(function (handle) {
      return IDB.fs.verifyPermission(handle, true).then(function (ok) {
        if (!ok) throw new Error('Permission refusée');
        return IDB.fs.saveHandle(handle).then(function () {
          _fsHandle = handle;
          _renderFsBanner();
          U.toast('Dossier configuré : ' + (handle.name || ''), 'success', 3000);
        });
      });
    }).catch(function (err) {
      if (err && err.name === 'AbortError') return;
      VC.logError('17-docs', 'chooseFolder échoué', err);
      U.toast('Erreur dossier : ' + (err.message || ''), 'error', 4000);
    });
  };

  D.forgetFolder = function () {
    if (!U.confirm('Oublier le dossier local ?\n\nLes fichiers déjà écrits restent intacts.')) {
      return;
    }
    IDB.fs.clearHandle().then(function () {
      _fsHandle = null;
      _renderFsBanner();
      U.toast('Dossier oublié.', 'info', 2000);
    });
  };

  function _mirrorToFolder(entry, blob) {
    if (!_fsHandle || !blob) return;

    IDB.fs.verifyPermission(_fsHandle, false).then(function (ok) {
      if (!ok) return;

      var ext = _extensionForMime(entry.mime);
      var filename = _sanitizeFilename(entry.nom);
      if (!/\.[a-z0-9]{2,4}$/i.test(filename)) filename += ext;

      return IDB.fs.writeFile(_fsHandle, filename, blob).then(function (res) {
        VC.logInfo('17-docs', 'Copie miroir OK : ' + res.relativePath);
      }).catch(function (e) {
        VC.logError('17-docs', 'mirror write échoué', e);
      });
    }).catch(function (e) {
      VC.logError('17-docs', 'mirror verify échoué', e);
    });
  }

  D.syncFromFolder = function () {
    if (!_fsHandle) {
      U.toast('Choisis d\'abord un dossier.', 'warning');
      return;
    }

    IDB.fs.verifyPermission(_fsHandle, true).then(function (ok) {
      if (!ok) {
        U.toast('Permission refusée.', 'error');
        return;
      }

      U.toast('Scan du dossier…', 'info', 2000);

      return IDB.fs.scanDir(_fsHandle, 2).then(function (files) {
        if (!files || files.length === 0) {
          U.toast('Aucun fichier dans le dossier.', 'info');
          return;
        }

        /* FIX R4 : comparaison SANS extension, car d.nom est stocké sans
           extension alors que f.name en a une. */
        var existing = S.getAll('documentsLib');
        var seen = {};
        function _stripExt(n) { return String(n || '').replace(/\.[^.]+$/, ''); }
        for (var i = 0; i < existing.length; i++) {
          var d = existing[i];
          if (!d) continue;
          var key = _stripExt(d.nom) + '|' + String(d.taille || 0);
          seen[key] = true;
        }

        var toImport = [];
        for (var j = 0; j < files.length; j++) {
          var f = files[j];
          var k2 = _stripExt(f.name) + '|' + f.size;
          if (seen[k2]) continue;
          toImport.push(f);
        }

        if (toImport.length === 0) {
          U.toast('Aucun nouveau fichier à importer.', 'info');
          return;
        }

        var added = 0, failed = 0, idx = 0;

        function next() {
          if (idx >= toImport.length) {
            D.render();
            var msg = added + ' fichier(s) importé(s)';
            if (failed > 0) msg += ' · ' + failed + ' échec(s)';
            U.toast(msg, added > 0 ? 'success' : 'warning', 4000);
            return;
          }

          var item = toImport[idx++];
          var cat = 'autre';
          if (/\.pdf$/i.test(item.name)) cat = 'facture';
          else if (/photo|img/i.test(item.name)) cat = 'photo';

          D.createEntry(item.file, {
            nom: item.name.replace(/\.[^.]+$/, ''),
            categorie: cat,
            date: U.todayISO(),
            tags: ['import-folder'],
            notes: 'Importé depuis le dossier local',
            skipMirror: true
          }).then(function () {
            added++;
            next();
          }).catch(function (e) {
            VC.logError('17-docs', 'sync import échoué pour ' + item.name, e);
            failed++;
            next();
          });
        }
        next();
      });
    }).catch(function (e) {
      VC.logError('17-docs', 'syncFromFolder échoué', e);
      U.toast('Erreur sync : ' + (e.message || ''), 'error', 4000);
    });
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 12 — IMPORT / EXPORT
     ═══════════════════════════════════════════════════════════ */

  D.exportJSON = function () {
    var arr = S.getAll('documentsLib');
    var data = {
      version: 1,
      exportedAt: new Date().toISOString(),
      count: arr.length,
      documents: arr,
      categories: S.getAll('documentsCategories')
    };
    var blob = new Blob([JSON.stringify(data, null, 2)], {
      type: 'application/json'
    });
    U.downloadBlob(blob, 'voltcore-documents-meta-' + U.todayISO() + '.json');
    U.toast(arr.length + ' document(s) (métadonnées) exporté(s)', 'success', 3000);
  };

  D.importJSON = function (file) {
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

          var arr = Array.isArray(parsed.documents) ? parsed.documents
            : (Array.isArray(parsed) ? parsed : null);
          if (!arr) {
            reject(new Error('Format invalide : documents[] attendu'));
            return;
          }

          var added = 0, skipped = 0, invalid = 0;

          for (var i = 0; i < arr.length; i++) {
            var d = arr[i];
            if (!d || !d.nom || !d.storageKey) { invalid++; continue; }
            if (D.getById(d.id)) { skipped++; continue; }
            if (S.save('documentsLib', d)) added++;
            else invalid++;
          }

          /* Fusion catégories */
          if (Array.isArray(parsed.categories)) {
            var existingCats = S.getAll('documentsCategories');
            for (var j = 0; j < parsed.categories.length; j++) {
              var c = parsed.categories[j];
              if (!c || !c.id) continue;
              var exists = false;
              for (var k = 0; k < existingCats.length; k++) {
                if (existingCats[k].id === c.id) { exists = true; break; }
              }
              if (!exists) S.save('documentsCategories', c);
            }
          }

          D.render();
          _populateFilterCategorie();

          var msg = added + ' doc(s) importé(s) (métadonnées)';
          if (skipped > 0) msg += ' · ' + skipped + ' doublon(s)';
          if (invalid > 0) msg += ' · ' + invalid + ' invalide(s)';
          U.toast(msg, added > 0 ? 'success' : 'warning', 4000);

          resolve({ added: added, skipped: skipped, invalid: invalid });
        } catch (err) {
          VC.logError('17-docs', 'importJSON parse échoué', err);
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
     SECTION 13 — EVENTS
     ═══════════════════════════════════════════════════════════ */

  D.attachEvents = function () {
    U.on('btnAddDocument', 'click', function () {
      D.openUploadModal();
    });

    U.on('documentsSearchInput', 'input', U.debounce(function (ev) {
      D.setSearch(ev.target.value);
    }, 250));

    U.on('documentsFilterCat', 'change', function (ev) {
      D.setFilterCat(ev.target.value);
    });

    U.on('documentsFilterLinked', 'change', function (ev) {
      D.setFilterLinked(ev.target.value);
    });

    U.on('documentsPrevBtn', 'click', function () {
      D.setPage(_page - 1);
    });

    U.on('documentsNextBtn', 'click', function () {
      D.setPage(_page + 1);
    });

    U.on('documentUploadSaveBtn', 'click', D.handleUploadForm);

    /* Auto-remplissage nom depuis fichier */
    U.on('documentUploadFile', 'change', function (ev) {
      var f = ev.target.files && ev.target.files[0];
      if (!f) return;
      var nomInput = document.getElementById('documentUploadNom');
      if (nomInput && !nomInput.value) {
        nomInput.value = f.name.replace(/\.[^.]+$/, '');
      }
    });

    U.on('btnExportDocumentsJSON', 'click', D.exportJSON);

    U.on('btnImportDocuments', 'click', function () {
      var input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json,application/json';
      input.onchange = function (ev) {
        var f = ev.target.files && ev.target.files[0];
        if (!f) return;
        D.importJSON(f).catch(function (err) {
          U.toast('Import échoué : ' + (err.message || ''), 'error', 4000);
        });
      };
      input.click();
    });

    /* FS banner */
    U.on('btnChooseDocumentsFolder', 'click', D.chooseFolder);
    U.on('btnSyncDocumentsFolder', 'click', D.syncFromFolder);
    U.on('btnForgetDocumentsFolder', 'click', D.forgetFolder);

    /* Init */
    _populateFilterCategorie();
    D.render();
    _initFsHandle();
    _renderFsBanner();

    /* Subscribe : re-render auto */
    S.subscribe('documentsLib', function () {
      D.render();
    });
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 14 — MARQUEUR
     ═══════════════════════════════════════════════════════════ */

  VC._docsLoaded = true;

  VC.logInfo('17-docs', 'Module chargé (blobs handler C3 actif)');

})(window);