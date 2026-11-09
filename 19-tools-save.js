/* ═══════════════════════════════════════════════════════════════
   VOLTCORE — 19-tools-save.js
   VERSION : v6.7 (Session #3 — merge refs réaffectées, UX import
                   backup sécurisée, version backup corrigée)
   RÔLE : Corbeille, historique, backup/restore (JSON + IndexedDB),
          doublons, aide (G), paramètres (RIB/logo/dark/reset)
   DÉPENDANCES : 01-core.js, 03-utils.js, 04-storage.js
   EXPOSE : renderTrash, restoreTrashItem, purgeOldTrash, emptyTrashAll,
            renderHistory, clearOldHistory,
            buildCompleteBackupData, exportCompleteBackup,
            importCompleteBackup,
            renderIDBBackups, restoreFromIDBBackup,
            findDuplicates, renderDuplicates, mergeDuplicates,
            mergeDuplicateClients, mergeDuplicateArticles, mergeDuplicateSuppliers,
            openHelpModal, closeHelpModal, renderHelp,
            loadSettings, saveSettings, saveLogoFromFile, removeLogo,
            toggleDarkMode, resetCompteurs,
            attachToolsEvents, initTools
   ═══════════════════════════════════════════════════════════════ */

/* ═══════════ SECTION 1 — CONSTANTES + ÉTAT ═══════════ */

var VOLTCORE_TRASH_MAX_DAYS = 30;
var VOLTCORE_HISTORY_MAX_ENTRIES = 500;

/* ═══════════ SECTION 2 — HELPERS ═══════════ */

function _toolsGet(id) {
  try { var el = document.getElementById(id); return el ? String(el.value || '').trim() : ''; } catch (e) { return ''; }
}
function _toolsSet(id, value) {
  try { var el = document.getElementById(id); if (el) el.value = value == null ? '' : value; } catch (e) {}
}
function _toolsText(id, text) {
  try { var el = document.getElementById(id); if (el) el.textContent = String(text || ''); } catch (e) {}
}

function _trashCount() {
  try {
    if (!trash || typeof trash !== 'object') return 0;
    var total = 0;
    var keys = Object.keys(trash);
    for (var i = 0; i < keys.length; i++) {
      if (Array.isArray(trash[keys[i]])) total += trash[keys[i]].length;
    }
    return total;
  } catch (e) { return 0; }
}

/* ═══════════ SECTION 3 — CORBEILLE ═══════════ */

function renderTrash() {
  try {
    var container = document.getElementById('trashList');
    if (!container) return;

    if (!trash || typeof trash !== 'object') {
      container.innerHTML = '<div class="empty-state">Corbeille vide.</div>';
      _toolsText('trashCount', '0');
      return;
    }

    var cats = [
      { key: 'clients', label: '👥 Clients' },
      { key: 'articles', label: '📦 Articles' },
      { key: 'suppliers', label: '🏭 Fournisseurs' },
      { key: 'documents', label: '🧾 Documents' },
      { key: 'chantiers', label: '🏗️ Chantiers' },
      { key: 'frais', label: '💰 Frais' },
      { key: 'purchases', label: '🛒 Achats' },
      { key: 'hrEmployees', label: '👤 Employés' },
      { key: 'hrWorkEntries', label: '📅 Journées' },
      { key: 'hrTransactions', label: '💵 Paiements' }
    ];

    var html = '';
    var totalShown = 0;
    for (var i = 0; i < cats.length; i++) {
      var cat = cats[i];
      var arr = Array.isArray(trash[cat.key]) ? trash[cat.key] : [];
      if (arr.length === 0) continue;
      totalShown += arr.length;
      html += '<div class="trash-category"><h4>' + escapeHtml(cat.label) +
        ' (' + arr.length + ')</h4>';
      for (var j = 0; j < arr.length; j++) {
        var entry = arr[j];
        if (!entry || !entry.item) continue;
        var item = entry.item;
        var label = _trashItemLabel(cat.key, item);
        var dateStr = entry.deletedAt ? formatDate(String(entry.deletedAt).slice(0, 10)) : '—';
        var daysOld = 0;
        if (entry.deletedAt) {
          try {
            daysOld = Math.floor((Date.now() - new Date(entry.deletedAt).getTime()) / 86400000);
          } catch (e) {}
        }
        var canRestore = !_trashItemExists(cat.key, item);
        html += '<div class="trash-row">' +
          '<div class="trash-row-main">' +
          '<div class="trash-row-label">' + escapeHtml(label) + '</div>' +
          '<div class="trash-row-meta">Supprimé le ' + escapeHtml(dateStr) +
          ' (' + daysOld + ' j)</div>' +
          '</div>' +
          '<div class="trash-row-actions">' +
          (canRestore
            ? '<button type="button" class="btn btn-sm" onclick="restoreTrashItem(\'' +
              escapeAttr(cat.key) + '\',' + j + ')">↩️ Restaurer</button>'
            : '<span class="badge badge-muted" title="Un élément identique existe déjà">⚠ Déjà présent</span>') +
          '</div></div>';
      }
      html += '</div>';
    }

    if (html === '') {
      container.innerHTML = '<div class="empty-state">Corbeille vide.</div>';
    } else {
      container.innerHTML = html;
    }
    _toolsText('trashCount', String(totalShown));
  } catch (e) { console.warn('renderTrash :', e); }
}

function _trashItemLabel(kind, item) {
  if (!item || typeof item !== 'object') return '(inconnu)';
  if (kind === 'clients' || kind === 'suppliers') return String(item.nom || '(sans nom)');
  if (kind === 'articles') return String(item.nom || item.designation || '(sans nom)');
  if (kind === 'documents' || kind === 'purchases') return String(item.numero || '(sans N°)');
  if (kind === 'chantiers') return String(item.nom || '(sans nom)');
  if (kind === 'frais') return (item.categorie || 'Frais') + ' — ' + formatMoney(item.montant);
  if (kind === 'hrEmployees') return String(item.nom || '(sans nom)');
  if (kind === 'hrWorkEntries') return String(item.date || '') + ' — ' + (item.hours || 0) + 'h';
  if (kind === 'hrTransactions') return String(item.type || '') + ' — ' + formatMoney(item.montant);
  return String(item.nom || item.numero || item.id || '');
}

function _trashItemExists(kind, item) {
  try {
    if (!item || !item.id) return false;
    var arr = [];
    if (kind === 'clients') arr = clients;
    else if (kind === 'articles') arr = savedArticles;
    else if (kind === 'suppliers') arr = suppliers;
    else if (kind === 'documents') arr = savedDocuments;
    else if (kind === 'chantiers') arr = savedChantiers;
    else if (kind === 'frais') arr = frais;
    else if (kind === 'purchases') arr = purchaseInvoices;
    else if (kind === 'hrEmployees') arr = hrEmployees;
    else if (kind === 'hrWorkEntries') arr = hrWorkEntries;
    else if (kind === 'hrTransactions') arr = hrTransactions;
    if (!Array.isArray(arr)) return false;
    for (var i = 0; i < arr.length; i++) {
      if (arr[i] && String(arr[i].id) === String(item.id)) return true;
    }
    return false;
  } catch (e) { return false; }
}

function restoreTrashItem(kind, index) {
  try {
    if (!trash || !Array.isArray(trash[kind])) return;
    if (index < 0 || index >= trash[kind].length) return;
    var entry = trash[kind][index];
    if (!entry || !entry.item) return;

    if (_trashItemExists(kind, entry.item)) {
      if (typeof showToast === 'function') showToast('Élément déjà présent (autre version).', 'warning');
      return;
    }

    if (kind === 'clients') clients.push(entry.item);
    else if (kind === 'articles') savedArticles.push(entry.item);
    else if (kind === 'suppliers') suppliers.push(entry.item);
    else if (kind === 'documents') savedDocuments.push(entry.item);
    else if (kind === 'chantiers') savedChantiers.push(entry.item);
    else if (kind === 'frais') frais.push(entry.item);
    else if (kind === 'purchases') purchaseInvoices.push(entry.item);
    else if (kind === 'hrEmployees') hrEmployees.push(entry.item);
    else if (kind === 'hrWorkEntries') hrWorkEntries.push(entry.item);
    else if (kind === 'hrTransactions') hrTransactions.push(entry.item);
    else return;

    trash[kind].splice(index, 1);
    if (typeof saveAll === 'function') saveAll();
    if (typeof logAction === 'function') logAction('trash.restore', kind);

    renderTrash();
    /* Refresh UI si les render sont définis */
    try {
      if (typeof renderClients === 'function') renderClients();
      if (typeof renderStock === 'function') renderStock();
      if (typeof renderSuppliers === 'function') renderSuppliers();
      if (typeof renderInvoices === 'function') renderInvoices();
      if (typeof renderChantiers === 'function') renderChantiers();
      if (typeof renderFrais === 'function') renderFrais();
      if (typeof renderPurchases === 'function') renderPurchases();
      if (typeof renderHR === 'function') renderHR();
    } catch (e) {}

    if (typeof showToast === 'function') showToast('Élément restauré', 'success', 2000);
  } catch (e) { console.warn('restoreTrashItem :', e); }
}

function purgeOldTrash() {
  try {
    if (!trash || typeof trash !== 'object') return 0;
    var cutoff = Date.now() - (VOLTCORE_TRASH_MAX_DAYS * 86400000);
    var purged = 0;
    var keys = Object.keys(trash);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (!Array.isArray(trash[k])) continue;
      var before = trash[k].length;
      trash[k] = trash[k].filter(function (entry) {
        if (!entry || !entry.deletedAt) return false;
        try { return new Date(entry.deletedAt).getTime() > cutoff; }
        catch (e) { return false; }
      });
      purged += before - trash[k].length;
    }
    if (purged > 0) {
      if (typeof saveAll === 'function') saveAll();
      if (typeof logAction === 'function') logAction('trash.purge', purged + ' éléments > ' + VOLTCORE_TRASH_MAX_DAYS + 'j');
    }
    renderTrash();
    return purged;
  } catch (e) { console.warn('purgeOldTrash :', e); return 0; }
}

function emptyTrashAll() {
  try {
    var count = _trashCount();
    if (count === 0) {
      if (typeof showToast === 'function') showToast('Corbeille déjà vide.', 'info');
      return;
    }
    var ok = (typeof confirmDialog === 'function')
      ? confirmDialog('Supprimer définitivement les ' + count + ' élément(s) de la corbeille ?')
      : window.confirm('Supprimer définitivement ' + count + ' élément(s) ?');
    if (!ok) return;

    trash = { clients: [], articles: [], documents: [] };
    if (typeof saveAll === 'function') saveAll();
    if (typeof logAction === 'function') logAction('trash.empty', count + ' supprimés définitivement');
    renderTrash();
    if (typeof showToast === 'function') showToast('Corbeille vidée (' + count + ' éléments)', 'success', 2500);
  } catch (e) { console.warn('emptyTrashAll :', e); }
}

/* ═══════════ SECTION 4 — HISTORIQUE ═══════════ */

function renderHistory() {
  try {
    var container = document.getElementById('historyList');
    if (!container) return;
    if (!Array.isArray(activityLog) || activityLog.length === 0) {
      container.innerHTML = '<div class="empty-state">Aucune activité enregistrée.</div>';
      return;
    }
    var limit = Math.min(100, activityLog.length);
    var html = '<table class="history-table"><thead><tr>' +
      '<th>Date</th><th>Utilisateur</th><th>Action</th><th>Détails</th>' +
      '</tr></thead><tbody>';
    for (var i = activityLog.length - 1; i >= 0 && (activityLog.length - i) <= limit; i--) {
      var e = activityLog[i];
      if (!e) continue;
      var dateStr = String(e.date || '').slice(0, 16).replace('T', ' ');
      html += '<tr>' +
        '<td>' + escapeHtml(dateStr) + '</td>' +
        '<td>' + escapeHtml(e.user || '—') + '</td>' +
        '<td><code>' + escapeHtml(e.action || '') + '</code></td>' +
        '<td>' + escapeHtml(e.details || '') + '</td>' +
        '</tr>';
    }
    html += '</tbody></table>';
    container.innerHTML = html;
  } catch (e) { console.warn('renderHistory :', e); }
}

function clearOldHistory(days) {
  try {
    if (!Array.isArray(activityLog)) return;
    var keepDays = parseInt(days, 10) || 90;
    var cutoff = Date.now() - (keepDays * 86400000);
    var before = activityLog.length;
    activityLog = activityLog.filter(function (e) {
      if (!e || !e.date) return false;
      try { return new Date(e.date).getTime() > cutoff; } catch (err) { return false; }
    });
    var removed = before - activityLog.length;
    if (removed > 0) {
      if (typeof saveAll === 'function') saveAll();
      if (typeof showToast === 'function') showToast(removed + ' anciennes entrées supprimées', 'success');
    } else {
      if (typeof showToast === 'function') showToast('Rien à supprimer.', 'info');
    }
    renderHistory();
  } catch (e) { console.warn('clearOldHistory :', e); }
}

/* ═══════════ SECTION 5 — BACKUP COMPLET ═══════════ */

function buildCompleteBackupData() {
  try {
    return {
      _voltcore_backup: true,
      /* v6.7 — version backup alignée sur la version app */
      _version: '6.7',
      _createdAt: new Date().toISOString(),
      clients: clients || [],
      articles: savedArticles || [],
      documents: savedDocuments || [],
      familles: familles || [],
      suppliers: suppliers || [],
      chantiers: savedChantiers || [],
      frais: frais || [],
      purchaseInvoices: purchaseInvoices || [],
      hrEmployees: hrEmployees || [],
      hrWorkEntries: hrWorkEntries || [],
      hrTransactions: hrTransactions || [],
      externalPrices: externalPrices || {},
      compteurs: compteurs || {},
      config: {
        rib: bankRib || '',
        banque: bankName || '',
        mf: bankMF || '',
        logo: (typeof getLogo === 'function') ? getLogo() : ''
      },
      trash: trash || { clients: [], articles: [], documents: [] },
      log: (Array.isArray(activityLog) ? activityLog.slice(-100) : [])
    };
  } catch (e) { console.warn('buildCompleteBackupData :', e); return null; }
}

function exportCompleteBackup() {
  try {
    var data = buildCompleteBackupData();
    if (!data) {
      if (typeof showToast === 'function') showToast('Erreur de construction du backup.', 'error');
      return;
    }
    var json = JSON.stringify(data, null, 2);
    var blob = new Blob([json], { type: 'application/json' });
    var filename = 'voltcore-backup-' + (typeof todayISO === 'function' ? todayISO() : Date.now()) + '.json';
    if (typeof downloadBlob === 'function') downloadBlob(blob, filename);
    if (typeof logAction === 'function') logAction('backup.export', filename);
    if (typeof showToast === 'function') showToast('Backup exporté : ' + filename, 'success', 3000);
  } catch (e) { console.warn('exportCompleteBackup :', e); }
}

function importCompleteBackup(file, options) {
  return new Promise(function (resolve, reject) {
    try {
      if (!file) return reject(new Error('Fichier requis'));
      var mode = (options && options.mode) || 'merge';

      var reader = new FileReader();
      reader.onload = function (ev) {
        try {
          var raw = ev.target.result;
          var parsed = JSON.parse(raw);
          if (!parsed || typeof parsed !== 'object') {
            return reject(new Error('JSON invalide'));
          }

          /* Validation : au moins une clé connue */
          var knownKeys = ['clients', 'articles', 'documents', 'suppliers',
                           'chantiers', 'frais', 'purchaseInvoices',
                           'hrEmployees', 'hrWorkEntries', 'hrTransactions'];
          var hasAtLeastOne = knownKeys.some(function (k) { return Array.isArray(parsed[k]); });
          if (!hasAtLeastOne) {
            return reject(new Error('Aucune donnée reconnue dans ce fichier'));
          }

          if (mode === 'replace') {
            var ok = (typeof confirmDialog === 'function')
              ? confirmDialog('⚠ Mode REMPLACER : TOUTES les données actuelles seront écrasées.\n\nContinuer ?')
              : window.confirm('Remplacer TOUTES les données ?');
            if (!ok) return reject(new Error('Annulé par l\'utilisateur'));
          }

          var stats = _applyImportData(parsed, mode);
          if (typeof saveAll === 'function') saveAll();
          if (typeof logAction === 'function') {
            logAction('backup.import', mode + ' : ' + stats.added + ' ajouts, ' + stats.skipped + ' doublons');
          }

          /* Refresh global */
          try {
            if (typeof refreshAllUI === 'function') refreshAllUI();
            else {
              if (typeof renderClients === 'function') renderClients();
              if (typeof renderStock === 'function') renderStock();
              if (typeof renderSuppliers === 'function') renderSuppliers();
              if (typeof renderInvoices === 'function') renderInvoices();
              if (typeof renderChantiers === 'function') renderChantiers();
              if (typeof renderFrais === 'function') renderFrais();
              if (typeof renderPurchases === 'function') renderPurchases();
              if (typeof renderHR === 'function') renderHR();
              if (typeof applyLogo === 'function') applyLogo();
            }
          } catch (e) {}

          if (typeof showToast === 'function') {
            var msg = 'Import réussi : ' + stats.added + ' ajout(s)';
            if (stats.skipped > 0) msg += ' · ' + stats.skipped + ' doublon(s)';
            showToast(msg, 'success', 4000);
          }
          resolve(stats);
        } catch (err) {
          reject(err);
        }
      };
      reader.onerror = function () { reject(reader.error || new Error('Lecture échouée')); };
      reader.readAsText(file);
    } catch (e) { reject(e); }
  });
}

function _applyImportData(data, mode) {
  var stats = { added: 0, skipped: 0 };
  try {
    if (mode === 'replace') {
      clients = []; savedArticles = []; savedDocuments = []; suppliers = [];
      savedChantiers = []; frais = []; purchaseInvoices = [];
      hrEmployees = []; hrWorkEntries = []; hrTransactions = [];
      familles = [];
    }

    if (Array.isArray(data.clients)) {
      for (var i = 0; i < data.clients.length; i++) {
        var c = data.clients[i];
        if (!c || !c.nom) { continue; }
        var exists = clients.some(function (x) {
          return x && String(x.id) === String(c.id);
        });
        if (exists) { stats.skipped++; continue; }
        if (mode === 'merge') {
          var dupName = clients.some(function (x) {
            return x && normalizeText(x.nom || '') === normalizeText(c.nom);
          });
          if (dupName) { stats.skipped++; continue; }
        }
        if (!c.id) c.id = 'cli_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
        clients.push(c); stats.added++;
      }
    }

    if (Array.isArray(data.articles)) {
      for (var j = 0; j < data.articles.length; j++) {
        var a = data.articles[j];
        if (!a || !a.nom) { continue; }
        var aExists = savedArticles.some(function (x) {
          return x && String(x.id) === String(a.id);
        });
        if (aExists) { stats.skipped++; continue; }
        if (mode === 'merge') {
          var aDup = savedArticles.some(function (x) {
            return x && normalizeText(x.nom || '') === normalizeText(a.nom);
          });
          if (aDup) { stats.skipped++; continue; }
        }
        if (!a.id) a.id = 'art_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
        savedArticles.push(a); stats.added++;
      }
    }

    if (Array.isArray(data.suppliers)) {
      for (var k = 0; k < data.suppliers.length; k++) {
        var s = data.suppliers[k];
        if (!s || !s.nom) continue;
        var sExists = suppliers.some(function (x) {
          return x && String(x.id) === String(s.id);
        });
        if (sExists) { stats.skipped++; continue; }
        if (mode === 'merge') {
          var sDup = suppliers.some(function (x) {
            return x && normalizeText(x.nom || '') === normalizeText(s.nom);
          });
          if (sDup) { stats.skipped++; continue; }
        }
        if (!s.id) s.id = 'sup_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
        suppliers.push(s); stats.added++;
      }
    }

    /* Documents + purchases + frais + chantiers + RH
       v6.8.1 — Détection de doublons renforcée.
       Avant : uniquement par ID → un backup sans IDs générait un nouvel
       ID aléatoire à chaque import → doublons massifs.
       Après : ID + clé naturelle (numero+date ou nom).
       Non couvert (par ID uniquement, pas de clé naturelle fiable) :
         frais, hrWorkEntries, hrTransactions.
       Signalement : un warning console est émis si le backup contient
       des items sans ID (signe d'un backup externe ou corrompu). */
    var additive = ['documents', 'purchaseInvoices', 'frais', 'chantiers', 'hrEmployees', 'hrWorkEntries', 'hrTransactions'];
    var targets = {
      documents: savedDocuments, purchaseInvoices: purchaseInvoices,
      frais: frais, chantiers: savedChantiers,
      hrEmployees: hrEmployees, hrWorkEntries: hrWorkEntries,
      hrTransactions: hrTransactions
    };
    var noIdWarnings = 0;
    for (var d = 0; d < additive.length; d++) {
      var key = additive[d];
      if (!Array.isArray(data[key])) continue;
      var target = targets[key];
      for (var e = 0; e < data[key].length; e++) {
        var item = data[key][e];
        if (!item) continue;
        /* v6.8.1 — warning si l'item n'a pas d'ID dans le backup */
        if (!item.id) {
          noIdWarnings++;
          item.id = 'x_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
        }
        /* Détection doublon ID (comme avant) */
        var exists2 = target.some(function (x) { return x && String(x.id) === String(item.id); });
        if (exists2) { stats.skipped++; continue; }
        /* v6.8.1 — Détection doublon par CONTENU (mode merge uniquement) */
        if (mode === 'merge') {
          var dupContent = false;
          if (key === 'documents' || key === 'purchaseInvoices') {
            /* Même numero + même date = doublon naturel */
            var num = String(item.numero || '').trim();
            var dt = String(item.date || item.dateFacture || '').slice(0, 10);
            if (num) {
              dupContent = target.some(function (x) {
                return x && String(x.numero || '').trim() === num &&
                  String(x.date || x.dateFacture || '').slice(0, 10) === dt;
              });
            }
          } else if (key === 'chantiers' || key === 'hrEmployees') {
            /* Même nom normalisé = doublon naturel */
            var nm = normalizeText(item.nom || '');
            if (nm) {
              dupContent = target.some(function (x) {
                return x && normalizeText(x.nom || '') === nm;
              });
            }
          }
          /* frais, hrWorkEntries, hrTransactions :
             pas de clé naturelle fiable → ID uniquement */
          if (dupContent) { stats.skipped++; continue; }
        }
        target.push(item); stats.added++;
      }
    }
    if (noIdWarnings > 0) {
      try {
        console.warn('[Import] ' + noIdWarnings +
          ' élément(s) du backup sans ID — IDs régénérés. ' +
          'La détection par contenu (numero/nom) limite les doublons.');
      } catch (e) {}
    }

    /* Config */
    if (data.config && typeof data.config === 'object') {
      if (data.config.rib) bankRib = String(data.config.rib);
      if (data.config.banque) bankName = String(data.config.banque);
      if (data.config.mf) bankMF = String(data.config.mf);
      try {
        if (data.config.rib) localStorage.setItem(STORAGE_KEYS.rib, data.config.rib);
        if (data.config.banque) localStorage.setItem(STORAGE_KEYS.banque, data.config.banque);
        if (data.config.mf) localStorage.setItem(STORAGE_KEYS.mf, data.config.mf);
        if (data.config.logo && typeof saveLogo === 'function') saveLogo(data.config.logo);
      } catch (e) {}
    }

    /* Compteurs */
    if (data.compteurs && typeof data.compteurs === 'object' && mode === 'replace') {
      compteurs = data.compteurs;
    }
  } catch (e) {
    console.warn('_applyImportData :', e);
  }
  return stats;
}

/* ═══════════ SECTION 6 — BACKUP INDEXEDDB ═══════════ */

async function renderIDBBackups() {
  try {
    var container = document.getElementById('idbBackupsList');
    if (!container) return;
    if (typeof _idbListBackups !== 'function') {
      container.innerHTML = '<div class="empty-state">IndexedDB non disponible.</div>';
      return;
    }
    container.innerHTML = '<div class="muted">Chargement…</div>';
    var list = await _idbListBackups();
    if (!list || list.length === 0) {
      container.innerHTML = '<div class="empty-state">Aucun backup automatique.</div>';
      return;
    }
    var html = '';
    for (var i = 0; i < list.length; i++) {
      var b = list[i];
      var dateStr = String(b.date || '').slice(0, 16).replace('T', ' ');
      var sizeStr = (typeof formatBytes === 'function') ? formatBytes(b.size || 0) : (b.size + ' o');
      html += '<div class="trash-row">' +
        '<div class="trash-row-main">' +
        '<div class="trash-row-label">' + escapeHtml(dateStr) + '</div>' +
        '<div class="trash-row-meta">' + escapeHtml(sizeStr) + '</div>' +
        '</div>' +
        '<div class="trash-row-actions">' +
        '<button type="button" class="btn btn-sm" onclick="restoreFromIDBBackup(' + b.id + ')">↩️ Restaurer</button>' +
        '</div></div>';
    }
    container.innerHTML = html;
  } catch (e) {
    console.warn('renderIDBBackups :', e);
    var cont = document.getElementById('idbBackupsList');
    if (cont) cont.innerHTML = '<div class="empty-state">Erreur de chargement.</div>';
  }
}

async function restoreFromIDBBackup(id) {
  try {
    if (typeof _idbRestoreBackup !== 'function') {
      if (typeof showToast === 'function') showToast('IndexedDB non disponible.', 'error');
      return;
    }
    var ok = (typeof confirmDialog === 'function')
      ? confirmDialog('Restaurer ce backup ? Les données actuelles seront remplacées.')
      : window.confirm('Restaurer ce backup ?');
    if (!ok) return;

    var payload = await _idbRestoreBackup(id);
    if (!payload || typeof payload !== 'object') {
      if (typeof showToast === 'function') showToast('Backup introuvable.', 'error');
      return;
    }

    /* payload est un snapshot de localStorage : { key: jsonString } */
    for (var storageKey in payload) {
      if (!payload.hasOwnProperty(storageKey)) continue;
      if (typeof payload[storageKey] !== 'string') continue;
      try { localStorage.setItem(storageKey, payload[storageKey]); } catch (e) {}
    }

    if (typeof loadAll === 'function') loadAll();
    if (typeof refreshAllUI === 'function') refreshAllUI();
    if (typeof logAction === 'function') logAction('idb.restore', 'id ' + id);
    if (typeof showToast === 'function') showToast('Backup IndexedDB restauré', 'success', 3000);
  } catch (e) {
    console.warn('restoreFromIDBBackup :', e);
    if (typeof showToast === 'function') showToast('Erreur de restauration.', 'error');
  }
}

/* ═══════════ SECTION 7 — DOUBLONS ═══════════ */

function findDuplicates() {
  var out = { clients: [], articles: [], suppliers: [] };
  try {
    out.clients = _groupByNormalizedName(clients);
    out.articles = _groupByNormalizedName(savedArticles);
    out.suppliers = _groupByNormalizedName(suppliers);
  } catch (e) { console.warn('findDuplicates :', e); }
  return out;
}

function _groupByNormalizedName(arr) {
  var groups = [];
  try {
    if (!Array.isArray(arr)) return groups;
    var byName = {};
    for (var i = 0; i < arr.length; i++) {
      var item = arr[i];
      if (!item || !item.nom) continue;
      var key = normalizeText(item.nom);
      if (!byName[key]) byName[key] = [];
      byName[key].push(item);
    }
    for (var k in byName) {
      if (byName.hasOwnProperty(k) && byName[k].length > 1) {
        groups.push(byName[k]);
      }
    }
  } catch (e) { console.warn('_groupByNormalizedName :', e); }
  return groups;
}

/* v6.7 — Compte les références qui seront réaffectées si on fusionne
   le groupe (kind = 'clients' | 'articles' | 'suppliers').
   Purement informatif : utilisé par le confirmDialog pour prévenir
   l'utilisateur. */
function _countRefsForMerge(kind, oldIds) {
  var count = 0;
  try {
    if (!Array.isArray(oldIds) || oldIds.length === 0) return 0;
    var ids = oldIds.map(String);
    function inIds(v) { return v && ids.indexOf(String(v)) >= 0; }

    if (kind === 'clients') {
      if (Array.isArray(savedDocuments)) {
        for (var i = 0; i < savedDocuments.length; i++) {
          if (savedDocuments[i] && inIds(savedDocuments[i].clientId)) count++;
        }
      }
      if (Array.isArray(savedChantiers)) {
        for (var j = 0; j < savedChantiers.length; j++) {
          if (savedChantiers[j] && inIds(savedChantiers[j].clientId)) count++;
        }
      }
      if (Array.isArray(frais)) {
        for (var k = 0; k < frais.length; k++) {
          if (frais[k] && inIds(frais[k].clientId)) count++;
        }
      }
    } else if (kind === 'articles') {
      if (Array.isArray(savedDocuments)) {
        for (var d = 0; d < savedDocuments.length; d++) {
          var doc = savedDocuments[d];
          if (!doc || !Array.isArray(doc.items)) continue;
          for (var ii = 0; ii < doc.items.length; ii++) {
            if (doc.items[ii] && inIds(doc.items[ii].articleId)) count++;
          }
        }
      }
      if (Array.isArray(purchaseInvoices)) {
        for (var p = 0; p < purchaseInvoices.length; p++) {
          var pur = purchaseInvoices[p];
          if (!pur || !Array.isArray(pur.lines)) continue;
          for (var li = 0; li < pur.lines.length; li++) {
            if (pur.lines[li] && inIds(pur.lines[li].articleId)) count++;
          }
        }
      }
    } else if (kind === 'suppliers') {
      if (Array.isArray(purchaseInvoices)) {
        for (var s = 0; s < purchaseInvoices.length; s++) {
          var pi = purchaseInvoices[s];
          if (!pi) continue;
          if (inIds(pi.supplierId) || inIds(pi.fournisseurId)) count++;
        }
      }
    }
  } catch (e) { console.warn('_countRefsForMerge :', e); }
  return count;
}

/* v6.7 — Réaffecte toutes les références d'anciens IDs vers newId
   avant suppression. Évite les orphelins après fusion de doublons. */
function _reassignRefsAfterMerge(kind, oldIds, newId) {
  try {
    if (!Array.isArray(oldIds) || oldIds.length === 0 || !newId) return 0;
    var ids = oldIds.map(String);
    var newIdStr = String(newId);
    var reassigned = 0;
    function inIds(v) { return v && ids.indexOf(String(v)) >= 0; }

    if (kind === 'clients') {
      if (Array.isArray(savedDocuments)) {
        for (var i = 0; i < savedDocuments.length; i++) {
          if (savedDocuments[i] && inIds(savedDocuments[i].clientId)) {
            savedDocuments[i].clientId = newIdStr;
            reassigned++;
          }
        }
      }
      if (Array.isArray(savedChantiers)) {
        for (var j = 0; j < savedChantiers.length; j++) {
          if (savedChantiers[j] && inIds(savedChantiers[j].clientId)) {
            savedChantiers[j].clientId = newIdStr;
            reassigned++;
          }
        }
      }
      if (Array.isArray(frais)) {
        for (var k = 0; k < frais.length; k++) {
          if (frais[k] && inIds(frais[k].clientId)) {
            frais[k].clientId = newIdStr;
            reassigned++;
          }
        }
      }
    } else if (kind === 'articles') {
      if (Array.isArray(savedDocuments)) {
        for (var d = 0; d < savedDocuments.length; d++) {
          var doc = savedDocuments[d];
          if (!doc || !Array.isArray(doc.items)) continue;
          for (var ii = 0; ii < doc.items.length; ii++) {
            if (doc.items[ii] && inIds(doc.items[ii].articleId)) {
              doc.items[ii].articleId = newIdStr;
              reassigned++;
            }
          }
        }
      }
      if (Array.isArray(purchaseInvoices)) {
        for (var p = 0; p < purchaseInvoices.length; p++) {
          var pur = purchaseInvoices[p];
          if (!pur || !Array.isArray(pur.lines)) continue;
          for (var li = 0; li < pur.lines.length; li++) {
            if (pur.lines[li] && inIds(pur.lines[li].articleId)) {
              pur.lines[li].articleId = newIdStr;
              reassigned++;
            }
          }
        }
      }
    } else if (kind === 'suppliers') {
      if (Array.isArray(purchaseInvoices)) {
        for (var s = 0; s < purchaseInvoices.length; s++) {
          var pi = purchaseInvoices[s];
          if (!pi) continue;
          if (inIds(pi.supplierId)) {
            pi.supplierId = newIdStr;
            reassigned++;
          }
          if (inIds(pi.fournisseurId)) {
            pi.fournisseurId = newIdStr;
            reassigned++;
          }
        }
      }
    }
    return reassigned;
  } catch (e) {
    console.warn('_reassignRefsAfterMerge :', e);
    return 0;
  }
}

/* v6.7 — Invalide les caches dépendants après un merge.
   Évite d'afficher des stats périmées (marges client, avoirs, achats fournisseur). */
function _invalidateCachesAfterMerge() {
  try {
    if (typeof window.invalidateClientStatsCache === 'function') {
      window.invalidateClientStatsCache();
    }
    if (typeof _invalidateSupplierInvoicesCache === 'function') {
      _invalidateSupplierInvoicesCache();
    }
    if (typeof _invalidateAvoirCache === 'function') {
      _invalidateAvoirCache();
    }
  } catch (e) { console.warn('_invalidateCachesAfterMerge :', e); }
}

function renderDuplicates() {
  try {
    var container = document.getElementById('duplicatesList');
    if (!container) return;
    var groups = findDuplicates();
    var total = groups.clients.length + groups.articles.length + groups.suppliers.length;

    if (total === 0) {
      container.innerHTML = '<div class="empty-state">Aucun doublon détecté. ✅</div>';
      return;
    }

    var html = '';
    html += _renderDupGroup('clients', groups.clients);
    html += _renderDupGroup('articles', groups.articles);
    html += _renderDupGroup('suppliers', groups.suppliers);
    container.innerHTML = html;
  } catch (e) { console.warn('renderDuplicates :', e); }
}

function _renderDupGroup(kind, groups) {
  if (!groups || groups.length === 0) return '';
  var label = kind === 'clients' ? '👥 Clients'
             : kind === 'articles' ? '📦 Articles'
             : '🏭 Fournisseurs';
  var html = '<div class="trash-category"><h4>' + label + ' (' + groups.length + ' doublon(s))</h4>';
  for (var i = 0; i < groups.length; i++) {
    var grp = groups[i];
    html += '<div class="trash-row">' +
      '<div class="trash-row-main">' +
      '<div class="trash-row-label">' + escapeHtml(grp[0].nom) + ' × ' + grp.length + '</div>' +
      '<div class="trash-row-meta">IDs : ' +
      grp.map(function (x) { return String(x.id).slice(-6); }).join(', ') + '</div>' +
      '</div>' +
      '<div class="trash-row-actions">' +
      '<button type="button" class="btn btn-sm" onclick="mergeDuplicates(\'' +
      escapeAttr(kind) + '\',' + i + ')">🔀 Fusionner</button>' +
      '</div></div>';
  }
  html += '</div>';
  return html;
}

/* v6.7 — Fusion avec réaffectation des références.
   Avant : on supprimait les doublons sans mettre à jour les références
   → factures/chantiers/achats perdaient le lien (orphelins).
   Après : on réaffecte AVANT de supprimer, puis on invalide les caches. */
function mergeDuplicates(kind, groupIndex) {
  try {
    var groups = findDuplicates();
    var grp = null;
    if (kind === 'clients' && groups.clients[groupIndex]) grp = groups.clients[groupIndex];
    else if (kind === 'articles' && groups.articles[groupIndex]) grp = groups.articles[groupIndex];
    else if (kind === 'suppliers' && groups.suppliers[groupIndex]) grp = groups.suppliers[groupIndex];
    if (!grp || grp.length < 2) return;

    var primary = grp[0];
    var toRemove = grp.slice(1);
    var oldIds = toRemove.map(function (x) { return String(x.id); });
    var refsCount = _countRefsForMerge(kind, oldIds);

    /* Message de confirmation enrichi (v6.7) */
    var msg = 'Fusionner ' + grp.length + ' entrées identiques ?\n\n';
    msg += '• La première ("' + String(primary.nom || '').slice(0, 40) + '") sera conservée\n';
    msg += '• Les ' + toRemove.length + ' autre(s) seront supprimées\n';
    if (refsCount > 0) {
      msg += '\n⚠️ ' + refsCount + ' référence(s) ' +
        (kind === 'clients' ? '(factures, chantiers, frais)' :
         kind === 'articles' ? '(lignes de facture, lignes d\'achat)' :
         '(factures d\'achat)') +
        ' seront réaffectées automatiquement.';
    }

    var ok = (typeof confirmDialog === 'function')
      ? confirmDialog(msg)
      : window.confirm(msg);
    if (!ok) return;

    /* 1. Remplit les trous du primary avec les données des autres */
    for (var i = 0; i < toRemove.length; i++) {
      var other = toRemove[i];
      if (!other) continue;
      var keys = Object.keys(other);
      for (var j = 0; j < keys.length; j++) {
        var k = keys[j];
        if (k === 'id' || k === 'createdAt') continue;
        if (!primary[k] || primary[k] === '' || primary[k] === 0) {
          primary[k] = other[k];
        }
      }
    }

    /* 2. v6.7 — RÉAFFECTATION DES RÉFÉRENCES avant suppression */
    var reassigned = _reassignRefsAfterMerge(kind, oldIds, String(primary.id));

    /* 3. Supprime les doublons de la collection */
    var target = kind === 'clients' ? clients : (kind === 'articles' ? savedArticles : suppliers);
    for (var m = 0; m < toRemove.length; m++) {
      var idx = target.indexOf(toRemove[m]);
      if (idx >= 0) target.splice(idx, 1);
    }

    /* 4. Persiste + invalide les caches */
    if (typeof saveAll === 'function') saveAll();
    _invalidateCachesAfterMerge();

    if (typeof logAction === 'function') {
      logAction('doublons.merge', kind + ' : ' + toRemove.length + ' fusionnés, ' +
        reassigned + ' référence(s) réaffectée(s)');
    }
    renderDuplicates();

    try {
      if (typeof renderClients === 'function') renderClients();
      if (typeof renderStock === 'function') renderStock();
      if (typeof renderSuppliers === 'function') renderSuppliers();
      if (typeof renderInvoices === 'function') renderInvoices();
      if (typeof renderPurchases === 'function') renderPurchases();
    } catch (e) {}

    if (typeof showToast === 'function') {
      var toastMsg = toRemove.length + ' doublon(s) fusionné(s)';
      if (reassigned > 0) toastMsg += ' · ' + reassigned + ' référence(s) réaffectée(s)';
      showToast(toastMsg, 'success', 3000);
    }
  } catch (e) { console.warn('mergeDuplicates :', e); }
}

/* Alias pour compat */
function mergeDuplicateClients(i) { mergeDuplicates('clients', i); }
function mergeDuplicateArticles(i) { mergeDuplicates('articles', i); }
function mergeDuplicateSuppliers(i) { mergeDuplicates('suppliers', i); }

/* ═══════════ SECTION 8 — AIDE (G) ═══════════ */

var HELP_ITEMS = [
  { q: 'Comment créer une facture ?', a: 'Facturation → "+ Nouvelle facture" → remplis le client, ajoute des lignes, vérifie les totaux, puis "Enregistrer".' },
  { q: 'Comment ajouter un client ?', a: 'Clients → "+ Nouveau client" → nom obligatoire, le reste optionnel. Un doublon par nom sera refusé.' },
  { q: 'Comment faire un avoir ?', a: 'Facturation → clique sur la facture → "Créer avoir". Les lignes sont pré-remplies, ajuste les quantités puis enregistre.' },
  { q: 'Comment importer depuis l\'IA ?', a: 'Assistant IA → copie le prompt du modèle voulu → colle dans ChatGPT/Claude/DeepSeek → colle la réponse JSON → Aperçu → Confirmer. Les fournisseurs sont matchés en STRICT (nom exact ou MF), pas de fuzzy.' },
  { q: 'Comment faire une sauvegarde ?', a: 'Outils → "Backup complet" → exporte un fichier JSON. Un backup automatique est aussi fait chaque jour dans IndexedDB (7 derniers).' },
  { q: 'Comment restaurer ?', a: 'Outils → "Importer backup" → choisis le JSON. Tape "FUSIONNER" pour ajouter sans toucher, ou "REMPLACER" pour tout écraser (dangereux).' },
  { q: 'Comment scanner un document ?', a: 'Outils → Scanner → autorise la caméra → capture → l\'image s\'attache à la facture ouverte, sinon se télécharge.' },
  { q: 'Comment signer une facture ?', a: 'Ouvre la facture → Outils → Signature → signe au doigt → "Attacher à la facture". La signature apparaît dans le PDF.' },
  { q: 'Comment créer un bon A/B/C/D ?', a: 'Outils → clique sur "Bon A" (ou B/C/D) → remplis les lignes → Imprimer. Le numéro est auto-incrémenté.' },
  { q: 'Comment fonctionne la corbeille ?', a: 'Toute suppression va dans Outils → Corbeille. Tu peux restaurer pendant 30 j. Après, purge automatique.' },
  { q: 'Comment imprimer en PDF ?', a: 'Sur la liste des factures, clique sur 🖨️. Le navigateur propose "Enregistrer en PDF" dans la boîte d\'impression.' },
  { q: 'Comment activer le mode sombre ?', a: 'Outils → Paramètres → bascule "Mode sombre". Le choix est conservé entre sessions.' },
  { q: 'Comment changer le logo ?', a: 'Outils → Paramètres → "Changer le logo" → choisis une image (<500 Ko après compression auto). Apparaît sur les PDF.' },
  { q: 'Comment calculer la TVA ?', a: 'TVA 19% par défaut. Retenue TVA 25% (optionnelle) et retenues IR/IS configurables par facture. La retenue garantie BTP (5%) se configure par facture aussi.' },
  { q: 'Comment fusionner des doublons ?', a: 'Outils → Doublons → Scanner → Fusionner. Les références (factures, chantiers, achats) sont réaffectées automatiquement vers l\'entrée conservée.' },
  { q: 'Comment activer la biométrie ?', a: 'Paramètres → "Activer l\'empreinte" (nécessite HTTPS). Sinon mot de passe classique. Auto-lock après 5 min d\'inactivité.' }
];

function openHelpModal() {
  try {
    var modal = document.getElementById('helpModal');
    if (!modal) return;
    renderHelp();
    modal.style.display = 'flex';
  } catch (e) { console.warn('openHelpModal :', e); }
}

function closeHelpModal() {
  try {
    var m = document.getElementById('helpModal');
    if (m) m.style.display = 'none';
  } catch (e) {}
}

function renderHelp() {
  try {
    var container = document.getElementById('helpBody');
    if (!container) return;
    var html = '';
    for (var i = 0; i < HELP_ITEMS.length; i++) {
      var item = HELP_ITEMS[i];
      html += '<details class="help-item">' +
        '<summary>' + escapeHtml(item.q) + '</summary>' +
        '<p>' + escapeHtml(item.a) + '</p>' +
        '</details>';
    }
    html += '<div class="help-footer">VOLTCORE v6.7 — Document d\'aide intégré</div>';
    container.innerHTML = html;
  } catch (e) { console.warn('renderHelp :', e); }
}

/* ═══════════ SECTION 9 — PARAMÈTRES ═══════════ */

function loadSettings() {
  try {
    _toolsSet('settingsRib', bankRib || '');
    _toolsSet('settingsBanque', bankName || '');
    _toolsSet('settingsMF', bankMF || '');
    /* v6.8.1 — RNE. N'agit que si le champ HTML settingsRNE existe. */
    if (typeof bankRNE !== 'undefined') {
      _toolsSet('settingsRNE', bankRNE || '');
    }
    var darkCb = document.getElementById('settingsDarkMode');
    if (darkCb) {
      darkCb.checked = localStorage.getItem('voltcore_dark') === '1';
    }
    var logoImg = document.getElementById('settingsLogoPreview');
    if (logoImg) {
      var logo = (typeof getLogo === 'function') ? getLogo() : '';
      if (logo) { logoImg.src = logo; logoImg.style.display = ''; }
      else { logoImg.removeAttribute('src'); logoImg.style.display = 'none'; }
    }
  } catch (e) { console.warn('loadSettings :', e); }
}

function saveSettings() {
  try {
    var rib = _toolsGet('settingsRib');
    var banque = _toolsGet('settingsBanque');
    var mf = _toolsGet('settingsMF');

    bankRib = rib;
    bankName = banque;
    bankMF = mf;

    try {
      localStorage.setItem(STORAGE_KEYS.rib, rib);
      localStorage.setItem(STORAGE_KEYS.banque, banque);
      localStorage.setItem(STORAGE_KEYS.mf, mf);
    } catch (e) {}

    /* v6.8.1 — RNE. Ne touche à bankRNE QUE si le champ HTML existe,
       pour ne pas écraser la valeur par défaut avec '' tant que le
       champ n'est pas ajouté dans index.html (Étape 2). */
    var rneEl = document.getElementById('settingsRNE');
    if (rneEl && typeof bankRNE !== 'undefined') {
      var rne = _toolsGet('settingsRNE');
      if (rne) {
        bankRNE = rne;
        try { localStorage.setItem(STORAGE_KEYS.rne, rne); } catch (e) {}
      }
    }

    if (typeof logAction === 'function') logAction('settings.save', 'RIB/Banque/MF/RNE');
    if (typeof showToast === 'function') showToast('Paramètres enregistrés', 'success', 2000);
  } catch (e) { console.warn('saveSettings :', e); }
}

async function saveLogoFromFile(file) {
  try {
    if (!file) return;
    if (typeof compressImageWithFeedback !== 'function') {
      if (typeof showToast === 'function') showToast('Compression indisponible.', 'error');
      return;
    }
    var dataUrl = await compressImageWithFeedback(file, 200 * 1024);
    if (typeof saveLogo === 'function') saveLogo(dataUrl);
    var logoImg = document.getElementById('settingsLogoPreview');
    if (logoImg) { logoImg.src = dataUrl; logoImg.style.display = ''; }
    if (typeof logAction === 'function') logAction('settings.logo', 'mis à jour');
    if (typeof showToast === 'function') showToast('Logo enregistré', 'success', 2000);
  } catch (e) {
    console.warn('saveLogoFromFile :', e);
    if (typeof showToast === 'function') showToast('Erreur de logo.', 'error');
  }
}

function removeLogo() {
  try {
    if (typeof saveLogo === 'function') saveLogo('');
    var logoImg = document.getElementById('settingsLogoPreview');
    if (logoImg) { logoImg.removeAttribute('src'); logoImg.style.display = 'none'; }
    if (typeof showToast === 'function') showToast('Logo supprimé', 'info', 2000);
  } catch (e) { console.warn('removeLogo :', e); }
}

function toggleDarkMode() {
  try {
    var cb = document.getElementById('settingsDarkMode');
    var on = cb ? cb.checked : !(localStorage.getItem('voltcore_dark') === '1');
    localStorage.setItem('voltcore_dark', on ? '1' : '0');
    document.body.classList.toggle('dark-mode', on);
    if (typeof showToast === 'function') showToast(on ? 'Mode sombre activé' : 'Mode clair activé', 'info', 1500);
  } catch (e) { console.warn('toggleDarkMode :', e); }
}

function resetCompteurs() {
  try {
    var typed = (typeof promptDialog === 'function')
      ? promptDialog('Tape "RESET" pour confirmer la remise à zéro des compteurs.\n(Les documents existants ne sont PAS supprimés, seulement la numérotation repart à 1.)')
      : window.prompt('Tape RESET pour confirmer');
    if (!typed || String(typed).toUpperCase() !== 'RESET') {
      if (typeof showToast === 'function') showToast('Annulé.', 'info', 1500);
      return;
    }
    compteurs = {};
    if (typeof saveCompteurs === 'function') saveCompteurs();
    if (typeof saveAll === 'function') saveAll();
    if (typeof logAction === 'function') logAction('settings.resetCompteurs', 'reset');
    if (typeof showToast === 'function') showToast('Compteurs remis à zéro', 'success', 2500);
  } catch (e) { console.warn('resetCompteurs :', e); }
}

/* ═══════════ SECTION 10 — ÉVÉNEMENTS ═══════════ */

function attachToolsEvents() {
  try {
    /* Corbeille */
    var btnPurge = document.getElementById('btnPurgeTrash');
    if (btnPurge && !btnPurge.__bound) {
      btnPurge.__bound = true;
      btnPurge.addEventListener('click', function () {
        var n = purgeOldTrash();
        if (typeof showToast === 'function') {
          showToast(n > 0 ? n + ' éléments purgés' : 'Rien à purger (> ' + VOLTCORE_TRASH_MAX_DAYS + 'j)', 'info');
        }
      });
    }
    var btnEmpty = document.getElementById('btnEmptyTrash');
    if (btnEmpty && !btnEmpty.__bound) {
      btnEmpty.__bound = true;
      btnEmpty.addEventListener('click', emptyTrashAll);
    }

    /* Historique */
    var btnHistoryClear = document.getElementById('btnClearOldHistory');
    if (btnHistoryClear && !btnHistoryClear.__bound) {
      btnHistoryClear.__bound = true;
      btnHistoryClear.addEventListener('click', function () {
        var inp = document.getElementById('historyDaysInput');
        var days = inp ? parseInt(inp.value, 10) : 90;
        clearOldHistory(days || 90);
      });
    }

    /* Backup JSON */
    var btnExportBackup = document.getElementById('btnExportCompleteBackup');
    if (btnExportBackup && !btnExportBackup.__bound) {
      btnExportBackup.__bound = true;
      btnExportBackup.addEventListener('click', exportCompleteBackup);
    }
    var btnImportBackup = document.getElementById('btnImportCompleteBackup');
    if (btnImportBackup && !btnImportBackup.__bound) {
      btnImportBackup.__bound = true;
      btnImportBackup.addEventListener('click', function () {
        var input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json,application/json';
        input.onchange = function (ev) {
          var f = ev.target.files && ev.target.files[0];
          if (!f) return;

          /* v6.7 — UX sécurisée : l'utilisateur doit taper FUSIONNER ou
             REMPLACER. Avant, "Annuler" du confirmDialog signifiait
             silencieusement "replace" → risque d'écrasement accidentel
             en cas de double-clic sur Annuler. */
          var choice = null;
          if (typeof promptDialog === 'function') {
            choice = promptDialog(
              'Comment importer ce backup ?\n\n' +
              '• Tape "FUSIONNER" pour ajouter sans toucher aux données existantes (recommandé)\n' +
              '• Tape "REMPLACER" pour TOUT écraser (DANGEREUX)\n' +
              '• Annule pour abandonner'
            );
          } else {
            choice = window.prompt('Tape FUSIONNER ou REMPLACER (Annuler = abandonner)');
          }
          if (choice === null) return; /* Annulé → rien */

          var mode = (String(choice).toUpperCase().trim() === 'REMPLACER') ? 'replace' : 'merge';

          importCompleteBackup(f, { mode: mode }).catch(function (err) {
            if (typeof showToast === 'function') {
              showToast('Import échoué : ' + (err.message || ''), 'error', 4000);
            }
          });
        };
        input.click();
      });
    }

    /* Backup IndexedDB */
    var btnRefreshIDB = document.getElementById('btnRefreshIDBBackups');
    if (btnRefreshIDB && !btnRefreshIDB.__bound) {
      btnRefreshIDB.__bound = true;
      btnRefreshIDB.addEventListener('click', renderIDBBackups);
    }

    /* Doublons */
    var btnScanDup = document.getElementById('btnScanDuplicates');
    if (btnScanDup && !btnScanDup.__bound) {
      btnScanDup.__bound = true;
      btnScanDup.addEventListener('click', renderDuplicates);
    }

    /* Aide (G) */
    var btnHelp = document.getElementById('btnOpenHelp');
    if (btnHelp && !btnHelp.__bound) {
      btnHelp.__bound = true;
      btnHelp.addEventListener('click', openHelpModal);
    }

    /* Paramètres */
    var btnSaveSettings = document.getElementById('btnSaveSettings');
    if (btnSaveSettings && !btnSaveSettings.__bound) {
      btnSaveSettings.__bound = true;
      btnSaveSettings.addEventListener('click', saveSettings);
    }
    var btnChangeLogo = document.getElementById('btnChangeLogo');
    if (btnChangeLogo && !btnChangeLogo.__bound) {
      btnChangeLogo.__bound = true;
      btnChangeLogo.addEventListener('click', function () {
        var input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.onchange = function (ev) {
          var f = ev.target.files && ev.target.files[0];
          if (f) saveLogoFromFile(f);
        };
        input.click();
      });
    }
    var btnRemoveLogo = document.getElementById('btnRemoveLogo');
    if (btnRemoveLogo && !btnRemoveLogo.__bound) {
      btnRemoveLogo.__bound = true;
      btnRemoveLogo.addEventListener('click', removeLogo);
    }
    var darkCb = document.getElementById('settingsDarkMode');
    if (darkCb && !darkCb.__bound) {
      darkCb.__bound = true;
      darkCb.addEventListener('change', toggleDarkMode);
    }
    var btnResetCompteurs = document.getElementById('btnResetCompteurs');
    if (btnResetCompteurs && !btnResetCompteurs.__bound) {
      btnResetCompteurs.__bound = true;
      btnResetCompteurs.addEventListener('click', resetCompteurs);
    }
  } catch (e) { console.warn('attachToolsEvents :', e); }
}

/* ═══════════ SECTION 11 — INIT ═══════════ */

function initTools() {
  try {
    loadSettings();
    renderTrash();
    renderHistory();
    /* Purge auto au démarrage */
    try { purgeOldTrash(); } catch (e) {}
    /* Dark mode depuis préférences */
    try {
      if (localStorage.getItem('voltcore_dark') === '1') {
        document.body.classList.add('dark-mode');
        var cb = document.getElementById('settingsDarkMode');
        if (cb) cb.checked = true;
      }
    } catch (e) {}
  } catch (e) { console.warn('initTools :', e); }
}

console.log('✅ 19-tools-save.js chargé — v6.7 (merge refs + UX import sécurisée)');