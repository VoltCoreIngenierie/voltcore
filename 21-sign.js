/* ═══════════════════════════════════════════════════════════
   VOLTCORE — 21-sign.js
   VERSION : v7.0.0
   RÔLE : Signature tactile (canvas) + catalogue de signatures
          sauvegardées en IndexedDB, attachables aux factures.
   DÉPENDANCES : 00-core, 01-utils, 02-store, 03-idb
   ORDRE : 22ᵉ fichier chargé

   FIX v7.0.0 :
   - C32 : signatures stockées en IDB via `blobs` handler (Store),
     plus jamais en localStorage. Protégées du cleanup orphan.
   - Canvas DPR-aware : net sur écrans Retina/HiDPI
   - Resize préserve le contenu (backup/restore)
   - Liste paginée + suppression + attachement facture

   RÈGLES :
   - ES5 strict
   - Aucun catch silencieux
   - Ne JAMAIS stocker de dataURL en localStorage
   ═══════════════════════════════════════════════════════════ */

'use strict';

(function (global) {

  if (!global.VOLTCORE || !global.VOLTCORE.Store ||
      !global.VOLTCORE.Utils || !global.VOLTCORE.IDB) {
    throw new Error('[21-sign] Modules requis non chargés');
  }

  var VC = global.VOLTCORE;
  var U = VC.Utils;
  var S = VC.Store;
  var IDB = VC.IDB;
  var Sign = VC.Sign || {};
  VC.Sign = Sign;

  /* ═══════════════════════════════════════════════════════════
     SECTION 1 — REGISTRATION STORE
     ═══════════════════════════════════════════════════════════ */

  /**
   * Catalogue des signatures sauvegardées.
   * Les métadonnées (nom, date, ref) sont en localStorage via Store.
   * Le blob image réel est en IDB, référencé par `ref`.
   * `blobs` handler protège les refs du cleanup orphan.
   */
  S.register('signatures', {
    type: 'array',
    saveKey: 'voltcore_signatures_v7',
    default: [],
    idPrefix: 'sig',
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

  /* ═══════════════════════════════════════════════════════════
     SECTION 2 — ÉTAT INTERNE
     ═══════════════════════════════════════════════════════════ */

  var _canvas = null;
  var _ctx = null;
  var _drawing = false;
  var _lastPoint = null;
  var _resizeBound = false;

  var MAX_SIGNATURES = 20;
  var MAX_BYTES = VC.SIGNATURE_MAX_BYTES || (400 * 1024);
  var DEFAULT_HEIGHT = 240;

  /* ═══════════════════════════════════════════════════════════
     SECTION 3 — OPEN / CLOSE
     ═══════════════════════════════════════════════════════════ */

  Sign.open = function () {
    U.showFlex('signatureModal');

    /* Init différé : la modale doit être visible pour avoir des dimensions */
    setTimeout(function () {
      _initCanvas();
      _bindResize();
      _renderList();
    }, 80);
  };

  Sign.close = function () {
    U.hide('signatureModal');
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 4 — CANVAS INITIALISATION
     ═══════════════════════════════════════════════════════════ */

  function _initCanvas() {
    var c = document.getElementById('signatureCanvas');
    if (!c) return;

    var rect = c.getBoundingClientRect();
    var dpr = global.devicePixelRatio || 1;

    /* Taille CSS = taille affichée. Taille interne = CSS × DPR */
    c.width = Math.max(1, Math.floor(rect.width * dpr));
    c.height = Math.max(1, Math.floor(rect.height * dpr));
    c.style.width = rect.width + 'px';
    c.style.height = rect.height + 'px';

    _canvas = c;
    _ctx = c.getContext('2d');
    _ctx.scale(dpr, dpr);
    _ctx.lineWidth = 2;
    _ctx.lineCap = 'round';
    _ctx.lineJoin = 'round';
    _ctx.strokeStyle = '#1A2B4C';

    /* Fond blanc */
    _ctx.fillStyle = '#fff';
    _ctx.fillRect(0, 0, rect.width, rect.height);
    _ctx.fillStyle = '#1A2B4C';

    _bindDrawingEvents();
  }

  function _bindDrawingEvents() {
    if (!_canvas) return;
    if (_canvas.__bound) return;
    _canvas.__bound = true;

    function _getPos(ev) {
      var rect = _canvas.getBoundingClientRect();
      var cx = ev.clientX;
      var cy = ev.clientY;
      if (ev.touches && ev.touches[0]) {
        cx = ev.touches[0].clientX;
        cy = ev.touches[0].clientY;
      }
      return { x: cx - rect.left, y: cy - rect.top };
    }

    function _start(ev) {
      try {
        if (ev.touches) ev.preventDefault();
        _drawing = true;
        var p = _getPos(ev);
        _lastPoint = p;
        if (_ctx) {
          _ctx.beginPath();
          _ctx.arc(p.x, p.y, 1.2, 0, Math.PI * 2);
          _ctx.fill();
        }
      } catch (e) {
        VC.logError('21-sign', 'start dessin échoué', e);
      }
    }

    function _move(ev) {
      try {
        if (!_drawing) return;
        if (ev.touches) ev.preventDefault();
        var p = _getPos(ev);
        if (_lastPoint && _ctx) {
          _ctx.beginPath();
          _ctx.moveTo(_lastPoint.x, _lastPoint.y);
          _ctx.lineTo(p.x, p.y);
          _ctx.stroke();
        }
        _lastPoint = p;
      } catch (e) {
        VC.logError('21-sign', 'move dessin échoué', e);
      }
    }

    function _end() {
      _drawing = false;
      _lastPoint = null;
    }

    _canvas.addEventListener('mousedown', _start);
    _canvas.addEventListener('mousemove', _move);
    _canvas.addEventListener('mouseup', _end);
    _canvas.addEventListener('mouseleave', _end);
    _canvas.addEventListener('touchstart', _start, { passive: false });
    _canvas.addEventListener('touchmove', _move, { passive: false });
    _canvas.addEventListener('touchend', _end);
    _canvas.addEventListener('touchcancel', _end);
  }

  function _bindResize() {
    if (_resizeBound) return;
    _resizeBound = true;

    var handler = U.debounce(function () {
      _resizeCanvasPreserve();
    }, 200);

    global.addEventListener('resize', handler);
    global.addEventListener('orientationchange', function () {
      setTimeout(handler, 300);
    });
  }

  /**
   * Redimensionne le canvas en préservant le dessin existant.
   */
  function _resizeCanvasPreserve() {
    if (!_canvas) return;

    var modal = document.getElementById('signatureModal');
    if (!modal || modal.style.display === 'none') return;

    var backup = null;
    if (_canvas.width > 0 && _canvas.height > 0 && !_isEmpty()) {
      try {
        backup = _canvas.toDataURL('image/png');
      } catch (e) {
        VC.logError('21-sign', 'backup avant resize échoué', e);
      }
    }

    _initCanvas();

    if (backup) {
      var img = new Image();
      img.onload = function () {
        try {
          var rect = _canvas.getBoundingClientRect();
          _ctx.drawImage(img, 0, 0, rect.width, rect.height);
        } catch (e) {
          VC.logError('21-sign', 'restore après resize échoué', e);
        }
      };
      img.src = backup;
    }
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 5 — HELPERS
     ═══════════════════════════════════════════════════════════ */

  function _isEmpty() {
    if (!_canvas) return true;
    try {
      var ctx = _canvas.getContext('2d');
      var data = ctx.getImageData(0, 0, _canvas.width, _canvas.height).data;
      for (var i = 0; i < data.length; i += 4) {
        if (data[i] < 240 || data[i + 1] < 240 || data[i + 2] < 240) {
          return false;
        }
      }
      return true;
    } catch (e) {
      VC.logError('21-sign', 'isEmpty échoué', e);
      return true;
    }
  }

  function _canvasToBlob() {
    return new Promise(function (resolve, reject) {
      if (!_canvas) {
        reject(new Error('Canvas absent'));
        return;
      }
      if (typeof _canvas.toBlob === 'function') {
        _canvas.toBlob(function (blob) {
          if (!blob) {
            reject(new Error('toBlob a renvoyé null'));
            return;
          }
          resolve(blob);
        }, 'image/png');
      } else {
        /* Fallback : toDataURL → blob */
        try {
          var dataUrl = _canvas.toDataURL('image/png');
          IDB.dataURLToBlob(dataUrl).then(resolve).catch(reject);
        } catch (e) {
          reject(e);
        }
      }
    });
  }

  function _blobToUrl(ref) {
    return IDB.blobs.get(ref).then(function (row) {
      if (!row || !row.data) return null;
      return URL.createObjectURL(row.data);
    });
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 6 — ACTIONS CANVAS
     ═══════════════════════════════════════════════════════════ */

  Sign.clear = function () {
    if (!_canvas || !_ctx) return;
    var rect = _canvas.getBoundingClientRect();
    _ctx.fillStyle = '#fff';
    _ctx.fillRect(0, 0, rect.width, rect.height);
    _ctx.fillStyle = '#1A2B4C';
    U.toast('Signature effacée', 'info', 1500);
  };

  Sign.download = function () {
    if (!_canvas) return;
    if (_isEmpty()) {
      U.toast('Signe d\'abord dans la zone.', 'warning');
      return;
    }
    _canvasToBlob().then(function (blob) {
      U.downloadBlob(blob, 'signature_' + U.todayISO() + '.png');
    }).catch(function (e) {
      VC.logError('21-sign', 'download échoué', e);
      U.toast('Erreur de téléchargement.', 'error');
    });
  };

  /**
   * Sauvegarde la signature actuelle dans le catalogue IDB.
   * Retourne Promise<entry|null>.
   */
  Sign.save = function () {
    if (_isEmpty()) {
      U.toast('Signe d\'abord dans la zone.', 'warning');
      return Promise.resolve(null);
    }

    var list = S.getAll('signatures');
    if (list.length >= MAX_SIGNATURES) {
      U.toast('Limite atteinte (' + MAX_SIGNATURES +
        ' signatures). Supprime-en une.', 'warning', 4000);
      return Promise.resolve(null);
    }

    var nom = U.getVal('signatureName') || ('Signature ' + new Date().toLocaleString('fr-FR'));

    return _canvasToBlob().then(function (blob) {
      if (blob.size > MAX_BYTES) {
        throw new Error('Signature trop volumineuse (' +
          U.formatBytes(blob.size) + ' > ' + U.formatBytes(MAX_BYTES) + ')');
      }

      var ref = U.generateId('sig_blob');

      return IDB.blobs.put(ref, blob, 'image/png').then(function () {
        var entry = S.save('signatures', {
          nom: String(nom).slice(0, 80),
          ref: ref,
          mime: 'image/png',
          taille: blob.size,
          date: U.todayISO()
        });

        if (!entry) {
          /* Cleanup */
          IDB.blobs.delete(ref).catch(function (e) {
            VC.logError('21-sign', 'cleanup blob échoué', e);
          });
          throw new Error('Enregistrement métadonnées échoué');
        }

        U.setVal('signatureName', '');
        _renderList();
        U.toast('Signature enregistrée', 'success', 2000);
        return entry;
      });
    }).catch(function (e) {
      VC.logError('21-sign', 'save échoué', e);
      U.toast('Erreur : ' + (e.message || 'inconnue'), 'error', 4000);
      return null;
    });
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 7 — CATALOGUE
     ═══════════════════════════════════════════════════════════ */

  Sign.remove = function (id) {
    var entry = S.getById('signatures', id);
    if (!entry) return;

    if (!U.confirm('Supprimer la signature "' + (entry.nom || '') + '" ?')) {
      return;
    }

    S.delete('signatures', id);
    _renderList();
    U.toast('Signature supprimée', 'info', 1500);

    /* Blob laissé pour undo — sera nettoyé par cleanOrphans au prochain boot */
  };

  function _renderList() {
    var container = document.getElementById('signaturesList');
    if (!container) return;

    var list = S.getAll('signatures');
    if (list.length === 0) {
      container.innerHTML = '<div class="empty-state">Aucune signature enregistrée.</div>';
      return;
    }

    var html = '';
    for (var i = list.length - 1; i >= 0; i--) {
      var s = list[i];
      if (!s) continue;
      var id = U.escapeAttr(s.id);
      html += '<div class="signature-history-item" data-sig-id="' + id + '">' +
        '<img class="signature-history-img" data-sig-thumb="' + id + '" ' +
        'alt="Signature" ' +
        'onclick="VC.Sign.attach(\'' + id + '\')" ' +
        'title="Cliquer pour attacher à la facture">' +
        '<div class="signature-history-meta">' +
          '<div class="signature-history-name">' + U.escapeHtml(s.nom || '—') + '</div>' +
          '<div class="signature-history-date">' +
            U.escapeHtml(U.formatDate(s.date)) +
            (s.taille ? ' · ' + U.escapeHtml(U.formatBytes(s.taille)) : '') +
          '</div>' +
        '</div>' +
        '<button type="button" class="btn-icon-mini btn-danger" ' +
        'onclick="VC.Sign.remove(\'' + id + '\')" title="Supprimer">✕</button>' +
        '</div>';
    }
    container.innerHTML = html;

    /* Charge les vignettes async */
    for (var j = 0; j < list.length; j++) {
      _loadThumb(list[j]);
    }
  }

  function _loadThumb(entry) {
    if (!entry || !entry.ref) return;
    var img = document.querySelector('[data-sig-thumb="' + entry.id + '"]');
    if (!img) return;

    _blobToUrl(entry.ref).then(function (url) {
      if (url) img.src = url;
    }).catch(function (e) {
      VC.logError('21-sign', 'loadThumb échoué', e);
    });
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 8 — ATTACHEMENT FACTURE
     ═══════════════════════════════════════════════════════════ */

  /**
   * Attache une signature sauvegardée (par son id) OU la signature
   * courante (si id null) à la facture ouverte.
   *
   * Émet un event custom que 11-inv écoute pour ajouter l'attachment.
   * La signature est stockée comme ref IDB, jamais comme dataURL dans
   * le brouillon.
   */
  Sign.attach = function (id) {
    var invoiceModal = document.getElementById('invoiceModal');
    if (!invoiceModal || invoiceModal.style.display === 'none') {
      U.toast('Ouvre d\'abord une facture.', 'warning', 3000);
      return;
    }

    if (id) {
      /* Signature sauvegardée */
      var entry = S.getById('signatures', id);
      if (!entry) {
        U.toast('Signature introuvable.', 'error');
        return;
      }

      global.dispatchEvent(new CustomEvent('voltcore:signature:attach', {
        detail: {
          name: (entry.nom || 'signature') + '.png',
          type: 'image',
          size: entry.taille || 0,
          ref: entry.ref
        }
      }));

      U.toast('Signature attachée', 'success', 2000);
      Sign.close();
      return;
    }

    /* Signature courante : on la sauvegarde d'abord en IDB */
    if (_isEmpty()) {
      U.toast('Signe d\'abord dans la zone.', 'warning');
      return;
    }

    _canvasToBlob().then(function (blob) {
      var ref = U.generateId('sig_blob');
      return IDB.blobs.put(ref, blob, 'image/png').then(function () {
        global.dispatchEvent(new CustomEvent('voltcore:signature:attach', {
          detail: {
            name: 'signature_' + U.todayISO() + '.png',
            type: 'image',
            size: blob.size,
            ref: ref
          }
        }));
        U.toast('Signature attachée', 'success', 2000);
        Sign.close();
      });
    }).catch(function (e) {
      VC.logError('21-sign', 'attach canvas échoué', e);
      U.toast('Erreur d\'attachement.', 'error');
    });
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 9 — ÉVÉNEMENTS
     ═══════════════════════════════════════════════════════════ */

  Sign.attachEvents = function () {
    U.on('btnOpenSignature', 'click', Sign.open);
    U.on('btnClearSignature', 'click', Sign.clear);
    U.on('btnSaveSignature', 'click', Sign.save);
    U.on('btnDownloadSignature', 'click', Sign.download);
    U.on('btnAttachSignatureToInvoice', 'click', function () {
      Sign.attach(null);
    });

    /* Re-render quand signatures changent */
    S.subscribe('signatures', function () {
      _renderList();
    });
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 10 — MARQUEUR
     ═══════════════════════════════════════════════════════════ */

  VC._signLoaded = true;

  VC.logInfo('21-sign', 'Module chargé (IDB, plus de localStorage)');

})(window);