/* ═══════════════════════════════════════════════════════════════
   VOLTCORE — 21-init-app.js
   VERSION : v6.7 (Session #3 — bump version, messages revus)
   RÔLE : Boot complet — initApp, attachAllEvents, showSection,
          refreshAllUI, bootSequence, raccourcis clavier
   DÉPENDANCES : les 20+ fichiers précédents (typeof partout)
   EXPOSE : initApp, attachAllEvents, showSection, refreshAllUI,
            bootSequence, navigateToSection
   SECTIONS :
     1 : CONSTANTES + ÉTAT
     2 : MAP SECTIONS
     3 : NAVIGATION (showSection)
     4 : REFRESH GLOBAL
     5 : NAV + SEARCH + RACCOURCIS + ÉCHAP SÉCURISÉ
     6 : ATTACH ALL EVENTS
     7 : INIT APP (appelé après login)
     8 : BOOT SEQUENCE (appelé au démarrage)
     9 : AUTO-START
   ═══════════════════════════════════════════════════════════════ */

/* ═══════════ SECTION 1 — CONSTANTES + ÉTAT ═══════════ */

var __appBooted = false;
var __bootSequenceCalled = false;
var __currentSection = 'dashboard';

/* Mapping modal → fonction de fermeture "propre".
   Si la fonction n'existe pas (ou vaut null), on retombe sur
   `m.style.display='none'` simple. Évite de perdre le brouillon
   de facture, ou de laisser un état fantôme après Échap. */
var MODAL_CLOSE_FNS = {
  clientModal:        'closeClientModal',
  clientDetailModal:  'closeClientDetail',
  supplierModal:      'closeSupplierModal',
  supplierDetailModal:'closeSupplierDetail',
  articleModal:       'closeArticleModal',
  articleDetailModal: 'closeArticleDetail',
  chantierModal:      'closeChantierModal',
  chantierDetailModal:'closeChantierDetail',
  hrEmployeeModal:    'closeHREmployeeModal',
  hrDetailModal:      'closeHRDetail',
  invoiceModal:       'closeInvoiceForm',       /* ⚠ critique : save brouillon */
  invoiceDetailModal: 'closeInvoiceDetail',
  purchaseModal:      'closePurchaseModal',
  fraisModal:         'closeFraisModal',
  bonModal:           'closeBonEditor',
  scanModal:          'closeScanner',
  signatureModal:     'closeSignatureModal',
  iaModal:            'closeAssistantIA',
  helpModal:          'closeHelpModal',
  alertsModal:        'closeAlertsModal'
  /* Modales sans closeFn dédiée (paymentModal, lockOverlay, etc.)
     → fallback automatique sur style.display='none'. */
};

/* ═══════════ SECTION 2 — MAP SECTIONS ═══════════ */

var VOLTCORE_SECTION_MAP = {
  dashboard:    'dashboardSection',
  reports:      'reportsSection',
  clients:      'clientsSection',
  fournisseurs: 'suppliersSection',
  stock:        'stockSection',
  chantiers:    'chantiersSection',
  facturation:  'facturationSection',
  achats:       'purchasesSection',
  frais:        'fraisSection',
  bonsRoute:    'bonsRouteSection',
  rh:           'hrSection',
  documents:    'documentsSection',
  outils:       'toolsSection'
};

var SIDEBAR_SECTIONS = ['dashboard', 'clients', 'fournisseurs', 'stock',
                        'chantiers', 'facturation', 'achats', 'frais',
                        'bonsRoute', 'rh', 'documents', 'outils'];

function _getInitialSection() {
  try {
    var hash = (window.location.hash || '').replace('#', '');
    if (hash && VOLTCORE_SECTION_MAP[hash] && SIDEBAR_SECTIONS.indexOf(hash) >= 0) {
      return hash;
    }
  } catch (e) {}
  return 'dashboard';
}

function _hideSkeleton() {
  try {
    var sk = document.getElementById('appSkeleton');
    if (sk) sk.style.display = 'none';
    var app = document.getElementById('appRoot');
    if (app) app.style.display = '';
  } catch (e) {}
}

function _showSkeletonError(msg) {
  try {
    var sk = document.getElementById('appSkeleton');
    if (!sk) return;
    sk.innerHTML = '<div style="padding:40px;text-align:center;font-family:Arial">' +
      '<h2 style="color:#c00">Erreur de démarrage</h2>' +
      '<p>' + escapeHtml(String(msg || 'Erreur inconnue')) + '</p>' +
      '<button onclick="location.reload()" style="padding:10px 20px;font-size:14px;cursor:pointer">Recharger</button>' +
      '</div>';
    sk.style.display = '';
  } catch (e) {}
}

/* ═══════════ SECTION 3 — NAVIGATION (showSection) ═══════════ */

function showSection(sectionId) {
  try {
    var sec = String(sectionId || 'dashboard');
    if (!VOLTCORE_SECTION_MAP[sec]) sec = 'dashboard';

    var keys = Object.keys(VOLTCORE_SECTION_MAP);
    for (var i = 0; i < keys.length; i++) {
      var el = document.getElementById(VOLTCORE_SECTION_MAP[keys[i]]);
      if (el) el.style.display = 'none';
    }

    var target = document.getElementById(VOLTCORE_SECTION_MAP[sec]);
    if (target) target.style.display = '';

    var navItems = document.querySelectorAll('[data-nav-section]');
    for (var j = 0; j < navItems.length; j++) {
      var item = navItems[j];
      item.classList.toggle('active',
        item.getAttribute('data-nav-section') === sec);
    }

    try {
      if (window.history && typeof window.history.replaceState === 'function') {
        window.history.replaceState(null, '', '#' + sec);
      }
    } catch (e) {}

    try {
      window.dispatchEvent(new CustomEvent('voltcore:section:changed', {
        detail: { section: sec }
      }));
    } catch (e) {}

    _renderSectionContent(sec);

    try { window.scrollTo(0, 0); } catch (e) {}

    __currentSection = sec;
  } catch (e) {
    console.warn('showSection :', e);
  }
}

function _renderSectionContent(sec) {
  try {
    switch (sec) {
      case 'dashboard':
        var dDash = document.getElementById('dashboardSection');
        var dRep = document.getElementById('reportsSection');
        if (dDash) dDash.style.display = '';
        if (dRep) dRep.style.display = 'none';
        var tabD = document.getElementById('tabDashboard');
        var tabR = document.getElementById('tabReports');
        if (tabD) tabD.classList.add('active');
        if (tabR) tabR.classList.remove('active');
        if (typeof renderDashboard === 'function') renderDashboard();
        break;
      case 'reports':
        if (typeof renderReportsCurrentTab === 'function') renderReportsCurrentTab();
        break;
      case 'clients':
        if (typeof renderClients === 'function') renderClients();
        break;
      case 'fournisseurs':
        if (typeof renderSuppliers === 'function') renderSuppliers();
        break;
      case 'stock':
        if (typeof renderStock === 'function') renderStock();
        if (typeof renderFamilles === 'function') renderFamilles();
        break;
      case 'chantiers':
        if (typeof renderChantiers === 'function') renderChantiers();
        break;
      case 'facturation':
        if (typeof renderInvoices === 'function') renderInvoices();
        break;
      case 'achats':
        if (typeof renderPurchases === 'function') renderPurchases();
        break;
      case 'frais':
        if (typeof renderFrais === 'function') renderFrais();
        break;
      case 'bonsRoute':
        if (typeof renderBonsRoute === 'function') renderBonsRoute();
        break;
      case 'rh':
        if (typeof renderHR === 'function') renderHR();
        break;
      case 'documents':
        if (typeof renderDocuments === 'function') renderDocuments();
        break;
      case 'outils':
        if (typeof loadSettings === 'function') loadSettings();
        break;
    }
  } catch (e) {
    console.warn('_renderSectionContent(' + sec + ') :', e);
  }
}

/* Version UNIFIÉE de navigateToSection.
   ⚠️ Si 18-mobile.js contient encore une déclaration de
   `navigateToSection`, c'est cette version qui gagne (chargée après).
   La fonction de 18-mobile.js a été retirée en Session #2. */
function navigateToSection(sectionId) {
  try {
    var sec = String(sectionId || '');
    if (!sec) return;

    if (typeof showSection === 'function') {
      try { showSection(sec); } catch (e) { console.warn('showSection :', e); }
    }
    if (typeof updateBottomBarActive === 'function') {
      try { updateBottomBarActive(sec); } catch (e) {}
    }
    if (typeof updateFabForSection === 'function') {
      try { updateFabForSection(sec); } catch (e) {}
    }
  } catch (e) {
    console.warn('navigateToSection :', e);
  }
}

/* ═══════════ SECTION 4 — REFRESH GLOBAL ═══════════ */

function refreshAllUI() {
  try {
    if (typeof renderAlertBadges === 'function') renderAlertBadges();
    if (typeof renderActiveChantierBadge === 'function') renderActiveChantierBadge();
    if (typeof renderClients === 'function') renderClients();
    if (typeof renderSuppliers === 'function') renderSuppliers();
    if (typeof renderStock === 'function') renderStock();
    if (typeof renderFamilles === 'function') renderFamilles();
    if (typeof renderChantiers === 'function') renderChantiers();
    if (typeof renderInvoices === 'function') renderInvoices();
    if (typeof renderPurchases === 'function') renderPurchases();
    if (typeof renderFrais === 'function') renderFrais();
    /* v6.9.4 — fix I1 : bons route rafraîchis aussi (étaient oubliés) */
    if (typeof renderBonsRoute === 'function') renderBonsRoute();
    /* v6.9.8 — documents rafraîchis aussi */
    if (typeof renderDocuments === 'function') renderDocuments();
    if (typeof renderHR === 'function') renderHR();
    if (typeof renderTrash === 'function') renderTrash();
    if (typeof renderHistory === 'function') renderHistory();
    if (typeof _populateInvoicesClientFilter === 'function') {
      try { _populateInvoicesClientFilter(); } catch (e) {}
    }
  } catch (e) {
    console.warn('refreshAllUI :', e);
  }
}

/* ═══════════ SECTION 5 — NAV + SEARCH + RACCOURCIS + ÉCHAP SÉCURISÉ ═══════════ */

function _attachGlobalNav() {
  try {
    var navItems = document.querySelectorAll('[data-nav-section]');
    for (var i = 0; i < navItems.length; i++) {
      var item = navItems[i];
      if (item.__bound) continue;
      item.__bound = true;
      (function (el) {
        el.addEventListener('click', function (ev) {
          try { ev.preventDefault(); } catch (e) {}
          var sec = el.getAttribute('data-nav-section') || '';
          if (sec) showSection(sec);
        });
      })(item);
    }
  } catch (e) {
    console.warn('_attachGlobalNav :', e);
  }
}

function _attachGlobalSearch() {
  try {
    /* v6.8.1 — Map des champs de recherche par section.
       Déclarée HORS du listener pour éviter de recréer l'objet
       à chaque frappe (micro-optim + clarté). */
    var searchIds = {
      clients: 'clientsSearchInput',
      fournisseurs: 'suppliersSearchInput',
      stock: 'stockSearchInput',
      chantiers: 'chantiersSearchInput',
      facturation: 'invoicesSearchInput',
      achats: 'purchasesSearchInput',
      frais: 'fraisSearchInput',
      rh: 'hrSearchInput'
    };

    document.addEventListener('keydown', function (ev) {
      if (!(ev.ctrlKey || ev.metaKey)) return;
      if (ev.key !== 'k' && ev.key !== 'K') return;

      try { ev.preventDefault(); } catch (e) {}

      /* Niveau 1 — champ de la section active */
      var id = searchIds[__currentSection];
      if (id) {
        var inp = document.getElementById(id);
        if (inp) {
          /* Préserve le focus si l'utilisateur est déjà dans CE champ
             (évite de sélectionner tout le texte à chaque frappe Ctrl+K) */
          if (inp !== document.activeElement) {
            try { inp.focus(); inp.select(); } catch (e) {}
          }
          return;
        }
      }

      /* Niveau 2 — section sans champ (dashboard/reports/outils).
         Affiche un toast qui indique où Ctrl+K fonctionne + propose
         la section la plus proche (clients en priorité, sinon 1re
         section cherchable disponible). */
      var sectionLabel = __currentSection || 'cette section';
      var TOAST_MS = 4000;
      if (typeof showToast === 'function') {
        showToast(
          'Ctrl+K : recherche rapide disponible dans Clients, Fournisseurs, ' +
          'Stock, Chantiers, Facturation, Achats, Frais et RH.',
          'info',
          TOAST_MS
        );
      }

      /* Niveau 3 — fallback silencieux : si la section active est
         "dashboard", "reports" ou "outils", on ne bascule PAS
         automatiquement (l'utilisateur reste dans son contexte).
         Il peut cliquer lui-même sur Clients s'il veut chercher. */
      try { console.log('[Ctrl+K] Section "' + sectionLabel + '" sans champ de recherche.'); } catch (e) {}
    });
  } catch (e) {
    console.warn('_attachGlobalSearch :', e);
  }
}

/* Ferme la modale du dessus en respectant son closeFn.
   Ne rafraîchit PAS toutes les listes (gain de perf) : fermer une
   modale sans sauvegarder ne change aucune donnée. */
function _closeTopModal() {
  try {
    /* Ordre : sous-modales d'abord, puis formulaires, licence en dernier */
    var modalIds = [
      'iaPreviewModal', 'helpModal', 'signatureModal', 'scanModal',
      'clientDetailModal', 'supplierDetailModal', 'articleDetailModal',
      'chantierDetailModal', 'hrDetailModal', 'invoiceDetailModal',
      'paymentModal', 'supplierPaymentModal',
      'clientModal', 'supplierModal', 'articleModal', 'familleModal',
      'chantierModal', 'hrEmployeeModal', 'hrWorkModal', 'hrTxModal',
      'purchaseModal', 'fraisModal', 'bonModal', 'iaModal', 'invoiceModal',
      'licenseModal'
    ];
    for (var i = 0; i < modalIds.length; i++) {
      var m = document.getElementById(modalIds[i]);
      if (m && m.style.display === 'flex') {
        /* 1) Si une closeFn propre existe → on l'appelle */
        var fnName = MODAL_CLOSE_FNS[modalIds[i]];
        if (fnName && typeof window[fnName] === 'function') {
          try { window[fnName](); } catch (e) {
            console.warn('_closeTopModal → ' + fnName + ' :', e);
            m.style.display = 'none';
          }
        } else {
          /* 2) Fallback : fermeture directe */
          m.style.display = 'none';
        }
        return true;
      }
    }
    return false;
  } catch (e) {
    return false;
  }
}

function _attachKeyboardShortcuts() {
  try {
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' || ev.keyCode === 27) {
        var closed = _closeTopModal();
        if (closed) {
          try { ev.preventDefault(); } catch (e) {}
        }
      }
    });
  } catch (e) {
    console.warn('_attachKeyboardShortcuts :', e);
  }
}

function _attachHashNavigation() {
  try {
    window.addEventListener('hashchange', function () {
      var hash = (window.location.hash || '').replace('#', '');
      if (hash && VOLTCORE_SECTION_MAP[hash] && SIDEBAR_SECTIONS.indexOf(hash) >= 0) {
        if (hash !== __currentSection) showSection(hash);
      }
    });
  } catch (e) {
    console.warn('_attachHashNavigation :', e);
  }
}

/* Bouton "Utilisateurs" dans Outils.
   Le bouton HTML utilise onclick inline avec guard, mais on câble
   aussi via addEventListener ici pour cohérence (idempotent). */
function _attachUsersButton() {
  try {
    var btn = document.getElementById('btnOpenUserManagement');
    if (!btn || btn.__bound) return;
    btn.__bound = true;
    btn.addEventListener('click', function (ev) {
      try { ev.preventDefault(); } catch (e) {}
      if (typeof window.openUserManagementModal === 'function') {
        try { window.openUserManagementModal(); return; } catch (e) { console.warn(e); }
      }
      if (typeof showToast === 'function') {
        showToast('Gestion utilisateurs indisponible (02-auth.js non chargé).', 'warning', 4000);
      }
    });
  } catch (e) { console.warn('_attachUsersButton :', e); }
}

/* ═══════════ SECTION 6 — ATTACH ALL EVENTS ═══════════ */

function attachAllEvents() {
  try {
    /* Modules métier */
    if (typeof attachClientsEvents === 'function') attachClientsEvents();
    if (typeof attachSuppliersEvents === 'function') attachSuppliersEvents();
    if (typeof attachStockEvents === 'function') attachStockEvents();
    if (typeof attachChantiersEvents === 'function') attachChantiersEvents();
    if (typeof attachHREvents === 'function') attachHREvents();
    if (typeof attachInvoicesEvents === 'function') attachInvoicesEvents();
    if (typeof attachInvoicesViewEvents === 'function') attachInvoicesViewEvents();
    if (typeof attachPurchasesEvents === 'function') attachPurchasesEvents();
    if (typeof attachExpensesBonsEvents === 'function') attachExpensesBonsEvents();
    if (typeof attachBonsRouteEvents === 'function') attachBonsRouteEvents();
    if (typeof attachDocumentsEvents === 'function') attachDocumentsEvents();
    if (typeof attachScanSignEvents === 'function') attachScanSignEvents();
    if (typeof attachAssistantIAEvents === 'function') attachAssistantIAEvents();
    if (typeof attachDashboardEvents === 'function') attachDashboardEvents();
    if (typeof attachMobileEvents === 'function') attachMobileEvents();
    if (typeof attachToolsEvents === 'function') attachToolsEvents();

    /* Modules LOT 3 (23/24) : appels avec garde-fou.
       Si les fichiers ne sont pas chargés, typeof renvoie 'undefined'
       et rien ne se passe (pas de crash). */
    if (typeof attachUsersEvents === 'function') {
      try { attachUsersEvents(); } catch (e) { console.warn('attachUsersEvents :', e); }
    }
    if (typeof attachArticlePickerEvents === 'function') {
      try { attachArticlePickerEvents(); } catch (e) { console.warn('attachArticlePickerEvents :', e); }
    }

    /* Nav + search + raccourcis globaux */
    _attachGlobalNav();
    _attachGlobalSearch();
    _attachKeyboardShortcuts();
    _attachHashNavigation();

    /* Bouton Utilisateurs (dans Outils) */
    _attachUsersButton();
  } catch (e) {
    if (typeof logError === 'function') {
      try { logError('attach', 'attachAllEvents failed', '', e.stack); } catch (e2) {}
    }
    console.warn('attachAllEvents :', e);
  }
}

/* ═══════════ SECTION 7 — INIT APP (appelé après login) ═══════════ */

function initApp() {
  if (__appBooted) {
    try { console.warn('initApp déjà appelé — ignoré'); } catch (e) {}
    return;
  }
  __appBooted = true;

  try {
    console.log('🔧 initApp — câblage des événements et premiers rendus…');

    /* 1. Câble tous les événements */
    attachAllEvents();

    /* 2. Modules à initialiser une fois les données prêtes */
    if (typeof initTools === 'function') initTools();
    if (typeof initMobile === 'function') initMobile();

    /* 3. Section de départ (hash ou dashboard) */
    var startSection = _getInitialSection();
    showSection(startSection);

    /* 4. Premier rendu de toutes les listes (même cachées) */
    refreshAllUI();

    /* 5. Masque le skeleton (au cas où 02-auth ne l'aurait pas fait) */
    _hideSkeleton();

    /* 6. Log de démarrage */
    if (typeof logAction === 'function') {
      try { logAction('app.init', 'v6.7'); } catch (e) {}
    }

    /* 7. Message d'accueil discret */
    if (typeof showToast === 'function' && currentUser) {
      try {
        showToast('Bienvenue ' + (currentUser.username || '') + ' — v6.7', 'success', 2500);
      } catch (e) {}
    }

    console.log('✅ VOLTCORE v6.7 prêt — section : ' + startSection);
  } catch (e) {
    console.error('initApp :', e);
    if (typeof logError === 'function') {
      try { logError('init', 'initApp failed', '', e.stack); } catch (e2) {}
    }
    _showSkeletonError(e && e.message ? e.message : 'Erreur d\'initialisation');
  }
}

/* ═══════════ SECTION 8 — BOOT SEQUENCE (appelé au démarrage) ═══════════ */

async function bootSequence() {
  if (__bootSequenceCalled) {
    try { console.warn('bootSequence déjà appelée — ignoré'); } catch (e) {}
    return;
  }
  __bootSequenceCalled = true;

  try {
    console.log('🚀 VOLTCORE v6.7 — démarrage…');

    /* 1. Charge les données locales */
    if (typeof loadAll === 'function') {
      try { loadAll(); } catch (e) {
        console.warn('loadAll :', e);
        if (typeof logError === 'function') {
          try { logError('boot', 'loadAll failed', '', e.stack); } catch (e2) {}
        }
      }
    }

    /* 2. Infra — handlers d'erreur + réparation IDs */
    if (typeof initInfra === 'function') {
      try { initInfra(); } catch (e) {
        console.warn('initInfra :', e);
      }
    }

    /* 3. Licence + login → initApp sera appelé après auth */
    if (typeof bootWithLicense === 'function') {
      await bootWithLicense();
    } else {
      console.error('bootWithLicense introuvable — fallback login direct');
      if (typeof checkLogin === 'function') checkLogin();
    }
  } catch (e) {
    console.error('bootSequence :', e);
    if (typeof logError === 'function') {
      try { logError('boot', 'bootSequence failed', '', e.stack); } catch (e2) {}
    }
    _showSkeletonError(e && e.message ? e.message : 'Erreur de démarrage');
  }
}

/* ═══════════ SECTION 9 — AUTO-START ═══════════ */

(function _autoStart() {
  try {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () {
        bootSequence();
      });
    } else {
      setTimeout(function () { bootSequence(); }, 0);
    }
  } catch (e) {
    console.error('autoStart :', e);
  }
})();

console.log('✅ 21-init-app.js chargé — v6.9.8 (boot + guard + documents + fix I1)');


/* ═══════════════════════════════════════════════════════════════════
   NOTE SÉCURITÉ — v6.8.1
   ═══════════════════════════════════════════════════════════════════
   Le TEST HARNESS qui existait ici (bypass licence + auto-login admin)
   a été RETIRÉ en v6.8.1 pour livrer une version production propre.

   Pour le développement, coller en console devtools (F12) — un
   snippet externe sera fourni dans le README :
       // Snippet dev à coller manuellement en console
       // (aucun code de bypass dans le fichier livré)
   ═══════════════════════════════════════════════════════════════════ */