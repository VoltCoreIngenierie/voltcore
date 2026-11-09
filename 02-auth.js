/* ═══════════════════════════════════════════════════════════════
   VOLTCORE — 02-auth.js
   VERSION : v6.7 (Session #3 — closure _umRenderList corrigée,
                   versions bumpées, messages revus)
   RÔLE : Utilisateurs, hash SHA-256 salé, biométrie WebAuthn,
          login/logout, verrouillage après 5 échecs, inactivité,
          + UI GESTION UTILISATEURS (modale, ajout, mdp, suppression)
   DÉPENDANCES : 01-core.js (users, currentUser, __inactivityTimer)
   EXPOSE : checkLogin, doLogin, doLogout, lockApp, unlockApp,
            hashPassword, verifyPassword, createUser,
            updateUserPassword, deleteUser,
            enableBiometric, disableBiometric, loginWithBiometric,
            startInactivityTimer, stopInactivityTimer,
            resetInactivityTimer, forgetRememberedUser,
            openUserManagementModal, closeUserManagementModal,
            attachUsersEvents, attachUserManagementEvents
   SECTIONS :
     1 : CONSTANTES
     2 : HACHAGE SHA-256 SALÉ
     3 : GESTION DES UTILISATEURS (logique)
     4 : LOGIN / LOGOUT / VERROUILLAGE
     5 : BIOMÉTRIE WEBAUTHN
     6 : INACTIVITÉ
     7 : SE SOUVENIR DE MOI
     8 : UI GESTION UTILISATEURS (modale + CRUD + stats)
     9 : LOGS
   ═══════════════════════════════════════════════════════════════ */

/* ═══════════ SECTION 1 — CONSTANTES ═══════════ */

var VOLTCORE_AUTH_MAX_ATTEMPTS = 5;
var VOLTCORE_AUTH_LOCK_MS = 5 * 60 * 1000;
var VOLTCORE_AUTH_STORAGE_KEY = 'voltcore_users_v2';
var VOLTCORE_AUTH_ATTEMPTS_KEY = 'voltcore_login_attempts';
var VOLTCORE_AUTH_REMEMBER_KEY = 'voltcore_remembered_user';
var VOLTCORE_AUTH_BIO_ENABLED_KEY = 'voltcore_biometric_enabled';
var VOLTCORE_AUTH_BIO_CRED_KEY = 'voltcore_biometric_credential_id';

var __authBusy = false;
var __inactivityListenersAttached = false;

/* ═══════════ SECTION 2 — HACHAGE SHA-256 SALÉ ═══════════ */

function _bytesToB64(buffer) {
  var bytes = new Uint8Array(buffer);
  var binary = '';
  for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function _b64ToBytes(b64) {
  var binary = atob(b64);
  var bytes = new Uint8Array(binary.length);
  for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function hashPassword(password) {
  if (!window.crypto || !window.crypto.subtle) {
    throw new Error('crypto.subtle indisponible');
  }
  if (typeof password !== 'string' || !password) {
    throw new Error('Mot de passe requis');
  }
  var salt = window.crypto.getRandomValues(new Uint8Array(16));
  var enc = new TextEncoder().encode(password);
  var saltAndPwd = new Uint8Array(salt.length + enc.length);
  saltAndPwd.set(salt, 0);
  saltAndPwd.set(enc, salt.length);
  var hashBuffer = await window.crypto.subtle.digest('SHA-256', saltAndPwd);
  return _bytesToB64(salt.buffer) + ':' + _bytesToB64(hashBuffer);
}

async function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string') return false;
  var parts = stored.split(':');
  if (parts.length !== 2) return false;
  try {
    var salt = _b64ToBytes(parts[0]);
    var expected = _b64ToBytes(parts[1]);
    var enc = new TextEncoder().encode(password || '');
    var saltAndPwd = new Uint8Array(salt.length + enc.length);
    saltAndPwd.set(salt, 0);
    saltAndPwd.set(enc, salt.length);
    var hashBuffer = await window.crypto.subtle.digest('SHA-256', saltAndPwd);
    var actual = new Uint8Array(hashBuffer);
    if (actual.length !== expected.length) return false;
    var diff = 0;
    for (var i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
    return diff === 0;
  } catch (e) {
    return false;
  }
}

/* ═══════════ SECTION 3 — GESTION DES UTILISATEURS (logique) ═══════════ */

function loadUsers() {
  try {
    var raw = localStorage.getItem(VOLTCORE_AUTH_STORAGE_KEY);
    if (!raw) { users = []; return; }
    var parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) { users = []; return; }
    users = parsed.filter(function (u) {
      return u && typeof u === 'object'
        && typeof u.username === 'string'
        && typeof u.passwordHash === 'string';
    });
  } catch (e) {
    console.warn('loadUsers :', e);
    users = [];
  }
}

function saveUsers() {
  try {
    localStorage.setItem(VOLTCORE_AUTH_STORAGE_KEY, JSON.stringify(users));
    return true;
  } catch (e) {
    console.warn('saveUsers :', e);
    return false;
  }
}

async function createUser(username, password, role) {
  if (!username || typeof username !== 'string') throw new Error('Nom d\'utilisateur requis');
  if (!password || typeof password !== 'string' || password.length < 4) {
    throw new Error('Mot de passe trop court (4 caractères minimum)');
  }
  username = username.trim().toLowerCase();
  if (!username) throw new Error('Nom d\'utilisateur invalide');
  if (users.some(function (u) { return u.username === username; })) {
    throw new Error('Cet utilisateur existe déjà');
  }
  var hash = await hashPassword(password);
  var user = {
    id: 'u_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
    username: username,
    passwordHash: hash,
    role: role || 'admin',
    createdAt: new Date().toISOString()
  };
  users.push(user);
  saveUsers();
  return user;
}

async function updateUserPassword(username, newPassword) {
  if (!newPassword || newPassword.length < 4) throw new Error('Mot de passe trop court');
  var user = users.find(function (u) { return u.username === username; });
  if (!user) throw new Error('Utilisateur introuvable');
  user.passwordHash = await hashPassword(newPassword);
  saveUsers();
  return true;
}

function deleteUser(username) {
  if (username === 'admin') throw new Error('Impossible de supprimer admin');
  var idx = users.findIndex(function (u) { return u.username === username; });
  if (idx < 0) throw new Error('Utilisateur introuvable');
  users.splice(idx, 1);
  saveUsers();
  return true;
}

/* ═══════════ SECTION 4 — LOGIN / LOGOUT / VERROUILLAGE ═══════════ */

function _getAttempts() {
  try {
    var raw = localStorage.getItem(VOLTCORE_AUTH_ATTEMPTS_KEY);
    if (!raw) return { count: 0, lastAttempt: 0, lockedUntil: 0 };
    var p = JSON.parse(raw);
    return {
      count: parseInt(p.count, 10) || 0,
      lastAttempt: parseInt(p.lastAttempt, 10) || 0,
      lockedUntil: parseInt(p.lockedUntil, 10) || 0
    };
  } catch (e) {
    return { count: 0, lastAttempt: 0, lockedUntil: 0 };
  }
}

function _setAttempts(obj) {
  try { localStorage.setItem(VOLTCORE_AUTH_ATTEMPTS_KEY, JSON.stringify(obj)); } catch (e) {}
}

function _clearAttempts() {
  try { localStorage.removeItem(VOLTCORE_AUTH_ATTEMPTS_KEY); } catch (e) {}
}

function _isLocked() {
  return _getAttempts().lockedUntil > Date.now();
}

function _remainingLockMinutes() {
  var a = _getAttempts();
  if (a.lockedUntil <= Date.now()) return 0;
  return Math.ceil((a.lockedUntil - Date.now()) / 60000);
}

function _recordFailedAttempt() {
  var a = _getAttempts();
  a.count = (a.count || 0) + 1;
  a.lastAttempt = Date.now();
  if (a.count >= VOLTCORE_AUTH_MAX_ATTEMPTS) {
    a.lockedUntil = Date.now() + VOLTCORE_AUTH_LOCK_MS;
    a.count = 0;
  }
  _setAttempts(a);
}

function checkLogin() {
  try {
    loadUsers();
    if (users.length === 0) {
      _bootstrapDefaultUser();
      return;
    }
    if (currentUser) {
      _showAppAfterLogin();
      return;
    }
    var loginModal = document.getElementById('loginModal');
    if (loginModal) loginModal.style.display = 'flex';
    var app = document.getElementById('appRoot');
    if (app) app.style.display = 'none';
    _prefillRememberedUser();
    _updateBiometricButton();
    var userInput = document.getElementById('loginUsername');
    if (userInput) {
      setTimeout(function () { try { userInput.focus(); } catch (e) {} }, 100);
    }
  } catch (e) {
    console.warn('checkLogin :', e);
  }
}

async function _bootstrapDefaultUser() {
  try {
    await createUser('admin', 'admin', 'admin');
    if (typeof showToast === 'function') {
      showToast('Compte par défaut créé : admin / admin. Change le mot de passe dès que possible !', 'warning', 5000);
    }
    checkLogin();
  } catch (e) {
    console.warn('_bootstrapDefaultUser :', e);
  }
}

async function doLogin() {
  if (__authBusy) return;
  if (_isLocked()) {
    var mins = _remainingLockMinutes();
    if (typeof showToast === 'function') {
      showToast('Compte verrouillé. Réessaie dans ' + mins + ' minute(s).', 'error');
    }
    return;
  }
  __authBusy = true;
  try {
    var userInput = document.getElementById('loginUsername');
    var passInput = document.getElementById('loginPassword');
    var errEl = document.getElementById('loginError');
    var username = ((userInput && userInput.value) || '').trim().toLowerCase();
    var password = (passInput && passInput.value) || '';
    if (!username || !password) {
      if (errEl) errEl.textContent = 'Renseigne ton nom d\'utilisateur et ton mot de passe.';
      return;
    }
    var user = users.find(function (u) { return u.username === username; });
    if (!user) {
      _recordFailedAttempt();
      if (errEl) errEl.textContent = 'Identifiants incorrects (' + VOLTCORE_AUTH_MAX_ATTEMPTS + ' essais max).';
      return;
    }
    var ok = await verifyPassword(password, user.passwordHash);
    if (!ok) {
      _recordFailedAttempt();
      if (errEl) errEl.textContent = 'Mot de passe incorrect.';
      return;
    }
    _clearAttempts();
    currentUser = user;
    if (errEl) errEl.textContent = '';
    _saveRememberedUser(username);
    _showAppAfterLogin();
    if (typeof showToast === 'function') showToast('Bienvenue, ' + user.username + ' !', 'success');
  } catch (e) {
    console.warn('doLogin :', e);
    var errEl2 = document.getElementById('loginError');
    if (errEl2) errEl2.textContent = 'Erreur de connexion.';
  } finally {
    __authBusy = false;
  }
}

function _showAppAfterLogin() {
  try {
    var loginModal = document.getElementById('loginModal');
    if (loginModal) loginModal.style.display = 'none';
    var lockOverlay = document.getElementById('lockOverlay');
    if (lockOverlay) lockOverlay.style.display = 'none';
    var app = document.getElementById('appRoot');
    if (app) app.style.display = '';
    var skeleton = document.getElementById('appSkeleton');
    if (skeleton) skeleton.style.display = 'none';
    if (typeof initApp === 'function' && !window.__appInitialized) {
      window.__appInitialized = true;
      initApp();
    }
    startInactivityTimer();
  } catch (e) {
    console.warn('_showAppAfterLogin :', e);
  }
}

function doLogout() {
  try {
    currentUser = null;
    stopInactivityTimer();
    var app = document.getElementById('appRoot');
    if (app) app.style.display = 'none';
    var loginModal = document.getElementById('loginModal');
    if (loginModal) loginModal.style.display = 'flex';
    var passInput = document.getElementById('loginPassword');
    if (passInput) passInput.value = '';
    var userInput = document.getElementById('loginUsername');
    if (userInput) userInput.value = '';
    if (typeof showToast === 'function') showToast('Déconnecté', 'info');
  } catch (e) {
    console.warn('doLogout :', e);
  }
}

function lockApp() {
  try {
    if (!currentUser) return;
    var lockOverlay = document.getElementById('lockOverlay');
    if (lockOverlay) {
      lockOverlay.style.display = 'flex';
      var passInput = document.getElementById('unlockPassword');
      if (passInput) { passInput.value = ''; setTimeout(function () { try { passInput.focus(); } catch (e) {} }, 100); }
      var errEl = document.getElementById('unlockError');
      if (errEl) errEl.textContent = '';
    } else {
      doLogout();
    }
  } catch (e) {
    console.warn('lockApp :', e);
  }
}

async function unlockApp() {
  try {
    var passInput = document.getElementById('unlockPassword');
    var password = (passInput && passInput.value) || '';
    var errEl = document.getElementById('unlockError');
    if (!password || !currentUser) {
      if (errEl) errEl.textContent = 'Mot de passe requis.';
      return;
    }
    var ok = await verifyPassword(password, currentUser.passwordHash);
    if (ok) {
      var lockOverlay = document.getElementById('lockOverlay');
      if (lockOverlay) lockOverlay.style.display = 'none';
      if (passInput) passInput.value = '';
      if (errEl) errEl.textContent = '';
      resetInactivityTimer();
    } else {
      if (errEl) errEl.textContent = 'Mot de passe incorrect.';
    }
  } catch (e) {
    console.warn('unlockApp :', e);
  }
}

/* ═══════════ SECTION 5 — BIOMÉTRIE WEBAUTHN ═══════════ */

function _bioSupported() {
  return !!(window.PublicKeyCredential
    && window.VoltCore
    && window.VoltCore.aBiometrie
    && window.VoltCore.estHTTPS);
}

function _bioEnabled() {
  try { return localStorage.getItem(VOLTCORE_AUTH_BIO_ENABLED_KEY) === '1'; } catch (e) { return false; }
}

function _getBioCredId() {
  try {
    var raw = localStorage.getItem(VOLTCORE_AUTH_BIO_CRED_KEY);
    if (!raw) return null;
    return _b64ToBytes(raw);
  } catch (e) { return null; }
}

function _saveBioCredId(credId) {
  try { localStorage.setItem(VOLTCORE_AUTH_BIO_CRED_KEY, _bytesToB64(credId)); } catch (e) {}
}

function _updateBiometricButton() {
  try {
    var btn = document.getElementById('biometricLoginBtn');
    if (!btn) return;
    btn.style.display = (_bioSupported() && _bioEnabled() && _getBioCredId()) ? 'inline-block' : 'none';
  } catch (e) {}
}

async function enableBiometric() {
  if (!_bioSupported()) {
    if (typeof showToast === 'function') showToast('Biométrie non disponible sur cet appareil.', 'error');
    return false;
  }
  if (!currentUser) {
    if (typeof showToast === 'function') showToast('Connecte-toi d\'abord.', 'error');
    return false;
  }
  try {
    var challenge = window.crypto.getRandomValues(new Uint8Array(32));
    var userIdBytes = new TextEncoder().encode(currentUser.username);
    var options = {
      publicKey: {
        challenge: challenge,
        rp: { name: 'VOLTCORE' },
        user: { id: userIdBytes, name: currentUser.username, displayName: currentUser.username },
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
    var cred = await navigator.credentials.create(options);
    if (!cred) throw new Error('Création annulée');
    _saveBioCredId(new Uint8Array(cred.rawId));
    localStorage.setItem(VOLTCORE_AUTH_BIO_ENABLED_KEY, '1');
    _updateBiometricButton();
    if (typeof showToast === 'function') showToast('Biométrie activée !', 'success');
    return true;
  } catch (e) {
    console.warn('enableBiometric :', e);
    if (typeof showToast === 'function') showToast('Impossible d\'activer la biométrie.', 'error');
    return false;
  }
}

function disableBiometric() {
  try {
    localStorage.removeItem(VOLTCORE_AUTH_BIO_ENABLED_KEY);
    localStorage.removeItem(VOLTCORE_AUTH_BIO_CRED_KEY);
    _updateBiometricButton();
    if (typeof showToast === 'function') showToast('Biométrie désactivée.', 'info');
    return true;
  } catch (e) {
    console.warn('disableBiometric :', e);
    return false;
  }
}

async function loginWithBiometric() {
  if (!_bioSupported() || !_bioEnabled()) return;
  var credId = _getBioCredId();
  if (!credId) return;
  try {
    var challenge = window.crypto.getRandomValues(new Uint8Array(32));
    var options = {
      publicKey: {
        challenge: challenge,
        allowCredentials: [{ type: 'public-key', id: credId, transports: ['internal'] }],
        userVerification: 'preferred',
        timeout: 60000
      }
    };
    var assertion = await navigator.credentials.get(options);
    if (!assertion) return;
    var rememberedRaw = localStorage.getItem(VOLTCORE_AUTH_REMEMBER_KEY);
    if (!rememberedRaw) return;
    var remembered = JSON.parse(rememberedRaw);
    var user = users.find(function (u) { return u.username === remembered.username; });
    if (!user) return;
    currentUser = user;
    _clearAttempts();
    _showAppAfterLogin();
    if (typeof showToast === 'function') showToast('Connecté par biométrie', 'success');
  } catch (e) {
    console.warn('loginWithBiometric :', e);
  }
}

/* ═══════════ SECTION 6 — INACTIVITÉ ═══════════ */

function startInactivityTimer() {
  if (!currentUser) return;
  if (__inactivityListenersAttached) {
    resetInactivityTimer();
    return;
  }
  __inactivityListenersAttached = true;
  try {
    window.addEventListener('click', resetInactivityTimer, { passive: true });
    window.addEventListener('touchstart', resetInactivityTimer, { passive: true });
    window.addEventListener('keydown', resetInactivityTimer, { passive: true });
    window.addEventListener('mousemove', _throttledInactivityReset, { passive: true });
  } catch (e) {}
  resetInactivityTimer();
}

function stopInactivityTimer() {
  if (window.__inactivityTimer) {
    clearTimeout(window.__inactivityTimer);
    window.__inactivityTimer = null;
  }
  __inactivityListenersAttached = false;
}

function _throttledInactivityReset() {
  var now = Date.now();
  if (now - (window.__inactivityLastReset || 0) < 30000) return;
  window.__inactivityLastReset = now;
  resetInactivityTimer();
}

function resetInactivityTimer() {
  if (!currentUser) return;
  if (window.__inactivityTimer) clearTimeout(window.__inactivityTimer);
  window.__inactivityTimer = setTimeout(function () {
    if (currentUser) lockApp();
  }, 5 * 60 * 1000);
}

/* ═══════════ SECTION 7 — SE SOUVENIR DE MOI ═══════════ */

function _saveRememberedUser(username) {
  try {
    localStorage.setItem(VOLTCORE_AUTH_REMEMBER_KEY, JSON.stringify({
      username: username,
      savedAt: new Date().toISOString()
    }));
  } catch (e) {}
}

function _prefillRememberedUser() {
  try {
    var raw = localStorage.getItem(VOLTCORE_AUTH_REMEMBER_KEY);
    if (!raw) return;
    var p = JSON.parse(raw);
    if (!p || !p.username) return;
    var userInput = document.getElementById('loginUsername');
    if (userInput && !userInput.value) userInput.value = p.username;
    var passInput = document.getElementById('loginPassword');
    if (passInput) setTimeout(function () { try { passInput.focus(); } catch (e) {} }, 100);
  } catch (e) {}
}

function forgetRememberedUser() {
  try { localStorage.removeItem(VOLTCORE_AUTH_REMEMBER_KEY); } catch (e) {}
}

/* ═══════════ SECTION 8 — UI GESTION UTILISATEURS ═══════════
   Modale créée dynamiquement à la première ouverture.
   Aucun impact sur login/logout : ces fonctions ne sont jamais
   appelées tant que l'utilisateur n'a pas cliqué sur le bouton
   "Utilisateurs" dans Outils.

   v6.7 (Session #3) :
   - Correction BUG critique closure dans _umRenderList : le clic sur
     "Mot de passe" ou "Supprimer" agissait sur le DERNIER bouton de
     la liste au lieu du bouton cliqué. Corrigé via IIFE (même pattern
     que 05-alerts.js).
   - Aucun autre bug connu sur cette section.
*/

/* Garde-fou : seul un admin peut ouvrir la modale.
   Retourne true si autorisé, false sinon (avec toast). */
function _umGuard() {
  try {
    if (!currentUser) {
      if (typeof showToast === 'function') showToast('Connecte-toi d\'abord.', 'error');
      return false;
    }
    var role = String(currentUser.role || 'admin').toLowerCase();
    if (role !== 'admin') {
      if (typeof showToast === 'function') {
        showToast('Accès réservé aux administrateurs.', 'warning', 3500);
      }
      return false;
    }
    return true;
  } catch (e) {
    return false;
  }
}

/* Crée la modale si absente. Idempotent. */
function _umEnsureModal() {
  try {
    if (document.getElementById('userManagementModal')) return;

    var modal = document.createElement('div');
    modal.id = 'userManagementModal';
    modal.className = 'modal';
    modal.style.display = 'none';
    modal.innerHTML =
      '<div class="modal-content modal-large">' +
        '<h2>👥 Gestion utilisateurs</h2>' +
        '<div id="umStats" class="um-stats" style="margin-bottom:12px;padding:10px;background:#f5f7fb;border-radius:6px;font-size:12px"></div>' +
        '<div id="umList" style="margin-bottom:16px;max-height:300px;overflow:auto"></div>' +
        '<h3 style="margin-top:16px">➕ Ajouter un utilisateur</h3>' +
        '<div class="form-grid">' +
          '<label>Nom *<input type="text" id="umNewUsername" class="input" autocomplete="off" maxlength="32"></label>' +
          '<label>Mot de passe *<input type="password" id="umNewPassword" class="input" autocomplete="new-password"></label>' +
          '<label>Confirmer *<input type="password" id="umNewPasswordConfirm" class="input" autocomplete="new-password"></label>' +
          '<label>Rôle<select id="umNewRole" class="input">' +
            '<option value="admin">🟢 Admin</option>' +
            '<option value="user" selected>🔵 Utilisateur</option>' +
            '<option value="reader">⚪ Lecteur</option>' +
          '</select></label>' +
        '</div>' +
        '<div id="umError" class="form-error"></div>' +
        '<div class="modal-actions">' +
          '<button type="button" class="btn" onclick="closeUserManagementModal()">Fermer</button>' +
          '<button type="button" class="btn btn-primary" id="umAddBtn">➕ Ajouter</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(modal);

    /* Bind bouton ajouter (une seule fois) */
    var addBtn = document.getElementById('umAddBtn');
    if (addBtn && !addBtn.__bound) {
      addBtn.__bound = true;
      addBtn.addEventListener('click', function () { _umHandleCreateUser(); });
    }
  } catch (e) { console.warn('_umEnsureModal :', e); }
}

/* Ouvre la modale. */
function openUserManagementModal() {
  try {
    if (!_umGuard()) return;
    _umEnsureModal();
    /* Recharge users pour être à jour */
    if (typeof loadUsers === 'function') loadUsers();
    _umRender();
    var modal = document.getElementById('userManagementModal');
    if (modal) modal.style.display = 'flex';
    /* Reset form */
    var u = document.getElementById('umNewUsername');
    var p = document.getElementById('umNewPassword');
    var pc = document.getElementById('umNewPasswordConfirm');
    var r = document.getElementById('umNewRole');
    var err = document.getElementById('umError');
    if (u) u.value = '';
    if (p) p.value = '';
    if (pc) pc.value = '';
    if (r) r.value = 'user';
    if (err) err.textContent = '';
    if (u) setTimeout(function () { try { u.focus(); } catch (e) {} }, 100);
  } catch (e) { console.warn('openUserManagementModal :', e); }
}

function closeUserManagementModal() {
  try {
    var modal = document.getElementById('userManagementModal');
    if (modal) modal.style.display = 'none';
  } catch (e) {}
}

/* Retourne le label d'un rôle. */
function _umRoleLabel(role) {
  var r = String(role || 'admin').toLowerCase();
  if (r === 'admin') return '🟢 Admin';
  if (r === 'user') return '🔵 Utilisateur';
  if (r === 'reader') return '⚪ Lecteur';
  return '⚪ ' + r;
}

/* Retourne la couleur d'un rôle (pour bordure/badge). */
function _umRoleColor(role) {
  var r = String(role || 'admin').toLowerCase();
  if (r === 'admin') return '#2e7d32';
  if (r === 'user') return '#0b3d91';
  if (r === 'reader') return '#888';
  return '#888';
}

/* Compte les admins dans la liste users. */
function _umCountAdmins() {
  var n = 0;
  if (!Array.isArray(users)) return 0;
  for (var i = 0; i < users.length; i++) {
    if (users[i] && String(users[i].role || '').toLowerCase() === 'admin') n++;
  }
  return n;
}

/* Affiche les stats. */
function _umRenderStats() {
  try {
    var el = document.getElementById('umStats');
    if (!el) return;
    var total = Array.isArray(users) ? users.length : 0;
    var admins = _umCountAdmins();
    var oldest = '';
    if (Array.isArray(users) && users.length > 0) {
      var dates = users.map(function (u) { return u && u.createdAt ? String(u.createdAt).slice(0, 10) : ''; })
                        .filter(function (d) { return d; }).sort();
      if (dates.length > 0) oldest = dates[0];
    }
    var html = '';
    html += '<strong>Statistiques</strong> · ';
    html += 'Utilisateurs : <strong>' + total + '</strong> · ';
    html += 'Admins : <strong>' + admins + '</strong>';
    if (oldest) {
      html += ' · Créé le : <strong>' + _umEscape(oldest) + '</strong>';
    }
    el.innerHTML = html;
  } catch (e) { console.warn('_umRenderStats :', e); }
}

/* Petits helpers fallback si escapeHtml/formatDate absents (02 chargé avant 03). */
function _umEscape(s) {
  if (typeof escapeHtml === 'function') return escapeHtml(s);
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function _umFormatDate(iso) {
  if (typeof formatDate === 'function') return formatDate(iso);
  if (!iso || typeof iso !== 'string') return '';
  var p = iso.slice(0, 10).split('-');
  return p.length === 3 ? (p[2] + '/' + p[1] + '/' + p[0]) : iso;
}

/* Affiche la liste des utilisateurs avec actions.
   v6.7 : closure corrigée via IIFE pour que chaque bouton agisse
   sur SON utilisateur, pas sur le dernier de la liste. */
function _umRenderList() {
  try {
    var el = document.getElementById('umList');
    if (!el) return;
    if (!Array.isArray(users) || users.length === 0) {
      el.innerHTML = '<div class="muted" style="padding:8px">Aucun utilisateur.</div>';
      return;
    }

    var html = '<table style="width:100%;border-collapse:collapse;font-size:13px">';
    html += '<thead><tr style="background:#f0f0f0">' +
      '<th style="padding:6px;text-align:left">Nom</th>' +
      '<th style="padding:6px;text-align:left">Rôle</th>' +
      '<th style="padding:6px;text-align:left">Créé le</th>' +
      '<th style="padding:6px;text-align:left">Actions</th>' +
      '</tr></thead><tbody>';

    var admins = _umCountAdmins();
    var currentName = currentUser ? String(currentUser.username || '') : '';

    for (var i = 0; i < users.length; i++) {
      var u = users[i];
      if (!u) continue;
      var uname = String(u.username || '');
      var role = String(u.role || 'admin').toLowerCase();
      var isCurrent = (uname === currentName);
      var isOnlyAdmin = (role === 'admin' && admins <= 1);
      var rowStyle = isCurrent ? 'background:#e3f2fd;' : '';

      html += '<tr style="border-bottom:1px solid #eee;' + rowStyle + '">';
      html += '<td style="padding:6px"><strong>' + _umEscape(uname) + '</strong>';
      if (isCurrent) html += ' <span style="color:#0b3d91;font-size:11px">(Connecté)</span>';
      html += '</td>';
      html += '<td style="padding:6px"><span style="padding:2px 8px;border-radius:4px;background:' +
        _umRoleColor(role) + ';color:#fff;font-size:11px">' + _umEscape(_umRoleLabel(role)) + '</span></td>';
      html += '<td style="padding:6px;font-size:12px">' + _umEscape(_umFormatDate(u.createdAt || '')) + '</td>';
      html += '<td style="padding:6px;white-space:nowrap">';

      /* Changer mdp */
      html += '<button type="button" class="btn btn-sm" data-um-action="pwd" data-um-name="' +
        _umEscape(uname) + '" style="margin-right:4px">🔑 Mot de passe</button>';

      /* Supprimer */
      if (uname === 'admin') {
        html += '<button type="button" class="btn btn-sm" disabled title="admin ne peut pas être supprimé" style="opacity:0.4">🗑️</button>';
      } else if (isOnlyAdmin) {
        html += '<button type="button" class="btn btn-sm" disabled title="Dernier admin — refusé" style="opacity:0.4">🗑️</button>';
      } else {
        html += '<button type="button" class="btn btn-sm btn-danger" data-um-action="del" data-um-name="' +
          _umEscape(uname) + '">🗑️</button>';
      }
      html += '</td></tr>';
    }
    html += '</tbody></table>';
    el.innerHTML = html;

    /* Bind boutons (delegation) — v6.7 IIFE pour closure correcte */
    var btns = el.querySelectorAll('[data-um-action]');
    for (var b = 0; b < btns.length; b++) {
      (function (btnRef) {
        if (btnRef.__bound) return;
        btnRef.__bound = true;
        btnRef.addEventListener('click', function (ev) {
          try { ev.preventDefault(); } catch (e) {}
          var action = btnRef.getAttribute('data-um-action');
          var name = btnRef.getAttribute('data-um-name');
          if (action === 'pwd') _umHandleChangePassword(name);
          else if (action === 'del') _umHandleDeleteUser(name);
        });
      })(btns[b]);
    }
  } catch (e) { console.warn('_umRenderList :', e); }
}

function _umRender() {
  _umRenderStats();
  _umRenderList();
}

/* Ajout d'un utilisateur. */
async function _umHandleCreateUser() {
  try {
    var errEl = document.getElementById('umError');
    if (errEl) errEl.textContent = '';

    var u = (document.getElementById('umNewUsername') || {}).value || '';
    var p = (document.getElementById('umNewPassword') || {}).value || '';
    var pc = (document.getElementById('umNewPasswordConfirm') || {}).value || '';
    var r = (document.getElementById('umNewRole') || {}).value || 'user';

    u = String(u).trim().toLowerCase();

    if (!u) { if (errEl) errEl.textContent = 'Nom requis.'; return; }
    if (!/^[a-z0-9_\-]{2,32}$/.test(u)) {
      if (errEl) errEl.textContent = 'Nom invalide (2-32 caractères : a-z, 0-9, _, -).';
      return;
    }
    if (!p || p.length < 4) {
      if (errEl) errEl.textContent = 'Mot de passe : 4 caractères minimum.';
      return;
    }
    if (p !== pc) {
      if (errEl) errEl.textContent = 'Les deux mots de passe ne correspondent pas.';
      return;
    }

    await createUser(u, p, r);

    if (typeof showToast === 'function') showToast('Utilisateur créé : ' + u, 'success', 2500);
    if (typeof logAction === 'function') {
      try { logAction('user.create', u + ' (' + r + ')'); } catch (e) {}
    }
    /* Reset form */
    var un = document.getElementById('umNewUsername');
    var up = document.getElementById('umNewPassword');
    var upc = document.getElementById('umNewPasswordConfirm');
    if (un) un.value = '';
    if (up) up.value = '';
    if (upc) upc.value = '';
    /* Refresh */
    if (typeof loadUsers === 'function') loadUsers();
    _umRender();
  } catch (e) {
    console.warn('_umHandleCreateUser :', e);
    var errEl2 = document.getElementById('umError');
    if (errEl2) errEl2.textContent = 'Erreur : ' + (e.message || 'inconnue');
  }
}

/* Changement de mot de passe. */
async function _umHandleChangePassword(username) {
  try {
    if (!username) return;
    var msg = 'Nouveau mot de passe pour "' + username + '" :\n(minimum 4 caractères)';
    var pwd = null;
    if (typeof promptDialog === 'function') {
      pwd = promptDialog(msg, '');
    } else {
      pwd = window.prompt(msg, '');
    }
    if (pwd === null) return;
    if (!pwd || pwd.length < 4) {
      if (typeof showToast === 'function') showToast('Mot de passe trop court.', 'warning');
      return;
    }
    await updateUserPassword(username, pwd);
    if (typeof showToast === 'function') showToast('Mot de passe changé : ' + username, 'success', 2500);
    if (typeof logAction === 'function') {
      try { logAction('user.password', username); } catch (e) {}
    }
  } catch (e) {
    console.warn('_umHandleChangePassword :', e);
    if (typeof showToast === 'function') showToast('Erreur : ' + (e.message || 'inconnue'), 'error');
  }
}

/* Suppression d'un utilisateur. */
async function _umHandleDeleteUser(username) {
  try {
    if (!username) return;

    /* Vérifications AVANT l'appel (03-utils.js chargé entre temps) */
    if (username === 'admin') {
      if (typeof showToast === 'function') showToast('Impossible de supprimer "admin".', 'warning');
      return;
    }

    var admins = _umCountAdmins();
    var userObj = null;
    for (var i = 0; i < users.length; i++) {
      if (users[i] && String(users[i].username) === username) { userObj = users[i]; break; }
    }
    if (userObj && String(userObj.role || '').toLowerCase() === 'admin' && admins <= 1) {
      if (typeof showToast === 'function') showToast('Impossible : dernier administrateur.', 'warning');
      return;
    }

    var msg = 'Supprimer définitivement "' + username + '" ?\n\nCette action est irréversible.';
    var ok = false;
    if (typeof confirmDialog === 'function') ok = confirmDialog(msg);
    else ok = window.confirm(msg);
    if (!ok) return;

    deleteUser(username);

    if (typeof showToast === 'function') showToast('Utilisateur supprimé : ' + username, 'success', 2500);
    if (typeof logAction === 'function') {
      try { logAction('user.delete', username); } catch (e) {}
    }
    if (typeof loadUsers === 'function') loadUsers();
    _umRender();
  } catch (e) {
    console.warn('_umHandleDeleteUser :', e);
    if (typeof showToast === 'function') showToast('Erreur : ' + (e.message || 'inconnue'), 'error');
  }
}

/* Bind générique (appelé par 21-init-app.js attachAllEvents). */
function attachUsersEvents() {
  try {
    /* Bind bouton ouvrir (dans Outils) */
    var openBtn = document.getElementById('btnOpenUserManagement');
    if (openBtn && !openBtn.__bound) {
      openBtn.__bound = true;
      openBtn.addEventListener('click', function (ev) {
        try { ev.preventDefault(); } catch (e) {}
        openUserManagementModal();
      });
    }
    /* Le formulaire ajout et les boutons ligne sont bindés à la volée
       dans _umEnsureModal et _umRenderList. */
  } catch (e) { console.warn('attachUsersEvents :', e); }
}

/* Alias (certains fichiers peuvent appeler attachUserManagementEvents). */
function attachUserManagementEvents() {
  return attachUsersEvents();
}

/* ═══════════ SECTION 9 — LOGS ═══════════ */

console.log('✅ 02-auth.js chargé — v6.7 (closure _umRenderList corrigée, versions bumpées)');