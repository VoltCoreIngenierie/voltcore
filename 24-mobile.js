/* ═══════════════════════════════════════════════════════════
   VOLTCORE — 24-mobile.js
   VERSION : v7.0.7
   RÔLE : UI mobile — détection viewport, classes .fact-mobile,
          PWA install prompt, FAB contextuel, bottom bar,
          plein écran, safe-area iOS, classes body.
   DÉPENDANCES : 00-core, 01-utils
   ORDRE : 25ᵉ fichier chargé

   FIX v7.0.0 :
   - Listeners mobile uniques (plus d'empilement au re-bind)
   - FAB contextuel avec garde typeof sur chaque action
   - navigateToSection délégué à VC.Nav (défini dans 29-init)
   - Bottom bar actif synchronisé via event 'voltcore:section:changed'
   - Détection PWA installée + capture beforeinstallprompt

   RÈGLES :
   - ES5 strict
   - Aucun catch silencieux
   - Ne JAMAIS dupliquer les listeners window
   ═══════════════════════════════════════════════════════════ */

'use strict';

(function (global) {

  if (!global.VOLTCORE || !global.VOLTCORE.Utils) {
    throw new Error('[24-mobile] 00-core et 01-utils requis');
  }

  var VC = global.VOLTCORE;
  var U = VC.Utils;
  var Mob = VC.Mobile || {};
  VC.Mobile = Mob;

  /* ═══════════════════════════════════════════════════════════
     SECTION 1 — ÉTAT INTERNE
     ═══════════════════════════════════════════════════════════ */

  var _currentSection = 'dashboard';
  var _deferredInstallPrompt = null;
  var _installBannerDismissed = false;
  var _eventsBound = false;

  /* FAB : une action par section. Chaque action protégée par typeof. */
  var FAB_ACTIONS = {
    clients: function () {
      if (VC.Clients && typeof VC.Clients.openModal === 'function') {
        VC.Clients.openModal(null);
      }
    },
    fournisseurs: function () {
      if (VC.Suppliers && typeof VC.Suppliers.openModal === 'function') {
        VC.Suppliers.openModal(null);
      }
    },
    stock: function () {
      if (VC.Stock && typeof VC.Stock.openModal === 'function') {
        VC.Stock.openModal(null);
      }
    },
    chantiers: function () {
      if (VC.Chantiers && typeof VC.Chantiers.openModal === 'function') {
        VC.Chantiers.openModal(null);
      }
    },
    facturation: function () {
      if (VC.Invoices && typeof VC.Invoices.openForm === 'function') {
        VC.Invoices.openForm();
      }
    },
    achats: function () {
      if (VC.Purchases && typeof VC.Purchases.openModal === 'function') {
        VC.Purchases.openModal(null);
      }
    },
    frais: function () {
      if (VC.Frais && typeof VC.Frais.openModal === 'function') {
        VC.Frais.openModal(null);
      }
    },
    bonsRoute: function () {
      if (VC.Route && typeof VC.Route.openModal === 'function') {
        VC.Route.openModal(null);
      }
    },
    rh: function () {
      if (VC.HR && typeof VC.HR.openEmployeeModal === 'function') {
        VC.HR.openEmployeeModal(null);
      }
    },
    documents: function () {
      if (VC.Documents && typeof VC.Documents.openUploadModal === 'function') {
        VC.Documents.openUploadModal();
      }
    }
  };

  var FAB_LABELS = {
    clients: '👤 Nouveau client',
    fournisseurs: '🏭 Nouveau fournisseur',
    stock: '📦 Nouvel article',
    chantiers: '🏗️ Nouveau chantier',
    facturation: '🧾 Nouvelle facture',
    achats: '🛒 Nouvel achat',
    frais: '💰 Nouveau frais',
    bonsRoute: '🚐 Nouveau bon route',
    rh: '👥 Nouvel employé',
    documents: '📁 Nouveau document'
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 2 — DÉTECTION VIEWPORT / DEVICE
     ═══════════════════════════════════════════════════════════ */

  Mob.isMobile = function () {
    return global.innerWidth < VC.MOBILE_BREAKPOINT;
  };

  Mob.isTablet = function () {
    return global.innerWidth >= VC.MOBILE_BREAKPOINT &&
           global.innerWidth < VC.TABLET_BREAKPOINT;
  };

  function _updateDeviceClasses() {
    var body = document.body;
    if (!body) return;

    var isMob = Mob.isMobile();
    var isTab = Mob.isTablet();

    body.classList.toggle('is-mobile-view', isMob);
    body.classList.toggle('is-tablet-view', isTab);
    body.classList.toggle('is-desktop-view', !isMob && !isTab);
    body.classList.toggle('is-touch-device', VC.device.touch);
  }

  function _applyFactMobileClasses() {
    var body = document.body;
    if (!body) return;

    if (Mob.isMobile()) {
      body.classList.add('fact-mobile');
      body.classList.remove('fact-desktop');
    } else {
      body.classList.add('fact-desktop');
      body.classList.remove('fact-mobile');
    }
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 3 — PWA INSTALL PROMPT
     ═══════════════════════════════════════════════════════════ */

  function _showInstallBanner() {
    U.showFlex('installPwaBanner');
  }

  function _hideInstallBanner() {
    U.hide('installPwaBanner');
  }

  Mob.installPWA = function () {
    if (!_deferredInstallPrompt) {
      U.toast('Installation non disponible. Utilise le menu du navigateur.',
        'info', 4000);
      return Promise.resolve(false);
    }

    _deferredInstallPrompt.prompt();
    return _deferredInstallPrompt.userChoice.then(function (choice) {
      var accepted = choice && choice.outcome === 'accepted';
      _deferredInstallPrompt = null;
      _hideInstallBanner();

      if (accepted) {
        U.toast('VOLTCORE installé !', 'success', 3000);
        return true;
      }
      return false;
    }).catch(function (e) {
      VC.logError('24-mobile', 'installPWA échoué', e);
      return false;
    });
  };

  Mob.dismissInstallBanner = function () {
    _installBannerDismissed = true;
    _hideInstallBanner();
  };

  function _onBeforeInstallPrompt(ev) {
    try { ev.preventDefault(); } catch (e) {
      VC.logError('24-mobile', 'preventDefault beforeinstallprompt échoué', e);
    }
    _deferredInstallPrompt = ev;

    if (!VC.isPWAInstalled() && !_installBannerDismissed) {
      _showInstallBanner();
    }
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 4 — PLEIN ÉCRAN
     ═══════════════════════════════════════════════════════════ */

  Mob.isFullscreen = function () {
    return !!(document.fullscreenElement ||
              document.webkitFullscreenElement ||
              document.mozFullScreenElement ||
              document.msFullscreenElement);
  };

  Mob.toggleFullscreen = function () {
    if (Mob.isFullscreen()) {
      try {
        if (document.exitFullscreen) document.exitFullscreen();
        else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
        else if (document.mozCancelFullScreen) document.mozCancelFullScreen();
        else if (document.msExitFullscreen) document.msExitFullscreen();
      } catch (e) {
        VC.logError('24-mobile', 'exitFullscreen échoué', e);
      }
    } else {
      var el = document.documentElement;
      try {
        var p = null;
        if (el.requestFullscreen) p = el.requestFullscreen();
        else if (el.webkitRequestFullscreen) p = el.webkitRequestFullscreen();
        else if (el.mozRequestFullScreen) p = el.mozRequestFullScreen();
        else if (el.msRequestFullscreen) p = el.msRequestFullscreen();

        if (p && typeof p.catch === 'function') {
          p.catch(function (e) {
            VC.logError('24-mobile', 'requestFullscreen refusé', e);
          });
        }
      } catch (e) {
        VC.logError('24-mobile', 'requestFullscreen échoué', e);
      }
    }
  };

  function _onFullscreenChange() {
    var btn = document.getElementById('btnFullscreen');
    if (btn) {
      btn.title = Mob.isFullscreen() ? 'Quitter le plein écran' : 'Plein écran';
    }
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 5 — FAB CONTEXTUEL
     ═══════════════════════════════════════════════════════════ */

  function _renderFab() {
    var fab = document.getElementById('mobileFab');
    if (!fab) return;

    var hasAction = !!FAB_ACTIONS[_currentSection];
    fab.style.display = hasAction ? 'flex' : 'none';
    if (hasAction) {
      fab.setAttribute('aria-label', FAB_LABELS[_currentSection] || 'Nouveau');
      fab.title = FAB_LABELS[_currentSection] || 'Nouveau';
    }
  }

  function _onFabClick() {
    var action = FAB_ACTIONS[_currentSection];
    if (typeof action === 'function') {
      try {
        action();
      } catch (e) {
        VC.logError('24-mobile', 'FAB action échouée pour ' + _currentSection, e);
      }
    }
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 6 — BOTTOM BAR
     ═══════════════════════════════════════════════════════════ */

  function _updateBottomBarActive(section) {
    var tabs = document.querySelectorAll('.bottom-tab');
    for (var i = 0; i < tabs.length; i++) {
      var tab = tabs[i];
      var s = tab.getAttribute('data-section') || '';
      tab.classList.toggle('active', s === section);
    }
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 7 — INIT + RESIZE
     ═══════════════════════════════════════════════════════════ */

  Mob.init = function () {
    _updateDeviceClasses();
    _applyFactMobileClasses();
    _updateBottomBarActive(_currentSection);
    _renderFab();

    if (VC.isPWAInstalled()) _hideInstallBanner();

    /* Bouton fullscreen caché si non supporté */
    var fsBtn = document.getElementById('btnFullscreen');
    if (fsBtn && !VC.device.fullscreen) {
      fsBtn.style.display = 'none';
    }
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 8 — EVENTS
     ═══════════════════════════════════════════════════════════ */

  Mob.attachEvents = function () {
    if (_eventsBound) return;
    _eventsBound = true;

    /* Resize debounced */
    var onResize = U.debounce(function () {
      _updateDeviceClasses();
      _applyFactMobileClasses();
    }, 200);

    global.addEventListener('resize', onResize);
    global.addEventListener('orientationchange', function () {
      setTimeout(onResize, 300);
    });

    /* PWA */
    global.addEventListener('beforeinstallprompt', _onBeforeInstallPrompt);
    global.addEventListener('appinstalled', function () {
      _deferredInstallPrompt = null;
      _hideInstallBanner();
      U.toast('VOLTCORE installé !', 'success', 3000);
    });

    /* Fullscreen */
    var fsEvents = ['fullscreenchange', 'webkitfullscreenchange',
                    'mozfullscreenchange', 'MSFullscreenChange'];
    for (var i = 0; i < fsEvents.length; i++) {
      try {
        document.addEventListener(fsEvents[i], _onFullscreenChange);
      } catch (e) {
        VC.logError('24-mobile', 'bind ' + fsEvents[i] + ' échoué', e);
      }
    }

    /* FAB clic */
    U.on('mobileFab', 'click', _onFabClick);

    /* Bottom bar tabs */
    var tabs = document.querySelectorAll('.bottom-tab');
    for (var j = 0; j < tabs.length; j++) {
      (function (tab) {
        if (tab.__bound) return;
        tab.__bound = true;
        tab.addEventListener('click', function (ev) {
          try { ev.preventDefault(); } catch (e) {
            VC.logError('24-mobile', 'bottom tab preventDefault échoué', e);
          }
          var sec = tab.getAttribute('data-section') || '';
          if (VC.Nav && typeof VC.Nav.go === 'function') {
            VC.Nav.go(sec);
          } else {
            VC.logWarn('24-mobile', 'VC.Nav.go indisponible');
          }
        });
      })(tabs[j]);
    }

    /* Bouton fullscreen */
    U.on('btnFullscreen', 'click', Mob.toggleFullscreen);

    /* Boutons install banner */
    U.on('btnInstallPwa', 'click', function () { Mob.installPWA(); });
    U.on('btnDismissInstallPwa', 'click', Mob.dismissInstallBanner);

    /* Synchronisation section (émis par 29-init via showSection) */
    global.addEventListener('voltcore:section:changed', function (ev) {
      var sec = ev && ev.detail && ev.detail.section;
      if (sec) {
        _currentSection = String(sec);
        _updateBottomBarActive(sec);
        _renderFab();
      }
    });
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 9 — MARQUEUR
     ═══════════════════════════════════════════════════════════ */

  VC._mobileLoaded = true;

  VC.logInfo('24-mobile', 'Module chargé', {
    mobile: Mob.isMobile(),
    tablet: Mob.isTablet(),
    pwaInstalled: VC.isPWAInstalled()
  });

})(window);