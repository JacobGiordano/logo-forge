Last updated: 2026-08-21

## Status

Issues #11-#18 complete and merged to main, shipped. Binary tracer defaults to tuned potrace-wasm (with fallback); sidebar scrolls independently; both vector-fit sliders work; selection/crop UI (#6-#9) now has Playwright coverage. Issue #19 (Otsu-threshold bug) filed but not started — backlog.

## Decisions made this session

- #11-#17 (potrace-wasm arc): binary tracer now defaults to potrace-wasm, tuned (`alphamax=0.35`, non-linear slider mapping — see `js/app.js` `cornerSmoothingToAlphamax()`/`curveFitToOpttolerance()`), falls back to the original `imagetracer.js` chain if wasm is unavailable. Color-aware tracing deliberately NOT built — #12 found ~93% speckle-fragment paths, needs its own despeckle spike first. Full history in closed issues #11-#17 if needed; not re-summarized here.
- #18: user reported mobile drag-to-select doesn't work. Confirmed in code: `js/app.js`'s `selectCanvas` only listens for `mousedown`/`mousemove`/`mouseup` — zero touch/pointer event handling. Added `tests/selection.spec.ts` (12 desktop tests covering #6-#9: draw/resize/pan/zoom/clear/confirm, both auto-trim on and off) plus a `test.fail()`-annotated touch test that dispatches real `TouchEvent`s and confirms **nothing happens at all** (no partial drag — `dragMode`/`selectionBox` never set). That `test.fail()` is a deliberate tripwire: it'll flip to a real failure once touch support is added, forcing removal of the annotation.
- New fixtures: `tests/fixtures/select-sheet.png` (512×512, sharp edges) and `select-sheet-aa.png` (same, anti-aliased) — needed since the existing `test-logo.png` (32×32) is under the app's 256px selection-view threshold.
- #19 (not started, backlog): found while building #18's fixtures — `computeOtsuThreshold()` returns exactly `0` on perfectly bimodal images (only 2 histogram bins, e.g. flat vector-style exports), and two call sites use it unclamped: `autoTrimSourceRect` (#6 auto-trim) and `centerSubjectInFrame` (#8 Center button) both silently no-op as a result. The main trace pipeline's own Otsu mode already clamps correctly — not affected. Repro is `tests/selection.spec.ts`'s second `test.fail()` block.
- Lesson carried forward from #16: when tuning/testing coupled controls, sweep each in isolation at the OTHER's default, not just each at its own extremes — that's what hid #16's bug.

## Next issues

- Mobile touch support for the selection UI: add touch/pointer event handling to `js/app.js`'s `selectCanvas` (`mousedown`/`mousemove`/`mouseup` handlers, ~line 617-669). `tests/selection.spec.ts`'s `test.fail()` touch test is the acceptance target — remove the annotation once it passes.
- #19: fix the Otsu-threshold-returns-0 bug (see above) — separate root cause from the touch gap, intentionally not bundled.
- `logo-forge.html` (alt entry point) still out of sync with all feature work since before #6 — undecided whether it's still meant to be live.
- Color-aware tracing: needs a despeckle-focused spike before it's a real issue (see #12 findings).

## Gotchas

- Plain static HTML/JS app — no build step, no framework
- Binary tracing tries potrace-wasm first, falls back to `imagetracer.js` silently — test changes against both engines
- Selection UI only appears for images >256px in the relevant dimension; smaller images skip straight to tracing
- `body{height:100vh}` on desktop is load-bearing for the sidebar's internal scroll; the mobile media query overrides it back to `auto` — don't remove either half independently
- Live-update debounce is 350ms (`scheduleLive()` in `js/app.js`); all trace triggers must go through `#trace-btn`'s `clearTimeout(liveTimer)` guard
