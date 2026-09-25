#!/usr/bin/env python3
"""
SRIDHAR RUSH — visual presentation plates.

Renders the approval-review sheets for the logo system. This script only READS
the existing site assets (for the side-by-side comparison) and writes preview
images under tools/logo-forge/out/present/. It does not touch the site.

Run: PYTHONPATH=/tmp/pylibs python3 tools/logo-forge/present.py
"""
import os, sys, math, struct, zlib

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
sys.path.insert(0, '/tmp/pylibs')
sys.path.insert(0, os.path.join(HERE, '..', 'icon-forge'))
sys.path.insert(0, HERE)

import build_logo as B
from glyphs import load, layout_text

OUT = os.path.join(HERE, 'out', 'present')
KIT = os.path.join(HERE, 'out')
os.makedirs(OUT, exist_ok=True)

ORB9 = B.ORB9
ORB7 = load('orbitron-latin-700-normal.woff')
CHK5 = load('chakra-petch-latin-500-normal.woff')
CHK7 = load('chakra-petch-latin-700-normal.woff')
# Annotation face for the review sheets: Orbitron's stylised numerals ("2")
# and Chakra Petch's "Y" are both ambiguous at label sizes, and these sheets
# have to be readable. Inter is used ONLY in the plates — never in an asset.
INT5 = load('inter-latin-500-normal.woff')
INT6 = load('inter-latin-600-normal.woff')
INT7 = load('inter-latin-700-normal.woff')

DARK = (8, 11, 18)
PANEL = (15, 20, 30)
LIGHT = (240, 243, 247)
WHITE = (244, 248, 252)
INK = (16, 20, 28)
CYAN = (0, 232, 255)
GREY = (128, 140, 158)

# ---------------------------------------------------------------------------
# PNG reader (needed to load the CURRENT logo for the comparison sheet)
# ---------------------------------------------------------------------------
def read_png(path):
    d = open(path, 'rb').read()
    assert d[:8] == b'\x89PNG\r\n\x1a\n', path
    w, h, depth, ctype = struct.unpack('>IIBB', d[16:26])
    assert depth == 8, 'only 8-bit PNGs supported'
    pos, idat, plte = 8, b'', None
    while pos < len(d):
        ln = struct.unpack('>I', d[pos:pos + 4])[0]
        typ = d[pos + 4:pos + 8]
        data = d[pos + 8:pos + 8 + ln]
        if typ == b'IDAT':
            idat += data
        elif typ == b'PLTE':
            plte = data
        pos += 12 + ln
    raw = zlib.decompress(idat)
    nch = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[ctype]
    stride = w * nch
    px = []
    prev = bytearray(stride)
    i = 0
    for _ in range(h):
        f = raw[i]; i += 1
        line = bytearray(raw[i:i + stride]); i += stride
        if f == 1:
            for x in range(nch, stride):
                line[x] = (line[x] + line[x - nch]) & 255
        elif f == 2:
            for x in range(stride):
                line[x] = (line[x] + prev[x]) & 255
        elif f == 3:
            for x in range(stride):
                a = line[x - nch] if x >= nch else 0
                line[x] = (line[x] + ((a + prev[x]) >> 1)) & 255
        elif f == 4:
            for x in range(stride):
                a = line[x - nch] if x >= nch else 0
                b = prev[x]
                c = prev[x - nch] if x >= nch else 0
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[x] = (line[x] + pr) & 255
        row = []
        if ctype == 2:
            for x in range(w):
                row.append((line[x * 3], line[x * 3 + 1], line[x * 3 + 2], 255))
        elif ctype == 6:
            for x in range(w):
                row.append((line[x * 4], line[x * 4 + 1], line[x * 4 + 2], line[x * 4 + 3]))
        elif ctype == 0:
            for x in range(w):
                v = line[x]
                row.append((v, v, v, 255))
        elif ctype == 3:
            for x in range(w):
                k = line[x] * 3
                row.append((plte[k], plte[k + 1], plte[k + 2], 255))
        px.append(row)
        prev = line
    return px


def resize_box(px, nw, nh):
    """Box-filter downscale (good enough for comparison at small sizes)."""
    h, w = len(px), len(px[0])
    out = []
    for y in range(nh):
        row = []
        y0, y1 = int(y * h / nh), max(int((y + 1) * h / nh), int(y * h / nh) + 1)
        for x in range(nw):
            x0, x1 = int(x * w / nw), max(int((x + 1) * w / nw), int(x * w / nw) + 1)
            r = g = b = a = n = 0
            for yy in range(y0, y1):
                for xx in range(x0, x1):
                    p = px[yy][xx]
                    af = p[3] / 255.0
                    r += p[0] * af; g += p[1] * af; b += p[2] * af; a += p[3]; n += 1
            if n == 0:
                row.append((0, 0, 0, 0))
            else:
                aa = a / n
                if aa <= 0:
                    row.append((0, 0, 0, 0))
                else:
                    wsum = sum(px[yy][xx][3] / 255.0
                               for yy in range(y0, y1) for xx in range(x0, x1)) or 1
                    row.append((int(r / wsum), int(g / wsum), int(b / wsum), int(aa)))
        out.append(row)
    return out


# ---------------------------------------------------------------------------
# Drawing helpers
# ---------------------------------------------------------------------------
def canvas(w, h, bg=None):
    if bg is None:
        return [[(0.0, 0.0, 0.0, 0.0) for _ in range(w)] for _ in range(h)]
    return [[(float(bg[0]), float(bg[1]), float(bg[2]), 1.0) for _ in range(w)] for _ in range(h)]


def fill_group_evenodd(dst, polys, colour):
    H, W = len(dst), len(dst[0])
    edges = []
    for poly in polys:
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
                dst[y][x] = (float(colour[0]), float(colour[1]), float(colour[2]), 1.0)


def fill_group_nonzero(dst, polys, colour, alpha=1.0):
    """Nonzero-winding fill of one glyph.

    Annotation faces (Inter) draw letters like A and W as OVERLAPPING
    contours, relying on the renderer's nonzero winding rule. Even-odd turns
    those overlaps into holes -- an "A" comes out as a hollow triangle -- so
    plate text is filled with nonzero winding instead. The logo assets do not
    use this path; they keep the even-odd behaviour they were designed with.
    """
    edges = []
    for poly in polys:
        n = len(poly)
        for i in range(n):
            ax, ay = poly[i]
            bx, by = poly[(i + 1) % n]
            if ay != by:
                edges.append((ax, ay, bx, by, 1 if by > ay else -1))
    if not edges:
        return
    H, W = len(dst), len(dst[0])
    ymin = max(0, int(min(min(e[1], e[3]) for e in edges)))
    ymax = min(H - 1, int(max(max(e[1], e[3]) for e in edges)) + 1)
    for y in range(ymin, ymax + 1):
        yc = y + 0.5
        xs = []
        for (ax, ay, bx, by, d) in edges:
            if (ay <= yc < by) or (by <= yc < ay):
                xs.append((ax + (yc - ay) * (bx - ax) / (by - ay), d))
        if not xs:
            continue
        xs.sort()
        wind = 0
        for i in range(len(xs) - 1):
            wind += xs[i][1]
            if wind != 0:
                for x in range(max(0, int(xs[i][0])), min(W - 1, int(xs[i + 1][0])) + 1):
                    c = dst[y][x]
                    dst[y][x] = (colour[0] * alpha + c[0] * (1 - alpha),
                                 colour[1] * alpha + c[1] * (1 - alpha),
                                 colour[2] * alpha + c[2] * (1 - alpha), 1.0)


def draw_text(dst, font, text, size, x, y, colour, tracking=0.02, skew=0.0):
    out, end = layout_text(font, text, size, x, y, tracking=tracking, skew=skew)
    for polys, _, _ in out:
        fill_group_nonzero(dst, polys, colour)
    return end


def text_width(font, text, size, tracking=0.02):
    out, end = layout_text(font, text, size, 0, 0, tracking=tracking)
    return end


def overlay(dst, src, ox, oy):
    for y in range(len(src)):
        for x in range(len(src[0])):
            ty, tx = oy + y, ox + x
            if ty < 0 or tx < 0 or ty >= len(dst) or tx >= len(dst[0]):
                continue
            r, g, b, a = src[y][x]
            if a <= 0.001:
                continue
            c = dst[ty][tx]
            dst[ty][tx] = (r * a + c[0] * (1 - a), g * a + c[1] * (1 - a),
                           b * a + c[2] * (1 - a), 1.0)
    return dst


def overlay_png(dst, px, ox, oy):
    for y in range(len(px)):
        for x in range(len(px[0])):
            ty, tx = oy + y, ox + x
            if ty < 0 or tx < 0 or ty >= len(dst) or tx >= len(dst[0]):
                continue
            r, g, b, a = px[y][x]
            a = a / 255.0
            if a <= 0.001:
                continue
            c = dst[ty][tx]
            dst[ty][tx] = (r * a + c[0] * (1 - a), g * a + c[1] * (1 - a),
                           b * a + c[2] * (1 - a), 1.0)
    return dst


def write(path, px):
    return B.write_png_rgba(path, px)


def mono(variant, size, ss=None):
    return B._mono_px(variant, size, ss=ss)


def tile(size, variant='primary', pad_ratio=0.10, radius=0.22):
    return B._tile_px(size, variant, radius=radius,
                      ox=int(size * pad_ratio), oy=int(size * pad_ratio))


def rounded(dst, x0, y0, x1, y1, r, colour, alpha=1.0):
    from make_icons import rrect
    poly = rrect(x0, y0, x1 - x0, y1 - y0, r, n=12)
    H, W = len(dst), len(dst[0])
    edges = []
    n = len(poly)
    for i in range(n):
        ax, ay = poly[i]
        bx, by = poly[(i + 1) % n]
        if ay != by:
            edges.append((ax, ay, bx, by))
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
                c = dst[y][x]
                dst[y][x] = (colour[0] * alpha + c[0] * (1 - alpha),
                             colour[1] * alpha + c[1] * (1 - alpha),
                             colour[2] * alpha + c[2] * (1 - alpha), 1.0)


# Orbitron has no middle dot / arrow glyph; swap them so plate text never
# silently drops characters.
_FALLBACK = {'\u00b7': '/', '\u2192': '>'}


def _fit_font(font, text):
    """Replace characters the face has no glyph for (Orbitron lacks the middle
    dot) so plate text never silently loses a character."""
    cmap = font.getBestCmap()
    for bad, good in _FALLBACK.items():
        if bad in text and ord(bad) not in cmap:
            text = text.replace(bad, good)
    return text


def label(dst, text, x, y, colour=GREY, size=15, font=None, tracking=0.06):
    font = font or INT6
    draw_text(dst, font, _fit_font(font, text), size, x, y, colour, tracking=tracking)


def title(dst, text, x, y, size=18, colour=None):
    """Plate heading, in the brand face (Orbitron). Titles carry no digits."""
    draw_text(dst, B.ORB9, text, size, x, y, colour or WHITE, tracking=0.12)


# ===========================================================================
# PLATE 1 — the monogram at every required size, actual pixels
# ===========================================================================
def plate_sizes():
    """Actual-size marks. 512 needs its own band, so this is laid out as two
    columns: dark on the left, light on the right, same sizes in both."""
    PANEL_W = 700
    W = PANEL_W * 2
    H = 1010
    sheet = canvas(W, H, DARK)
    # light right half
    for y in range(H):
        for x in range(PANEL_W, W):
            sheet[y][x] = (float(LIGHT[0]), float(LIGHT[1]), float(LIGHT[2]), 1.0)

    small = [16, 32, 48, 64]

    def column(ox, variant, bg_is_dark):
        ink = WHITE if bg_is_dark else (44, 52, 66)
        sub = GREY if bg_is_dark else (110, 120, 136)
        title = 'DARK BACKGROUND  -  sr-primary.svg' if bg_is_dark else 'LIGHT BACKGROUND  -  sr-onlight.svg'
        label(sheet, title, ox + 34, 52, ink, 15, INT7, 0.02)
        # row 1: 16 32 48 64
        x = ox + 34
        y = 96
        for sz in small:
            overlay(sheet, mono(variant, sz), x, y)
            tw = text_width(INT6, '%dpx' % sz, 12)
            draw_text(sheet, INT6, '%dpx' % sz, 12, x + (sz - tw) / 2, y + 92, sub)
            x += sz + 46
        # row 2: 128
        overlay(sheet, mono(variant, 128), ox + 34, y + 128)
        draw_text(sheet, INT6, '128px', 13, ox + 34, y + 128 + 150, sub)
        # row 3: 512
        overlay(sheet, mono(variant, 512), ox + 34, y + 300)
        draw_text(sheet, INT6, '512px', 14, ox + 34, y + 300 + 530, sub)

    column(0, 'primary', True)
    column(PANEL_W, 'onlight', False)
    p = os.path.join(OUT, '1-sizes-actual.png')
    write(p, sheet)
    return p


# ===========================================================================
# PLATE 2 — lockups: horizontal, stacked, header, compact
# ===========================================================================
# Lockup text colours per variant. The light-background variants must not use
# white lettering: "SRIDHAR" would disappear on a light page.
TEXT_INK = {'primary': (244, 248, 252), 'onlight': (23, 30, 43), 'mono-white': (244, 248, 252),
            'mono-black': (16, 20, 28), 'red-white': (244, 248, 252), 'cyan-white': (238, 243, 249),
            'flat-red': (230, 34, 34)}
TEXT_ACC = {'primary': (236, 34, 34), 'onlight': (226, 34, 34), 'mono-white': (244, 248, 252),
            'mono-black': (16, 20, 28), 'red-white': (236, 34, 34), 'cyan-white': (0, 226, 250),
            'flat-red': (230, 34, 34)}


def lockup_layout(kind, variant='primary', ts=None):
    """One source of truth for lockup geometry, used by the plates AND the
    website mockup. Returns dict with size + a paint(dst, ox, oy) function.

    layout_text() bakes each glyph's x-advance into its polygons, so the ONLY
    transform needed at paint time is a single translate. Everything is offset
    from y=0 internally.
    """
    if kind == 'stacked':
        ts = ts or 76
        s_out, s_end = layout_text(ORB9, 'SRIDHAR', ts, 0, 0, tracking=0.05)
        r_out, r_end = layout_text(ORB9, 'RUSH', ts, 0, 0, tracking=0.05, skew=13)
        tw = max(s_end, r_end)
        mark_h = int(ts * 2.05)
        mark = mono(variant, mark_h, ss=3)
        W = int(max(mark_h * 1.05, tw + 10))
        gap = ts * 0.42
        H = int(mark_h + gap + ts * 2.1)
        mx = (W - mark_h) // 2
        tx = (W - tw) / 2
        ty = mark_h + gap + ts * 0.86

        def paint(dst, ox, oy):
            overlay(dst, mark, ox + mx, oy)
            for polys, _, _ in s_out:
                fill_group_evenodd(dst, [[(px + ox + tx, py + oy + ty) for (px, py) in poly] for poly in polys],
                                TEXT_INK[variant])
            for polys, _, _ in r_out:
                fill_group_evenodd(dst, [[(px + ox + tx, py + oy + ty) for (px, py) in poly] for poly in polys],
                                   TEXT_ACC[variant])
        return dict(W=W, H=H, paint=paint, ts=ts, mark_h=mark_h, tw=tw)

    # horizontal / header
    ts = ts or (72 if kind == 'horizontal' else 54)
    s_out, s_end = layout_text(ORB9, 'SRIDHAR', ts, 0, 0, tracking=0.05)
    r_out, r_end = layout_text(ORB9, 'RUSH', ts, 0, 0, tracking=0.05, skew=13)
    tw = max(s_end, r_end)
    mark_h = int(ts * 2.1)
    mark = mono(variant, mark_h, ss=3)
    gap = int(ts * 0.62)
    tx = mark_h + gap
    W = int(tx + tw + 6)
    H = int(mark_h + 4)
    ty = (H - ts * 1.86) / 2 + ts * 0.78        # top line baseline
    dy = ts * 1.02                               # RUSH sits below SRIDHAR

    def paint(dst, ox, oy):
        overlay(dst, mark, ox, oy + 2)
        for polys, _, _ in s_out:
            fill_group_evenodd(dst, [[(px + ox + tx, py + oy + ty) for (px, py) in poly] for poly in polys],
                                TEXT_INK[variant])
        for polys, _, _ in r_out:
            fill_group_evenodd(dst, [[(px + ox + tx, py + oy + ty + dy) for (px, py) in poly] for poly in polys],
                                TEXT_ACC[variant])
    return dict(W=W, H=H, paint=paint, ts=ts, mark_h=mark_h, tw=tw)


def _lockup_geometry(kind, variant='primary', text_size=None):
    L = lockup_layout(kind, variant, text_size)
    return L['W'], L['H'], (lambda dst, ox=0, oy=0: L['paint'](dst, ox, oy))


def plate_lockups():
    entries = [('horizontal', 'HORIZONTAL LOCKUP  (primary)'), ('header', 'HEADER LOCKUP  (tighter, for the site bar)')]
    PAD, TOP = 40, 74
    W = 1500
    H = TOP + sum(_lockup_geometry(k)[1] + 40 + 22 for k, _ in entries) + 8
    sheet = canvas(W, H, DARK)
    title(sheet, 'LOCKUPS', 40, 46)
    y = TOP
    for kind, cap in entries:
        w, h, draw = _lockup_geometry(kind)
        panel_h = h + 40
        rounded(sheet, PAD, y, W - PAD, y + panel_h, 16, PANEL, 0.55)
        draw(sheet, PAD + 24, y + 20)
        label(sheet, cap, PAD + 26, y + panel_h - 10, GREY, 13, INT5, 0.02)
        y += panel_h + 22
    p = os.path.join(OUT, '2-lockups.png')
    write(p, sheet)
    return p


# ===========================================================================
# PLATE 3 — dark vs light, side by side
# ===========================================================================
def plate_darklight():
    """The mark and the header lockup, side by side on dark and light."""
    W, H = 1240, 620
    sheet = canvas(W, H, DARK)
    half = W // 2
    for y in range(H):
        for x in range(half, W):
            sheet[y][x] = (float(LIGHT[0]), float(LIGHT[1]), float(LIGHT[2]), 1.0)
    label(sheet, 'DARK BACKGROUND', 46, 50, WHITE, 16, INT7, 0.02)
    label(sheet, 'LIGHT BACKGROUND', half + 46, 50, (60, 70, 86), 16, INT7, 0.02)

    # large marks
    overlay(sheet, mono('primary', 300), 60, 96)
    overlay(sheet, mono('onlight', 300), half + 60, 96)

    # the header lockup at real header scale (36px type), one per background
    for ox, variant in ((60, 'primary'), (half + 60, 'onlight')):
        L = lockup_layout('header', variant, ts=36)
        L['paint'](sheet, ox, 470)
    label(sheet, 'header lockup at 36px type', 62, 600, GREY, 12, INT5, 0.02)
    label(sheet, 'header lockup at 36px type', half + 62, 600, (120, 130, 146), 12, INT5, 0.02)
    p = os.path.join(OUT, '3-dark-vs-light.png')
    write(p, sheet)
    return p


# ===========================================================================
# PLATE 4 — every colour variant on the background it is meant for
# ===========================================================================
def variant_tile(sheet, x, y, w, h, variant, bg, name, note):
    if bg is not None:
        for yy in range(y, y + h):
            for xx in range(x, x + w):
                sheet[yy][xx] = (float(bg[0]), float(bg[1]), float(bg[2]), 1.0)
    dark = bg is None or sum(bg) < 380
    m = mono(variant, 150, ss=2)
    overlay(sheet, m, x + (w - len(m[0])) // 2, y + 34)
    bright = WHITE if dark else INK
    dim = GREY if dark else (110, 120, 136)
    label(sheet, name, x + 22, y + h - 56, bright, 17, INT7, 0.02)
    label(sheet, note, x + 22, y + h - 30, dim, 12, INT5, 0.01)


def plate_variants():
    """The five required colourways plus the two extra print/web ones."""
    W, H = 1240, 1096
    sheet = canvas(W, H, DARK)
    title(sheet, 'COLOUR VARIANTS', 40, 46)
    label(sheet, 'each shown on the background it is designed for', 40, 72, GREY, 13, CHK5, 0.06)
    tw, th = 380, 300
    gx, gy = 30, 26
    x0, y0 = 40, 108
    cells = [
        ('primary',    DARK,   'PRIMARY',     'silver S + racing red R + dark keyline — default on dark'),
        ('mono-white', DARK,   'MONO WHITE',  'one colour, alpha only — overlays, video, merch'),
        ('red-white',  DARK,   'RED / WHITE', 'white S + red R, no keyline — high contrast'),
        ('cyan-white', DARK,   'CYAN / WHITE','electric cyan R — esports / stream variant'),
        ('mono-black', LIGHT,  'MONO BLACK',  'one colour, alpha only — light UI, print, invoices'),
        ('onlight',    LIGHT,  'ON LIGHT',    'graphite S + red R — the light-background default'),
        ('flat-red',   PANEL,  'FLAT RED',    'single flat red — stamps, watermarks, tiny use'),
    ]
    for i, (v, bg, name, note) in enumerate(cells):
        cx = x0 + (i % 3) * (tw + gx)
        cy = y0 + (i // 3) * (th + gy)
        variant_tile(sheet, cx, cy, tw, th, v, bg, name, note)
    # swatch legend
    lx, ly = x0 + 2 * (tw + gx), y0 + 2 * (th + gy)
    for yy in range(ly, ly + th):
        for xx in range(lx, lx + tw):
            sheet[yy][xx] = (15.0, 20.0, 30.0, 1.0)
    label(sheet, 'PALETTE', lx + 22, ly + 40, WHITE, 17, INT7, 0.02)
    sw = [('#e8eef6', 'THEME', 'white / metallic silver'), ('#e62222', 'RACING RED', 'accent, R letter'),
          ('#0d121b', 'KEYLINE', 'separation on light'), ('#00e8ff', 'ELECTRIC CYAN', 'optional, sparing')]
    for i, (hexv, nm, use) in enumerate(sw):
        sy = ly + 66 + i * 52
        col = tuple(int(hexv[j:j + 2], 16) for j in (1, 3, 5))
        rounded(sheet, lx + 22, sy, lx + 62, sy + 36, 6, (58, 68, 86))     # chip outline
        rounded(sheet, lx + 23, sy + 1, lx + 61, sy + 35, 5, col)
        label(sheet, nm, lx + 76, sy + 10, WHITE, 13, INT7, 0.02)
        label(sheet, use, lx + 76, sy + 28, GREY, 12, INT5, 0.01)
    out = os.path.join(OUT, '4-variants.png')
    write(out, sheet)
    return out


# ===========================================================================
# PLATE 5 — favicon + PWA icons at their real pixel sizes
# ===========================================================================
def plate_icons():
    """Every launcher asset at its true pixel size where it fits, with the
    maskable safe zone drawn to scale."""
    W, H = 1240, 752
    sheet = canvas(W, H, DARK)
    title(sheet, 'APP ICONS AT ACTUAL SIZE', 40, 46)
    label(sheet, 'favicon 16/32/48 / apple-touch 180 / PWA 192 + 512 / maskable 512',
          40, 74, GREY, 13, INT5, 0.02)

    row1 = [('favicon-16.png', 16, 'favicon', 'favicon'), ('favicon-32.png', 32, 'favicon', 'favicon'),
            ('favicon-48.png', 48, 'favicon', 'favicon'), ('icon-192.png', 192, 'PWA', 'PWA 192')]
    x, y = 60, 120
    for path, size, kind, nm in row1:
        px = read_png(os.path.join(KIT, path))
        rounded(sheet, x - 14, y - 14, x + size + 14, y + size + 14, 8, (13, 17, 26))
        overlay_png(sheet, px, x, y)
        label(sheet, '%s %d' % (nm, size) if nm != 'PWA 192' else 'PWA 192',
              x - 14, y + size + 26, WHITE, 13, INT7, 0.02)
        label(sheet, '%dpx actual' % size, x - 14, y + size + 46, GREY, 12, INT5, 0.02)
        x += max(size, 150) + 40

    # apple-touch + the two 512 masters, shown scaled so they fit the sheet
    y2 = 372
    p512 = read_png(os.path.join(KIT, 'icon-512.png'))
    mk = read_png(os.path.join(KIT, 'icon-512-maskable.png'))
    apple = read_png(os.path.join(KIT, 'apple-touch-icon.png'))
    for i, (px, cap, note) in enumerate([
            (apple, 'APPLE TOUCH 180', 'shown at 180px -- actual size'),
            (p512, 'PWA 512', 'shown at 240px (scaled to fit)'),
            (mk, 'PWA 512 MASKABLE', 'shown at 240px (scaled to fit)')]):
        bx = 60 + i * 330
        shown = px if i == 0 else resize_box(px, 240, 240)
        rounded(sheet, bx - 12, y2 - 12, bx + len(shown[0]) + 12, y2 + len(shown) + 12, 8, (13, 17, 26))
        overlay_png(sheet, shown, bx, y2)
        if i == 2:
            cx, cy, r = bx + 120, y2 + 120, int(120 * 0.80)
            for a in range(0, 7200):
                th = a * math.pi / 3600.0
                gx, gy = int(cx + r * math.cos(th)), int(cy + r * math.sin(th))
                if 0 <= gy < H and 0 <= gx < W:
                    sheet[gy][gx] = (0.0, 232.0, 255.0, 1.0)
            note = 'whole mark fits the cyan 80% safe circle'
        label(sheet, cap, bx - 12, y2 + len(shown) + 26, WHITE, 13, INT7, 0.02)
        label(sheet, note, bx - 12, y2 + len(shown) + 46, GREY, 12, INT5, 0.02)
    label(sheet, 'the two 512 masters are the only scaled images here; the mark keeps a 20% margin so '
                 'Android may crop it to any shape',
          60, H - 44, GREY, 12, INT5, 0.01)
    label(sheet, 'the plain 512 is the full-bleed detail icon; the maskable one is padded and squared off '
                 'for circular launcher masks.',
          60, H - 22, GREY, 12, INT5, 0.01)
    out = os.path.join(OUT, '5-icons.png')
    write(out, sheet)
    return out


# ===========================================================================
# PLATE 6 — how it looks in the real UI (mockup only, no site files touched)
# ===========================================================================
def plate_mockup():
    """How the identity sits inside the real UI.

    This is a DRAWING, not the site: nothing under public/ is read for
    styling beyond the palette, and no site file is modified.
    """
    W, H = 1240, 664
    sheet = canvas(W, H, (5, 7, 13))
    for y in range(H):
        t = y / H
        for x in range(W):
            c = sheet[y][x]
            sheet[y][x] = (c[0] + 10 * t, c[1] + 14 * t, c[2] + 24 * t, 1.0)
    title(sheet, 'IN CONTEXT - MOCKUP ONLY', 40, 44)
    label(sheet, 'drawn from the real palette and layout; no website file was touched',
          40, 72, GREY, 13, INT5, 0.02)

    # ---- browser strip
    rounded(sheet, 40, 92, W - 40, 136, 10, (18, 23, 34))
    for i, col in enumerate([(255, 95, 86), (255, 189, 46), (39, 201, 63)]):
        for yy in range(110, 119):
            for xx in range(62 + i * 22, 71 + i * 22):
                sheet[yy][xx] = (float(col[0]), float(col[1]), float(col[2]), 1.0)
    label(sheet, 'sridhar-drift.vercel.app', 150, 106, GREY, 14, INT5, 0.02)

    # ---- boot splash panel (the .bs-logo block: 64px icon + text logo)
    bx0, by0, bx1, by1 = 40, 164, 610, 428
    for yy in range(by0, by1):
        for xx in range(bx0, bx1):
            sheet[yy][xx] = (0.0, 0.0, 0.0, 1.0)
    m64 = mono('primary', 64, ss=3)
    t1, t2 = 'SRIDHAR', 'RUSH'
    w1 = text_width(ORB9, t1, 26, 0.14)
    w2 = text_width(ORB9, t2, 26, 0.14)
    gap, space = 20, 12
    group = 64 + gap + w1 + space + w2
    gx = int(bx0 + (bx1 - bx0 - group) // 2)
    gy = by0 + 118
    overlay(sheet, m64, gx, gy)
    draw_text(sheet, ORB9, t1, 26, gx + 64 + gap, gy + 44, (255, 255, 255), tracking=0.14)
    draw_text(sheet, ORB9, t2, 26, gx + 64 + gap + w1 + space, gy + 44, (0, 232, 255), tracking=0.14)
    label(sheet, 'boot splash - 64px icon beside the existing text logo',
          bx0 + 20, by1 - 40, GREY, 13, INT5, 0.02)
    label(sheet, 'swap in splash-mark-64.png (drop the black square, it is transparent)',
          bx0 + 20, by1 - 18, GREY, 12, INT5, 0.01)

    # ---- lobby card panel (h1 replaced by the header lockup)
    cx0, cy0, cx1, cy1 = 640, 164, W - 40, 604
    rounded(sheet, cx0, cy0, cx1, cy1, 16, (15, 20, 30))
    rounded(sheet, cx0 + 1, cy0, cx1 - 1, cy0 + 3, 2, (0, 232, 255))
    L = lockup_layout('header', 'primary', ts=48)
    L['paint'](sheet, int(cx0 + (cx1 - cx0 - L['W']) // 2), cy0 + 26)
    tag = 'REAL-TIME 3D MULTIPLAYER RACING \u00b7 PHONE CONTROLLER SUPPORT'
    tw = text_width(INT6, tag, 12, 0.02)
    label(sheet, tag, cx0 + (cx1 - cx0 - tw) / 2, cy0 + 168, (148, 163, 184), 12, INT6, 0.02)
    # room row + ghost buttons, right-aligned inside the card
    label(sheet, 'ROOM \u00b7\u00b7\u00b7\u00b7A7K2', cx0 + 32, cy0 + 206, (226, 232, 240), 13, INT7, 0.02)
    labels = ['COPY', 'CREATE', 'JOIN', 'EN']
    widths = [88, 88, 78, 52]
    total = sum(widths) + 8 * (len(widths) - 1)
    bxx = cx1 - 32 - total
    for txt, bw in zip(labels, widths):
        rounded(sheet, bxx, cy0 + 188, bxx + bw, cy0 + 222, 8, (36, 44, 60))
        draw_text(sheet, INT7, txt, 12, bxx + (bw - text_width(INT7, txt, 12, 0.02)) / 2,
                  cy0 + 198, (226, 232, 240), tracking=0.02)
        bxx += bw + 8
    # primary CTA
    rounded(sheet, cx0 + 32, cy0 + 246, cx1 - 32, cy0 + 292, 10, (24, 32, 46))
    draw_text(sheet, ORB9, 'PLAY SOLO', 17,
              cx0 + (cx1 - cx0 - text_width(ORB9, 'PLAY SOLO', 17, 0.10)) / 2, cy0 + 258,
              (255, 255, 255), tracking=0.10)
    for i, txt in enumerate(['CREATE ROOM', 'JOIN ROOM']):
        x0 = cx0 + 32 if i == 0 else cx0 + (cx1 - cx0) / 2 + 6
        x1 = cx1 - 32 if i == 1 else cx0 + (cx1 - cx0) / 2 - 6
        rounded(sheet, x0, cy0 + 306, x1, cy0 + 348, 10, (24, 32, 46))
        draw_text(sheet, ORB9, txt, 15, x0 + ((x1 - x0) - text_width(ORB9, txt, 15, 0.08)) / 2,
                  cy0 + 318, (255, 255, 255), tracking=0.08)
    label(sheet, 'lobby card - the header lockup in place of the current <h1>, tagline unchanged',
          cx0 + 32, cy1 - 34, GREY, 13, INT5, 0.02)
    label(sheet, 'everything on this sheet is drawn by tools/logo-forge/present.py for review; '
                 'no file in public/ was modified.',
          40, H - 30, (150, 160, 178), 13, INT5, 0.01)
    out = os.path.join(OUT, '6-header-mockup.png')
    write(out, sheet)
    return out


# ===========================================================================
# PLATE 7 — the live logo next to the proposal
# ===========================================================================
def plate_compare():
    """The live logo next to the proposal, large and at real small sizes."""
    W, H = 1240, 830
    sheet = canvas(W, H, DARK)
    title(sheet, 'CURRENT SITE LOGO  vs  PROPOSED', 40, 46)
    label(sheet, 'left: public/img/logo.png as it ships today / right: sr-primary',
          40, 74, GREY, 13, INT5, 0.02)
    cur = read_png(os.path.join(ROOT, 'public', 'img', 'logo.png'))
    cur512 = resize_box(cur, 300, 300)
    overlay_png(sheet, cur512, 60, 116)
    overlay(sheet, mono('primary', 300, ss=2), 660, 116)
    label(sheet, 'CURRENT - 1254x1254 raster PNG, 1.52 MB, no alpha, one size only',
          60, 440, WHITE, 14, INT7, 0.02)
    label(sheet, 'a generic shield + lightning mark, cyan/red/yellow gradient, washes out when small',
          60, 462, GREY, 12, INT5, 0.01)
    label(sheet, 'PROPOSED - real SVG vector + 35 transparent PNGs, 8 sizes per colourway',
          660, 440, WHITE, 14, INT7, 0.02)
    label(sheet, '628 KB for the entire kit, alpha verified, drawn to survive 16px',
          660, 462, GREY, 12, INT5, 0.01)

    label(sheet, 'AT SMALL SIZES - ACTUAL PIXELS', 40, 516, WHITE, 15, INT7, 0.02)
    label(sheet, 'the top row is the current file box-filtered down; the bottom row is what the kit ships',
          40, 538, GREY, 12, INT5, 0.01)
    cols = [64, 32, 16]
    xs = [520, 700, 840]
    for x, sz in zip(xs, cols):
        lw = text_width(INT6, '%dpx' % sz, 12)
        label(sheet, '%dpx' % sz, x, 578, GREY, 12, INT6, 0.02)
        overlay_png(sheet, resize_box(cur, sz, sz), x, 596)
        overlay(sheet, mono('primary', sz, ss=3), x, 720)
    label(sheet, 'CURRENT', 40, 616, (200, 208, 220), 13, INT7, 0.02)
    label(sheet, 'PROPOSED', 40, 740, (200, 208, 220), 13, INT7, 0.02)
    label(sheet, 'the current raster cannot resolve below roughly 48px - the S and the lightning merge into a smudge.',
          40, 796, GREY, 12, INT5, 0.01)
    out = os.path.join(OUT, '7-current-vs-proposed.png')
    write(out, sheet)
    return out
