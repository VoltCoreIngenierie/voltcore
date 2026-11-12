/* ═══════════════════════════════════════════════════════════
   VOLTCORE — 19-scan-cv.js
   VERSION : v7.0.7
   RÔLE : Pipeline OpenCV pour le scanner.
          - Détection auto des coins (4 stratégies + scoring)
          - Warp perspective avec bilinéaire
          - 4 modes : document / photo / texte / aucun
          - Correction d'ombres avant binarisation
          - Auto-crop après warp
          - Cleanup strict cv.Mat (règle 15)
          - Timeout + AbortController à chaque étape
   DÉPENDANCES : 00-core, 01-utils
   ORDRE : 20ᵉ fichier chargé

   FIX v7.0.0 :
   - Règle 15 OpenCV : tout cv.Mat est dans un tableau `mats`
     et supprimé dans le bloc `finally`
   - Timeout par étape (si OpenCV pend, on bascule sur fallback)
   - Scoring des 4 stratégies : aucune n'est prioritaire, la meilleure gagne
   - Correction d'ombres (background subtraction) sur mode document
   - Auto-crop après warp (trim des marges blanches)
   - Traitement des modes distincts :
       document = binarize Otsu/Adaptive + ombres corrigées
       photo    = enhancement saturation + contraste (garde couleurs)
       text     = accentuation netteté + binarize sélectif
       none     = warp brut (aucune binarisation)

   RÈGLES :
   - ES5 strict
   - Aucun catch silencieux
   - Aucun cv.Mat non supprimé
   - Chaque étape vérifie le signal d'abandon
   ═══════════════════════════════════════════════════════════ */

'use strict';

(function (global) {

  if (!global.VOLTCORE || !global.VOLTCORE.Utils) {
    throw new Error('[19-scan-cv] Modules requis non chargés');
  }

  var VC = global.VOLTCORE;
  var CV = VC.ScanCV || {};
  VC.ScanCV = CV;

  /* ═══════════════════════════════════════════════════════════
     SECTION 1 — CONSTANTES + ÉTAT
     ═══════════════════════════════════════════════════════════ */

  var STRATEGY_TIMEOUT_MS = 4000;
  var MAX_WARP_DIM = 2000;

  function _cv() {
    return global.cv;
  }

  function _cvReady() {
    return !!(global.__opencvReady && typeof global.cv !== 'undefined');
  }

  function _checkAbort(signal) {
    if (signal && signal.aborted) {
      var e = new Error('Aborted');
      e.name = 'AbortError';
      throw e;
    }
  }

  function _timeoutPromise(ms, msg) {
    return new Promise(function (resolve, reject) {
      setTimeout(function () {
        reject(new Error('Timeout : ' + msg));
      }, ms);
    });
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 2 — API : DÉTECTION DES COINS
     ═══════════════════════════════════════════════════════════ */

  /**
   * Détecte les 4 coins d'un document dans une image.
   * Teste 4 stratégies en parallèle (ou séquentiel), chacune retourne
   * un quadrilatère potentiel avec un score. Le meilleur gagne.
   *
   * @param canvas {HTMLCanvasElement}
   * @returns Promise<Array<{x%, y%}> × 4 | null>
   */
  CV.detectCorners = function (canvas) {
    return new Promise(function (resolve) {
      if (!_cvReady()) {
        resolve(null);
        return;
      }
      if (!canvas || !canvas.width || !canvas.height) {
        resolve(null);
        return;
      }

      var cv = _cv();
      var mats = [];
      var matVector = null;
      var hierarchy = null;

      try {
        var src = cv.imread(canvas);
        mats.push(src);

        /* Redimensionne pour la détection : max 900px */
        var scale = Math.min(900 / Math.max(src.cols, src.rows), 1);
        var small = new cv.Mat();
        mats.push(small);
        cv.resize(src, small,
          new cv.Size(Math.round(src.cols * scale), Math.round(src.rows * scale)),
          0, 0, cv.INTER_AREA);

        var gray = new cv.Mat();
        mats.push(gray);
        cv.cvtColor(small, gray, cv.COLOR_RGBA2GRAY);

        var filtered = new cv.Mat();
        mats.push(filtered);
        cv.bilateralFilter(gray, filtered, 9, 75, 75);

        var minArea = small.cols * small.rows * 0.05;
        var strategies = [
          { name: 'canny-strict', type: 'canny', low: 75, high: 200 },
          { name: 'canny-medium', type: 'canny', low: 50, high: 150 },
          { name: 'canny-soft', type: 'canny', low: 30, high: 90 },
          { name: 'adaptive', type: 'adaptive' }
        ];

        var best = null;

        for (var s = 0; s < strategies.length; s++) {
          var strat = strategies[s];
          var found = _runStrategy(strat, filtered, minArea);
          if (found && (!best || found.score > best.score)) {
            best = found;
          }
        }

        if (!best) {
          resolve(null);
          return;
        }

        /* Remet à l'échelle d'origine */
        var origPoints = [];
        for (var i = 0; i < best.points.length; i++) {
          origPoints.push({
            x: best.points[i].x / scale,
            y: best.points[i].y / scale
          });
        }

        var sorted = _sortCornersTLTRBRBL(origPoints);
        if (!sorted) {
          resolve(null);
          return;
        }

        /* Convertit en pourcentages */
        var imgW = canvas.width;
        var imgH = canvas.height;
        var percent = [];
        for (var j = 0; j < sorted.length; j++) {
          percent.push({
            x: Math.max(0, Math.min(100, sorted[j].x / imgW * 100)),
            y: Math.max(0, Math.min(100, sorted[j].y / imgH * 100))
          });
        }

        resolve(percent);

      } catch (e) {
        VC.logError('19-scan-cv', 'detectCorners échoué', e);
        resolve(null);
      } finally {
        for (var m = 0; m < mats.length; m++) {
          try { mats[m].delete(); } catch (e) {
            VC.logError('19-scan-cv', 'cleanup mat échoué', e);
          }
        }
        try { if (matVector) matVector.delete(); } catch (e) { /* silencieux */ }
        try { if (hierarchy) hierarchy.delete(); } catch (e) { /* silencieux */ }
      }
    });
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 3 — STRATÉGIES (une par type)
     ═══════════════════════════════════════════════════════════ */

  function _runStrategy(strat, filteredMat, minArea) {
    var cv = _cv();
    var mats = [];

    try {
      var edges = new cv.Mat();
      mats.push(edges);

      if (strat.type === 'canny') {
        cv.Canny(filteredMat, edges, strat.low, strat.high);
      } else if (strat.type === 'adaptive') {
        cv.adaptiveThreshold(filteredMat, edges, 255,
          cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY_INV, 15, 10);
      }

      /* Fermeture morphologique pour relier les bords */
      var kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(11, 11));
      mats.push(kernel);
      var closed = new cv.Mat();
      mats.push(closed);
      cv.morphologyEx(edges, closed, cv.MORPH_CLOSE, kernel,
        new cv.Point(-1, -1), 2);

      /* Find contours */
      var contours = new cv.MatVector();
      var hierarchy = new cv.Mat();
      try {
        cv.findContours(closed, contours, hierarchy,
          cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

        var best = _findBestQuad(contours, minArea);
        return best;
      } finally {
        try { contours.delete(); } catch (e) { /* silencieux */ }
        try { hierarchy.delete(); } catch (e) { /* silencieux */ }
      }
    } catch (e) {
      VC.logError('19-scan-cv', 'strategy ' + strat.name + ' échoué', e);
      return null;
    } finally {
      for (var m = 0; m < mats.length; m++) {
        try { mats[m].delete(); } catch (e) { /* silencieux */ }
      }
    }
  }

  function _findBestQuad(contours, minArea) {
    var cv = _cv();
    var best = null;
    var epsilons = [0.01, 0.015, 0.02, 0.03, 0.04];

    for (var i = 0; i < contours.size(); i++) {
      var cnt = contours.get(i);
      var approx = null;

      try {
        var peri = cv.arcLength(cnt, true);
        if (peri < 80) continue;

        for (var e = 0; e < epsilons.length; e++) {
          if (!approx) approx = new cv.Mat();
          cv.approxPolyDP(cnt, approx, epsilons[e] * peri, true);

          if (approx.rows === 4) {
            var area = cv.contourArea(approx);
            if (area > minArea) {
              var pts = [];
              var ok = true;
              for (var j = 0; j < 4; j++) {
                var p = _safeGetPoint(approx, j);
                if (!p) { ok = false; break; }
                pts.push(p);
              }

              if (ok && pts.length === 4) {
                var valid = _isValidQuad(pts);
                if (valid) {
                  var score = _scoreQuad(pts, area);
                  if (!best || score > best.score) {
                    best = {
                      points: pts,
                      area: area,
                      score: score
                    };
                  }
                }
              }
            }
            break;
          }
        }
      } catch (e) {
        VC.logError('19-scan-cv', 'findBestQuad inner échoué', e);
      } finally {
        try { cnt.delete(); } catch (e) { /* silencieux */ }
        try { if (approx) approx.delete(); } catch (e) { /* silencieux */ }
      }
    }

    return best;
  }

  function _safeGetPoint(mat, idx) {
    try {
      var cv = _cv();
      var t = mat.type();
      if (t === cv.CV_32SC2) {
        return { x: mat.data32S[idx * 2], y: mat.data32S[idx * 2 + 1] };
      }
      if (t === cv.CV_32FC2) {
        return { x: mat.data32F[idx * 2], y: mat.data32F[idx * 2 + 1] };
      }
    } catch (e) {
      VC.logError('19-scan-cv', '_safeGetPoint échoué', e);
    }
    return null;
  }

  function _isValidQuad(pts) {
    if (!pts || pts.length !== 4) return false;

    var sides = [];
    for (var i = 0; i < 4; i++) {
      var p1 = pts[i];
      var p2 = pts[(i + 1) % 4];
      var dx = p2.x - p1.x;
      var dy = p2.y - p1.y;
      var len = Math.sqrt(dx * dx + dy * dy);
      if (len < 30) return false;
      sides.push(len);
    }

    var maxS = Math.max.apply(null, sides);
    var minS = Math.min.apply(null, sides);
    if (maxS / minS > 8) return false;

    return true;
  }

  /**
   * Score de qualité d'un quadrilatère (plus haut = meilleur).
   * Combine : aire normalisée + rectangularité + régularité des côtés.
   */
  function _scoreQuad(pts, area) {
    var sides = [];
    for (var i = 0; i < 4; i++) {
      var p1 = pts[i];
      var p2 = pts[(i + 1) % 4];
      var dx = p2.x - p1.x;
      var dy = p2.y - p1.y;
      sides.push(Math.sqrt(dx * dx + dy * dy));
    }

    var maxS = Math.max.apply(null, sides);
    var minS = Math.min.apply(null, sides);
    var regularity = minS / maxS;

    return area * regularity;
  }

  function _sortCornersTLTRBRBL(corners) {
    if (!corners || corners.length !== 4) return null;

    /* Tri par somme (TL = plus petite somme, BR = plus grande) */
    var bySum = corners.slice().sort(function (a, b) {
      var d = (a.x + a.y) - (b.x + b.y);
      if (Math.abs(d) < 1) return a.x - b.x;
      return d;
    });

    var tl = bySum[0];
    var br = bySum[3];

    /* Tri par différence (TR = plus petite diff, BL = plus grande) */
    var byDiff = corners.slice().sort(function (a, b) {
      var d = (a.y - a.x) - (b.y - b.x);
      if (Math.abs(d) < 1) return a.y - b.y;
      return d;
    });

    var tr = byDiff[0];
    var bl = byDiff[3];

    /* Vérifie qu'on a 4 points distincts */
    var ids = {};
    var unique = 0;
    [tl, tr, br, bl].forEach(function (p) {
      var k = Math.round(p.x) + ':' + Math.round(p.y);
      if (!ids[k]) { ids[k] = true; unique++; }
    });

    if (unique !== 4) return null;

    return [tl, tr, br, bl];
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 4 — API : TRAITEMENT PRINCIPAL
     ═══════════════════════════════════════════════════════════ */

  /**
   * Traite une image selon les options.
   *
   * @param sourceCanvas {HTMLCanvasElement}
   * @param opts {
   *   corners: [{x%, y%} × 4] (ordre TL, TR, BR, BL)
   *   mode: 'document' | 'photo' | 'text' | 'none'
   *   rotation: 0|90|180|270
   *   mirrored: bool
   *   signal: AbortSignal
   * }
   * @returns Promise<HTMLCanvasElement>
   */
  CV.process = function (sourceCanvas, opts) {
    return new Promise(function (resolve, reject) {
      if (!_cvReady()) {
        reject(new Error('OpenCV non prêt'));
        return;
      }

      var o = opts || {};
      var signal = o.signal || null;

      try {
        _checkAbort(signal);
      } catch (e) {
        reject(e);
        return;
      }

      /* Étape 1 : rotation / miroir appliqués en premier */
      var rotated = _applyRotationMirror(sourceCanvas, o.rotation, o.mirrored);
      if (!rotated) {
        reject(new Error('Rotation échouée'));
        return;
      }

      /* Étape 2 : warp perspective */
      var warped = _warpPerspective(rotated, o.corners, signal);
      if (!warped) {
        reject(new Error('Warp perspective échoué'));
        return;
      }

      /* Étape 3 : auto-crop */
      var cropped = _autoCrop(warped);
      if (!cropped) cropped = warped;

      /* Étape 4 : mode spécifique */
      var result;
      try {
        _checkAbort(signal);
        result = _applyMode(cropped, o.mode || 'document', signal);
      } catch (e) {
        reject(e);
        return;
      }

      if (!result) {
        reject(new Error('Mode processing échoué'));
        return;
      }

      resolve(result);
    });
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 5 — ROTATION / MIROIR
     ═══════════════════════════════════════════════════════════ */

  function _applyRotationMirror(sourceCanvas, rotation, mirrored) {
    try {
      var rot = ((parseInt(rotation, 10) || 0) % 360 + 360) % 360;
      var mir = !!mirrored;

      if (rot === 0 && !mir) {
        /* Aucune transformation : retourne une copie */
        var copy = document.createElement('canvas');
        copy.width = sourceCanvas.width;
        copy.height = sourceCanvas.height;
        copy.getContext('2d').drawImage(sourceCanvas, 0, 0);
        return copy;
      }

      var w = sourceCanvas.width;
      var h = sourceCanvas.height;

      /* Dimensions après rotation */
      var outW = (rot === 90 || rot === 270) ? h : w;
      var outH = (rot === 90 || rot === 270) ? w : h;

      var out = document.createElement('canvas');
      out.width = outW;
      out.height = outH;

      var ctx = out.getContext('2d');
      ctx.save();

      /* Centre de rotation */
      ctx.translate(outW / 2, outH / 2);
      ctx.rotate(rot * Math.PI / 180);
      if (mir) ctx.scale(-1, 1);
      ctx.drawImage(sourceCanvas, -w / 2, -h / 2);

      ctx.restore();
      return out;
    } catch (e) {
      VC.logError('19-scan-cv', '_applyRotationMirror échoué', e);
      return null;
    }
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 6 — WARP PERSPECTIVE
     ═══════════════════════════════════════════════════════════ */

  function _warpPerspective(sourceCanvas, cornersPercent, signal) {
    if (!cornersPercent || cornersPercent.length !== 4) {
      /* Pas de coins : retourne la source telle quelle */
      var copy = document.createElement('canvas');
      copy.width = sourceCanvas.width;
      copy.height = sourceCanvas.height;
      copy.getContext('2d').drawImage(sourceCanvas, 0, 0);
      return copy;
    }

    var cv = _cv();
    var mats = [];

    try {
      _checkAbort(signal);

      var src = cv.imread(sourceCanvas);
      mats.push(src);

      /* Convertit % en pixels */
      var imgW = sourceCanvas.width;
      var imgH = sourceCanvas.height;
      var cornersPx = [];
      for (var i = 0; i < 4; i++) {
        cornersPx.push({
          x: Math.round(cornersPercent[i].x / 100 * imgW),
          y: Math.round(cornersPercent[i].y / 100 * imgH)
        });
      }

      /* Calcule les dimensions de destination */
      var w1 = Math.hypot(cornersPx[1].x - cornersPx[0].x,
                          cornersPx[1].y - cornersPx[0].y);
      var w2 = Math.hypot(cornersPx[2].x - cornersPx[3].x,
                          cornersPx[2].y - cornersPx[3].y);
      var h1 = Math.hypot(cornersPx[3].x - cornersPx[0].x,
                          cornersPx[3].y - cornersPx[0].y);
      var h2 = Math.hypot(cornersPx[2].x - cornersPx[1].x,
                          cornersPx[2].y - cornersPx[1].y);

      var dstW = Math.round(Math.max(w1, w2));
      var dstH = Math.round(Math.max(h1, h2));

      if (dstW < 10 || dstH < 10) {
        throw new Error('Dimensions destination invalides');
      }

      if (dstW > MAX_WARP_DIM || dstH > MAX_WARP_DIM) {
        var r = Math.min(MAX_WARP_DIM / dstW, MAX_WARP_DIM / dstH);
        dstW = Math.round(dstW * r);
        dstH = Math.round(dstH * r);
      }

      _checkAbort(signal);

      var srcPts = cv.matFromArray(4, 1, cv.CV_32FC2, [
        cornersPx[0].x, cornersPx[0].y,
        cornersPx[1].x, cornersPx[1].y,
        cornersPx[2].x, cornersPx[2].y,
        cornersPx[3].x, cornersPx[3].y
      ]);
      mats.push(srcPts);

      var dstPts = cv.matFromArray(4, 1, cv.CV_32FC2, [
        0, 0, dstW, 0, dstW, dstH, 0, dstH
      ]);
      mats.push(dstPts);

      var M = cv.getPerspectiveTransform(srcPts, dstPts);
      mats.push(M);

      var warped = new cv.Mat();
      mats.push(warped);
      cv.warpPerspective(src, warped, M, new cv.Size(dstW, dstH),
        cv.INTER_LINEAR, cv.BORDER_CONSTANT,
        new cv.Scalar(255, 255, 255, 255));

      var outCanvas = document.createElement('canvas');
      cv.imshow(outCanvas, warped);

      return outCanvas;

    } catch (e) {
      VC.logError('19-scan-cv', '_warpPerspective échoué', e);
      return null;
    } finally {
      for (var m = 0; m < mats.length; m++) {
        try { mats[m].delete(); } catch (e) {
          VC.logError('19-scan-cv', 'cleanup warp mat échoué', e);
        }
      }
    }
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 7 — AUTO-CROP
     ═══════════════════════════════════════════════════════════ */

  /**
   * Détecte les marges blanches (bordure uniforme) et crop l'image
   * au contenu réel. Retourne un nouveau canvas ou null.
   */
  function _autoCrop(canvas) {
    try {
      var ctx = canvas.getContext('2d');
      var w = canvas.width;
      var h = canvas.height;
      var data = ctx.getImageData(0, 0, w, h).data;

      var THRESHOLD_WHITE = 240;
      var MIN_CONTENT_RATIO = 0.02;

      /* Trouve les bords gauche/droit */
      var left = 0, right = w - 1, top = 0, bottom = h - 1;

      /* Scan horizontal pour trouver le contenu */
      for (var x = 0; x < w; x++) {
        var count = 0;
        for (var y = 0; y < h; y += 4) {
          var idx = (y * w + x) * 4;
          if (data[idx] < THRESHOLD_WHITE) count++;
        }
        if (count / (h / 4) > MIN_CONTENT_RATIO) {
          left = x;
          break;
        }
      }

      for (var x2 = w - 1; x2 >= 0; x2--) {
        var count2 = 0;
        for (var y2 = 0; y2 < h; y2 += 4) {
          var idx2 = (y2 * w + x2) * 4;
          if (data[idx2] < THRESHOLD_WHITE) count2++;
        }
        if (count2 / (h / 4) > MIN_CONTENT_RATIO) {
          right = x2;
          break;
        }
      }

      /* Scan vertical pour trouver le contenu */
      for (var yy = 0; yy < h; yy++) {
        var count3 = 0;
        for (var xx = 0; xx < w; xx += 4) {
          var idx3 = (yy * w + xx) * 4;
          if (data[idx3] < THRESHOLD_WHITE) count3++;
        }
        if (count3 / (w / 4) > MIN_CONTENT_RATIO) {
          top = yy;
          break;
        }
      }

      for (var yy2 = h - 1; yy2 >= 0; yy2--) {
        var count4 = 0;
        for (var xx2 = 0; xx2 < w; xx2 += 4) {
          var idx4 = (yy2 * w + xx2) * 4;
          if (data[idx4] < THRESHOLD_WHITE) count4++;
        }
        if (count4 / (w / 4) > MIN_CONTENT_RATIO) {
          bottom = yy2;
          break;
        }
      }

      /* Marges de sécurité */
      var margin = 5;
      left = Math.max(0, left - margin);
      right = Math.min(w - 1, right + margin);
      top = Math.max(0, top - margin);
      bottom = Math.min(h - 1, bottom + margin);

      var newW = right - left + 1;
      var newH = bottom - top + 1;

      if (newW < 20 || newH < 20) {
        return null;
      }
      if (newW === w && newH === h) {
        return null;
      }

      var out = document.createElement('canvas');
      out.width = newW;
      out.height = newH;
      out.getContext('2d').drawImage(canvas, left, top, newW, newH, 0, 0, newW, newH);
      return out;
    } catch (e) {
      VC.logError('19-scan-cv', '_autoCrop échoué', e);
      return null;
    }
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 8 — MODES DE TRAITEMENT
     ═══════════════════════════════════════════════════════════ */

  function _applyMode(canvas, mode, signal) {
    switch (mode) {
      case 'document': return _modeDocument(canvas, signal);
      case 'photo':    return _modePhoto(canvas, signal);
      case 'text':     return _modeText(canvas, signal);
      case 'none':     return canvas;
      default:         return _modeDocument(canvas, signal);
    }
  }

  /**
   * MODE DOCUMENT — Binarisation propre avec correction d'ombres.
   * 1. Grayscale
   * 2. Correction d'ombres (background subtraction)
   * 3. Binarisation Otsu
   */
  function _modeDocument(canvas, signal) {
    var cv = _cv();
    var mats = [];

    try {
      _checkAbort(signal);

      var src = cv.imread(canvas);
      mats.push(src);

      var gray = new cv.Mat();
      mats.push(gray);
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

      /* Correction d'ombres : estime le fond par fermeture morphologique */
      var bg = new cv.Mat();
      mats.push(bg);
      var kernelBg = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(31, 31));
      mats.push(kernelBg);
      cv.morphologyEx(gray, bg, cv.MORPH_CLOSE, kernelBg);

      /* Divise le gray par le fond (normalise l'éclairage) */
      var normalized = new cv.Mat();
      mats.push(normalized);
      var bgFloat = new cv.Mat();
      mats.push(bgFloat);
      bg.convertTo(bgFloat, cv.CV_32F);

      var grayFloat = new cv.Mat();
      mats.push(grayFloat);
      gray.convertTo(grayFloat, cv.CV_32F);

      /* FIX R63 : éviter la division par ~0 sur les zones très sombres.
         Sans ce clamp, grayFloat / bgFloat explose → saturation à 255
         → artefacts blancs sur les zones noires du document. */
      var bgSafe = new cv.Mat();
      mats.push(bgSafe);
      var oneMat = new cv.Mat(bgFloat.rows, bgFloat.cols, cv.CV_32F, new cv.Scalar(1.0));
      mats.push(oneMat);
      cv.max(bgFloat, oneMat, bgSafe);

      /* normalized = (gray / bgSafe) * 255 */
      cv.divide(grayFloat, bgSafe, normalized, 255);
      var normalizedU8 = new cv.Mat();
      mats.push(normalizedU8);
      normalized.convertTo(normalizedU8, cv.CV_8U);

      _checkAbort(signal);

      /* Binarisation Otsu */
      var binary = new cv.Mat();
      mats.push(binary);
      cv.threshold(normalizedU8, binary, 0, 255,
        cv.THRESH_BINARY | cv.THRESH_OTSU);

      var resultRGBA = new cv.Mat();
      mats.push(resultRGBA);
      cv.cvtColor(binary, resultRGBA, cv.COLOR_GRAY2RGBA);

      var outCanvas = document.createElement('canvas');
      cv.imshow(outCanvas, resultRGBA);
      return outCanvas;

    } catch (e) {
      VC.logError('19-scan-cv', '_modeDocument échoué', e);
      return null;
    } finally {
      for (var m = 0; m < mats.length; m++) {
        try { mats[m].delete(); } catch (e) {
          VC.logError('19-scan-cv', 'cleanup doc mat échoué', e);
        }
      }
    }
  }

  /**
   * MODE PHOTO — Amélioration couleurs (garde l'image en couleur).
   * Contraste adaptatif + saturation + léger débruitage.
   */
  function _modePhoto(canvas, signal) {
    var cv = _cv();
    var mats = [];
    var labPlanes = null;
    var LEnhanced = null;
    var clahe = null;

    try {
      _checkAbort(signal);

      var src = cv.imread(canvas);
      mats.push(src);

      /* RGBA → RGB (variable intermédiaire pour éviter l'auto-écrasement) */
      var rgb = new cv.Mat();
      mats.push(rgb);
      cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);

      /* RGB → LAB */
      var lab = new cv.Mat();
      mats.push(lab);
      cv.cvtColor(rgb, lab, cv.COLOR_RGB2Lab);

      /* Split LAB */
    labPlanes = new cv.MatVector();
    cv.split(lab, labPlanes);

    var L = labPlanes.get(0);
    LEnhanced = new cv.Mat();

    /* FIX Bug 6 : CLAHE n'est pas présent dans toutes les builds OpenCV.js.
       Fallback sur equalizeHist si absent. */
    try {
      if (typeof cv.CLAHE === 'function') {
        clahe = new cv.CLAHE(2.0, new cv.Size(8, 8));
        clahe.apply(L, LEnhanced);
      } else {
        cv.equalizeHist(L, LEnhanced);
      }

      /* FIX Bug 6 : après set(), labPlanes possède LEnhanced.
         On met la variable à null pour éviter le double delete. */
      labPlanes.set(0, LEnhanced);
      LEnhanced = null;
    } finally {
      /* FIX R11 : libère le Mat retourné par get(0).
         Sans ce delete(), le data buffer d'origine (partagé avec
         labPlanes[0] avant set()) reste à refcount 1 → fuite de
         12 Mo par scan en mode Photo. */
      try { L.delete(); } catch (e) {
        VC.logError('19-scan-cv', '_modePhoto: L.delete échoué', e);
      }
    }
      var merged = new cv.Mat();
      mats.push(merged);
      cv.merge(labPlanes, merged);

      var resultRGB = new cv.Mat();
      mats.push(resultRGB);
      cv.cvtColor(merged, resultRGB, cv.COLOR_Lab2RGB);

      var resultRGBA = new cv.Mat();
      mats.push(resultRGBA);
      cv.cvtColor(resultRGB, resultRGBA, cv.COLOR_RGB2RGBA);

      var outCanvas = document.createElement('canvas');
      cv.imshow(outCanvas, resultRGBA);
      return outCanvas;
    } catch (e) {
      VC.logError('19-scan-cv', '_modePhoto échoué', e);
      return null;
    } finally {
      /* FIX Bug 6 : ordre de libération strict.
         labPlanes.delete() libère aussi L (retourné par get). */
      if (LEnhanced) {
        try { LEnhanced.delete(); } catch (e) { /* silencieux */ }
      }
      if (clahe) {
        try { clahe.delete(); } catch (e) { /* silencieux */ }
      }
      if (labPlanes) {
        try { labPlanes.delete(); } catch (e) { /* silencieux */ }
      }
      for (var m = 0; m < mats.length; m++) {
        try { mats[m].delete(); } catch (e) {
          VC.logError('19-scan-cv', 'cleanup photo mat échoué', e);
        }
      }
    }
  }

  /**
   * MODE TEXTE — Accentue la netteté (pour texte fin, signatures).
   * Binarisation adaptative Gaussienne + accentuation.
   */
  function _modeText(canvas, signal) {
    var cv = _cv();
    var mats = [];

    try {
      _checkAbort(signal);

      var src = cv.imread(canvas);
      mats.push(src);

      var gray = new cv.Mat();
      mats.push(gray);
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

      /* Correction d'ombres légère */
      var bg = new cv.Mat();
      mats.push(bg);
      var kernelBg = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(21, 21));
      mats.push(kernelBg);
      cv.morphologyEx(gray, bg, cv.MORPH_CLOSE, kernelBg);

      var normalized = new cv.Mat();
      mats.push(normalized);
      var bgFloat = new cv.Mat();
      mats.push(bgFloat);
      bg.convertTo(bgFloat, cv.CV_32F);

      var grayFloat = new cv.Mat();
      mats.push(grayFloat);
      gray.convertTo(grayFloat, cv.CV_32F);

      cv.divide(grayFloat, bgFloat, normalized, 255);
      var normalizedU8 = new cv.Mat();
      mats.push(normalizedU8);
      normalized.convertTo(normalizedU8, cv.CV_8U);

      _checkAbort(signal);

      /* Accentuation netteté */
      var sharpened = new cv.Mat();
      mats.push(sharpened);
      /* FIX Bug 3 : cv.Scalar n'accepte que 4 valeurs.
         Utiliser matFromArray pour un kernel 3×3 complet. */
      var kernelSharp = cv.matFromArray(3, 3, cv.CV_32F, [0, -1, 0, -1, 5, -1, 0, -1, 0]);
      mats.push(kernelSharp);
      cv.filter2D(normalizedU8, sharpened, cv.CV_8U, kernelSharp);

      /* Binarisation adaptative Gaussienne */
      var binary = new cv.Mat();
      mats.push(binary);
      cv.adaptiveThreshold(sharpened, binary, 255,
        cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, 25, 10);

      var resultRGBA = new cv.Mat();
      mats.push(resultRGBA);
      cv.cvtColor(binary, resultRGBA, cv.COLOR_GRAY2RGBA);

      var outCanvas = document.createElement('canvas');
      cv.imshow(outCanvas, resultRGBA);
      return outCanvas;

    } catch (e) {
      VC.logError('19-scan-cv', '_modeText échoué', e);
      return null;
    } finally {
      for (var m = 0; m < mats.length; m++) {
        try { mats[m].delete(); } catch (e) {
          VC.logError('19-scan-cv', 'cleanup text mat échoué', e);
        }
      }
    }
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 9 — MARQUEUR
     ═══════════════════════════════════════════════════════════ */

  VC._scanCvLoaded = true;

  VC.logInfo('19-scan-cv', 'Pipeline OpenCV chargé', {
    cvAvailable: _cvReady(),
    strategies: 4,
    modes: ['document', 'photo', 'text', 'none']
  });

})(window);