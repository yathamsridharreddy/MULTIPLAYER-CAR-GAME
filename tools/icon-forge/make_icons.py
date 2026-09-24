#!/usr/bin/env python3
"""
SRIDHAR RUSH — icon forge.

Single source of truth for the site's icon set. Defines every icon as geometry,
then emits:
  * public/img/icons.svg          colour sprite  (<symbol id="i-NAME">)
  * public/img/icons-mono.svg     mono sprite    (<symbol id="m-NAME">, currentColor)
  * public/img/ico/<name>.svg     individual colour files (for <img> use)

It ALSO rasterises the same geometry to PNG so the art can actually be looked
at before it ships. This sandbox has no SVG rasteriser (no Chromium, no
ImageMagick SVG delegate, no cairosvg), so the preview is drawn by hand from
the identical primitives — what you see is what gets emitted.

Run:  python3 tools/icon-forge/make_icons.py [icon-name ...]
"""
import math, zlib, struct, os, sys

SS = 3                      # supersample factor for the preview raster
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))

# ---------------------------------------------------------------- geometry ---
def circle(cx, cy, r, n=48, ry=None):
    ry = r if ry is None else ry
    return [(cx + r * math.cos(2 * math.pi * i / n), cy + ry * math.sin(2 * math.pi * i / n)) for i in range(n)]

def rrect(x, y, w, h, r, n=8):
    pts = []
    for (cx, cy, a0) in ((x + r, y + r, math.pi), (x + w - r, y + r, 1.5 * math.pi),
                         (x + w - r, y + h - r, 0.0), (x + r, y + h - r, 0.5 * math.pi)):
        for i in range(n + 1):
            a = a0 + (math.pi / 2) * i / n
            pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return pts

def star(cx, cy, r_out, r_in, points=5, rot=-math.pi / 2):
    pts = []
    for i in range(points * 2):
        r = r_out if i % 2 == 0 else r_in
        a = rot + math.pi * i / points
        pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return pts


def crescent(cx, cy, rA, dx, rB, rot=0.0, n=48):
    """True crescent = the part of circle A that circle B (offset by dx) does not
    cover. Built from the two arcs joined at their intersection points, so the
    horns come out sharp instead of the blobby freehand polygon it replaced."""
    x = (dx * dx + rA * rA - rB * rB) / (2 * dx)
    y = math.sqrt(max(rA * rA - x * x, 1e-9))
    tA = math.atan2(y, x)
    tB = math.atan2(y, x - dx)
    pts = []
    spanA = (2 * math.pi - tA) - tA
    for i in range(n + 1):
        a = tA + spanA * i / n
        pts.append((cx + rA * math.cos(a), cy + rA * math.sin(a)))
    a0, a1 = 2 * math.pi - tB, tB
    spanB = a0 - a1
    for i in range(1, n):
        a = a0 - spanB * i / n
        pts.append((cx + dx + rB * math.cos(a), cy + rB * math.sin(a)))
    if rot:
        c, sn = math.cos(rot), math.sin(rot)
        pts = [(cx + (px - cx) * c - (py - cy) * sn, cy + (px - cx) * sn + (py - cy) * c) for (px, py) in pts]
    return pts

# --------------------------------------------------------------- icon model ---
def solid(h): return ('solid', h)
def lin(angle, stops): return ('lin', angle, stops)
def rad(cx, cy, r, stops): return ('rad', (cx, cy, r), stops)

ICONS = {}

def icon(name):
    def deco(fn):
        ICONS[name] = fn()
        return fn
    return deco

# 128x128 canvas; icon content roughly 6..126.

# ============================================================== GROUP A ======
@icon('nitro')
def _():
    outer = [(64, 8), (78, 34), (94, 46), (100, 68), (96, 92), (78, 112),
             (64, 118), (50, 112), (32, 92), (28, 68), (40, 42), (52, 30), (60, 20)]
    inner = [(64, 44), (74, 62), (82, 74), (80, 92), (64, 106), (48, 92), (46, 76), (56, 60)]
    core = [(64, 68), (70, 82), (64, 96), (58, 82)]
    return [
        dict(sub=[outer], fill=lin(90, [(0, '#ff3b30'), (.55, '#e01200'), (1, '#8c0a00')]), glow='#ff2d00'),
        dict(sub=[inner], fill=lin(90, [(0, '#ffd23f'), (.5, '#ff8c00'), (1, '#ff4d00')])),
        dict(sub=[core], fill=solid('#fff3c4')),
    ]

@icon('race-flag')
def _():
    pole = rrect(28, 22, 8, 96, 3)
    wave = []
    for i in range(13):
        t = i / 12
        wave.append((36 + 68 * t, 30 + 6 * math.sin(t * 3.1)))
    for i in range(12, -1, -1):
        t = i / 12
        wave.append((36 + 68 * t, 74 + 6 * math.sin(t * 3.1)))
    checks = [rrect(38 + col * 11.3, 31 + row * 21, 11.3, 20, 0)
              for row in range(2) for col in range(6) if (row + col) % 2 == 0]
    return [
        dict(sub=[pole], fill=lin(0, [(0, '#e8eefc'), (.5, '#9aa7bd'), (1, '#5c6880')]), glow='#8fd8ff'),
        dict(sub=[wave], fill=lin(90, [(0, '#f2f6ff'), (1, '#aab6cc')])),
        dict(sub=checks, fill=solid('#0b0d12')),
    ]

@icon('trophy')
def _():
    cup = [(38, 30), (90, 30), (86, 62), (80, 78), (64, 88), (48, 78), (42, 62)]
    stem = rrect(57, 86, 14, 16, 2)
    base = rrect(40, 100, 48, 12, 4)
    hl = rrect(28, 34, 12, 34, 6)
    hr = rrect(88, 34, 12, 34, 6)
    return [
        dict(sub=[hl, hr], fill=lin(0, [(0, '#ffe9a8'), (.5, '#e8b434'), (1, '#a97512')]), glow='#ffb300'),
        dict(sub=[cup], fill=lin(100, [(0, '#fff4cc'), (.35, '#ffd75e'), (.75, '#e0a51f'), (1, '#b8800f')]), glow='#ffb300'),
        dict(sub=[rrect(30, 30, 16, 40, 7), rrect(82, 30, 16, 40, 7)], fill=solid('#c8901a')),
        dict(sub=[stem, base], fill=lin(0, [(0, '#ffdf8a'), (.5, '#d9a32a'), (1, '#9c6f10')])),
        dict(sub=[star(64, 52, 15, 6.5)], fill=solid('#8a5d08')),
    ]

@icon('racing-car')
def _():
    body = [(16, 74), (16, 52), (26, 38), (40, 30), (50, 40), (58, 50), (76, 52), (86, 58),
            (106, 64), (124, 72), (126, 78), (110, 80), (58, 80)]
    rear_wing = rrect(8, 16, 44, 11, 3)
    endplate = rrect(6, 12, 11, 34, 3)
    pylon = [(24, 27), (34, 27), (34, 40), (24, 40)]
    cockpit = [(58, 44), (76, 47), (78, 55), (56, 53)]
    halo = [(52, 38), (82, 40), (82, 46), (52, 45)]
    front_wing = [(100, 80), (126, 86), (126, 92), (98, 90)]
    return [
        dict(sub=[endplate, rear_wing, pylon], fill=lin(0, [(0, '#bff4ff'), (.6, '#4fb8e8'), (1, '#1b7fb5')]), glow='#00d0ff'),
        dict(sub=[body], fill=lin(90, [(0, '#eaffff'), (.45, '#7fdcff'), (1, '#1b7fb5')]), glow='#00d0ff'),
        dict(sub=[cockpit], fill=solid('#0d2b3d')),
        dict(sub=[halo], fill=solid('#2b3a4d')),
        dict(sub=[front_wing], fill=lin(0, [(0, '#d7f4ff'), (1, '#2b8fc0')])),
        dict(sub=[circle(40, 78, 22, 44)], fill=solid('#0b0d12')),
        dict(sub=[circle(106, 76, 18, 44)], fill=solid('#0b0d12')),
        dict(sub=[circle(40, 78, 10, 32)], fill=lin(0, [(0, '#e8eefc'), (1, '#7c8595')])),
        dict(sub=[circle(106, 76, 8, 32)], fill=lin(0, [(0, '#e8eefc'), (1, '#7c8595')])),
    ]

@icon('helmet')
def _():
    shell = [(64, 10), (96, 18), (112, 42), (114, 72), (102, 92), (82, 102), (46, 102), (26, 92), (14, 72), (16, 42), (32, 18)]
    visor = rrect(20, 44, 88, 26, 13)
    chin = rrect(44, 64, 40, 24, 10)
    return [
        dict(sub=[shell], fill=lin(90, [(0, '#ffffff'), (.45, '#dbe9f7'), (1, '#7f96ad')]), glow='#8fd8ff'),
        dict(sub=[rrect(54, 16, 20, 8, 3)], fill=solid('#9fb0c8')),
        dict(sub=[visor], fill=lin(0, [(0, '#123449'), (.5, '#071726'), (1, '#0d2b3d')])),
        dict(sub=[chin], fill=lin(90, [(0, '#f2f7ff'), (1, '#93a6bd')])),
        dict(sub=[rrect(54 + i * 7, 78, 4, 12, 1.5) for i in range(3)], fill=solid('#31404f')),
    ]

@icon('stopwatch')
def _():
    ring = circle(64, 70, 46, 64)
    inner = circle(64, 70, 35, 64)
    ticks = [rrect(62 + 26 * math.cos(a) - 2, 70 + 26 * math.sin(a) - 2, 4, 4, 1)
             for a in [math.pi + i * math.pi / 5 for i in range(6)]]
    hand = [(60, 70), (64, 44), (68, 70)]
    return [
        dict(sub=[rrect(56, 4, 16, 14, 4), rrect(60, 16, 8, 8, 2)], fill=solid('#9fb0c8')),
        dict(sub=[ring, inner], fill=lin(90, [(0, '#ffffff'), (.5, '#a9d8f0'), (1, '#4f9dc4')]), glow='#00d0ff'),
        dict(sub=[circle(64, 70, 34, 64)], fill=solid('#0d1b28')),
        dict(sub=ticks, fill=solid('#7f96ad')),
        dict(sub=[hand], fill=solid('#7fe3ff')),
        dict(sub=[circle(64, 70, 5)], fill=solid('#ffffff')),
    ]

@icon('ghost')
def _():
    body = [(64, 14), (94, 26), (106, 56), (106, 100), (94, 110), (84, 98), (74, 110),
            (54, 110), (44, 98), (34, 110), (22, 100), (22, 56), (34, 26)]
    eyes = [circle(50, 56, 9, 24, 11), circle(78, 56, 9, 24, 11)]
    pupils = [circle(50, 58, 4.2), circle(78, 58, 4.2)]
    return [
        dict(sub=[body], fill=lin(90, [(0, '#ffffff'), (.55, '#e2ecf9'), (1, '#9fb2c8')]), glow='#8fd8ff'),
        dict(sub=eyes, fill=solid('#0b0d12')),
        dict(sub=pupils, fill=solid('#7fe3ff')),
    ]

@icon('target')
def _():
    arrow = [(96, 32), (104, 24), (110, 46), (86, 22), (108, 16), (104, 22)]
    tip = [(84, 44), (92, 52), (72, 72), (60, 60)]
    return [
        dict(sub=[circle(64, 64, 56), circle(64, 64, 48)], fill=solid('#ff2d00'), glow='#ff2d00'),
        dict(sub=[circle(64, 64, 48), circle(64, 64, 34)], fill=solid('#ffffff')),
        dict(sub=[circle(64, 64, 34), circle(64, 64, 20)], fill=solid('#ff2d00')),
        dict(sub=[circle(64, 64, 20)], fill=solid('#ffffff')),
        dict(sub=[tip], fill=lin(0, [(0, '#ffffff'), (1, '#b9c6d8')])),
        dict(sub=[arrow], fill=solid('#ffcf3f')),
    ]

@icon('swords')
def _():
    b1 = [(30, 22), (40, 26), (98, 84), (88, 94), (30, 36)]
    b2 = [(98, 22), (88, 26), (30, 84), (40, 94), (98, 36)]
    g1 = rrect(18, 78, 32, 11, 3)
    g2 = rrect(78, 78, 32, 11, 3)
    h1 = [(14, 108), (26, 96), (36, 106), (24, 118)]
    h2 = [(114, 108), (102, 96), (92, 106), (104, 118)]
    return [
        dict(sub=[b1], fill=lin(45, [(0, '#ffffff'), (.5, '#c3cfe0'), (1, '#6b7788')]), glow='#8fd8ff'),
        dict(sub=[b2], fill=lin(135, [(0, '#ffffff'), (.5, '#c3cfe0'), (1, '#6b7788')]), glow='#8fd8ff'),
        dict(sub=[g1, g2], fill=lin(0, [(0, '#ffe9a8'), (1, '#c08c14')])),
        dict(sub=[h1, h2], fill=solid('#3f4a5c')),
    ]

@icon('crown')
def _():
    body = [(16, 96), (24, 40), (44, 62), (64, 26), (84, 62), (104, 40), (112, 96)]
    return [
        dict(sub=[body], fill=lin(90, [(0, '#fff3c4'), (.4, '#ffd75e'), (1, '#c8901a')]), glow='#ffb300'),
        dict(sub=[rrect(16, 88, 96, 16, 4)], fill=lin(0, [(0, '#ffe9a8'), (1, '#b8800f')])),
        dict(sub=[circle(24, 36, 8), circle(64, 20, 9), circle(104, 36, 8)], fill=solid('#ffffff')),
        dict(sub=[circle(46, 96, 5), circle(64, 96, 5), circle(82, 96, 5)], fill=solid('#ff2d00')),
    ]

# ============================================================== GROUP B ======
@icon('camera')
def _():
    return [
        dict(sub=[rrect(12, 38, 78, 56, 12)], fill=lin(90, [(0, '#ffffff'), (.5, '#cfe3f5'), (1, '#7f96ad')]), glow='#00d0ff'),
        dict(sub=[[(92, 58), (118, 44), (118, 90), (92, 76)]], fill=lin(0, [(0, '#bfeaff'), (1, '#3f9fd0')])),
        dict(sub=[circle(51, 66, 15)], fill=solid('#0d2b3d')),
        dict(sub=[circle(51, 66, 7)], fill=solid('#7fe3ff')),
    ]

@icon('steering-wheel')
def _():
    return [
        dict(sub=[circle(64, 64, 52, 64), circle(64, 64, 39, 64)],
             fill=lin(90, [(0, '#ffffff'), (.5, '#c3cfe0'), (1, '#6b7788')]), glow='#8fd8ff'),
        dict(sub=[[(26, 56), (58, 56), (58, 72), (26, 72)],
                  [(70, 56), (102, 56), (102, 72), (70, 72)],
                  [(56, 60), (72, 60), (72, 100), (56, 100)]],
             fill=lin(90, [(0, '#e8eefc'), (1, '#8f9cb0')])),
        dict(sub=[circle(64, 64, 17, 32)], fill=lin(90, [(0, '#ffffff'), (1, '#93a2b8')])),
        dict(sub=[circle(64, 64, 7)], fill=solid('#31404f')),
    ]

@icon('gamepad')
def _():
    dpad = [rrect(26, 56, 26, 9, 3), rrect(34, 48, 9, 26, 3)]
    btn = [circle(88, 54, 6.5), circle(102, 66, 6.5), circle(88, 78, 6.5), circle(74, 66, 6.5)]
    return [
        dict(sub=[rrect(8, 40, 112, 54, 22)], fill=lin(90, [(0, '#ffffff'), (.5, '#cfe3f5'), (1, '#7f96ad')]), glow='#00d0ff'),
        dict(sub=dpad, fill=solid('#31404f')),
        dict(sub=btn, fill=solid('#00a8d6')),
    ]

# explicit chevron geometry (rotation maths inverted the directions - do not go back)
@icon('arrow-up')
def _():
    return [dict(sub=[[(30, 50), (64, 16), (98, 50), (98, 68), (64, 34), (30, 68)]],
                 fill=lin(0, [(0, '#eaffff'), (1, '#3f9fd0')]), glow='#00d0ff'),
            dict(sub=[[(30, 94), (64, 60), (98, 94), (98, 112), (64, 78), (30, 112)]],
                 fill=lin(0, [(0, '#eaffff'), (1, '#3f9fd0')]), glow='#00d0ff')]

@icon('arrow-down')
def _():
    return [dict(sub=[[(30, 78), (64, 112), (98, 78), (98, 60), (64, 94), (30, 60)]],
                 fill=lin(0, [(0, '#3f9fd0'), (1, '#eaffff')]), glow='#00d0ff'),
            dict(sub=[[(30, 34), (64, 68), (98, 34), (98, 16), (64, 50), (30, 16)]],
                 fill=lin(0, [(0, '#3f9fd0'), (1, '#eaffff')]), glow='#00d0ff')]

@icon('arrow-left')
def _():
    return [dict(sub=[[(50, 98), (16, 64), (50, 30), (68, 30), (34, 64), (68, 98)]],
                 fill=lin(0, [(0, '#eaffff'), (1, '#3f9fd0')]), glow='#00d0ff'),
            dict(sub=[[(94, 98), (60, 64), (94, 30), (112, 30), (78, 64), (112, 98)]],
                 fill=lin(0, [(0, '#eaffff'), (1, '#3f9fd0')]), glow='#00d0ff')]

@icon('arrow-right')
def _():
    return [dict(sub=[[(78, 30), (112, 64), (78, 98), (60, 98), (94, 64), (60, 30)]],
                 fill=lin(0, [(0, '#3f9fd0'), (1, '#eaffff')]), glow='#00d0ff'),
            dict(sub=[[(34, 30), (68, 64), (34, 98), (16, 98), (50, 64), (16, 30)]],
                 fill=lin(0, [(0, '#3f9fd0'), (1, '#eaffff')]), glow='#00d0ff')]

@icon('brake')
def _():
    holes = [circle(60 + 20 * math.cos(a), 66 + 20 * math.sin(a), 4.5)
             for a in [i * math.pi / 4 for i in range(8)]]
    return [
        dict(sub=[rrect(88, 22, 30, 52, 12)], fill=lin(0, [(0, '#ff6b5e'), (1, '#b3140a')]), glow='#ff2d00'),
        dict(sub=[circle(60, 66, 44), circle(60, 66, 30)], fill=lin(90, [(0, '#f4f8ff'), (.5, '#b9c6d8'), (1, '#6b7788')]), glow='#8fd8ff'),
        dict(sub=[circle(60, 66, 30)], fill=solid('#2a3546')),
        dict(sub=[circle(60, 66, 12)], fill=lin(0, [(0, '#dfe9f7'), (1, '#8f9cb0')])),
        dict(sub=holes, fill=solid('#1a2230')),
    ]

@icon('speedometer')
def _():
    ticks = [rrect(62 + 34 * math.cos(a) - 2, 64 + 34 * math.sin(a) - 2, 4, 4, 1)
             for a in [math.pi + i * math.pi / 6 for i in range(7)]]
    return [
        dict(sub=[circle(64, 64, 50, 64), circle(64, 64, 26, 64)],
             fill=lin(90, [(0, '#ffd7d2'), (.35, '#ff4a3a'), (1, '#b3140a')]), glow='#ff2d00'),
        dict(sub=[circle(64, 64, 30, 64)], fill=solid('#0d1b28')),
        dict(sub=ticks, fill=solid('#e8eefc')),
        dict(sub=[[(60, 64), (100, 40), (66, 68)]], fill=solid('#ff7a6b')),
        dict(sub=[circle(64, 64, 6)], fill=solid('#ffffff')),
    ]

@icon('refresh')
def _():
    return [
        dict(sub=[circle(64, 64, 44, 60), circle(64, 64, 32, 60)],
             fill=lin(90, [(0, '#eaffff'), (.5, '#4fb8e8'), (1, '#1b7fb5')]), glow='#00d0ff'),
        dict(sub=[[(86, 20), (112, 34), (84, 48)]], fill=lin(0, [(0, '#bfeaff'), (1, '#3f9fd0')]), glow='#00d0ff'),
    ]

@icon('warning')
def _():
    return [
        dict(sub=[[(64, 12), (120, 108), (8, 108)]], fill=lin(90, [(0, '#ff8a7e'), (.4, '#ff3b30'), (1, '#8c0a00')]), glow='#ff2d00'),
        dict(sub=[[(64, 30), (106, 100), (22, 100)]], fill=lin(90, [(0, '#ff4b40'), (1, '#c00e02')])),
        dict(sub=[rrect(59, 46, 10, 34, 4)], fill=solid('#ffffff')),
        dict(sub=[circle(64, 90, 6)], fill=solid('#ffffff')),
    ]

@icon('fullscreen')
def _():
    def corner(sx, sy):
        x0 = 16 if sx < 0 else 70
        y0 = 16 if sy < 0 else 70
        return [rrect(x0, y0, 42, 12, 2), rrect(x0, y0, 12, 42, 2)]
    return [dict(sub=corner(-1, -1) + corner(1, -1) + corner(-1, 1) + corner(1, 1),
                 fill=lin(90, [(0, '#d7f4ff'), (.5, '#3f9fd0'), (1, '#14506e')]), glow='#00d0ff')]

@icon('vibrate')
def _():
    return [
        dict(sub=[rrect(44, 20, 40, 88, 9)], fill=lin(90, [(0, '#ffffff'), (.5, '#cfe3f5'), (1, '#7f96ad')]), glow='#00d0ff'),
        dict(sub=[rrect(49, 28, 30, 70, 5)], fill=solid('#0d2b3d')),
        dict(sub=[rrect(20, 48, 8, 32, 4), rrect(30, 40, 6, 48, 3),
                  rrect(100, 48, 8, 32, 4), rrect(92, 40, 6, 48, 3)],
             fill=lin(0, [(0, '#bff4ff'), (1, '#2b8fc0')])),
    ]

@icon('flag-start')
def _():
    checks = [rrect(34 + col * 19, 21 + row * 22, 19, 22, 0)
              for row in range(2) for col in range(4) if (row + col) % 2 == 0]
    return [
        dict(sub=[rrect(26, 16, 8, 100, 3)], fill=lin(0, [(0, '#e8eefc'), (.5, '#9aa7bd'), (1, '#5c6880')]), glow='#8fd8ff'),
        dict(sub=[[(34, 24), (110, 18), (110, 62), (34, 70)]], fill=lin(0, [(0, '#ffffff'), (1, '#aab6cc')])),
        dict(sub=checks, fill=solid('#0b0d12')),
    ]


# ============================================================== WEATHER ======
@icon('weather-sun')
def _():
    rays = []
    for i in range(8):
        a = math.pi * i / 4
        rays.append([(64 + 30 * math.cos(a) - 5 * math.sin(a), 64 + 30 * math.sin(a) + 5 * math.cos(a)),
                     (64 + 46 * math.cos(a) - 5 * math.sin(a), 64 + 46 * math.sin(a) + 5 * math.cos(a)),
                     (64 + 46 * math.cos(a) + 5 * math.sin(a), 64 + 46 * math.sin(a) - 5 * math.cos(a)),
                     (64 + 30 * math.cos(a) + 5 * math.sin(a), 64 + 30 * math.sin(a) - 5 * math.cos(a))])
    return [
        dict(sub=rays, fill=lin(90, [(0, '#ffe07a'), (.5, '#ffb300'), (1, '#e07b00')]), glow='#ffb300'),
        dict(sub=[circle(64, 64, 30, 48)], fill=lin(90, [(0, '#fff6cc'), (.5, '#ffcf3f'), (1, '#e08c00')])),
    ]

@icon('weather-rain')
def _():
    cloud = [(30, 60), (38, 42), (58, 34), (78, 38), (92, 48), (96, 60), (100, 70), (92, 78), (30, 78), (20, 70), (22, 62)]
    drops = []
    for i, x in enumerate((36, 54, 72, 90)):
        y = 92 + (7 if i % 2 else 0)
        drops.append([(x, y + 20), (x - 7.5, y), (x + 7.5, y)])
        drops.append(circle(x, y, 7.5, 20))
    return [
        dict(sub=[cloud], fill=lin(90, [(0, '#ffffff'), (.5, '#d5e3f2'), (1, '#93a6bd')]), glow='#8fd8ff'),
        dict(sub=drops, fill=lin(90, [(0, '#7fe3ff'), (1, '#1b7fb5')]), glow='#00d0ff'),
    ]

@icon('weather-snow')
def _():
    arms = []
    for i in range(3):
        a = math.pi * i / 3
        arms.append([(64 - 42 * math.cos(a), 64 - 42 * math.sin(a)),
                     (64 + 42 * math.cos(a), 64 + 42 * math.sin(a)),
                     (64 + 42 * math.cos(a) + 5 * math.sin(a), 64 + 42 * math.sin(a) - 5 * math.cos(a)),
                     (64 - 42 * math.cos(a) + 5 * math.sin(a), 64 - 42 * math.sin(a) - 5 * math.cos(a))])
    twigs = []
    for i in range(6):
        a = math.pi * i / 3
        for r in (24, 34):
            bx, by = 64 + r * math.cos(a), 64 + r * math.sin(a)
            for da in (0.6, -0.6):
                twigs.append([(bx, by), (bx + 13 * math.cos(a + da), by + 13 * math.sin(a + da)),
                              (bx + 13 * math.cos(a + da) + 4 * math.cos(a + da - 0.3),
                               by + 13 * math.sin(a + da) + 4 * math.sin(a + da - 0.3)),
                              (bx + 4 * math.cos(a - 0.3), by + 4 * math.sin(a - 0.3))])
    return [
        dict(sub=arms, fill=lin(90, [(0, '#eaffff'), (.5, '#7fe3ff'), (1, '#2391c4')]), glow='#00d0ff'),
        dict(sub=twigs, fill=solid('#7fe3ff')),
        dict(sub=[circle(64, 64, 9, 24)], fill=solid('#ffffff')),
    ]

@icon('weather-night')
def _():
    moon = crescent(70, 64, 46, 30, 44, rot=-0.55)
    spark = [(16, 18), (21, 28), (31, 33), (21, 38), (16, 48), (11, 38), (1, 33), (11, 28)]
    return [
        dict(sub=[circle(44, 12, 3.5), circle(10, 58, 3), circle(30, 66, 2.5)], fill=solid('#e8eefc')),
        dict(sub=[moon], fill=lin(45, [(0, '#ffffff'), (.45, '#cfe0f5'), (1, '#7f96ad')]), glow='#8fd8ff'),
        dict(sub=[spark], fill=solid('#ffffff')),
    ]

# ------------------------------------------------------------- rasteriser ---
def hx(h):
    h = h.lstrip('#')
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))

def _grad(fill, x, y):
    if fill[0] == 'solid':
        return hx(fill[1])
    if fill[0] == 'lin':
        ang, stops = fill[1], fill[2]
        a = math.radians(ang)
        # matches the emitted SVG exactly: userSpaceOnUse A=64-d B=64+d
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
            c0, c1 = hx(prev[1]), hx(cur[1])
            return tuple(int(c0[j] + (c1[j] - c0[j]) * k) for j in range(3))
        prev = cur
    return hx(stops[-1][1])

def render(layers, size=128, ss=SS):
    W = size * ss
    buf = [[(0.0, 0.0, 0.0, 0.0) for _ in range(W)] for _ in range(W)]
    for L in layers:
        if not L.get('glow'):
            continue
        g = hx(L['glow'])
        pts = [p for sp in L['sub'] for p in sp]
        cx = sum(p[0] for p in pts) / len(pts)
        cy = sum(p[1] for p in pts) / len(pts)
        y0g = max(0, int((cy - 62) * ss)); y1g = min(W, int((cy + 62) * ss) + 1)
        x0g = max(0, int((cx - 62) * ss)); x1g = min(W, int((cx + 62) * ss) + 1)
        for y in range(y0g, y1g):
            dy = (y + 0.5) / ss - cy
            for x in range(x0g, x1g):
                dx = (x + 0.5) / ss - cx
                d = math.hypot(dx, dy)
                if d > 62:
                    continue
                a = max(0.0, 1.0 - d / 62.0) ** 2.2 * 0.30
                if a <= 0.002:
                    continue
                r0, g0, b0, a0 = buf[y][x]
                na = a + a0 * (1 - a)
                if na <= 0:
                    continue
                buf[y][x] = ((g[0] * a + r0 * a0 * (1 - a)) / na,
                             (g[1] * a + g0 * a0 * (1 - a)) / na,
                             (g[2] * a + b0 * a0 * (1 - a)) / na, na)
    for L in layers:
        fill = L['fill']
        edges = []
        for sp in L['sub']:
            n = len(sp)
            for i in range(n):
                x0, y0 = sp[i]
                x1, y1 = sp[(i + 1) % n]
                if y0 != y1:
                    edges.append((x0 * ss, y0 * ss, x1 * ss, y1 * ss))
        if not edges:
            continue
        ymin = max(0, int(min(min(e[1], e[3]) for e in edges)))
        ymax = min(W - 1, int(max(max(e[1], e[3]) for e in edges)) + 1)
        for y in range(ymin, ymax + 1):
            yc = y + 0.5
            xs = []
            for (x0, y0, x1, y1) in edges:
                if (y0 <= yc < y1) or (y1 <= yc < y0):
                    xs.append(x0 + (yc - y0) * (x1 - x0) / (y1 - y0))
            if len(xs) < 2:
                continue
            xs.sort()
            row = buf[y]
            for i in range(0, len(xs) - 1, 2):
                xa, xb = xs[i], xs[i + 1]
                if xb <= xa:
                    continue
                for x in range(max(0, int(math.ceil(xa - 0.5))), min(W - 1, int(math.floor(xb - 0.5))) + 1):
                    r, g, b = _grad(fill, (x + 0.5) / ss, (y + 0.5) / ss)
                    row[x] = (r, g, b, 1.0)
    out = []
    for y in range(size):
        row = []
        for x in range(size):
            sr = sg = sb = sa = 0.0
            for j in range(ss):
                for i in range(ss):
                    r, g, b, a = buf[y * ss + j][x * ss + i]
                    sr += r; sg += g; sb += b; sa += a
            n = ss * ss
            row.append((int(sr / n), int(sg / n), int(sb / n), int(255 * sa / n)))
        out.append(row)
    return out

def write_png(path, px):
    h = len(px); w = len(px[0])
    raw = b''
    for row in px:
        raw += b'\x00' + b''.join(struct.pack('BBB', r, g, b) for (r, g, b, a) in row)
    def chunk(t, d):
        c = struct.pack('>I', len(d)) + t + d
        return c + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    png = b'\x89PNG\r\n\x1a\n'
    png += chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress(raw, 9))
    png += chunk(b'IEND', b'')
    open(path, 'wb').write(png)

# ------------------------------------------------------------- SVG emitter ---
def _path(sp):
    return "M" + " L".join("%s,%s" % (round(x, 2), round(y, 2)) for (x, y) in sp) + " Z"

def _grad_def(gid, fill):
    if fill[0] == 'solid':
        return None, fill[1]
    if fill[0] == 'lin':
        ang, stops = fill[1], fill[2]
        a = math.radians(ang)
        dx, dy = math.cos(a) * 64, math.sin(a) * 64
        s = ('<linearGradient id="%s" x1="%g" y1="%g" x2="%g" y2="%g" gradientUnits="userSpaceOnUse">'
             % (gid, 64 - dx, 64 - dy, 64 + dx, 64 + dy))
    else:
        (cx, cy, r), stops = fill[1], fill[2]
        s = ('<radialGradient id="%s" cx="%g" cy="%g" r="%g" gradientUnits="userSpaceOnUse">'
             % (gid, cx, cy, r))
    for (pos, col) in stops:
        s += '<stop offset="%g" stop-color="%s"/>' % (pos, col)
    return s + ('</linearGradient>' if fill[0] == 'lin' else '</radialGradient>'), None

def icon_svg(name, layers, indent='  '):
    defs, body = [], []
    for i, L in enumerate(layers):
        gid = '%s-g%d' % (name, i)
        d, flat = _grad_def(gid, L['fill'])
        if d:
            defs.append(d)
            paint = 'url(#%s)' % gid
        else:
            paint = flat
        filt = ''
        if L.get('glow'):
            fid = '%s-f%d' % (name, i)
            defs.append('<filter id="%s" x="-40%%" y="-40%%" width="180%%" height="180%%">'
                        '<feDropShadow dx="0" dy="0" stdDeviation="5" flood-color="%s" flood-opacity="0.9"/>'
                        '</filter>' % (fid, L['glow']))
            filt = ' filter="url(#%s)"' % fid
        body.append('%s<path d="%s" fill="%s"%s/>'
                    % (indent, " ".join(_path(sp) for sp in L['sub']), paint, filt))
    return "\n".join(['<defs>'] + [indent + d for d in defs] + ['</defs>'] + body)

def _lum(fill):
    """mean luminance - drives the mono opacity so ONE css colour keeps depth."""
    stops = fill[2] if fill[0] != 'solid' else [(0, fill[1])]
    tot = 0.0
    for (_, col) in stops:
        r, g, b = hx(col)
        tot += (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255.0
    return tot / max(len(stops), 1)

def mono_svg(name, layers, indent='  '):
    body = []
    for L in layers:
        op = max(0.16, min(1.0, 0.14 + 0.92 * _lum(L['fill'])))
        opattr = '' if op > 0.985 else ' opacity="%.2f"' % op
        body.append('%s<path d="%s" fill="currentColor"%s/>'
                    % (indent, " ".join(_path(sp) for sp in L['sub']), opattr))
    return "\n".join(body)

HEAD = '<!-- SRIDHAR RUSH icon - generated by tools/icon-forge/make_icons.py. Do not edit by hand. -->\n'
_SVG_OPEN = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128">'

def write_assets(pubdir):
    """Colour icons -> img/ico/<name>.svg      (used with <img>, full gradient art)
       Mono icons   -> img/ico-mono/<name>.svg (used as a CSS mask, tinted by color)"""
    cdir = os.path.join(pubdir, 'ico')
    mdir = os.path.join(pubdir, 'ico-mono')
    os.makedirs(cdir, exist_ok=True)
    os.makedirs(mdir, exist_ok=True)
    ctot = mtot = 0
    for name, layers in ICONS.items():
        c = HEAD + _SVG_OPEN + "\n" + icon_svg(name, layers, indent='  ') + "\n</svg>\n"
        m = HEAD + _SVG_OPEN + "\n" + mono_svg(name, layers, indent='  ') + "\n</svg>\n"
        open(os.path.join(cdir, '%s.svg' % name), 'w').write(c)
        open(os.path.join(mdir, '%s.svg' % name), 'w').write(m)
        ctot += len(c); mtot += len(m)
    return len(ICONS), ctot, mtot

def preview(names=None, path=None, cell=128, pad=12, cols=6):
    names = names or list(ICONS.keys())
    rows = (len(names) + cols - 1) // cols
    W = cols * (cell + pad) + pad
    H = rows * (cell + pad) + pad
    sheet = [[(10, 13, 20, 255) for _ in range(W)] for _ in range(H)]
    for idx, name in enumerate(names):
        px = render(ICONS[name], size=cell, ss=SS if cell >= 128 else 2)
        cx = pad + (idx % cols) * (cell + pad)
        cy = pad + (idx // cols) * (cell + pad)
        for y in range(cell):
            for x in range(cell):
                r, g, b, a = px[y][x]
                bg = sheet[cy + y][cx + x]
                af = a / 255.0
                sheet[cy + y][cx + x] = (int(r * af + bg[0] * (1 - af)),
                                         int(g * af + bg[1] * (1 - af)),
                                         int(b * af + bg[2] * (1 - af)), 255)
    write_png(path, sheet)
    return path

if __name__ == '__main__':
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    pub = os.path.join(ROOT, 'public', 'img')
    n, csz, msz = write_assets(pub)
    print('emitted %d icons -> %s' % (n, pub))
    print('  img/ico/      %d files totalling %6.1f KB' % (n, csz / 1024))
    print('  img/ico-mono/ %d files totalling %6.1f KB' % (n, msz / 1024))
    out = os.path.join(ROOT, 'tools', 'icon-forge', 'preview')
    os.makedirs(out, exist_ok=True)
    p = preview(args or None, os.path.join(out, 'sheet.png'))
    print('  preview -> %s' % p)
