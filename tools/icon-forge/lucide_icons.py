#!/usr/bin/env python3
"""SRIDHAR RUSH — Lucide bridge for the generic half of the icon set.

The identity icons (car, flag, helmet, nitro, speedometer, steering wheel, trophy,
crown, swords, ghost, target, stopwatch, weather) are drawn in
tools/icon-forge/make_icons.py as geometry, because they are the site's own
language. The GENERIC icons (gear, globe, user, chart, mute, plus, key, ...) are
not worth redrawing badly, so they come from Lucide - ISC licensed, credited in
ASSETS-CREDITS.md and below - and are re-emitted here in exactly the house format:

  * public/img/ico-mono/<name>.svg   same 128 viewBox, stroke=currentColor, used
                                     as a CSS mask and tinted by `color`
  * public/img/ico/<name>.svg       same 128 viewBox, gradient stroke + glow,
                                     used through <img class="ico-img">

Lucide draws on a 24 grid with a 2-unit stroke. Everything is scaled onto our 128
grid by a single transform, so the geometry is Lucide's own - not redrawn, not
guessed at - and only the weight is tuned to sit beside the filled house icons.

Run:  python3 tools/icon-forge/lucide_icons.py [name ...]
"""
import os
import re
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
LUCIDE = '/tmp/lucide/node_modules/lucide-static/icons'

# --- how the 24 grid maps onto our 128 canvas ---------------------------------
# Content is scaled to leave the same breathing room the house icons have, and the
# stroke is thickened a touch so a line icon does not read thin next to a filled one.
SCALE = 4.70
T = (128 - 24 * SCALE) / 2          # centre the 24 grid in the canvas
STROKE = 2.75                       # local units, i.e. ~0.10em on screen

# --- palette per family, matching the house gradients -------------------------
CYAN = ('#bff2ff', '#00d5ff', '#0077a8')
GOLD = ('#fff4cc', '#ffc93c', '#a97512')
RED = ('#ffd0c4', '#ff4d2e', '#8c1400')
PURPLE = ('#e8d6ff', '#a855f7', '#5b21b6')
GREEN = ('#c8ffe4', '#00d97e', '#066b41')
SLATE = ('#eef4ff', '#9fb2cc', '#4a5972')

GLOW = {CYAN: '#00d5ff', GOLD: '#ffb300', RED: '#ff3b1f', PURPLE: '#a855f7',
        GREEN: '#00d97e', SLATE: '#8fb4ff'}

# --- our name -> (lucide file, palette) --------------------------------------
LUCIDE_MAP = {
    # chrome actions
    'bolt': ('zap', RED),
    'star': ('star', GOLD),
    'moon': ('moon', PURPLE),
    'heart': ('heart', RED),
    'trending-up': ('trending-up', GREEN),
    'diamond': ('gem', PURPLE),
    'exit': ('log-out', SLATE),
    'share': ('share-2', CYAN),
    'copy': ('copy', SLATE),
    'video': ('video', CYAN),
    'image': ('image', CYAN),
    'camera-plus': ('camera', CYAN),
    'book': ('book-open', CYAN),
    'plus': ('plus', GREEN),
    'key': ('key-round', GOLD),
    'install': ('download', CYAN),
    'globe': ('globe', CYAN),
    'chat': ('message-circle', GREEN),
    'send': ('send', CYAN),
    'mail': ('mail', CYAN),
    'monitor': ('monitor', CYAN),
    'map': ('map', CYAN),
    'calendar': ('calendar-days', CYAN),
    'copy-check': ('clipboard-check', GREEN),
    'arrow-right-circle': ('circle-arrow-right', CYAN),
    # identity / profile
    'user': ('user', CYAN),
    'users': ('users', CYAN),
    'chart': ('chart-no-axes-column', CYAN),
    'gear': ('settings', SLATE),
    'lock': ('lock', GOLD),
    'shield': ('shield-check', CYAN),
    # progression / reward
    'medal': ('medal', GOLD),
    'coin': ('coins', GOLD),
    'gift': ('gift', GOLD),
    'flame': ('flame', RED),
    'rocket': ('rocket', RED),
    'check': ('check', GREEN),
    # settings toggles
    'mute': ('volume-x', SLATE),
    'music': ('music', PURPLE),
    'sparkle': ('sparkles', PURPLE),
    'palette': ('palette', PURPLE),
    'bulb': ('lightbulb', PURPLE),
    'pause': ('pause', PURPLE),
    'wind': ('wind', PURPLE),
    'gauge': ('gauge', CYAN),
    # states
    'x': ('x', RED),
    'dot': ('circle', GOLD),
    'phone': ('smartphone', CYAN),
    'trophy-plus': ('trophy', GOLD),
    'keyboard': ('keyboard', SLATE),
    'eye': ('eye', CYAN),
    'search': ('search', CYAN),
    'clock': ('clock', CYAN),
    'compass': ('compass', CYAN),
    'list': ('list', CYAN),
    'loader': ('loader-circle', CYAN),
    'wifi': ('wifi', GREEN),
    'arrow-up-right': ('arrow-up-right', CYAN),
    'user-plus': ('user-plus', GREEN),
    'refresh-cw': ('refresh-cw', CYAN),
    'shirt': ('shirt', PURPLE),
    'crown-plus': ('crown', GOLD),
    'route': ('route', CYAN),
    'sliders': ('sliders-horizontal', SLATE),
    'terminal': ('square-terminal', SLATE),
    'hourglass': ('hourglass', GOLD),
    'swords-plus': ('swords', SLATE),
    'ban': ('ban', RED),
    'piggy': ('piggy-bank', GOLD),
    'handshake': ('handshake', GREEN),
    'ticket': ('ticket', PURPLE),
    'megaphone': ('megaphone', RED),
}

HEAD = ('<!-- SRIDHAR RUSH icon - Lucide geometry (ISC), re-emitted on the house 128 grid\n'
        '     by tools/icon-forge/lucide_icons.py. Lucide: https://lucide.dev (ISC). -->\n')
SVG_OPEN = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128">'


def lucide_inner(name):
    """the <path>/<circle>/<line>/... markup between <svg> and </svg>"""
    path = os.path.join(LUCIDE, name + '.svg')
    src = open(path).read()
    body = src[src.index('>', src.index('<svg')) + 1:src.rindex('</svg>')]
    body = re.sub(r'<!--.*?-->', '', body, flags=re.S)
    return body.strip()


def grad_def(gid, stops):
    return ('<linearGradient id="%s" x1="4" y1="3" x2="20" y2="21" gradientUnits="userSpaceOnUse">'
            '<stop offset="0" stop-color="%s"/><stop offset="0.5" stop-color="%s"/>'
            '<stop offset="1" stop-color="%s"/></linearGradient>' % ((gid,) + stops))


def emit(name, lucide, palette):
    inner = lucide_inner(lucide)
    gid, fid = '%s-g0' % name, '%s-f0' % name
    t = 'translate(%.4f %.4f) scale(%.4f)' % (T, T, SCALE)

    mono = (HEAD + SVG_OPEN + '\n'
            '  <g transform="%s" fill="none" stroke="currentColor" stroke-width="%.2f"\n'
            '     stroke-linecap="round" stroke-linejoin="round" opacity="0.86">\n'
            '    %s\n  </g>\n</svg>\n'
            % (t, STROKE, inner))

    colour = (HEAD + SVG_OPEN + '\n'
              '<defs>\n'
              '  %s\n'
              '  <filter id="%s" x="-40%%" y="-40%%" width="180%%" height="180%%">'
              '<feDropShadow dx="0" dy="0" stdDeviation="5" flood-color="%s" flood-opacity="0.9"/></filter>\n'
              '</defs>\n'
              '  <g transform="%s" fill="none" stroke="url(#%s)" stroke-width="%.2f"\n'
              '     stroke-linecap="round" stroke-linejoin="round" filter="url(#%s)">\n'
              '    %s\n  </g>\n</svg>\n'
              % (grad_def(gid, palette), fid, GLOW[palette], t, gid, STROKE, fid, inner))
    return mono, colour


def write_all(names=None):
    cdir = os.path.join(ROOT, 'public', 'img', 'ico')
    mdir = os.path.join(ROOT, 'public', 'img', 'ico-mono')
    os.makedirs(cdir, exist_ok=True)
    os.makedirs(mdir, exist_ok=True)
    todo = names or sorted(LUCIDE_MAP)
    written = []
    for name in todo:
        lucide, palette = LUCIDE_MAP[name]
        mono, colour = emit(name, lucide, palette)
        open(os.path.join(mdir, '%s.svg' % name), 'w').write(mono)
        open(os.path.join(cdir, '%s.svg' % name), 'w').write(colour)
        written.append(name)
    return written


def css_rules(names=None):
    """the mask rules the stylesheet needs - printed, and checked by test/icons.test.js"""
    return '\n'.join(
        '.ico[data-i="%s"] { -webkit-mask-image: url("../img/ico-mono/%s.svg"); '
        'mask-image: url("../img/ico-mono/%s.svg"); }' % (n, n, n)
        for n in (names or sorted(LUCIDE_MAP)))


if __name__ == '__main__':
    args = [a for a in sys.argv[1:] if not a.startswith('-')]
    got = write_all(args or None)
    print('wrote %d icon pairs: %s' % (len(got), ' '.join(got)))
    if '-css' in sys.argv:
        print()
        print(css_rules(args or None))
