Last updated: 2026-08-21

## Status

Issues #11-#20 complete and merged to main, shipped. Binary tracer defaults to tuned potrace-wasm (with fallback); sidebar scrolls independently; both vector-fit sliders work; selection/crop UI (#6-#9) has full Playwright coverage including mobile touch drag-select; Otsu-threshold-zero bug fixed. No open issues right now.

## Decisions made this session

- #20: mobile drag-to-select fixed. `js/app.js`'s `eventToCanvasPoint` now resolves coordinates from `e.touches[0]`/`e.changedTouches[0]`/`e` itself (mouse and touch share one code path); the old inline `mousedown` handler became `onSelectDragStart`, wired to both `mousedown` and `touchstart`, with `touchmove`/`touchend` routed through the existing `onSelectDrag`/`onSelectDragEnd` — no parallel touch-only state machine. `preventDefault()` guarded by `e.cancelable` so it doesn't throw on synthetic test events. `tests/selection.spec.ts`'s touch `test.fail()` tripwire (from #18) and the stale auto-trim `test.fail()` tripwire (made obsolete by #19) were both flipped to real passing tests in the same pass. Full suite: 30/30 passing, zero `test.fail()` left in the repo.
- #11-#19 (potrace-wasm arc, selection/crop UI, Otsu fix): full history in closed issues if needed; not re-summarized here. Color-aware tracing deliberately NOT built — #12 found ~93% speckle-fragment paths, needs its own despeckle spike first.
- Lesson carried forward from #16: when tuning/testing coupled controls, sweep each in isolation at the OTHER's default, not just each at its own extremes.

## Next issues

- `logo-forge.html` (alt entry point) still out of sync with all feature work since before #6 — undecided whether it's still meant to be live.
- Color-aware tracing: needs a despeckle-focused spike before it's a real issue (see #12 findings).

## Gotchas

- Plain static HTML/JS app — no build step, no framework
- Binary tracing tries potrace-wasm first, falls back to `imagetracer.js` silently — test changes against both engines
- Selection UI only appears for images >256px in the relevant dimension; smaller images skip straight to tracing
- `body{height:100vh}` on desktop is load-bearing for the sidebar's internal scroll; the mobile media query overrides it back to `auto` — don't remove either half independently
- Live-update debounce is 350ms (`scheduleLive()` in `js/app.js`); all trace triggers must go through `#trace-btn`'s `clearTimeout(liveTimer)` guard
- Selection drag state (mouse and touch) lives in `js/app.js`'s `onSelectDragStart`/`onSelectDrag`/`onSelectDragEnd` trio — keep both input paths routed through these, don't fork a touch-only copy
