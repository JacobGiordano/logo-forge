Last updated: 2026-10-26

## Status

Issues #11-#41 complete and shipped, plus Upscale-2x-by-default (no issue). Suite: 102 passed.

## Decisions made this session

- "Upscale before trace" now defaults to 2×. Sources with min side < 256 (`isSmallSource`, shared with #39's SMALL_SOURCE_DIM gate) skip 2× and trace native, with a "This image is small" advisory; >=3500px native gate unchanged.
- `computeOtsuThreshold`: a histogram with exactly two populated levels returns their midpoint (rounded up, still clamped [1,254]). Without it, 2× bilinear edges fell outside ink and B&W shapes lost ~0.5 source px/side. Also fixes non-black two-tone ink (e.g. grey 50 on white) that previously traced empty at any setting.
- Specs that test native-path behaviour pin `#upscale-factor` to Off explicitly; small-fixture specs stay on the default to cover the skip.

## Next issues (unfiled follow-ups)

- Auto-detect bg polarity uses whole-image mean luminance (`autoDetect`, plus Center/auto-trim copies) → inverts when the subject fills >~half a tight crop. Fix: classify by border/edge strip (like `choosePadFill`). Subsumes the Center polarity no-op.
- `#svg-meta` reports "Paths: 1" when the SVG has zero `<path>` elements.
- Optional: filename prompt on single-file downloads via `showSaveFilePicker` with `<a download>` fallback (today the prompt is purely the browser's setting).
- touchcancel on a one-finger draw keeps an already-valid box — decide if it should discard.
- Zoom near canvas edge shifts the box (`clampBoxToCanvas`), dropping padding; Center can need two clicks; no padding test runs Center while zoomed in.
- `package.json` serve/start scripts still use port 4321 (manual use only). Color-aware tracing: on hold.

## Gotchas

- Plain static HTML/JS app — no build step, no framework
- `preprocessImageData` is async, gated by `BILINEAR_NATIVE_SAFE_LIMIT=3500`, the #37 6000px cap, and `isSmallSource` (<256)
- Levels runs before Otsu/threshold resolution on both native and bilinear paths
- `tests/bilinear.spec.ts:172` (3499px gate) is a known sandbox timing flake — don't chase without new evidence
