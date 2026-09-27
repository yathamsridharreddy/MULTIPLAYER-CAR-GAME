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