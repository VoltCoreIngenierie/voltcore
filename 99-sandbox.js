/* ═══════════════════════════════════════════════════════════
   VOLTCORE — 99-sandbox.js
   VERSION : v7.0.7
   RÔLE : Staging de nouvelles fonctions AVANT intégration.
          Mini test-runner console. Aucune interaction avec
          les données de production.

   ACTIVATION :
     Décommenter dans index.html :
       <script src="./99-sandbox.js"></script>

   USAGE CONSOLE :
     Sandbox.add('maFn', function(a) { return a * 2; },
                 function() { return Sandbox.fn.maFn(2) === 4; });
     Sandbox.runAll();
     → ✅ maFn : OK
     → ❌ autreFn : FAIL (résultat 4, attendu 5)

   RÈGLES :
   - Aucun try/catch silencieux
   - Aucune écriture dans Store/IDB/localStorage
   - Namespace isolé (window.Sandbox)
   ═══════════════════════════════════════════════════════════ */

'use strict';

(function (global) {

  if (global.Sandbox) return;

  var SB = {
    fn: {},
    tests: {},
    results: []
  };

  /* ═══════ §1 — ENREGISTREMENT ═══════ */

  SB.add = function (name, fn, test) {
    if (!name || typeof name !== 'string') {
      console.error('[Sandbox] add: nom invalide');
      return false;
    }
    if (typeof fn !== 'function') {
      console.error('[Sandbox] add(' + name + '): fn doit être une fonction');
      return false;
    }

    SB.fn[name] = fn;
    SB.tests[name] = (typeof test === 'function') ? test : null;

    console.log('[Sandbox] +' + name + (test ? ' (test fourni)' : ' (sans test)'));
    return true;
  };

  SB.remove = function (name) {
    delete SB.fn[name];
    delete SB.tests[name];
  };

  SB.list = function () {
    return Object.keys(SB.fn);
  };

  /* ═══════ §2 — EXÉCUTION ═══════ */

  SB.run = function (name) {
    var fn = SB.fn[name];
    var test = SB.tests[name];

    if (!fn) {
      console.warn('[Sandbox] run(' + name + '): inconnu');
      return null;
    }
    if (!test) {
      console.warn('[Sandbox] run(' + name + '): pas de test');
      return null;
    }

    var started = performance.now ? performance.now() : Date.now();
    var ok = false;
    var error = null;

    try {
      var ret = test();
      if (ret && typeof ret.then === 'function') {
        /* Test async : retourne Promise */
        return ret.then(function (res) {
          var ms = ((performance.now ? performance.now() : Date.now()) - started).toFixed(1);
          var entry = { name: name, ok: !!res, ms: ms, error: null };
          SB.results.push(entry);
          _log(entry);
          return entry;
        }).catch(function (e) {
          var ms = ((performance.now ? performance.now() : Date.now()) - started).toFixed(1);
          var entry = { name: name, ok: false, ms: ms, error: e && e.message };
          SB.results.push(entry);
          _log(entry);
          return entry;
        });
      }
      ok = !!ret;
    } catch (e) {
      ok = false;
      error = e && e.message ? e.message : String(e);
    }

    var ms = ((performance.now ? performance.now() : Date.now()) - started).toFixed(1);
    var entry = { name: name, ok: ok, ms: ms, error: error };
    SB.results.push(entry);
    _log(entry);
    return entry;
  };

  SB.runAll = function () {
    var names = Object.keys(SB.fn);
    SB.results = [];

    console.log('═══ Sandbox run ' + names.length + ' test(s) ═══');

    var promises = [];
    for (var i = 0; i < names.length; i++) {
      var r = SB.run(names[i]);
      if (r && typeof r.then === 'function') promises.push(r);
    }

    if (promises.length === 0) {
      _summary();
      return Promise.resolve(SB.results);
    }
    return Promise.all(promises).then(function () {
      _summary();
      return SB.results;
    });
  };

  function _log(entry) {
    var mark = entry.ok ? '✅' : '❌';
    var msg = '[Sandbox] ' + mark + ' ' + entry.name + ' (' + entry.ms + ' ms)';
    if (entry.ok) console.log(msg);
    else console.error(msg + (entry.error ? ' — ' + entry.error : ''));
  }

  function _summary() {
    var total = SB.results.length;
    var pass = 0, fail = 0;
    for (var i = 0; i < SB.results.length; i++) {
      if (SB.results[i].ok) pass++;
      else fail++;
    }
    console.log('═══ Résumé : ' + pass + '/' + total + ' ✅ · ' + fail + ' ❌ ═══');
  }

  /* ═══════ §3 — UTILITAIRES ═══════ */

  SB.clear = function () {
    SB.results = [];
    console.log('[Sandbox] résultats effacés');
  };

  SB.exportResults = function () {
    var json = JSON.stringify({
      date: new Date().toISOString(),
      total: SB.results.length,
      pass: SB.results.filter(function (r) { return r.ok; }).length,
      fail: SB.results.filter(function (r) { return !r.ok; }).length,
      results: SB.results
    }, null, 2);

    if (global.VOLTCORE && VOLTCORE.Utils && VOLTCORE.Utils.downloadBlob) {
      var blob = new Blob([json], { type: 'application/json' });
      VOLTCORE.Utils.downloadBlob(blob, 'sandbox-results-' + Date.now() + '.json');
    } else {
      console.log(json);
    }
  };

  /* ═══════ §4 — EXEMPLES (à remplacer) ═══════ */

  SB.add('_exemple_addition',
    function (a, b) { return a + b; },
    function () { return SB.fn._exemple_addition(2, 3) === 5; }
  );

  SB.add('_exemple_parse',
    function (s) { return parseFloat(String(s).replace(',', '.')); },
    function () { return SB.fn._exemple_parse('12,5') === 12.5; }
  );

  SB.add('_exemple_async',
    function () { return Promise.resolve(42); },
    function () {
      return SB.fn._exemple_async().then(function (v) { return v === 42; });
    }
  );

  /* ═══════ §5 — INIT ═══════ */

  global.Sandbox = SB;

  console.log('%c🧪 Sandbox prêt — tape Sandbox.runAll() pour lancer',
    'color:#C9A84C;font-weight:bold;font-size:12px');
  console.log('   Ou Sandbox.add(nom, fn, test) pour ajouter un test.');

})(window);