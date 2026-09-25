#!/usr/bin/env python3
"""
Font -> vector outlines for the SRIDHAR RUSH wordmark.

The wordmark must be commercially usable, so it is built from fonts that are
SIL Open Font License 1.1 (the same families the site already loads) and then
converted to plain SVG paths. No font is embedded, no raster is involved, and
nothing depends on a viewer having the font installed.

Also flattens the outlines to polygons so the in-house rasteriser can preview
the exact geometry that ships.
"""
import os, sys, math

sys.path.insert(0, '/tmp/pylibs')
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen

FONT_DIR = '/tmp/fonts/use'


def load(font_file):
    return TTFont(os.path.join(FONT_DIR, font_file))


# --------------------------------------------------------------- text -> SVG --
def text_to_paths(font, text, size, tracking=0.0, skew=0.0, y=0.0):
    """Return (path_d_list, advance_width).

    path_d_list: one SVG path 'd' per glyph, already scaled to `size` em, with
    Y flipped for SVG. Curves are preserved (this is the shipping artwork).
    """
    upm = font['head'].unitsPerEm
    scale = size / upm
    cmap = font.getBestCmap()
    gs = font.getGlyphSet()
    x = 0.0
    out = []
    for ch in text:
        gname = cmap.get(ord(ch))
        if gname is None:
            x += size * 0.5
            continue
        pen = SVGPathPen(gs)
        gs[gname].draw(pen)
        d = pen.getCommands()
        adv = gs[gname].width * scale
        if d:
            out.append((d, x, scale, skew, y))
        x += adv + tracking * size
    return out, x


def d_to_svg(d, tx, ty, scale, skew=0.0, origin_y=0.0):
    """Wrap a glyph 'd' in a transform: font units -> SVG px, Y flipped,
    optional forward skew for the speed treatment."""
    # skew: x' = x + skew * (y)  -> in SVG (Y down) a positive skew leans right
    tr = "translate(%.4f,%.4f) scale(%.5f,%.5f)" % (tx, ty, scale, -scale)
    if skew:
        tr += " skewX(%.3f)" % (-skew)
    return tr, d


# ------------------------------------------------------- flatten for preview --
def _num(tok):
    return float(tok)


def _tokens(d):
    """Font outlines come out as "M202 0Q162 0Q..." - command letters are glued
    to their numbers, so a whitespace split silently produces zero polygons.
    This tokenises commands and numbers separately."""
    import re
    return re.findall(r'[MLHVCQTSAZmlhvcqtsaz]|-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?', d)


def flatten_path(d, steps=16):
    """Parse an SVG path 'd' into polygons so the preview rasteriser fills the
    identical geometry that ships as curves. Flattening curves to straight lines
    is preview-only; the shipped SVG keeps the real curves."""
    toks = _tokens(d)
    i = 0
    polys = []
    cur = []
    x = y = 0.0
    start = (0.0, 0.0)

    def push(px, py):
        cur.append((px, py))

    def is_num(tok):
        return tok not in 'MLHVCQTSAZmlhvcqtsaz'

    while i < len(toks):
        t = toks[i]
        i += 1
        if t == 'M':
            if len(cur) > 2:
                polys.append(cur)
            x, y = _num(toks[i]), _num(toks[i + 1]); i += 2
            cur = [(x, y)]
            start = (x, y)
            # SVG allows implicit linetos after a moveto: "M50 0 570 1490" is
            # a moveto followed by a lineto. Some fonts (Inter, for one) emit
            # paths this way; dropping those pairs deletes real corners and
            # the glyph renders as a mangled outline.
            while i + 1 < len(toks) and is_num(toks[i]) and is_num(toks[i + 1]):
                lx, ly = _num(toks[i]), _num(toks[i + 1]); i += 2
                push(lx, ly)
                x, y = lx, ly
        elif t == 'L':
            while i + 1 < len(toks) and is_num(toks[i]) and is_num(toks[i + 1]):
                x, y = _num(toks[i]), _num(toks[i + 1]); i += 2
                push(x, y)
        elif t == 'H':
            x = _num(toks[i]); i += 1
            push(x, y)
        elif t == 'V':
            y = _num(toks[i]); i += 1
            push(x, y)
        elif t in ('Q', 'T'):
            while True:
                if t == 'T':
                    cx, cy = x, y
                else:
                    cx, cy = _num(toks[i]), _num(toks[i + 1]); i += 2
                nx, ny = _num(toks[i]), _num(toks[i + 1]); i += 2
                x0, y0 = x, y
                for s2 in range(1, steps + 1):
                    u = s2 / steps
                    push((1 - u) ** 2 * x0 + 2 * (1 - u) * u * cx + u * u * nx,
                         (1 - u) ** 2 * y0 + 2 * (1 - u) * u * cy + u * u * ny)
                x, y = nx, ny
                if not (i + 1 < len(toks) and is_num(toks[i]) and is_num(toks[i + 1])
                        and (t == 'T' or (i + 3 < len(toks) and is_num(toks[i + 3])))):
                    break
        elif t in ('C', 'S'):
            if t == 'S':
                c1x, c1y = x, y
            else:
                c1x, c1y = _num(toks[i]), _num(toks[i + 1]); i += 2
            c2x, c2y = _num(toks[i]), _num(toks[i + 1]); i += 2
            nx, ny = _num(toks[i]), _num(toks[i + 1]); i += 2
            x0, y0 = x, y
            for s2 in range(1, steps + 1):
                u = s2 / steps
                v = 1 - u
                push(v ** 3 * x0 + 3 * v * v * u * c1x + 3 * v * u * u * c2x + u ** 3 * nx,
                     v ** 3 * y0 + 3 * v * v * u * c1y + 3 * v * u * u * c2y + u ** 3 * ny)
            x, y = nx, ny
        elif t in ('Z', 'z'):
            if len(cur) > 2:
                cur.append(start)
                polys.append(cur)
            cur = []
            x, y = start
        else:
            # unsupported/relative command: skip its numeric arguments
            while i < len(toks) and toks[i] not in 'MLHVCQTSAZmlhvcqtsaz':
                i += 1
    if len(cur) > 2:
        polys.append(cur)
    return polys


def apply_transform(polys, tx, ty, scale, skew=0.0):
    """Mirror d_to_svg's transform exactly, so the preview matches the SVG."""
    out = []
    for p in polys:
        q = []
        for (px, py) in p:
            # font units, Y up -> flip like scale(s,-s)
            X = px
            Y = -py
            if skew:
                X = X + math.tan(math.radians(skew)) * Y
            q.append((tx + X * scale, ty + Y * scale))
        out.append(q)
    return out


def layout_text(font, text, size, x, y, tracking=0.0, skew=0.0):
    """Position each glyph of `text` and return [(polygons, x, y)] so the
    preview rasteriser can fill exactly what the SVG emits."""
    upm = font['head'].unitsPerEm
    scale = size / upm
    cmap = font.getBestCmap()
    gs = font.getGlyphSet()
    out = []
    cx = x
    for ch in text:
        gname = cmap.get(ord(ch))
        if gname is None:
            continue
        pen = SVGPathPen(gs)
        gs[gname].draw(pen)
        d = pen.getCommands()
        adv = gs[gname].width * scale
        if d:
            polys = apply_transform(flatten_path(d), cx, y, scale, skew)
            out.append((polys, cx, y))
        cx += adv + tracking * size
    return out, cx


def text_svg_paths(font, text, size, x, y, tracking=0.0, skew=0.0):
    """The shipping version: same placement, but keeping the real curves."""
    upm = font['head'].unitsPerEm
    scale = size / upm
    cmap = font.getBestCmap()
    gs = font.getGlyphSet()
    out = []
    cx = x
    for ch in text:
        gname = cmap.get(ord(ch))
        if gname is None:
            continue
        pen = SVGPathPen(gs)
        gs[gname].draw(pen)
        d = pen.getCommands()
        adv = gs[gname].width * scale
        if d:
            tr = "translate(%.3f,%.3f) scale(%.6f,%.6f)" % (cx, y, scale, -scale)
            if skew:
                tr += " skewX(%.3f)" % (-skew)
            out.append('<path transform="%s" d="%s"/>' % (tr, d))
        cx += adv + tracking * size
    return out, cx
