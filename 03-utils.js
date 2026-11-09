/* ═══════════════════════════════════════════════════════════════
   VOLTCORE — 03-utils.js
   VERSION : v6.6 (LOT 2 + LOT 5 + Session #3 — computeLineTotal,
                   downloadBlob, Promise helpers, numberToFrenchWords)
   RÔLE : Helpers réutilisables partout (chaînes, nombres, dates,
          toasts avec undo, dialogues, DOM, fichiers, images,
          calculs de lignes BTP, montants en toutes lettres)
   DÉPENDANCES : aucune
   EXPOSE : escapeHtml, escapeAttr, normalizeText,
            formatMoney, dt, parseNumber, formatNumber,
            computeLineTotal,
            todayISO, formatDate, addDaysISO, compareISO,
            isValidDateString, daysBetweenISO,
            showToast, showUndoToast,
            confirmDialog, confirmDialogAsync,
            promptDialog, promptDialogAsync,
            debounce, throttle,
            generateId, sleep,
            formatBytes, downloadBlob, _fallbackDownload,
            copyToClipboard, compressImage, compressImageWithFeedback,
            numberToFrenchWords  ← NOUVEAU Session #3
   SECTION 1 : HELPERS CHAÎNES
   SECTION 2 : HELPERS NOMBRES + CALCULS LIGNES (computeLineTotal)
   SECTION 3 : HELPERS DATES
   SECTION 4 : TOASTS (avec undo — Amélioration B)
   SECTION 5 : DIALOGUES (sync + async)
   SECTION 6 : HELPERS DOM (debounce, throttle)
   SECTION 7 : ID + SLEEP
   SECTION 8 : HELPERS FICHIERS (download, copy, bytes)
   SECTION 9 : COMPRESSION IMAGES (Amélioration H)
   SECTION 10 : NOMBRES EN LETTRES (numberToFrenchWords — Session #3)
   ═══════════════════════════════════════════════════════════════ */

/* ═══════════ SECTION 1 — HELPERS CHAÎNES ═══════════ */

/* Échappe le HTML pour éviter les XSS dans innerHTML */
function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* Échappe une valeur destinée à un attribut HTML (double quotes) */
function escapeAttr(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/* Normalise une chaîne pour la recherche : minuscules, sans accents */
function normalizeText(str) {
  if (!str) return '';
  try {
    return String(str).toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
  } catch (e) {
    return String(str).toLowerCase();
  }
}

/* ═══════════ SECTION 2 — HELPERS NOMBRES + CALCULS LIGNES ═══════════ */

/* Formate un nombre en dinars tunisiens : 1234.5 → "1 234,500 DT"
   v6.8.1 — Normalisation des espaces.
   Chrome 80+ utilise U+202F (espace fine insécable) dans
   toLocaleString('fr-FR'), Firefox utilise U+00A0, et les tests
   attendent U+0020 (espace normal). Sans normalisation, le rendu
   varie selon navigateur + copier-coller Excel cassé + tests KO.
   On force U+0020 pour cohérence universelle. */
function formatMoney(n) {
  var num = parseFloat(n);
  if (!isFinite(num)) return '0,000 DT';
  try {
    var s = num.toLocaleString('fr-FR', {
      minimumFractionDigits: 3,
      maximumFractionDigits: 3
    });
    /* U+202F (fine insécable) + U+2009 (fine) + U+00A0 (insécable) → U+0020 */
    s = s.replace(/[\u202F\u2009\u00A0]/g, ' ');
    return s + ' DT';
  } catch (e) {
    return num.toFixed(3).replace('.', ',') + ' DT';
  }
}

/* Alias historique très utilisé dans v5.0 */
function dt(n) {
  return formatMoney(n);
}

/* Parse un nombre depuis une chaîne.
   Supporte formats FR (1 234,56), US (1,234.56) et mixtes.
   Ex : parseNumber('1.234,56') → 1234.56
        parseNumber('1,234.56') → 1234.56
        parseNumber('1234,56')  → 1234.56
        parseNumber('1234.56')  → 1234.56 */
function parseNumber(value) {
  if (typeof value === 'number') return isFinite(value) ? value : 0;
  if (value === null || value === undefined) return 0;
  var s = String(value).trim();
  if (!s) return 0;

  /* Retire les espaces (séparateur de milliers FR) */
  s = s.replace(/\s/g, '');
  /* Retire les caractères non pertinents (garde chiffres, . , -) */
  s = s.replace(/[^\d.,\-]/g, '');
  if (!s) return 0;

  var hasComma = s.indexOf(',') >= 0;
  var hasDot = s.indexOf('.') >= 0;

  if (hasComma && hasDot) {
    /* Ambigu : on regarde le DERNIER séparateur */
    var lastComma = s.lastIndexOf(',');
    var lastDot = s.lastIndexOf('.');
    if (lastComma > lastDot) {
      /* FR : "1.234,56" → milliers = point, décimal = virgule */
      s = s.replace(/\./g, '').replace(',', '.');
    } else {
      /* US : "1,234.56" → milliers = virgule, décimal = point */
      s = s.replace(/,/g, '');
    }
  } else if (hasComma) {
    /* Virgule seule = décimal FR : "1234,56" */
    s = s.replace(',', '.');
  }
  /* else : point seul = décimal (format JS natif), on garde tel quel */

  var n = parseFloat(s);
  return isFinite(n) ? n : 0;
}

/* Formate un nombre sans devise, sans décimales inutiles */
function formatNumber(n, decimals) {
  var num = parseFloat(n);
  if (!isFinite(num)) return '0';
  var d = (typeof decimals === 'number') ? decimals : 0;
  try {
    return num.toLocaleString('fr-FR', {
      minimumFractionDigits: d,
      maximumFractionDigits: d
    });
  } catch (e) {
    return num.toFixed(d).replace('.', ',');
  }
}

/* ═══ computeLineTotal — CALCUL TOTAL D'UNE LIGNE BTP ═══
   Rétablie au LOT 5 (avait été perdue entre v6.0 et v6.2).
   Formule : totalNet = (qte × pu) × (1 - remisePct/100) - remiseMontant
   Arrondi à 3 décimales (millimes tunisiens).
   Supporte plusieurs signatures pour compatibilité :

     1) computeLineTotal({ qte, pu, remisePct?, remiseMontant? })
        accepte aussi { quantite, prixUnitaire, prix, remise }
     2) computeLineTotal(qte, pu)
     3) computeLineTotal(qte, pu, remise)   (remise ≤ 100 = %, sinon = montant)

   Cas BTP typiques :
     - Devis avec remise ligne 5% : { qte: 2, pu: 100, remisePct: 5 } → 190
     - Avoir (qte négative)      : { qte: -1, pu: 100 } → -100
     - Remise montant fixe       : { qte: 1, pu: 500, remiseMontant: 50 } → 450
*/
function computeLineTotal(a, b, c) {
  var qte = 0, pu = 0, remisePct = 0, remiseMontant = 0;

  if (a && typeof a === 'object') {
    /* Signature objet (la plus courante) */
    qte = parseNumber(a.qte != null ? a.qte : a.quantite);
    pu = parseNumber(
      a.pu != null ? a.pu :
      (a.prixUnitaire != null ? a.prixUnitaire :
       (a.prix != null ? a.prix : 0))
    );
    remisePct = parseNumber(a.remisePct);
    remiseMontant = parseNumber(a.remiseMontant);

    /* Support du champ `remise` générique (rétrocompat) */
    if (!remisePct && !remiseMontant && a.remise != null) {
      var r = parseNumber(a.remise);
      if (r > 0 && r <= 100) remisePct = r;
      else remiseMontant = r;
    }
  } else {
    /* Signature (qte, pu, remise?) */
    qte = parseNumber(a);
    pu = parseNumber(b);
    var r2 = parseNumber(c);
    if (r2 > 0 && r2 <= 100) remisePct = r2;
    else remiseMontant = r2;
  }

  /* Garde-fous : clamp pourcentages */
  if (remisePct < 0) remisePct = 0;
  if (remisePct > 100) remisePct = 100;

  var totalBrut = qte * pu;
  var montantRemisePct = totalBrut * (remisePct / 100);
  var totalNet = totalBrut - montantRemisePct - remiseMontant;

  /* Arrondi à 3 décimales (millimes) */
  return Math.round(totalNet * 1000) / 1000;
}

/* ═══════════ SECTION 3 — HELPERS DATES ═══════════ */

/* Date du jour au format YYYY-MM-DD (heure locale) */
function todayISO() {
  var d = new Date();
  var y = d.getFullYear();
  var m = String(d.getMonth() + 1).padStart(2, '0');
  var day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

/* Formate une date ISO en JJ/MM/AAAA pour affichage */
function formatDate(iso) {
  if (!iso || typeof iso !== 'string') return '';
  var parts = iso.slice(0, 10).split('-');
  if (parts.length !== 3) return iso;
  return parts[2] + '/' + parts[1] + '/' + parts[0];
}

/* Ajoute n jours à une date ISO */
function addDaysISO(iso, n) {
  if (!isValidDateString(iso)) return '';
  var d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() + (parseInt(n, 10) || 0));
  var y = d.getFullYear();
  var m = String(d.getMonth() + 1).padStart(2, '0');
  var day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

/* Compare deux dates ISO : -1, 0, +1 */
function compareISO(a, b) {
  if (!a) return b ? -1 : 0;
  if (!b) return a ? 1 : 0;
  return a < b ? -1 : (a > b ? 1 : 0);
}

/* Vérifie qu'une chaîne est une date ISO valide YYYY-MM-DD */
function isValidDateString(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  var d = new Date(s + 'T12:00:00');
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/* Nombre de jours entre deux dates ISO (b - a) */
function daysBetweenISO(a, b) {
  if (!isValidDateString(a) || !isValidDateString(b)) return 0;
  var da = new Date(a + 'T12:00:00').getTime();
  var db = new Date(b + 'T12:00:00').getTime();
  return Math.round((db - da) / 86400000);
}

/* ═══════════ SECTION 4 — TOASTS (Amélioration B : undo) ═══════════ */

/* Toast classique : showToast('Message', 'success', 3000)
   Types : 'success', 'error', 'warning', 'info' */
function showToast(message, type, duration) {
  try {
    var container = document.getElementById('toastContainer');
    if (!container) {
      var created = document.createElement('div');
      created.id = 'toastContainer';
      created.className = 'toast-container';
      document.body.appendChild(created);
      container = created;
    }
    var t = document.createElement('div');
    t.className = 'toast toast-' + (type || 'info');
    t.textContent = String(message || '');
    container.appendChild(t);
    var ms = (typeof duration === 'number') ? duration : 3000;
    setTimeout(function () {
      t.classList.add('toast-hide');
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 300);
    }, ms);
    return t;
  } catch (e) {
    console.warn('showToast :', e);
    return null;
  }
}

/* Toast avec bouton "Annuler" (Amélioration B).
   showUndoToast('Client supprimé', function() { restaurerClient(); })
   → l'utilisateur a 5 secondes pour annuler */
function showUndoToast(message, onUndo, duration) {
  try {
    var container = document.getElementById('toastContainer');
    if (!container) {
      var created = document.createElement('div');
      created.id = 'toastContainer';
      created.className = 'toast-container';
      document.body.appendChild(created);
      container = created;
    }
    var ms = (typeof duration === 'number') ? duration : 5000;
    var t = document.createElement('div');
    t.className = 'toast toast-warning toast-undo';

    var text = document.createElement('span');
    text.className = 'toast-undo-text';
    text.textContent = String(message || '');
    t.appendChild(text);

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast-undo-btn';
    btn.textContent = '↩️ Annuler';

    var timer = null;
    var dismissed = false;

    function dismiss() {
      if (dismissed) return;
      dismissed = true;
      if (timer) { clearTimeout(timer); timer = null; }
      t.classList.add('toast-hide');
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 300);
    }

    btn.addEventListener('click', function () {
      if (dismissed) return;
      try {
        if (typeof onUndo === 'function') onUndo();
      } catch (e) {
        console.warn('showUndoToast.onUndo :', e);
      }
      dismiss();
    });

    t.appendChild(btn);
    container.appendChild(t);
    timer = setTimeout(dismiss, ms);
    return t;
  } catch (e) {
    console.warn('showUndoToast :', e);
    return null;
  }
}

/* ═══════════ SECTION 5 — DIALOGUES (sync + async) ═══════════ */

/* Confirmation SYNCHRONE (compatibilité 100% avec le code existant).
   Usage : if (confirmDialog('Supprimer ?')) { ... } */
function confirmDialog(message, options) {
  try {
    var text = String(message || 'Confirmer ?');
    if (options && options.title) text = options.title + '\n\n' + text;
    return window.confirm(text);
  } catch (e) {
    return false;
  }
}

/* Confirmation ASYNCHRONE (Promise).
   Usage : if (await confirmDialogAsync('Supprimer ?')) { ... } */
function confirmDialogAsync(message, options) {
  return Promise.resolve(confirmDialog(message, options));
}

/* Saisie SYNCHRONE (compatibilité 100%).
   Usage : var nom = promptDialog('Nom ?'); */
function promptDialog(message, defaultValue) {
  try {
    var text = String(message || 'Saisir :');
    var result = window.prompt(text, defaultValue || '');
    return result;
  } catch (e) {
    return null;
  }
}

/* Saisie ASYNCHRONE (Promise).
   Usage : var nom = await promptDialogAsync('Nom ?'); */
function promptDialogAsync(message, defaultValue) {
  return Promise.resolve(promptDialog(message, defaultValue));
}

/* ═══════════ SECTION 6 — HELPERS DOM ═══════════ */

/* Debounce : exécute fn après `wait` ms sans nouvel appel */
function debounce(fn, wait) {
  var timer = null;
  var w = (typeof wait === 'number') ? wait : 300;
  return function () {
    var args = arguments;
    var ctx = this;
    if (timer) clearTimeout(timer);
    timer = setTimeout(function () {
      timer = null;
      try { fn.apply(ctx, args); } catch (e) { console.warn('debounce :', e); }
    }, w);
  };
}

/* Throttle : exécute fn au plus une fois toutes les `wait` ms */
function throttle(fn, wait) {
  var last = 0;
  var timer = null;
  var w = (typeof wait === 'number') ? wait : 300;
  return function () {
    var args = arguments;
    var ctx = this;
    var now = Date.now();
    var remaining = w - (now - last);
    if (remaining <= 0) {
      if (timer) { clearTimeout(timer); timer = null; }
      last = now;
      try { fn.apply(ctx, args); } catch (e) { console.warn('throttle :', e); }
    } else if (!timer) {
      timer = setTimeout(function () {
        last = Date.now();
        timer = null;
        try { fn.apply(ctx, args); } catch (e) { console.warn('throttle :', e); }
      }, remaining);
    }
  };
}

/* ═══════════ SECTION 7 — ID + SLEEP ═══════════ */

/* Génère un ID unique court (ex : 'id_lx3k8a_9f2') */
function generateId(prefix) {
  var p = prefix || 'id';
  var rand = Math.random().toString(36).slice(2, 8);
  return p + '_' + Date.now().toString(36) + '_' + rand;
}

/* Pause asynchrone : await sleep(500) */
function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

/* ═══════════ SECTION 8 — HELPERS FICHIERS ═══════════ */

/* Formate un nombre d'octets en Ko/Mo/Go */
function formatBytes(bytes) {
  var n = parseInt(bytes, 10) || 0;
  if (n < 1024) return n + ' o';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' Ko';
  if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' Mo';
  return (n / (1024 * 1024 * 1024)).toFixed(2) + ' Go';
}

/* Télécharge un Blob avec le nom donné. */
function downloadBlob(blob, filename) {
  try {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename || ('voltcore-' + todayISO() + '.bin');
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      try { if (a.parentNode) a.parentNode.removeChild(a); } catch (e) {}
    }, 250);
    setTimeout(function () {
      try { URL.revokeObjectURL(url); } catch (e) {}
    }, 30000);
    return true;
  } catch (e) {
    console.warn('downloadBlob :', e);
    if (typeof showToast === 'function') {
      showToast('Téléchargement impossible.', 'error');
    }
    return false;
  }
}

/* Délègue à downloadBlob (implémentation unique). */
function _fallbackDownload(blob, filename) {
  return downloadBlob(blob, filename);
}

/* Copie un texte dans le presse-papiers (avec fallback). */
async function copyToClipboard(text) {
  var str = String(text || '');
  if (!str) return false;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(str);
      return true;
    }
  } catch (e) { /* fallback */ }
  try {
    var ta = document.createElement('textarea');
    ta.value = str;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    var ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return !!ok;
  } catch (e) {
    console.warn('copyToClipboard :', e);
    return false;
  }
}

/* ═══════════ SECTION 9 — COMPRESSION IMAGES (Amélioration H) ═══════════ */

/* Compresse une image pour ne pas dépasser maxBytes. */
async function compressImage(file, maxBytes) {
  var MAX = (typeof maxBytes === 'number') ? maxBytes : 500 * 1024;
  if (!file) throw new Error('Fichier image requis');
  var isImage = /^image\//.test(file.type || '');
  if (!isImage) throw new Error('Fichier non-image');

  var dataUrl = await new Promise(function (resolve, reject) {
    var reader = new FileReader();
    reader.onload = function () { resolve(reader.result); };
    reader.onerror = function () { reject(reader.error || new Error('Lecture impossible')); };
    reader.readAsDataURL(file);
  });

  if (typeof dataUrl === 'string' && dataUrl.length * 0.75 <= MAX) {
    return dataUrl;
  }

  var img = await new Promise(function (resolve, reject) {
    var i = new Image();
    i.onload = function () { resolve(i); };
    i.onerror = function () { reject(new Error('Image illisible')); };
    i.src = dataUrl;
  });

  var MAX_DIM = 1600;
  var w = img.width;
  var h = img.height;
  if (w > MAX_DIM || h > MAX_DIM) {
    var ratio = Math.min(MAX_DIM / w, MAX_DIM / h);
    w = Math.round(w * ratio);
    h = Math.round(h * ratio);
  }

  var canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  var ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, w, h);

  var qualities = [0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3];
  var result = canvas.toDataURL('image/jpeg', 0.9);
  for (var i = 0; i < qualities.length; i++) {
    var q = qualities[i];
    result = canvas.toDataURL('image/jpeg', q);
    if (result.length * 0.75 <= MAX) break;
  }
  return result;
}

/* Affiche un message à l'utilisateur après compression. */
async function compressImageWithFeedback(file, maxBytes) {
  try {
    var before = file ? file.size : 0;
    var dataUrl = await compressImage(file, maxBytes);
    var after = Math.round(dataUrl.length * 0.75);
    if (typeof showToast === 'function' && before > after) {
      showToast('Image compressée : ' + formatBytes(before) + ' → ' + formatBytes(after), 'info', 2500);
    }
    return dataUrl;
  } catch (e) {
    console.warn('compressImageWithFeedback :', e);
    if (typeof showToast === 'function') {
      showToast('Compression impossible : ' + (e.message || 'erreur'), 'error', 4000);
    }
    throw e;
  }
}

/* ═══════════ SECTION 10 — NOMBRES EN LETTRES (Session #3) ═══════════
   Convertit un montant en toutes lettres (français).
   Utilisé par le PDF de facture pour le bloc :
     "Arrêtée la présente facture à la somme de : [X] TTC"

   Exemples :
     numberToFrenchWords(0)        → "zéro dinar"
     numberToFrenchWords(1)        → "un dinar"
     numberToFrenchWords(21)       → "vingt et un dinars"
     numberToFrenchWords(80)       → "quatre-vingts dinars"
     numberToFrenchWords(81)       → "quatre-vingt-un dinars"
     numberToFrenchWords(100)      → "cent dinars"
     numberToFrenchWords(200)      → "deux cents dinars"
     numberToFrenchWords(1000)     → "mille dinars"
     numberToFrenchWords(1234.567) → "mille deux cent trente-quatre dinars
                                      et cinq cent soixante-sept millimes"
   ═══════════════════════════════════════════════════════════════ */

/* Unités 0 → 19 */
var _FR_UNITS = [
  'zéro', 'un', 'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf',
  'dix', 'onze', 'douze', 'treize', 'quatorze', 'quinze', 'seize',
  'dix-sept', 'dix-huit', 'dix-neuf'
];

/* Dizaines (index 7 et 9 vides, gérées séparément : 70→79, 90→99) */
var _FR_TENS = [
  '', '', 'vingt', 'trente', 'quarante', 'cinquante', 'soixante',
  '', 'quatre-vingt', ''
];

/* 0 → 99 en toutes lettres */
function _frBelow100(n) {
  if (n < 0 || n > 99) return '';
  if (n < 20) return _FR_UNITS[n];

  var t = Math.floor(n / 10);
  var u = n % 10;

  /* 70 → 79 : soixante-dix, soixante et onze, soixante-douze, ... */
  if (t === 7) {
    if (u === 1) return 'soixante et onze';
    return 'soixante-' + _FR_UNITS[10 + u];
  }
  /* 90 → 99 : quatre-vingt-dix, quatre-vingt-onze, ... */
  if (t === 9) {
    if (u === 0) return 'quatre-vingt-dix';
    return 'quatre-vingt-' + _FR_UNITS[10 + u];
  }

  var prefix = _FR_TENS[t];

  if (u === 0) {
    /* 80 : quatre-vingts (avec s) */
    if (t === 8) return 'quatre-vingts';
    return prefix;
  }
  if (u === 1) {
    /* 81 : quatre-vingt-un (sans "et") */
    if (t === 8) return 'quatre-vingt-un';
    /* 21, 31, 41, 51, 61 : "et un" */
    return prefix + ' et un';
  }
  return prefix + '-' + _FR_UNITS[u];
}

/* 0 → 999 en toutes lettres */
function _frBelow1000(n) {
  if (n < 0 || n > 999) return '';
  if (n < 100) return _frBelow100(n);

  var h = Math.floor(n / 100);
  var r = n % 100;

  /* 200, 300, ... : "cents" avec s quand pas suivi d'un autre nombre */
  if (r === 0) {
    if (h === 1) return 'cent';
    return _frBelow100(h) + ' cents';
  }
  var hStr = (h === 1) ? 'cent' : _frBelow100(h) + ' cent';
  return hStr + ' ' + _frBelow100(r);
}

/* 0 → 999 999 999 999 en toutes lettres (milliards inclus) */
function _frIntWords(n) {
  if (n === 0) return 'zéro';
  if (n < 1000) return _frBelow1000(n);

  /* Milliers */
  if (n < 1000000) {
    var thousands = Math.floor(n / 1000);
    var rest = n % 1000;
    var tStr = (thousands === 1) ? 'mille' : _frBelow1000(thousands) + ' mille';
    if (rest === 0) return tStr;
    return tStr + ' ' + _frBelow1000(rest);
  }

  /* Millions */
  if (n < 1000000000) {
    var millions = Math.floor(n / 1000000);
    var rest2 = n % 1000000;
    var mStr = (millions === 1) ? 'un million' : _frBelow1000(millions) + ' millions';
    if (rest2 === 0) return mStr;
    return mStr + ' ' + _frIntWords(rest2);
  }

  /* Milliards */
  var milliards = Math.floor(n / 1000000000);
  var rest3 = n % 1000000000;
  var gStr = (milliards === 1) ? 'un milliard' : _frBelow1000(milliards) + ' milliards';
  if (rest3 === 0) return gStr;
  return gStr + ' ' + _frIntWords(rest3);
}

/* API publique : montant → texte (dinars + millimes) */
function numberToFrenchWords(montant) {
  var num = parseFloat(montant);
  if (!isFinite(num)) return 'zéro dinar';

  var neg = (num < 0);
  if (neg) num = -num;

  /* Arrondi à 3 décimales (millimes) */
  var total = Math.round(num * 1000);
  var dinars = Math.floor(total / 1000);
  var millimes = total % 1000;

  /* Partie dinars (pluriel si > 1, sinon singulier) */
  var str = _frIntWords(dinars) + ' ' + (dinars > 1 ? 'dinars' : 'dinar');

  /* Partie millimes (seulement si non nulle) */
  if (millimes > 0) {
    str += ' et ' + _frIntWords(millimes) + ' ' + (millimes > 1 ? 'millimes' : 'millime');
  }

  if (neg) str = 'moins ' + str;
  return str;
}

console.log('✅ 03-utils.js chargé — v6.6 (LOT 2 + LOT 5 + Session #3 — computeLineTotal + downloadBlob + Promise helpers + numberToFrenchWords)');