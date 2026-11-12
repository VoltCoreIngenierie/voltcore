/* ═══════════════════════════════════════════════════════════
   VOLTCORE — 05-auth.js
   VERSION : v7.0.7
   RÔLE : Utilisateurs, hash SHA-256 salé, biométrie WebAuthn,
          login/logout, verrouillage 5 min après inactivité,
          trusted device, gestion UI utilisateurs.
   DÉPENDANCES : 00-core, 01-utils, 02-store
   ORDRE : 6ᵉ fichier chargé

   RÈGLES :
   - ES5 strict (var uniquement, pas de let/const, pas de arrow)
   - Aucun catch silencieux (tout est loggué)
   - Store pour persistence des users (pas de lecture directe localStorage)
   - Listener inactivité retiré proprement (fix M3)
   - Ne JAMAIS exposer le hash en clair dans le DOM
   ═══════════════════════════════════════════════════════════ */

'use strict';

(function (global) {

  if (!global.VOLTCORE || !global.VOLTCORE.Store || !global.VOLTCORE.Utils) {
    throw new Error('[05-auth] 00-core, 01-utils, 02-store requis');
  }

  var VC = global.VOLTCORE;
  var U = VC.Utils;
  var S = VC.Store;
  var Auth = VC.Auth || {};
  VC.Auth = Auth;

  /* ═══════════════════════════════════════════════════════════
     SECTION 1 — REGISTRATION STORE
     ═══════════════════════════════════════════════════════════ */

  S.register('users', {
    type: 'array',
    saveKey: 'voltcore_users_v2',
    default: [],
    idPrefix: 'u',
    schema: {
      username: 'string|required',
      passwordHash: 'string|required',
      role: 'enum|admin,user,reader',
      createdAt: 'string'
    },
    backup: true
  });

  /* ═══════════════════════════════════════════════════════════
     SECTION 2 — ÉTAT INTERNE
     ═══════════════════════════════════════════════════════════ */

  Auth.currentUser = null;

  var __authBusy = false;
  var __inactivityTimer = null;
  var __inactivityHandlers = null;
  var __loginAttempts = { count: 0, lastAttempt: 0, lockedUntil: 0 };

  /* ═══════════════════════════════════════════════════════════
     SECTION 3 — HASH SHA-256 SALÉ
     ═══════════════════════════════════════════════════════════ */

  function _bytesToB64(buffer) {
    var bytes = new Uint8Array(buffer);
    var binary = '';
    for (var i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  function _b64ToBytes(b64) {
    var binary = atob(b64);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  Auth.hashPassword = function (password) {
    return new Promise(function (resolve, reject) {
      if (!global.crypto || !global.crypto.subtle) {
        reject(new Error('crypto.subtle indisponible (HTTPS requis)'));
        return;
      }
      if (typeof password !== 'string' || !password) {
        reject(new Error('Mot de passe requis'));
        return;
      }

      var salt = global.crypto.getRandomValues(new Uint8Array(16));
      var enc = new TextEncoder().encode(password);
      var combined = new Uint8Array(salt.length + enc.length);
      combined.set(salt, 0);
      combined.set(enc, salt.length);

      global.crypto.subtle.digest('SHA-256', combined).then(function (hashBuffer) {
        var hashB64 = _bytesToB64(hashBuffer);
        var saltB64 = _bytesToB64(salt.buffer);
        resolve(saltB64 + ':' + hashB64);
      }).catch(function (e) {
        VC.logError('05-auth', 'hashPassword digest échoué', e);
        reject(e);
      });
    });
  };

  Auth.verifyPassword = function (password, stored) {
    return new Promise(function (resolve) {
      if (!stored || typeof stored !== 'string') {
        resolve(false);
        return;
      }

      var parts = stored.split(':');
      if (parts.length !== 2) {
        resolve(false);
        return;
      }

      try {
        var salt = _b64ToBytes(parts[0]);
        var expected = _b64ToBytes(parts[1]);
        var enc = new TextEncoder().encode(password || '');
        var combined = new Uint8Array(salt.length + enc.length);
        combined.set(salt, 0);
        combined.set(enc, salt.length);

        global.crypto.subtle.digest('SHA-256', combined).then(function (hashBuffer) {
          var actual = new Uint8Array(hashBuffer);
          if (actual.length !== expected.length) {
            resolve(false);
            return;
          }
          var diff = 0;
          for (var i = 0; i < actual.length; i++) {
            diff |= actual[i] ^ expected[i];
          }
          resolve(diff === 0);
        }).catch(function (e) {
          VC.logError('05-auth', 'verifyPassword digest échoué', e);
          resolve(false);
        });
      } catch (e) {
        VC.logError('05-auth', 'verifyPassword parse échoué', e);
        resolve(false);
      }
    });
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 4 — USERS CRUD
     ═══════════════════════════════════════════════════════════ */

  Auth.getUsers = function () {
    return S.getAll('users');
  };

  Auth.getUser = function (username) {
    if (!username) return null;
    var uname = String(username).toLowerCase().trim();
    var users = S.getAll('users');
    for (var i = 0; i < users.length; i++) {
      if (users[i] && String(users[i].username).toLowerCase() === uname) {
        return users[i];
      }
    }
    return null;
  };

  Auth.createUser = function (username, password, role) {
    return new Promise(function (resolve, reject) {
      if (!username || typeof username !== 'string') {
        reject(new Error('Nom d\'utilisateur requis'));
        return;
      }
      var uname = username.toLowerCase().trim();
      if (!/^[a-z0-9_\-]{2,32}$/.test(uname)) {
        reject(new Error('Nom invalide (2-32 caractères : a-z, 0-9, _, -)'));
        return;
      }
      if (!password || password.length < 4) {
        reject(new Error('Mot de passe trop court (4 caractères min)'));
        return;
      }
      if (Auth.getUser(uname)) {
        reject(new Error('Cet utilisateur existe déjà'));
        return;
      }

      Auth.hashPassword(password).then(function (hash) {
        var user = S.save('users', {
          username: uname,
          passwordHash: hash,
          role: role || 'admin',
          createdAt: new Date().toISOString()
        });
        if (!user) {
          reject(new Error('Sauvegarde utilisateur échouée'));
          return;
        }
        resolve(user);
      }).catch(reject);
    });
  };

  Auth.updateUserPassword = function (username, newPassword) {
    return new Promise(function (resolve, reject) {
      if (!newPassword || newPassword.length < 4) {
        reject(new Error('Mot de passe trop court'));
        return;
      }
      var user = Auth.getUser(username);
      if (!user) {
        reject(new Error('Utilisateur introuvable'));
        return;
      }

      Auth.hashPassword(newPassword).then(function (hash) {
        user.passwordHash = hash;
        var saved = S.save('users', user);
        if (!saved) {
          reject(new Error('Sauvegarde échouée'));
          return;
        }
        resolve(true);
      }).catch(reject);
    });
  };

  Auth.deleteUser = function (username) {
    var uname = String(username || '').toLowerCase().trim();
    if (uname === 'admin') {
      throw new Error('Impossible de supprimer admin');
    }
    var user = Auth.getUser(uname);
    if (!user) {
      throw new Error('Utilisateur introuvable');
    }

    /* Vérifie ce n'est pas le dernier admin */
    var users = S.getAll('users');
    var admins = 0;
    for (var i = 0; i < users.length; i++) {
      if (users[i] && String(users[i].role).toLowerCase() === 'admin') admins++;
    }
    if (String(user.role).toLowerCase() === 'admin' && admins <= 1) {
      throw new Error('Impossible : dernier administrateur');
    }

    return S.delete('users', user.id);
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 5 — LOGIN / LOGOUT / LOCK
     ═══════════════════════════════════════════════════════════ */

  function _getAttempts() {
    return __loginAttempts;
  }

  function _isLocked() {
    return __loginAttempts.lockedUntil > Date.now();
  }

  function _remainingLockMinutes() {
    if (__loginAttempts.lockedUntil <= Date.now()) return 0;
    return Math.ceil((__loginAttempts.lockedUntil - Date.now()) / 60000);
  }

  function _recordFailedAttempt() {
    __loginAttempts.count++;
    __loginAttempts.lastAttempt = Date.now();
    if (__loginAttempts.count >= VC.AUTH_MAX_ATTEMPTS) {
      __loginAttempts.lockedUntil = Date.now() + VC.AUTH_LOCK_MS;
      __loginAttempts.count = 0;
    }
  }

  function _clearAttempts() {
    __loginAttempts = { count: 0, lastAttempt: 0, lockedUntil: 0 };
  }

  /**
   * Appelé par 30-boot.js après vérification de licence (ou bypass trusted device).
   * Charge les users, bootstrap admin si base vide, affiche login si nécessaire.
   */
  Auth.checkLogin = function () {
    var users = S.getAll('users');

    if (users.length === 0) {
      Auth._bootstrapDefaultUser();
      return;
    }

    /* Trusted device : auto-login */
    if (Auth._isTrustedDevice()) {
      var remembered = Auth._getRememberedUser();
      if (remembered) {
        var u = Auth.getUser(remembered);
        if (u) {
          Auth.currentUser = u;
          Auth._showAppAfterLogin();
          return;
        }
      }
    }

    /* Pas encore connecté : affiche login */
    U.showFlex('loginModal');
    U.hide('appRoot');
    Auth._prefillRememberedUser();
    Auth._updateBiometricButton();
    setTimeout(function () {
      try {
        var el = document.getElementById('loginUsername');
        if (el) el.focus();
      } catch (e) {
        VC.logError('05-auth', 'checkLogin focus échoué', e);
      }
    }, 100);
  };

  Auth._bootstrapDefaultUser = function () {
    Auth.createUser('admin', 'admin', 'admin').then(function () {
      U.toast('Compte par défaut : admin / admin — Change le mot de passe !', 'warning', 6000);
      Auth.checkLogin();
    }).catch(function (e) {
      VC.logError('05-auth', 'bootstrap admin échoué', e);
      U.toast('Erreur création compte admin : ' + e.message, 'error', 5000);
    });
  };

  Auth.login = function () {
    if (__authBusy) return;
    if (_isLocked()) {
      U.toast('Compte verrouillé. Réessaie dans ' + _remainingLockMinutes() + ' min.', 'error');
      return;
    }

    __authBusy = true;

    var username = (U.getVal('loginUsername') || '').toLowerCase().trim();
    var password = U.getVal('loginPassword') || '';
    var errEl = document.getElementById('loginError');

    if (!username || !password) {
      if (errEl) errEl.textContent = 'Renseigne identifiant et mot de passe.';
      __authBusy = false;
      return;
    }

    var user = Auth.getUser(username);
    if (!user) {
      _recordFailedAttempt();
      if (errEl) errEl.textContent = 'Identifiants incorrects.';
      __authBusy = false;
      return;
    }

    Auth.verifyPassword(password, user.passwordHash).then(function (ok) {
      __authBusy = false;
      if (!ok) {
        _recordFailedAttempt();
        if (errEl) errEl.textContent = 'Mot de passe incorrect.';
        return;
      }

      _clearAttempts();
      Auth.currentUser = user;
      if (errEl) errEl.textContent = '';
      Auth._saveRememberedUser(username);
      Auth._showAppAfterLogin();
      U.toast('Bienvenue ' + user.username + ' !', 'success');
    }).catch(function (e) {
      __authBusy = false;
      VC.logError('05-auth', 'login verify échoué', e);
      if (errEl) errEl.textContent = 'Erreur de connexion.';
    });
  };

  Auth._showAppAfterLogin = function () {
    U.hide('loginModal');
    U.hide('lockOverlay');
    U.hide('appSkeleton');
    U.show('appRoot');

    /* Init app une seule fois */
    if (!VC._appInitialized && typeof VC.initApp === 'function') {
      VC._appInitialized = true;
      VC.initApp();
    }

    Auth.startInactivityTimer();
  };

  Auth.logout = function () {
    Auth.currentUser = null;
    Auth.stopInactivityTimer();

    /* Révocation trusted device (sécurité) */
    Auth._clearTrustedDevice();
    /* FIX R3 : révoquer aussi l'utilisateur mémorisé pour empêcher
       l'auto-login biométrique après un logout explicite. */
    Auth.forgetRememberedUser();

    U.hide('appRoot');
    U.showFlex('loginModal');
    U.setVal('loginPassword', '');
    U.setVal('loginUsername', '');
    U.toast('Déconnecté', 'info');
  };

  Auth.lock = function () {
    if (!Auth.currentUser) return;
    U.showFlex('lockOverlay');
    U.setVal('unlockPassword', '');
    var err = document.getElementById('unlockError');
    if (err) err.textContent = '';
    setTimeout(function () {
      try {
        var el = document.getElementById('unlockPassword');
        if (el) el.focus();
      } catch (e) {
        VC.logError('05-auth', 'lock focus échoué', e);
      }
    }, 100);
  };

  Auth.unlock = function () {
    var password = U.getVal('unlockPassword') || '';
    var errEl = document.getElementById('unlockError');

    if (!password || !Auth.currentUser) {
      if (errEl) errEl.textContent = 'Mot de passe requis.';
      return;
    }

    Auth.verifyPassword(password, Auth.currentUser.passwordHash).then(function (ok) {
      if (!ok) {
        if (errEl) errEl.textContent = 'Mot de passe incorrect.';
        return;
      }
      U.hide('lockOverlay');
      U.setVal('unlockPassword', '');
      if (errEl) errEl.textContent = '';
      Auth.resetInactivityTimer();
    }).catch(function (e) {
      VC.logError('05-auth', 'unlock verify échoué', e);
      if (errEl) errEl.textContent = 'Erreur.';
    });
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 6 — INACTIVITÉ (FIX M3 : listeners propres)
     ═══════════════════════════════════════════════════════════ */

  Auth.startInactivityTimer = function () {
    if (!Auth.currentUser) return;

    /* Si déjà démarré : juste reset */
    if (__inactivityHandlers) {
      Auth.resetInactivityTimer();
      return;
    }

    /* Créer handlers UNE FOIS (référence stable pour removal) */
    __inactivityHandlers = {
      click: function () { Auth._throttledReset(); },
      touchstart: function () { Auth._throttledReset(); },
      keydown: function () { Auth._throttledReset(); },
      mousemove: function () { Auth._throttledReset(); }
    };

    try {
      global.addEventListener('click', __inactivityHandlers.click, { passive: true });
      global.addEventListener('touchstart', __inactivityHandlers.touchstart, { passive: true });
      global.addEventListener('keydown', __inactivityHandlers.keydown, { passive: true });
      global.addEventListener('mousemove', __inactivityHandlers.mousemove, { passive: true });
    } catch (e) {
      VC.logError('05-auth', 'startInactivityTimer: bind échoué', e);
    }

    Auth.resetInactivityTimer();
  };

  Auth.stopInactivityTimer = function () {
    /* FIX M3 : retire les listeners proprement */
    if (__inactivityHandlers) {
      try {
        global.removeEventListener('click', __inactivityHandlers.click);
        global.removeEventListener('touchstart', __inactivityHandlers.touchstart);
        global.removeEventListener('keydown', __inactivityHandlers.keydown);
        global.removeEventListener('mousemove', __inactivityHandlers.mousemove);
      } catch (e) {
        VC.logError('05-auth', 'stopInactivityTimer: remove échoué', e);
      }
      __inactivityHandlers = null;
    }

    if (__inactivityTimer) {
      clearTimeout(__inactivityTimer);
      __inactivityTimer = null;
    }
  };

  var __lastResetAt = 0;
  Auth._throttledReset = function () {
    var now = Date.now();
    if (now - __lastResetAt < 30000) return;
    __lastResetAt = now;
    Auth.resetInactivityTimer();
  };

  Auth.resetInactivityTimer = function () {
    if (!Auth.currentUser) return;
    if (__inactivityTimer) clearTimeout(__inactivityTimer);
    __inactivityTimer = setTimeout(function () {
      __inactivityTimer = null;
      if (Auth.currentUser) Auth.lock();
    }, VC.INACTIVITY_DELAY);
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 7 — REMEMBER ME
     ═══════════════════════════════════════════════════════════ */

  var REMEMBER_KEY = 'voltcore_remembered_user';

  Auth._saveRememberedUser = function (username) {
    try {
      localStorage.setItem(REMEMBER_KEY, JSON.stringify({
        username: username,
        savedAt: new Date().toISOString()
      }));
    } catch (e) {
      VC.logError('05-auth', 'saveRememberedUser échoué', e);
    }
  };

  Auth._getRememberedUser = function () {
    try {
      var raw = localStorage.getItem(REMEMBER_KEY);
      if (!raw) return null;
      var p = JSON.parse(raw);
      return p && p.username ? String(p.username) : null;
    } catch (e) {
      VC.logError('05-auth', 'getRememberedUser échoué', e);
      return null;
    }
  };

  Auth._prefillRememberedUser = function () {
    var username = Auth._getRememberedUser();
    if (!username) return;
    U.setVal('loginUsername', username);
    setTimeout(function () {
      try {
        var el = document.getElementById('loginPassword');
        if (el) el.focus();
      } catch (e) {
        VC.logError('05-auth', 'prefillRememberedUser focus échoué', e);
      }
    }, 100);
  };

  Auth.forgetRememberedUser = function () {
    try {
      localStorage.removeItem(REMEMBER_KEY);
    } catch (e) {
      VC.logError('05-auth', 'forgetRememberedUser échoué', e);
    }
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 8 — TRUSTED DEVICE
     ═══════════════════════════════════════════════════════════ */

  var TRUSTED_KEY = 'voltcore_trusted_device';

  Auth._isTrustedDevice = function () {
    try {
      return localStorage.getItem(TRUSTED_KEY) === '1';
    } catch (e) {
      VC.logError('05-auth', 'isTrustedDevice échoué', e);
      return false;
    }
  };

  Auth.setTrustedDevice = function (enabled) {
    try {
      if (enabled) {
        localStorage.setItem(TRUSTED_KEY, '1');
      } else {
        localStorage.removeItem(TRUSTED_KEY);
      }
      return true;
    } catch (e) {
      VC.logError('05-auth', 'setTrustedDevice échoué', e);
      return false;
    }
  };

  Auth._clearTrustedDevice = function () {
    try {
      localStorage.removeItem(TRUSTED_KEY);
    } catch (e) {
      VC.logError('05-auth', 'clearTrustedDevice échoué', e);
    }
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 9 — BIOMÉTRIE
     ═══════════════════════════════════════════════════════════ */

  var BIO_ENABLED_KEY = 'voltcore_biometric_enabled';
  var BIO_CRED_KEY = 'voltcore_biometric_credential_id';

  function _bioSupported() {
    try {
      return !!(global.PublicKeyCredential && VC.device.biometric && VC.device.https);
    } catch (e) {
      VC.logError('05-auth', 'bioSupported échoué', e);
      return false;
    }
  }

  function _bioEnabled() {
    try {
      return localStorage.getItem(BIO_ENABLED_KEY) === '1';
    } catch (e) {
      VC.logError('05-auth', 'bioEnabled échoué', e);
      return false;
    }
  }

  function _getBioCredId() {
    try {
      var raw = localStorage.getItem(BIO_CRED_KEY);
      return raw ? _b64ToBytes(raw) : null;
    } catch (e) {
      VC.logError('05-auth', 'getBioCredId échoué', e);
      return null;
    }
  }

  Auth._updateBiometricButton = function () {
    try {
      var btn = document.getElementById('biometricLoginBtn');
      if (!btn) return;
      var ok = _bioSupported() && _bioEnabled() && _getBioCredId();
      btn.style.display = ok ? 'inline-block' : 'none';
    } catch (e) {
      VC.logError('05-auth', 'updateBiometricButton échoué', e);
    }
  };

  Auth.enableBiometric = function () {
    if (!_bioSupported()) {
      U.toast('Biométrie non disponible.', 'error');
      return Promise.resolve(false);
    }
    if (!Auth.currentUser) {
      U.toast('Connecte-toi d\'abord.', 'error');
      return Promise.resolve(false);
    }

    return new Promise(function (resolve) {
      var challenge = global.crypto.getRandomValues(new Uint8Array(32));
      var userIdBytes = new TextEncoder().encode(Auth.currentUser.username);

      var options = {
        publicKey: {
          challenge: challenge,
          rp: { name: 'VOLTCORE' },
          user: {
            id: userIdBytes,
            name: Auth.currentUser.username,
            displayName: Auth.currentUser.username
          },
          pubKeyCredParams: [
            { type: 'public-key', alg: -7 },
            { type: 'public-key', alg: -257 }
          ],
          authenticatorSelection: {
            authenticatorAttachment: 'platform',
            userVerification: 'preferred'
          },
          timeout: 60000,
          attestation: 'none'
        }
      };

      navigator.credentials.create(options).then(function (cred) {
        if (!cred) {
          resolve(false);
          return;
        }
        try {
          localStorage.setItem(BIO_CRED_KEY, _bytesToB64(new Uint8Array(cred.rawId)));
          localStorage.setItem(BIO_ENABLED_KEY, '1');
          Auth._updateBiometricButton();
          U.toast('Biométrie activée', 'success');
          resolve(true);
        } catch (e) {
          VC.logError('05-auth', 'enableBiometric save échoué', e);
          resolve(false);
        }
      }).catch(function (e) {
        VC.logError('05-auth', 'enableBiometric create échoué', e);
        U.toast('Impossible d\'activer la biométrie.', 'error');
        resolve(false);
      });
    });
  };

  Auth.disableBiometric = function () {
    try {
      localStorage.removeItem(BIO_ENABLED_KEY);
      localStorage.removeItem(BIO_CRED_KEY);
      Auth._updateBiometricButton();
      U.toast('Biométrie désactivée', 'info');
      return true;
    } catch (e) {
      VC.logError('05-auth', 'disableBiometric échoué', e);
      return false;
    }
  };

  Auth.loginWithBiometric = function () {
    if (!_bioSupported() || !_bioEnabled()) return;
    var credId = _getBioCredId();
    if (!credId) return;

    var challenge = global.crypto.getRandomValues(new Uint8Array(32));
    var options = {
      publicKey: {
        challenge: challenge,
        allowCredentials: [{ type: 'public-key', id: credId, transports: ['internal'] }],
        userVerification: 'preferred',
        timeout: 60000
      }
    };

    navigator.credentials.get(options).then(function (assertion) {
      if (!assertion) return;

      var remembered = Auth._getRememberedUser();
      if (!remembered) {
        U.toast('Aucun utilisateur mémorisé.', 'warning');
        return;
      }
      var user = Auth.getUser(remembered);
      if (!user) {
        U.toast('Utilisateur introuvable.', 'error');
        return;
      }
      Auth.currentUser = user;
      _clearAttempts();
      Auth._showAppAfterLogin();
      U.toast('Connecté par biométrie', 'success');
    }).catch(function (e) {
      VC.logError('05-auth', 'loginWithBiometric échoué', e);
    });
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 10 — UI GESTION UTILISATEURS
     ═══════════════════════════════════════════════════════════ */

  function _umGuard() {
    if (!Auth.currentUser) {
      U.toast('Connecte-toi d\'abord.', 'error');
      return false;
    }
    var role = String(Auth.currentUser.role || 'admin').toLowerCase();
    if (role !== 'admin') {
      U.toast('Accès réservé aux administrateurs.', 'warning');
      return false;
    }
    return true;
  }

  function _umEnsureModal() {
    if (document.getElementById('userManagementModal')) return;

    var modal = document.createElement('div');
    modal.id = 'userManagementModal';
    modal.className = 'modal';
    modal.style.display = 'none';
    modal.innerHTML =
      '<div class="modal-content modal-large">' +
        '<h2>👥 Gestion utilisateurs</h2>' +
        '<div id="umStats" style="margin-bottom:12px;padding:10px;background:#f5f7fb;border-radius:6px;font-size:12px"></div>' +
        '<div id="umList" style="margin-bottom:16px;max-height:300px;overflow:auto"></div>' +
        '<h3 style="margin-top:16px">➕ Ajouter un utilisateur</h3>' +
        '<div class="form-grid">' +
          '<label>Nom *<input type="text" id="umNewUsername" class="input" maxlength="32"></label>' +
          '<label>Mot de passe *<input type="password" id="umNewPassword" class="input"></label>' +
          '<label>Confirmer *<input type="password" id="umNewPasswordConfirm" class="input"></label>' +
          '<label>Rôle<select id="umNewRole" class="input">' +
            '<option value="admin">🟢 Admin</option>' +
            '<option value="user" selected>🔵 Utilisateur</option>' +
            '<option value="reader">⚪ Lecteur</option>' +
          '</select></label>' +
        '</div>' +
        '<div id="umError" class="form-error"></div>' +
        '<div class="modal-actions">' +
          '<button type="button" class="btn" onclick="VC.Auth.closeUserModal()">Fermer</button>' +
          '<button type="button" class="btn btn-primary" id="umAddBtn">➕ Ajouter</button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(modal);

    var addBtn = document.getElementById('umAddBtn');
    if (addBtn) {
      addBtn.addEventListener('click', Auth._umHandleCreate);
    }
  }

  Auth.openUserModal = function () {
    if (!_umGuard()) return;
    _umEnsureModal();
    _umRender();
    U.showFlex('userManagementModal');
    U.setVal('umNewUsername', '');
    U.setVal('umNewPassword', '');
    U.setVal('umNewPasswordConfirm', '');
    U.setVal('umNewRole', 'user');
    U.setText('umError', '');
  };

  Auth.closeUserModal = function () {
    U.hide('userManagementModal');
  };

  function _umRoleLabel(role) {
    var r = String(role || 'user').toLowerCase();
    if (r === 'admin') return '🟢 Admin';
    if (r === 'user') return '🔵 Utilisateur';
    if (r === 'reader') return '⚪ Lecteur';
    return r;
  }

  function _umRoleColor(role) {
    var r = String(role || 'user').toLowerCase();
    if (r === 'admin') return '#2e7d32';
    if (r === 'user') return '#0b3d91';
    return '#888';
  }

  function _umRender() {
    var users = S.getAll('users');
    var admins = 0;
    for (var i = 0; i < users.length; i++) {
      if (users[i] && String(users[i].role).toLowerCase() === 'admin') admins++;
    }

    var statsEl = document.getElementById('umStats');
    if (statsEl) {
      statsEl.innerHTML = '<strong>Statistiques</strong> · Utilisateurs : <strong>' +
        users.length + '</strong> · Admins : <strong>' + admins + '</strong>';
    }

    var listEl = document.getElementById('umList');
    if (!listEl) return;

    if (users.length === 0) {
      listEl.innerHTML = '<div class="muted" style="padding:8px">Aucun utilisateur.</div>';
      return;
    }

    var current = Auth.currentUser ? String(Auth.currentUser.username) : '';
    var html = '<table style="width:100%;border-collapse:collapse;font-size:13px">';
    html += '<thead><tr style="background:#f0f0f0">' +
      '<th style="padding:6px;text-align:left">Nom</th>' +
      '<th style="padding:6px;text-align:left">Rôle</th>' +
      '<th style="padding:6px;text-align:left">Créé le</th>' +
      '<th style="padding:6px;text-align:left">Actions</th>' +
      '</tr></thead><tbody>';

    for (var j = 0; j < users.length; j++) {
      var u = users[j];
      var uname = String(u.username || '');
      var role = String(u.role || 'user').toLowerCase();
      var isCurrent = (uname === current);
      var isOnlyAdmin = (role === 'admin' && admins <= 1);
      var rowStyle = isCurrent ? 'background:#e3f2fd;' : '';

      html += '<tr style="border-bottom:1px solid #eee;' + rowStyle + '">';
      html += '<td style="padding:6px"><strong>' + U.escapeHtml(uname) + '</strong>';
      if (isCurrent) html += ' <span style="color:#0b3d91;font-size:11px">(Connecté)</span>';
      html += '</td>';
      html += '<td style="padding:6px"><span style="padding:2px 8px;border-radius:4px;background:' +
        _umRoleColor(role) + ';color:#fff;font-size:11px">' + U.escapeHtml(_umRoleLabel(role)) + '</span></td>';
      html += '<td style="padding:6px;font-size:12px">' +
        U.escapeHtml(String(u.createdAt || '').slice(0, 10)) + '</td>';
      html += '<td style="padding:6px;white-space:nowrap">';
      html += '<button type="button" class="btn btn-sm" data-um-action="pwd" data-um-name="' +
        U.escapeAttr(uname) + '" style="margin-right:4px">🔑</button>';

      if (uname === 'admin' || isOnlyAdmin) {
        html += '<button type="button" class="btn btn-sm" disabled style="opacity:0.4">🗑️</button>';
      } else {
        html += '<button type="button" class="btn btn-sm btn-danger" data-um-action="del" data-um-name="' +
          U.escapeAttr(uname) + '">🗑️</button>';
      }
      html += '</td></tr>';
    }
    html += '</tbody></table>';
    listEl.innerHTML = html;

    var btns = listEl.querySelectorAll('[data-um-action]');
    for (var b = 0; b < btns.length; b++) {
      (function (btn) {
        btn.addEventListener('click', function (ev) {
          try { ev.preventDefault(); } catch (e) {
            VC.logError('05-auth', 'um button preventDefault échoué', e);
          }
          var action = btn.getAttribute('data-um-action');
          var name = btn.getAttribute('data-um-name');
          if (action === 'pwd') Auth._umHandleChangePassword(name);
          else if (action === 'del') Auth._umHandleDelete(name);
        });
      })(btns[b]);
    }
  }

  Auth._umHandleCreate = function () {
    U.setText('umError', '');
    var u = (U.getVal('umNewUsername') || '').trim();
    var p = U.getVal('umNewPassword') || '';
    var pc = U.getVal('umNewPasswordConfirm') || '';
    var r = U.getVal('umNewRole') || 'user';

    if (!u) { U.setText('umError', 'Nom requis.'); return; }
    if (!p || p.length < 4) { U.setText('umError', 'Mot de passe 4 caractères min.'); return; }
    if (p !== pc) { U.setText('umError', 'Les mots de passe ne correspondent pas.'); return; }

    Auth.createUser(u, p, r).then(function () {
      U.toast('Utilisateur créé : ' + u, 'success');
      U.setVal('umNewUsername', '');
      U.setVal('umNewPassword', '');
      U.setVal('umNewPasswordConfirm', '');
      _umRender();
    }).catch(function (e) {
      U.setText('umError', e.message);
    });
  };

  Auth._umHandleChangePassword = function (username) {
    var pwd = U.prompt('Nouveau mot de passe pour "' + username + '" :\n(min 4 caractères)', '');
    if (pwd === null) return;
    if (!pwd || pwd.length < 4) {
      U.toast('Mot de passe trop court.', 'warning');
      return;
    }
    Auth.updateUserPassword(username, pwd).then(function () {
      U.toast('Mot de passe changé : ' + username, 'success');
    }).catch(function (e) {
      U.toast('Erreur : ' + e.message, 'error');
    });
  };

  Auth._umHandleDelete = function (username) {
    if (username === 'admin') {
      U.toast('Impossible de supprimer admin.', 'warning');
      return;
    }
    if (!U.confirm('Supprimer définitivement "' + username + '" ?')) return;

    try {
      Auth.deleteUser(username);
      U.toast('Utilisateur supprimé : ' + username, 'success');
      _umRender();
    } catch (e) {
      U.toast('Erreur : ' + e.message, 'error');
    }
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 11 — ATTACH EVENTS
     ═══════════════════════════════════════════════════════════ */

  Auth.attachEvents = function () {
    U.on('biometricLoginBtn', 'click', function () {
      Auth.loginWithBiometric();
    });

    /* Login form : entrée pour valider */
    try {
      var passInput = document.getElementById('loginPassword');
      if (passInput) {
        passInput.addEventListener('keydown', function (ev) {
          if (ev.key === 'Enter') {
            ev.preventDefault();
            Auth.login();
          }
        });
      }
      var unlockInput = document.getElementById('unlockPassword');
      if (unlockInput) {
        unlockInput.addEventListener('keydown', function (ev) {
          if (ev.key === 'Enter') {
            ev.preventDefault();
            Auth.unlock();
          }
        });
      }
    } catch (e) {
      VC.logError('05-auth', 'attachEvents keydown échoué', e);
    }

    /* Bouton gestion utilisateurs (dans Outils) */
    U.on('btnOpenUserManagement', 'click', function (ev) {
      try { ev.preventDefault(); } catch (e) {
        VC.logError('05-auth', 'btnOpenUserManagement preventDefault échoué', e);
      }
      Auth.openUserModal();
    });
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 12 — MARQUEUR
     ═══════════════════════════════════════════════════════════ */

  VC._authLoaded = true;

  VC.logInfo('05-auth', 'Module chargé', {
    bioSupported: _bioSupported(),
    trustedDevice: Auth._isTrustedDevice()
  });

})(window);