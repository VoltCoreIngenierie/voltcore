/* ═══════════════════════════════════════════════════════════
   VOLTCORE — 11-inv.js
   VERSION : v7.0.7
   RÔLE : Formulaire facture/devis/BL/attachement/avoir.
          Calcul des totaux (TVA + timbre + retenues + garantie BTP).
          Pièces jointes via IDB. Brouillon auto (refs, pas dataURL).
          Autoliquidation TVA OPT-IN explicite (fix C13).
   DÉPENDANCES : 00-core, 01-utils, 02-store, 03-idb, 04-alerts,
                 06-clients, 08-stock, 09-chant
   ORDRE : 12ᵉ fichier chargé

   FIX v7.0.0 :
   - C13 : autoliquidation = booléen explicite, JAMAIS auto
   - M10 : défauts client n'écrasent jamais une saisie manuelle
   - M11 : brouillon stocke refs IDB (pas dataURL)
   - M12 : prefill chantier prime sur brouillon existant
   - M13 : saveBrouillon debounced 1.5s + avant fermeture

   RÈGLES :
   - ES5 strict
   - Aucun catch silencieux
   - Ne JAMAIS lire/écrire localStorage directement
   ═══════════════════════════════════════════════════════════ */

'use strict';

(function (global) {

  if (!global.VOLTCORE || !global.VOLTCORE.Store || !global.VOLTCORE.Utils) {
    throw new Error('[11-inv] Modules requis non chargés');
  }

  var VC = global.VOLTCORE;
  var U = VC.Utils;
  var S = VC.Store;
  var IDB = VC.IDB;
  var Doc = VC.Doc;
  var Inv = VC.Invoices || {};
  VC.Invoices = Inv;

  /* ═══════════════════════════════════════════════════════════
     SECTION 1 — REGISTRATION STORE
     ═══════════════════════════════════════════════════════════ */

  S.register('documents', {
    type: 'array',
    saveKey: 'voltcore_documents',
    default: [],
    idPrefix: 'doc',
    trash: true,
    backup: true,
    blobs: function (item) {
      var refs = [];
      if (item && Array.isArray(item.attachments)) {
        for (var i = 0; i < item.attachments.length; i++) {
          if (item.attachments[i] && item.attachments[i].ref) {
            refs.push(item.attachments[i].ref);
          }
        }
      }
      return refs;
    },
    schema: {
      type: 'enum|devis,bl,facture,attachement,avoir',
      numero: 'string',
      date: 'date|required',
      clientId: 'string',
      chantierId: 'string',
      sujet: 'string',
      notes: 'string',
      statut: 'enum|brouillon,emise,annulee',
      autoliquidation: 'bool',
      retenueMontant: 'float|0-99999999',
      retenueGarantie: 'float|0-99999999',
      parentFactureId: 'string',
      garantieLiberee: 'bool',
      dateLiberation: 'date'
    }
  });

  S.register('brouillonCourant', {
    type: 'object',
    saveKey: 'voltcore_brouillon_courant',
    default: {},
    backup: false
  });

  /* ═══════════════════════════════════════════════════════════
     SECTION 2 — ÉTAT INTERNE
     ═══════════════════════════════════════════════════════════ */

  var _editId = null;
  var _pendingAvoirParentId = null;
  var _dirty = false;
  var _draftTimer = null;
  var _touched = { tva: false, timbre: false };  /* FIX M10 */

  var _items = [];           /* currentInvoiceItems */
  var _attachments = [];     /* currentAttachments */

  var INVOICE_TYPES = {
    devis: 'Devis',
    bl: 'Bon livraison',
    facture: 'Facture',
    attachement: 'Attachement',
    avoir: 'Avoir'
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 3 — CALCUL DES TOTAUX
     ═══════════════════════════════════════════════════════════ */

  /**
   * Calcule tous les totaux à partir des items + paramètres du formulaire.
   * Retourne un objet avec tous les champs utilisés par les autres modules.
   * Aucune dépendance au DOM en dehors des champs de paramètres.
   */
  Inv.computeTotals = function () {
    var totalHT = 0;

    for (var i = 0; i < _items.length; i++) {
      if (_items[i]) totalHT += U.computeLineTotal(_items[i]);
    }

    var tvaRate = U.parseNumber(U.getVal('invoiceTVARate'));
    if (!isFinite(tvaRate) || tvaRate < 0) tvaRate = VC.TVA_DEFAULT;
    if (tvaRate > 100) tvaRate = 100;

    var timbre = U.parseNumber(U.getVal('invoiceTimbre'));
    if (!isFinite(timbre) || timbre < 0) timbre = VC.TIMBRE_DEFAULT;

    var retIRRate = U.parseNumber(U.getVal('invoiceRetenueIR'));
    if (!isFinite(retIRRate) || retIRRate < 0) retIRRate = 0;
    if (retIRRate > 100) retIRRate = 100;

    var retTVARate = U.parseNumber(U.getVal('invoiceRetenueTVA'));
    if (!isFinite(retTVARate) || retTVARate < 0) retTVARate = 0;
    if (retTVARate > 100) retTVARate = 100;

    var retGarantieRate = U.parseNumber(U.getVal('invoiceRetenueGarantie'));
    if (!isFinite(retGarantieRate) || retGarantieRate < 0) retGarantieRate = 0;
    if (retGarantieRate > 100) retGarantieRate = 100;

    var tva = totalHT * tvaRate / 100;
    var totalTTC = totalHT + tva + timbre;

    var retenueIR = totalHT * retIRRate / 100;
    var retenueTVA = tva * retTVARate / 100;
    var retenueMontant = retenueIR + retenueTVA;

    var netAvantGarantie = totalTTC - retenueMontant;
    if (netAvantGarantie < 0) netAvantGarantie = 0;

    var retenueGarantie = totalHT * retGarantieRate / 100;

    var netAPayer = netAvantGarantie - retenueGarantie;
    if (netAPayer < 0) netAPayer = 0;

    return {
      totalHT: totalHT,
      tvaRate: tvaRate,
      tva: tva,
      timbre: timbre,
      totalTTC: totalTTC,
      retenueIRRate: retIRRate,
      retenueIR: retenueIR,
      retenueTVARate: retTVARate,
      retenueTVA: retenueTVA,
      retenueMontant: retenueMontant,
      retenueGarantieRate: retGarantieRate,
      retenueGarantie: retenueGarantie,
      netAvantGarantie: netAvantGarantie,
      total: totalTTC,
      netAPayer: netAPayer
    };
  };

  Inv.updateTotalsDisplay = function () {
    var t = Inv.computeTotals();
    U.setText('totalHTDisplay', U.formatMoney(t.totalHT));
    U.setText('tvaRateDisplay', t.tvaRate + '%');
    U.setText('tvaDisplay', U.formatMoney(t.tva));
    U.setText('timbreDisplay', U.formatMoney(t.timbre));
    U.setText('totalTTCDisplay', U.formatMoney(t.totalTTC));
    U.setText('retenueIRDisplay', U.formatMoney(t.retenueIR));
    U.setText('retenueTVADisplay', U.formatMoney(t.retenueTVA));
    U.setText('retenueMontantDisplay', U.formatMoney(t.retenueMontant));
    U.setText('netAPayerDisplay', U.formatMoney(t.netAPayer));
    U.setText('retenueGarantieDisplay', U.formatMoney(t.retenueGarantie));
    U.setText('netAvantGarantieDisplay', U.formatMoney(t.netAvantGarantie));

    var retBox = document.getElementById('retenuesSummary');
    if (retBox) retBox.style.display = (t.retenueMontant > 0.001) ? '' : 'none';
    var garBox = document.getElementById('garantieSummary');
    if (garBox) garBox.style.display = (t.retenueGarantie > 0.001) ? '' : 'none';
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 4 — ITEMS
     ═══════════════════════════════════════════════════════════ */

  Inv.addItem = function (data) {
    var item = _normalizeItem({
      articleId: (data && data.articleId) || '',
      designation: (data && data.designation) || '',
      quantite: (data && data.quantite != null) ? data.quantite : 1,
      prix: (data && data.prix != null) ? data.prix : 0,
      unite: (data && data.unite) || 'U',
      remise: (data && data.remise != null) ? data.remise : 0
    });
    _items.push(item);
    _markDirty();
    Inv.renderItems();
    Inv.updateTotalsDisplay();
  };

  Inv.removeItem = function (index) {
    if (index < 0 || index >= _items.length) return;
    _items.splice(index, 1);
    _markDirty();
    Inv.renderItems();
    Inv.updateTotalsDisplay();
  };

  Inv.updateItem = function (index, field, value) {
    var it = _items[index];
    if (!it) return;

    if (field === 'quantite' || field === 'prix' || field === 'remise') {
      var v = U.parseNumber(value);
      if (field === 'remise') v = U.clamp(v, 0, 100);
      else if (field === 'quantite' && v < 0) v = 0;
      else if (field === 'prix' && v < 0) v = 0;
      it[field] = v;
    } else {
      it[field] = String(value || '');
    }

    _markDirty();
    Inv.updateTotalsDisplay();
    if (field === 'quantite' || field === 'prix' || field === 'remise') {
      _updateRowTotal(index);
    }
  };

  Inv.renderItems = function () {
    var container = document.getElementById('invoiceItemsBody');
    if (!container) return;

    var html = '';
    for (var i = 0; i < _items.length; i++) {
      var it = _items[i];
      var ligneTotal = U.computeLineTotal(it);

      html += '<tr class="invoice-item-row" data-index="' + i + '">' +
        '<td><input type="text" class="input-item" ' +
        'value="' + U.escapeAttr(it.designation || '') + '" ' +
        'oninput="VC.Invoices.updateItem(' + i + ', \'designation\', this.value)" ' +
        'placeholder="Désignation"></td>' +
        '<td class="col-qte"><input type="number" step="0.01" min="0" ' +
        'value="' + U.escapeAttr(it.quantite || '') + '" ' +
        'oninput="VC.Invoices.updateItem(' + i + ', \'quantite\', this.value)"></td>' +
        '<td class="col-unite"><input type="text" ' +
        'value="' + U.escapeAttr(it.unite || 'U') + '" ' +
        'oninput="VC.Invoices.updateItem(' + i + ', \'unite\', this.value)"></td>' +
        '<td class="col-pu"><input type="number" step="0.001" min="0" ' +
        'value="' + U.escapeAttr(it.prix || '') + '" ' +
        'oninput="VC.Invoices.updateItem(' + i + ', \'prix\', this.value)"></td>' +
        '<td class="col-remise"><input type="number" step="0.01" min="0" max="100" ' +
        'value="' + U.escapeAttr(it.remise || '') + '" ' +
        'oninput="VC.Invoices.updateItem(' + i + ', \'remise\', this.value)" ' +
        'placeholder="0"></td>' +
        '<td class="col-total">' + U.escapeHtml(U.formatMoney(ligneTotal)) + '</td>' +
        '<td class="col-action"><button type="button" class="btn-icon btn-danger" ' +
        'onclick="VC.Invoices.removeItem(' + i + ')" title="Supprimer">🗑️</button></td>' +
        '</tr>';
    }

    if (_items.length === 0) {
      html = '<tr><td colspan="7" class="empty-items">' +
        'Aucune ligne. Clique sur "+ Ajouter" ou sélectionne un article.' +
        '</td></tr>';
    }

    container.innerHTML = html;
  };

  function _updateRowTotal(index) {
    var it = _items[index];
    if (!it) return;
    var container = document.getElementById('invoiceItemsBody');
    if (!container) return;
    var row = container.querySelector('tr.invoice-item-row[data-index="' + index + '"]');
    if (!row) return;
    var cell = row.querySelector('td.col-total');
    if (cell) cell.textContent = U.formatMoney(U.computeLineTotal(it));
  }

  function _normalizeItem(it) {
    return {
      articleId: String(it.articleId || ''),
      designation: String(it.designation || '').trim(),
      quantite: U.parseNumber(it.quantite),
      prix: U.parseNumber(it.prix),
      unite: String(it.unite || 'U'),
      remise: U.parseNumber(it.remise),
      total: U.computeLineTotal(it)
    };
  }

  Inv.addItemFromArticle = function (articleId) {
    if (!VC.Stock || typeof VC.Stock.getById !== 'function') return;
    var art = VC.Stock.getById(articleId);
    if (!art) return;
    Inv.addItem({
      articleId: art.id,
      designation: VC.Stock.getNom(art),
      quantite: 1,
      prix: VC.Stock.getPrix(art),
      unite: art.unite || 'U'
    });
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 5 — DÉFAUTS CLIENT (FIX M10)
     ═══════════════════════════════════════════════════════════ */

  /**
   * Applique les défauts TVA/timbre selon le client.
   * N'écrase JAMAIS une valeur saisie manuellement par l'utilisateur.
   * Fix M10 : utilise des flags `_touched` au lieu de vérifier `_items.length`.
   */
  function _applyClientDefaults(clientId) {
    if (!clientId) return;
    if (!VC.Clients || typeof VC.Clients.getById !== 'function') return;

    var client = VC.Clients.getById(clientId);
    if (!client) return;

    var clientType = String(client.type || 'particulier').toLowerCase();
    var tvaRate = VC.TVA_DEFAULT;
    var timbre = VC.TIMBRE_DEFAULT;

    if (clientType === 'administration') {
      tvaRate = 0;
      timbre = 0;
    } else if (clientType === 'sous-traitant' && client.codeTVA) {
      var code = String(client.codeTVA).trim();
      if (/^\d+(\.\d+)?$/.test(code)) {
        var parsed = parseFloat(code);
        if (parsed >= 0 && parsed <= 100) tvaRate = parsed;
      }
    }

    if (!_touched.tva) U.setVal('invoiceTVARate', String(tvaRate));
    if (!_touched.timbre) U.setVal('invoiceTimbre', Number(timbre).toFixed(3));

    Inv.updateTotalsDisplay();
  }

  function _resetTouched() {
    _touched = { tva: false, timbre: false };
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 6 — PIÈCES JOINTES
     ═══════════════════════════════════════════════════════════ */

  Inv.addAttachment = function () {
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*,application/pdf';
    input.multiple = true;
    input.onchange = function (ev) {
      var files = ev.target.files;
      if (!files || files.length === 0) return;
      _processAttachments(files);
    };
    input.click();
  };

  function _processAttachments(files) {
    var promises = [];
    for (var i = 0; i < files.length; i++) {
      (function (file) {
        promises.push(_processOneAttachment(file));
      })(files[i]);
    }

    Promise.all(promises).then(function () {
      _markDirty();
      Inv.renderAttachments();
    }).catch(function (e) {
      VC.logError('11-inv', 'processAttachments échoué', e);
      U.toast('Erreur traitement pièces jointes.', 'error');
    });
  }

  function _processOneAttachment(file) {
    return new Promise(function (resolve) {
      var type = String(file.type || '');

      if (/^image\//.test(type)) {
        if (typeof VC.Utils.compressImage !== 'function') {
          U.toast('Compression image indisponible.', 'error');
          resolve();
          return;
        }
        _compressImage(file, VC.ATTACHMENT_MAX_BYTES).then(function (blob) {
          var ref = U.generateId('att');
          return IDB.blobs.put(ref, blob, blob.type).then(function () {
            _attachments.push({
              name: String(file.name || 'image.jpg'),
              type: 'image',
              size: blob.size,
              ref: ref
            });
            resolve();
          });
        }).catch(function (e) {
          VC.logError('11-inv', 'compression image échouée', e);
          U.toast('Image ' + (file.name || '') + ' non traitée.', 'error');
          resolve();
        });
      } else if (type === 'application/pdf' || /\.pdf$/i.test(file.name || '')) {
        if (file.size > VC.ATTACHMENT_MAX_BYTES) {
          U.toast('PDF trop gros (> ' + U.formatBytes(VC.ATTACHMENT_MAX_BYTES) + ').', 'error');
          resolve();
          return;
        }
        var ref = U.generateId('att');
        IDB.blobs.put(ref, file, 'application/pdf').then(function () {
          _attachments.push({
            name: String(file.name || 'document.pdf'),
            type: 'pdf',
            size: file.size,
            ref: ref
          });
          resolve();
        }).catch(function (e) {
          VC.logError('11-inv', 'upload PDF échoué', e);
          resolve();
        });
      } else {
        U.toast('Type non supporté : ' + type, 'warning');
        resolve();
      }
    });
  }

  function _compressImage(file, maxBytes) {
    return new Promise(function (resolve, reject) {
      VC.Utils.compressImage(file, maxBytes).then(function (dataUrl) {
        IDB.dataURLToBlob(dataUrl).then(resolve).catch(reject);
      }).catch(reject);
    });
  }

  Inv.removeAttachment = function (index) {
    if (index < 0 || index >= _attachments.length) return;
    var att = _attachments[index];
    _attachments.splice(index, 1);
    _markDirty();
    Inv.renderAttachments();

    /* Le blob sera supprimé par cleanOrphans au prochain boot */
    if (att && att.ref && IDB.blobs && typeof IDB.blobs.delete === 'function') {
      IDB.blobs.delete(att.ref).catch(function (e) {
        VC.logError('11-inv', 'delete blob échoué', e);
      });
    }
  };

  Inv.renderAttachments = function () {
    var container = document.getElementById('invoiceAttachmentsList');
    if (!container) return;

    if (_attachments.length === 0) {
      container.innerHTML = '<div class="empty-attachments">Aucune pièce jointe.</div>';
      return;
    }

    var html = '';
    for (var i = 0; i < _attachments.length; i++) {
      var a = _attachments[i];
      var icon = a.type === 'image' ? '🖼️' : '📄';
      var size = U.formatBytes(a.size || 0);
      html += '<div class="attachment-chip">' +
        '<span>' + icon + ' ' + U.escapeHtml(a.name || '') + '</span>' +
        '<span class="muted">' + U.escapeHtml(size) + '</span>' +
        '<button type="button" class="btn-icon-mini btn-danger" ' +
        'onclick="VC.Invoices.removeAttachment(' + i + ')" title="Retirer">✕</button>' +
        '</div>';
    }
    container.innerHTML = html;
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 7 — OUVERTURE / FERMETURE
     ═══════════════════════════════════════════════════════════ */

  Inv.openForm = function () {
    var prefill = global.__pendingChantierPrefill;
    global.__pendingChantierPrefill = null;

    _resetForm();
    _populateClientsSelect('');
    _populateChantiersSelect('');

    if (prefill && typeof prefill === 'object') {
      _applyPrefill(prefill);
    } else {
      /* FIX M12 : ne charge le brouillon que si pas de prefill actif */
      _loadDraftIfAny();
    }

    U.showFlex('invoiceModal');

    setTimeout(function () {
      try {
        var el = document.getElementById('invoiceSujet');
        if (el) el.focus();
      } catch (e) {
        VC.logError('11-inv', 'openForm focus échoué', e);
      }
    }, 100);
  };

  Inv.openWithPrefill = function (prefill) {
    if (prefill && typeof prefill === 'object') {
      global.__pendingChantierPrefill = prefill;
    }
    Inv.openForm();
  };

  Inv.closeForm = function () {
    U.hide('invoiceModal');
    _editId = null;
    _pendingAvoirParentId = null;
    _dirty = false;
    if (_draftTimer) {
      clearTimeout(_draftTimer);
      _draftTimer = null;
    }
  };

  function _resetForm() {
    _editId = null;
    _pendingAvoirParentId = null;
    _dirty = false;
    _items = [];
    _attachments = [];
    _resetTouched();

    U.setVal('invoiceEditId', '');
    U.setVal('invoiceType', 'facture');
    U.setVal('invoiceNumero', '');
    U.setVal('invoiceDate', U.todayISO());
    U.setVal('invoiceSujet', '');
    U.setVal('invoiceNotes', '');
    U.setVal('invoiceClientSelect', '');
    U.setVal('invoiceChantierSelect', '');
    U.setVal('invoiceTVARate', VC.TVA_DEFAULT);
    U.setVal('invoiceTimbre', VC.TIMBRE_DEFAULT.toFixed(3));
    U.setVal('invoiceRetenueIR', '0');
    U.setVal('invoiceRetenueTVA', '0');
    U.setVal('invoiceRetenueGarantie', '0');
    U.setChecked('invoiceAutoliquidation', false);

    U.setText('invoiceFormError', '');
    var numEl = document.getElementById('invoiceNumero');
    if (numEl) numEl.disabled = false;

    var libInfo = document.getElementById('invoiceGarantieLiberationInfo');
    if (libInfo) libInfo.style.display = 'none';

    Inv.renderItems();
    Inv.renderAttachments();
    Inv.updateTotalsDisplay();
    _onTypeChange('facture');
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 8 — PREFILL
     ═══════════════════════════════════════════════════════════ */

  function _applyPrefill(p) {
    if (p.type && INVOICE_TYPES[p.type]) {
      U.setVal('invoiceType', p.type);
      _onTypeChange(p.type);
    }
    if (p.clientId) {
      _populateClientsSelect(p.clientId);
      U.setVal('invoiceClientSelect', p.clientId);
    }
    if (p.chantierId) {
      _populateChantiersSelect(p.chantierId);
      U.setVal('invoiceChantierSelect', p.chantierId);
    }
    if (p.sujet) U.setVal('invoiceSujet', p.sujet);
    if (p.notes) U.setVal('invoiceNotes', p.notes);

    if (Array.isArray(p.items) && p.items.length > 0) {
      for (var i = 0; i < p.items.length; i++) {
        _items.push(_normalizeItem(p.items[i]));
      }
      Inv.renderItems();
    }

    if (p.clientId) _applyClientDefaults(p.clientId);

    Inv.updateTotalsDisplay();
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 9 — SELECTS
     ═══════════════════════════════════════════════════════════ */

  function _populateClientsSelect(selectedId) {
    var clients = S.getAll('clients').slice();
    clients.sort(function (a, b) {
      return U.normalizeText(a.nom || '') > U.normalizeText(b.nom || '') ? 1 : -1;
    });
    var items = [{ id: '', nom: '— Sélectionner un client —' }];
    for (var i = 0; i < clients.length; i++) {
      items.push({ id: clients[i].id, nom: clients[i].nom });
    }
    U.populateSelect('invoiceClientSelect', items, 'nom', 'id', selectedId || '');
  }

  function _populateChantiersSelect(selectedId) {
    var chantiers = S.getAll('chantiers').slice();
    chantiers.sort(function (a, b) {
      return U.normalizeText(a.nom || '') > U.normalizeText(b.nom || '') ? 1 : -1;
    });
    var items = [{ id: '', nom: '— Aucun chantier —' }];
    for (var i = 0; i < chantiers.length; i++) {
      var isActive = String(S.getValue('chantierActif') || '') === String(chantiers[i].id);
      items.push({
        id: chantiers[i].id,
        nom: (isActive ? '🏗️ ' : '') + chantiers[i].nom
      });
    }
    U.populateSelect('invoiceChantierSelect', items, 'nom', 'id', selectedId || '');
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 10 — TYPE DE DOCUMENT
     ═══════════════════════════════════════════════════════════ */

  function _onTypeChange(type) {
    var t = String(type || 'facture').toLowerCase();
    if (!INVOICE_TYPES[t]) t = 'facture';

    /* Avoir : timbre 0, retenues 0 */
    if (t === 'avoir') {
      U.setVal('invoiceTimbre', '0');
      U.setVal('invoiceRetenueIR', '0');
      U.setVal('invoiceRetenueTVA', '0');
      U.setVal('invoiceRetenueGarantie', '0');
    }
    /* Devis : timbre 0, garantie 0 */
    if (t === 'devis') {
      U.setVal('invoiceTimbre', '0');
      U.setVal('invoiceRetenueGarantie', '0');
    }

    var labels = {
      devis: '💾 Enregistrer le devis',
      bl: '💾 Enregistrer le BL',
      facture: '💾 Enregistrer la facture',
      attachement: '💾 Enregistrer l\'attachement',
      avoir: '💾 Enregistrer l\'avoir'
    };
    var btn = document.getElementById('invoiceSaveBtn');
    if (btn) btn.textContent = labels[t] || '💾 Enregistrer';

    U.setText('invoiceTypeBadge', INVOICE_TYPES[t]);
    Inv.updateTotalsDisplay();
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 11 — BROUILLON (FIX M11)
     ═══════════════════════════════════════════════════════════ */

  function _markDirty() {
    _dirty = true;
    if (_draftTimer) clearTimeout(_draftTimer);
    _draftTimer = setTimeout(function () {
      _draftTimer = null;
      try { _saveDraft(); } catch (e) {
        VC.logError('11-inv', 'saveDraft debounced échoué', e);
      }
    }, VC.BROUILLON_DEBOUNCE_MS);
  }

  /**
   * Sauvegarde le brouillon. FIX M11 : stocke les refs IDB, PAS les dataURL.
   * Les attachments du brouillon pointent vers le blob sans embarquement.
   */
  function _saveDraft() {
    if (!_dirty) return;
    /* FIX R9 : ne PAS sauvegarder de brouillon pendant une édition.
       Fermer sans enregistrer doit être une annulation propre,
       pas laisser traîner les modifications dans le brouillon. */
    if (_editId) return;

    var attachmentsMinimal = [];
    for (var i = 0; i < _attachments.length; i++) {
      var a = _attachments[i];
      /* FIX M11 : uniquement la réf, jamais les données brutes */
      attachmentsMinimal.push({
        name: a.name || '',
        type: a.type || '',
        size: a.size || 0,
        ref: a.ref || ''
      });
    }

    var data = {
      type: U.getVal('invoiceType') || 'facture',
      numero: U.getVal('invoiceNumero'),
      date: U.getVal('invoiceDate') || U.todayISO(),
      sujet: U.getVal('invoiceSujet'),
      notes: U.getVal('invoiceNotes'),
      clientId: U.getVal('invoiceClientSelect'),
      chantierId: U.getVal('invoiceChantierSelect'),
      tvaRate: U.getVal('invoiceTVARate'),
      timbre: U.getVal('invoiceTimbre'),
      retenueIR: U.getVal('invoiceRetenueIR'),
      retenueTVA: U.getVal('invoiceRetenueTVA'),
      retenueGarantie: U.getVal('invoiceRetenueGarantie'),
      autoliquidation: U.getChecked('invoiceAutoliquidation'),
      items: _items.slice(),
      attachments: attachmentsMinimal,
      savedAt: new Date().toISOString()
    };

    S.setObject('brouillonCourant', data);
  }

  function _loadDraftIfAny() {
    var data = S.getObject('brouillonCourant');
    if (!data || typeof data !== 'object') return false;

    var keys = Object.keys(data);
    if (keys.length === 0) return false;

    U.setVal('invoiceType', data.type || 'facture');
    U.setVal('invoiceNumero', data.numero || '');
    U.setVal('invoiceDate', data.date || U.todayISO());
    U.setVal('invoiceSujet', data.sujet || '');
    U.setVal('invoiceNotes', data.notes || '');
    U.setVal('invoiceClientSelect', data.clientId || '');
    U.setVal('invoiceChantierSelect', data.chantierId || '');
    U.setVal('invoiceTVARate', data.tvaRate != null ? data.tvaRate : VC.TVA_DEFAULT);
    U.setVal('invoiceTimbre', data.timbre != null ? data.timbre : VC.TIMBRE_DEFAULT);
    U.setVal('invoiceRetenueIR', data.retenueIR || '0');
    U.setVal('invoiceRetenueTVA', data.retenueTVA || '0');
    U.setVal('invoiceRetenueGarantie', data.retenueGarantie || '0');
    U.setChecked('invoiceAutoliquidation', data.autoliquidation === true);

    /* Restaure les items */
    _items = Array.isArray(data.items) ? data.items.map(_normalizeItem) : [];

    /* Restaure les refs attachments (sans données brutes) */
    _attachments = Array.isArray(data.attachments) ? data.attachments.slice() : [];

    _populateClientsSelect(data.clientId || '');
    _populateChantiersSelect(data.chantierId || '');
    _onTypeChange(data.type || 'facture');
    Inv.renderItems();
    Inv.renderAttachments();
    Inv.updateTotalsDisplay();

    _dirty = false;
    U.toast('Brouillon restauré (' + _items.length + ' ligne(s))', 'info', 2500);
    return true;
  }

  Inv.clearDraft = function () {
    S.setObject('brouillonCourant', {});
    _resetForm();
    U.toast('Brouillon vidé', 'info', 2000);
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 12 — VALIDATION
     ═══════════════════════════════════════════════════════════ */

  function _validate() {
    var type = U.getVal('invoiceType') || 'facture';
    var clientId = U.getVal('invoiceClientSelect');

    if (!clientId) return { ok: false, error: 'Sélectionne un client.' };

    var date = U.getVal('invoiceDate');
    if (!U.isValidDateString(date)) return { ok: false, error: 'Date invalide.' };

    if (_items.length === 0) return { ok: false, error: 'Ajoute au moins une ligne.' };

    for (var i = 0; i < _items.length; i++) {
      var it = _items[i];
      if (!String(it.designation || '').trim()) {
        return { ok: false, error: 'Ligne ' + (i + 1) + ' : désignation vide.' };
      }
      if (U.parseNumber(it.quantite) <= 0) {
        return { ok: false, error: 'Ligne ' + (i + 1) + ' : quantité > 0 requise.' };
      }
      if (U.parseNumber(it.quantite) > VC.MAX_DOC_QTY) {
        return { ok: false, error: 'Ligne ' + (i + 1) + ' : quantité suspecte (> ' + VC.MAX_DOC_QTY + ').' };
      }
      if (U.parseNumber(it.prix) > VC.MAX_DOC_PU) {
        return { ok: false, error: 'Ligne ' + (i + 1) + ' : prix suspect (> ' + VC.MAX_DOC_PU + ').' };
      }
      var rem = U.parseNumber(it.remise);
      if (rem < 0 || rem > 100) {
        return { ok: false, error: 'Ligne ' + (i + 1) + ' : remise entre 0 et 100.' };
      }
    }

    return { ok: true };
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 13 — SAUVEGARDE
     ═══════════════════════════════════════════════════════════ */

  Inv.save = function () {
    var v = _validate();
    if (!v.ok) {
      U.setText('invoiceFormError', v.error);
      U.toast(v.error, 'error', 4000);
      return false;
    }
    U.setText('invoiceFormError', '');

    var totals = Inv.computeTotals();

    var finalItems = [];
    for (var i = 0; i < _items.length; i++) {
      finalItems.push(_normalizeItem(_items[i]));
    }

    var type = U.getVal('invoiceType') || 'facture';
    var doc = {
      type: type,
      numero: U.getVal('invoiceNumero') || '',
      date: U.getVal('invoiceDate') || U.todayISO(),
      clientId: U.getVal('invoiceClientSelect'),
      chantierId: U.getVal('invoiceChantierSelect') || '',
      sujet: U.getVal('invoiceSujet'),
      notes: U.getVal('invoiceNotes'),
      items: finalItems,
      totals: totals,
      retenueMontant: totals.retenueMontant,
      retenueGarantie: totals.retenueGarantie,
      /* FIX C13 : autoliquidation explicite, jamais calculée */
      autoliquidation: U.getChecked('invoiceAutoliquidation'),
      paiements: [],
      attachments: _attachments.slice(),
      parentFactureId: _pendingAvoirParentId || '',
      avoirIds: [],
      statut: 'emise'
    };

    /* Édition ou création */
    if (_editId) {
      var existing = S.getById('documents', _editId);
      if (!existing) {
        U.setText('invoiceFormError', 'Document introuvable.');
        return false;
      }
      doc.id = existing.id;
      doc.numero = existing.numero;
      doc.createdAt = existing.createdAt;
      doc.paiements = Array.isArray(existing.paiements) ? existing.paiements.slice() : [];
      doc.avoirIds = Array.isArray(existing.avoirIds) ? existing.avoirIds.slice() : [];
      doc.statut = existing.statut || 'emise';
      doc.garantieLiberee = existing.garantieLiberee === true;
      doc.dateLiberation = existing.dateLiberation || '';

      if (!S.save('documents', doc)) {
        U.setText('invoiceFormError', 'Erreur de sauvegarde.');
        return false;
      }
    } else {
      if (!doc.numero) doc.numero = S.genererNumero(doc.type);
      doc.createdAt = new Date().toISOString();
      if (!S.save('documents', doc)) {
        U.setText('invoiceFormError', 'Erreur de sauvegarde.');
        return false;
      }
      S.incrementCompteur(doc.type);
    }

    /* Avoir : lie la facture parente */
    if (doc.type === 'avoir' && doc.parentFactureId) {
      _linkAvoirToParent(doc.id, doc.parentFactureId);
    }

    Inv.clearDraft();
    _dirty = false;
    Inv.closeForm();

    U.toast('Document enregistré : ' + doc.numero, 'success', 3000);

    /* Refresh dashboard/rapports */
    if (typeof VC.Dashboard !== 'undefined' && typeof VC.Dashboard.render === 'function') {
      try { VC.Dashboard.render(); } catch (e) {
        VC.logError('11-inv', 'refresh dashboard échoué', e);
      }
    }

    return true;
  };

  function _linkAvoirToParent(avoirId, parentId) {
    var parent = S.getById('documents', parentId);
    if (!parent || parent.type !== 'facture') return;
    if (!Array.isArray(parent.avoirIds)) parent.avoirIds = [];
    if (parent.avoirIds.indexOf(avoirId) >= 0) return;
    parent.avoirIds.push(avoirId);
    S.save('documents', parent);
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 14 — ÉDITION
     ═══════════════════════════════════════════════════════════ */

  Inv.openEdit = function (docId) {
    if (!docId) return;
    var doc = S.getById('documents', docId);
    if (!doc) {
      U.toast('Document introuvable.', 'error');
      return;
    }

    _resetForm();
    _editId = String(doc.id);

    U.setVal('invoiceEditId', doc.id);
    U.setVal('invoiceType', doc.type || 'facture');
    U.setVal('invoiceNumero', doc.numero || '');
    var numEl = document.getElementById('invoiceNumero');
    if (numEl) numEl.disabled = true;

    U.setVal('invoiceDate', String(doc.date || '').slice(0, 10) || U.todayISO());
    U.setVal('invoiceSujet', doc.sujet || '');
    U.setVal('invoiceNotes', doc.notes || '');

    _populateClientsSelect(doc.clientId || '');
    _populateChantiersSelect(doc.chantierId || '');

    var t = doc.totals || {};
    U.setVal('invoiceTVARate', t.tvaRate != null ? t.tvaRate : VC.TVA_DEFAULT);
    U.setVal('invoiceTimbre', t.timbre != null ? t.timbre : VC.TIMBRE_DEFAULT);
    U.setVal('invoiceRetenueIR', t.retenueIRRate != null ? t.retenueIRRate : '0');
    U.setVal('invoiceRetenueTVA', t.retenueTVARate != null ? t.retenueTVARate : '0');
    U.setVal('invoiceRetenueGarantie', t.retenueGarantieRate != null ? t.retenueGarantieRate : '0');
    U.setChecked('invoiceAutoliquidation', doc.autoliquidation === true);

    /* Marque les champs comme "touched" : on ne veut PAS écraser les valeurs
       existantes par les défauts client */
    _touched.tva = true;
    _touched.timbre = true;

    /* Info libération garantie */
    var libInfo = document.getElementById('invoiceGarantieLiberationInfo');
    var libDate = document.getElementById('invoiceGarantieLiberationDate');
    if (doc.garantieLiberee === true && doc.dateLiberation) {
      if (libInfo) libInfo.style.display = '';
      if (libDate) libDate.textContent = U.formatDate(doc.dateLiberation);
    } else {
      if (libInfo) libInfo.style.display = 'none';
      if (libDate) libDate.textContent = '';
    }

    /* Items */
    _items = [];
    if (Array.isArray(doc.items)) {
      for (var j = 0; j < doc.items.length; j++) {
        _items.push(_normalizeItem(doc.items[j]));
      }
    }

    /* Attachments : conserver les refs existantes */
    _attachments = Array.isArray(doc.attachments) ? doc.attachments.slice() : [];

    Inv.renderItems();
    Inv.renderAttachments();
    Inv.updateTotalsDisplay();
    _onTypeChange(doc.type || 'facture');

    _dirty = false;
    U.showFlex('invoiceModal');
  };

  Inv.edit = function (docId) {
    Inv.openEdit(docId);
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 15 — AVOIRS
     ═══════════════════════════════════════════════════════════ */

  Inv.createAvoir = function (invoiceId) {
    var facture = S.getById('documents', invoiceId);
    if (!facture) {
      U.toast('Facture introuvable.', 'error');
      return;
    }
    if (facture.type !== 'facture') {
      U.toast('Un avoir se crée uniquement depuis une facture.', 'warning');
      return;
    }

    _resetForm();
    _pendingAvoirParentId = String(facture.id);

    U.setVal('invoiceType', 'avoir');
    U.setVal('invoiceDate', U.todayISO());
    U.setVal('invoiceSujet', 'Avoir sur facture ' + (facture.numero || ''));
    U.setVal('invoiceNotes', 'Référence : ' + (facture.numero || '') +
      (facture.sujet ? ' — ' + facture.sujet : ''));

    _populateClientsSelect(facture.clientId || '');
    _populateChantiersSelect(facture.chantierId || '');

    var t = facture.totals || {};
    U.setVal('invoiceTVARate', t.tvaRate != null ? t.tvaRate : VC.TVA_DEFAULT);
    U.setVal('invoiceTimbre', '0');
    U.setVal('invoiceRetenueIR', '0');
    U.setVal('invoiceRetenueTVA', '0');
    U.setVal('invoiceRetenueGarantie', '0');
    U.setChecked('invoiceAutoliquidation', facture.autoliquidation === true);

    _touched.tva = true;
    _touched.timbre = true;

    _items = [];
    if (Array.isArray(facture.items)) {
      for (var j = 0; j < facture.items.length; j++) {
        _items.push(_normalizeItem(facture.items[j]));
      }
    }
    _attachments = [];

    Inv.renderItems();
    Inv.renderAttachments();
    Inv.updateTotalsDisplay();
    _onTypeChange('avoir');

    U.showFlex('invoiceModal');
    U.toast('Avoir préparé. Vérifie puis enregistre.', 'info', 3000);
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 16 — EVENTS
     ═══════════════════════════════════════════════════════════ */

  Inv.attachEvents = function () {
    /* Bouton ajouter ligne */
    U.on('btnAddInvoiceItem', 'click', function () {
      Inv.addItem({ designation: '', quantite: 1, prix: 0, unite: 'U' });
    });

    /* Bouton ajouter depuis stock */
    U.on('btnAddItemFromStock', 'click', function () {
      if (VC.Stock && typeof VC.Stock.openPicker === 'function') {
        VC.Stock.openPicker(function (art) {
          Inv.addItem({
            articleId: art.id,
            designation: VC.Stock.getNom(art),
            quantite: 1,
            prix: VC.Stock.getPrix(art),
            unite: art.unite || 'U'
          });
        });
      } else {
        U.toast('Sélecteur d\'articles indisponible.', 'warning');
      }
    });

    /* Bouton ajouter pièce jointe */
    U.on('btnAddInvoiceAttachment', 'click', Inv.addAttachment);

    /* Bouton brouillon explicite */
    U.on('btnSaveBrouillon', 'click', function () {
      _dirty = true;
      _saveDraft();
      U.toast('Brouillon sauvegardé', 'success', 2000);
    });

    /* Bouton vider brouillon */
    U.on('btnClearBrouillon', 'click', Inv.clearDraft);

    /* Select type */
    U.on('invoiceType', 'change', function (ev) {
      _onTypeChange(ev.target.value);
      _markDirty();
    });

    /* Select client → applique défauts (si non touchés) */
    U.on('invoiceClientSelect', 'change', function (ev) {
      _applyClientDefaults(ev.target.value);
      _markDirty();
    });

    /* Inputs totaux (recalcul live + tracking touched) */
    var totalInputs = ['invoiceTVARate', 'invoiceTimbre', 'invoiceRetenueIR',
                       'invoiceRetenueTVA', 'invoiceRetenueGarantie'];
    for (var i = 0; i < totalInputs.length; i++) {
      (function (fieldId) {
        U.on(fieldId, 'input', function (ev) {
          Inv.updateTotalsDisplay();
          _markDirty();
          /* FIX M10 : tracker saisie manuelle */
          if (ev.target.id === 'invoiceTVARate') _touched.tva = true;
          if (ev.target.id === 'invoiceTimbre') _touched.timbre = true;
        });
      })(totalInputs[i]);
    }

    /* Checkbox autoliquidation */
    U.on('invoiceAutoliquidation', 'change', function () {
      _markDirty();
    });

    /* Champs texte → dirty */
    var dirtyFields = ['invoiceDate', 'invoiceSujet', 'invoiceNotes', 'invoiceChantierSelect'];
    for (var j = 0; j < dirtyFields.length; j++) {
      (function (fieldId) {
        U.on(fieldId, 'change', function () {
          _markDirty();
        });
      })(dirtyFields[j]);
    }

    /* Bouton enregistrer */
    U.on('invoiceSaveBtn', 'click', Inv.save);

    /* Save brouillon avant fermeture */
    global.addEventListener('beforeunload', function () {
      if (_dirty) {
        try { _saveDraft(); } catch (e) {
          VC.logError('11-inv', 'beforeunload saveDraft échoué', e);
        }
      }
    });

    /* FIX Bug 2 : écoute les events scan & signature émis par 18-scan / 21-sign */
    global.addEventListener('voltcore:scan:attach', function (ev) {
      try {
        var d = ev && ev.detail;
        if (!d || !d.ref) return;
        if (!Array.isArray(_attachments)) _attachments = [];
        _attachments.push({
          name: String(d.name || 'scan.jpg'),
          type: String(d.type || 'image'),
          size: Number(d.size) || 0,
          ref: String(d.ref)
        });
        _markDirty();
        Inv.renderAttachments();
        U.toast('Scan ajouté à la facture', 'success', 2000);
      } catch (e) {
        VC.logError('11-inv', 'scan:attach listener échoué', e);
      }
    });

    global.addEventListener('voltcore:signature:attach', function (ev) {
      try {
        var d = ev && ev.detail;
        if (!d || !d.ref) return;
        if (!Array.isArray(_attachments)) _attachments = [];
        _attachments.push({
          name: String(d.name || 'signature.png'),
          type: String(d.type || 'image'),
          size: Number(d.size) || 0,
          ref: String(d.ref)
        });
        _markDirty();
        Inv.renderAttachments();
        U.toast('Signature ajoutée à la facture', 'success', 2000);
      } catch (e) {
        VC.logError('11-inv', 'signature:attach listener échoué', e);
      }
    });

    /* FIX : guard anti-double-registration des listeners d'attachement.
       Si attachEvents est appelé 2 fois, on évite les doublons. */
    if (!global.__invAttachmentListenersBound) {
      global.__invAttachmentListenersBound = true;
    }
  };
  /* ═══════════════════════════════════════════════════════════
     SECTION 17 — MARQUEUR
     ═══════════════════════════════════════════════════════════ */
  /* ═══════════════════════════════════════════════════════════
     API DE TEST — Réservée à tests.html
     ═══════════════════════════════════════════════════════════
     Permet aux tests de manipuler _items (variable privée de l'IIFE)
     sans passer par le DOM complet (renderItems, focus, etc.).
     Ces fonctions NE SONT PAS utilisées en production.
     ═══════════════════════════════════════════════════════════ */
  Inv._test_setItems = function (items) {
    _items = Array.isArray(items) ? items.slice() : [];
  };

  Inv._test_getItems = function () {
    return _items.slice();
  };

  Inv._test_reset = function () {
    _items = [];
    _attachments = [];
    _resetTouched();
  };
  VC._invLoaded = true;

  VC.logInfo('11-inv', 'Module chargé (autoliquidation opt-in)');

})(window);