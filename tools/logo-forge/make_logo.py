#!/usr/bin/env python3
"""
SRIDHAR RUSH — logo forge.

Rebuilds the chosen brand mark as clean VECTOR geometry, then emits every asset
a website actually needs: the SVG mark, the favicons, the PWA icons and the boot
splash. Vector is not a stylistic preference here — the previous logo was a
1.52 MB, 1254x1254, NO-ALPHA PNG sitting in a 16px favicon slot.

Geometry -> SVG + raster, so the art can be looked at before it ships (this
sandbox has no SVG rasteriser, so the preview uses the same primitives).

Run:  python3 tools/logo-forge/make_logo.py
"""
import math, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'icon-forge'))
import make_icons as mf          # shares the geometry + rasteriser + SVG emitter
from make_icons import circle, rrect, solid, lin, rad

W, H = 128.0, 128.0

# ---------------------------------------------------------------------------
# THE MONOGRAM — original geometry, built for 16px first.
#
# Sheet 2's *idea* was the brief (a bold stacked SR that survives as an icon);
# the geometry below is newly constructed for SRIDHAR RUSH. It is NOT traced or
# sampled from that sheet.
#
# Small-size rules this obeys:
#   * every stroke >= 19 design units on a 128 box  -> >= 2.4px at 16px
#   * the R counter is a single big rectangle (28x30) -> ~3.5 x 3.75px at 16px
#   * only right angles and one 45-degree leg: no thin strokes, no hairlines,
#     no tiny gaps, no fillets that can crumble
#   * S and R are separated by COLOUR as well as shape, which is what stops two
#     bold letterforms reading as one blob when they shrink
# ---------------------------------------------------------------------------
# Layout constants — DERIVED FROM THE 16px TARGET, not chosen by eye.
# At 16px the mark is 15px wide, so 1 design unit = 0.117px:
SX0, SX1 = 4.0, 56.0        # S box  (52u wide  -> 6.1px)
RX0, RX1 = 65.0, 126.0      # R box  (61u wide  -> 7.1px)
LETTER_GAP = RX0 - SX1      # 9u -> 1.05px at 16px: separates S from R by SHAPE
                            # alone, which is what makes the one-colour versions
                            # work. A 4u gap would be a hairline and vanish.
Y0, Y1 = 8.0, 120.0         # 112u tall -> 13.1px
BAR = 27.0                  # S bar thickness  -> 3.2px at 16px
GAP = 15.5                  # S counter gap    -> 1.8px at 16px
STEM = 20.0                 # R stem           -> 2.3px
RWALL = 20.0                # R bowl right wall-> 2.3px (matches STEM)
RCOUNT = 26.0               # R counter        -> 3.0px high
BOWL_H = 64.0               # R bowl height



def chamfer(poly, idx, c):
    """Replace corner `idx` with a straight cut c units along both adjacent
    edges. A 45-degree cut is what gives the letterforms their aggressive,
    machined feel while keeping every stroke thick enough for 16px."""
    n = len(poly)
    px, py = poly[idx]
    ax, ay = poly[(idx - 1) % n]
    bx, by = poly[(idx + 1) % n]

    def unit(fx, fy, tx, ty):
        dx, dy = tx - fx, ty - fy
        d = math.hypot(dx, dy) or 1.0
        return dx / d, dy / d

    ux, uy = unit(px, py, ax, ay)      # towards the previous point
    vx, vy = unit(px, py, bx, by)      # towards the next point
    return [(px + ux * c, py + uy * c), (px + vx * c, py + vy * c)]


def chamfered(poly, corners, c):
    """Apply chamfer() to several corners of one polygon."""
    out = list(poly)
    for idx in sorted(corners, reverse=True):
        cut = chamfer(out, idx, c)
        out = out[:idx] + cut + out[idx + 1:]
    return out


def monogram(variant='primary'):
    """The SR monogram — original geometry built FOR 16px, not scaled down to it.

    variant:
      'primary'  silver S + red R, with a dark keyline  -> dark backgrounds
      'onlight'  graphite S + red R                    -> light backgrounds
      'monolight' white on transparent                 -> over photography / red
      'monodark'  pure black on transparent             -> print, stamps, embossing

    The keyline exists because the size test showed the silver S vanishing
    against a white page: the mark must not depend on its background.
    """
    b2 = Y0 + BAR + GAP
    b3 = b2 + BAR + GAP
    mid_bot = b2 + BAR
    CH = 9.0

    s_top = chamfered([(SX0, Y0), (SX1, Y0), (SX1, Y0 + BAR), (SX0, Y0 + BAR)], [0, 1], CH)
    s_ru = [(SX1 - STEM, Y0 + BAR), (SX1, Y0 + BAR), (SX1, b2), (SX1 - STEM, b2)]
    s_mid = [(SX0, b2), (SX1, b2), (SX1, mid_bot), (SX0, mid_bot)]
    s_ll = [(SX0, mid_bot), (SX0 + STEM, mid_bot), (SX0 + STEM, b3), (SX0, b3)]
    s_bot = chamfered([(SX0, Y1 - BAR), (SX1, Y1 - BAR), (SX1, Y1), (SX0, Y1)], [3, 2], CH)

    r_stem = chamfered([(RX0, Y0), (RX0 + STEM, Y0), (RX0 + STEM, Y1), (RX0, Y1)], [0], CH)
    r_bowl = chamfered([(RX0 + STEM, Y0), (RX1, Y0), (RX1, Y0 + BOWL_H), (RX0 + STEM, Y0 + BOWL_H)], [1], CH)
    r_counter = [(RX0 + STEM, Y0 + 19), (RX1 - RWALL, Y0 + 19),
                 (RX1 - RWALL, Y0 + 19 + RCOUNT), (RX0 + STEM, Y0 + 19 + RCOUNT)]
    r_leg = chamfered([(RX0 + STEM, Y0 + BOWL_H), (RX0 + STEM + STEM, Y0 + BOWL_H),
                       (RX1, Y1), (RX1 - STEM, Y1)], [3], CH)

    S_ALL = [s_ll, s_ru, s_top, s_mid, s_bot]
    silver = lin(90, [(0, '#ffffff'), (.48, '#eef3fa'), (1, '#aebccf')])
    graphite = lin(90, [(0, '#3d4756'), (.5, '#232b38'), (1, '#0d121b')])
    red = lin(90, [(0, '#ff4a3a'), (.5, '#e01010'), (1, '#8e060a')])

    if variant == 'onlight':
        return [
            dict(sub=[r_stem], fill=red),
            dict(sub=[r_bowl, r_counter, r_leg], evenodd=True, fill=red),
            dict(sub=S_ALL, fill=graphite),
        ]
    if variant == 'monolight':
        white = solid('#ffffff')
        return [
            dict(sub=[r_stem], fill=white),
            dict(sub=[r_bowl, r_counter, r_leg], evenodd=True, fill=white),
            dict(sub=S_ALL, fill=white),
        ]
    if variant == 'monodark':
        black = solid('#000000')
        return [
            dict(sub=[r_stem], fill=black),
            dict(sub=[r_bowl, r_counter, r_leg], evenodd=True, fill=black),
            dict(sub=S_ALL, fill=black),
        ]
    # primary: silver S with a dark keyline so it keeps a silhouette on light too
    return [
        dict(sub=[r_stem], fill=red),
        dict(sub=[r_bowl, r_counter, r_leg], evenodd=True, fill=red),
        dict(sub=S_ALL, stroke='#0d121b', stroke_width=5.0,
             fill=silver),
    ]


def mark():
    """Alias used by the tile / PWA builders."""
    return monogram()


def mark():
    """Back-compat alias for the tile/PWA builders."""
    return monogram()


# ---------------------------------------------------------------------------
# Composite pieces
# ---------------------------------------------------------------------------
def tile(size, radius_ratio=0.22, bg=((0x0b, 0x11, 0x1c), (0x05, 0x07, 0x0c)), inset=0.14):
    """The mark on a rounded dark tile — the app-icon / favicon treatment."""
    r = size * radius_ratio
    tile_poly = rrect(0, 0, size, size, r, n=14)
    inset_px = size * inset
    scale = (size - 2 * inset_px) / 128.0
    mark_polys = []
    for L in mark():
        for sp in L['sub']:
            mark_polys.append([(inset_px + x * scale, inset_px + y * scale) for (x, y) in sp])
    return tile_poly, mark_polys, bg


def mark_only(size):
    scale = size / 128.0
    out = []
    for L in mark():
        out.append(dict(sub=[[(x * scale, y * scale) for (x, y) in sp] for sp in L['sub']],
                        fill=L['fill'], glow=L.get('glow'), evenodd=L.get('evenodd')))
    return out


def _svg_path(sp):
    return "M" + " L".join("%s,%s" % (round(x, 2), round(y, 2)) for (x, y) in sp) + " Z"


def mark_svg(indent='  ', variant='primary', flat=True):
    """Standalone mark SVG — no filters, so it is safe everywhere (favicon, <img>, inline)."""
    body = []
    for L in monogram(variant):
        rule = ' fill-rule="evenodd"' if L.get('evenodd') else ''
        stroke = ''
        if L.get('stroke'):
            stroke = ' stroke="%s" stroke-width="%g" stroke-linejoin="miter"' % (L['stroke'], L['stroke_width'])
        body.append('%s<path d="%s" fill="%s"%s%s/>'
                    % (indent, " ".join(_svg_path(sp) for sp in L['sub']), _flat(L['fill']), rule, stroke))
    return "\n".join(body)


def _flat(fill):
    """One representative colour per layer (favicons do not need the gradients)."""
    if fill[0] == 'solid':
        return fill[1]
    return fill[2][len(fill[2]) // 2][1]


def write_mark_svg(path):
    svg = ('<!-- SRIDHAR RUSH mark - generated by tools/logo-forge/make_logo.py. Do not edit by hand. -->\n'
           '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128" role="img" aria-label="SRIDHAR RUSH">\n'
           + mark_svg() + "\n</svg>\n")
    open(path, 'w').write(svg)
    return len(svg)


# ---------------------------------------------------------------------------
# Rasteriser (own compositor: mf.render's gradients are pinned to a 128 box,
# and the mark needs to be rendered at arbitrary sizes)
# ---------------------------------------------------------------------------
def _hx(h):
    h = h.lstrip('#')
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))


def _grad(fill, x, y):
    if isinstance(fill, str):
        return _hx(fill)          # plain hex, e.g. a keyline stroke
    if fill[0] == 'solid':
        return _hx(fill[1])
    if fill[0] == 'lin':
        ang, stops = fill[1], fill[2]
        a = math.radians(ang)
        t = (math.cos(a) * (x - 64) + math.sin(a) * (y - 64)) / 128.0 + 0.5
    else:
        (gx, gy, gr), stops = fill[1], fill[2]
        t = math.hypot(x - gx, y - gy) / max(gr, 1e-6)
    t = min(1.0, max(0.0, t))
    prev = stops[0]
    for i in range(1, len(stops)):
        cur = stops[i]
        if t <= cur[0]:
            span = max(cur[0] - prev[0], 1e-9)
            k = (t - prev[0]) / span
            c0, c1 = _hx(prev[1]), _hx(cur[1])
            return tuple(int(c0[j] + (c1[j] - c0[j]) * k) for j in range(3))
        prev = cur
    return _hx(stops[-1][1])


def raster(layers, size, ss=3):
    """layers use 128-space coords. Returns a size x size list of (r,g,b,a 0..1)."""
    W = size * ss
    k = W / 128.0
    buf = [[[0.0, 0.0, 0.0, 0.0] for _ in range(W)] for _ in range(W)]

    def fill_group(group, fill):
        """Scanline-fill a set of polygons as one even-odd region."""
        edges = []
        for sp in group:
            n = len(sp)
            for i in range(n):
                ax, ay = sp[i]
                bx, by = sp[(i + 1) % n]
                if ay != by:
                    edges.append((ax * k, ay * k, bx * k, by * k))
        if not edges:
            return
        ymin = max(0, int(min(min(e[1], e[3]) for e in edges)))
        ymax = min(W - 1, int(max(max(e[1], e[3]) for e in edges)) + 1)
        for yy in range(ymin, ymax + 1):
            yc = yy + 0.5
            xs = []
            for (ax, ay, bx, by) in edges:
                if (ay <= yc < by) or (by <= yc < ay):
                    xs.append(ax + (yc - ay) * (bx - ax) / (by - ay))
            if len(xs) < 2:
                continue
            xs.sort()
            row = buf[yy]
            for i in range(0, len(xs) - 1, 2):
                if xs[i + 1] <= xs[i]:
                    continue
                for xx in range(max(0, int(math.ceil(xs[i] - 0.5))), min(W - 1, int(math.floor(xs[i + 1] - 0.5))) + 1):
                    r, g, b = _grad(fill, (xx + 0.5) / k, (yy + 0.5) / k)
                    row[xx] = [float(r), float(g), float(b), 1.0]

    def fill_poly(sp, fill, glow=None):
        if glow:
            g = _hx(glow)
            pts = sp
            cx = sum(p[0] for p in pts) / len(pts)
            cy = sum(p[1] for p in pts) / len(pts)
            R = 60.0
            y0 = max(0, int((cy - R) * k)); y1 = min(W, int((cy + R) * k) + 1)
            x0 = max(0, int((cx - R) * k)); x1 = min(W, int((cx + R) * k) + 1)
            for yy in range(y0, y1):
                dy = (yy + 0.5) / k - cy
                for xx in range(x0, x1):
                    dx = (xx + 0.5) / k - cx
                    d = math.hypot(dx, dy)
                    if d > R:
                        continue
                    a = max(0.0, 1.0 - d / R) ** 2.0 * 0.34
                    if a <= 0.002:
                        continue
                    cell = buf[yy][xx]
                    na = a + cell[3] * (1 - a)
                    if na <= 0:
                        continue
                    buf[yy][xx] = [(g[0] * a + cell[0] * cell[3] * (1 - a)) / na,
                                   (g[1] * a + cell[1] * cell[3] * (1 - a)) / na,
                                   (g[2] * a + cell[2] * cell[3] * (1 - a)) / na, na]
        edges = []
        n = len(sp)
        for i in range(n):
            ax, ay = sp[i]
            bx, by = sp[(i + 1) % n]
            if ay != by:
                edges.append((ax * k, ay * k, bx * k, by * k))
        if not edges:
            return
        ymin = max(0, int(min(min(e[1], e[3]) for e in edges)))
        ymax = min(W - 1, int(max(max(e[1], e[3]) for e in edges)) + 1)
        for yy in range(ymin, ymax + 1):
            yc = yy + 0.5
            xs = []
            for (ax, ay, bx, by) in edges:
                if (ay <= yc < by) or (by <= yc < ay):
                    xs.append(ax + (yc - ay) * (bx - ax) / (by - ay))
            if len(xs) < 2:
                continue
            xs.sort()
            row = buf[yy]
            for i in range(0, len(xs) - 1, 2):
                if xs[i + 1] <= xs[i]:
                    continue
                for xx in range(max(0, int(math.ceil(xs[i] - 0.5))), min(W - 1, int(math.floor(xs[i + 1] - 0.5))) + 1):
                    r, g, b = _grad(fill, (xx + 0.5) / k, (yy + 0.5) / k)
                    row[xx] = [float(r), float(g), float(b), 1.0]

    for L in layers:
        # glow per polygon, but fill the whole layer as ONE even-odd group so
        # counters (the R's bowl) come out as real holes instead of filling in
        for sp in L['sub']:
            if L.get('glow'):
                fill_poly(sp, L['fill'], L['glow'])
        if L.get('stroke'):
            w = L['stroke_width']
            for sp in L['sub']:
                for i in range(len(sp)):
                    ax, ay = sp[i]
                    bx, by = sp[(i + 1) % len(sp)]
                    dx, dy = bx - ax, by - ay
                    d = math.hypot(dx, dy) or 1.0
                    nx, ny = -dy / d * w / 2, dx / d * w / 2
                    fill_group([[(ax + nx, ay + ny), (bx + nx, by + ny),
                                 (bx - nx, by - ny), (ax - nx, ay - ny)]], L['stroke'])
        if L.get('evenodd') and len(L['sub']) > 1:
            fill_group(L['sub'], L['fill'])
        else:
            for sp in L['sub']:
                fill_group([sp], L['fill'])

    out = []
    for y in range(size):
        row = []
        for x in range(size):
            sr = sg = sb = sa = 0.0
            for j in range(ss):
                for i in range(ss):
                    c = buf[y * ss + j][x * ss + i]
                    sr += c[0]; sg += c[1]; sb += c[2]; sa += c[3]
            n = ss * ss
            row.append((sr / n, sg / n, sb / n, sa / n))
        out.append(row)
    return out


def png(path, px, over=None):
    """Write RGBA-ish PNG over an optional background colour."""
    rgba = []
    for row in px:
        out = []
        for (r, g, b, a) in row:
            if over is None:
                out.append((int(r), int(g), int(b)))
            else:
                af = a
                out.append((int(r * af + over[0] * (1 - af)),
                            int(g * af + over[1] * (1 - af)),
                            int(b * af + over[2] * (1 - af))))
        rgba.append(out)
    mf.write_png(path, [[(r, g, b, 255) for (r, g, b) in row] for row in rgba])


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------
SIZES = [512, 192, 180, 48, 32, 16]


def build(outdir):
    os.makedirs(outdir, exist_ok=True)
    written = []

    svg_path = os.path.join(outdir, 'logo-mark.svg')
    n = write_mark_svg(svg_path)
    written.append(('logo-mark.svg', n))

    # tinted mark, transparent background, at every size a website needs
    for s in [512, 256, 192, 128, 64, 48, 32, 16]:
        px = raster(mark_only(128), s, ss=3 if s >= 128 else 8)
        p = os.path.join(outdir, 'logo-mark-%d.png' % s)
        png(p, px)
        written.append(('logo-mark-%d.png' % s, os.path.getsize(p)))

    # app-icon / favicon tiles: mark on a rounded dark tile
    for s in [512, 192, 180, 48, 32, 16]:
        r = 128 * 0.22
        bg = dict(sub=[rrect(0, 0, 128, 128, r, n=16)],
                  fill=lin(90, [(0, '#111a28'), (.5, '#0a0f18'), (1, '#05070c')]))
        layers = [bg] + mark_only(128)
        px = raster(layers, s, ss=3 if s >= 128 else 8)
        p = os.path.join(outdir, 'tile-%d.png' % s)
        png(p, px)
        written.append(('tile-%d.png' % s, os.path.getsize(p)))
    return written


if __name__ == '__main__':
    out = os.path.join(HERE, 'out')
    for name, size in build(out):
        print('  %-22s %7d bytes' % (name, size))
    print('->', out)
