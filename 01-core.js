/* ═══════════════════════════════════════════════════════════════
   VOLTCORE — 01-core.js
   VERSION : v6.7 (Session #3 — protection localStorage, gestion
                   propre du cas "storage bloqué", versions bumpées)
   RÔLE : Variables globales, détection matérielle, licence ECDSA P-256
   DÉPENDANCES : aucune
   EXPOSE : window.VoltCore, initialiserVoltCore,
            verifyVoltcoreLicense, showLicenseGate,
            setLicenseExpiryBadge, scheduleLicenseRecheck,
            bootWithLicense, activateVoltcoreLicense,
            exportBackupFromLicenseGate, localLicenseDate
   CONSOMME : window.crypto.subtle, localStorage (license token)
   SECTION 1 : VARIABLES GLOBALES
   SECTION 2 : DÉTECTION MATÉRIELLE (window.VoltCore)
   SECTION 3 : LICENCE ECDSA P-256
   SECTION 4 : DÉMARRAGE
   ═══════════════════════════════════════════════════════════════ */

/* ═══════════ SECTION 1 — VARIABLES GLOBALES ═══════════ */

/* ─── Données applicatives ─── */
var users = [];
var currentUser = null;

var clients = [];
var savedArticles = [];
var savedDocuments = [];
var familles = [];
var savedChantiers = [];

var hrEmployees = [];
var hrWorkEntries = [];
var hrTransactions = [];

var purchaseInvoices = [];
var purchaseModalLines = [];
var editingPurchaseInvoiceId = null;
var currentSupplierPaymentInvoiceId = null;

var currentInvoiceItems = [];

var trash = { clients: [], articles: [], documents: [] };

var suppliers = [];
var selectedDocs = [];
var frais = [];

/* v6.9.0 — Bons Route (traçabilité Sfax↔Tunis, HORS comptabilité) */
var bonsRoute = [];

/* ─── Coordonnées société par défaut ───
   v6.8.1 : ajout de bankRNE (Registre National des Entreprises)
   pour sortir le numéro RNE hardcodé de 12-invoices-view.js.
   Configurable via Paramètres → Outils quand le champ HTML
   settingsRNE sera ajouté (Étape 2 — Câblage Garantie). */
var bankRib = "07 054 0112101102584 69";
var bankName = "AMEN BANK";
var bankMF = "1977463P / A / M / 000";
var bankRNE = "1977463P";

/* ─── Journal d'activité ─── */
var activityLog = [];

/* ─── Pièces jointes en cours ─── */
var currentAttachments = [];

/* ─── État d'édition ─── */
var editDocIndex = -1;
var editAttachments = [];
var editingExistingDocIndex = -1;
var currentDocFilter = 'all';
var editingChantierId = null;
var editingHREmployeeId = null;

/* ─── Horodatage dernière modification ─── */
var __lastDataChange = Date.now();

/* ─── Filtre stock actif ─── */
window.__stockShowMode = 'actif';

/* ─── Instances des graphiques ─── */
var chartCAInstance = null;
var chartFamillesInstance = null;
var chartPaiementsInstance = null;
var chartMargeChantiersInstance = null;

/* ─── Minuteries / débounces ─── */
var __logSaveTimer = null;
var __stockSearchTimer = null;
var __docSearchTimer = null;
var __globalSearchTimer = null;

/* ─── Sécurité / inactivité ─── */
var __inactivityTimer = null;
var __inactivityLastReset = 0;
var VOLTCORE_INACTIVITY_DELAY = 5 * 60 * 1000;

/* ─── Init app guard (empêche la double initialisation) ─── */
var __appInitialized = false;

/* ─── Constantes documents ─── */
var VOLTCORE_MAX_DOCUMENT_QTY = 10000000;
var VOLTCORE_MAX_DOCUMENT_PU = 1000000;

/* ─── Sauvegarde dossier ─── */
var savedDirHandle = null;

/* v6.10.2 — currentBonType/Data supprimés (bons A/B/C/D redondants) */

/* ─── Pagination RH ─── */
var __hrWorkPage = 0;
var __hrTxPage = 0;
var __hrPerPage = 50;

/* ─── Enregistreur vocal ─── */
var __voiceRecorder = null;
var __voiceChunks = [];
var __voiceStream = null;
var __voiceStartTime = 0;
var __voiceTimerInterval = null;

/* ─── Pagination stock ─── */
var __stockPage = 0;
var __stockPerPage = 50;
var __stockFilteredList = [];
var __stockIndexMap = null;

/* ═══════════ SECTION 2 — DÉTECTION MATÉRIELLE ═══════════ */

window.VoltCore = {
  estMobile: false,
  estHTTPS: false,
  aCamera: false,
  aBiometrie: false,
  aPleinEcran: false,
  aStockageLocal: false,
  aNotification: false,
  aPartage: false,
  estPret: false
};

/* Fonction d'initialisation asynchrone des capacités.
   Lancée au chargement de ce fichier. Émet 'voltcore:ready' à la fin. */
async function initialiserVoltCore() {
  console.log("⚙️ Initialisation de VoltCore...");

  /* 1. Détection Mobile ou PC */
  try {
    window.VoltCore.estMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
  } catch (e) {
    console.warn('Détection mobile échouée :', e);
  }

  /* 2. Détection HTTPS (obligatoire pour biométrie + caméra) */
  try {
    window.VoltCore.estHTTPS = location.protocol === 'https:' ||
      location.hostname === 'localhost' ||
      location.hostname === '127.0.0.1';
  } catch (e) {
    console.warn('Détection HTTPS échouée :', e);
  }

  /* 3. Détection Caméra */
  try {
    window.VoltCore.aCamera = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  } catch (e) {
    console.warn('Détection caméra échouée :', e);
  }

  /* 4. Détection Biométrie (WebAuthn) */
  if (window.PublicKeyCredential && window.VoltCore.estHTTPS) {
    try {
      window.VoltCore.aBiometrie = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
    } catch (e) {
      window.VoltCore.aBiometrie = false;
    }
  }

  /* 5. Détection Plein Écran (préfixes navigateurs) */
  try {
    window.VoltCore.aPleinEcran = !!(
      document.documentElement.requestFullscreen ||
      document.documentElement.webkitRequestFullscreen ||
      document.documentElement.mozRequestFullScreen ||
      document.documentElement.msRequestFullscreen
    );
  } catch (e) {
    console.warn('Détection plein écran échouée :', e);
  }

  /* 6. Détection Stockage Local */
  try {
    localStorage.setItem('voltcore_test', 'ok');
    localStorage.removeItem('voltcore_test');
    window.VoltCore.aStockageLocal = true;
  } catch (e) {
    window.VoltCore.aStockageLocal = false;
  }

  /* 7. Détection Notifications */
  try {
    window.VoltCore.aNotification = "Notification" in window;
  } catch (e) {
    window.VoltCore.aNotification = false;
  }

  /* 8. Détection Partage Natif (Web Share API) */
  try {
    window.VoltCore.aPartage = !!navigator.share;
  } catch (e) {
    window.VoltCore.aPartage = false;
  }

  window.VoltCore.estPret = true;

  /* Rapport dans la console */
  try {
    console.log("📊 Rapport de compatibilité VoltCore :", window.VoltCore);
    if (window.VoltCore.estMobile) console.log("📱 Mode : Mobile détecté");
    else console.log("💻 Mode : PC / Bureau détecté");
    if (!window.VoltCore.estHTTPS) console.warn("⚠️ Pas en HTTPS. La biométrie et la caméra seront bloquées.");
    if (!window.VoltCore.aBiometrie) console.warn("⚠️ Biométrie non disponible.");
    if (!window.VoltCore.aCamera) console.warn("⚠️ Caméra non disponible.");
    if (!window.VoltCore.aStockageLocal) console.warn("⚠️ Stockage local bloqué. Les sauvegardes seront perdues.");
  } catch (e) { /* console indisponible */ }

  /* Prévient les autres scripts que tout est prêt */
  try {
    window.dispatchEvent(new Event('voltcore:ready'));
  } catch (e) {
    console.warn('Impossible d\'émettre voltcore:ready :', e);
  }
}

/* Lancement protégé — un échec ne bloque pas le chargement */
(function lancerInitialisationVoltCore() {
  try {
    var p = initialiserVoltCore();
    if (p && typeof p.catch === 'function') {
      p.catch(function (e) {
        console.warn('initialiserVoltCore a échoué :', e);
        if (window.VoltCore) window.VoltCore.estPret = true;
        try { window.dispatchEvent(new Event('voltcore:ready')); } catch (_) {}
      });
    }
  } catch (e) {
    console.warn('Erreur synchrone dans initialiserVoltCore :', e);
    if (window.VoltCore) window.VoltCore.estPret = true;
    try { window.dispatchEvent(new Event('voltcore:ready')); } catch (_) {}
  }
})();

/* ═══════════ SECTION 3 — LICENCE ECDSA P-256 ═══════════ */

var VOLTCORE_LICENSE_PUBLIC_SPKI = 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEiKQJS0e73Id8r/SC4FcsMoFo0acCBiXK2HuscUjg7SOifmW5L/yr1TfZXNBdtmMPzTb+dMtAKzpqnT6SZQfahQ==';
var VOLTCORE_LICENSE_GRACE_DAYS = 14;
var voltcoreLicenseTimer = null;

/* v6.7 — Test de disponibilité du stockage local.
   Évite les crashs en mode privé Safari ou cookies bloqués. */
function _isStorageAvailable() {
  try {
    var k = '__voltcore_storage_test_' + Date.now();
    localStorage.setItem(k, '1');
    var v = localStorage.getItem(k);
    localStorage.removeItem(k);
    return v === '1';
  } catch (e) {
    return false;
  }
}

/* Décodage base64url → bytes */
function licenseB64UrlBytes(value) {
  var b64 = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  var binary = atob(b64);
  var bytes = new Uint8Array(binary.length);
  for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/* Validation date YYYY-MM-DD → Date UTC */
function licenseDateValue(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  var date = new Date(value + 'T00:00:00.000Z');
  if (isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) return null;
  return date;
}

/* Date du jour au format YYYY-MM-DD (locale) */
function localLicenseDate() {
  var d = new Date();
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

/* Vérification signature ECDSA + période de validité + anti-rollback
   v6.7 : détecte en amont si localStorage est bloqué et retourne
   { ok: false, reason: 'storage' } (message clair côté UI) au lieu
   de retourner 'invalid' (message trompeur "clé invalide"). */
async function verifyVoltcoreLicense(token) {
  if (!window.crypto || !window.crypto.subtle) return { ok: false, reason: 'unsupported' };
  /* v6.7 — garde-fou : storage bloqué → message dédié */
  if (!_isStorageAvailable()) return { ok: false, reason: 'storage' };
  try {
    var parts = String(token || '').trim().split('.');
    if (parts.length !== 3 || parts[0] !== 'VC1') return { ok: false, reason: 'invalid' };
    var payloadBytes = licenseB64UrlBytes(parts[1]);
    var signature = licenseB64UrlBytes(parts[2]);
    if (signature.length !== 64) return { ok: false, reason: 'invalid' };
    var payload = JSON.parse(new TextDecoder().decode(payloadBytes));
    if (!payload || payload.v !== 1 || payload.p !== 'VOLTCORE' || payload.i !== '1977463P' || payload.n !== 'VOLTCORE INGENIERIE') {
      return { ok: false, reason: 'invalid' };
    }
    var issued = licenseDateValue(payload.issued);
    var expires = licenseDateValue(payload.expires);
    var today = localLicenseDate();
    if (!issued || !expires || payload.expires < payload.issued || payload.issued > today) {
      return { ok: false, reason: 'invalid' };
    }
    var maxExpiry = new Date(issued.getTime());
    maxExpiry.setUTCDate(maxExpiry.getUTCDate() + 370);
    if (expires.getTime() > maxExpiry.getTime()) return { ok: false, reason: 'invalid' };
    var publicBytes = Uint8Array.from(atob(VOLTCORE_LICENSE_PUBLIC_SPKI), function (c) { return c.charCodeAt(0); });
    var publicKey = await window.crypto.subtle.importKey(
      'spki', publicBytes,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false, ['verify']
    );
    var signatureOk = await window.crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      publicKey, signature,
      new TextEncoder().encode(parts[1])
    );
    if (!signatureOk) return { ok: false, reason: 'invalid' };
    /* Anti-rollback : la date ne doit pas avoir reculé de plus d'1 jour */
    var lastSeenText = '';
    try {
      lastSeenText = localStorage.getItem('voltcore_license_last_seen') || '';
    } catch (e) {
      /* v6.7 — lecture protégée, on ignore le check anti-rollback
         si on ne peut pas lire le dernier marqueur. */
      lastSeenText = '';
    }
    var lastSeen = licenseDateValue(lastSeenText);
    if (lastSeen) {
      var rollbackLimit = new Date(lastSeen.getTime());
      rollbackLimit.setUTCDate(rollbackLimit.getUTCDate() - 1);
      if (today < rollbackLimit.toISOString().slice(0, 10)) {
        return { ok: false, reason: 'clock', expires: payload.expires };
      }
    }
    if (!lastSeen || today > lastSeenText) {
      try { localStorage.setItem('voltcore_license_last_seen', today); } catch (e) {}
    }
    /* Grâce 14 jours après expiration */
    var graceEnd = new Date(expires.getTime());
    graceEnd.setUTCDate(graceEnd.getUTCDate() + VOLTCORE_LICENSE_GRACE_DAYS);
    var graceEndText = graceEnd.toISOString().slice(0, 10);
    if (today > graceEndText) return { ok: false, reason: 'expired', expires: payload.expires };
    return {
      ok: true,
      payload: payload,
      grace: today > payload.expires,
      graceEnd: graceEndText
    };
  } catch (e) {
    return { ok: false, reason: 'invalid' };
  }
}

/* Affichage de la porte de licence */
function showLicenseGate(result) {
  var skeleton = document.getElementById('appSkeleton');
  if (skeleton) skeleton.style.display = 'none';
  var login = document.getElementById('loginModal');
  var modal = document.getElementById('licenseModal');
  var status = document.getElementById('licenseStatus');
  if (login) login.style.display = 'none';
  if (modal) modal.style.display = 'flex';
  if (!status) return;
  if (result && result.reason === 'storage') {
    /* v6.7 — cas mode privé / cookies bloqués */
    status.textContent = 'Le stockage du navigateur est bloqué (mode privé, cookies refusés, ou paramètre de confidentialité). ' +
      'Autorise le stockage local pour cet onglet et recharge la page pour ouvrir VOLTCORE. ' +
      'Tu peux toujours exporter tes données via le bouton ci-dessous (mais il n\'y aura rien à exporter tant que le stockage est bloqué).';
  } else if (result && result.reason === 'unsupported') {
    status.textContent = 'La vérification hors ligne nécessite un navigateur récent comme Chrome ou Edge. Vos données restent dans ce navigateur.';
  } else if (result && result.reason === 'clock') {
    status.textContent = 'La date de cet ordinateur semble avoir reculé. Rétablis la date correcte pour vérifier la licence. Tu peux toujours exporter tes données.';
  } else if (result && result.reason === 'expired') {
    status.textContent = 'La clé a expiré le ' + result.expires + ' et la période de grâce est terminée. Colle une nouvelle clé pour continuer. Tu peux toujours exporter tes données ci-dessous.';
  } else if (result && result.reason === 'invalid') {
    status.textContent = 'La clé est invalide ou ne correspond pas à VOLTCORE INGENIERIE. Vérifie qu\'elle est copiée en entier.';
  } else {
    status.textContent = 'Une clé annuelle signée est nécessaire pour ouvrir l\'application. Colle la clé fournie par l\'administrateur.';
  }
}

/* Affichage du badge d'expiration dans le top-bar */
function setLicenseExpiryBadge(result) {
  var badge = document.getElementById('licenseExpiryBadge');
  if (!badge || !result || !result.payload) return;
  badge.textContent = 'Licence jusqu\'au ' + result.payload.expires +
    (result.grace ? ' · renouvellement requis' : '');
  badge.title = 'Clé hors ligne VOLTCORE INGENIERIE';
}

/* Re-vérifie la licence toutes les heures
   v6.7 : lecture du token protégée par try/catch. */
function scheduleLicenseRecheck() {
  if (voltcoreLicenseTimer) clearInterval(voltcoreLicenseTimer);
  voltcoreLicenseTimer = setInterval(async function () {
    var token = '';
    try {
      token = localStorage.getItem('voltcore_license_token') || '';
    } catch (e) {
      /* Storage bloqué : on ne peut plus rien vérifier, on laisse
         l'app tourner avec la dernière validation connue. */
      return;
    }
    var result = await verifyVoltcoreLicense(token);
    if (!result.ok) showLicenseGate(result);
    else setLicenseExpiryBadge(result);
  }, 60 * 60 * 1000);
}

/* ═══════════ SECTION 4 — DÉMARRAGE ═══════════ */

/* Démarrage avec vérification de licence.
   Appelée par bootSequence() dans 21-init-app.js.
   Si licence valide → checkLogin() (dans 02-auth.js).

   v6.7 : lecture du token protégée par try/catch. Si storage bloqué,
   on affiche la porte de licence avec un message clair au lieu de
   planter au démarrage. */
async function bootWithLicense() {
  /* v6.7 — test storage en amont */
  if (!_isStorageAvailable()) {
    showLicenseGate({ ok: false, reason: 'storage' });
    return;
  }

  var token = '';
  try {
    token = localStorage.getItem('voltcore_license_token') || '';
  } catch (e) {
    console.warn('bootWithLicense — lecture token bloquée :', e);
    showLicenseGate({ ok: false, reason: 'storage' });
    return;
  }

  var result = token
    ? await verifyVoltcoreLicense(token)
    : { ok: false, reason: 'missing' };
  if (!result.ok) {
    showLicenseGate(result);
    return;
  }
  var modal = document.getElementById('licenseModal');
  if (modal) modal.style.display = 'none';
  setLicenseExpiryBadge(result);
  scheduleLicenseRecheck();
  if (result.grace && typeof showToast === 'function') {
    showToast('La licence a expiré le ' + result.payload.expires + '. Renouvelle-la pendant la période de grâce.', 'error');
  }
  if (typeof checkLogin === 'function') checkLogin();
}

/* Activation d'une clé depuis la porte de licence */
async function activateVoltcoreLicense() {
  var button = document.getElementById('activateLicenseBtn');
  var status = document.getElementById('licenseStatus');
  if (button) button.disabled = true;
  if (status) status.textContent = 'Vérification de la clé…';
  var input = document.getElementById('licenseKeyInput');
  var token = input ? input.value.replace(/\s+/g, '') : '';
  var result = await verifyVoltcoreLicense(token);
  if (!result.ok) {
    if (button) button.disabled = false;
    showLicenseGate(result);
    return;
  }
  try {
    localStorage.setItem('voltcore_license_token', token);
  } catch (e) {
    if (button) button.disabled = false;
    if (status) status.textContent = 'Impossible d\'enregistrer la clé dans ce navigateur.';
    return;
  }
  if (button) button.disabled = false;
  if (input) input.value = '';
  bootWithLicense();
}

/* Export de secours depuis la porte de licence (si bloqué) */
function exportBackupFromLicenseGate() {
  try {
    if (typeof loadAll === 'function') loadAll();
    if (typeof loadFrais === 'function') loadFrais();
    if (typeof buildCompleteBackupData === 'function') {
      var data = buildCompleteBackupData();
      var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      if (typeof exportWithPicker === 'function') {
        exportWithPicker(blob, 'VOLTCORE_sauvegarde_' + localLicenseDate() + '.json');
      } else {
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = 'VOLTCORE_sauvegarde_' + localLicenseDate() + '.json';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
      }
      var statusEl = document.getElementById('licenseStatus');
      if (statusEl) statusEl.textContent = 'Sauvegarde exportée. Tu peux maintenant activer une clé pour continuer.';
    }
  } catch (e) {
    var statusEl2 = document.getElementById('licenseStatus');
    if (statusEl2) statusEl2.textContent = 'La sauvegarde n\'a pas pu être créée depuis ce navigateur.';
  }
}

console.log('✅ 01-core.js chargé — v6.7 (fondations + protection storage)');