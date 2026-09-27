# Third-party asset credits

SRIDHAR RUSH code is proprietary (see LICENSE). The following third-party
assets are bundled under their own licenses:

## Car models

| Car id | Asset | Source | License | Attribution |
| --- | --- | --- | --- | --- |
| `ghost` | CarConcept (glTF-WEBP) | [KhronosGroup/glTF-Sample-Assets](https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/CarConcept) | CC-BY-4.0 | "CarConcept" model by the Khronos Group, based on a public-domain (CC0) concept car by Unity Fan. https://creativecommons.org/licenses/by/4.0/ |

Per-folder license copies live next to the assets
(`public/assets/cars/<id>/LICENSE.txt`).

## Car-select card portraits (v145)

`public/img/cars/<id>.webp` — eight portraits (fury, storm, volt, viper, blaze,
phantom, ghost, reaper) shown on the car-select cards.

These are **original renders generated for this project** with an image model
from prompts written here; they are not photographs, screenshots, or artwork
imported from anywhere. No brand badge, wordmark or other manufacturer mark
appears in any of them (the prompts exclude them explicitly), and the shapes are
generic mid-engine hypercar silhouettes rather than any specific maker's design.

- source working files: `tools/car-art/raw/<id>.png` (kept out of the repo; the
  shipped `.webp` are the deliverable, produced by the crop/resize step in the
  v145 build notes)
- geometry, colour and camera are consistent across the eight so the cards read
  as one set: three-quarter front view, dark studio, a colour-matched neon accent
  and a reflective floor
- each is < 60 KB and precached by the service worker

**Not covered by trademark clearance:** the portraits are original artwork, but as
with the logo, whether a given silhouette is confusable with a registered
trademark is a legal question this project cannot answer. See
`tools/logo-forge/PROVENANCE.md` for the same note about the wordmark.

## Weather-condition card art (v147)

`public/img/weather/<id>.webp` - four pictures (dry, wet, night, blizzard) shown on
the weather cards.

Like the car portraits, these are **original images generated for this project**
with an image model from prompts written here; they are not photographs or
imported artwork. No brand mark, logo or readable signage appears in any of them
(the prompts exclude them), and each was composed with a plain, dark band on one
side so the card's text has somewhere quiet to sit.

- 480x294, 17-36 KB each, precached by the service worker
- one visual family: same low camera angle, surface filling the lower frame, a
  colour grade that matches the game's accent for that condition

**No trademark clearance was performed** - same caveat as the wordmark and the car
portraits.

## Circuit card art (v148)

`public/img/map-<id>.webp` — five pictures (highland, neon, island, canyon, snow)
shown on the circuit cards.

**Original images generated for this project** with an image model from prompts
written here, replacing the previous pack. They are not photographs or imported
artwork, and no brand mark, logo or readable signage appears in any of them (the
prompts exclude them explicitly).

- 512x230, 21-38 KB each
- one family: low camera just above the tarmac, the road entering bottom-left and
  sweeping through the middle of the frame, a grade that matches that circuit's
  accent colour

**No trademark clearance was performed** - same caveat as the wordmark, the car
portraits and the weather art.

## Icons — the generic half (Lucide, ISC)

The chrome icons are a hybrid set. The identity icons (car, flag, helmet, nitro,
speedometer, wheel, trophy, crown, swords, ghost, target, stopwatch, the weather
symbols) are hand-authored for this project in `tools/icon-forge/make_icons.py` and
are covered by the project's own copyright. The utility icons — gear, globe, user,
chart, mute, plus, key, share, search, star and the rest — are **Lucide**
(https://lucide.dev), which is released under the **ISC licence** (a permissive,
MIT-equivalent licence that requires the copyright notice and permission notice to
be retained). They are not copied as-is: `tools/icon-forge/lucide_icons.py`
re-emits the same path geometry on this project's own 128-unit grid, with its own
stroke weight and opacity, and every emitted file carries a provenance header.

```
ISC License

Copyright (c) for portions of Lucide are held by Lucide Contributors 2022.
Permission to use, copy, modify, and/or distribute this software for any purpose
with or without fee is hereby granted, provided that the above copyright notice
and this permission notice appear in all copies.
THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
THIS SOFTWARE.
```

The licence text above is reproduced in full because ISC requires it to travel with
the work; the icon files themselves repeat the attribution in their header comment.

### The app icon and the favicons

`public/icon.svg` is drawn geometry (a shield and a road, from this project's own
logo), not a font glyph — it replaced a `<text>` element that rendered whatever
emoji the visitor's device happened to have. `public/img/icon-192.png`,
`icon-512.png`, `icon-512-maskable.png` and `apple-touch-icon.png` are rendered from
`public/img/logo.png` by `tools/icon-forge/make_app_icon.py` and the PIL pipeline in
`tools/icon-forge/`. The maskable variant exists because Android crops maskable
icons to a circle: pointing that entry at the same file as the "any" icon (which is
what the manifest used to do) cut the artwork's edges off.

## Rejected candidate sources (licensing audit, 2026-09-22)

- `Vivekkk-1/3D-Models` - owner disclaims ownership; Sketchfab rips of
  real-brand cars without per-model licenses. Not used.
- `Nissmo89/Supercar-Vault-3D` - no LICENSE file; real-brand models incl. a
  vecarz.com-watermarked GLB. Not used.

- **fury** — CarConcept GLB (ghost) recoloured to fury paint — CC-BY-4.0 Khronos Group
- **storm** — CarConcept GLB (ghost) recoloured to storm paint — CC-BY-4.0 Khronos Group
- **volt** — CarConcept GLB (ghost) recoloured to volt paint — CC-BY-4.0 Khronos Group
- **viper** — CarConcept GLB (ghost) recoloured to viper paint — CC-BY-4.0 Khronos Group
- **blaze** — CarConcept GLB (ghost) recoloured to blaze paint — CC-BY-4.0 Khronos Group
- **phantom** — CarConcept GLB (ghost) recoloured to phantom paint — CC-BY-4.0 Khronos Group
- **reaper** — CarConcept GLB (ghost) recoloured to reaper paint — CC-BY-4.0 Khronos Group