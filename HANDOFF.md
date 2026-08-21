Last updated: 2026-08-21

## Status

Issues #11-#23 complete and merged to main, shipped. Binary tracer defaults to tuned potrace-wasm (with fallback); sidebar scrolls independently; both vector-fit sliders work; selection/crop UI (#6-#9) has full Playwright coverage including mobile touch drag-select, pinch-to-zoom, and two-finger pan; Otsu-threshold-zero bug fixed; stale `logo-forge.html` build removed. No open issues right now.

## Decisions made this session

- #23: pinch-to-zoom and two-finger pan added for touch. A `'touch-pinch'` mode was added to the existing `dragMode` state machine (`onSelectDragStart`/`onSelectDrag`/`onSelectDragEnd`) rather than a parallel touch-only implementation — a second finger landing tears down any in-progress single-touch drag via the existing `onSelectDragEnd`. New `applyPinchZoomPan(newZoomRaw, mid)` pins a gesture-fixed source anchor captured once at pinch start, so a moving two-finger midpoint pans in the same motion that a changing finger distance zooms. Reuses `clampPanToCanvas`/`clampBoxToCanvas` — no new clamping logic. `touchcancel` isn't handled (matches the existing single-touch drag modes' convention, not a regression).
- #22: selection-view copy (hint text, canvas `aria-label`, status message) now branches on `isTouchPrimary()` (`matchMedia('(pointer: coarse)')`) instead of always showing desktop-only language ("scroll to zoom", "hold space to pan") to touch users. #23 landed in the same session and added real touch panning, so the #22 touch copy was updated again to mention it — copy must always match actual capability, not go stale when a follow-up issue changes what's true.
- #11-#21 (potrace-wasm arc, selection/crop UI, Otsu fix, dead-file removal, mobile drag-select): full history in closed issues if needed; not re-summarized here. Color-aware tracing deliberately NOT built — #12 found ~93% speckle-fragment paths, needs its own despeckle spike first.

## Next issues

- Color-aware tracing: needs a despeckle-focused spike before it's a real issue (see #12 findings).
- Possible future: `touchcancel` handling for pinch/pan if an interrupted OS gesture ever turns out to be a real-world pain point (flagged in #23, not urgent).

## Gotchas

- Plain static HTML/JS app — no build step, no framework
- Binary tracing tries potrace-wasm first, falls back to `imagetracer.js` silently — test changes against both engines
- Selection UI only appears for images >256px in the relevant dimension; smaller images skip straight to tracing
- `body{height:100vh}` on desktop is load-bearing for the sidebar's internal scroll; the mobile media query overrides it back to `auto` — don't remove either half independently
- Live-update debounce is 350ms (`scheduleLive()` in `js/app.js`); all trace triggers must go through `#trace-btn`'s `clearTimeout(liveTimer)` guard
- Selection drag state (mouse, touch, and now two-finger pinch/pan) lives in `js/app.js`'s `onSelectDragStart`/`onSelectDrag`/`onSelectDragEnd` trio — keep all input paths routed through these, don't fork input-specific copies
- Selection-view copy (hint/aria-label/status) branches on `isTouchPrimary()` — if you change what touch can/can't do, update `SELECT_HINT_TOUCH`/`SELECT_CANVAS_LABEL_TOUCH`/`SELECT_STATUS_TOUCH` in the same pass
