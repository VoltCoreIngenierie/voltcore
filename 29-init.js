/* ═══════════════════════════════════════════════════════════
   VOLTCORE — 29-init.js
   VERSION : v7.0.7
   RÔLE : Wiring central.
          - Navigation (showSection, VC.Nav.go, hash)
          - refreshAllUI (re-render global)
          - Fermeture modales Échap (closeTopModal) — FIX M16
          - Raccourcis clavier (Échap, Ctrl+K, Ctrl+S)
          - attachAllEvents : appelle attachEvents de chaque module
          - initApp : premier rendu après login
   DÉPENDANCES : 00 → 28
   ORDRE : 30ᵉ fichier chargé

   FIX v7.0.0 :
   - M16 : liberationGarantieModal fermable via Échap
   - Attach idempotent (flag __attached)
   - Ctrl+S intercepté pour saveAll
   - Ctrl+K focus dynamique par section (avec fallback toast)

   RÈGLES :
   - ES5 strict
   - Aucun catch silencieux
   - Chaque attach protégé par typeof (module absent → skip)
   ═══════════════════════════════════════════════════════════ */

'use strict';

(function (global) {

  if (!global.VOLTCORE || !global.VOLTCORE.Store || !global.VOLTCORE.Utils) {
    throw new Error('[29-init] Modules requis non chargés');
  }

  var VC = global.VOLTCORE;
  var U = VC.Utils;
  var S = VC.Store;
  var Init = VC.Init || {};
  VC.Init = Init;

  /* ═══════════════════════════════════════════════════════════
     SECTION 1 — CONSTANTES + ÉTAT
     ═══════════════════════════════════════════════════════════ */

  var _attached = false;
  var _currentSection = 'dashboard';
  var _appBooted = false;

  /* Map section → { container, render } */
  var SECTION_MAP = {
    dashboard: { el: 'dashboardSection', render: 'renderDashboard' },
    reports: { el: 'reportsSection', render: 'renderReportsCurrentTab' },
    clients: { el: 'clientsSection', render: 'renderClients' },
    fournisseurs: { el: 'suppliersSection', render: 'renderSuppliers' },
    stock: { el: 'stockSection', render: 'renderStock' },
    chantiers: { el: 'chantiersSection', render: 'renderChantiers' },
    facturation: { el: 'facturationSection', render: 'renderInvoices' },
    achats: { el: 'purchasesSection', render: 'renderPurchases' },
    frais: { el: 'fraisSection', render: 'renderFrais' },
    bonsRoute: { el: 'bonsRouteSection', render: 'renderBonsRoute' },
    rh: { el: 'hrSection', render: 'renderHR' },
    documents: { el: 'documentsSection', render: 'renderDocuments' },
    outils: { el: 'toolsSection', render: 'renderTools' }
  };

  var VALID_SECTIONS = Object.keys(SECTION_MAP);

  /* Map : section → id du champ de recherche */
  var SEARCH_INPUTS = {
    clients: 'clientsSearchInput',
    fournisseurs: 'suppliersSearchInput',
    stock: 'stockSearchInput',
    chantiers: 'chantiersSearchInput',
    facturation: 'invoicesSearchInput',
    achats: 'purchasesSearchInput',
    frais: 'fraisSearchInput',
    bonsRoute: 'bonsRouteSearchInput',
    rh: 'hrSearchInput',
    documents: 'documentsSearchInput'
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 2 — MODAL CLOSE MAP (FIX M16)
     ═══════════════════════════════════════════════════════════ */

  /**
   * Map modalId → nom de fonction sur VC (namespace + function).
   * Si le module n'existe pas ou la fonction non plus, fallback sur
   * display = 'none'.
   *
   * FIX M16 : liberationGarantieModal incluse.
   */
  var MODAL_CLOSE_FNS = {
    /* Auth */
    'loginModal': null,               /* Ne pas fermer par Échap */
    'lockOverlay': null,              /* Ne pas fermer par Échap */
    'licenseModal': null,             /* Ne pas fermer par Échap */
    'userManagementModal': function () {
      if (VC.Auth && VC.Auth.closeUserModal) VC.Auth.closeUserModal();
    },

    /* Clients */
    'clientModal': function () {
      if (VC.Clients && VC.Clients.closeModal) VC.Clients.closeModal();
    },
    'clientDetailModal': function () {
      if (VC.Clients && VC.Clients.closeDetail) VC.Clients.closeDetail();
    },

    /* Suppliers */
    'supplierModal': function () {
      if (VC.Suppliers && VC.Suppliers.closeModal) VC.Suppliers.closeModal();
    },
    'supplierDetailModal': function () {
      if (VC.Suppliers && VC.Suppliers.closeDetail) VC.Suppliers.closeDetail();
    },

    /* Stock */
    'articleModal': function () {
      if (VC.Stock && VC.Stock.closeModal) VC.Stock.closeModal();
    },
    'articleDetailModal': function () {
      if (VC.Stock && VC.Stock.closeDetail) VC.Stock.closeDetail();
    },
    'familleModal': function () { U.hide('familleModal'); },
    'articlePickerModal': function () {
      if (VC.Stock && VC.Stock.closePicker) VC.Stock.closePicker();
    },

    /* Chantiers */
    'chantierModal': function () {
      if (VC.Chantiers && VC.Chantiers.closeModal) VC.Chantiers.closeModal();
    },
    'chantierDetailModal': function () {
      if (VC.Chantiers && VC.Chantiers.closeDetail) VC.Chantiers.closeDetail();
    },

    /* RH */
    'hrEmployeeModal': function () {
      if (VC.HR && VC.HR.closeEmployeeModal) VC.HR.closeEmployeeModal();
    },
    'hrWorkModal': function () { U.hide('hrWorkModal'); },
    'hrTxModal': function () { U.hide('hrTxModal'); },
    'hrDetailModal': function () {
      if (VC.HR && VC.HR.closeDetail) VC.HR.closeDetail();
    },

    /* Factures — CRITIQUE : closeForm sauve le brouillon */
    'invoiceModal': function () {
      if (VC.Invoices && VC.Invoices.closeForm) VC.Invoices.closeForm();
    },
    'invoiceDetailModal': function () {
      if (VC.InvoicesView && VC.InvoicesView.closeDetail) VC.InvoicesView.closeDetail();
    },
    'paymentModal': function () { U.hide('paymentModal'); },
    'liberationGarantieModal': function () {
      /* FIX M16 */
      if (VC.InvoicesView && VC.InvoicesView.closeLiberationGarantie) {
        VC.InvoicesView.closeLiberationGarantie();
      }
    },

    /* Achats */
    'purchaseModal': function () {
      if (VC.Purchases && VC.Purchases.closeModal) VC.Purchases.closeModal();
    },
    'supplierPaymentModal': function () { U.hide('supplierPaymentModal'); },

    /* Frais */
    'fraisModal': function () {
      if (VC.Frais && VC.Frais.closeModal) VC.Frais.closeModal();
    },

    /* Bons Route */
    'bonRouteModal': function () {
      if (VC.Route && VC.Route.closeModal) VC.Route.closeModal();
    },
    'bonRouteDetailModal': function () {
      if (VC.Route && VC.Route.closeDetail) VC.Route.closeDetail();
    },

    /* Documents */
    'documentUploadModal': function () {
      if (VC.Documents && VC.Documents.closeUploadModal) VC.Documents.closeUploadModal();
    },
    'documentDetailModal': function () {
      if (VC.Documents && VC.Documents.closeDetail) VC.Documents.closeDetail();
    },

    /* Scanner */
    'scanModal': function () {
      if (VC.Scan && VC.Scan.close) VC.Scan.close();
    },

    /* Signature */
    'signatureModal': function () {
      if (VC.Sign && VC.Sign.close) VC.Sign.close();
    },

    /* IA */
    'iaModal': function () {
      if (VC.AssistantIA && VC.AssistantIA.close) VC.AssistantIA.close();
    },
    'iaPreviewModal': function () {
      if (VC.AssistantIA && VC.AssistantIA.closePreview) VC.AssistantIA.closePreview();
    },

    /* Aide / Alertes / Diag */
    'helpModal': function () { U.hide('helpModal'); },
    'alertsModal': function () {
      if (VC.Alerts && VC.Alerts.closeModal) VC.Alerts.closeModal();
    },
    'diagPanel': function () {
      if (VC.Tools && VC.Tools.closeDiagnostics) VC.Tools.closeDiagnostics();
    }
  };

  /* Ordre de priorité pour closeTopModal (sous-modales d'abord) */
  var MODAL_PRIORITY = [
    'diagPanel',
    'userManagementModal',
    'articlePickerModal',
    'iaPreviewModal',
    'liberationGarantieModal',
    'paymentModal',
    'supplierPaymentModal',
    'bonRouteDetailModal',
    'documentDetailModal',
    'hrDetailModal',
    'hrWorkModal',
    'hrTxModal',
    'clientDetailModal',
    'supplierDetailModal',
    'articleDetailModal',
    'chantierDetailModal',
    'invoiceDetailModal',
    'signatureModal',
    'scanModal',
    'iaModal',
    'helpModal',
    'alertsModal',
    'bonRouteModal',
    'documentUploadModal',
    'fraisModal',
    'purchaseModal',
    'chantierModal',
    'hrEmployeeModal',
    'familleModal',
    'articleModal',
    'supplierModal',
    'clientModal',
    'invoiceModal'
  ];

  /* ═══════════════════════════════════════════════════════════
     SECTION 3 — FERMETURE MODALE TOP
     ═══════════════════════════════════════════════════════════ */

  function _isModalVisible(el) {
    if (!el) return false;
    var d = el.style.display;
    return d !== 'none' && d !== '';
  }

  function closeTopModal() {
    try {
      for (var i = 0; i < MODAL_PRIORITY.length; i++) {
        var id = MODAL_PRIORITY[i];
        var el = document.getElementById(id);
        if (!_isModalVisible(el)) continue;

        var closer = MODAL_CLOSE_FNS[id];
        if (typeof closer === 'function') {
          try {
            closer();
          } catch (e) {
            VC.logError('29-init', 'closer ' + id + ' échoué', e);
            el.style.display = 'none';
          }
        } else if (closer === undefined) {
          /* Fonction absente de la map → fallback */
          el.style.display = 'none';
        }
        /* Si closer est null explicitement : ne pas fermer (login/lock/licence) */
        return true;
      }
      return false;
    } catch (e) {
      VC.logError('29-init', 'closeTopModal échoué', e);
      return false;
    }
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 4 — NAVIGATION
     ═══════════════════════════════════════════════════════════ */

  function _getInitialSection() {
    try {
      var hash = String(global.location.hash || '').replace('#', '');
      if (hash && VALID_SECTIONS.indexOf(hash) !== -1) return hash;
    } catch (e) {
      VC.logError('29-init', 'lecture hash échoué', e);
    }
    return 'dashboard';
  }

  function _renderSectionContent(section) {
    var entry = SECTION_MAP[section];
    if (!entry) return;

    var fnName = entry.render;
    if (!fnName) return;

    /* Résolution : tous les render vivent sous VC.X.render ou VC.X.renderY */
    var fns = {
      renderDashboard: function () {
        if (VC.Dashboard && VC.Dashboard.render) VC.Dashboard.render();
      },
      renderReportsCurrentTab: function () {
        if (VC.Dashboard && VC.Dashboard.renderCurrentReport) {
          VC.Dashboard.renderCurrentReport();
        }
      },
      renderClients: function () {
        if (VC.Clients && VC.Clients.render) VC.Clients.render();
      },
      renderSuppliers: function () {
        if (VC.Suppliers && VC.Suppliers.render) VC.Suppliers.render();
      },
      renderStock: function () {
        if (VC.Stock && VC.Stock.render) VC.Stock.render();
      },
      renderChantiers: function () {
        if (VC.Chantiers && VC.Chantiers.render) VC.Chantiers.render();
      },
      renderInvoices: function () {
        if (VC.InvoicesView && VC.InvoicesView.render) VC.InvoicesView.render();
      },
      renderPurchases: function () {
        if (VC.Purchases && VC.Purchases.render) VC.Purchases.render();
      },
      renderFrais: function () {
        if (VC.Frais && VC.Frais.render) VC.Frais.render();
      },
      renderBonsRoute: function () {
        if (VC.Route && VC.Route.render) VC.Route.render();
      },
      renderHR: function () {
        if (VC.HR && VC.HR.render) VC.HR.render();
      },
      renderDocuments: function () {
        if (VC.Documents && VC.Documents.render) VC.Documents.render();
      },
      renderTools: function () {
        if (VC.Tools && VC.Tools.loadSettings) VC.Tools.loadSettings();
        if (VC.Tools && VC.Tools.renderTrash) VC.Tools.renderTrash();
        if (VC.Tools && VC.Tools.renderHistory) VC.Tools.renderHistory();
      }
    };

    var fn = fns[fnName];
    if (typeof fn === 'function') {
      try { fn(); } catch (e) {
        VC.logError('29-init', 'render ' + section + ' échoué', e);
      }
    }
  }

  function showSection(sectionId) {
    try {
      var sec = String(sectionId || 'dashboard');
      if (VALID_SECTIONS.indexOf(sec) === -1) sec = 'dashboard';

      /* Cache toutes les sections */
      for (var i = 0; i < VALID_SECTIONS.length; i++) {
        var s = VALID_SECTIONS[i];
        var el = document.getElementById(SECTION_MAP[s].el);
        if (el) el.style.display = 'none';
      }

      /* Affiche la cible */
      var target = document.getElementById(SECTION_MAP[sec].el);
      if (target) target.style.display = '';

      /* Met à jour la sidebar */
      var navItems = document.querySelectorAll('[data-nav-section]');
      for (var j = 0; j < navItems.length; j++) {
        var item = navItems[j];
        var isActive = item.getAttribute('data-nav-section') === sec;
        item.classList.toggle('active', isActive);
      }

      /* Met à jour l'URL */
      try {
        if (global.history && typeof global.history.replaceState === 'function') {
          global.history.replaceState(null, '', '#' + sec);
        }
      } catch (e) {
        VC.logError('29-init', 'replaceState échoué', e);
      }

      /* Émet l'event (capté par 24-mobile pour la bottom bar / FAB) */
      try {
        global.dispatchEvent(new CustomEvent('voltcore:section:changed', {
          detail: { section: sec }
        }));
      } catch (e) {
        VC.logError('29-init', 'dispatchEvent échoué', e);
      }

      /* Render du contenu */
      _renderSectionContent(sec);

      /* Scroll top */
      try { global.scrollTo(0, 0); } catch (e) {
        VC.logError('29-init', 'scrollTo échoué', e);
      }

      _currentSection = sec;
    } catch (e) {
      VC.logError('29-init', 'showSection échoué', e);
    }
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 5 — REFRESH ALL UI
     ═══════════════════════════════════════════════════════════ */

  function refreshAllUI() {
    var renders = [
      ['VC.Dashboard.render', function () {
        if (VC.Dashboard && VC.Dashboard.render) VC.Dashboard.render();
      }],
      ['VC.Alerts.renderBadges', function () {
        if (VC.Alerts && VC.Alerts.renderBadges) VC.Alerts.renderBadges();
      }],
      ['VC.Chantiers.renderBadge', function () {
        if (VC.Chantiers && VC.Chantiers.renderBadge) VC.Chantiers.renderBadge();
      }],
      ['VC.Clients.render', function () {
        if (VC.Clients && VC.Clients.render) VC.Clients.render();
      }],
      ['VC.Suppliers.render', function () {
        if (VC.Suppliers && VC.Suppliers.render) VC.Suppliers.render();
      }],
      ['VC.Stock.render', function () {
        if (VC.Stock && VC.Stock.render) VC.Stock.render();
      }],
      ['VC.Chantiers.render', function () {
        if (VC.Chantiers && VC.Chantiers.render) VC.Chantiers.render();
      }],
      ['VC.InvoicesView.render', function () {
        if (VC.InvoicesView && VC.InvoicesView.render) VC.InvoicesView.render();
      }],
      ['VC.Purchases.render', function () {
        if (VC.Purchases && VC.Purchases.render) VC.Purchases.render();
      }],
      ['VC.Frais.render', function () {
        if (VC.Frais && VC.Frais.render) VC.Frais.render();
      }],
      ['VC.Route.render', function () {
        if (VC.Route && VC.Route.render) VC.Route.render();
      }],
      ['VC.HR.render', function () {
        if (VC.HR && VC.HR.render) VC.HR.render();
      }],
      ['VC.Documents.render', function () {
        if (VC.Documents && VC.Documents.render) VC.Documents.render();
      }],
      ['VC.Tools.renderTrash', function () {
        if (VC.Tools && VC.Tools.renderTrash) VC.Tools.renderTrash();
      }],
      ['VC.Tools.renderHistory', function () {
        if (VC.Tools && VC.Tools.renderHistory) VC.Tools.renderHistory();
      }]
    ];

    for (var i = 0; i < renders.length; i++) {
      try {
        renders[i][1]();
      } catch (e) {
        VC.logError('29-init', renders[i][0] + ' échoué', e);
      }
    }
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 6 — RACCOURCIS CLAVIER
     ═══════════════════════════════════════════════════════════ */

  function _attachKeyboardShortcuts() {
    global.addEventListener('keydown', function (ev) {
      /* Échap → fermer top modal */
      if (ev.key === 'Escape' || ev.keyCode === 27) {
        var closed = closeTopModal();
        if (closed) {
          try { ev.preventDefault(); } catch (e) {
            VC.logError('29-init', 'Escape preventDefault échoué', e);
          }
        }
        return;
      }

      /* Ctrl+S / Cmd+S → saveAll */
      if ((ev.ctrlKey || ev.metaKey) && (ev.key === 's' || ev.key === 'S')) {
        try { ev.preventDefault(); } catch (e) {
          VC.logError('29-init', 'Ctrl+S preventDefault échoué', e);
        }
        try {
          S.saveAll();
          U.toast('Données sauvegardées', 'success', 1500);
        } catch (e) {
          VC.logError('29-init', 'Ctrl+S saveAll échoué', e);
        }
        return;
      }

      /* Ctrl+K → focus recherche de la section courante */
      if ((ev.ctrlKey || ev.metaKey) && (ev.key === 'k' || ev.key === 'K')) {
        try { ev.preventDefault(); } catch (e) {
          VC.logError('29-init', 'Ctrl+K preventDefault échoué', e);
        }

        var inputId = SEARCH_INPUTS[_currentSection];
        if (inputId) {
          var el = document.getElementById(inputId);
          if (el && el !== document.activeElement) {
            try { el.focus(); el.select(); } catch (e) {
              VC.logError('29-init', 'Ctrl+K focus échoué', e);
            }
            return;
          }
        }

        U.toast('Recherche rapide disponible dans Clients, Fournisseurs, ' +
          'Stock, Chantiers, Facturation, Achats, Frais, RH, Bons Route, Documents.',
          'info', 4000);
        return;
      }
    });
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 7 — NAV EVENTS (sidebar + hash)
     ═══════════════════════════════════════════════════════════ */

  function _attachGlobalNav() {
    var navItems = document.querySelectorAll('[data-nav-section]');
    for (var i = 0; i < navItems.length; i++) {
      (function (item) {
        if (item.__bound) return;
        item.__bound = true;
        item.addEventListener('click', function (ev) {
          try { ev.preventDefault(); } catch (e) {
            VC.logError('29-init', 'nav preventDefault échoué', e);
          }
          var sec = item.getAttribute('data-nav-section') || '';
          if (sec) showSection(sec);
        });
      })(navItems[i]);
    }
  }

  function _attachHashNav() {
    global.addEventListener('hashchange', function () {
      try {
        var hash = String(global.location.hash || '').replace('#', '');
        if (hash && VALID_SECTIONS.indexOf(hash) !== -1 &&
            hash !== _currentSection) {
          showSection(hash);
        }
      } catch (e) {
        VC.logError('29-init', 'hashchange échoué', e);
      }
    });
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 8 — ATTACH ALL EVENTS
     ═══════════════════════════════════════════════════════════ */

  Init.attachAllEvents = function () {
    if (_attached) {
      VC.logWarn('29-init', 'attachAllEvents déjà appelé — skip');
      return;
    }
    _attached = true;

    /* Modules métier : chaque attach protégé par typeof */
    var modules = [
      ['Auth', VC.Auth],
      ['Clients', VC.Clients],
      ['Suppliers', VC.Suppliers],
      ['Stock', VC.Stock],
      ['Chantiers', VC.Chantiers],
      ['HR', VC.HR],
      ['Invoices', VC.Invoices],
      ['InvoicesView', VC.InvoicesView],
      ['Purchases', VC.Purchases],
      ['Frais', VC.Frais],
      ['Route', VC.Route],
      ['Documents', VC.Documents],
      ['Scan', VC.Scan],
      ['Sign', VC.Sign],
      ['AssistantIA', VC.AssistantIA],
      ['Dashboard', VC.Dashboard],
      ['Mobile', VC.Mobile],
      ['Tools', VC.Tools],
      ['Backup', VC.Backup]
    ];

    for (var i = 0; i < modules.length; i++) {
      var name = modules[i][0];
      var mod = modules[i][1];

      if (!mod || typeof mod.attachEvents !== 'function') {
        VC.logWarn('29-init', name + '.attachEvents absent (module non chargé ?)');
        continue;
      }

      try {
        mod.attachEvents();
      } catch (e) {
        VC.logError('29-init', name + '.attachEvents échoué', e);
      }
    }

    /* Bindings globaux */
    _attachGlobalNav();
    _attachHashNav();
    _attachKeyboardShortcuts();

    VC.logInfo('29-init', 'attachAllEvents terminé');
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 9 — INIT APP (après login)
     ═══════════════════════════════════════════════════════════ */

  Init.initApp = function () {
    if (_appBooted) {
      VC.logWarn('29-init', 'initApp déjà appelé — skip');
      return;
    }
    _appBooted = true;

    try {
      VC.logInfo('29-init', 'initApp — wiring + premier rendu');

      /* 1. Wiring */
      Init.attachAllEvents();

      /* 2. Modules à initialiser une fois (tools, mobile) */
      if (VC.Tools && typeof VC.Tools.init === 'function') {
        try { VC.Tools.init(); } catch (e) {
          VC.logError('29-init', 'VC.Tools.init échoué', e);
        }
      }
      if (VC.Mobile && typeof VC.Mobile.init === 'function') {
        try { VC.Mobile.init(); } catch (e) {
          VC.logError('29-init', 'VC.Mobile.init échoué', e);
        }
      }

      /* 3. Section de départ */
      var startSection = _getInitialSection();
      showSection(startSection);

      /* 4. Premier rendu global */
      refreshAllUI();

      /* 5. Badge autosave initial */
      if (VC.Infra && typeof VC.Infra.updateAutosaveBadge === 'function') {
        try { VC.Infra.updateAutosaveBadge(); } catch (e) {
          VC.logError('29-init', 'updateAutosaveBadge échoué', e);
        }
      }

      /* 6. Message d'accueil */
      if (VC.Auth && VC.Auth.currentUser) {
        U.toast('Bienvenue ' + VC.Auth.currentUser.username +
          ' — v' + VC.VERSION, 'success', 2500);
      }

      VC.logInfo('29-init', 'VOLTCORE v' + VC.VERSION +
        ' prêt — section : ' + startSection);
    } catch (e) {
      VC.logError('29-init', 'initApp échoué', e);
    }
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 10 — EXPOSITION VC.Nav + VC.initApp
     ═══════════════════════════════════════════════════════════ */

  VC.Nav = {
    go: showSection,
    showSection: showSection,
    getCurrent: function () { return _currentSection; },
    closeTopModal: closeTopModal
  };

  /* Exposé pour 05-auth (_showAppAfterLogin) */
  VC.initApp = Init.initApp;
  VC.refreshAllUI = refreshAllUI;

  /* ═══════════════════════════════════════════════════════════
     SECTION 11 — MARQUEUR
     ═══════════════════════════════════════════════════════════ */

  VC._initLoaded = true;

  VC.logInfo('29-init', 'Module chargé (M16 corrigé, Ctrl+S actif)');

})(window);