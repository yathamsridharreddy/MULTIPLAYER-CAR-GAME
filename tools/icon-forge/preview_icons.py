#!/usr/bin/env python3
"""Preview the Lucide-derived icons as pixels, without an SVG rasteriser.

This sandbox has no browser and no SVG renderer, so an icon cannot be checked by
opening it. make_icons.py solves this for the house icons by drawing its own
polygon geometry; this solves it for the Lucide half by flattening the same path
data the SVG ships and stamping a round brush along it - i.e. what a renderer
would do with stroke-linecap="round".

It is a PREVIEW tool: the SVG files it checks are the deliverable, this only draws
them so a human (or the agent) can see mistakes before shipping.

Run:  python3 tools/icon-forge/preview_icons.py [name ...]   -> tools/icon-forge/preview/lucide.png
"""
import math
import os
import re
import struct
import sys
import zlib

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))

NUM = re.compile(r'[+-]?(?:\d*\.\d+|\d+\.?)(?:[eE][+-]?\d+)?')


class PathParser:
    """cursor over SVG path data - needed because arc flags are single digits and
    may be written run-together ("a1.5 1.5 0 00-2.474-1.561"), which a number
    tokenizer happily reads as one number and then everything after is garbage."""

    def __init__(self, d):
        self.d = d
        self.i = 0

    def _skip(self):
        while self.i < len(self.d) and self.d[self.i] in ' ,\t\n\r':
            self.i += 1

    def at_end(self):
        self._skip()
        return self.i >= len(self.d)

    def command(self):
        self._skip()
        if self.i < len(self.d) and self.d[self.i].isalpha():
            c = self.d[self.i]
            self.i += 1
            return c
        return None

    def number(self):
        self._skip()
        m = NUM.match(self.d, self.i)
        if not m:
            raise ValueError('number expected at %d in %r' % (self.i, self.d[self.i:self.i + 14]))
        self.i = m.end()
        return float(m.group())

    def flag(self):
        self._skip()
        c = self.d[self.i]
        if c not in '01':
            raise ValueError('flag expected at %d' % self.i)
        self.i += 1
        return int(c)


def bezier(p0, pts, n=14):
    """de Casteljau for any order - enough for the c/s/q/t segments Lucide uses"""
    out = []
    for k in range(1, n + 1):
        t = k / n
        cur = list(pts)
        while len(cur) > 1:
            cur = [((1 - t) * cur[i][0] + t * cur[i + 1][0],
                    (1 - t) * cur[i][1] + t * cur[i + 1][1])
                   for i in range(len(cur) - 1)]
        out.append(cur[0])
    return out


def arc_points(p0, rx, ry, rot, large, sweep, p1, n=16):
    """endpoint -> centre parameterisation (SVG implementation notes F.6.5)"""
    if rx == 0 or ry == 0:
        return [p1]
    phi = math.radians(rot)
    cosp, sinp = math.cos(phi), math.sin(phi)
    dx2, dy2 = (p0[0] - p1[0]) / 2.0, (p0[1] - p1[1]) / 2.0
    x1p = cosp * dx2 + sinp * dy2
    y1p = -sinp * dx2 + cosp * dy2
    rx, ry = abs(rx), abs(ry)
    lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry)
    if lam > 1:
        s = math.sqrt(lam); rx *= s; ry *= s
    num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p
    den = rx * rx * y1p * y1p + ry * ry * x1p * x1p
    co = math.sqrt(max(num / den, 0.0))
    if large == sweep:
        co = -co
    cxp = co * rx * y1p / ry
    cyp = -co * ry * x1p / rx
    cx = cosp * cxp - sinp * cyp + (p0[0] + p1[0]) / 2.0
    cy = sinp * cxp + cosp * cyp + (p0[1] + p1[1]) / 2.0

    def ang(ux, uy, vx, vy):
        dot = ux * vx + uy * vy
        ln = math.hypot(ux, uy) * math.hypot(vx, vy)
        a = math.acos(max(-1.0, min(1.0, dot / (ln or 1))))
        return -a if (ux * vy - uy * vx) < 0 else a

    th1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry)
    dth = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry)
    if not sweep and dth > 0:
        dth -= 2 * math.pi
    elif sweep and dth < 0:
        dth += 2 * math.pi
    pts = []
    for k in range(1, n + 1):
        t = th1 + dth * k / n
        x = cx + rx * math.cos(t) * cosp - ry * math.sin(t) * sinp
        y = cy + rx * math.cos(t) * sinp + ry * math.sin(t) * cosp
        pts.append((x, y))
    return pts


def flatten(d):
    """path data -> list of polylines, in the path's own coordinate space"""
    P = PathParser(d)
    cmd = None
    cx = cy = sx = sy = 0.0
    prev_c = prev_q = None
    lines, cur = [], []

    while not P.at_end():
        c = P.command()
        if c:
            cmd = c
        elif cmd is None:
            raise ValueError('path does not start with a command: %r' % d[:20])
        rel = cmd.islower()
        C = cmd.upper()

        if C == 'M':
            x, y = P.number(), P.number()
            if rel:
                x, y = cx + x, cy + y
            if cur:
                lines.append(cur)
            cur = [(x, y)]
            cx, cy = x, y
            sx, sy = x, y      # (chained `a = b = x, y` assigns the TUPLE to every name)
            cmd = 'l' if rel else 'L'
            prev_c = prev_q = None
        elif C == 'L':
            x, y = P.number(), P.number()
            if rel:
                x, y = cx + x, cy + y
            cur.append((x, y)); cx, cy = x, y
        elif C == 'H':
            x = P.number()
            if rel:
                x = cx + x
            cur.append((x, cy)); cx = x
        elif C == 'V':
            y = P.number()
            if rel:
                y = cy + y
            cur.append((cx, y)); cy = y
        elif C == 'C':
            a = (P.number(), P.number())
            b = (P.number(), P.number())
            e = (P.number(), P.number())
            if rel:
                a = (cx + a[0], cy + a[1]); b = (cx + b[0], cy + b[1]); e = (cx + e[0], cy + e[1])
            cur += bezier((cx, cy), [(cx, cy), a, b, e])
            prev_c = b; prev_q = None; cx, cy = e
        elif C == 'S':
            b = (P.number(), P.number())
            e = (P.number(), P.number())
            if rel:
                b = (cx + b[0], cy + b[1]); e = (cx + e[0], cy + e[1])
            a = (2 * cx - prev_c[0], 2 * cy - prev_c[1]) if prev_c else (cx, cy)
            cur += bezier((cx, cy), [(cx, cy), a, b, e])
            prev_c = b; prev_q = None; cx, cy = e
        elif C == 'Q':
            a = (P.number(), P.number())
            e = (P.number(), P.number())
            if rel:
                a = (cx + a[0], cy + a[1]); e = (cx + e[0], cy + e[1])
            cur += bezier((cx, cy), [(cx, cy), a, e])
            prev_q = a; prev_c = None; cx, cy = e
        elif C == 'T':
            e = (P.number(), P.number())
            if rel:
                e = (cx + e[0], cy + e[1])
            a = (2 * cx - prev_q[0], 2 * cy - prev_q[1]) if prev_q else (cx, cy)
            cur += bezier((cx, cy), [(cx, cy), a, e])
            prev_q = a; prev_c = None; cx, cy = e
        elif C == 'A':
            rx, ry, rot = P.number(), P.number(), P.number()
            large, sweep = P.flag(), P.flag()
            x, y = P.number(), P.number()
            if rel:
                x, y = cx + x, cy + y
            cur += arc_points((cx, cy), rx, ry, rot, large, sweep, (x, y))
            cx, cy = x, y
            prev_c = prev_q = None
        elif C == 'Z':
            if cur:
                cur.append((sx, sy))
                lines.append(cur)
                cur = []
            cx, cy = sx, sy
            prev_c = prev_q = None
        else:
            raise ValueError('unsupported path command %r' % cmd)

        if C not in 'CS':
            prev_c = None
        if C not in 'QT':
            prev_q = None

    if cur:
        lines.append(cur)
    return lines


def stamp(buf, w, h, x, y, r, alpha):
    x0, x1 = max(0, int(x - r - 1)), min(w - 1, int(x + r + 1))
    y0, y1 = max(0, int(y - r - 1)), min(h - 1, int(y + r + 1))
    if x1 < x0 or y1 < y0:
        return
    r2 = r * r
    for py in range(y0, y1 + 1):
        dy = py - y
        base = py * w
        for px in range(x0, x1 + 1):
            dx = px - x
            d2 = dx * dx + dy * dy
            if d2 <= r2:
                # soft edge, so the sheet is not a jagged mess
                a = alpha * min(1.0, (r2 - d2) / (r2 * 0.35 + 1e-6) + 0.35)
                idx = base + px
                if a > buf[idx]:
                    buf[idx] = a


# ------------------------------------------------------------------ sheet ---
def write_png(path, px):
    h = len(px); w = len(px[0])
    raw = b''
    for row in px:
        raw += b'\x00' + b''.join(struct.pack('BBB', r, g, b) for (r, g, b) in row)

    def chunk(t, d):
        c = struct.pack('>I', len(d)) + t + d
        return c + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    png = b'\x89PNG\r\n\x1a\n'
    png += chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress(raw, 9))
    png += chunk(b'IEND', b'')
    open(path, 'wb').write(png)


def main():
    import lucide_icons as L
    names = [a for a in sys.argv[1:] if not a.startswith('-')] or sorted(L.LUCIDE_MAP)
    cell, pad = 116, 14
    cols = 8
    rows = (len(names) + cols - 1) // cols
    W = cols * (cell + pad) + pad
    H = rows * (cell + pad) + pad
    sheet = [[(13, 18, 28) for _ in range(W)] for _ in range(H)]

    for idx, name in enumerate(names):
        inner = L.lucide_inner(L.LUCIDE_MAP[name][0])
        ds = re.findall(r'\sd="([^"]+)"', inner)
        shapes = []
        for d in ds:
            shapes += flatten(d)
        # circles / rects / lines in Lucide markup
        for m in re.finditer(r'<circle[^>]*cx="([\d.]+)"[^>]*cy="([\d.]+)"[^>]*r="([\d.]+)"', inner):
            cx, cy, rr = (float(m.group(i)) for i in (1, 2, 3))
            pts = [(cx + rr * math.cos(2 * math.pi * k / 32), cy + rr * math.sin(2 * math.pi * k / 32))
                   for k in range(33)]
            shapes.append(pts)
        for m in re.finditer(r'<rect[^>]*x="([\d.]+)"[^>]*y="([\d.]+)"[^>]*width="([\d.]+)"[^>]*height="([\d.]+)"[^>]*rx="([\d.]+)"', inner):
            x, y, w, h, rr = (float(m.group(i)) for i in (1, 2, 3, 4, 5))
            shapes.append([(x, y), (x + w, y), (x + w, y + h), (x, y + h), (x, y)])

        xs = [p[0] for s in shapes for p in s]
        ys = [p[1] for s in shapes for p in s]
        if not xs:
            continue
        # scale this icon's own bounds to a comfortable cell, same rule for all
        w = (max(xs) - min(xs)) or 1
        h = (max(ys) - min(ys)) or 1
        # normalise into a 24 box first so every icon gets the same optical size
        norm = [[((x - min(xs)) / w * 24 + (24 - 24) / 2, (y - min(ys)) / h * 24) for (x, y) in s] for s in shapes]
        W2 = cell * 3
        buf = [0.0] * (W2 * W2)
        r = 2.75 * (cell / 24.0) * 3 / 2.0
        for s in norm:
            pts = [(p[0] * (cell * 3 / 24) + 0, p[1] * (cell * 3 / 24) + 0) for p in s]
            for i in range(len(pts) - 1):
                (x0, y0), (x1, y1) = pts[i], pts[i + 1]
                dist = math.hypot(x1 - x0, y1 - y0)
                steps = max(1, int(dist / (r * 0.5)) + 1)
                for k in range(steps + 1):
                    t = k / steps
                    stamp(buf, W2, W2, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, r, 1.0)
        cx0 = pad + (idx % cols) * (cell + pad)
        cy0 = pad + (idx // cols) * (cell + pad)
        for y in range(cell):
            for x in range(cell):
                tot = 0.0
                for dy in range(3):
                    for dx in range(3):
                        tot += buf[(y * 3 + dy) * W2 + (x * 3 + dx)]
                a = tot / 9.0 * 0.9
                bg = sheet[cy0 + y][cx0 + x]
                sheet[cy0 + y][cx0 + x] = (int(226 * a + bg[0] * (1 - a)),
                                           int(238 * a + bg[1] * (1 - a)),
                                           int(252 * a + bg[2] * (1 - a)))
    out = os.path.join(ROOT, 'tools', 'icon-forge', 'preview')
    os.makedirs(out, exist_ok=True)
    path = os.path.join(out, 'lucide.png')
    write_png(path, sheet)
    print('wrote %s  (%d icons, %dx%d)' % (path, len(names), W, H))


if __name__ == '__main__':
    main()
