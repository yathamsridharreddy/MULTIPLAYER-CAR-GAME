#!/usr/bin/env python3
"""Wire the icon set into the chrome: emoji out of buttons/tabs/headings, icons in.

WHY A SCRIPT: the emoji live in TWO places - the markup and the i18n dictionary -
and i18n.js is written in four languages. A hand edit would drift between them.

WHY IT MATTERS HOW THE ICON IS PLACED: applyI18n() writes `textContent` on any
element carrying data-i18n, which DELETES child elements. So an icon may never be
a child of an i18n target - it has to be a sibling:

    <button data-i18n="clubs">🏁 CLUBS</button>                  <- before
    <button><span class="ico" data-i="race-flag"></span>
            <span data-i18n="clubs">CLUBS</span></button>        <- after

test/icons.test.js enforces that ("an element may not carry an icon AND data-i18n").

KEPT AS EMOJI, on purpose:
  * dictionary values that are NOT chrome labels - toasts, room status and
    sentence-length messages (the option the user approved: chrome only)
  * game.js share strings, which are outbound text a player reads elsewhere

Run:  python3 tools/icon-forge/apply_icons.py [--check]
      --check reports what is left without writing anything.
"""
import os
import re
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
PAGES = ['public/index.html', 'public/controller.html', 'public/auth.html', 'public/replay.html']

EMOJI = '\U0001F000-\U0001FAFF\u2600-\u27BF\u2B00-\u2BFF\u2705\u274C\u26A0'
EMOJI_RE = re.compile('[%s]\uFE0F?' % EMOJI)

# --- emoji -> icon. House icons where identity matters (they are the site's own
#     language), Lucide for the generic ones. Absent from this table = keep.
MAP = {
    '🏁': 'race-flag', '🏎️': 'racing-car', '🏎': 'racing-car',
    '🏆': 'trophy', '⚔️': 'swords', '⚔': 'swords', '🎯': 'target',
    '👻': 'ghost', '⏱️': 'stopwatch', '⏱': 'stopwatch', '👑': 'crown',
    '🛡️': 'shield', '🛡': 'shield',
    '⚡': 'bolt', '🚪': 'exit', '🔁': 'refresh', '🔄': 'refresh-cw',
    '📤': 'share', '📄': 'copy', '🎥': 'video', '📸': 'camera-plus',
    '🗺️': 'map', '🗺': 'map', '👤': 'user', '👥': 'users', '🎖️': 'medal',
    '🎖': 'medal', '📊': 'chart', '📈': 'chart', '⚙️': 'gear', '⚙': 'gear',
    '🌐': 'globe', '➕': 'plus', '🔑': 'key', '📲': 'install', '🔇': 'mute',
    '🎵': 'music', '✨': 'sparkle', '🎨': 'palette', '💡': 'bulb',
    '🖼️': 'image', '💬': 'chat', '🕹️': 'gamepad', '🕹': 'gamepad',
    '🎮': 'gamepad', '📱': 'phone', '🔥': 'flame', '🚀': 'rocket',
    '✅': 'check', '❌': 'x', '✖': 'x', '⏸': 'pause', '✈️': 'send', '✈': 'send',
    '🟢': 'dot', '🟡': 'dot', '🪙': 'coin', '🎁': 'gift', '📅': 'calendar',
    '🖥️': 'monitor', '🖥': 'monitor', '🎓': 'book', '🔐': 'lock',
    '🌀': 'wind', '🎚️': 'gauge', '🎚': 'gauge', '⌨️': 'keyboard', '⌨': 'keyboard',
    '⏳': 'hourglass', '🚫': 'ban', '🛍️': 'shopping', '🔎': 'search',
    '👁️': 'eye', '👁': 'eye', '🌍': 'globe', '📨': 'mail', '✉️': 'mail',
    # controller page + stragglers (vibrate and fullscreen are already house icons)
    '⏏️': 'exit', '⏏': 'exit', '↺': 'refresh', '🔃': 'refresh-cw',
    '📳': 'vibrate', '⛶': 'fullscreen', '⬆️': 'arrow-up', '⬆': 'arrow-up',
    '😕': 'ban', '🧭': 'compass', '🛍': 'ticket',
}

# tints, so a status dot keeps its meaning now that it is a real icon
TINT = {'🟢': 'green', '🟡': 'amber', '🔥': 'flame'}


def icon_span(emoji, tint=True):
    name = MAP[emoji]
    cls = 'ico'
    if tint and emoji in TINT:
        cls += ' ico-' + TINT[emoji]
    return '<span class="%s" data-i="%s" aria-hidden="true"></span>' % (cls, name)


# matches a small element whose content is plain text: <tag attrs>text</tag>
LEAF = re.compile(r'<([a-z0-9]+)((?:"[^"]*"|[^>"])*)>([^<>]*)</\1>', re.I)
ATTR_KEY = re.compile(r'\sdata-i18n(?:-[a-z]+)?="([^"]+)"')


def transform_page(html):
    """Move a LEADING emoji out of a leaf element and put an icon in front of the text.

    Returns (new_html, [(tag, i18n key or None, emoji, icon name), ...]).
    """
    sites = []

    def repl(m):
        tag, attrs, inner = m.group(1), m.group(2), m.group(3)
        stripped = inner.lstrip()
        e = EMOJI_RE.match(stripped)
        if not e:
            return m.group(0)
        emoji = e.group(0).strip()
        if emoji not in MAP:
            return m.group(0)
        text = stripped[len(e.group(0)):].strip()
        text = EMOJI_RE.sub('', text).strip()   # a trailing glyph goes too ('... REPLAY ⚡')
        if not text:
            # an icon-ONLY control (the controller's tool buttons). Safe only for a
            # button: an icon must never be the whole content of a text element.
            if tag.lower() != 'button':
                return m.group(0)
            km = ATTR_KEY.search(attrs)
            if km:
                return m.group(0)               # cannot carry both an icon and i18n
            sites.append((tag, None, emoji, MAP[emoji]))
            return '<%s%s>%s</%s>' % (tag, attrs, icon_span(emoji), tag)
        km = ATTR_KEY.search(attrs)
        icon = icon_span(emoji)
        if km:
            # the i18n attribute must move DOWN, or applyI18n writes textContent on
            # the parent and deletes the icon
            key = km.group(1)
            attrs2 = ATTR_KEY.sub('', attrs)
            sites.append((tag, key, emoji, MAP[emoji]))
            return '<%s%s>%s<span data-i18n="%s">%s</span></%s>' % (tag, attrs2, icon, key, text, tag)
        sites.append((tag, None, emoji, MAP[emoji]))
        return '<%s%s>%s%s</%s>' % (tag, attrs, icon, text, tag)

    out = LEAF.sub(repl, html)
    return out, sites


def main():
    check = '--check' in sys.argv
    root_html = os.path.join(ROOT, PAGES[0])
    html = open(root_html).read()
    out, changed = transform_page(html)
    print('index.html: %d sites transformed' % len(changed))
    if not check:
        open(root_html, 'w').write(out)


if __name__ == '__main__':
    main()
