Last updated: 2026-08-22

## Status

Issues #11-#25 complete and merged to main, shipped. Path-simplify slider now does real point/node reduction (was a decimal-precision-only no-op); #25's antialiased/multi-level tracing spike ruled that approach out (measured worse than current pipeline, reproduced #12's speckle-fragment problem on clean shapes). #26 (slider tooltips/popovers) and #27 (bilinear-upsample-before-Otsu spike) are open, not started.

## Decisions made this session

- #24: path-simplify's tolerance is a Ramer-Douglas-Peucker pass over straight-line (`L`) runs only — curve segments (`C`/`Q`) are never touched, keeping it orthogonal to curve-fit's tolerance concern. Tolerance = `pathSimplify * 0.18px`, matching `ltres`'s existing slope so potrace-wasm and imagetracer land on comparable strength at the same slider position (previously potrace-wasm ignored the slider entirely). Not scale-invariant — fixed pixel tolerance, same convention as every other trace slider in this file; a favicon-sized source simplifies far more aggressively than a large one at the same slider position.
- #25 (spike): tested whether multi-level/antialiased luminance tracing (pre-binarize) beats the current hard-Otsu pipeline. It doesn't — 2-3x worse pixel-diff against ground truth, gets worse with more luminance bands not better, and 86-99.6% of emitted paths were speckle fragments even on clean synthetic shapes (generalizes #12's finding beyond photographic content). No implementation follow-up from this spike. Findings: `_system/antialiased-multilevel-tracing-findings.md`.
- #27 opened as a *different*, untested mechanism from the same root-cause hypothesis: bilinear-interpolate grayscale before Otsu threshold (true supersampling of continuous data) instead of today's Scale2x-after-binarize. Not assumed to work — needs its own spike before any implementation.

## Next issues

- #26: slider tooltips/popovers explaining what each control does — must work on touch (tap), not just desktop hover.
- #27: bilinear-upsample-before-Otsu spike — see above.
- Color-aware tracing: on hold per user request (2026-08-22) until color capabilities come up again; still needs a despeckle-focused spike first if revisited (see #12 findings).
- Possible future: `touchcancel` handling for pinch/pan if an interrupted OS gesture ever turns out to be a real-world pain point (flagged in #23, not urgent).

## Gotchas

- Plain static HTML/JS app — no build step, no framework
- Binary tracing tries potrace-wasm first, falls back to `imagetracer.js` silently — test changes against both engines
- Selection UI only appears for images >256px in the relevant dimension; smaller images skip straight to tracing
- `body{height:100vh}` on desktop is load-bearing for the sidebar's internal scroll; the mobile media query overrides it back to `auto` — don't remove either half independently
- Live-update debounce is 350ms (`scheduleLive()` in `js/app.js`); all trace triggers must go through `#trace-btn`'s `clearTimeout(liveTimer)` guard
- Selection drag state (mouse, touch, pinch/pan) lives in `js/app.js`'s `onSelectDragStart`/`onSelectDrag`/`onSelectDragEnd` trio — keep all input paths routed through these
- Selection-view copy (hint/aria-label/status) branches on `isTouchPrimary()` — if you change what touch can/can't do, update `SELECT_HINT_TOUCH`/`SELECT_CANVAS_LABEL_TOUCH`/`SELECT_STATUS_TOUCH` in the same pass
- `compactPathData()` in `js/app.js` now does real RDP node simplification, not just precision rounding — if you touch it, keep curve segments untouched and re-check both engines' output
