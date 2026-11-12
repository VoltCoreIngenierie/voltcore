/* ═══════════════════════════════════════════════════════════
   VOLTCORE — 02-store.js
   VERSION : v7.0.7
   RÔLE : Registre central de toutes les collections.
          CRUD génériques, trash ouvert, saveAll/loadAll
          pilotés par registre, subscribers, blobs tracking,
          BroadcastChannel multi-onglet.
   DÉPENDANCES : 00-core.js, 01-utils.js
   ORDRE : 3ᵉ fichier chargé

   RÈGLES :
   - ES5 strict (var uniquement, pas de let/const, pas de arrow)
   - CHAQUE module enregistre ses collections via Store.register()
   - Trash = objet OUVERT, jamais de clés fixes (fix C1/C2)
   - getAllBlobRefs() scanne TOUTES les collections (fix C3)
   - saveAll() itère sur le registre, jamais sur des clés hardcodées
   - Toute erreur loggée via VC.logError (pas de catch silencieux)
   ═══════════════════════════════════════════════════════════ */

'use strict';

(function (global) {

  if (!global.VOLTCORE || !global.VOLTCORE.Utils) {
    throw new Error('[02-store] 00-core.js et 01-utils.js doivent être chargés avant');
  }

  var VC = global.VOLTCORE;
  var U = VC.Utils;
  var S = VC.Store || {};
  VC.Store = S;

  /* ═══════════════════════════════════════════════════════════
     SECTION 1 — ÉTAT INTERNE
     ═══════════════════════════════════════════════════════════ */

  var _registry = {};      /* name → spec */
  var _data = {};          /* name → array | object | string | number */
  var _trash = {};         /* name → [ {item, deletedAt, deletedBy} ] */
  var _subscribers = {};   /* name → [ callback ] */
  var _initialLoadDone = false;
  var _broadcastChannel = null;
  var _applyingRemote = false;

  /* ═══════════════════════════════════════════════════════════
     SECTION 2 — REGISTRATION
     ═══════════════════════════════════════════════════════════ */

  /**
   * Enregistre une collection.
   *
   * spec = {
   *   type: 'array' | 'object' | 'string' | 'number',
   *   saveKey: 'voltcore_xxx' (clé localStorage),
   *   default: valeur par défaut (array vide, {} , '', 0),
   *   schema: { field: 'type|options' },   // optionnel pour type object/string/number
   *   trash: true,                          // optionnel, seulement type 'array'
   *   idPrefix: 'cli',                      // optionnel, préfixe auto-id
   *   blobs: function(item) { return [ref]; }, // optionnel, refs IDB
   *   backup: true,                         // optionnel, inclure dans export backup
   *   notifyOnLoad: false                   // optionnel, notify au boot
   * }
   */
  S.register = function (name, spec) {
    if (!name || typeof name !== 'string') {
      VC.logError('02-store', 'register: nom invalide', name);
      return false;
    }
    if (!spec || typeof spec !== 'object') {
      VC.logError('02-store', 'register(' + name + '): spec invalide', spec);
      return false;
    }
    if (!spec.saveKey || typeof spec.saveKey !== 'string') {
      VC.logError('02-store', 'register(' + name + '): saveKey manquante');
      return false;
    }
    if (['array', 'object', 'string', 'number'].indexOf(spec.type) === -1) {
      VC.logError('02-store', 'register(' + name + '): type invalide', spec.type);
      return false;
    }
    if (_registry[name]) {
      VC.logWarn('02-store', 'register(' + name + '): déjà enregistré, écrasement');
    }

    _registry[name] = {
      type: spec.type,
      saveKey: spec.saveKey,
      default: _defaultForType(spec.type, spec.default),
      schema: spec.schema || null,
      trash: !!spec.trash,
      idPrefix: spec.idPrefix || null,
      blobs: typeof spec.blobs === 'function' ? spec.blobs : null,
      backup: spec.backup !== false,
      notifyOnLoad: !!spec.notifyOnLoad
    };

    /* Initialise la valeur par défaut si pas encore chargé */
    if (_data[name] === undefined) {
      _data[name] = _cloneDefault(_registry[name].default, spec.type);
    }

    return true;
  };

  function _defaultForType(type, provided) {
    if (provided !== undefined) return provided;
    if (type === 'array') return [];
    if (type === 'object') return {};
    if (type === 'string') return '';
    if (type === 'number') return 0;
    return null;
  }

  function _cloneDefault(def, type) {
    if (type === 'array') return Array.isArray(def) ? def.slice() : [];
    if (type === 'object') return (def && typeof def === 'object') ? Object.assign({}, def) : {};
    if (type === 'string') return String(def || '');
    if (type === 'number') return Number(def) || 0;
    return null;
  }

  S.getSpec = function (name) {
    return _registry[name] || null;
  };

  S.listRegistered = function () {
    return Object.keys(_registry);
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 3 — NORMALISATION
     ═══════════════════════════════════════════════════════════ */

  /**
   * Formate de schéma : 'type' ou 'type|option1|option2'
   *
   * Types :
   *   'string'    → trim + collapse spaces
   *   'int'       → entier, options : 'min-max' ou 'min-max|default'
   *   'float'     → décimal, options : 'min-max' ou 'min-max|default'
   *   'enum'      → valeur parmi liste, options : 'val1,val2,val3'
   *   'bool'      → booléen
   *   'date'      → date ISO YYYY-MM-DD
   *   'array'     → tableau
   *   'object'    → objet
   *
   * Flag supplémentaire : 'required' (ajouté en dernier)
   *   'string|required'         → string obligatoire
   *   'enum|a,b,c|required'     → enum obligatoire
   *
   * Retourne :
   *   - la valeur normalisée si OK
   *   - null si 'required' et valeur vide (item sera rejeté)
   */
  function _normalizeField(rule, value) {
    if (typeof rule !== 'string' || !rule) return value;

    var parts = rule.split('|');
    var type = parts[0];
    var opts = parts.slice(1);
    var isRequired = opts.indexOf('required') !== -1;

    if (type === 'string') {
      var str = U.trimCollapse(value != null ? value : '');
      if (isRequired && !str) return null;
      return str;
    }

    if (type === 'int') {
      var rangeStr = opts[0] || '';
      var defStr = opts[1];
      var min = -Infinity, max = Infinity, def = 0;
      if (rangeStr) {
        var range = rangeStr.split('-');
        min = parseInt(range[0], 10);
        max = parseInt(range[1], 10);
        if (isNaN(min)) min = -Infinity;
        if (isNaN(max)) max = Infinity;
      }
      if (defStr !== undefined) {
        def = parseInt(defStr, 10);
        if (isNaN(def)) def = 0;
      }
      if (isRequired && (value === undefined || value === null || value === '')) {
        return null;
      }
      /* FIX : même logique que float — rejeter below-min si required. */
      if (isRequired) {
        var parsedInt2 = parseInt(value, 10);
        if (!isNaN(parsedInt2) && parsedInt2 < min) {
          return null;
        }
      }
      return U.clampInt(value, min, max, def);
    }

    if (type === 'float') {
      var rangeStr2 = opts[0] || '';
      var min2 = -Infinity, max2 = Infinity;
      if (rangeStr2) {
        var range2 = rangeStr2.split('-');
        min2 = parseFloat(range2[0]);
        max2 = parseFloat(range2[1]);
        if (isNaN(min2)) min2 = -Infinity;
        if (isNaN(max2)) max2 = Infinity;
      }
      if (isRequired && (value === undefined || value === null || value === '')) {
        return null;
      }
      /* FIX : si required ET la valeur numérique est sous le minimum
         (ex : montant 0 quand min = 0.01), rejeter au lieu de clamper.
         Le clamp silencieux masque une saisie invalide. */
      if (isRequired) {
        var parsedNum2 = U.parseNumber(value);
        if (isFinite(parsedNum2) && parsedNum2 < min2) {
          return null;
        }
      }
      return U.clamp(value, min2, max2);
    }

    if (type === 'enum') {
      var allowedStr = opts[0] || '';
      var allowed = allowedStr ? allowedStr.split(',') : [];
      var v = String(value || '').toLowerCase().trim();
      for (var i = 0; i < allowed.length; i++) {
        if (allowed[i].toLowerCase() === v) return allowed[i];
      }
      if (isRequired) return null;
      return allowed[0] || '';
    }

    if (type === 'bool') {
      if (value === true || value === 'true' || value === 1 || value === '1') return true;
      return false;
    }

    if (type === 'date') {
      var d = String(value || '').slice(0, 10);
      if (U.isValidDateString(d)) return d;
      if (isRequired) return null;
      return '';
    }

    if (type === 'array') {
      return Array.isArray(value) ? value : [];
    }

    if (type === 'object') {
      return (value && typeof value === 'object' && !Array.isArray(value)) ? value : {};
    }

    /* Type inconnu → passe-plat */
    return value;
  }

  /**
   * Normalise un item brut contre le schéma.
   * - Préserve les champs inconnus (compat ancien code)
   * - Applique le schéma sur les champs déclarés
   * - Rejette si un champ 'required' est vide
   * - Génère un id si absent (via spec.idPrefix)
   */
  S.normalize = function (name, raw) {
    var spec = _registry[name];
    if (!spec) {
      VC.logWarn('02-store', 'normalize(' + name + '): collection non enregistrée');
      return null;
    }
    if (!raw || typeof raw !== 'object') {
      return null;
    }

    /* Point de départ : copie de raw (préserve inconnus) */
    var out = {};
    var rawKeys = Object.keys(raw);
    for (var i = 0; i < rawKeys.length; i++) {
      out[rawKeys[i]] = raw[rawKeys[i]];
    }

    /* Applique le schéma */
    if (spec.schema && typeof spec.schema === 'object') {
      var schemaKeys = Object.keys(spec.schema);
      for (var j = 0; j < schemaKeys.length; j++) {
        var field = schemaKeys[j];
        var rule = spec.schema[field];
        var normalized = _normalizeField(rule, raw[field]);

        if (normalized === null) {
          /* Champ 'required' vide → item rejeté */
          return null;
        }
        out[field] = normalized;
      }
    }

    /* Génère un id si absent */
    if (!out.id && spec.idPrefix) {
      out.id = U.generateId(spec.idPrefix);
    }

    return out;
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 4 — LECTURE
     ═══════════════════════════════════════════════════════════ */

  /**
   * Retourne la référence interne (mutation directe possible,
   * mais préférer save()/delete()/replaceAll() pour notifier les subscribers).
   */
  S.get = function (name) {
    return _data[name];
  };

  S.getAll = function (name) {
    var v = _data[name];
    if (Array.isArray(v)) return v;
    return [];
  };

  S.getById = function (name, id) {
    if (!id) return null;
    var arr = _data[name];
    if (!Array.isArray(arr)) return null;
    var sid = String(id);
    for (var i = 0; i < arr.length; i++) {
      if (arr[i] && String(arr[i].id) === sid) return arr[i];
    }
    return null;
  };

  S.getObject = function (name) {
    var v = _data[name];
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
    return {};
  };

  S.getValue = function (name) {
    var v = _data[name];
    if (v === undefined || v === null) return '';
    return v;
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 5 — ÉCRITURE
     ═══════════════════════════════════════════════════════════ */

  /**
   * Upsert atomique d'un item.
   * - Si item.id existe dans la collection → remplace
   * - Sinon → push
   * - Notifie les subscribers
   * - Persiste immédiatement
   * Retourne l'item normalisé, ou null si invalide.
   */
  S.save = function (name, rawItem) {
    var spec = _registry[name];
    if (!spec) {
      VC.logError('02-store', 'save(' + name + '): collection non enregistrée');
      return null;
    }
    if (spec.type !== 'array') {
      VC.logError('02-store', 'save(' + name + '): type ' + spec.type + ' non supporté (utiliser setObject/setValue)');
      return null;
    }

    var clean = S.normalize(name, rawItem);
    if (!clean) {
      VC.logWarn('02-store', 'save(' + name + '): item invalide (champ requis vide)', rawItem);
      return null;
    }

    var arr = _data[name];
    if (!Array.isArray(arr)) {
      arr = [];
      _data[name] = arr;
    }

    var found = -1;
    if (clean.id) {
      for (var i = 0; i < arr.length; i++) {
        if (arr[i] && String(arr[i].id) === String(clean.id)) {
          found = i;
          break;
        }
      }
    }

    if (found >= 0) {
      arr[found] = clean;
    } else {
      arr.push(clean);
    }

    _persistOne(name);
    _notify(name, 'save', clean);
    return clean;
  };

  /**
   * Suppression avec trash.
   * - Retire de la collection
   * - Si spec.trash → push dans _trash[name]
   * - Notifie
   * - Persiste
   */
  S.delete = function (name, id) {
    var spec = _registry[name];
    if (!spec) {
      VC.logError('02-store', 'delete(' + name + '): collection non enregistrée');
      return false;
    }

    var arr = _data[name];
    if (!Array.isArray(arr)) return false;

    var sid = String(id);
    var found = -1;
    var item = null;
    for (var i = 0; i < arr.length; i++) {
      if (arr[i] && String(arr[i].id) === sid) {
        found = i;
        item = arr[i];
        break;
      }
    }
    if (found < 0) return false;

    arr.splice(found, 1);

    if (spec.trash && item) {
      S.moveToTrash(name, item);
    }

    _persistOne(name);
    _persistTrash();
    _notify(name, 'delete', item);
    _broadcast({ type: 'delete', name: name, id: sid });
    return true;
  };

  /**
   * Remplace toute la collection (bulk atomique).
   * - Notifie une seule fois
   * - Persiste
   */
  S.replaceAll = function (name, newArray) {
    var spec = _registry[name];
    if (!spec) {
      VC.logError('02-store', 'replaceAll(' + name + '): non enregistré');
      return false;
    }
    if (spec.type !== 'array') {
      VC.logError('02-store', 'replaceAll(' + name + '): type non array');
      return false;
    }
    if (!Array.isArray(newArray)) {
      VC.logError('02-store', 'replaceAll(' + name + '): argument non-array');
      return false;
    }

    var clean = [];
    var rejected = [];

    for (var i = 0; i < newArray.length; i++) {
      var rawItem = newArray[i];

      /* FIX R61 : migration avant normalisation (cohérent avec _loadArray) */
      var migrated = rawItem;
      if (VC.Migrate && typeof VC.Migrate.upgradeItem === 'function') {
        try {
          migrated = VC.Migrate.upgradeItem(name, rawItem) || rawItem;
        } catch (e) {
          VC.logError('02-store', 'replaceAll(' + name + '): migrate item ' + i + ' échoué', e);
        }
      }

      var item = S.normalize(name, migrated);
      if (item) {
        clean.push(item);
      } else {
        /* FIX R61 : les items rejetés vont en quarantaine au lieu d'être
           silencieusement perdus. Important en mode import replace. */
        rejected.push(rawItem);
      }
    }

    _data[name] = clean;
    _persistOne(name);

    /* FIX R61 : quarantaine AVANT la notification pour que les
       subscribers voient l'état définitif. */
    if (rejected.length > 0) {
      _quarantineItems(name, rejected);
      VC.logWarn('02-store', 'replaceAll(' + name + '): ' +
        rejected.length + ' item(s) rejeté(s) → quarantaine');
    }

    _notify(name, 'replaceAll', null);
    return true;
  };

  S.setObject = function (name, obj) {
    var spec = _registry[name];
    if (!spec || spec.type !== 'object') {
      VC.logError('02-store', 'setObject(' + name + '): type non object');
      return false;
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      VC.logError('02-store', 'setObject(' + name + '): argument non-objet');
      return false;
    }
    _data[name] = obj;
    _persistOne(name);
    _notify(name, 'save', obj);
    return true;
  };

  S.setValue = function (name, value) {
    var spec = _registry[name];
    if (!spec || (spec.type !== 'string' && spec.type !== 'number')) {
      VC.logError('02-store', 'setValue(' + name + '): type non string/number');
      return false;
    }
    if (spec.type === 'number') {
      _data[name] = Number(value) || 0;
    } else {
      _data[name] = String(value != null ? value : '');
    }
    _persistOne(name);
    _notify(name, 'save', _data[name]);
    return true;
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 6 — TRASH (objet OUVERT, jamais de clés fixes)
     ═══════════════════════════════════════════════════════════ */

  S.getTrash = function () {
    return _trash;
  };

  S.getTrashEntries = function (name) {
    return Array.isArray(_trash[name]) ? _trash[name] : [];
  };

  S.getTrashCount = function () {
    var total = 0;
    var keys = Object.keys(_trash);
    for (var i = 0; i < keys.length; i++) {
      if (Array.isArray(_trash[keys[i]])) total += _trash[keys[i]].length;
    }
    return total;
  };

  S.moveToTrash = function (name, item) {
    var spec = _registry[name];
    if (!spec || !spec.trash) {
      VC.logWarn('02-store', 'moveToTrash(' + name + '): trash non activé pour cette collection');
      return false;
    }
    if (!item) return false;

    if (!Array.isArray(_trash[name])) _trash[name] = [];

    var user = 'anon';
    try {
      if (VC.Auth && VC.Auth.currentUser && VC.Auth.currentUser.username) {
        user = String(VC.Auth.currentUser.username);
      }
    } catch (e) {
      VC.logError('02-store', 'moveToTrash: lecture user échouée', e);
    }

    _trash[name].push({
      item: item,
      deletedAt: new Date().toISOString(),
      deletedBy: user
    });

    _persistTrash();
    return true;
  };

  S.restoreFromTrash = function (name, index) {
    var entries = _trash[name];
    if (!Array.isArray(entries) || index < 0 || index >= entries.length) {
      return null;
    }

    var entry = entries[index];
    if (!entry || !entry.item) return null;

    /* Vérifie ID non déjà présent */
    var arr = _data[name];
    if (!Array.isArray(arr)) {
      arr = [];
      _data[name] = arr;
    }

    if (entry.item.id) {
      for (var i = 0; i < arr.length; i++) {
        if (arr[i] && String(arr[i].id) === String(entry.item.id)) {
          VC.logWarn('02-store', 'restoreFromTrash(' + name + '): ID déjà présent', entry.item.id);
          return null;
        }
      }
    }

    entries.splice(index, 1);
    arr.push(entry.item);

    _persistOne(name);
    _persistTrash();
    _notify(name, 'restore', entry.item);
    return entry.item;
  };

  S.emptyTrash = function () {
    _trash = {};
    _persistTrash();
    return true;
  };

  S.purgeOldTrash = function (days) {
    var maxDays = (typeof days === 'number') ? days : VC.TRASH_MAX_DAYS;
    var cutoff = Date.now() - (maxDays * 86400000);
    var purged = 0;
    var keys = Object.keys(_trash);

    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (!Array.isArray(_trash[k])) continue;
      var before = _trash[k].length;
      _trash[k] = _trash[k].filter(function (entry) {
        if (!entry || !entry.deletedAt) return false;
        try {
          return new Date(entry.deletedAt).getTime() > cutoff;
        } catch (e) {
          VC.logError('02-store', 'purgeOldTrash: date invalide', entry.deletedAt);
          return false;
        }
      });
      purged += (before - _trash[k].length);
    }

    if (purged > 0) _persistTrash();
    return purged;
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 7 — COMPTEURS (singleton object)
     ═══════════════════════════════════════════════════════════ */

  S.getCompteurs = function () {
    return S.getObject('compteurs');
  };

  S.incrementCompteur = function (type) {
    var c = S.getObject('compteurs');
    var year = new Date().getFullYear();
    var key = String(type || 'doc') + '_' + year;
    c[key] = (parseInt(c[key], 10) || 0) + 1;
    _persistOne('compteurs');
    return c[key];
  };

  S.genererNumero = function (type) {
    var t = String(type || '').toLowerCase();
    var prefixes = {
      facture: 'FAC', devis: 'DEV', bl: 'BL',
      avoir: 'AV', attachement: 'ATT', achat: 'ACH', bonroute: 'BR'
    };
    var prefix = prefixes[t] || 'DOC';
    var year = new Date().getFullYear();
    var c = S.getObject('compteurs');
    var key = t + '_' + year;
    var next = (parseInt(c[key], 10) || 0) + 1;
    return prefix + '-' + year + '-' + String(next).padStart(4, '0');
  };

  S.resetCompteurs = function () {
    _data['compteurs'] = {};
    _persistOne('compteurs');
    return true;
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 8 — SAVE / LOAD ALL
     ═══════════════════════════════════════════════════════════ */

  function _persistOne(name) {
    var spec = _registry[name];
    if (!spec) return false;
    try {
      var value = _data[name];
      if (value === undefined) return false;
      var serialized;
      if (spec.type === 'array' || spec.type === 'object') {
        serialized = JSON.stringify(value);
      } else {
        serialized = String(value);
      }
      localStorage.setItem(spec.saveKey, serialized);
      return true;
    } catch (e) {
      if (e && (e.name === 'QuotaExceededError' || e.code === 22)) {
        VC.logError('02-store', 'persistOne(' + name + '): quota localStorage dépassé', e);
      } else {
        VC.logError('02-store', 'persistOne(' + name + ') échoué', e);
      }
      return false;
    }
  }

  function _persistTrash() {
    try {
      localStorage.setItem('voltcore_trash', JSON.stringify(_trash));
      return true;
    } catch (e) {
      VC.logError('02-store', 'persistTrash échoué', e);
      return false;
    }
  }

  S.saveAll = function () {
    var names = Object.keys(_registry);
    var ok = 0, failed = 0;

    for (var i = 0; i < names.length; i++) {
      if (_persistOne(names[i])) ok++;
      else failed++;
    }
    if (_persistTrash()) ok++;
    else failed++;

    _broadcast({ type: 'saveAll', names: names });
    return { ok: ok, failed: failed };
  };

  S.loadAll = function () {
    var names = Object.keys(_registry);
    var loaded = 0, skipped = 0;

    for (var i = 0; i < names.length; i++) {
      _loadOne(names[i]);
      loaded++;
    }

    _loadTrash();

    _initialLoadDone = true;
    VC.logInfo('02-store', 'loadAll terminé', {
      collections: loaded,
      skipped: skipped,
      trashKeys: Object.keys(_trash).length
    });
    return { loaded: loaded, skipped: skipped };
  };

  function _loadOne(name) {
    var spec = _registry[name];
    if (!spec) return;

    var raw = null;
    try {
      raw = localStorage.getItem(spec.saveKey);
    } catch (e) {
      VC.logError('02-store', 'loadOne(' + name + '): lecture localStorage échouée', e);
      _data[name] = _cloneDefault(spec.default, spec.type);
      return;
    }

    if (raw === null || raw === undefined || raw === '') {
      _data[name] = _cloneDefault(spec.default, spec.type);
      return;
    }

    if (spec.type === 'array') {
      _loadArray(name, spec, raw);
    } else if (spec.type === 'object') {
      _loadObject(name, spec, raw);
    } else {
      _loadValue(name, spec, raw);
    }
  }

  function _loadArray(name, spec, raw) {
    var parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      VC.logError('02-store', 'loadArray(' + name + '): JSON invalide', e);
      _data[name] = [];
      return;
    }

    if (!Array.isArray(parsed)) {
      VC.logError('02-store', 'loadArray(' + name + '): pas un tableau');
      _data[name] = [];
      return;
    }

    var out = [];
    var rejected = [];
    for (var i = 0; i < parsed.length; i++) {
      var rawItem = parsed[i];
      if (!rawItem || typeof rawItem !== 'object') {
        rejected.push(rawItem);
        continue;
      }

      /* Migration éventuelle (27-migrate.js) */
      var migrated = rawItem;
      if (VC.Migrate && typeof VC.Migrate.upgradeItem === 'function') {
        try {
          migrated = VC.Migrate.upgradeItem(name, rawItem) || rawItem;
        } catch (e) {
          VC.logError('02-store', 'loadArray(' + name + '): migrate item ' + i + ' échoué', e);
        }
      }

      /* Normalisation */
      var clean = S.normalize(name, migrated);
      if (!clean) {
        rejected.push(rawItem);
        continue;
      }
      out.push(clean);
    }
    _data[name] = out;

    /* FIX R1 : ne PAS perdre les items rejetés. Les mettre en quarantaine. */
    if (rejected.length > 0) {
      _quarantineItems(name, rejected);

      /* FIX R43 : réécrire la clé source SANS les items rejetés.
         Sans cette réécriture, un item invalide reste indéfiniment
         dans localStorage → re-quarantiné à chaque boot → duplication
         linéaire → saturation du quota. */
      try {
        localStorage.setItem(spec.saveKey, JSON.stringify(out));
      } catch (e) {
        VC.logError('02-store', 'loadArray(' + name +
          '): réécriture source après quarantaine échouée (quota ?)', e);
      }
    }
  }

  /* FIX R1 : quarantaine — préserve les items rejetés dans une clé dédiée
     localStorage, pour récupération manuelle ultérieure. */
  function _quarantineItems(name, items) {
    try {
      var key = 'voltcore_quarantine_' + name;
      var raw = localStorage.getItem(key);
      var arr = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(arr)) arr = [];

      /* FIX R44 : dédupliquer par (JSON.stringify(item) + collection)
         pour éviter les doublons si le même item est rejeté plusieurs fois. */
      var seen = {};
      for (var s = 0; s < arr.length; s++) {
        if (!arr[s] || arr[s].item === undefined) continue;
        try {
          var keyStr = name + '|' + JSON.stringify(arr[s].item);
          seen[keyStr] = true;
        } catch (e) { /* item circulaire ou non sérialisable, skip */ }
      }

      var now = new Date().toISOString();
      var added = 0;
      for (var i = 0; i < items.length; i++) {
        var item = items[i];
        var dedupeKey;
        try {
          dedupeKey = name + '|' + JSON.stringify(item);
        } catch (e) {
          /* Item non sérialisable → on l'ajoute quand même avec marqueur */
          dedupeKey = name + '|<unserializable_' + Date.now() + '_' + Math.random() + '>';
        }
        if (seen[dedupeKey]) continue;
        seen[dedupeKey] = true;
        arr.push({ _quarantinedAt: now, _collection: name, item: item });
        added++;
      }

      if (added > 0) {
        localStorage.setItem(key, JSON.stringify(arr));
        VC.logWarn('02-store', added + ' item(s) mis en quarantaine pour "' + name + '" (clé localStorage : ' + key + ')');
      }
    } catch (e) {
      VC.logError('02-store', '_quarantineItems échoué', e);
    }
  }

  S.getQuarantine = function (name) {
    try {
      var raw = localStorage.getItem('voltcore_quarantine_' + name);
      if (!raw) return [];
      var arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch (e) {
      VC.logError('02-store', 'getQuarantine échoué', e);
      return [];
    }
  };

  S.listQuarantinedCollections = function () {
    var out = [];
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf('voltcore_quarantine_') === 0) {
          var name = k.replace('voltcore_quarantine_', '');
          var arr = S.getQuarantine(name);
          if (arr.length > 0) {
            out.push({ name: name, count: arr.length, key: k });
          }
        }
      }
    } catch (e) {
      VC.logError('02-store', 'listQuarantinedCollections échoué', e);
    }
    return out;
  };

  function _loadObject(name, spec, raw) {
    try {
      var parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        _data[name] = parsed;
      } else {
        VC.logWarn('02-store', 'loadObject(' + name + '): pas un objet, reset');
        _data[name] = _cloneDefault(spec.default, spec.type);
      }
    } catch (e) {
      VC.logError('02-store', 'loadObject(' + name + '): JSON invalide', e);
      _data[name] = _cloneDefault(spec.default, spec.type);
    }
  }

  function _loadValue(name, spec, raw) {
    if (spec.type === 'number') {
      var n = Number(raw);
      _data[name] = isFinite(n) ? n : 0;
    } else {
      _data[name] = String(raw || '');
    }
  }

  function _loadTrash() {
    /* FIX C1/C2 : préserve TOUTES les clés de trash, pas 3 */
    var raw = null;
    try {
      raw = localStorage.getItem('voltcore_trash');
    } catch (e) {
      VC.logError('02-store', 'loadTrash: lecture échouée', e);
      _trash = {};
      return;
    }

    if (!raw) {
      _trash = {};
      return;
    }

    try {
      var parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        _trash = parsed;  /* ← FIX : objet entier préservé */
      } else {
        VC.logWarn('02-store', 'loadTrash: format inattendu, reset');
        _trash = {};
      }
    } catch (e) {
      VC.logError('02-store', 'loadTrash: JSON invalide', e);
      _trash = {};
    }
  }

  S.isInitialLoadDone = function () {
    return _initialLoadDone;
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 9 — SUBSCRIBERS
     ═══════════════════════════════════════════════════════════ */

  S.subscribe = function (name, callback) {
    if (typeof callback !== 'function') {
      VC.logError('02-store', 'subscribe: callback non-fonction');
      return false;
    }
    if (!_subscribers[name]) _subscribers[name] = [];
    _subscribers[name].push(callback);
    return true;
  };

  S.unsubscribe = function (name, callback) {
    var subs = _subscribers[name];
    if (!Array.isArray(subs)) return false;
    var idx = subs.indexOf(callback);
    if (idx < 0) return false;
    subs.splice(idx, 1);
    return true;
  };

  function _notify(name, action, item) {
    var subs = _subscribers[name];
    if (!Array.isArray(subs) || subs.length === 0) return;
    for (var i = 0; i < subs.length; i++) {
      try {
        subs[i]({ name: name, action: action, item: item });
      } catch (e) {
        VC.logError('02-store', 'subscriber échoué pour ' + name, e);
      }
    }
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 10 — BLOBS TRACKING (fix C3)
     ═══════════════════════════════════════════════════════════ */

  /**
   * Retourne toutes les références de blobs utilisées par les collections
   * enregistrées avec un handler `blobs`, y compris ceux présents en trash.
   * Utilisé par 03-idb.js pour préserver les blobs actifs lors du cleanup.
   */
  S.getAllBlobRefs = function () {
    var refs = [];
    var names = Object.keys(_registry);

    for (var i = 0; i < names.length; i++) {
      var name = names[i];
      var spec = _registry[name];
      if (!spec || typeof spec.blobs !== 'function') continue;

      var arr = _data[name];
      if (!Array.isArray(arr)) continue;

      for (var j = 0; j < arr.length; j++) {
        try {
          var itemRefs = spec.blobs(arr[j]);
          if (Array.isArray(itemRefs)) {
            for (var k = 0; k < itemRefs.length; k++) {
              if (itemRefs[k]) refs.push(String(itemRefs[k]));
            }
          }
        } catch (e) {
          VC.logError('02-store', 'getAllBlobRefs: handler échoué pour ' + name, e);
        }
      }
    }

    /* Scan le trash aussi (protège les blobs des items en corbeille) */
    var trashNames = Object.keys(_trash);
    for (var t = 0; t < trashNames.length; t++) {
      var tName = trashNames[t];
      var tSpec = _registry[tName];
      if (!tSpec || typeof tSpec.blobs !== 'function') continue;

      var entries = _trash[tName];
      if (!Array.isArray(entries)) continue;

      for (var m = 0; m < entries.length; m++) {
        var entry = entries[m];
        if (!entry || !entry.item) continue;
        try {
          var tRefs = tSpec.blobs(entry.item);
          if (Array.isArray(tRefs)) {
            for (var n = 0; n < tRefs.length; n++) {
              if (tRefs[n]) refs.push(String(tRefs[n]));
            }
          }
        } catch (e) {
          VC.logError('02-store', 'getAllBlobRefs: handler trash échoué pour ' + tName, e);
        }
      }
    }

    /* FIX R10 : scanner aussi la quarantaine.
       Les items rejetés à la normalisation ont leurs blobs en IDB,
       mais ne sont plus dans _data. Sans ce scan, cleanOrphans
       supprimerait leurs fichiers au prochain boot. */
    try {
      for (var q = 0; q < localStorage.length; q++) {
        var qKey = localStorage.key(q);
        if (!qKey || qKey.indexOf('voltcore_quarantine_') !== 0) continue;
        var qName = qKey.replace('voltcore_quarantine_', '');
        var qSpec = _registry[qName];
        var qRaw = localStorage.getItem(qKey);
        if (!qRaw) continue;
        var qArr;
        try { qArr = JSON.parse(qRaw); } catch (e) { continue; }
        if (!Array.isArray(qArr)) continue;

        for (var qq = 0; qq < qArr.length; qq++) {
          var qItem = qArr[qq] && qArr[qq].item;
          if (!qItem) continue;
          /* Utilise le handler blobs de la collection si dispo */
          if (qSpec && typeof qSpec.blobs === 'function') {
            try {
              var qRefs = qSpec.blobs(qItem);
              if (Array.isArray(qRefs)) {
                for (var qr = 0; qr < qRefs.length; qr++) {
                  if (qRefs[qr]) refs.push(String(qRefs[qr]));
                }
              }
            } catch (e) {
              VC.logError('02-store', 'getAllBlobRefs: quarantine handler échoué', e);
            }
          }
          /* Fallback : scan direct des champs connus */
          if (qItem.storageKey) refs.push(String(qItem.storageKey));
          if (qItem.ref) refs.push(String(qItem.ref));
          if (Array.isArray(qItem.attachments)) {
            for (var qa = 0; qa < qItem.attachments.length; qa++) {
              if (qItem.attachments[qa] && qItem.attachments[qa].ref) {
                refs.push(String(qItem.attachments[qa].ref));
              }
            }
          }
        }
      }
    } catch (e) {
      VC.logError('02-store', 'getAllBlobRefs: quarantine scan failed', e);
    }

    return refs;
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 11 — BROADCASTCHANNEL (multi-onglet)
     ═══════════════════════════════════════════════════════════ */

  function _initBroadcast() {
    try {
      if (typeof BroadcastChannel !== 'function') return;
      _broadcastChannel = new BroadcastChannel('voltcore-sync');
      _broadcastChannel.onmessage = function (ev) {
        var data = ev.data || {};
        if (!data.type) return;

        _applyingRemote = true;
        try {
          if (data.type === 'saveAll' && Array.isArray(data.names)) {
            for (var i = 0; i < data.names.length; i++) {
              var n = data.names[i];
              if (_registry[n]) {
                _loadOne(n);
                _notify(n, 'remote-reload', null);
              }
            }
            _loadTrash();
          } else if (data.type === 'delete' && data.name) {
            _loadOne(data.name);
            _notify(data.name, 'remote-reload', null);
            _loadTrash();
          } else if (data.type === 'trash-empty') {
            _loadTrash();
          }
        } catch (e) {
          VC.logError('02-store', 'broadcast onmessage échoué', e);
        } finally {
          _applyingRemote = false;
        }
      };
    } catch (e) {
      VC.logError('02-store', 'initBroadcast échoué', e);
    }
  }

  function _broadcast(payload) {
    if (_applyingRemote) return;
    try {
      if (_broadcastChannel) _broadcastChannel.postMessage(payload);
    } catch (e) {
      VC.logError('02-store', 'broadcast échoué', e);
    }
  }

  _initBroadcast();

  /* ═══════════════════════════════════════════════════════════
     SECTION 12 — MARQUEUR
     ═══════════════════════════════════════════════════════════ */

  VC._storeLoaded = true;

  VC.logInfo('02-store', 'Store initialisé', {
    registered: Object.keys(_registry).length,
    broadcast: _broadcastChannel !== null
  });

})(window);