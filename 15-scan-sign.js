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
    _scanShow('scanPreviewContainer', false);
    _scanShow('scanVideoContainer', false);
    _scanShow('scanEmptyHint', true);

    var camBtn = document.getElementById('btnStartCamera');
    if (camBtn) camBtn.disabled = false;
    if (camBtn) camBtn.style.display = '';

    var stopBtn = document.getElementById('btnStopCamera');
    if (stopBtn) stopBtn.style.display = 'none';

    var capBtn = document.getElementById('btnCapturePhoto');
    if (capBtn) capBtn.style.display = 'none';

    var prev = document.getElementById('scanPreview');
    if (prev) prev.removeAttribute('src');

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

    var img = document.getElementById('scanPreview');
    if (img) img.src = dataUrl;
    _scanShow('scanPreviewContainer', true);
    _scanShow('scanEmptyHint', false);

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

    var img = document.getElementById('scanPreview');
    if (img) img.src = dataUrl;
    _scanShow('scanPreviewContainer', true);
    _scanShow('scanActions', true);
    _scanShow('scanEmptyHint', false);
    _scanShow('scanVideoContainer', false);
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
  } catch (e) { console.warn('attachScanSignEvents :', e); }
}

/* Cleanup caméra si on quitte */
try {
  window.addEventListener('beforeunload', function () { try { stopCamera(); } catch (e) {} });
} catch (e) {}

console.log('✅ 15-scan-sign.js chargé — v6.7 (Session #3 — version unifiée, fix resize inclus)');