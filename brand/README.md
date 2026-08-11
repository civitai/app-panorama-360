# Panorama 360 — brand

> *Generate a world, not a picture.*

Store assets for this app's Civitai App listing. **These files are the source of truth for
this app's identity** — the listing images are exported from them, not the other way round.

## Identity

**Voice.** Cartographer — expansive, calm, horizon-obsessed. The output is a place, not a render.

**Motif.** **The loop that closes.** An unbroken ring read as a 360° dial: twelve thin ticks spaced evenly inside it, and one warm arc lit along the band.

## Palette

| Role | Hex | |
|---|---|---|
| Plate / dominant | `#2D9CFF` | the icon background, edge to edge |
| Secondary | `#A8D6FF` | the mark itself |
| Accent | `#FF9E5E` | the horizon / the seam — used sparingly, one element only |
| Cover ground | `#2D9CFF` | |

## Files

| File | Purpose |
|---|---|
| `icon.svg` | listing icon, 1024×1024 |
| `cover.svg` | listing cover, 1600×900 |

Export with `rsvg-convert`:

```bash
rsvg-convert -w 1024 -h 1024 brand/icon.svg  -o /tmp/icon.png
rsvg-convert -w 1600 -h 900  brand/cover.svg -o /tmp/cover.png
```

🔴 **Flatten the icon's corners onto the plate colour before uploading** — do not upload it
with transparency:

```bash
magick /tmp/icon.png -background '#2D9CFF' -alpha remove -alpha off /tmp/icon-upload.png
```

The listing pipeline transcodes every asset to JPEG, which has no alpha channel, and the
transparency is flattened to **black**. The store then clips the icon with a CSS avatar mask
that is slightly *less* rounded than the plate, so a thin dark rim survives along the curve.
Filling the corners with the plate colour removes the whole class — there is no transparency
left to flatten.

Attach with:

```bash
civitai app listing set-icon  /tmp/icon-upload.png
civitai app listing set-cover /tmp/cover.png
```

On a live listing this opens a revision for moderator re-review; the current assets stay
visible until it is approved. Setting the icon and cover in the same session puts both on one
revision, so they are reviewed together.

## Shared construction grammar

This app is one of five first-party apps drawn to a common grammar, so a row of them reads as
a suite while each stays individually memorable. Keep to it when changing anything here:

- Flat vector. Solid fills only — no gradients, shading, bevel, glow or 3D.
- Geometric primitives only: squares, triangles, circles, arcs, rings.
- Thick, uniform stroke weight. This is the strongest family signal at thumbnail size.
- Three colours maximum: one dominant, one accent, one neutral.
- The plate fills the whole canvas **edge to edge**; the margin lives *inside* it, around the
  mark. Never ask for margin *around* the plate — that bakes in a surround the store cannot
  crop past the rounded corners.
- **No lettering anywhere** — and that includes motifs whose skeleton *constructs* a letter or
  digit. Before locking a shape, ask what character it resembles.
- Never name a direction with a noun that already implies one. Say the geometry.

## App-specific note

🔴 The cover is **seamlessly tileable, by construction**. Its ranges are triangular waves whose period divides the width exactly, so both edges land on the same valley at the same height. Verify any replacement by butting two copies together and comparing the edge columns against two adjacent interior columns as a control — a seam number means nothing without that baseline. Three attempts to obtain this from a text prompt missed by 35×, 22× and 21× their own interior baselines: a sampler cannot close a loop. Also avoid triangles pointing *outward* from the ring plus a warm disc — that combination is the sun-rays prior and renders a weather icon.

## If you regenerate these

These were drawn as vector rather than generated, after three measured rounds established that
the constraints above and diffusion are structurally mismatched: across 42 generated images,
flat solid fills held 0/20, exact palette 1/10, and the alpha channel 0/20. Generation is
useful for *finding* a composition and poor at *meeting* a spec. If you use it, treat the
output as a sketch and redraw the winner in vector — and judge a candidate by what a stranger
would say it depicts, not by whether it matches the prompt.
