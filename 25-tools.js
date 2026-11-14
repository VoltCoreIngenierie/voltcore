/* ═══════════════════════════════════════════════════════════
   VOLTCORE — 25-tools.js
   VERSION : v7.0.7
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

  // FIX : Catalogue de cachets (comme les signatures)
  S.register('cachets', {
    type: 'array',
    saveKey: 'voltcore_cachets_v7',
    default: [],
    idPrefix: 'cac',
    trash: true,
    backup: true,
    blobs: function (item) {
      return (item && item.ref) ? [item.ref] : [];
    },
    schema: {
      nom: 'string|required',
      ref: 'string|required',
      mime: 'string',
      taille: 'float|0-999999999',
      date: 'date'
    }
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

    _renderCatalogSelects();
    T._renderSignaturePreview();
    T._renderCachetPreview();

    _settingsLoaded = true;
  };

  function _renderCatalogSelects() {
    // Signatures
    var sigs = S.getAll('signatures');
    var sigSelect = document.getElementById('signatureCatalogSelect');
    if (sigSelect) {
      var currentSig = sigSelect.value; // Sauvegarder la sélection
      var html = '<option value="">— Aucune —</option>';
      for (var i = 0; i < sigs.length; i++) {
        html += '<option value="' + U.escapeAttr(sigs[i].id) + '">' + U.escapeHtml(sigs[i].nom) + '</option>';
      }
      sigSelect.innerHTML = html;
      if (currentSig) sigSelect.value = currentSig; // Restaurer
    }
    
    // Cachets
    var cacs = S.getAll('cachets');
    var cacSelect = document.getElementById('cachetCatalogSelect');
    if (cacSelect) {
      var currentCac = cacSelect.value; // Sauvegarder la sélection
      var html2 = '<option value="">— Aucun —</option>';
      for (var j = 0; j < cacs.length; j++) {
        html2 += '<option value="' + U.escapeAttr(cacs[j].id) + '">' + U.escapeHtml(cacs[j].nom) + '</option>';
      }
      cacSelect.innerHTML = html2;
      if (currentCac) cacSelect.value = currentCac; // Restaurer
    }
  }

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
    var nom = U.prompt('Nom de la signature :', 'Signature ' + U.todayISO());
    if (nom === null) return;
    _uploadDefaultImage('sig', file, '', '', '_renderSignaturePreview', nom);
  };

  T.uploadCachet = function (file) {
    if (!file) return;
    var nom = U.prompt('Nom du cachet :', 'Cachet ' + U.todayISO());
    if (nom === null) return;
    _uploadDefaultImage('cachet', file, '', '', '_renderCachetPreview', nom);
  };

  function _uploadDefaultImage(kind, file, ref, metaKey, renderFn, nomCustom) {
    if (!/^image\//.test(file.type)) {
      U.toast('Format image requis (PNG, JPG).', 'error');
      return;
    }

    U.toast('Traitement de l\'image…', 'info', 2000);

    function doUpload(blob) {
      var processPromise = (kind === 'cachet') ? _detourerCachet(blob) : Promise.resolve(blob);

      processPromise.then(function (processBlob) {
        var newRef = U.generateId(kind + '_blob');
        var collection = (kind === 'cachet') ? 'cachets' : 'signatures';

        IDB.blobs.put(newRef, processBlob, processBlob.type).then(function () {
          var entry = S.save(collection, {
            nom: (nomCustom || (kind === 'cachet' ? 'Cachet ' : 'Signature ') + U.todayISO()).trim(),
            ref: newRef,
            mime: processBlob.type,
            taille: processBlob.size,
            date: U.todayISO()
          });

          if (entry) {
            T.loadSettings();
            setTimeout(function() {
                var sel = document.getElementById(kind === 'cachet' ? 'cachetCatalogSelect' : 'signatureCatalogSelect');
                if (sel) sel.value = entry.id;
                if (typeof T[renderFn] === 'function') T[renderFn]();
            }, 100);
            U.toast('Ajouté au catalogue', 'success', 2000);
          }
        });
      });
    }

    if (file.size > VC.SIGNATURE_MAX_BYTES) {
      U.compressImage(file, VC.SIGNATURE_MAX_BYTES).then(function (dataUrl) {
        IDB.dataURLToBlob(dataUrl).then(doUpload);
      });
    } else {
      doUpload(file);
    }
  }

   T._renderSignaturePreview = function () {
    var sel = document.getElementById('signatureCatalogSelect');
    var selectedId = sel ? sel.value : '';
    var entry = selectedId ? S.getById('signatures', selectedId) : null;
    _renderCatalogPreview('signatureDefaultPreview', 'btnRemoveSignatureDefault', entry, 'Signature');
  };

  T._renderCachetPreview = function () {
    var sel = document.getElementById('cachetCatalogSelect');
    var selectedId = sel ? sel.value : '';
    var entry = selectedId ? S.getById('cachets', selectedId) : null;
    _renderCatalogPreview('cachetDefaultPreview', 'btnRemoveCachetDefault', entry, 'Cachet');
  };

  function _renderCatalogPreview(previewId, removeBtnId, entry, label) {
    var preview = document.getElementById(previewId);
    var removeBtn = document.getElementById(removeBtnId);
    var nameInput = document.getElementById(label === 'Cachet' ? 'cachetNameInput' : 'signatureNameInput');
    
    if (!preview) return;

    if (nameInput) nameInput.value = entry ? (entry.nom || '') : '';
    if (!entry || !entry.ref) {
      preview.innerHTML = '<span class="muted" style="font-size:12px">' +
        'Sélectionne ou ajoute un(e) ' + label.toLowerCase() + '</span>';
      if (removeBtn) removeBtn.style.display = 'none';
      return;
    }

    if (removeBtn) removeBtn.style.display = '';

    IDB.blobs.get(entry.ref).then(function (row) {
      if (!row || !row.data) {
        preview.innerHTML = '<span class="muted" style="font-size:12px">Fichier introuvable</span>';
        return;
      }
      IDB.blobToDataURL(row.data).then(function (d) {
        preview.innerHTML =
          '<div style="width:100%; height:100%; display:flex; flex-direction:column; align-items:center; justify-content:center; padding:10px;">' +
            '<img src="' + d + '" alt="' + label + '" style="width:100%; height:100%; max-height:120px; object-fit:contain; mix-blend-mode: multiply;">' +
            '<div class="muted" style="font-size:11px;margin-top:8px">' + U.escapeHtml(entry.nom) + '</div>' +
          '</div>';
      }).catch(function (e) {
        VC.logError('25-tools', 'render preview échoué', e);
      });
    }).catch(function (e) {
      VC.logError('25-tools', 'render preview load échoué', e);
    });
  }
  /**
   * FIX BLOC B : détoure un cachet (rend le fond blanc transparent).
   * Utilise un Canvas pour analyser les pixels.
   */
  function _detourerCachet(blob) {
    return new Promise(function (resolve) {
      var img = new Image();
      var url = URL.createObjectURL(blob);
      
      img.onload = function () {
        var canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        var ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        URL.revokeObjectURL(url);

        var imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        var data = imgData.data;
        
        // Parcours de chaque pixel
        for (var i = 0; i < data.length; i += 4) {
          var r = data[i];
          var g = data[i + 1];
          var b = data[i + 2];
          
          // Si le pixel est clair (proche du blanc/gris clair), on le rend transparent
          // Le seuil de 180 permet de gérer les ombres légères sur la photo
          if (r > 180 && g > 180 && b > 180) {
            data[i + 3] = 0; // Alpha = 0 (transparent)
          }
        }
        
        ctx.putImageData(imgData, 0, 0);
        
        // Reconvertir en Blob PNG (qui gère la transparence)
        canvas.toBlob(function (newBlob) {
          if (!newBlob) resolve(blob); // Fallback si ça échoue
          else resolve(newBlob);
        }, 'image/png');
      };
      
      img.onerror = function () {
        resolve(blob); // Si l'image ne charge pas, on garde l'original
      };
      
      img.src = url;
    });
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
  /**
   * FIX BLOC B : Scanner un cachet spécifiquement.
   * Ouvre la caméra, prend la photo, et lance un algorithme de détourage
   * avancé pour ne garder QUE l'encre (transparence parfaite).
   */
  T.scanCachet = function () {
    // FIX BLOC B : Ouvre le vrai scanner principal avec un mode "cachet"
    if (VC.Scan && typeof VC.Scan.open === 'function') {
      VC.Scan.open({ target: 'cachet' });
    } else {
      U.toast('Module Scanner indisponible.', 'error');
    }
  };

  /**
   * Algorithme de détourage avancé pour le cachet.
   * 1. Enlève le papier (rend blanc transparent)
   * 2. Renforce l'encre (contraste + saturation)
   */
  function _processCachetImage(img) {
    var canvas = document.createElement('canvas');
    // Augmenté à 1200 pour plus de détails sur le cachet
    var maxDim = 1200;
    var scale = Math.min(maxDim / img.width, maxDim / img.height, 1);
    
    canvas.width = img.width * scale;
    canvas.height = img.height * scale;
    
    var ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    
    var imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    var data = imgData.data;
    var w = canvas.width;
    var h = canvas.height;
    
    // ═══════════════════════════════════════════════════════════
    // 1. FILTRE DE NETTETÉ (Unsharp Mask / Convolution)
    // Rend les traits de l'encre beaucoup plus nets
    // ═══════════════════════════════════════════════════════════
    var copy = new Uint8ClampedArray(data);
    // Matrice de convolution 3x3 (netteté)
    //  0 -1  0
    // -1  5 -1
    //  0 -1  0
    for (var y = 1; y < h - 1; y++) {
      for (var x = 1; x < w - 1; x++) {
        var idx = (y * w + x) * 4;
        for (var c = 0; c < 3; c++) {
          var val = 
            (copy[idx - w*4 + c] * 0) + (copy[idx - w*4 + 4 + c] * -1) + (copy[idx - w*4 + 8 + c] * 0) +
            (copy[idx - 4 + c] * -1)    + (copy[idx + c] * 5)           + (copy[idx + 4 + c] * -1) +
            (copy[idx + w*4 + c] * 0)   + (copy[idx + w*4 + 4 + c] * -1) + (copy[idx + w*4 + 8 + c] * 0);
            
          data[idx + c] = Math.max(0, Math.min(255, val));
        }
      }
    }
    
    // ═══════════════════════════════════════════════════════════
    // 2. DÉTOURAGE ET CONTRASTE
    // ═══════════════════════════════════════════════════════════
    var SEUIL_BLANC = 170; // Ajusté pour être plus propre
    
    for (var i = 0; i < data.length; i += 4) {
      var r = data[i];
      var g = data[i + 1];
      var b = data[i + 2];
      
      // Calcul de la luminance
      var luminance = 0.299 * r + 0.587 * g + 0.114 * b;
      
      if (luminance > SEUIL_BLANC) {
        // Papier ou fond clair -> transparent
        data[i + 3] = 0; 
      } else {
        // Encre -> on augmente le contraste et on sature un peu
        var facteur = 1.8; // Contraste fort pour la netteté
        data[i] = Math.max(0, Math.min(255, (r - 128) * facteur + 128));
        data[i + 1] = Math.max(0, Math.min(255, (g - 128) * facteur + 128));
        data[i + 2] = Math.max(0, Math.min(255, (b - 128) * facteur + 128));
        
        // L'encre devient 100% opaque
        data[i + 3] = 255; 
      }
    }
    
    ctx.putImageData(imgData, 0, 0);
    
    // On retourne un Blob PNG (obligatoire pour la transparence)
    var dataUrl = canvas.toDataURL('image/png');
    
    // Conversion dataURL -> Blob
    var parts = dataUrl.split(',');
    var mime = parts[0].match(/:(.*?);/)[1];
    var bstr = atob(parts[1]);
    var n = bstr.length;
    var u8arr = new Uint8Array(n);
    for (var j = 0; j < n; j++) {
      u8arr[j] = bstr.charCodeAt(j);
    }
    return new Blob([u8arr], { type: mime });
  }
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

      // FIX : Utilisation de <details> pour faire un accordéon
      html += '<details class="trash-category" style="margin-bottom:12px; background:var(--bg-soft); border-radius:var(--radius-sm); border:1px solid var(--border)">' +
        '<summary style="cursor:pointer; padding:12px; font-weight:600; color:var(--vc-navy); user-select:none; display:flex; justify-content:space-between; align-items:center">' +
          '<span>' + U.escapeHtml(label) + '</span>' +
          '<span class="badge">' + entries.length + '</span>' +
        '</summary>' +
        '<div style="padding: 0 12px 12px 12px; display:flex; flex-direction:column; gap:8px; max-height:300px; overflow-y:auto;">';

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

        html += '<div class="trash-row" style="background:var(--card); border:1px solid var(--border); padding:8px; border-radius:4px; display:flex; justify-content:space-between; align-items:center">' +
          '<div class="trash-row-main">' +
            '<div class="trash-row-label" style="font-size:13px; font-weight:600">' + U.escapeHtml(itemLabel) + '</div>' +
            '<div class="trash-row-meta" style="font-size:11px; color:var(--text-light)">Supprimé le ' + U.escapeHtml(dateStr) +
            ' (' + daysOld + ' j)</div>' +
          '</div>' +
          '<div class="trash-row-actions">' +
            '<button type="button" class="btn btn-sm" ' +
            'onclick="VC.Tools.restoreTrashItem(\'' +
            U.escapeAttr(key) + '\',' + j + ')">↩️ Restaurer</button>' +
          '</div>' +
        '</div>';
      }
      html += '</div></details>';
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
    // FIX : Le bouton Ajouter Signature ouvre la modale de dessin !
    U.on('btnOpenSignatureModal', 'click', function () {
      if (VC.Sign && typeof VC.Sign.open === 'function') {
        VC.Sign.open();
      } else {
        U.toast('Module signature indisponible.', 'error');
      }
    });
    
    U.on('btnRemoveSignatureDefault', 'click', function() {
       var sel = document.getElementById('signatureCatalogSelect');
       if (sel && sel.value) {
           if (U.confirm('Supprimer cette signature du catalogue ?')) {
               S.delete('signatures', sel.value);
               _renderCatalogSelects();
               T._renderSignaturePreview();
           }
       }
    });
        // FIX : Renommer Signature
    U.on('btnRenameSignature', 'click', function() {
       var sel = document.getElementById('signatureCatalogSelect');
       var input = document.getElementById('signatureNameInput');
       if (sel && sel.value && input) {
           var entry = S.getById('signatures', sel.value);
           if (entry && input.value.trim()) {
               entry.nom = input.value.trim();
               S.save('signatures', entry);
               T.loadSettings();
               U.toast('Signature renommée !', 'success', 2000);
           }
       }
    });

    // FIX : Renommer Cachet
    U.on('btnRenameCachet', 'click', function() {
       var sel = document.getElementById('cachetCatalogSelect');
       var input = document.getElementById('cachetNameInput');
       if (sel && sel.value && input) {
           var entry = S.getById('cachets', sel.value);
           if (entry && input.value.trim()) {
               entry.nom = input.value.trim();
               S.save('cachets', entry);
               T.loadSettings();
               U.toast('Cachet renommé !', 'success', 2000);
           }
       }
    });
    // FIX : Écouter le changement dans les listes déroulantes
    U.on('signatureCatalogSelect', 'change', T._renderSignaturePreview);
    U.on('cachetCatalogSelect', 'change', T._renderCachetPreview);

    U.on('btnRemoveCachetDefault', 'click', function() {
       var sel = document.getElementById('cachetCatalogSelect');
       if (sel && sel.value) {
           if (U.confirm('Supprimer ce cachet du catalogue ?')) {
               S.delete('cachets', sel.value);
               _renderCatalogSelects();
               T._renderCachetPreview();
           }
       }
    });
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
    
    // FIX BLOC B : binding du nouveau bouton Scanner
    U.on('btnScanCachet', 'click', T.scanCachet);
    
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