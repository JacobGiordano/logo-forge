Last updated: 2026-08-18

## Status

Issue #5 (marquee-select a region from an uploaded sheet, crop becomes the active image) complete and merged to main.

## Decisions made this session

- Images ≤256px in both dimensions skip the selection view entirely and go straight to the existing immediate-trace flow — keeps small single-icon uploads (e.g. `tests/fixtures/test-logo.png`, 32×32) byte-for-byte unchanged
- Crop is taken from the full source resolution via an offscreen canvas (`drawImage(pendingImage, sx, sy, sw, sh, ...)`), never from the downscaled on-screen selection canvas — coordinates are scaled display→source before cropping
- Selection view is entered from `handleFile`, so first upload, "replace ↑", and drag-and-drop all go through it identically
- No changes needed downstream of `srcImage` being set — the whole refine/upscale/trace/export pipeline already works on whatever `Image` ends up there

## Next issues

- #6 auto-trim negative space around the subject (depends on #5)
- #7 zoom/pan the selection canvas for dense sheets (depends on #5)
- #8 interactive crop editor: resizable crop handles, pan subject under a fixed frame, crosshair guides, one-shot center-snap, fix low-contrast selection outline on light backgrounds (depends on #5; in progress next)
- Known gap: no Playwright coverage of the selection UI itself yet (existing suite passes only because the fixture is small enough to bypass selection) — Scout should add a larger-sheet fixture + selection-flow tests

## Gotchas

- Plain static HTML/JS app — no build step, no framework
- `serve` package used as dev server for Playwright tests only
- Undo button stays disabled until a second trace is committed (by design)
- Scale2x/3x-family upscaling bevels true 90° corners by ~1px (inherent to the algorithm) — negligible on curved logo art, visible on hard-cornered geometric fixtures
- Selection view threshold (256px) is a plain constant in `js/app.js` — no UI to configure it
