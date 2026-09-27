#!/usr/bin/env python3
"""Render the weather row from the values in public/css/style.css.

There is no browser in this environment (the Playwright browser CDN is blocked),
so this draws the row from the SHIPPING css numbers - accents, radii, paddings,
tile size, chip colours - to check proportion, contrast and hierarchy before
pushing. It is a mock of the design, not a screenshot: the text metrics come from
DejaVu rather than Orbitron, and the masked SVG icons are redrawn as shapes.
"""
from PIL import Image, ImageDraw, ImageFont
import math, os

S = 3                                    # supersample
W, H = 1560, 210
PAGE_BG = (10, 15, 24)
CARD_BG = (16, 24, 40)
BORDER = (255, 255, 255, 24)
MUTED = (143, 162, 184)
NAME = (234, 241, 250)
FONTS = '/usr/share/fonts/truetype/dejavu/'
F = lambda name, px: ImageFont.truetype(FONTS + name, int(px * S))

WEATHER = [
    ('dry', 'DRY ASPHALT', '1.00x Grip', 'Optimal Track Pace', (255, 194, 74), 'sun'),
    ('wet', 'WET RAIN', '0.92x Grip', 'Water Spray & Puddles', (86, 182, 255), 'rain'),
    ('night', 'MIDNIGHT NEON', '1.00x Grip', 'Glowing Cyber Luminescence', (176, 124, 255), 'moon'),
    ('blizzard', 'ALPINE BLIZZARD', '0.88x Grip', 'Icy Snow Swirls', (159, 232, 255), 'snow'),
]


def rgba(c, a):
    return (c[0], c[1], c[2], int(round(a * 255)))


def icon(d, kind, cx, cy, r, col, bg):
    if kind == 'sun':
        d.ellipse([cx - r * .42, cy - r * .42, cx + r * .42, cy + r * .42], fill=col)
        for i in range(8):
            a = i * math.pi / 4
            d.line([cx + math.cos(a) * r * .62, cy + math.sin(a) * r * .62,
                    cx + math.cos(a) * r * .95, cy + math.sin(a) * r * .95], fill=col, width=max(1, int(1.5 * S)))
    elif kind == 'rain':
        d.ellipse([cx - r * .85, cy - r * .5, cx + r * .05, cy + r * .22], fill=col)
        d.ellipse([cx - r * .3, cy - r * .85, cx + r * .7, cy + r * .22], fill=col)
        d.rectangle([cx - r * .3, cy - r * .2, cx + r * .55, cy + r * .2], fill=col)
        for dx in (-.45, 0, .45):
            d.line([cx + dx * r, cy + r * .40, cx + dx * r - r * .18, cy + r * .85], fill=col, width=max(1, int(1.4 * S)))
    elif kind == 'moon':
        d.ellipse([cx - r * .85, cy - r * .85, cx + r * .85, cy + r * .85], fill=col)
        d.ellipse([cx - r * .05, cy - r * 1.1, cx + r * 1.3, cy + r * .45], fill=bg)
    else:
        for i in range(3):
            a = i * math.pi / 3
            d.line([cx - math.cos(a) * r, cy - math.sin(a) * r,
                    cx + math.cos(a) * r, cy + math.sin(a) * r], fill=col, width=max(1, int(1.4 * S)))


def draw_card(canvas, base_x, base_y, w, h, data, active):
    key, name, grip, desc, col, kind = data
    w, h = int(w), int(h)
    x0, y0 = int(base_x), int(base_y)
    radius = 14 * S

    # --- card body + atmosphere on their own layer, so alpha actually blends
    layer = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    ld = ImageDraw.Draw(layer, 'RGBA')
    ld.rounded_rectangle([0, 0, w - 1, h - 1], radius, fill=CARD_BG + (255,))
    if active:
        ld.rounded_rectangle([0, 0, w - 1, h - 1], radius, fill=rgba(col, 0.14))

    # the ::before glow: strongest at the top right, fading out
    glow = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow, 'RGBA')
    gcx, gcy = w * 0.90, -h * 0.10
    for i in range(30, 0, -1):
        rr = w * 0.95 * i / 30
        gd.ellipse([gcx - rr, gcy - rr, gcx + rr, gcy + rr], fill=rgba(col, 0.014))
    layer.alpha_composite(glow)

    streaks = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    sd = ImageDraw.Draw(streaks, 'RGBA')
    if key == 'wet':
        for i in range(-h, w + h, 8 * S):
            sd.line([i, 0, i + h, h], fill=rgba(col, 0.16), width=max(1, int(0.7 * S)))
    elif key == 'blizzard':
        for i in range(-h, w + h, 9 * S):
            sd.line([i, h, i + h, 0], fill=rgba((255, 255, 255), 0.10), width=max(1, int(0.7 * S)))
    elif key == 'night':
        for sx, sy in ((.70, .20), (.80, .46), (.62, .60), (.88, .76), (.55, .32)):
            px, py = w * sx, h * sy
            sd.ellipse([px - 1.2 * S, py - 1.2 * S, px + 1.2 * S, py + 1.2 * S], fill=(255, 255, 255, 200))
    layer.alpha_composite(streaks)

    # --- the icon tile (gradient + inner ring + the masked icon)
    t = int(34 * S)
    tx, ty = 14 * S, int((h - t) / 2)
    tile = Image.new('RGBA', (t, t), (0, 0, 0, 0))
    td = ImageDraw.Draw(tile, 'RGBA')
    for i in range(t):
        f = i / t
        td.line([0, i, t, i], fill=rgba(col, 0.26 * (1 - f) + 0.07 * f))
    td.rounded_rectangle([0, 0, t - 1, t - 1], 10 * S, outline=rgba(col, 0.32), width=max(1, int(0.9 * S)))
    icon(td, kind, t / 2, t / 2, t * 0.29, col + (255,), (0, 0, 0, 0))
    layer.alpha_composite(tile, (int(tx), int(ty)))

    # --- border, and the lit top bar on the chosen card
    bd = ImageDraw.Draw(layer, 'RGBA')
    bd.rounded_rectangle([0, 0, w - 1, h - 1], radius,
                         outline=rgba(col, 0.85) if active else BORDER, width=max(1, int(1.0 * S)))
    if active:
        bd.rounded_rectangle([12 * S, 0, w - 12 * S, 2 * S], 2 * S, fill=col + (255,))

    canvas.alpha_composite(layer, (x0, y0))

    # --- text, drawn opaque on the canvas so nothing is lost to blending
    d = ImageDraw.Draw(canvas, 'RGBA')
    nx = x0 + tx + t + 11 * S
    name_col = col if active else NAME
    d.text((nx, y0 + h * 0.30), name, font=F('DejaVuSans-Bold.ttf', 12.5), fill=name_col + (255,), anchor='lm')

    f_chip = F('DejaVuSans-Bold.ttf', 10.5)
    chip_w = d.textlength(grip, font=f_chip)
    cy = int(y0 + h * 0.66)
    chip = Image.new('RGBA', (int(chip_w + 14 * S), int(20 * S)), (0, 0, 0, 0))
    cd = ImageDraw.Draw(chip, 'RGBA')
    cd.rounded_rectangle([0, 0, chip.width - 1, chip.height - 1], 999, fill=rgba(col, 0.13),
                         outline=rgba(col, 0.28), width=max(1, int(0.9 * S)))
    canvas.alpha_composite(chip, (int(nx), cy - int(10 * S)))
    d = ImageDraw.Draw(canvas, 'RGBA')
    d.text((nx + 7 * S, cy), grip, font=f_chip, fill=col + (255,), anchor='lm')
    d.text((nx + chip.width + 7 * S, cy), desc, font=F('DejaVuSans.ttf', 11), fill=MUTED + (255,), anchor='lm')


def main():
    canvas = Image.new('RGBA', (W * S, H * S), PAGE_BG + (255,))
    d = ImageDraw.Draw(canvas, 'RGBA')
    d.text((24 * S, 26 * S), 'DYNAMIC WEATHER & SURFACE CONDITIONS',
           font=F('DejaVuSans-Bold.ttf', 15), fill=(240, 245, 252, 255), anchor='lm')

    margin, gap, top, ch = 24 * S, 10 * S, 56 * S, 66 * S
    cw = (W * S - 2 * margin - 3 * gap) / 4
    for i, wdata in enumerate(WEATHER):
        draw_card(canvas, margin + i * (cw + gap), top, cw, ch, wdata, i == 0)

    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'weather-row.png')
    canvas.convert('RGB').resize((W, H), Image.LANCZOS).save(out)
    print('wrote', out)


if __name__ == '__main__':
    main()
