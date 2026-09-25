#!/usr/bin/env python3
"""
SRIDHAR RUSH — complete brand asset build.

Produces the full brand kit from one set of original vector definitions:
  * SR monogram, 7 colour variants, as SVG + PNG at every required size
  * SRIDHAR RUSH wordmark (Orbitron, SIL OFL 1.1) converted to vector outlines
  * horizontal lockup, stacked lockup, website-header lockup, compact lockup
  * favicon 16/32/48, PWA 192/512, Apple touch 180, boot/splash mark
  * the mandatory 16 -> 512 size test, on light AND dark
  * genuine alpha verification (PNG colour type 6 + real transparent pixels)

Run:  PYTHONPATH=/tmp/pylibs python3 tools/logo-forge/build_logo.py
"""
import os, re, sys, math, struct, zlib

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, '/tmp/pylibs')
sys.path.insert(0, os.path.join(HERE, '..', 'icon-forge'))
sys.path.insert(0, HERE)

import make_icons as mf
from glyphs import load, layout_text, text_svg_paths

OUT = os.path.join(HERE, 'out')

# ===========================================================================
# 1. THE MONOGRAM — original geometry, designed for 16px first
#
# Canvas 136x136. Every measurement below is chosen so that, at 16px
# (1 unit = 0.1176px), no stroke falls under 2px and no gap under 2px.
# ===========================================================================
CX, CY = 136.0, 136.0
SX0, SX1 = 4.0, 58.0            # S box, 54u wide  -> 6.4px
RX0, RX1 = 67.0, 132.0          # R box, 65u wide  -> 7.6px
Y0, Y1 = 9.0, 126.0             # 117u tall        -> 13.8px
BAR = 27.0                      # S bar            -> 3.2px
GAP = 18.0                      # S counter gap    -> 2.1px  (kept > 2px)
STEM = 23.0                     # R stem           -> 2.7px
RWALL = 20.0                    # R bowl wall      -> 2.4px
RCOUNT = 26.0                   # R counter height -> 3.1px
BOWL_H = 66.0
CH = 10.0                       # chamfer           -> 1.2px
SLANT = 13.0                    # degrees. Matches the wordmark's RUSH skew, so
                                # the monogram and the lettering read as one
                                # system. It also disambiguates the squared S
                                # from a "2", and it is the cheapest way to add
                                # speed without adding a single thin stroke.
                                # A vertical stroke keeps its full 23u width
                                # under a shear, so 16px safety is unaffected.


def _chamfer(poly, idx, c):
    n = len(poly)
    px, py = poly[idx]
    ax, ay = poly[(idx - 1) % n]
    bx, by = poly[(idx + 1) % n]

    def u(fx, fy, tx, ty):
        dx, dy = tx - fx, ty - fy
        d = math.hypot(dx, dy) or 1.0
        return dx / d, dy / d

    ux, uy = u(px, py, ax, ay)
    vx, vy = u(px, py, bx, by)
    return [(px + ux * c, py + uy * c), (px + vx * c, py + vy * c)]


def _chamfered(poly, corners, c):
    out = list(poly)
    for idx in sorted(corners, reverse=True):
        out = out[:idx] + _chamfer(out, idx, c) + out[idx + 1:]
    return out


def _shear(poly):
    t = math.tan(math.radians(SLANT))
    return [(x + t * (y - CY / 2), y) for (x, y) in poly]


def _shapes():
    b2 = Y0 + BAR + GAP          # 54
    b3 = b2 + BAR + GAP          # 99
    s_top = _chamfered([(SX0, Y0), (SX1, Y0), (SX1, Y0 + BAR), (SX0, Y0 + BAR)], [0, 1], CH)
    # SEGMENT LOGIC — this is what makes it an S and not a 2, and it is easy to
    # get backwards: a squared S connects top->middle on the LEFT and
    # middle->bottom on the RIGHT. (The mirror image of that is a "2", which is
    # exactly what the first build of this mark rendered as.)
    s_ul = [(SX0, Y0 + BAR), (SX0 + BAR, Y0 + BAR), (SX0 + BAR, b2), (SX0, b2)]
    s_mid = [(SX0, b2), (SX1, b2), (SX1, b2 + BAR), (SX0, b2 + BAR)]
    s_lr = [(SX1 - BAR, b2 + BAR), (SX1, b2 + BAR), (SX1, b3), (SX1 - BAR, b3)]
    s_bot = _chamfered([(SX0, Y1 - BAR), (SX1, Y1 - BAR), (SX1, Y1), (SX0, Y1)], [3, 2], CH)
    r_stem = _chamfered([(RX0, Y0), (RX0 + STEM, Y0), (RX0 + STEM, Y1), (RX0, Y1)], [0], CH)
    r_bowl = _chamfered([(RX0 + STEM, Y0), (RX1, Y0), (RX1, Y0 + BOWL_H),
                         (RX0 + STEM, Y0 + BOWL_H)], [1], CH)
    r_counter = [(RX0 + STEM, Y0 + 20), (RX1 - RWALL, Y0 + 20),
                 (RX1 - RWALL, Y0 + 20 + RCOUNT), (RX0 + STEM, Y0 + 20 + RCOUNT)]
    r_leg = _chamfered([(RX0 + STEM, Y0 + BOWL_H), (RX0 + STEM + STEM, Y0 + BOWL_H),
                        (RX1, Y1), (RX1 - STEM, Y1)], [3], CH)
    sh = dict(S=[s_top, s_ul, s_mid, s_lr, s_bot],
              R=[r_stem, r_bowl, r_counter, r_leg])
    # apply the slant, then re-centre so nothing clips the canvas
    xs = [p[0] for group in sh.values() for poly in group for p in poly]
    shift = (CX - (max(xs) - min(xs))) / 2 - min(xs)
    out = {}
    for k, group in sh.items():
        out[k] = [[(x + shift, y) for (x, y) in _shear(poly)] for poly in group]
    return out


SILVER = ('lin', 90, [(0, '#ffffff'), (.48, '#eef3fa'), (1, '#aebccf')])
GRAPHITE = ('lin', 90, [(0, '#3d4756'), (.5, '#232b38'), (1, '#0d121b')])
RED = ('lin', 90, [(0, '#ff4a3a'), (.5, '#e01010'), (1, '#8e060a')])
RED_FLAT = ('solid', '#e21111')
CYAN = ('lin', 0, [(0, '#7fe3ff'), (1, '#0a86c0')])
WHITE = ('solid', '#ffffff')
BLACK = ('solid', '#000000')

VARIANTS = {
    # name          S colour   R colour   keyline
    'primary':     (SILVER,    RED,       '#0d121b'),   # dark backgrounds
    'onlight':     (GRAPHITE,  RED,       None),        # light backgrounds
    'mono-white':  (WHITE,     WHITE,     None),
    'mono-black':  (BLACK,     BLACK,     None),
    'red-white':   (WHITE,     RED,       None),
    'cyan-white':  (SILVER,    CYAN,      '#0d121b'),
    'flat-red':    (RED_FLAT,  RED_FLAT,  None),
}


def monogram_layers(variant='primary'):
    sh = _shapes()
    s_col, r_col, key = VARIANTS[variant]
    layers = [
        dict(sub=[sh['R'][0]], fill=r_col),
        dict(sub=[sh['R'][1], sh['R'][2], sh['R'][3]], evenodd=True, fill=r_col),
        dict(sub=sh['S'], fill=s_col),
    ]
    if key:
        layers[-1]['stroke'] = key
        layers[-1]['stroke_width'] = 5.0
    return layers


# ===========================================================================
# 2. THE WORDMARK — Orbitron (SIL OFL 1.1) converted to vector outlines
# ===========================================================================
ORB8 = load('orbitron-latin-800-normal.woff')
ORB9 = load('orbitron-latin-900-normal.woff')


def _text_png_geo(font, text, size, x, y, tracking=0.0, skew=0.0):
    out, _ = layout_text(font, text, size, x, y, tracking=tracking, skew=skew)
    return out


def wordmark_paths(size=64, x=0.0, y=0.0):
    """SRIDHAR (clean, white) over RUSH (skewed, red). Returns (paths, width, height)."""
    s_paths, s_w = text_svg_paths(ORB9, 'SRIDHAR', size, x, y, tracking=0.055)
    r_paths, r_w = text_svg_paths(ORB9, 'RUSH', size, x, y + size * 0.98, tracking=0.055, skew=13)
    return s_paths, r_paths, max(s_w, r_w)


# ===========================================================================
# 3. RASTERISER (own, so the SVG and the preview cannot drift apart)
# ===========================================================================
def _hx(h):
    h = h.lstrip('#')
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))


def _grad(fill, x, y):
    if isinstance(fill, str):
        return _hx(fill)
    if fill[0] == 'solid':
        return _hx(fill[1])
    if fill[0] == 'lin':
        ang, stops = fill[1], fill[2]
        a = math.radians(ang)
        t = (math.cos(a) * (x - CX / 2) + math.sin(a) * (y - CY / 2)) / CX + 0.5
    else:
        (gx, gy, gr), stops = fill[1], fill[2]
        t = math.hypot(x - gx, y - gy) / max(gr, 1e-6)
    t = min(1.0, max(0.0, t))
    prev = stops[0]
    for i in range(1, len(stops)):
        cur = stops[i]
        if t <= cur[0]:
            k = (t - prev[0]) / max(cur[0] - prev[0], 1e-9)
            c0, c1 = _hx(prev[1]), _hx(cur[1])
            return tuple(int(c0[j] + (c1[j] - c0[j]) * k) for j in range(3))
        prev = cur
    return _hx(stops[-1][1])


def raster(layers, w, h, scale=1.0, ox=0.0, oy=0.0, ss=3):
    """Render layers (in 136-space, offset/scaled) onto a w x h RGBA buffer."""
    W, H = w * ss, h * ss
    buf = [[[0.0, 0.0, 0.0, 0.0] for _ in range(W)] for _ in range(H)]

    def fill_group(group, fill):
        edges = []
        for sp in group:
            n = len(sp)
            for i in range(n):
                ax, ay = sp[i]
                bx, by = sp[(i + 1) % n]
                ax = (ox + ax * scale) * ss; ay = (oy + ay * scale) * ss
                bx = (ox + bx * scale) * ss; by = (oy + by * scale) * ss
                if ay != by:
                    edges.append((ax, ay, bx, by))
        if not edges:
            return
        ymin = max(0, int(min(min(e[1], e[3]) for e in edges)))
        ymax = min(H - 1, int(max(max(e[1], e[3]) for e in edges)) + 1)
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
                    gx = (xx + 0.5) / ss / scale - ox / scale
                    gy = (yy + 0.5) / ss / scale - oy / scale
                    r, g, b = _grad(fill, gx, gy)
                    row[xx] = [float(r), float(g), float(b), 1.0]

    for L in layers:
        if L.get('stroke'):
            for sp in L['sub']:
                for i in range(len(sp)):
                    ax, ay = sp[i]
                    bx, by = sp[(i + 1) % len(sp)]
                    dx, dy = bx - ax, by - ay
                    d = math.hypot(dx, dy) or 1.0
                    nx, ny = -dy / d * L['stroke_width'] / 2, dx / d * L['stroke_width'] / 2
                    fill_group([[(ax + nx, ay + ny), (bx + nx, by + ny),
                                 (bx - nx, by - ny), (ax - nx, ay - ny)]], L['stroke'])
        if L.get('evenodd') and len(L['sub']) > 1:
            fill_group(L['sub'], L['fill'])
        else:
            for sp in L['sub']:
                fill_group([sp], L['fill'])

    out = []
    for y in range(h):
        row = []
        for x in range(w):
            sr = sg = sb = sa = 0.0
            for j in range(ss):
                for i in range(ss):
                    c = buf[y * ss + j][x * ss + i]
                    sr += c[0]; sg += c[1]; sb += c[2]; sa += c[3]
            n = ss * ss
            row.append((sr / n, sg / n, sb / n, sa / n))
        out.append(row)
    return out


def overlay(dst, src, ox, oy):
    """Alpha-composite src onto dst at ox,oy."""
    for y in range(len(src)):
        for x in range(len(src[0])):
            ty, tx = oy + y, ox + x
            if ty < 0 or tx < 0 or ty >= len(dst) or tx >= len(dst[0]):
                continue
            r, g, b, a = src[y][x]
            if a <= 0:
                continue
            c = dst[ty][tx]
            dst[ty][tx] = (r * a + c[0] * (1 - a), g * a + c[1] * (1 - a),
                           b * a + c[2] * (1 - a), 1.0)


def canvas(w, h, bg=None):
    if bg is None:
        return [[(0.0, 0.0, 0.0, 0.0) for _ in range(w)] for _ in range(h)]
    return [[(float(bg[0]), float(bg[1]), float(bg[2]), 1.0) for _ in range(w)] for _ in range(h)]


# ===========================================================================
# 4. PNG with REAL alpha (colour type 6) + written verification
# ===========================================================================
def write_png_rgba(path, px):
    h, w = len(px), len(px[0])
    raw = b''
    for row in px:
        line = bytearray()
        for (r, g, b, a) in row:
            line += struct.pack('BBBB', max(0, min(255, int(round(r)))),
                                max(0, min(255, int(round(g)))),
                                max(0, min(255, int(round(b)))),
                                max(0, min(255, int(round(a * 255)))))
        raw += b'\x00' + bytes(line)

    def chunk(t, d):
        c = struct.pack('>I', len(d)) + t + d
        return c + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)

    png = b'\x89PNG\r\n\x1a\n'
    png += chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))   # 6 = truecolour+alpha
    png += chunk(b'IDAT', zlib.compress(raw, 9))
    png += chunk(b'IEND', b'')
    open(path, 'wb').write(png)
    return len(png)


def verify_alpha(path):
    """Programmatically confirm: colour type 6, and the image really does contain
    transparent pixels (not a grey checkerboard painted on)."""
    d = open(path, 'rb').read()
    assert d[:8] == b'\x89PNG\r\n\x1a\n', path + ': not a PNG'
    w, h, depth, ctype = struct.unpack('>IIBB', d[16:26])
    assert ctype == 6, '%s: colour type %d is not RGBA(6)' % (path, ctype)
    # decompress IDAT and count alpha==0 pixels
    pos, idat = 8, b''
    while pos < len(d):
        ln = struct.unpack('>I', d[pos:pos + 4])[0]
        typ = d[pos + 4:pos + 8]
        if typ == b'IDAT':
            idat += d[pos + 8:pos + 8 + ln]
        pos += 12 + ln
    raw = zlib.decompress(idat)
    stride = w * 4
    transparent = opaque = 0
    prev = bytearray(stride)
    i = 0
    for _ in range(h):
        f = raw[i]; i += 1
        line = bytearray(raw[i:i + stride]); i += stride
        if f == 1:
            for x in range(4, stride):
                line[x] = (line[x] + line[x - 4]) & 255
        elif f == 2:
            for x in range(stride):
                line[x] = (line[x] + prev[x]) & 255
        elif f == 3:
            for x in range(stride):
                a = line[x - 4] if x >= 4 else 0
                line[x] = (line[x] + ((a + prev[x]) >> 1)) & 255
        elif f == 4:
            for x in range(stride):
                a = line[x - 4] if x >= 4 else 0
                b = prev[x]
                c = prev[x - 4] if x >= 4 else 0
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[x] = (line[x] + pr) & 255
        for x in range(3, stride, 4):
            if line[x] < 8:
                transparent += 1
            elif line[x] > 250:
                opaque += 1
        prev = line
    return dict(w=w, h=h, colour_type=ctype, transparent_px=transparent,
                opaque_px=opaque, has_alpha=transparent > 0)


# ===========================================================================
# 5. SVG emitters (clean, no rasters, no metadata)
# ===========================================================================
def _p(sp):
    return "M" + " ".join("%g %g" % (round(x, 2), round(y, 2)) for (x, y) in sp) + "Z"


def _flat(fill):
    if isinstance(fill, str):
        return fill
    if fill[0] == 'solid':
        return fill[1]
    return fill[2][len(fill[2]) // 2][1]


def _grad_def(gid, fill, box):
    if isinstance(fill, str) or fill[0] == 'solid':
        return None, _flat(fill)
    if fill[0] == 'lin':
        ang, stops = fill[1], fill[2]
        a = math.radians(ang)
        cx, cy = box[0] / 2, box[1] / 2
        dx, dy = math.cos(a) * box[0] / 2, math.sin(a) * box[1] / 2
        s = ('<linearGradient id="%s" x1="%g" y1="%g" x2="%g" y2="%g" '
             'gradientUnits="userSpaceOnUse">' % (gid, cx - dx, cy - dy, cx + dx, cy + dy))
    else:
        (gx, gy, gr), stops = fill[1], fill[2]
        s = ('<radialGradient id="%s" cx="%g" cy="%g" r="%g" '
             'gradientUnits="userSpaceOnUse">' % (gid, gx, gy, gr))
    for (pos, col) in stops:
        s += '<stop offset="%g" stop-color="%s"/>' % (pos, col)
    return s + ('</linearGradient>' if fill[0] == 'lin' else '</radialGradient>'), None


def monogram_svg(variant='primary', box=(CX, CY), with_defs=True):
    layers = monogram_layers(variant)
    defs, paths = [], []
    for i, L in enumerate(layers):
        gid = 'g%d' % i
        d, flat = _grad_def(gid, L['fill'], box)
        if d:
            defs.append(d)
            paint = 'url(#%s)' % gid
        else:
            paint = flat
        rule = ' fill-rule="evenodd"' if L.get('evenodd') else ''
        stroke = ''
        if L.get('stroke'):
            stroke = (' stroke="%s" stroke-width="%g" stroke-linejoin="miter"'
                      % (L['stroke'], L['stroke_width']))
        paths.append('<path d="%s" fill="%s"%s%s/>'
                     % (" ".join(_p(sp) for sp in L['sub']), paint, rule, stroke))
    body = ''
    if defs and with_defs:
        body += '<defs>' + "".join(defs) + '</defs>\n'
    return body + "\n".join(paths)


def write_monogram(path, variant='primary', px_size=None):
    w, h = (px_size or CX), (px_size or CY)
    svg = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 %g %g" width="%g" height="%g" '
           'role="img" aria-label="SRIDHAR RUSH">\n%s\n</svg>\n'
           % (CX, CY, w, h, monogram_svg(variant)))
    open(path, 'w').write(svg)
    return len(svg)


def lockup_svg(kind='horizontal', variant='primary'):
    """kind: horizontal | stacked | header | compact"""
    sh = _shapes()
    if kind == 'compact':
        w, h = CX, CY
        body = monogram_svg(variant)
        return ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 %g %g" '
                'width="%g" height="%g" role="img" aria-label="SRIDHAR RUSH">\n%s\n</svg>\n'
                % (CX, CY, w, h, body))

    mark_scale = 0.62 if kind in ('horizontal', 'header') else 1.0
    mark_w = CX * mark_scale
    mark_h = CY * mark_scale

    if kind in ('horizontal', 'header'):
        text_size = 46 if kind == 'horizontal' else 40
        s_paths, r_paths, tw = wordmark_paths(size=text_size, x=0, y=0)
        gap = 26
        W = mark_w + gap + tw + 8
        H = max(mark_h, text_size * 2.05)
        ms = mark_scale
        mbody = '<g transform="translate(0,%g) scale(%g)">%s</g>' % ((H - mark_h) / 2, ms, monogram_svg(variant, with_defs=False))
        ty = (H - text_size * 2.05) / 2 + text_size * 0.86
        tbody = '<g transform="translate(%g,%g)">%s%s</g>' % (
            mark_w + gap, ty, "".join(s_paths), "".join(r_paths))
    else:                                   # stacked
        text_size = 54
        s_paths, r_paths, tw = wordmark_paths(size=text_size, x=0, y=0)
        W = max(CX, tw)
        H = CY + text_size * 2.3
        mbody = '<g transform="translate(%g,0)">%s</g>' % ((W - CX) / 2, monogram_svg(variant, with_defs=False))
        ty = CY + text_size * 0.9
        tbody = '<g transform="translate(%g,%g)">%s%s</g>' % ((W - tw) / 2, ty,
                                                              "".join(s_paths), "".join(r_paths))
    svg = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 %g %g" width="%g" height="%g" '
           'role="img" aria-label="SRIDHAR RUSH">\n%s\n%s\n</svg>\n'
           % (W, H, W, H, mbody, tbody))
    return svg


# ===========================================================================
# 6. BUILD
# ===========================================================================
SIZES = [16, 24, 32, 48, 64, 128, 192, 512]
DARK = (10, 13, 20)
LIGHT = (238, 241, 246)


def _mono_px(variant, size, ss=None):
    ss = ss or (8 if size <= 64 else 3)
    return raster(monogram_layers(variant), size, size, scale=size / CX, ss=ss)


# A maskable icon may be cropped to a circle covering only the central 80% of
# its width, so the artwork is scaled down until its worst-case corner (the
# slanted mark's bounding corner, 96.1 units from centre in the 136-unit
# design) fits inside that circle. The tile is also squared off: a maskable
# background has to reach the edges, the platform draws the shape.
MASK_CONTENT_R = 96.1


def _maskable_ox(size, margin=0.98):
    inner = int(size * 0.40 * margin * (CX / MASK_CONTENT_R))
    return max(0, (size - inner) // 2)


def _tile_px(size, variant='primary', radius=0.22, ox=10, oy=10):
    """The app-icon treatment: mark on a rounded dark tile."""
    ss = 8 if size <= 64 else 3
    W = H = size
    bg = canvas(W, H, DARK)
    if radius is not None:
        # rounded-rect mask via the same scanline machinery.
        # radius=None means "no mask": a full-bleed square, which is what a
        # maskable icon needs (the platform draws the shape, not us).
        from make_icons import rrect as _rr
        r = CX * radius
        tile = _rr(0, 0, CX, CY, r, n=18)
        mask = raster([dict(sub=[tile], fill=('solid', '#ffffff'))], W, H, scale=1.0, ss=ss)
        for y in range(H):
            for x in range(W):
                if mask[y][x][3] < 0.5:
                    bg[y][x] = (bg[y][x][0], bg[y][x][1], bg[y][x][2], 0.0)
    inner = size - 2 * ox
    m = raster(monogram_layers(variant), W, H, scale=inner / CX, ox=ox, oy=oy, ss=ss)
    overlay(bg, m, 0, 0)
    return bg


def _write_png(path, px, opaque_bg=None):
    if opaque_bg is not None:
        px = [[(r * a + opaque_bg[0] * (1 - a), g * a + opaque_bg[1] * (1 - a),
                b * a + opaque_bg[2] * (1 - a), 1.0) for (r, g, b, a) in row] for row in px]
    return write_png_rgba(path, [[(r, g, b, a) for (r, g, b, a) in row] for row in px])



def write_asset_map():
    """Emit out/ASSET-MAP.txt from the build itself.

    The inventory used to be written by hand, which meant it could describe a
    kit that no longer matched the files on disk. Generating it from the same
    lists the build writes from makes that impossible.
    """
    import glob as _glob
    names = sorted(os.path.basename(x) for x in _glob.glob(os.path.join(OUT, '*')))
    def size_of(n):
        f = os.path.join(OUT, n)
        return os.path.getsize(f) if os.path.isfile(f) else 0

    svg = [n for n in names if n.endswith('.svg')]
    monogram_svg = [n for n in svg if n.startswith('sr-')]
    variant_desc = {'primary': 'silver S + red R + dark keyline (default on dark)',
                    'onlight': 'graphite S + red R (light backgrounds)',
                    'mono-white': 'one colour, white',
                    'mono-black': 'one colour, black',
                    'red-white': 'white S + red R',
                    'cyan-white': 'silver S + electric cyan R',
                    'flat-red': 'single flat red'}
    lockup_svg = [n for n in svg if n.startswith('logo-')]
    mono_png = [n for n in names if re.match(r'sr-(primary|onlight|mono-white|mono-black)-\d+\.png$', n)]
    other_png = [n for n in names if n.endswith('.png') and n not in mono_png and not n.startswith('present')]

    lines = []
    A = lines.append
    A('SRIDHAR RUSH \u2014 brand asset kit')
    A('=' * 30)
    A('Generated by tools/logo-forge/build_logo.py  (do not hand-edit)')
    A('Review plates are drawn separately by tools/logo-forge/present.py.')
    A('')
    A('MASTER VECTORS  (real SVG geometry, no raster, no metadata, no embedded font)')
    for n in monogram_svg:
        A('  %-24s %7d B  %s' % (n, size_of(n), variant_desc.get(n[3:-4], '')))
    A('')
    A('LOCKUPS  (monogram + wordmark as vector outlines; Orbitron 900, SIL OFL 1.1)')
    for n in lockup_svg:
        A('  %-26s %7d B' % (n, size_of(n)))
    A('')
    A('MONOGRAM PNGs  (transparent, 8-bit RGBA, colour type 6 \u2014 verified at build time)')
    A('  %d files: sr-{primary,onlight,mono-white,mono-black}-{%s}.png'
      % (len(mono_png), ','.join(str(s) for s in SIZES)))
    A('')
    A('FAVICON / APP ICONS  (opaque \u2014 the correct treatment for launcher slots)')
    for n in other_png:
        if not (n.startswith(('favicon-', 'icon-', 'apple-touch', 'splash-mark'))):
            continue
        A('  %-24s %7d B' % (n, size_of(n)))
    A('')
    A('AUDIT SHEETS  (renders of the kit, kept for eyeballing)')
    for n in other_png:
        if n.startswith(('favicon-', 'icon-', 'apple-touch', 'splash-mark')):
            continue
        A('  %-24s %7d B' % (n, size_of(n)))
    A('')
    A('REVIEW PLATES  (not part of the build; run present.py)')
    for n in sorted(os.path.basename(x) for x in _glob.glob(os.path.join(OUT, 'present', '*.png'))):
        A('  present/%-22s' % n)
    A('')
    A('WORDMARK FONT')
    A('  Family : Orbitron (The League of Moveable Type)')
    A('  Weights: 900 (SRIDHAR, RUSH)')
    A('  Licence: SIL Open Font License 1.1 - commercial use permitted')
    A('  NOT embedded: converted to outlines, so no font file ships')
    A('')
    A('REBUILD')
    A('  PYTHONPATH=/tmp/pylibs python3 tools/logo-forge/build_logo.py')
    A('')
    p = os.path.join(OUT, 'ASSET-MAP.txt')
    open(p, 'w').write('\n'.join(lines))
    return p


def build():
    os.makedirs(OUT, exist_ok=True)
    made = []

    # ---- master SVGs, one per variant
    for v in VARIANTS:
        p = os.path.join(OUT, 'sr-%s.svg' % v)
        made.append((os.path.basename(p), write_monogram(p, v), 'svg'))

    # ---- lockups (real vector, wordmark as outlines)
    for kind in ('horizontal', 'stacked', 'header', 'compact'):
        p = os.path.join(OUT, 'logo-%s.svg' % kind)
        svg = lockup_svg(kind)
        open(p, 'w').write(svg)
        made.append((os.path.basename(p), len(svg), 'svg'))

    # ---- transparent monogram PNGs, both background variants
    for v in ('primary', 'onlight', 'mono-white', 'mono-black'):
        for s in SIZES:
            p = os.path.join(OUT, 'sr-%s-%d.png' % (v, s))
            made.append((os.path.basename(p), _write_png(p, _mono_px(v, s)), 'png-alpha'))

    # ---- app icons / favicons (tiled, opaque — correct for these slots)
    for s in (16, 32, 48):
        p = os.path.join(OUT, 'favicon-%d.png' % s)
        made.append((os.path.basename(p), _write_png(p, _tile_px(s, ox=int(s * 0.08), oy=int(s * 0.08))), 'png'))
    for s, nm in ((180, 'apple-touch-icon.png'), (192, 'icon-192.png'), (512, 'icon-512.png')):
        p = os.path.join(OUT, nm)
        made.append((nm, _write_png(p, _tile_px(s, ox=int(s * 0.09), oy=int(s * 0.09))), 'png'))
    p = os.path.join(OUT, 'icon-512-maskable.png')
    _mo = _maskable_ox(512)
    made.append(('icon-512-maskable.png',
                  _write_png(p, _tile_px(512, radius=None, ox=_mo, oy=_mo)), 'png'))

    # ---- boot / splash mark (transparent, so it drops onto the existing splash)
    for s in (128, 256, 512):
        p = os.path.join(OUT, 'splash-mark-%d.png' % s)
        made.append((os.path.basename(p), _write_png(p, _mono_px('primary', s)), 'png-alpha'))

    # ---- wordmark PNG (for the audit sheet)
    p = os.path.join(OUT, 'lockup-horizontal.png')
    W, H = 1200, 300
    sheet = canvas(W, H, DARK)
    for font, text, size, x, y, col, skew in (
            (ORB9, 'SRIDHAR', 96, 330, 118, (238.0, 243.0, 250.0), 0.0),
            (ORB9, 'RUSH', 96, 330, 232, (238.0, 42.0, 42.0), 13.0)):
        polys, _ = layout_text(font, text, size, x, y, tracking=0.05, skew=skew)
        for poly in [q for (ps, _, _) in polys for q in ps]:
            raster_fill(sheet, poly, col)
    overlay(sheet, raster(monogram_layers('primary'), 240, 240, scale=240 / CX, ss=3), 50, 32)
    made.append(('lockup-horizontal.png', _write_png(p, sheet), 'png'))

    return made


def raster_fill(dst, poly, col):
    """Fill one polygon onto an RGB float buffer."""
    H, W = len(dst), len(dst[0])
    edges = []
    n = len(poly)
    for i in range(n):
        ax, ay = poly[i]
        bx, by = poly[(i + 1) % n]
        if ay != by:
            edges.append((ax, ay, bx, by))
    if not edges:
        return
    ymin = max(0, int(min(min(e[1], e[3]) for e in edges)))
    ymax = min(H - 1, int(max(max(e[1], e[3]) for e in edges)) + 1)
    for y in range(ymin, ymax + 1):
        yc = y + 0.5
        xs = []
        for (ax, ay, bx, by) in edges:
            if (ay <= yc < by) or (by <= yc < ay):
                xs.append(ax + (yc - ay) * (bx - ax) / (by - ay))
        if len(xs) < 2:
            continue
        xs.sort()
        for i in range(0, len(xs) - 1, 2):
            for x in range(max(0, int(xs[i])), min(W - 1, int(xs[i + 1])) + 1):
                dst[y][x] = (col[0], col[1], col[2], 1.0)


def size_test():
    """THE MANDATORY TEST: 16 24 32 48 64 128 192 512 on dark and light."""
    PAD, TOP = 26, 34
    width = 40 + sum(SIZES) + PAD * (len(SIZES) - 1) + 40
    row_h = 240
    H = row_h * 2 + TOP
    sheet = canvas(width, H, DARK)
    x = 40
    for s in SIZES:
        overlay(sheet, _mono_px('primary', s), x, TOP)
        x += s + PAD
    for yy in range(row_h + TOP // 2, H):
        for xx in range(width):
            sheet[yy][xx] = (float(LIGHT[0]), float(LIGHT[1]), float(LIGHT[2]), 1.0)
    x = 40
    for s in SIZES:
        overlay(sheet, _mono_px('onlight', s), x, row_h + TOP)
        x += s + PAD
    p = os.path.join(OUT, 'size-test.png')
    _write_png(p, sheet)
    return p


if __name__ == '__main__':
    made = build()
    _map = write_asset_map()
    sz = size_test()

    print('=' * 74)
    print('SRIDHAR RUSH — brand asset build')
    print('=' * 74)
    for name, size, kind in made:
        print('  %-30s %8d  %s' % (name, size, kind))
    print('  %-30s %8d  size test' % (os.path.basename(sz), os.path.getsize(sz)))
    print('  %-30s %8d  inventory' % (os.path.basename(_map), os.path.getsize(_map)))

    print()
    print('-' * 74)
    print('ALPHA VERIFICATION (colour type 6 + real transparent pixels)')
    print('-' * 74)
    for name, size, kind in made:
        if kind != 'png-alpha':
            continue
        v = verify_alpha(os.path.join(OUT, name))
        print('  %-26s %dbpp  colour_type=%d  transparent=%-7d opaque=%-7d  %s'
              % (name, 8, v['colour_type'], v['transparent_px'], v['opaque_px'],
                 'PASS' if v['has_alpha'] else 'FAIL'))
