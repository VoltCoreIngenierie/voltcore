/* ═══════════════════════════════════════════════════════════════
   VOLTCORE — 24-documents.js
   VERSION : v6.9.8 (Session #6 — Sprint 3 : bibliothèque de documents)
   RÔLE : Bibliothèque transversale de documents (scans, PDF, photos)
          Métadonnées en localStorage, fichiers en IndexedDB blobs.
          Catégories, recherche, filtres, upload, aperçu, download.
   DÉPENDANCES : 01-core.js, 03-utils.js, 04-storage.js (blobs + clés)
   ORDRE : APRÈS 23-bons-route.js, AVANT 21-init-app.js
   ═══════════════════════════════════════════════════════════════ */

/* ═══════════ SECTION 1 — CONSTANTES ═══════════ */

var DOCUMENTS_CATEGORIES_DEFAULT = [
  { id: 'facture',     label: 'Factures',        icon: '🧾' },
  { id: 'contrat',     label: 'Contrats',        icon: '📄' },
  { id: 'plan',        label: 'Plans',           icon: '📐' },
  { id: 'attestation', label: 'Attestations',    icon: '✅' },
  { id: 'photo',       label: 'Photos chantier', icon: '📷' },
  { id: 'recu',        label: 'Reçus',           icon: '🧾' },
  { id: 'autre',       label: 'Autres',          icon: '📎' }
];

var DOCUMENTS_MAX_FILE_SIZE = 5 * 1024 * 1024; /* 5 Mo */
var DOCUMENTS_ACCEPTED_MIMES = [
  'image/jpeg', 'image/png', 'image/webp', 'application/pdf'
];

/* ═══════════ SECTION 2 — ÉTAT ═══════════ */

var __documentsLib = [];
var __documentsCategories = [];
var __documentsSearch = '';
var __documentsFilterCat = 'all';
var __documentsFilterLinked = 'all';
var __documentsPage = 0;
var __documentsPerPage = 50;

/* ═══════════ SECTION 3 — HELPERS ═══════════ */

function _docLibGet(id) {
  try { var el = document.getElementById(id); return el ? String(el.value || '').trim() : ''; } catch (e) { return ''; }
}
function _docLibSet(id, value) {
  try { var el = document.getElementById(id); if (el) el.value = (value === null || value === undefined) ? '' : value; } catch (e) {}
}
function _docLibText(id, text) {
  try { var el = document.getElementById(id); if (el) el.textContent = String(text || ''); } catch (e) {}
}

function _docLibGetCategorieInfo(catId) {
  var id = String(catId || 'autre');
  for (var i = 0; i < __documentsCategories.length; i++) {
    if (__documentsCategories[i].id === id) return __documentsCategories[i];
  }
  for (var j = 0; j < DOCUMENTS_CATEGORIES_DEFAULT.length; j++) {
    if (DOCUMENTS_CATEGORIES_DEFAULT[j].id === id) return DOCUMENTS_CATEGORIES_DEFAULT[j];
  }
  return { id: 'autre', label: 'Autres', icon: '📎' };
}

function _docLibFormatSize(bytes) {
  var n = parseInt(bytes, 10) || 0;
  if (n < 1024) return n + ' o';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' Ko';
  return (n / (1024 * 1024)).toFixed(1) + ' Mo';
}

function _docLibIsImage(mime) {
  return String(mime || '').indexOf('image/') === 0;
}

function _docLibIsPdf(mime) {
  return String(mime || '') === 'application/pdf';
}

/* ═══════════ SECTION 4 — CHARGEMENT / SAUVEGARDE ═══════════ */

function _docLibLoad() {
  try {
    /* Catégories customs */
    var rawCats = localStorage.getItem(STORAGE_KEYS.documentsCategories);
    if (rawCats) {
      var cats = JSON.parse(rawCats);
      __documentsCategories = Array.isArray(cats) ? cats : [];
    } else {
      __documentsCategories = [];
    }

    /* Métadonnées */
    var rawDocs = localStorage.getItem(STORAGE_KEYS.documentsLib);
    if (rawDocs) {
      var docs = JSON.parse(rawDocs);
      __documentsLib = Array.isArray(docs) ? docs : [];
    } else {
      __documentsLib = [];
    }
  } catch (e) {
    console.warn('_docLibLoad :', e);
    __documentsLib = [];
    __documentsCategories = [];
  }
}

function _docLibSave() {
  try {
    localStorage.setItem(STORAGE_KEYS.documentsLib, JSON.stringify(__documentsLib));
    localStorage.setItem(STORAGE_KEYS.documentsCategories, JSON.stringify(__documentsCategories));
    return true;
  } catch (e) {
    if (e && (e.name === 'QuotaExceededError' || e.code === 22)) {
      if (typeof showToast === 'function') {
        showToast('Stockage plein (métadonnées). Exporte et supprime des documents.', 'error', 6000);
      }
    } else {
      console.warn('_docLibSave :', e);
    }
    return false;
  }
}

function _docLibEnsureCategoriesPopulated() {
  if (__documentsCategories.length === 0) return;
  /* Rien à faire — les catégories par défaut sont codées en dur */
}

function _docLibGetAllCategories() {
  /* Fusion : défaut + customs (customs écrasent si même id) */
  var map = {};
  var out = [];
  for (var i = 0; i < DOCUMENTS_CATEGORIES_DEFAULT.length; i++) {
    map[DOCUMENTS_CATEGORIES_DEFAULT[i].id] = DOCUMENTS_CATEGORIES_DEFAULT[i];
  }
  for (var j = 0; j < __documentsCategories.length; j++) {
    if (__documentsCategories[j] && __documentsCategories[j].id) {
      map[__documentsCategories[j].id] = __documentsCategories[j];
    }
  }
  for (var k in map) {
    if (map.hasOwnProperty(k)) out.push(map[k]);
  }
  return out;
}

function _docLibPopulateCategorySelect(selectId, selectedId) {
  try {
    var sel = document.getElementById(selectId);
    if (!sel) return;
    var cats = _docLibGetAllCategories();
    var html = '<option value="">— Choisir —</option>';
    for (var i = 0; i < cats.length; i++) {
      var c = cats[i];
      html += '<option value="' + escapeAttr(c.id) + '"' +
        (String(selectedId || '') === c.id ? ' selected' : '') + '>' +
        escapeHtml(c.icon + ' ' + c.label) + '</option>';
    }
    sel.innerHTML = html;
  } catch (e) { console.warn('_docLibPopulateCategorySelect :', e); }
}

function _docLibPopulateFilterCategorySelect() {
  try {
    var sel = document.getElementById('documentsFilterCat');
    if (!sel) return;
    var cats = _docLibGetAllCategories();
    var html = '<option value="all">Toutes catégories</option>';
    for (var i = 0; i < cats.length; i++) {
      var c = cats[i];
      html += '<option value="' + escapeAttr(c.id) + '"' +
        (String(__documentsFilterCat) === c.id ? ' selected' : '') + '>' +
        escapeHtml(c.icon + ' ' + c.label) + '</option>';
    }
    sel.innerHTML = html;
  } catch (e) { console.warn('_docLibPopulateFilterCategorySelect :', e); }
}

/* ═══════════ SECTION 5 — CRUD ═══════════ */

function getDocLibById(id) {
  try {
    if (!id) return null;
    var sid = String(id);
    for (var i = 0; i < __documentsLib.length; i++) {
      if (__documentsLib[i] && String(__documentsLib[i].id) === sid) return __documentsLib[i];
    }
    return null;
  } catch (e) { return null; }
}

function _docLibCreateEntry(file, meta) {
  return new Promise(function (resolve, reject) {
    try {
      if (!file) return reject(new Error('Fichier requis'));
      if (!DOCUMENTS_ACCEPTED_MIMES.some(function (m) { return file.type === m; })) {
        return reject(new Error('Type non accepté (image JPEG/PNG/WebP ou PDF)'));
      }
      if (file.size > DOCUMENTS_MAX_FILE_SIZE) {
        return reject(new Error('Fichier trop lourd (> ' + _docLibFormatSize(DOCUMENTS_MAX_FILE_SIZE) + ')'));
      }

      var blobRef = 'doclib_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      var entryId = 'doc_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);

      /* 1. Stocke le blob en IDB */
      _idbBlobsPut(blobRef, file, file.type).then(function () {
        /* 2. Construit les métadonnées */
        var m = meta || {};
        var nom = String(m.nom || file.name || 'Sans nom').trim();
        var entry = {
          id: entryId,
          nom: nom.slice(0, 200),
          categorie: String(m.categorie || 'autre'),
          mime: file.type,
          taille: file.size,
          storage: 'idb',
          storageKey: blobRef,
          tags: Array.isArray(m.tags) ? m.tags.slice(0, 20) : [],
          notes: String(m.notes || '').slice(0, 500),
          linkedTo: m.linkedTo || null,
          date: String(m.date || todayISO()).slice(0, 10),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };
        __documentsLib.push(entry);
        _docLibSave();
        if (typeof logAction === 'function') {
          try { logAction('doclib.create', entry.nom); } catch (e) {}
        }
        /* v6.9.9 — Copie miroir dans le dossier local si configuré */
        if (typeof _docLibMirrorToFolder === 'function') {
          try {
            var safeName = entry.nom.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
            var ext = '';
            if (file.type === 'application/pdf') ext = '.pdf';
            else if (file.type === 'image/png') ext = '.png';
            else if (file.type === 'image/webp') ext = '.webp';
            else ext = '.jpg';
            if (!/\.[a-z0-9]{2,4}$/i.test(safeName)) safeName += ext;
            _docLibMirrorToFolder(safeName, file);
          } catch (e) { /* silencieux */ }
        }
        resolve(entry);
      }).catch(reject);
    } catch (e) {
      reject(e);
    }
  });
}

function updateDocLibMeta(id, changes) {
  try {
    var entry = getDocLibById(id);
    if (!entry) return false;
    if (!changes || typeof changes !== 'object') return false;
    var allowed = ['nom', 'categorie', 'tags', 'notes', 'date', 'linkedTo'];
    for (var i = 0; i < allowed.length; i++) {
      var k = allowed[i];
      if (changes.hasOwnProperty(k)) {
        if (k === 'tags') {
          entry.tags = Array.isArray(changes[k]) ? changes[k].slice(0, 20) : [];
        } else if (k === 'linkedTo') {
          entry.linkedTo = changes[k] || null;
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
    entry.updatedAt = new Date().toISOString();
    _docLibSave();
    if (typeof logAction === 'function') {
      try { logAction('doclib.update', entry.nom); } catch (e) {}
    }
    return true;
  } catch (e) {
    console.warn('updateDocLibMeta :', e);
    return false;
  }
}

function deleteDocLibEntry(id) {
  try {
    var entry = getDocLibById(id);
    if (!entry) return false;

    var idx = -1;
    for (var i = 0; i < __documentsLib.length; i++) {
      if (__documentsLib[i] && String(__documentsLib[i].id) === String(id)) { idx = i; break; }
    }
    if (idx < 0) return false;

    __documentsLib.splice(idx, 1);

    /* Corbeille */
    if (!trash || typeof trash !== 'object') {
      trash = { clients: [], articles: [], documents: [] };
    }
    if (!Array.isArray(trash.documentsLib)) trash.documentsLib = [];
    var trashEntry = {
      item: entry,
      deletedAt: new Date().toISOString(),
      deletedBy: (typeof currentUser !== 'undefined' && currentUser && currentUser.username) || 'anon'
    };
    trash.documentsLib.push(trashEntry);

    _docLibSave();
    if (typeof saveAll === 'function') { try { saveAll(); } catch (e) {} }
    if (typeof logAction === 'function') {
      try { logAction('doclib.delete', entry.nom); } catch (e) {}
    }

    renderDocuments();

    if (typeof showUndoToast === 'function') {
      showUndoToast('Document supprimé : ' + entry.nom,
        function () { _docLibRestoreFromTrash(trashEntry); }, 5000);
    } else if (typeof showToast === 'function') {
      showToast('Document déplacé dans la corbeille.', 'info', 3000);
    }
    return true;
  } catch (e) {
    console.warn('deleteDocLibEntry :', e);
    return false;
  }
}

function _docLibRestoreFromTrash(trashEntry) {
  try {
    if (!trashEntry || !trashEntry.item) return false;
    if (trash && Array.isArray(trash.documentsLib)) {
      var ti = trash.documentsLib.indexOf(trashEntry);
      if (ti >= 0) trash.documentsLib.splice(ti, 1);
    }
    var exists = getDocLibById(trashEntry.item.id);
    if (exists) return false;
    __documentsLib.push(trashEntry.item);
    _docLibSave();
    if (typeof saveAll === 'function') { try { saveAll(); } catch (e) {} }
    renderDocuments();
    if (typeof showToast === 'function') {
      showToast('Document restauré : ' + trashEntry.item.nom, 'success', 2500);
    }
    return true;
  } catch (e) {
    console.warn('_docLibRestoreFromTrash :', e);
    return false;
  }
}

/* ═══════════ SECTION 6 — RECHERCHE / FILTRES / PAGINATION ═══════════ */

function setDocumentsSearch(term) {
  __documentsSearch = String(term || '');
  __documentsPage = 0;
  renderDocuments();
}

function setDocumentsFilterCat(cat) {
  __documentsFilterCat = String(cat || 'all');
  __documentsPage = 0;
  renderDocuments();
}

function setDocumentsFilterLinked(link) {
  __documentsFilterLinked = String(link || 'all');
  __documentsPage = 0;
  renderDocuments();
}

function setDocumentsPage(p) {
  __documentsPage = Math.max(0, parseInt(p, 10) || 0);
  renderDocuments();
}

function getFilteredDocuments() {
  try {
    var out = __documentsLib.slice();

    if (__documentsFilterCat && __documentsFilterCat !== 'all') {
      out = out.filter(function (d) { return d && d.categorie === __documentsFilterCat; });
    }

    if (__documentsFilterLinked === 'linked') {
      out = out.filter(function (d) { return d && d.linkedTo && d.linkedTo.id; });
    } else if (__documentsFilterLinked === 'unlinked') {
      out = out.filter(function (d) { return !d || !d.linkedTo || !d.linkedTo.id; });
    }

    if (__documentsSearch) {
      var term = normalizeText(__documentsSearch);
      out = out.filter(function (d) {
        if (!d) return false;
        var hay = normalizeText([
          d.nom,
          (Array.isArray(d.tags) ? d.tags.join(' ') : ''),
          d.notes || ''
        ].join(' '));
        return hay.indexOf(term) >= 0;
      });
    }

    out.sort(function (a, b) {
      var da = String((a && a.date) || (a && a.createdAt) || '');
      var db = String((b && b.date) || (b && b.createdAt) || '');
      if (da === db) {
        var na = String((a && a.nom) || '').toLowerCase();
        var nb = String((b && b.nom) || '').toLowerCase();
        return na > nb ? 1 : (na < nb ? -1 : 0);
      }
      return da < db ? 1 : -1;
    });
    return out;
  } catch (e) {
    console.warn('getFilteredDocuments :', e);
    return [];
  }
}

/* ═══════════ SECTION 7 — RENDU LISTE ═══════════ */

function renderDocuments() {
  try {
    var container = document.getElementById('documentsList');
    if (!container) return;

    var list = getFilteredDocuments();
    var total = list.length;

    if (total === 0) {
      container.innerHTML = '<div class="empty-state" style="grid-column:1/-1">Aucun document' +
        (__documentsSearch || __documentsFilterCat !== 'all' || __documentsFilterLinked !== 'all' ? ' pour ce filtre' : '') +
        '. Clique sur "+ Nouveau document" pour commencer.</div>';
      _docLibText('documentsCount', '0');
      var pag = document.getElementById('documentsPagination');
      if (pag) pag.style.display = 'none';
      return;
    }

    var perPage = __documentsPerPage;
    var page = __documentsPage;
    var maxPage = Math.max(0, Math.ceil(total / perPage) - 1);
    if (page > maxPage) { page = maxPage; __documentsPage = page; }
    var start = page * perPage;
    var end = Math.min(start + perPage, total);
    var slice = list.slice(start, end);

    var html = '';
    for (var i = 0; i < slice.length; i++) {
      html += renderDocumentCard(slice[i]);
    }
    container.innerHTML = html;

    _docLibText('documentsCount', String(total));
    _docLibRenderPagination(page, maxPage, total);

    /* Chargement asynchrone des vignettes */
    for (var j = 0; j < slice.length; j++) {
      _docLibLoadThumbAsync(slice[j]);
    }
  } catch (e) { console.warn('renderDocuments :', e); }
}

function renderDocumentCard(doc) {
  try {
    if (!doc) return '';
    var id = escapeAttr(doc.id);
    var cat = _docLibGetCategorieInfo(doc.categorie);
    var nom = escapeHtml(doc.nom || 'Sans nom');
    var isImg = _docLibIsImage(doc.mime);
    var isPdf = _docLibIsPdf(doc.mime);

    var thumbInner = '';
    if (isImg) {
      thumbInner = '<img data-doc-thumb="' + id + '" alt="" style="opacity:0;transition:opacity 0.2s">';
    } else if (isPdf) {
      thumbInner = '<span class="doc-icon">📄</span>';
    } else {
      thumbInner = '<span class="doc-icon">📎</span>';
    }

    var badge = isPdf ? '<span class="doc-type-badge">PDF</span>' :
                (isImg ? '<span class="doc-type-badge">IMG</span>' : '');

    var dateStr = doc.date ? formatDate(doc.date) : '';
    var sizeStr = _docLibFormatSize(doc.taille);

    return '<div class="document-card" data-doclib-id="' + id + '" ' +
      'onclick="openDocumentDetail(\'' + id + '\')" ' +
      'style="cursor:pointer">' +
      '<div class="document-card-thumb">' + thumbInner + badge + '</div>' +
      '<div class="document-card-body">' +
        '<div class="document-card-name" title="' + nom + '">' + nom + '</div>' +
        '<div class="document-card-meta">' +
          '<span>' + escapeHtml(cat.icon) + ' ' + escapeHtml(cat.label) + '</span>' +
          '<span>' + escapeHtml(sizeStr) + '</span>' +
        '</div>' +
        (dateStr ? '<div class="document-card-meta"><span>' + escapeHtml(dateStr) + '</span></div>' : '') +
      '</div>' +
      '<div class="document-card-actions">' +
        '<button type="button" class="btn-icon" title="Partager" ' +
          'onclick="event.stopPropagation();handleShareDocLib(\'' + id + '\')">📤</button>' +
        '<button type="button" class="btn-icon" title="Télécharger" ' +
          'onclick="event.stopPropagation();downloadDocLib(\'' + id + '\')">⬇️</button>' +
        '<button type="button" class="btn-icon btn-danger" title="Supprimer" ' +
          'onclick="event.stopPropagation();deleteDocLibEntry(\'' + id + '\')">🗑️</button>' +
      '</div>' +
    '</div>';
  } catch (e) { console.warn('renderDocumentCard :', e); return ''; }
}

function _docLibLoadThumbAsync(doc) {
  try {
    if (!doc || !_docLibIsImage(doc.mime)) return;
    var img = document.querySelector('[data-doc-thumb="' + doc.id + '"]');
    if (!img) return;
    _idbBlobsGet(doc.storageKey).then(function (row) {
      if (!row || !row.data) return;
      var url = URL.createObjectURL(row.data);
      img.src = url;
      img.style.opacity = '1';
      img.onload = function () { /* garde l'URL active pour la session */ };
      /* Note : on ne révoque pas l'URL immédiatement car l'img la référence.
         Cleanup au prochain render (GC navigateur fera le reste). */
    }).catch(function () {});
  } catch (e) { /* silencieux */ }
}

function _docLibRenderPagination(page, maxPage, total) {
  try {
    var pag = document.getElementById('documentsPagination');
    if (!pag) return;
    if (maxPage <= 0) { pag.style.display = 'none'; return; }
    pag.style.display = 'flex';
    _docLibText('documentsPageInfo',
      'Page ' + (page + 1) + ' / ' + (maxPage + 1) + ' — ' + total + ' doc(s)');
    var prev = document.getElementById('documentsPrevBtn');
    if (prev) prev.disabled = (page <= 0);
    var next = document.getElementById('documentsNextBtn');
    if (next) next.disabled = (page >= maxPage);
  } catch (e) {}
}

/* ═══════════ SECTION 8 — UPLOAD (modale) ═══════════ */

function openDocumentUploadModal() {
  try {
    var modal = document.getElementById('documentUploadModal');
    if (!modal) return;
    _docLibSet('documentUploadFile', '');
    _docLibSet('documentUploadNom', '');
    _docLibSet('documentUploadTags', '');
    _docLibSet('documentUploadNotes', '');
    _docLibSet('documentUploadDate', todayISO());
    _docLibPopulateCategorySelect('documentUploadCategorie', 'facture');
    _docLibText('documentUploadError', '');
    modal.style.display = 'flex';
  } catch (e) { console.warn('openDocumentUploadModal :', e); }
}

function closeDocumentUploadModal() {
  try {
    var m = document.getElementById('documentUploadModal');
    if (m) m.style.display = 'none';
  } catch (e) {}
}

function _docLibHandleUploadForm() {
  try {
    var errEl = document.getElementById('documentUploadError');
    if (errEl) errEl.textContent = '';

    var fileInput = document.getElementById('documentUploadFile');
    if (!fileInput || !fileInput.files || !fileInput.files[0]) {
      if (errEl) errEl.textContent = 'Sélectionne un fichier.';
      return;
    }
    var file = fileInput.files[0];

    var cat = _docLibGet('documentUploadCategorie') || 'autre';
    var nom = _docLibGet('documentUploadNom') || file.name || 'Sans nom';
    var date = _docLibGet('documentUploadDate') || todayISO();
    var tagsRaw = _docLibGet('documentUploadTags');
    var tags = tagsRaw ? tagsRaw.split(',').map(function (t) { return t.trim(); }).filter(function (t) { return t; }) : [];
    var notes = _docLibGet('documentUploadNotes');

    _docLibCreateEntry(file, {
      nom: nom,
      categorie: cat,
      date: date,
      tags: tags,
      notes: notes
    }).then(function (entry) {
      closeDocumentUploadModal();
      renderDocuments();
      if (typeof showToast === 'function') {
        showToast('Document ajouté : ' + entry.nom, 'success', 2500);
      }
    }).catch(function (err) {
      if (errEl) errEl.textContent = 'Erreur : ' + (err.message || 'inconnue');
    });
  } catch (e) {
    console.warn('_docLibHandleUploadForm :', e);
  }
}

/* ═══════════ SECTION 9 — DÉTAIL (modale) ═══════════ */

function openDocumentDetail(id) {
  try {
    var doc = getDocLibById(id);
    if (!doc) { if (typeof showToast === 'function') showToast('Document introuvable.', 'error'); return; }

    var modal = document.getElementById('documentDetailModal');
    var body = document.getElementById('documentDetailBody');
    var title = document.getElementById('documentDetailTitle');
    if (!modal || !body) return;

    if (title) title.textContent = doc.nom || 'Document';

    var cat = _docLibGetCategorieInfo(doc.categorie);
    var isImg = _docLibIsImage(doc.mime);
    var isPdf = _docLibIsPdf(doc.mime);

    var html = '';
    html += '<div id="docDetailPreviewWrap" class="doc-detail-preview">';
    html += '<div class="muted" style="padding:40px">Chargement…</div>';
    html += '</div>';

    html += '<div class="detail-section"><h3>Informations</h3><div class="detail-grid">';
    html += '<div class="detail-item"><div class="detail-label">Nom</div><div class="detail-value">' + escapeHtml(doc.nom) + '</div></div>';
    html += '<div class="detail-item"><div class="detail-label">Catégorie</div><div class="detail-value">' + escapeHtml(cat.icon + ' ' + cat.label) + '</div></div>';
    html += '<div class="detail-item"><div class="detail-label">Taille</div><div class="detail-value">' + _docLibFormatSize(doc.taille) + '</div></div>';
    html += '<div class="detail-item"><div class="detail-label">Date</div><div class="detail-value">' + (doc.date ? formatDate(doc.date) : '—') + '</div></div>';
    if (Array.isArray(doc.tags) && doc.tags.length > 0) {
      html += '<div class="detail-item"><div class="detail-label">Tags</div><div class="detail-value">' + escapeHtml(doc.tags.join(', ')) + '</div></div>';
    }
    if (doc.notes) {
      html += '<div class="detail-item" style="grid-column:1/-1"><div class="detail-label">Notes</div><div class="detail-value">' + escapeHtml(doc.notes) + '</div></div>';
    }
    html += '</div></div>';

    html += '<div class="detail-section detail-actions">';
    html += '<button type="button" class="btn" onclick="handleShareDocLib(\'' + escapeAttr(doc.id) + '\')">📤 Partager</button> ';
    html += '<button type="button" class="btn" onclick="downloadDocLib(\'' + escapeAttr(doc.id) + '\')">⬇️ Télécharger</button> ';
    html += '<button type="button" class="btn" onclick="openDocLibInTab(\'' + escapeAttr(doc.id) + '\')">🔗 Ouvrir dans un onglet</button> ';
    html += '<button type="button" class="btn" onclick="renameDocLib(\'' + escapeAttr(doc.id) + '\')">✏️ Renommer</button> ';
    html += '<button type="button" class="btn btn-danger" onclick="if(confirm(\'Supprimer ?\')){deleteDocLibEntry(\'' + escapeAttr(doc.id) + '\');closeDocumentDetail();}">🗑️ Supprimer</button>';
    html += '</div>';

    body.innerHTML = html;
    modal.style.display = 'flex';

    /* Charge l'aperçu */
    _idbBlobsGet(doc.storageKey).then(function (row) {
      var wrap = document.getElementById('docDetailPreviewWrap');
      if (!wrap) return;
      if (!row || !row.data) {
        wrap.innerHTML = '<div class="muted" style="padding:40px">Fichier introuvable</div>';
        return;
      }
      if (isImg) {
        var url = URL.createObjectURL(row.data);
        wrap.innerHTML = '<img src="' + url + '" alt="Aperçu">';
      } else if (isPdf) {
        var url2 = URL.createObjectURL(row.data);
        wrap.innerHTML = '<iframe src="' + url2 + '" title="Aperçu PDF"></iframe>';
      } else {
        wrap.innerHTML = '<div class="muted" style="padding:40px">Aperçu non disponible pour ce type</div>';
      }
    }).catch(function () {
      var wrap2 = document.getElementById('docDetailPreviewWrap');
      if (wrap2) wrap2.innerHTML = '<div class="muted" style="padding:40px">Erreur de chargement</div>';
    });
  } catch (e) { console.warn('openDocumentDetail :', e); }
}

function closeDocumentDetail() {
  try {
    var m = document.getElementById('documentDetailModal');
    if (m) m.style.display = 'none';
  } catch (e) {}
}

/* ═══════════ SECTION 10 — ACTIONS DOCUMENT ═══════════ */

function downloadDocLib(id) {
  try {
    var doc = getDocLibById(id);
    if (!doc) return;
    _idbBlobsGet(doc.storageKey).then(function (row) {
      if (!row || !row.data) {
        if (typeof showToast === 'function') showToast('Fichier introuvable.', 'error');
        return;
      }
      var ext = '';
      if (_docLibIsPdf(doc.mime)) ext = '.pdf';
      else if (doc.mime === 'image/png') ext = '.png';
      else if (doc.mime === 'image/webp') ext = '.webp';
      else ext = '.jpg';
      var filename = doc.nom.replace(/[\\/:*?"<>|]/g, '_').slice(0, 100) + (doc.nom.toLowerCase().endsWith(ext) ? '' : ext);

      var url = URL.createObjectURL(row.data);
      var a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () {
        try { document.body.removeChild(a); } catch (e) {}
        try { URL.revokeObjectURL(url); } catch (e) {}
      }, 500);
    }).catch(function (e) {
      console.warn('downloadDocLib :', e);
      if (typeof showToast === 'function') showToast('Erreur de téléchargement.', 'error');
    });
  } catch (e) { console.warn('downloadDocLib :', e); }
}

function openDocLibInTab(id) {
  try {
    var doc = getDocLibById(id);
    if (!doc) return;
    _idbBlobsGet(doc.storageKey).then(function (row) {
      if (!row || !row.data) {
        if (typeof showToast === 'function') showToast('Fichier introuvable.', 'error');
        return;
      }
      var url = URL.createObjectURL(row.data);
      window.open(url, '_blank');
    }).catch(function () {});
  } catch (e) { console.warn('openDocLibInTab :', e); }
}

function renameDocLib(id) {
  try {
    var doc = getDocLibById(id);
    if (!doc) return;
    var nouveau = (typeof promptDialog === 'function')
      ? promptDialog('Nouveau nom :', doc.nom)
      : window.prompt('Nouveau nom :', doc.nom);
    if (nouveau === null) return;
    var trimmed = String(nouveau).trim();
    if (!trimmed) return;
    if (updateDocLibMeta(id, { nom: trimmed })) {
      renderDocuments();
      if (typeof showToast === 'function') showToast('Document renommé.', 'success', 2000);
      /* Re-ouvre le détail si ouvert */
      var detailModal = document.getElementById('documentDetailModal');
      if (detailModal && detailModal.style.display === 'flex') openDocumentDetail(id);
    }
  } catch (e) { console.warn('renameDocLib :', e); }
}

/* ═══════════ SECTION 11 — EXPORT / IMPORT ═══════════ */

function exportDocumentsJSON() {
  try {
    var data = {
      version: 1,
      exportedAt: new Date().toISOString(),
      count: __documentsLib.length,
      documents: __documentsLib,
      categories: __documentsCategories
    };
    var json = JSON.stringify(data, null, 2);
    var blob = new Blob([json], { type: 'application/json' });
    var filename = 'voltcore-documents-meta-' + todayISO() + '.json';
    if (typeof downloadBlob === 'function') downloadBlob(blob, filename);
    if (typeof showToast === 'function') {
      showToast(__documentsLib.length + ' document(s) (métadonnées) exporté(s)', 'success', 3000);
    }
    if (typeof logAction === 'function') {
      try { logAction('doclib.export.meta', __documentsLib.length + ' docs'); } catch (e) {}
    }
  } catch (e) { console.warn('exportDocumentsJSON :', e); }
}

function importDocumentsJSON(file, options) {
  return new Promise(function (resolve, reject) {
    try {
      if (!file) return reject(new Error('Fichier requis'));
      var reader = new FileReader();
      reader.onload = function (ev) {
        try {
          var parsed = JSON.parse(ev.target.result);
          if (!parsed || typeof parsed !== 'object') throw new Error('JSON invalide');
          var arr = Array.isArray(parsed.documents) ? parsed.documents : (Array.isArray(parsed) ? parsed : null);
          if (!arr) throw new Error('Format invalide : documents[] attendu');

          var added = 0, skipped = 0, invalid = 0;
          for (var i = 0; i < arr.length; i++) {
            var d = arr[i];
            if (!d || !d.id || !d.nom || !d.storageKey) { invalid++; continue; }
            if (getDocLibById(d.id)) { skipped++; continue; }
            __documentsLib.push(d);
            added++;
          }
          /* Fusion catégories */
          if (Array.isArray(parsed.categories)) {
            for (var j = 0; j < parsed.categories.length; j++) {
              var c = parsed.categories[j];
              if (!c || !c.id) continue;
              var exists = false;
              for (var k = 0; k < __documentsCategories.length; k++) {
                if (__documentsCategories[k].id === c.id) { exists = true; break; }
              }
              if (!exists) __documentsCategories.push(c);
            }
          }

          _docLibSave();
          if (typeof logAction === 'function') {
            try { logAction('doclib.import', added + ' ajoutés'); } catch (e) {}
          }
          renderDocuments();
          _docLibPopulateFilterCategorySelect();
          if (typeof showToast === 'function') {
            var msg = added + ' doc(s) importé(s) (métadonnées)';
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

/* ═══════════ SECTION 12 — ÉVÉNEMENTS ═══════════ */

function attachDocumentsEvents() {
  try {
    /* Bouton nouveau document */
    var addBtn = document.getElementById('btnAddDocument');
    if (addBtn && !addBtn.__bound) {
      addBtn.__bound = true;
      addBtn.addEventListener('click', function (ev) {
        try { ev.preventDefault(); } catch (e) {}
        openDocumentUploadModal();
      });
    }

    /* Recherche debounced */
    var searchInput = document.getElementById('documentsSearchInput');
    if (searchInput && !searchInput.__bound) {
      searchInput.__bound = true;
      var debounced = (typeof debounce === 'function')
        ? debounce(function (ev) { setDocumentsSearch(ev.target.value); }, 250)
        : function (ev) { setDocumentsSearch(ev.target.value); };
      searchInput.addEventListener('input', debounced);
    }

    /* Filtre catégorie */
    var filterCat = document.getElementById('documentsFilterCat');
    if (filterCat && !filterCat.__bound) {
      filterCat.__bound = true;
      filterCat.addEventListener('change', function (ev) {
        setDocumentsFilterCat(ev.target.value);
      });
    }

    /* Filtre linked */
    var filterLinked = document.getElementById('documentsFilterLinked');
    if (filterLinked && !filterLinked.__bound) {
      filterLinked.__bound = true;
      filterLinked.addEventListener('change', function (ev) {
        setDocumentsFilterLinked(ev.target.value);
      });
    }

    /* Pagination */
    var prevBtn = document.getElementById('documentsPrevBtn');
    if (prevBtn && !prevBtn.__bound) {
      prevBtn.__bound = true;
      prevBtn.addEventListener('click', function () {
        setDocumentsPage(__documentsPage - 1);
      });
    }
    var nextBtn = document.getElementById('documentsNextBtn');
    if (nextBtn && !nextBtn.__bound) {
      nextBtn.__bound = true;
      nextBtn.addEventListener('click', function () {
        setDocumentsPage(__documentsPage + 1);
      });
    }

    /* Upload form */
    var uploadSaveBtn = document.getElementById('documentUploadSaveBtn');
    if (uploadSaveBtn && !uploadSaveBtn.__bound) {
      uploadSaveBtn.__bound = true;
      uploadSaveBtn.addEventListener('click', _docLibHandleUploadForm);
    }

    /* Auto-remplissage du nom depuis le fichier sélectionné */
    var fileInput = document.getElementById('documentUploadFile');
    if (fileInput && !fileInput.__bound) {
      fileInput.__bound = true;
      fileInput.addEventListener('change', function (ev) {
        var f = ev.target.files && ev.target.files[0];
        if (!f) return;
        var nomInput = document.getElementById('documentUploadNom');
        if (nomInput && !nomInput.value) {
          nomInput.value = f.name.replace(/\.[^.]+$/, '');
        }
      });
    }

    /* Export */
    var expBtn = document.getElementById('btnExportDocumentsJSON');
    if (expBtn && !expBtn.__bound) {
      expBtn.__bound = true;
      expBtn.addEventListener('click', exportDocumentsJSON);
    }

    /* Import */
    var impBtn = document.getElementById('btnImportDocuments');
    if (impBtn && !impBtn.__bound) {
      impBtn.__bound = true;
      impBtn.addEventListener('click', function () {
        var input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json,application/json';
        input.onchange = function (ev) {
          var f = ev.target.files && ev.target.files[0];
          if (!f) return;
          importDocumentsJSON(f).catch(function (err) {
            if (typeof showToast === 'function') {
              showToast('Import échoué : ' + (err.message || ''), 'error', 4000);
            }
          });
        };
        input.click();
      });
    }

    /* v6.9.9 — Bandeau dossier local */
    var chooseBtn = document.getElementById('btnChooseDocumentsFolder');
    if (chooseBtn && !chooseBtn.__bound) {
      chooseBtn.__bound = true;
      chooseBtn.addEventListener('click', function (ev) {
        try { ev.preventDefault(); } catch (e) {}
        chooseDocumentsFolder();
      });
    }
    var syncBtn = document.getElementById('btnSyncDocumentsFolder');
    if (syncBtn && !syncBtn.__bound) {
      syncBtn.__bound = true;
      syncBtn.addEventListener('click', function (ev) {
        try { ev.preventDefault(); } catch (e) {}
        syncDocumentsFromFolder();
      });
    }
    var forgetBtn = document.getElementById('btnForgetDocumentsFolder');
    if (forgetBtn && !forgetBtn.__bound) {
      forgetBtn.__bound = true;
      forgetBtn.addEventListener('click', function (ev) {
        try { ev.preventDefault(); } catch (e) {}
        forgetDocumentsFolder();
      });
    }

    /* Chargement initial */
    _docLibLoad();
    _docLibPopulateFilterCategorySelect();
    renderDocuments();
    /* v6.9.9 — Charge le handle dossier (silencieux, sans permission) */
    _docLibInitFsHandle();
    _docLibRenderFsBanner();
  } catch (e) {
    console.warn('attachDocumentsEvents :', e);
  }
}

/* Expose globalement (pour onclick inline) */
try {
  if (typeof window !== 'undefined') {
    window.openDocumentDetail = openDocumentDetail;
    window.closeDocumentDetail = closeDocumentDetail;
    window.openDocumentUploadModal = openDocumentUploadModal;
    window.closeDocumentUploadModal = closeDocumentUploadModal;
    window.downloadDocLib = downloadDocLib;
    window.openDocLibInTab = openDocLibInTab;
    window.renameDocLib = renameDocLib;
    window.deleteDocLibEntry = deleteDocLibEntry;
    window.renderDocuments = renderDocuments;
    window.attachDocumentsEvents = attachDocumentsEvents;
    window.shareDocLib = shareDocLib;
    window.handleShareDocLib = handleShareDocLib;
  }
} catch (e) {}
/* ═══════════ v6.9.9 — DOSSIER LOCAL + COPIE MIROIR ═══════════ */

var __documentsFsHandle = null;

/* Affiche/masque le bandeau dossier selon support + état */
function _docLibRenderFsBanner() {
  try {
    var banner = document.getElementById('documentsFsBanner');
    if (!banner) return;
    if (typeof isFileSystemSupported !== 'function' || !isFileSystemSupported()) {
      banner.style.display = 'none';
      return;
    }
    banner.style.display = 'flex';

    var nameEl = document.getElementById('documentsFsName');
    var chooseBtn = document.getElementById('btnChooseDocumentsFolder');
    var syncBtn = document.getElementById('btnSyncDocumentsFolder');
    var forgetBtn = document.getElementById('btnForgetDocumentsFolder');

    if (__documentsFsHandle) {
      if (nameEl) nameEl.textContent = __documentsFsHandle.name || '(dossier)';
      if (chooseBtn) chooseBtn.textContent = '🔄 Changer';
      if (syncBtn) syncBtn.style.display = '';
      if (forgetBtn) forgetBtn.style.display = '';
    } else {
      if (nameEl) nameEl.textContent = 'Aucun dossier sélectionné (les documents vont uniquement en IndexedDB)';
      if (chooseBtn) chooseBtn.textContent = '📂 Choisir un dossier';
      if (syncBtn) syncBtn.style.display = 'none';
      if (forgetBtn) forgetBtn.style.display = 'none';
    }
  } catch (e) { console.warn('_docLibRenderFsBanner :', e); }
}

/* Charge le handle au boot (sans demander permission). */
function _docLibInitFsHandle() {
  try {
    if (typeof _fsGetHandle !== 'function') return;
    _fsGetHandle().then(function (h) {
      if (h) {
        __documentsFsHandle = h;
        _docLibRenderFsBanner();
      }
    }).catch(function () {});
  } catch (e) {}
}

/* Choisir un nouveau dossier (demande permission + sauvegarde handle). */
function chooseDocumentsFolder() {
  try {
    if (typeof window.showDirectoryPicker !== 'function') {
      if (typeof showToast === 'function') showToast('Non supporté sur ce navigateur.', 'warning');
      return;
    }
    window.showDirectoryPicker({ mode: 'readwrite' }).then(function (handle) {
      return _fsVerifyPermission(handle, true).then(function (ok) {
        if (!ok) throw new Error('Permission refusée');
        return _fsSaveHandle(handle).then(function () {
          __documentsFsHandle = handle;
          _docLibRenderFsBanner();
          if (typeof showToast === 'function') {
            showToast('Dossier configuré : ' + (handle.name || ''), 'success', 3000);
          }
        });
      });
    }).catch(function (err) {
      if (err && err.name === 'AbortError') return; /* user cancel */
      console.warn('chooseDocumentsFolder :', err);
      if (typeof showToast === 'function') showToast('Erreur dossier : ' + (err.message || ''), 'error', 4000);
    });
  } catch (e) { console.warn('chooseDocumentsFolder :', e); }
}

function forgetDocumentsFolder() {
  try {
    var ok = (typeof confirmDialog === 'function')
      ? confirmDialog('Oublier le dossier local ?\n\nLes fichiers déjà écrits sur le disque restent intacts.')
      : window.confirm('Oublier le dossier local ?');
    if (!ok) return;
    _fsClearHandle().then(function () {
      __documentsFsHandle = null;
      _docLibRenderFsBanner();
      if (typeof showToast === 'function') showToast('Dossier oublié.', 'info', 2000);
    });
  } catch (e) { console.warn('forgetDocumentsFolder :', e); }
}

/* Copie miroir : écrit le blob dans le dossier local si configuré.
   Non-bloquant, ne rejette jamais (log un warning si échec). */
function _docLibMirrorToFolder(filename, blob) {
  try {
    if (!__documentsFsHandle || !blob) return;
    _fsVerifyPermission(__documentsFsHandle, false).then(function (ok) {
      if (!ok) {
        console.log('[Mirror] Permission dossier non accordée — copie miroir ignorée');
        return;
      }
      return _fsWriteFile(__documentsFsHandle, filename, blob).then(function (res) {
        console.log('[Mirror] Fichier copié dans le dossier : ' + res.relativePath);
      }).catch(function (e) {
        console.warn('[Mirror] Échec écriture :', e);
      });
    });
  } catch (e) { console.warn('_docLibMirrorToFolder :', e); }
}

/* Synchronise : scanne le dossier, importe les fichiers manquants.
   Détection doublon : (nom + taille) déjà présents → skip. */
function syncDocumentsFromFolder() {
  try {
    if (!__documentsFsHandle) {
      if (typeof showToast === 'function') showToast('Choisis d\'abord un dossier.', 'warning');
      return;
    }
    _fsVerifyPermission(__documentsFsHandle, true).then(function (ok) {
      if (!ok) {
        if (typeof showToast === 'function') showToast('Permission refusée.', 'error');
        return;
      }
      if (typeof showToast === 'function') showToast('Scan du dossier…', 'info', 2000);
      return _fsScanDir(__documentsFsHandle, 2).then(function (files) {
        if (!files || files.length === 0) {
          if (typeof showToast === 'function') showToast('Aucun fichier dans le dossier.', 'info');
          return;
        }

        /* Détection doublons par (nom + taille) */
        var seen = {};
        for (var i = 0; i < __documentsLib.length; i++) {
          var d = __documentsLib[i];
          if (!d) continue;
          var key = String(d.nom) + '|' + String(d.taille || 0);
          seen[key] = true;
        }

        var toImport = [];
        for (var j = 0; j < files.length; j++) {
          var f = files[j];
          var k2 = f.name + '|' + f.size;
          if (seen[k2]) continue;
          toImport.push(f);
        }

        if (toImport.length === 0) {
          if (typeof showToast === 'function') showToast('Aucun nouveau fichier à importer.', 'info');
          return;
        }

        /* Import séquentiel (évite saturation mémoire) */
        var added = 0, failed = 0, idx = 0;
        function next() {
          if (idx >= toImport.length) {
            renderDocuments();
            if (typeof showToast === 'function') {
              var msg = added + ' fichier(s) importé(s)';
              if (failed > 0) msg += ' · ' + failed + ' échec(s)';
              showToast(msg, added > 0 ? 'success' : 'warning', 4000);
            }
            if (typeof logAction === 'function') {
              try { logAction('doclib.sync-folder', added + ' importés'); } catch (e) {}
            }
            return;
          }
          var item = toImport[idx++];
          /* Devine la catégorie selon extension */
          var cat = 'autre';
          if (/\.pdf$/i.test(item.name)) cat = 'facture';
          else if (/photo|img/i.test(item.name)) cat = 'photo';
          _docLibCreateEntry(item.file, {
            nom: item.name.replace(/\.[^.]+$/, ''),
            categorie: cat,
            date: todayISO(),
            tags: ['import-folder'],
            notes: 'Importé depuis le dossier local'
          }).then(function () {
            added++;
            next();
          }).catch(function (e) {
            console.warn('[Sync] Échec import ' + item.name + ' :', e);
            failed++;
            next();
          });
        }
        next();
      });
    }).catch(function (e) {
      console.warn('syncDocumentsFromFolder :', e);
      if (typeof showToast === 'function') showToast('Erreur sync : ' + (e.message || ''), 'error', 4000);
    });
  } catch (e) { console.warn('syncDocumentsFromFolder :', e); }
}
/* ═══════════ v6.10.1 — PARTAGE NATIF (Share API) ═══════════
   Sur mobile (Android/iOS), utilise navigator.share pour envoyer
   le fichier vers Google Drive, WhatsApp, Gmail, etc.
   Sur desktop (Chrome/Edge), fallback download direct.
   Sur desktop sans Share API, fallback download aussi. */

function _docLibCanShare() {
  try {
    return typeof navigator !== 'undefined' &&
           typeof navigator.share === 'function' &&
           typeof navigator.canShare === 'function';
  } catch (e) { return false; }
}

/* Vérifie si le partage de fichier est supporté (pas juste du texte). */
function _docLibCanShareFiles() {
  try {
    if (!_docLibCanShare()) return false;
    /* Test avec un fichier bidon pour voir si files sont acceptés */
    var testFile = new File(['x'], 'test.txt', { type: 'text/plain' });
    return navigator.canShare({ files: [testFile] });
  } catch (e) {
    /* Si File constructor absent → non supporté */
    return false;
  }
}

/* Partage un document via Share API ou fallback download.
   - id : id du document dans __documentsLib
   - Retourne Promise<{ ok, method }> où method = 'share' | 'download' | 'cancelled' */
function shareDocLib(id) {
  return new Promise(function (resolve) {
    try {
      var doc = getDocLibById(id);
      if (!doc) return resolve({ ok: false, method: 'not-found' });

      _idbBlobsGet(doc.storageKey).then(function (row) {
        if (!row || !row.data) {
          return resolve({ ok: false, method: 'blob-missing' });
        }

        var ext = '';
        if (_docLibIsPdf(doc.mime)) ext = '.pdf';
        else if (doc.mime === 'image/png') ext = '.png';
        else if (doc.mime === 'image/webp') ext = '.webp';
        else ext = '.jpg';

        var filename = doc.nom.replace(/[\\/:*?"<>|]/g, '_').slice(0, 100);
        if (!/\.[a-z0-9]{2,4}$/i.test(filename)) filename += ext;

        /* Tentative Share API native (mobile) */
        if (_docLibCanShareFiles()) {
          try {
            var file = new File([row.data], filename, { type: doc.mime || row.mime });
            navigator.share({
              files: [file],
              title: doc.nom,
              text: 'Document VOLTCORE : ' + doc.nom
            }).then(function () {
              /* Succès : utilisateur a partagé */
              if (typeof logAction === 'function') {
                try { logAction('doclib.share', doc.nom + ' (share)'); } catch (e) {}
              }
              resolve({ ok: true, method: 'share' });
            }).catch(function (err) {
              if (err && err.name === 'AbortError') {
                /* L'utilisateur a annulé le share */
                return resolve({ ok: false, method: 'cancelled' });
              }
              console.warn('navigator.share échoué :', err);
              /* Fallback download */
              _docLibFallbackDownload(row.data, filename).then(function () {
                resolve({ ok: true, method: 'download' });
              });
            });
          } catch (e) {
            console.warn('_docLibCanShareFiles a retourné true mais File creation a échoué :', e);
            _docLibFallbackDownload(row.data, filename).then(function () {
              resolve({ ok: true, method: 'download' });
            });
          }
        } else {
          /* Pas de Share API → download direct */
          _docLibFallbackDownload(row.data, filename).then(function () {
            if (typeof logAction === 'function') {
              try { logAction('doclib.share', doc.nom + ' (download)'); } catch (e) {}
            }
            resolve({ ok: true, method: 'download' });
          });
        }
      }).catch(function (err) {
        console.warn('shareDocLib :', err);
        resolve({ ok: false, method: 'error' });
      });
    } catch (e) {
      console.warn('shareDocLib (sync) :', e);
      resolve({ ok: false, method: 'error' });
    }
  });
}

/* Fallback download via <a download> — utilisé par shareDocLib. */
function _docLibFallbackDownload(blob, filename) {
  return new Promise(function (resolve) {
    try {
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () {
        try { document.body.removeChild(a); } catch (e) {}
        try { URL.revokeObjectURL(url); } catch (e) {}
        resolve();
      }, 500);
    } catch (e) {
      console.warn('_docLibFallbackDownload :', e);
      resolve();
    }
  });
}

/* Handler UI du bouton "📤 Partager" (déclenché depuis carte ou détail). */
function handleShareDocLib(id) {
  shareDocLib(id).then(function (res) {
    if (!res.ok) {
      if (res.method === 'cancelled') return; /* pas de toast si annulé */
      if (typeof showToast === 'function') {
        showToast('Partage impossible (' + (res.method || 'erreur') + ').', 'warning', 3000);
      }
      return;
    }
    if (res.method === 'share') {
      if (typeof showToast === 'function') showToast('Document partagé.', 'success', 2000);
    } else if (res.method === 'download') {
      if (typeof showToast === 'function') showToast('Document téléchargé (partage natif indisponible).', 'info', 3000);
    }
  });
}

console.log('✅ 24-documents.js chargé — v6.10.1 (partage natif mobile + bibliothèque complète)');