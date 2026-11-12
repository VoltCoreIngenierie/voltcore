/* ═══════════════════════════════════════════════════════════
   VOLTCORE — 30-boot.js
   VERSION : v7.0.0
   RÔLE : Séquence de démarrage complète.
          1. Store.loadAll() — charge toutes les collections
          2. Migrate.upgradeIfNeeded() — migrations cross-refs
          3. IDB.cleanOrphans() — cleanup blobs orphelins (C3)
          4. Infra.init() — handlers + autosave + IDs
          5. Licence (trusted device bypass)
          6. Login (auto si trusted)
          7. initApp() — wiring + premier rendu
   DÉPENDANCES : 00 → 29
   ORDRE : 31ᵉ fichier chargé (dernier)

   FIX v7.0.0 :
   - Chaque étape isolée : échec d'une étape n'empêche pas les suivantes
   - Erreur affichée clairement dans le skeleton
   - Trusted device bypasse licence ET login (cohérent)
   - Double appel protégé (__bootCalled)
   - Cleanup IDB non bloquant (promesse non attendue)

   RÈGLES :
   - ES5 strict
   - Aucun catch silencieux
   - Ne JAMAIS bloquer le démarrage sur un échec non critique
   ═══════════════════════════════════════════════════════════ */

'use strict';

(function (global) {

  if (!global.VOLTCORE || !global.VOLTCORE.Store || !global.VOLTCORE.Utils) {
    throw new Error('[30-boot] Modules requis non chargés');
  }

  var VC = global.VOLTCORE;
  var U = VC.Utils;
  var S = VC.Store;
  var IDB = VC.IDB;
  var Boot = VC.Boot || {};
  VC.Boot = Boot;

  /* ═══════════════════════════════════════════════════════════
     SECTION 1 — ÉTAT INTERNE
     ═══════════════════════════════════════════════════════════ */

  var __bootCalled = false;

  /* ═══════════════════════════════════════════════════════════
     SECTION 2 — HELPERS UI
     ═══════════════════════════════════════════════════════════ */

  function _hideSkeleton() {
    try {
      var sk = document.getElementById('appSkeleton');
      if (sk) sk.style.display = 'none';
    } catch (e) {
      VC.logError('30-boot', 'hideSkeleton échoué', e);
    }
  }

  function _showSkeletonError(msg) {
    try {
      var sk = document.getElementById('appSkeleton');
      if (!sk) return;

      var safeMsg = U.escapeHtml(String(msg || 'Erreur de démarrage'));

      sk.innerHTML =
        '<div style="padding:40px;max-width:520px;margin:0 auto;text-align:center;' +
        'font-family:Arial,sans-serif;color:#fff">' +
          '<div style="font-size:42px;margin-bottom:16px">⚠️</div>' +
          '<h2 style="color:#E70013;font-size:22px;margin-bottom:12px">' +
            'Erreur de démarrage' +
          '</h2>' +
          '<p style="font-size:14px;line-height:1.6;margin-bottom:24px;' +
          'color:rgba(255,255,255,0.85)">' +
            safeMsg +
          '</p>' +
          '<div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap">' +
            '<button onclick="location.reload()" ' +
            'style="padding:10px 24px;background:#C9A84C;color:#1A2B4C;' +
            'border:none;border-radius:6px;font-weight:700;cursor:pointer;' +
            'font-size:14px">🔄 Recharger</button>' +
            '<button onclick="if(window.VOLTCORE&&VOLTCORE.Infra)VOLTCORE.Infra.exportLog()" ' +
            'style="padding:10px 24px;background:transparent;color:#C9A84C;' +
            'border:1px solid #C9A84C;border-radius:6px;font-weight:700;' +
            'cursor:pointer;font-size:14px">📥 Exporter le journal</button>' +
          '</div>' +
          '<div style="margin-top:24px;font-size:11px;' +
          'color:rgba(255,255,255,0.5)">' +
            'VOLTCORE v' + U.escapeHtml(VC.VERSION) +
          '</div>' +
        '</div>';
      sk.style.display = 'flex';
    } catch (e) {
      VC.logError('30-boot', 'showSkeletonError échoué', e);
    }
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 3 — ÉTAPES INDIVIDUELLES
     ═══════════════════════════════════════════════════════════ */

  function _stepLoadAll() {
    try {
      var res = S.loadAll();
      VC.logInfo('30-boot', 'loadAll terminé', res);
      return true;
    } catch (e) {
      VC.logError('30-boot', 'loadAll échoué', e);
      return false;
    }
  }

  function _stepMigrate() {
    try {
      if (VC.Migrate && typeof VC.Migrate.upgradeIfNeeded === 'function') {
        var res = VC.Migrate.upgradeIfNeeded();
        VC.logInfo('30-boot', 'Migrate terminé', res);
      }
      return true;
    } catch (e) {
      VC.logError('30-boot', 'Migrate échoué', e);
      return false;
    }
  }

  function _stepInfra() {
    try {
      if (VC.Infra && typeof VC.Infra.init === 'function') {
        VC.Infra.init();
        VC.logInfo('30-boot', 'Infra initialisé');
      }
      return true;
    } catch (e) {
      VC.logError('30-boot', 'Infra.init échoué', e);
      return false;
    }
  }

  function _stepCleanOrphans() {
    /* Non bloquant : on lance en arrière-plan */
    try {
      if (IDB && IDB.blobs && typeof IDB.blobs.cleanOrphans === 'function') {
        IDB.blobs.cleanOrphans().then(function (res) {
          if (res && res.cleaned > 0) {
            VC.logInfo('30-boot', res.cleaned + ' blob(s) orphelin(s) nettoyé(s)');
          }
        }).catch(function (e) {
          VC.logError('30-boot', 'cleanOrphans échoué', e);
        });
      }
    } catch (e) {
      VC.logError('30-boot', 'cleanOrphans init échoué', e);
    }
    return true;
  }

  function _stepInitAutoBackup() {
    /* Non bloquant : backup auto si >24h */
    try {
      if (IDB && typeof IDB.initAutoBackup === 'function') {
        IDB.initAutoBackup();
      }
    } catch (e) {
      VC.logError('30-boot', 'initAutoBackup échoué', e);
    }
    return true;
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 4 — VÉRIFICATION LICENCE / TRUSTED DEVICE
     ═══════════════════════════════════════════════════════════ */

  function _isTrustedDevice() {
    try {
      return localStorage.getItem('voltcore_trusted_device') === '1';
    } catch (e) {
      VC.logError('30-boot', 'isTrustedDevice échoué', e);
      return false;
    }
  }

  /**
   * Bypass licence si trusted device actif.
   * Sinon, vérifie la licence stockée.
   * Retourne une Promise<boolean> : true = accès autorisé.
   */
  function _checkAccess() {
    return new Promise(function (resolve) {
      /* 1. Trusted device → bypass total */
      if (_isTrustedDevice()) {
        VC.logInfo('30-boot', 'Appareil de confiance — bypass licence');
        _hideSkeleton();
        resolve(true);
        return;
      }

      /* 2. Sinon, vérification licence standard */
      if (typeof VC.bootWithLicense !== 'function') {
        VC.logWarn('30-boot', 'bootWithLicense absent — fallback checkLogin');
        resolve(true);
        return;
      }

      try {
        Promise.resolve(VC.bootWithLicense()).then(function () {
          /* bootWithLicense gère l'affichage de la licence ou appelle checkLogin */
          resolve(true);
        }).catch(function (e) {
          VC.logError('30-boot', 'bootWithLicense échoué', e);
          resolve(true); /* On laisse bootWithLicense gérer ses propres erreurs */
        });
      } catch (e) {
        VC.logError('30-boot', 'bootWithLicense throw', e);
        resolve(true);
      }
    });
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 5 — SÉQUENCE COMPLÈTE
     ═══════════════════════════════════════════════════════════ */

  Boot.run = function () {
    if (__bootCalled) {
      VC.logWarn('30-boot', 'bootSequence déjà appelée — skip');
      return;
    }
    __bootCalled = true;

    VC.logInfo('30-boot', 'Démarrage VOLTCORE v' + VC.VERSION);

    /* ── Étape 1 : Charger les données ── */
    var loadOk = _stepLoadAll();
    if (!loadOk) {
      _showSkeletonError(
        'Impossible de charger les données locales. ' +
        'Vérifie que le stockage du navigateur n\'est pas bloqué ' +
        '(mode privé, cookies refusés).'
      );
      return;
    }

    /* ── Étape 2 : Migrer les schémas ── */
    _stepMigrate();

    /* ── Étape 3 : Infra (handlers, autosave, IDs) ── */
    _stepInfra();

    /* ── Étape 4 : Cleanup IDB (non bloquant) ── */
    _stepCleanOrphans();

    /* ── Étape 5 : Auto-backup IDB (non bloquant) ── */
    _stepInitAutoBackup();

    /* ── Étape 6 : Licence + login ── */
    _checkAccess().then(function () {
      /* Si trusted device ou licence OK → vérifier login */
      if (typeof VC.checkLogin === 'function') {
        try {
          VC.checkLogin();
        } catch (e) {
          VC.logError('30-boot', 'checkLogin échoué', e);
          _showSkeletonError(
            'Erreur d\'initialisation de la session. Recharge la page.'
          );
        }
      } else if (VC.Auth && typeof VC.Auth.checkLogin === 'function') {
        try {
          VC.Auth.checkLogin();
        } catch (e) {
          VC.logError('30-boot', 'Auth.checkLogin échoué', e);
          _showSkeletonError(
            'Erreur d\'initialisation de la session. Recharge la page.'
          );
        }
      } else {
        VC.logWarn('30-boot', 'checkLogin absent — démarrage direct');
        /* Si aucun checkLogin, on init directement */
        if (typeof VC.initApp === 'function') {
          try {
            VC.initApp();
          } catch (e) {
            VC.logError('30-boot', 'initApp échoué', e);
          }
        }
      }
    }).catch(function (e) {
      VC.logError('30-boot', '_checkAccess a throw', e);
      _showSkeletonError(
        'Erreur lors de la vérification de la licence. ' +
        'Utilise le bouton "Exporter le journal" pour signaler le problème.'
      );
    });
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 6 — AUTO-START
     ═══════════════════════════════════════════════════════════ */

  (function _autoStart() {
    try {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () {
          Boot.run();
        });
      } else {
        /* DOM déjà prêt (script chargé en fin de body) */
        setTimeout(function () {
          Boot.run();
        }, 0);
      }
    } catch (e) {
      VC.logError('30-boot', 'autoStart échoué', e);
    }
  })();

  /* ═══════════════════════════════════════════════════════════
     SECTION 7 — MARQUEUR
     ═══════════════════════════════════════════════════════════ */

  VC._bootLoaded = true;

  VC.logInfo('30-boot', 'Module chargé — boot séquence prête');

})(window);