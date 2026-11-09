/* ═══════════════════════════════════════════════════════════════
   VOLTCORE — 18-mobile.js
   VERSION : v6.7 (Session #3 — bump version, garde double-binding
                   sur les listeners window, messages revus)
   RÔLE : Mobile UI (détection viewport, B8 fact-mobile classes,
          PWA install prompt, FAB contextuel, plein écran, bottom bar,
          safe-area iOS)
   DÉPENDANCES : 01-core.js (VoltCore), 03-utils.js (helpers)
   EXPOSE : initMobile, isMobileView, isTouchDevice, isPWAInstalled,
            installPWA, isFullscreen, toggleFullscreen,
            updateFabForSection, updateBottomBarActive,
            applyFactMobileClasses, attachMobileEvents
   SECTIONS :
     1 : CONSTANTES + ÉTAT
     2 : DÉTECTION VIEWPORT / DEVICE
     3 : B8 — CLASSES .fact-mobile-*
     4 : PWA INSTALL PROMPT
     5 : PLEIN ÉCRAN
     6 : FAB CONTEXTUEL
     7 : BOTTOM BAR
     8 : ÉVÉNEMENTS
     9 : INIT
   ═══════════════════════════════════════════════════════════════ */

/* ═══════════ SECTION 1 — CONSTANTES + ÉTAT ═══════════ */

var VOLTCORE_MOBILE_BREAKPOINT = 768;
var VOLTCORE_TABLET_BREAKPOINT = 1024;

var __currentMobileSection = 'dashboard';
var __deferredInstallPrompt = null;
var __installBannerDismissed = false;
/* v6.7 — garde anti-double binding des listeners window (resize,
   orientationchange). Sans cette garde, si attachMobileEvents est
   appelé 2 fois (cas anormal mais possible via HMR en dev), on
   empile les écouteurs et le debounce se déclenche N fois. */
var __mobileEventsBound = false;

/* Registre FAB : une action par section.
   Chaque action est protégée par typeof → safe si module pas chargé. */
var FAB_FUNCS = {
  'clients':      function () { if (typeof openClientModal === 'function') openClientModal(null); },
  'fournisseurs': function () { if (typeof openSupplierModal === 'function') openSupplierModal(null); },
  'stock':        function () { if (typeof openArticleModal === 'function') openArticleModal(null); },
  'chantiers':    function () { if (typeof openChantierModal === 'function') openChantierModal(null); },
  'facturation':  function () { if (typeof openInvoiceForm === 'function') openInvoiceForm(); },
  'achats':       function () { if (typeof openPurchaseModal === 'function') openPurchaseModal(null); },
  'frais':        function () { if (typeof openFraisModal === 'function') openFraisModal(null); },
  'bonsRoute':    function () { if (typeof openBonRouteModal === 'function') openBonRouteModal(null); },
  'rh':           function () { if (typeof openHREmployeeModal === 'function') openHREmployeeModal(null); }
};

var FAB_LABELS = {
  'clients':      '👤 Nouveau client',
  'fournisseurs': '🏭 Nouveau fournisseur',
  'stock':        '📦 Nouvel article',
  'chantiers':    '🏗️ Nouveau chantier',
  'facturation':  '🧾 Nouvelle facture',
  'achats':       '🛒 Nouvel achat',
  'frais':        '💰 Nouveau frais',
  'bonsRoute':    '🚐 Nouveau bon route',
  'rh':           '👥 Nouvel employé'
};

/* ═══════════ SECTION 2 — DÉTECTION VIEWPORT / DEVICE ═══════════ */

function isMobileView() {
  try {
    return window.innerWidth < VOLTCORE_MOBILE_BREAKPOINT;
  } catch (e) { return false; }
}

function isTabletView() {
  try {
    return window.innerWidth >= VOLTCORE_MOBILE_BREAKPOINT &&
           window.innerWidth < VOLTCORE_TABLET_BREAKPOINT;
  } catch (e) { return false; }
}

function isTouchDevice() {
  try {
    return ('ontouchstart' in window) || (navigator.maxTouchPoints > 0) ||
           (navigator.msMaxTouchPoints > 0);
  } catch (e) { return false; }
}

function _updateDeviceClass() {
  try {
    var body = document.body;
    if (!body) return;
    var isMob = isMobileView();
    var isTab = isTabletView();

    body.classList.toggle('is-mobile-view', isMob);
    body.classList.toggle('is-tablet-view', isTab);
    body.classList.toggle('is-desktop-view', !isMob && !isTab);
    body.classList.toggle('is-touch-device', isTouchDevice());
  } catch (e) { console.warn('_updateDeviceClass :', e); }
}

/* ═══════════ SECTION 3 — B8 — CLASSES .fact-mobile-* ═══════════ */

/* B8 : ajoute/retire les classes .fact-mobile / .fact-desktop
   qui activent les règles CSS responsives pour la facture.
   Le JS ne touche PAS au HTML — le CSS fait la transformation. */
function applyFactMobileClasses() {
  try {
    var body = document.body;
    if (!body) return;
    if (isMobileView()) {
      body.classList.add('fact-mobile');
      body.classList.remove('fact-desktop');
    } else {
      body.classList.add('fact-desktop');
      body.classList.remove('fact-mobile');
    }
  } catch (e) { console.warn('applyFactMobileClasses :', e); }
}

/* ═══════════ SECTION 4 — PWA INSTALL PROMPT ═══════════ */

function isPWAInstalled() {
  try {
    if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) return true;
    if (window.navigator.standalone === true) return true; /* iOS */
    if (window.matchMedia && window.matchMedia('(display-mode: minimal-ui)').matches) return true;
  } catch (e) {}
  return false;
}

function _captureInstallPrompt(ev) {
  try {
    ev.preventDefault();
    __deferredInstallPrompt = ev;
    /* N'affiche pas la bannière si déjà installée ou si dismiss récent */
    if (!isPWAInstalled() && !__installBannerDismissed) {
      _showInstallBanner();
    }
  } catch (e) { console.warn('_captureInstallPrompt :', e); }
}

function _showInstallBanner() {
  try {
    var banner = document.getElementById('installPwaBanner');
    if (!banner) return;
    banner.style.display = 'flex';
  } catch (e) {}
}

function _hideInstallBanner() {
  try {
    var banner = document.getElementById('installPwaBanner');
    if (banner) banner.style.display = 'none';
  } catch (e) {}
}

async function installPWA() {
  try {
    if (!__deferredInstallPrompt) {
      if (typeof showToast === 'function') {
        showToast('Installation non disponible. Utilise le menu du navigateur.', 'info', 4000);
      }
      return false;
    }
    __deferredInstallPrompt.prompt();
    var choice = await __deferredInstallPrompt.userChoice;
    __deferredInstallPrompt = null;
    _hideInstallBanner();
    if (choice && choice.outcome === 'accepted') {
      if (typeof showToast === 'function') showToast('VOLTCORE installé !', 'success', 3000);
      return true;
    }
    return false;
  } catch (e) {
    console.warn('installPWA :', e);
    return false;
  }
}

function dismissInstallBanner() {
  __installBannerDismissed = true;
  _hideInstallBanner();
}

/* ═══════════ SECTION 5 — PLEIN ÉCRAN ═══════════ */

function isFullscreenAvailable() {
  try {
    return !!(document.documentElement.requestFullscreen ||
              document.documentElement.webkitRequestFullscreen ||
              document.documentElement.mozRequestFullScreen ||
              document.documentElement.msRequestFullscreen);
  } catch (e) { return false; }
}

function isFullscreen() {
  try {
    return !!(document.fullscreenElement || document.webkitFullscreenElement ||
              document.mozFullScreenElement || document.msFullscreenElement);
  } catch (e) { return false; }
}

function enterFullscreen() {
  try {
    var el = document.documentElement;
    var p = null;
    if (el.requestFullscreen) p = el.requestFullscreen();
    else if (el.webkitRequestFullscreen) p = el.webkitRequestFullscreen();
    else if (el.mozRequestFullScreen) p = el.mozRequestFullScreen();
    else if (el.msRequestFullscreen) p = el.msRequestFullscreen();
    if (p && typeof p.catch === 'function') p.catch(function (e) { console.warn(e); });
  } catch (e) { console.warn('enterFullscreen :', e); }
}

function exitFullscreen() {
  try {
    if (document.exitFullscreen) document.exitFullscreen();
    else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
    else if (document.mozCancelFullScreen) document.mozCancelFullScreen();
    else if (document.msExitFullscreen) document.msExitFullscreen();
  } catch (e) { console.warn('exitFullscreen :', e); }
}

function toggleFullscreen() {
  if (isFullscreen()) exitFullscreen();
  else enterFullscreen();
}

function _onFullscreenChange() {
  try {
    var btn = document.getElementById('btnFullscreen');
    if (!btn) return;
    btn.textContent = isFullscreen() ? '⛶' : '⛶';
    btn.title = isFullscreen() ? 'Quitter le plein écran' : 'Plein écran';
  } catch (e) {}
}

/* ═══════════ SECTION 6 — FAB CONTEXTUEL ═══════════ */

function renderFab() {
  try {
    var fab = document.getElementById('mobileFab');
    if (!fab) return;
    var hasAction = !!FAB_FUNCS[__currentMobileSection];
    fab.style.display = hasAction ? 'flex' : 'none';
    if (hasAction) {
      fab.setAttribute('aria-label', FAB_LABELS[__currentMobileSection] || 'Nouveau');
      fab.title = FAB_LABELS[__currentMobileSection] || 'Nouveau';
    }
  } catch (e) { console.warn('renderFab :', e); }
}

function updateFabForSection(sectionId) {
  try {
    __currentMobileSection = String(sectionId || 'dashboard');
    renderFab();
  } catch (e) { console.warn('updateFabForSection :', e); }
}

function _handleFabClick() {
  try {
    var fn = FAB_FUNCS[__currentMobileSection];
    if (typeof fn !== 'function') return;
    fn();
  } catch (e) { console.warn('_handleFabClick :', e); }
}

/* ═══════════ SECTION 7 — BOTTOM BAR ═══════════ */

function updateBottomBarActive(sectionId) {
  try {
    var sec = String(sectionId || '');
    var tabs = document.querySelectorAll('.bottom-tab');
    for (var i = 0; i < tabs.length; i++) {
      var t = tabs[i];
      var tsec = t.getAttribute('data-section') || '';
      t.classList.toggle('active', tsec === sec);
    }
  } catch (e) { console.warn('updateBottomBarActive :', e); }
}

/* ═══ LOT 5 — navigateToSection DÉPLACÉE dans 21-init-app.js ═══
   Raison : duplication silencieuse (2 définitions globales → la dernière
   écrasait l'autre selon l'ordre de chargement). La version unifiée est
   dans 21-init-app.js chargé après ce fichier.
   Ne PAS la redéfinir ici. */

/* ═══════════ SECTION 8 — ÉVÉNEMENTS ═══════════ */

function attachMobileEvents() {
  /* v6.7 — garde anti-double binding (défensive) */
  if (__mobileEventsBound) {
    try { console.warn('attachMobileEvents déjà appelé — ignoré'); } catch (e) {}
    return;
  }
  __mobileEventsBound = true;

  try {
    /* ── Resize (debounced) ── */
    var debouncedResize = debounce(function () {
      _updateDeviceClass();
      applyFactMobileClasses();
    }, 200);
    window.addEventListener('resize', debouncedResize);
    /* orientationchange déclenche resize aussi mais on l'attrape au cas où */
    window.addEventListener('orientationchange', function () {
      setTimeout(debouncedResize, 250);
    });

    /* ── beforeinstallprompt (PWA) ── */
    window.addEventListener('beforeinstallprompt', _captureInstallPrompt);
    window.addEventListener('appinstalled', function () {
      __deferredInstallPrompt = null;
      _hideInstallBanner();
      if (typeof showToast === 'function') showToast('VOLTCORE installé !', 'success', 3000);
    });

    /* ── fullscreen change ── */
    ['fullscreenchange', 'webkitfullscreenchange', 'mozfullscreenchange', 'MSFullscreenChange']
      .forEach(function (ev) {
        try { document.addEventListener(ev, _onFullscreenChange); } catch (e) {}
      });

    /* ── FAB clic ── */
    var fab = document.getElementById('mobileFab');
    if (fab && !fab.__bound) {
      fab.__bound = true;
      fab.addEventListener('click', _handleFabClick);
    }

    /* ── Bottom bar : click sur tabs ── */
    var tabs = document.querySelectorAll('.bottom-tab');
    for (var i = 0; i < tabs.length; i++) {
      var tab = tabs[i];
      if (tab.__bound) continue;
      tab.__bound = true;
      (function (t) {
        t.addEventListener('click', function (ev) {
          try { ev.preventDefault(); } catch (e) {}
          var sec = t.getAttribute('data-section') || '';
          /* navigateToSection est défini dans 21-init-app.js */
          if (typeof navigateToSection === 'function') {
            navigateToSection(sec);
          }
        });
      })(tab);
    }

    /* ── Bouton plein écran header ── */
    var fsBtn = document.getElementById('btnFullscreen');
    if (fsBtn && !fsBtn.__bound) {
      fsBtn.__bound = true;
      if (!isFullscreenAvailable()) {
        fsBtn.style.display = 'none';
      } else {
        fsBtn.addEventListener('click', toggleFullscreen);
      }
    }

    /* ── Boutons install banner ── */
    var installBtn = document.getElementById('btnInstallPwa');
    if (installBtn && !installBtn.__bound) {
      installBtn.__bound = true;
      installBtn.addEventListener('click', installPWA);
    }
    var dismissBtn = document.getElementById('btnDismissInstallPwa');
    if (dismissBtn && !dismissBtn.__bound) {
      dismissBtn.__bound = true;
      dismissBtn.addEventListener('click', dismissInstallBanner);
    }

    /* ── Écoute changement de section custom event ──
       (émis par showSection dans 21-init-app.js si présent) */
    window.addEventListener('voltcore:section:changed', function (ev) {
      var sec = ev && ev.detail && ev.detail.section;
      if (sec) {
        __currentMobileSection = String(sec);
        updateBottomBarActive(sec);
        updateFabForSection(sec);
      }
    });
  } catch (e) { console.warn('attachMobileEvents :', e); }
}

/* ═══════════ SECTION 9 — INIT ═══════════ */

function initMobile() {
  try {
    _updateDeviceClass();
    applyFactMobileClasses();
    updateBottomBarActive(__currentMobileSection);
    updateFabForSection(__currentMobileSection);

    /* Si PWA déjà installée, cache la bannière */
    if (isPWAInstalled()) {
      _hideInstallBanner();
    }
  } catch (e) { console.warn('initMobile :', e); }
}

console.log('✅ 18-mobile.js chargé — v6.7 (mobile UI + garde double-binding)');