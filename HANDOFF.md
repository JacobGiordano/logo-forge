Last updated: 2026-08-24

## Status

Issues #11-#31 complete and previously shipped. This cycle: #32 (perf spike) found and validated a fix for the bilinear-presupersample OOM/crash blocker from #30, and #34 wired bilinear-presupersample into production — pre-threshold bilinear supersampling replaces the Scale2x-family upscale's 2x tier, hard-capped at 2x (3x/4x never exposed). Two same-day follow-ups tightened the safety gate after manual verification surfaced crashes the isolated spike harnesses didn't catch. Tempo reviewed the final gate. Full Playwright suite (33 tests) green.

## Decisions made this session

- #32: root cause of #30's OOM was despeckle/hole-fill's flood-fill running at upsampled mask resolution, not the bilinear resample itself. Fix: cheap block-approximate despeckle (downsample to native via majority vote, run existing despeckle at native cost, apply flip decisions back onto the fine mask) — recovers the 2x crash cell at every tested size (512-4200). 4x remained unrecoverable (separate bottleneck: the bilinear upsample's own Float64Array pair scales with (native × factor)², ~4.5GB at 4x/4200px) — this is why #34 capped the mechanism to 2x rather than fixing 4x.
- #34: implemented per issue — `js/bilinear-worker.js` (new) runs the bilinear upsample + cheap despeckle off the main thread, with clean rejection on construction/postMessage/runtime failure and a 20s timeout. `preprocessImageData` in `js/app.js` is now async.
- #34 follow-ups (same-day manual verification, not in the original spike harnesses): production holds the source image, thumbnail canvas, potrace-wasm's heap, and undo/selection state concurrently on top of the bilinear buffers, so real crash thresholds are lower than the isolated harnesses measured. A full renderer-process crash can't be caught by try/catch or worker.onerror. Also found the Scale2x-2x *fallback* crashes at the same native sizes (~4037-4200px) as bilinear-2x — the danger zone is producing/tracing a large mask at all, independent of which algorithm made it. Resolved with one unified gate: `BILINEAR_NATIVE_SAFE_LIMIT = 3500` (native longest dimension) — at/above this, neither bilinear-2x nor its Scale2x-2x fallback is attempted; the pipeline runs at native resolution with no upscale. This supersedes the earlier `BILINEAR_OUTPUT_CAP` (10,000px) backstop.

## Next issues

- #33 (Scout): Playwright coverage for the #26/#28 tooltip/popover feature — not started, still open.
- Color-aware tracing: on hold per user request until color capabilities come up again.
- Possible future: `touchcancel` handling for pinch/pan if an interrupted OS gesture ever turns out to be a real-world pain point (flagged in #23, not urgent).

## Gotchas

- Plain static HTML/JS app — no build step, no framework
- Binary tracing tries potrace-wasm first, falls back to `imagetracer.js` silently — test changes against both engines
- Selection UI only appears for images >256px in the relevant dimension; smaller images skip straight to tracing
- `body{height:100vh}` on desktop is load-bearing for the sidebar's internal scroll; the mobile media query overrides it back to `auto` — don't remove either half independently
- Live-update debounce is 350ms (`scheduleLive()` in `js/app.js`); all trace triggers must go through `#trace-btn`'s `clearTimeout(liveTimer)` guard
- `#threshold`/`#threshold-bias` are conditionally disabled based on `threshold-mode` (#29) — any test or code path that fills one directly must first ensure the matching mode is selected
- `preprocessImageData` (`js/app.js`) is async and gated by `BILINEAR_NATIVE_SAFE_LIMIT = 3500` (native longest dimension) — above this, neither bilinear-presupersample nor its Scale2x-2x fallback runs; touching this pipeline needs manual verification at real upload sizes (4000px+), not just the isolated spike harnesses in `_system/potrace-spike/`, which understated production memory pressure
- Playwright's dev server is hardcoded to port 4321 (`playwright.config.ts`) — a killed/removed worktree can leave an orphaned `serve` process holding it; check `ps aux | grep "serve \."` before assuming the port is broken
