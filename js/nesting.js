/*
 * 排料估算引擎
 * ------------------------------------------------------------
 * 采用工厂常用的「横排套排」：
 *   · 每排沿幅宽方向摆放裁片，排高 = 裁片包围盒高度；
 *   · 允许 0°/90° 旋转；相邻裁片可翻转 180° 交错套排，
 *     用 1mm 栅格碰撞检测求最小排距（含裁片间距）；
 *   · 各排沿布长方向依次排列，遇到 45m 卷尾自动换卷。
 *
 * 这是一个偏保守、可解释的工程估算，不追求数学最优。
 */
(function (global) {
  'use strict';

  var RES = 2; // mm / cell，用于交错套排的碰撞检测（2mm 精度足够工程估算）

  /* ---------- 基础几何 ---------- */

  function rotate(pts, w, h, deg) {
    var out = [];
    var i, p;
    deg = ((deg % 360) + 360) % 360;
    if (deg === 0) return { pts: pts, w: w, h: h };
    if (deg === 90) {
      for (i = 0; i < pts.length; i++) {
        p = pts[i];
        out.push([h - p[1], p[0]]);
      }
      return { pts: out, w: h, h: w };
    }
    if (deg === 180) {
      for (i = 0; i < pts.length; i++) {
        p = pts[i];
        out.push([w - p[0], h - p[1]]);
      }
      return { pts: out, w: w, h: h };
    }
    if (deg === 270) {
      for (i = 0; i < pts.length; i++) {
        p = pts[i];
        out.push([p[1], w - p[0]]);
      }
      return { pts: out, w: h, h: w };
    }

    // 任意角度（45° 步进）：绕包围盒中心旋转后归零
    var rad = deg * Math.PI / 180;
    var cos = Math.cos(rad), sin = Math.sin(rad);
    var cx = w / 2, cy = h / 2;
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    var out2 = new Array(pts.length);
    for (i = 0; i < pts.length; i++) {
      var vx = pts[i][0] - cx, vy = pts[i][1] - cy;
      var nx = vx * cos - vy * sin;
      var ny = vx * sin + vy * cos;
      out2[i] = [nx, ny];
      if (nx < minX) minX = nx;
      if (nx > maxX) maxX = nx;
      if (ny < minY) minY = ny;
      if (ny > maxY) maxY = ny;
    }
    for (i = 0; i < out2.length; i++) {
      out2[i][0] -= minX;
      out2[i][1] -= minY;
    }
    return { pts: out2, w: maxX - minX, h: maxY - minY };
  }

  /* ---------- 栅格蒙版（用于求交错排距） ---------- */

  function buildMask(pts, w, h, pad) {
    var W = Math.ceil(w / RES) + pad * 2 + 2;
    var H = Math.ceil(h / RES) + pad * 2 + 2;
    var grid = new Uint8Array(W * H);

    for (var r = 0; r < H; r++) {
      var y = (r + 0.5 - pad) * RES;
      var xs = [];
      for (var i = 0; i < pts.length; i++) {
        var p = pts[i], q = pts[(i + 1) % pts.length];
        if ((p[1] > y) !== (q[1] > y)) {
          xs.push((p[0] + (y - p[1]) * (q[0] - p[0]) / (q[1] - p[1])) / RES + pad);
        }
      }
      if (xs.length < 2) continue;
      xs.sort(function (a, b) { return a - b; });
      for (var k = 0; k + 1 < xs.length; k += 2) {
        var xa = Math.max(0, Math.ceil(xs[k] - 0.5));
        var xb = Math.min(W - 1, Math.floor(xs[k + 1] - 0.5));
        for (var x = xa; x <= xb; x++) grid[r * W + x] = 1;
      }
    }

    for (var d = 0; d < pad; d++) {
      var next = grid.slice();
      for (var yy = 0; yy < H; yy++) {
        for (var xx = 0; xx < W; xx++) {
          var idx = yy * W + xx;
          if (grid[idx]) continue;
          if ((yy > 0 && grid[idx - W]) || (yy < H - 1 && grid[idx + W]) ||
              (xx > 0 && grid[idx - 1]) || (xx < W - 1 && grid[idx + 1])) {
            next[idx] = 1;
          }
        }
      }
      grid = next;
    }

    var words = (W + 31) >> 5;
    var data = new Uint32Array(H * words);
    for (var ry = 0; ry < H; ry++) {
      for (var rx = 0; rx < W; rx++) {
        if (grid[ry * W + rx]) data[ry * words + (rx >> 5)] |= (1 << (rx & 31));
      }
    }
    return { w: W, h: H, words: words, data: data };
  }

  function masksOverlap(A, B, dx) {
    // 把 B 的位图整体右移 dx 个栅格（裁片 B 放在 A 右侧 dx 处）
    var ws = dx >> 5, bs = dx & 31;
    var n = A.words;
    for (var y = 0; y < A.h; y++) {
      var ao = y * A.words, bo = y * B.words;
      for (var i = 0; i < n; i++) {
        var j = i - ws;
        if (j < 0) continue;
        var v = B.data[bo + j] << bs;
        if (bs && j - 1 >= 0) v |= B.data[bo + j - 1] >>> (32 - bs);
        if (A.data[ao + i] & v) return true;
      }
    }
    return false;
  }

  function computePitch(opt, gap) {
    if (opt._pitch !== undefined) return opt._pitch;
    var pad = Math.max(0, Math.round(gap / (2 * RES)));
    var wCells = Math.ceil(opt.w / RES);
    var hCells = Math.ceil(opt.h / RES);
    if (wCells < 6 || hCells < 6 || wCells * hCells > 120000) {
      opt._pitch = opt.w;
      return opt._pitch;
    }
    var A = buildMask(opt.ptsA, opt.w, opt.h, pad);
    var B = buildMask(opt.ptsB, opt.w, opt.h, pad);
    var start = Math.max(2, Math.floor(wCells * 0.45));
    var pitch = opt.w;
    for (var dx = start; dx < wCells; dx++) {
      // 交替排布时 A→B 与 B→A 两种相邻关系都必须无碰撞
      if (!masksOverlap(A, B, dx) && !masksOverlap(B, A, dx)) { pitch = dx * RES; break; }
    }
    opt._pitch = pitch;
    return pitch;
  }

  /* ---------- 精确几何校验 ----------
   * 栅格只用来快速估计排距；最终排距必须通过下面的精确多边形距离校验：
   * 任意两片之间的最小距离 >= 裁片间距，保证严格不重叠。
   */

  function pointSegDist2(px, py, ax, ay, bx, by) {
    var vx = bx - ax, vy = by - ay;
    var wx = px - ax, wy = py - ay;
    var c1 = vx * wx + vy * wy;
    if (c1 <= 0) return wx * wx + wy * wy;
    var c2 = vx * vx + vy * vy;
    if (c2 <= c1) {
      var dx2 = px - bx, dy2 = py - by;
      return dx2 * dx2 + dy2 * dy2;
    }
    var t = c1 / c2;
    var dx = px - (ax + t * vx), dy = py - (ay + t * vy);
    return dx * dx + dy * dy;
  }

  function pointInPolyX(x, y, poly, dx) {
    var inside = false;
    for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      var xi = poly[i][0] + dx, yi = poly[i][1];
      var xj = poly[j][0] + dx, yj = poly[j][1];
      if ((yi > y) !== (yj > y)) {
        var xin = (xj - xi) * (y - yi) / (yj - yi) + xi;
        if (x < xin) inside = !inside;
      }
    }
    return inside;
  }

  function segsCross(ax, ay, bx, by, cx, cy, dx, dy) {
    function orient(px, py, qx, qy, rx, ry) {
      var v = (qx - px) * (ry - py) - (qy - py) * (rx - px);
      return v > 1e-9 ? 1 : (v < -1e-9 ? -1 : 0);
    }
    var d1 = orient(ax, ay, bx, by, cx, cy);
    var d2 = orient(ax, ay, bx, by, dx, dy);
    var d3 = orient(cx, cy, dx, dy, ax, ay);
    var d4 = orient(cx, cy, dx, dy, bx, by);
    return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
           ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
  }

  // A 固定在原点，B 水平右移 dx；返回两轮廓的最小距离（相交/包含时为 0）
  function polyClearance(A, B, dx) {
    var i, j;
    for (i = 0; i < A.length; i++) {
      var a1 = A[i], a2 = A[(i + 1) % A.length];
      for (j = 0; j < B.length; j++) {
        var b1 = B[j], b2 = B[(j + 1) % B.length];
        if (segsCross(a1[0], a1[1], a2[0], a2[1],
                      b1[0] + dx, b1[1], b2[0] + dx, b2[1])) return 0;
      }
    }
    if (pointInPolyX(A[0][0], A[0][1], B, dx) ||
        pointInPolyX(B[0][0] + dx, B[0][1], A, 0)) return 0;

    var best = Infinity;
    for (i = 0; i < A.length; i++) {
      var p = A[i];
      for (j = 0; j < B.length; j++) {
        var q1 = B[j], q2 = B[(j + 1) % B.length];
        var d = pointSegDist2(p[0], p[1], q1[0] + dx, q1[1], q2[0] + dx, q2[1]);
        if (d < best) best = d;
      }
    }
    for (i = 0; i < B.length; i++) {
      var pb = B[i];
      for (j = 0; j < A.length; j++) {
        var r1 = A[j], r2 = A[(j + 1) % A.length];
        var d2 = pointSegDist2(pb[0] + dx, pb[1], r1[0], r1[1], r2[0], r2[1]);
        if (d2 < best) best = d2;
      }
    }
    return Math.sqrt(best);
  }

  // 检查一整排交替摆放（A, B, A, B…）的所有相邻关系是否都满足间距
  // 返回最小距离；不满足时返回 null
  function rowClearance(opt, pitch, gap) {
    var w = opt.w;
    var dmax = Math.floor((w + gap) / pitch) + 1;
    var min = Infinity;
    for (var d = 1; d <= dmax; d++) {
      var off = d * pitch;
      if (off - w >= gap - 1e-9) break;   // 包围盒已拉开，形状不可能更近
      var c1, c2;
      if (d % 2 === 1) {
        c1 = polyClearance(opt.ptsA, opt.ptsB, off);
        if (c1 < gap) return null;
        c2 = polyClearance(opt.ptsB, opt.ptsA, off);
        if (c2 < gap) return null;
      } else {
        c1 = polyClearance(opt.ptsA, opt.ptsA, off);
        if (c1 < gap) return null;
        c2 = polyClearance(opt.ptsB, opt.ptsB, off);
        if (c2 < gap) return null;
      }
      if (c1 < min) min = c1;
      if (c2 < min) min = c2;
    }
    return min === Infinity ? gap : min;
  }

  // 在栅格估计值附近寻找满足间距要求的精确排距
  function exactPitch(opt, gap) {
    var pR = computePitch(opt, gap);
    var lo = Math.max(2, pR - 8);
    var hi = Math.min(opt.w, pR + 24);
    for (var p = lo; p <= hi + 1e-9; p += 0.5) {
      var clr = rowClearance(opt, p, gap);
      if (clr === null) continue;
      return { pitch: p, clearance: clr };
    }
    return null;
  }

  /* ---------- 排样方案 ---------- */

  function arrangements(poly, width, gap, allowInterlock, fixedRot) {
    var fixed = (typeof fixedRot === 'number' && isFinite(fixedRot)) ? fixedRot : null;
    var key = width + '|' + gap + '|' + (allowInterlock ? 1 : 0) + '|' + (fixed === null ? 'auto' : fixed);
    if (poly._arr && poly._arr.key === key) return poly._arr.options;

    var options = [];
    var angles = fixed === null ? [0, 90] : [fixed];
    angles.forEach(function (userDeg) {
      // 调整角度为顺时针；数学坐标逆时针为正，故取负
      var a = rotate(poly.pts, poly.w, poly.h, -userDeg);
      var b = rotate(a.pts, a.w, a.h, 180);
      var opt = {
        rot: userDeg,
        w: a.w, h: a.h,
        ptsA: a.pts,
        ptsB: b.pts,
        interlock: false,
        pitch: a.w + gap,
        clearance: gap,
        rowH: a.h
      };
      var perPlain = Math.floor((width + gap) / (opt.w + gap));
      if (perPlain >= 1) {
        opt.perRow = perPlain;
        options.push(opt);
      }
      if (allowInterlock && opt.w >= 10) {
        var res = exactPitch(opt, gap);
        if (res && res.pitch < opt.w - 0.01) {
          var perInt = Math.floor((width - opt.w) / res.pitch) + 1;
          if (perInt > perPlain) {
            options.push({
              rot: userDeg,
              w: opt.w, h: opt.h,
              ptsA: opt.ptsA, ptsB: opt.ptsB,
              interlock: true,
              pitch: res.pitch,
              clearance: res.clearance,
              rowH: opt.h,
              perRow: perInt
            });
          }
        }
      }
    });

    poly._arr = { key: key, options: options };
    return options;
  }

  function chooseOption(poly, count, width, gap, allowInterlock, fixedRot) {
    var opts = arrangements(poly, width, gap, allowInterlock, fixedRot);
    var best = null;
    for (var i = 0; i < opts.length; i++) {
      var o = opts[i];
      var rows = Math.ceil(count / o.perRow);
      var len = rows * o.rowH + (rows - 1) * gap;
      if (!best || len < best.length - 1e-9) {
        best = {
          rot: o.rot, w: o.w, h: o.h, ptsA: o.ptsA, ptsB: o.ptsB,
          interlock: o.interlock, pitch: o.pitch, rowH: o.rowH,
          clearance: o.clearance === undefined ? gap : o.clearance,
          perRow: o.perRow, rows: rows, length: len
        };
      }
    }
    return best;
  }

  /* ---------- 主计算 ---------- */

  function computePlan(cfg) {
    var parts = cfg.parts, sizes = cfg.sizes;
    var width = cfg.width, rollLength = cfg.rollLength;
    var gap = Math.max(2, Number(cfg.gap) || 0);   // 工业裁剪：片间距不少于 2mm
    var pairFactor = cfg.pairFactor, allowInterlock = cfg.allowInterlock;

    var groups = [];
    var warnings = [];
    var totalPieces = 0, totalArea = 0;
    var minClearance = gap;

    parts.forEach(function (part) {
      if (!part.qty || part.qty <= 0) return;
      for (var si = 0; si < sizes.length; si++) {
        var pairs = sizes[si].pairs || 0;
        if (pairs <= 0) continue;
        var poly = part.sizes[si];
        if (!poly) continue;
        var count = Math.round(pairs * part.qty * pairFactor);
        if (count <= 0) continue;

        if (poly.w > width && poly.h > width) {
          warnings.push('「' + part.name + '」' + sizes[si].label + '码外形 ' + poly.w.toFixed(0) +
            '×' + poly.h.toFixed(0) + 'mm，超过可用幅宽 ' + width + 'mm，无法排料。');
          continue;
        }

        var fixedRot = (typeof part.rot === 'number' && isFinite(part.rot)) ? part.rot : null;
        var opt = chooseOption(poly, count, width, gap, allowInterlock, fixedRot);
        if (!opt) {
          warnings.push('「' + part.name + '」' + sizes[si].label + '码尺寸超出幅宽，无法排料。');
          continue;
        }

        groups.push({
          partIndex: part.index,
          partName: part.name,
          color: part.color,
          sizeIndex: si,
          sizeLabel: sizes[si].label,
          count: count,
          rows: opt.rows,
          perRow: opt.perRow,
          rowH: opt.rowH,
          pitch: opt.pitch,
          interlock: opt.interlock,
          clearance: opt.clearance,
          rot: opt.rot,
          fixedRot: fixedRot,
          w: opt.w,
          h: opt.h,
          ptsA: opt.ptsA,
          ptsB: opt.ptsB,
          length: opt.length,
          area: poly.area,
          areaTotal: poly.area * count
        });
        totalPieces += count;
        totalArea += poly.area * count;
        if (opt.clearance < minClearance) minClearance = opt.clearance;
      }
    });

    // 沿布长依次排入卷材
    var roll = 1;
    var cursor = 0;
    var segments = [];
    var netLength = 0;
    var rollWaste = 0;

    for (var gi = 0; gi < groups.length; gi++) {
      var g = groups[gi];
      var remaining = g.rows;
      var rowOffset = 0;

      while (remaining > 0) {
        var avail = rollLength - cursor;
        var fit = Math.floor((avail + gap) / (g.rowH + gap));
        if (fit <= 0) {
          if (cursor === 0) {
            // 单排高于一卷：仍放置，提示
            segments.push({ group: g, start: 0, rows: 1, rowOffset: 0, roll: roll });
            netLength += g.rowH + (netLength > 0 ? gap : 0);
            cursor = g.rowH;
            remaining -= 1;
            rowOffset += 1;
            warnings.push('「' + g.partName + '」' + g.sizeLabel + '码单排高度超过每卷长度。');
            continue;
          }
          rollWaste += Math.max(0, avail);
          roll++;
          cursor = 0;
          continue;
        }

        var take = Math.min(remaining, fit);
        var segLen = take * g.rowH + (take - 1) * gap;
        segments.push({ group: g, start: cursor, rows: take, rowOffset: rowOffset, roll: roll });
        netLength += segLen + (netLength > 0 ? gap : 0);
        cursor += segLen;
        remaining -= take;
        rowOffset += take;

        if (remaining > 0) {
          rollWaste += Math.max(0, rollLength - cursor);
          roll++;
          cursor = 0;
        }
      }

      if (gi < groups.length - 1) cursor += gap;
    }

    var rollCount = segments.length ? roll : 0;
    var purchased = rollCount * rollLength;
    var utilization = netLength > 0 ? totalArea / (width * netLength) : 0;
    var utilizationRoll = purchased > 0 ? totalArea / (width * purchased) : 0;

    // 尺码 / 部件汇总
    var bySize = sizes.map(function (s, i) {
      return { index: i, label: s.label, pairs: s.pairs || 0, pieces: 0, area: 0, length: 0 };
    });
    var byPart = parts.map(function (p, i) {
      return { index: i, name: p.name, color: p.color, qty: p.qty, pieces: 0, area: 0, length: 0 };
    });
    groups.forEach(function (g) {
      var s = bySize[g.sizeIndex];
      if (s) { s.pieces += g.count; s.area += g.areaTotal; s.length += g.length; }
      var p = byPart[g.partIndex];
      if (p) { p.pieces += g.count; p.area += g.areaTotal; p.length += g.length; }
    });

    return {
      groups: groups,
      segments: segments,
      warnings: warnings,
      totalPieces: totalPieces,
      totalArea: totalArea,
      netLength: netLength,
      rollCount: rollCount,
      purchasedLength: purchased,
      rollWaste: rollWaste,
      utilization: utilization,
      utilizationRoll: utilizationRoll,
      gap: gap,
      minClearance: minClearance,
      bySize: bySize,
      byPart: byPart
    };
  }

  global.Nesting = {
    computePlan: computePlan,
    arrangements: arrangements,
    rotateShape: rotate
  };
})(window);
