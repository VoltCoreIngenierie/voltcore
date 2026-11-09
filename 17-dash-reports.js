/* ═══════════════════════════════════════════════════════════════
   VOLTCORE — 17-dash-reports.js
   VERSION : v6.7 (Session #3 — fix case mismatch onglet TVA,
                   map explicite reportTabIds)
   RÔLE : Dashboard (KPIs + graphiques) + Rapports (TVA, mensuel, relances)
   DÉPENDANCES : 01-core.js, 03-utils.js (helpers, computeLineTotal),
                 04-storage.js (getNetRevenu, getResteAPayer,
                  getStatutPaiement), 05-alerts.js (computeChantierMarge)
   EXPOSE : renderDashboard, renderDashboardKPIs, renderTVAReport,
            renderMonthlyReport, renderRelances, attachDashboardEvents,
            computeDashboardKPIs, computeMonthlyStats,
            computeFamilleStats, computePaiementModes,
            computeChantierMarges, computeTVAReport
   ═══════════════════════════════════════════════════════════════ */

/* ═══════════ SECTION 1 — CONSTANTES + ÉTAT ═══════════ */

var VOLTCORE_CHART_CDN = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js';

var __chartJsLoaded = false;
var __chartJsLoading = null;
var __chartJsFailed = false;
var __dashCurrentTab = 'dashboard';
var __reportsCurrentTab = 'tva';

/* v6.7 — Map explicite entre clé d'onglet et ID HTML.
   Avant, on construisait 'tabReport' + capitalize(clé), ce qui donnait
   'tabReportTva' au lieu de 'tabReportTVA' (ID réel dans index.html).
   Résultat : l'onglet TVA ne s'allumait jamais après un premier clic. */
var __reportTabIds = {
  tva:       'tabReportTVA',
  monthly:   'tabReportMonthly',
  relances:  'tabReportRelances',
  garanties: 'tabReportGaranties'
};

var __reportTabBodies = {
  tva:       'tvaReportBody',
  monthly:   'monthlyReportBody',
  relances:  'relancesBody',
  garanties: 'garantiesBody'
};

var MOIS_FR = ['Jan', 'Fév', 'Mar', 'Avr', 'Mai', 'Juin',
               'Juil', 'Août', 'Sep', 'Oct', 'Nov', 'Déc'];

/* ═══════════ SECTION 2 — LAZY CHART.JS ═══════════ */

function ensureChartJS() {
  if (window.Chart) {
    __chartJsLoaded = true;
    return Promise.resolve();
  }
  if (__chartJsFailed) {
    return Promise.reject(new Error('Chart.js indisponible (mode offline)'));
  }
  if (__chartJsLoading) return __chartJsLoading;

  __chartJsLoading = new Promise(function (resolve, reject) {
    try {
      var script = document.createElement('script');
      script.src = VOLTCORE_CHART_CDN;
      script.async = true;
      script.onload = function () {
        __chartJsLoaded = true;
        __chartJsLoading = null;
        console.log('✅ [Chart.js] chargé depuis CDN');
        resolve();
      };
      script.onerror = function () {
        __chartJsFailed = true;
        __chartJsLoading = null;
        console.warn('⚠️ [Chart.js] échec de chargement CDN');
        reject(new Error('Chart.js CDN inaccessible'));
      };
      document.head.appendChild(script);
    } catch (e) {
      __chartJsFailed = true;
      __chartJsLoading = null;
      reject(e);
    }
  });
  return __chartJsLoading;
}

function _setChartLoading(containerId, message) {
  try {
    var el = document.getElementById(containerId);
    if (!el) return;
    el.innerHTML = '<div class="chart-message">' + escapeHtml(message) + '</div>';
  } catch (e) {}
}

function _destroyChart(chartVar) {
  if (chartVar && typeof chartVar.destroy === 'function') {
    try { chartVar.destroy(); } catch (e) {}
  }
}

function _chartFmt(v) {
  var n = parseFloat(v) || 0;
  var a = Math.abs(n);
  if (a >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (a >= 1000) return (n / 1000).toFixed(0) + 'k';
  return String(Math.round(n));
}

function _chartColors() {
  return ['#0b3d91', '#2e7d32', '#d97706', '#7b1fa2', '#dc2626',
          '#0891b2', '#65a30d', '#ea580c', '#7c3aed', '#db2777'];
}

/* ═══════════ SECTION 3 — CALCULS KPI ═══════════ */

function computeDashboardKPIs() {
      var kpis = {
      caTotal: 0, caMois: 0, margeTotale: 0, beneficeNet: 0,
      impayes: 0, nbFactures: 0, nbClients: 0, nbChantiers: 0,
      achatsTotal: 0, fraisTotal: 0, rhTotal: 0, nbAlertes: 0,
      garantiesEnAttente: 0, nbGarantiesEnAttente: 0
    };
  try {
    var moisPrefix = todayISO().slice(0, 7);

    /* Factures actives + CA */
    if (Array.isArray(savedDocuments)) {
      for (var i = 0; i < savedDocuments.length; i++) {
        var d = savedDocuments[i];
        if (!d || d.type !== 'facture') continue;
        if (d.statut === 'annulee' || d.annulee === true) continue;
        
        var t = (d.totals && typeof d.totals.total === 'number')
              ? d.totals.total
              : (typeof d.totalTTC === 'number' ? d.totalTTC : 0);
        
        /* Déduire les avoirs pour le CA */
        var net = (typeof getNetRevenu === 'function') ? getNetRevenu(d) : t;
        
        kpis.caTotal += net;
        kpis.nbFactures++;
        var dDate = String(d.date || '').slice(0, 10);
        if (dDate.slice(0, 7) === moisPrefix) kpis.caMois += net;
        
        var reste = (typeof getResteAPayer === 'function') ? getResteAPayer(d) : 0;
        if (reste > 0.001) kpis.impayes += reste;
        /* v6.8 — Garanties en attente */
        if (typeof getGarantieStatut === 'function' && getGarantieStatut(d) === 'en_attente') {
          var g = getGarantieEnAttente(d);
          if (g > 0.001) {
            kpis.garantiesEnAttente += g;
            kpis.nbGarantiesEnAttente++;
          }
        }
      }
    }

    /* Achats */
    if (Array.isArray(purchaseInvoices)) {
      for (var j = 0; j < purchaseInvoices.length; j++) {
        var p = purchaseInvoices[j];
        if (!p) continue;
        var totalP = (typeof p.totalTTC === 'number') ? p.totalTTC
                   : (typeof p.total === 'number') ? p.total : 0;
        kpis.achatsTotal += totalP;
      }
    }

    /* Frais */
    if (Array.isArray(frais)) {
      for (var k = 0; k < frais.length; k++) {
        if (frais[k]) kpis.fraisTotal += parseNumber(frais[k].montant);
      }
    }

    /* RH */
    if (Array.isArray(hrWorkEntries) && Array.isArray(hrEmployees)) {
      var rateById = {};
      for (var e = 0; e < hrEmployees.length; e++) {
        if (hrEmployees[e] && hrEmployees[e].id) {
          rateById[hrEmployees[e].id] = parseNumber(
            hrEmployees[e].hourlyRate != null ? hrEmployees[e].hourlyRate : hrEmployees[e].tauxHoraire
          );
        }
      }
      for (var h = 0; h < hrWorkEntries.length; h++) {
        var w = hrWorkEntries[h];
        if (!w) continue;
        var hh = parseNumber(w.hours != null ? w.hours : w.heures);
        var rr = (w.rate != null) ? parseNumber(w.rate) : (rateById[w.employeeId] || 0);
        kpis.rhTotal += hh * rr;
      }
    }

    /* Clients / chantiers / alertes */
    if (Array.isArray(clients)) kpis.nbClients = clients.length;
    if (Array.isArray(savedChantiers)) {
      for (var c = 0; c < savedChantiers.length; c++) {
        if (savedChantiers[c] && savedChantiers[c].statut !== 'annule') kpis.nbChantiers++;
      }
    }
    if (typeof getAlertCounts === 'function') {
      try { kpis.nbAlertes = getAlertCounts().total; } catch (e) {}
    }

    /* NOTE v6.7 : beneficeNet = margeTotale intentionnellement.
       Sans suivi des impôts/taxes, on ne peut pas distinguer une vraie
       "marge" d'un "bénéfice net après impôt". Les deux KPIs affichent
       donc la même valeur. Si tu veux les différencier plus tard, il
       faudra ajouter le calcul de la TVA due et des charges fiscales. */
    kpis.margeTotale = kpis.caTotal - kpis.achatsTotal - kpis.fraisTotal - kpis.rhTotal;
    kpis.beneficeNet = kpis.margeTotale;

    return kpis;
  } catch (e) {
    console.warn('computeDashboardKPIs :', e);
    return kpis;
  }
}

/* ═══════════ SECTION 4 — CALCULS CHART ═══════════ */

function computeMonthlyStats() {
  var out = [];
  try {
    var now = new Date();
    for (var i = 11; i >= 0; i--) {
      var d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      var key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
      out.push({ month: key, ca: 0, achats: 0, frais: 0, rh: 0, marge: 0 });
    }
    var byKey = {};
    for (var j = 0; j < out.length; j++) byKey[out[j].month] = out[j];

    if (Array.isArray(savedDocuments)) {
      for (var a = 0; a < savedDocuments.length; a++) {
        var doc = savedDocuments[a];
        if (!doc || doc.type !== 'facture') continue;
        if (doc.statut === 'annulee' || doc.annulee === true) continue;
        var m = String(doc.date || '').slice(0, 7);
        var rec = byKey[m];
        if (!rec) continue;
        
        /* Déduire les avoirs */
        var net = (typeof getNetRevenu === 'function') ? getNetRevenu(doc) : 0;
        rec.ca += net;
      }
    }
    
    if (Array.isArray(purchaseInvoices)) {
      for (var b = 0; b < purchaseInvoices.length; b++) {
        var pi = purchaseInvoices[b];
        if (!pi) continue;
        var mp = String(pi.date || pi.dateFacture || '').slice(0, 7);
        var rp = byKey[mp];
        if (!rp) continue;
        rp.achats += (typeof pi.totalTTC === 'number') ? pi.totalTTC
                   : (typeof pi.total === 'number') ? pi.total : 0;
      }
    }
    
    if (Array.isArray(frais)) {
      for (var c = 0; c < frais.length; c++) {
        var f = frais[c];
        if (!f) continue;
        var mf = String(f.date || '').slice(0, 7);
        var rf = byKey[mf];
        if (!rf) continue;
        rf.frais += parseNumber(f.montant);
      }
    }
    
    if (Array.isArray(hrWorkEntries) && Array.isArray(hrEmployees)) {
      var rates = {};
      for (var e = 0; e < hrEmployees.length; e++) {
        if (hrEmployees[e] && hrEmployees[e].id) {
          rates[hrEmployees[e].id] = parseNumber(
            hrEmployees[e].hourlyRate != null ? hrEmployees[e].hourlyRate : hrEmployees[e].tauxHoraire
          );
        }
      }
      for (var h = 0; h < hrWorkEntries.length; h++) {
        var w = hrWorkEntries[h];
        if (!w) continue;
        var mw = String(w.date || '').slice(0, 7);
        var rw = byKey[mw];
        if (!rw) continue;
        var hrs = parseNumber(w.hours != null ? w.hours : w.heures);
        var rt = (w.rate != null) ? parseNumber(w.rate) : (rates[w.employeeId] || 0);
        rw.rh += hrs * rt;
      }
    }
    
    for (var x = 0; x < out.length; x++) {
      out[x].marge = out[x].ca - out[x].achats - out[x].frais - out[x].rh;
    }
    return out;
  } catch (e) {
    console.warn('computeMonthlyStats :', e);
    return out;
  }
}

/* LOT 4 — OPTIMISATION : computeFamilleStats avec index */
function computeFamilleStats() {
  var out = [];
  try {
    /* 1. Index alphabétique des articles */
    var articlesById = {};
    if (Array.isArray(savedArticles)) {
      for (var a = 0; a < savedArticles.length; a++) {
        if (savedArticles[a] && savedArticles[a].id) {
          articlesById[String(savedArticles[a].id)] = savedArticles[a];
        }
      }
    }

    /* 2. Une seule passe sur les documents */
    var byFamille = {};
    if (Array.isArray(savedDocuments)) {
      for (var i = 0; i < savedDocuments.length; i++) {
        var d = savedDocuments[i];
        if (!d || d.type !== 'facture') continue;
        if (d.statut === 'annulee' || d.annulee === true) continue;
        if (!Array.isArray(d.items)) continue;

        for (var j = 0; j < d.items.length; j++) {
          var it = d.items[j];
          if (!it) continue;

          /* Lookup O(1) */
          var art = it.articleId ? articlesById[String(it.articleId)] : null;
          var fam = art ? String(art.famille || 'Sans famille') : 'Sans famille';

          /* Inclure la remise via computeLineTotal (LOT 2) */
          var lt = (typeof computeLineTotal === 'function') 
            ? computeLineTotal(it) 
            : parseNumber(it.quantite) * parseNumber(it.prix);

          byFamille[fam] = (byFamille[fam] || 0) + lt;
        }
      }
    }

    for (var k in byFamille) {
      if (byFamille.hasOwnProperty(k)) out.push({ famille: k, total: byFamille[k] });
    }
    out.sort(function (a, b) { return b.total - a.total; });
    return out.slice(0, 8);
  } catch (e) { 
    console.warn('computeFamilleStats :', e); 
    return out; 
  }
}

function computePaiementModes() {
  var out = { espèces: 0, chèque: 0, virement: 0, traite: 0, autre: 0 };
  try {
    if (!Array.isArray(savedDocuments)) return out;
    for (var i = 0; i < savedDocuments.length; i++) {
      var d = savedDocuments[i];
      if (!d || !Array.isArray(d.paiements)) continue;
      for (var j = 0; j < d.paiements.length; j++) {
        var p = d.paiements[j];
        if (!p) continue;
        var m = String(p.mode || 'autre').toLowerCase();
        var montant = parseNumber(p.montant);
        if (m === 'espèces' || m === 'especes') out['espèces'] += montant;
        else if (m === 'chèque' || m === 'cheque') out['chèque'] += montant;
        else if (m === 'virement') out['virement'] += montant;
        else if (m === 'traite') out['traite'] += montant;
        else out.autre += montant;
      }
    }
    return out;
  } catch (e) { console.warn('computePaiementModes :', e); return out; }
}

function computeChantierMarges() {
  var out = [];
  try {
    if (!Array.isArray(savedChantiers)) return out;
    for (var i = 0; i < savedChantiers.length; i++) {
      var ch = savedChantiers[i];
      if (!ch || ch.statut === 'annule') continue;
      var m = (typeof computeChantierMarge === 'function')
        ? computeChantierMarge(ch.id)
        : { marge: 0, recettes: 0 };
      out.push({ nom: ch.nom || '(sans nom)', recettes: m.recettes, marge: m.marge });
    }
    out.sort(function (a, b) { return b.marge - a.marge; });
    return out.slice(0, 10);
  } catch (e) { console.warn('computeChantierMarges :', e); return out; }
}

/* ═══════════ SECTION 5 — RENDU DASHBOARD ═══════════ */

function renderDashboard() {
  try {
    renderDashboardKPIs();

    _setChartLoading('chartCAWrapper', 'Chargement des graphiques…');
    _setChartLoading('chartFamillesWrapper', 'Chargement des graphiques…');
    _setChartLoading('chartPaiementsWrapper', 'Chargement des graphiques…');
    _setChartLoading('chartMargeChantiersWrapper', 'Chargement des graphiques…');

    ensureChartJS().then(function () {
      renderDashboardCharts();
    }).catch(function (e) {
      var msg = 'Graphiques indisponibles (offline 1ère fois).\nLes KPIs restent à jour.';
      _setChartLoading('chartCAWrapper', msg);
      _setChartLoading('chartFamillesWrapper', msg);
      _setChartLoading('chartPaiementsWrapper', msg);
      _setChartLoading('chartMargeChantiersWrapper', msg);
    });
  } catch (e) { console.warn('renderDashboard :', e); }
}

function renderDashboardKPIs() {
  try {
    var k = computeDashboardKPIs();
    function setText(id, val) {
      try { var el = document.getElementById(id); if (el) el.textContent = val; } catch (e) {}
    }
    setText('kpiCA', formatMoney(k.caTotal));
    setText('kpiCAMois', formatMoney(k.caMois));
    setText('kpiMarge', formatMoney(k.margeTotale));
    setText('kpiBenefice', formatMoney(k.beneficeNet));
    setText('kpiImpayes', formatMoney(k.impayes));
    setText('kpiNbFactures', String(k.nbFactures));
    setText('kpiNbClients', String(k.nbClients));
    setText('kpiNbChantiers', String(k.nbChantiers));
    setText('kpiNbAlertes', String(k.nbAlertes));
    /* v6.8 — Garanties en attente */
    setText('kpiGaranties', formatMoney(k.garantiesEnAttente));
    setText('kpiNbGaranties', String(k.nbGarantiesEnAttente));

    try {
      var bEl = document.getElementById('kpiBenefice');
      if (bEl) bEl.style.color = k.beneficeNet >= 0 ? 'var(--success)' : 'var(--danger)';
      var mEl = document.getElementById('kpiMarge');
      if (mEl) mEl.style.color = k.margeTotale >= 0 ? 'var(--success)' : 'var(--danger)';
    } catch (e) {}
  } catch (e) { console.warn('renderDashboardKPIs :', e); }
}

/* ═══════════ SECTION 6 — RENDU GRAPHIQUES ═══════════ */

function renderDashboardCharts() {
  try {
    if (!window.Chart) return;
    _renderChartCA();
    _renderChartFamilles();
    _renderChartPaiements();
    _renderChartMargeChantiers();
  } catch (e) { console.warn('renderDashboardCharts :', e); }
}

function _renderChartCA() {
  try {
    _setChartLoading('chartCAWrapper', '');
    var wrapper = document.getElementById('chartCAWrapper');
    if (!wrapper) return;

    var canvas = document.getElementById('chartCA');
    if (!canvas) {
      wrapper.innerHTML = '<canvas id="chartCA"></canvas>';
      canvas = document.getElementById('chartCA');
    }
    if (!canvas) return;

    var monthly = computeMonthlyStats();
    var labels = [];
    for (var i = 0; i < monthly.length; i++) {
      var parts = monthly[i].month.split('-');
      labels.push(MOIS_FR[parseInt(parts[1], 10) - 1] + ' ' + parts[0].slice(2));
    }

    _destroyChart(chartCAInstance);
    var ctx = canvas.getContext('2d');
    chartCAInstance = new window.Chart(ctx, {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [{
          label: 'CA', data: monthly.map(function (m) { return m.ca; }),
          backgroundColor: '#0b3d91', borderRadius: 4
        }, {
          label: 'Marge', data: monthly.map(function (m) { return m.marge; }),
          backgroundColor: '#2e7d32', borderRadius: 4
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { position: 'bottom' },
          tooltip: { callbacks: { label: function (ctx) { return ctx.dataset.label + ' : ' + formatMoney(ctx.raw); } } }
        },
        scales: {
          y: { beginAtZero: true, ticks: { callback: function (v) { return _chartFmt(v) + ' DT'; } } }
        }
      }
    });
  } catch (e) { console.warn('_renderChartCA :', e); }
}

function _renderChartFamilles() {
  try {
    _setChartLoading('chartFamillesWrapper', '');
    var wrapper = document.getElementById('chartFamillesWrapper');
    if (!wrapper) return;
    var canvas = document.getElementById('chartFamilles');
    if (!canvas) {
      wrapper.innerHTML = '<canvas id="chartFamilles"></canvas>';
      canvas = document.getElementById('chartFamilles');
    }
    if (!canvas) return;

    var data = computeFamilleStats();
    if (data.length === 0) {
      wrapper.innerHTML = '<div class="chart-message">Aucune donnée de famille.</div>';
      return;
    }

    _destroyChart(chartFamillesInstance);
    var ctx = canvas.getContext('2d');
    chartFamillesInstance = new window.Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: data.map(function (d) { return d.famille; }),
        datasets: [{ data: data.map(function (d) { return d.total; }), backgroundColor: _chartColors() }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { position: 'right', labels: { boxWidth: 12 } },
          tooltip: { callbacks: { label: function (ctx) { return ctx.label + ' : ' + formatMoney(ctx.raw); } } }
        }
      }
    });
  } catch (e) { console.warn('_renderChartFamilles :', e); }
}

function _renderChartPaiements() {
  try {
    _setChartLoading('chartPaiementsWrapper', '');
    var wrapper = document.getElementById('chartPaiementsWrapper');
    if (!wrapper) return;
    var canvas = document.getElementById('chartPaiements');
    if (!canvas) {
      wrapper.innerHTML = '<canvas id="chartPaiements"></canvas>';
      canvas = document.getElementById('chartPaiements');
    }
    if (!canvas) return;

    var modes = computePaiementModes();
    var labels = [], vals = [];
    var keys = ['espèces', 'chèque', 'virement', 'traite', 'autre'];
    for (var i = 0; i < keys.length; i++) {
      if (modes[keys[i]] > 0.001) {
        labels.push(keys[i]);
        vals.push(modes[keys[i]]);
      }
    }
    if (labels.length === 0) {
      wrapper.innerHTML = '<div class="chart-message">Aucun paiement enregistré.</div>';
      return;
    }

    _destroyChart(chartPaiementsInstance);
    var ctx = canvas.getContext('2d');
    chartPaiementsInstance = new window.Chart(ctx, {
      type: 'pie',
      data: { labels: labels, datasets: [{ data: vals, backgroundColor: _chartColors() }] },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { position: 'right' },
          tooltip: { callbacks: { label: function (ctx) { return ctx.label + ' : ' + formatMoney(ctx.raw); } } }
        }
      }
    });
  } catch (e) { console.warn('_renderChartPaiements :', e); }
}

function _renderChartMargeChantiers() {
  try {
    _setChartLoading('chartMargeChantiersWrapper', '');
    var wrapper = document.getElementById('chartMargeChantiersWrapper');
    if (!wrapper) return;
    var canvas = document.getElementById('chartMargeChantiers');
    if (!canvas) {
      wrapper.innerHTML = '<canvas id="chartMargeChantiers"></canvas>';
      canvas = document.getElementById('chartMargeChantiers');
    }
    if (!canvas) return;

    var data = computeChantierMarges();
    if (data.length === 0) {
      wrapper.innerHTML = '<div class="chart-message">Aucun chantier.</div>';
      return;
    }

    _destroyChart(chartMargeChantiersInstance);
    var ctx = canvas.getContext('2d');
    chartMargeChantiersInstance = new window.Chart(ctx, {
      type: 'bar',
      data: {
        labels: data.map(function (d) { return d.nom; }),
        datasets: [{
          label: 'Marge', data: data.map(function (d) { return d.marge; }),
          backgroundColor: data.map(function (d) { return d.marge >= 0 ? '#2e7d32' : '#dc2626'; }),
          borderRadius: 4
        }]
      },
      options: {
        indexAxis: 'y', responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: function (ctx) { return 'Marge : ' + formatMoney(ctx.raw); } } }
        },
        scales: { x: { ticks: { callback: function (v) { return _chartFmt(v); } } } }
      }
    });
  } catch (e) { console.warn('_renderChartMargeChantiers :', e); }
}

/* ═══════════ SECTION 7 — RAPPORT TVA ═══════════ */

function computeTVAReport(monthIso) {
  var out = {
    encaissee: { ht: 0, tva: 0, ttc: 0, count: 0, avoirsCount: 0 },
    deductible: { ht: 0, tva: 0, ttc: 0, count: 0 },
    net: 0
  };
  try {
    var prefix = String(monthIso || todayISO()).slice(0, 7);

    /* TVA encaissée : factures ENTIÈREMENT payées du mois, NETTES d'avoirs.
       NOTE v6.7 : on ne compte que les factures 'payee'. Les factures
       'partielle' sont exclues (régime TVA sur encaissement strict).
       NOTE v6.8.1 : les avoirs liés (parentFactureId) sont maintenant
       déduits. Avant, on comptait la TVA brute des factures sans retirer
       la TVA des avoirs → TVA surévaluée → déclaration erronée.
       Approche fiscale retenue : la TVA d'un avoir est déduite au moment
       où sa FACTURE PARENTE est encaissée, quel que soit le mois
       d'émission de l'avoir. Cela évite de créer un crédit de TVA fictif
       sur une facture non encore payée.
       Un avoir orphelin (parentFactureId inexistant) n'est jamais déduit
       et émet un warning console. */
    if (Array.isArray(savedDocuments)) {
      /* 1. Index des avoirs actifs par facture parente (une seule passe) */
      var avoirsByFacture = {};
      for (var ai = 0; ai < savedDocuments.length; ai++) {
        var av = savedDocuments[ai];
        if (!av || av.type !== 'avoir') continue;
        if (av.statut === 'annulee' || av.annulee === true) continue;
        var parentId = String(av.parentFactureId || '');
        if (!parentId) continue;
        if (!avoirsByFacture[parentId]) avoirsByFacture[parentId] = [];
        avoirsByFacture[parentId].push(av);
      }
      /* 2. Factures payées du mois, nettes d'avoirs */
      for (var i = 0; i < savedDocuments.length; i++) {
        var d = savedDocuments[i];
        if (!d || d.type !== 'facture') continue;
        if (d.statut === 'annulee' || d.annulee === true) continue;
        if (String(d.date || '').slice(0, 7) !== prefix) continue;
        var statut = (typeof getStatutPaiement === 'function') ? getStatutPaiement(d) : 'impayee';
        if (statut !== 'payee') continue;

        var t = d.totals || {};
        var htF = parseNumber(t.totalHT);
        var tvaF = parseNumber(t.tva);
        var ttcF = parseNumber(t.totalTTC);

        /* 3. Déduire les avoirs liés (HT + TVA + TTC) */
        var avoirsLies = avoirsByFacture[String(d.id)] || [];
        for (var k = 0; k < avoirsLies.length; k++) {
          var avT = avoirsLies[k].totals || {};
          htF -= parseNumber(avT.totalHT);
          tvaF -= parseNumber(avT.tva);
          ttcF -= parseNumber(avT.totalTTC);
          out.encaissee.avoirsCount++;
        }

        out.encaissee.ht += htF;
        out.encaissee.tva += tvaF;
        out.encaissee.ttc += ttcF;
        out.encaissee.count++;
      }
      /* 4. Warning si avoirs orphelins (facture parente introuvable) */
      var orphanAvoirs = 0;
      for (var aid in avoirsByFacture) {
        if (!avoirsByFacture.hasOwnProperty(aid)) continue;
        var factureExists = savedDocuments.some(function (x) {
          return x && String(x.id) === aid && x.type === 'facture';
        });
        if (!factureExists) orphanAvoirs += avoirsByFacture[aid].length;
      }
      if (orphanAvoirs > 0) {
        try {
          console.warn('[TVA] ' + orphanAvoirs +
            ' avoir(s) orphelin(s) — parentFactureId introuvable, TVA non déduite.');
        } catch (e) {}
      }
    }

    if (Array.isArray(purchaseInvoices)) {
      for (var j = 0; j < purchaseInvoices.length; j++) {
        var p = purchaseInvoices[j];
        if (!p) continue;
        var pDate = String(p.date || p.dateFacture || '').slice(0, 7);
        if (pDate !== prefix) continue;
        var tt = (typeof computePurchaseTotals === 'function')
          ? computePurchaseTotals(p.lines, p.tvaRate, p.timbre)
          : { totalHT: 0, tva: 0, totalTTC: 0 };
        out.deductible.ht += tt.totalHT;
        out.deductible.tva += tt.tva;
        out.deductible.ttc += tt.totalTTC;
        out.deductible.count++;
      }
    }

    out.net = out.encaissee.tva - out.deductible.tva;
    return out;
  } catch (e) { console.warn('computeTVAReport :', e); return out; }
}

function renderTVAReport() {
  try {
    var container = document.getElementById('tvaReportBody');
    if (!container) return;

    var monthInput = document.getElementById('tvaReportMonth');
    var month = monthInput && monthInput.value ? monthInput.value : todayISO().slice(0, 7);
    var r = computeTVAReport(month);

    var html = '';
    html += '<div class="report-summary">';
    html += '<div class="report-block">';
    html += '<h4>TVA encaissée</h4>';
    html += '<div><strong>Factures payées</strong> : ' + r.encaissee.count + '</div>';
    html += '<div>HT : ' + formatMoney(r.encaissee.ht) + '</div>';
    html += '<div>TVA : <strong>' + formatMoney(r.encaissee.tva) + '</strong></div>';
    html += '<div>TTC : ' + formatMoney(r.encaissee.ttc) + '</div>';
    html += '</div>';

    html += '<div class="report-block">';
    html += '<h4>TVA déductible</h4>';
    html += '<div><strong>Achats</strong> : ' + r.deductible.count + '</div>';
    html += '<div>HT : ' + formatMoney(r.deductible.ht) + '</div>';
    html += '<div>TVA : <strong>' + formatMoney(r.deductible.tva) + '</strong></div>';
    html += '<div>TTC : ' + formatMoney(r.deductible.ttc) + '</div>';
    html += '</div>';
    html += '</div>';

    var netColor = r.net >= 0 ? 'var(--danger)' : 'var(--success)';
    var netLabel = r.net >= 0 ? 'À payer' : 'Crédit de TVA';
    html += '<div class="report-net" style="border-color:' + netColor + '">';
    html += '<div class="report-net-label">' + netLabel + '</div>';
    html += '<div class="report-net-value" style="color:' + netColor + '">' + formatMoney(Math.abs(r.net)) + '</div>';
    html += '</div>';

    container.innerHTML = html;
  } catch (e) { console.warn('renderTVAReport :', e); }
}

/* ═══════════ SECTION 8 — RAPPORT MENSUEL ═══════════ */

function renderMonthlyReport() {
  try {
    var container = document.getElementById('monthlyReportBody');
    if (!container) return;

    var stats = computeMonthlyStats();
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
        '<td>' + escapeHtml(label) + '</td>' +
        '<td class="right">' + formatMoney(s.ca) + '</td>' +
        '<td class="right">' + formatMoney(s.achats) + '</td>' +
        '<td class="right">' + formatMoney(s.frais) + '</td>' +
        '<td class="right">' + formatMoney(s.rh) + '</td>' +
        '<td class="right" style="color:' + margeColor + '"><strong>' + formatMoney(s.marge) + '</strong></td>' +
        '</tr>';
    }
    var totColor = totals.marge >= 0 ? 'var(--success)' : 'var(--danger)';
    html += '<tr style="background:var(--bg-alt);font-weight:bold">' +
      '<td>TOTAL 12 MOIS</td>' +
      '<td class="right">' + formatMoney(totals.ca) + '</td>' +
      '<td class="right">' + formatMoney(totals.achats) + '</td>' +
      '<td class="right">' + formatMoney(totals.frais) + '</td>' +
      '<td class="right">' + formatMoney(totals.rh) + '</td>' +
      '<td class="right" style="color:' + totColor + '">' + formatMoney(totals.marge) + '</td></tr>';
    html += '</tbody></table>';

    container.innerHTML = html;
  } catch (e) { console.warn('renderMonthlyReport :', e); }
}

/* ═══════════ SECTION 9 — RELANCES ═══════════ */

function renderRelances() {
  try {
    var container = document.getElementById('relancesBody');
    if (!container) return;

    var relances = [];
    if (Array.isArray(savedDocuments)) {
      for (var i = 0; i < savedDocuments.length; i++) {
        var d = savedDocuments[i];
        if (!d || d.type !== 'facture') continue;
        if (d.statut === 'annulee' || d.annulee === true) continue;
        var reste = (typeof getResteAPayer === 'function') ? getResteAPayer(d) : 0;
        if (reste <= 0.001) continue;
        var dateStr = String(d.date || '').slice(0, 10);
        var days = 0;
        if (dateStr && isValidDateString(dateStr)) {
          var t = new Date(dateStr + 'T12:00:00').getTime();
          days = Math.max(0, Math.floor((Date.now() - t) / 86400000));
        }
        var client = d.clientId && typeof getClientById === 'function' ? getClientById(d.clientId) : null;
        relances.push({
          doc: d, reste: reste, days: days,
          clientNom: client ? client.nom || '' : '—',
          clientId: d.clientId || '',
          telephone: client ? client.telephone || '' : '',
          email: client ? client.email || '' : ''
        });
      }
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
                    : r.days > 30 ? 'var(--warning)'
                    : 'var(--muted)';
      var dayLabel = r.days === 0 ? 'Aujourd\'hui' : r.days + ' jour(s)';
      var docId = escapeAttr(r.doc.id);
      html += '<div class="relance-row">' +
        '<div class="relance-row-main">' +
          '<div class="relance-header">' +
            '<strong>' + escapeHtml(r.doc.numero || '—') + '</strong>' +
            ' <span class="badge" style="background:' + dayColor + ';color:#fff">' + escapeHtml(dayLabel) + '</span>' +
          '</div>' +
          '<div class="relance-meta">' + escapeHtml(r.clientNom) + ' · ' + escapeHtml(formatDate(String(r.doc.date || '').slice(0, 10))) + '</div>' +
          '<div class="relance-amount">Reste : <strong style="color:var(--danger)">' + formatMoney(r.reste) + '</strong></div>' +
        '</div>' +
        '<div class="relance-actions">' +
          (r.telephone ? '<button type="button" class="btn-icon" title="WhatsApp" onclick="sendRelanceWhatsApp(\'' + docId + '\')">💬</button>' : '') +
          (r.email ? '<button type="button" class="btn-icon" title="Email" onclick="sendRelanceEmail(\'' + docId + '\')">✉️</button>' : '') +
        '</div>' +
      '</div>';
    }
    container.innerHTML = html;
  } catch (e) { console.warn('renderRelances :', e); }
}

function sendRelanceWhatsApp(docId) {
  try {
    if (!Array.isArray(savedDocuments)) return;
    var d = null;
    for (var i = 0; i < savedDocuments.length; i++) {
      if (savedDocuments[i] && String(savedDocuments[i].id) === String(docId)) {
        d = savedDocuments[i]; break;
      }
    }
    if (!d) return;
    var client = d.clientId && typeof getClientById === 'function' ? getClientById(d.clientId) : null;
    var reste = (typeof getResteAPayer === 'function') ? getResteAPayer(d) : 0;
    var days = 0;
    var dateStr = String(d.date || '').slice(0, 10);
    if (dateStr && isValidDateString(dateStr)) {
      days = Math.max(0, Math.floor((Date.now() - new Date(dateStr + 'T12:00:00').getTime()) / 86400000));
    }
    var text = 'Bonjour ' + (client ? client.nom || '' : '') + ',\n\n' +
      'Rappel amical : votre facture N° ' + (d.numero || '') +
      ' du ' + formatDate(dateStr) + ' reste impayée depuis ' + days + ' jour(s).\n' +
      'Montant restant : ' + formatMoney(reste) + '\n\n' +
      'Merci de bien vouloir régulariser.\n\n' +
      'Cordialement,\nVOLTCORE INGENIERIE';
    var phone = client && client.telephone ? String(client.telephone).replace(/[^\d]/g, '') : '';
    var url = phone ? 'https://wa.me/' + phone + '?text=' + encodeURIComponent(text)
                    : 'https://wa.me/?text=' + encodeURIComponent(text);
    window.open(url, '_blank');
  } catch (e) { console.warn('sendRelanceWhatsApp :', e); }
}

function sendRelanceEmail(docId) {
  try {
    if (!Array.isArray(savedDocuments)) return;
    var d = null;
    for (var i = 0; i < savedDocuments.length; i++) {
      if (savedDocuments[i] && String(savedDocuments[i].id) === String(docId)) {
        d = savedDocuments[i]; break;
      }
    }
    if (!d) return;
    var client = d.clientId && typeof getClientById === 'function' ? getClientById(d.clientId) : null;
    var reste = (typeof getResteAPayer === 'function') ? getResteAPayer(d) : 0;
    var subject = 'Relance facture N° ' + (d.numero || '');
    var body = 'Bonjour ' + (client ? client.nom || '' : '') + ',\n\n' +
      'Sauf erreur de notre part, la facture N° ' + (d.numero || '') +
      ' du ' + formatDate(String(d.date || '').slice(0, 10)) +
      ' reste impayée.\nMontant dû : ' + formatMoney(reste) + '\n\n' +
      'Merci de bien vouloir régulariser.\n\n' +
      'Cordialement,\nVOLTCORE INGENIERIE';
    var email = client && client.email ? client.email : '';
    window.location.href = 'mailto:' + encodeURIComponent(email) +
      '?subject=' + encodeURIComponent(subject) +
      '&body=' + encodeURIComponent(body);
  } catch (e) { console.warn('sendRelanceEmail :', e); }
}

/* ═══════════ SECTION 10 — ÉVÉNEMENTS ═══════════ */

function attachDashboardEvents() {
  try {
    var dashTab = document.getElementById('tabDashboard');
    if (dashTab && !dashTab.__bound) {
      dashTab.__bound = true;
      dashTab.addEventListener('click', function () {
        __dashCurrentTab = 'dashboard';
        _switchDashTabUI();
        renderDashboard();
      });
    }
    var reportsTab = document.getElementById('tabReports');
    if (reportsTab && !reportsTab.__bound) {
      reportsTab.__bound = true;
      reportsTab.addEventListener('click', function () {
        __dashCurrentTab = 'reports';
        _switchDashTabUI();
        renderReportsCurrentTab();
      });
    }

    /* v6.7 — Onglets rapports : boucle sur la map explicite */
    var reportKeys = Object.keys(__reportTabIds);
    for (var i = 0; i < reportKeys.length; i++) {
      (function (key) {
        var idEl = document.getElementById(__reportTabIds[key]);
        if (idEl && !idEl.__bound) {
          idEl.__bound = true;
          idEl.addEventListener('click', function () {
            __reportsCurrentTab = key;
            _switchReportTabUI();
            renderReportsCurrentTab();
          });
        }
      })(reportKeys[i]);
    }

    var monthInput = document.getElementById('tvaReportMonth');
    if (monthInput && !monthInput.__bound) {
      monthInput.__bound = true;
      monthInput.addEventListener('change', renderTVAReport);
    }
  } catch (e) { console.warn('attachDashboardEvents :', e); }
}

function _switchDashTabUI() {
  try {
    var dDash = document.getElementById('dashboardSection');
    var dRep = document.getElementById('reportsSection');
    if (dDash) dDash.style.display = __dashCurrentTab === 'dashboard' ? '' : 'none';
    if (dRep) dRep.style.display = __dashCurrentTab === 'reports' ? '' : 'none';

    var t1 = document.getElementById('tabDashboard');
    var t2 = document.getElementById('tabReports');
    if (t1) t1.classList.toggle('active', __dashCurrentTab === 'dashboard');
    if (t2) t2.classList.toggle('active', __dashCurrentTab === 'reports');
  } catch (e) {}
}

/* v6.7 — Corrigé : utilise les map explicites au lieu de construire
   l'ID dynamiquement. Avant, __reportsCurrentTab === 'tva' produisait
   'tabReportTva' au lieu de 'tabReportTVA' → l'onglet ne s'allumait
   jamais correctement. */
function _switchReportTabUI() {
  try {
    var keys = Object.keys(__reportTabIds);
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      var tabEl = document.getElementById(__reportTabIds[key]);
      if (tabEl) tabEl.classList.toggle('active', key === __reportsCurrentTab);
      var bodyEl = document.getElementById(__reportTabBodies[key]);
      if (bodyEl) bodyEl.style.display = (key === __reportsCurrentTab) ? '' : 'none';
    }
  } catch (e) { console.warn('_switchReportTabUI :', e); }
}

function renderReportsCurrentTab() {
  try {
    if (__reportsCurrentTab === 'tva') renderTVAReport();
    else if (__reportsCurrentTab === 'monthly') renderMonthlyReport();
    else if (__reportsCurrentTab === 'relances') renderRelances();
    else if (__reportsCurrentTab === 'garanties') renderGarantiesReport();
  } catch (e) { console.warn('renderReportsCurrentTab :', e); }
}


/* ═══════════ v6.8 — RAPPORT GARANTIES EN ATTENTE ═══════════ */

function renderGarantiesReport() {
  try {
    var container = document.getElementById('garantiesBody');
    if (!container) return;

    if (typeof getGarantieStatut !== 'function') {
      container.innerHTML = '<div class="empty-state">Module garantie non chargé.</div>';
      return;
    }

    var enAttente = [];
    var liberees = [];
    var totalEnAttente = 0, totalLiberees = 0;

    if (Array.isArray(savedDocuments)) {
      for (var i = 0; i < savedDocuments.length; i++) {
        var d = savedDocuments[i];
        if (!d || d.type !== 'facture') continue;
        var statut = getGarantieStatut(d);
        if (statut === 'en_attente') {
          var g = getGarantieEnAttente(d);
          totalEnAttente += g;
          enAttente.push({ doc: d, montant: g });
        } else if (statut === 'liberee') {
          var gl = getGarantieEnAttente(d);
          totalLiberees += gl;
          liberees.push({ doc: d, montant: gl });
        }
      }
    }

    /* Tri par date décroissante */
    enAttente.sort(function (a, b) {
      var da = String(a.doc.date || ''), db = String(b.doc.date || '');
      return da < db ? 1 : -1;
    });
    liberees.sort(function (a, b) {
      var da = String(a.doc.dateLiberation || a.doc.date || '');
      var db = String(b.doc.dateLiberation || b.doc.date || '');
      return da < db ? 1 : -1;
    });

    var html = '';

    /* Bloc résumé */
    html += '<div class="report-summary">';
    html += '<div class="report-block">';
    html += '<h4>🔒 Garanties en attente</h4>';
    html += '<div><strong>' + enAttente.length + '</strong> facture(s)</div>';
    html += '<div>Montant total : <strong style="color:var(--warning)">' +
      formatMoney(totalEnAttente) + '</strong></div>';
    html += '</div>';
    html += '<div class="report-block">';
    html += '<h4>✅ Garanties libérées</h4>';
    html += '<div><strong>' + liberees.length + '</strong> facture(s)</div>';
    html += '<div>Montant total : <strong style="color:var(--success)">' +
      formatMoney(totalLiberees) + '</strong></div>';
    html += '</div>';
    html += '</div>';

    /* Bloc en attente */
    if (enAttente.length > 0) {
      html += '<h3 style="margin-top:24px">Garanties à libérer</h3>';
      html += '<table class="report-table"><thead><tr>' +
        '<th>Facture</th><th>Client</th><th>Date facture</th>' +
        '<th class="right">Garantie</th><th></th>' +
        '</tr></thead><tbody>';
      for (var j = 0; j < enAttente.length; j++) {
        var it = enAttente[j];
        var clientNom = _docClientNom ? _docClientNom(it.doc).nom : '—';
        html += '<tr>' +
          '<td>' + escapeHtml(it.doc.numero || '—') + '</td>' +
          '<td>' + escapeHtml(clientNom) + '</td>' +
          '<td>' + escapeHtml(formatDate(String(it.doc.date || '').slice(0, 10))) + '</td>' +
          '<td class="right">' + formatMoney(it.montant) + '</td>' +
          '<td><button type="button" class="btn btn-sm btn-primary" ' +
          'onclick="openLiberationGarantieModal(\'' + escapeAttr(it.doc.id) + '\')">🔓 Libérer</button></td>' +
          '</tr>';
      }
      html += '</tbody></table>';
    } else {
      html += '<div class="empty-state" style="margin-top:20px">Aucune garantie en attente. 🎉</div>';
    }

    /* Bloc historique (collapsible) */
    if (liberees.length > 0) {
      html += '<details style="margin-top:24px">';
      html += '<summary style="cursor:pointer;font-weight:600;padding:8px 0">' +
        'Historique des garanties libérées (' + liberees.length + ')</summary>';
      html += '<table class="report-table" style="margin-top:10px"><thead><tr>' +
        '<th>Facture</th><th>Client</th><th>Libérée le</th>' +
        '<th class="right">Montant</th>' +
        '</tr></thead><tbody>';
      for (var k = 0; k < liberees.length; k++) {
        var lib = liberees[k];
        var cNom = _docClientNom ? _docClientNom(lib.doc).nom : '—';
        html += '<tr>' +
          '<td>' + escapeHtml(lib.doc.numero || '—') + '</td>' +
          '<td>' + escapeHtml(cNom) + '</td>' +
          '<td>' + escapeHtml(formatDate(lib.doc.dateLiberation || '')) + '</td>' +
          '<td class="right">' + formatMoney(lib.montant) + '</td>' +
          '</tr>';
      }
      html += '</tbody></table>';
      html += '</details>';
    }

    container.innerHTML = html;
  } catch (e) {
    console.warn('renderGarantiesReport :', e);
    var c = document.getElementById('garantiesBody');
    if (c) c.innerHTML = '<div class="empty-state">Erreur de calcul.</div>';
  }
}
console.log('✅ 17-dash-reports.js chargé — v6.7 (onglet TVA corrigé, map explicite)');