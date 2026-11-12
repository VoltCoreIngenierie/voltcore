/* ═══════════════════════════════════════════════════════════
   VOLTCORE — 01-utils.js
   VERSION : v7.0.7
   RÔLE : Helpers purs (strings, numbers, dates, money),
          helpers DOM (get/set/show/populate), helpers
          d'interface (toast, dialog), helpers fichiers.
   DÉPENDANCES : 00-core.js (VC namespace)
   ORDRE : 2ᵉ fichier chargé

   RÈGLES :
   - ES5 strict (var uniquement, pas de let/const, pas de arrow)
   - Toutes les fonctions exposées sous VC.Utils.*
   - Aucun try/catch silencieux (tout est loggué via VC.logError)
   - Aucune dépendance à document avant l'appel (helpers purs)
   - Formatage monétaire : espaces U+0020 (pas U+00A0/U+202F)
   ═══════════════════════════════════════════════════════════ */

'use strict';

(function (global) {

  if (!global.VOLTCORE) {
    throw new Error('[01-utils] 00-core.js doit être chargé avant 01-utils.js');
  }

  var VC = global.VOLTCORE;
  var U = VC.Utils || {};
  VC.Utils = U;

  /* ═══════════════════════════════════════════════════════════
     SECTION 1 — HELPERS STRINGS
     ═══════════════════════════════════════════════════════════ */

  U.escapeHtml = function (value) {
    if (value === null || value === undefined) return '';
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  };

  U.escapeAttr = function (value) {
    if (value === null || value === undefined) return '';
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  };

  U.normalizeText = function (str) {
    if (!str) return '';
    var s = String(str);
    try {
      if (s.normalize) {
        s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      }
    } catch (e) {
      VC.logWarn('01-utils', 'normalizeText: normalize() indisponible', e);
    }
    return s.toLowerCase();
  };

  U.trimCollapse = function (str) {
    if (!str) return '';
    return String(str).replace(/\s+/g, ' ').trim();
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 2 — HELPERS NUMBERS
     ═══════════════════════════════════════════════════════════ */

  /**
   * Parse un nombre depuis n'importe quel format (FR / US / mixte).
   * Gère les cas malformés avec multi-virgules (ex: '1,5,3' → 15.3).
   *
   * Heuristique multi-virgules sans point :
   *   - Si toutes les parties après la 1re virgule ont 3 chiffres → milliers ('1,234,567' → 1234567)
   *   - Sinon → la dernière virgule est décimale, les autres sont des milliers ('1,5,3' → 15.3)
   */
  U.parseNumber = function (value) {
    if (typeof value === 'number') {
      return isFinite(value) ? value : 0;
    }
    if (value === null || value === undefined) return 0;

    var s = String(value).trim();
    if (!s) return 0;

    /* Retire les espaces (séparateur de milliers FR) */
    s = s.replace(/\s/g, '');

    /* Garde uniquement chiffres, points, virgules, moins */
    s = s.replace(/[^0-9.,\-]/g, '');
    if (!s) return 0;

    var hasComma = s.indexOf(',') !== -1;
    var hasDot = s.indexOf('.') !== -1;

    if (hasComma && hasDot) {
      var lastComma = s.lastIndexOf(',');
      var lastDot = s.lastIndexOf('.');
      if (lastComma > lastDot) {
        /* FR: '1.234,56' → retire les points, virgule décimale */
        s = s.replace(/\./g, '').replace(',', '.');
      } else {
        /* US: '1,234.56' → retire les virgules */
        s = s.replace(/,/g, '');
      }
    } else if (hasComma && !hasDot) {
      var parts = s.split(',');
      if (parts.length === 2) {
        /* Une seule virgule → décimale */
        s = parts[0] + '.' + parts[1];
      } else {
        /* Multi-virgules : vérifier si milliers (chaque partie après la 1re = 3 chiffres) */
        var isThousands = true;
        for (var i = 1; i < parts.length; i++) {
          if (!/^\d{3}$/.test(parts[i])) {
            isThousands = false;
            break;
          }
        }
        if (isThousands && parts[0].length <= 3 && parts[0].length >= 1) {
          /* Milliers US : '1,234,567' */
          s = parts.join('');
        } else {
          /* Malformé : la dernière virgule est décimale */
          var lastIdx = parts.length - 1;
          var intPart = parts.slice(0, lastIdx).join('');
          s = intPart + '.' + parts[lastIdx];
        }
      }
    }
    /* else : point seul ou entier → on garde tel quel */

    var n = parseFloat(s);
    return isFinite(n) ? n : 0;
  };

  /**
   * Formate un nombre en dinars tunisiens : "1 234,500 DT"
   * Force l'espace normale (U+0020) pour éviter les divergences Chrome/Firefox
   * (U+202F, U+2009, U+00A0 → U+0020).
   */
  U.formatMoney = function (n) {
    var num = parseFloat(n);
    if (!isFinite(num)) return '0,000 DT';
    try {
      var s = num.toLocaleString('fr-FR', {
        minimumFractionDigits: 3,
        maximumFractionDigits: 3
      });
      s = s.replace(/[\u202F\u2009\u00A0]/g, ' ');
      return s + ' DT';
    } catch (e) {
      VC.logWarn('01-utils', 'formatMoney: toLocaleString échoué', e);
      return num.toFixed(3).replace('.', ',') + ' DT';
    }
  };

  /**
   * Formate un nombre sans devise, sans décimales inutiles.
   */
  U.formatNumber = function (n, decimals) {
    var num = parseFloat(n);
    if (!isFinite(num)) return '0';
    var d = (typeof decimals === 'number') ? decimals : 0;
    try {
      var s = num.toLocaleString('fr-FR', {
        minimumFractionDigits: d,
        maximumFractionDigits: d
      });
      return s.replace(/[\u202F\u2009\u00A0]/g, ' ');
    } catch (e) {
      VC.logWarn('01-utils', 'formatNumber: toLocaleString échoué', e);
      return num.toFixed(d).replace('.', ',');
    }
  };

  U.clamp = function (value, min, max) {
    var n = parseFloat(value);
    if (!isFinite(n)) return min;
    if (n < min) return min;
    if (n > max) return max;
    return n;
  };

  U.clampInt = function (value, min, max, def) {
    var n = parseInt(value, 10);
    if (isNaN(n)) return (typeof def === 'number') ? def : min;
    if (n < min) return min;
    if (n > max) return max;
    return n;
  };

  /**
   * Calcule le total d'une ligne BTP.
   * Signature objet : { qte|quantite, pu|prixUnitaire|prix, remisePct?, remiseMontant?, remise? }
   * Signature pos : (qte, pu, remise?)
   * Arrondi à 3 décimales (millimes).
   */
  U.computeLineTotal = function (a, b, c) {
    var qte = 0, pu = 0, remisePct = 0, remiseMontant = 0;

    if (a && typeof a === 'object') {
      qte = U.parseNumber(a.qte != null ? a.qte : a.quantite);
      pu = U.parseNumber(
        a.pu != null ? a.pu
        : (a.prixUnitaire != null ? a.prixUnitaire
        : (a.prix != null ? a.prix : 0))
      );
      remisePct = U.parseNumber(a.remisePct);
      remiseMontant = U.parseNumber(a.remiseMontant);

      if (!remisePct && !remiseMontant && a.remise != null) {
        var r = U.parseNumber(a.remise);
        if (r > 0 && r <= 100) remisePct = r;
        else remiseMontant = r;
      }
    } else {
      qte = U.parseNumber(a);
      pu = U.parseNumber(b);
      var r2 = U.parseNumber(c);
      if (r2 > 0 && r2 <= 100) remisePct = r2;
      else remiseMontant = r2;
    }

    if (remisePct < 0) remisePct = 0;
    if (remisePct > 100) remisePct = 100;

    var brut = qte * pu;
    var net = brut - (brut * remisePct / 100) - remiseMontant;
    return Math.round(net * 1000) / 1000;
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 3 — HELPERS DATES
     ═══════════════════════════════════════════════════════════ */

  U.todayISO = function () {
    var d = new Date();
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  };

  U.isValidDateString = function (s) {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    var d = new Date(s + 'T12:00:00');
    if (isNaN(d.getTime())) return false;
    return d.toISOString().slice(0, 10) === s;
  };

  U.formatDate = function (iso) {
    if (!iso || typeof iso !== 'string') return '';
    var parts = iso.slice(0, 10).split('-');
    if (parts.length !== 3) return iso;
    return parts[2] + '/' + parts[1] + '/' + parts[0];
  };

  U.addDaysISO = function (iso, n) {
    if (!U.isValidDateString(iso)) return '';
    var d = new Date(iso + 'T12:00:00');
    d.setDate(d.getDate() + (parseInt(n, 10) || 0));
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  };

  U.compareISO = function (a, b) {
    if (!a && !b) return 0;
    if (!a) return -1;
    if (!b) return 1;
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  };

  U.daysBetweenISO = function (a, b) {
    if (!U.isValidDateString(a) || !U.isValidDateString(b)) return 0;
    var da = new Date(a + 'T12:00:00').getTime();
    var db = new Date(b + 'T12:00:00').getTime();
    return Math.round((db - da) / 86400000);
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 4 — HELPERS DOM
     ═══════════════════════════════════════════════════════════ */

  U.getVal = function (id) {
    try {
      var el = document.getElementById(id);
      return el ? String(el.value != null ? el.value : '') : '';
    } catch (e) {
      VC.logError('01-utils', 'getVal(' + id + ') échoué', e);
      return '';
    }
  };

  U.setVal = function (id, value) {
    try {
      var el = document.getElementById(id);
      if (el) el.value = (value === null || value === undefined) ? '' : value;
    } catch (e) {
      VC.logError('01-utils', 'setVal(' + id + ') échoué', e);
    }
  };

  U.setText = function (id, text) {
    try {
      var el = document.getElementById(id);
      if (el) el.textContent = String(text != null ? text : '');
    } catch (e) {
      VC.logError('01-utils', 'setText(' + id + ') échoué', e);
    }
  };

  U.getChecked = function (id) {
    try {
      var el = document.getElementById(id);
      return !!(el && el.checked);
    } catch (e) {
      VC.logError('01-utils', 'getChecked(' + id + ') échoué', e);
      return false;
    }
  };

  U.setChecked = function (id, value) {
    try {
      var el = document.getElementById(id);
      if (el) el.checked = !!value;
    } catch (e) {
      VC.logError('01-utils', 'setChecked(' + id + ') échoué', e);
    }
  };

  U.show = function (id) {
    try {
      var el = document.getElementById(id);
      if (el) el.style.display = '';
    } catch (e) {
      VC.logError('01-utils', 'show(' + id + ') échoué', e);
    }
  };

  U.hide = function (id) {
    try {
      var el = document.getElementById(id);
      if (el) el.style.display = 'none';
    } catch (e) {
      VC.logError('01-utils', 'hide(' + id + ') échoué', e);
    }
  };

  U.showFlex = function (id) {
    try {
      var el = document.getElementById(id);
      if (el) el.style.display = 'flex';
    } catch (e) {
      VC.logError('01-utils', 'showFlex(' + id + ') échoué', e);
    }
  };

  /**
   * Binding idempotent : si l'élément a déjà un __bound pour cet event, on ne re-bind pas.
   * Évite les listeners empilés en cas d'appel répété.
   */
  U.on = function (id, event, handler) {
    try {
      var el = document.getElementById(id);
      if (!el) return false;
      var key = '__bound_' + event;
      if (el[key]) return false;
      el[key] = true;
      el.addEventListener(event, handler);
      return true;
    } catch (e) {
      VC.logError('01-utils', 'on(' + id + ',' + event + ') échoué', e);
      return false;
    }
  };

  /**
   * Peuple un <select> à partir d'un tableau.
   * labelKey / valueKey : noms de propriété (fallback .nom, .label / .id).
   * Si valueKey est absent, la valeur est l'objet lui-même (utile pour les strings).
   */
  U.populateSelect = function (selectId, items, labelKey, valueKey, selectedValue) {
    try {
      var sel = document.getElementById(selectId);
      if (!sel) return false;

      var arr = Array.isArray(items) ? items : [];
      var html = '';

      for (var i = 0; i < arr.length; i++) {
        var it = arr[i];
        if (!it) continue;

        var label = '';
        if (typeof it === 'string') {
          label = it;
        } else if (labelKey && it[labelKey] != null) {
          label = String(it[labelKey]);
        } else if (it.nom != null) {
          label = String(it.nom);
        } else if (it.label != null) {
          label = String(it.label);
        } else {
          label = String(it);
        }

        var value = '';
        if (typeof it === 'string') {
          value = it;
        } else if (valueKey && it[valueKey] != null) {
          value = String(it[valueKey]);
        } else if (it.id != null) {
          value = String(it.id);
        } else {
          value = String(it);
        }

        var isSel = (selectedValue != null && String(selectedValue) === value);
        html += '<option value="' + U.escapeAttr(value) + '"' +
          (isSel ? ' selected' : '') + '>' +
          U.escapeHtml(label) + '</option>';
      }

      sel.innerHTML = html;
      return true;
    } catch (e) {
      VC.logError('01-utils', 'populateSelect(' + selectId + ') échoué', e);
      return false;
    }
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 5 — TOASTS (avec undo)
     ═══════════════════════════════════════════════════════════ */

  function _ensureToastContainer() {
    try {
      var container = document.getElementById('toastContainer');
      if (!container) {
        container = document.createElement('div');
        container.id = 'toastContainer';
        container.className = 'toast-container';
        document.body.appendChild(container);
      }
      return container;
    } catch (e) {
      VC.logError('01-utils', 'Création toastContainer échouée', e);
      return null;
    }
  }

  U.toast = function (message, type, duration) {
    try {
      var container = _ensureToastContainer();
      if (!container) return null;

      var t = document.createElement('div');
      t.className = 'toast toast-' + (type || 'info');
      t.textContent = String(message || '');
      container.appendChild(t);

      var ms = (typeof duration === 'number') ? duration : 3000;
      setTimeout(function () {
        t.classList.add('toast-hide');
        setTimeout(function () {
          if (t.parentNode) t.parentNode.removeChild(t);
        }, 300);
      }, ms);

      return t;
    } catch (e) {
      VC.logError('01-utils', 'toast échoué', e);
      return null;
    }
  };

  U.toastUndo = function (message, onUndo, duration) {
    try {
      var container = _ensureToastContainer();
      if (!container) return null;

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
        setTimeout(function () {
          if (t.parentNode) t.parentNode.removeChild(t);
        }, 300);
      }

      btn.addEventListener('click', function () {
        if (dismissed) return;
        try {
          if (typeof onUndo === 'function') onUndo();
        } catch (e) {
          VC.logError('01-utils', 'toastUndo.onUndo échoué', e);
        }
        dismiss();
      });

      t.appendChild(btn);
      container.appendChild(t);
      timer = setTimeout(dismiss, ms);

      return t;
    } catch (e) {
      VC.logError('01-utils', 'toastUndo échoué', e);
      return null;
    }
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 6 — DIALOGUES (confirm / prompt)
     ═══════════════════════════════════════════════════════════ */

  U.confirm = function (message, options) {
    try {
      var text = String(message || 'Confirmer ?');
      if (options && options.title) text = options.title + '\n\n' + text;
      return global.confirm(text);
    } catch (e) {
      VC.logError('01-utils', 'confirm échoué', e);
      return false;
    }
  };

  U.prompt = function (message, defaultValue) {
    try {
      return global.prompt(String(message || 'Saisir :'), defaultValue || '');
    } catch (e) {
      VC.logError('01-utils', 'prompt échoué', e);
      return null;
    }
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 7 — HELPERS DIVERS
     ═══════════════════════════════════════════════════════════ */

  U.generateId = function (prefix) {
    var p = prefix || 'id';
    return p + '_' + Date.now().toString(36) + '_' +
      Math.random().toString(36).slice(2, 8);
  };

  U.debounce = function (fn, wait) {
    var timer = null;
    var w = (typeof wait === 'number') ? wait : 300;
    return function () {
      var args = arguments;
      var ctx = this;
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () {
        timer = null;
        try { fn.apply(ctx, args); } catch (e) {
          VC.logError('01-utils', 'debounce callback échoué', e);
        }
      }, w);
    };
  };

  U.throttle = function (fn, wait) {
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
        try { fn.apply(ctx, args); } catch (e) {
          VC.logError('01-utils', 'throttle callback échoué', e);
        }
      } else if (!timer) {
        timer = setTimeout(function () {
          last = Date.now();
          timer = null;
          try { fn.apply(ctx, args); } catch (e) {
            VC.logError('01-utils', 'throttle callback échoué', e);
          }
        }, remaining);
      }
    };
  };

  U.sleep = function (ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  };

  U.formatBytes = function (bytes) {
    var n = parseInt(bytes, 10) || 0;
    if (n < 1024) return n + ' o';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' Ko';
    if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' Mo';
    return (n / (1024 * 1024 * 1024)).toFixed(2) + ' Go';
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 8 — HELPERS FICHIERS
     ═══════════════════════════════════════════════════════════ */

  U.downloadBlob = function (blob, filename) {
    try {
      if (!blob) {
        VC.logWarn('01-utils', 'downloadBlob: blob vide');
        return false;
      }
      var name = filename || ('voltcore-' + U.todayISO() + '.bin');
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () {
        try { if (a.parentNode) a.parentNode.removeChild(a); } catch (e) {
          VC.logError('01-utils', 'downloadBlob cleanup <a> échoué', e);
        }
        try { URL.revokeObjectURL(url); } catch (e) {
          VC.logError('01-utils', 'downloadBlob revoke URL échoué', e);
        }
      }, 30000);
      return true;
    } catch (e) {
      VC.logError('01-utils', 'downloadBlob échoué', e);
      return false;
    }
  };

  U.copyToClipboard = function (text) {
    var str = String(text || '');
    if (!str) return Promise.resolve(false);

    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(str).then(function () {
        return true;
      }).catch(function (e) {
        VC.logWarn('01-utils', 'clipboard.writeText échoué, fallback', e);
        return _fallbackCopy(str);
      });
    }
    return Promise.resolve(_fallbackCopy(str));
  };

  function _fallbackCopy(str) {
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
      VC.logError('01-utils', 'fallbackCopy échoué', e);
      return false;
    }
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 9 — NOMBRES EN LETTRES (français)
     ═══════════════════════════════════════════════════════════ */

  var _FR_UNITS = [
    'zéro', 'un', 'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf',
    'dix', 'onze', 'douze', 'treize', 'quatorze', 'quinze', 'seize',
    'dix-sept', 'dix-huit', 'dix-neuf'
  ];

  var _FR_TENS = [
    '', '', 'vingt', 'trente', 'quarante', 'cinquante', 'soixante',
    '', 'quatre-vingt', ''
  ];

  function _frBelow100(n) {
    if (n < 0 || n > 99) return '';
    if (n < 20) return _FR_UNITS[n];

    var t = Math.floor(n / 10);
    var u = n % 10;

    if (t === 7) {
      if (u === 1) return 'soixante et onze';
      return 'soixante-' + _FR_UNITS[10 + u];
    }
    if (t === 9) {
      if (u === 0) return 'quatre-vingt-dix';
      return 'quatre-vingt-' + _FR_UNITS[10 + u];
    }

    var prefix = _FR_TENS[t];

    if (u === 0) {
      if (t === 8) return 'quatre-vingts';
      return prefix;
    }
    if (u === 1) {
      if (t === 8) return 'quatre-vingt-un';
      return prefix + ' et un';
    }
    return prefix + '-' + _FR_UNITS[u];
  }

  function _frBelow1000(n) {
    if (n < 0 || n > 999) return '';
    if (n < 100) return _frBelow100(n);

    var h = Math.floor(n / 100);
    var r = n % 100;

    if (r === 0) {
      if (h === 1) return 'cent';
      return _frBelow100(h) + ' cents';
    }
    var hStr = (h === 1) ? 'cent' : _frBelow100(h) + ' cent';
    return hStr + ' ' + _frBelow100(r);
  }

  function _frIntWords(n) {
    if (n === 0) return 'zéro';
    if (n < 1000) return _frBelow1000(n);

    if (n < 1000000) {
      var thousands = Math.floor(n / 1000);
      var rest = n % 1000;
      var tStr = (thousands === 1) ? 'mille' : _frBelow1000(thousands) + ' mille';
      if (rest === 0) return tStr;
      return tStr + ' ' + _frBelow1000(rest);
    }

    if (n < 1000000000) {
      var millions = Math.floor(n / 1000000);
      var rest2 = n % 1000000;
      var mStr = (millions === 1) ? 'un million' : _frBelow1000(millions) + ' millions';
      if (rest2 === 0) return mStr;
      return mStr + ' ' + _frIntWords(rest2);
    }

    var milliards = Math.floor(n / 1000000000);
    var rest3 = n % 1000000000;
    var gStr = (milliards === 1) ? 'un milliard' : _frBelow1000(milliards) + ' milliards';
    if (rest3 === 0) return gStr;
    return gStr + ' ' + _frIntWords(rest3);
  }

  U.numberToFrenchWords = function (montant) {
    var num = parseFloat(montant);
    if (!isFinite(num)) return 'zéro dinar';

    var neg = (num < 0);
    if (neg) num = -num;

    var total = Math.round(num * 1000);
    var dinars = Math.floor(total / 1000);
    var millimes = total % 1000;

    var str = _frIntWords(dinars) + ' ' + (dinars > 1 ? 'dinars' : 'dinar');

    if (millimes > 0) {
      str += ' et ' + _frIntWords(millimes) + ' ' + (millimes > 1 ? 'millimes' : 'millime');
    }

    if (neg) str = 'moins ' + str;
    return str;
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 10 — COMPRESSION IMAGES (v7.0.7 — FIX manquant)
     ═══════════════════════════════════════════════════════════
     Compresse une image pour ne pas dépasser maxBytes.
     Retourne une dataURL JPEG (ou PNG si la source est déjà sous la limite).

     Utilisé par :
       - 18-scan.js _processFile (import galerie)
       - 25-tools.js _uploadDefaultImage (signature/cachet)
       - 25-tools.js changeLogo (logo société)
       - 11-inv.js _compressImage (pièces jointes factures)
  */

  U.compressImage = function (file, maxBytes) {
    var MAX = (typeof maxBytes === 'number') ? maxBytes : 500 * 1024;

    return new Promise(function (resolve, reject) {
      try {
        if (!file) {
          reject(new Error('Fichier image requis'));
          return;
        }
        var isImage = /^image\//.test(file.type || '');
        if (!isImage) {
          reject(new Error('Fichier non-image'));
          return;
        }

        /* Étape 1 : lire le fichier en dataURL */
        var reader = new FileReader();
        reader.onload = function () {
          try {
            var dataUrl = reader.result;

            /* Si déjà sous la limite, retourne tel quel */
            if (typeof dataUrl === 'string' && dataUrl.length * 0.75 <= MAX) {
              resolve(dataUrl);
              return;
            }

            /* Étape 2 : charger l'image dans un objet Image */
            var img = new Image();
            img.onload = function () {
              try {
                var MAX_DIM = 1600;
                var w = img.width;
                var h = img.height;
                if (w > MAX_DIM || h > MAX_DIM) {
                  var ratio = Math.min(MAX_DIM / w, MAX_DIM / h);
                  w = Math.round(w * ratio);
                  h = Math.round(h * ratio);
                }

                /* Étape 3 : dessiner sur canvas */
                var canvas = document.createElement('canvas');
                canvas.width = w;
                canvas.height = h;
                var ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, w, h);

                /* Étape 4 : baisser la qualité jusqu'à tenir dans MAX */
                var qualities = [0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3];
                var result = canvas.toDataURL('image/jpeg', 0.9);
                for (var qi = 0; qi < qualities.length; qi++) {
                  result = canvas.toDataURL('image/jpeg', qualities[qi]);
                  if (result.length * 0.75 <= MAX) break;
                }
                resolve(result);
              } catch (e2) {
                VC.logError('01-utils', 'compressImage canvas échoué', e2);
                reject(e2);
              }
            };
            img.onerror = function () {
              reject(new Error('Image illisible'));
            };
            img.src = dataUrl;
          } catch (e3) {
            VC.logError('01-utils', 'compressImage lecture échouée', e3);
            reject(e3);
          }
        };
        reader.onerror = function () {
          reject(reader.error || new Error('Lecture fichier impossible'));
        };
        reader.readAsDataURL(file);
      } catch (e) {
        VC.logError('01-utils', 'compressImage sync échoué', e);
        reject(e);
      }
    });
  };

  U.compressImageWithFeedback = function (file, maxBytes) {
    var before = file ? file.size : 0;
    return U.compressImage(file, maxBytes).then(function (dataUrl) {
      var after = Math.round(dataUrl.length * 0.75);
      if (before > after && typeof U.toast === 'function') {
        try {
          U.toast('Image compressée : ' +
            U.formatBytes(before) + ' → ' + U.formatBytes(after),
            'info', 2500);
        } catch (e) {
          VC.logError('01-utils', 'compressImageWithFeedback toast échoué', e);
        }
      }
      return dataUrl;
    }).catch(function (e) {
      VC.logError('01-utils', 'compressImageWithFeedback échoué', e);
      if (typeof U.toast === 'function') {
        U.toast('Compression impossible : ' + (e.message || 'erreur'),
          'error', 4000);
      }
      throw e;
    });
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 11 — MARQUEUR DE CHARGEMENT
     ═══════════════════════════════════════════════════════════ */

  VC._utilsLoaded = true;

  VC.logInfo('01-utils', 'Helpers chargés', {
    functions: Object.keys(U).length
  });

})(window);