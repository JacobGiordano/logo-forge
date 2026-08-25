Last updated: 2026-08-25

## Status

Issues #11-#34 complete and previously shipped. This cycle ships six issues together (#35-#40), all merged to local `main`, full Playwright suite green (52 tests; 1 pre-existing sandbox timing flake unrelated to any of this work — see Gotchas).

## Decisions made this session

- #35: closed the aa-wordmark stray-fragment regression in `cheapDespeckle` (`js/bilinear-worker.js`). Went through two iterations — an initial 100%-vote despeckle rule (a4e47c9) proved too aggressive on other content, replaced with a decoupled spur-removal pass (dd57733) gated on boundary adjacency rather than size alone (47fb7bd), plus a fixture correction (1de6cc1) to actually exercise the `spurArea=4` case it claimed to cover.
- #36 (Scout): added Playwright coverage for the bilinear-2x path, the native-size fallback gate at `BILINEAR_NATIVE_SAFE_LIMIT`, the 3x/4x-removal regression guard, and Worker construction/timeout failure handling (`tests/bilinear.spec.ts`).
- #37: added an app-wide upload size cap — rejects uploads above 6000px longest-side before the trace pipeline runs, with a clear user-facing message, using #34's ~7300-8000px crash-ceiling evidence as the basis for the margin.
- #38: `onSelectDragEnd()`'s `'new'`-drag-mode branch was the sole call site mutating `imagePanX`/`imagePanY` without an immediate `redrawSelectCanvasBackground()` — added it, matching every other pan-mutation site in `js/app.js`. Fixed the Center button reading stale pixels and double-counting a silent `clampPanToBox` correction.
- #39: added `SMALL_SOURCE_DIM=256` gate — below it, `smoothMask`'s majority-vote thresholds relax (stops deleting 1px strokes / bridging 1px gaps) and `despeckleNative` scales down proportionally; unchanged at/above the cutoff. Fixes smeared/merged small-logo text without affecting normal-sized sources.
- #40: added a Levels control (black point / white point / gamma) on the source image, upstream of thresholding, luminance-only. Wired into the existing generic `CONTROL_DEFS` mechanism (undo/redo, live-preview debounce) rather than bespoke code. Additive to #39, not a substitute — doesn't touch color tracing (still on hold).

## Next issues

- #33 (Scout): Playwright coverage for the #26/#28 tooltip/popover feature — not started, still open.
- Color-aware tracing: on hold per user request until color capabilities come up again.
- Possible future: `touchcancel` handling for pinch/pan if an interrupted OS gesture ever turns out to be a real-world pain point (flagged in #23, not urgent).

## Gotchas

- Plain static HTML/JS app — no build step, no framework
- `preprocessImageData` (`js/app.js`) is async, gated by `BILINEAR_NATIVE_SAFE_LIMIT=3500` (native longest dimension) and the new #37 upload cap at 6000px — touching this pipeline needs manual verification at real upload sizes, not just isolated spike harnesses
- `SMALL_SOURCE_DIM=256` (js/app.js) gates #39's relaxed smoothMask/despeckle behavior — any future despeckle/smoothing tuning must check both size tiers
- Levels (`applyLevels()`) runs on continuous luminance before Otsu/threshold resolution, ahead of both the native and bilinear paths — a third pipeline stage now precedes thresholding alongside despeckle/smoothMask, keep the ordering in mind for future pipeline changes
- `tests/bilinear.spec.ts:172` ("just below the gate (3499px)...") is a known pre-existing sandbox timing flake, independently reproduced against unmodified code by three separate sessions this cycle — not a real regression, don't chase it without new evidence
