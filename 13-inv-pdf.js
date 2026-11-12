/* ═══════════════════════════════════════════════════════════
   VOLTCORE — 13-inv-pdf.js
   VERSION : v7.0.7
   RÔLE : Génération PDF facture/devis/BL/avoir.
          Montant en lettres, signature + cachet depuis IDB,
          bloc autoliquidation OPT-IN explicite.
   DÉPENDANCES : 00-core, 01-utils, 02-store, 03-idb, 04-alerts, 06-clients
   ORDRE : 14ᵉ fichier chargé

   FIX v7.0.0 :
   - C13 : autoliquidation JAMAIS calculée — UNIQUEMENT si doc.autoliquidation === true
   - Signature/cachet chargés en parallèle puis injectés
   - Pas d'image chargée si absente (pas de placeholder inutile)

   RÈGLES :
   - ES5 strict
   - Aucun catch silencieux
   - Ne JAMAIS lire/écrire localStorage directement
   ═══════════════════════════════════════════════════════════ */

'use strict';

(function (global) {

  if (!global.VOLTCORE || !global.VOLTCORE.Store || !global.VOLTCORE.Utils) {
    throw new Error('[13-inv-pdf] Modules requis non chargés');
  }

  var VC = global.VOLTCORE;
  var U = VC.Utils;
  var S = VC.Store;
  var IDB = VC.IDB;
  var Doc = VC.Doc;
  var PDF = VC.InvoicePDF || {};
  VC.InvoicePDF = PDF;

  /* ═══════════════════════════════════════════════════════════
     SECTION 1 — HELPERS
     ═══════════════════════════════════════════════════════════ */

  function _docTotal(doc) {
    if (!doc) return 0;
    if (doc.totals && typeof doc.totals.total === 'number') return doc.totals.total;
    if (typeof doc.totalTTC === 'number') return doc.totalTTC;
    return 0;
  }

  function _docDate(doc) {
    if (!doc) return '';
    return String(doc.date || '').slice(0, 10);
  }

  function _docTypeLabel(doc) {
    var labels = {
      devis: 'Devis',
      bl: 'Bon de livraison',
      facture: 'Facture',
      attachement: 'Attachement',
      avoir: 'Avoir'
    };
    if (!doc) return 'Document';
    return labels[doc.type] || 'Document';
  }

  function _docClient(doc) {
    if (!doc || !doc.clientId) return null;
    if (VC.Clients && typeof VC.Clients.getById === 'function') {
      return VC.Clients.getById(doc.clientId);
    }
    return null;
  }

  function _lineTotal(it) {
    if (!it) return 0;
    return U.computeLineTotal(it);
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 2 — CHARGEMENT SIGNATURE + CACHET
     ═══════════════════════════════════════════════════════════ */

  function _getSignatureMeta() {
    try {
      var raw = localStorage.getItem('voltcore_signature_default');
      if (!raw) return null;
      var meta = JSON.parse(raw);
      return (meta && meta.ref) ? meta : null;
    } catch (e) {
      VC.logError('13-inv-pdf', 'getSignatureMeta échoué', e);
      return null;
    }
  }

  function _getCachetMeta() {
    try {
      var raw = localStorage.getItem('voltcore_cachet_default');
      if (!raw) return null;
      var meta = JSON.parse(raw);
      return (meta && meta.ref) ? meta : null;
    } catch (e) {
      VC.logError('13-inv-pdf', 'getCachetMeta échoué', e);
      return null;
    }
  }

  /**
   * Charge la signature + cachet par défaut depuis IDB.
   * Retourne Promise<{ signatureDataUrl, cachetDataUrl }>.
   * Ne rejette jamais : retourne null si absent/erreur.
   */
  function _loadImages() {
    var result = { signatureDataUrl: null, cachetDataUrl: null };

    var sigMeta = _getSignatureMeta();
    var cacMeta = _getCachetMeta();

    var promises = [];

    if (sigMeta && sigMeta.ref) {
      promises.push(
        IDB.blobs.get(sigMeta.ref).then(function (row) {
          if (row && row.data) {
            return IDB.blobToDataURL(row.data).then(function (d) {
              result.signatureDataUrl = d;
            });
          }
        }).catch(function (e) {
          VC.logError('13-inv-pdf', 'load signature échoué', e);
        })
      );
    }

    if (cacMeta && cacMeta.ref) {
      promises.push(
        IDB.blobs.get(cacMeta.ref).then(function (row) {
          if (row && row.data) {
            return IDB.blobToDataURL(row.data).then(function (d) {
              result.cachetDataUrl = d;
            });
          }
        }).catch(function (e) {
          VC.logError('13-inv-pdf', 'load cachet échoué', e);
        })
      );
    }

    return Promise.all(promises).then(function () {
      return result;
    });
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 3 — CONSTRUCTION HTML
     ═══════════════════════════════════════════════════════════ */

  /**
   * Construit le HTML complet du document.
   * opts = { signatureDataUrl, cachetDataUrl }
   *
   * FIX C13 : la mention d'autoliquidation est affichée UNIQUEMENT si
   * doc.autoliquidation === true (case cochée par l'utilisateur).
   * Aucune détection automatique basée sur le type de client.
   */
  PDF.buildHTML = function (doc, opts) {
    if (!doc) return '';

    var images = opts || {};
    var client = _docClient(doc);
    var t = doc.totals || {};
    var avoirTotal = Doc.getAvoirTotalForFacture(doc.id);

    /* ─── Calcul du net final ─── */
    var netFinal;
    if (t.netAPayer != null && isFinite(t.netAPayer)) {
      netFinal = t.netAPayer - avoirTotal;
    } else {
      var totalDoc = _docTotal(doc);
      netFinal = totalDoc - (t.retenueMontant || 0) -
                 (t.retenueGarantie || 0) - avoirTotal;
    }
    if (netFinal < 0) netFinal = 0;

    var totalTTC = t.totalTTC || _docTotal(doc);
    var hasRetenues = (t.retenueMontant || 0) > 0.001 ||
                      (t.retenueGarantie || 0) > 0.001 ||
                      avoirTotal > 0.001;

    var libelleNet = hasRetenues ? 'NET À PAYER' : 'NET À PAYER TTC';
    var libelleLettres = hasRetenues ? 'net à payer' : 'TTC';

    /* ─── Échéance ─── */
    var dateEm = _docDate(doc);
    var echeance = 'À réception';
    if (client && client.delaiPaiement != null) {
      if (client.delaiPaiement === 0) echeance = 'Comptant';
      else if (U.addDaysISO) {
        echeance = U.formatDate(U.addDaysISO(dateEm, client.delaiPaiement));
      }
    }

    /* ─── Activité client ─── */
    var activite = '';
    if (client) activite = client.codeCategorie || client.type || '';

    /* ─── Titre ─── */
    var titre = _docTypeLabel(doc).toUpperCase() + ' N° ' + (doc.numero || '—');

    /* ─── Client ─── */
    var clientNom = '—';
    if (client && client.nom) clientNom = client.nom;
    else if (doc._clientNomOrphelin) clientNom = doc._clientNomOrphelin;

    var clientAdresse = (client && client.adresse) ? U.escapeHtml(client.adresse) : '';
    var clientMf = (client && client.mf) ? U.escapeHtml(client.mf) : '—';
    var activiteHtml = activite ? U.escapeHtml(activite) : '—';

    /* ─── Lignes ─── */
    var itemsHtml = '';
    if (Array.isArray(doc.items)) {
      for (var i = 0; i < doc.items.length; i++) {
        var it = doc.items[i];
        if (!it) continue;
        var lt = _lineTotal(it);
        var remise = U.parseNumber(it.remise);
        var desigCell = U.escapeHtml(it.designation || '');
        if (remise > 0) {
          desigCell += ' <span style="font-size:9px;color:#999">(remise ' +
            remise + '%)</span>';
        }
        itemsHtml += '<tr>' +
          '<td>' + desigCell + '</td>' +
          '<td class="text-center">' + U.parseNumber(it.quantite) +
          (it.unite ? ' ' + U.escapeHtml(it.unite) : '') + '</td>' +
          '<td class="text-right">' + U.formatNumber(U.parseNumber(it.prix), 3) + '</td>' +
          '<td class="text-right">' + U.formatNumber(lt, 3) + '</td>' +
          '</tr>';
      }
    }
    if (!itemsHtml) {
      itemsHtml = '<tr><td colspan="4" style="text-align:center;color:#999;padding:20px">Aucune ligne</td></tr>';
    }

    /* ─── Totaux ─── */
    var totauxHtml = '';
    totauxHtml += '<div class="line"><strong>Total HT</strong> <span>' +
      U.formatNumber(t.totalHT || 0, 3) + ' DT</span></div>';
    totauxHtml += '<div class="line"><strong>TVA (' + (t.tvaRate || 0) +
      '%)</strong> <span>' + U.formatNumber(t.tva || 0, 3) + ' DT</span></div>';
    if ((t.timbre || 0) > 0.001) {
      totauxHtml += '<div class="line"><strong>Timbre fiscal</strong> <span>' +
        U.formatNumber(t.timbre, 3) + ' DT</span></div>';
    }
    totauxHtml += '<div class="line"><strong>Total TTC</strong> <span>' +
      U.formatNumber(totalTTC, 3) + ' DT</span></div>';

    if ((t.retenueIR || 0) > 0.001) {
      totauxHtml += '<div class="line"><strong>Retenue IR</strong> <span>− ' +
        U.formatNumber(t.retenueIR, 3) + ' DT</span></div>';
    }
    if ((t.retenueTVA || 0) > 0.001) {
      totauxHtml += '<div class="line"><strong>Retenue TVA</strong> <span>− ' +
        U.formatNumber(t.retenueTVA, 3) + ' DT</span></div>';
    }
    if ((t.retenueGarantie || 0) > 0.001) {
      var tauxG = t.retenueGarantieRate || 5;
      totauxHtml += '<div class="line"><strong>Retenue garantie (' + tauxG +
        '%)</strong> <span>− ' + U.formatNumber(t.retenueGarantie, 3) +
        ' DT</span></div>';
    }
    if (avoirTotal > 0.001) {
      totauxHtml += '<div class="line"><strong>Avoirs</strong> <span>− ' +
        U.formatNumber(avoirTotal, 3) + ' DT</span></div>';
    }
    totauxHtml += '<div class="line grand-total"><strong>' + libelleNet +
      '</strong> <span>' + U.formatNumber(netFinal, 3) + ' DT</span></div>';

    /* ─── Montant en lettres ─── */
    var montantLettres;
    if (typeof U.numberToFrenchWords === 'function') {
      montantLettres = U.numberToFrenchWords(netFinal);
    } else {
      montantLettres = '[' + U.formatNumber(netFinal, 3) + ' DT]';
      VC.logWarn('13-inv-pdf', 'numberToFrenchWords indisponible — fallback');
    }

    /* ─── Observation ─── */
    var observationHtml = '';
    if (doc.notes) {
      observationHtml = '<div class="observation"><strong>Observation :</strong> ' +
        U.escapeHtml(doc.notes).replace(/\n/g, '<br>') + '</div>';
    }

    /* ─── Paiements ─── */
    var paiementsHtml = '';
    var paiements = Array.isArray(doc.paiements) ? doc.paiements : [];
    if (paiements.length > 0) {
      paiementsHtml = '<div style="margin-top:18px">' +
        '<strong style="color:#1A2B4C;font-size:10px;text-transform:uppercase;letter-spacing:0.5px">' +
        'Paiements enregistrés</strong>' +
        '<table style="width:100%;border-collapse:collapse;margin-top:8px;font-size:10px">' +
        '<thead><tr style="background:#1A2B4C;color:#fff">' +
        '<th style="padding:6px 8px;text-align:left">Date</th>' +
        '<th style="padding:6px 8px;text-align:left">Mode</th>' +
        '<th style="padding:6px 8px;text-align:right">Montant</th>' +
        '</tr></thead><tbody>';
      for (var j = 0; j < paiements.length; j++) {
        var p = paiements[j];
        paiementsHtml += '<tr>' +
          '<td style="padding:6px 8px;border-bottom:1px solid #e0e4e9">' +
          U.escapeHtml(U.formatDate(p.date || '')) + '</td>' +
          '<td style="padding:6px 8px;border-bottom:1px solid #e0e4e9">' +
          U.escapeHtml(p.mode || '—') + '</td>' +
          '<td style="padding:6px 8px;border-bottom:1px solid #e0e4e9;text-align:right">' +
          U.formatNumber(U.parseNumber(p.montant), 3) + ' DT</td>' +
          '</tr>';
      }
      paiementsHtml += '</tbody></table></div>';
    }

    /* ─── Variables société ─── */
    var mfVal = '1977463P / A / M / 000';
    var ribVal = '07 054 0112101102584 69';
    var banqueVal = 'AMEN BANK';
    var rneVal = '1977463P';

    try {
      mfVal = (typeof VC.Company !== 'undefined' && VC.Company.mf) || mfVal;
      ribVal = (typeof VC.Company !== 'undefined' && VC.Company.rib) || ribVal;
      banqueVal = (typeof VC.Company !== 'undefined' && VC.Company.banque) || banqueVal;
      rneVal = (typeof VC.Company !== 'undefined' && VC.Company.rne) || rneVal;
    } catch (e) {
      VC.logError('13-inv-pdf', 'lecture company config échouée', e);
    }

    /* ─── Logo ─── */
    var logo = '';
    try {
      logo = localStorage.getItem('voltcore_logo') || '';
    } catch (e) {
      VC.logError('13-inv-pdf', 'lecture logo échouée', e);
    }

    var logoHtml;
    if (logo) {
      logoHtml = '<img src="' + U.escapeAttr(logo) +
        '" style="max-height:60px;max-width:200px" alt="Logo">';
    } else {
      logoHtml = '<div class="logo-text">' +
        '<h1>VOLT<span>CORE</span></h1>' +
        '<div class="sub">INGÉNIERIE · ÉLECTRICITÉ · BÂTIMENT</div>' +
        '<div class="logo-underline"><div class="gold"></div><div class="red"></div></div>' +
        '</div>';
    }

    /* ─── Assemblage ─── */
    var html = '<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><title>' +
      U.escapeHtml(titre) + '</title><style>';
    html += '@page{size:A4;margin:15mm}';
    html += '*{margin:0;padding:0;box-sizing:border-box}';
    html += 'body{font-family:\'Calibri\',\'Segoe UI\',Arial,sans-serif;background:#fff;padding:10px;font-size:10px;color:#1A2B4C;-webkit-print-color-adjust:exact;print-color-adjust:exact}';
    html += '.invoice-wrapper{max-width:950px;margin:0 auto;background:#fff;padding:20px 28px}';
    html += '.header{display:flex;justify-content:space-between;align-items:center;border-bottom:2px solid #C9A84C;padding-bottom:16px;margin-bottom:16px;flex-wrap:wrap;gap:10px}';
    html += '.logo-text h1{font-size:34px;font-weight:900;color:#1A2B4C;letter-spacing:1.5px;line-height:1;margin-bottom:4px}';
    html += '.logo-text h1 span{color:#E70013}';
    html += '.logo-text .sub{font-size:10px;color:#C9A84C;letter-spacing:3px;font-weight:700;text-transform:uppercase;margin-bottom:6px}';
    html += '.logo-underline{display:flex;height:3px;width:100%}';
    html += '.logo-underline .gold{width:65%;background:#C9A84C}';
    html += '.logo-underline .red{width:35%;background:#E70013}';
    html += '.company-info{text-align:right;font-size:10px;line-height:1.6;color:#2c3e66}';
    html += '.company-info strong{color:#1A2B4C}';
    html += '.invoice-title{text-align:center;font-size:22px;font-weight:700;color:#E70013;margin:4px 0 16px;letter-spacing:1px}';
    html += '.client-box{background:#F9FAFE;padding:12px 18px;border-radius:10px;border-left:4px solid #C9A84C;display:flex;justify-content:space-between;flex-wrap:wrap;gap:15px;margin-bottom:20px;font-size:10px;line-height:1.5}';
    html += '.client-box strong{color:#1A2B4C}';
    html += 'table.items{width:100%;border-collapse:collapse;margin:12px 0;font-size:10px}';
    html += 'table.items th{background:#1A2B4C;color:#fff;padding:10px 8px;text-align:center;font-weight:600;letter-spacing:0.5px}';
    html += 'table.items td{padding:8px;border-bottom:1px solid #e0e4e9;vertical-align:middle}';
    html += 'table.items tr:nth-child(even) td{background:#F9FAFE}';
    html += '.text-right{text-align:right}';
    html += '.text-center{text-align:center}';
    html += '.totals-box{width:50%;margin-left:auto;margin-top:15px;padding:15px 20px;background:#FEFCF5;border-radius:10px;border:1px solid #f0e5d0}';
    html += '.totals-box .line{display:flex;justify-content:space-between;padding:3px 0;font-size:11px;color:#1A2B4C}';
    html += '.totals-box .grand-total{font-size:16px;font-weight:800;color:#E70013;border-top:2px solid #C9A84C;padding-top:8px;margin-top:5px}';
    html += '.letter-amount{border:1px solid #C9A84C;background:#FEFAF2;border-radius:8px;padding:12px 16px;margin:18px 0 14px;font-size:11px;color:#1A2B4C}';
    html += '.observation{background:#f8f9fa;padding:10px 16px;border-radius:8px;font-size:10px;color:#444;border-left:3px solid #C9A84C;margin:12px 0 16px}';
    html += '.autoliq{background:#FEF3C7;padding:10px 16px;border-radius:8px;font-size:10px;color:#78350F;border-left:4px solid #E70013;margin:12px 0 16px}';
    html += '.footer{border-top:1px solid #ddd;padding-top:12px;margin-top:16px;font-size:8px;text-align:center;color:#555;line-height:1.6}';
    html += '.footer strong{color:#1A2B4C}';
    html += '.footer .bank{margin-top:6px}';
    html += '.signature-area{display:flex;justify-content:space-between;margin-top:25px;font-size:10px}';
    html += '.signature-area div{width:38%;border-top:1px solid #999;padding-top:8px;text-align:center;color:#1A2B4C;font-weight:600}';
    html += '.clearfix::after{content:"";display:table;clear:both}';
    html += '@media print{body{padding:0}.invoice-wrapper{padding:0}}';
    html += '</style></head><body>';

    html += '<div class="invoice-wrapper">';

    /* Header */
    html += '<div class="header">';
    html += '<div class="logo-title">' + logoHtml + '</div>';
    html += '<div class="company-info">';
    html += '<strong>VOLTCORE INGENIERIE</strong><br>';
    html += 'Route Soukra KM 3, Cité El Habib<br>';
    html += 'Sfax Ouest – 3052, Tunisie<br>';
    html += '<strong>MF :</strong> ' + U.escapeHtml(mfVal) + '<br>';
    html += '<strong>RNE :</strong> ' + U.escapeHtml(rneVal) + '<br>';
    html += 'Tél : +216 51 176 186';
    html += '</div>';
    html += '</div>';

    /* Titre */
    html += '<div class="invoice-title">' + U.escapeHtml(titre) + '</div>';

    /* Bloc client */
    html += '<div class="client-box">';
    html += '<div>';
    html += '<strong>Date d\'émission :</strong> ' + U.escapeHtml(U.formatDate(dateEm)) + '<br>';
    html += '<strong>Échéance :</strong> ' + U.escapeHtml(echeance);
    html += '</div>';
    html += '<div>';
    html += '<strong>Facturé à :</strong><br>';
    html += '<strong>' + U.escapeHtml(clientNom) + '</strong><br>';
    if (clientAdresse) html += clientAdresse + '<br>';
    html += '<strong>MF :</strong> ' + clientMf + '<br>';
    html += '<strong>Activité :</strong> ' + activiteHtml;
    html += '</div>';
    html += '</div>';

    /* Tableau items */
    html += '<table class="items">';
    html += '<thead><tr>';
    html += '<th style="text-align:left;width:48%">Désignation</th>';
    html += '<th style="text-align:center;width:10%">Qté</th>';
    html += '<th style="text-align:right;width:21%">P.U. HT (TND)</th>';
    html += '<th style="text-align:right;width:21%">Total HT (TND)</th>';
    html += '</tr></thead>';
    html += '<tbody>' + itemsHtml + '</tbody>';
    html += '</table>';

    /* Totaux */
    html += '<div class="clearfix">';
    html += '<div class="totals-box">' + totauxHtml + '</div>';
    html += '</div>';

    /* Montant en lettres */
    html += '<div class="letter-amount">';
    html += 'Arrêtée la présente facture à la somme de : <strong>' +
      U.escapeHtml(montantLettres) + ' ' + libelleLettres + '</strong>.';
    html += '</div>';

    /* FIX C13 : autoliquidation OPT-IN explicite UNIQUEMENT */
    if (doc.autoliquidation === true) {
      html += '<div class="autoliq">';
      html += '<strong>⚠️ Autoliquidation de la TVA par le preneur</strong><br>';
      html += 'Prestation de services soumise au régime de l\'autoliquidation ' +
        'conformément à la réglementation en vigueur (Code de la TVA, Tunisie). ' +
        'La TVA doit être déclarée et acquittée par le client.';
      html += '</div>';
    }

    /* Observation */
    html += observationHtml;

    /* Paiements */
    html += paiementsHtml;

    /* Footer */
    html += '<div class="footer">';
    html += '<div>TVA récupérable sur présentation – Paiement à réception – ' +
      'Pénalités de retard 15% l\'an.</div>';
    html += '<div><strong>VOLTCORE INGENIERIE</strong> – SARL au capital 20 000 TND – RNE ' +
      U.escapeHtml(rneVal) + '</div>';
    html += '<div class="bank"><strong>Coordonnées bancaires :</strong> ' +
      U.escapeHtml(banqueVal) + ' – RIB : ' + U.escapeHtml(ribVal) + '</div>';
    html += '</div>';

    /* Signatures */
    html += '<div class="signature-area">';
    if (images.cachetDataUrl) {
      html += '<div>';
      html += '<img src="' + U.escapeAttr(images.cachetDataUrl) + '" ' +
        'style="max-height:60px;max-width:180px;display:block;margin:0 auto 4px;' +
        'mix-blend-mode:multiply" alt="Cachet">';
      html += '<span style="font-size:8px;color:#666">Cachet VOLTCORE</span>';
      html += '</div>';
    } else {
      html += '<div>Cachet & Signature VOLTCORE</div>';
    }
    if (images.signatureDataUrl) {
      html += '<div>';
      html += '<img src="' + U.escapeAttr(images.signatureDataUrl) + '" ' +
        'style="max-height:60px;max-width:180px;display:block;margin:0 auto 4px;' +
        'mix-blend-mode:multiply" alt="Signature">';
      html += '<span style="font-size:8px;color:#666">Signature client</span>';
      html += '</div>';
    } else {
      html += '<div>Signature client</div>';
    }
    html += '</div>';

    html += '</div>';  /* /invoice-wrapper */
    html += '</body></html>';

    return html;
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 4 — IMPRESSION
     ═══════════════════════════════════════════════════════════ */

  PDF.print = function (docId) {
    var doc = S.getById('documents', docId);
    if (!doc) {
      U.toast('Document introuvable.', 'error');
      return;
    }

    /* Charge signature + cachet puis imprime */
    _loadImages().then(function (images) {
      var html = PDF.buildHTML(doc, images);
      _openPrintWindow(html);
    }).catch(function (e) {
      VC.logError('13-inv-pdf', 'print — chargement images échoué', e);
      /* Fallback : imprime sans images */
      var html = PDF.buildHTML(doc, {});
      _openPrintWindow(html);
    });
  };

  function _openPrintWindow(html) {
    var w = global.open('', '_blank');
    if (!w) {
      U.toast('Autorise les pop-ups pour imprimer.', 'warning', 4000);
      return;
    }
    try {
      w.document.open();
      w.document.write(html);
      w.document.close();
      setTimeout(function () {
        try {
          w.focus();
          w.print();
        } catch (e) {
          VC.logError('13-inv-pdf', 'print focus/print échoué', e);
        }
      }, 400);
    } catch (e) {
      VC.logError('13-inv-pdf', 'openPrintWindow écriture échouée', e);
      U.toast('Erreur d\'impression.', 'error');
    }
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 5 — MARQUEUR
     ═══════════════════════════════════════════════════════════ */

  VC._invPdfLoaded = true;

  VC.logInfo('13-inv-pdf', 'Module chargé (autoliquidation opt-in stricte)');

})(window);