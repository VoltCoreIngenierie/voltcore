/* ═══════════════════════════════════════════════════════════
   VOLTCORE — 25-tools.js
   VERSION : v7.0.0
   RÔLE : Outils & Paramètres.
          Corbeille, historique, backups IDB, doublons,
          société (RIB/MF/RNE), signature/cachet par défaut,
          logo, dark mode, trusted device, reset compteurs,
          diagnostics.
   DÉPENDANCES : 00-core, 01-utils, 02-store, 03-idb, 05-auth
   ORDRE : 26ᵉ fichier chargé

   FIX v7.0.0 :
   - Corbeille OUVERTE via Store (plus de 3 clés hardcodées)
   - Signature/cachet stockés en IDB (pas localStorage)
   - Diagnostics via VC.Infra (26-infra.js)
   - Restauration IDB réécrit sur loadAll + migrate

   RÈGLES :
   - ES5 strict
   - Aucun catch silencieux
   - Ne JAMAIS lire/écrire localStorage directement (sauf trusted device/dark mode)
   ═══════════════════════════════════════════════════════════ */

'use strict';

(function (global) {

  if (!global.VOLTCORE || !global.VOLTCORE.Store ||
      !global.VOLTCORE.Utils || !global.VOLTCORE.IDB) {
    throw new Error('[25-tools] Modules requis non chargés');
  }

  var VC = global.VOLTCORE;
  var U = VC.Utils;
  var S = VC.Store;
  var IDB = VC.IDB;
  var T = VC.Tools || {};
  VC.Tools = T;

  /* ═══════════════════════════════════════════════════════════
     SECTION 1 — REGISTRATION STORE
     ═══════════════════════════════════════════════════════════ */

  S.register('config', {
    type: 'object',
    saveKey: 'voltcore_config',
    default: {
      rib: '07 054 0112101102584 69',
      banque: 'AMEN BANK',
      mf: '1977463P / A / M / 000',
      rne: '1977463P',
      logo: ''
    },
    backup: true
  });

  S.register('history', {
    type: 'array',
    saveKey: 'voltcore_log',
    default: [],
    backup: true
  });

  /* ═══════════════════════════════════════════════════════════
     SECTION 2 — ÉTAT INTERNE
     ═══════════════════════════════════════════════════════════ */

  var _settingsLoaded = false;

  /* ═══════════════════════════════════════════════════════════
     SECTION 3 — CONFIG SOCIÉTÉ
     ═══════════════════════════════════════════════════════════ */

  T.getCompany = function () {
    return S.getObject('config');
  };

  T.loadSettings = function () {
    var c = T.getCompany();

    U.setVal('settingsRib', c.rib || '');
    U.setVal('settingsBanque', c.banque || '');
    U.setVal('settingsMF', c.mf || '');
    U.setVal('settingsRNE', c.rne || '');

    var darkCb = document.getElementById('settingsDarkMode');
    if (darkCb) {
      try {
        darkCb.checked = localStorage.getItem('voltcore_dark') === '1';
      } catch (e) {
        VC.logError('25-tools', 'lecture dark mode échouée', e);
      }
    }

    var trustedCb = document.getElementById('settingsTrustedDevice');
    if (trustedCb && VC.Auth) {
      trustedCb.checked = VC.Auth._isTrustedDevice();
    }

    var logoImg = document.getElementById('settingsLogoPreview');
    if (logoImg) {
      if (c.logo) {
        logoImg.src = c.logo;
        logoImg.style.display = '';
      } else {
        logoImg.removeAttribute('src');
        logoImg.style.display = 'none';
      }
    }

    _renderSignaturePreview();
    _renderCachetPreview();

    _settingsLoaded = true;
  };

  T.saveSettings = function () {
    var c = T.getCompany();

    c.rib = U.getVal('settingsRib');
    c.banque = U.getVal('settingsBanque');
    c.mf = U.getVal('settingsMF');
    c.rne = U.getVal('settingsRNE');

    if (S.setObject('config', c)) {
      U.toast('Paramètres enregistrés', 'success', 2000);
    } else {
      U.toast('Erreur d\'enregistrement', 'error');
    }
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 4 — LOGO
     ═══════════════════════════════════════════════════════════ */

  T.changeLogo = function (file) {
    if (!file) return;

    U.compressImage(file, 200 * 1024).then(function (dataUrl) {
      var c = T.getCompany();
      c.logo = dataUrl;
      if (S.setObject('config', c)) {
        var logoImg = document.getElementById('settingsLogoPreview');
        if (logoImg) {
          logoImg.src = dataUrl;
          logoImg.style.display = '';
        }
        U.toast('Logo enregistré', 'success', 2000);
      }
    }).catch(function (e) {
      VC.logError('25-tools', 'changeLogo échoué', e);
      U.toast('Erreur de logo.', 'error');
    });
  };

  T.removeLogo = function () {
    var c = T.getCompany();
    c.logo = '';
    S.setObject('config', c);

    var logoImg = document.getElementById('settingsLogoPreview');
    if (logoImg) {
      logoImg.removeAttribute('src');
      logoImg.style.display = 'none';
    }
    U.toast('Logo supprimé', 'info', 2000);
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 5 — SIGNATURE / CACHET PAR DÉFAUT (IDB)
     ═══════════════════════════════════════════════════════════ */

  var SIG_REF = 'sig_default';
  var CACHET_REF = 'cachet_default';
  var SIG_META_KEY = 'voltcore_signature_default';
  var CACHET_META_KEY = 'voltcore_cachet_default';

  function _getSigMeta() {
    try {
      var raw = localStorage.getItem(SIG_META_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) {
      VC.logError('25-tools', 'getSigMeta échoué', e);
      return null;
    }
  }

  function _getCachetMeta() {
    try {
      var raw = localStorage.getItem(CACHET_META_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) {
      VC.logError('25-tools', 'getCachetMeta échoué', e);
      return null;
    }
  }

  T.getSignatureMeta = _getSigMeta;
  T.getCachetMeta = _getCachetMeta;

  T.uploadSignature = function (file) {
    if (!file) return;
    _uploadDefaultImage('sig', file, SIG_REF, SIG_META_KEY, '_renderSignaturePreview');
  };

  T.uploadCachet = function (file) {
    if (!file) return;
    _uploadDefaultImage('cachet', file, CACHET_REF, CACHET_META_KEY, '_renderCachetPreview');
  };

  function _uploadDefaultImage(kind, file, ref, metaKey, renderFn) {
    if (!/^image\//.test(file.type)) {
      U.toast('Format image requis (PNG, JPG).', 'error');
      return;
    }

    var doUpload = function (blob, name) {
      IDB.blobs.put(ref, blob, blob.type).then(function () {
        try {
          localStorage.setItem(metaKey, JSON.stringify({
            ref: ref,
            name: name,
            mime: blob.type,
            size: blob.size,
            uploadedAt: new Date().toISOString()
          }));
        } catch (e) {
          VC.logError('25-tools', 'setItem ' + metaKey + ' échoué', e);
        }

        if (typeof T[renderFn] === 'function') {
          T[renderFn]();
        }
        U.toast(kind === 'sig' ? 'Signature enregistrée' : 'Cachet enregistré',
          'success', 2000);
      }).catch(function (e) {
        VC.logError('25-tools', 'upload ' + kind + ' échoué', e);
        U.toast('Erreur d\'enregistrement.', 'error');
      });
    };

    if (file.size > VC.SIGNATURE_MAX_BYTES) {
      U.compressImage(file, VC.SIGNATURE_MAX_BYTES).then(function (dataUrl) {
        IDB.dataURLToBlob(dataUrl).then(function (blob) {
          doUpload(blob, file.name || kind);
        });
      }).catch(function (e) {
        VC.logError('25-tools', 'compression ' + kind + ' échouée', e);
        U.toast('Image trop lourde.', 'error');
      });
    } else {
      doUpload(file, file.name || kind);
    }
  }

  T._renderSignaturePreview = function () {
    _renderDefaultImagePreview('signatureDefaultPreview',
      'btnRemoveSignatureDefault', _getSigMeta(), 'Signature');
  };

  T._renderCachetPreview = function () {
    _renderDefaultImagePreview('cachetDefaultPreview',
      'btnRemoveCachetDefault', _getCachetMeta(), 'Cachet');
  };

  function _renderDefaultImagePreview(previewId, removeBtnId, meta, label) {
    var preview = document.getElementById(previewId);
    var removeBtn = document.getElementById(removeBtnId);
    if (!preview) return;

    if (!meta || !meta.ref) {
      preview.innerHTML = '<span class="muted" style="font-size:12px">' +
        'Aucun(e) ' + label.toLowerCase() + ' configuré(e)</span>';
      if (removeBtn) removeBtn.style.display = 'none';
      return;
    }

    IDB.blobs.get(meta.ref).then(function (row) {
      if (!row || !row.data) {
        preview.innerHTML = '<span class="muted" style="font-size:12px">' +
          'Fichier introuvable</span>';
        return;
      }

      IDB.blobToDataURL(row.data).then(function (d) {
        preview.innerHTML =
          '<img src="' + d + '" alt="' + label + '" ' +
          'style="max-height:80px;max-width:200px;background:#fff;' +
          'padding:4px;border:1px solid var(--border);border-radius:4px">' +
          '<div class="muted" style="font-size:11px;margin-top:4px">' +
            U.escapeHtml(meta.name || label) + ' · ' +
            U.formatBytes(meta.size || 0) +
          '</div>';
      }).catch(function (e) {
        VC.logError('25-tools', 'render preview dataURL échoué', e);
        preview.innerHTML = '<span class="muted" style="font-size:12px">' +
          'Erreur d\'affichage</span>';
      });
    }).catch(function (e) {
      VC.logError('25-tools', 'render preview load échoué', e);
      preview.innerHTML = '<span class="muted" style="font-size:12px">' +
        'Erreur d\'accès IDB</span>';
    });

    if (removeBtn) removeBtn.style.display = '';
  }

  T.removeSignature = function () {
    if (!U.confirm('Supprimer la signature par défaut ?')) return;
    try {
      localStorage.removeItem(SIG_META_KEY);
    } catch (e) {
      VC.logError('25-tools', 'remove sig meta échoué', e);
    }
    IDB.blobs.delete(SIG_REF).catch(function (e) {
      VC.logError('25-tools', 'delete sig blob échoué', e);
    });
    T._renderSignaturePreview();
    U.toast('Signature supprimée', 'info', 2000);
  };

  T.removeCachet = function () {
    if (!U.confirm('Supprimer le cachet par défaut ?')) return;
    try {
      localStorage.removeItem(CACHET_META_KEY);
    } catch (e) {
      VC.logError('25-tools', 'remove cachet meta échoué', e);
    }
    IDB.blobs.delete(CACHET_REF).catch(function (e) {
      VC.logError('25-tools', 'delete cachet blob échoué', e);
    });
    T._renderCachetPreview();
    U.toast('Cachet supprimé', 'info', 2000);
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 6 — CORBEILLE (STORE)
     ═══════════════════════════════════════════════════════════ */

  T.renderTrash = function () {
    var container = document.getElementById('trashList');
    if (!container) return;

    var trash = S.getTrash();
    var trashKeys = Object.keys(trash);

    if (trashKeys.length === 0 || S.getTrashCount() === 0) {
      container.innerHTML = '<div class="empty-state">Corbeille vide.</div>';
      U.setText('trashCount', '0');
      return;
    }

    /* Labels pour chaque type de collection */
    var labels = {
      clients: '👥 Clients',
      articles: '📦 Articles',
      suppliers: '🏭 Fournisseurs',
      documents: '🧾 Documents',
      chantiers: '🏗️ Chantiers',
      frais: '💰 Frais',
      purchaseInvoices: '🛒 Achats',
      bonsRoute: '🚐 Bons Route',
      hrEmployees: '👤 Employés',
      hrWorkEntries: '📅 Journées',
      hrTransactions: '💵 Paiements',
      documentsLib: '📁 Documents (biblio)',
      signatures: '✍️ Signatures'
    };

    var html = '';
    var totalShown = 0;

    for (var i = 0; i < trashKeys.length; i++) {
      var key = trashKeys[i];
      var entries = trash[key];
      if (!Array.isArray(entries) || entries.length === 0) continue;

      totalShown += entries.length;
      var label = labels[key] || key;

      html += '<div class="trash-category"><h4>' +
        U.escapeHtml(label) + ' (' + entries.length + ')</h4>';

      for (var j = 0; j < entries.length; j++) {
        var entry = entries[j];
        if (!entry || !entry.item) continue;

        var item = entry.item;
        var itemLabel = _itemLabel(key, item);
        var dateStr = entry.deletedAt
          ? U.formatDate(String(entry.deletedAt).slice(0, 10)) : '—';
        var daysOld = 0;

        if (entry.deletedAt) {
          try {
            daysOld = Math.floor(
              (Date.now() - new Date(entry.deletedAt).getTime()) / 86400000
            );
          } catch (e) {
            VC.logError('25-tools', 'calc days old échoué', e);
          }
        }

        html += '<div class="trash-row">' +
          '<div class="trash-row-main">' +
            '<div class="trash-row-label">' + U.escapeHtml(itemLabel) + '</div>' +
            '<div class="trash-row-meta">Supprimé le ' + U.escapeHtml(dateStr) +
            ' (' + daysOld + ' j)</div>' +
          '</div>' +
          '<div class="trash-row-actions">' +
            '<button type="button" class="btn btn-sm" ' +
            'onclick="VC.Tools.restoreTrashItem(\'' +
            U.escapeAttr(key) + '\',' + j + ')">↩️ Restaurer</button>' +
          '</div>' +
        '</div>';
      }
      html += '</div>';
    }

    if (html === '') {
      container.innerHTML = '<div class="empty-state">Corbeille vide.</div>';
    } else {
      container.innerHTML = html;
    }
    U.setText('trashCount', String(totalShown));
  };

  function _itemLabel(kind, item) {
    if (!item || typeof item !== 'object') return '(inconnu)';

    if (kind === 'clients' || kind === 'suppliers' ||
        kind === 'chantiers' || kind === 'hrEmployees') {
      return String(item.nom || '(sans nom)');
    }
    if (kind === 'articles') {
      return String(item.nom || item.designation || '(sans nom)');
    }
    if (kind === 'documents' || kind === 'purchaseInvoices' || kind === 'bonsRoute') {
      return String(item.numero || '(sans N°)');
    }
    if (kind === 'documentsLib') {
      return String(item.nom || '(sans nom)');
    }
    if (kind === 'signatures') {
      return String(item.nom || '(sans nom)');
    }
    if (kind === 'frais') {
      return String(item.categorie || 'Frais') + ' — ' +
        U.formatMoney(item.montant);
    }
    if (kind === 'hrWorkEntries') {
      return String(item.date || '') + ' — ' +
        (item.hours || 0) + 'h';
    }
    if (kind === 'hrTransactions') {
      return String(item.type || '') + ' — ' +
        U.formatMoney(item.montant);
    }
    return String(item.nom || item.numero || item.id || '');
  }

  T.restoreTrashItem = function (kind, index) {
    var restored = S.restoreFromTrash(kind, index);
    if (restored) {
      T.renderTrash();
      U.toast('Élément restauré', 'success', 2000);
    } else {
      U.toast('Erreur de restauration.', 'error');
    }
  };

  T.purgeOldTrash = function () {
    var purged = S.purgeOldTrash(VC.TRASH_MAX_DAYS);
    if (purged > 0) {
      T.renderTrash();
      /* Cleanup blobs orphelins */
      IDB.blobs.cleanOrphans().then(function (res) {
        if (res && res.cleaned > 0) {
          VC.logInfo('25-tools', res.cleaned + ' blobs nettoyés');
        }
      }).catch(function (e) {
        VC.logError('25-tools', 'cleanOrphans échoué', e);
      });
      U.toast(purged + ' élément(s) purgé(s)', 'success', 2000);
    } else {
      U.toast('Rien à purger (> ' + VC.TRASH_MAX_DAYS + 'j)', 'info');
    }
  };

  T.emptyTrash = function () {
    var count = S.getTrashCount();
    if (count === 0) {
      U.toast('Corbeille déjà vide.', 'info');
      return;
    }

    if (!U.confirm('Supprimer définitivement les ' + count +
      ' élément(s) de la corbeille ?')) {
      return;
    }

    S.emptyTrash();
    T.renderTrash();

    /* Cleanup blobs orphelins */
    IDB.blobs.cleanOrphans().then(function (res) {
      if (res && res.cleaned > 0) {
        VC.logInfo('25-tools', res.cleaned + ' blobs nettoyés');
      }
    }).catch(function (e) {
      VC.logError('25-tools', 'cleanOrphans échoué', e);
    });

    U.toast('Corbeille vidée (' + count + ' éléments)', 'success', 2500);
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 7 — HISTORIQUE
     ═══════════════════════════════════════════════════════════ */

  T.renderHistory = function () {
    var container = document.getElementById('historyList');
    if (!container) return;

    var history = S.getAll('history');
    if (history.length === 0) {
      container.innerHTML = '<div class="empty-state">' +
        'Aucune activité enregistrée.</div>';
      return;
    }

    var limit = Math.min(100, history.length);
    var html = '<table class="history-table"><thead><tr>' +
      '<th>Date</th><th>Utilisateur</th><th>Action</th><th>Détails</th>' +
      '</tr></thead><tbody>';

    for (var i = history.length - 1; i >= 0 && (history.length - i) <= limit; i--) {
      var e = history[i];
      if (!e) continue;
      var dateStr = String(e.date || '').slice(0, 16).replace('T', ' ');
      html += '<tr>' +
        '<td>' + U.escapeHtml(dateStr) + '</td>' +
        '<td>' + U.escapeHtml(e.user || '—') + '</td>' +
        '<td><code>' + U.escapeHtml(e.action || '') + '</code></td>' +
        '<td>' + U.escapeHtml(e.details || '') + '</td>' +
        '</tr>';
    }
    html += '</tbody></table>';
    container.innerHTML = html;
  };

  T.clearOldHistory = function () {
    var input = document.getElementById('historyDaysInput');
    var days = input ? parseInt(input.value, 10) || 90 : 90;
    var cutoff = Date.now() - (days * 86400000);

    var history = S.getAll('history');
    var filtered = history.filter(function (e) {
      if (!e || !e.date) return false;
      try {
        return new Date(e.date).getTime() > cutoff;
      } catch (err) {
        return false;
      }
    });

    var removed = history.length - filtered.length;
    if (removed === 0) {
      U.toast('Rien à supprimer.', 'info');
      return;
    }

    S.replaceAll('history', filtered);
    T.renderHistory();
    U.toast(removed + ' anciennes entrées supprimées', 'success');
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 8 — BACKUPS IDB
     ═══════════════════════════════════════════════════════════ */

  T.renderIDBBackups = function () {
    var container = document.getElementById('idbBackupsList');
    if (!container) return;

    container.innerHTML = '<div class="muted">Chargement…</div>';

    IDB.backups.list().then(function (list) {
      if (!list || list.length === 0) {
        container.innerHTML = '<div class="empty-state">' +
          'Aucun backup automatique.</div>';
        return;
      }

      var html = '';
      for (var i = 0; i < list.length; i++) {
        var b = list[i];
        var dateStr = String(b.date || '').slice(0, 16).replace('T', ' ');
        var sizeStr = U.formatBytes(b.size || 0);
        html += '<div class="trash-row">' +
          '<div class="trash-row-main">' +
            '<div class="trash-row-label">' + U.escapeHtml(dateStr) + '</div>' +
            '<div class="trash-row-meta">' + U.escapeHtml(sizeStr) + '</div>' +
          '</div>' +
          '<div class="trash-row-actions">' +
            '<button type="button" class="btn btn-sm" ' +
            'onclick="VC.Tools.restoreFromIDBBackup(' + b.id + ')">' +
            '↩️ Restaurer</button>' +
          '</div>' +
        '</div>';
      }
      container.innerHTML = html;
    }).catch(function (e) {
      VC.logError('25-tools', 'renderIDBBackups échoué', e);
      container.innerHTML = '<div class="empty-state">Erreur de chargement.</div>';
    });
  };

  T.restoreFromIDBBackup = function (id) {
    if (!U.confirm('Restaurer ce backup ? Les données actuelles seront remplacées.')) {
      return;
    }

    IDB.backups.restore(id).then(function (payload) {
      if (!payload || typeof payload !== 'object') {
        U.toast('Backup introuvable.', 'error');
        return;
      }

      /* payload = snapshot localStorage : { key: jsonString } */
      var count = 0;
      var keys = Object.keys(payload);
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        if (typeof payload[k] !== 'string') continue;
        try {
          localStorage.setItem(k, payload[k]);
          count++;
        } catch (e) {
          VC.logError('25-tools', 'setItem ' + k + ' échoué', e);
        }
      }

      /* Recharge + re-render */
      S.loadAll();
      if (VC.Migrate && typeof VC.Migrate.upgradeIfNeeded === 'function') {
        VC.Migrate.upgradeIfNeeded();
      }

      T.renderTrash();
      T.renderHistory();
      T.loadSettings();

      U.toast('Backup restauré (' + count + ' clés)', 'success', 3000);
    }).catch(function (e) {
      VC.logError('25-tools', 'restoreFromIDBBackup échoué', e);
      U.toast('Erreur de restauration.', 'error');
    });
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 9 — DOUBLONS
     ═══════════════════════════════════════════════════════════ */

  T.renderDuplicates = function () {
    var container = document.getElementById('duplicatesList');
    if (!container) return;

    var groups = {
      clients: _groupByNormalizedName(S.getAll('clients')),
      articles: _groupByNormalizedName(S.getAll('articles')),
      suppliers: _groupByNormalizedName(S.getAll('suppliers'))
    };

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
  };

  function _groupByNormalizedName(arr) {
    var groups = [];
    if (!Array.isArray(arr)) return groups;

    var byName = {};
    for (var i = 0; i < arr.length; i++) {
      var item = arr[i];
      if (!item || !item.nom) continue;
      var key = U.normalizeText(item.nom);
      if (!byName[key]) byName[key] = [];
      byName[key].push(item);
    }

    var keys = Object.keys(byName);
    for (var k = 0; k < keys.length; k++) {
      if (byName[keys[k]].length > 1) {
        groups.push(byName[keys[k]]);
      }
    }
    return groups;
  }

  function _renderDupGroup(kind, groups) {
    if (!groups || groups.length === 0) return '';

    var label = kind === 'clients' ? '👥 Clients'
      : kind === 'articles' ? '📦 Articles' : '🏭 Fournisseurs';

    var html = '<div class="trash-category"><h4>' + label +
      ' (' + groups.length + ' doublon(s))</h4>';

    for (var i = 0; i < groups.length; i++) {
      var grp = groups[i];
      html += '<div class="trash-row">' +
        '<div class="trash-row-main">' +
          '<div class="trash-row-label">' +
          U.escapeHtml(grp[0].nom) + ' × ' + grp.length + '</div>' +
          '<div class="trash-row-meta">IDs : ' +
          grp.map(function (x) { return String(x.id).slice(-6); }).join(', ') +
          '</div>' +
        '</div>' +
        '<div class="trash-row-actions">' +
          '<button type="button" class="btn btn-sm" ' +
          'onclick="VC.Tools.mergeDuplicates(\'' +
          U.escapeAttr(kind) + '\',' + i + ')">🔀 Fusionner</button>' +
        '</div>' +
      '</div>';
    }
    html += '</div>';
    return html;
  }

  T.mergeDuplicates = function (kind, groupIndex) {
    var groups = {
      clients: _groupByNormalizedName(S.getAll('clients')),
      articles: _groupByNormalizedName(S.getAll('articles')),
      suppliers: _groupByNormalizedName(S.getAll('suppliers'))
    };

    var grp = groups[kind] && groups[kind][groupIndex];
    if (!grp || grp.length < 2) return;

    var primary = grp[0];
    var toRemove = grp.slice(1);

    if (!U.confirm('Fusionner ' + grp.length + ' entrées identiques ?\n\n' +
      '• "' + (primary.nom || '') + '" sera conservée\n' +
      '• Les ' + toRemove.length + ' autre(s) seront supprimées\n\n' +
      'Les références seront réaffectées automatiquement.')) {
      return;
    }

    /* Remplit les trous de primary avec les données des autres */
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

    /* Réaffectation des références AVANT suppression */
    var oldIds = toRemove.map(function (x) { return String(x.id); });
    var reassigned = _reassignRefs(kind, oldIds, String(primary.id));

    /* Sauvegarde primary + suppression des doublons */
    S.save(kind, primary);
    for (var m = 0; m < toRemove.length; m++) {
      S.delete(kind, toRemove[m].id);
    }

    /* FIX Bug 4 : persister AUSSI les mutations de _reassignRefs
       (documents/chantiers/frais/achats mutés en mémoire). */
    S.saveAll();

    T.renderDuplicates();
    U.toast(toRemove.length + ' doublon(s) fusionné(s)' +
      (reassigned > 0 ? ' · ' + reassigned + ' référence(s)' : ''),
      'success', 3000);
  };

  function _reassignRefs(kind, oldIds, newId) {
    var count = 0;
    var idsMap = {};
    for (var i = 0; i < oldIds.length; i++) idsMap[oldIds[i]] = true;

    function remap(arr, field) {
      if (!Array.isArray(arr)) return;
      for (var j = 0; j < arr.length; j++) {
        if (arr[j] && idsMap[String(arr[j][field] || '')]) {
          arr[j][field] = newId;
          count++;
        }
      }
    }

    if (kind === 'clients') {
      remap(S.getAll('documents'), 'clientId');
      remap(S.getAll('chantiers'), 'clientId');
      remap(S.getAll('frais'), 'clientId');
    } else if (kind === 'suppliers') {
      var purchases = S.getAll('purchaseInvoices');
      for (var k = 0; k < purchases.length; k++) {
        var p = purchases[k];
        if (!p) continue;
        if (idsMap[String(p.supplierId || '')]) {
          p.supplierId = newId;
          p.fournisseurId = newId;
          count++;
        }
      }
    } else if (kind === 'articles') {
      var docs = S.getAll('documents');
      for (var a = 0; a < docs.length; a++) {
        var d = docs[a];
        if (!d || !Array.isArray(d.items)) continue;
        for (var b = 0; b < d.items.length; b++) {
          if (d.items[b] && idsMap[String(d.items[b].articleId || '')]) {
            d.items[b].articleId = newId;
            count++;
          }
        }
      }
    }

    return count;
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 10 — DARK MODE
     ═══════════════════════════════════════════════════════════ */

  T.toggleDarkMode = function () {
    var cb = document.getElementById('settingsDarkMode');
    var on = cb ? cb.checked : !(localStorage.getItem('voltcore_dark') === '1');

    try {
      localStorage.setItem('voltcore_dark', on ? '1' : '0');
    } catch (e) {
      VC.logError('25-tools', 'setItem dark échoué', e);
    }

    document.body.classList.toggle('dark-mode', on);
    U.toast(on ? 'Mode sombre activé' : 'Mode clair activé', 'info', 1500);
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 11 — TRUSTED DEVICE
     ═══════════════════════════════════════════════════════════ */

  T.toggleTrustedDevice = function () {
    var cb = document.getElementById('settingsTrustedDevice');
    if (!cb || !VC.Auth) return;

    if (cb.checked) {
      VC.Auth.setTrustedDevice(true);
      U.toast('Appareil de confiance activé. Vous ne verrez plus ' +
        'l\'écran de connexion.', 'success', 4000);
    } else {
      VC.Auth.setTrustedDevice(false);
      U.toast('Appareil de confiance désactivé.', 'info', 3000);
    }
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 12 — RESET COMPTEURS
     ═══════════════════════════════════════════════════════════ */

  T.resetCompteurs = function () {
    var typed = U.prompt('Tape "RESET" pour confirmer la remise à zéro ' +
      'des compteurs.\n(Les documents existants ne sont PAS supprimés, ' +
      'seule la numérotation repart à 1.)');

    if (!typed || String(typed).toUpperCase() !== 'RESET') {
      U.toast('Annulé.', 'info', 1500);
      return;
    }

    S.resetCompteurs();
    U.toast('Compteurs remis à zéro', 'success', 2500);
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 13 — DIAGNOSTICS
     ═══════════════════════════════════════════════════════════ */

  T.openDiagnostics = function () {
    var panel = document.getElementById('diagPanel');
    if (panel) panel.style.display = 'block';

    var out = document.getElementById('diagOutput');
    if (!out) return;

    var lines = [];
    lines.push('═══════════════════════════════');
    lines.push('  DIAGNOSTIC VOLTCORE ' + VC.VERSION);
    lines.push('═══════════════════════════════');
    lines.push('');

    lines.push('▶ RUNTIME');
    lines.push('Appareil : ' + (VC.device.mobile ? 'mobile'
      : (VC.device.tablet ? 'tablet' : 'desktop')));
    lines.push('HTTPS : ' + (VC.device.https ? 'oui' : 'non'));
    lines.push('Caméra : ' + (VC.device.camera ? 'oui' : 'non'));
    lines.push('Biométrie : ' + (VC.device.biometric ? 'oui' : 'non'));
    lines.push('Storage : ' + (VC.device.storage ? 'oui' : 'non'));
    lines.push('PWA installée : ' + (VC.isPWAInstalled() ? 'oui' : 'non'));
    lines.push('OpenCV prêt : ' + (global.__opencvReady ? 'oui' : 'non'));
    lines.push('');

    lines.push('▶ MODULES CHARGÉS');
    var modules = [
      ['00-core', VC._coreLoaded],
      ['01-utils', VC._utilsLoaded],
      ['02-store', VC._storeLoaded],
      ['03-idb', VC._idbLoaded],
      ['04-alerts', VC._alertsLoaded],
      ['05-auth', VC._authLoaded],
      ['06-clients', VC._clientsLoaded],
      ['07-suppl', VC._supplLoaded],
      ['08-stock', VC._stockLoaded],
      ['09-chant', VC._chantLoaded],
      ['10-hr', VC._hrLoaded],
      ['11-inv', VC._invLoaded],
      ['12-inv-view', VC._invViewLoaded],
      ['13-inv-pdf', VC._invPdfLoaded],
      ['14-purch', VC._purchLoaded],
      ['15-frais', VC._fraisLoaded],
      ['16-route', VC._routeLoaded],
      ['17-docs', VC._docsLoaded],
      ['18-scan', VC._scanLoaded],
      ['19-scan-cv', VC._scanCvLoaded],
      ['20-scan-js', VC._scanJsLoaded],
      ['21-sign', VC._signLoaded],
      ['22-ia', VC._iaLoaded],
      ['23-dash', VC._dashLoaded],
      ['24-mobile', VC._mobileLoaded],
      ['25-tools', VC._toolsLoaded],
      ['26-infra', VC._infraLoaded],
      ['27-migrate', VC._migrateLoaded],
      ['28-backup', VC._backupLoaded]
    ];
    for (var i = 0; i < modules.length; i++) {
      lines.push(modules[i][0] + ' : ' + (modules[i][1] ? '✅' : '❌'));
    }
    lines.push('');

    lines.push('▶ DONNÉES');
    var collections = S.listRegistered();
    for (var j = 0; j < collections.length; j++) {
      var name = collections[j];
      var spec = S.getSpec(name);
      if (!spec) continue;
      if (spec.type === 'array') {
        lines.push(name + ' : ' + S.getAll(name).length);
      } else if (spec.type === 'object') {
        lines.push(name + ' : ' + Object.keys(S.getObject(name)).length + ' clés');
      } else {
        lines.push(name + ' : ' + String(S.getValue(name)).slice(0, 40));
      }
    }
    lines.push('');

    lines.push('▶ CORBEILLE');
    var trash = S.getTrash();
    var trashKeys = Object.keys(trash);
    lines.push('Total : ' + S.getTrashCount() + ' élément(s)');
    for (var k = 0; k < trashKeys.length; k++) {
      var arr = trash[trashKeys[k]];
      if (Array.isArray(arr) && arr.length > 0) {
        lines.push('  ' + trashKeys[k] + ' : ' + arr.length);
      }
    }
    lines.push('');

    lines.push('▶ STOCKAGE');
    var total = 0;
    try {
      for (var l = 0; l < localStorage.length; l++) {
        var lk = localStorage.key(l);
        if (lk && lk.indexOf(VC.STORAGE_PREFIX) === 0) {
          total += (localStorage.getItem(lk) || '').length;
        }
      }
    } catch (e) {
      lines.push('Erreur lecture localStorage : ' + e.message);
    }
    lines.push('localStorage : ' + (total / 1024).toFixed(1) + ' Ko (~' +
      (total / 1024 / 1024).toFixed(2) + ' Mo / 5 Mo)');

    IDB.blobs.list().then(function (blobs) {
      lines.push('IDB blobs : ' + (blobs ? blobs.length : 0) + ' fichiers');

      IDB.backups.list().then(function (backups) {
        lines.push('IDB backups : ' + (backups ? backups.length : 0));

        if (VC.Infra && typeof VC.Infra.getStatus === 'function') {
          var status = VC.Infra.getStatus();
          lines.push('');
          lines.push('▶ INFRA');
          lines.push('Erreurs loggées : ' + (status.errors || 0));
        }

        out.textContent = lines.join('\n');
      });
    }).catch(function (e) {
      VC.logError('25-tools', 'diagnostics IDB échoué', e);
      out.textContent = lines.join('\n');
    });
  };

  T.closeDiagnostics = function () {
    var panel = document.getElementById('diagPanel');
    if (panel) panel.style.display = 'none';
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 14 — INIT + EVENTS
     ═══════════════════════════════════════════════════════════ */

  T.init = function () {
    T.loadSettings();
    T.renderTrash();
    T.renderHistory();

    /* Dark mode */
    try {
      if (localStorage.getItem('voltcore_dark') === '1') {
        document.body.classList.add('dark-mode');
        var cb = document.getElementById('settingsDarkMode');
        if (cb) cb.checked = true;
      }
    } catch (e) {
      VC.logError('25-tools', 'init dark mode échoué', e);
    }

    /* Purge auto au boot */
    try { S.purgeOldTrash(VC.TRASH_MAX_DAYS); } catch (e) {
      VC.logError('25-tools', 'purge auto échouée', e);
    }
  };

  T.attachEvents = function () {
    /* Corbeille */
    U.on('btnPurgeTrash', 'click', T.purgeOldTrash);
    U.on('btnEmptyTrash', 'click', T.emptyTrash);

    /* Historique */
    U.on('btnClearOldHistory', 'click', T.clearOldHistory);

    /* Backups IDB */
    U.on('btnRefreshIDBBackups', 'click', T.renderIDBBackups);

    /* Doublons */
    U.on('btnScanDuplicates', 'click', T.renderDuplicates);

    /* Paramètres */
    U.on('btnSaveSettings', 'click', T.saveSettings);
    U.on('settingsDarkMode', 'change', T.toggleDarkMode);
    U.on('settingsTrustedDevice', 'change', T.toggleTrustedDevice);
    U.on('btnResetCompteurs', 'click', T.resetCompteurs);

    /* Logo */
    U.on('btnChangeLogo', 'click', function () {
      var input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.onchange = function (ev) {
        var f = ev.target.files && ev.target.files[0];
        if (f) T.changeLogo(f);
      };
      input.click();
    });
    U.on('btnRemoveLogo', 'click', T.removeLogo);

    /* Signature / cachet */
    U.on('btnUploadSignatureDefault', 'click', function () {
      var input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/png,image/jpeg,image/webp';
      input.onchange = function (ev) {
        var f = ev.target.files && ev.target.files[0];
        if (f) T.uploadSignature(f);
      };
      input.click();
    });
    U.on('btnRemoveSignatureDefault', 'click', T.removeSignature);

    U.on('btnUploadCachetDefault', 'click', function () {
      var input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/png,image/jpeg,image/webp';
      input.onchange = function (ev) {
        var f = ev.target.files && ev.target.files[0];
        if (f) T.uploadCachet(f);
      };
      input.click();
    });
    U.on('btnRemoveCachetDefault', 'click', T.removeCachet);

    /* Diagnostics */
    U.on('diagBtn', 'click', T.openDiagnostics);
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 15 — MARQUEUR
     ═══════════════════════════════════════════════════════════ */

  VC._toolsLoaded = true;

  VC.logInfo('25-tools', 'Module chargé (trash ouvert, IDB signatures)');

})(window);