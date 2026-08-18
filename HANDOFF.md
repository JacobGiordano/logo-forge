Last updated: 2026-08-18

## Status

Issue #8 (interactive crop editor: resize, pan, guides, center-snap) complete and merged to main.

## Decisions made this session

- Outline contrast fixed with a background-agnostic dark scrim + white/black double-border on handles, not a single accent-color outline — works regardless of source image color
- "Pan the subject" implemented as the literal fixed-frame version (frame stays visually static, image pans beneath it), clamped so panning can't expose empty space at an edge — not the simpler frame-moves fallback
- Center-snap reuses `buildMask`/`computeOtsuThreshold` directly (not the full `preprocessImageData` pipeline, which includes cosmetic despeckle/hole-fill/upscale steps irrelevant to a one-shot bounding-box estimate) to find the subject and center it
- Rune review skipped by user decision for this issue — no new external/network input surface, still pure client-side canvas work on user-supplied local images

## Next issues

- #6 auto-trim negative space around the subject (depends on #5)
- #7 zoom/pan the selection canvas for dense sheets (depends on #5)
- New idea raised, not yet ticketed: allow re-editing a crop after it's already been confirmed (currently the original uploaded image is discarded once a selection is confirmed — `pendingImage = null` in `finalizeImage`, app.js — so there's no way back into the selection view without re-uploading from disk). Check `gh issue list --repo JacobGiordano/logo-forge` for current state before starting.
- Known gap: no Playwright coverage of the selection UI itself yet (resize handles, pan-drag, crosshair toggle, center-snap all currently untested) — Scout should add a larger, off-center fixture and selection-flow tests

## Gotchas

- Plain static HTML/JS app — no build step, no framework
- `serve` package used as dev server for Playwright tests only
- Undo button stays disabled until a second trace is committed (by design)
- Scale2x/3x-family upscaling bevels true 90° corners by ~1px (inherent to the algorithm) — negligible on curved logo art, visible on hard-cornered geometric fixtures
- Selection view threshold (256px) is a plain constant in `js/app.js` — no UI to configure it
- Image pan during crop-edit is clamped at the point the frame would no longer be fully covered by image content — there is deliberately no way to pan "off the edge"
