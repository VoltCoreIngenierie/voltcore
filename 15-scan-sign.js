/* ═══════════════════════════════════════════════════════════════
   VOLTCORE — 15-scan-sign.js
   VERSION : v6.7 (Session #3 — version unifiée, fix resize signature
                   LOT 5 inclus, aucun changement fonctionnel)
   RÔLE : Scanner documents (caméra + galerie, compression H) +
          signature tactile (canvas, stockage, attachement facture)
   DÉPENDANCES : 01-core.js (currentAttachments, VoltCore.aCamera),
                 03-utils.js (helpers + compressImageWithFeedback),
                 04-storage.js (saveAll)
   EXPOSE : openScanner, closeScanner, startCamera, stopCamera,
            capturePhoto, importScanFromGallery, saveScannedDocument,
            openSignatureModal, closeSignatureModal,
            clearSignature, saveSignature, downloadSignature,
            attachScanToInvoice, attachSignatureToInvoice,
            getStoredSignatures, deleteSignature, renderSignaturesList,
            attachScanSignEvents
   SECTION 1  : CONSTANTES + ÉTAT
   SECTION 2  : HELPERS
   SECTION 3  : SCANNER — OUVERTURE
   SECTION 4  : SCANNER — CAMÉRA
   SECTION 5  : SCANNER — IMPORT GALERIE
   SECTION 6  : SCANNER — PREVIEW + SAVE
   SECTION 7  : SIGNATURE — CANVAS
   SECTION 8  : SIGNATURE — ACTIONS
   SECTION 9  : HISTORIQUE SIGNATURES
   SECTION 10 : ATTACHEMENT À FACTURE
   SECTION 11 : ÉVÉNEMENTS
   ═══════════════════════════════════════════════════════════════ */

/* ═══════════ SECTION 1 — CONSTANTES + ÉTAT ═══════════ */

var VOLTCORE_SCAN_MAX_BYTES = 500 * 1024;
var VOLTCORE_SIGNATURES_KEY = 'voltcore_signatures';
var VOLTCORE_SIGNATURE_MAX = 20;

var __scanStream = null;
var __scanCapturedImage = null;
var __signatureCanvas = null;
var __signatureCtx = null;
var __signatureDrawing = false;
var __signatureLastPoint = null;

/* ═══════════ SECTION 2 — HELPERS ═══════════ */

function _scanGet(id) {
  try { var el = document.getElementById(id); return el ? String(el.value || '').trim() : ''; } catch (e) { return ''; }
}
function _scanSet(id, value) {
  try { var el = document.getElementById(id); if (el) el.value = value == null ? '' : value; } catch (e) {}
}
function _scanText(id, text) {
  try { var el = document.getElementById(id); if (el) el.textContent = String(text || ''); } catch (e) {}
}
function _scanShow(id, show) {
  try { var el = document.getElementById(id); if (el) el.style.display = show ? '' : 'none'; } catch (e) {}
}
function _readFileAsDataURL(file) {
  return new Promise(function (resolve, reject) {
    try {
      var reader = new FileReader();
      reader.onload = function (e) { resolve(e.target.result); };
      reader.onerror = function () { reject(reader.error || new Error('Lecture échouée')); };
      reader.readAsDataURL(file);
    } catch (e) { reject(e); }
  });
}

/* ═══════════ SECTION 3 — SCANNER — OUVERTURE ═══════════ */

function openScanner() {
  try {
    __scanCapturedImage = null;
    __scanRawImage = null;
    __scanIsImproved = false;
    __scanCurrentMode = 'fast';
    __scanCornerPositions = null;
    _scanShow('scanPreviewContainer', false);
    _scanShow('scanVideoContainer', false);
    _scanShow('scanEmptyHint', true);
    if (typeof _scanShowImproveBar === 'function') _scanShowImproveBar(false);
    if (typeof _scanShowCorners === 'function') _scanShowCorners(false);

    var camBtn = document.getElementById('btnStartCamera');
    if (camBtn) camBtn.disabled = false;
    if (camBtn) camBtn.style.display = '';

    var stopBtn = document.getElementById('btnStopCamera');
    if (stopBtn) stopBtn.style.display = 'none';

    var capBtn = document.getElementById('btnCapturePhoto');
    if (capBtn) capBtn.style.display = 'none';

    var prev = document.getElementById('scanPreview');
    if (prev) prev.removeAttribute('src');

    /* v6.10.0 — masque les boutons avancés */
    var undoBtn = document.getElementById('btnUndoScanImprove');
    if (undoBtn) undoBtn.style.display = 'none';
    var saveDocs = document.getElementById('btnSaveScanToDocs');
    if (saveDocs) saveDocs.style.display = 'none';
    var saveBtn = document.getElementById('btnSaveScan');
    if (saveBtn) saveBtn.style.display = 'none';
    var spin = document.getElementById('scanProcessingSpinner');
    if (spin) spin.style.display = 'none';

    var errEl = document.getElementById('scanError');
    if (errEl) errEl.textContent = '';

    var modal = document.getElementById('scanModal');
    if (modal) modal.style.display = 'flex';
  } catch (e) { console.warn('openScanner :', e); }
}

function closeScanner() {
  try {
    stopCamera();
    var m = document.getElementById('scanModal');
    if (m) m.style.display = 'none';
    __scanCapturedImage = null;
  } catch (e) {}
}

/* ═══════════ SECTION 4 — SCANNER — CAMÉRA ═══════════ */

async function startCamera() {
  try {
    var errEl = document.getElementById('scanError');
    if (errEl) errEl.textContent = '';

    if (!window.VoltCore || !window.VoltCore.aCamera) {
      if (errEl) errEl.textContent = 'Caméra non disponible sur cet appareil.';
      if (typeof showToast === 'function') showToast('Caméra non disponible.', 'error');
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      if (errEl) errEl.textContent = 'Navigateur trop ancien pour la caméra.';
      return;
    }

    stopCamera();

    var stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false
      });
    } catch (e1) {
      /* Fallback sans contrainte facingMode */
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      } catch (e2) {
        if (errEl) errEl.textContent = 'Accès caméra refusé. Autorise dans les paramètres du navigateur.';
        return;
      }
    }

    __scanStream = stream;
    var video = document.getElementById('scanVideo');
    if (!video) { stopCamera(); return; }

    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    try { await video.play(); } catch (e) {}

    _scanShow('scanVideoContainer', true);
    _scanShow('scanEmptyHint', false);
    _scanShow('scanPreviewContainer', false);

    var camBtn2 = document.getElementById('btnStartCamera');
    if (camBtn2) camBtn2.style.display = 'none';
    var stopBtn = document.getElementById('btnStopCamera');
    if (stopBtn) stopBtn.style.display = '';
    var capBtn = document.getElementById('btnCapturePhoto');
    if (capBtn) capBtn.style.display = '';
  } catch (e) {
    console.warn('startCamera :', e);
    var errEl2 = document.getElementById('scanError');
    if (errEl2) errEl2.textContent = 'Impossible de démarrer la caméra.';
  }
}

function stopCamera() {
  try {
    if (__scanStream) {
      var tracks = __scanStream.getTracks ? __scanStream.getTracks() : [];
      for (var i = 0; i < tracks.length; i++) {
        try { tracks[i].stop(); } catch (e) {}
      }
      __scanStream = null;
    }
    var video = document.getElementById('scanVideo');
    if (video) {
      try { video.pause(); } catch (e) {}
      video.srcObject = null;
    }
    _scanShow('scanVideoContainer', false);

    var camBtn = document.getElementById('btnStartCamera');
    if (camBtn) camBtn.style.display = '';
    var stopBtn = document.getElementById('btnStopCamera');
    if (stopBtn) stopBtn.style.display = 'none';
    var capBtn = document.getElementById('btnCapturePhoto');
    if (capBtn) capBtn.style.display = 'none';
  } catch (e) { console.warn('stopCamera :', e); }
}

async function capturePhoto() {
  try {
    var video = document.getElementById('scanVideo');
    if (!video || !video.videoWidth || !video.videoHeight) {
      if (typeof showToast === 'function') showToast('Caméra pas encore prête.', 'warning');
      return;
    }
    var canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    var ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0);

    /* Qualité jpeg 0.9 — la compression H affinera si nécessaire */
    var dataUrl = canvas.toDataURL('image/jpeg', 0.9);
    __scanCapturedImage = dataUrl;
    /* v6.10.0 — stocke aussi le raw pour annulation */
    __scanRawImage = dataUrl;
    __scanIsImproved = false;
    __scanCornerPositions = null;

    var img = document.getElementById('scanPreview');
    if (img) img.src = dataUrl;
    _scanShow('scanPreviewContainer', true);
    _scanShow('scanEmptyHint', false);

    /* v6.10.0 — affiche les handles + barre d'amélioration */
    if (typeof _scanShowCorners === 'function') {
      _scanShowCorners(true);
      setTimeout(function () {
        _scanResetCornerPositions();
        _scanRenderCornerHandles();
        _scanAttachCornerEvents();
        _scanSetMode(__scanCurrentMode || 'fast');
      }, 100);
    }
    if (typeof _scanShowImproveBar === 'function') _scanShowImproveBar(true);

    /* v6.10.0 — boutons basiques visibles (avant amélioration) */
    var saveBtn0 = document.getElementById('btnSaveScan');
    if (saveBtn0) saveBtn0.style.display = '';
    var saveDocs0 = document.getElementById('btnSaveScanToDocs');
    if (saveDocs0) saveDocs0.style.display = '';

    stopCamera();
  } catch (e) { console.warn('capturePhoto :', e); }
}

/* ═══════════ SECTION 5 — SCANNER — IMPORT GALERIE ═══════════ */

function importScanFromGallery() {
  try {
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async function (ev) {
      var f = ev.target.files && ev.target.files[0];
      if (!f) return;
      await _processScannedFile(f);
    };
    input.click();
  } catch (e) { console.warn('importScanFromGallery :', e); }
}

async function _processScannedFile(file) {
  try {
    var errEl = document.getElementById('scanError');
    if (errEl) errEl.textContent = '';
    if (!/^image\//.test(String(file.type || ''))) {
      if (errEl) errEl.textContent = 'Fichier non supporté (image requise).';
      return;
    }

    var dataUrl;
    if (typeof compressImageWithFeedback === 'function') {
      dataUrl = await compressImageWithFeedback(file, VOLTCORE_SCAN_MAX_BYTES);
    } else {
      dataUrl = await _readFileAsDataURL(file);
    }
    __scanCapturedImage = dataUrl;
    /* v6.10.0 — raw + improved reset */
    __scanRawImage = dataUrl;
    __scanIsImproved = false;
    __scanCornerPositions = null;

    var img = document.getElementById('scanPreview');
    if (img) img.src = dataUrl;
    _scanShow('scanPreviewContainer', true);
    _scanShow('scanActions', true);
    _scanShow('scanEmptyHint', false);
    _scanShow('scanVideoContainer', false);

    /* v6.10.0 — handles + barre */
    if (typeof _scanShowCorners === 'function') {
      _scanShowCorners(true);
      setTimeout(function () {
        _scanResetCornerPositions();
        _scanRenderCornerHandles();
        _scanAttachCornerEvents();
        _scanSetMode(__scanCurrentMode || 'fast');
      }, 100);
    }
    if (typeof _scanShowImproveBar === 'function') _scanShowImproveBar(true);
    var saveBtn0 = document.getElementById('btnSaveScan');
    if (saveBtn0) saveBtn0.style.display = '';
    var saveDocs0 = document.getElementById('btnSaveScanToDocs');
    if (saveDocs0) saveDocs0.style.display = '';
  } catch (e) {
    console.warn('_processScannedFile :', e);
    var errEl2 = document.getElementById('scanError');
    if (errEl2) errEl2.textContent = 'Impossible de traiter l\'image.';
  }
}

/* ═══════════ SECTION 6 — SCANNER — PREVIEW + SAVE ═══════════ */

function saveScannedDocument() {
  try {
    if (!__scanCapturedImage) {
      if (typeof showToast === 'function') showToast('Aucune image capturée.', 'warning');
      return;
    }

    /* Vérifie que la facture est ouverte */
    var invoiceModal = document.getElementById('invoiceModal');
    if (!invoiceModal || invoiceModal.style.display === 'none') {
      /* Sauvegarde standalone : télécharge directement */
      if (typeof showToast === 'function') {
        showToast('Aucune facture ouverte. L\'image va être téléchargée.', 'info', 3500);
      }
      _downloadScanStandalone();
      closeScanner();
      return;
    }

    attachScanToInvoice();
  } catch (e) { console.warn('saveScannedDocument :', e); }
}

function attachScanToInvoice() {
  try {
    if (!__scanCapturedImage) return;
    if (!Array.isArray(currentAttachments)) currentAttachments = [];

    var approx = Math.round(__scanCapturedImage.length * 0.75);
    currentAttachments.push({
      name: 'scan_' + new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-') + '.jpg',
      type: 'image',
      size: approx,
      data: __scanCapturedImage
    });

    /* Refresh de L11 si disponible */
    if (typeof renderInvoiceAttachments === 'function') {
      try { renderInvoiceAttachments(); } catch (e) {}
    }
    if (typeof _invDirty === 'function') {
      try { _invDirty(); } catch (e) {}
    }

    if (typeof showToast === 'function') {
      showToast('Scan ajouté à la facture', 'success', 2500);
    }
    closeScanner();
  } catch (e) { console.warn('attachScanToInvoice :', e); }
}

function _downloadScanStandalone() {
  try {
    if (!__scanCapturedImage) return;
    var parts = __scanCapturedImage.split(',');
    if (parts.length !== 2) return;
    var mime = (parts[0].match(/:(.*?);/) || [])[1] || 'image/jpeg';
    var binary = atob(parts[1]);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    var blob = new Blob([bytes], { type: mime });
    if (typeof downloadBlob === 'function') {
      downloadBlob(blob, 'scan_' + (typeof todayISO === 'function' ? todayISO() : Date.now()) + '.jpg');
    }
  } catch (e) { console.warn('_downloadScanStandalone :', e); }
}

/* ═══════════ SECTION 7 — SIGNATURE — CANVAS ═══════════ */

function openSignatureModal() {
  try {
    var modal = document.getElementById('signatureModal');
    if (!modal) return;
    modal.style.display = 'flex';
    /* Init après affichage pour que la taille soit correcte */
    setTimeout(function () {
      initSignatureCanvas();
      _attachSignatureResizeHandler();
      renderSignaturesList();
    }, 80);
  } catch (e) { console.warn('openSignatureModal :', e); }
}

function closeSignatureModal() {
  try {
    var m = document.getElementById('signatureModal');
    if (m) m.style.display = 'none';
  } catch (e) {}
}

function initSignatureCanvas() {
  try {
    var canvas = document.getElementById('signatureCanvas');
    if (!canvas) return;

    var rect = canvas.getBoundingClientRect();
    var dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    canvas.style.width = rect.width + 'px';
    canvas.style.height = rect.height + 'px';

    __signatureCanvas = canvas;
    __signatureCtx = canvas.getContext('2d');
    /* Setting canvas.width ci-dessus a remis le transform à l'identité
       → safe d'appliquer scale(dpr, dpr) une seule fois */
    __signatureCtx.scale(dpr, dpr);
    __signatureCtx.lineWidth = 2;
    __signatureCtx.lineCap = 'round';
    __signatureCtx.lineJoin = 'round';
    __signatureCtx.strokeStyle = '#000';

    /* Fond blanc opaque pour export PNG */
    __signatureCtx.fillStyle = '#fff';
    __signatureCtx.fillRect(0, 0, rect.width, rect.height);
    __signatureCtx.fillStyle = '#000';

    _initSignatureDrawing();
  } catch (e) { console.warn('initSignatureCanvas :', e); }
}

/* LOT 5 — Fix bug resize/rotation.
   Sans ce handler, le canvas garde ses dimensions figées au moment de
   l'ouverture de la modale. Après rotation écran, le canvas déborde ou
   est trop petit → signature tronquée/étirée.

   Stratégie :
   1. Sauvegarde le dessin actuel (dataURL PNG)
   2. Re-mesure le container (getBoundingClientRect)
   3. Redimensionne le buffer + les styles CSS
   4. Ré-applique le transform devicePixelRatio (net sur Retina)
   5. Restaure le dessin en préservant les proportions */
function _resizeSignatureCanvas() {
  try {
    var canvas = __signatureCanvas || document.getElementById('signatureCanvas');
    if (!canvas) return;

    /* N'agit que si la modale est ouverte (évite calculs inutiles) */
    var modal = document.getElementById('signatureModal');
    if (!modal || modal.style.display === 'none') return;

    /* 1. Backup du contenu (uniquement si non vide) */
    var backup = null;
    try {
      if (canvas.width > 0 && canvas.height > 0 && !_isSignatureEmpty()) {
        backup = canvas.toDataURL('image/png');
      }
    } catch (e) {}

    /* 2. Re-mesure */
    var rect = canvas.getBoundingClientRect();
    if (!rect || rect.width < 1 || rect.height < 1) return;

    var dpr = window.devicePixelRatio || 1;

    /* 3. Redimensionnement buffer + styles.
       ⚠️ Affecter canvas.width reset automatiquement le contexte
       (transform, styles, contenu) → il faut TOUT ré-appliquer. */
    canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    canvas.style.width = rect.width + 'px';
    canvas.style.height = rect.height + 'px';

    /* 4. Ré-applique la config */
    var ctx = canvas.getContext('2d');
    __signatureCanvas = canvas;
    __signatureCtx = ctx;
    ctx.scale(dpr, dpr);
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#000';
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, rect.width, rect.height);
    ctx.fillStyle = '#000';

    /* 5. Restaure le dessin si présent.
       On utilise un Image temporaire (async) — le debounce 200ms évite
       les races si plusieurs resize rapprochés. */
    if (backup) {
      var img = new Image();
      img.onload = function () {
        try {
          /* drawImage avec les dimensions CSS courantes → préserve
             l'aspect ratio du contenu (le buffer est x dpr mais le
             transform scale(dpr, dpr) ramène tout en CSS pixels). */
          ctx.drawImage(img, 0, 0, rect.width, rect.height);
        } catch (e) { /* silencieux */ }
      };
      img.src = backup;
    }
  } catch (e) { console.warn('_resizeSignatureCanvas :', e); }
}

/* Installe l'écouteur resize (une seule fois, protégé par flag). */
var __signatureResizeAttached = false;
function _attachSignatureResizeHandler() {
  if (__signatureResizeAttached) return;
  __signatureResizeAttached = true;

  var handler = function () {
    try { _resizeSignatureCanvas(); } catch (e) {}
  };

  /* Utilise debounce de 03-utils.js si dispo, sinon fallback local */
  var debounced;
  if (typeof debounce === 'function') {
    debounced = debounce(handler, 200);
  } else {
    var __sigResizeTimer = null;
    debounced = function () {
      if (__sigResizeTimer) clearTimeout(__sigResizeTimer);
      __sigResizeTimer = setTimeout(handler, 200);
    };
  }

  window.addEventListener('resize', debounced);
  window.addEventListener('orientationchange', function () {
    setTimeout(debounced, 300);
  });
}

function _initSignatureDrawing() {
  try {
    var canvas = __signatureCanvas;
    if (!canvas) return;
    /* Évite le double-binding — le canvas reste le même élément
       même après resize (seul son buffer change). */
    if (canvas.__bound) return;
    canvas.__bound = true;

    function getPos(ev) {
      var rect = canvas.getBoundingClientRect();
      var clientX = ev.clientX, clientY = ev.clientY;
      if (ev.touches && ev.touches[0]) {
        clientX = ev.touches[0].clientX;
        clientY = ev.touches[0].clientY;
      }
      return { x: clientX - rect.left, y: clientY - rect.top };
    }

    function start(ev) {
      try {
        if (ev.touches) ev.preventDefault();
        __signatureDrawing = true;
        var p = getPos(ev);
        __signatureLastPoint = p;
        if (__signatureCtx) {
          __signatureCtx.beginPath();
          __signatureCtx.arc(p.x, p.y, 1.2, 0, Math.PI * 2);
          __signatureCtx.fill();
        }
      } catch (e) {}
    }

    function move(ev) {
      try {
        if (!__signatureDrawing) return;
        if (ev.touches) ev.preventDefault();
        var p = getPos(ev);
        if (__signatureLastPoint && __signatureCtx) {
          __signatureCtx.beginPath();
          __signatureCtx.moveTo(__signatureLastPoint.x, __signatureLastPoint.y);
          __signatureCtx.lineTo(p.x, p.y);
          __signatureCtx.stroke();
        }
        __signatureLastPoint = p;
      } catch (e) {}
    }

    function end() {
      __signatureDrawing = false;
      __signatureLastPoint = null;
    }

    canvas.addEventListener('mousedown', start);
    canvas.addEventListener('mousemove', move);
    canvas.addEventListener('mouseup', end);
    canvas.addEventListener('mouseleave', end);
    canvas.addEventListener('touchstart', start, { passive: false });
    canvas.addEventListener('touchmove', move, { passive: false });
    canvas.addEventListener('touchend', end);
    canvas.addEventListener('touchcancel', end);
  } catch (e) { console.warn('_initSignatureDrawing :', e); }
}

function _isSignatureEmpty() {
  try {
    if (!__signatureCanvas) return true;
    var ctx = __signatureCanvas.getContext('2d');
    var data = ctx.getImageData(0, 0, __signatureCanvas.width, __signatureCanvas.height).data;
    /* Cherche des pixels non-blancs (RGBA != 255,255,255,255) */
    for (var i = 0; i < data.length; i += 4) {
      if (data[i] < 240 || data[i + 1] < 240 || data[i + 2] < 240) return false;
    }
    return true;
  } catch (e) { return true; }
}

/* ═══════════ SECTION 8 — SIGNATURE — ACTIONS ═══════════ */

function clearSignature() {
  try {
    if (!__signatureCanvas || !__signatureCtx) return;
    var rect = __signatureCanvas.getBoundingClientRect();
    __signatureCtx.fillStyle = '#fff';
    __signatureCtx.fillRect(0, 0, rect.width, rect.height);
    __signatureCtx.fillStyle = '#000';
    if (typeof showToast === 'function') showToast('Signature effacée', 'info', 1500);
  } catch (e) { console.warn('clearSignature :', e); }
}

function saveSignature() {
  try {
    if (!__signatureCanvas) {
      if (typeof showToast === 'function') showToast('Canvas absent.', 'error');
      return null;
    }
    if (_isSignatureEmpty()) {
      if (typeof showToast === 'function') showToast('Signe d\'abord dans la zone.', 'warning');
      return null;
    }
    var dataUrl = __signatureCanvas.toDataURL('image/png');
    var name = _scanGet('signatureName') || ('Signature ' + new Date().toLocaleString('fr-FR'));
    var list = getStoredSignatures();
    var entry = {
      id: 'sig_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      name: String(name).slice(0, 80),
      data: dataUrl,
      date: new Date().toISOString(),
      size: Math.round(dataUrl.length * 0.75)
    };
    list.push(entry);
    /* Limite à 20 signatures */
    if (list.length > VOLTCORE_SIGNATURE_MAX) list = list.slice(-VOLTCORE_SIGNATURE_MAX);
    _saveStoredSignatures(list);
    _scanSet('signatureName', '');
    renderSignaturesList();
    if (typeof showToast === 'function') showToast('Signature enregistrée', 'success', 2000);
    return entry;
  } catch (e) {
    console.warn('saveSignature :', e);
    if (typeof showToast === 'function') showToast('Erreur sauvegarde signature.', 'error');
    return null;
  }
}

function downloadSignature() {
  try {
    if (!__signatureCanvas) return;
    if (_isSignatureEmpty()) {
      if (typeof showToast === 'function') showToast('Signe d\'abord.', 'warning');
      return;
    }
    var dataUrl = __signatureCanvas.toDataURL('image/png');
    var parts = dataUrl.split(',');
    var binary = atob(parts[1]);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    var blob = new Blob([bytes], { type: 'image/png' });
    if (typeof downloadBlob === 'function') {
      downloadBlob(blob, 'signature_' + (typeof todayISO === 'function' ? todayISO() : Date.now()) + '.png');
    }
  } catch (e) { console.warn('downloadSignature :', e); }
}

/* ═══════════ SECTION 9 — HISTORIQUE SIGNATURES ═══════════ */

function getStoredSignatures() {
  try {
    var raw = localStorage.getItem(VOLTCORE_SIGNATURES_KEY);
    if (!raw) return [];
    var parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) { return []; }
}

function _saveStoredSignatures(list) {
  try { localStorage.setItem(VOLTCORE_SIGNATURES_KEY, JSON.stringify(list || [])); }
  catch (e) { console.warn('_saveStoredSignatures :', e); }
}

function deleteSignature(id) {
  try {
    var list = getStoredSignatures();
    var filtered = list.filter(function (s) { return s.id !== id; });
    if (filtered.length === list.length) return;
    _saveStoredSignatures(filtered);
    renderSignaturesList();
    if (typeof showToast === 'function') showToast('Signature supprimée', 'info', 1500);
  } catch (e) { console.warn('deleteSignature :', e); }
}

function renderSignaturesList() {
  try {
    var container = document.getElementById('signaturesList');
    if (!container) return;
    var list = getStoredSignatures();
    if (list.length === 0) {
      container.innerHTML = '<div class="empty-state">Aucune signature enregistrée.</div>';
      return;
    }
    var html = '';
    for (var i = list.length - 1; i >= 0; i--) {
      var s = list[i];
      if (!s || !s.data) continue;
      html += '<div class="signature-history-item">' +
        '<img src="' + escapeAttr(s.data) + '" alt="Signature" class="signature-history-img" ' +
        'onclick="attachSignatureToInvoice(\'' + escapeAttr(s.id) + '\')" title="Cliquer pour attacher à la facture">' +
        '<div class="signature-history-meta">' +
          '<div class="signature-history-name">' + escapeHtml(s.name || '—') + '</div>' +
          '<div class="signature-history-date">' + escapeHtml(typeof formatDate === 'function' ? formatDate(s.date.slice(0, 10)) : s.date) +
            (s.size ? ' · ' + (typeof formatBytes === 'function' ? formatBytes(s.size) : s.size + ' o') : '') +
          '</div>' +
        '</div>' +
        '<button type="button" class="btn-icon-mini btn-danger" ' +
        'onclick="deleteSignature(\'' + escapeAttr(s.id) + '\')" title="Supprimer">✕</button>' +
        '</div>';
    }
    container.innerHTML = html;
  } catch (e) { console.warn('renderSignaturesList :', e); }
}

/* ═══════════ SECTION 10 — ATTACHEMENT À FACTURE ═══════════ */

function attachSignatureToInvoice(sigId) {
  try {
    /* Si pas d'ID, tente d'utiliser le canvas courant */
    var dataUrl = null;
    var name = 'Signature';
    if (sigId) {
      var list = getStoredSignatures();
      for (var i = 0; i < list.length; i++) {
        if (list[i].id === sigId) {
          dataUrl = list[i].data;
          name = list[i].name || name;
          break;
        }
      }
    } else if (__signatureCanvas && !_isSignatureEmpty()) {
      dataUrl = __signatureCanvas.toDataURL('image/png');
      name = _scanGet('signatureName') || 'Signature';
    }

    if (!dataUrl) {
      if (typeof showToast === 'function') showToast('Signature vide ou introuvable.', 'warning');
      return;
    }

    /* Vérifie qu'une facture est ouverte */
    var invoiceModal = document.getElementById('invoiceModal');
    if (!invoiceModal || invoiceModal.style.display === 'none') {
      if (typeof showToast === 'function') showToast('Ouvre d\'abord une facture.', 'warning', 3000);
      return;
    }

    if (!Array.isArray(currentAttachments)) currentAttachments = [];
    currentAttachments.push({
      name: String(name).slice(0, 80) + '.png',
      type: 'image',
      size: Math.round(dataUrl.length * 0.75),
      data: dataUrl
    });

    if (typeof renderInvoiceAttachments === 'function') {
      try { renderInvoiceAttachments(); } catch (e) {}
    }
    if (typeof _invDirty === 'function') {
      try { _invDirty(); } catch (e) {}
    }

    if (typeof showToast === 'function') showToast('Signature attachée à la facture', 'success', 2500);
    closeSignatureModal();
  } catch (e) { console.warn('attachSignatureToInvoice :', e); }
}

/* ═══════════ SECTION 11 — ÉVÉNEMENTS ═══════════ */

function attachScanSignEvents() {
  try {
    /* ── SCANNER ── */
    var openScanBtn = document.getElementById('btnOpenScanner');
    if (openScanBtn && !openScanBtn.__bound) {
      openScanBtn.__bound = true;
      openScanBtn.addEventListener('click', openScanner);
    }

    var camBtn = document.getElementById('btnStartCamera');
    if (camBtn && !camBtn.__bound) {
      camBtn.__bound = true;
      camBtn.addEventListener('click', startCamera);
    }

    var stopCamBtn = document.getElementById('btnStopCamera');
    if (stopCamBtn && !stopCamBtn.__bound) {
      stopCamBtn.__bound = true;
      stopCamBtn.addEventListener('click', stopCamera);
    }

    var capBtn = document.getElementById('btnCapturePhoto');
    if (capBtn && !capBtn.__bound) {
      capBtn.__bound = true;
      capBtn.addEventListener('click', capturePhoto);
    }

    var importBtn = document.getElementById('btnImportScanGallery');
    if (importBtn && !importBtn.__bound) {
      importBtn.__bound = true;
      importBtn.addEventListener('click', importScanFromGallery);
    }

    var saveScanBtn = document.getElementById('btnSaveScan');
    if (saveScanBtn && !saveScanBtn.__bound) {
      saveScanBtn.__bound = true;
      saveScanBtn.addEventListener('click', saveScannedDocument);
    }

    /* ── SIGNATURE ── */
    var openSigBtn = document.getElementById('btnOpenSignature');
    if (openSigBtn && !openSigBtn.__bound) {
      openSigBtn.__bound = true;
      openSigBtn.addEventListener('click', openSignatureModal);
    }

    var clearSigBtn = document.getElementById('btnClearSignature');
    if (clearSigBtn && !clearSigBtn.__bound) {
      clearSigBtn.__bound = true;
      clearSigBtn.addEventListener('click', clearSignature);
    }

    var saveSigBtn = document.getElementById('btnSaveSignature');
    if (saveSigBtn && !saveSigBtn.__bound) {
      saveSigBtn.__bound = true;
      saveSigBtn.addEventListener('click', saveSignature);
    }

    var downloadSigBtn = document.getElementById('btnDownloadSignature');
    if (downloadSigBtn && !downloadSigBtn.__bound) {
      downloadSigBtn.__bound = true;
      downloadSigBtn.addEventListener('click', downloadSignature);
    }

    var attachSigBtn = document.getElementById('btnAttachSignatureToInvoice');
    if (attachSigBtn && !attachSigBtn.__bound) {
      attachSigBtn.__bound = true;
      attachSigBtn.addEventListener('click', function () {
        attachSignatureToInvoice(null);
      });
    }

    /* v6.10.0 — binds CamScanner */
    var modeFast = document.getElementById('btnScanModeFast');
    if (modeFast && !modeFast.__bound) {
      modeFast.__bound = true;
      modeFast.addEventListener('click', function (ev) {
        try { ev.preventDefault(); } catch (e) {}
        _scanSetMode('fast');
      });
    }
    var modePrecise = document.getElementById('btnScanModePrecise');
    if (modePrecise && !modePrecise.__bound) {
      modePrecise.__bound = true;
      modePrecise.addEventListener('click', function (ev) {
        try { ev.preventDefault(); } catch (e) {}
        _scanSetMode('precise');
      });
    }
    var applyBtn = document.getElementById('btnApplyScanImprove');
    if (applyBtn && !applyBtn.__bound) {
      applyBtn.__bound = true;
      applyBtn.addEventListener('click', function (ev) {
        try { ev.preventDefault(); } catch (e) {}
        handleApplyScanImprovement();
      });
    }
    var resetBtn = document.getElementById('btnResetScanCorners');
    if (resetBtn && !resetBtn.__bound) {
      resetBtn.__bound = true;
      resetBtn.addEventListener('click', function (ev) {
        try { ev.preventDefault(); } catch (e) {}
        _scanResetCornerPositions();
        _scanRenderCornerHandles();
      });
    }
    var undoBtn = document.getElementById('btnUndoScanImprove');
    if (undoBtn && !undoBtn.__bound) {
      undoBtn.__bound = true;
      undoBtn.addEventListener('click', function (ev) {
        try { ev.preventDefault(); } catch (e) {}
        undoScanImprovement();
      });
    }
    var saveDocsBtn = document.getElementById('btnSaveScanToDocs');
    if (saveDocsBtn && !saveDocsBtn.__bound) {
      saveDocsBtn.__bound = true;
      saveDocsBtn.addEventListener('click', function (ev) {
        try { ev.preventDefault(); } catch (e) {}
        saveScanToDocuments();
      });
    }

    /* Initialise les binds des corners (idempotent) */
    _scanAttachCornerEvents();
  } catch (e) { console.warn('attachScanSignEvents :', e); }
}

/* Cleanup caméra si on quitte */
try {
  window.addEventListener('beforeunload', function () { try { stopCamera(); } catch (e) {} });
} catch (e) {}
/* ═══════════ v6.10.0 — CAMSCANNER OFFLINE ═══════════
   Redressement perspective + binarisation adaptative.
   Zéro dépendance externe. ES5 strict (async/await autorisé). */

/* État scan "brut" (jamais écrasé par l'amélioration) */
var __scanRawImage = null;
var __scanIsImproved = false;
var __scanCurrentMode = 'fast';  /* 'fast' | 'precise' */
var __scanCornerPositions = null; /* [{x%, y%} × 4] ou null = défaut */
var __scanCornerDragState = null;
var SCAN_CORNER_DEFAULT_INSET_PCT = 3;

/* ─── Utilitaires géométrie ─── */
function _scanDist(a, b) {
  var dx = a.x - b.x, dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/* Calcule l'affine qui mappe un triangle source vers un triangle dest.
   Retourne {a,b,c,d,e,f} ou null si dégénéré. */
function _scanComputeAffine(s1, s2, s3, d1, d2, d3) {
  var det = (s2.x - s1.x) * (s3.y - s1.y) - (s3.x - s1.x) * (s2.y - s1.y);
  if (Math.abs(det) < 1e-10) return null;
  var a = ((d2.x - d1.x) * (s3.y - s1.y) - (d3.x - d1.x) * (s2.y - s1.y)) / det;
  var c = ((d3.x - d1.x) * (s2.x - s1.x) - (d2.x - d1.x) * (s3.x - s1.x)) / det;
  var b = ((d2.y - d1.y) * (s3.y - s1.y) - (d3.y - d1.y) * (s2.y - s1.y)) / det;
  var d = ((d3.y - d1.y) * (s2.x - s1.x) - (d2.y - d1.y) * (s3.x - s1.x)) / det;
  var e = d1.x - a * s1.x - c * s1.y;
  var f = d1.y - b * s1.x - d * s1.y;
  return { a: a, b: b, c: c, d: d, e: e, f: f };
}

function _scanDrawTriangle(ctx, srcImage, src1, src2, src3, dst1, dst2, dst3) {
  var m = _scanComputeAffine(src1, src2, src3, dst1, dst2, dst3);
  if (!m) return;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(dst1.x, dst1.y);
  ctx.lineTo(dst2.x, dst2.y);
  ctx.lineTo(dst3.x, dst3.y);
  ctx.closePath();
  ctx.clip();
  ctx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);
  ctx.drawImage(srcImage, 0, 0);
  ctx.restore();
}

/* Applique une correction de perspective.
   sourceImg : Image (HTMLImageElement) ou Canvas
   sw, sh    : dimensions source (utile si canvas, sinon ignorer)
   corners   : [{x,y} × 4] dans les coords source (TL, TR, BR, BL)
   Retourne un Canvas redressé (dimensions auto selon les bords). */
function _scanApplyPerspectiveWarp(sourceImg, corners) {
  try {
    if (!corners || corners.length !== 4) return null;

    /* Dimensions destination = max des largeurs/huteurs source */
    var topW    = _scanDist(corners[0], corners[1]);
    var bottomW = _scanDist(corners[3], corners[2]);
    var leftH   = _scanDist(corners[0], corners[3]);
    var rightH  = _scanDist(corners[1], corners[2]);

    var dw = Math.round(Math.max(topW, bottomW));
    var dh = Math.round(Math.max(leftH, rightH));
    if (dw < 1 || dh < 1) return null;

    /* Cap à 2000 px pour éviter l'explosion mémoire */
    var MAX_DIM = 2000;
    if (dw > MAX_DIM || dh > MAX_DIM) {
      var ratio = Math.min(MAX_DIM / dw, MAX_DIM / dh);
      dw = Math.round(dw * ratio);
      dh = Math.round(dh * ratio);
    }

    var dst = document.createElement('canvas');
    dst.width = dw;
    dst.height = dh;
    var ctx = dst.getContext('2d');

    /* 4 coins destination = rectangle */
    var dTL = { x: 0, y: 0 };
    var dTR = { x: dw, y: 0 };
    var dBR = { x: dw, y: dh };
    var dBL = { x: 0, y: dh };

    /* Triangle 1 : TL → TR → BL */
    _scanDrawTriangle(ctx, sourceImg,
      corners[0], corners[1], corners[3],
      dTL, dTR, dBL);

    /* Triangle 2 : TR → BR → BL */
    _scanDrawTriangle(ctx, sourceImg,
      corners[1], corners[2], corners[3],
      dTR, dBR, dBL);

    return dst;
  } catch (e) {
    console.warn('_scanApplyPerspectiveWarp :', e);
    return null;
  }
}

/* ─── Binarisation ─── */

/* Otsu : seuil global optimal. Retourne un entier 0-255. */
function _scanOtsuThreshold(gray) {
  var hist = new Array(256);
  var i;
  for (i = 0; i < 256; i++) hist[i] = 0;
  var total = gray.length;
  for (i = 0; i < total; i++) hist[gray[i]]++;

  var sum = 0;
  for (i = 0; i < 256; i++) sum += i * hist[i];

  var sumB = 0, wB = 0, maxVar = 0, bestT = 0;
  for (var t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    var wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    var mB = sumB / wB;
    var mF = (sum - sumB) / wF;
    var between = wB * wF * (mB - mF) * (mB - mF);
    if (between > maxVar) { maxVar = between; bestT = t; }
  }
  /* v6.10.4 — Clamp [1, 254] : évite un seuil dégénéré (0 ou 255) quand
     un des deux modes est collé au bord. Ex : image [0×N, 255×M] retournait
     t=0, ce qui binarisait en TOUT BLANC (0 < 0 = false → 255). */
  if (bestT < 1) bestT = 1;
  if (bestT > 254) bestT = 254;
  return bestT;
}

/* Sauvola adaptatif (fenêtre 15×15).
   Utilise une image intégrale pour O(1) par pixel.
   Modifie `data` en place. */
function _scanSauvolaBinarize(gray, data, w, h) {
  var W = w + 1;
  var integral = new Float64Array(W * (h + 1));
  var integralSq = new Float64Array(W * (h + 1));

  /* 1. Remplissage image intégrale (2 passes fusionnées) */
  for (var y = 1; y <= h; y++) {
    var rowBase = y * W;
    var rowPrev = (y - 1) * W;
    var gRowBase = (y - 1) * w;
    var sumRow = 0, sumSqRow = 0;
    for (var x = 1; x <= w; x++) {
      var g = gray[gRowBase + (x - 1)];
      sumRow += g;
      sumSqRow += g * g;
      integral[rowBase + x] = integral[rowPrev + x] + sumRow;
      integralSq[rowBase + x] = integralSq[rowPrev + x] + sumSqRow;
    }
  }

  /* 2. Application pixel par pixel */
  var win = 15;
  var halfWin = 7;
  var k = 0.5;
  var R = 128.0;

  for (var yy = 0; yy < h; yy++) {
    var y1 = yy - halfWin; if (y1 < 0) y1 = 0;
    var y2 = yy + halfWin; if (y2 >= h) y2 = h - 1;
    var hWin = y2 - y1 + 1;

    var rowBase2 = yy * w;
    for (var xx = 0; xx < w; xx++) {
      var x1 = xx - halfWin; if (x1 < 0) x1 = 0;
      var x2 = xx + halfWin; if (x2 >= w) x2 = w - 1;
      var wWin = x2 - x1 + 1;
      var count = hWin * wWin;

      var sum = integral[(y2+1)*W + (x2+1)] - integral[y1*W + (x2+1)]
              - integral[(y2+1)*W + x1] + integral[y1*W + x1];
      var sumSq = integralSq[(y2+1)*W + (x2+1)] - integralSq[y1*W + (x2+1)]
                - integralSq[(y2+1)*W + x1] + integralSq[y1*W + x1];

      var mean = sum / count;
      var variance = (sumSq / count) - (mean * mean);
      if (variance < 0) variance = 0;
      var std = Math.sqrt(variance);

      var threshold = mean * (1 + k * (std / R - 1));
      var gv = gray[rowBase2 + xx];
      var out = (gv < threshold) ? 0 : 255;

      var idx = (rowBase2 + xx) * 4;
      data[idx] = out;
      data[idx+1] = out;
      data[idx+2] = out;
    }
  }
}

/* Binarise un canvas en place selon le mode choisi. Retourne le canvas. */
function _scanBinarizeCanvas(canvas, mode) {
  try {
    var ctx = canvas.getContext('2d');
    var w = canvas.width, h = canvas.height;
    var imageData = ctx.getImageData(0, 0, w, h);
    var data = imageData.data;

    /* Conversion en niveaux de gris (une seule allocation) */
    var gray = new Uint8Array(w * h);
    for (var i = 0; i < w * h; i++) {
      var idx = i * 4;
      gray[i] = Math.round(0.299 * data[idx] + 0.587 * data[idx+1] + 0.114 * data[idx+2]);
    }

    if (mode === 'fast') {
      /* Otsu : 1 seul seuil global, très rapide */
      var t = _scanOtsuThreshold(gray);
      for (var j = 0; j < w * h; j++) {
        var out = (gray[j] < t) ? 0 : 255;
        var idx2 = j * 4;
        data[idx2] = out;
        data[idx2+1] = out;
        data[idx2+2] = out;
      }
    } else {
      /* Sauvola : adaptatif local, ~10× plus lent mais meilleur
         sur les photos avec ombres inégales */
      _scanSauvolaBinarize(gray, data, w, h);
    }

    ctx.putImageData(imageData, 0, 0);
    return canvas;
  } catch (e) {
    console.warn('_scanBinarizeCanvas :', e);
    return canvas;
  }
}

/* Redimensionne un canvas si > maxDim. Retourne le canvas (même ou nouveau). */
function _scanResizeCanvasIfNeeded(canvas, maxDim) {
  try {
    if (!canvas) return canvas;
    if (canvas.width <= maxDim && canvas.height <= maxDim) return canvas;

    var ratio = Math.min(maxDim / canvas.width, maxDim / canvas.height);
    var w = Math.round(canvas.width * ratio);
    var h = Math.round(canvas.height * ratio);

    var dst = document.createElement('canvas');
    dst.width = w;
    dst.height = h;
    var ctx = dst.getContext('2d');
    ctx.drawImage(canvas, 0, 0, w, h);
    return dst;
  } catch (e) {
    console.warn('_scanResizeCanvasIfNeeded :', e);
    return canvas;
  }
}

/* Convertit des positions % (0-100) en pixels selon les dimensions img. */
function _scanGetCornersInPixels(imgW, imgH) {
  var pos = __scanCornerPositions;
  if (!pos || pos.length !== 4) {
    var inset = SCAN_CORNER_DEFAULT_INSET_PCT;
    pos = [
      { x: inset, y: inset },
      { x: 100 - inset, y: inset },
      { x: 100 - inset, y: 100 - inset },
      { x: inset, y: 100 - inset }
    ];
  }
  var corners = [];
  for (var i = 0; i < 4; i++) {
    corners.push({
      x: Math.round(pos[i].x / 100 * imgW),
      y: Math.round(pos[i].y / 100 * imgH)
    });
  }
  return corners;
}

/* Charge une dataURL dans un HTMLImageElement (Promise). */
function _scanLoadImage(dataUrl) {
  return new Promise(function (resolve, reject) {
    try {
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error('Image illisible')); };
      img.src = dataUrl;
    } catch (e) { reject(e); }
  });
}

/* Fonction principale : applique le traitement complet. */
function applyScanImprovement(mode) {
  return new Promise(function (resolve, reject) {
    try {
      if (!__scanRawImage) return reject(new Error('Aucune image brute disponible'));

      var effectiveMode = (mode === 'precise') ? 'precise' : 'fast';
      __scanCurrentMode = effectiveMode;

      _scanLoadImage(__scanRawImage).then(function (img) {
        try {
          var corners = _scanGetCornersInPixels(img.naturalWidth, img.naturalHeight);

          /* 1. Warp */
          var warped = _scanApplyPerspectiveWarp(img, corners);
          if (!warped) {
            return reject(new Error('Échec du redressement (coins invalides ?)'));
          }

          /* 2. Resize à 1600 px max (avant binarisation pour perf) */
          var resized = _scanResizeCanvasIfNeeded(warped, 1600);

          /* 3. Binarize */
          var final = _scanBinarizeCanvas(resized, effectiveMode);

          /* 4. Encode JPEG q=0.85 (bimodal → très efficace) */
          var dataUrl = final.toDataURL('image/jpeg', 0.85);
          __scanCapturedImage = dataUrl;
          __scanIsImproved = true;

          var preview = document.getElementById('scanPreview');
          if (preview) preview.src = dataUrl;

          /* UI : masque handles, propose annuler */
          _scanShowCorners(false);
          _scanShowImproveBar(false);
          var undoBtn = document.getElementById('btnUndoScanImprove');
          if (undoBtn) undoBtn.style.display = '';
          var saveDocs = document.getElementById('btnSaveScanToDocs');
          if (saveDocs) saveDocs.style.display = '';
          var saveBtn = document.getElementById('btnSaveScan');
          if (saveBtn) saveBtn.style.display = '';

          resolve(dataUrl);
        } catch (e) { reject(e); }
      }).catch(reject);
    } catch (e) { reject(e); }
  });
}

/* Annule l'amélioration, revient à la photo brute. */
function undoScanImprovement() {
  try {
    if (!__scanRawImage) return;
    __scanCapturedImage = __scanRawImage;
    __scanIsImproved = false;

    var preview = document.getElementById('scanPreview');
    if (preview) preview.src = __scanRawImage;

    _scanShowCorners(true);
    _scanShowImproveBar(true);
    var undoBtn = document.getElementById('btnUndoScanImprove');
    if (undoBtn) undoBtn.style.display = 'none';

    /* Réapplique les handles après un petit délai (img peut être en cours de chargement) */
    setTimeout(function () { _scanRenderCornerHandles(); }, 80);
  } catch (e) { console.warn('undoScanImprovement :', e); }
}
/* ═══════════ v6.10.0 — CORNER HANDLES UI ═══════════ */

function _scanShowCorners(show) {
  try {
    var c = document.getElementById('scanCornersContainer');
    if (c) c.style.display = show ? '' : 'none';
  } catch (e) {}
}

function _scanShowImproveBar(show) {
  try {
    var b = document.getElementById('scanImproveBar');
    if (b) b.style.display = show ? '' : 'none';
  } catch (e) {}
}

/* Initialise les positions par défaut au % (appelé après chargement img). */
function _scanResetCornerPositions() {
  var inset = SCAN_CORNER_DEFAULT_INSET_PCT;
  __scanCornerPositions = [
    { x: inset, y: inset },
    { x: 100 - inset, y: inset },
    { x: 100 - inset, y: 100 - inset },
    { x: inset, y: 100 - inset }
  ];
}

/* Positionne les 4 handles selon __scanCornerPositions. */
function _scanRenderCornerHandles() {
  try {
    if (!__scanCornerPositions) _scanResetCornerPositions();
    var handles = document.querySelectorAll('.scan-corner');
    for (var i = 0; i < handles.length; i++) {
      var idx = parseInt(handles[i].getAttribute('data-corner'), 10);
      if (isNaN(idx) || !__scanCornerPositions[idx]) continue;
      var p = __scanCornerPositions[idx];
      handles[i].style.left = p.x + '%';
      handles[i].style.top = p.y + '%';
    }
  } catch (e) { console.warn('_scanRenderCornerHandles :', e); }
}

function _scanCornerFromEvent(ev, wrapperRect) {
  var clientX = ev.clientX, clientY = ev.clientY;
  if (ev.touches && ev.touches[0]) {
    clientX = ev.touches[0].clientX;
    clientY = ev.touches[0].clientY;
  }
  var px = (clientX - wrapperRect.left) / wrapperRect.width * 100;
  var py = (clientY - wrapperRect.top) / wrapperRect.height * 100;
  if (px < 0) px = 0; if (px > 100) px = 100;
  if (py < 0) py = 0; if (py > 100) py = 100;
  return { x: px, y: py };
}

function _scanStartCornerDrag(ev, idx, handle) {
  try {
    ev.preventDefault();
    if (!__scanCornerPositions) _scanResetCornerPositions();
    __scanCornerDragState = { idx: idx, handle: handle };
    handle.classList.add('dragging');
  } catch (e) { console.warn('_scanStartCornerDrag :', e); }
}

function _scanMoveCornerDrag(ev) {
  try {
    if (!__scanCornerDragState) return;
    ev.preventDefault();
    var wrapper = document.getElementById('scanPreviewWrapper');
    if (!wrapper) return;
    var wrapperRect = wrapper.getBoundingClientRect();
    var pos = _scanCornerFromEvent(ev, wrapperRect);
    __scanCornerPositions[__scanCornerDragState.idx] = pos;
    var h = __scanCornerDragState.handle;
    h.style.left = pos.x + '%';
    h.style.top = pos.y + '%';
  } catch (e) { /* silencieux */ }
}

function _scanEndCornerDrag() {
  try {
    if (__scanCornerDragState && __scanCornerDragState.handle) {
      __scanCornerDragState.handle.classList.remove('dragging');
    }
    __scanCornerDragState = null;
  } catch (e) {}
}

function _scanAttachCornerEvents() {
  try {
    var handles = document.querySelectorAll('.scan-corner');
    for (var i = 0; i < handles.length; i++) {
      (function (handle) {
        if (handle.__bound) return;
        handle.__bound = true;
        var idx = parseInt(handle.getAttribute('data-corner'), 10);

        handle.addEventListener('mousedown', function (ev) {
          _scanStartCornerDrag(ev, idx, handle);
        });
        handle.addEventListener('touchstart', function (ev) {
          _scanStartCornerDrag(ev, idx, handle);
        }, { passive: false });
      })(handles[i]);
    }

    /* Listeners globaux (une seule fois) */
    if (!window.__scanCornerGlobalBound) {
      window.__scanCornerGlobalBound = true;
      document.addEventListener('mousemove', _scanMoveCornerDrag);
      document.addEventListener('touchmove', _scanMoveCornerDrag, { passive: false });
      document.addEventListener('mouseup', _scanEndCornerDrag);
      document.addEventListener('touchend', _scanEndCornerDrag);
      document.addEventListener('touchcancel', _scanEndCornerDrag);
    }
  } catch (e) { console.warn('_scanAttachCornerEvents :', e); }
}

function _scanSetMode(mode) {
  try {
    __scanCurrentMode = (mode === 'precise') ? 'precise' : 'fast';
    var btnFast = document.getElementById('btnScanModeFast');
    var btnPrecise = document.getElementById('btnScanModePrecise');
    if (btnFast) btnFast.classList.toggle('active', __scanCurrentMode === 'fast');
    if (btnPrecise) btnPrecise.classList.toggle('active', __scanCurrentMode === 'precise');
  } catch (e) {}
}

/* Affiche le spinner + désactive les boutons pendant le calcul. */
function _scanSetProcessing(active, message) {
  try {
    var wrap = document.getElementById('scanPreviewWrapper');
    var spin = document.getElementById('scanProcessingSpinner');
    if (spin) {
      spin.style.display = active ? 'flex' : 'none';
      var txt = document.getElementById('scanProcessingMsg');
      if (txt && message) txt.textContent = message;
    }
    var applyBtn = document.getElementById('btnApplyScanImprove');
    if (applyBtn) applyBtn.disabled = !!active;
    var fastBtn = document.getElementById('btnScanModeFast');
    if (fastBtn) fastBtn.disabled = !!active;
    var precBtn = document.getElementById('btnScanModePrecise');
    if (precBtn) precBtn.disabled = !!active;
  } catch (e) {}
}

/* Handler du bouton "Améliorer". */
function handleApplyScanImprovement() {
  var mode = __scanCurrentMode || 'fast';
  var msg = (mode === 'precise') ? 'Traitement précis (1-2 s)…' : 'Traitement rapide…';
  _scanSetProcessing(true, msg);
  setTimeout(function () {
    applyScanImprovement(mode).then(function () {
      _scanSetProcessing(false, '');
      if (typeof showToast === 'function') {
        showToast('Document amélioré (' + (mode === 'precise' ? 'précis' : 'rapide') + ')', 'success', 2500);
      }
    }).catch(function (err) {
      _scanSetProcessing(false, '');
      if (typeof showToast === 'function') {
        showToast('Échec : ' + (err.message || err), 'error', 4000);
      }
    });
  }, 30); /* laisse le spinner s'afficher */
}

/* Enregistre le scan dans la bibliothèque Documents. */
function saveScanToDocuments() {
  try {
    if (!__scanCapturedImage) {
      if (typeof showToast === 'function') showToast('Aucune image à enregistrer.', 'warning');
      return;
    }
    if (typeof _docLibCreateEntry !== 'function' || typeof _dataURLToBlob !== 'function') {
      if (typeof showToast === 'function') showToast('Module Documents indisponible.', 'error');
      return;
    }

    var filename = 'scan_' + new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-') + '.jpg';

    _dataURLToBlob(__scanCapturedImage).then(function (blob) {
      /* Crée un File pour profiter du .name */
      var file;
      try {
        file = new File([blob], filename, { type: blob.type || 'image/jpeg' });
      } catch (e) {
        /* Fallback : Enrichit le Blob manuellement (anciens navigateurs) */
        blob.name = filename;
        file = blob;
      }
      return _docLibCreateEntry(file, {
        nom: 'Scan ' + new Date().toLocaleString('fr-FR'),
        categorie: 'facture',
        date: (typeof todayISO === 'function') ? todayISO() : '',
        tags: ['scan'],
        notes: 'Créé via scanner'
      });
    }).then(function (entry) {
      if (typeof showToast === 'function') {
        showToast('Scan enregistré dans Documents : ' + (entry.nom || ''), 'success', 3000);
      }
      closeScanner();
      /* Si la section Documents est ouverte, refresh */
      if (typeof renderDocuments === 'function') {
        try { renderDocuments(); } catch (e) {}
      }
    }).catch(function (err) {
      if (typeof showToast === 'function') {
        showToast('Échec enregistrement : ' + (err.message || err), 'error', 4000);
      }
    });
  } catch (e) { console.warn('saveScanToDocuments :', e); }
}

console.log('✅ 15-scan-sign.js chargé — v6.10.0 (CamScanner offline + perspective + Sauvola)');