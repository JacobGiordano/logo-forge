Last updated: 2026-08-18

## Status

Issue #4 (perceptual mask upscaler + supersampled tracing) complete and merged to main.

## Decisions made this session

- Upscaler applies to the binary trace mask (post despeckle/hole-fill/smooth), not the raw grayscale source — despeckle/hole-preservation thresholds stay in natural-resolution units, no rescaling needed
- Algorithm: Scale2x/Scale3x (AdvMAME) family, pure JS, zero deps, in `js/upscale.js` — 4x = Scale2x applied twice. xBRZ considered and rejected as too complex for this scope
- Supersampled tracing needs no path-coordinate math: `cleanupSVG` already sets `viewBox` from the traced (upscaled) imagedata while `width`/`height` attrs stay at natural size — free downscale via SVG's own viewBox mechanism
- Mask preview now shows the upscaled mask (what's actually traced), not natural-resolution — more useful for debugging trace quality

## Next issues

- New feature under discussion: upload a sprite/icon sheet (see `_screenshots/`), marquee-select a region, auto-trim negative space around the subject, then run the existing refine/upscale/trace/export pipeline on just that crop (selection replaces the active image, reusing the current single-image pipeline as-is). Not yet ticketed — check `gh issue list --repo JacobGiordano/logo-forge` for current state.

## Gotchas

- Plain static HTML/JS app — no build step, no framework
- `serve` package used as dev server for Playwright tests only
- Undo button stays disabled until a second trace is committed (by design)
- Scale2x/3x-family upscaling bevels true 90° corners by ~1px (inherent to the algorithm) — negligible on curved logo art, visible on hard-cornered geometric fixtures
