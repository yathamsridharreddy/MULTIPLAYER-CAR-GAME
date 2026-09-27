#!/usr/bin/env python3
"""Render the SHIPPED mono icons as a contact sheet, so they can be checked.

preview_icons.py draws the Lucide source geometry. This draws the files that
actually ship - public/img/ico-mono/*.svg - transform, stroke width, opacity and
all, because those are what the mask in the stylesheet paints. If the translate or
the scale in the bridge is wrong, an icon would be clipped or floating in a corner
and no test would catch it.

Uses PIL when it is available and falls back to the pure-python rasteriser in
preview_icons.py when it is not.

Run:  python3 tools/icon-forge/render_icons.py [--all | name ...]
      -> tools/icon-forge/preview/shipped-icons.png
"""
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
sys.path.insert(0, HERE)
ICON_DIR = os.path.join(ROOT, 'public', 'img', 'ico-mono')
OUT = os.path.join(HERE, 'preview', 'shipped-icons.png')

G_RE = re.compile(r'<g transform="translate\(([-\d.]+) ([-\d.]+)\) scale\(([-\d.]+)\)"(.*?)</g>', re.S)
PATH_RE = re.compile(r'<path d="([^"]+)"')
CIRCLE_RE = re.compile(r'<circle cx="([-\d.]+)" cy="([-\d.]+)" r="([-\d.]+)"')


def rasterise(name, cell=56, pad=8):
    """one icon -> a PIL image, drawn the way a mask would paint it"""
    from PIL import Image, ImageDraw
    svg = open(os.path.join(ICON_DIR, name + '.svg')).read()
    size = cell + pad * 2
    img = Image.new('L', (size, size), 0)
    d = ImageDraw.Draw(img)
    g = G_RE.search(svg)
    tx = ty = 0.0
    sc = 1.0
    stroke = 0.0
    opacity = 1.0
    if g:
        tx, ty, sc = float(g.group(1)), float(g.group(2)), float(g.group(3))
        attrs = g.group(4)
        m = re.search(r'stroke-width="([\d.]+)"', attrs)
        stroke = float(m.group(1)) if m else 0.0
        m = re.search(r'opacity="([\d.]+)"', attrs)
        opacity = float(m.group(1)) if m else 1.0
    fill = 'fill="currentColor"' in svg
    k = (cell / 128.0)

    def pt(x, y):
        return (pad + (tx + x * sc) * k, pad + (ty + y * sc) * k)

    if g:                                     # stroked (Lucide) geometry
        import preview_icons as P
        w = max(1, int(round(stroke * sc * k)))
        for p in PATH_RE.finditer(g.group(0)):
            # flatten() gives a LIST OF SUBPATHS, one per M - each a run of points
            for sub in P.flatten(p.group(1)):
                for i in range(1, len(sub)):
                    x0, y0 = pt(*sub[i - 1])
                    x1, y1 = pt(*sub[i])
                    d.line([x0, y0, x1, y1], fill=int(255 * opacity), width=w)
                    for (cx, cy) in ((x0, y0), (x1, y1)):   # round caps + joins
                        r = w / 2.0
                        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=int(255 * opacity))
        for c in CIRCLE_RE.finditer(g.group(0)):
            cx, cy = pt(float(c.group(1)), float(c.group(2)))
            r = (float(c.group(3)) * sc) * k + w / 2.0
            d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=int(255 * opacity), width=w)
    else:                                     # filled (house) geometry
        import preview_icons as P
        for p in PATH_RE.finditer(svg):
            tail = svg[p.end():p.end() + 60]
            m = re.search(r'opacity="([\d.]+)"', tail)
            op = float(m.group(1)) if m else 1.0
            for sub in P.flatten(p.group(1)):
                poly = [pt(x, y) for x, y in sub]
                if len(poly) > 2:
                    d.polygon(poly, fill=int(255 * max(op, 0.55)))
    return img


def P_pairs(d):
    import preview_icons as P
    return P.flatten(d)


def main():
    names = [a for a in sys.argv[1:] if not a.startswith('--')]
    if not names or '--all' in sys.argv:
        names = sorted(f[:-4] for f in os.listdir(ICON_DIR) if f.endswith('.svg'))
    from PIL import Image, ImageDraw
    cols = min(12, max(1, len(names)))
    rows = (len(names) + cols - 1) // cols
    cell, pad = 56, 14
    W, H = cols * (cell + pad), rows * (cell + pad)
    sheet = Image.new('RGB', (W, H), (10, 14, 22))
    for i, n in enumerate(names):
        try:
            tile = rasterise(n, cell, pad)
        except Exception as exc:                       # a broken icon must be loud
            print('!! %-22s %s' % (n, exc))
            continue
        r, c = divmod(i, cols)
        # the glyph in cyan on a dark plate - the way the mask paints it
        cyan = Image.new('RGB', tile.size, (122, 226, 255))
        x, y = c * (cell + pad), r * (cell + pad)
        d_tile = Image.new('RGB', tile.size, (14, 20, 30))
        sheet.paste(d_tile, (x, y))
        sheet.paste(cyan, (x, y), tile)
    sheet.save(OUT)
    print('rendered %d icons -> %s  (%dx%d)' % (len(names), OUT, W, H))


if __name__ == '__main__':
    main()
