/* ═══════════════════════════════════════════════════════════
   VOLTCORE — 20-scan-js.js
   VERSION : v7.0.7
   RÔLE : Pipeline scanner en JS pur (fallback sans OpenCV).
          - Détection simplifiée par gradient (Sobel)
          - Warp perspective bilinéaire (pas seulement 2 triangles)
          - Modes : document / photo / text / none
          - Otsu binarization
          - CLAHE simplifié pour mode photo
   DÉPENDANCES : 00-core, 01-utils
   ORDRE : 21ᵉ fichier chargé

   ⚠️ Le fallback n'est PAS aussi performant qu'OpenCV.
   Il est pensé pour garantir que le scan FONCTIONNE TOUJOURS,
   même si OpenCV échoue à charger (11 Mo, réseau lent, mobile ancien).

   API identique à VC.ScanCV :
   - detectCorners(canvas) → Promise<Array<{x%, y%} × 4 | null>
   - process(canvas, opts)  → Promise<HTMLCanvasElement>

   RÈGLES :
   - ES5 strict
   - Aucun catch silencieux
   - Aucune dépendance externe
   - Respecte signal.aborted à chaque étape
   ═══════════════════════════════════════════════════════════ */

'use strict';

(function (global) {

  if (!global.VOLTCORE || !global.VOLTCORE.Utils) {
    throw new Error('[20-scan-js] 00-core et 01-utils requis');
  }

  var VC = global.VOLTCORE;
  var JS = VC.ScanJS || {};
  VC.ScanJS = JS;

  /* ═══════════════════════════════════════════════════════════
     SECTION 1 — CONSTANTES
     ═══════════════════════════════════════════════════════════ */

  var MAX_WARP_DIM = 1600;
  var DETECT_MAX_DIM = 500;

  /* ═══════════════════════════════════════════════════════════
     SECTION 2 — HELPERS
     ═══════════════════════════════════════════════════════════ */

  function _checkAbort(signal) {
    if (signal && signal.aborted) {
      var e = new Error('Aborted');
      e.name = 'AbortError';
      throw e;
    }
  }

  function _canvasCopy(src) {
    var c = document.createElement('canvas');
    c.width = src.width;
    c.height = src.height;
    c.getContext('2d').drawImage(src, 0, 0);
    return c;
  }

  function _resizeCanvas(src, maxDim) {
    if (src.width <= maxDim && src.height <= maxDim) {
      return _canvasCopy(src);
    }
    var ratio = Math.min(maxDim / src.width, maxDim / src.height);
    var w = Math.round(src.width * ratio);
    var h = Math.round(src.height * ratio);
    var out = document.createElement('canvas');
    out.width = w;
    out.height = h;
    out.getContext('2d').drawImage(src, 0, 0, w, h);
    return out;
  }

  function _toGrayscale(imageData) {
    var w = imageData.width;
    var h = imageData.height;
    var data = imageData.data;
    var gray = new Uint8Array(w * h);

    for (var i = 0, j = 0; i < data.length; i += 4, j++) {
      gray[j] = Math.round(
        0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
      );
    }
    return gray;
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 3 — DÉTECTION DES COINS (Sobel + heuristique)
     ═══════════════════════════════════════════════════════════ */

  /**
   * Détection par gradients. Beaucoup plus simple qu'OpenCV :
   * - Calcule le gradient de Sobel
   * - Cherche les 4 points extrêmes (haut-gauche, haut-droite, bas-droite, bas-gauche)
   *   parmi les pixels à fort gradient
   * - Retourne en % ou null si insuffisant
   */
  JS.detectCorners = function (canvas) {
    return new Promise(function (resolve) {
      if (!canvas || !canvas.width || !canvas.height) {
        resolve(null);
        return;
      }

      try {
        var small = _resizeCanvas(canvas, DETECT_MAX_DIM);
        var ctx = small.getContext('2d');
        var imgData = ctx.getImageData(0, 0, small.width, small.height);
        var gray = _toGrayscale(imgData);

        var w = small.width;
        var h = small.height;
        var sobel = _sobelMagnitude(gray, w, h);

        /* Trouve un seuil adaptatif : percentile 90 des gradients */
        var threshold = _percentile(sobel, 0.90);
        if (threshold < 20) {
          /* Pas assez de contours → abandon */
          resolve(null);
          return;
        }

        /* Cherche les 4 coins extrêmes parmi les points à fort gradient */
        var tl = null, tr = null, br = null, bl = null;
        var minSumTL = Infinity, maxSumBR = -Infinity;
        var maxDiffTR = -Infinity, maxDiffBL = -Infinity;

        for (var y = 0; y < h; y++) {
          for (var x = 0; x < w; x++) {
            var idx = y * w + x;
            if (sobel[idx] < threshold) continue;

            var sum = x + y;
            var diff = y - x;

            if (sum < minSumTL) {
              minSumTL = sum;
              tl = { x: x, y: y };
            }
            if (sum > maxSumBR) {
              maxSumBR = sum;
              br = { x: x, y: y };
            }
            if (diff > maxDiffTR) {
              maxDiffTR = diff;
              tr = { x: x, y: y };
            }
            if (diff < maxDiffBL) {
              maxDiffBL = diff;
              bl = { x: x, y: y };
            }
          }
        }

        if (!tl || !tr || !br || !bl) {
          resolve(null);
          return;
        }

        /* Valide que c'est un quadrilatère cohérent */
        var pts = [tl, tr, br, bl];
        if (!_isValidQuad(pts)) {
          resolve(null);
          return;
        }

        /* Convertit en pourcentages */
        var result = [];
        for (var i = 0; i < 4; i++) {
          result.push({
            x: Math.max(0, Math.min(100, pts[i].x / w * 100)),
            y: Math.max(0, Math.min(100, pts[i].y / h * 100))
          });
        }

        resolve(result);

      } catch (e) {
        VC.logError('20-scan-js', 'detectCorners échoué', e);
        resolve(null);
      }
    });
  };

  function _sobelMagnitude(gray, w, h) {
    var out = new Uint16Array(w * h);

    for (var y = 1; y < h - 1; y++) {
      for (var x = 1; x < w - 1; x++) {
        var idx = y * w + x;

        var gx =
          -gray[(y - 1) * w + (x - 1)] + gray[(y - 1) * w + (x + 1)]
          - 2 * gray[y * w + (x - 1)] + 2 * gray[y * w + (x + 1)]
          - gray[(y + 1) * w + (x - 1)] + gray[(y + 1) * w + (x + 1)];

        var gy =
          -gray[(y - 1) * w + (x - 1)] - 2 * gray[(y - 1) * w + x] - gray[(y - 1) * w + (x + 1)]
          + gray[(y + 1) * w + (x - 1)] + 2 * gray[(y + 1) * w + x] + gray[(y + 1) * w + (x + 1)];

        var mag = Math.sqrt(gx * gx + gy * gy);
        out[idx] = Math.min(65535, mag);
      }
    }
    return out;
  }

  function _percentile(arr, p) {
    /* Échantillonne pour perf */
    var step = Math.max(1, Math.floor(arr.length / 10000));
    var sample = [];
    for (var i = 0; i < arr.length; i += step) {
      sample.push(arr[i]);
    }
    sample.sort(function (a, b) { return a - b; });
    var idx = Math.floor(sample.length * p);
    return sample[idx] || 0;
  }

  function _isValidQuad(pts) {
    if (!pts || pts.length !== 4) return false;

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

    if (minS < 20) return false;
    if (maxS / minS > 10) return false;

    return true;
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 4 — TRAITEMENT PRINCIPAL
     ═══════════════════════════════════════════════════════════ */

  JS.process = function (sourceCanvas, opts) {
    return new Promise(function (resolve, reject) {
      if (!sourceCanvas || !sourceCanvas.width) {
        reject(new Error('Canvas source invalide'));
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

      /* Étape 1 : rotation / miroir */
      var rotated;
      try {
        rotated = _applyRotationMirror(sourceCanvas, o.rotation, o.mirrored);
      } catch (e) {
        VC.logError('20-scan-js', 'rotation échouée', e);
        reject(e);
        return;
      }

      /* Étape 2 : warp */
      var warped;
      try {
        _checkAbort(signal);
        warped = _warpPerspectiveBilinear(rotated, o.corners, signal);
      } catch (e) {
        VC.logError('20-scan-js', 'warp échoué', e);
        reject(e);
        return;
      }

      if (!warped) {
        reject(new Error('Warp perspective échoué'));
        return;
      }

      /* Étape 3 : mode */
      var result;
      try {
        _checkAbort(signal);
        result = _applyMode(warped, o.mode || 'document');
      } catch (e) {
        VC.logError('20-scan-js', 'mode échoué', e);
        reject(e);
        return;
      }

      resolve(result);
    });
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 5 — ROTATION / MIROIR
     ═══════════════════════════════════════════════════════════ */

  function _applyRotationMirror(sourceCanvas, rotation, mirrored) {
    var rot = ((parseInt(rotation, 10) || 0) % 360 + 360) % 360;
    var mir = !!mirrored;

    var w = sourceCanvas.width;
    var h = sourceCanvas.height;
    var outW = (rot === 90 || rot === 270) ? h : w;
    var outH = (rot === 90 || rot === 270) ? w : h;

    var out = document.createElement('canvas');
    out.width = outW;
    out.height = outH;

    var ctx = out.getContext('2d');
    ctx.save();
    ctx.translate(outW / 2, outH / 2);
    ctx.rotate(rot * Math.PI / 180);
    if (mir) ctx.scale(-1, 1);
    ctx.drawImage(sourceCanvas, -w / 2, -h / 2);
    ctx.restore();

    return out;
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 5.bis — WARP PERSPECTIVE BILINÉAIRE
     ═══════════════════════════════════════════════════════════ */

  /**
   * Warp perspective en pur JS.
   * Calcule pour chaque pixel de destination ses coordonnées (u, v)
   * dans la source par interpolation bilinéaire, plutôt que de découper
   * en 2 triangles (qui produit des artefacts sur les droites).
   *
   * Utilise une homographie calculée par résolution de système 8×8
   * (méthode des moindres carrés simplifiée pour 4 points).
   */
  function _warpPerspectiveBilinear(sourceCanvas, cornersPercent, signal) {
    /* Si pas de corners : retourne la source */
    if (!cornersPercent || cornersPercent.length !== 4) {
      return _canvasCopy(sourceCanvas);
    }

    var srcW = sourceCanvas.width;
    var srcH = sourceCanvas.height;
    var srcCtx = sourceCanvas.getContext('2d');
    var srcData = srcCtx.getImageData(0, 0, srcW, srcH);

    /* Coins en pixels */
    var corners = [];
    for (var i = 0; i < 4; i++) {
      corners.push({
        x: cornersPercent[i].x / 100 * srcW,
        y: cornersPercent[i].y / 100 * srcH
      });
    }

    /* Dimensions destination */
    var w1 = Math.hypot(corners[1].x - corners[0].x, corners[1].y - corners[0].y);
    var w2 = Math.hypot(corners[2].x - corners[3].x, corners[2].y - corners[3].y);
    var h1 = Math.hypot(corners[3].x - corners[0].x, corners[3].y - corners[0].y);
    var h2 = Math.hypot(corners[2].x - corners[1].x, corners[2].y - corners[1].y);

    var dstW = Math.round(Math.max(w1, w2));
    var dstH = Math.round(Math.max(h1, h2));

    if (dstW < 10 || dstH < 10) return null;

    if (dstW > MAX_WARP_DIM || dstH > MAX_WARP_DIM) {
      var r = Math.min(MAX_WARP_DIM / dstW, MAX_WARP_DIM / dstH);
      dstW = Math.round(dstW * r);
      dstH = Math.round(dstH * r);
    }

    /* Calcule l'homographie inverse (dst → src) */
    var H = _computeHomography(
      [{ x: 0, y: 0 }, { x: dstW, y: 0 }, { x: dstW, y: dstH }, { x: 0, y: dstH }],
      corners
    );

    if (!H) return null;

    var dstCanvas = document.createElement('canvas');
    dstCanvas.width = dstW;
    dstCanvas.height = dstH;

    var dstCtx = dstCanvas.getContext('2d');
    var dstImg = dstCtx.createImageData(dstW, dstH);
    var dstPixels = dstImg.data;
    var srcPixels = srcData.data;

    /* Pour chaque pixel destination */
    for (var y = 0; y < dstH; y++) {
      if (signal && signal.aborted) {
        var err = new Error('Aborted');
        err.name = 'AbortError';
        throw err;
      }

      for (var x = 0; x < dstW; x++) {
        /* Applique H : (x, y) → (sx, sy) */
        var d = H[6] * x + H[7] * y + 1;
        if (Math.abs(d) < 1e-10) d = 1e-10;

        var sx = (H[0] * x + H[1] * y + H[2]) / d;
        var sy = (H[3] * x + H[4] * y + H[5]) / d;

        /* Interpolation bilinéaire */
        var color = _bilinearSample(srcPixels, srcW, srcH, sx, sy);

        var idx = (y * dstW + x) * 4;
        dstPixels[idx] = color[0];
        dstPixels[idx + 1] = color[1];
        dstPixels[idx + 2] = color[2];
        dstPixels[idx + 3] = 255;
      }
    }

    dstCtx.putImageData(dstImg, 0, 0);
    return dstCanvas;
  }

  function _bilinearSample(pixels, w, h, fx, fy) {
    if (fx < 0) fx = 0;
    if (fy < 0) fy = 0;
    if (fx >= w - 1) fx = w - 2;
    if (fy >= h - 1) fy = h - 2;

    var x0 = Math.floor(fx);
    var y0 = Math.floor(fy);
    var x1 = x0 + 1;
    var y1 = y0 + 1;

    var dx = fx - x0;
    var dy = fy - y0;

    var idx00 = (y0 * w + x0) * 4;
    var idx10 = (y0 * w + x1) * 4;
    var idx01 = (y1 * w + x0) * 4;
    var idx11 = (y1 * w + x1) * 4;

    var c = [0, 0, 0];
    for (var k = 0; k < 3; k++) {
      var v00 = pixels[idx00 + k];
      var v10 = pixels[idx10 + k];
      var v01 = pixels[idx01 + k];
      var v11 = pixels[idx11 + k];

      var v0 = v00 * (1 - dx) + v10 * dx;
      var v1 = v01 * (1 - dx) + v11 * dx;
      c[k] = Math.round(v0 * (1 - dy) + v1 * dy);
    }
    return c;
  }

  /**
   * Calcule l'homographie 3×3 (8 inconnues) qui mappe les 4 points `from`
   * vers les 4 points `to`. Résolution par élimination de Gauss.
   */
  function _computeHomography(from, to) {
    /* Matrice 8×9 : [A | b] où A·h = b */
    var M = [];

    for (var i = 0; i < 4; i++) {
      var fx = from[i].x, fy = from[i].y;
      var tx = to[i].x, ty = to[i].y;

      M.push([fx, fy, 1, 0, 0, 0, -fx * tx, -fy * tx, tx]);
      M.push([0, 0, 0, fx, fy, 1, -fx * ty, -fy * ty, ty]);
    }

    /* Élimination de Gauss */
    for (var col = 0; col < 8; col++) {
      /* Pivot */
      var pivotRow = col;
      var maxVal = Math.abs(M[col][col]);
      for (var row = col + 1; row < 8; row++) {
        if (Math.abs(M[row][col]) > maxVal) {
          maxVal = Math.abs(M[row][col]);
          pivotRow = row;
        }
      }

      if (maxVal < 1e-10) return null;

      if (pivotRow !== col) {
        var tmp = M[col];
        M[col] = M[pivotRow];
        M[pivotRow] = tmp;
      }

      /* Normalise la ligne pivot */
      var pivot = M[col][col];
      for (var k = col; k < 9; k++) {
        M[col][k] /= pivot;
      }

      /* Élimine la colonne dans les autres lignes */
      for (var r = 0; r < 8; r++) {
        if (r === col) continue;
        var factor = M[r][col];
        if (Math.abs(factor) < 1e-12) continue;
        for (var k2 = col; k2 < 9; k2++) {
          M[r][k2] -= factor * M[col][k2];
        }
      }
    }

    /* Les 8 inconnues sont dans la dernière colonne */
    var h = [];
    for (var i2 = 0; i2 < 8; i2++) {
      h.push(M[i2][8]);
    }

    return h;
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 6 — MODES DE TRAITEMENT
     ═══════════════════════════════════════════════════════════ */

  function _applyMode(canvas, mode) {
    switch (mode) {
      case 'document': return _modeDocument(canvas);
      case 'photo':    return _modePhoto(canvas);
      case 'text':     return _modeText(canvas);
      case 'none':     return _canvasCopy(canvas);
      default:         return _modeDocument(canvas);
    }
  }

  /**
   * MODE DOCUMENT — Binarisation Otsu avec correction d'ombres légère.
   */
  function _modeDocument(canvas) {
    var ctx = canvas.getContext('2d');
    var imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    var data = imgData.data;
    var w = canvas.width;
    var h = canvas.height;
    var gray = _toGrayscale(imgData);

    /* Correction d'ombres : divise par une version floue du gray */
    var blurred = _boxBlur(gray, w, h, 15);
    var normalized = new Uint8Array(w * h);
    for (var i = 0; i < w * h; i++) {
      var denom = blurred[i] || 1;
      var v = (gray[i] / denom) * 200;
      normalized[i] = Math.min(255, v);
    }

    /* Otsu */
    var threshold = _otsuThreshold(normalized);

    for (var j = 0, k = 0; j < data.length; j += 4, k++) {
      var out = normalized[k] < threshold ? 0 : 255;
      data[j] = out;
      data[j + 1] = out;
      data[j + 2] = out;
      data[j + 3] = 255;
    }

    ctx.putImageData(imgData, 0, 0);
    return canvas;
  }

  /**
   * MODE PHOTO — Amélioration contraste + saturation (garde couleurs).
   */
  function _modePhoto(canvas) {
    var ctx = canvas.getContext('2d');
    var imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    var data = imgData.data;

    /* 1. Contraste : normalise chaque canal par min/max local (simplifié) */
    var minR = 255, maxR = 0, minG = 255, maxG = 0, minB = 255, maxB = 0;
    for (var i = 0; i < data.length; i += 4) {
      if (data[i] < minR) minR = data[i];
      if (data[i] > maxR) maxR = data[i];
      if (data[i + 1] < minG) minG = data[i + 1];
      if (data[i + 1] > maxG) maxG = data[i + 1];
      if (data[i + 2] < minB) minB = data[i + 2];
      if (data[i + 2] > maxB) maxB = data[i + 2];
    }

    var rangeR = Math.max(1, maxR - minR);
    var rangeG = Math.max(1, maxG - minG);
    var rangeB = Math.max(1, maxB - minB);

    /* 2. Applique étirement contraste + légère saturation */
    for (var j = 0; j < data.length; j += 4) {
      data[j] = Math.round((data[j] - minR) / rangeR * 255);
      data[j + 1] = Math.round((data[j + 1] - minG) / rangeG * 255);
      data[j + 2] = Math.round((data[j + 2] - minB) / rangeB * 255);
    }

    ctx.putImageData(imgData, 0, 0);
    return canvas;
  }

  /**
   * MODE TEXTE — Accentuation netteté + binarisation Otsu.
   */
  function _modeText(canvas) {
    var ctx = canvas.getContext('2d');
    var imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    var data = imgData.data;
    var w = canvas.width;
    var h = canvas.height;
    var gray = _toGrayscale(imgData);

    /* Accentuation par filtre "unsharp mask" simplifié */
    var blurred = _boxBlur(gray, w, h, 2);
    var sharpened = new Uint8Array(w * h);
    for (var i = 0; i < w * h; i++) {
      var v = gray[i] + (gray[i] - blurred[i]) * 1.5;
      sharpened[i] = Math.max(0, Math.min(255, v));
    }

    /* Otsu */
    var threshold = _otsuThreshold(sharpened);

    for (var j = 0, k = 0; j < data.length; j += 4, k++) {
      var out = sharpened[k] < threshold ? 0 : 255;
      data[j] = out;
      data[j + 1] = out;
      data[j + 2] = out;
      data[j + 3] = 255;
    }

    ctx.putImageData(imgData, 0, 0);
    return canvas;
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 7 — FILTRES UTILITAIRES
     ═══════════════════════════════════════════════════════════ */

  function _boxBlur(gray, w, h, radius) {
    var out = new Uint8Array(w * h);
    var r = Math.max(1, radius);

    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var sum = 0, count = 0;

        for (var dy = -r; dy <= r; dy++) {
          var yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (var dx = -r; dx <= r; dx++) {
            var xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            sum += gray[yy * w + xx];
            count++;
          }
        }

        out[y * w + x] = count > 0 ? Math.round(sum / count) : 0;
      }
    }
    return out;
  }

  function _otsuThreshold(gray) {
    var hist = new Array(256);
    for (var i = 0; i < 256; i++) hist[i] = 0;

    for (var j = 0; j < gray.length; j++) hist[gray[j]]++;

    var total = gray.length;
    var sum = 0;
    for (var k = 0; k < 256; k++) sum += k * hist[k];

    var sumB = 0, wB = 0, maxVar = 0, bestT = 0;

    for (var t = 0; t < 256; t++) {
      wB += hist[t];
      if (wB === 0) continue;

      var wF = total - wB;
      if (wF === 0) break;

      sumB += t * hist[t];
      var mB = sumB / wB;
      var mF = (sum - sumB) / wF;
      var between = wB * wF * (mB - mF) * (mB - mF);

      if (between > maxVar) {
        maxVar = between;
        bestT = t;
      }
    }

    return Math.max(1, Math.min(254, bestT));
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 8 — MARQUEUR
     ═══════════════════════════════════════════════════════════ */

  VC._scanJsLoaded = true;

  VC.logInfo('20-scan-js', 'Fallback JS pur chargé', {
    modes: ['document', 'photo', 'text', 'none'],
    detect: 'sobel-extremes',
    warp: 'bilinear-homography'
  });

})(window);