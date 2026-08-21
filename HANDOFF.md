Last updated: 2026-08-21

## Status

Issues #11-#19 complete and merged to main, shipped. Binary tracer defaults to tuned potrace-wasm (with fallback); sidebar scrolls independently; both vector-fit sliders work; selection/crop UI (#6-#9) has Playwright coverage; Otsu-threshold-zero bug fixed. Mobile touch support for selection is next, not started.

## Decisions made this session

- #11-#17 (potrace-wasm arc): binary tracer now defaults to potrace-wasm, tuned (`alphamax=0.35`, non-linear slider mapping — see `js/app.js` `cornerSmoothingToAlphamax()`/`curveFitToOpttolerance()`), falls back to the original `imagetracer.js` chain if wasm is unavailable. Color-aware tracing deliberately NOT built — #12 found ~93% speckle-fragment paths, needs its own despeckle spike first. Full history in closed issues #11-#17 if needed; not re-summarized here.
- #18: user reported mobile drag-to-select doesn't work. Confirmed in code: `js/app.js`'s `selectCanvas` only listens for `mousedown`/`mousemove`/`mouseup` — zero touch/pointer event handling. Added `tests/selection.spec.ts` (12 desktop tests covering #6-#9) plus a `test.fail()`-annotated touch test confirming **nothing happens at all** on a real `TouchEvent` drag. That `test.fail()` is a deliberate tripwire — flips to a real failure once touch support lands, forcing removal of the annotation. New fixtures: `tests/fixtures/select-sheet.png` / `select-sheet-aa.png` (512×512, existing `test-logo.png` is under the 256px selection-view threshold).
- #19: `computeOtsuThreshold()` returned exactly `0` on perfectly bimodal images (only 2 histogram bins), silently breaking `autoTrimSourceRect` (#6 auto-trim) and `centerSubjectInFrame` (#8 Center). Fixed by clamping to `[1,254]` *inside* `computeOtsuThreshold()` itself, not at each call site — a raw 0/255 is never a usable threshold anywhere it's consumed, so the invariant belongs in the function, protecting any future caller too. No-op for the trace pipeline's own Otsu mode, which already clamped separately. Verified: auto-trim now tightens 289×289→164×164 on the repro fixture; Center now actually pans.
- Stale test flagged, not yet cleaned up: #19's fix makes `tests/selection.spec.ts`'s auto-trim `test.fail()` block start unexpectedly passing (correct — the bug is fixed) — its annotation needs removing. Deliberately deferred to ride along with the mobile-touch Scout session, since that session already touches this file.
- Lesson carried forward from #16: when tuning/testing coupled controls, sweep each in isolation at the OTHER's default, not just each at its own extremes.

## Next issues

- Mobile touch support for the selection UI: add touch/pointer event handling to `js/app.js`'s `selectCanvas` (`mousedown`/`mousemove`/`mouseup` handlers, ~line 617-669). `tests/selection.spec.ts`'s touch `test.fail()` is the acceptance target; the auto-trim `test.fail()` (now stale per #19) should be cleaned up in the same pass since Scout will already be in this file.
- `logo-forge.html` (alt entry point) still out of sync with all feature work since before #6 — undecided whether it's still meant to be live.
- Color-aware tracing: needs a despeckle-focused spike before it's a real issue (see #12 findings).

## Gotchas

- Plain static HTML/JS app — no build step, no framework
- Binary tracing tries potrace-wasm first, falls back to `imagetracer.js` silently — test changes against both engines
- Selection UI only appears for images >256px in the relevant dimension; smaller images skip straight to tracing
- `body{height:100vh}` on desktop is load-bearing for the sidebar's internal scroll; the mobile media query overrides it back to `auto` — don't remove either half independently
- Live-update debounce is 350ms (`scheduleLive()` in `js/app.js`); all trace triggers must go through `#trace-btn`'s `clearTimeout(liveTimer)` guard
