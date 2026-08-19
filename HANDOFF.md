Last updated: 2026-08-19

## Status

Issue #9 (re-edit a confirmed crop via new "Edit crop" button) complete and merged to main.

## Decisions made this session

- New persistent state `lastUploadedSheet`/`lastCropRect`, kept separate from the transient `pendingImage`/`selectionBox` used while the selection view is actively open — avoids conflating "mid-selection" state with "what to reopen later"
- "Edit crop" reuses `openSelectionView` and pre-seeds `selectionBox`/pan from `lastCropRect` rather than adding any new drag/resize/pan code — #8's existing tools handle the rest unchanged
- Button is hidden for images that took the skip-selection bypass (≤256px, no `lastUploadedSheet` to edit) rather than showing a broken empty selection view
- Rune review skipped by user decision again — no new external/network input surface, same risk profile as #5/#8

## Next issues

- #6 auto-trim negative space around the subject (depends on #5)
- #7 zoom/pan the selection canvas for dense sheets (depends on #5)
- Known gap, growing: still no Playwright coverage of the selection UI (resize handles, pan-drag, crosshair toggle, center-snap from #8; reopen/pre-fill from #9) — the only fixture (32×32) always takes the skip-selection bypass. Scout should add a larger, off-center fixture and selection-flow tests before this surface grows further.

## Gotchas

- Plain static HTML/JS app — no build step, no framework
- `serve` package used as dev server for Playwright tests only
- Undo button stays disabled until a second trace is committed (by design)
- Scale2x/3x-family upscaling bevels true 90° corners by ~1px (inherent to the algorithm) — negligible on curved logo art, visible on hard-cornered geometric fixtures
- Selection view threshold (256px) is a plain constant in `js/app.js` — no UI to configure it
- Image pan during crop-edit is clamped at the point the frame would no longer be fully covered by image content — there is deliberately no way to pan "off the edge"
- A fresh upload (new file, or "replace ↑") always clears `lastUploadedSheet`/`lastCropRect` — "Edit crop" only ever reopens the most recent confirmed crop, not a history of them
