/* ═══════════════════════════════════════════════════════════════
   VOLTCORE — 06-clients.js
   VERSION : v6.7 (Session #3 — renommage _csvCellClients pour
                   éviter la collision globale avec 14-expenses-bons,
                   bump version)
   RÔLE : CRUD clients complet, recherche, filtres, statistiques B5,
          import/export JSON+CSV, impression, suppression avec undo,
          enrichissements BTP (type, délai, retenue, gouvernorat,
          adresse chantier, relance impayé WhatsApp)
   DÉPENDANCES : 01-core.js (clients, trash, savedDocuments,
                            savedChantiers, currentUser),
                 03-utils.js (escapeHtml, escapeAttr, formatMoney,
                            normalizeText, showUndoToast, debounce,
                            todayISO, showToast, logAction),
                 04-storage.js (saveAll, getResteAPayer),
                 05-alerts.js (computeClientMarge)
   EXPOSE : getClientById, getClientName, clientExists,
            computeClientStats, invalidateClientStatsCache,
            renderClients, renderClientRow,
            openClientModal, closeClientModal, saveClientFromForm,
            deleteClient, openClientDetail, closeClientDetail,
            setClientsSearch, setClientsFilter, setClientsSort,
            getFilteredClients, exportClientsJSON, exportClientsCSV,
            importClientsJSON, printClientsList, attachClientsEvents,
            relancerImpayeClient
   SECTION 1  : ÉTAT + CONSTANTES + CACHES
   SECTION 2  : HELPERS CLIENTS (dont helpers BTP)
   SECTION 3  : STATISTIQUES (B5 + B8 + B9 + B10 avec cache)
   SECTION 4  : RENDU LISTE (badges retard/risque)
   SECTION 5  : RENDU DÉTAIL (infos BTP + relance impayé)
   SECTION 6  : FORMULAIRE AJOUT/ÉDITION (champs BTP)
   SECTION 7  : SUPPRESSION AVEC UNDO (B)
   SECTION 8  : RECHERCHE + FILTRES + TRI
   SECTION 9  : IMPORT/EXPORT (replace sécurisé)
   SECTION 10 : IMPRESSION
   SECTION 11 : ÉVÉNEMENTS
   ═══════════════════════════════════════════════════════════════ */

/* ═══════════ SECTION 1 — ÉTAT + CONSTANTES + CACHES ═══════════ */

var __clientsSearchTerm = '';
var __clientsFilter = 'all';
var __clientsSortField = 'nom';   /* 'nom' | 'ca' | 'marge' | 'impaye' | 'retard' */
var __clientsSortDir = 'asc';     /* 'asc' | 'desc' */
var __clientsLastDeleted = null;

/* Cache des statistiques par client (corrige BUG 4 + T1).
   TTL 30s + invalidation manuelle possible via invalidateClientStatsCache. */
var __clientStatsCache = {};
var CLIENT_STATS_CACHE_TTL_MS = 30000;

/* Cache de la liste filtrée (T3). Invalidé à chaque mutation. */
var __filteredClientsCache = null;

/* ═══════════ SECTION 2 — HELPERS CLIENTS ═══════════ */

/* Retourne un client par son ID, ou null. */
function getClientById(id) {
  try {
    if (!id || !Array.isArray(clients)) return null;
    var sid = String(id);
    for (var i = 0; i < clients.length; i++) {
      if (clients[i] && String(clients[i].id) === sid) return clients[i];
    }
    return null;
  } catch (e) {
    console.warn('getClientById :', e);
    return null;
  }
}

/* Retourne le nom d'un client par son ID. */
function getClientName(id) {
  var c = getClientById(id);
  if (!c) return '';
  return String(c.nom || c.name || '');
}

/* Vérifie si un client avec ce nom existe déjà.
   excludeId permet d'ignorer le client en cours d'édition. */
function clientExists(nom, excludeId) {
  try {
    if (!nom || !Array.isArray(clients)) return false;
    var normalized = normalizeText(nom);
    for (var i = 0; i < clients.length; i++) {
      var c = clients[i];
      if (!c) continue;
      if (excludeId && String(c.id) === String(excludeId)) continue;
      if (normalizeText(c.nom || c.name || '') === normalized) return true;
    }
    return false;
  } catch (e) {
    return false;
  }
}

/* Normalise un client : trim les champs texte, dédoublonne les espaces,
   prépare les champs BTP optionnels (B1→B6). */
function _normalizeClient(raw) {
  if (!raw || typeof raw !== 'object') return null;
  var out = {
    id: raw.id || ('cli_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)),
    nom: String(raw.nom || raw.name || '').trim().replace(/\s+/g, ' '),
    telephone: String(raw.telephone || '').trim(),
    email: String(raw.email || '').trim().toLowerCase(),
    adresse: String(raw.adresse || '').trim(),
    mf: String(raw.mf || raw.matriculeFiscale || '').trim(),
    cin: String(raw.cin || '').trim(),
    notes: String(raw.notes || '').trim(),
    /* ——— Enrichissements BTP Tunisie (tous optionnels) ——— */
    type: String(raw.type || 'particulier').trim().toLowerCase(),
    delaiPaiement: _clampInt(raw.delaiPaiement, 0, 365, 0),
    retenueSource: _clampFloat(raw.retenueSource, 0, 100, 0),
    gouvernorat: String(raw.gouvernorat || '').trim(),
    adresseChantier: String(raw.adresseChantier || '').trim(),
    codeTVA: String(raw.codeTVA || '').trim(),
    codeCategorie: String(raw.codeCategorie || '').trim(),
    createdAt: raw.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  if (!out.nom) return null;
  if (!_isValidClientType(out.type)) out.type = 'particulier';
  return out;
}

/* Helpers numériques (garde-fous). */
function _clampInt(v, min, max, def) {
  var n = parseInt(v, 10);
  if (isNaN(n)) return def;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}
function _clampFloat(v, min, max, def) {
  var n = parseFloat(v);
  if (isNaN(n)) return def;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

/* Types de client reconnus (B1). */
function _isValidClientType(t) {
  return t === 'particulier' || t === 'entreprise' ||
         t === 'administration' || t === 'sous-traitant';
}
function _getClientTypeLabel(t) {
  if (t === 'entreprise') return 'Entreprise';
  if (t === 'administration') return 'Administration';
  if (t === 'sous-traitant') return 'Sous-traitant';
  return 'Particulier';
}
function _getDelaiLabel(j) {
  var n = parseInt(j, 10);
  if (!n || n <= 0) return 'Comptant';
  return n + ' jours';
}

/* Cascade de téléchargement blindée (corrige BUG 2 + BUG 3 + T2).
   Ordre : downloadBlob (03-utils.js) → _fallbackDownload global → local. */
function _download06(blob, filename) {
  try {
    if (typeof downloadBlob === 'function') {
      downloadBlob(blob, filename);
      return;
    }
    if (typeof _fallbackDownload === 'function') {
      _fallbackDownload(blob, filename);
      return;
    }
    _fallbackDownload06(blob, filename);
  } catch (e) {
    console.warn('_download06 :', e);
    if (typeof showToast === 'function') showToast('Téléchargement impossible.', 'error');
  }
}

/* Version locale de secours — n'est utilisée QUE si aucun utilitaire
   global n'est disponible. Délai de révocation 30 s (corrige BUG 3). */
function _fallbackDownload06(blob, filename) {
  try {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () {
      try { URL.revokeObjectURL(url); } catch (e) {}
    }, 30000);
  } catch (e) {
    console.warn('_fallbackDownload06 :', e);
    if (typeof showToast === 'function') showToast('Export échoué.', 'error');
  }
}

/* ═══════════ SECTION 3 — STATISTIQUES (B5 + B8 + B9 + B10) ═══════════ */

/* Invalide le cache de stats.
   - clientId fourni : ne purge qu'un client
   - sinon : purge tout
   Exposé globalement pour permettre aux autres fichiers (11-invoices.js,
   09-chantiers.js, etc.) de purger quand ils modifient des données liées. */
function invalidateClientStatsCache(clientId) {
  try {
    if (clientId) {
      delete __clientStatsCache[String(clientId)];
    } else {
      __clientStatsCache = {};
    }
    __filteredClientsCache = null;
  } catch (e) {}
}

/* Retourne les stats d'un client (avec cache 30 s) :
   { nbFactures, nbChantiers, caTotal, marge, margePct, impaye,
     retardJours, derniereFactureDate, dernierPaiementDate, aRisque }
*/
function computeClientStats(clientId) {
  var empty = {
    nbFactures: 0, nbChantiers: 0, caTotal: 0, marge: 0, margePct: 0,
    impaye: 0, retardJours: 0, derniereFactureDate: '', dernierPaiementDate: '',
    aRisque: false
  };
  try {
    if (!clientId) return empty;
    var sid = String(clientId);

    /* Lecture cache */
    var cached = __clientStatsCache[sid];
    var now = Date.now();
    if (cached && (now - cached.at) < CLIENT_STATS_CACHE_TTL_MS) {
      return cached.stats;
    }

    /* Marge (B5) */
    var m = (typeof computeClientMarge === 'function')
      ? computeClientMarge(clientId)
      : { recettes: 0, marge: 0, margePct: 0, nbDocs: 0 };

    /* Impayés + retard + dates (B8, B9) */
    var impaye = 0;
    var retardJours = 0;
    var derniereFactureDate = '';
    var dernierPaiementDate = '';

    /* Délai de paiement du client (B2) */
    var client = getClientById(clientId);
    var delaiJ = client ? (client.delaiPaiement || 0) : 0;

    var today = new Date();
    today.setHours(0, 0, 0, 0);

    if (Array.isArray(savedDocuments)) {
      for (var i = 0; i < savedDocuments.length; i++) {
        var d = savedDocuments[i];
        if (!d || d.type !== 'facture') continue;
        if (String(d.clientId || '') !== sid) continue;
        if (d.statut === 'annulee' || d.annulee === true) continue;

        var r = (typeof getResteAPayer === 'function') ? getResteAPayer(d) : 0;
        if (r > 0) impaye += r;

        /* Date facture */
        var dFact = String(d.date || d.dateEmission || d.createdAt || '');
        if (dFact && (!derniereFactureDate || dFact > derniereFactureDate)) {
          derniereFactureDate = dFact;
        }

        /* Retard : jours depuis facture - délai - déjà payé ? (B8) */
        if (r > 0 && dFact) {
          var tsF = Date.parse(dFact);
          if (!isNaN(tsF)) {
            var dtF = new Date(tsF);
            dtF.setHours(0, 0, 0, 0);
            var jours = Math.floor((today.getTime() - dtF.getTime()) / 86400000);
            var retard = jours - delaiJ;
            if (retard > retardJours) retardJours = retard;
          }
        }

        /* Date dernier paiement (B9) */
        var paiements = d.paiements || d.payments || [];
        if (Array.isArray(paiements)) {
          for (var p = 0; p < paiements.length; p++) {
            var pmt = paiements[p];
            if (!pmt) continue;
            var dP = String(pmt.date || '');
            if (dP && (!dernierPaiementDate || dP > dernierPaiementDate)) {
              dernierPaiementDate = dP;
            }
          }
        }
      }
    }

    /* Nombre de chantiers */
    var nbChantiers = 0;
    if (Array.isArray(savedChantiers)) {
      for (var j = 0; j < savedChantiers.length; j++) {
        if (savedChantiers[j] && String(savedChantiers[j].clientId || '') === sid) {
          nbChantiers++;
        }
      }
    }

    /* Statut à risque (B10) : impayé > 30 % du CA et CA > 0 */
    var caTotal = m.recettes || 0;
    var aRisque = (caTotal > 0) && (impaye > 0.30 * caTotal);

    var result = {
      nbFactures: m.nbDocs || 0,
      nbChantiers: nbChantiers,
      caTotal: caTotal,
      marge: m.marge || 0,
      margePct: m.margePct || 0,
      impaye: impaye,
      retardJours: retardJours,
      derniereFactureDate: derniereFactureDate,
      dernierPaiementDate: dernierPaiementDate,
      aRisque: aRisque
    };

    __clientStatsCache[sid] = { stats: result, at: now };
    return result;
  } catch (e) {
    console.warn('computeClientStats :', e);
    return empty;
  }
}

/* ═══════════ SECTION 4 — RENDU LISTE ═══════════ */

/* Rendu principal de la liste clients. */
function renderClients() {
  try {
    var container = document.getElementById('clientsList');
    if (!container) return;

    var list = getFilteredClients();

    if (list.length === 0) {
      container.innerHTML = '<div class="empty-state">Aucun client' +
        (__clientsSearchTerm || __clientsFilter !== 'all' ? ' pour ce filtre' : '') +
        '. Clique sur "+ Nouveau client" pour commencer.</div>';
      _updateClientsCount(0);
      return;
    }

    var html = '';
    for (var i = 0; i < list.length; i++) {
      html += renderClientRow(list[i]);
    }
    container.innerHTML = html;
    _updateClientsCount(list.length);
  } catch (e) {
    console.warn('renderClients :', e);
  }
}

/* Rendu d'une ligne client. */
function renderClientRow(c) {
  try {
    if (!c) return '';
    /* Garde-fou escapeAttr (corrige BUG 6 / T7) */
    var escAttr = (typeof escapeAttr === 'function') ? escapeAttr : escapeHtml;
    var id = escAttr(c.id);
    var nom = escapeHtml(c.nom || '(Sans nom)');
    var tel = escapeHtml(c.telephone || '');
    var email = escapeHtml(c.email || '');
    var metaParts = [];
    if (tel) metaParts.push('📞 ' + tel);
    if (email) metaParts.push('✉️ ' + email);
    var typeLabel = _getClientTypeLabel(c.type);
    metaParts.push('<span class="muted">[' + escapeHtml(typeLabel) + ']</span>');
    var meta = metaParts.join(' · ');

    var stats = computeClientStats(c.id);

    /* Badge impayé (B5) */
    var badgeImpaye = '';
    if (stats.impaye > 0.001) {
      badgeImpaye = '<span class="badge badge-error" title="Impayés">' +
        formatMoney(stats.impaye) + '</span>';
    }

    /* Badge retard (B8) */
    var badgeRetard = '';
    if (stats.retardJours > 0) {
      badgeRetard = '<span class="badge badge-warning" title="Jours de retard">' +
        '⏰ ' + stats.retardJours + ' j</span>';
    }

    /* Badge client à risque (B10) */
    var badgeRisque = '';
    if (stats.aRisque) {
      badgeRisque = '<span class="badge badge-error" title="Client à risque">⚠️</span>';
    }

    return '<div class="client-row" data-client-id="' + id + '">' +
      '<div class="client-row-main">' +
        '<div class="client-row-name">' + nom + ' ' + badgeRisque + badgeImpaye + badgeRetard + '</div>' +
        '<div class="client-row-meta">' + meta + '</div>' +
      '</div>' +
      '<div class="client-row-actions">' +
        '<button type="button" class="btn-icon" title="Voir détail" ' +
          'onclick="openClientDetail(\'' + id + '\')">👁️</button>' +
        '<button type="button" class="btn-icon" title="Éditer" ' +
          'onclick="openClientModal(\'' + id + '\')">✏️</button>' +
        '<button type="button" class="btn-icon btn-danger" title="Supprimer" ' +
          'onclick="deleteClient(\'' + id + '\')">🗑️</button>' +
      '</div>' +
    '</div>';
  } catch (e) {
    console.warn('renderClientRow :', e);
    return '';
  }
}

/* Met à jour le compteur de clients affiché. */
function _updateClientsCount(n) {
  try {
    var el = document.getElementById('clientsCount');
    if (el) el.textContent = String(n);
  } catch (e) {}
}

/* ═══════════ SECTION 5 — RENDU DÉTAIL ═══════════ */

/* Ouvre la modale de détail d'un client. */
function openClientDetail(id) {
  try {
    var c = getClientById(id);
    if (!c) return;
    var modal = document.getElementById('clientDetailModal');
    var body = document.getElementById('clientDetailBody');
    var title = document.getElementById('clientDetailTitle');
    if (!modal || !body) return;

    if (title) title.textContent = c.nom || 'Client';

    var stats = computeClientStats(c.id);
    var margeColor = stats.margePct >= 0.10 ? 'var(--success)' :
                     stats.margePct >= 0 ? 'var(--warning)' : 'var(--danger)';

    var html = '';

    /* Bloc contact */
    html += '<div class="detail-section">';
    html += '<h3>Contact</h3>';
    html += '<div class="detail-grid">';
    html += _detailItem('Téléphone', c.telephone || '—');
    html += _detailItem('Email', c.email || '—');
    html += _detailItem('Adresse', c.adresse || '—');
    html += _detailItem('Type', _getClientTypeLabel(c.type));
    html += _detailItem('Gouvernorat', c.gouvernorat || '—');
    html += _detailItem('Adresse chantier', c.adresseChantier || '—');
    html += '</div>';
    html += '</div>';

    /* Bloc fiscal (B3, B6) */
    html += '<div class="detail-section">';
    html += '<h3>Fiscal &amp; paiement</h3>';
    html += '<div class="detail-grid">';
    html += _detailItem('MF', c.mf || '—');
    html += _detailItem('CIN', c.cin || '—');
    html += _detailItem('Code TVA', c.codeTVA || '—');
    html += _detailItem('Code catégorie', c.codeCategorie || '—');
    html += _detailItem('Délai paiement', _getDelaiLabel(c.delaiPaiement));
    html += _detailItem('Retenue source', (c.retenueSource || 0) + ' %');
    html += '</div>';
    html += '</div>';

    /* Bloc activité + B8/B9/B10 */
    html += '<div class="detail-section">';
    html += '<h3>Activité</h3>';
    html += '<div class="stats-grid">';
    html += _statItem('Factures', String(stats.nbFactures));
    html += _statItem('Chantiers', String(stats.nbChantiers));
    html += _statItem('CA total', formatMoney(stats.caTotal));
    html += _statItem('Marge', formatMoney(stats.marge), margeColor);
    html += _statItem('Marge %', (stats.margePct * 100).toFixed(1) + '%', margeColor);
    html += _statItem('Impayés', formatMoney(stats.impaye),
      stats.impaye > 0.001 ? 'var(--danger)' : '');
    html += _statItem('Retard', stats.retardJours > 0 ? (stats.retardJours + ' j') : '—',
      stats.retardJours > 0 ? 'var(--warning)' : '');
    html += _statItem('Dernière facture',
      stats.derniereFactureDate ? stats.derniereFactureDate.slice(0, 10) : '—');
    html += _statItem('Dernier paiement',
      stats.dernierPaiementDate ? stats.dernierPaiementDate.slice(0, 10) : '—');
    html += _statItem('À risque', stats.aRisque ? 'OUI' : 'non',
      stats.aRisque ? 'var(--danger)' : '');
    html += '</div>';
    html += '</div>';

    /* Bouton relance WhatsApp (B7) */
    if (stats.impaye > 0.001) {
      html += '<div class="detail-section">';
      html += '<h3>Relance</h3>';
      html += '<button type="button" class="btn btn-warning" ' +
        'onclick="relancerImpayeClient(\'' + escapeAttr(c.id) + '\')">' +
        '📲 Relancer via WhatsApp (' + formatMoney(stats.impaye) + ')</button>';
      html += '</div>';
    }

    if (c.notes) {
      html += '<div class="detail-section">';
      html += '<h3>Notes</h3>';
      html += '<p class="detail-notes">' + escapeHtml(c.notes).replace(/\n/g, '<br>') + '</p>';
      html += '</div>';
    }

    body.innerHTML = html;
    modal.style.display = 'flex';
  } catch (e) {
    console.warn('openClientDetail :', e);
  }
}

function closeClientDetail() {
  try {
    var modal = document.getElementById('clientDetailModal');
    if (modal) modal.style.display = 'none';
  } catch (e) {}
}

function _detailItem(label, value) {
  return '<div class="detail-item">' +
    '<div class="detail-label">' + escapeHtml(label) + '</div>' +
    '<div class="detail-value">' + escapeHtml(value) + '</div>' +
    '</div>';
}

function _statItem(label, value, color) {
  return '<div class="stat-item">' +
    '<div class="stat-value"' + (color ? ' style="color:' + color + '"' : '') + '>' +
    escapeHtml(value) + '</div>' +
    '<div class="stat-label">' + escapeHtml(label) + '</div>' +
    '</div>';
}

/* Envoie une relance WhatsApp pré-remplie (B7).
   Ouvre wa.me avec le numéro du client (format tunisien normalisé). */
function relancerImpayeClient(id) {
  try {
    var c = getClientById(id);
    if (!c) return;
    var tel = _normalizeTunisianPhone(c.telephone);
    if (!tel) {
      if (typeof showToast === 'function') {
        showToast('Aucun numéro de téléphone valide pour ce client.', 'warning');
      }
      return;
    }
    var stats = computeClientStats(c.id);
    var montant = formatMoney(stats.impaye);
    var msg = 'Bonjour ' + (c.nom || '') + ', ' +
      'nous vous rappelons que votre compte présente un solde impayé de ' +
      montant + ' TND. ' +
      'Merci de bien vouloir procéder au règlement. ' +
      'Cordialement, VOLTCORE INGENIERIE.';
    var url = 'https://wa.me/' + tel.replace(/^\+/, '') +
              '?text=' + encodeURIComponent(msg);
    window.open(url, '_blank');
    if (typeof logAction === 'function') {
      logAction('client.relance', c.nom || id);
    }
  } catch (e) {
    console.warn('relancerImpayeClient :', e);
  }
}

/* Normalise un numéro tunisien ou international en format E.164
   (+216XXXXXXXX pour la Tunisie). Utilisé par relancerImpayeClient
   (WhatsApp) et par le PDF de facture.

   v6.8.1 — Refonte robuste. Corrige les cas suivants :
     • '0021698765432'  → '+21698765432'   (préfixe international 00)
     • '123'            → ''               (trop court, rejeté)
     • '0'              → ''               (rejeté)
     • '+33 6 12 34 56 78' → '+33612345678' (numéro étranger préservé)
     • '012345678'      → '+21612345678'    (0 initial local → +216)
     • '21698765432'    → '+21698765432'    (sans + → +216)
     • '+216 98 765 432' → '+21698765432'  (espaces retirés)

   Retourne '' si le numéro est vide ou invalide (trop court / trop
   long), pour que l'appelant affiche « Aucun numéro valide ». */
function _normalizeTunisianPhone(tel) {
  try {
    if (!tel) return '';
    var s = String(tel).trim();
    if (!s) return '';

    /* 1. Retire tout sauf chiffres et + (espaces, tirets, points, parenthèses) */
    s = s.replace(/[^0-9+]/g, '');
    if (!s) return '';

    /* 2. Cas international avec + : '+XX...' (8 à 15 chiffres, norme E.164) */
    if (s.charAt(0) === '+') {
      var digitsPlus = s.slice(1);
      if (digitsPlus.length >= 8 && digitsPlus.length <= 15) {
        return '+' + digitsPlus;
      }
      return '';
    }

    /* 3. Cas préfixe international ancien '00' : '00XX...' → '+XX...' */
    if (s.indexOf('00') === 0) {
      var digitsDoubleZero = s.slice(2);
      if (digitsDoubleZero.length >= 8 && digitsDoubleZero.length <= 15) {
        return '+' + digitsDoubleZero;
      }
      return '';
    }

    /* 4. Cas '216XXXXXXXX' sans + (11 à 14 chiffres) → '+216XXXXXXXX' */
    if (s.indexOf('216') === 0 && s.length >= 11 && s.length <= 14) {
      return '+' + s;
    }

    /* 5. Cas '0XXXXXXXX' (9 chiffres, 0 initial) → '+216XXXXXXXX' */
    if (s.charAt(0) === '0' && s.length === 9) {
      return '+216' + s.slice(1);
    }

    /* 6. Cas 8 chiffres locaux → '+216XXXXXXXX' */
    if (s.length === 8) {
      return '+216' + s;
    }

    /* 7. Tout autre format → rejeté (numéro invalide) */
    return '';
  } catch (e) {
    console.warn('_normalizeTunisianPhone :', e);
    return '';
  }
}

/* ═══════════ SECTION 6 — FORMULAIRE AJOUT/ÉDITION ═══════════ */

/* Ouvre la modale d'ajout ou d'édition. */
function openClientModal(clientId) {
  try {
    var modal = document.getElementById('clientModal');
    var title = document.getElementById('clientModalTitle');
    if (!modal) return;

    var form = document.getElementById('clientForm');
    if (form) form.reset();

    if (clientId) {
      var c = getClientById(clientId);
      if (!c) return;
      if (title) title.textContent = 'Modifier client';
      _fillFormValue('clientId', c.id);
      _fillFormValue('clientNom', c.nom || '');
      _fillFormValue('clientTelephone', c.telephone || '');
      _fillFormValue('clientEmail', c.email || '');
      _fillFormValue('clientAdresse', c.adresse || '');
      _fillFormValue('clientMF', c.mf || '');
      _fillFormValue('clientCIN', c.cin || '');
      _fillFormValue('clientNotes', c.notes || '');
      /* ——— Champs BTP (B1→B6) : ignorés si absents du HTML ——— */
      _fillFormValue('clientType', c.type || 'particulier');
      _fillFormValue('clientDelai', String(c.delaiPaiement || 0));
      _fillFormValue('clientRetenue', String(c.retenueSource || 0));
      _fillFormValue('clientGouvernorat', c.gouvernorat || '');
      _fillFormValue('clientAdresseChantier', c.adresseChantier || '');
      _fillFormValue('clientCodeTVA', c.codeTVA || '');
      _fillFormValue('clientCodeCategorie', c.codeCategorie || '');
    } else {
      if (title) title.textContent = 'Nouveau client';
      _fillFormValue('clientId', '');
      _fillFormValue('clientType', 'particulier');
      _fillFormValue('clientDelai', '0');
      _fillFormValue('clientRetenue', '0');
    }

    var errEl = document.getElementById('clientFormError');
    if (errEl) errEl.textContent = '';

    modal.style.display = 'flex';
    var nomInput = document.getElementById('clientNom');
    if (nomInput) setTimeout(function () { try { nomInput.focus(); } catch (e) {} }, 100);
  } catch (e) {
    console.warn('openClientModal :', e);
  }
}

function closeClientModal() {
  try {
    var modal = document.getElementById('clientModal');
    if (modal) modal.style.display = 'none';
  } catch (e) {}
}

function _fillFormValue(id, value) {
  try {
    var el = document.getElementById(id);
    if (el) el.value = value || '';
  } catch (e) {}
}

function _getFormValue(id) {
  try {
    var el = document.getElementById(id);
    return el ? String(el.value || '').trim() : '';
  } catch (e) {
    return '';
  }
}

/* Enregistre le client depuis le formulaire (création ou mise à jour). */
function saveClientFromForm() {
  try {
    var errEl = document.getElementById('clientFormError');
    var id = _getFormValue('clientId');
    var nom = _getFormValue('clientNom');

    if (!nom) {
      if (errEl) errEl.textContent = 'Le nom du client est obligatoire.';
      return;
    }

    if (clientExists(nom, id)) {
      if (errEl) errEl.textContent = 'Un client avec ce nom existe déjà.';
      return;
    }

    var raw = {
      id: id || undefined,
      nom: nom,
      telephone: _getFormValue('clientTelephone'),
      email: _getFormValue('clientEmail'),
      adresse: _getFormValue('clientAdresse'),
      mf: _getFormValue('clientMF'),
      cin: _getFormValue('clientCIN'),
      notes: _getFormValue('clientNotes'),
      /* ——— Champs BTP (B1→B6) ——— */
      type: _getFormValue('clientType') || 'particulier',
      delaiPaiement: _getFormValue('clientDelai') || 0,
      retenueSource: _getFormValue('clientRetenue') || 0,
      gouvernorat: _getFormValue('clientGouvernorat'),
      adresseChantier: _getFormValue('clientAdresseChantier'),
      codeTVA: _getFormValue('clientCodeTVA'),
      codeCategorie: _getFormValue('clientCodeCategorie')
    };

    var clean = _normalizeClient(raw);
    if (!clean) {
      if (errEl) errEl.textContent = 'Données invalides.';
      return;
    }

    if (id) {
      var existing = getClientById(id);
      if (!existing) {
        if (errEl) errEl.textContent = 'Client introuvable.';
        return;
      }
      clean.createdAt = existing.createdAt;
      var idx = clients.indexOf(existing);
      clients[idx] = clean;
    } else {
      clients.push(clean);
    }

    invalidateClientStatsCache(clean.id);

    if (typeof saveAll === 'function') saveAll();
    if (typeof logAction === 'function') {
      logAction(id ? 'client.update' : 'client.create', clean.nom);
    }

    closeClientModal();
    renderClients();
    if (typeof showToast === 'function') {
      showToast(id ? 'Client modifié' : 'Client créé', 'success', 2500);
    }
  } catch (e) {
    console.warn('saveClientFromForm :', e);
    var errEl2 = document.getElementById('clientFormError');
    if (errEl2) errEl2.textContent = 'Erreur lors de l\'enregistrement.';
  }
}

/* ═══════════ SECTION 7 — SUPPRESSION AVEC UNDO (B) ═══════════ */

/* Supprime un client avec toast undo 5s (Amélioration B). */
function deleteClient(id) {
  try {
    var c = getClientById(id);
    if (!c) return;

    var idx = clients.indexOf(c);
    if (idx < 0) return;
    clients.splice(idx, 1);

    if (!trash || typeof trash !== 'object') {
      trash = { clients: [], articles: [], documents: [] };
    }
    if (!Array.isArray(trash.clients)) trash.clients = [];
    var trashEntry = {
      item: c,
      deletedAt: new Date().toISOString(),
      deletedBy: (typeof currentUser !== 'undefined' && currentUser && currentUser.username) || 'anon'
    };
    trash.clients.push(trashEntry);

    invalidateClientStatsCache(c.id);

    if (typeof saveAll === 'function') saveAll();
    if (typeof logAction === 'function') {
      logAction('client.delete', c.nom || id);
    }
    renderClients();

    if (typeof showUndoToast === 'function') {
      showUndoToast(
        'Client supprimé : ' + (c.nom || '') + ' (dans la corbeille)',
        function () { _restoreDeletedClient(trashEntry, c); },
        5000
      );
    } else if (typeof showToast === 'function') {
      showToast('Client déplacé dans la corbeille.', 'info', 3000);
    }
  } catch (e) {
    console.warn('deleteClient :', e);
    if (typeof showToast === 'function') showToast('Erreur lors de la suppression.', 'error');
  }
}

/* Restaure un client depuis la corbeille (undo). */
function _restoreDeletedClient(trashEntry, clientObj) {
  try {
    if (!trashEntry || !clientObj) return;

    if (Array.isArray(trash.clients)) {
      var idx = trash.clients.indexOf(trashEntry);
      if (idx >= 0) trash.clients.splice(idx, 1);
    }

    if (getClientById(clientObj.id)) {
      if (typeof showToast === 'function') {
        showToast('Client déjà restauré.', 'info');
      }
      return;
    }

    clients.push(clientObj);
    invalidateClientStatsCache(clientObj.id);

    if (typeof saveAll === 'function') saveAll();
    if (typeof logAction === 'function') {
      logAction('client.restore', clientObj.nom || clientObj.id);
    }
    renderClients();
    if (typeof showToast === 'function') {
      showToast('Client restauré : ' + (clientObj.nom || ''), 'success', 2500);
    }
  } catch (e) {
    console.warn('_restoreDeletedClient :', e);
  }
}

/* ═══════════ SECTION 8 — RECHERCHE + FILTRES + TRI ═══════════ */

/* Définit le terme de recherche (avec debounce côté UI). */
function setClientsSearch(term) {
  __clientsSearchTerm = String(term || '');
  __filteredClientsCache = null;
  renderClients();
}

/* Définit le filtre : 'all' | 'with_docs' | 'without_docs' | 'with_impayes' | 'a_risque'. */
function setClientsFilter(filter) {
  __clientsFilter = filter || 'all';
  __filteredClientsCache = null;
  renderClients();
}

/* Définit le champ de tri (T4) : 'nom' | 'ca' | 'marge' | 'impaye' | 'retard'.
   Si le même champ est renvoyé, bascule le sens asc/desc. */
function setClientsSort(field) {
  var f = String(field || 'nom');
  if (f === __clientsSortField) {
    __clientsSortDir = (__clientsSortDir === 'asc') ? 'desc' : 'asc';
  } else {
    __clientsSortField = f;
    __clientsSortDir = 'asc';
  }
  __filteredClientsCache = null;
  renderClients();
}

/* Retourne la liste filtrée + triée (avec cache T3). */
function getFilteredClients() {
  try {
    if (!Array.isArray(clients)) return [];

    var cacheKey = __clientsSearchTerm + '|' + __clientsFilter + '|' +
                   __clientsSortField + '|' + __clientsSortDir + '|' + clients.length;
    if (__filteredClientsCache && __filteredClientsCache.key === cacheKey) {
      return __filteredClientsCache.list;
    }

    var out = clients.slice();

    /* Filtre recherche */
    if (__clientsSearchTerm) {
      var term = normalizeText(__clientsSearchTerm);
      out = out.filter(function (c) {
        if (!c) return false;
        var hay = normalizeText([
          c.nom, c.telephone, c.email, c.adresse, c.mf, c.cin,
          c.gouvernorat, c.adresseChantier
        ].join(' '));
        return hay.indexOf(term) >= 0;
      });
    }

    /* Filtre type */
    if (__clientsFilter === 'with_docs') {
      out = out.filter(function (c) {
        var s = computeClientStats(c.id);
        return s.nbFactures > 0 || s.nbChantiers > 0;
      });
    } else if (__clientsFilter === 'without_docs') {
      out = out.filter(function (c) {
        var s = computeClientStats(c.id);
        return s.nbFactures === 0 && s.nbChantiers === 0;
      });
    } else if (__clientsFilter === 'with_impayes') {
      out = out.filter(function (c) {
        var s = computeClientStats(c.id);
        return s.impaye > 0.001;
      });
    } else if (__clientsFilter === 'a_risque') {
      out = out.filter(function (c) {
        var s = computeClientStats(c.id);
        return s.aRisque;
      });
    }

    /* Tri (T4) */
    var dir = (__clientsSortDir === 'desc') ? -1 : 1;
    var field = __clientsSortField;
    if (field === 'ca' || field === 'marge' || field === 'impaye' || field === 'retard') {
      out.sort(function (a, b) {
        var sa = computeClientStats(a.id);
        var sb = computeClientStats(b.id);
        var va = 0, vb = 0;
        if (field === 'ca') { va = sa.caTotal; vb = sb.caTotal; }
        else if (field === 'marge') { va = sa.marge; vb = sb.marge; }
        else if (field === 'impaye') { va = sa.impaye; vb = sb.impaye; }
        else if (field === 'retard') { va = sa.retardJours; vb = sb.retardJours; }
        if (va === vb) return 0;
        return (va < vb ? -1 : 1) * dir;
      });
    } else {
      out.sort(function (a, b) {
        var na = normalizeText(a.nom || '');
        var nb = normalizeText(b.nom || '');
        if (na === nb) return 0;
        return (na < nb ? -1 : 1) * dir;
      });
    }

    __filteredClientsCache = { key: cacheKey, list: out };
    return out;
  } catch (e) {
    console.warn('getFilteredClients :', e);
    return [];
  }
}

/* ═══════════ SECTION 9 — IMPORT/EXPORT ═══════════ */

/* Exporte tous les clients en JSON. */
function exportClientsJSON() {
  try {
    var data = {
      version: 1,
      exportedAt: new Date().toISOString(),
      count: clients.length,
      clients: clients
    };
    var json = JSON.stringify(data, null, 2);
    var blob = new Blob([json], { type: 'application/json' });
    var filename = 'voltcore-clients-' + todayISO() + '.json';
    _download06(blob, filename);
    if (typeof showToast === 'function') {
      showToast(clients.length + ' client(s) exporté(s)', 'success');
    }
  } catch (e) {
    console.warn('exportClientsJSON :', e);
    if (typeof showToast === 'function') showToast('Erreur d\'export.', 'error');
  }
}

/* Exporte les clients en CSV (compatible Excel — tab-separated avec BOM). */
function exportClientsCSV() {
  try {
    var lines = [];
    lines.push([
      'Nom', 'Type', 'Téléphone', 'Email', 'Adresse', 'Gouvernorat',
      'Adresse chantier', 'MF', 'CIN', 'Code TVA', 'Code catégorie',
      'Délai paiement', 'Retenue source', 'Notes'
    ].join('\t'));
    for (var i = 0; i < clients.length; i++) {
      var c = clients[i];
      if (!c) continue;
      lines.push([
        _csvCellClients(c.nom),
        _csvCellClients(_getClientTypeLabel(c.type)),
        _csvCellClients(c.telephone),
        _csvCellClients(c.email),
        _csvCellClients(c.adresse),
        _csvCellClients(c.gouvernorat),
        _csvCellClients(c.adresseChantier),
        _csvCellClients(c.mf),
        _csvCellClients(c.cin),
        _csvCellClients(c.codeTVA),
        _csvCellClients(c.codeCategorie),
        _csvCellClients(_getDelaiLabel(c.delaiPaiement)),
        _csvCellClients(String(c.retenueSource || 0)),
        _csvCellClients(c.notes)
      ].join('\t'));
    }
    var csv = '\uFEFF' + lines.join('\r\n');
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    var filename = 'voltcore-clients-' + todayISO() + '.csv';
    _download06(blob, filename);
    if (typeof showToast === 'function') showToast('CSV exporté', 'success');
  } catch (e) {
    console.warn('exportClientsCSV :', e);
    if (typeof showToast === 'function') showToast('Export CSV échoué.', 'error');
  }
}

/* v6.7 — Renommé _csvCell → _csvCellClients pour éviter la collision
   globale avec _csvCell de 14-expenses-bons.js (chaque fichier a son
   propre helper CSV, plus de dépendance silencieuse à l'ordre de chargement). */
function _csvCellClients(v) {
  var s = String(v == null ? '' : v);
  return s.replace(/\t/g, ' ').replace(/\r?\n/g, ' ');
}

/* Importe des clients depuis un fichier JSON.
   Options : { mode: 'merge' | 'replace' }
   Sécurisation (BUG 5 / T6) : en mode 'replace', les clients actuels
   sont poussés dans la corbeille avant d'être vidés. */
function importClientsJSON(file, options) {
  return new Promise(function (resolve, reject) {
    try {
      if (!file) return reject(new Error('Fichier requis'));
      var mode = (options && options.mode) || 'merge';
      var reader = new FileReader();
      reader.onload = function (ev) {
        try {
          var raw = ev.target.result;
          var parsed = JSON.parse(raw);
          var arr = null;
          if (Array.isArray(parsed)) arr = parsed;
          else if (parsed && Array.isArray(parsed.clients)) arr = parsed.clients;
          if (!arr) throw new Error('Format invalide : clients[] attendu');

          /* ——— Sécurité mode replace (BUG 5) ——— */
          if (mode === 'replace') {
            if (!trash || typeof trash !== 'object') {
              trash = { clients: [], articles: [], documents: [] };
            }
            if (!Array.isArray(trash.clients)) trash.clients = [];
            var stamp = new Date().toISOString();
            for (var k = 0; k < clients.length; k++) {
              if (!clients[k]) continue;
              trash.clients.push({
                item: clients[k],
                deletedAt: stamp,
                deletedBy: (typeof currentUser !== 'undefined' && currentUser && currentUser.username) || 'anon',
                reason: 'import-replace'
              });
            }
            clients = [];
          }

          var added = 0, skipped = 0, invalid = 0;
          for (var i = 0; i < arr.length; i++) {
            var clean = _normalizeClient(arr[i]);
            if (!clean) { invalid++; continue; }
            if (clientExists(clean.nom)) { skipped++; continue; }
            clients.push(clean);
            added++;
          }

          invalidateClientStatsCache();

          if (typeof saveAll === 'function') saveAll();
          if (typeof logAction === 'function') {
            logAction('client.import', added + ' ajoutés, ' + skipped + ' doublons (mode ' + mode + ')');
          }
          renderClients();
          if (typeof showToast === 'function') {
            var msg = added + ' client(s) importé(s)';
            if (skipped > 0) msg += ' · ' + skipped + ' doublon(s) ignoré(s)';
            if (invalid > 0) msg += ' · ' + invalid + ' invalide(s)';
            if (mode === 'replace') msg += ' · anciens en corbeille';
            showToast(msg, added > 0 ? 'success' : 'warning', 4000);
          }
          resolve({ added: added, skipped: skipped, invalid: invalid, mode: mode });
        } catch (err) {
          reject(err);
        }
      };
      reader.onerror = function () { reject(reader.error || new Error('Lecture échouée')); };
      reader.readAsText(file);
    } catch (e) {
      reject(e);
    }
  });
}

/* ═══════════ SECTION 10 — IMPRESSION ═══════════ */

/* Ouvre une fenêtre d'impression avec la liste des clients. */
function printClientsList() {
  try {
    var list = getFilteredClients();
    var html = '<!DOCTYPE html><html><head><meta charset="UTF-8">' +
      '<title>Liste des clients — VOLTCORE</title>' +
      '<style>' +
      'body{font-family:Arial,sans-serif;margin:20px;font-size:12px}' +
      'h1{color:#0b3d91;font-size:18px;border-bottom:2px solid #0b3d91;padding-bottom:6px}' +
      'table{width:100%;border-collapse:collapse;margin-top:10px}' +
      'th,td{border:1px solid #ccc;padding:6px;text-align:left}' +
      'th{background:#f0f0f0;font-weight:bold}' +
      '.footer{margin-top:20px;font-size:10px;color:#666;text-align:center}' +
      '</style></head><body>';
    html += '<h1>Liste des clients</h1>';
    html += '<div>Total : ' + list.length + ' client(s) · ' + todayISO() + '</div>';
    html += '<table><thead><tr>' +
      '<th>Nom</th><th>Type</th><th>Téléphone</th><th>Email</th>' +
      '<th>Adresse</th><th>MF</th>' +
      '</tr></thead><tbody>';
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      html += '<tr>' +
        '<td>' + escapeHtml(c.nom || '') + '</td>' +
        '<td>' + escapeHtml(_getClientTypeLabel(c.type)) + '</td>' +
        '<td>' + escapeHtml(c.telephone || '') + '</td>' +
        '<td>' + escapeHtml(c.email || '') + '</td>' +
        '<td>' + escapeHtml(c.adresse || '') + '</td>' +
        '<td>' + escapeHtml(c.mf || '') + '</td>' +
        '</tr>';
    }
    html += '</tbody></table>';
    html += '<div class="footer">VOLTCORE — Généré le ' + todayISO() + '</div>';
    html += '</body></html>';

    var w = window.open('', '_blank');
    if (!w) {
      if (typeof showToast === 'function') {
        showToast('Autorise les pop-ups pour imprimer.', 'warning');
      }
      return;
    }
    w.document.write(html);
    w.document.close();
    setTimeout(function () {
      try { w.print(); } catch (e) {}
    }, 500);
  } catch (e) {
    console.warn('printClientsList :', e);
  }
}

/* ═══════════ SECTION 11 — ÉVÉNEMENTS ═══════════ */

/* Attache les écouteurs (appelé par attachAllEvents dans 21-init-app.js). */
function attachClientsEvents() {
  try {
    /* Recherche avec debounce */
    var searchInput = document.getElementById('clientsSearchInput');
    if (searchInput && !searchInput.__bound) {
      searchInput.__bound = true;
      var debounced = debounce(function (ev) {
        setClientsSearch(ev.target.value);
      }, 250);
      searchInput.addEventListener('input', debounced);
    }

    /* Filtre select */
    var filterSel = document.getElementById('clientsFilterSelect');
    if (filterSel && !filterSel.__bound) {
      filterSel.__bound = true;
      filterSel.addEventListener('change', function (ev) {
        setClientsFilter(ev.target.value);
      });
    }

    /* Bouton ajout */
    var addBtn = document.getElementById('btnAddClient');
    if (addBtn && !addBtn.__bound) {
      addBtn.__bound = true;
      addBtn.addEventListener('click', function () { openClientModal(null); });
    }

    /* Bouton import */
    var importBtn = document.getElementById('btnImportClients');
    if (importBtn && !importBtn.__bound) {
      importBtn.__bound = true;
      importBtn.addEventListener('click', function () {
        var input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json,application/json';
        input.onchange = function (ev) {
          var f = ev.target.files && ev.target.files[0];
          if (!f) return;
          importClientsJSON(f, { mode: 'merge' }).catch(function (err) {
            if (typeof showToast === 'function') {
              showToast('Import échoué : ' + (err.message || ''), 'error');
            }
          });
        };
        input.click();
      });
    }

    /* Bouton export JSON */
    var exportJsonBtn = document.getElementById('btnExportClientsJSON');
    if (exportJsonBtn && !exportJsonBtn.__bound) {
      exportJsonBtn.__bound = true;
      exportJsonBtn.addEventListener('click', exportClientsJSON);
    }

    /* Bouton export CSV */
    var exportCsvBtn = document.getElementById('btnExportClientsCSV');
    if (exportCsvBtn && !exportCsvBtn.__bound) {
      exportCsvBtn.__bound = true;
      exportCsvBtn.addEventListener('click', exportClientsCSV);
    }

    /* Bouton impression */
    var printBtn = document.getElementById('btnPrintClients');
    if (printBtn && !printBtn.__bound) {
      printBtn.__bound = true;
      printBtn.addEventListener('click', printClientsList);
    }
  } catch (e) {
    console.warn('attachClientsEvents :', e);
  }
}

/* ═══════════ EXPOSITION GLOBALE (inter-fichiers) ═══════════
   Permet aux autres fichiers de purger le cache quand ils modifient
   des factures / chantiers / paiements liés à un client. */
try {
  if (typeof window !== 'undefined') {
    window.invalidateClientStatsCache = invalidateClientStatsCache;
    window.relancerImpayeClient = relancerImpayeClient;
    window.setClientsSort = setClientsSort;
  }
} catch (e) {}

console.log('✅ 06-clients.js chargé — v6.7 (Session #3 — BTP + cache + relance + _csvCellClients)');