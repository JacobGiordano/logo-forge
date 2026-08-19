Last updated: 2026-08-19

## Status

Issue #10 (Live update enabled by default) complete and merged to main, shipped.

## Decisions made this session

- Live update now defaults ON (`liveEnabled = true` in `js/app.js`); `#live-toggle` markup starts in sync (`on` class, `aria-pressed="true"`)
- Caught and fixed a real regression before shipping: defaulting live-update on exposed a pre-existing race where a pending `scheduleLive()` timer wasn't cancelled by a manual Trace click, so a stray auto-retrace could fire ~350ms later and silently add an extra undo/redo history entry. Fixed by `clearTimeout(liveTimer)` at the top of the `#trace-btn` click handler, covering both the manual and auto-triggered paths through one place.
- This only surfaced as ~1-in-5 flakiness in the existing Playwright suite, not a single-run failure — a single clean `npm test` pass is not sufficient evidence for timing-sensitive changes near `scheduleLive()`/`liveTimer`; rerun the suite several times before trusting it
- Rune review skipped again by user decision — no new external/network input surface

## Next issues

- No open issues queued right now — `gh issue list` is empty as of this ship
- Known gap, still growing: no Playwright coverage of the selection UI at all (#6/#7/#8/#9 selection features). Scout should also add a regression test for the stray-timer race: rapid slider-change → immediate manual Trace click → wait past 350ms → assert exactly one new history entry, not two.

## Gotchas

- Plain static HTML/JS app — no build step, no framework
- Live-update debounce is 350ms (`scheduleLive()` in `js/app.js`); any code path that triggers a trace must go through the `#trace-btn` click handler so the `clearTimeout(liveTimer)` guard applies — don't add a second way to run a trace
- Selection view threshold (256px) and auto-trim margin (`AUTO_TRIM_MARGIN_PX`, 2px) are plain constants in `js/app.js` — no UI to configure either
- A fresh upload always clears `lastUploadedSheet`/`lastCropRect` — "Edit crop" only ever reopens the most recent confirmed crop
