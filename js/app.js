(function () {
  'use strict';

  // 旧版浏览器没有 roundRect，补一个简单实现
  if (typeof CanvasRenderingContext2D !== 'undefined' &&
      !CanvasRenderingContext2D.prototype.roundRect) {
    CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h, r) {
      var rr = Math.min(typeof r === 'number' ? r : 0, w / 2, h / 2);
      this.moveTo(x + rr, y);
      this.arcTo(x + w, y, x + w, y + h, rr);
      this.arcTo(x + w, y + h, x, y + h, rr);
      this.arcTo(x, y + h, x, y, rr);
      this.arcTo(x, y, x + w, y, rr);
      this.closePath();
    };
  }

  var EDGE_TRIM_MM = 15;        // 布边每边扣除的宽度
  var WIDTH_MIN = 1350;         // 坯布幅宽 1.35m
  var WIDTH_MAX = 1400;         // 坯布幅宽 1.40m
  var WIDTH_DEFAULT = 1400;     // 默认 1.40m
  var ROLL_MM = 45000;          // 每份料长 45 m
  var STORE_KEY = 'shoe-material-calc-v1';
  var STORE_VERSION = 2;        // 2：默认幅宽改为 1.40m

  var COLORS = [
    '#3b6fe0', '#e18a34', '#2f9e74', '#d0576b', '#7b64c9',
    '#2693a8', '#b07a2c', '#6d8f3a', '#c464a0', '#5c6b7a'
  ];

  var state = {
    dataset: { source: '', builtin: true, warnings: [] },
    sizes: [],
    parts: [],
    gap: 3,
    width: WIDTH_DEFAULT,
    pairFactor: 1,
    interlock: true,
    startSize: 31
  };

  function usableWidth() {
    return state.width - EDGE_TRIM_MM * 2;
  }

  var plan = null;
  var conservativePlan = null;
  var recalcTimer = null;
  var viz = null;

  /* ================= 工具 ================= */

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  function round1(v) { return Math.round(v * 10) / 10; }

  function fmtInt(n) { return Math.round(n).toLocaleString('zh-CN'); }
  function fmt1(n) { return Number(n).toLocaleString('zh-CN', { minimumFractionDigits: 1, maximumFractionDigits: 1 }); }
  function fmt2(n) { return Number(n).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function fmtM(mm) { return fmt1(mm / 1000); }
  function fmtPct(v) { return (v * 100).toFixed(1) + '%'; }

  function hexA(hex, alpha) {
    var h = hex.replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var r = parseInt(h.slice(0, 2), 16);
    var g = parseInt(h.slice(2, 4), 16);
    var b = parseInt(h.slice(4, 6), 16);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function showError(msg) {
    var el = $('#errorBanner');
    el.textContent = msg;
    el.hidden = false;
  }

  function clearError() {
    var el = $('#errorBanner');
    el.textContent = '';
    el.hidden = true;
  }

  var toastTimer = null;
  function toast(msg, kind) {
    var el = $('#toast');
    el.textContent = msg;
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, 3800);
  }

  /* ================= 数据装载 ================= */

  function normalizePoly(p) {
    var pts = p.pts;
    var w = p.w, h = p.h;
    if (!w || !h) {
      var b = DXF.bboxOf(pts);
      w = b[2] - b[0];
      h = b[3] - b[1];
    }
    return { pts: pts, area: p.area, w: round1(w), h: round1(h) };
  }

  function buildDataset(ds) {
    state.dataset = {
      source: ds.source,
      builtin: !!ds.builtin,
      warnings: ds.warnings || []
    };
    clearError();
    state.sizes = ds.labels.map(function (label) {
      return { label: String(label), pairs: 0, graded: false };
    });
    state.parts = ds.parts.map(function (p, i) {
      return {
        index: i,
        name: p.name || ('配件' + String(i + 1).padStart(2, '0')),
        qty: 1,
        color: COLORS[i % COLORS.length],
        sizes: p.sizes.map(normalizePoly)
      };
    });
    state.startSize = Number(ds.labels[0]) || 31;

    renderSizeTable();
    renderPartsTable();
    updateSourceInfo();
    syncControls();

    if (plan) { viz && viz.resetView(); }
  }

  function loadSample(silent) {
    var d = window.SAMPLE_DATA;
    if (!d) {
      showError('缺少 data/parts.js，无法载入示例数据。');
      return;
    }
    buildDataset({
      source: d.source,
      builtin: true,
      labels: d.sizeLabels.slice(),
      parts: d.parts,
      warnings: d.warnings || []
    });
    if (!silent) toast('已恢复示例数据');
  }

  /* ================= 订单表 ================= */

  function renderSizeTable() {
    var tbody = $('#sizeTbody');
    tbody.innerHTML = state.sizes.map(function (s, i) {
      return '<div class="sg-row" data-size-row="' + i + '">' +
        '<span class="sg-size">' +
          '<input class="cell-input size-label" data-size-label="' + i + '" value="' +
            escapeHtml(s.label) + '" aria-label="尺码">' +
          (s.graded ? '<i class="graded-dot" title="按相邻尺码比例推算"></i>' : '') +
        '</span>' +
        '<span><input class="cell-input pairs" type="number" min="0" step="100" data-size-pairs="' + i +
          '" value="' + (s.pairs || 0) + '" aria-label="数量"></span>' +
        '<span class="comp m-pieces" data-size-pieces="' + i + '">—</span>' +
        '<span class="comp dim m-meters" data-size-meters="' + i + '">—</span>' +
        '<span><button class="icon-btn" data-del-size="' + i + '" title="删除该尺码">×</button></span>' +
        '</div>';
    }).join('');

    var delBtns = $$('[data-del-size]', tbody);
    delBtns.forEach(function (btn) {
      btn.addEventListener('click', function () {
        removeSize(Number(btn.getAttribute('data-del-size')));
      });
    });
  }

  function removeSize(i) {
    if (state.sizes.length <= 1) { toast('至少保留一个尺码', 'error'); return; }
    state.sizes.splice(i, 1);
    state.parts.forEach(function (p) { p.sizes.splice(i, 1); });
    renderSizeTable();
    updateSourceInfo();
    recalc();
    saveSettings();
    toast('已删除尺码');
  }

  function addSize() {
    if (state.sizes.length >= 24) { toast('尺码过多', 'error'); return; }
    var n = state.sizes.length;
    var last = n - 1;
    var prev = Math.max(0, n - 2);

    state.parts.forEach(function (p) {
      var a = p.sizes[last];
      var b = p.sizes[prev] || a;
      if (!a) return;
      var sx = b.w > 0 ? a.w / b.w : 1.025;
      var sy = b.h > 0 ? a.h / b.h : 1.025;
      sx = clamp(sx, 1.0, 1.07);
      sy = clamp(sy, 1.0, 1.07);
      p.sizes.push(scalePoly(a, sx, sy));
    });

    var lastLabel = state.sizes[last].label;
    var num = Number(lastLabel);
    var label = isFinite(num) && lastLabel !== '' ? String(num + 1) : '新码';
    state.sizes.push({ label: label, pairs: 0, graded: true });

    renderSizeTable();
    updateSourceInfo();
    recalc();
    saveSettings();
    toast('已添加尺码 ' + label + '（按上一码比例推算）');
  }

  function scalePoly(poly, sx, sy) {
    var pts = poly.pts.map(function (p) {
      return [round1(p[0] * sx), round1(p[1] * sy)];
    });
    return {
      pts: pts,
      w: round1(poly.w * sx),
      h: round1(poly.h * sy),
      area: round1(poly.area * sx * sy)
    };
  }

  /* ================= 配件表 ================= */

  function thumbSvg(poly, color) {
    var size = 42, pad = 3;
    var s = Math.min((size - pad * 2) / Math.max(poly.w, 0.1), (size - pad * 2) / Math.max(poly.h, 0.1));
    var dx = (size - poly.w * s) / 2;
    var dy = (size - poly.h * s) / 2;
    var pts = poly.pts.map(function (p) {
      return round1(dx + p[0] * s) + ',' + round1(size - dy - p[1] * s);
    }).join(' ');
    return '<svg viewBox="0 0 ' + size + ' ' + size + '" width="' + size + '" height="' + size + '">' +
      '<polygon points="' + pts + '" fill="' + hexA(color, .18) + '" stroke="' + color +
      '" stroke-width="1.1" stroke-linejoin="round"/></svg>';
  }

  function renderPartsTable() {
    var tbody = $('#partsTbody');
    tbody.innerHTML = state.parts.map(function (p, i) {
      var big = p.sizes[p.sizes.length - 1] || p.sizes[0];
      return '<tr data-part-row="' + i + '">' +
        '<td class="thumb-cell"><div class="thumb">' + thumbSvg(big, p.color) + '</div></td>' +
        '<td><input class="part-name-input" data-part-name="' + i + '" value="' + escapeHtml(p.name) +
          '" aria-label="配件名称"></td>' +
        '<td class="num"><div class="stepper">' +
          '<button data-step="-1" data-part-step="' + i + '" aria-label="减少">−</button>' +
          '<span class="qty" data-part-qty="' + i + '">' + p.qty + '</span>' +
          '<button data-step="1" data-part-step="' + i + '" aria-label="增加">+</button>' +
        '</div></td>' +
        '<td class="num m-part-pieces" data-part-pieces="' + i + '">—</td>' +
        '<td class="num m-part-unit" data-part-unit="' + i + '">—</td>' +
        '<td class="num m-part-area" data-part-area="' + i + '">—</td>' +
        '<td class="num m-part-len" data-part-len="' + i + '">—</td>' +
        '<td class="num m-part-util" data-part-util="' + i + '">—</td>' +
        '</tr>';
    }).join('');

    $$('[data-part-step]', tbody).forEach(function (btn) {
      btn.addEventListener('click', function () {
        var i = Number(btn.getAttribute('data-part-step'));
        var step = Number(btn.getAttribute('data-step'));
        var p = state.parts[i];
        p.qty = clamp((p.qty || 0) + step, 0, 99);
        $('[data-part-qty="' + i + '"]').textContent = p.qty;
        recalc();
        saveSettings();
      });
    });
  }

  /* ================= 数据源 ================= */

  function updateSourceInfo() {
    var d = state.dataset;
    var box = $('#sourceInfo');
    box.innerHTML =
      '<div class="source-file"><strong>' + escapeHtml(d.source) + '</strong></div>' +
      '<div class="source-meta">' + state.parts.length + ' 个配件 · ' + state.sizes.length +
      ' 个尺码 · 坯布 ' + (state.width / 1000).toFixed(2) + ' m / 有效 ' + usableWidth() +
      ' mm' + (d.builtin ? ' · 内置示例' : ' · 已导入') + '</div>';
    var badge = $('#sourceBadge');
    badge.textContent = d.builtin ? '示例：' + d.source : '导入：' + d.source;
  }

  function syncControls() {
    $('#gapInput').value = state.gap;
    $('#widthInput').value = String(state.width);
    $('#widthHint').textContent = '布边每边扣 ' + EDGE_TRIM_MM + ' mm，有效幅宽 ' + usableWidth() + ' mm';
    $('#usableSpec').textContent = usableWidth();
    $('#rollSpec').textContent = (state.width / 1000).toFixed(2) + ' m × 45 m';
    $('#interlockInput').checked = state.interlock;
    $('#startSize').value = state.startSize;
    $$('#pairFactor button').forEach(function (b) {
      b.classList.toggle('active', Number(b.getAttribute('data-v')) === state.pairFactor);
    });
  }

  /* ================= 计算 ================= */

  function scheduleRecalc() {
    clearTimeout(recalcTimer);
    recalcTimer = setTimeout(recalc, 120);
  }

  function recalc() {
    if (!state.parts.length) return;
    var cfg = {
      parts: state.parts,
      sizes: state.sizes,
      width: usableWidth(),
      gap: state.gap,
      rollLength: ROLL_MM,
      pairFactor: state.pairFactor,
      allowInterlock: state.interlock
    };
    plan = Nesting.computePlan(cfg);
    conservativePlan = state.interlock
      ? Nesting.computePlan(Object.assign({}, cfg, { allowInterlock: false }))
      : plan;

    updateKpis();
    updateRangeStrip();
    updateWarnings();
    updateSizeCells();
    updatePartCells();
    updateSizeSummary();
    updateLegend();
    var hint = $('#vizHint');
    if (hint) {
      hint.innerHTML = '已按精确几何校验：任意两片间距 ≥ <b>' + fmt1(plan.gap) +
        ' mm</b>，无重叠。滚轮上下滚动 · 拖动平移 · 右侧缩略条可点击跳转。虚线为每份料（45 m）的分界，灰色为卷尾余料。';
    }
    if (viz) viz.setPlan(plan);
  }

  function updateKpis() {
    var totalPairs = state.sizes.reduce(function (a, s) { return a + (s.pairs || 0); }, 0);
    var areaM2 = plan.totalArea / 1e6;
    var lowLen = plan.totalArea / usableWidth();
    var box = $('#kpis');
    box.innerHTML =
      '<div class="kpi">' +
        '<div class="k-label">总片数</div>' +
        '<div class="k-value">' + fmtInt(plan.totalPieces) + '<small>片</small></div>' +
        '<div class="k-sub">' + fmtInt(totalPairs) + ' 双 · ' + state.parts.length + ' 个配件</div>' +
      '</div>' +
      '<div class="kpi accent">' +
        '<div class="k-label">预计排料长度</div>' +
        '<div class="k-value">' + fmtM(plan.netLength) + '<small>m</small></div>' +
        '<div class="k-sub">面积法下限 ' + fmtM(lowLen) + ' m</div>' +
      '</div>' +
      '<div class="kpi">' +
        '<div class="k-label">份数（45 m / 份）</div>' +
        '<div class="k-value">' + fmtInt(plan.rollCount) + '<small>份</small></div>' +
        '<div class="k-sub">备料 ' + fmtM(plan.purchasedLength) + ' m</div>' +
      '</div>' +
      '<div class="kpi">' +
        '<div class="k-label">排料利用率</div>' +
        '<div class="k-value">' + (plan.netLength ? (plan.utilization * 100).toFixed(1) : '0.0') + '<small>%</small></div>' +
        '<div class="k-sub">裁片面积 ' + fmt1(areaM2) + ' m²</div>' +
      '</div>';
  }

  function updateRangeStrip() {
    var low = plan.totalArea / usableWidth();
    var est = plan.netLength;
    var cons = conservativePlan.netLength;
    var lo = Math.min(est, cons), hi = Math.max(est, cons);
    var parts = [];
    parts.push('<span><span class="rs-label">面积法下限</span> <b>' + fmtM(low) + ' m</b></span>');
    parts.push('<span class="sep"></span>');
    parts.push('<span><span class="rs-label">估算区间</span> <b>' +
      (hi - lo < 0.1 ? fmtM(lo) + ' m' : fmtM(lo) + ' – ' + fmtM(hi) + ' m') + '</b></span>');
    parts.push('<span class="sep"></span>');
    parts.push('<span><span class="rs-label">预计用料</span> <b>' + fmtM(est) + ' m</b> · ' +
      fmtInt(plan.rollCount) + ' 份</span>');
    if (plan.rollCount) {
      parts.push('<span class="sep"></span>');
      parts.push('<span><span class="rs-label">卷尾余料</span> <b>' +
        fmtM(Math.max(0, plan.purchasedLength - plan.netLength)) + ' m</b></span>');
    }
    parts.push('<span class="rs-note">' + (state.interlock
      ? '区间 = 交错套排 ~ 直排保守；实际以排版软件为准'
      : '当前按直排保守计算；开启交错套排可省料') + '</span>');
    $('#rangeStrip').innerHTML = parts.join('');
  }

  function updateWarnings() {
    var box = $('#warnBox');
    var list = (state.dataset.warnings || []).concat(plan.warnings || []);
    if (!list.length) { box.hidden = true; box.textContent = ''; return; }
    box.hidden = false;
    box.textContent = '提示：' + list.join('；');
  }

  function updateSizeCells() {
    state.sizes.forEach(function (s, i) {
      var row = plan.bySize[i];
      var pieces = $('[data-size-pieces="' + i + '"]');
      var meters = $('[data-size-meters="' + i + '"]');
      if (pieces) pieces.textContent = row && row.pieces ? fmtInt(row.pieces) : '—';
      if (meters) meters.textContent = row && row.length ? fmtM(row.length) : '—';
    });
  }

  function updatePartCells() {
    state.parts.forEach(function (p, i) {
      var row = plan.byPart[i];
      var pieces = $('[data-part-pieces="' + i + '"]');
      var unit = $('[data-part-unit="' + i + '"]');
      var area = $('[data-part-area="' + i + '"]');
      var len = $('[data-part-len="' + i + '"]');
      var util = $('[data-part-util="' + i + '"]');
      if (!row || !row.pieces) {
        [pieces, unit, area, len, util].forEach(function (el) { if (el) el.textContent = '—'; });
        return;
      }
      var avgArea = p.sizes.reduce(function (a, s) { return a + s.area; }, 0) / Math.max(1, p.sizes.length);
      if (pieces) pieces.textContent = fmtInt(row.pieces);
      if (unit) unit.textContent = fmtInt(avgArea / 100) + ' cm²';
      if (area) area.textContent = fmt2(row.area / 1e6) + ' m²';
      if (len) len.textContent = fmtM(row.length) + ' m';
      if (util) util.textContent = row.length ? fmtPct(row.area / (usableWidth() * row.length)) : '—';
    });
  }

  function updateLegend() {
    var box = $('#legend');
    box.innerHTML = state.parts.map(function (p) {
      return '<span class="item" data-legend="' + p.index + '"><span class="dot" style="background:' +
        p.color + '"></span>' + escapeHtml(p.name) + '</span>';
    }).join('');
    $$('#legend .item').forEach(function (el) {
      el.style.cursor = 'pointer';
      el.addEventListener('click', function () {
        viz.focusPart(Number(el.getAttribute('data-legend')));
      });
    });
  }

  function updateSizeSummary() {
    var tbody = $('#sizeSummary tbody');
    if (!tbody) return;
    var totalLen = plan.netLength || 1;
    var rows = state.sizes.map(function (s, i) {
      var r = plan.bySize[i];
      if (!r || (!r.pairs && !r.pieces)) return '';
      return '<tr>' +
        '<td><strong>' + escapeHtml(s.label) + '</strong>' + (s.graded ? '<span class="graded-dot"></span>' : '') + '</td>' +
        '<td class="num">' + fmtInt(r.pairs) + '</td>' +
        '<td class="num">' + fmtInt(r.pieces) + '</td>' +
        '<td class="num">' + fmt2(r.area / 1e6) + '</td>' +
        '<td class="num">' + fmtM(r.length) + '</td>' +
        '<td class="num">' + fmtPct(r.length / totalLen) + '</td>' +
        '</tr>';
    }).join('');

    if (!rows) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty-row">填写每个尺码的数量后，这里会按尺码汇总用料。</td></tr>';
      return;
    }
    tbody.innerHTML = rows +
      '<tr class="total-row"><td>合计</td>' +
      '<td class="num">' + fmtInt(state.sizes.reduce(function (a, s) { return a + (s.pairs || 0); }, 0)) + '</td>' +
      '<td class="num">' + fmtInt(plan.totalPieces) + '</td>' +
      '<td class="num">' + fmt2(plan.totalArea / 1e6) + '</td>' +
      '<td class="num">' + fmtM(plan.netLength) + '</td>' +
      '<td class="num">100.0%</td></tr>';
  }

  /* ================= 可视化 ================= */

  function createViz() {
    var canvas = $('#vizCanvas');
    var ctx = canvas.getContext('2d');
    var obj = {
      canvas: canvas,
      ctx: ctx,
      W: 0, H: 0,
      view: { y: 0, zoom: 1, panX: 0 },
      plan: null,
      geo: null,
      drag: null,
      mapDrag: false,

      init: function () {
        var self = this;
        this.resize();
        if (window.ResizeObserver) {
          new ResizeObserver(function () { self.resize(); }).observe(canvas.parentElement);
        } else {
          window.addEventListener('resize', function () { self.resize(); });
        }

        canvas.addEventListener('wheel', function (e) {
          e.preventDefault();
          if (!self.geo) return;
          if (e.ctrlKey || e.metaKey) {
            self.setZoom(self.view.zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12));
          } else if (e.shiftKey) {
            self.view.panX = clamp(self.view.panX + e.deltaY / self.geo.s, 0, self.geo.maxPanX);
            self.draw();
          } else {
            self.view.y = clamp(self.view.y + e.deltaY / self.geo.s, 0,
              Math.max(0, self.geo.total - self.geo.visH));
            self.draw();
          }
        }, { passive: false });

        canvas.addEventListener('pointerdown', function (e) {
          if (!self.geo) return;
          canvas.setPointerCapture(e.pointerId);
          var rect = canvas.getBoundingClientRect();
          var x = e.clientX - rect.left;
          var y = e.clientY - rect.top;
          self.drag = { x: x, y: y, moved: false };
          self.mapDrag = x > self.W - self.geo.padR + 6;
          if (self.mapDrag) self.jumpFromMap(y);
          else canvas.classList.add('dragging');
        });

        canvas.addEventListener('pointermove', function (e) {
          if (!self.drag || !self.geo) return;
          var rect = canvas.getBoundingClientRect();
          var x = e.clientX - rect.left;
          var y = e.clientY - rect.top;
          if (self.mapDrag) { self.jumpFromMap(y); return; }
          var dx = x - self.drag.x, dy = y - self.drag.y;
          if (Math.abs(dx) + Math.abs(dy) > 2) self.drag.moved = true;
          self.view.y = clamp(self.view.y - dy / self.geo.s, 0, Math.max(0, self.geo.total - self.geo.visH));
          self.view.panX = clamp(self.view.panX - dx / self.geo.s, 0, self.geo.maxPanX);
          self.drag.x = x;
          self.drag.y = y;
          self.draw();
        });

        function endDrag() {
          self.drag = null;
          self.mapDrag = false;
          canvas.classList.remove('dragging');
        }
        canvas.addEventListener('pointerup', endDrag);
        canvas.addEventListener('pointercancel', endDrag);
        canvas.addEventListener('dblclick', function () { self.resetView(); });

        $('#zoomInput').addEventListener('input', function (e) {
          obj.setZoom(Number(e.target.value));
        });
        $('#btnFit').addEventListener('click', function () { obj.fitWidth(); });
      },

      resize: function () {
        var rect = this.canvas.getBoundingClientRect();
        if (rect.width < 10) return;
        var dpr = Math.min(2, window.devicePixelRatio || 1);
        this.canvas.width = Math.round(rect.width * dpr);
        this.canvas.height = Math.round(rect.height * dpr);
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        this.W = rect.width;
        this.H = rect.height;
        this.draw();
      },

      setPlan: function (p) {
        this.plan = p;
        this.resize();
      },

      resetView: function () {
        this.view.y = 0;
        this.view.zoom = 1;
        this.view.panX = 0;
        $('#zoomInput').value = 1;
        this.draw();
      },

      fitWidth: function () {
        this.view.zoom = 1;
        this.view.panX = 0;
        $('#zoomInput').value = 1;
        this.draw();
      },

      setZoom: function (z) {
        z = clamp(z, 1, 8);
        var geo = this.geo;
        if (geo) {
          var center = this.view.y + geo.visH / 2;
          this.view.zoom = z;
          this.draw();
          var visH = (this.geo.vh / this.geo.s);
          this.view.y = clamp(center - visH / 2, 0, Math.max(0, this.geo.total - visH));
        } else {
          this.view.zoom = z;
        }
        $('#zoomInput').value = z;
        this.draw();
      },

      jumpFromMap: function (y) {
        var geo = this.geo;
        if (!geo) return;
        var ratio = (y - geo.padT) / geo.vh;
        this.view.y = clamp(ratio * geo.total - geo.visH / 2, 0, Math.max(0, geo.total - geo.visH));
        this.draw();
      },

      focusPart: function (partIndex) {
        var p = this.plan;
        if (!p || !this.geo) return;
        for (var i = 0; i < p.segments.length; i++) {
          var seg = p.segments[i];
          if (seg.group.partIndex !== partIndex) continue;
          var gStart = (seg.roll - 1) * ROLL_MM + seg.start;
          if (this.view.zoom < 1.6) this.setZoom(1.6);
          this.view.y = Math.max(0, gStart - 60);
          this.draw();
          toast('定位到「' + seg.group.partName + '」');
          return;
        }
        toast('该配件当前没有排料（用量或数量为 0）', 'error');
      },

      draw: function () {
        var ctx = this.ctx;
        if (!ctx || !this.W) return;
        var W = this.W, H = this.H;
        ctx.clearRect(0, 0, W, H);

        var padL = 56, padR = 86, padT = 10, padB = 22;
        var vw = Math.max(60, W - padL - padR);
        var vh = Math.max(60, H - padT - padB);
        var p = this.plan;

        ctx.font = '12px "Segoe UI", "Microsoft YaHei", sans-serif';

        if (!p || !p.groups.length) {
          ctx.fillStyle = '#98a1b0';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.font = '13px "Segoe UI", "Microsoft YaHei", sans-serif';
          ctx.fillText('填写订单数量后显示排料图', W / 2, H / 2);
          this.geo = null;
          return;
        }

        var stripW = usableWidth();
        var total = Math.max(1, p.rollCount * ROLL_MM);
        var s = (vw / stripW) * this.view.zoom;
        var visW = vw / s, visH = vh / s;
        var maxPanX = Math.max(0, stripW - visW);
        this.view.panX = clamp(this.view.panX, 0, maxPanX);
        this.view.y = clamp(this.view.y, 0, Math.max(0, total - visH));

        var px = function (mm) { return padL + (mm - this.view.panX) * s; }.bind(this);
        var py = function (mm) { return padT + (mm - this.view.y) * s; }.bind(this);

        this.geo = {
          padL: padL, padT: padT, padR: padR, vw: vw, vh: vh,
          s: s, visW: visW, visH: visH, total: total, maxPanX: maxPanX
        };

        // 卷面
        ctx.save();
        ctx.beginPath();
        ctx.rect(padL, padT, vw, vh);
        ctx.clip();

        ctx.fillStyle = '#ffffff';
        ctx.fillRect(px(0), py(0), stripW * s, total * s);
        ctx.strokeStyle = '#dde2ea';
        ctx.lineWidth = 1;
        ctx.strokeRect(px(0) + .5, py(0) + .5, stripW * s - 1, total * s - 1);

        // 每卷已用终点
        var rollEnd = new Array(p.rollCount + 2).fill(0);
        p.segments.forEach(function (seg) {
          var end = seg.start + seg.rows * seg.group.rowH + (seg.rows - 1) * state.gap;
          if (end > rollEnd[seg.roll]) rollEnd[seg.roll] = end;
        });

        for (var r = 1; r <= p.rollCount; r++) {
          var tailStart = (r - 1) * ROLL_MM + rollEnd[r];
          var tailEnd = r * ROLL_MM;
          var y0 = py(tailStart), y1 = py(tailEnd);
          if (y1 > padT && y0 < padT + vh) {
            ctx.fillStyle = '#f2f4f8';
            ctx.fillRect(px(0), y0, stripW * s, Math.max(0, y1 - y0));
            if (y1 - y0 > 26) {
              ctx.fillStyle = '#aab2c0';
              ctx.textAlign = 'center';
              ctx.textBaseline = 'middle';
              ctx.fillText('卷尾余料 ' + fmt1((tailEnd - tailStart) / 1000) + ' m',
                px(stripW / 2), (y0 + y1) / 2);
            }
          }
        }

        // 裁片
        var gap = state.gap;
        var drawn = 0;
        for (var si = 0; si < p.segments.length; si++) {
          var seg = p.segments[si];
          var g = seg.group;
          var gStart = (seg.roll - 1) * ROLL_MM + seg.start;
          var segLen = seg.rows * g.rowH + (seg.rows - 1) * gap;
          if (gStart > this.view.y + visH + 10) continue;
          if (gStart + segLen < this.view.y - 10) continue;

          for (var i = 0; i < seg.rows; i++) {
            var top = gStart + i * (g.rowH + gap);
            if (top + g.rowH < this.view.y - 2) continue;
            if (top > this.view.y + visH + 2) break;
            var rowIdx = seg.rowOffset + i;
            var n = Math.min(g.perRow, g.count - rowIdx * g.perRow);
            if (n <= 0) continue;

            var yTop = py(top);
            var hPx = Math.max(0.6, g.rowH * s);
            var tooMany = n > 140 || g.w * s < 1.4;

            if (tooMany) {
              var xa = px(0);
              var xb = px((n - 1) * g.pitch + g.w);
              ctx.fillStyle = hexA(g.color, .26);
              ctx.fillRect(xa, yTop, Math.max(0.8, xb - xa), hPx);
            } else {
              for (var k = 0; k < n; k++) {
                var pts = (g.interlock && (k & 1)) ? g.ptsB : g.ptsA;
                var ox = k * g.pitch;
                ctx.beginPath();
                for (var j = 0; j < pts.length; j++) {
                  var X = px(ox + pts[j][0]);
                  var Y = py(top + g.h - pts[j][1]);
                  if (j) ctx.lineTo(X, Y); else ctx.moveTo(X, Y);
                }
                ctx.closePath();
                ctx.fillStyle = hexA(g.color, .18);
                ctx.fill();
                ctx.strokeStyle = hexA(g.color, .8);
                ctx.lineWidth = Math.min(1.1, Math.max(.5, s * 0.8));
                ctx.stroke();
                drawn++;
              }
            }

            // 配件标签（每组第一次出现）
            if (seg.rowOffset === 0 && i === 0 && hPx > 12) {
              var label = g.partName + ' · ' + g.sizeLabel + '码 · ' + fmtInt(g.count) +
                '片 · 每排' + g.perRow + (g.interlock ? '（交错）' : '');
              ctx.font = '11px "Segoe UI", "Microsoft YaHei", sans-serif';
              var tw = ctx.measureText(label).width;
              var tx = px(4);
              var ty = yTop + 3;
              ctx.fillStyle = 'rgba(255,255,255,.86)';
              ctx.beginPath();
              ctx.roundRect(tx - 3, ty, tw + 8, 17, 4);
              ctx.fill();
              ctx.fillStyle = '#43506a';
              ctx.textAlign = 'left';
              ctx.textBaseline = 'top';
              ctx.fillText(label, tx + 1, ty + 3);
            }
          }
        }

        // 每份料分界
        for (var b = 1; b < p.rollCount; b++) {
          var by = py(b * ROLL_MM);
          if (by < padT - 1 || by > padT + vh + 1) continue;
          ctx.save();
          ctx.setLineDash([5, 4]);
          ctx.strokeStyle = '#d0576b';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(padL, by + .5);
          ctx.lineTo(padL + vw, by + .5);
          ctx.stroke();
          ctx.restore();
          ctx.fillStyle = '#b04557';
          ctx.textAlign = 'left';
          ctx.textBaseline = 'bottom';
          ctx.font = '10.5px "Segoe UI", "Microsoft YaHei", sans-serif';
          ctx.fillText('第 ' + (b + 1) + ' 份', padL + 6, by - 3);
        }

        ctx.restore();

        // 标尺（画在裁剪区外，避免被裁掉）
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.font = '10.5px "Segoe UI", "Microsoft YaHei", sans-serif';
        var steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100];
        var stepMm = 1000;
        for (var q = 0; q < steps.length; q++) {
          if (steps[q] * 1000 * s >= 44) { stepMm = steps[q] * 1000; break; }
        }
        var startMm = Math.ceil(this.view.y / stepMm) * stepMm;
        for (var mm = startMm; mm <= this.view.y + visH; mm += stepMm) {
          var yy = clamp(py(mm), padT + 6, padT + vh - 6);
          ctx.strokeStyle = '#c8cfda';
          ctx.beginPath();
          ctx.moveTo(padL - 5, yy + .5);
          ctx.lineTo(padL, yy + .5);
          ctx.stroke();
          ctx.fillStyle = '#8b94a3';
          ctx.fillText(fmt1(mm / 1000) + 'm', padL - 8, yy);
        }

        // 缩略条
        this.drawMinimap(padL, padT, vw, vh, total, p);

        // 底部说明
        ctx.fillStyle = '#8b94a3';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.font = '11px "Segoe UI", "Microsoft YaHei", sans-serif';
        ctx.fillText('共 ' + p.rollCount + ' 份 · 净排料 ' + fmtM(p.netLength) + ' m · 有效幅宽 ' +
          stripW + ' mm · 片间距 ≥ ' + fmt1(p.gap) + ' mm', padL, H - 11);
        ctx.textAlign = 'right';
        ctx.fillText('拖动平移 · 滚轮滚动 · Ctrl+滚轮缩放', padL + vw, H - 11);
      },

      drawMinimap: function (padL, padT, vw, vh, total, p) {
        var ctx = this.ctx;
        var mx = padL + vw + 14;
        var mw = Math.max(34, this.W - mx - 14);

        ctx.fillStyle = '#f7f9fc';
        ctx.strokeStyle = '#e0e5ee';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(mx, padT, mw, vh, 6);
        ctx.fill();
        ctx.stroke();

        ctx.save();
        ctx.beginPath();
        ctx.roundRect(mx, padT, mw, vh, 6);
        ctx.clip();

        var k = vh / total;
        p.segments.forEach(function (seg) {
          var gStart = (seg.roll - 1) * ROLL_MM + seg.start;
          var len = seg.rows * seg.group.rowH + (seg.rows - 1) * state.gap;
          var y0 = padT + gStart * k;
          var h = Math.max(1.2, len * k);
          ctx.fillStyle = hexA(seg.group.color, .85);
          ctx.fillRect(mx + 3, y0, mw - 6, h + 0.6);
        });

        // 每份料分界（缩略图上）
        var rollPx = ROLL_MM * k;
        if (rollPx > 7) {
          ctx.strokeStyle = 'rgba(255,255,255,.75)';
          ctx.lineWidth = 1;
          for (var rr = 1; rr < p.rollCount; rr++) {
            var ry = padT + rr * ROLL_MM * k;
            ctx.beginPath();
            ctx.moveTo(mx + 3, ry + .5);
            ctx.lineTo(mx + mw - 3, ry + .5);
            ctx.stroke();
          }
        }

        ctx.fillStyle = 'rgba(42,91,215,.10)';
        var vy = padT + this.view.y * k;
        var vhh = Math.max(6, this.geo.visH * k);
        ctx.fillRect(mx, vy, mw, vhh);
        ctx.strokeStyle = '#2a5bd7';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(mx + .75, vy + .75, mw - 1.5, vhh - 1.5);

        ctx.restore();

        ctx.fillStyle = '#8b94a3';
        ctx.font = '10px "Segoe UI", "Microsoft YaHei", sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText('全卷', mx + mw / 2, padT + vh + 4);
      }
    };

    return obj;
  }

  /* ================= CSV ================= */

  function csvCell(v) {
    var s = String(v == null ? '' : v);
    if (/[",\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function exportCsv() {
    if (!plan || !plan.groups.length) {
      toast('还没有可导出的数据，请先填写订单数量', 'error');
      return;
    }
    var rows = [];
    rows.push(['鞋料用量估算']);
    rows.push(['数据源', state.dataset.source]);
    rows.push(['坯布幅宽(mm)', state.width]);
    rows.push(['有效幅宽(mm)', usableWidth()]);
    rows.push(['裁片间距(mm)', state.gap]);
    rows.push(['每双片数', state.pairFactor]);
    rows.push(['交错套排', state.interlock ? '是' : '否']);
    rows.push([]);
    rows.push(['总片数', plan.totalPieces]);
    rows.push(['裁片总面积(m²)', (plan.totalArea / 1e6).toFixed(2)]);
    rows.push(['净排料长度(m)', (plan.netLength / 1000).toFixed(1)]);
    rows.push(['份数(45m/份)', plan.rollCount]);
    rows.push(['备料长度(m)', (plan.purchasedLength / 1000).toFixed(1)]);
    rows.push(['排料利用率', (plan.utilization * 100).toFixed(1) + '%']);
    rows.push(['面积法下限(m)', (plan.totalArea / usableWidth() / 1000).toFixed(1)]);
    rows.push(['直排保守(m)', (conservativePlan.netLength / 1000).toFixed(1)]);
    rows.push([]);
    rows.push(['尺码', '双数', '片数', '面积(m²)', '排料长度(m)']);
    state.sizes.forEach(function (s, i) {
      var r = plan.bySize[i];
      if (!r || (!r.pairs && !r.pieces)) return;
      rows.push([s.label, r.pairs, r.pieces, (r.area / 1e6).toFixed(2), (r.length / 1000).toFixed(1)]);
    });
    rows.push(['合计', state.sizes.reduce(function (a, s) { return a + (s.pairs || 0); }, 0),
      plan.totalPieces, (plan.totalArea / 1e6).toFixed(2), (plan.netLength / 1000).toFixed(1)]);
    rows.push([]);
    rows.push(['配件', '每双用量', '片数', '面积(m²)', '排料长度(m)', '利用率']);
    state.parts.forEach(function (p, i) {
      var r = plan.byPart[i];
      if (!r || !r.pieces) return;
      rows.push([p.name, p.qty, r.pieces, (r.area / 1e6).toFixed(2), (r.length / 1000).toFixed(1),
        (r.area / (usableWidth() * r.length) * 100).toFixed(1) + '%']);
    });

    var csv = '\ufeff' + rows.map(function (r) { return r.map(csvCell).join(','); }).join('\r\n');
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    var d = new Date();
    var stamp = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
    a.href = URL.createObjectURL(blob);
    a.download = '鞋料估算_' + stamp + '.csv';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 800);
    toast('已导出 CSV');
  }

  /* ================= 导入 ================= */

  function importFile(file) {
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var text = String(reader.result || '');
        var polylines = DXF.parse(text);
        if (!polylines.length) {
          throw new Error('文件中没有找到多段线（POLYLINE / LWPOLYLINE）。请确认 DXF 未加密，且裁片外轮廓为闭合多段线。');
        }
        var res = DXF.extract(polylines);
        var labels = [];
        for (var i = 0; i < res.sizeCount; i++) labels.push(31 + i);
        buildDataset({
          source: file.name,
          builtin: false,
          labels: labels,
          parts: res.parts,
          warnings: res.warnings
        });
        if (viz) viz.resetView();
        recalc();
        updateSizeSummary();
        toast('已导入：' + res.parts.length + ' 个配件 × ' + res.sizeCount + ' 个尺码');
      } catch (err) {
        showError('导入失败：' + (err && err.message ? err.message : err));
        toast('导入失败：' + (err && err.message ? err.message : err), 'error');
      }
    };
    reader.onerror = function () {
      toast('读取文件失败', 'error');
    };
    reader.readAsText(file, 'utf-8');
  }

  /* ================= 本地存储 ================= */

  function saveSettings() {
    if (!state.dataset.builtin) return;
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        version: STORE_VERSION,
        sizes: state.sizes.map(function (s) { return { label: s.label, pairs: s.pairs, graded: !!s.graded }; }),
        parts: state.parts.map(function (p) { return { name: p.name, qty: p.qty }; }),
        gap: state.gap,
        width: state.width,
        pairFactor: state.pairFactor,
        interlock: state.interlock
      }));
    } catch (e) { /* 忽略 */ }
  }

  function restoreSettings() {
    var raw;
    try { raw = localStorage.getItem(STORE_KEY); } catch (e) { return; }
    if (!raw) return;
    try {
      var d = JSON.parse(raw);
      if (d.sizes && d.sizes.length === state.sizes.length) {
        state.sizes.forEach(function (s, i) {
          if (typeof d.sizes[i].label === 'string') s.label = d.sizes[i].label;
          s.pairs = Math.max(0, Number(d.sizes[i].pairs) || 0);
        });
      }
      if (d.parts && d.parts.length === state.parts.length) {
        state.parts.forEach(function (p, i) {
          if (typeof d.parts[i].name === 'string' && d.parts[i].name) p.name = d.parts[i].name;
          p.qty = clamp(Number(d.parts[i].qty), 0, 99);
          if (!isFinite(p.qty)) p.qty = 1;
        });
      }
      if (typeof d.gap === 'number') state.gap = clamp(d.gap, 2, 20);
      if (typeof d.width === 'number' && isFinite(d.width)) {
        state.width = clamp(Math.round(d.width / 10) * 10, WIDTH_MIN, WIDTH_MAX);
        // 旧版本默认值是 1.37m；未带版本号的存档按新默认 1.40m 处理
        if (d.version !== STORE_VERSION && state.width === 1370) state.width = WIDTH_DEFAULT;
      }
      state.startSize = Number(state.sizes[0] && state.sizes[0].label) || state.startSize;
      if (d.pairFactor === 2 || d.pairFactor === 1) state.pairFactor = d.pairFactor;
      if (typeof d.interlock === 'boolean') state.interlock = d.interlock;
    } catch (e) { /* 忽略损坏的存储 */ }
  }

  /* ================= 事件绑定 ================= */

  function bindGlobal() {
    $('#fileInput').addEventListener('change', function (e) {
      importFile(e.target.files && e.target.files[0]);
      e.target.value = '';
    });
    $('#btnImport').addEventListener('click', function () { $('#fileInput').click(); });
    $('#btnImport2').addEventListener('click', function () { $('#fileInput').click(); });
    $('#btnSample').addEventListener('click', function () {
      loadSample(false);
      recalc();
      saveSettings();
    });
    $('#btnSample2').addEventListener('click', function () {
      loadSample(false);
      recalc();
      saveSettings();
    });
    $('#btnExport').addEventListener('click', exportCsv);

    $('#btnAddSize').addEventListener('click', addSize);
    $('#btnRenumber').addEventListener('click', function () {
      var start = parseInt($('#startSize').value, 10);
      if (!isFinite(start)) { toast('请输入有效起始码', 'error'); return; }
      state.startSize = start;
      state.sizes.forEach(function (s, i) {
        s.label = String(start + i);
        s.graded = false;
      });
      renderSizeTable();
      recalc();
      saveSettings();
      toast('尺码已重编号为 ' + start + '–' + (start + state.sizes.length - 1));
    });

    $('#btnExample').addEventListener('click', function () {
      state.sizes.forEach(function (s, i) {
        s.pairs = i === 0 ? 5000 : (i === 1 ? 6000 : 0);
      });
      renderSizeTable();
      recalc();
      saveSettings();
      toast('已填入示例：' + state.sizes[0].label + '码 5000 双' +
        (state.sizes[1] ? '，' + state.sizes[1].label + '码 6000 双' : ''));
    });

    $('#sizeTbody').addEventListener('input', function (e) {
      var t = e.target;
      if (t.hasAttribute('data-size-pairs')) {
        var i = Number(t.getAttribute('data-size-pairs'));
        var v = Math.max(0, Math.floor(Number(t.value) || 0));
        state.sizes[i].pairs = v;
        scheduleRecalc();
        saveSettings();
      } else if (t.hasAttribute('data-size-label')) {
        var j = Number(t.getAttribute('data-size-label'));
        state.sizes[j].label = t.value;
        scheduleRecalc();
        saveSettings();
      }
    });

    $('#sizeTbody').addEventListener('focusin', function (e) {
      if (e.target.classList.contains('pairs') && e.target.value === '0') e.target.select();
    });

    $('#partsTbody').addEventListener('input', function (e) {
      var t = e.target;
      if (t.hasAttribute('data-part-name')) {
        var i = Number(t.getAttribute('data-part-name'));
        state.parts[i].name = t.value;
        scheduleRecalc();
        saveSettings();
      }
    });

    $('#pairFactor').addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      state.pairFactor = Number(b.getAttribute('data-v')) === 2 ? 2 : 1;
      syncControls();
      recalc();
      saveSettings();
    });

    $('#widthInput').addEventListener('change', function (e) {
      var v = Math.round(Number(e.target.value) / 10) * 10;
      if (!isFinite(v)) v = WIDTH_DEFAULT;
      state.width = clamp(v, WIDTH_MIN, WIDTH_MAX);
      syncControls();
      updateSourceInfo();
      recalc();
      saveSettings();
    });

    $('#gapInput').addEventListener('input', function (e) {
      var raw = Number(e.target.value);
      var v = clamp(isFinite(raw) ? raw : 3, 2, 20);
      if (v !== raw) e.target.value = v;
      state.gap = v;
      scheduleRecalc();
      saveSettings();
    });

    $('#interlockInput').addEventListener('change', function (e) {
      state.interlock = e.target.checked;
      recalc();
      saveSettings();
    });

    // 拖放导入
    document.addEventListener('dragover', function (e) {
      e.preventDefault();
    });
    document.addEventListener('drop', function (e) {
      e.preventDefault();
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) importFile(f);
    });

    window.addEventListener('error', function (e) {
      if (!e.message) return;
      showError('脚本错误：' + e.message);
    });
    window.addEventListener('unhandledrejection', function (e) {
      showError('未捕获的错误：' + (e.reason && e.reason.message ? e.reason.message : e.reason));
    });
  }

  /* ================= 启动 ================= */

  function boot() {
    if (!window.SAMPLE_DATA) {
      showError('缺少 data/parts.js，无法载入示例数据。请确认文件完整。');
      return;
    }

    loadSample(true);
    restoreSettings();
    renderSizeTable();
    renderPartsTable();
    syncControls();
    bindGlobal();

    viz = createViz();
    viz.init();
    recalc();

    // 首次渲染后保证画布尺寸正确
    requestAnimationFrame(function () { viz.resize(); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
