#!/usr/bin/env python3
"""Emit public/icon.svg - the vector app mark.

public/icon.svg used to be `<text>🏎️</text>`: a font glyph standing in for an app
icon. It is the manifest's SVG icon and the favicon on the auth page, so wherever
the device's emoji font lacks the codepoint the site's icon was a tofu box, and
everywhere else it was whatever the operating system thinks a racing car looks
like.

The shipped logo (public/img/logo.png) is LINE ART - a hexagonal shield with a
road curling into an S - so tracing its alpha is the wrong tool (the strokes
average away by 24px). This rebuilds the same shape as vector geometry instead:
the same hex shield, the same S road, the same cyan -> red rim, on the same dark
tile. It is the site's own mark, redrawn, not a new one - and at favicon size it
reads as the logo while staying a few hundred bytes with no raster inside it.

Run:  python3 tools/icon-forge/make_app_icon.py [--preview]
"""
import os
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
OUT = os.path.join(ROOT, 'public', 'icon.svg')

# 128 grid. The shield: flat shoulders, straight flanks, a point at the bottom.
SHIELD = 'M64 12 L104 30 L104 66 Q104 92 64 116 Q24 92 24 66 L24 30 Z'
# the road: down the left flank, across, and up the right - the S of the logo
ROAD = 'M46 92 C68 92 66 70 60 64 C54 58 82 58 84 34'

SVG = '''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128" role="img" aria-label="SRIDHAR RUSH">
  <defs>
    <linearGradient id="k" x1="24" y1="12" x2="104" y2="116" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#3fe7ff"/>
      <stop offset="0.28" stop-color="#0a86c8"/>
      <stop offset="0.62" stop-color="#0c2f57"/>
      <stop offset="1" stop-color="#ff3a1f"/>
    </linearGradient>
    <linearGradient id="t" x1="0" y1="0" x2="128" y2="128" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#08111c"/>
      <stop offset="1" stop-color="#0b1220"/>
    </linearGradient>
  </defs>
  <rect width="128" height="128" rx="26" fill="url(#t)"/>
  <path d="%s" fill="none" stroke="url(#k)" stroke-width="6" stroke-linejoin="round"/>
  <path d="%s" fill="none" stroke="url(#k)" stroke-width="7" stroke-linecap="round"/>
  <circle cx="46" cy="92" r="3.4" fill="#7ceaff"/>
  <circle cx="84" cy="34" r="3.4" fill="#ff6a4d"/>
</svg>
''' % (SHIELD, ROAD)


def preview(out):
    """draw the same geometry with PIL so it can be looked at without a renderer"""
    from PIL import Image, ImageDraw
    import re
    S = 256
    sc = S / 128.0
    img = Image.new('RGB', (S, S), (8, 17, 28))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, S - 1, S - 1], int(26 * sc), fill=(9, 15, 26))

    def pol(points):
        return [(x * sc, y * sc) for (x, y) in points]

    shield = pol([(64, 12), (104, 30), (104, 66), (64, 116), (24, 66), (24, 30), (64, 12)])
    d.line(shield, fill=(60, 200, 255), width=int(6 * sc), joint='curve')
    road = pol([(46, 92), (58, 92), (66, 78), (60, 64), (62, 58), (78, 58), (84, 44), (84, 34)])
    d.line(road, fill=(120, 190, 255), width=int(7 * sc), joint='curve')
    for (x, y), c in (((46, 92), (124, 234, 255)), ((84, 34), (255, 106, 77))):
        d.ellipse([x * sc - 3.4 * sc, y * sc - 3.4 * sc, x * sc + 3.4 * sc, y * sc + 3.4 * sc], fill=c)
    img.save(out)
    return out


def main():
    open(OUT, 'w').write(SVG)
    print('wrote %s (%d bytes)' % (OUT, len(SVG)))
    if '--preview' in sys.argv:
        out = os.path.join(ROOT, 'tools', 'icon-forge', 'preview', 'app-icon.png')
        os.makedirs(os.path.dirname(out), exist_ok=True)
        print('preview ->', preview(out))


if __name__ == '__main__':
    main()
