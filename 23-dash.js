/* ═══════════════════════════════════════════════════════════
   VOLTCORE — 23-dash.js
   VERSION : v7.0.0
   RÔLE : Tableau de bord (KPIs + graphiques) + Rapports
          (TVA / Mensuel / Relances / Garanties).
          Chart.js lazy-loaded depuis CDN.
   DÉPENDANCES : 00-core, 01-utils, 02-store, 04-alerts, 06-clients,
                 09-chant, 12-inv-view
   ORDRE : 24ᵉ fichier chargé

   FIX v7.0.0 :
   - TVA déduite avoirs par facture parente (v6.8.1 préservé)
   - Chart instances détruites avant re-render (pas de fuite mémoire)
   - Tabs rapport pilotés par map explicite (case mismatch corrigé)
   - Graphiques protégés contre Chart.js indisponible

   RÈGLES :
   - ES5 strict
   - Aucun catch silencieux
   - Ne JAMAIS lire/écrire localStorage directement
   ═══════════════════════════════════════════════════════════ */

'use strict';

(function (global) {

  if (!global.VOLTCORE || !global.VOLTCORE.Store || !global.VOLTCORE.Utils) {
    throw new Error('[23-dash] Modules requis non chargés');
  }

  var VC = global.VOLTCORE;
  var U = VC.Utils;
  var S = VC.Store;
  var Doc = VC.Doc;
  var A = VC.Alerts;
  var Dash = VC.Dashboard || {};
  VC.Dashboard = Dash;

  /* ═══════════════════════════════════════════════════════════
     SECTION 1 — CONSTANTES + ÉTAT
     ═══════════════════════════════════════════════════════════ */

  var CHART_CDN = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js';

  var _chartJsLoaded = false;
  var _chartJsLoading = null;
  var _chartJsFailed = false;

  var _instances = {
    ca: null,
    familles: null,
    paiements: null,
    chantiers: null
  };

  var _currentReportTab = 'tva';

  var REPORT_TAB_IDS = {
    tva:       'tabReportTVA',
    monthly:   'tabReportMonthly',
    relances:  'tabReportRelances',
    garanties: 'tabReportGaranties'
  };

  var REPORT_BODY_IDS = {
    tva:       'tvaReportBody',
    monthly:   'monthlyReportBody',
    relances:  'relancesBody',
    garanties: 'garantiesBody'
  };

  var MOIS_FR = ['Jan', 'Fév', 'Mar', 'Avr', 'Mai', 'Juin',
                 'Juil', 'Août', 'Sep', 'Oct', 'Nov', 'Déc'];

  /* ═══════════════════════════════════════════════════════════
     SECTION 2 — CHART.JS LAZY LOAD
     ═══════════════════════════════════════════════════════════ */

  function _ensureChartJs() {
    if (global.Chart) {
      _chartJsLoaded = true;
      return Promise.resolve();
    }
    if (_chartJsFailed) {
      return Promise.reject(new Error('Chart.js indisponible'));
    }
    if (_chartJsLoading) return _chartJsLoading;

    _chartJsLoading = new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      script.src = CHART_CDN;
      script.async = true;
      script.onload = function () {
        _chartJsLoaded = true;
        _chartJsLoading = null;
        VC.logInfo('23-dash', 'Chart.js chargé');
        resolve();
      };
      script.onerror = function () {
        _chartJsFailed = true;
        _chartJsLoading = null;
        VC.logError('23-dash', 'Chart.js CDN inaccessible');
        reject(new Error('Chart.js CDN inaccessible'));
      };
      document.head.appendChild(script);
    });
    return _chartJsLoading;
  }

  function _destroyChart(key) {
    var inst = _instances[key];
    if (inst && typeof inst.destroy === 'function') {
      try { inst.destroy(); } catch (e) {
        VC.logError('23-dash', 'destroy chart ' + key + ' échoué', e);
      }
    }
    _instances[key] = null;
  }

  function _destroyAllCharts() {
    var keys = Object.keys(_instances);
    for (var i = 0; i < keys.length; i++) _destroyChart(keys[i]);
  }

  function _chartColors() {
    return ['#0b3d91', '#2e7d32', '#d97706', '#7b1fa2', '#dc2626',
            '#0891b2', '#65a30d', '#ea580c', '#7c3aed', '#db2777'];
  }

  function _chartFmt(v) {
    var n = parseFloat(v) || 0;
    var a = Math.abs(n);
    if (a >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (a >= 1000) return (n / 1000).toFixed(0) + 'k';
    return String(Math.round(n));
  }

  function _setChartMessage(containerId, message) {
    var el = document.getElementById(containerId);
    if (el) el.innerHTML = '<div class="chart-message">' +
      U.escapeHtml(message) + '</div>';
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 3 — CALCULS (stats mensuelles, familles, paiements, chantiers)
     ═══════════════════════════════════════════════════════════ */

  function _computeMonthlyStats() {
    var out = [];
    var now = new Date();

    for (var i = 11; i >= 0; i--) {
      var d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      var key = d.getFullYear() + '-' +
        String(d.getMonth() + 1).padStart(2, '0');
      out.push({ month: key, ca: 0, achats: 0, frais: 0, rh: 0, marge: 0 });
    }

    var byKey = {};
    for (var j = 0; j < out.length; j++) byKey[out[j].month] = out[j];

    var docs = S.getAll('documents');
    for (var a = 0; a < docs.length; a++) {
      var doc = docs[a];
      if (!doc || doc.type !== 'facture') continue;
      if (doc.statut === 'annulee' || doc.annulee === true) continue;
      var m = String(doc.date || '').slice(0, 7);
      var rec = byKey[m];
      if (!rec) continue;
      rec.ca += Doc.getNetRevenu(doc);
    }

    var purchases = S.getAll('purchaseInvoices');
    for (var b = 0; b < purchases.length; b++) {
      var p = purchases[b];
      if (!p) continue;
      var mp = String(p.date || p.dateFacture || '').slice(0, 7);
      var rp = byKey[mp];
      if (!rp) continue;
      rp.achats += (typeof p.totalTTC === 'number') ? p.totalTTC
                  : (typeof p.total === 'number') ? p.total : 0;
    }

    var frais = S.getAll('frais');
    for (var c = 0; c < frais.length; c++) {
      var f = frais[c];
      if (!f) continue;
      var mf = String(f.date || '').slice(0, 7);
      var rf = byKey[mf];
      if (!rf) continue;
      rf.frais += U.parseNumber(f.montant);
    }

    var works = S.getAll('hrWorkEntries');
    var emps = S.getAll('hrEmployees');
    var rates = {};
    for (var e = 0; e < emps.length; e++) {
      if (emps[e] && emps[e].id) {
        rates[emps[e].id] = U.parseNumber(
          emps[e].hourlyRate != null ? emps[e].hourlyRate : emps[e].tauxHoraire
        );
      }
    }
    for (var h = 0; h < works.length; h++) {
      var w = works[h];
      if (!w) continue;
      var mw = String(w.date || '').slice(0, 7);
      var rw = byKey[mw];
      if (!rw) continue;
      var hrs = U.parseNumber(w.hours != null ? w.hours : w.heures);
      var rt = (w.rate != null) ? U.parseNumber(w.rate)
                                : (rates[w.employeeId] || 0);
      rw.rh += hrs * rt;
    }

    for (var x = 0; x < out.length; x++) {
      out[x].marge = out[x].ca - out[x].achats - out[x].frais - out[x].rh;
    }
    return out;
  }

  function _computeFamilleStats() {
    var articlesById = {};
    var articles = S.getAll('articles');
    for (var a = 0; a < articles.length; a++) {
      if (articles[a] && articles[a].id) {
        articlesById[String(articles[a].id)] = articles[a];
      }
    }

    var byFamille = {};
    var docs = S.getAll('documents');
    for (var i = 0; i < docs.length; i++) {
      var d = docs[i];
      if (!d || d.type !== 'facture') continue;
      if (d.statut === 'annulee' || d.annulee === true) continue;
      if (!Array.isArray(d.items)) continue;

      for (var j = 0; j < d.items.length; j++) {
        var it = d.items[j];
        if (!it) continue;
        var art = it.articleId ? articlesById[String(it.articleId)] : null;
        var fam = art ? String(art.famille || 'Sans famille') : 'Sans famille';
        var lt = U.computeLineTotal(it);
        byFamille[fam] = (byFamille[fam] || 0) + lt;
      }
    }

    var out = [];
    var keys = Object.keys(byFamille);
    for (var k = 0; k < keys.length; k++) {
      out.push({ famille: keys[k], total: byFamille[keys[k]] });
    }
    out.sort(function (x, y) { return y.total - x.total; });
    return out.slice(0, 8);
  }

  function _computePaiementModes() {
    var out = { espèces: 0, chèque: 0, virement: 0, traite: 0, autre: 0 };
    var docs = S.getAll('documents');

    for (var i = 0; i < docs.length; i++) {
      var d = docs[i];
      if (!d || !Array.isArray(d.paiements)) continue;

      for (var j = 0; j < d.paiements.length; j++) {
        var p = d.paiements[j];
        if (!p) continue;
        var m = String(p.mode || 'autre').toLowerCase();
        var montant = U.parseNumber(p.montant);
        if (m === 'espèces' || m === 'especes') out['espèces'] += montant;
        else if (m === 'chèque' || m === 'cheque') out['chèque'] += montant;
        else if (m === 'virement') out.virement += montant;
        else if (m === 'traite') out.traite += montant;
        else out.autre += montant;
      }
    }
    return out;
  }

  function _computeChantierMarges() {
    var out = [];
    var chantiers = S.getAll('chantiers');

    for (var i = 0; i < chantiers.length; i++) {
      var ch = chantiers[i];
      if (!ch || ch.statut === 'annule') continue;
      var m = A.computeChantierMarge(ch.id);
      out.push({
        nom: ch.nom || '(sans nom)',
        recettes: m.recettes,
        marge: m.marge
      });
    }

    out.sort(function (a, b) { return b.marge - a.marge; });
    return out.slice(0, 10);
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 4 — KPIs
     ═══════════════════════════════════════════════════════════ */

  Dash.renderKPIs = function () {
    var k = A.computeDashboardKPIs();

    U.setText('kpiCA', U.formatMoney(k.caTotal));
    U.setText('kpiCAMois', U.formatMoney(k.caMois));
    U.setText('kpiMarge', U.formatMoney(k.margeTotale));
    U.setText('kpiBenefice', U.formatMoney(k.beneficeNet));
    U.setText('kpiImpayes', U.formatMoney(k.impayes));
    U.setText('kpiNbFactures', String(k.nbFactures));
    U.setText('kpiNbClients', String(k.nbClients));
    U.setText('kpiNbChantiers', String(k.nbChantiers));
    U.setText('kpiNbAlertes', String(k.nbAlertes));
    U.setText('kpiGaranties', U.formatMoney(k.garantiesEnAttente));
    U.setText('kpiNbGaranties', String(k.nbGarantiesEnAttente));

    var bEl = document.getElementById('kpiBenefice');
    if (bEl) bEl.style.color = k.beneficeNet >= 0
      ? 'var(--success)' : 'var(--danger)';
    var mEl = document.getElementById('kpiMarge');
    if (mEl) mEl.style.color = k.margeTotale >= 0
      ? 'var(--success)' : 'var(--danger)';
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 5 — GRAPHIQUES
     ═══════════════════════════════════════════════════════════ */

  Dash.renderCharts = function () {
    _ensureChartJs().then(function () {
      _renderChartCA();
      _renderChartFamilles();
      _renderChartPaiements();
      _renderChartChantiers();
    }).catch(function (e) {
      var msg = 'Graphiques indisponibles (Chart.js CDN inaccessible).\n' +
        'Les KPIs restent à jour.';
      _setChartMessage('chartCAWrapper', msg);
      _setChartMessage('chartFamillesWrapper', msg);
      _setChartMessage('chartPaiementsWrapper', msg);
      _setChartMessage('chartMargeChantiersWrapper', msg);
      VC.logWarn('23-dash', 'renderCharts reporté', e);
    });
  };

  function _getOrCreateCanvas(wrapperId, canvasId) {
    var wrapper = document.getElementById(wrapperId);
    if (!wrapper) return null;

    var canvas = document.getElementById(canvasId);
    if (!canvas) {
      wrapper.innerHTML = '<canvas id="' + canvasId + '"></canvas>';
      canvas = document.getElementById(canvasId);
    }
    return canvas;
  }

  function _renderChartCA() {
    _destroyChart('ca');

    var canvas = _getOrCreateCanvas('chartCAWrapper', 'chartCA');
    if (!canvas) return;

    var monthly = _computeMonthlyStats();
    var labels = [];
    for (var i = 0; i < monthly.length; i++) {
      var parts = monthly[i].month.split('-');
      labels.push(MOIS_FR[parseInt(parts[1], 10) - 1] + ' ' + parts[0].slice(2));
    }

    var dataCA = [], dataMarge = [];
    for (var j = 0; j < monthly.length; j++) {
      dataCA.push(monthly[j].ca);
      dataMarge.push(monthly[j].marge);
    }

    _instances.ca = new global.Chart(canvas.getContext('2d'), {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [
          { label: 'CA', data: dataCA, backgroundColor: '#0b3d91', borderRadius: 4 },
          { label: 'Marge', data: dataMarge, backgroundColor: '#2e7d32', borderRadius: 4 }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'bottom' },
          tooltip: {
            callbacks: {
              label: function (ctx) {
                return ctx.dataset.label + ' : ' + U.formatMoney(ctx.raw);
              }
            }
          }
        },
        scales: {
          y: {
            beginAtZero: true,
            ticks: { callback: function (v) { return _chartFmt(v) + ' DT'; } }
          }
        }
      }
    });
  }

  function _renderChartFamilles() {
    _destroyChart('familles');

    var canvas = _getOrCreateCanvas('chartFamillesWrapper', 'chartFamilles');
    if (!canvas) return;

    var data = _computeFamilleStats();
    if (data.length === 0) {
      _setChartMessage('chartFamillesWrapper', 'Aucune donnée de famille.');
      return;
    }

    var labels = [], values = [];
    for (var i = 0; i < data.length; i++) {
      labels.push(data[i].famille);
      values.push(data[i].total);
    }

    _instances.familles = new global.Chart(canvas.getContext('2d'), {
      type: 'doughnut',
      data: {
        labels: labels,
        datasets: [{ data: values, backgroundColor: _chartColors() }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'right', labels: { boxWidth: 12 } },
          tooltip: {
            callbacks: {
              label: function (ctx) {
                return ctx.label + ' : ' + U.formatMoney(ctx.raw);
              }
            }
          }
        }
      }
    });
  }

  function _renderChartPaiements() {
    _destroyChart('paiements');

    var canvas = _getOrCreateCanvas('chartPaiementsWrapper', 'chartPaiements');
    if (!canvas) return;

    var modes = _computePaiementModes();
    var labels = [], values = [];
    var keys = ['espèces', 'chèque', 'virement', 'traite', 'autre'];
    for (var i = 0; i < keys.length; i++) {
      if (modes[keys[i]] > 0.001) {
        labels.push(keys[i]);
        values.push(modes[keys[i]]);
      }
    }

    if (labels.length === 0) {
      _setChartMessage('chartPaiementsWrapper', 'Aucun paiement enregistré.');
      return;
    }

    _instances.paiements = new global.Chart(canvas.getContext('2d'), {
      type: 'pie',
      data: {
        labels: labels,
        datasets: [{ data: values, backgroundColor: _chartColors() }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'right' },
          tooltip: {
            callbacks: {
              label: function (ctx) {
                return ctx.label + ' : ' + U.formatMoney(ctx.raw);
              }
            }
          }
        }
      }
    });
  }

  function _renderChartChantiers() {
    _destroyChart('chantiers');

    var canvas = _getOrCreateCanvas('chartMargeChantiersWrapper', 'chartMargeChantiers');
    if (!canvas) return;

    var data = _computeChantierMarges();
    if (data.length === 0) {
      _setChartMessage('chartMargeChantiersWrapper', 'Aucun chantier.');
      return;
    }

    var labels = [], values = [], colors = [];
    for (var i = 0; i < data.length; i++) {
      labels.push(data[i].nom);
      values.push(data[i].marge);
      colors.push(data[i].marge >= 0 ? '#2e7d32' : '#dc2626');
    }

    _instances.chantiers = new global.Chart(canvas.getContext('2d'), {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [{
          label: 'Marge',
          data: values,
          backgroundColor: colors,
          borderRadius: 4
        }]
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: function (ctx) {
                return 'Marge : ' + U.formatMoney(ctx.raw);
              }
            }
          }
        },
        scales: {
          x: { ticks: { callback: function (v) { return _chartFmt(v); } } }
        }
      }
    });
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 6 — RENDU GLOBAL
     ═══════════════════════════════════════════════════════════ */

  Dash.render = function () {
    Dash.renderKPIs();
    Dash.renderCharts();
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 7 — RAPPORT TVA
     ═══════════════════════════════════════════════════════════ */

  function _computeTVAReport(monthIso) {
    var out = {
      encaissee: { ht: 0, tva: 0, ttc: 0, count: 0, avoirsCount: 0 },
      deductible: { ht: 0, tva: 0, ttc: 0, count: 0 },
      net: 0
    };

    var prefix = String(monthIso || U.todayISO()).slice(0, 7);
    var docs = S.getAll('documents');

    /* Index des avoirs actifs par facture parente */
    var avoirsByFacture = {};
    for (var ai = 0; ai < docs.length; ai++) {
      var av = docs[ai];
      if (!av || av.type !== 'avoir') continue;
      if (av.statut === 'annulee' || av.annulee === true) continue;
      var parentId = String(av.parentFactureId || '');
      if (!parentId) continue;
      if (!avoirsByFacture[parentId]) avoirsByFacture[parentId] = [];
      avoirsByFacture[parentId].push(av);
    }

    /* Factures payées du mois, nettes d'avoirs */
    for (var i = 0; i < docs.length; i++) {
      var d = docs[i];
      if (!d || d.type !== 'facture') continue;
      if (d.statut === 'annulee' || d.annulee === true) continue;
      if (String(d.date || '').slice(0, 7) !== prefix) continue;

      var statut = Doc.getStatutPaiement(d);
      if (statut !== 'payee') continue;

      var t = d.totals || {};
      var htF = U.parseNumber(t.totalHT);
      var tvaF = U.parseNumber(t.tva);
      var ttcF = U.parseNumber(t.totalTTC);

      var avoirsLies = avoirsByFacture[String(d.id)] || [];
      for (var k = 0; k < avoirsLies.length; k++) {
        var avT = avoirsLies[k].totals || {};
        htF -= U.parseNumber(avT.totalHT);
        tvaF -= U.parseNumber(avT.tva);
        ttcF -= U.parseNumber(avT.totalTTC);
        out.encaissee.avoirsCount++;
      }

      out.encaissee.ht += htF;
      out.encaissee.tva += tvaF;
      out.encaissee.ttc += ttcF;
      out.encaissee.count++;
    }

    /* Achats du mois */
    var purchases = S.getAll('purchaseInvoices');
    for (var j = 0; j < purchases.length; j++) {
      var p = purchases[j];
      if (!p) continue;
      var pDate = String(p.date || p.dateFacture || '').slice(0, 7);
      if (pDate !== prefix) continue;

      var tt = VC.Purchases
        ? VC.Purchases.computeTotals(p.lines, p.tvaRate, p.timbre)
        : { totalHT: 0, tva: 0, totalTTC: 0 };

      out.deductible.ht += tt.totalHT;
      out.deductible.tva += tt.tva;
      out.deductible.ttc += tt.totalTTC;
      out.deductible.count++;
    }

    out.net = out.encaissee.tva - out.deductible.tva;
    return out;
  }

  function _renderTVAReport() {
    var container = document.getElementById('tvaReportBody');
    if (!container) return;

    var monthInput = document.getElementById('tvaReportMonth');
    var month = monthInput && monthInput.value
      ? monthInput.value : U.todayISO().slice(0, 7);

    var r = _computeTVAReport(month);

    var html = '';
    html += '<div class="report-summary">';
    html += '<div class="report-block">';
    html += '<h4>TVA encaissée</h4>';
    html += '<div><strong>Factures payées</strong> : ' +
      r.encaissee.count + '</div>';
    if (r.encaissee.avoirsCount > 0) {
      html += '<div><strong>Avoirs déduits</strong> : ' +
        r.encaissee.avoirsCount + '</div>';
    }
    html += '<div>HT : ' + U.formatMoney(r.encaissee.ht) + '</div>';
    html += '<div>TVA : <strong>' + U.formatMoney(r.encaissee.tva) +
      '</strong></div>';
    html += '<div>TTC : ' + U.formatMoney(r.encaissee.ttc) + '</div>';
    html += '</div>';

    html += '<div class="report-block">';
    html += '<h4>TVA déductible</h4>';
    html += '<div><strong>Achats</strong> : ' + r.deductible.count + '</div>';
    html += '<div>HT : ' + U.formatMoney(r.deductible.ht) + '</div>';
    html += '<div>TVA : <strong>' + U.formatMoney(r.deductible.tva) +
      '</strong></div>';
    html += '<div>TTC : ' + U.formatMoney(r.deductible.ttc) + '</div>';
    html += '</div>';
    html += '</div>';

    var netColor = r.net >= 0 ? 'var(--danger)' : 'var(--success)';
    var netLabel = r.net >= 0 ? 'À payer' : 'Crédit de TVA';
    html += '<div class="report-net" style="border-color:' + netColor + '">';
    html += '<div class="report-net-label">' + netLabel + '</div>';
    html += '<div class="report-net-value" style="color:' + netColor + '">' +
      U.formatMoney(Math.abs(r.net)) + '</div>';
    html += '</div>';

    container.innerHTML = html;
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 8 — RAPPORT MENSUEL
     ═══════════════════════════════════════════════════════════ */

  function _renderMonthlyReport() {
    var container = document.getElementById('monthlyReportBody');
    if (!container) return;

    var stats = _computeMonthlyStats();
    var html = '<table class="report-table"><thead><tr>' +
      '<th>Mois</th><th class="right">CA</th><th class="right">Achats</th>' +
      '<th class="right">Frais</th><th class="right">RH</th>' +
      '<th class="right">Marge</th></tr></thead><tbody>';

    var totals = { ca: 0, achats: 0, frais: 0, rh: 0, marge: 0 };

    for (var i = 0; i < stats.length; i++) {
      var s = stats[i];
      var parts = s.month.split('-');
      var label = MOIS_FR[parseInt(parts[1], 10) - 1] + ' ' + parts[0];
      var margeColor = s.marge >= 0 ? 'var(--success)' : 'var(--danger)';
      totals.ca += s.ca; totals.achats += s.achats;
      totals.frais += s.frais; totals.rh += s.rh; totals.marge += s.marge;
      html += '<tr>' +
        '<td>' + U.escapeHtml(label) + '</td>' +
        '<td class="right">' + U.formatMoney(s.ca) + '</td>' +
        '<td class="right">' + U.formatMoney(s.achats) + '</td>' +
        '<td class="right">' + U.formatMoney(s.frais) + '</td>' +
        '<td class="right">' + U.formatMoney(s.rh) + '</td>' +
        '<td class="right" style="color:' + margeColor + '"><strong>' +
        U.formatMoney(s.marge) + '</strong></td>' +
        '</tr>';
    }

    var totColor = totals.marge >= 0 ? 'var(--success)' : 'var(--danger)';
    html += '<tr style="background:var(--bg-alt);font-weight:bold">' +
      '<td>TOTAL 12 MOIS</td>' +
      '<td class="right">' + U.formatMoney(totals.ca) + '</td>' +
      '<td class="right">' + U.formatMoney(totals.achats) + '</td>' +
      '<td class="right">' + U.formatMoney(totals.frais) + '</td>' +
      '<td class="right">' + U.formatMoney(totals.rh) + '</td>' +
      '<td class="right" style="color:' + totColor + '">' +
      U.formatMoney(totals.marge) + '</td></tr>';
    html += '</tbody></table>';

    container.innerHTML = html;
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 9 — RAPPORT RELANCES
     ═══════════════════════════════════════════════════════════ */

  function _renderRelances() {
    var container = document.getElementById('relancesBody');
    if (!container) return;

    var docs = S.getAll('documents');
    var relances = [];

    for (var i = 0; i < docs.length; i++) {
      var d = docs[i];
      if (!d || d.type !== 'facture') continue;
      if (d.statut === 'annulee' || d.annulee === true) continue;

      var reste = Doc.getResteAPayer(d);
      if (reste <= 0.001) continue;

      var dateStr = String(d.date || '').slice(0, 10);
      var days = 0;
      if (dateStr && U.isValidDateString(dateStr)) {
        var t = new Date(dateStr + 'T12:00:00').getTime();
        days = Math.max(0, Math.floor((Date.now() - t) / 86400000));
      }

      var client = d.clientId && VC.Clients
        ? VC.Clients.getById(d.clientId) : null;

      relances.push({
        doc: d,
        reste: reste,
        days: days,
        clientNom: client ? client.nom || '' : '—',
        telephone: client ? client.telephone || '' : '',
        email: client ? client.email || '' : ''
      });
    }

    relances.sort(function (a, b) { return b.days - a.days; });

    if (relances.length === 0) {
      container.innerHTML = '<div class="empty-state">Aucune relance en attente. 🎉</div>';
      return;
    }

    var html = '';
    for (var j = 0; j < relances.length; j++) {
      var r = relances[j];
      var dayColor = r.days > 60 ? 'var(--danger)'
        : r.days > 30 ? 'var(--warning)' : 'var(--muted)';
      var dayLabel = r.days === 0 ? 'Aujourd\'hui' : r.days + ' jour(s)';
      var docId = U.escapeAttr(r.doc.id);

      html += '<div class="relance-row">' +
        '<div class="relance-row-main">' +
          '<div class="relance-header">' +
            '<strong>' + U.escapeHtml(r.doc.numero || '—') + '</strong>' +
            ' <span class="badge" style="background:' + dayColor +
            ';color:#fff">' + U.escapeHtml(dayLabel) + '</span>' +
          '</div>' +
          '<div class="relance-meta">' + U.escapeHtml(r.clientNom) +
          ' · ' + U.escapeHtml(U.formatDate(String(r.doc.date || '').slice(0, 10))) +
          '</div>' +
          '<div class="relance-amount">Reste : ' +
          '<strong style="color:var(--danger)">' +
          U.formatMoney(r.reste) + '</strong></div>' +
        '</div>' +
        '<div class="relance-actions">' +
          (r.telephone
            ? '<button type="button" class="btn-icon" title="WhatsApp" ' +
              'onclick="VC.InvoicesView.shareWhatsApp(\'' + docId + '\')">💬</button>'
            : '') +
          (r.email
            ? '<button type="button" class="btn-icon" title="Email" ' +
              'onclick="VC.InvoicesView.shareEmail(\'' + docId + '\')">✉️</button>'
            : '') +
        '</div>' +
      '</div>';
    }
    container.innerHTML = html;
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 10 — RAPPORT GARANTIES
     ═══════════════════════════════════════════════════════════ */

  function _renderGarantiesReport() {
    var container = document.getElementById('garantiesBody');
    if (!container) return;

    var docs = S.getAll('documents');
    var enAttente = [], liberees = [];
    var totalEnAttente = 0, totalLiberees = 0;

    for (var i = 0; i < docs.length; i++) {
      var d = docs[i];
      if (!d || d.type !== 'facture') continue;

      var statut = Doc.getGarantieStatut(d);
      if (statut === 'en_attente') {
        var g = Doc.getGarantieEnAttente(d);
        totalEnAttente += g;
        enAttente.push({ doc: d, montant: g });
      } else if (statut === 'liberee') {
        var gl = Doc.getGarantieEnAttente(d);
        totalLiberees += gl;
        liberees.push({ doc: d, montant: gl });
      }
    }

    enAttente.sort(function (a, b) {
      return String(a.doc.date || '') < String(b.doc.date || '') ? 1 : -1;
    });
    liberees.sort(function (a, b) {
      return String(a.doc.dateLiberation || '') < String(b.doc.dateLiberation || '') ? 1 : -1;
    });

    var html = '';

    html += '<div class="report-summary">';
    html += '<div class="report-block">';
    html += '<h4>🔒 Garanties en attente</h4>';
    html += '<div><strong>' + enAttente.length + '</strong> facture(s)</div>';
    html += '<div>Montant total : <strong style="color:var(--warning)">' +
      U.formatMoney(totalEnAttente) + '</strong></div>';
    html += '</div>';
    html += '<div class="report-block">';
    html += '<h4>✅ Garanties libérées</h4>';
    html += '<div><strong>' + liberees.length + '</strong> facture(s)</div>';
    html += '<div>Montant total : <strong style="color:var(--success)">' +
      U.formatMoney(totalLiberees) + '</strong></div>';
    html += '</div>';
    html += '</div>';

    if (enAttente.length > 0) {
      html += '<h3 style="margin-top:24px">Garanties à libérer</h3>';
      html += '<table class="report-table"><thead><tr>' +
        '<th>Facture</th><th>Client</th><th>Date facture</th>' +
        '<th class="right">Garantie</th><th></th>' +
        '</tr></thead><tbody>';

      for (var j = 0; j < enAttente.length; j++) {
        var it = enAttente[j];
        var cNom = '—';
        if (it.doc.clientId && VC.Clients) {
          var c = VC.Clients.getById(it.doc.clientId);
          if (c) cNom = c.nom || '—';
        }
        html += '<tr>' +
          '<td>' + U.escapeHtml(it.doc.numero || '—') + '</td>' +
          '<td>' + U.escapeHtml(cNom) + '</td>' +
          '<td>' + U.escapeHtml(U.formatDate(String(it.doc.date || '').slice(0, 10))) + '</td>' +
          '<td class="right">' + U.formatMoney(it.montant) + '</td>' +
          '<td><button type="button" class="btn btn-sm btn-primary" ' +
          'onclick="VC.InvoicesView.openLiberationGarantie(\'' +
          U.escapeAttr(it.doc.id) + '\')">🔓 Libérer</button></td>' +
          '</tr>';
      }
      html += '</tbody></table>';
    } else {
      html += '<div class="empty-state" style="margin-top:20px">' +
        'Aucune garantie en attente. 🎉</div>';
    }

    if (liberees.length > 0) {
      html += '<details style="margin-top:24px">';
      html += '<summary style="cursor:pointer;font-weight:600;padding:8px 0">' +
        'Historique des garanties libérées (' + liberees.length + ')</summary>';
      html += '<table class="report-table" style="margin-top:10px"><thead><tr>' +
        '<th>Facture</th><th>Libérée le</th><th class="right">Montant</th>' +
        '</tr></thead><tbody>';
      for (var k = 0; k < liberees.length; k++) {
        var lib = liberees[k];
        html += '<tr>' +
          '<td>' + U.escapeHtml(lib.doc.numero || '—') + '</td>' +
          '<td>' + U.escapeHtml(U.formatDate(lib.doc.dateLiberation || '')) + '</td>' +
          '<td class="right">' + U.formatMoney(lib.montant) + '</td>' +
          '</tr>';
      }
      html += '</tbody></table>';
      html += '</details>';
    }

    container.innerHTML = html;
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 11 — SWITCH REPORT TABS
     ═══════════════════════════════════════════════════════════ */

  function _switchReportTabUI() {
    var keys = Object.keys(REPORT_TAB_IDS);
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      var tabEl = document.getElementById(REPORT_TAB_IDS[key]);
      if (tabEl) tabEl.classList.toggle('active', key === _currentReportTab);
      var bodyEl = document.getElementById(REPORT_BODY_IDS[key]);
      if (bodyEl) bodyEl.style.display = (key === _currentReportTab) ? '' : 'none';
    }
  }

  Dash.setReportTab = function (tab) {
    _currentReportTab = tab || 'tva';
    _switchReportTabUI();
    Dash.renderCurrentReport();
  };

  Dash.renderCurrentReport = function () {
    if (_currentReportTab === 'tva') _renderTVAReport();
    else if (_currentReportTab === 'monthly') _renderMonthlyReport();
    else if (_currentReportTab === 'relances') _renderRelances();
    else if (_currentReportTab === 'garanties') _renderGarantiesReport();
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 12 — EVENTS
     ═══════════════════════════════════════════════════════════ */

  Dash.attachEvents = function () {
    var keys = Object.keys(REPORT_TAB_IDS);
    for (var i = 0; i < keys.length; i++) {
      (function (key) {
        U.on(REPORT_TAB_IDS[key], 'click', function () {
          Dash.setReportTab(key);
        });
      })(keys[i]);
    }

    U.on('tvaReportMonth', 'change', _renderTVAReport);

    /* Re-render auto sur changement de données */
    S.subscribe('documents', function () {
      if (_currentReportTab === 'tva') _renderTVAReport();
      else if (_currentReportTab === 'relances') _renderRelances();
      else if (_currentReportTab === 'garanties') _renderGarantiesReport();
    });
    S.subscribe('purchaseInvoices', function () {
      if (_currentReportTab === 'tva') _renderTVAReport();
    });
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 13 — MARQUEUR
     ═══════════════════════════════════════════════════════════ */

  /* ═══════════════════════════════════════════════════════════
     FIX R6 — Re-render auto du dashboard sur changement de données
     ═══════════════════════════════════════════════════════════
     Guard : ne rend que si la section dashboard est visible.
     Évite les re-renders inutiles (Chart.js coûteux). */

  (function _watchDashboardSources() {
    var watchList = ['documents', 'purchaseInvoices', 'frais',
                     'hrWorkEntries', 'hrEmployees', 'clients', 'chantiers'];
    for (var i = 0; i < watchList.length; i++) {
      S.subscribe(watchList[i], (function () {
        try {
          var dashEl = document.getElementById('dashboardSection');
          if (dashEl && dashEl.style.display !== 'none') {
            /* FIX R6-perf : ne re-render QUE les KPIs (coût ~5ms)
               au lieu de tout le dashboard (Charts = ~200ms).
               Les graphiques se rafraîchissent au prochain clic
               manuel sur "Dashboard" dans la sidebar. */
            Dash.renderKPIs();
          }
        } catch (e) {
          VC.logError('23-dash', 'subscribe render échoué', e);
        }
      }));
    }
  })();

  VC._dashLoaded = true;

  VC.logInfo('23-dash', 'Module chargé (Chart.js lazy, 4 rapports, auto-refresh)');

})(window);