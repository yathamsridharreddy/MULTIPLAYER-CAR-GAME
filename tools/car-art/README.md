# Car-select card art

The eight portraits on the car-select cards (`public/img/cars/<id>.webp`) are
original renders generated for this project with an image model, from prompts
written here. They are not photographs, screenshots or imported artwork, and no
manufacturer badge, wordmark or other brand mark appears in any of them.

## What each prompt pinned down

So the eight read as ONE set rather than eight unrelated pictures:

- generic mid-engine hypercar silhouette (no specific maker's design)
- three-quarter front view, angled the same way in every frame
- dark studio with a reflective floor and two thin vertical neon light bars
- a glow behind the car in the car's own colour, and calipers to match
- "no brand badges, no logos, no text anywhere"
- wide framing, car centred in the middle band, so the 120:64crop has room

## Pipeline

1. `raw/<id>.png` — the model's full output (not committed; ~1.8 MB each)
2. centre-crop to the card's 120:64 aspect, then resize to 480x256 (4x the CSS box)
3. re-encode to WebP at quality 82 (`public/img/cars/<id>.webp`, 8-13 KB each)

The transparent-PNG copies alongside them are a fallback for anything that cannot
decode WebP; the client asks for the WebP first.

`contact-sheet.png` shows the whole set at once; `cards-preview.png` shows them
in card boxes at roughly the size the lobby renders.

## Licensing

See the v145 section of `ASSETS-CREDITS.md`. The artwork is original to this
project, but as with the wordmark, whether a given car shape is confusable with
a registered trademark is a clearance question this repository cannot answer.
