Last updated: 2026-08-20

## Status

Issues #11-#15 complete and merged to main, shipped. Binary tracer now defaults to potrace-wasm (tuned), plus a sidebar-scroll fix found while testing it.

## Decisions made this session

- Explored in stages before implementing: #11 scoped the swap, #12 spiked it (proved output parity on simple shapes, found color-aware tracing has an unresolved speckle problem — deferred, out of scope), #13 spiked curve quality against real detailed content and found potrace only wins at *tuned* settings, not its own library defaults
- #14 implemented the binary swap: `js/potrace-wasm.js` (new vendored dep, `esm-potrace-wasm`, ~76KB, wasm inlined, no build step) + `js/potrace-trace.js` (new adapter — bakes potrace's coordinate transform into path data, resolves its `<g>`-level fill onto each `<path>`). Falls back automatically to the original `imagetracer.js` chain (kept fully intact) if wasm fails/unavailable — verified by forcing the failure, not just assumed.
- Corner-smoothing/curve-fit sliders now drive `alphamax`/`opttolerance` instead of `ltres`/`qtres`. Non-linear mapping — useful `alphamax` range is ~0.2-1.3, quality degrades above ~1.0. Default lands on the tuned "tight" preset (`alphamax=0.2, opttolerance=0.05`), not potrace's own defaults, which tested measurably softer on corners.
- #15: sidebar (`.left-panel`) wasn't scrolling independently — `body` had `min-height:100vh` (a floor, not a ceiling) so the whole page grew instead of clipping the sidebar. Fixed with `height:100vh` on desktop; mobile breakpoint gets `body{height:auto}` back to preserve its existing whole-page-scroll behavior.
- Color-aware (multi-layer) tracing intentionally NOT built — #12 found ~93% of paths were anti-aliasing speckle fragments at usable posterize levels. Needs its own spike on despeckling before it's worth scoping.

## Next issues

- Scout: add fallback-path test (stub `WebAssembly` away, assert trace still completes), a load-timing race test (upload → immediate Trace click before wasm loads, in the spirit of the #10 `liveTimer` fix), and slider-range coverage for the new `alphamax`/`opttolerance` mapping
- Still no Playwright coverage of the selection UI (#6-#9) — longstanding gap, not addressed this round
- `logo-forge.html` (alt entry point) remains out of sync with all feature work since before #6 — worth a decision on whether it's still meant to be live
- Color-aware tracing: needs a despeckle-focused spike before it's a real issue (see #12 findings)

## Gotchas

- Plain static HTML/JS app — no build step, no framework
- Binary tracing now tries potrace-wasm first, falls back to `imagetracer.js` silently — any change to the trace path needs to be tested against both engines
- `body{height:100vh}` on desktop is load-bearing for the sidebar's internal scroll; the mobile media query overrides it back to `auto` — don't remove either half independently
- Live-update debounce is 350ms (`scheduleLive()` in `js/app.js`); all trace triggers must go through the `#trace-btn` click handler's `clearTimeout(liveTimer)` guard
