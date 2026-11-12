/* ═══════════════════════════════════════════════════════════
   VOLTCORE — 18-scan.js
   VERSION : v7.0.7
   RÔLE : Orchestrateur du scanner.
          - Gestion caméra (start/stop/capture)
          - Import galerie
          - Manipulation des 4 coins
          - Aperçu LIVE du warp (debounced)
          - Rotation / Miroir / Undo
          - 4 modes (Document / Photo / Texte / Aucun)
          - Multi-pages
          - Délégation du traitement à 19-scan-cv / 20-scan-js
   DÉPENDANCES : 00-core, 01-utils, 17-docs
   ORDRE : 19ᵉ fichier chargé

   ARCHITECTURE :
   - Ce fichier = UI + orchestration
   - Traitement image = délégué à VC.ScanCV (OpenCV) ou VC.ScanJS
   - API delegate : process(sourceCanvas, opts) → Promise<canvas>
     opts = { corners: [{x,y}%×4], mode, rotation, mirrored }
   - Modes : 'document' (binarize) | 'photo' (enhance) | 'text' (accent) | 'none' (warp brut)

   RÈGLES :
   - ES5 strict
   - Aucun catch silencieux
   - Aucun accès direct à localStorage/IDB (délégué à VC.Documents)
   - Annulation possible via AbortController
   ═══════════════════════════════════════════════════════════ */

'use strict';

(function (global) {

  if (!global.VOLTCORE || !global.VOLTCORE.Utils || !global.VOLTCORE.Store) {
    throw new Error('[18-scan] Modules requis non chargés');
  }

  var VC = global.VOLTCORE;
  var U = VC.Utils;
  var Scan = VC.Scan || {};
  VC.Scan = Scan;

  /* ═══════════════════════════════════════════════════════════
     SECTION 1 — ÉTAT INTERNE
     ═══════════════════════════════════════════════════════════ */

  var _stream = null;
  var _originalDataUrl = null;       /* Image capturée brute */
  var _rawImage = null;              /* HTMLImageElement de l'originale */
  var _currentResultDataUrl = null;  /* Résultat après Apply (ou brute) */
  var _currentResultIsProcessed = false;
  var _corners = null;               /* [{x%, y%} × 4] : TL, TR, BR, BL */
  var _cornersWasSet = false;
  var _mode = 'document';
  var _rotation = 0;                 /* 0, 90, 180, 270 */
  var _mirrored = false;
  var _pages = [];                   /* [{dataUrl, mode, at}] */
  var _sessionTag = null;
  var _processing = false;
  var _previewTimer = null;
  var _dragState = null;
  var _abortCtrl = null;
  var _lastDetectedAt = 0;

  var MAX_PREVIEW_DIM = 500;         /* Preview live réduite pour fluidité */
  var DEBOUNCE_PREVIEW = 150;

  /* ═══════════════════════════════════════════════════════════
     SECTION 2 — HELPERS
     ═══════════════════════════════════════════════════════════ */

  function _cvAvailable() {
    return !!(global.__opencvReady && typeof global.cv !== 'undefined');
  }

  function _pickProcessor() {
    if (_cvAvailable() && VC.ScanCV && typeof VC.ScanCV.process === 'function') {
      return VC.ScanCV;
    }
    if (VC.ScanJS && typeof VC.ScanJS.process === 'function') {
      return VC.ScanJS;
    }
    return null;
  }

  function _loadImage(dataUrl) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error('Image illisible')); };
      img.src = dataUrl;
    });
  }

  function _imageToCanvas(img, maxDim) {
    var w = img.naturalWidth || img.width;
    var h = img.naturalHeight || img.height;

    if (maxDim && (w > maxDim || h > maxDim)) {
      var ratio = Math.min(maxDim / w, maxDim / h);
      w = Math.round(w * ratio);
      h = Math.round(h * ratio);
    }

    var c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    var ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);
    return c;
  }

  function _defaultCorners() {
    var inset = 3;
    return [
      { x: inset, y: inset },
      { x: 100 - inset, y: inset },
      { x: 100 - inset, y: 100 - inset },
      { x: inset, y: 100 - inset }
    ];
  }

  function _cornersToPixels(corners, imgW, imgH) {
    var out = [];
    for (var i = 0; i < 4; i++) {
      out.push({
        x: Math.round(corners[i].x / 100 * imgW),
        y: Math.round(corners[i].y / 100 * imgH)
      });
    }
    return out;
  }

  function _setProgress(pct, msg) {
    var bar = document.getElementById('scanProgressBar');
    if (bar) bar.style.width = Math.max(0, Math.min(100, pct)) + '%';

    var label = document.getElementById('scanProgressLabel');
    if (label && msg) label.textContent = msg;

    var wrap = document.getElementById('scanProgressWrap');
    if (wrap) {
      if (pct <= 0 || pct >= 100) {
        setTimeout(function () {
          if (wrap) wrap.style.display = 'none';
        }, pct >= 100 ? 600 : 0);
      } else {
        wrap.style.display = '';
      }
    }
  }

  function _setProcessing(active, msg) {
    _processing = active;
    var spin = document.getElementById('scanProcessingSpinner');
    if (spin) spin.style.display = active ? 'flex' : 'none';
    var txt = document.getElementById('scanProcessingMsg');
    if (txt && msg) txt.textContent = msg;
    _disableButtons(active);
  }

  function _disableButtons(disabled) {
    var ids = ['btnApplyScan', 'btnRotateScan', 'btnMirrorScan',
               'btnUndoScan', 'btnResetScanCorners', 'btnSaveScanToDocs',
               'btnAttachScanToInvoice', 'btnAddScanPage', 'btnSaveScanAll'];
    for (var i = 0; i < ids.length; i++) {
      var btn = document.getElementById(ids[i]);
      if (btn) btn.disabled = disabled;
    }
    var modeBtns = document.querySelectorAll('[data-scan-mode]');
    for (var j = 0; j < modeBtns.length; j++) {
      modeBtns[j].disabled = disabled;
    }
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 3 — OUVERTURE / FERMETURE
     ═══════════════════════════════════════════════════════════ */

  Scan.open = function () {
    _resetState();

    U.showFlex('scanModal');
    _showSection('camera');
    _renderPages();
    _updateModeButtons();
    _updateOpenCvBadge();
    _setProgress(0, '');

    _bindOnce();
  };

  Scan.close = function () {
    Scan.stopCamera();

    if (_abortCtrl) {
      try { _abortCtrl.abort(); } catch (e) {
        VC.logError('18-scan', 'abort échoué', e);
      }
      _abortCtrl = null;
    }

    U.hide('scanModal');
    _resetState();
  };

  function _resetState() {
    if (_previewTimer) {
      clearTimeout(_previewTimer);
      _previewTimer = null;
    }
    _originalDataUrl = null;
    _rawImage = null;
    _currentResultDataUrl = null;
    _currentResultIsProcessed = false;
    _corners = null;
    _cornersWasSet = false;
    _mode = 'document';
    _rotation = 0;
    _mirrored = false;
    _pages = [];
    _sessionTag = null;
    _processing = false;
    _dragState = null;

    /* FIX R15 : réinitialiser les libellés UI */
    U.setText('scanProgressLabel', '');
    U.setText('scanPageCounter', '');
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 4 — GESTION DES SECTIONS UI
     ═══════════════════════════════════════════════════════════ */

  function _showSection(name) {
    /* name: 'camera' | 'preview' | 'empty' */
    var cam = document.getElementById('scanVideoContainer');
    var prev = document.getElementById('scanPreviewContainer');
    var empty = document.getElementById('scanEmptyHint');
    var improveBar = document.getElementById('scanImproveBar');
    var pageBar = document.getElementById('scanPageBar');
    var actions = document.getElementById('scanMainActions');

    if (cam) cam.style.display = name === 'camera' ? '' : 'none';
    if (prev) prev.style.display = name === 'preview' ? '' : 'none';
    if (empty) empty.style.display = name === 'empty' ? '' : 'none';
    if (improveBar) improveBar.style.display = name === 'preview' ? '' : 'none';
    if (pageBar) pageBar.style.display = (_pages.length > 0 || name === 'preview') ? '' : 'none';
    if (actions) actions.style.display = name === 'empty' ? 'none' : '';

    var btnStart = document.getElementById('btnStartCamera');
    var btnStop = document.getElementById('btnStopCamera');
    var btnCapture = document.getElementById('btnCapturePhoto');
    if (btnStart) btnStart.style.display = name === 'camera' && !_stream ? '' : 'none';
    if (btnStop) btnStop.style.display = _stream ? '' : 'none';
    if (btnCapture) btnCapture.style.display = _stream ? '' : 'none';
  }

  function _updateOpenCvBadge() {
    var dot = document.getElementById('scanOpenCvDot');
    var text = document.getElementById('scanOpenCvText');
    if (!dot || !text) return;

    if (_cvAvailable()) {
      dot.style.background = '#2E8B57';
      text.textContent = 'OpenCV prêt (mode haute qualité)';
      text.style.color = '#2E8B57';
    } else if (typeof global.cv !== 'undefined') {
      dot.style.background = '#E8A33D';
      text.textContent = 'OpenCV en cours de chargement…';
      text.style.color = '#E8A33D';
    } else {
      dot.style.background = '#A88A32';
      text.textContent = 'Mode JS pur (OpenCV indisponible)';
      text.style.color = '#A88A32';
    }
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 5 — CAMÉRA
     ═══════════════════════════════════════════════════════════ */

  Scan.startCamera = function () {
    if (_stream) return Promise.resolve();

    if (!VC.device.camera) {
      U.toast('Caméra non disponible sur cet appareil.', 'error');
      return Promise.resolve();
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      U.toast('Navigateur trop ancien pour la caméra.', 'error');
      return Promise.resolve();
    }

    return navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1920 },
        height: { ideal: 1080 }
      },
      audio: false
    }).then(function (stream) {
      _stream = stream;
      var video = document.getElementById('scanVideo');
      if (video) {
        video.srcObject = stream;
        video.muted = true;
        video.playsInline = true;
        return video.play().catch(function (e) {
          VC.logError('18-scan', 'video.play échoué', e);
        });
      }
    }).then(function () {
      _showSection('camera');
    }).catch(function (e) {
      VC.logError('18-scan', 'startCamera échoué', e);
      U.toast('Accès caméra refusé ou indisponible.', 'error', 4000);
    });
  };

  Scan.stopCamera = function () {
    if (_stream) {
      try {
        var tracks = _stream.getTracks ? _stream.getTracks() : [];
        for (var i = 0; i < tracks.length; i++) {
          try { tracks[i].stop(); } catch (e) {
            VC.logError('18-scan', 'track.stop échoué', e);
          }
        }
      } catch (e) {
        VC.logError('18-scan', 'stopCamera échoué', e);
      }
      _stream = null;
    }
    var video = document.getElementById('scanVideo');
    if (video) {
      try { video.pause(); } catch (e) { /* silencieux */ }
      video.srcObject = null;
    }
    var btnStart = document.getElementById('btnStartCamera');
    var btnStop = document.getElementById('btnStopCamera');
    var btnCapture = document.getElementById('btnCapturePhoto');
    if (btnStart) btnStart.style.display = '';
    if (btnStop) btnStop.style.display = 'none';
    if (btnCapture) btnCapture.style.display = 'none';
  };

  Scan.capturePhoto = function () {
    if (!_stream) return;

    var video = document.getElementById('scanVideo');
    if (!video || !video.videoWidth) {
      U.toast('Caméra pas prête.', 'warning');
      return;
    }

    var canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);

    var dataUrl = canvas.toDataURL('image/jpeg', 0.92);
    Scan.stopCamera();
    _initPreview(dataUrl);
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 6 — GALERIE
     ═══════════════════════════════════════════════════════════ */

  Scan.importFromGallery = function () {
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = function (ev) {
      var f = ev.target.files && ev.target.files[0];
      if (!f) return;
      _processFile(f);
    };
    input.click();
  };

  function _processFile(file) {
    if (!/^image\//.test(String(file.type || ''))) {
      U.toast('Fichier non supporté (image requise).', 'warning');
      return;
    }

    U.compressImage(file, VC.SCAN_MAX_BYTES).then(function (dataUrl) {
      _initPreview(dataUrl);
    }).catch(function (e) {
      VC.logError('18-scan', 'compress fichier échoué', e);
      U.toast('Impossible de traiter l\'image.', 'error');
    });
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 7 — INITIALISATION DE L'APERÇU
     ═══════════════════════════════════════════════════════════ */

  function _initPreview(dataUrl) {
    _originalDataUrl = dataUrl;
    _currentResultDataUrl = dataUrl;
    _currentResultIsProcessed = false;
    _rotation = 0;
    _mirrored = false;
    _corners = _defaultCorners();
    _cornersWasSet = false;

    _loadImage(dataUrl).then(function (img) {
      _rawImage = img;

      var preview = document.getElementById('scanPreview');
      if (preview) preview.src = dataUrl;

      _showSection('preview');

      setTimeout(function () {
        _renderCornerHandles();
        _attachCornerEvents();
        _showSection('preview');
        _tryAutoDetectCorners();
      }, 100);
    }).catch(function (e) {
      VC.logError('18-scan', 'initPreview loadImage échoué', e);
      U.toast('Erreur chargement image.', 'error');
    });
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 8 — DÉTECTION AUTOMATIQUE DES COINS
     ═══════════════════════════════════════════════════════════ */

  function _tryAutoDetectCorners() {
    if (_cornersWasSet) return;

    var processor = _pickProcessor();
    if (!processor || typeof processor.detectCorners !== 'function') {
      VC.logInfo('18-scan', 'Détection auto indisponible (pas de detectCorners)');
      return;
    }

    if (!_rawImage) return;

    _setProgress(10, 'Détection des bords…');

    var canvas = _imageToCanvas(_rawImage, 900);

    processor.detectCorners(canvas).then(function (corners) {
      _setProgress(0, '');
      if (!corners || corners.length !== 4) {
        VC.logInfo('18-scan', 'Aucun quadrilatère détecté');
        return;
      }
      _corners = corners;
      _cornersWasSet = true;
      _renderCornerHandles();
      _scheduleLivePreview();
      _lastDetectedAt = Date.now();
      U.toast('✨ Bords détectés', 'success', 1500);
    }).catch(function (e) {
      _setProgress(0, '');
      VC.logError('18-scan', 'detectCorners échoué', e);
    });
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 9 — MANIPULATION DES COINS
     ═══════════════════════════════════════════════════════════ */

  function _renderCornerHandles() {
    if (!_corners) _corners = _defaultCorners();
    var handles = document.querySelectorAll('.scan-corner');
    for (var i = 0; i < handles.length; i++) {
      var idx = parseInt(handles[i].getAttribute('data-corner'), 10);
      if (isNaN(idx) || !_corners[idx]) continue;
      handles[i].style.left = _corners[idx].x + '%';
      handles[i].style.top = _corners[idx].y + '%';
    }
  }

  function _attachCornerEvents() {
    var handles = document.querySelectorAll('.scan-corner');
    for (var i = 0; i < handles.length; i++) {
      (function (handle) {
        if (handle.__bound) return;
        handle.__bound = true;
        var idx = parseInt(handle.getAttribute('data-corner'), 10);

        var startFn = function (ev) { _onCornerDragStart(ev, idx, handle); };
        handle.addEventListener('mousedown', startFn);
        handle.addEventListener('touchstart', startFn, { passive: false });
      })(handles[i]);
    }

    if (!global.__scanGlobalBound) {
      global.__scanGlobalBound = true;
      document.addEventListener('mousemove', _onCornerDragMove);
      document.addEventListener('touchmove', _onCornerDragMove, { passive: false });
      document.addEventListener('mouseup', _onCornerDragEnd);
      document.addEventListener('touchend', _onCornerDragEnd);
      document.addEventListener('touchcancel', _onCornerDragEnd);
    }
  }

  function _onCornerDragStart(ev, idx, handle) {
    try { ev.preventDefault(); } catch (e) { /* silencieux */ }
    _dragState = { idx: idx, handle: handle };
    _cornersWasSet = true;
    handle.classList.add('dragging');
  }

  function _onCornerDragMove(ev) {
    if (!_dragState) return;

    try { ev.preventDefault(); } catch (e) { /* silencieux */ }

    var wrapper = document.getElementById('scanPreviewWrapper');
    if (!wrapper) return;

    var rect = wrapper.getBoundingClientRect();
    var clientX = ev.clientX;
    var clientY = ev.clientY;
    if (ev.touches && ev.touches[0]) {
      clientX = ev.touches[0].clientX;
      clientY = ev.touches[0].clientY;
    }

    var px = (clientX - rect.left) / rect.width * 100;
    var py = (clientY - rect.top) / rect.height * 100;
    px = Math.max(0, Math.min(100, px));
    py = Math.max(0, Math.min(100, py));

    _corners[_dragState.idx] = { x: px, y: py };
    _dragState.handle.style.left = px + '%';
    _dragState.handle.style.top = py + '%';

    _scheduleLivePreview();
  }

  function _onCornerDragEnd() {
    if (_dragState && _dragState.handle) {
      _dragState.handle.classList.remove('dragging');
    }
    _dragState = null;
  }

  Scan.resetCorners = function () {
    _corners = _defaultCorners();
    _cornersWasSet = false;
    _renderCornerHandles();
    _scheduleLivePreview();
    U.toast('Coins réinitialisés', 'info', 1500);
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 10 — APERÇU LIVE (debounced)
     ═══════════════════════════════════════════════════════════ */

  function _scheduleLivePreview() {
    if (_previewTimer) clearTimeout(_previewTimer);
    _previewTimer = setTimeout(function () {
      _previewTimer = null;
      _updateLivePreview();
    }, DEBOUNCE_PREVIEW);
  }

  function _updateLivePreview() {
    if (_processing) return;
    if (!_rawImage || !_corners) return;

    var processor = _pickProcessor();
    if (!processor) return;

    var canvas = _imageToCanvas(_rawImage, MAX_PREVIEW_DIM);

    if (_abortCtrl) {
      try { _abortCtrl.abort(); } catch (e) { /* silencieux */ }
    }
    // FIX R56 : si AbortController absent (Safari 12, vieux Chrome),
    // _abortCtrl = null → le bouton Annuler ne peut rien faire.
    // On émet un warning unique au premier usage pour prévenir Anis.
    var _hasAbort = (typeof AbortController !== 'undefined');
    if (!_hasAbort && !global.__scanNoAbortWarned) {
      global.__scanNoAbortWarned = true;
      U.toast('Navigateur ancien : annulation de scan non supportée. ' +
        'Le traitement ira au bout.', 'warning', 5000);
    }
    _abortCtrl = _hasAbort ? new AbortController() : null;

    processor.process(canvas, {
      corners: _corners,
      mode: 'none',           /* preview rapide sans traitement */
      rotation: _rotation,
      mirrored: _mirrored,
      signal: _abortCtrl ? _abortCtrl.signal : null
    }).then(function (resultCanvas) {
      if (!resultCanvas) return;
      var preview = document.getElementById('scanPreview');
      if (preview) {
        preview.src = resultCanvas.toDataURL('image/jpeg', 0.85);
      }
      _currentResultDataUrl = resultCanvas.toDataURL('image/jpeg', 0.85);
      _currentResultIsProcessed = false;
    }).catch(function (e) {
      if (e && e.name === 'AbortError') return;
      VC.logError('18-scan', 'preview live échoué', e);
    });
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 11 — ROTATION / MIROIR
     ═══════════════════════════════════════════════════════════ */

  Scan.rotate = function () {
    _rotation = (_rotation + 90) % 360;
    _scheduleLivePreview();
    U.toast('Rotation : ' + _rotation + '°', 'info', 1000);
  };

  Scan.mirror = function () {
    _mirrored = !_mirrored;
    _scheduleLivePreview();
    U.toast(_mirrored ? 'Miroir activé' : 'Miroir désactivé', 'info', 1000);
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 12 — MODES
     ═══════════════════════════════════════════════════════════ */

  Scan.setMode = function (mode) {
    var valid = ['document', 'photo', 'text', 'none'];
    if (valid.indexOf(mode) === -1) mode = 'document';
    _mode = mode;
    _updateModeButtons();
  };

  function _updateModeButtons() {
    var btns = document.querySelectorAll('[data-scan-mode]');
    for (var i = 0; i < btns.length; i++) {
      var btn = btns[i];
      var m = btn.getAttribute('data-scan-mode');
      if (m === _mode) btn.classList.add('active');
      else btn.classList.remove('active');
    }
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 13 — APPLIQUER LE TRAITEMENT
     ═══════════════════════════════════════════════════════════ */

  Scan.apply = function () {
    if (_processing || !_rawImage) return;

    var processor = _pickProcessor();
    if (!processor) {
      U.toast('Moteur de traitement indisponible.', 'error');
      return;
    }

    _setProcessing(true, 'Traitement (' + _modeLabel(_mode) + ')…');
    _setProgress(20, 'Analyse…');

    var canvas = _imageToCanvas(_rawImage, 1600);

    if (_abortCtrl) {
      try { _abortCtrl.abort(); } catch (e) { /* silencieux */ }
    }
    // FIX R56 : idem preview — warning déjà émis dans _updateLivePreview
    var _hasAbort = (typeof AbortController !== 'undefined');
    _abortCtrl = _hasAbort ? new AbortController() : null;

    setTimeout(function () {
      _setProgress(50, 'Correction perspective…');
    }, 100);

    processor.process(canvas, {
      corners: _corners,
      mode: _mode,
      rotation: _rotation,
      mirrored: _mirrored,
      signal: _abortCtrl ? _abortCtrl.signal : null
    }).then(function (resultCanvas) {
      _setProgress(90, 'Nettoyage…');

      if (!resultCanvas) {
        throw new Error('Résultat vide');
      }

      var dataUrl = resultCanvas.toDataURL('image/jpeg', 0.9);
      _currentResultDataUrl = dataUrl;
      _currentResultIsProcessed = true;

      var preview = document.getElementById('scanPreview');
      if (preview) preview.src = dataUrl;

      /* Cache les handles : le résultat est figé */
      var handles = document.getElementById('scanCornersContainer');
      if (handles) handles.style.display = 'none';

      _setProgress(100, 'Terminé');

      setTimeout(function () {
        _setProcessing(false, '');
        _setProgress(0, '');
      }, 300);

      U.toast('Document amélioré (' + _modeLabel(_mode) + ')', 'success', 2000);
    }).catch(function (e) {
      if (e && e.name === 'AbortError') {
        VC.logInfo('18-scan', 'traitement annulé');
      } else {
        VC.logError('18-scan', 'apply échoué', e);
        U.toast('Échec du traitement : ' + (e.message || 'inconnu'), 'error', 4000);
      }
      _setProcessing(false, '');
      _setProgress(0, '');
    });
  };

  function _modeLabel(mode) {
    var labels = {
      document: '📄 Document',
      photo: '📷 Photo',
      text: '✏️ Texte',
      none: '🎨 Brut'
    };
    return labels[mode] || mode;
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 14 — UNDO
     ═══════════════════════════════════════════════════════════ */

  Scan.undo = function () {
    if (!_originalDataUrl) return;

    _rotation = 0;
    _mirrored = false;
    _currentResultIsProcessed = false;
    _currentResultDataUrl = _originalDataUrl;

    var preview = document.getElementById('scanPreview');
    if (preview) preview.src = _originalDataUrl;

    var handles = document.getElementById('scanCornersContainer');
    if (handles) handles.style.display = '';

    if (!_cornersWasSet) {
      _corners = _defaultCorners();
    }
    _renderCornerHandles();
    _scheduleLivePreview();

    U.toast('Annulation', 'info', 1500);
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 15 — MULTI-PAGES
     ═══════════════════════════════════════════════════════════ */

  Scan.addPage = function () {
    if (!_currentResultDataUrl) {
      U.toast('Aucun scan à ajouter.', 'warning');
      return;
    }

    if (!_sessionTag) {
      _sessionTag = 'scan_' + Date.now();
    }

    _pages.push({
      dataUrl: _currentResultDataUrl,
      mode: _mode,
      at: new Date().toISOString()
    });

    _renderPages();
    U.toast('Page ' + _pages.length + ' ajoutée', 'success', 1500);

    /* Reset pour la page suivante */
    _originalDataUrl = null;
    _rawImage = null;
    _currentResultDataUrl = null;
    _currentResultIsProcessed = false;
    _corners = null;
    _cornersWasSet = false;
    _rotation = 0;
    _mirrored = false;

    _showSection('empty');
    _setProgress(0, '');
  };

  function _renderPages() {
    var wrap = document.getElementById('scanPagesThumbnails');
    if (!wrap) return;

    if (_pages.length === 0) {
      wrap.innerHTML = '<span class="muted" style="font-size:11px">' +
        'Aucune page ajoutée</span>';
      var counter = document.getElementById('scanPageCounter');
      if (counter) counter.textContent = '';
      return;
    }

    var html = '';
    for (var i = 0; i < _pages.length; i++) {
      html += '<div class="scan-page-thumb" data-page-idx="' + i + '">' +
        '<img src="' + _pages[i].dataUrl + '" alt="Page ' + (i + 1) + '">' +
        '<span class="scan-page-num">' + (i + 1) + '</span>' +
        '<button type="button" class="scan-page-remove" ' +
        'onclick="VC.Scan.removePage(' + i + ')" title="Retirer">✕</button>' +
        '</div>';
    }
    wrap.innerHTML = html;

    var counter = document.getElementById('scanPageCounter');
    if (counter) counter.textContent = _pages.length + ' page(s)';
  }

  Scan.removePage = function (idx) {
    if (idx < 0 || idx >= _pages.length) return;
    _pages.splice(idx, 1);
    _renderPages();
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 16 — SAUVEGARDE
     ═══════════════════════════════════════════════════════════ */

  Scan.saveToDocuments = function () {
    if (!_currentResultDataUrl && _pages.length === 0) {
      U.toast('Aucun scan à enregistrer.', 'warning');
      return;
    }

    if (!VC.Documents || typeof VC.Documents.createEntry !== 'function') {
      U.toast('Module Documents indisponible.', 'error');
      return;
    }

    /* Rassemble les pages : pages ajoutées + scan courant */
    var allPages = _pages.slice();
    if (_currentResultDataUrl) {
      allPages.push({
        dataUrl: _currentResultDataUrl,
        mode: _mode,
        at: new Date().toISOString()
      });
    }

    if (allPages.length === 0) {
      U.toast('Aucun scan à enregistrer.', 'warning');
      return;
    }

    var sessionTag = _sessionTag || ('scan_' + Date.now());
    var saved = 0, failed = 0, idx = 0;

    _setProcessing(true, 'Enregistrement…');
    _setProgress(5, 'Enregistrement ' + allPages.length + ' page(s)…');

    function next() {
      if (idx >= allPages.length) {
        _setProcessing(false, '');
        _setProgress(0, '');
        VC.Scan.close();

        var msg = saved + ' page(s) enregistrée(s)';
        if (failed > 0) msg += ' · ' + failed + ' échec(s)';
        U.toast(msg, saved > 0 ? 'success' : 'warning', 3000);

        if (VC.Documents && typeof VC.Documents.render === 'function') {
          try { VC.Documents.render(); } catch (e) {
            VC.logError('18-scan', 'refresh documents échoué', e);
          }
        }
        return;
      }

      var page = allPages[idx];
      var pageNum = idx + 1;
      _setProgress(5 + Math.round((idx / allPages.length) * 90),
        'Page ' + pageNum + '/' + allPages.length);

      idx++;

      VC.IDB.dataURLToBlob(page.dataUrl).then(function (blob) {
        var filename = sessionTag + '_p' + String(pageNum).padStart(2, '0') + '.jpg';
        var file;
        try {
          file = new File([blob], filename, { type: 'image/jpeg' });
        } catch (e) {
          blob.name = filename;
          file = blob;
        }

        return VC.Documents.createEntry(file, {
          nom: 'Scan ' + U.todayISO() + ' — page ' + pageNum,
          categorie: 'autre',
          date: U.todayISO(),
          tags: ['scan', sessionTag],
          notes: 'Créé via scanner (mode ' + page.mode + ')'
        });
      }).then(function () {
        saved++;
        next();
      }).catch(function (err) {
        VC.logError('18-scan', 'save page ' + pageNum + ' échoué', err);
        failed++;
        next();
      });
    }
    next();
  };

  Scan.attachToInvoice = function () {
    if (!_currentResultDataUrl) {
      U.toast('Aucun scan à attacher.', 'warning');
      return;
    }

    var invoiceModal = document.getElementById('invoiceModal');
    if (!invoiceModal || invoiceModal.style.display === 'none') {
      U.toast('Ouvre d\'abord une facture.', 'warning', 3000);
      return;
    }

    if (typeof VC.Invoices === 'undefined' || !VC.Invoices) {
      U.toast('Module factures indisponible.', 'error');
      return;
    }

    /* On crée un blob et on l'ajoute aux attachments du brouillon courant.
       Le module 11-inv gère _attachments en interne. On passe par l'API
       publique si elle existe, sinon fallback par événement custom. */
    VC.IDB.dataURLToBlob(_currentResultDataUrl).then(function (blob) {
      var ref = U.generateId('att_scan');
      return VC.IDB.blobs.put(ref, blob, 'image/jpeg').then(function () {
        /* On ne peut pas accéder à _attachments directement depuis ce fichier.
           On émet un event que 11-inv peut écouter. */
        global.dispatchEvent(new CustomEvent('voltcore:scan:attach', {
          detail: {
            name: 'scan_' + Date.now() + '.jpg',
            type: 'image',
            size: blob.size,
            ref: ref
          }
        }));
        U.toast('Scan prêt à être attaché à la facture', 'success', 2500);
        VC.Scan.close();
      });
    }).catch(function (e) {
      VC.logError('18-scan', 'attachToInvoice échoué', e);
      U.toast('Erreur lors de l\'attachement.', 'error');
    });
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 17 — BIND GLOBAL (une seule fois)
     ═══════════════════════════════════════════════════════════ */

  function _bindOnce() {
    /* Boutons caméra */
    U.on('btnStartCamera', 'click', Scan.startCamera);
    U.on('btnStopCamera', 'click', Scan.stopCamera);
    U.on('btnCapturePhoto', 'click', Scan.capturePhoto);
    U.on('btnImportScanGallery', 'click', Scan.importFromGallery);

    /* Boutons transformations */
    U.on('btnRotateScan', 'click', Scan.rotate);
    U.on('btnMirrorScan', 'click', Scan.mirror);
    U.on('btnUndoScan', 'click', Scan.undo);
    U.on('btnResetScanCorners', 'click', Scan.resetCorners);

    /* Bouton appliquer */
    U.on('btnApplyScan', 'click', Scan.apply);

    /* Modes */
    var modeBtns = document.querySelectorAll('[data-scan-mode]');
    for (var i = 0; i < modeBtns.length; i++) {
      (function (btn) {
        if (btn.__bound) return;
        btn.__bound = true;
        btn.addEventListener('click', function (ev) {
          try { ev.preventDefault(); } catch (e) { /* silencieux */ }
          var m = btn.getAttribute('data-scan-mode');
          Scan.setMode(m);
        });
      })(modeBtns[i]);
    }

    /* Boutons sauvegarde */
    U.on('btnSaveScanToDocs', 'click', Scan.saveToDocuments);
    U.on('btnAttachScanToInvoice', 'click', Scan.attachToInvoice);

    /* Multi-pages */
    U.on('btnAddScanPage', 'click', Scan.addPage);
    U.on('btnSaveScanAll', 'click', Scan.saveToDocuments);

    /* Fermer proprement */
    global.addEventListener('beforeunload', function () {
      try { Scan.stopCamera(); } catch (e) { /* silencieux */ }
    });
  }

  /* Listener pour OpenCV ready (re-badge) */
  global.addEventListener('voltcore:opencv:ready', function () {
    _updateOpenCvBadge();
  });

  /* FIX R13-bis : bind le bouton d'ouverture du scanner.
     Sans ce bind, le bouton "📷 Scanner" dans Outils ne fait rien
     (mon patch R13 avait rendu cette fonction no-op par erreur). */
  Scan.attachEvents = function () {
    U.on('btnOpenScanner', 'click', function (ev) {
      try { if (ev) ev.preventDefault(); } catch (e) {
        VC.logError('18-scan', 'btnOpenScanner preventDefault échoué', e);
      }
      Scan.open();
    });
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 18 — MARQUEUR
     ═══════════════════════════════════════════════════════════ */

  VC._scanLoaded = true;

  VC.logInfo('18-scan', 'Orchestrateur scan chargé', {
    cvAvailable: _cvAvailable()
  });

})(window);