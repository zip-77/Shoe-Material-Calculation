#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""从 DXF 提取裁片外轮廓，生成 data/parts.js。

用法:
    python tools/extract_parts.py "24AWB5308-2 (8).DXF"

识别规则（与 js/dxf.js 中的浏览器端识别保持一致）：
  1. 只取闭合多段线（首尾点重合），面积 >= 250 mm²；
  2. 若某条闭合线的 60% 以上采样点落在另一条更大的闭合线内部，则视为内部工艺线剔除；
  3. 按包围盒上边缘聚类成「行」，每行按 x 从左到右即 31→38 码；
  4. 取各行的众数作为尺码数量。
"""

import json
import math
import sys
from pathlib import Path

AREA_MIN = 250.0
NEST_SAMPLE = 40
NEST_INSIDE_RATIO = 0.6
ROW_TOL = 8.0
RDP_EPS = 0.15


def read_pairs(path):
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        lines = [l.strip() for l in f]
    return [(lines[i], lines[i + 1]) for i in range(0, len(lines) - 1, 2)]


def parse_polylines(pairs):
    """返回 [{'pts': [(x, y)...], 'closed': bool}]"""
    result = []
    poly = None
    verts = []
    for code, value in pairs:
        if code == "0":
            if value == "POLYLINE":
                poly = {"flags": 0}
                verts = []
            elif value == "VERTEX" and poly is not None:
                verts.append({})
            elif value == "SEQEND" and poly is not None:
                pts = [(v.get("x", 0.0), v.get("y", 0.0)) for v in verts]
                if len(pts) >= 3:
                    closed = bool(int(poly.get("flags", 0)) & 1) or (
                        len(pts) > 2 and math.dist(pts[0], pts[-1]) < 0.5
                    )
                    result.append({"pts": pts, "closed": closed})
                poly = None
                verts = []
            continue
        if poly is None:
            continue
        if verts:
            v = verts[-1]
            if code == "10":
                v["x"] = float(value)
            elif code == "20":
                v["y"] = float(value)
        else:
            if code == "70":
                poly["flags"] = int(float(value))
            elif code == "10":
                poly["x"] = float(value)
            elif code == "20":
                poly["y"] = float(value)
    return result


def poly_area(pts):
    s = 0.0
    n = len(pts)
    for i in range(n):
        x1, y1 = pts[i]
        x2, y2 = pts[(i + 1) % n]
        s += x1 * y2 - x2 * y1
    return abs(s) / 2.0


def bbox(pts):
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    return min(xs), min(ys), max(xs), max(ys)


def point_in_poly(pt, pts):
    x, y = pt
    inside = False
    n = len(pts)
    j = n - 1
    for i in range(n):
        xi, yi = pts[i]
        xj, yj = pts[j]
        if (yi > y) != (yj > y):
            xin = (xj - xi) * (y - yi) / (yj - yi) + xi
            if x < xin:
                inside = not inside
        j = i
    return inside


def rdp(pts, eps):
    """Ramer-Douglas-Peucker，闭合轮廓按首点切开处理。"""
    if len(pts) < 3:
        return pts

    def simplify(seq):
        if len(seq) < 3:
            return seq
        x1, y1 = seq[0]
        x2, y2 = seq[-1]
        dx, dy = x2 - x1, y2 - y1
        norm = math.hypot(dx, dy)
        idx, dmax = -1, 0.0
        for i in range(1, len(seq) - 1):
            px, py = seq[i]
            if norm == 0:
                d = math.hypot(px - x1, py - y1)
            else:
                d = abs(dy * px - dx * py + x2 * y1 - y2 * x1) / norm
            if d > dmax:
                idx, dmax = i, d
        if dmax > eps:
            left = simplify(seq[: idx + 1])
            right = simplify(seq[idx:])
            return left[:-1] + right
        return [seq[0], seq[-1]]

    if math.dist(pts[0], pts[-1]) < 0.01:
        loop = pts[:-1]
    else:
        loop = pts
    if len(loop) < 4:
        return pts
    # 从最远的两点切开，避免退化
    p0 = loop[0]
    far = max(range(len(loop)), key=lambda i: math.dist(loop[i], p0))
    a = loop[: far + 1]
    b = loop[far:] + [loop[0]]
    out = simplify(a)[:-1] + simplify(b)[:-1]
    out.append(out[0])
    return out


def extract(polylines):
    candidates = []
    for pl in polylines:
        pts = pl["pts"]
        closed = pl["closed"]
        if not closed:
            continue
        area = poly_area(pts)
        if area < AREA_MIN:
            continue
        candidates.append({"pts": pts, "area": area, "bbox": bbox(pts)})

    candidates.sort(key=lambda c: -c["area"])
    keep = []
    for c in candidates:
        step = max(1, len(c["pts"]) // NEST_SAMPLE)
        samples = c["pts"][::step]
        nested = False
        for k in keep:
            if k["area"] <= c["area"]:
                continue
            kb = k["bbox"]
            hit = 0
            for s in samples:
                if kb[0] <= s[0] <= kb[2] and kb[1] <= s[1] <= kb[3] and point_in_poly(s, k["pts"]):
                    hit += 1
            if hit > len(samples) * NEST_INSIDE_RATIO:
                nested = True
                break
        if not nested:
            keep.append(c)

    # 按上边缘聚类成行
    keep.sort(key=lambda c: c["bbox"][1])
    rows = []
    for c in keep:
        if rows and abs(c["bbox"][1] - rows[-1]["top"]) <= ROW_TOL:
            rows[-1]["items"].append(c)
            rows[-1]["top"] = sum(i["bbox"][1] for i in rows[-1]["items"]) / len(rows[-1]["items"])
        else:
            rows.append({"top": c["bbox"][1], "items": [c]})

    counts = [len(r["items"]) for r in rows]
    size_count = max(set(counts), key=counts.count) if counts else 0
    warnings = []
    for r in rows:
        r["items"].sort(key=lambda c: c["bbox"][0])
        if len(r["items"]) != size_count:
            warnings.append("有一行识别到 %d 个裁片，与尺码数 %d 不一致，已按 x 顺序对应" % (len(r["items"]), size_count))

    parts = []
    for r in rows:
        items = r["items"]
        polys = []
        for i in range(size_count):
            if i < len(items):
                polys.append(items[i])
            elif items:
                # 缺失则用本行最后一个补位
                polys.append(items[-1])
        area = sum(p["area"] for p in polys) / max(1, len(polys))
        parts.append({"polys": polys, "area": area})

    parts.sort(key=lambda p: -p["area"])
    return parts, size_count, warnings


def make_data(parts, size_count):
    out = []
    for idx, part in enumerate(parts):
        sizes = []
        for p in part["polys"]:
            pts = rdp(p["pts"], RDP_EPS)
            x0, y0 = p["bbox"][0], p["bbox"][1]
            pts = [[round(x - x0, 1), round(y - y0, 1)] for x, y in pts]
            # 去掉尾部重复点
            if len(pts) > 1 and pts[0] == pts[-1]:
                pts = pts[:-1]
            sizes.append({"pts": pts, "area": round(poly_area(pts), 1)})
        out.append({"name": "配件%02d" % (idx + 1), "sizes": sizes})
    return out


def main():
    src = Path(sys.argv[1] if len(sys.argv) > 1 else "24AWB5308-2 (8).DXF")
    pairs = read_pairs(src)
    polylines = parse_polylines(pairs)
    parts, size_count, warnings = extract(polylines)
    data = make_data(parts, size_count)
    labels = list(range(31, 31 + size_count))
    js = "window.SAMPLE_DATA = " + json.dumps(
        {"source": src.name, "sizeLabels": labels, "parts": data,
         "unit": "mm", "warnings": warnings},
        ensure_ascii=False, separators=(",", ":"),
    ) + ";\n"
    dest = Path("data/parts.js")
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(js, encoding="utf-8")
    print("closed polylines:", sum(1 for p in polylines if p["closed"]))
    print("parts:", len(parts), "sizes:", size_count, "warnings:", warnings)
    print("bytes:", dest.stat().st_size)
    for i, part in enumerate(data):
        print(i + 1, part["name"], "area", part["sizes"][0]["area"], "verts", [len(s["pts"]) for s in part["sizes"]][:4])


if __name__ == "__main__":
    main()
