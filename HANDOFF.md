Last updated: 2026-08-19

## Status

Issues #6 (auto-trim negative space) and #7 (zoom/pan selection canvas) complete and merged to main, shipped together.

## Decisions made this session

- #7: screen→source coordinate mapping consolidated into `selectionRectToSourceRect()` in `js/app.js` — the single integration point any future selection-consuming feature should use, regardless of zoom/pan state at confirm time
- #7: pan is hold-Space+drag or middle-click-drag, not plain left-drag — left-drag was already "draw a marquee," so overloading it would make selection impossible while zoomed in
- #7: "Edit crop" (#9) reopens at fit-to-view rather than restoring the zoom/pan active at confirm time — the crop rect itself is unaffected, so preserving zoom history wasn't worth the complexity
- #6: auto-trim reuses #8's existing luminance+Otsu bbox detection (`centerSubjectInFrame`'s approach), not the full trace pipeline (`preprocessImageData`) — trim results must not silently depend on whatever the Trace panel sliders currently say
- #6: defaults ON — the feature's whole point is "selections don't need to be pixel-perfect," so off-by-default would only benefit users who find the toggle first
- #6: re-applies (not re-stacks) when re-editing a crop via #9 — verified idempotent, not progressively shrinking, across repeated re-edits
- Found and fixed a pre-existing bug while keyboard-testing #6's toggle: hold-Space-to-pan was swallowing Space on any focused button in the selection view (Guides, Center, zoom, etc.), contradicting its own comment's intent — one-line fix, re-verified no pan regression
- Rune review skipped again by user decision — no new external/network input surface, same risk profile as #5/#7/#8/#9

## Next issues

- No open issues queued right now — `gh issue list` is empty as of this ship
- Known gap, still growing: no Playwright coverage of the selection UI at all (resize/pan/crosshair/center from #8, reopen/pre-fill from #9, zoom/pan from #7, auto-trim toggle from #6) — the only fixture (32×32) always takes the skip-selection bypass. Scout needs a larger, off-center fixture before this surface grows further; both #6 and #7 sessions left specific coverage notes in their PR reports for whoever picks this up.

## Gotchas

- Plain static HTML/JS app — no build step, no framework
- Selection view threshold (256px) is a plain constant in `js/app.js` — no UI to configure it
- Auto-trim margin (2px) is a plain constant (`AUTO_TRIM_MARGIN_PX`) in `js/app.js`
- A fresh upload always clears `lastUploadedSheet`/`lastCropRect` — "Edit crop" only ever reopens the most recent confirmed crop
