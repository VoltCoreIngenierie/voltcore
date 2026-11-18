/* ═══════════════════════════════════════════════════════════════
   VOLTCORE — 23-bons-route.js
   ═══════════════════════════════════════════════════════════════

   VERSION : v6.9.0 (Session #5 — 2026-11-XX)
   STATUT  : STABLE — module autonome, hors comptabilité
   ORDRE DE CHARGEMENT : AVANT 21-init-app.js (pour que
                         attachBonsRouteEvents soit définie quand
                         attachAllEvents l'appelle)

   ─── RÔLE ───
   Traçabilité des trajets Sfax ↔ Tunis : bons de sortie (matériel
   qui part du local), bons de commande (matériel commandé pour un
   chantier Tunis), bons de déplacement (véhicule + chauffeur).

   ⚠️ MODULE HORS COMPTABILITÉ (règle absolue) :
     • Aucun champ montant / tva / total
     • Aucune écriture dans voltcore_documents ni voltcore_frais
     • Aucune lecture par computeChantierMarge, computeClientMarge,
       computeTVAReport, computeDashboardKPIs (sauf comptage nb/km
       dans un KPI dédié, sans montant)
     • Impact CA, marge, TVA, impayés = ZÉRO par construction

   ─── DÉPENDANCES ───
   · 01-core.js  (AVANT) → globaux, bankMF, currentUser
   · 03-utils.js (AVANT) → escapeHtml, escapeAttr, formatMoney,
                           formatDate, todayISO, parseNumber,
                           normalizeText, showToast, showUndoToast,
                           confirmDialog, debounce, generateId
   · 04-storage.js (AVANT) → STORAGE_KEYS (clé bonsRoute à ajouter),
                             saveAll, compteurs, logAction

   ─── EXPOSE (à venir en BR2-BR6) ───
   🔹 Helpers (BR1)  : getBonRouteById, BON_ROUTE_STATUTS,
                       BON_ROUTE_TYPES, _bonRouteStatutLabel,
                       _bonRouteStatutColor, _bonRouteTypeLabel,
                       _normalizeBonRoute, _genererNumeroBonRoute
   🔹 CRUD (BR2)     : openBonRouteModal, closeBonRouteModal,
                       saveBonRouteFromForm, deleteBonRoute,
                       _restoreDeletedBonRoute
   🔹 Rendu (BR3)    : renderBonsRoute, renderBonRouteRow,
                       setBonsRouteSearch, setBonsRouteFilter,
                       getFilteredBonsRoute
   🔹 Formulaire(BR4): _populateBonRouteVehicules, _populateBonRouteChauffeurs,
                       addBonRouteMaterielLine, addBonRouteDocLine,
                       renderBonRouteMaterielTable, renderBonRouteDocTable
   🔹 PDF (BR5)      : printBonRoute
   🔹 Import/Export  : exportBonsRouteJSON, exportBonsRouteCSV,
                       importBonsRouteJSON
   🔹 Événements     : attachBonsRouteEvents

   ─── SCHÉMA localStorage (SOURCE DE VÉRITÉ) ───

   voltcore_bons_route = [
     {
       id: 'br_<ts>_<rand>',
       numero: 'BR-2026-0001',                // 4 chiffres, compteur annuel
       type: 'sortie'|'commande'|'deplacement',
       dateCreation: 'YYYY-MM-DD',
       dateDepart: 'YYYY-MM-DD' | '',
       dateRetour: 'YYYY-MM-DD' | '',
       vehicule: 'Partner K9 — 248 TU 8239' | '',
       chauffeur: 'Ahmed Ben Ali' | '',
       destination: 'tunis'|'sfax'|'autre',
       adressePrecise: '',
       chantierId: 'ch_xxx' | '',             // lien INFO (jamais lu par compta)
       kmDepart: 0,
       kmRetour: 0,
       materiel: [                            // type 'sortie' uniquement
         { designation, quantite, unite, observation }
       ],
       documents: [                           // type 'commande' uniquement
         { reference, designation, fournisseur, quantite, observation }
       ],
       statut: 'brouillon'|'envoye'|'recu'|'retourne'|'archive',
       notes: '',
       createdAt: 'ISO',
       updatedAt: 'ISO'
     }
   ]

   ─── RÈGLES MÉTIER ───
   1. Statuts : brouillon → envoye → recu → retourne → archive
      · sortie    : brouillon → envoye (départ) → recu (arrivée Tunis) → archive
      · commande  : brouillon → envoye (au fournisseur) → recu (livré) → archive
      · deplacement : brouillon → envoye (départ) → retourne (retour Sfax) → archive
   2. Numérotation : BR-<année>-<NNNN> via compteurs['bonRoute_<année>']
   3. Aucun champ montant — impossible de calculer un coût
   4. Les km sont informatifs (pas de calcul carburant automatique)
   5. chantierId est un lien INFORMATIF pour filtrer « bons pour ce chantier »
      → jamais lu par computeChantierMarge, computeClientMarge, etc.

   ─── ANTI-PATTERNS À ÉVITER ───
   ❌ Ne JAMAIS ajouter un champ montant/tva/total à un bon route
   ❌ Ne JAMAIS écrire dans voltcore_documents / voltcore_frais
      depuis ce module
   ❌ Ne JAMAIS modifier la structure sans bump CACHE_VERSION
      dans 22-pwa.js
   ❌ Ne PAS appeler renderInvoices/renderPurchases depuis ce module
      (le refresh se fait via window.dispatchEvent('voltcore:bonsRoute:changed')
      si nécessaire)
   ❌ Ne PAS lire bonsRoute depuis 04-storage.js getStatutPaiement,
      _computeDuDoc, getNetRevenu (aucun impact compta)

   ─── HISTORIQUE ───
   v6.9.0 (S5) : création du module (BR1 → BR7)

   ═══════════════════════════════════════════════════════════════ */

/* ═══════════ SECTION 1 — CONSTANTES ═══════════ */

/* Types de bons disponibles.
   Le libellé est utilisé dans l'UI et le PDF. */
var BON_ROUTE_TYPES = {
  sortie:       { label: 'Bon de sortie',   icon: '📤' },
  commande:     { label: 'Bon de commande', icon: '📥' },
  deplacement:  { label: 'Bon de déplacement', icon: '🚐' }
};

/* Statuts du cycle de vie.
   Ordre logique d'avancement pour les badges UI. */
var BON_ROUTE_STATUTS = {
  brouillon: { label: 'Brouillon', icon: '📝', color: 'var(--muted)' },
  envoye:    { label: 'Envoyé',    icon: '📤', color: 'var(--info)' },
  recu:      { label: 'Reçu',      icon: '📥', color: 'var(--success)' },
  retourne:  { label: 'Retourné',  icon: '🔙', color: 'var(--warning)' },
  archive:   { label: 'Archivé',   icon: '📚', color: 'var(--muted)' }
};

/* Destinations prédéfinies (extensible par l'utilisateur). */
var BON_ROUTE_DESTINATIONS = {
  tunis:  'Tunis',
  sfax:   'Sfax',
  autre:  'Autre'
};

/* Bornes défensives (cohérence avec VOLTCORE_MAX_DOCUMENT_* de 01-core.js). */
var BON_ROUTE_MAX_KM        = 9999999;      /* 9 999 999 km (raisonnable) */
var BON_ROUTE_MAX_QUANTITE  = 10000000;     /* 10 M unités */

/* Compteur de numérotation (clé année, comme les autres documents). */
var BON_ROUTE_NUMERO_PREFIX = 'BR';

/* ═══════════ SECTION 2 — ÉTAT LOCAL ═══════════ */

var __bonsRouteSearchTerm = '';
var __bonsRouteFilterType = 'all';       /* 'all' | 'sortie' | 'commande' | 'deplacement' */
var __bonsRouteFilterStatut = 'all';     /* 'all' | 'brouillon' | ... */
var __bonsRouteFilterDestination = 'all';/* 'all' | 'tunis' | 'sfax' | 'autre' */
var __bonsRoutePage = 0;
var __bonsRoutePerPage = 50;

/* Cache d'un item en cours d'édition (évite de fouiller la collection). */
var __bonRouteEditingId = null;

/* Flag anti-spam warnings console (cohérent avec B19/B20). */
var __lastBonRouteWarnAt = 0;

/* ═══════════ SECTION 3 — HELPERS DE BASE ═══════════ */

/* Accès sécurisé à la collection (au cas où elle ne serait pas chargée). */
function _getBonsRouteArray() {
  try {
    if (Array.isArray(bonsRoute)) return bonsRoute;
    return [];
  } catch (e) {
    return [];
  }
}

/* Retourne un bon route par ID, ou null. */
function getBonRouteById(id) {
  try {
    if (!id) return null;
    var sid = String(id);
    var arr = _getBonsRouteArray();
    for (var i = 0; i < arr.length; i++) {
      if (arr[i] && String(arr[i].id) === sid) return arr[i];
    }
    return null;
  } catch (e) {
    console.warn('getBonRouteById :', e);
    return null;
  }
}

/* Libellé d'un type (avec fallback si type inconnu). */
function _bonRouteTypeLabel(type) {
  var t = String(type || '').toLowerCase();
  var info = BON_ROUTE_TYPES[t];
  if (info) return info.icon + ' ' + info.label;
  return '📄 ' + t;
}

/* Libellé d'un statut (avec fallback). */
function _bonRouteStatutLabel(statut) {
  var s = String(statut || 'brouillon').toLowerCase();
  var info = BON_ROUTE_STATUTS[s];
  if (info) return info.icon + ' ' + info.label;
  return s;
}

/* Couleur CSS d'un statut (pour les badges inline). */
function _bonRouteStatutColor(statut) {
  var s = String(statut || 'brouillon').toLowerCase();
  var info = BON_ROUTE_STATUTS[s];
  return info ? info.color : 'var(--muted)';
}

/* Valide un statut (retourne 'brouillon' si inconnu). */
function _isValidBonRouteStatut(statut) {
  return BON_ROUTE_STATUTS.hasOwnProperty(String(statut || '').toLowerCase());
}

/* Valide un type (retourne null si inconnu). */
function _isValidBonRouteType(type) {
  return BON_ROUTE_TYPES.hasOwnProperty(String(type || '').toLowerCase());
}

/* Nombre de jours entre deux dates ISO (pour affichage durée trajet). */
function _bonRouteDaysBetween(dateDepart, dateRetour) {
  try {
    if (!dateDepart || !dateRetour) return 0;
    if (typeof daysBetweenISO === 'function') {
      return daysBetweenISO(dateDepart, dateRetour);
    }
    /* Fallback local si 03-utils n'est pas chargé (ne devrait pas arriver) */
    var d1 = new Date(dateDepart + 'T12:00:00').getTime();
    var d2 = new Date(dateRetour + 'T12:00:00').getTime();
    return Math.round((d2 - d1) / 86400000);
  } catch (e) { return 0; }
}

/* Calcule les km parcourus (retour - départ, clampé à 0). */
function _bonRouteKmParcourus(bon) {
  try {
    if (!bon) return 0;
    var dep = parseNumber(bon.kmDepart);
    var ret = parseNumber(bon.kmRetour);
    if (!ret || ret <= dep) return 0;
    return ret - dep;
  } catch (e) { return 0; }
}

/* ═══════════ SECTION 4 — NORMALISATION ═══════════ */

/* Normalise un bon route brut avant stockage.
   Applique les garde-fous :
     • Trim des chaînes
     • Quantités > 0 (BON_ROUTE_MAX_QUANTITE)
     • Km dans [0, BON_ROUTE_MAX_KM]
     • Type/statut valides (fallback)
     • ID généré si absent
     • Dates ISO (aujourd'hui si vide)
     • Tableaux materiel/documents toujours présents

   Retourne null si non normalisable (données corrompues). */
function _normalizeBonRoute(raw) {
  try {
    if (!raw || typeof raw !== 'object') return null;

    var type = String(raw.type || 'sortie').toLowerCase();
    if (!_isValidBonRouteType(type)) type = 'sortie';

    var statut = String(raw.statut || 'brouillon').toLowerCase();
    if (!_isValidBonRouteStatut(statut)) statut = 'brouillon';

    var destination = String(raw.destination || 'tunis').toLowerCase();
    if (!BON_ROUTE_DESTINATIONS.hasOwnProperty(destination)) destination = 'autre';

    /* Km clampés */
    var kmDep = parseNumber(raw.kmDepart);
    if (kmDep < 0) kmDep = 0;
    if (kmDep > BON_ROUTE_MAX_KM) kmDep = BON_ROUTE_MAX_KM;
    var kmRet = parseNumber(raw.kmRetour);
    if (kmRet < 0) kmRet = 0;
    if (kmRet > BON_ROUTE_MAX_KM) kmRet = BON_ROUTE_MAX_KM;

    /* Materiel (type 'sortie') */
    var materiel = [];
    if (Array.isArray(raw.materiel)) {
      for (var i = 0; i < raw.materiel.length; i++) {
        var m = raw.materiel[i];
        if (!m || typeof m !== 'object') continue;
        var des = String(m.designation || '').trim();
        if (!des) continue;
        var qte = parseNumber(m.quantite);
        if (qte <= 0) continue;
        if (qte > BON_ROUTE_MAX_QUANTITE) qte = BON_ROUTE_MAX_QUANTITE;
        materiel.push({
          designation: des.slice(0, 200),
          quantite: qte,
          unite: String(m.unite || 'U').trim().slice(0, 20),
          observation: String(m.observation || '').trim().slice(0, 300)
        });
      }
    }

    /* Documents (type 'commande') */
    var documents = [];
    if (Array.isArray(raw.documents)) {
      for (var j = 0; j < raw.documents.length; j++) {
        var d = raw.documents[j];
        if (!d || typeof d !== 'object') continue;
        var des2 = String(d.designation || '').trim();
        if (!des2) continue;
        var qte2 = parseNumber(d.quantite);
        if (qte2 <= 0) continue;
        if (qte2 > BON_ROUTE_MAX_QUANTITE) qte2 = BON_ROUTE_MAX_QUANTITE;
        documents.push({
          reference: String(d.reference || '').trim().slice(0, 80),
          designation: des2.slice(0, 200),
          fournisseur: String(d.fournisseur || '').trim().slice(0, 120),
          quantite: qte2,
          observation: String(d.observation || '').trim().slice(0, 300)
        });
      }
    }

    var id = raw.id || ('br_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8));
    var numero = String(raw.numero || '').trim();
    if (!numero) {
      numero = _genererNumeroBonRoute();
    }

    var dateCreation = String(raw.dateCreation || '').slice(0, 10);
    if (!dateCreation || !isValidDateString(dateCreation)) {
      dateCreation = (typeof todayISO === 'function') ? todayISO() : '';
    }

    var dateDepart = String(raw.dateDepart || '').slice(0, 10);
    if (dateDepart && !isValidDateString(dateDepart)) dateDepart = '';

    var dateRetour = String(raw.dateRetour || '').slice(0, 10);
    if (dateRetour && !isValidDateString(dateRetour)) dateRetour = '';

    return {
      id: id,
      numero: numero,
      type: type,
      dateCreation: dateCreation,
      dateDepart: dateDepart,
      dateRetour: dateRetour,
      vehicule: String(raw.vehicule || '').trim().slice(0, 80),
      chauffeur: String(raw.chauffeur || '').trim().slice(0, 80),
      destination: destination,
      adressePrecise: String(raw.adressePrecise || '').trim().slice(0, 300),
      chantierId: String(raw.chantierId || '').trim(),
      kmDepart: kmDep,
      kmRetour: kmRet,
      materiel: materiel,
      documents: documents,
      statut: statut,
      notes: String(raw.notes || '').trim().slice(0, 1000),
      createdAt: raw.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
  } catch (e) {
    console.warn('_normalizeBonRoute :', e);
    return null;
  }
}

/* ═══════════ SECTION 5 — NUMÉROTATION ═══════════ */

/* Génère le prochain numéro BR-<année>-<NNNN>.
   Utilise compteurs['bonRoute_<année>'] (même mécanisme que
   04-storage.js genererNumero mais clé dédiée).
   N'incrémente PAS le compteur — c'est incrementerCompteurBonRoute()
   qui le fait (livré en BR2, lors de la sauvegarde réelle).

   Permet d'appeler plusieurs fois sans effet de bord (aperçu). */
function _genererNumeroBonRoute() {
  try {
    var year = new Date().getFullYear();
    var key = 'bonRoute_' + year;
    var current = 0;
    if (typeof compteurs === 'object' && compteurs && compteurs[key]) {
      current = parseInt(compteurs[key], 10) || 0;
    }
    var next = current + 1;
    return BON_ROUTE_NUMERO_PREFIX + '-' + year + '-' + String(next).padStart(4, '0');
  } catch (e) {
    console.warn('_genererNumeroBonRoute :', e);
    return BON_ROUTE_NUMERO_PREFIX + '-0000-0001';
  }
}

/* Incrémente le compteur de numérotation.
   À appeler UNIQUEMENT après confirmation d'ajout d'un bon (pas dans
   l'aperçu de formulaire, sinon les numéros sautent). */
function incrementerCompteurBonRoute() {
  try {
    var year = new Date().getFullYear();
    var key = 'bonRoute_' + year;
    if (typeof compteurs !== 'object' || !compteurs) compteurs = {};
    compteurs[key] = (parseInt(compteurs[key], 10) || 0) + 1;
    if (typeof saveCompteurs === 'function') saveCompteurs();
    return compteurs[key];
  } catch (e) {
    console.warn('incrementerCompteurBonRoute :', e);
    return 0;
  }
}

/* ═══════════ SECTION 6 — HELPERS POUR BR2 (stubs prêts) ═══════════ */

/* Vérifie si un numéro de bon route existe déjà (cohérent avec
   numeroDocExiste de 04-storage.js mais sur la collection bonsRoute). */
function numeroBonRouteExiste(numero, excludeId) {
  try {
    if (!numero) return false;
    var target = String(numero).trim().toLowerCase();
    if (!target) return false;
    var arr = _getBonsRouteArray();
    for (var i = 0; i < arr.length; i++) {
      var b = arr[i];
      if (!b || !b.numero) continue;
      if (excludeId && String(b.id) === String(excludeId)) continue;
      if (String(b.numero).trim().toLowerCase() === target) return true;
    }
    return false;
  } catch (e) { return false; }
}

/* ═══════════ LOG DE CHARGEMENT ═══════════ */

/* ═══════════ SECTION 7 — HELPERS DOM ═══════════
   Accès sécurisé aux champs du formulaire (BR4 livre le HTML).
   Si un champ est absent, on retourne '' / 0 sans crash. */

function _brGet(id) {
  try {
    var el = document.getElementById(id);
    return el ? String(el.value || '').trim() : '';
  } catch (e) { return ''; }
}

function _brSet(id, value) {
  try {
    var el = document.getElementById(id);
    if (el) el.value = (value === null || value === undefined) ? '' : value;
  } catch (e) {}
}

function _brText(id, text) {
  try {
    var el = document.getElementById(id);
    if (el) el.textContent = String(text || '');
  } catch (e) {}
}

/* Peuple le select chantiers (lien INFO, jamais lu par compta). */
function _populateBonRouteChantiers(selectedId) {
  try {
    var sel = document.getElementById('bonRouteChantierSelect');
    if (!sel) return;
    var html = '<option value="">— Aucun —</option>';
    if (Array.isArray(savedChantiers)) {
      var sorted = savedChantiers.slice().sort(function (a, b) {
        return normalizeText(a.nom || '') > normalizeText(b.nom || '') ? 1 : -1;
      });
      for (var i = 0; i < sorted.length; i++) {
        var ch = sorted[i];
        if (!ch) continue;
        var sid = String(ch.id);
        html += '<option value="' + escapeAttr(sid) + '"' +
          (sid === String(selectedId || '') ? ' selected' : '') + '>' +
          escapeHtml(ch.nom || '') + '</option>';
      }
    }
    sel.innerHTML = html;
  } catch (e) { console.warn('_populateBonRouteChantiers :', e); }
}

/* Peuple le select destination. */
function _populateBonRouteDestinations(selectedDest) {
  try {
    var sel = document.getElementById('bonRouteDestination');
    if (!sel) return;
    var html = '';
    var keys = Object.keys(BON_ROUTE_DESTINATIONS);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      html += '<option value="' + escapeAttr(k) + '"' +
        (k === String(selectedDest || '') ? ' selected' : '') + '>' +
        escapeHtml(BON_ROUTE_DESTINATIONS[k]) + '</option>';
    }
    sel.innerHTML = html;
  } catch (e) { console.warn('_populateBonRouteDestinations :', e); }
}

/* Peuple le select statut (workflow complet). */
function _populateBonRouteStatuts(selectedStatut) {
  try {
    var sel = document.getElementById('bonRouteStatut');
    if (!sel) return;
    var html = '';
    var keys = ['brouillon', 'envoye', 'recu', 'retourne', 'archive'];
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      var info = BON_ROUTE_STATUTS[k];
      html += '<option value="' + k + '"' +
        (k === String(selectedStatut || 'brouillon') ? ' selected' : '') + '>' +
        escapeHtml(info.icon + ' ' + info.label) + '</option>';
    }
    sel.innerHTML = html;
  } catch (e) { console.warn('_populateBonRouteStatuts :', e); }
}

/* Peuple le select type (3 types). */
function _populateBonRouteTypes(selectedType) {
  try {
    var sel = document.getElementById('bonRouteType');
    if (!sel) return;
    var html = '';
    var keys = ['sortie', 'commande', 'deplacement'];
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      var info = BON_ROUTE_TYPES[k];
      html += '<option value="' + k + '"' +
        (k === String(selectedType || 'sortie') ? ' selected' : '') + '>' +
        escapeHtml(info.icon + ' ' + info.label) + '</option>';
    }
    sel.innerHTML = html;
  } catch (e) { console.warn('_populateBonRouteTypes :', e); }
}

/* ═══════════ SECTION 8 — OUVERTURE / FERMETURE ═══════════ */

/* Ouvre la modale de création ou d'édition.
   - bonId absent/null → mode création (numéro auto, statut brouillon)
   - bonId présent    → mode édition (charge les données existantes)

   Peuple tous les selects + remplit les champs + initialise les
   arrays window.__bonRouteMateriel / __bonRouteDocuments. */
function openBonRouteModal(bonId) {
  try {
    var modal = document.getElementById('bonRouteModal');
    if (!modal) {
      if (typeof showToast === 'function') {
        showToast('Formulaire bon route indisponible.', 'error');
      }
      return;
    }

    __bonRouteEditingId = bonId ? String(bonId) : null;

    /* Arrays de travail */
    window.__bonRouteMateriel = [];
    window.__bonRouteDocuments = [];

    /* Reset erreurs */
    _brText('bonRouteFormError', '');

    if (bonId) {
      /* ─── Mode édition ─── */
      var bon = getBonRouteById(bonId);
      if (!bon) {
        if (typeof showToast === 'function') showToast('Bon route introuvable.', 'error');
        return;
      }
      _brText('bonRouteModalTitle', 'Modifier bon route — ' + (bon.numero || ''));

      _brSet('bonRouteId', bon.id);
      _populateBonRouteTypes(bon.type);
      _brSet('bonRouteNumero', bon.numero || '');
      _brSet('bonRouteDateCreation', bon.dateCreation || '');
      _brSet('bonRouteDateDepart', bon.dateDepart || '');
      _brSet('bonRouteDateRetour', bon.dateRetour || '');
      _brSet('bonRouteVehicule', bon.vehicule || '');
      _brSet('bonRouteChauffeur', bon.chauffeur || '');
      _populateBonRouteDestinations(bon.destination);
      _brSet('bonRouteAdressePrecise', bon.adressePrecise || '');
      _populateBonRouteChantiers(bon.chantierId || '');
      _brSet('bonRouteKmDepart', bon.kmDepart || 0);
      _brSet('bonRouteKmRetour', bon.kmRetour || 0);
      _populateBonRouteStatuts(bon.statut);
      _brSet('bonRouteNotes', bon.notes || '');

      /* Arrays depuis l'objet */
      window.__bonRouteMateriel = Array.isArray(bon.materiel) ? bon.materiel.slice() : [];
      window.__bonRouteDocuments = Array.isArray(bon.documents) ? bon.documents.slice() : [];
    } else {
      /* ─── Mode création ─── */
      _brText('bonRouteModalTitle', 'Nouveau bon route');

      _brSet('bonRouteId', '');
      _populateBonRouteTypes('sortie');
      _brSet('bonRouteNumero', _genererNumeroBonRoute());
      _brSet('bonRouteDateCreation', (typeof todayISO === 'function') ? todayISO() : '');
      _brSet('bonRouteDateDepart', '');
      _brSet('bonRouteDateRetour', '');
      _brSet('bonRouteVehicule', '');
      _brSet('bonRouteChauffeur', '');
      _populateBonRouteDestinations('tunis');
      _brSet('bonRouteAdressePrecise', '');
      _populateBonRouteChantiers('');
      _brSet('bonRouteKmDepart', 0);
      _brSet('bonRouteKmRetour', 0);
      _populateBonRouteStatuts('brouillon');
      _brSet('bonRouteNotes', '');
    }

    /* Rendu des tables (BR4 définit ces fonctions, protégé par typeof) */
    if (typeof renderBonRouteMaterielTable === 'function') {
      try { renderBonRouteMaterielTable(); } catch (e) {}
    }
    if (typeof renderBonRouteDocTable === 'function') {
      try { renderBonRouteDocTable(); } catch (e) {}
    }
    if (typeof _bonRouteToggleTypeSections === 'function') {
      try { _bonRouteToggleTypeSections(_brGet('bonRouteType') || 'sortie'); } catch (e) {}
    }

    modal.style.display = 'flex';

    /* Focus sur le premier champ utile */
    var focusTarget = document.getElementById('bonRouteVehicule');
    if (focusTarget) {
      setTimeout(function () { try { focusTarget.focus(); } catch (e) {} }, 100);
    }
  } catch (e) {
    console.warn('openBonRouteModal :', e);
    if (typeof showToast === 'function') showToast('Erreur à l\'ouverture.', 'error');
  }
}

/* Ferme la modale + nettoie l'état (évite fuite entre 2 ouvertures). */
function closeBonRouteModal() {
  try {
    var modal = document.getElementById('bonRouteModal');
    if (modal) modal.style.display = 'none';
    __bonRouteEditingId = null;
    window.__bonRouteMateriel = [];
    window.__bonRouteDocuments = [];
    _brText('bonRouteFormError', '');
  } catch (e) { console.warn('closeBonRouteModal :', e); }
}

/* ═══════════ SECTION 9 — SAUVEGARDE ═══════════ */

/* Lit le formulaire, normalise, ajoute ou remplace dans bonsRoute.
   - Numéro unique vérifié (numeroBonRouteExiste)
   - Type/statut validés (via _normalizeBonRoute)
   - Date de création : preserve l'originale en édition
   - Incrémente compteur UNIQUEMENT si nouveau
   - Aucun champ montant (hors compta) */
function saveBonRouteFromForm() {
  try {
    var errEl = document.getElementById('bonRouteFormError');
    if (errEl) errEl.textContent = '';

    var id = _brGet('bonRouteId');
    var numero = _brGet('bonRouteNumero');
    var type = _brGet('bonRouteType') || 'sortie';
    var statut = _brGet('bonRouteStatut') || 'brouillon';
    var dateCreation = _brGet('bonRouteDateCreation');
    var dateDepart = _brGet('bonRouteDateDepart');
    var dateRetour = _brGet('bonRouteDateRetour');
    var vehicule = _brGet('bonRouteVehicule');
    var chauffeur = _brGet('bonRouteChauffeur');
    var destination = _brGet('bonRouteDestination') || 'tunis';
    var adressePrecise = _brGet('bonRouteAdressePrecise');
    var chantierId = _brGet('bonRouteChantierSelect');
    var kmDepart = _brGet('bonRouteKmDepart');
    var kmRetour = _brGet('bonRouteKmRetour');
    var notes = _brGet('bonRouteNotes');

    /* ─── Validation minimale ─── */
    if (!numero) {
      if (errEl) errEl.textContent = 'Numéro requis.';
      return false;
    }
    if (!vehicule) {
      if (errEl) errEl.textContent = 'Véhicule requis.';
      return false;
    }
    if (!dateCreation || !isValidDateString(dateCreation)) {
      if (errEl) errEl.textContent = 'Date de création invalide.';
      return false;
    }
    if (dateDepart && !isValidDateString(dateDepart)) {
      if (errEl) errEl.textContent = 'Date de départ invalide.';
      return false;
    }
    if (dateRetour && !isValidDateString(dateRetour)) {
      if (errEl) errEl.textContent = 'Date de retour invalide.';
      return false;
    }
    if (dateDepart && dateRetour && dateRetour < dateDepart) {
      if (errEl) errEl.textContent = 'Date de retour antérieure au départ.';
      return false;
    }

    /* Numéro unique */
    if (numeroBonRouteExiste(numero, id)) {
      if (errEl) errEl.textContent = 'Numéro déjà utilisé : ' + numero;
      return false;
    }

    /* ─── Construction de l'objet brut ─── */
    var existing = id ? getBonRouteById(id) : null;
    var raw = {
      id: id || undefined,
      numero: numero,
      type: type,
      dateCreation: dateCreation,
      dateDepart: dateDepart,
      dateRetour: dateRetour,
      vehicule: vehicule,
      chauffeur: chauffeur,
      destination: destination,
      adressePrecise: adressePrecise,
      chantierId: chantierId,
      kmDepart: kmDepart,
      kmRetour: kmRetour,
      materiel: Array.isArray(window.__bonRouteMateriel) ? window.__bonRouteMateriel.slice() : [],
      documents: Array.isArray(window.__bonRouteDocuments) ? window.__bonRouteDocuments.slice() : [],
      statut: statut,
      notes: notes,
      createdAt: existing ? existing.createdAt : undefined
    };

    var clean = _normalizeBonRoute(raw);
    if (!clean) {
      if (errEl) errEl.textContent = 'Données invalides.';
      return false;
    }

    /* ─── Insertion / remplacement ─── */
    if (!Array.isArray(bonsRoute)) bonsRoute = [];
    if (id) {
      var idx = -1;
      for (var i = 0; i < bonsRoute.length; i++) {
        if (bonsRoute[i] && String(bonsRoute[i].id) === String(id)) { idx = i; break; }
      }
      if (idx < 0) {
        if (errEl) errEl.textContent = 'Bon route introuvable.';
        return false;
      }
      bonsRoute[idx] = clean;
    } else {
      bonsRoute.push(clean);
      /* Nouveau → on incrémente le compteur APRÈS insertion réussie
         (sinon un échec laisserait un trou dans la numérotation) */
      incrementerCompteurBonRoute();
    }

    /* ─── Persistance + log ─── */
    if (typeof saveAll === 'function') saveAll();
    if (typeof logAction === 'function') {
      try {
        logAction(id ? 'bonroute.update' : 'bonroute.create',
          clean.numero + ' ' + clean.type + ' → ' + clean.destination);
      } catch (e) {}
    }

    /* ─── Fermeture + rendu ─── */
    closeBonRouteModal();

    if (typeof renderBonsRoute === 'function') {
      try { renderBonsRoute(); } catch (e) {}
    }
    /* Refresh compteur badge si BR7 l'a câblé */
    if (typeof _updateBonsRouteCount === 'function') {
      try { _updateBonsRouteCount(); } catch (e) {}
    }

    if (typeof showToast === 'function') {
      showToast(id ? 'Bon route modifié : ' + clean.numero
                   : 'Bon route créé : ' + clean.numero,
                   'success', 2500);
    }
    return true;
  } catch (e) {
    console.warn('saveBonRouteFromForm :', e);
    var errEl2 = document.getElementById('bonRouteFormError');
    if (errEl2) errEl2.textContent = 'Erreur : ' + (e.message || 'inconnue');
    return false;
  }
}

/* ═══════════ SECTION 10 — SUPPRESSION + UNDO ═══════════ */

/* Supprime un bon route avec soft delete dans trash.bonsRoute + undo 5s.
   Confirmation requise si le bon n'est pas en brouillon (protection
   contre suppression accidentelle d'un bon déjà envoyé/reçu). */
function deleteBonRoute(id) {
  try {
    var bon = getBonRouteById(id);
    if (!bon) {
      if (typeof showToast === 'function') showToast('Bon route introuvable.', 'error');
      return false;
    }

    /* Confirmation renforcée si le bon est engagé (pas brouillon) */
    if (bon.statut && bon.statut !== 'brouillon') {
      var msg = 'Le bon ' + (bon.numero || '') + ' est en statut « ' +
        _bonRouteStatutLabel(bon.statut) + ' ».\n\nSupprimer quand même ?';
      var ok = (typeof confirmDialog === 'function')
        ? confirmDialog(msg) : window.confirm(msg);
      if (!ok) return false;
    }

    /* Retirer de la collection */
    if (!Array.isArray(bonsRoute)) return false;
    var idx = -1;
    for (var i = 0; i < bonsRoute.length; i++) {
      if (bonsRoute[i] && String(bonsRoute[i].id) === String(id)) { idx = i; break; }
    }
    if (idx < 0) return false;
    bonsRoute.splice(idx, 1);

    /* Push dans trash.bonsRoute (créé à la volée si absent) */
    if (!trash || typeof trash !== 'object') {
      trash = { clients: [], articles: [], documents: [] };
    }
    if (!Array.isArray(trash.bonsRoute)) trash.bonsRoute = [];
    var entry = {
      item: bon,
      deletedAt: new Date().toISOString(),
      deletedBy: (typeof currentUser !== 'undefined' && currentUser && currentUser.username) || 'anon'
    };
    trash.bonsRoute.push(entry);

    /* Persistance + log */
    if (typeof saveAll === 'function') saveAll();
    if (typeof logAction === 'function') {
      try { logAction('bonroute.delete', bon.numero || id); } catch (e) {}
    }

    if (typeof renderBonsRoute === 'function') {
      try { renderBonsRoute(); } catch (e) {}
    }

    /* Undo toast 5s */
    if (typeof showUndoToast === 'function') {
      showUndoToast(
        'Bon route supprimé : ' + (bon.numero || ''),
        function () { _restoreDeletedBonRoute(entry, bon); },
        5000
      );
    } else if (typeof showToast === 'function') {
      showToast('Bon route déplacé dans la corbeille.', 'info', 3000);
    }
    return true;
  } catch (e) {
    console.warn('deleteBonRoute :', e);
    if (typeof showToast === 'function') showToast('Erreur lors de la suppression.', 'error');
    return false;
  }
}

/* Restaure un bon route supprimé (appelé par undo toast).
   - Retire du trash
   - Re-push dans bonsRoute
   - Persiste + rend
   Idempotent : si déjà restauré, ne fait rien. */
function _restoreDeletedBonRoute(entry, obj) {
  try {
    if (!entry || !obj || !obj.id) return false;

    /* Retirer du trash */
    if (trash && Array.isArray(trash.bonsRoute)) {
      var tidx = trash.bonsRoute.indexOf(entry);
      if (tidx >= 0) trash.bonsRoute.splice(tidx, 1);
    }

    /* Éviter doublon (déjà restauré via un autre chemin) */
    if (getBonRouteById(obj.id)) {
      if (typeof showToast === 'function') showToast('Bon route déjà restauré.', 'info', 2000);
      return false;
    }

    /* Re-push */
    if (!Array.isArray(bonsRoute)) bonsRoute = [];
    bonsRoute.push(obj);

    if (typeof saveAll === 'function') saveAll();
    if (typeof logAction === 'function') {
      try { logAction('bonroute.restore', obj.numero || obj.id); } catch (e) {}
    }
    if (typeof renderBonsRoute === 'function') {
      try { renderBonsRoute(); } catch (e) {}
    }
    if (typeof showToast === 'function') {
      showToast('Bon route restauré : ' + (obj.numero || ''), 'success', 2500);
    }
    return true;
  } catch (e) {
    console.warn('_restoreDeletedBonRoute :', e);
    return false;
  }
}

/* ═══════════ SECTION 11 — RENDU LISTE ═══════════ */

/* Rendu principal de la liste des bons route.
   - Container : #bonsRouteList (BR7)
   - Pagination : #bonsRoutePagination (créé à la volée si absent, comme pour Facturation)
   - Compteur  : #bonsRouteCount (BR7)
   - 50 bons par page
   Silencieux si container absent (l'app démarre sans planter avant BR7). */
function renderBonsRoute() {
  try {
    var container = document.getElementById('bonsRouteList');
    if (!container) return;

    var list = getFilteredBonsRoute();
    var total = list.length;

    /* Pagination (créée une seule fois si absente) */
    var pagContainer = document.getElementById('bonsRoutePagination');
    if (!pagContainer && container.parentNode) {
      pagContainer = document.createElement('div');
      pagContainer.id = 'bonsRoutePagination';
      pagContainer.className = 'pagination';
      pagContainer.style.marginTop = '16px';
      pagContainer.style.display = 'flex';
      pagContainer.style.justifyContent = 'center';
      pagContainer.style.alignItems = 'center';
      pagContainer.style.gap = '12px';

      var btnPrev = document.createElement('button');
      btnPrev.id = 'bonsRoutePrevBtn';
      btnPrev.className = 'btn btn-sm';
      btnPrev.textContent = '◀ Précédent';
      btnPrev.onclick = function () { setBonsRoutePage(__bonsRoutePage - 1); };

      var spanInfo = document.createElement('span');
      spanInfo.id = 'bonsRoutePageInfo';
      spanInfo.className = 'muted';
      spanInfo.style.fontSize = '13px';

      var btnNext = document.createElement('button');
      btnNext.id = 'bonsRouteNextBtn';
      btnNext.className = 'btn btn-sm';
      btnNext.textContent = 'Suivant ▶';
      btnNext.onclick = function () { setBonsRoutePage(__bonsRoutePage + 1); };

      pagContainer.appendChild(btnPrev);
      pagContainer.appendChild(spanInfo);
      pagContainer.appendChild(btnNext);

      try {
        container.parentNode.insertBefore(pagContainer, container.nextSibling);
      } catch (e) {}
    }

    if (total === 0) {
      container.innerHTML = '<div class="empty-state">Aucun bon route' +
        (__bonsRouteSearchTerm ||
         __bonsRouteFilterType !== 'all' ||
         __bonsRouteFilterStatut !== 'all' ||
         __bonsRouteFilterDestination !== 'all' ? ' pour ce filtre' : '') +
        '. Clique sur "+ Nouveau bon route" pour commencer.</div>';
      _updateBonsRouteCount(0);
      _updateBonsRoutePagination(0, 0, 0);
      return;
    }

    /* Pagination effective */
    var perPage = __bonsRoutePerPage || 50;
    var page = __bonsRoutePage || 0;
    var maxPage = Math.max(0, Math.ceil(total / perPage) - 1);
    if (page > maxPage) { page = maxPage; __bonsRoutePage = page; }
    var start = page * perPage;
    var end = Math.min(start + perPage, total);
    var slice = list.slice(start, end);

    var html = '';
    for (var i = 0; i < slice.length; i++) {
      html += renderBonRouteRow(slice[i]);
    }
    container.innerHTML = html;

    _updateBonsRouteCount(total);
    _updateBonsRoutePagination(page, maxPage, total);
  } catch (e) {
    console.warn('renderBonsRoute :', e);
  }
}

/* Rendu d'une carte bon route.
   Affiche : numéro, type, statut, trajet, km, dates, chauffeur, chantier lié.
   Actions : 👁️ Détail · ✏️ Éditer · 🗑️ Supprimer.
   Aucun montant (hors compta). */
function renderBonRouteRow(bon) {
  try {
    if (!bon) return '';
    var id = escapeAttr(bon.id);
    var numero = escapeHtml(bon.numero || '—');
    var typeLabel = escapeHtml(_bonRouteTypeLabel(bon.type));
    var statutLabel = escapeHtml(_bonRouteStatutLabel(bon.statut));
    var statutColor = _bonRouteStatutColor(bon.statut);

    /* Trajet : destination + adresse précise si présente */
    var destLabel = BON_ROUTE_DESTINATIONS[bon.destination] || 'Autre';
    var trajet = destLabel;
    if (bon.adressePrecise) {
      trajet += ' — ' + bon.adressePrecise;
    }

    /* Meta : véhicule · chauffeur · dates */
    var metaParts = [];
    if (bon.vehicule) metaParts.push('🚐 ' + escapeHtml(bon.vehicule));
    if (bon.chauffeur) metaParts.push('👤 ' + escapeHtml(bon.chauffeur));
    var dateStr = bon.dateCreation ? escapeHtml(formatDate(bon.dateCreation)) : '';
    if (bon.dateDepart) dateStr += ' → ' + escapeHtml(formatDate(bon.dateDepart));
    if (bon.dateRetour) dateStr += ' → ' + escapeHtml(formatDate(bon.dateRetour));
    if (dateStr) metaParts.push('📅 ' + dateStr);

    var meta = metaParts.join(' · ');

    /* Km parcourus */
    var km = _bonRouteKmParcourus(bon);
    var kmHtml = '';
    if (km > 0) {
      kmHtml = '<span class="bon-route-km" style="color:var(--text-light);font-size:12px;margin-left:8px">' +
        '📍 ' + km + ' km</span>';
    }

    /* Chantier lié (info) */
    var chantierHtml = '';
    if (bon.chantierId && typeof getChantierNom === 'function') {
      var chNom = getChantierNom(bon.chantierId);
      if (chNom) {
        chantierHtml = '<span class="bon-route-chantier" style="color:var(--text-light);font-size:12px;margin-left:8px">🏗️ ' +
          escapeHtml(chNom) + '</span>';
      }
    }

    /* Résumé matériel/documents (1 ligne) */
    var contenuHtml = '';
    if (bon.type === 'sortie' && Array.isArray(bon.materiel) && bon.materiel.length > 0) {
      contenuHtml = '<span class="muted">📦 ' + bon.materiel.length + ' article(s)</span>';
    } else if (bon.type === 'commande' && Array.isArray(bon.documents) && bon.documents.length > 0) {
      contenuHtml = '<span class="muted">📄 ' + bon.documents.length + ' document(s)</span>';
    }

    return '<div class="bon-route-row" data-bon-route-id="' + id + '">' +
      '<div class="bon-route-row-main">' +
        '<div class="bon-route-row-header">' +
          '<span class="doc-type-badge">' + typeLabel + '</span>' +
          ' <strong>' + numero + '</strong>' +
          ' <span class="badge" style="background:' + statutColor + ';color:#fff">' +
            statutLabel + '</span>' +
          kmHtml +
          chantierHtml +
        '</div>' +
        '<div class="bon-route-row-meta">' +
          '📍 ' + escapeHtml(trajet) +
          (contenuHtml ? ' · ' + contenuHtml : '') +
        '</div>' +
        '<div class="bon-route-row-meta muted" style="font-size:11px">' +
          meta +
        '</div>' +
      '</div>' +
      '<div class="bon-route-row-actions">' +
        '<button type="button" class="btn-icon" title="Voir détail" ' +
          'onclick="openBonRouteDetail(\'' + id + '\')">👁️</button>' +
        '<button type="button" class="btn-icon" title="Éditer" ' +
          'onclick="openBonRouteModal(\'' + id + '\')">✏️</button>' +
        '<button type="button" class="btn-icon" title="Imprimer PDF" ' +
          'onclick="if(typeof printBonRoute===\'function\')printBonRoute(\'' + id + '\')">🖨️</button>' +
        '<button type="button" class="btn-icon btn-danger" title="Supprimer" ' +
          'onclick="deleteBonRoute(\'' + id + '\')">🗑️</button>' +
      '</div>' +
    '</div>';
  } catch (e) {
    console.warn('renderBonRouteRow :', e);
    return '';
  }
}

/* Met à jour le compteur #bonsRouteCount. */
function _updateBonsRouteCount(n) {
  try {
    var el = document.getElementById('bonsRouteCount');
    if (el) el.textContent = String(n);
  } catch (e) {}
}

/* Met à jour l'UI de pagination. */
function _updateBonsRoutePagination(page, maxPage, total) {
  try {
    var info = document.getElementById('bonsRoutePageInfo');
    if (info) {
      info.textContent = total > 0
        ? 'Page ' + (page + 1) + ' / ' + (maxPage + 1) + ' — ' + total + ' bon(s)'
        : '0 bon';
    }
    var prev = document.getElementById('bonsRoutePrevBtn');
    if (prev) prev.disabled = (page <= 0);
    var next = document.getElementById('bonsRouteNextBtn');
    if (next) next.disabled = (page >= maxPage);
  } catch (e) {}
}

/* Change la page courante (clampée). */
function setBonsRoutePage(p) {
  __bonsRoutePage = Math.max(0, parseInt(p, 10) || 0);
  renderBonsRoute();
}

/* ═══════════ SECTION 12 — FILTRES + RECHERCHE ═══════════ */

function setBonsRouteSearch(term) {
  __bonsRouteSearchTerm = String(term || '');
  __bonsRoutePage = 0;
  renderBonsRoute();
}

function setBonsRouteFilterType(type) {
  __bonsRouteFilterType = String(type || 'all');
  __bonsRoutePage = 0;
  renderBonsRoute();
}

function setBonsRouteFilterStatut(statut) {
  __bonsRouteFilterStatut = String(statut || 'all');
  __bonsRoutePage = 0;
  renderBonsRoute();
}

function setBonsRouteFilterDestination(dest) {
  __bonsRouteFilterDestination = String(dest || 'all');
  __bonsRoutePage = 0;
  renderBonsRoute();
}

/* Retourne la liste filtrée + triée.
   Ordre : date de création décroissante (plus récent en haut).
   Filtres appliqués dans cet ordre :
     1. Recherche texte (numéro, véhicule, chauffeur, destination, notes,
        matériel[].designation, documents[].designation, documents[].reference)
     2. Type   (all / sortie / commande / deplacement)
     3. Statut (all / brouillon / envoye / recu / retourne / archive)
     4. Destination (all / tunis / sfax / autre) */
function getFilteredBonsRoute() {
  try {
    var arr = _getBonsRouteArray();
    if (!arr.length) return [];
    var out = arr.slice();

    /* 1. Recherche texte */
    if (__bonsRouteSearchTerm) {
      var term = normalizeText(__bonsRouteSearchTerm);
      out = out.filter(function (b) {
        if (!b) return false;
        /* Champs directs */
        var hay = normalizeText([
          b.numero, b.vehicule, b.chauffeur, b.adressePrecise, b.notes,
          BON_ROUTE_DESTINATIONS[b.destination] || ''
        ].join(' '));

        if (hay.indexOf(term) >= 0) return true;

        /* Recherche dans le matériel */
        if (Array.isArray(b.materiel)) {
          for (var i = 0; i < b.materiel.length; i++) {
            var m = b.materiel[i];
            if (!m) continue;
            if (normalizeText(m.designation || '').indexOf(term) >= 0) return true;
            if (normalizeText(m.observation || '').indexOf(term) >= 0) return true;
          }
        }

        /* Recherche dans les documents */
        if (Array.isArray(b.documents)) {
          for (var j = 0; j < b.documents.length; j++) {
            var d = b.documents[j];
            if (!d) continue;
            if (normalizeText(d.reference || '').indexOf(term) >= 0) return true;
            if (normalizeText(d.designation || '').indexOf(term) >= 0) return true;
            if (normalizeText(d.fournisseur || '').indexOf(term) >= 0) return true;
          }
        }
        return false;
      });
    }

    /* 2. Type */
    if (__bonsRouteFilterType && __bonsRouteFilterType !== 'all') {
      var t = String(__bonsRouteFilterType).toLowerCase();
      out = out.filter(function (b) { return b && b.type === t; });
    }

    /* 3. Statut */
    if (__bonsRouteFilterStatut && __bonsRouteFilterStatut !== 'all') {
      var s = String(__bonsRouteFilterStatut).toLowerCase();
      out = out.filter(function (b) { return b && b.statut === s; });
    }

    /* 4. Destination */
    if (__bonsRouteFilterDestination && __bonsRouteFilterDestination !== 'all') {
      var dest = String(__bonsRouteFilterDestination).toLowerCase();
      out = out.filter(function (b) { return b && b.destination === dest; });
    }

    /* Tri : date création décroissante (plus récent d'abord).
       Fallback : updatedAt si dateCreation absent. */
    out.sort(function (a, b) {
      var da = String((a && a.dateCreation) || (a && a.updatedAt) || '');
      var db = String((b && b.dateCreation) || (b && b.updatedAt) || '');
      if (da === db) {
        /* 2ᵉ critère : numéro (BR-2026-0001 < BR-2026-0002) */
        var na = String((a && a.numero) || '');
        var nb = String((b && b.numero) || '');
        return na < nb ? 1 : (na > nb ? -1 : 0);
      }
      return da < db ? 1 : -1;
    });

    return out;
  } catch (e) {
    console.warn('getFilteredBonsRoute :', e);
    return [];
  }
}

/* ═══════════ SECTION 13 — DÉTAIL (modale) ═══════════ */

/* Ouvre la modale de détail (lecture seule).
   Le HTML #bonRouteDetailModal est créé en BR4. */
function openBonRouteDetail(id) {
  try {
    var bon = getBonRouteById(id);
    if (!bon) {
      if (typeof showToast === 'function') showToast('Bon route introuvable.', 'error');
      return;
    }

    var modal = document.getElementById('bonRouteDetailModal');
    if (!modal) {
      if (typeof showToast === 'function') {
        showToast('Modale de détail indisponible (BR4 à venir).', 'info', 3000);
      }
      return;
    }

    var body = document.getElementById('bonRouteDetailBody');
    var title = document.getElementById('bonRouteDetailTitle');

    if (title) title.textContent = 'Bon route ' + (bon.numero || '');

    if (body) {
      var html = '';

      /* Bloc en-tête : type + statut + dates */
      html += '<div class="detail-section">';
      html += '<h3>Informations générales</h3>';
      html += '<div class="detail-grid">';
      html += _brDetailItem('Numéro', bon.numero || '—');
      html += _brDetailItem('Type', _bonRouteTypeLabel(bon.type));
      html += _brDetailItem('Statut', _bonRouteStatutLabel(bon.statut));
      html += _brDetailItem('Date création', bon.dateCreation ? formatDate(bon.dateCreation) : '—');
      html += _brDetailItem('Date départ', bon.dateDepart ? formatDate(bon.dateDepart) : '—');
      html += _brDetailItem('Date retour', bon.dateRetour ? formatDate(bon.dateRetour) : '—');
      html += '</div>';
      html += '</div>';

      /* Bloc trajet */
      html += '<div class="detail-section">';
      html += '<h3>Trajet</h3>';
      html += '<div class="detail-grid">';
      html += _brDetailItem('Destination',
        BON_ROUTE_DESTINATIONS[bon.destination] || 'Autre');
      if (bon.adressePrecise) {
        html += _brDetailItem('Adresse précise', bon.adressePrecise);
      }
      html += _brDetailItem('Véhicule', bon.vehicule || '—');
      html += _brDetailItem('Chauffeur', bon.chauffeur || '—');
      html += _brDetailItem('Km départ', String(bon.kmDepart || 0));
      html += _brDetailItem('Km retour', String(bon.kmRetour || 0));
      html += _brDetailItem('Km parcourus', String(_bonRouteKmParcourus(bon)));
      if (bon.chantierId && typeof getChantierNom === 'function') {
        html += _brDetailItem('Chantier lié (info)', getChantierNom(bon.chantierId) || '—');
      }
      html += '</div>';
      html += '</div>';

      /* Bloc matériel (type sortie) */
      if (bon.type === 'sortie' && Array.isArray(bon.materiel) && bon.materiel.length > 0) {
        html += '<div class="detail-section">';
        html += '<h3>Matériel sorti (' + bon.materiel.length + ')</h3>';
        html += '<table class="invoice-detail-table"><thead><tr>' +
          '<th>Désignation</th><th class="right">Qté</th>' +
          '<th>Unité</th><th>Observation</th></tr></thead><tbody>';
        for (var i = 0; i < bon.materiel.length; i++) {
          var m = bon.materiel[i];
          html += '<tr><td>' + escapeHtml(m.designation || '') + '</td>' +
            '<td class="right">' + escapeHtml(String(m.quantite || 0)) + '</td>' +
            '<td>' + escapeHtml(m.unite || 'U') + '</td>' +
            '<td>' + escapeHtml(m.observation || '') + '</td></tr>';
        }
        html += '</tbody></table></div>';
      }

      /* Bloc documents (type commande) */
      if (bon.type === 'commande' && Array.isArray(bon.documents) && bon.documents.length > 0) {
        html += '<div class="detail-section">';
        html += '<h3>Documents commandés (' + bon.documents.length + ')</h3>';
        html += '<table class="invoice-detail-table"><thead><tr>' +
          '<th>Réf.</th><th>Désignation</th><th>Fournisseur</th>' +
          '<th class="right">Qté</th><th>Observation</th></tr></thead><tbody>';
        for (var j = 0; j < bon.documents.length; j++) {
          var d = bon.documents[j];
          html += '<tr><td>' + escapeHtml(d.reference || '') + '</td>' +
            '<td>' + escapeHtml(d.designation || '') + '</td>' +
            '<td>' + escapeHtml(d.fournisseur || '') + '</td>' +
            '<td class="right">' + escapeHtml(String(d.quantite || 0)) + '</td>' +
            '<td>' + escapeHtml(d.observation || '') + '</td></tr>';
        }
        html += '</tbody></table></div>';
      }

      /* Bloc notes */
      if (bon.notes) {
        html += '<div class="detail-section">';
        html += '<h3>Notes</h3>';
        html += '<p class="detail-notes">' + escapeHtml(bon.notes).replace(/\n/g, '<br>') + '</p>';
        html += '</div>';
      }

      /* Actions */
      html += '<div class="detail-section detail-actions">';
      html += '<button type="button" class="btn" ' +
        'onclick="closeBonRouteDetail()">Fermer</button> ';
      html += '<button type="button" class="btn btn-primary" ' +
        'onclick="closeBonRouteDetail(); openBonRouteModal(\'' + escapeAttr(bon.id) + '\')">✏️ Éditer</button> ';
      if (typeof printBonRoute === 'function') {
        html += '<button type="button" class="btn" ' +
          'onclick="printBonRoute(\'' + escapeAttr(bon.id) + '\')">🖨️ PDF</button>';
      }
      html += '</div>';

      body.innerHTML = html;
    }

    modal.style.display = 'flex';
  } catch (e) {
    console.warn('openBonRouteDetail :', e);
  }
}

function closeBonRouteDetail() {
  try {
    var modal = document.getElementById('bonRouteDetailModal');
    if (modal) modal.style.display = 'none';
  } catch (e) {}
}

/* Petit helper de bloc détail (label + value). */
function _brDetailItem(label, value) {
  return '<div class="detail-item">' +
    '<div class="detail-label">' + escapeHtml(label) + '</div>' +
    '<div class="detail-value">' + escapeHtml(String(value || '—')) + '</div>' +
    '</div>';
}

/* ═══════════ SECTION 14 — SECTIONS TYPE (matériel vs documents) ═══════════ */

/* Affiche/cache les sections matériel et documents selon le type.
   - sortie      : matériel visible, documents cachés
   - commande    : matériel caché, documents visibles
   - deplacement : les deux cachés */
function _bonRouteToggleTypeSections(type) {
  try {
    var t = String(type || 'sortie').toLowerCase();
    var matSec = document.getElementById('bonRouteMaterielSection');
    var docSec = document.getElementById('bonRouteDocSection');
    if (matSec) matSec.style.display = (t === 'sortie') ? '' : 'none';
    if (docSec) docSec.style.display = (t === 'commande') ? '' : 'none';
  } catch (e) { console.warn('_bonRouteToggleTypeSections :', e); }
}

/* ═══════════ SECTION 15 — MATÉRIEL (tables dynamiques) ═══════════ */

function addBonRouteMaterielLine() {
  try {
    if (!Array.isArray(window.__bonRouteMateriel)) window.__bonRouteMateriel = [];
    window.__bonRouteMateriel.push({
      designation: '', quantite: 1, unite: 'U', observation: ''
    });
    renderBonRouteMaterielTable();
    /* Focus sur la première cellule de la nouvelle ligne */
    var focusEl = document.querySelector('#bonRouteMaterielBody tr:last-child input');
    if (focusEl) setTimeout(function () { try { focusEl.focus(); } catch (e) {} }, 50);
  } catch (e) { console.warn('addBonRouteMaterielLine :', e); }
}

function removeBonRouteMaterielLine(index) {
  try {
    if (!Array.isArray(window.__bonRouteMateriel)) return;
    if (index < 0 || index >= window.__bonRouteMateriel.length) return;
    window.__bonRouteMateriel.splice(index, 1);
    renderBonRouteMaterielTable();
  } catch (e) { console.warn('removeBonRouteMaterielLine :', e); }
}

function updateBonRouteMaterielLine(index, field, value) {
  try {
    if (!Array.isArray(window.__bonRouteMateriel)) return;
    var m = window.__bonRouteMateriel[index];
    if (!m) return;
    if (field === 'quantite') {
      var q = parseNumber(value);
      if (q < 0) q = 0;
      if (q > BON_ROUTE_MAX_QUANTITE) q = BON_ROUTE_MAX_QUANTITE;
      m[field] = q;
    } else {
      m[field] = String(value || '').slice(0, 200);
    }
  } catch (e) { console.warn('updateBonRouteMaterielLine :', e); }
}

function renderBonRouteMaterielTable() {
  try {
    var tbody = document.getElementById('bonRouteMaterielBody');
    if (!tbody) return;
    if (!Array.isArray(window.__bonRouteMateriel)) window.__bonRouteMateriel = [];
    var html = '';
    var arr = window.__bonRouteMateriel;
    for (var i = 0; i < arr.length; i++) {
      var m = arr[i] || {};
      html += '<tr>' +
        '<td><input type="text" value="' + escapeAttr(m.designation || '') + '" ' +
          'oninput="if(typeof updateBonRouteMaterielLine===\'function\')updateBonRouteMaterielLine(' + i + ', \'designation\', this.value)" ' +
          'placeholder="Désignation" maxlength="200"></td>' +
        '<td class="col-qte"><input type="number" min="0" step="0.01" ' +
          'value="' + escapeAttr(m.quantite || '') + '" ' +
          'oninput="if(typeof updateBonRouteMaterielLine===\'function\')updateBonRouteMaterielLine(' + i + ', \'quantite\', this.value)"></td>' +
        '<td class="col-unite"><input type="text" value="' + escapeAttr(m.unite || 'U') + '" ' +
          'oninput="if(typeof updateBonRouteMaterielLine===\'function\')updateBonRouteMaterielLine(' + i + ', \'unite\', this.value)" maxlength="20"></td>' +
        '<td><input type="text" value="' + escapeAttr(m.observation || '') + '" ' +
          'oninput="if(typeof updateBonRouteMaterielLine===\'function\')updateBonRouteMaterielLine(' + i + ', \'observation\', this.value)" ' +
          'placeholder="Observation" maxlength="300"></td>' +
        '<td class="col-action"><button type="button" class="btn-icon btn-danger" ' +
          'onclick="if(typeof removeBonRouteMaterielLine===\'function\')removeBonRouteMaterielLine(' + i + ')" ' +
          'title="Supprimer">🗑️</button></td>' +
        '</tr>';
    }
    if (arr.length === 0) {
      html = '<tr><td colspan="5" class="empty-items">Aucune ligne. Clique sur "+ Ajouter une ligne".</td></tr>';
    }
    tbody.innerHTML = html;
  } catch (e) { console.warn('renderBonRouteMaterielTable :', e); }
}

/* ═══════════ SECTION 16 — DOCUMENTS (tables dynamiques) ═══════════ */

function addBonRouteDocLine() {
  try {
    if (!Array.isArray(window.__bonRouteDocuments)) window.__bonRouteDocuments = [];
    window.__bonRouteDocuments.push({
      reference: '', designation: '', fournisseur: '', quantite: 1, observation: ''
    });
    renderBonRouteDocTable();
    var focusEl = document.querySelector('#bonRouteDocBody tr:last-child input');
    if (focusEl) setTimeout(function () { try { focusEl.focus(); } catch (e) {} }, 50);
  } catch (e) { console.warn('addBonRouteDocLine :', e); }
}

function removeBonRouteDocLine(index) {
  try {
    if (!Array.isArray(window.__bonRouteDocuments)) return;
    if (index < 0 || index >= window.__bonRouteDocuments.length) return;
    window.__bonRouteDocuments.splice(index, 1);
    renderBonRouteDocTable();
  } catch (e) { console.warn('removeBonRouteDocLine :', e); }
}

function updateBonRouteDocLine(index, field, value) {
  try {
    if (!Array.isArray(window.__bonRouteDocuments)) return;
    var d = window.__bonRouteDocuments[index];
    if (!d) return;
    if (field === 'quantite') {
      var q = parseNumber(value);
      if (q < 0) q = 0;
      if (q > BON_ROUTE_MAX_QUANTITE) q = BON_ROUTE_MAX_QUANTITE;
      d[field] = q;
    } else {
      var maxLen = (field === 'reference') ? 80 : (field === 'fournisseur') ? 120 : 200;
      d[field] = String(value || '').slice(0, maxLen);
    }
  } catch (e) { console.warn('updateBonRouteDocLine :', e); }
}

function renderBonRouteDocTable() {
  try {
    var tbody = document.getElementById('bonRouteDocBody');
    if (!tbody) return;
    if (!Array.isArray(window.__bonRouteDocuments)) window.__bonRouteDocuments = [];
    var html = '';
    var arr = window.__bonRouteDocuments;
    for (var i = 0; i < arr.length; i++) {
      var d = arr[i] || {};
      html += '<tr>' +
        '<td style="width:100px"><input type="text" value="' + escapeAttr(d.reference || '') + '" ' +
          'oninput="if(typeof updateBonRouteDocLine===\'function\')updateBonRouteDocLine(' + i + ', \'reference\', this.value)" ' +
          'placeholder="Réf." maxlength="80"></td>' +
        '<td><input type="text" value="' + escapeAttr(d.designation || '') + '" ' +
          'oninput="if(typeof updateBonRouteDocLine===\'function\')updateBonRouteDocLine(' + i + ', \'designation\', this.value)" ' +
          'placeholder="Désignation" maxlength="200"></td>' +
        '<td style="width:150px"><input type="text" value="' + escapeAttr(d.fournisseur || '') + '" ' +
          'oninput="if(typeof updateBonRouteDocLine===\'function\')updateBonRouteDocLine(' + i + ', \'fournisseur\', this.value)" ' +
          'placeholder="Fournisseur" maxlength="120"></td>' +
        '<td class="col-qte"><input type="number" min="0" step="0.01" ' +
          'value="' + escapeAttr(d.quantite || '') + '" ' +
          'oninput="if(typeof updateBonRouteDocLine===\'function\')updateBonRouteDocLine(' + i + ', \'quantite\', this.value)"></td>' +
        '<td><input type="text" value="' + escapeAttr(d.observation || '') + '" ' +
          'oninput="if(typeof updateBonRouteDocLine===\'function\')updateBonRouteDocLine(' + i + ', \'observation\', this.value)" ' +
          'placeholder="Observation" maxlength="300"></td>' +
        '<td class="col-action"><button type="button" class="btn-icon btn-danger" ' +
          'onclick="if(typeof removeBonRouteDocLine===\'function\')removeBonRouteDocLine(' + i + ')" ' +
          'title="Supprimer">🗑️</button></td>' +
        '</tr>';
    }
    if (arr.length === 0) {
      html = '<tr><td colspan="6" class="empty-items">Aucune ligne. Clique sur "+ Ajouter une ligne".</td></tr>';
    }
    tbody.innerHTML = html;
  } catch (e) { console.warn('renderBonRouteDocTable :', e); }
}

/* ═══════════ SECTION 17 — IMPRESSION PDF ═══════════ */

/* Ouvre une popup d'impression avec le bon route formaté.
   Le navigateur propose « Enregistrer en PDF » dans la boîte d'impression.
   Refuse proprement si :
     • bonId absent / bon introuvable
     • popup bloquée par le navigateur (fallback toast explicite)
   N'écrit RIEN dans les données (lecture seule). */
function printBonRoute(bonId) {
  try {
    var bon = getBonRouteById(bonId);
    if (!bon) {
      if (typeof showToast === 'function') showToast('Bon route introuvable.', 'error');
      return;
    }

    /* v6.9.6 — charge signature + cachet par défaut avant génération */
    var imagesPromise = (typeof _loadDefaultSignatureCachetImages === 'function')
      ? _loadDefaultSignatureCachetImages()
      : Promise.resolve({ signatureDataUrl: null, cachetDataUrl: null });

    imagesPromise.then(function (images) {
      try {
        var html = _buildBonRouteHTML(bon, images);
        var w = window.open('', '_blank');
        if (!w) {
          if (typeof showToast === 'function') {
            showToast('Autorise les pop-ups pour imprimer le bon route.', 'warning', 4000);
          }
          return;
        }
        w.document.open();
        w.document.write(html);
        w.document.close();
        setTimeout(function () { try { w.focus(); w.print(); } catch (e) {} }, 400);
        if (typeof logAction === 'function') {
          try { logAction('bonroute.print', bon.numero || bonId); } catch (e) {}
        }
      } catch (e) { console.warn('printBonRoute (inner) :', e); }
    }).catch(function (e) {
      console.warn('printBonRoute (images load) :', e);
      try {
        var html = _buildBonRouteHTML(bon, {});
        var w = window.open('', '_blank');
        if (w) {
          w.document.open(); w.document.write(html); w.document.close();
          setTimeout(function () { try { w.focus(); w.print(); } catch (e) {} }, 400);
        }
      } catch (e2) {}
    });
  } catch (e) {
    console.warn('printBonRoute :', e);
    if (typeof showToast === 'function') showToast('Erreur lors de l\'impression.', 'error');
  }
}

/* Construit le HTML complet du bon route (aligné facture.html).
   Différences vs _buildInvoiceHTML :
     • Aucun total / TVA / paiement / retenue (hors compta par design)
     • Un seul tableau : matériel OU documents selon le type
     • Bloc trajet dédié (véhicule + chauffeur + km + dates)
     • Zone signature chauffeur (justificatif papier)
   Retourne une chaîne HTML autonome. */
function _buildBonRouteHTML(bon, opts) {
  /* v6.9.6 — opts (optionnel) : { signatureDataUrl, cachetDataUrl } */
  var _images = opts || {};
  var t = BON_ROUTE_TYPES[bon.type] || BON_ROUTE_TYPES.sortie;
  var destLabel = BON_ROUTE_DESTINATIONS[bon.destination] || 'Autre';
  var statutLabel = _bonRouteStatutLabel(bon.statut);
  var kmParcourus = _bonRouteKmParcourus(bon);

  /* Titre : « BON DE SORTIE N° BR-2026-0001 » */
  var titre = String(t.label || 'Bon route').toUpperCase() + ' N° ' + (bon.numero || '—');

  /* Chantier lié (info, jamais lu par compta) */
  var chantierNom = '';
  if (bon.chantierId && typeof getChantierNom === 'function') {
    chantierNom = getChantierNom(bon.chantierId) || '';
  }

  /* ─── Lignes tableau (matériel OU documents) ─── */
  var lignesHtml = '';
  if (bon.type === 'sortie' && Array.isArray(bon.materiel)) {
    for (var i = 0; i < bon.materiel.length; i++) {
      var m = bon.materiel[i];
      if (!m) continue;
      lignesHtml += '<tr>' +
        '<td>' + escapeHtml(m.designation || '') + '</td>' +
        '<td class="text-center">' + escapeHtml(String(m.quantite || 0)) + '</td>' +
        '<td class="text-center">' + escapeHtml(m.unite || 'U') + '</td>' +
        '<td>' + escapeHtml(m.observation || '') + '</td>' +
        '</tr>';
    }
    if (!lignesHtml) {
      lignesHtml = '<tr><td colspan="4" style="text-align:center;color:#999;padding:16px">(Aucun matériel listé)</td></tr>';
    }
  } else if (bon.type === 'commande' && Array.isArray(bon.documents)) {
    for (var j = 0; j < bon.documents.length; j++) {
      var d = bon.documents[j];
      if (!d) continue;
      lignesHtml += '<tr>' +
        '<td>' + escapeHtml(d.reference || '') + '</td>' +
        '<td>' + escapeHtml(d.designation || '') + '</td>' +
        '<td>' + escapeHtml(d.fournisseur || '') + '</td>' +
        '<td class="text-center">' + escapeHtml(String(d.quantite || 0)) + '</td>' +
        '<td>' + escapeHtml(d.observation || '') + '</td>' +
        '</tr>';
    }
    if (!lignesHtml) {
      lignesHtml = '<tr><td colspan="5" style="text-align:center;color:#999;padding:16px">(Aucun document listé)</td></tr>';
    }
  } else {
    /* Type deplacement : pas de tableau, juste le trajet */
    lignesHtml = '';
  }

  /* ─── Tableau selon type ─── */
  var tableauHtml = '';
  if (bon.type === 'sortie') {
    tableauHtml =
      '<table class="items">' +
      '<thead><tr>' +
      '<th style="text-align:left;width:50%">Désignation</th>' +
      '<th style="text-align:center;width:12%">Qté</th>' +
      '<th style="text-align:center;width:10%">Unité</th>' +
      '<th style="text-align:left;width:28%">Observation</th>' +
      '</tr></thead>' +
      '<tbody>' + lignesHtml + '</tbody></table>';
  } else if (bon.type === 'commande') {
    tableauHtml =
      '<table class="items">' +
      '<thead><tr>' +
      '<th style="text-align:left;width:14%">Réf.</th>' +
      '<th style="text-align:left;width:30%">Désignation</th>' +
      '<th style="text-align:left;width:20%">Fournisseur</th>' +
      '<th style="text-align:center;width:10%">Qté</th>' +
      '<th style="text-align:left;width:26%">Observation</th>' +
      '</tr></thead>' +
      '<tbody>' + lignesHtml + '</tbody></table>';
  }

  /* ─── Bloc trajet ─── */
  var trajetHtml = '';
  trajetHtml += '<div class="info-box">';
  trajetHtml += '<div class="info-row"><span class="info-label">Véhicule</span><span class="info-value">' +
    escapeHtml(bon.vehicule || '—') + '</span></div>';
  trajetHtml += '<div class="info-row"><span class="info-label">Chauffeur</span><span class="info-value">' +
    escapeHtml(bon.chauffeur || '—') + '</span></div>';
  trajetHtml += '<div class="info-row"><span class="info-label">Destination</span><span class="info-value">' +
    escapeHtml(destLabel) + (bon.adressePrecise ? ' — ' + escapeHtml(bon.adressePrecise) : '') + '</span></div>';
  if (chantierNom) {
    trajetHtml += '<div class="info-row"><span class="info-label">Chantier lié (info)</span><span class="info-value">' +
      escapeHtml(chantierNom) + '</span></div>';
  }
  trajetHtml += '<div class="info-row"><span class="info-label">Date départ</span><span class="info-value">' +
    (bon.dateDepart ? escapeHtml(formatDate(bon.dateDepart)) : '—') + '</span></div>';
  trajetHtml += '<div class="info-row"><span class="info-label">Date retour</span><span class="info-value">' +
    (bon.dateRetour ? escapeHtml(formatDate(bon.dateRetour)) : '—') + '</span></div>';
  trajetHtml += '<div class="info-row"><span class="info-label">Kilométrage</span><span class="info-value">' +
    'Départ : ' + escapeHtml(String(bon.kmDepart || 0)) + ' km' +
    ' · Retour : ' + escapeHtml(String(bon.kmRetour || 0)) + ' km' +
    ' · Parcourus : <strong>' + kmParcourus + ' km</strong></span></div>';
  trajetHtml += '</div>';

  /* ─── Bloc notes ─── */
  var notesHtml = '';
  if (bon.notes) {
    notesHtml = '<div class="observation"><strong>Notes :</strong> ' +
      escapeHtml(bon.notes).replace(/\n/g, '<br>') + '</div>';
  }

  /* ─── Variables société ─── */
  var mfVal     = (typeof bankMF !== 'undefined' && bankMF)       ? bankMF       : '1977463P / A / M / 000';
  var ribVal    = (typeof bankRib !== 'undefined' && bankRib)     ? bankRib      : '07 054 0112101102584 69';
  var banqueVal = (typeof bankName !== 'undefined' && bankName)   ? bankName     : 'AMEN BANK';
  var rneVal    = (typeof bankRNE !== 'undefined' && bankRNE)     ? bankRNE      : '1977463P';

  /* ─── Logo ─── */
  var logo = (typeof getLogo === 'function') ? getLogo() : '';
  var logoHtml;
  if (logo) {
    logoHtml = '<img src="' + escapeAttr(logo) + '" style="max-height:60px;max-width:200px" alt="Logo">';
  } else {
    logoHtml = '<div class="logo-text">' +
      '<h1>VOLT<span>CORE</span></h1>' +
      '<div class="sub">INGÉNIERIE · ÉLECTRICITÉ · BÂTIMENT</div>' +
      '<div class="logo-underline"><div class="gold"></div><div class="red"></div></div>' +
      '</div>';
  }

  /* ─── Assemblage HTML ─── */
  var html = '<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><title>' +
    escapeHtml(titre) + '</title><style>';
  html += '@page{size:A4;margin:15mm}';
  html += '*{margin:0;padding:0;box-sizing:border-box}';
  html += 'body{font-family:\'Calibri\',\'Segoe UI\',Arial,sans-serif;background:#fff;padding:10px;font-size:11px;color:#1A2B4C;-webkit-print-color-adjust:exact;print-color-adjust:exact}';
  html += '.wrapper{max-width:950px;margin:0 auto;padding:20px 28px}';
  html += '.header{display:flex;justify-content:space-between;align-items:center;border-bottom:2px solid #C9A84C;padding-bottom:16px;margin-bottom:16px;flex-wrap:wrap;gap:10px}';
  html += '.logo-text h1{font-size:34px;font-weight:900;color:#1A2B4C;letter-spacing:1.5px;line-height:1;margin-bottom:4px}';
  html += '.logo-text h1 span{color:#E70013}';
  html += '.logo-text .sub{font-size:10px;color:#C9A84C;letter-spacing:3px;font-weight:700;text-transform:uppercase;margin-bottom:6px}';
  html += '.logo-underline{display:flex;height:3px;width:100%}';
  html += '.logo-underline .gold{width:65%;background:#C9A84C}';
  html += '.logo-underline .red{width:35%;background:#E70013}';
  html += '.company-info{text-align:right;font-size:10px;line-height:1.6;color:#2c3e66}';
  html += '.company-info strong{color:#1A2B4C}';
  html += '.title{text-align:center;font-size:22px;font-weight:700;color:#E70013;margin:4px 0 16px;letter-spacing:1px}';
  html += '.meta-box{background:#F9FAFE;padding:12px 18px;border-radius:10px;border-left:4px solid #C9A84C;display:flex;justify-content:space-between;flex-wrap:wrap;gap:15px;margin-bottom:16px;font-size:11px;line-height:1.5}';
  html += '.meta-box strong{color:#1A2B4C}';
  html += '.info-box{background:#FEFCF5;border:1px solid #F0E5D0;border-radius:8px;padding:12px 16px;margin-bottom:16px;font-size:11px}';
  html += '.info-row{display:flex;padding:4px 0;border-bottom:1px dashed #F0E5D0}';
  html += '.info-row:last-child{border-bottom:none}';
  html += '.info-label{width:35%;font-weight:600;color:#666;text-transform:uppercase;font-size:9px;letter-spacing:0.5px;padding-top:2px}';
  html += '.info-value{width:65%;color:#1A2B4C}';
  html += 'table.items{width:100%;border-collapse:collapse;margin:12px 0;font-size:11px}';
  html += 'table.items th{background:#1A2B4C;color:#fff;padding:10px 8px;font-weight:600;letter-spacing:0.5px}';
  html += 'table.items td{padding:8px;border-bottom:1px solid #e0e4e9;vertical-align:middle}';
  html += 'table.items tr:nth-child(even) td{background:#F9FAFE}';
  html += '.text-center{text-align:center}';
  html += '.observation{background:#f8f9fa;padding:10px 16px;border-radius:8px;font-size:10px;color:#444;border-left:3px solid #C9A84C;margin:12px 0 16px}';
  html += '.footer{border-top:1px solid #ddd;padding-top:12px;margin-top:16px;font-size:8px;text-align:center;color:#555;line-height:1.6}';
  html += '.footer strong{color:#1A2B4C}';
  html += '.footer .bank{margin-top:6px}';
  html += '.signature-area{display:flex;justify-content:space-between;margin-top:30px;font-size:10px}';
  html += '.signature-area div{width:38%;border-top:1px solid #999;padding-top:8px;text-align:center;color:#1A2B4C;font-weight:600}';
  html += '@media print{body{padding:0}.wrapper{padding:0}}';
  html += '</style></head><body>';

  html += '<div class="wrapper">';

  /* Header */
  html += '<div class="header">';
  html += '<div class="logo-title">' + logoHtml + '</div>';
  html += '<div class="company-info">';
  html += '<strong>VOLTCORE INGENIERIE</strong><br>';
  html += 'Route Soukra KM 3, Cité El Habib<br>';
  html += 'Sfax Ouest – 3052, Tunisie<br>';
  html += '<strong>MF :</strong> ' + escapeHtml(mfVal) + '<br>';
  html += '<strong>RNE :</strong> ' + escapeHtml(rneVal) + '<br>';
  html += 'Tél : +216 51 176 186';
  html += '</div>';
  html += '</div>';

  /* Titre */
  html += '<div class="title">' + escapeHtml(titre) + '</div>';

  /* Bloc méta : type + statut + dates + numéro */
  html += '<div class="meta-box">';
  html += '<div>';
  html += '<strong>Type :</strong> ' + escapeHtml(t.label || '') + '<br>';
  html += '<strong>Statut :</strong> ' + escapeHtml(statutLabel);
  html += '</div>';
  html += '<div>';
  html += '<strong>Date création :</strong> ' +
    (bon.dateCreation ? escapeHtml(formatDate(bon.dateCreation)) : '—') + '<br>';
  html += '<strong>Numéro :</strong> ' + escapeHtml(bon.numero || '—');
  html += '</div>';
  html += '</div>';

  /* Bloc trajet */
  html += trajetHtml;

  /* Tableau (si pertinent) */
  html += tableauHtml;

  /* Notes */
  html += notesHtml;

  /* Mention « hors comptabilité » */
  html += '<div style="text-align:center;font-size:9px;color:#999;margin-top:20px;font-style:italic">' +
    'Document interne de traçabilité — n\'a pas valeur de facture ni de bon de commande comptable.</div>';

  /* Footer */
  html += '<div class="footer">';
  html += '<div><strong>VOLTCORE INGENIERIE</strong> – SARL au capital 20 000 TND – RNE ' + escapeHtml(rneVal) + '</div>';
  html += '<div class="bank"><strong>Coordonnées bancaires :</strong> ' + escapeHtml(banqueVal) + ' – RIB : ' + escapeHtml(ribVal) + '</div>';
  html += '</div>';

  /* Signatures — v6.9.6 : images par défaut si configurées */
  html += '<div class="signature-area">';
  if (_images.cachetDataUrl) {
    html += '<div>';
    html += '<img src="' + escapeAttr(_images.cachetDataUrl) + '" ' +
      'style="max-height:60px;max-width:180px;display:block;margin:0 auto 4px;mix-blend-mode:multiply" alt="Cachet">';
    html += '<span style="font-size:8px;color:#666">Cachet VOLTCORE</span>';
    html += '</div>';
  } else {
    html += '<div>Cachet & Signature VOLTCORE</div>';
  }
  if (_images.signatureDataUrl) {
    html += '<div>';
    html += '<img src="' + escapeAttr(_images.signatureDataUrl) + '" ' +
      'style="max-height:60px;max-width:180px;display:block;margin:0 auto 4px;mix-blend-mode:multiply" alt="Signature">';
    html += '<span style="font-size:8px;color:#666">Signature chauffeur</span>';
    html += '</div>';
  } else {
    html += '<div>Signature chauffeur</div>';
  }
  html += '</div>';

  html += '</div>';
  html += '</body></html>';
  return html;
}

/* ═══════════ SECTION 18 — EXPORT / IMPORT ═══════════ */

/* Exporte tous les bons route en JSON.
   Format : { version: 1, exportedAt, count, bonsRoute: [...] } */
function exportBonsRouteJSON() {
  try {
    var arr = _getBonsRouteArray();
    var data = {
      version: 1,
      exportedAt: new Date().toISOString(),
      count: arr.length,
      bonsRoute: arr
    };
    var json = JSON.stringify(data, null, 2);
    var blob = new Blob([json], { type: 'application/json' });
    var filename = 'voltcore-bons-route-' + todayISO() + '.json';
    if (typeof downloadBlob === 'function') {
      downloadBlob(blob, filename);
    } else {
      _brFallbackDownload(blob, filename);
    }
    if (typeof showToast === 'function') {
      showToast(arr.length + ' bon(s) route exporté(s)', 'success', 2500);
    }
    if (typeof logAction === 'function') {
      try { logAction('bonroute.export.json', arr.length + ' bons'); } catch (e) {}
    }
  } catch (e) {
    console.warn('exportBonsRouteJSON :', e);
    if (typeof showToast === 'function') showToast('Export JSON échoué.', 'error');
  }
}

/* Fallback local si downloadBlob indisponible (ne devrait pas arriver). */
function _brFallbackDownload(blob, filename) {
  try {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      try { if (a.parentNode) a.parentNode.removeChild(a); } catch (e) {}
      try { URL.revokeObjectURL(url); } catch (e) {}
    }, 30000);
  } catch (e) {
    console.warn('_brFallbackDownload :', e);
  }
}

/* Exporte tous les bons route en CSV (tab-separated + BOM Excel).
   Colonnes : Numéro · Type · Statut · Date création · Date départ ·
              Date retour · Véhicule · Chauffeur · Destination ·
              Adresse · Km départ · Km retour · Km parcourus ·
              Chantier · Notes
   Aucune colonne montant (hors compta). */
function exportBonsRouteCSV() {
  try {
    var arr = _getBonsRouteArray();
    var lines = [];
    lines.push([
      'Numéro', 'Type', 'Statut', 'Date création', 'Date départ',
      'Date retour', 'Véhicule', 'Chauffeur', 'Destination',
      'Adresse précise', 'Km départ', 'Km retour', 'Km parcourus',
      'Chantier', 'Notes'
    ].join('\t'));
    for (var i = 0; i < arr.length; i++) {
      var b = arr[i];
      if (!b) continue;
      var chantierNom = '';
      if (b.chantierId && typeof getChantierNom === 'function') {
        chantierNom = getChantierNom(b.chantierId) || '';
      }
      lines.push([
        _brCsvCell(b.numero),
        _brCsvCell(_bonRouteTypeLabel(b.type)),
        _brCsvCell(_bonRouteStatutLabel(b.statut)),
        _brCsvCell(b.dateCreation || ''),
        _brCsvCell(b.dateDepart || ''),
        _brCsvCell(b.dateRetour || ''),
        _brCsvCell(b.vehicule || ''),
        _brCsvCell(b.chauffeur || ''),
        _brCsvCell(BON_ROUTE_DESTINATIONS[b.destination] || ''),
        _brCsvCell(b.adressePrecise || ''),
        String(b.kmDepart || 0),
        String(b.kmRetour || 0),
        String(_bonRouteKmParcourus(b)),
        _brCsvCell(chantierNom),
        _brCsvCell(b.notes || '')
      ].join('\t'));
    }
    var csv = '\uFEFF' + lines.join('\r\n');
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    var filename = 'voltcore-bons-route-' + todayISO() + '.csv';
    if (typeof downloadBlob === 'function') {
      downloadBlob(blob, filename);
    } else {
      _brFallbackDownload(blob, filename);
    }
    if (typeof showToast === 'function') showToast('CSV exporté', 'success', 2500);
    if (typeof logAction === 'function') {
      try { logAction('bonroute.export.csv', arr.length + ' bons'); } catch (e) {}
    }
  } catch (e) {
    console.warn('exportBonsRouteCSV :', e);
    if (typeof showToast === 'function') showToast('Export CSV échoué.', 'error');
  }
}

/* Nettoie une cellule CSV (retire tabs et retours ligne). */
function _brCsvCell(v) {
  return String(v == null ? '' : v).replace(/\t/g, ' ').replace(/\r?\n/g, ' ');
}

/* Importe des bons route depuis un fichier JSON.
   Modes :
     • merge   (défaut) : ajoute sans écraser, ignore les doublons de numéro
     • replace          : pousse les bons actuels dans trash avant wipe
   Format accepté : Array direct OU { bonsRoute: [...] } OU { data: [...] }.
   Retourne Promise<{ added, skipped, invalid, mode }>. */
function importBonsRouteJSON(file, options) {
  return new Promise(function (resolve, reject) {
    try {
      if (!file) return reject(new Error('Fichier requis'));
      var mode = (options && options.mode) || 'merge';

      /* Rate-limit anti double-clic */
      if (typeof checkImportRate === 'function' && !checkImportRate()) {
        return reject(new Error('Trop rapide — attends 2 secondes.'));
      }

      var reader = new FileReader();
      reader.onload = function (ev) {
        try {
          var raw = ev.target.result;
          var parsed = JSON.parse(raw);
          var arr = null;
          if (Array.isArray(parsed)) {
            arr = parsed;
          } else if (parsed && Array.isArray(parsed.bonsRoute)) {
            arr = parsed.bonsRoute;
          } else if (parsed && Array.isArray(parsed.data)) {
            arr = parsed.data;
          }
          if (!arr) throw new Error('Format invalide : bonsRoute[] attendu');

          /* Mode replace : trash avant wipe */
          if (mode === 'replace') {
            var ok = (typeof confirmDialog === 'function')
              ? confirmDialog('⚠ Mode REMPLACER : TOUS les bons route actuels seront écrasés.\n\nContinuer ?')
              : window.confirm('Remplacer TOUS les bons route ?');
            if (!ok) return reject(new Error('Annulé par l\'utilisateur'));

            if (typeof _pushAllToTrashBeforeReplace === 'function') {
              _pushAllToTrashBeforeReplace('bonsRoute', _getBonsRouteArray());
            } else {
              /* Fallback : trash manuel */
              if (!trash || typeof trash !== 'object') {
                trash = { clients: [], articles: [], documents: [] };
              }
              if (!Array.isArray(trash.bonsRoute)) trash.bonsRoute = [];
              var stamp = new Date().toISOString();
              var current = _getBonsRouteArray();
              for (var t = 0; t < current.length; t++) {
                if (!current[t]) continue;
                trash.bonsRoute.push({
                  item: current[t],
                  deletedAt: stamp,
                  deletedBy: (typeof currentUser !== 'undefined' && currentUser && currentUser.username) || 'anon',
                  reason: 'import-replace'
                });
              }
            }
            bonsRoute = [];
          }

          /* Import + normalisation */
          var added = 0, skipped = 0, invalid = 0;
          if (!Array.isArray(bonsRoute)) bonsRoute = [];
          for (var i = 0; i < arr.length; i++) {
            var clean = _normalizeBonRoute(arr[i]);
            if (!clean) { invalid++; continue; }
            /* Doublon par numéro → skip (mode merge et replace car déjà vide en replace) */
            if (numeroBonRouteExiste(clean.numero, clean.id)) { skipped++; continue; }
            /* Éviter aussi doublon par ID (import du même fichier 2×) */
            if (getBonRouteById(clean.id)) { skipped++; continue; }
            bonsRoute.push(clean);
            added++;
          }

          if (typeof saveAll === 'function') saveAll();
          if (typeof logAction === 'function') {
            try {
              logAction('bonroute.import', mode + ' : ' + added + ' ajoutés, ' +
                skipped + ' doublons, ' + invalid + ' invalides');
            } catch (e) {}
          }
          if (typeof renderBonsRoute === 'function') {
            try { renderBonsRoute(); } catch (e) {}
          }

          if (typeof showToast === 'function') {
            var msg = added + ' bon(s) route importé(s)';
            if (skipped > 0) msg += ' · ' + skipped + ' doublon(s)';
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

/* ═══════════ SECTION 19 — ÉVÉNEMENTS ═══════════ */

/* Câble tous les boutons de la section Bons Route.
   Appelée par attachAllEvents() dans 21-init-app.js (BR7).
   Tous les binds sont idempotents (flag __bound). */
function attachBonsRouteEvents() {
  try {
    /* ── Bouton "Nouveau bon route" ── */
    var addBtn = document.getElementById('btnAddBonRoute');
    if (addBtn && !addBtn.__bound) {
      addBtn.__bound = true;
      addBtn.addEventListener('click', function (ev) {
        try { ev.preventDefault(); } catch (e) {}
        openBonRouteModal(null);
      });
    }

    /* ── Recherche (debounced) ── */
    var searchInput = document.getElementById('bonsRouteSearchInput');
    if (searchInput && !searchInput.__bound) {
      searchInput.__bound = true;
      var debouncedSearch;
      if (typeof debounce === 'function') {
        debouncedSearch = debounce(function (ev) {
          setBonsRouteSearch(ev.target.value);
        }, 250);
      } else {
        debouncedSearch = function (ev) {
          setBonsRouteSearch(ev.target.value);
        };
      }
      searchInput.addEventListener('input', debouncedSearch);
    }

    /* ── Filtres ── */
    var filterType = document.getElementById('bonsRouteFilterType');
    if (filterType && !filterType.__bound) {
      filterType.__bound = true;
      filterType.addEventListener('change', function (ev) {
        setBonsRouteFilterType(ev.target.value);
      });
    }

    var filterStatut = document.getElementById('bonsRouteFilterStatut');
    if (filterStatut && !filterStatut.__bound) {
      filterStatut.__bound = true;
      filterStatut.addEventListener('change', function (ev) {
        setBonsRouteFilterStatut(ev.target.value);
      });
    }

    var filterDest = document.getElementById('bonsRouteFilterDestination');
    if (filterDest && !filterDest.__bound) {
      filterDest.__bound = true;
      filterDest.addEventListener('change', function (ev) {
        setBonsRouteFilterDestination(ev.target.value);
      });
    }

    /* ── Export JSON ── */
    var exportJsonBtn = document.getElementById('btnExportBonsRouteJSON');
    if (exportJsonBtn && !exportJsonBtn.__bound) {
      exportJsonBtn.__bound = true;
      exportJsonBtn.addEventListener('click', function (ev) {
        try { ev.preventDefault(); } catch (e) {}
        exportBonsRouteJSON();
      });
    }

    /* ── Export CSV ── */
    var exportCsvBtn = document.getElementById('btnExportBonsRouteCSV');
    if (exportCsvBtn && !exportCsvBtn.__bound) {
      exportCsvBtn.__bound = true;
      exportCsvBtn.addEventListener('click', function (ev) {
        try { ev.preventDefault(); } catch (e) {}
        exportBonsRouteCSV();
      });
    }

    /* ── Import JSON (input file dynamique) ── */
    var importBtn = document.getElementById('btnImportBonsRoute');
    if (importBtn && !importBtn.__bound) {
      importBtn.__bound = true;
      importBtn.addEventListener('click', function (ev) {
        try { ev.preventDefault(); } catch (e) {}
        var input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json,application/json';
        input.onchange = function (ev2) {
          var f = ev2.target.files && ev2.target.files[0];
          if (!f) return;

          /* Choix du mode (cohérent avec import backup 19-tools-save.js) */
          var choice = null;
          if (typeof promptDialog === 'function') {
            choice = promptDialog(
              'Comment importer ce fichier ?\n\n' +
              '• Tape "FUSIONNER" pour ajouter sans toucher aux bons existants (recommandé)\n' +
              '• Tape "REMPLACER" pour TOUT écraser (DANGEREUX)\n' +
              '• Annule pour abandonner'
            );
          } else {
            choice = window.prompt('Tape FUSIONNER ou REMPLACER (Annuler = abandonner)');
          }
          if (choice === null) return;
          var mode = (String(choice).toUpperCase().trim() === 'REMPLACER') ? 'replace' : 'merge';

          importBonsRouteJSON(f, { mode: mode }).catch(function (err) {
            if (typeof showToast === 'function') {
              showToast('Import échoué : ' + (err.message || ''), 'error', 4000);
            }
          });
        };
        input.click();
      });
    }

    /* ── Impression de la liste filtrée (optionnel, si bouton présent en BR7) ── */
    var printListBtn = document.getElementById('btnPrintBonsRouteList');
    if (printListBtn && !printListBtn.__bound) {
      printListBtn.__bound = true;
      printListBtn.addEventListener('click', function (ev) {
        try { ev.preventDefault(); } catch (e) {}
        _printBonsRouteList();
      });
    }
  } catch (e) {
    console.warn('attachBonsRouteEvents :', e);
  }
}

/* Impression de la liste filtrée en cours.
   Utilisé par le bouton optionnel #btnPrintBonsRouteList. */
function _printBonsRouteList() {
  try {
    var list = getFilteredBonsRoute();
    var html = '<!DOCTYPE html><html><head><meta charset="UTF-8">' +
      '<title>Bons de route — VOLTCORE</title><style>' +
      '@page{size:A4 landscape;margin:10mm}' +
      'body{font-family:Arial,sans-serif;margin:10px;font-size:11px;color:#1A2B4C}' +
      'h1{color:#1A2B4C;border-bottom:2px solid #C9A84C;padding-bottom:6px}' +
      'table{width:100%;border-collapse:collapse;margin-top:10px}' +
      'th{background:#1A2B4C;color:#fff;padding:6px;text-align:left;font-size:10px}' +
      'td{border-bottom:1px solid #e0e4e9;padding:6px;font-size:10px}' +
      'tr:nth-child(even) td{background:#F9FAFE}' +
      '.right{text-align:right}.center{text-align:center}' +
      '.footer{margin-top:20px;text-align:center;font-size:9px;color:#666}' +
      '</style></head><body>';
    html += '<h1>Bons de route</h1>';
    html += '<div>Total : ' + list.length + ' · ' + todayISO() + '</div>';
    html += '<table><thead><tr>' +
      '<th>N°</th><th>Type</th><th>Statut</th><th>Dates</th>' +
      '<th>Véhicule</th><th>Chauffeur</th><th>Destination</th>' +
      '<th class="center">Km</th>' +
      '</tr></thead><tbody>';
    for (var i = 0; i < list.length; i++) {
      var b = list[i];
      var dates = '';
      if (b.dateDepart) dates += formatDate(b.dateDepart);
      if (b.dateRetour) dates += ' → ' + formatDate(b.dateRetour);
      html += '<tr>' +
        '<td>' + escapeHtml(b.numero || '') + '</td>' +
        '<td>' + escapeHtml(BON_ROUTE_TYPES[b.type] ? BON_ROUTE_TYPES[b.type].label : b.type) + '</td>' +
        '<td>' + escapeHtml(_bonRouteStatutLabel(b.statut)) + '</td>' +
        '<td>' + escapeHtml(dates) + '</td>' +
        '<td>' + escapeHtml(b.vehicule || '') + '</td>' +
        '<td>' + escapeHtml(b.chauffeur || '') + '</td>' +
        '<td>' + escapeHtml(BON_ROUTE_DESTINATIONS[b.destination] || '') + '</td>' +
        '<td class="center">' + _bonRouteKmParcourus(b) + '</td>' +
        '</tr>';
    }
    html += '</tbody></table>';
    html += '<div class="footer">VOLTCORE — Généré le ' + todayISO() + '</div>';
    html += '</body></html>';

    var w = window.open('', '_blank');
    if (!w) {
      if (typeof showToast === 'function') {
        showToast('Autorise les pop-ups pour imprimer.', 'warning', 4000);
      }
      return;
    }
    w.document.write(html);
    w.document.close();
    setTimeout(function () { try { w.print(); } catch (e) {} }, 500);
  } catch (e) {
    console.warn('_printBonsRouteList :', e);
  }
}

console.log('✅ 23-bons-route.js chargé — v6.9.6 (signature + cachet dans PDF)');