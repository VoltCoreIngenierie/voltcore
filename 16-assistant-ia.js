/* ═══════════════════════════════════════════════════════════════
   VOLTCORE — 16-assistant-ia.js
   VERSION : v6.7 (Session #3 — fuzzy match fournisseur supprimé,
                   matching strict + alerte doublon potentiel)
   RÔLE : 3 prompts IA distincts + aperçu avant import (C) +
          exemples dans prompts (D) + import JSON → achat fournisseur
   DÉPENDANCES : 01-core.js (purchaseInvoices, suppliers,
                            savedArticles), 03-utils.js (helpers),
                            04-storage.js (saveAll, recordExternalPrice),
                            08-stock.js (getArticleById),
                            13-purchases.js (computePurchaseTotals,
                            renderPurchases)
   EXPOSE : openAssistantIA, switchIAModel, renderIAPrompt,
            copyIAPrompt, openAIWebsite, parsePastedJSON,
            openImportPreview, closeImportPreview, confirmImportPreview,
            clearIAPaste, attachAssistantIAEvents
   SECTION 1  : CONSTANTES + ÉTAT
   SECTION 2  : PROMPTS (3 modèles)
   SECTION 3  : HELPERS CONTEXTE
   SECTION 4  : UI ACTIONS (copier / ouvrir / switch)
   SECTION 5  : PASTE + EXTRACTION JSON
   SECTION 6  : VALIDATION SCHÉMA
   SECTION 7  : APERÇU (C) + MATCHING STRICT v6.7
   SECTION 8  : IMPORT (création achat + fournisseur + articles)
   SECTION 9  : ÉVÉNEMENTS
   ═══════════════════════════════════════════════════════════════ */

/* ═══════════ SECTION 1 — CONSTANTES + ÉTAT ═══════════ */

var __iaCurrentModel = 'chatgpt';
var __iaParsedResult = null;
var __iaPreviewMatches = [];
var __iaImporting = false;

var IA_MODELS = {
  chatgpt:  { label: 'ChatGPT',  url: 'https://chat.openai.com',    icon: '🟢' },
  claude:   { label: 'Claude',   url: 'https://claude.ai',           icon: '🟣' },
  deepseek: { label: 'DeepSeek', url: 'https://chat.deepseek.com',   icon: '🔵' }
};

/* ═══════════ SECTION 2 — PROMPTS (3 modèles) ═══════════ */

var IA_PROMPT_CHATGPT = [
  'Tu es un assistant qui extrait les données d\'une facture d\'achat fournisseur (image ou texte) et les retourne EN JSON STRICT, sans AUCUNE phrase avant ou après.',
  '',
  'CONTEXTE VOLTCORE',
  'Articles existants dans le stock (matche si possible) :',
  '{ARTICLES_LIST}',
  '',
  'Fournisseurs existants (matche si possible) :',
  '{FOURNISSEURS_LIST}',
  '',
  'SCHEMA DE SORTIE',
  '{"fournisseur":"Nom","fournisseurMF":null,"numeroFacture":"N°","date":"YYYY-MM-DD","tvaRate":19,"timbre":1.000,"lignes":[{"articleId":null,"designation":"...","quantite":10,"prixUnitaire":1.200,"unite":"U"}]}',
  '',
  'RÈGLES STRICTES',
  '1. Retourne UNIQUEMENT le JSON brut. Pas de ```json``` autour, pas de phrase avant/après.',
  '2. Montants en dinars tunisiens (DT).',
  '3. Date au format YYYY-MM-DD (année-mois-jour).',
  '4. Si un article est reconnu dans la liste, mets son articleId exact. Sinon null.',
  '5. Toute valeur inconnue doit être null (jamais "", jamais 0 inventé).',
  '6. Cohérence : Σ(quantite × prixUnitaire) × (1 + tvaRate/100) + timbre = totalTTC.',
  '7. Au moins une ligne.',
  '',
  'EXEMPLE',
  'Entrée : "Facture AFEL N° F-2026-42 du 20/10/2026. Câble 3x2.5 : 50 m à 1,200 DT. Disjoncteur 16A : 10 U à 18,500 DT. TVA 19%, timbre 1 DT."',
  'Sortie :',
  '{"fournisseur":"AFEL","fournisseurMF":null,"numeroFacture":"F-2026-42","date":"2026-10-20","tvaRate":19,"timbre":1.000,"lignes":[{"articleId":null,"designation":"Câble 3x2.5","quantite":50,"prixUnitaire":1.200,"unite":"m"},{"articleId":null,"designation":"Disjoncteur 16A","quantite":10,"prixUnitaire":18.500,"unite":"U"}]}',
  '',
  'Réponds maintenant en JSON pur.'
].join('\n');

var IA_PROMPT_CLAUDE = [
  'Tu es un assistant spécialisé dans l\'extraction fidèle de données de factures fournisseur. Analyse attentivement l\'image ou le texte fourni, puis retourne UNIQUEMENT un objet JSON valide, sans introduction, sans commentaire, sans balises markdown.',
  '',
  'CONTEXTE VOLTCORE',
  'Articles existants (pour matching) :',
  '{ARTICLES_LIST}',
  '',
  'Fournisseurs existants (pour matching) :',
  '{FOURNISSEURS_LIST}',
  '',
  'SCHEMA ATTENDU',
  '{"fournisseur":"...","fournisseurMF":"...","numeroFacture":"...","date":"YYYY-MM-DD","tvaRate":19,"timbre":1.000,"lignes":[{"articleId":null,"designation":"...","quantite":10,"prixUnitaire":1.200,"unite":"U"}]}',
  '',
  'INSTRUCTIONS',
  '- Extrait TOUS les chiffres avec exactitude (ne pas arrondir).',
  '- Matching articles : préférer un articleId existant quand la désignation correspond clairement.',
  '- Toute valeur manquante doit être null, jamais une chaîne vide ni un zéro inventé.',
  '- Format date : YYYY-MM-DD (jour-mois-année, pas l\'inverse).',
  '- Montants en dinars tunisiens, 3 décimales max.',
  '- Une ligne par article distinct.',
  '- Vérifie que Σ(quantite × prixUnitaire) × (1 + tvaRate/100) + timbre est cohérent avec le total visible sur la facture.',
  '',
  'EXEMPLE',
  'Entrée : "Facture SCHNEIDER (MF 1234567/A/M/000) N° SCH-2026-889 du 15/09/2026. Contacteur LC1D09 : 5 U × 45,000 DT. TVA 19%, timbre 1 DT."',
  'Sortie :',
  '{"fournisseur":"SCHNEIDER","fournisseurMF":"1234567/A/M/000","numeroFacture":"SCH-2026-889","date":"2026-09-15","tvaRate":19,"timbre":1.000,"lignes":[{"articleId":null,"designation":"Contacteur LC1D09","quantite":5,"prixUnitaire":45.000,"unite":"U"}]}',
  '',
  'Retourne maintenant le JSON pur.'
].join('\n');

var IA_PROMPT_DEEPSEEK = [
  'Extrait les données de cette facture fournisseur et retourne UNIQUEMENT le JSON brut (aucun texte autour).',
  '',
  'Articles disponibles :',
  '{ARTICLES_LIST}',
  '',
  'Fournisseurs disponibles :',
  '{FOURNISSEURS_LIST}',
  '',
  'Format :',
  '{"fournisseur":"nom","fournisseurMF":null,"numeroFacture":"num","date":"YYYY-MM-DD","tvaRate":19,"timbre":1.000,"lignes":[{"articleId":null,"designation":"désignation","quantite":10,"prixUnitaire":1.200,"unite":"U"}]}',
  '',
  'Contraintes :',
  '- JSON brut uniquement, pas de ```json``` autour',
  '- Date YYYY-MM-DD',
  '- Montants en DT',
  '- articleId = ID existant si match, sinon null',
  '- Valeur inconnue = null',
  '- Min 1 ligne',
  '',
  'Exemple :',
  'Facture AFEL N° F-2026-42 du 20/10/2026, Câble 3x2.5 : 50 m à 1,200 DT, Disjoncteur 16A : 10 U à 18,500 DT, TVA 19%, timbre 1 DT',
  '→ {"fournisseur":"AFEL","fournisseurMF":null,"numeroFacture":"F-2026-42","date":"2026-10-20","tvaRate":19,"timbre":1.000,"lignes":[{"articleId":null,"designation":"Câble 3x2.5","quantite":50,"prixUnitaire":1.200,"unite":"m"},{"articleId":null,"designation":"Disjoncteur 16A","quantite":10,"prixUnitaire":18.500,"unite":"U"}]}',
  '',
  'Retourne le JSON maintenant.'
].join('\n');

/* ═══════════ SECTION 3 — HELPERS CONTEXTE ═══════════ */

function _iaGet(id) {
  try { var el = document.getElementById(id); return el ? String(el.value || '').trim() : ''; } catch (e) { return ''; }
}
function _iaSet(id, value) {
  try { var el = document.getElementById(id); if (el) el.value = value == null ? '' : value; } catch (e) {}
}
function _iaText(id, text) {
  try { var el = document.getElementById(id); if (el) el.textContent = String(text || ''); } catch (e) {}
}
function _iaShow(id, show) {
  try { var el = document.getElementById(id); if (el) el.style.display = show ? '' : 'none'; } catch (e) {}
}

function _buildArticlesContext() {
  try {
    if (!Array.isArray(savedArticles) || savedArticles.length === 0) {
      return '(aucun article dans le stock actuellement)';
    }
    var lines = [];
    var limit = Math.min(100, savedArticles.length);
    for (var i = 0; i < limit; i++) {
      var a = savedArticles[i];
      if (!a || !a.nom) continue;
      var pa = (typeof a.prixAchat === 'number') ? a.prixAchat : parseNumber(a.prixAchat);
      lines.push('- id=' + a.id + ' | nom="' + a.nom + '" | prix_achat=' + pa + ' DT');
    }
    if (lines.length === 0) return '(aucun article nommé)';
    return lines.join('\n');
  } catch (e) { return '(erreur de chargement)'; }
}

function _buildFournisseursContext() {
  try {
    if (!Array.isArray(suppliers) || suppliers.length === 0) {
      return '(aucun fournisseur enregistré)';
    }
    var lines = [];
    var limit = Math.min(50, suppliers.length);
    for (var i = 0; i < limit; i++) {
      var s = suppliers[i];
      if (!s || !s.nom) continue;
      lines.push('- id=' + s.id + ' | nom="' + s.nom + '"' +
        (s.mf ? ' | mf="' + s.mf + '"' : ''));
    }
    if (lines.length === 0) return '(aucun fournisseur nommé)';
    return lines.join('\n');
  } catch (e) { return '(erreur de chargement)'; }
}

function buildPromptFor(model) {
  try {
    var template = IA_PROMPT_CHATGPT;
    if (model === 'claude') template = IA_PROMPT_CLAUDE;
    else if (model === 'deepseek') template = IA_PROMPT_DEEPSEEK;

    var articlesCtx = _buildArticlesContext();
    var fournisseursCtx = _buildFournisseursContext();

    return template
      .split('{ARTICLES_LIST}').join(articlesCtx)
      .split('{FOURNISSEURS_LIST}').join(fournisseursCtx);
  } catch (e) {
    console.warn('buildPromptFor :', e);
    return '';
  }
}

/* ═══════════ SECTION 4 — UI ACTIONS ═══════════ */

function openAssistantIA() {
  try {
    var modal = document.getElementById('iaModal');
    if (!modal) return;
    __iaCurrentModel = 'chatgpt';
    switchIAModel('chatgpt');
    clearIAPaste();
    var errEl = document.getElementById('iaError');
    if (errEl) errEl.textContent = '';
    modal.style.display = 'flex';
  } catch (e) { console.warn('openAssistantIA :', e); }
}

function closeAssistantIA() {
  try {
    var m = document.getElementById('iaModal');
    if (m) m.style.display = 'none';
    __iaCurrentModel = 'chatgpt';
    clearIAPaste();
  } catch (e) {}
}

function switchIAModel(model) {
  try {
    var m = String(model || 'chatgpt').toLowerCase();
    if (!IA_MODELS[m]) m = 'chatgpt';
    __iaCurrentModel = m;

    /* Boutons actifs */
    var keys = Object.keys(IA_MODELS);
    for (var i = 0; i < keys.length; i++) {
      var btn = document.getElementById('iaModelBtn_' + keys[i]);
      if (btn) {
        if (keys[i] === m) btn.classList.add('active');
        else btn.classList.remove('active');
      }
    }
    renderIAPrompt();
  } catch (e) { console.warn('switchIAModel :', e); }
}

function renderIAPrompt() {
  try {
    var textarea = document.getElementById('iaPromptDisplay');
    if (!textarea) return;
    var prompt = buildPromptFor(__iaCurrentModel);
    textarea.value = prompt;
    var lbl = document.getElementById('iaModelLabel');
    if (lbl) {
      var info = IA_MODELS[__iaCurrentModel];
      lbl.textContent = (info ? info.icon + ' ' + info.label : 'IA');
    }
    /* Compteur de taille approximatif */
    var info2 = document.getElementById('iaPromptSize');
    if (info2) info2.textContent = prompt.length + ' caractères · ~' +
      Math.round(prompt.length / 4) + ' tokens';
  } catch (e) { console.warn('renderIAPrompt :', e); }
}

async function copyIAPrompt() {
  try {
    var textarea = document.getElementById('iaPromptDisplay');
    if (!textarea || !textarea.value) {
      if (typeof showToast === 'function') showToast('Prompt vide.', 'warning');
      return;
    }
    var ok = false;
    if (typeof copyToClipboard === 'function') {
      ok = await copyToClipboard(textarea.value);
    } else {
      try { textarea.select(); ok = document.execCommand('copy'); } catch (e) {}
    }
    if (ok && typeof showToast === 'function') {
      showToast('Prompt copié · colle-le dans ' + IA_MODELS[__iaCurrentModel].label, 'success', 3000);
    } else if (typeof showToast === 'function') {
      showToast('Copie impossible — sélectionne et copie manuellement.', 'warning', 3500);
    }
  } catch (e) { console.warn('copyIAPrompt :', e); }
}

function openAIWebsite() {
  try {
    var info = IA_MODELS[__iaCurrentModel];
    if (!info) return;
    var w = window.open(info.url, '_blank', 'noopener,noreferrer');
    if (!w) {
      if (typeof showToast === 'function') {
        showToast('Pop-up bloqué. Copie cette URL : ' + info.url, 'warning', 5000);
      }
    }
  } catch (e) { console.warn('openAIWebsite :', e); }
}

function clearIAPaste() {
  try {
    _iaSet('iaPasteTextarea', '');
    var errEl = document.getElementById('iaError');
    if (errEl) errEl.textContent = '';
  } catch (e) {}
}

/* ═══════════ SECTION 5 — PASTE + EXTRACTION JSON ═══════════ */

function extractJSONFromText(text) {
  try {
    if (!text) return null;
    var s = String(text).trim();
    /* Retire les fences markdown éventuelles */
    s = s.replace(/^```(?:json|JSON)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
    /* Cherche la première { et la dernière } */
    var first = s.indexOf('{');
    var last = s.lastIndexOf('}');
    if (first < 0 || last <= first) return null;
    var jsonStr = s.slice(first, last + 1);
    return JSON.parse(jsonStr);
  } catch (e) {
    return null;
  }
}

function parsePastedJSON() {
  try {
    var errEl = document.getElementById('iaError');
    if (errEl) errEl.textContent = '';

    var textarea = document.getElementById('iaPasteTextarea');
    var text = textarea ? textarea.value : '';
    if (!text || text.trim().length < 10) {
      if (errEl) errEl.textContent = 'Colle la réponse JSON de l\'IA dans la zone.';
      return;
    }

    var parsed = extractJSONFromText(text);
    if (!parsed) {
      if (errEl) errEl.textContent = 'JSON invalide. Vérifie que l\'IA a bien retourné du JSON pur.';
      return;
    }

    var v = validateParsedResult(parsed);
    if (!v.ok) {
      if (errEl) errEl.textContent = 'Structure invalide : ' + v.error;
      return;
    }

    __iaParsedResult = v.data;
    openImportPreview();
  } catch (e) {
    console.warn('parsePastedJSON :', e);
    var errEl2 = document.getElementById('iaError');
    if (errEl2) errEl2.textContent = 'Erreur : ' + (e.message || '');
  }
}

/* ═══════════ SECTION 6 — VALIDATION SCHÉMA ═══════════ */

function validateParsedResult(parsed) {
  try {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: 'pas un objet JSON' };
    }
    if (!parsed.fournisseur || !String(parsed.fournisseur).trim()) {
      return { ok: false, error: 'fournisseur manquant' };
    }
    if (!Array.isArray(parsed.lignes) || parsed.lignes.length === 0) {
      return { ok: false, error: 'aucune ligne' };
    }

    var cleanLines = [];
    for (var i = 0; i < parsed.lignes.length; i++) {
      var l = parsed.lignes[i];
      if (!l || typeof l !== 'object') continue;
      var designation = String(l.designation || '').trim();
      if (!designation) continue;
      var q = parseNumber(l.quantite);
      var p = parseNumber(l.prixUnitaire);
      if (q <= 0 || p < 0) continue;
      cleanLines.push({
        articleId: String(l.articleId || ''),
        designation: designation,
        quantite: q,
        prixUnitaire: p,
        unite: String(l.unite || 'U')
      });
    }
    if (cleanLines.length === 0) {
      return { ok: false, error: 'aucune ligne valide' };
    }

    var dateStr = String(parsed.date || '').slice(0, 10);
    var validDate = isValidDateString(dateStr) ? dateStr : todayISO();

    var tvaRate = parseNumber(parsed.tvaRate);
    if (!isFinite(tvaRate) || tvaRate < 0) tvaRate = 19;
    if (tvaRate > 100) tvaRate = 100;

    var timbre = parseNumber(parsed.timbre);
    if (!isFinite(timbre) || timbre < 0) timbre = 0;

    return {
      ok: true,
      data: {
        fournisseur: String(parsed.fournisseur).trim(),
        fournisseurMF: String(parsed.fournisseurMF || '').trim(),
        numeroFacture: String(parsed.numeroFacture || '').trim(),
        date: validDate,
        tvaRate: tvaRate,
        timbre: timbre,
        lignes: cleanLines
      }
    };
  } catch (e) {
    return { ok: false, error: 'exception : ' + (e.message || '') };
  }
}

/* ═══════════ SECTION 7 — APERÇU (C) + MATCHING STRICT v6.7 ═══════════ */

function openImportPreview() {
  try {
    if (!__iaParsedResult) return;
    _computePreviewMatches();
    _renderImportPreview();
    var modal = document.getElementById('iaPreviewModal');
    if (modal) modal.style.display = 'flex';
  } catch (e) { console.warn('openImportPreview :', e); }
}

function closeImportPreview() {
  try {
    var m = document.getElementById('iaPreviewModal');
    if (m) m.style.display = 'none';
    __iaParsedResult = null;
    __iaPreviewMatches = [];
  } catch (e) {}
}

/* v6.7 — Calcule un ratio de similarité entre 2 noms (0-1).
   Utilisé UNIQUEMENT pour alerter l'utilisateur (pas pour matcher).
   - 1.0 = identiques
   - entre 0.7 et 1.0 = proches (à signaler)
   - < 0.7 = considérés différents
   Basé sur la longueur en cas d'inclusion de préfixe :
   "AFEL" ⊂ "AFEL ELECTRICITE" → 5/16 ≈ 0.31 (refusé, pas de bruit)
   "STEG" ⊂ "STEG INDUSTRIE"   → 4/16 ≈ 0.25 (refusé)
   "SOTUMAC" ⊂ "SOTUMAC SARL"  → 7/14 = 0.50 (refusé) */
function _nameSimilarity(a, b) {
  try {
    if (!a || !b) return 0;
    var na = normalizeText(a);
    var nb = normalizeText(b);
    if (!na || !nb) return 0;
    if (na === nb) return 1;
    var la = na.length, lb = nb.length;
    var shorter = Math.min(la, lb);
    var longer = Math.max(la, lb);
    if (shorter === 0) return 0;
    if (na.indexOf(nb) === 0 || nb.indexOf(na) === 0) {
      return shorter / longer;
    }
    return 0;
  } catch (e) { return 0; }
}

/* v6.7 — Retourne la liste des fournisseurs "proches" d'un nom
   (ratio ≥ 0.7, mais pas identiques). Purement informatif :
   sert à afficher un avertissement dans l'aperçu. */
function _findSimilarSuppliers(name, excludeId) {
  var out = [];
  try {
    if (!name || !Array.isArray(suppliers)) return out;
    for (var i = 0; i < suppliers.length; i++) {
      var s = suppliers[i];
      if (!s || !s.nom) continue;
      if (excludeId && String(s.id) === String(excludeId)) continue;
      var ratio = _nameSimilarity(name, s.nom);
/* v6.7.1 — seuil abaissé à 0.25 pour détecter les inclusions courtes
   (« STEG » ⊂ « STEG INDUSTRIE » → 0.31, « AFEL » ⊂ « AFELEC » → 0.67).
   L'alerte reste informative : elle ne déclenche AUCUN match automatique
   (le vrai matching reste strict nom exact / MF). */
if (ratio >= 0.25 && ratio < 1) {
  out.push({ id: s.id, nom: s.nom, ratio: ratio });
}    }
    out.sort(function (a, b) { return b.ratio - a.ratio; });
  } catch (e) { console.warn('_findSimilarSuppliers :', e); }
  return out;
}

/* v6.7 — Match STRICT fournisseur.
   Politique (par ordre de priorité) :
   1. Match EXACT sur nom (après normalisation) → retourne le fournisseur
   2. Si MF fourni par l'IA et qu'un fournisseur en base a le même MF
      (avec au moins 6 caractères utiles) → retourne ce fournisseur
   3. Sinon → NOUVEAU fournisseur (aucun fuzzy par inclusion)
   Ajoute `similarSuppliers` dans le résultat pour information
   (affiché dans l'aperçu, mais ne déclenche PAS de match).

   ⚠️ Avant v6.7 : un fuzzy par inclusion fusionnait "AFEL" et
   "AFEL ELECTRICITE", causant des mélanges comptables. Supprimé. */
function _matchOrFlagSupplier(name, mf) {
  var result = {
    id: null,
    name: String(name || ''),
    isNew: true,
    mf: String(mf || ''),
    similarSuppliers: []
  };
  try {
    if (!name || !Array.isArray(suppliers)) return result;
    var normalized = normalizeText(name);
    var mfNormalized = String(mf || '').replace(/\s/g, '').toUpperCase();

    /* 1. Match exact sur nom */
    for (var i = 0; i < suppliers.length; i++) {
      if (normalizeText(suppliers[i].nom || '') === normalized) {
        return {
          id: suppliers[i].id,
          name: suppliers[i].nom,
          isNew: false,
          mf: suppliers[i].mf || '',
          similarSuppliers: []
        };
      }
    }

    /* 2. Match sur MF (matricule fiscal) si fourni par l'IA
       On exige au moins 6 caractères utiles pour éviter un MF bidon
       qui matcherait tout (ex: "0"). */
    if (mfNormalized && mfNormalized.length >= 6) {
      for (var j = 0; j < suppliers.length; j++) {
        var sMf = String(suppliers[j].mf || '').replace(/\s/g, '').toUpperCase();
        if (sMf && sMf === mfNormalized) {
          return {
            id: suppliers[j].id,
            name: suppliers[j].nom,
            isNew: false,
            mf: suppliers[j].mf || '',
            similarSuppliers: []
          };
        }
      }
    }

    /* 3. Pas de match → nouveau + liste des similaires (information) */
    result.similarSuppliers = _findSimilarSuppliers(name, null);
  } catch (e) { console.warn('_matchOrFlagSupplier :', e); }
  return result;
}

function _matchOrFlagArticle(designation, aiArticleId) {
  var result = { id: null, nom: String(designation || ''), isMatch: false };
  try {
    if (aiArticleId && typeof getArticleById === 'function') {
      var art = getArticleById(aiArticleId);
      if (art) {
        return { id: art.id, nom: art.nom || designation, isMatch: true, source: 'ai-id' };
      }
    }
    if (!Array.isArray(savedArticles)) return result;
    var normalized = normalizeText(designation);
    for (var i = 0; i < savedArticles.length; i++) {
      if (normalizeText(savedArticles[i].nom || '') === normalized) {
        return { id: savedArticles[i].id, nom: savedArticles[i].nom, isMatch: true, source: 'name' };
      }
    }
  } catch (e) { console.warn('_matchOrFlagArticle :', e); }
  return result;
}

function _computePreviewMatches() {
  try {
    __iaPreviewMatches = [];
    if (!__iaParsedResult) return;
    var supplier = _matchOrFlagSupplier(__iaParsedResult.fournisseur, __iaParsedResult.fournisseurMF);
    for (var i = 0; i < __iaParsedResult.lignes.length; i++) {
      var l = __iaParsedResult.lignes[i];
      var match = _matchOrFlagArticle(l.designation, l.articleId);
      __iaPreviewMatches.push({
        lineIndex: i,
        supplier: supplier,
        article: match,
        line: l
      });
    }
  } catch (e) { console.warn('_computePreviewMatches :', e); }
}

function _renderImportPreview() {
  try {
    var body = document.getElementById('iaPreviewBody');
    if (!body || !__iaParsedResult) return;
    var d = __iaParsedResult;
    var supplier = _matchOrFlagSupplier(d.fournisseur, d.fournisseurMF);

    /* Calcul des totaux via L13 */
    var totals = (typeof computePurchaseTotals === 'function')
      ? computePurchaseTotals(d.lignes, d.tvaRate, d.timbre)
      : { totalHT: 0, tva: 0, totalTTC: 0 };

    var html = '';

    /* Bloc fournisseur */
    html += '<div class="ia-preview-block">';
    html += '<h4>Fournisseur</h4>';
    if (supplier.isNew) {
      html += '<div><span class="badge badge-warning">⚠ Nouveau</span> ' +
        escapeHtml(supplier.name) + ' — sera créé automatiquement';
      if (supplier.mf) html += ' <span class="muted">(MF : ' + escapeHtml(supplier.mf) + ')</span>';
      html += '</div>';
      /* v6.7 — alerte doublon potentiel */
      if (supplier.similarSuppliers && supplier.similarSuppliers.length > 0) {
        html += '<div style="margin-top:8px;padding:8px;background:#fff7ed;' +
          'border-left:3px solid #d97706;border-radius:4px;font-size:12px">';
        html += '<strong>⚠ Doublon potentiel détecté :</strong><br>';
        for (var ss = 0; ss < Math.min(3, supplier.similarSuppliers.length); ss++) {
          var sim = supplier.similarSuppliers[ss];
          html += '• "' + escapeHtml(sim.nom) + '" (' +
            Math.round(sim.ratio * 100) + '% similaire)<br>';
        }
        if (supplier.similarSuppliers.length > 3) {
          html += '• … et ' + (supplier.similarSuppliers.length - 3) + ' autre(s)<br>';
        }
        html += '<span class="muted" style="font-size:11px">Si c\'est le même fournisseur, ' +
          'annule et crée-le manuellement en réutilisant l\'existant.</span>';
        html += '</div>';
      }
    } else {
      html += '<div><span class="badge badge-success">✓ Existant</span> ' +
        escapeHtml(supplier.name) + ' <span class="muted">(' + escapeHtml(supplier.id) + ')</span></div>';
    }
    html += '</div>';

    /* Bloc facture */
    html += '<div class="ia-preview-block">';
    html += '<h4>Facture</h4>';
    html += '<div><strong>N°</strong> ' + escapeHtml(d.numeroFacture || '(auto)') + '</div>';
    html += '<div><strong>Date</strong> ' + escapeHtml(formatDate(d.date)) + '</div>';
    html += '<div><strong>TVA</strong> ' + d.tvaRate + '% · ' +
      '<strong>Timbre</strong> ' + formatMoney(d.timbre) + '</div>';
    html += '</div>';

    /* Bloc lignes */
    var matchedCount = 0, newCount = 0;
    for (var i = 0; i < __iaPreviewMatches.length; i++) {
      if (__iaPreviewMatches[i].article.isMatch) matchedCount++;
      else newCount++;
    }

    html += '<div class="ia-preview-block">';
    html += '<h4>Lignes (' + d.lignes.length + ' — ' +
      matchedCount + ' article(s) reconnu(s), ' + newCount + ' nouveau(x))</h4>';
    html += '<table class="ia-preview-table"><thead><tr>' +
      '<th>Désignation</th><th>Article</th><th class="right">Qté</th>' +
      '<th class="right">P.U.</th><th class="right">Total</th></tr></thead><tbody>';
    for (var j = 0; j < d.lignes.length; j++) {
      var l = d.lignes[j];
      var match = __iaPreviewMatches[j] ? __iaPreviewMatches[j].article : { isMatch: false };
      var artCell = match.isMatch
        ? '<span class="badge badge-success">✓</span> ' + escapeHtml(match.nom || '')
        : '<span class="badge badge-warning">⚠</span> <span class="muted">nouveau</span>';
      var lt = parseNumber(l.quantite) * parseNumber(l.prixUnitaire);
      html += '<tr>' +
        '<td>' + escapeHtml(l.designation) + '</td>' +
        '<td>' + artCell + '</td>' +
        '<td class="right">' + l.quantite + ' ' + escapeHtml(l.unite) + '</td>' +
        '<td class="right">' + formatMoney(l.prixUnitaire) + '</td>' +
        '<td class="right">' + formatMoney(lt) + '</td>' +
        '</tr>';
    }
    html += '</tbody></table>';

    /* Option auto-création */
    if (newCount > 0) {
      html += '<div class="ia-preview-option">' +
        '<label><input type="checkbox" id="iaAutoCreateArticles" checked> ' +
        'Créer automatiquement les ' + newCount + ' article(s) manquant(s) ' +
        '<span class="muted">(recommandé pour alimenter le comparateur)</span></label>' +
        '</div>';
    }
    html += '</div>';

    /* Bloc totaux */
    html += '<div class="ia-preview-block">';
    html += '<h4>Totaux recalculés</h4>';
    html += '<div><strong>Total HT</strong> : ' + formatMoney(totals.totalHT) + '</div>';
    html += '<div><strong>TVA (' + d.tvaRate + '%)</strong> : ' + formatMoney(totals.tva) + '</div>';
    html += '<div><strong>Timbre</strong> : ' + formatMoney(d.timbre) + '</div>';
    html += '<div class="ia-preview-total"><strong>TOTAL TTC</strong> : ' +
      formatMoney(totals.totalTTC) + '</div>';
    html += '</div>';

    body.innerHTML = html;
  } catch (e) { console.warn('_renderImportPreview :', e); }
}

/* ═══════════ SECTION 8 — IMPORT (création) ═══════════ */

function _createSupplierQuick(nom, mf) {
  var sup = {
    id: 'sup_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
    nom: String(nom || '').trim(),
    mf: String(mf || '').trim(),
    telephone: '',
    email: '',
    adresse: '',
    rib: '',
    notes: 'Créé automatiquement par import IA',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  if (!Array.isArray(suppliers)) suppliers = [];
  suppliers.push(sup);
  return sup;
}

function _createArticleQuick(designation, prixUnitaire) {
  var nom = String(designation || '').trim();
  if (!nom) return null;
  var prixA = parseNumber(prixUnitaire);
  var art = {
    id: 'art_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
    nom: nom,
    designation: nom,
    prix: 0,
    prixAchat: prixA,
    stock: 0,
    seuil: 0,
    unite: 'U',
    famille: '',
    codeBarre: '',
    hs: false,
    actif: true,
    notes: 'Créé automatiquement par import IA',
    prixUpdates: [{
      date: new Date().toISOString(),
      oldPrix: 0,
      newPrix: 0,
      oldPrixAchat: 0,
      newPrixAchat: prixA,
      source: 'ia',
      note: 'Import IA'
    }],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  if (!Array.isArray(savedArticles)) savedArticles = [];
  savedArticles.push(art);
  return art;
}

function confirmImportPreview() {
  if (__iaImporting) return;
  __iaImporting = true;
  try {
    if (!__iaParsedResult) {
      if (typeof showToast === 'function') showToast('Aucun aperçu à confirmer.', 'error');
      return;
    }
    var d = __iaParsedResult;

    /* 1. Résoudre ou créer le fournisseur (match strict v6.7) */
    var supMatch = _matchOrFlagSupplier(d.fournisseur, d.fournisseurMF);
    var supplierId = supMatch.id;
    var supplierName = supMatch.name;
    if (supMatch.isNew) {
      var newSup = _createSupplierQuick(supMatch.name, supMatch.mf);
      supplierId = newSup.id;
      supplierName = newSup.nom;
    }

    /* 2. Résoudre les lignes (création d'articles si demandé) */
    var autoCreate = true;
    var cb = document.getElementById('iaAutoCreateArticles');
    if (cb) autoCreate = !!cb.checked;

    var finalLines = [];
    for (var i = 0; i < d.lignes.length; i++) {
      var l = d.lignes[i];
      var match = _matchOrFlagArticle(l.designation, l.articleId);
      var articleId = match.id || '';
      var designation = match.isMatch ? match.nom : l.designation;

      if (!articleId && autoCreate) {
        var newArt = _createArticleQuick(designation, l.prixUnitaire);
        if (newArt) {
          articleId = newArt.id;
          designation = newArt.nom;
        }
      }

      finalLines.push({
        articleId: articleId,
        designation: designation,
        quantite: l.quantite,
        prixUnitaire: l.prixUnitaire,
        unite: l.unite,
        total: l.quantite * l.prixUnitaire
      });
    }

    /* 3. Calculer les totaux via L13 */
    var totals = (typeof computePurchaseTotals === 'function')
      ? computePurchaseTotals(finalLines, d.tvaRate, d.timbre)
      : { totalHT: 0, tvaRate: d.tvaRate, tva: 0, timbre: d.timbre, totalTTC: 0, total: 0 };

    /* 4. Créer la facture d'achat */
    var year = new Date().getFullYear();
    var docNumero = d.numeroFacture ||
      ('ACH-' + year + '-' + String((purchaseInvoices || []).length + 1).padStart(4, '0'));

    var doc = {
      id: 'pur_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      numero: docNumero,
      refFacture: d.numeroFacture || '',
      supplierId: supplierId,
      fournisseurId: supplierId,
      fournisseur: supplierName,
      date: d.date,
      chantierId: '',
      tvaRate: totals.tvaRate,
      timbre: totals.timbre,
      notes: 'Importé via Assistant IA le ' + new Date().toISOString().slice(0, 10),
      lines: finalLines,
      totals: totals,
      totalTTC: totals.totalTTC,
      total: totals.totalTTC,
      paiements: [],
      source: 'ia',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    if (!Array.isArray(purchaseInvoices)) purchaseInvoices = [];
    purchaseInvoices.push(doc);

    /* 5. Alimenter le comparateur (recordExternalPrice) */
    if (typeof recordExternalPrice === 'function') {
      for (var k = 0; k < finalLines.length; k++) {
        var fl = finalLines[k];
        if (fl.articleId && fl.prixUnitaire > 0) {
          try {
            recordExternalPrice(fl.articleId, fl.prixUnitaire, supplierName, doc.numero, d.date);
          } catch (err) { console.warn('recordExternalPrice :', err); }
        }
      }
    }

    /* 6. Persister */
    if (typeof saveAll === 'function') saveAll();
    if (typeof logAction === 'function') {
      logAction('ia.import', docNumero + ' ' + formatMoney(totals.totalTTC) +
        ' (' + finalLines.length + ' ligne(s))');
    }

    /* 7. Cleanup + refresh */
    closeImportPreview();
    closeAssistantIA();

    try {
      if (typeof renderPurchases === 'function') renderPurchases();
      if (typeof renderStock === 'function') renderStock();
      if (typeof renderSuppliers === 'function') renderSuppliers();
      if (typeof renderAlertBadges === 'function') renderAlertBadges();
    } catch (e) { console.warn('refresh post-import :', e); }

    if (typeof showToast === 'function') {
      showToast('Import réussi : ' + docNumero + ' · ' + finalLines.length + ' ligne(s)', 'success', 4000);
    }
  } catch (e) {
    console.warn('confirmImportPreview :', e);
    if (typeof showToast === 'function') showToast('Erreur d\'import : ' + (e.message || ''), 'error', 5000);
  } finally {
    __iaImporting = false;
  }
}

/* ═══════════ SECTION 9 — ÉVÉNEMENTS ═══════════ */

function attachAssistantIAEvents() {
  try {
    /* Boutons de sélection de modèle */
    var keys = Object.keys(IA_MODELS);
    for (var i = 0; i < keys.length; i++) {
      var btn = document.getElementById('iaModelBtn_' + keys[i]);
      if (btn && !btn.__bound) {
        btn.__bound = true;
        (function (m) {
          btn.addEventListener('click', function () { switchIAModel(m); });
        })(keys[i]);
      }
    }

    var copyBtn = document.getElementById('iaCopyBtn');
    if (copyBtn && !copyBtn.__bound) {
      copyBtn.__bound = true;
      copyBtn.addEventListener('click', copyIAPrompt);
    }

    var openBtn = document.getElementById('iaOpenWebsiteBtn');
    if (openBtn && !openBtn.__bound) {
      openBtn.__bound = true;
      openBtn.addEventListener('click', openAIWebsite);
    }

    var analyzeBtn = document.getElementById('iaAnalyzeBtn');
    if (analyzeBtn && !analyzeBtn.__bound) {
      analyzeBtn.__bound = true;
      analyzeBtn.addEventListener('click', parsePastedJSON);
    }

    var clearBtn = document.getElementById('iaClearBtn');
    if (clearBtn && !clearBtn.__bound) {
      clearBtn.__bound = true;
      clearBtn.addEventListener('click', clearIAPaste);
    }

    var confirmBtn = document.getElementById('iaPreviewConfirmBtn');
    if (confirmBtn && !confirmBtn.__bound) {
      confirmBtn.__bound = true;
      confirmBtn.addEventListener('click', confirmImportPreview);
    }

    var cancelBtn = document.getElementById('iaPreviewCancelBtn');
    if (cancelBtn && !cancelBtn.__bound) {
      cancelBtn.__bound = true;
      cancelBtn.addEventListener('click', closeImportPreview);
    }

    var openIA = document.getElementById('btnOpenAssistantIA');
    if (openIA && !openIA.__bound) {
      openIA.__bound = true;
      openIA.addEventListener('click', openAssistantIA);
    }
  } catch (e) { console.warn('attachAssistantIAEvents :', e); }
}

console.log('✅ 16-assistant-ia.js chargé — v6.7 (matching fournisseur strict + alerte doublon)');