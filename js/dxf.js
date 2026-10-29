/*
 * DXF 裁片识别
 * ------------------------------------------------------------
 * 输入：DXF 文本
 * 输出：{ parts, sizeCount, warnings }
 *
 * 识别规则与 tools/extract_parts.py 保持一致：
 *   1. 只保留闭合多段线（首尾重合），面积 >= 250 mm²；
 *   2. 若一条闭合线的大部分采样点落在另一条更大的闭合线内部，
 *      视为内部工艺线（缝线/装饰线）剔除；
 *   3. 按包围盒上边缘聚类成「行」，行内按 x 由左到右即从小码到大码；
 *   4. 以各行裁片数的众数作为尺码数。
 */
(function (global) {
  'use strict';

  var AREA_MIN = 250;
  var NEST_SAMPLE = 40;
  var INSIDE_RATIO = 0.6;
  var ROW_TOL = 8;
  var RDP_EPS = 0.15;

  /* ---------- 基础几何 ---------- */

  function polyArea(pts) {
    var s = 0;
    for (var i = 0, n = pts.length; i < n; i++) {
      var p = pts[i], q = pts[(i + 1) % n];
      s += p[0] * q[1] - q[0] * p[1];
    }
    return Math.abs(s) / 2;
  }

  function bboxOf(pts) {
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (var i = 0; i < pts.length; i++) {
      var p = pts[i];
      if (p[0] < x0) x0 = p[0];
      if (p[1] < y0) y0 = p[1];
      if (p[0] > x1) x1 = p[0];
      if (p[1] > y1) y1 = p[1];
    }
    return [x0, y0, x1, y1];
  }

  function pointInPoly(pt, pts) {
    var x = pt[0], y = pt[1], inside = false;
    for (var i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      var xi = pts[i][0], yi = pts[i][1];
      var xj = pts[j][0], yj = pts[j][1];
      if ((yi > y) !== (yj > y)) {
        var xin = (xj - xi) * (y - yi) / (yj - yi) + xi;
        if (x < xin) inside = !inside;
      }
    }
    return inside;
  }

  function dist(a, b) {
    var dx = a[0] - b[0], dy = a[1] - b[1];
    return Math.sqrt(dx * dx + dy * dy);
  }

  /* ---------- Ramer-Douglas-Peucker 抽稀 ---------- */

  function rdp(pts, eps) {
    if (pts.length < 3) return pts;
    var loop = pts.slice();
    if (dist(loop[0], loop[loop.length - 1]) < 0.01) loop.pop();
    if (loop.length < 4) return pts;

    var far = 0, farD = -1;
    for (var i = 1; i < loop.length; i++) {
      var d = dist(loop[i], loop[0]);
      if (d > farD) { farD = d; far = i; }
    }
    var a = loop.slice(0, far + 1);
    var b = loop.slice(far).concat([loop[0]]);

    function simplify(seq) {
      if (seq.length < 3) return seq;
      var x1 = seq[0][0], y1 = seq[0][1];
      var x2 = seq[seq.length - 1][0], y2 = seq[seq.length - 1][1];
      var dx = x2 - x1, dy = y2 - y1;
      var norm = Math.sqrt(dx * dx + dy * dy);
      var idx = -1, dmax = 0;
      for (var k = 1; k < seq.length - 1; k++) {
        var px = seq[k][0], py = seq[k][1], dd;
        if (norm === 0) {
          dd = dist(seq[k], seq[0]);
        } else {
          dd = Math.abs(dy * px - dx * py + x2 * y1 - y2 * x1) / norm;
        }
        if (dd > dmax) { idx = k; dmax = dd; }
      }
      if (dmax > eps && idx > 0) {
        var left = simplify(seq.slice(0, idx + 1));
        var right = simplify(seq.slice(idx));
        return left.slice(0, -1).concat(right);
      }
      return [seq[0], seq[seq.length - 1]];
    }

    var out = simplify(a).slice(0, -1).concat(simplify(b).slice(0, -1));
    out.push(out[0]);
    return out;
  }

  /* ---------- DXF 解析 ---------- */

  function arcPoints(x1, y1, x2, y2, bulge) {
    var theta = 4 * Math.atan(bulge);
    var dx = x2 - x1, dy = y2 - y1;
    var d = Math.sqrt(dx * dx + dy * dy);
    if (d < 1e-9 || Math.abs(theta) < 1e-6) return [];
    var r = d / (2 * Math.sin(theta / 2));
    var h = r * Math.cos(theta / 2);
    var cx = (x1 + x2) / 2 - dy / d * h;
    var cy = (y1 + y2) / 2 + dx / d * h;
    var a0 = Math.atan2(y1 - cy, x1 - cx);
    var steps = Math.max(2, Math.ceil(Math.abs(theta) / (Math.PI / 24)));
    var pts = [];
    for (var i = 1; i < steps; i++) {
      var a = a0 + theta * i / steps;
      pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
    return pts;
  }

  function parse(text) {
    var lines = String(text).split(/\r\n|\r|\n/);
    var polylines = [];
    var poly = null;        // POLYLINE 状态
    var vertices = [];
    var lw = null;          // LWPOLYLINE 状态
    var lwPts = [];
    var pendingBulge = 0;

    function finishPoly() {
      if (poly && vertices.length >= 3) {
        var closed = (poly.flags & 1) === 1 || dist(vertices[0], vertices[vertices.length - 1]) < 0.5;
        polylines.push({ pts: vertices, closed: closed });
      }
      poly = null;
      vertices = [];
    }

    function finishLw() {
      if (lw && lwPts.length >= 3) {
        var pts = [];
        for (var i = 0; i < lwPts.length; i++) {
          pts.push(lwPts[i]);
          var b = lwPts[i].bulge;
          if (b && i + 1 < lwPts.length) {
            var extra = arcPoints(lwPts[i][0], lwPts[i][1], lwPts[i + 1][0], lwPts[i + 1][1], b);
            for (var k = 0; k < extra.length; k++) pts.push(extra[k]);
          }
        }
        var closedLw = (lw.flags & 1) === 1 || dist(pts[0], pts[pts.length - 1]) < 0.5;
        // 闭合段上的凸度（圆角）也要补成弧线
        if (closedLw && lwPts.length > 1 && lwPts[lwPts.length - 1].bulge) {
          var last = lwPts[lwPts.length - 1];
          var closing = arcPoints(last[0], last[1], lwPts[0][0], lwPts[0][1], last.bulge);
          for (var ci = 0; ci < closing.length; ci++) pts.push(closing[ci]);
        }
        polylines.push({ pts: pts, closed: closedLw });
      }
      lw = null;
      lwPts = [];
    }

    for (var i = 0; i + 1 < lines.length; i += 2) {
      var code = lines[i].trim();
      var val = lines[i + 1].trim();

      if (code === '0') {
        if (val === 'POLYLINE') {
          finishLw();
          finishPoly();
          poly = { flags: 0 };
          vertices = [];
        } else if (val === 'VERTEX') {
          if (poly) vertices.push([0, 0]);
        } else if (val === 'SEQEND') {
          finishPoly();
        } else if (val === 'LWPOLYLINE') {
          finishPoly();
          finishLw();
          lw = { flags: 0 };
          lwPts = [];
        } else {
          finishPoly();
          finishLw();
        }
        continue;
      }

      if (poly !== null) {
        if (code === '10') {
          if (vertices.length) vertices[vertices.length - 1][0] = parseFloat(val);
        } else if (code === '20') {
          if (vertices.length) vertices[vertices.length - 1][1] = parseFloat(val);
        } else if (code === '70' && vertices.length === 0) {
          poly.flags = parseInt(val, 10) || 0;
        }
      }

      if (lw !== null) {
        if (code === '10') {
          lwPts.push([parseFloat(val), 0]);
        } else if (code === '20') {
          if (lwPts.length) lwPts[lwPts.length - 1][1] = parseFloat(val);
        } else if (code === '42') {
          if (lwPts.length) lwPts[lwPts.length - 1].bulge = parseFloat(val) || 0;
        } else if (code === '70') {
          lw.flags = parseInt(val, 10) || 0;
        }
      }
    }
    finishPoly();
    finishLw();
    return polylines;
  }

  /* ---------- 提取裁片 ---------- */

  function extract(polylines) {
    var warnings = [];
    var candidates = [];

    for (var i = 0; i < polylines.length; i++) {
      var pl = polylines[i];
      if (!pl.closed) continue;
      var area = polyArea(pl.pts);
      if (!isFinite(area) || area < AREA_MIN) continue;
      candidates.push({ pts: pl.pts, area: area, bbox: bboxOf(pl.pts) });
    }

    candidates.sort(function (a, b) { return b.area - a.area; });

    var keep = [];
    for (var c = 0; c < candidates.length; c++) {
      var cand = candidates[c];
      var step = Math.max(1, Math.floor(cand.pts.length / NEST_SAMPLE));
      var samples = [];
      for (var s = 0; s < cand.pts.length; s += step) samples.push(cand.pts[s]);
      var nested = false;
      for (var k = 0; k < keep.length; k++) {
        var host = keep[k];
        if (host.area <= cand.area) continue;
        var hb = host.bbox;
        var hit = 0;
        for (var si = 0; si < samples.length; si++) {
          var p = samples[si];
          if (p[0] >= hb[0] && p[0] <= hb[2] && p[1] >= hb[1] && p[1] <= hb[3] && pointInPoly(p, host.pts)) hit++;
        }
        if (hit > samples.length * INSIDE_RATIO) { nested = true; break; }
      }
      if (!nested) keep.push(cand);
    }

    if (!keep.length) {
      throw new Error('DXF 中没有识别到闭合的裁片轮廓（需要闭合多段线 POLYLINE / LWPOLYLINE）。');
    }

    keep.sort(function (a, b) { return a.bbox[1] - b.bbox[1]; });

    var rows = [];
    for (var r = 0; r < keep.length; r++) {
      var cur = keep[r];
      var last = rows[rows.length - 1];
      if (last && Math.abs(cur.bbox[1] - last.top) <= ROW_TOL) {
        last.items.push(cur);
        var sum = 0;
        for (var t = 0; t < last.items.length; t++) sum += last.items[t].bbox[1];
        last.top = sum / last.items.length;
      } else {
        rows.push({ top: cur.bbox[1], items: [cur] });
      }
    }

    var counts = rows.map(function (row) { return row.items.length; });
    var sizeCount = mode(counts);
    if (!sizeCount) throw new Error('未能确定尺码数量。');

    rows.forEach(function (row) {
      row.items.sort(function (a, b) { return a.bbox[0] - b.bbox[0]; });
      if (row.items.length !== sizeCount) {
        warnings.push('有一排识别到 ' + row.items.length + ' 个裁片，与尺码数 ' + sizeCount +
          ' 不一致，已按左侧顺序对应。');
      }
    });

    var parts = rows.map(function (row) {
      var polys = [];
      for (var i = 0; i < sizeCount; i++) {
        var item = row.items[Math.min(i, row.items.length - 1)];
        polys.push(normalize(item));
      }
      return {
        name: '',
        sizes: polys
      };
    });

    parts.forEach(function (part, i) {
      var avg = part.sizes.reduce(function (a, s) { return a + s.area; }, 0) / part.sizes.length;
      part.avgArea = avg;
    });
    parts.sort(function (a, b) { return b.avgArea - a.avgArea; });
    parts.forEach(function (part, i) {
      part.name = '部件' + String(i + 1).padStart(2, '0');
      delete part.avgArea;
    });

    return { parts: parts, sizeCount: sizeCount, warnings: warnings };
  }

  function mode(arr) {
    var map = {};
    var best = 0, bestCount = 0;
    for (var i = 0; i < arr.length; i++) {
      map[arr[i]] = (map[arr[i]] || 0) + 1;
      if (map[arr[i]] > bestCount) { bestCount = map[arr[i]]; best = arr[i]; }
    }
    return best;
  }

  function normalize(item) {
    var clean = [];
    for (var ci = 0; ci < item.pts.length; ci++) {
      var cp = item.pts[ci];
      if (isFinite(cp[0]) && isFinite(cp[1])) clean.push(cp);
    }
    if (clean.length < 3) {
      return { pts: [[0, 0], [1, 1], [1, 0]], area: 0.5, w: 1, h: 1 };
    }
    var pts = rdp(clean, RDP_EPS);
    var b = bboxOf(pts);
    var x0 = b[0], y0 = b[1];
    var out = [];
    for (var i = 0; i < pts.length; i++) {
      out.push([Math.round((pts[i][0] - x0) * 10) / 10, Math.round((pts[i][1] - y0) * 10) / 10]);
    }
    if (out.length > 1 && out[0][0] === out[out.length - 1][0] && out[0][1] === out[out.length - 1][1]) {
      out.pop();
    }
    var bb = bboxOf(out);
    return {
      pts: out,
      area: Math.round(polyArea(out) * 10) / 10,
      w: Math.round((bb[2] - bb[0]) * 10) / 10,
      h: Math.round((bb[3] - bb[1]) * 10) / 10
    };
  }

  global.DXF = {
    parse: parse,
    extract: extract,
    polyArea: polyArea,
    bboxOf: bboxOf
  };
})(window);
