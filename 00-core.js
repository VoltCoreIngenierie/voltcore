/* ═══════════════════════════════════════════════════════════
   VOLTCORE — 00-core.js
   VERSION : v7.0.7
   RÔLE : Fondations — namespace global, constantes, polyfills,
          détection matérielle, logger minimal.
   DÉPENDANCES : aucune
   ORDRE : 1er fichier chargé (avant tout autre)

   RÈGLES :
   - ES5 strict (var uniquement, pas de let/const, pas de arrow)
   - Aucune dépendance externe
   - Aucun try/catch silencieux (tout est loggué via VC.log)
   - Ne touche à AUCUNE donnée métier (clients, articles, etc.)
   - Ce fichier doit être chargé AVANT tous les autres
   ═══════════════════════════════════════════════════════════ */

'use strict';

/* ═══════════════════════════════════════════════════════════
   SECTION 1 — NAMESPACE GLOBAL
   ═══════════════════════════════════════════════════════════ */

if (typeof window === 'undefined') {
  throw new Error('[00-core] window indisponible — environnement non navigateur');
}

window.VOLTCORE = window.VOLTCORE || {};
var VC = window.VOLTCORE;

/* Sous-namespaces (créés vides, peuplés par les fichiers suivants) */
VC.Utils = VC.Utils || {};       /* rempli par 01-utils.js */
VC.Store = VC.Store || {};       /* rempli par 02-store.js */
VC.IDB = VC.IDB || {};           /* rempli par 03-idb.js */
VC.Alerts = VC.Alerts || {};     /* rempli par 04-alerts.js */
VC.Auth = VC.Auth || {};         /* rempli par 05-auth.js */
VC.Infra = VC.Infra || {};       /* rempli par 26-infra.js */
VC.Migrate = VC.Migrate || {};   /* rempli par 27-migrate.js */

/* ═══════════════════════════════════════════════════════════
   SECTION 2 — CONSTANTES GLOBALES
   ═══════════════════════════════════════════════════════════ */

VC.VERSION = '7.0.7';
VC.BUILD_DATE = '2026-11-11';

/* Préfixe localStorage — toutes les clés commencent par ça.
   Ne JAMAIS changer (casserait la compatibilité avec les données existantes). */
VC.STORAGE_PREFIX = 'voltcore_';

/* Clés localStorage connues (registre de référence).
   Les modules enregistrent leurs clés via Store.register().
   Cette liste est ici pour la compatibilité de migration. */
VC.KNOWN_KEYS = {
  clients: 'voltcore_clients',
  articles: 'voltcore_articles',
  documents: 'voltcore_documents',
  familles: 'voltcore_familles',
  suppliers: 'voltcore_suppliers',
  chantiers: 'voltcore_chantiers',
  frais: 'voltcore_frais',
  bonsRoute: 'voltcore_bons_route',
  hrEmployees: 'voltcore_hr_employees',
  hrWorkEntries: 'voltcore_hr_work_entries',
  hrTransactions: 'voltcore_hr_transactions',
  purchaseInvoices: 'voltcore_purchase_invoices',
  externalPrices: 'voltcore_external_prices',
  trash: 'voltcore_trash',
  compteurs: 'voltcore_compteurs',
  log: 'voltcore_log',
  dismissedAlerts: 'voltcore_dismissed_alerts',
  documentsLib: 'voltcore_documents_lib',
  documentsCategories: 'voltcore_documents_categories',
  signatureDefault: 'voltcore_signature_default',
  cachetDefault: 'voltcore_cachet_default',
  brouillonCourant: 'voltcore_brouillon_courant',
  chantierActif: 'voltcore_chantier_actif',
  rib: 'voltcore_rib',
  banque: 'voltcore_banque',
  mf: 'voltcore_mf',
  rne: 'voltcore_rne',
  logo: 'voltcore_logo',
  dark: 'voltcore_dark',
  licenseToken: 'voltcore_license_token',
  licenseLastSeen: 'voltcore_license_last_seen',
  trustedDevice: 'voltcore_trusted_device',
  users: 'voltcore_users_v2',
  signatures: 'voltcore_signatures',
  errorLog: 'voltcore_error_log',
  lastAutoBackup: 'voltcore_last_auto_backup',
  idbLastBackup: 'voltcore_idb_last_backup'
};

/* Limites métier */
VC.MAX_DOC_QTY = 10000000;
VC.MAX_DOC_PU = 1000000;
VC.MAX_KM = 9999999;

/* Limites fichiers */
VC.SCAN_MAX_BYTES = 500 * 1024;
VC.ATTACHMENT_MAX_BYTES = 500 * 1024;
VC.SIGNATURE_MAX_BYTES = 400 * 1024;
VC.DOCLIB_MAX_BYTES = 5 * 1024 * 1024;

/* Limites quantitatives */
VC.SIGNATURE_MAX = 20;
VC.TRASH_MAX_DAYS = 30;
VC.HISTORY_MAX_ENTRIES = 500;
VC.ERROR_LOG_MAX = 50;
VC.ERROR_DEDUPE_MS = 5000;

/* Délais */
VC.INACTIVITY_DELAY = 5 * 60 * 1000;
VC.AUTOSAVE_INTERVAL_MS = 30000;
VC.AUTOSAVE_STALE_MS = 300000;
VC.NETWORK_TIMEOUT_MS = 5000;
VC.IMPORT_MIN_INTERVAL = 2000;
VC.BROUILLON_DEBOUNCE_MS = 1500;

/* Breakpoints */
VC.MOBILE_BREAKPOINT = 768;
VC.TABLET_BREAKPOINT = 1024;

/* Auth */
VC.AUTH_MAX_ATTEMPTS = 5;
VC.AUTH_LOCK_MS = 5 * 60 * 1000;

/* TVA / timbre */
VC.TVA_DEFAULT = 19;
VC.TIMBRE_DEFAULT = 1.000;

/* IndexedDB */
VC.IDB_NAME = 'voltcore_backups';
VC.IDB_VERSION = 3;
VC.IDB_STORE_BACKUPS = 'backups';
VC.IDB_STORE_BLOBS = 'blobs';
VC.IDB_STORE_FSHANDLES = 'fsHandles';
VC.IDB_KEEP_BACKUPS = 7;
VC.IDB_MAX_SIZE = 20 * 1024 * 1024;

/* Refs protégées */
VC.SIG_DEFAULT_REF = 'sig_default';
VC.CACHET_DEFAULT_REF = 'cachet_default';
VC.FS_HANDLE_ID = 'documents_dir';

/* ═══════════════════════════════════════════════════════════
   SECTION 3 — POLYFILLS
   ═══════════════════════════════════════════════════════════ */

if (!String.prototype.padStart) {
  String.prototype.padStart = function (targetLength, padString) {
    var str = String(this);
    var pad = (padString === undefined) ? ' ' : String(padString);
    if (str.length >= targetLength) return str;
    if (pad === '') return str;
    var needed = targetLength - str.length;
    var padding = '';
    while (padding.length < needed) padding += pad;
    return padding.slice(0, needed) + str;
  };
}

if (!String.prototype.padEnd) {
  String.prototype.padEnd = function (targetLength, padString) {
    var str = String(this);
    var pad = (padString === undefined) ? ' ' : String(padString);
    if (str.length >= targetLength) return str;
    if (pad === '') return str;
    var needed = targetLength - str.length;
    var padding = '';
    while (padding.length < needed) padding += pad;
    return str + padding.slice(0, needed);
  };
}

if (!String.prototype.endsWith) {
  String.prototype.endsWith = function (searchStr, position) {
    var str = String(this);
    var search = String(searchStr);
    var len = str.length;
    var pos = (position === undefined) ? len : Math.min(Number(position) || 0, len);
    return str.substring(pos - search.length, pos) === search;
  };
}

if (!String.prototype.startsWith) {
  String.prototype.startsWith = function (searchStr, position) {
    var str = String(this);
    var search = String(searchStr);
    var pos = Number(position) || 0;
    return str.substring(pos, pos + search.length) === search;
  };
}

if (!String.prototype.includes) {
  String.prototype.includes = function (searchStr, position) {
    return String(this).indexOf(String(searchStr), Number(position) || 0) !== -1;
  };
}

if (!Array.isArray) {
  Array.isArray = function (arg) {
    return Object.prototype.toString.call(arg) === '[object Array]';
  };
}

if (typeof Object.assign !== 'function') {
  Object.assign = function (target) {
    if (target === null || target === undefined) {
      throw new TypeError('Object.assign: target null ou undefined');
    }
    var to = Object(target);
    for (var i = 1; i < arguments.length; i++) {
      var src = arguments[i];
      if (src === null || src === undefined) continue;
      var keys = Object.keys(src);
      for (var j = 0; j < keys.length; j++) {
        to[keys[j]] = src[keys[j]];
      }
    }
    return to;
  };
}

if (!Array.prototype.find) {
  Array.prototype.find = function (predicate, thisArg) {
    if (this === null || this === undefined) {
      throw new TypeError('Array.prototype.find: this null');
    }
    var arr = Object(this);
    var len = arr.length >>> 0;
    for (var i = 0; i < len; i++) {
      var val = arr[i];
      if (predicate.call(thisArg, val, i, arr)) return val;
    }
    return undefined;
  };
}

if (!Array.prototype.findIndex) {
  Array.prototype.findIndex = function (predicate, thisArg) {
    if (this === null || this === undefined) {
      throw new TypeError('Array.prototype.findIndex: this null');
    }
    var arr = Object(this);
    var len = arr.length >>> 0;
    for (var i = 0; i < len; i++) {
      if (predicate.call(thisArg, arr[i], i, arr)) return i;
    }
    return -1;
  };
}

/* ═══════════════════════════════════════════════════════════
   SECTION 4 — LOGGER MINIMAL
   ═══════════════════════════════════════════════════════════ */

VC._errorCount = 0;

VC.log = function (level, module, message, context) {
  var lvl = String(level || 'info').toLowerCase();
  var mod = String(module || '?');
  var msg = String(message || '');

  if (lvl === 'error') VC._errorCount++;

  try {
    if (typeof console !== 'undefined') {
      var prefix = '[VC/' + lvl + '] [' + mod + ']';
      if (lvl === 'error' && console.error) {
        console.error(prefix, msg, context || '');
      } else if (lvl === 'warn' && console.warn) {
        console.warn(prefix, msg, context || '');
      } else if (console.log) {
        console.log(prefix, msg, context || '');
      }
    }
  } catch (e) {
    /* Console indisponible — impossible de logguer plus loin */
  }
};

VC.logInfo = function (module, message, context) {
  VC.log('info', module, message, context);
};
VC.logWarn = function (module, message, context) {
  VC.log('warn', module, message, context);
};
VC.logError = function (module, message, context) {
  VC.log('error', module, message, context);
};

/* ═══════════════════════════════════════════════════════════
   SECTION 5 — DÉTECTION MATÉRIELLE
   ═══════════════════════════════════════════════════════════ */

VC.device = {
  mobile: false,
  tablet: false,
  desktop: false,
  touch: false,
  https: false,
  camera: false,
  biometric: false,
  fullscreen: false,
  storage: false,
  notification: false,
  share: false,
  pwaInstalled: false,
  online: true
};

function _detectDevice() {
  var d = VC.device;

  try {
    var ua = (navigator.userAgent || '').toLowerCase();
    var w = window.innerWidth || 1024;
    d.mobile = w < VC.MOBILE_BREAKPOINT || /android|iphone|ipad|ipod|mobile/.test(ua);
    d.tablet = !d.mobile && w < VC.TABLET_BREAKPOINT;
    d.desktop = !d.mobile && !d.tablet;
  } catch (e) {
    VC.logError('00-core', 'Détection type appareil échouée', e);
  }

  try {
    d.touch = ('ontouchstart' in window) ||
              (navigator.maxTouchPoints > 0) ||
              (navigator.msMaxTouchPoints > 0);
  } catch (e) {
    VC.logError('00-core', 'Détection touch échouée', e);
  }

  try {
    d.https = location.protocol === 'https:' ||
              location.hostname === 'localhost' ||
              location.hostname === '127.0.0.1';
  } catch (e) {
    VC.logError('00-core', 'Détection HTTPS échouée', e);
  }

  try {
    d.camera = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  } catch (e) {
    VC.logError('00-core', 'Détection caméra échouée', e);
  }

  try {
    d.biometric = !!(window.PublicKeyCredential && d.https);
  } catch (e) {
    VC.logError('00-core', 'Détection biométrie échouée', e);
  }

  try {
    var el = document.documentElement;
    d.fullscreen = !!(el.requestFullscreen || el.webkitRequestFullscreen ||
                      el.mozRequestFullScreen || el.msRequestFullscreen);
  } catch (e) {
    VC.logError('00-core', 'Détection fullscreen échouée', e);
  }

  try {
    var k = '__vc_test_' + Date.now();
    localStorage.setItem(k, '1');
    var v = localStorage.getItem(k);
    localStorage.removeItem(k);
    d.storage = (v === '1');
  } catch (e) {
    d.storage = false;
    VC.logWarn('00-core', 'localStorage indisponible (mode privé ?)', e);
  }

  try {
    d.notification = ('Notification' in window);
  } catch (e) {
    VC.logError('00-core', 'Détection notification échouée', e);
  }

  try {
    d.share = !!(navigator.share);
  } catch (e) {
    VC.logError('00-core', 'Détection share échouée', e);
  }

  try {
    d.pwaInstalled = !!(window.matchMedia && (
      window.matchMedia('(display-mode: standalone)').matches ||
      window.matchMedia('(display-mode: minimal-ui)').matches
    )) || navigator.standalone === true;
  } catch (e) {
    VC.logError('00-core', 'Détection PWA échouée', e);
  }

  try {
    d.online = (navigator.onLine !== false);
  } catch (e) {
    d.online = true;
  }

  VC.logInfo('00-core', 'Détection matérielle terminée', {
    type: d.mobile ? 'mobile' : (d.tablet ? 'tablet' : 'desktop'),
    https: d.https,
    camera: d.camera,
    biometric: d.biometric,
    storage: d.storage,
    share: d.share,
    pwa: d.pwaInstalled
  });
}

/* ═══════════════════════════════════════════════════════════
   SECTION 6 — HELPERS DE DÉTECTION TEMPS RÉEL
   ═══════════════════════════════════════════════════════════ */

VC.isMobileView = function () {
  try {
    return window.innerWidth < VC.MOBILE_BREAKPOINT;
  } catch (e) {
    return false;
  }
};

VC.isTabletView = function () {
  try {
    return window.innerWidth >= VC.MOBILE_BREAKPOINT &&
           window.innerWidth < VC.TABLET_BREAKPOINT;
  } catch (e) {
    return false;
  }
};

VC.isTouchDevice = function () {
  try {
    return ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
  } catch (e) {
    return false;
  }
};

VC.isPWAInstalled = function () {
  try {
    if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) return true;
    if (window.navigator.standalone === true) return true;
    if (window.matchMedia && window.matchMedia('(display-mode: minimal-ui)').matches) return true;
  } catch (e) {
    return false;
  }
  return false;
};

VC.isOnline = function () {
  try {
    return navigator.onLine !== false;
  } catch (e) {
    return true;
  }
};

/* ═══════════════════════════════════════════════════════════
   SECTION 7 — INITIALISATION SYNCHRONE
   ═══════════════════════════════════════════════════════════ */

_detectDevice();

var __resizeTimer = null;
try {
  window.addEventListener('resize', function () {
    if (__resizeTimer) clearTimeout(__resizeTimer);
    __resizeTimer = setTimeout(function () {
      __resizeTimer = null;
      try {
        VC.device.mobile = VC.isMobileView();
        VC.device.tablet = VC.isTabletView();
        VC.device.desktop = !VC.device.mobile && !VC.device.tablet;
      } catch (e) {
        VC.logError('00-core', 'Resize re-détection échouée', e);
      }
    }, 200);
  }, { passive: true });
} catch (e) {
  VC.logError('00-core', 'Bind resize échoué', e);
}

try {
  window.addEventListener('online', function () {
    VC.device.online = true;
    VC.logInfo('00-core', 'Connexion rétablie');
  });
  window.addEventListener('offline', function () {
    VC.device.online = false;
    VC.logWarn('00-core', 'Connexion perdue');
  });
} catch (e) {
  VC.logError('00-core', 'Bind online/offline échoué', e);
}

/* ═══════════════════════════════════════════════════════════
   SECTION 8 — LOG DE DÉMARRAGE
   ═══════════════════════════════════════════════════════════ */

VC.logInfo('00-core', 'Fondations chargées', {
  version: VC.VERSION,
  build: VC.BUILD_DATE,
  storagePrefix: VC.STORAGE_PREFIX
});

/* Marqueur pour les autres fichiers */
VC._coreLoaded = true;