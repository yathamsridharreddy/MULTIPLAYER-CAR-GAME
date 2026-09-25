# SRIDHAR RUSH — logo design & provenance

## What this is

An original vector identity for **SRIDHAR RUSH**, built from the *design direction*
of a bold stacked "SR" monogram that has to survive as a 16px favicon.

## Provenance — how the artwork was made

**The geometry was newly constructed for SRIDHAR RUSH.** Specifically:

- Every coordinate in the monogram is a number in `build_logo.py`, set by hand
  against a small-size budget. Nothing was traced, sampled, auto-vectored or
  extracted from any image. No reference sheet was loaded by the build.
- The letterforms are **squared, chamfered, and slanted 13°**. They are not
  derived from any typeface; they are polygons.
- The wordmark is set in **Orbitron** at weights 900, then **converted to plain
  SVG path outlines** (via `fontTools`). Orbitron is licensed under the
  **SIL Open Font License 1.1**, which permits commercial use and permits
  outlines to be converted. **No font file is embedded** in any deliverable, so
  nothing depends on a viewer having the font installed, and no font is
  redistributed.

**Not copied from:** the reference sheet, or any existing racing / automotive /
esports / gaming identity. No shield, car silhouette, steering wheel, flame or
checkered flag is used as the primary mark.

## Geometry rules the mark obeys

The 16px requirement drove every measurement. At 16px the mark is ~15px wide, so
**1 design unit = 0.1176px**:

| Element | Size | At 16px | Rule |
|---|---|---|---|
| Canvas | 136 × 136u | 16px | — |
| S bar | 27u | 3.2px | ≥ 2px |
| S counter gap | 18u | 2.1px | ≥ 2px |
| R stem | 23u | 2.7px | ≥ 2px |
| R bowl wall | 20u | 2.4px | ≥ 2px |
| R counter | 26u tall | 3.1px | ≥ 2px |
| Chamfer | 10u | 1.2px | decorative only |

**No stroke is under 2px at 16px, and no gap is under 2px at 16px.** The mark
contains no hairlines, no fillets, no thin tails and no sub-pixel detail, which
is why it cannot crumble or fill in when it shrinks.

### The mistake worth recording

The first build of this mark rendered as **"2R"**. A squared **S** connects its
top bar to its middle bar on the **LEFT**, and its middle bar to its bottom bar
on the **RIGHT**. The mirror of that is a **"2"**. That was caught only by
rendering the mark and looking at it — the geometry was internally consistent and
looked plausible in code. The lesson is in the code comment at `_shapes()`.

### Two more defects found by rendering, and fixed

Both of these were invisible in the code and only showed up when the artwork was
actually rasterised and looked at:

1. **Glyph previews were mangled for some fonts.** SVG allows an implicit lineto
   after a moveto — `M50 0 570 1490` is a moveto *followed by* a lineto. The
   path flattener dropped those pairs, so any font whose outlines use that form
   (Inter, the annotation face) lost real corners: an "A" rasterised as a hollow
   triangle. Fixed in `glyphs.py`; the shipped SVG paths were never affected, but
   the previews were lying about them, which is just as bad.
2. **The maskable PWA icon sat outside the safe zone.** Android may crop a
   maskable icon to a circle covering only the central 80%. The first build drew
   the mark at 92% of the tile width — its worst corner reached 92% of the half
   width, i.e. well outside. It is now scaled so the worst corner lands at 78%
   of the half width, and the tile is a full-bleed square instead of a rounded
   one (the platform draws the shape; a maskable background must reach the
   edges). The artwork inside that circle is guaranteed to survive any crop.

## Variants

| File | Use |
|---|---|
| `sr-primary.svg` | Default mark. Silver S + red R, dark keyline. Dark backgrounds. |
| `sr-onlight.svg` | Light backgrounds. Graphite S + red R. |
| `sr-mono-white.svg` | One colour, white. Photography, video, sponsor deck. |
| `sr-mono-black.svg` | One colour, black. Print, stamps, engraving, invoices. |
| `sr-red-white.svg` | White S + red R, no keyline. High-contrast flat contexts. |
| `sr-cyan-white.svg` | Cyan R. Electric accent variant. |
| `sr-flat-red.svg` | Single flat red. Embroidery, silk-screen, vinyl cut. |

**Background independence was a measured result, not an assumption.** An early
build used a silver S with no keyline; the 16px render on a light background
showed the S vanishing completely (only the red R survived). The `primary`
variant now carries a dark keyline for that reason, and `onlight` exists as the
correct choice on white.

## Trademark status — read this

**This artwork was created independently, but no claim is made that it carries
"zero copyright or trademark risk."**

- **Copyright** in this artwork belongs to the project owner. The provenance
  above documents that it was independently constructed.
- **Trademark is a separate question and has NOT been checked.** Trademark rights
  depend on the marks already registered in the relevant classes and
  jurisdictions, and on whether a conflicting mark exists in the racing, gaming
  or entertainment sectors. **An independent design can still infringe an
  existing trademark.**
- Before commercial launch, commissioning merchandise, or filing, have a
  **trademark attorney run a clearance search** in the classes and territories
  you intend to trade in. That is a legal step this build cannot perform.
- The wordmark uses Orbitron under the SIL OFL 1.1. **Font licences cover the
  font software, not trademark rights in a resulting logo** — a wordmark still
  needs its own clearance.
- "SR" and "SRIDHAR RUSH" as names may themselves require clearance in your
  jurisdiction.

## Review sheets

The approval sheets under `out/present/` are drawn by `tools/logo-forge/present.py`.
Annotation text on those sheets is set in **Inter** (SIL OFL 1.1) because
Orbitron's numerals and Chakra Petch's "Y" are both ambiguous at label sizes, and
a review sheet has to be readable. Inter is an **annotation face only** — it
appears in no logo asset and is never redistributed with the kit. The only
typeface in the artwork itself is Orbitron.

`present.py` reads the live `public/img/logo.png` **read-only**, to draw the
before/after comparison. It writes only to `tools/logo-forge/out/present/`, and
**nothing under `public/` is created, modified or referenced by the build.**

## What the site actually loads

Only a subset of the kit ships to the browser; the rest exists so the identity
has a defined answer for print, merch and future surfaces.

| Site file | Source in the kit | Used by |
|---|---|---|
| `public/img/logo.svg` | `sr-primary.svg` | tab icon (SVG), also `public/icon.svg` |
| `public/img/logo.png` | `sr-primary-512.png` | social/legacy references, results share card |
| `public/img/logo-horizontal.svg` | `logo-horizontal.svg` | lobby header |
| `public/img/splash-mark-256.png` | `splash-mark-256.png` | boot splash (64px slot) |
| `public/img/favicon-16/32/48.png` | `favicon-*.png` | tab icons |
| `public/img/apple-touch-icon.png` | `apple-touch-icon.png` | iOS home screen |
| `public/img/icon-192.png` / `icon-512.png` | `icon-*.png` | PWA install |
| `public/img/icon-512-maskable.png` | `icon-512-maskable.png` | Android `maskable` entry |

`public/img/logo-header.svg` is **not** shipped: it is byte-identical to
`logo-horizontal.svg` today (`logo-compact.svg` and `sr-primary.svg` are the same
artwork too), so the site carries one file instead of duplicates.

## Rebuilding

```bash
PYTHONPATH=/tmp/pylibs python3 tools/logo-forge/build_logo.py
```

Requires `fontTools` and the Orbitron WOFF (both fetched via npm/pip in the
build notes). The build prints an alpha-verification table for every transparent
PNG it writes.
