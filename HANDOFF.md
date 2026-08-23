Last updated: 2026-08-23

## Status

Issues #11-#31 complete and merged to main, shipped. Every trace-setting slider now has an explanatory tap/click (+ hover-on-desktop) popover; the threshold/threshold-bias sliders now disable+dim based on the selected threshold mode instead of both always being interactable. Two tracing-pipeline spikes ran this cycle: multi-level/antialiased pre-binarize tracing (#25) was ruled out; bilinear-presupersample pre-binarize tracing (#27) won on quality/fragment-count but failed perf profiling at production upload sizes (#30) — not wired into production, findings only.

## Decisions made this session

- #26/#28: slider tooltips are click/tap-to-pin everywhere (guaranteed via native `<button>` click semantics) plus a hover preview on desktop only, gated on `isTouchPrimary()`. Hover must bind to just the info button + its own popover, NOT the whole `.ctrl-row` (#28 regression) — a `.ctrl-row`-wide hover binding also fires on hovering/dragging the slider itself. Fixed with a 200ms grace-period timer on mouseleave so the tip survives the cursor's trip from button down to popover text (separate grid row) without needing row-wide capture.
- #29: `threshold` (Manual-only) and `threshold-bias` (Auto-only) sliders + their number inputs now disable+dim based on `threshold-mode`, both on change and on initial load. Chose disable-and-dim over hide to avoid layout reflow on every mode toggle and keep the relationship discoverable. `applySettings()` (undo/redo path) also re-syncs this, since it sets `threshold-mode.value` directly without firing an `input` event.
- #31: fallout from #29 — `tests/undo-redo.spec.ts` was filling `#threshold` while it sat disabled in default Auto mode. Fixed by switching to Manual mode before each fill at all 4 call sites.
- #25 (spike): multi-level/antialiased pre-binarize tracing measured worse than the current pipeline on every axis (2-3x worse pixel-diff, reproduced #12's speckle-fragment problem even on clean synthetic shapes). Ruled out, no follow-up.
- #27/#30 (spike + productionization attempt): bilinear-interpolating grayscale before Otsu threshold (vs. today's Scale2x-after-binarize) beats the current pipeline on quality (better fidelity, smaller output, zero fragments) and the win holds on real degraded/anti-aliased images, not just synthetic shapes (#30). But it's 3-17x slower and OOM-crashed the tab at a realistic upload size (4200x4200) — dominant cost is despeckle/hole-fill's flood-fill passes at the upsampled resolution, not the bilinear resample itself. Composition finding: despeckle/hole-fill would need to move to run after threshold at the upsampled resolution with factor²-scaled `maxArea` (area scales quadratically, not linearly) — validated on the quality tests, but moot until perf is solved. Not wired into production. A future attempt needs a perf fix (Web Worker, capped upload size, or a cheaper despeckle pass at high resolution) before revisiting productionization — loop in Tempo first. Findings: `_system/bilinear-presupersample-tracing-findings.md`.

## Next issues

- Color-aware tracing: on hold per user request until color capabilities come up again; still needs a despeckle-focused spike first if revisited (see #12 findings).
- Possible future: `touchcancel` handling for pinch/pan if an interrupted OS gesture ever turns out to be a real-world pain point (flagged in #23, not urgent).
- No open issues right now on the bilinear-presupersample line — needs a perf-focused spike (Tempo) before any further productionization attempt, not scoped yet.
- Scout flagged: no Playwright coverage exists yet for the #26 tooltip feature (hover/click/tap/escape/dismiss) — not scoped as an issue yet.

## Gotchas

- Plain static HTML/JS app — no build step, no framework
- Binary tracing tries potrace-wasm first, falls back to `imagetracer.js` silently — test changes against both engines
- Selection UI only appears for images >256px in the relevant dimension; smaller images skip straight to tracing
- `body{height:100vh}` on desktop is load-bearing for the sidebar's internal scroll; the mobile media query overrides it back to `auto` — don't remove either half independently
- Live-update debounce is 350ms (`scheduleLive()` in `js/app.js`); all trace triggers must go through `#trace-btn`'s `clearTimeout(liveTimer)` guard
- `compactPathData()` in `js/app.js` does real RDP node simplification (#24), not just precision rounding — keep curve segments untouched, re-check both engines if you touch it
- `initInfoPopovers()` in `js/app.js`: hover must stay scoped to `item.btn`/`item.pop` only, never the whole `.ctrl-row` (#28) — see the inline comment for the grace-timer mechanism
- `#threshold`/`#threshold-bias` are conditionally disabled based on `threshold-mode` (#29) — any test or code path that fills one directly must first ensure the matching mode is selected
- Playwright's dev server is hardcoded to port 4321 (`playwright.config.ts`) — a killed/removed worktree can leave an orphaned `serve` process holding it; check `ps aux | grep "serve \."` before assuming the port is broken
