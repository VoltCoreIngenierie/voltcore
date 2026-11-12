/* ═══════════════════════════════════════════════════════════
   VOLTCORE — 03-idb.js
   VERSION : v7.0.7
   RÔLE : IndexedDB — blobs, backups automatiques, fsHandles.
          API namespacée : IDB.blobs.*, IDB.backups.*, IDB.fs.*
          Cleanup orphelins basé sur Store.getAllBlobRefs() (fix C3).
   DÉPENDANCES : 00-core.js, 01-utils.js, 02-store.js
   ORDRE : 4ᵉ fichier chargé

   RÈGLES :
   - ES5 strict (var uniquement, pas de let/const, pas de arrow)
   - Aucun catch silencieux (tout est loggué)
   - Connexion IDB réutilisée (cache _dbPromise, reset sur erreur)
   - versionchange → ferme proprement la connexion
   - Toutes les opérations retournent des Promises
   ═══════════════════════════════════════════════════════════ */

'use strict';

(function (global) {

  if (!global.VOLTCORE || !global.VOLTCORE.Utils || !global.VOLTCORE.Store) {
    throw new Error('[03-idb] 00-core, 01-utils, 02-store doivent être chargés avant');
  }

  var VC = global.VOLTCORE;
  var U = VC.Utils;
  var S = VC.Store;
  var I = VC.IDB || {};
  VC.IDB = I;

  /* ═══════════════════════════════════════════════════════════
     SECTION 1 — ÉTAT INTERNE
     ═══════════════════════════════════════════════════════════ */

  var _dbPromise = null;
  var _autoBackupTimer = null;

  I.isSupported = function () {
    try {
      return typeof global.indexedDB !== 'undefined' && global.indexedDB !== null;
    } catch (e) {
      VC.logError('03-idb', 'isSupported échoué', e);
      return false;
    }
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 2 — OUVERTURE DB
     ═══════════════════════════════════════════════════════════ */

  function _open() {
    if (_dbPromise) return _dbPromise;

    _dbPromise = new Promise(function (resolve, reject) {
      if (!I.isSupported()) {
        reject(new Error('IndexedDB indisponible'));
        return;
      }

      var req;
      try {
        req = indexedDB.open(VC.IDB_NAME, VC.IDB_VERSION);
      } catch (e) {
        reject(e);
        return;
      }

      req.onupgradeneeded = function (ev) {
        try {
          var db = ev.target.result;

          if (!db.objectStoreNames.contains(VC.IDB_STORE_BACKUPS)) {
            var s1 = db.createObjectStore(VC.IDB_STORE_BACKUPS, {
              keyPath: 'id', autoIncrement: true
            });
            s1.createIndex('date', 'date', { unique: false });
          }

          if (!db.objectStoreNames.contains(VC.IDB_STORE_BLOBS)) {
            var s2 = db.createObjectStore(VC.IDB_STORE_BLOBS, {
              keyPath: 'id'
            });
            s2.createIndex('createdAt', 'createdAt', { unique: false });
          }

          if (!db.objectStoreNames.contains(VC.IDB_STORE_FSHANDLES)) {
            db.createObjectStore(VC.IDB_STORE_FSHANDLES, { keyPath: 'id' });
          }
        } catch (e) {
          VC.logError('03-idb', 'onupgradeneeded échoué', e);
        }
      };

      req.onsuccess = function () {
        var db = req.result;
        db.onversionchange = function () {
          try { db.close(); } catch (e) {
            VC.logError('03-idb', 'versionchange close échoué', e);
          }
          _dbPromise = null;
        };
        resolve(db);
      };

      req.onerror = function () {
        reject(req.error || new Error('Ouverture IDB échouée'));
      };
    });

    /* Reset le cache si échec, pour permettre retry */
    _dbPromise = _dbPromise.then(function (db) {
      return db;
    }, function (err) {
      _dbPromise = null;
      throw err;
    });

    return _dbPromise;
  }

  /* Transaction générique — encapsule IDB dans une Promise.
     Ne ferme PAS la DB (réutilisable), gère les erreurs proprement. */
  function _txn(storeName, mode, opFn) {
    return _open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx, store, req;
        try {
          tx = db.transaction(storeName, mode);
          store = tx.objectStore(storeName);
          req = opFn(store);
        } catch (e) {
          reject(e);
          return;
        }
        req.onsuccess = function () {
          resolve(req.result);
        };
        req.onerror = function () {
          reject(req.error || new Error('IDB op échouée'));
        };
        tx.onabort = function () {
          reject(tx.error || new Error('IDB transaction aborted'));
        };
      });
    });
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 3 — DATAURL <-> BLOB
     ═══════════════════════════════════════════════════════════ */

  I.dataURLToBlob = function (dataUrl) {
    return new Promise(function (resolve, reject) {
      try {
        if (!dataUrl || typeof dataUrl !== 'string') {
          reject(new Error('dataUrl vide ou invalide'));
          return;
        }
        var parts = dataUrl.split(',');
        if (parts.length !== 2) {
          reject(new Error('dataUrl: format invalide'));
          return;
        }
        var mimeMatch = parts[0].match(/:(.*?);/);
        var mime = mimeMatch ? mimeMatch[1] : 'application/octet-stream';
        var binary = atob(parts[1]);
        var bytes = new Uint8Array(binary.length);
        for (var i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i);
        }
        resolve(new Blob([bytes], { type: mime }));
      } catch (e) {
        VC.logError('03-idb', 'dataURLToBlob échoué', e);
        reject(e);
      }
    });
  };

  I.blobToDataURL = function (blob) {
    return new Promise(function (resolve, reject) {
      try {
        if (!blob) {
          reject(new Error('blob vide'));
          return;
        }
        var reader = new FileReader();
        reader.onload = function (e) { resolve(e.target.result); };
        reader.onerror = function () {
          reject(reader.error || new Error('FileReader échoué'));
        };
        reader.readAsDataURL(blob);
      } catch (e) {
        VC.logError('03-idb', 'blobToDataURL échoué', e);
        reject(e);
      }
    });
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 4 — BLOBS
     ═══════════════════════════════════════════════════════════ */

  I.blobs = {

    put: function (id, blob, mime) {
      if (!id || !blob) {
        return Promise.reject(new Error('id et blob requis'));
      }
      var record = {
        id: String(id),
        data: blob,
        mime: String(mime || blob.type || 'application/octet-stream'),
        size: blob.size || 0,
        createdAt: new Date().toISOString()
      };
      return _txn(VC.IDB_STORE_BLOBS, 'readwrite', function (store) {
        return store.put(record);
      }).then(function () {
        return { ok: true, id: record.id, size: record.size };
      }).catch(function (e) {
        VC.logError('03-idb.blobs.put', 'put échoué pour ' + id, e);
        throw e;
      });
    },

    get: function (id) {
      if (!id) return Promise.resolve(null);
      return _txn(VC.IDB_STORE_BLOBS, 'readonly', function (store) {
        return store.get(String(id));
      }).catch(function (e) {
        VC.logError('03-idb.blobs.get', 'get échoué pour ' + id, e);
        return null;
      });
    },

    delete: function (id) {
      if (!id) return Promise.resolve(false);
      return _txn(VC.IDB_STORE_BLOBS, 'readwrite', function (store) {
        return store.delete(String(id));
      }).then(function () {
        return true;
      }).catch(function (e) {
        VC.logError('03-idb.blobs.delete', 'delete échoué pour ' + id, e);
        return false;
      });
    },

    list: function () {
      return new Promise(function (resolve, reject) {
        _open().then(function (db) {
          var tx, store, req;
          try {
            tx = db.transaction(VC.IDB_STORE_BLOBS, 'readonly');
            store = tx.objectStore(VC.IDB_STORE_BLOBS);
            req = store.openCursor();
          } catch (e) {
            reject(e);
            return;
          }
          var out = [];
          req.onsuccess = function (ev) {
            var cur = ev.target.result;
            if (cur) {
              out.push({
                id: String(cur.value.id || ''),
                mime: cur.value.mime || '',
                size: cur.value.size || 0,
                createdAt: cur.value.createdAt || ''
              });
              cur.continue();
            } else {
              resolve(out);
            }
          };
          req.onerror = function () {
            reject(req.error || new Error('Cursor error'));
          };
        }).catch(reject);
      }).catch(function (e) {
        VC.logError('03-idb.blobs.list', 'list échoué', e);
        return [];
      });
    },

    /**
     * FIX C3 — Supprime les blobs IDB qui ne sont référencés par AUCUNE
     * collection enregistrée dans Store, ni par le trash, ni par le
     * brouillon courant, ni par les refs protégées (sig_default,
     * cachet_default).
     *
     * Ne supprime JAMAIS les refs protégées même si non référencées.
     * Idempotent, safe à appeler à chaque boot.
     */
    cleanOrphans: function () {
      return new Promise(function (resolve) {

        var usedRefs = {};

        /* 1. Refs collectées par Store (arrays + trash) */
        try {
          var storeRefs = S.getAllBlobRefs();
          for (var i = 0; i < storeRefs.length; i++) {
            if (storeRefs[i]) usedRefs[String(storeRefs[i])] = true;
          }
        } catch (e) {
          VC.logError('03-idb.blobs.cleanOrphans', 'getAllBlobRefs échoué', e);
        }

        /* 2. Brouillon courant (type object, pas couvert par Store.getAllBlobRefs) */
        try {
          var rawDraft = localStorage.getItem('voltcore_brouillon_courant');
          if (rawDraft) {
            var draft = JSON.parse(rawDraft);
            if (draft && Array.isArray(draft.attachments)) {
              for (var d = 0; d < draft.attachments.length; d++) {
                var att = draft.attachments[d];
                if (att && att.ref) usedRefs[String(att.ref)] = true;
              }
            }
          }
        } catch (e) {
          VC.logError('03-idb.blobs.cleanOrphans', 'brouillon scan échoué', e);
        }

        /* 3. Refs TOUJOURS protégées (signature/cachet par défaut) */
        usedRefs[VC.SIG_DEFAULT_REF] = true;
        usedRefs[VC.CACHET_DEFAULT_REF] = true;

        /* 4. Parcours tous les blobs IDB, supprime ceux non référencés */
        I.blobs.list().then(function (allBlobs) {
          var toDelete = [];
          for (var j = 0; j < allBlobs.length; j++) {
            var blobId = String(allBlobs[j].id || '');
            if (blobId && !usedRefs[blobId]) {
              toDelete.push(blobId);
            }
          }

          if (toDelete.length === 0) {
            return resolve({ cleaned: 0 });
          }

          /* Suppression séquentielle (évite saturation transactions) */
          var deleted = 0;
          var idx = 0;

          function next() {
            if (idx >= toDelete.length) {
              return resolve({ cleaned: deleted });
            }
            var id = toDelete[idx++];
            I.blobs.delete(id).then(function (ok) {
              if (ok) deleted++;
              next();
            });
          }
          next();
        }).catch(function (e) {
          VC.logError('03-idb.blobs.cleanOrphans', 'list final échoué', e);
          resolve({ cleaned: 0, error: e.message });
        });
      });
    }
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 5 — BACKUPS
     ═══════════════════════════════════════════════════════════ */

  I.backups = {

    save: function (payload) {
      return new Promise(function (resolve, reject) {
        var json;
        try {
          json = JSON.stringify(payload);
        } catch (e) {
          reject(e);
          return;
        }
        if (json.length > VC.IDB_MAX_SIZE) {
          reject(new Error('Backup trop volumineux (' + json.length + ' octets)'));
          return;
        }

        var record = {
          date: new Date().toISOString(),
          size: json.length,
          payload: payload
        };

        _txn(VC.IDB_STORE_BACKUPS, 'readwrite', function (store) {
          return store.add(record);
        }).then(function (id) {
          resolve({ ok: true, id: id, size: json.length });
        }).catch(function (e) {
          VC.logError('03-idb.backups.save', 'save échoué', e);
          reject(e);
        });
      });
    },

    list: function () {
      return new Promise(function (resolve, reject) {
        _open().then(function (db) {
          var tx, store, req;
          try {
            tx = db.transaction(VC.IDB_STORE_BACKUPS, 'readonly');
            store = tx.objectStore(VC.IDB_STORE_BACKUPS);
            req = store.openCursor();
          } catch (e) {
            reject(e);
            return;
          }
          var out = [];
          req.onsuccess = function (ev) {
            var cur = ev.target.result;
            if (cur) {
              out.push({
                id: cur.value.id,
                date: cur.value.date,
                size: cur.value.size
              });
              cur.continue();
            } else {
              out.sort(function (a, b) {
                if (a.date < b.date) return 1;
                if (a.date > b.date) return -1;
                return 0;
              });
              resolve(out);
            }
          };
          req.onerror = function () {
            reject(req.error || new Error('Cursor error'));
          };
        }).catch(reject);
      }).catch(function (e) {
        VC.logError('03-idb.backups.list', 'list échoué', e);
        return [];
      });
    },

    restore: function (id) {
      return _txn(VC.IDB_STORE_BACKUPS, 'readonly', function (store) {
        return store.get(id);
      }).then(function (record) {
        if (!record) return null;
        return record.payload || null;
      }).catch(function (e) {
        VC.logError('03-idb.backups.restore', 'restore échoué pour ' + id, e);
        return null;
      });
    },

    clean: function (keep) {
      var max = (typeof keep === 'number') ? keep : VC.IDB_KEEP_BACKUPS;
      return I.backups.list().then(function (list) {
        if (list.length <= max) return 0;
        var toDelete = list.slice(max);
        var deleted = 0;
        return new Promise(function (resolve) {
          var idx = 0;
          function next() {
            if (idx >= toDelete.length) {
              resolve(deleted);
              return;
            }
            var bId = toDelete[idx++].id;
            _txn(VC.IDB_STORE_BACKUPS, 'readwrite', function (store) {
              return store.delete(bId);
            }).then(function () {
              deleted++;
              next();
            }).catch(function (e) {
              VC.logError('03-idb.backups.clean', 'delete ' + bId + ' échoué', e);
              next();
            });
          }
          next();
        });
      });
    },

    /**
     * Fait un backup auto si le dernier date de >24h.
     * Le payload est construit via Store.saveAll() snapshot.
     */
    autoIfNeeded: function () {
      var lastTs = 0;
      try {
        lastTs = parseInt(localStorage.getItem('voltcore_idb_last_backup') || '0', 10);
      } catch (e) {
        VC.logError('03-idb.backups.autoIfNeeded', 'lecture timestamp échouée', e);
        return Promise.resolve({ skipped: true });
      }

      if (Date.now() - lastTs < 24 * 3600 * 1000) {
        return Promise.resolve({ skipped: true });
      }

      /* Snapshot : sérialise toutes les clés localStorage voltcore_* */
      var payload = {};
      try {
        for (var i = 0; i < localStorage.length; i++) {
          var k = localStorage.key(i);
          if (k && k.indexOf(VC.STORAGE_PREFIX) === 0) {
            var v = localStorage.getItem(k);
            if (v !== null) payload[k] = v;
          }
        }
      } catch (e) {
        VC.logError('03-idb.backups.autoIfNeeded', 'snapshot localStorage échoué', e);
        return Promise.resolve({ error: e.message });
      }

      return I.backups.save(payload).then(function (res) {
        try {
          localStorage.setItem('voltcore_idb_last_backup', String(Date.now()));
        } catch (e) {
          VC.logError('03-idb.backups.autoIfNeeded', 'écriture timestamp échouée', e);
        }
        /* Nettoyage : garde les 7 derniers */
        I.backups.clean(VC.IDB_KEEP_BACKUPS).catch(function (e) {
          VC.logError('03-idb.backups.autoIfNeeded', 'clean échoué', e);
        });
        return { ok: true, id: res.id, size: res.size };
      }).catch(function (e) {
        VC.logError('03-idb.backups.autoIfNeeded', 'save échoué', e);
        return { error: e.message };
      });
    }
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 6 — FILE SYSTEM ACCESS
     ═══════════════════════════════════════════════════════════ */

  I.fs = {

    isSupported: function () {
      try {
        return typeof global.showDirectoryPicker === 'function';
      } catch (e) {
        VC.logError('03-idb.fs.isSupported', 'check échoué', e);
        return false;
      }
    },

    saveHandle: function (handle) {
      return new Promise(function (resolve, reject) {
        if (!handle) {
          reject(new Error('handle requis'));
          return;
        }
        _txn(VC.IDB_STORE_FSHANDLES, 'readwrite', function (store) {
          return store.put({
            id: VC.FS_HANDLE_ID,
            handle: handle,
            name: String(handle.name || 'documents'),
            savedAt: new Date().toISOString()
          });
        }).then(function () {
          resolve(true);
        }).catch(function (e) {
          VC.logError('03-idb.fs.saveHandle', 'save échoué', e);
          reject(e);
        });
      });
    },

    getHandle: function () {
      if (!I.fs.isSupported()) return Promise.resolve(null);
      return _txn(VC.IDB_STORE_FSHANDLES, 'readonly', function (store) {
        return store.get(VC.FS_HANDLE_ID);
      }).then(function (record) {
        return record ? record.handle : null;
      }).catch(function (e) {
        VC.logError('03-idb.fs.getHandle', 'get échoué', e);
        return null;
      });
    },

    clearHandle: function () {
      return _txn(VC.IDB_STORE_FSHANDLES, 'readwrite', function (store) {
        return store.delete(VC.FS_HANDLE_ID);
      }).then(function () {
        return true;
      }).catch(function (e) {
        VC.logError('03-idb.fs.clearHandle', 'clear échoué', e);
        return false;
      });
    },

    verifyPermission: function (handle, requestIfNeeded) {
      return new Promise(function (resolve) {
        if (!handle) {
          resolve(false);
          return;
        }
        var opts = { mode: 'readwrite' };
        if (typeof handle.queryPermission !== 'function') {
          resolve(false);
          return;
        }
        handle.queryPermission(opts).then(function (perm) {
          if (perm === 'granted') {
            resolve(true);
            return;
          }
          if (!requestIfNeeded) {
            resolve(false);
            return;
          }
          if (typeof handle.requestPermission !== 'function') {
            resolve(false);
            return;
          }
          handle.requestPermission(opts).then(function (p2) {
            resolve(p2 === 'granted');
          }).catch(function (e) {
            VC.logError('03-idb.fs.verifyPermission', 'request échoué', e);
            resolve(false);
          });
        }).catch(function (e) {
          VC.logError('03-idb.fs.verifyPermission', 'query échoué', e);
          resolve(false);
        });
      });
    },

    /**
     * Écrit un fichier dans le dossier, sous year/month/filename.
     * Crée les sous-dossiers au besoin.
     */
    writeFile: function (handle, filename, blob) {
      return new Promise(function (resolve, reject) {
        if (!handle || !filename || !blob) {
          reject(new Error('handle/filename/blob requis'));
          return;
        }
        var now = new Date();
        var year = String(now.getFullYear());
        var month = String(now.getMonth() + 1).padStart(2, '0');

        handle.getDirectoryHandle(year, { create: true }).then(function (yearDir) {
          return yearDir.getDirectoryHandle(month, { create: true });
        }).then(function (monthDir) {
          return monthDir.getFileHandle(filename, { create: true });
        }).then(function (fileHandle) {
          return fileHandle.createWritable();
        }).then(function (writable) {
          return writable.write(blob).then(function () {
            return writable.close();
          });
        }).then(function () {
          resolve({ ok: true, relativePath: year + '/' + month + '/' + filename });
        }).catch(function (e) {
          VC.logError('03-idb.fs.writeFile', 'write échoué pour ' + filename, e);
          reject(e);
        });
      });
    },

    /**
     * Scan récursif du dossier (profondeur max).
     * Retourne Array<{ path, name, size, file }>.
     * Collecte les entries sans for-await (compatible ES5 strict).
     */
    scanDir: function (handle, maxDepth) {
      var depth = (typeof maxDepth === 'number') ? maxDepth : 2;
      var extAccepted = ['.jpg', '.jpeg', '.png', '.webp', '.pdf'];

      function isAccepted(name) {
        var lower = String(name || '').toLowerCase();
        for (var i = 0; i < extAccepted.length; i++) {
          if (lower.slice(-extAccepted[i].length) === extAccepted[i]) return true;
        }
        return false;
      }

      function collectEntries(dirHandle) {
        return new Promise(function (resolve, reject) {
          var entries = [];
          var iterator;
          try {
            iterator = dirHandle.values();
          } catch (e) {
            reject(e);
            return;
          }
          function next() {
            iterator.next().then(function (result) {
              if (result.done) {
                resolve(entries);
                return;
              }
              entries.push(result.value);
              next();
            }).catch(reject);
          }
          next();
        });
      }

      function walk(dirHandle, currentDepth, pathPrefix) {
        return collectEntries(dirHandle).then(function (entries) {
          var tasks = [];
          for (var i = 0; i < entries.length; i++) {
            var entry = entries[i];
            if (entry.kind === 'file') {
              if (!isAccepted(entry.name)) continue;
              tasks.push((function (fileEntry, relPath) {
                return fileEntry.getFile().then(function (f) {
                  return {
                    path: relPath + fileEntry.name,
                    name: fileEntry.name,
                    size: f.size,
                    file: f
                  };
                });
              })(entry, pathPrefix));
            } else if (entry.kind === 'directory' && currentDepth < depth) {
              tasks.push(walk(entry, currentDepth + 1, pathPrefix + entry.name + '/'));
            }
          }
          return Promise.all(tasks);
        });
      }

      return walk(handle, 0, '').then(function (results) {
        /* Aplatir (tasks contient soit des objets, soit des arrays de walk) */
        var flat = [];
        for (var i = 0; i < results.length; i++) {
          var r = results[i];
          if (Array.isArray(r)) {
            for (var j = 0; j < r.length; j++) flat.push(r[j]);
          } else if (r) {
            flat.push(r);
          }
        }
        return flat;
      }).catch(function (e) {
        VC.logError('03-idb.fs.scanDir', 'scan échoué', e);
        return [];
      });
    }
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 7 — INITIALISATION AUTOSAVE
     ═══════════════════════════════════════════════════════════ */

  /**
   * Démarre le timer d'autosave (backup IDB toutes les 24h).
   * Appelé une seule fois par 29-init.js.
   */
  I.initAutoBackup = function () {
    if (_autoBackupTimer) return;
    try {
      /* Backup initial au boot (si >24h) */
      I.backups.autoIfNeeded().then(function (res) {
        if (res && res.ok) {
          VC.logInfo('03-idb', 'Backup auto initial créé (id=' + res.id + ', size=' + res.size + ')');
        }
      }).catch(function (e) {
        VC.logError('03-idb.initAutoBackup', 'backup initial échoué', e);
      });

      /* Timer de 30 min (l'autoIfNeeded skip si <24h) */
      _autoBackupTimer = setInterval(function () {
        I.backups.autoIfNeeded().catch(function (e) {
          VC.logError('03-idb.initAutoBackup', 'timer backup échoué', e);
        });
      }, 30 * 60 * 1000);
    } catch (e) {
      VC.logError('03-idb.initAutoBackup', 'init timer échoué', e);
    }
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 8 — MARQUEUR
     ═══════════════════════════════════════════════════════════ */

  VC._idbLoaded = true;

  VC.logInfo('03-idb', 'IDB module chargé', {
    supported: I.isSupported(),
    version: VC.IDB_VERSION
  });

})(window);